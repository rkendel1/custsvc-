const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const net = require('net');
const pdfParse = require('pdf-parse');
const { randomUUID } = require('crypto');
const { compileBundle, normalizeVisibility } = require('./lib/compiler');
const { buildAnalytics } = require('./lib/analytics');
const { createStorage } = require('./lib/storage');
const { provisionTenant } = require('./lib/tenantProvisioner');
const { createDeployment } = require('./lib/tenant/deployment');

function stripHtml(text) {
  const input = String(text || '');
  let insideTag = false;
  let output = '';

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '<') {
      insideTag = true;
      output += ' ';
      continue;
    }
    if (ch === '>') {
      insideTag = false;
      output += ' ';
      continue;
    }
    if (!insideTag) output += ch;
  }

  return output.replace(/\s+/g, ' ').trim();
}

function createRateLimiter({ max = 120, windowMs = 60_000 } = {}) {
  const buckets = new Map();
  let lastCleanup = 0;
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    if (now - lastCleanup >= windowMs) {
      for (const [bucketKey, bucket] of buckets.entries()) {
        if (now > bucket.resetAt) buckets.delete(bucketKey);
      }
      lastCleanup = now;
    }
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

function resolveDatabaseProbeTarget() {
  const fromUrl = process.env.DATABASE_URL;
  if (fromUrl) {
    try {
      const parsed = new URL(fromUrl);
      if (parsed.hostname) {
        return {
          host: parsed.hostname,
          port: Number(parsed.port || 5432),
          source: 'DATABASE_URL',
        };
      }
    } catch (_error) {
      // Ignore parse errors and fallback to PGHOST/PGPORT.
    }
  }

  if (process.env.PGHOST) {
    return {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      source: 'PGHOST',
    };
  }

  return null;
}

function probeTcp({ host, port }, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) });
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish({ ok: true }));
    socket.on('timeout', () => finish({ ok: false, reason: 'timeout' }));
    socket.on('error', (error) => finish({ ok: false, reason: error.message }));
  });
}

function isValidHttpUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return ['http:', 'https:'].includes(parsed.protocol) && !isPrivateHost(parsed.hostname);
  } catch (_e) {
    return false;
  }
}

function normalizeSourceType(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_ -]/g, '')
    .replace(/[ -]+/g, '_')
    .slice(0, 48);
  return normalized || 'GENERIC';
}

function sourceHealth(source) {
  const status = String(source?.status || 'connected').toLowerCase();
  if (status !== 'connected') return status;
  const lastSyncAt = source?.last_sync_at ? Date.parse(source.last_sync_at) : null;
  const pollMinutes = Number(source?.poll_minutes || 60);
  if (!lastSyncAt || !Number.isFinite(lastSyncAt)) return 'pending';
  const ageMs = Date.now() - lastSyncAt;
  if (ageMs > pollMinutes * 60 * 1000 * 2) return 'stale';
  return 'healthy';
}

function toDocumentFromInput(input = {}, tenantId) {
  const title = String(input.title || '').trim();
  const body = String(input.body || '').trim();
  if (!title || !body) return null;
  return {
    id: `doc-${randomUUID()}`,
    tenant_id: tenantId,
    title,
    body,
    summary: input.summary ? String(input.summary) : null,
    type: String(input.type || 'TEXT').toUpperCase(),
    visibility: normalizeVisibility(input.visibility || 'INTERNAL'),
    owner: input.owner || null,
    department: input.department || null,
    audience: input.audience || null,
    classification: input.classification || null,
    status: input.status || 'ACTIVE',
    tags: Array.isArray(input.tags) ? input.tags : [],
    relationships: Array.isArray(input.relationships) ? input.relationships : [],
    citations: Array.isArray(input.citations) ? input.citations : [],
    last_reviewed: input.last_reviewed || null,
    review_frequency: input.review_frequency || null,
    confidence: Number(input.confidence || 0.7),
    source_url: input.source_url || null,
    createdAt: new Date().toISOString(),
  };
}

function listData(storage, listMethod) {
  if (typeof storage[listMethod] !== 'function') return [];
  const data = storage[listMethod]();
  return Array.isArray(data) ? data : [];
}

