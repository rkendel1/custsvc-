const express = require('express');
const multer = require('multer');
const path = require('path');
const pdfParse = require('pdf-parse');
const { compileBundle, normalizeVisibility } = require('./lib/compiler');
const { buildAnalytics } = require('./lib/analytics');
const { createStorage } = require('./lib/storage');

function stripHtml(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createApp(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const companyName = options.companyName || 'Acme Intelligence';
  const storage = options.storage || createStorage(rootDir);

  const app = express();
  const upload = multer({ storage: multer.memoryStorage() });

  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/documents', (_req, res) => {
    res.json({ documents: storage.listDocuments() });
  });

  app.post('/api/documents', (req, res) => {
    const { title, content, type = 'TEXT', visibility = 'BOTH' } = req.body || {};
    if (!title || !content) {
      return res.status(400).json({ error: 'title and content are required' });
    }

    const docs = storage.listDocuments();
    const document = {
      id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

  app.post('/api/documents/url', async (req, res) => {
    const { url, title, visibility = 'BOTH' } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });

    try {
      const response = await fetch(url);
      if (!response.ok) {
        return res.status(400).json({ error: `failed to fetch url (${response.status})` });
      }
      const html = await response.text();
      const text = stripHtml(html);
      if (!text) return res.status(400).json({ error: 'fetched content was empty' });

      const docs = storage.listDocuments();
      const document = {
        id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: title || `URL: ${url}`,
        content: text,
        type: 'URL',
        visibility: normalizeVisibility(visibility),
        sourceUrl: url,
        createdAt: new Date().toISOString(),
      };
      docs.push(document);
      storage.saveDocuments(docs);
      return res.status(201).json({ document });
    } catch (error) {
      return res.status(500).json({ error: `unable to fetch url: ${error.message}` });
    }
  });

  app.post('/api/documents/pdf', upload.single('file'), async (req, res) => {
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
        id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

  app.post('/api/compile', (req, res) => {
    const docs = storage.listDocuments();
    const bundle = compileBundle(docs, { company: companyName });
    const name = req.body?.name || 'company.intelligence.bundle.json';
    storage.writeBundle(name, bundle);

    res.json({
      message: 'bundle compiled',
      name,
      bundleSummary: {
        version: bundle.version,
        company: bundle.company,
        generatedAt: bundle.generatedAt,
        documentCount: bundle.documentCount,
        chunkCount: bundle.chunkCount,
      },
    });
  });

  app.post('/api/telemetry', (req, res) => {
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
    res.sendFile(path.join(rootDir, 'public', 'admin.html'));
  });

  return app;
}

module.exports = {
  createApp,
};
