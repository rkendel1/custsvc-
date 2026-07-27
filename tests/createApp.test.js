const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const { createApp } = require('../src/createApp');

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('createApp requires SOURCE_SECRET_KEY in production', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousSecret = process.env.SOURCE_SECRET_KEY;
  process.env.NODE_ENV = 'production';
  delete process.env.SOURCE_SECRET_KEY;
  try {
    assert.throws(() => createApp({ rootDir: os.tmpdir(), storage: { writeBundle: () => ({ bundleFileName: 'bundle.json' }) } }));
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    if (previousSecret === undefined) {
      delete process.env.SOURCE_SECRET_KEY;
    } else {
      process.env.SOURCE_SECRET_KEY = previousSecret;
    }
  }
});

test('telemetry endpoint accepts privacy-preserving payload without question content', async (t) => {
  const telemetry = [];
  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    listTelemetry: () => [...telemetry],
    saveTelemetry: (events) => {
      telemetry.length = 0;
      telemetry.push(...events);
    },
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };
  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/telemetry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intent: 'refund_request',
      confidence: 0.91,
      knowledge_gap: true,
      process_started: true,
      duration: 45,
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].intent, 'refund_request');
  assert.equal(Object.hasOwn(telemetry[0], 'question'), false);
});

test('telemetry endpoint rejects payloads without question and intent', async (t) => {
  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    listTelemetry: () => [],
    saveTelemetry: () => {},
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };
  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/telemetry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confidence: 0.2 }),
  });
  assert.equal(response.status, 400);
});

test('onboarding resolves tenant_id from session token when tenant_id is omitted', async (t) => {
  const now = Date.now();
  const sessions = [
    {
      token: 'kos_test_token',
      tenant_id: 'acme',
      user_id: 'user-acme-owner',
      status: 'active',
      expires_at: new Date(now + 60_000).toISOString(),
    },
  ];
  const onboarding = [];

  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    listTelemetry: () => [],
    saveTelemetry: () => {},
    listSessions: () => [...sessions],
    saveSessions: (nextSessions) => {
      sessions.length = 0;
      sessions.push(...nextSessions);
    },
    listOnboarding: () => [...onboarding],
    saveOnboarding: (nextOnboarding) => {
      onboarding.length = 0;
      onboarding.push(...nextOnboarding);
    },
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/onboarding`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-session-token': 'kos_test_token',
    },
    body: JSON.stringify({
      step: 'compile-intelligence',
      deploymentChoice: 'Both',
      importSources: ['Upload documents'],
      audiences: ['Customers', 'Employees'],
    }),
  });

  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.onboarding.tenant_id, 'acme');
});

test('bulk documents endpoint ingests valid items and reports rejects', async (t) => {
  const documents = [];
  const storage = {
    listDocuments: () => [...documents],
    saveDocuments: (nextDocuments) => {
      documents.length = 0;
      documents.push(...nextDocuments);
    },
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/documents/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [
        { title: 'Policy A', body: 'Refund within 30 days', type: 'POLICY' },
        { title: '', body: 'Invalid' },
      ],
    }),
  });

  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.inserted_count, 1);
  assert.equal(body.rejected_count, 1);
  assert.equal(documents.length >= 1, true);
});

test('source monitoring endpoints register and sync website sources', async (t) => {
  const documents = [];
  const sources = [];
  const storage = {
    listDocuments: () => [...documents],
    saveDocuments: (nextDocuments) => {
      documents.length = 0;
      documents.push(...nextDocuments);
    },
    listSources: () => [...sources],
    saveSources: (nextSources) => {
      sources.length = 0;
      sources.push(...nextSources);
    },
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const createResponse = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Support Site',
      type: 'WEBSITE',
      site_url: 'https://example.com/help',
      tenant_id: 'public',
    }),
  });
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201);
  assert.ok(created.source.source_id);

  const syncResponse = await fetch(`${baseUrl}/api/sources/${created.source.source_id}/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'public',
      documents: [{ title: 'FAQ', body: 'Contact support via portal.' }],
    }),
  });
  const synced = await syncResponse.json();
  assert.equal(syncResponse.status, 200);
  assert.equal(synced.synced_count, 1);

  const listResponse = await fetch(`${baseUrl}/api/sources`);
  const listed = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(Array.isArray(listed.sources), true);
  assert.equal(listed.sources.length, 1);
});