function saveData(storage, saveMethod, value) {
  if (typeof storage[saveMethod] === 'function') {
    storage[saveMethod](value);
  }
}

function resolveSessionToken(req) {
  const authHeader = req.header('authorization') || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return req.header('x-session-token') || req.query.session_token || req.body?.session_token || null;
}

function resolveTenantId(req) {
  return (
    req.header('x-tenant-id') ||
    req.query.tenant_id ||
    req.body?.tenant_id ||
    req.body?.tenantId ||
    null
  );
}

function requireTenant(req, res, next) {
  const tenantId = resolveTenantId(req);
  if (!tenantId) {
    return res.status(400).json({ error: 'tenant_id is required' });
  }
  req.tenantId = String(tenantId);
  return next();
}

function requireTenantOrSession(storage) {
  return (req, res, next) => {
    const tenantId = resolveTenantId(req);
    if (tenantId) {
      req.tenantId = String(tenantId);
      return next();
    }

    const token = resolveSessionToken(req);
    if (!token) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    const sessions = listData(storage, 'listSessions');
    const session = sessions.find((item) => item.token === token && item.status === 'active');
    if (!session) {
      return res.status(403).json({ error: 'invalid tenant session' });
    }
    if (session.expires_at && Date.now() > Date.parse(session.expires_at)) {
      return res.status(401).json({ error: 'session expired' });
    }

    req.tenantId = String(session.tenant_id);
    return next();
  };
}

function requireTenantSession(storage) {
  return (req, res, next) => {
    const token = resolveSessionToken(req);
    if (!token) return res.status(401).json({ error: 'session token is required' });

    const sessions = listData(storage, 'listSessions');
    const session = sessions.find(
      (item) => item.token === token && item.tenant_id === req.tenantId && item.status === 'active',
    );
    if (!session) return res.status(403).json({ error: 'invalid tenant session' });

    if (session.expires_at && Date.now() > Date.parse(session.expires_at)) {
      return res.status(401).json({ error: 'session expired' });
    }

    req.session = session;
    return next();
  };
}

function isValidEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value || value.length > 254 || value.includes(' ')) return false;
  const atIndex = value.indexOf('@');
  if (atIndex <= 0 || atIndex !== value.lastIndexOf('@')) return false;
  const domain = value.slice(atIndex + 1);
  if (!domain || !domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  return true;
}

function createSession(storage, { tenantId, userId, role }) {
  const sessions = listData(storage, 'listSessions');
  const token = `kos_${randomUUID().replace(/-/g, '')}`;
  const session = {
    session_id: `session-${randomUUID()}`,
    token,
    tenant_id: tenantId,
    user_id: userId,
    role,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    status: 'active',
  };
  sessions.push(session);
  saveData(storage, 'saveSessions', sessions);
  return session;
}

