const express = require('express');
const multer = require('multer');
const path = require('path');
const net = require('net');
const pdfParse = require('pdf-parse');
const { randomUUID } = require('crypto');
const { compileBundle, normalizeVisibility } = require('./lib/compiler');
const { buildAnalytics } = require('./lib/analytics');
const { createStorage } = require('./lib/storage');

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createRateLimiter({ max = 120, windowMs = 60_000 } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const record = buckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > record.resetAt) {
      record.count = 0;
      record.resetAt = now + windowMs;
    }
    record.count += 1;
    buckets.set(key, record);
    if (record.count > max) {
      return res.status(429).json({ error: 'Too many requests, please try again later.' });
    }
    return next();
  };
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.local')) return true;

  const ipVersion = net.isIP(host);
  if (!ipVersion) return false;
  if (ipVersion === 4) {
    return (
      host.startsWith('10.') ||
      host.startsWith('127.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
      host.startsWith('169.254.')
    );
  }

  return host === '::1' || host.startsWith('fc00:') || host.startsWith('fd00:') || host.startsWith('fe80:');
}

function parseAndValidateExternalUrl(rawUrl, allowedHosts) {
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (isPrivateHost(parsed.hostname)) return false;
    if (!allowedHosts.has(parsed.hostname.toLowerCase())) return false;
    return parsed;
  } catch (_e) {
    return false;
  }
}

function createApp(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const companyName = options.companyName || 'Acme Intelligence';
  const storage = options.storage || createStorage(rootDir);

  const app = express();
  const upload = multer({ storage: multer.memoryStorage() });
  const writeLimiter = createRateLimiter();
  const allowedFetchHosts = new Set(
    String(process.env.ALLOWED_FETCH_HOSTS || '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  );

  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/documents', (_req, res) => {
    res.json({ documents: storage.listDocuments() });
  });

  app.post('/api/documents', writeLimiter, (req, res) => {
    const { title, content, type = 'TEXT', visibility = 'BOTH' } = req.body || {};
    if (!title || !content) {
      return res.status(400).json({ error: 'title and content are required' });
    }

    const docs = storage.listDocuments();
    const document = {
      id: `doc-${randomUUID()}`,
      title: String(title),
      content: String(content),
      type: String(type).toUpperCase(),
      visibility: normalizeVisibility(visibility),
      createdAt: new Date().toISOString(),
    };
    docs.push(document);
    storage.saveDocuments(docs);

    return res.status(201).json({ document });
  });

  app.post('/api/documents/url', writeLimiter, async (req, res) => {
    const { url, title, visibility = 'BOTH' } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });
    if (allowedFetchHosts.size === 0) {
      return res.status(400).json({ error: 'URL ingestion is disabled until ALLOWED_FETCH_HOSTS is configured.' });
    }

    const validatedUrl = parseAndValidateExternalUrl(url, allowedFetchHosts);
    if (!validatedUrl) {
      return res.status(400).json({ error: 'url must be public http(s), non-private, and in ALLOWED_FETCH_HOSTS' });
    }

    try {
      const response = await fetch(validatedUrl.toString());
      if (!response.ok) {
        return res.status(400).json({ error: `failed to fetch url (${response.status})` });
      }
      const html = await response.text();
      const text = stripHtml(html);
      if (!text) return res.status(400).json({ error: 'fetched content was empty' });

      const docs = storage.listDocuments();
      const document = {
        id: `doc-${randomUUID()}`,
        title: title || `URL: ${validatedUrl.toString()}`,
        content: text,
        type: 'URL',
        visibility: normalizeVisibility(visibility),
        sourceUrl: validatedUrl.toString(),
        createdAt: new Date().toISOString(),
      };
      docs.push(document);
      storage.saveDocuments(docs);
      return res.status(201).json({ document });
    } catch (error) {
      return res.status(500).json({ error: `unable to fetch url: ${error.message}` });
    }
  });

  app.post('/api/documents/pdf', writeLimiter, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    const visibility = normalizeVisibility(req.body.visibility);
    const title = req.body.title || req.file.originalname;

    try {
      const parsed = await pdfParse(req.file.buffer);
      if (!parsed.text || !parsed.text.trim()) {
        return res.status(400).json({ error: 'pdf had no extractable text' });
      }

      const docs = storage.listDocuments();
      const document = {
        id: `doc-${randomUUID()}`,
        title,
        content: parsed.text.trim(),
        type: 'PDF',
        visibility,
        createdAt: new Date().toISOString(),
      };
      docs.push(document);
      storage.saveDocuments(docs);
      return res.status(201).json({ document });
    } catch (error) {
      return res.status(500).json({ error: `unable to parse pdf: ${error.message}` });
    }
  });

  app.post('/api/compile', writeLimiter, (req, res) => {
    const docs = storage.listDocuments();
    const bundle = compileBundle(docs, { company: companyName });
    const name = req.body?.name || 'company.intelligence.bundle.json';
    const { safeName } = storage.writeBundle(name, bundle);

    res.json({
      message: 'bundle compiled',
      name: safeName,
      bundleSummary: {
        version: bundle.version,
        company: bundle.company,
        generatedAt: bundle.generatedAt,
        documentCount: bundle.documentCount,
        chunkCount: bundle.chunkCount,
      },
    });
  });

  app.post('/api/telemetry', writeLimiter, (req, res) => {
    const { question, answered, score, topChunkId } = req.body || {};
    if (!question) return res.status(400).json({ error: 'question is required' });

    const events = storage.listTelemetry();
    events.push({
      timestamp: new Date().toISOString(),
      question: String(question),
      answered: Boolean(answered),
      score: Number(score || 0),
      topChunkId: topChunkId || null,
    });
    storage.saveTelemetry(events);
    res.status(201).json({ ok: true });
  });

  app.get('/api/admin/analytics', (_req, res) => {
    const analytics = buildAnalytics(storage.listTelemetry());
    res.json({ analytics });
  });

  app.use('/bundles', express.static(path.join(rootDir, 'bundles')));
  app.use(express.static(path.join(rootDir, 'public')));

  app.get('/admin', (_req, res) => {
    res.redirect('/admin.html');
  });

  return app;
}

module.exports = {
  createApp,
};