test('source templates endpoint returns connector field requirements', async (t) => {
  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    listSources: () => [],
    saveSources: () => {},
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/sources/templates`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(Array.isArray(body.templates), true);
  assert.equal(body.templates.some((template) => template.type === 'SHAREPOINT'), true);
});

test('source creation enforces required credentials and redacts sensitive fields', async (t) => {
  const sources = [];
  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    listSources: () => [...sources],
    saveSources: (nextSources) => {
      sources.length = 0;
      sources.push(...nextSources);
    },
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const invalidResponse = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'SharePoint Help Center',
      type: 'SHAREPOINT',
      tenant_id: 'public',
    }),
  });
  const invalidBody = await invalidResponse.json();
  assert.equal(invalidResponse.status, 400);
  assert.equal(Array.isArray(invalidBody.missing), true);
  assert.equal(invalidBody.missing.includes('client_secret'), true);

  const validResponse = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'SharePoint Help Center',
      type: 'SHAREPOINT',
      tenant_id: 'public',
      credentials: {
        tenant_id: 'tenant-123',
        site_id: 'site-123',
        client_id: 'client-123',
        client_secret: 'secret-value',
      },
    }),
  });
  const validBody = await validResponse.json();
  assert.equal(validResponse.status, 201);
  assert.equal(validBody.source.config.client_secret, '***');

  const listResponse = await fetch(`${baseUrl}/api/sources`);
  const listed = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(listed.sources[0].config.client_secret, '***');
});

test('source update rotates credentials and keeps sensitive fields redacted', async (t) => {
  const sources = [];
  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    listSources: () => [...sources],
    saveSources: (nextSources) => {
      sources.length = 0;
      sources.push(...nextSources);
    },
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const createResponse = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'SharePoint Docs',
      type: 'SHAREPOINT',
      tenant_id: 'public',
      credentials: {
        tenant_id: 'tenant-1',
        site_id: 'site-1',
        client_id: 'client-1',
        client_secret: 'old-secret',
      },
    }),
  });
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201);

  const updateResponse = await fetch(`${baseUrl}/api/sources/${created.source.source_id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'public',
      name: 'SharePoint Docs Rotated',
      credentials: {
        client_secret: 'new-secret',
      },
    }),
  });
  const updated = await updateResponse.json();
  assert.equal(updateResponse.status, 200);
  assert.equal(updated.source.name, 'SharePoint Docs Rotated');
  assert.equal(updated.source.config.client_secret, '***');
});

test('source test endpoint validates connector state and updates source status', async (t) => {
  const sources = [];
  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    listSources: () => [...sources],
    saveSources: (nextSources) => {
      sources.length = 0;
      sources.push(...nextSources);
    },
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const createResponse = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Confluence KB',
      type: 'CONFLUENCE',
      tenant_id: 'public',
      credentials: {
        workspace: 'acme',
        email: 'admin@example.com',
        api_token: 'token-123',
      },
    }),
  });
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201);

  const testResponse = await fetch(`${baseUrl}/api/sources/${created.source.source_id}/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_id: 'public' }),
  });
  const tested = await testResponse.json();
  assert.equal(testResponse.status, 200);
  assert.equal(tested.ok, true);
  assert.equal(tested.source.health === 'pending' || tested.source.health === 'healthy', true);
});

test('source credentials are encrypted at rest when SOURCE_SECRET_KEY is configured', async (t) => {
  const originalSecret = process.env.SOURCE_SECRET_KEY;
  process.env.SOURCE_SECRET_KEY = 'test-secret-key-material';
  t.after(() => {
    if (originalSecret === undefined) {
      delete process.env.SOURCE_SECRET_KEY;
    } else {
      process.env.SOURCE_SECRET_KEY = originalSecret;
    }
  });

  const sources = [];
  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    listSources: () => [...sources],
    saveSources: (nextSources) => {
      sources.length = 0;
      sources.push(...nextSources);
    },
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'GitHub Docs',
      type: 'GITHUB',
      tenant_id: 'public',
      credentials: {
        org_or_owner: 'acme',
        token: 'ghp_123456',
      },
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.source.config.token, '***');
  assert.equal(String(sources[0].config.token || '').startsWith('enc:v1:'), true);
});