function ensureDemoTenant(storage) {
  const DEMO_OWNER_USER_ID = 'user-acme-owner';
  const tenants = listData(storage, 'listTenants');
  if (tenants.some((tenant) => tenant.tenant_id === 'acme')) return;

  const tenant = provisionTenant({
    tenantId: 'acme',
    companyName: 'Acme Manufacturing',
    ownerEmail: 'owner@acme.example',
    companySize: '201-500',
    primaryUseCase: 'Customer Website',
    deploymentProfile: 'BOTH',
  });
  tenants.push({ ...tenant, owner_user_id: DEMO_OWNER_USER_ID, seeded: true });
  saveData(storage, 'saveTenants', tenants);

  const users = listData(storage, 'listUsers');
  if (!users.some((user) => user.user_id === DEMO_OWNER_USER_ID)) {
    users.push({
      user_id: DEMO_OWNER_USER_ID,
      tenant_id: 'acme',
      name: 'Acme Owner',
      email: 'owner@acme.example',
      created_at: new Date().toISOString(),
      email_verified: true,
    });
    saveData(storage, 'saveUsers', users);
  }

  const memberships = listData(storage, 'listTenantMemberships');
  if (!memberships.some((membership) => membership.tenant_id === 'acme' && membership.user_id === DEMO_OWNER_USER_ID)) {
    memberships.push({
      tenant_id: 'acme',
      user_id: DEMO_OWNER_USER_ID,
      role: 'Owner',
      status: 'active',
      created_at: new Date().toISOString(),
    });
    saveData(storage, 'saveTenantMemberships', memberships);
  }

  const subscriptions = listData(storage, 'listSubscriptions');
  if (!subscriptions.some((subscription) => subscription.tenant_id === 'acme')) {
    subscriptions.push({
      tenant_id: 'acme',
      plan: 'Starter',
      usage: { questions_answered: 0 },
      limits: { documents: 100, monthly_questions: 1000 },
      status: 'active',
      created_at: new Date().toISOString(),
    });
    saveData(storage, 'saveSubscriptions', subscriptions);
  }

  const documents = listData(storage, 'listDocuments');
  if (!documents.some((doc) => doc.tenant_id === 'acme')) {
    documents.push(
      {
        id: `doc-${randomUUID()}`,
        tenant_id: 'acme',
        title: 'Return Policy',
        body: 'Customers can return products within 30 days with receipt.',
        type: 'POLICY',
        visibility: 'PUBLIC',
        audience: 'PUBLIC',
        createdAt: new Date().toISOString(),
      },
      {
        id: `doc-${randomUUID()}`,
        tenant_id: 'acme',
        title: 'Support Escalation Process',
        body: 'If refund exceeds $500, escalate to a manager for approval within 1 business day.',
        type: 'PROCESS',
        visibility: 'INTERNAL',
        audience: 'INTERNAL',
        createdAt: new Date().toISOString(),
      },
      {
        id: `doc-${randomUUID()}`,
        tenant_id: 'acme',
        title: 'Manager Exception Guidelines',
        body: 'Managers review exceptions weekly and track SLA breaches in operations metrics.',
        type: 'SOP',
        visibility: 'INTERNAL',
        audience: 'INTERNAL',
        createdAt: new Date().toISOString(),
      },
    );
    saveData(storage, 'saveDocuments', documents);
  }

  const sessions = listData(storage, 'listSessions');
  if (!sessions.some((session) => session.tenant_id === 'acme' && session.user_id === DEMO_OWNER_USER_ID)) {
    createSession(storage, { tenantId: 'acme', userId: DEMO_OWNER_USER_ID, role: 'Owner' });
  }
}

function ensureDefaultBundle(storage, companyName) {
  const defaultBundleName = 'knowledgeos.bundle.json';
  const bundlesDir = storage?.bundlesDir;
  const canCheckFilesystem = Boolean(bundlesDir);

  if (canCheckFilesystem) {
    const defaultBundlePath = path.join(bundlesDir, defaultBundleName);
    if (fs.existsSync(defaultBundlePath)) return;
  }

  const docs = listData(storage, 'listDocuments');
  const bundle = compileBundle(docs, { company: companyName });
  storage.writeBundle(defaultBundleName, bundle);
}

