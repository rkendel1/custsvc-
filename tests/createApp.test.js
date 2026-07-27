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