function createApp(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const companyName = options.companyName || 'KnowledgeOS';
  const storage = options.storage || createStorage(rootDir);

  ensureDemoTenant(storage);
  ensureDefaultBundle(storage, companyName);

  const app = express();
  const upload = multer({ storage: multer.memoryStorage() });
  const writeLimiter = createRateLimiter();
  const signupLimiter = createRateLimiter({ max: 12, windowMs: 60_000 });
  const readLimiter = createRateLimiter({ max: 240, windowMs: 60_000 });
  const tenantResolverMiddleware = requireTenantOrSession(storage);
  const tenantSessionMiddleware = requireTenantSession(storage);

  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, product: 'KnowledgeOS' });
  });

  app.get('/api/system/status', async (_req, res) => {
    const databaseTarget = resolveDatabaseProbeTarget();
    let database = {
      configured: Boolean(databaseTarget),
      reachable: false,
      host: databaseTarget?.host || null,
      port: databaseTarget?.port || null,
      source: databaseTarget?.source || null,
      error: null,
    };

    if (databaseTarget) {
      const result = await probeTcp(databaseTarget);
      database = {
        ...database,
        reachable: result.ok,
        error: result.ok ? null : result.reason || 'unknown',
      };
    }

    res.json({
      ok: true,
      database,
      browser_runtime: {
        bundle_url: '/bundles/knowledgeos.bundle.json',
        pglite_module_url: '/vendor/pglite/index.js',
      },
    });
  });

  app.get('/api/documents', readLimiter, (req, res) => {
    const tenantId = resolveTenantId(req);
    const documents = listData(storage, 'listDocuments');
    const filtered = tenantId ? documents.filter((doc) => doc.tenant_id === tenantId) : documents;
    res.json({ documents: filtered });
  });

  app.post('/api/documents', writeLimiter, (req, res) => {
    const {
      title,
      body,
      type = 'TEXT',
      visibility = 'INTERNAL',
      owner = null,
      department = null,
      audience = null,
      classification = null,
      status = 'ACTIVE',
      tags = [],
      relationships = [],
      citations = [],
      summary = null,
      last_reviewed = null,
      review_frequency = null,
      confidence = 0.7,
    } = req.body || {};
    const normalizedBody = String(body || '').trim();
    if (!title || !normalizedBody) {
      return res.status(400).json({ error: 'title and body are required' });
    }

    const tenantId = resolveTenantId(req) || 'public';
    const docs = listData(storage, 'listDocuments');
    const document = {
      id: `doc-${randomUUID()}`,
      tenant_id: tenantId,
      title: String(title),
      body: normalizedBody,
      summary: summary ? String(summary) : null,
      type: String(type).toUpperCase(),
      visibility: normalizeVisibility(visibility),
      owner,
      department,
      audience,
      classification,
      status,
      tags,
      relationships,
      citations,
      last_reviewed,
      review_frequency,
      confidence,
      createdAt: new Date().toISOString(),
    };
    docs.push(document);
    saveData(storage, 'saveDocuments', docs);

    return res.status(201).json({ document });
  });

  app.post('/api/documents/bulk', writeLimiter, (req, res) => {
    const tenantId = resolveTenantId(req) || 'public';
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ error: 'items array is required' });
    }

    const docs = listData(storage, 'listDocuments');
    const inserted = [];
    const rejected = [];

    for (let i = 0; i < items.length; i += 1) {
      const candidate = toDocumentFromInput(items[i], tenantId);
      if (!candidate) {
        rejected.push({ index: i, reason: 'title and body are required' });
        continue;
      }
      docs.push(candidate);
      inserted.push(candidate);
    }

    saveData(storage, 'saveDocuments', docs);
    return res.status(201).json({
      inserted_count: inserted.length,
      rejected_count: rejected.length,
      rejected,
      documents: inserted,
    });
  });

  app.post('/api/documents/url', writeLimiter, (req, res) => {
    const { url, title, content, visibility = 'PUBLIC', owner = null, department = null } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });
    if (!content) {
      return res.status(400).json({ error: 'content is required for URL ingestion in this secure mode' });
    }
    if (!isValidHttpUrl(url)) {
      return res.status(400).json({ error: 'url must be public http(s) and not private/internal' });
    }

    try {
      const text = stripHtml(content);
      if (!text) return res.status(400).json({ error: 'content was empty after sanitization' });

      const tenantId = resolveTenantId(req) || 'public';
      const docs = listData(storage, 'listDocuments');
      const document = {
        id: `doc-${randomUUID()}`,
        tenant_id: tenantId,
        title: title || `URL: ${url}`,
        body: text,
        type: 'URL',
        visibility: normalizeVisibility(visibility),
        audience: 'PUBLIC',
        owner,
        department,
        sourceUrl: String(url),
        createdAt: new Date().toISOString(),
      };
      docs.push(document);
      saveData(storage, 'saveDocuments', docs);
      return res.status(201).json({ document });
    } catch (error) {
      return res.status(500).json({ error: `unable to process URL content: ${error.message}` });
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

      const tenantId = resolveTenantId(req) || 'public';
      const docs = listData(storage, 'listDocuments');
      const document = {
        id: `doc-${randomUUID()}`,
        tenant_id: tenantId,
        title,
        body: parsed.text.trim(),
        type: 'PDF',
        visibility,
        audience: visibility,
        createdAt: new Date().toISOString(),
      };
      docs.push(document);
      saveData(storage, 'saveDocuments', docs);
      return res.status(201).json({ document });
    } catch (error) {
      return res.status(500).json({ error: `unable to parse pdf: ${error.message}` });
    }
  });

  app.post('/api/compile', writeLimiter, (req, res) => {
    const tenantId = resolveTenantId(req);
    const allDocs = listData(storage, 'listDocuments');
    const docs = tenantId ? allDocs.filter((doc) => doc.tenant_id === tenantId) : allDocs;
    const bundle = compileBundle(docs, { company: companyName });
    const defaultBundleName = tenantId ? `${tenantId}.knowledgeos.bundle.json` : 'knowledgeos.bundle.json';
    const name = req.body?.name || defaultBundleName;
    const { safeName } = storage.writeBundle(name, bundle);

    res.json({
      message: 'bundle compiled',
      name: safeName,
      tenant_id: tenantId || null,
      bundleSummary: {
        version: bundle.version,
        company: bundle.company,
        generatedAt: bundle.generatedAt,
        documentCount: bundle.documentCount,
        knowledgeCount: bundle.knowledgeCount,
        chunkCount: bundle.chunkCount,
        processCount: bundle.processCount || 0,
        relationships: bundle.relationships.length,
        contradictions: bundle.contradictions.length,
        duplicates: bundle.duplicates.length,
        review_schedule: bundle.review_schedule,
        process_review: bundle.review?.processes || {},
        confidence: bundle.confidence,
      },
    });
  });

  app.post('/api/telemetry', writeLimiter, (req, res) => {
    const {
      question,
      answered,
      score,
      topChunkId,
      role,
      department,
      permissions,
      confidence,
      intent,
      knowledge_gap,
      process_started,
      duration,
      includeContent,
    } = req.body || {};
    if (!question && !intent) return res.status(400).json({ error: 'at least one of question or intent is required' });

    const events = listData(storage, 'listTelemetry');
    const event = {
      tenant_id: resolveTenantId(req) || 'public',
      timestamp: new Date().toISOString(),
      answered: Boolean(answered),
      score: Number(score || 0),
      topChunkId: topChunkId || null,
      role: role || 'Customer',
      department: department || null,
      permissions: Array.isArray(permissions) ? permissions : [],
      confidence: Number(confidence || 0),
      intent: intent ? String(intent) : null,
      knowledge_gap: Boolean(knowledge_gap),
      process_started: Boolean(process_started),
      duration: Number(duration || 0),
    };
    if (includeContent && question) event.question = String(question);
    events.push(event);
    saveData(storage, 'saveTelemetry', events);
    res.status(201).json({ ok: true });
  });

  app.get('/api/admin/analytics', readLimiter, (req, res) => {
    const tenantId = resolveTenantId(req);
    const events = listData(storage, 'listTelemetry');
    const filtered = tenantId ? events.filter((event) => event.tenant_id === tenantId) : events;
    const analytics = buildAnalytics(filtered);
    res.json({ analytics });
  });

  app.get('/api/sources', readLimiter, (req, res) => {
    const tenantId = resolveTenantId(req) || null;
    const allSources = listData(storage, 'listSources');
    const sources = tenantId ? allSources.filter((item) => item.tenant_id === tenantId) : allSources;
    const summarized = sources.map((source) => ({
      ...source,
      health: sourceHealth(source),
    }));
    res.json({ sources: summarized });
  });

  app.post('/api/sources', writeLimiter, (req, res) => {
    const { name, type = 'GENERIC', site_url = null, poll_minutes = 60, config = {} } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (site_url && !isValidHttpUrl(site_url)) {
      return res.status(400).json({ error: 'site_url must be public http(s) and not private/internal' });
    }

    const tenantId = resolveTenantId(req) || 'public';
    const sources = listData(storage, 'listSources');
    const source = {
      source_id: `source-${randomUUID()}`,
      tenant_id: tenantId,
      name: String(name),
      type: normalizeSourceType(type),
      site_url: site_url ? String(site_url) : null,
      poll_minutes: Math.max(5, Number(poll_minutes || 60)),
      status: 'connected',
      config: typeof config === 'object' && config ? config : {},
      last_sync_at: null,
      last_sync_status: 'never',
      last_sync_error: null,
      documents_synced: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    sources.push(source);
    saveData(storage, 'saveSources', sources);
    res.status(201).json({ source: { ...source, health: sourceHealth(source) } });
  });

  app.post('/api/sources/:sourceId/sync', writeLimiter, (req, res) => {
    const sourceId = req.params.sourceId;
    const tenantId = resolveTenantId(req) || 'public';
    const sources = listData(storage, 'listSources');
    const index = sources.findIndex((item) => item.source_id === sourceId && item.tenant_id === tenantId);
    if (index < 0) return res.status(404).json({ error: 'source not found' });

    const source = sources[index];
    const docs = listData(storage, 'listDocuments');
    const incoming = Array.isArray(req.body?.documents) ? req.body.documents : [];

    let syncedCount = 0;
    if (incoming.length) {
      for (const item of incoming) {
        const doc = toDocumentFromInput(
          {
            ...item,
            type: item.type || (source.type === 'WEBSITE' ? 'URL' : 'TEXT'),
            source_url: item.source_url || source.site_url || null,
          },
          tenantId,
        );
        if (!doc) continue;
        docs.push(doc);
        syncedCount += 1;
      }
      saveData(storage, 'saveDocuments', docs);
    }

    const updated = {
      ...source,
      last_sync_at: new Date().toISOString(),
      last_sync_status: 'success',
      last_sync_error: null,
      documents_synced: Number(source.documents_synced || 0) + syncedCount,
      updated_at: new Date().toISOString(),
    };
    sources[index] = updated;
    saveData(storage, 'saveSources', sources);

    res.json({
      source: { ...updated, health: sourceHealth(updated) },
      synced_count: syncedCount,
    });
  });

  app.post('/api/signup', signupLimiter, (req, res) => {
    const { name, email, company, companySize, primaryUseCase, deploymentProfile = 'BOTH' } = req.body || {};
    if (!name || !email || !company || !companySize || !primaryUseCase) {
      return res.status(400).json({ error: 'name, email, company, companySize, and primaryUseCase are required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'a valid email is required' });
    }

    let tenant;
    try {
      tenant = provisionTenant({
        companyName: company,
        ownerEmail: email,
        companySize,
        primaryUseCase,
        deploymentProfile,
      });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const tenants = listData(storage, 'listTenants');
    if (tenants.some((existing) => existing.tenant_id === tenant.tenant_id)) {
      return res.status(409).json({ error: 'tenant already exists for this company' });
    }
    const userId = `user-${randomUUID()}`;
    tenant.owner_user_id = userId;
    tenants.push(tenant);
    saveData(storage, 'saveTenants', tenants);

    const users = listData(storage, 'listUsers');
    users.push({
      user_id: userId,
      tenant_id: tenant.tenant_id,
      name: String(name),
      email: String(email).toLowerCase(),
      email_verified: false,
      created_at: new Date().toISOString(),
    });
    saveData(storage, 'saveUsers', users);

    const memberships = listData(storage, 'listTenantMemberships');
    memberships.push({
      tenant_id: tenant.tenant_id,
      user_id: userId,
      role: 'Owner',
      status: 'active',
      created_at: new Date().toISOString(),
    });
    saveData(storage, 'saveTenantMemberships', memberships);

    const subscriptions = listData(storage, 'listSubscriptions');
    subscriptions.push({
      tenant_id: tenant.tenant_id,
      plan: 'Starter',
      usage: { questions_answered: 0, runtime_instances: 0 },
      limits: { documents: 100, monthly_questions: 1000, runtime_instances: 1 },
      status: 'active',
      created_at: new Date().toISOString(),
    });
    saveData(storage, 'saveSubscriptions', subscriptions);

    const session = createSession(storage, { tenantId: tenant.tenant_id, userId, role: 'Owner' });

    return res.status(201).json({
      tenant,
      user: { user_id: userId, name: String(name), email: String(email).toLowerCase(), role: 'Owner' },
      session: {
        token: session.token,
        expires_at: session.expires_at,
      },
      onboarding_url: `/onboarding?tenant_id=${tenant.tenant_id}&session_token=${session.token}`,
      email_verification: {
        required: true,
        status: 'pending',
        hook: '/api/auth/verify-email',
      },
    });
  });

  app.post('/api/tenants', signupLimiter, (req, res) => {
    const { company_name, owner_email, owner_name = 'Owner', deployment_profile = 'BOTH', company_size = null, primary_use_case = null } = req.body || {};
    if (!company_name || !owner_email) {
      return res.status(400).json({ error: 'company_name and owner_email are required' });
    }
    if (!isValidEmail(owner_email)) {
      return res.status(400).json({ error: 'owner_email must be a valid email' });
    }

    let tenant;
    try {
      tenant = provisionTenant({
        companyName: company_name,
        ownerEmail: owner_email,
        deploymentProfile: deployment_profile,
        companySize: company_size,
        primaryUseCase: primary_use_case,
      });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const tenants = listData(storage, 'listTenants');
    if (tenants.some((existing) => existing.tenant_id === tenant.tenant_id)) {
      return res.status(409).json({ error: 'tenant already exists for this company' });
    }
    const userId = `user-${randomUUID()}`;
    tenant.owner_user_id = userId;
    tenants.push(tenant);
    saveData(storage, 'saveTenants', tenants);

    const users = listData(storage, 'listUsers');
    users.push({
      user_id: userId,
      tenant_id: tenant.tenant_id,
      name: String(owner_name),
      email: String(owner_email).toLowerCase(),
      email_verified: false,
      created_at: new Date().toISOString(),
    });
    saveData(storage, 'saveUsers', users);

    const memberships = listData(storage, 'listTenantMemberships');
    memberships.push({
      tenant_id: tenant.tenant_id,
      user_id: userId,
      role: 'Owner',
      status: 'active',
      created_at: new Date().toISOString(),
    });
    saveData(storage, 'saveTenantMemberships', memberships);

    const session = createSession(storage, { tenantId: tenant.tenant_id, userId, role: 'Owner' });
    return res.status(201).json({
      tenant,
      owner: { user_id: userId, role: 'Owner' },
      session: {
        token: session.token,
        expires_at: session.expires_at,
      },
    });
  });

  app.get('/api/tenant', readLimiter, tenantResolverMiddleware, tenantSessionMiddleware, (req, res) => {
    const tenants = listData(storage, 'listTenants');
    const tenant = tenants.find((item) => item.tenant_id === req.tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'tenant not found' });
    }

    const docs = listData(storage, 'listDocuments').filter((doc) => doc.tenant_id === req.tenantId);
    const analytics = buildAnalytics(listData(storage, 'listTelemetry').filter((event) => event.tenant_id === req.tenantId));
    const deployments = listData(storage, 'listDeployments').filter((deployment) => deployment.tenant_id === req.tenantId);

    return res.json({
      tenant,
      dashboard: {
        knowledge_health: docs.length,
        documents: docs.length,
        confidence: analytics.averageScore,
        questions: analytics.total,
        knowledge_gaps: analytics.unanswered,
        runtime_status: deployments[deployments.length - 1]?.status || 'not_deployed',
      },
    });
  });

  app.post('/api/onboarding', writeLimiter, tenantResolverMiddleware, tenantSessionMiddleware, (req, res) => {
    const { step, companyProfile, deploymentChoice, importSources, audiences } = req.body || {};
    const onboarding = listData(storage, 'listOnboarding');
    const nextState = {
      tenant_id: req.tenantId,
      step: step || 'company-profile',
      company_profile: companyProfile || null,
      deployment_choice: deploymentChoice || null,
      import_sources: importSources || [],
      audiences: audiences || ['Customers', 'Employees'],
      updated_at: new Date().toISOString(),
    };

    const index = onboarding.findIndex((item) => item.tenant_id === req.tenantId);
    if (index >= 0) onboarding[index] = { ...onboarding[index], ...nextState };
    else onboarding.push(nextState);
    saveData(storage, 'saveOnboarding', onboarding);

    const compileProgress = [
      'Processing documents',
      'Building knowledge graph',
      'Generating embeddings',
      'Preparing runtime',
    ];

    return res.status(201).json({
      onboarding: nextState,
      compile_progress: compileProgress,
      next: '/api/deploy',
    });
  });

  app.post('/api/deploy', writeLimiter, tenantResolverMiddleware, tenantSessionMiddleware, (req, res) => {
    const userId = req.session.user_id;
    const memberships = listData(storage, 'listTenantMemberships');
    const membership = memberships.find((item) => item.tenant_id === req.tenantId && item.user_id === userId);
    if (!membership) {
      return res.status(403).json({ error: 'user is not a tenant member' });
    }
    if (!['Owner', 'Admin'].includes(membership.role)) {
      return res.status(403).json({ error: 'deployment requires Owner or Admin role' });
    }

    const tenants = listData(storage, 'listTenants');
    const tenant = tenants.find((item) => item.tenant_id === req.tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'tenant not found' });
    }

    const deployment = createDeployment({
      tenantId: req.tenantId,
      companyName: tenant.company_name,
      deploymentProfile: req.body?.deployment_profile || tenant.deployment_profile || 'BOTH',
      audiences: req.body?.audiences || tenant.audiences,
    });

    const deployments = listData(storage, 'listDeployments');
    deployments.push(deployment);
    saveData(storage, 'saveDeployments', deployments);

    const runtimeInstances = listData(storage, 'listRuntimeInstances');
    runtimeInstances.push({
      runtime_instance_id: `runtime-${randomUUID()}`,
      tenant_id: req.tenantId,
      deployment_id: deployment.deployment_id,
      runtime_url: deployment.runtime_url,
      status: deployment.status,
      created_at: deployment.deployed_at,
    });
    saveData(storage, 'saveRuntimeInstances', runtimeInstances);

    return res.status(201).json({
      deployment,
      outputs: {
        runtime_url: deployment.runtime_url,
        embed_code: deployment.embed_code,
        api_key: deployment.api_key,
        access_settings: {
          tenant_membership_required: true,
          audiences: deployment.audience_rules,
        },
      },
    });
  });

  app.get('/api/deployment/status', readLimiter, tenantResolverMiddleware, tenantSessionMiddleware, (req, res) => {
    const deploymentId = req.query.deployment_id || req.query.id;
    if (!deploymentId) {
      return res.status(400).json({ error: 'deployment_id is required' });
    }

    const deployments = listData(storage, 'listDeployments');
    const deployment = deployments.find((item) => item.tenant_id === req.tenantId && item.deployment_id === deploymentId);
    if (!deployment) {
      return res.status(404).json({ error: 'deployment not found' });
    }

    return res.json({
      deployment_id: deployment.deployment_id,
      tenant_id: deployment.tenant_id,
      status: deployment.status,
      runtime_url: deployment.runtime_url,
      deployed_at: deployment.deployed_at,
    });
  });

  app.get('/api/demo', readLimiter, (_req, res) => {
    return res.json({
      tenant_id: 'acme',
      company_name: 'Acme Manufacturing',
      views: {
        customer: {
          question: 'How do I return this product?',
          answer: 'You can return products within 30 days with a receipt.',
          citation: 'Return Policy',
          confidence: 0.93,
        },
        support: {
          customer_context: 'Order #49312, purchased 20 days ago',
          recommended_process: 'Refund Process > Collect Data > Decision',
          next_action: 'Collect receipt and reason code',
        },
        manager: {
          approval_workflow: 'Refund over $500 requires manager approval',
          metrics: { pending: 3, approved_today: 12 },
          exceptions: ['SLA breach risk: 1'],
        },
        executive: {
          knowledge_gaps: ['Warranty policy for international returns'],
          operational_insights: ['Return volume up 7% this month'],
        },
      },
    });
  });

  app.use('/bundles', express.static(path.join(rootDir, 'bundles')));
  app.use('/vendor/pglite', express.static(path.join(rootDir, 'node_modules', '@electric-sql', 'pglite', 'dist')));
  app.use(express.static(path.join(rootDir, 'public')));

  app.get('/admin', (_req, res) => {
    res.redirect('/admin.html');
  });

  app.get('/console', (_req, res) => {
    res.redirect('/admin.html');
  });

  app.get('/demo', readLimiter, (_req, res) => {
    res.redirect('/demo.html');
  });

  app.get('/signup', readLimiter, (_req, res) => {
    res.redirect('/signup.html');
  });

  app.get('/onboarding', readLimiter, (_req, res) => {
    res.redirect('/onboarding.html');
  });

  app.get('/tenant', readLimiter, (_req, res) => {
    res.redirect('/tenant.html');
  });

  return app;
}

module.exports = {
  createApp,
};
