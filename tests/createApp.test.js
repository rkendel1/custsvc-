const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/createApp');

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function requestJson({ port, requestPath, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        ...headers,
      },
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch (_error) {
          parsed = raw;
        }
        resolve({ statusCode: Number(response.statusCode || 0), body: parsed });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
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

test('access credentials support signup and allow tenant lookup during login', async (t) => {
  const previousAuthSecret = process.env.APP_AUTH_SECRET;
  process.env.APP_AUTH_SECRET = 'test-app-auth-secret';
  t.after(() => {
    if (previousAuthSecret === undefined) {
      delete process.env.APP_AUTH_SECRET;
    } else {
      process.env.APP_AUTH_SECRET = previousAuthSecret;
    }
  });

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledgeos-access-'));
  const tenants = [];
  const onboarding = [];
  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    listTelemetry: () => [],
    saveTelemetry: () => {},
    listTenants: () => [...tenants],
    saveTenants: (nextTenants) => {
      tenants.length = 0;
      tenants.push(...nextTenants);
    },
    listOnboarding: () => [...onboarding],
    saveOnboarding: (nextOnboarding) => {
      onboarding.length = 0;
      onboarding.push(...nextOnboarding);
    },
    listDeployments: () => [],
    saveDeployments: () => {},
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir, storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const signupResponse = await fetch(`${baseUrl}/api/access/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'acme',
      email: 'owner@acme.com',
      password: 'password123',
    }),
  });
  assert.equal(signupResponse.status, 201);
  const signupBody = await signupResponse.json();
  assert.equal(typeof signupBody.next_url, 'string');
  assert.equal(signupBody.next_url.includes('/onboarding.html?tenant_id=acme'), true);

  const statusResponse = await fetch(`${baseUrl}/api/access/status`);
  const statusBody = await statusResponse.json();
  assert.equal(statusBody.auth_mode, 'credentials');
  assert.equal(statusBody.signup_required, false);

  const deniedLogin = await fetch(`${baseUrl}/api/access/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'password123' }),
  });
  assert.equal(deniedLogin.status, 401);

  const inferredTenantLogin = await fetch(`${baseUrl}/api/access/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'owner@acme.com',
      password: 'password123',
    }),
  });
  assert.equal(inferredTenantLogin.status, 200);
  const inferredTenantLoginBody = await inferredTenantLogin.json();
  assert.equal(typeof inferredTenantLoginBody.next_url, 'string');
  assert.equal(inferredTenantLoginBody.next_url.includes('/onboarding.html?tenant_id=acme'), true);

  const loginResponse = await fetch(`${baseUrl}/api/access/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'acme',
      email: 'owner@acme.com',
      password: 'password123',
    }),
  });
  assert.equal(loginResponse.status, 200);
  const loginBody = await loginResponse.json();
  assert.equal(typeof loginBody.next_url, 'string');
  assert.equal(loginBody.next_url.includes('/onboarding.html?tenant_id=acme'), true);

  onboarding.push({ tenant_id: 'acme', step: 'compile-intelligence' });

  const onboardedLoginResponse = await fetch(`${baseUrl}/api/access/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'acme',
      email: 'owner@acme.com',
      password: 'password123',
    }),
  });
  assert.equal(onboardedLoginResponse.status, 200);
  const onboardedLoginBody = await onboardedLoginResponse.json();
  assert.equal(typeof onboardedLoginBody.next_url, 'string');
  assert.equal(onboardedLoginBody.next_url.includes('/admin.html?tenant_id=acme'), true);
});

test('signup is not blocked by tenant scope middleware', async (t) => {
  const previousAuthSecret = process.env.APP_AUTH_SECRET;
  process.env.APP_AUTH_SECRET = 'test-app-auth-secret';
  t.after(() => {
    if (previousAuthSecret === undefined) delete process.env.APP_AUTH_SECRET;
    else process.env.APP_AUTH_SECRET = previousAuthSecret;
  });

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledgeos-access-scope-signup-'));
  const app = createApp({ rootDir });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const firstSignup = await fetch(`${baseUrl}/api/access/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'alpha',
      email: 'owner@alpha.com',
      password: 'password123',
    }),
  });
  assert.equal(firstSignup.status, 201);
  const cookie = firstSignup.headers.get('set-cookie');
  assert.equal(Boolean(cookie), true);

  const secondSignup = await fetch(`${baseUrl}/api/access/signup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({
      tenant_id: 'gofo',
      email: 'randy@kendelconsulting.com',
      password: 'G04broke',
    }),
  });
  const secondBody = await secondSignup.json();

  assert.equal(secondSignup.status, 201);
  assert.equal(secondBody.tenant_id, 'gofo');
});

test('tenant subdomain host resolves tenant scope without explicit tenant_id', async (t) => {
  const previousTenantBaseDomain = process.env.TENANT_BASE_DOMAIN;
  process.env.TENANT_BASE_DOMAIN = 'tryghostpost.com';
  t.after(() => {
    if (previousTenantBaseDomain === undefined) delete process.env.TENANT_BASE_DOMAIN;
    else process.env.TENANT_BASE_DOMAIN = previousTenantBaseDomain;
  });

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledgeos-subdomain-scope-'));
  const app = createApp({ rootDir });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const signup = await fetch(`${baseUrl}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Host Scoped Owner',
      email: 'owner@hostscope.com',
      company: 'Host Scope Co',
    }),
  });
  assert.equal(signup.status, 201);
  const signupBody = await signup.json();
  const tenantId = String(signupBody?.tenant?.tenant_id || '');
  const sessionToken = String(signupBody?.session?.token || '');
  assert.equal(Boolean(tenantId), true);
  assert.equal(Boolean(sessionToken), true);

  const { port } = server.address();
  const tenantResponse = await requestJson({
    port,
    requestPath: '/api/tenant',
    method: 'GET',
    headers: {
      host: `${tenantId}.tryghostpost.com`,
      'x-session-token': sessionToken,
    },
  });

  assert.equal(tenantResponse.statusCode, 200);
  assert.equal(tenantResponse.body?.tenant?.tenant_id, tenantId);
});

test('onboarding standards endpoint returns canonical option sets', async (t) => {
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

  const response = await fetch(`${baseUrl}/api/standards/onboarding`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(Array.isArray(body.company_size_options), true);
  assert.equal(Array.isArray(body.primary_use_case_options), true);
  assert.equal(Array.isArray(body.deployment_profile_options), true);
  assert.equal(Array.isArray(body.audience_options), true);
  assert.equal(Array.isArray(body.import_source_options), true);
  assert.equal(body.company_size_options.some((item) => item.value === '1-50'), true);
  assert.equal(body.primary_use_case_options.some((item) => item.value === 'Customer Website'), true);
  assert.equal(body.deployment_profile_options.some((item) => item.value === 'BOTH'), true);
  assert.equal(body.audience_options.some((item) => item.value === 'Customers'), true);
  assert.equal(body.import_source_options.some((item) => item.value === 'WEBSITE'), true);
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

test('embed runtime auto-provisions deployment and bundle for authenticated tenant', async (t) => {
  const previousAuthSecret = process.env.APP_AUTH_SECRET;
  const previousEmbedSecret = process.env.EMBED_TOKEN_SECRET;
  process.env.APP_AUTH_SECRET = 'test-app-auth-secret';
  process.env.EMBED_TOKEN_SECRET = 'test-embed-token-secret';
  t.after(() => {
    if (previousAuthSecret === undefined) delete process.env.APP_AUTH_SECRET;
    else process.env.APP_AUTH_SECRET = previousAuthSecret;
    if (previousEmbedSecret === undefined) delete process.env.EMBED_TOKEN_SECRET;
    else process.env.EMBED_TOKEN_SECRET = previousEmbedSecret;
  });

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledgeos-embed-autobundle-'));
  const app = createApp({ rootDir });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const signupResponse = await fetch(`${baseUrl}/api/access/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'randy',
      email: 'owner@randy.dev',
      password: 'password123',
    }),
  });
  assert.equal(signupResponse.status, 201);
  const cookie = signupResponse.headers.get('set-cookie');
  assert.equal(Boolean(cookie), true);

  const sessionResponse = await fetch(`${baseUrl}/api/embed/session?tenant_id=randy`, {
    headers: { cookie },
  });
  assert.equal(sessionResponse.status, 200);
  const sessionBody = await sessionResponse.json();
  assert.equal(typeof sessionBody.token, 'string');
  assert.equal(sessionBody.token.length > 10, true);

  const bundleResponse = await fetch(`${baseUrl}/api/embed/bundle?tenant_id=randy`, {
    headers: { 'x-embed-token': sessionBody.token, cookie },
  });
  assert.equal(bundleResponse.status, 200);
  const bundle = await bundleResponse.json();
  assert.equal(bundle.company, 'randy');

  const createDocResponse = await fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({
      title: 'Refund policy',
      body: 'Refunds are available within 30 days of purchase.',
      visibility: 'PUBLIC',
      type: 'POLICY',
    }),
  });
  assert.equal(createDocResponse.status, 201);

  const searchResponse = await fetch(`${baseUrl}/api/embed/search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-embed-token': sessionBody.token,
      cookie,
    },
    body: JSON.stringify({
      tenant_id: 'randy',
      query: 'refund window',
      limit: 3,
      role: 'customer',
    }),
  });
  const searchBody = await searchResponse.json();
  assert.equal(searchResponse.status, 200);
  assert.equal(searchBody.tenant_id, 'randy');
  assert.equal(Array.isArray(searchBody.matches), true);
  assert.equal(searchBody.matches.length >= 1, true);
  assert.equal(searchBody.matches[0].title, 'Refund policy');

  const tenantBundlePath = path.join(rootDir, 'bundles', 'randy.knowledgeos.bundle.json');
  assert.equal(fs.existsSync(tenantBundlePath), true);
});

test('embed session does not auto-provision without authenticated tenant identity', async (t) => {
  const previousEmbedSecret = process.env.EMBED_TOKEN_SECRET;
  process.env.EMBED_TOKEN_SECRET = 'test-embed-token-secret';
  t.after(() => {
    if (previousEmbedSecret === undefined) delete process.env.EMBED_TOKEN_SECRET;
    else process.env.EMBED_TOKEN_SECRET = previousEmbedSecret;
  });

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledgeos-embed-noauth-'));
  const app = createApp({ rootDir });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const onboardingResponse = await fetch(`${baseUrl}/api/onboarding/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'No Auth',
      email: 'owner@noauth.dev',
      company: 'No Auth Co',
    }),
  });
  assert.equal(onboardingResponse.status, 201);
  const onboardingBody = await onboardingResponse.json();
  const tenantId = String(onboardingBody?.tenant?.tenant_id || '').trim();
  assert.equal(Boolean(tenantId), true);

  const sessionResponse = await fetch(`${baseUrl}/api/embed/session?tenant_id=${encodeURIComponent(tenantId)}`);
  assert.equal(sessionResponse.status, 403);
  const sessionBody = await sessionResponse.json();
  assert.equal(sessionBody.error, 'tenant is not deployed yet');

  const tenantBundlePath = path.join(rootDir, 'bundles', `${tenantId}.knowledgeos.bundle.json`);
  assert.equal(fs.existsSync(tenantBundlePath), false);
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

test('documents are strictly scoped per tenant and do not bleed across tenants', async (t) => {
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

  await fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-a' },
    body: JSON.stringify({ title: 'A1', body: 'Tenant A policy' }),
  });

  await fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-b' },
    body: JSON.stringify({ title: 'B1', body: 'Tenant B policy' }),
  });

  const tenantA = await fetch(`${baseUrl}/api/documents`, { headers: { 'x-tenant-id': 'tenant-a' } }).then((r) => r.json());
  const tenantB = await fetch(`${baseUrl}/api/documents`, { headers: { 'x-tenant-id': 'tenant-b' } }).then((r) => r.json());

  assert.equal(tenantA.documents.length, 1);
  assert.equal(tenantB.documents.length, 1);
  assert.equal(tenantA.documents[0].title, 'A1');
  assert.equal(tenantB.documents[0].title, 'B1');
});

test('document vector search endpoint validates embedding payload and returns scoped shape', async (t) => {
  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const badResponse = await fetch(`${baseUrl}/api/documents/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-a' },
    body: JSON.stringify({ embedding: null }),
  });
  assert.equal(badResponse.status, 400);

  const okResponse = await fetch(`${baseUrl}/api/documents/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-a' },
    body: JSON.stringify({ embedding: [0.12, 0.77, -0.3], limit: 3 }),
  });
  const body = await okResponse.json();
  assert.equal(okResponse.status, 200);
  assert.equal(body.tenant_id, 'tenant-a');
  assert.equal(Array.isArray(body.matches), true);
});

test('hybrid search blends semantic, full-text, keyword, and nearest-neighbor scoring', async (t) => {
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

  await fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-a' },
    body: JSON.stringify({
      title: 'Refund policy',
      body: 'Customers can request a full refund within 30 days of purchase.',
      visibility: 'PUBLIC',
      type: 'POLICY',
    }),
  });

  await fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-b' },
    body: JSON.stringify({
      title: 'Internal payroll guide',
      body: 'Payroll closes on the 25th of each month.',
      visibility: 'INTERNAL',
      type: 'SOP',
    }),
  });

  const response = await fetch(`${baseUrl}/api/search/hybrid`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-a' },
    body: JSON.stringify({ query: 'What is the refund window?', limit: 5 }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.tenant_id, 'tenant-a');
  assert.equal(Array.isArray(body.matches), true);
  assert.equal(body.matches.length >= 1, true);
  assert.equal(body.matches[0].title, 'Refund policy');
  assert.equal(typeof body.matches[0].scores.semantic, 'number');
  assert.equal(typeof body.matches[0].scores.full_text, 'number');
  assert.equal(typeof body.matches[0].scores.keyword, 'number');
  assert.equal(typeof body.matches[0].scores.nearest_neighbor, 'number');
});

test('source monitoring endpoints register and sync website sources', async (t) => {
  const documents = [];
  const sources = [];
  const sessions = [{ token: 'owner-token', tenant_id: 'public', user_id: 'owner-1', role: 'Owner', status: 'active' }];
  const memberships = [{ tenant_id: 'public', user_id: 'owner-1', role: 'Owner', status: 'active' }];
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
    listSessions: () => [...sessions],
    saveSessions: () => {},
    listTenantMemberships: () => [...memberships],
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const createResponse = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': 'owner-token' },
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

  const duplicateCreateResponse = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': 'owner-token' },
    body: JSON.stringify({
      name: 'Support Site',
      type: 'WEBSITE',
      site_url: 'https://example.com/help/',
      tenant_id: 'public',
    }),
  });
  const deduped = await duplicateCreateResponse.json();
  assert.equal(duplicateCreateResponse.status, 200);
  assert.equal(deduped.deduped, true);
  assert.equal(deduped.source.source_id, created.source.source_id);

  const syncResponse = await fetch(`${baseUrl}/api/sources/${created.source.source_id}/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': 'owner-token' },
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

test('source sync creates snapshot documents for non-website connectors', async (t) => {
  const documents = [];
  const sources = [];
  const sessions = [{ token: 'owner-token', tenant_id: 'public', user_id: 'owner-1', role: 'Owner', status: 'active' }];
  const memberships = [{ tenant_id: 'public', user_id: 'owner-1', role: 'Owner', status: 'active' }];
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
    listSessions: () => [...sessions],
    saveSessions: () => {},
    listTenantMemberships: () => [...memberships],
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const createResponse = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': 'owner-token' },
    body: JSON.stringify({
      name: 'Internal KB',
      type: 'GENERIC',
      tenant_id: 'public',
      config: { notes: 'seed notes' },
    }),
  });
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201);
  assert.ok(created.source.source_id);

  const syncResponse = await fetch(`${baseUrl}/api/sources/${created.source.source_id}/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': 'owner-token' },
    body: JSON.stringify({ tenant_id: 'public', documents: [] }),
  });
  const synced = await syncResponse.json();
  assert.equal(syncResponse.status, 200);
  assert.equal(synced.synced_count >= 1, true);

  const docsResponse = await fetch(`${baseUrl}/api/documents`, {
    headers: { 'x-session-token': 'owner-token' },
  });
  const docsBody = await docsResponse.json();
  assert.equal(docsResponse.status, 200);
  assert.equal(Array.isArray(docsBody.documents), true);
  assert.equal(docsBody.documents.some((doc) => doc.type === 'SOURCE_SNAPSHOT'), true);
});

test('source listing marks health as error when last sync failed', async (t) => {
  const sources = [
    {
      source_id: 'source-1',
      tenant_id: 'public',
      name: 'Personal website',
      type: 'WEBSITE',
      status: 'connected',
      config: {},
      site_url: 'https://www.randykendel.com/',
      last_sync_status: 'error',
      last_sync_error: 'Website content could not be extracted',
      last_sync_at: new Date().toISOString(),
      poll_minutes: 60,
      secret_fields: [],
      documents_synced: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];
  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    listSources: () => [...sources],
    saveSources: () => {},
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const listResponse = await fetch(`${baseUrl}/api/sources`);
  const listed = await listResponse.json();

  assert.equal(listResponse.status, 200);
  assert.equal(Array.isArray(listed.sources), true);
  assert.equal(listed.sources.length, 1);
  assert.equal(listed.sources[0].health, 'error');
});

test('source document endpoint ingests content and links it to source', async (t) => {
  const documents = [];
  const sources = [];
  const sessions = [{ token: 'owner-token', tenant_id: 'public', user_id: 'owner-1', role: 'Owner', status: 'active' }];
  const memberships = [{ tenant_id: 'public', user_id: 'owner-1', role: 'Owner', status: 'active' }];
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
    listSessions: () => [...sessions],
    saveSessions: () => {},
    listTenantMemberships: () => [...memberships],
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const createResponse = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': 'owner-token' },
    body: JSON.stringify({
      name: 'Support Site',
      type: 'WEBSITE',
      site_url: 'https://example.com/help',
      tenant_id: 'public',
    }),
  });
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201);

  const ingestResponse = await fetch(`${baseUrl}/api/sources/${created.source.source_id}/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': 'owner-token' },
    body: JSON.stringify({
      title: 'Returns',
      body: 'Returns are accepted within 30 days.',
      type: 'POLICY',
      visibility: 'PUBLIC',
    }),
  });
  const ingested = await ingestResponse.json();

  assert.equal(ingestResponse.status, 201);
  assert.equal(ingested.document.source_id, created.source.source_id);
  assert.equal(ingested.document.tenant_id, 'public');
  assert.equal(documents.length >= 1, true);
  assert.equal(documents.some((doc) => doc.source_id === created.source.source_id && doc.title === 'Returns'), true);
});

test('source endpoints accept console cookie auth without session token', async (t) => {
  const previousAuthSecret = process.env.APP_AUTH_SECRET;
  process.env.APP_AUTH_SECRET = 'test-app-auth-secret';
  t.after(() => {
    if (previousAuthSecret === undefined) delete process.env.APP_AUTH_SECRET;
    else process.env.APP_AUTH_SECRET = previousAuthSecret;
  });

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledgeos-source-cookie-auth-'));
  const app = createApp({ rootDir });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const signup = await fetch(`${baseUrl}/api/access/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'cookieco',
      email: 'owner@cookieco.dev',
      password: 'password123',
    }),
  });
  assert.equal(signup.status, 201);
  const cookie = signup.headers.get('set-cookie');
  assert.equal(Boolean(cookie), true);

  const sourceCreate = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({
      name: 'Cookie Source',
      type: 'GENERIC',
      config: { notes: 'cookie auth path' },
    }),
  });
  assert.equal(sourceCreate.status, 201);
  const created = await sourceCreate.json();

  const sourceDoc = await fetch(`${baseUrl}/api/sources/${created.source.source_id}/documents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({
      title: 'Cookie-auth document',
      body: 'This source document was ingested via console cookie auth.',
      visibility: 'INTERNAL',
    }),
  });
  const sourceDocBody = await sourceDoc.json();
  assert.equal(sourceDoc.status, 201);
  assert.equal(sourceDocBody.document.title, 'Cookie-auth document');

  const badPdf = new FormData();
  badPdf.set('file', new Blob([Buffer.from('not-a-real-pdf')], { type: 'application/pdf' }), 'invalid.pdf');
  badPdf.set('title', 'Invalid PDF');

  const pdfUpload = await fetch(`${baseUrl}/api/sources/${created.source.source_id}/documents/pdf`, {
    method: 'POST',
    headers: { cookie },
    body: badPdf,
  });
  assert.equal(pdfUpload.status !== 401, true);
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
  const sessions = [{ token: 'owner-token', tenant_id: 'public', user_id: 'owner-1', role: 'Owner', status: 'active' }];
  const memberships = [{ tenant_id: 'public', user_id: 'owner-1', role: 'Owner', status: 'active' }];
  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    listSources: () => [...sources],
    saveSources: (nextSources) => {
      sources.length = 0;
      sources.push(...nextSources);
    },
    listSessions: () => [...sessions],
    saveSessions: () => {},
    listTenantMemberships: () => [...memberships],
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const invalidResponse = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': 'owner-token' },
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
    headers: { 'content-type': 'application/json', 'x-session-token': 'owner-token' },
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
  const sessions = [{ token: 'owner-token', tenant_id: 'public', user_id: 'owner-1', role: 'Owner', status: 'active' }];
  const memberships = [{ tenant_id: 'public', user_id: 'owner-1', role: 'Owner', status: 'active' }];
  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    listSources: () => [...sources],
    saveSources: (nextSources) => {
      sources.length = 0;
      sources.push(...nextSources);
    },
    listSessions: () => [...sessions],
    saveSessions: () => {},
    listTenantMemberships: () => [...memberships],
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const createResponse = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': 'owner-token' },
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
    headers: { 'content-type': 'application/json', 'x-session-token': 'owner-token' },
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
  const sessions = [{ token: 'owner-token', tenant_id: 'public', user_id: 'owner-1', role: 'Owner', status: 'active' }];
  const memberships = [{ tenant_id: 'public', user_id: 'owner-1', role: 'Owner', status: 'active' }];
  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    listSources: () => [...sources],
    saveSources: (nextSources) => {
      sources.length = 0;
      sources.push(...nextSources);
    },
    listSessions: () => [...sessions],
    saveSessions: () => {},
    listTenantMemberships: () => [...memberships],
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const createResponse = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': 'owner-token' },
    body: JSON.stringify({
      name: 'Generic KB',
      type: 'GENERIC',
      tenant_id: 'public',
      config: { notes: 'local-test' },
    }),
  });
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201);

  const testResponse = await fetch(`${baseUrl}/api/sources/${created.source.source_id}/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': 'owner-token' },
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
  const connectorSecrets = [];
  const sessions = [{ token: 'owner-token', tenant_id: 'public', user_id: 'owner-1', role: 'Owner', status: 'active' }];
  const memberships = [{ tenant_id: 'public', user_id: 'owner-1', role: 'Owner', status: 'active' }];
  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    listSources: () => [...sources],
    saveSources: (nextSources) => {
      sources.length = 0;
      sources.push(...nextSources);
    },
    listSessions: () => [...sessions],
    saveSessions: () => {},
    listTenantMemberships: () => [...memberships],
    listConnectorSecrets: () => [...connectorSecrets],
    saveConnectorSecrets: (nextSecrets) => {
      connectorSecrets.length = 0;
      connectorSecrets.push(...nextSecrets);
    },
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': 'owner-token' },
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
  assert.equal(typeof sources[0].config.token, 'undefined');
  assert.equal(String(connectorSecrets[0].encrypted_payload || '').startsWith('enc:v1:'), true);
});

test('source audit trail records connector lifecycle events', async (t) => {
  const sources = [];
  const connectorAudit = [];
  const sessions = [{ token: 'owner-token', tenant_id: 'public', user_id: 'owner-1', role: 'Owner', status: 'active' }];
  const memberships = [{ tenant_id: 'public', user_id: 'owner-1', role: 'Owner', status: 'active' }];
  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    listSources: () => [...sources],
    saveSources: (nextSources) => {
      sources.length = 0;
      sources.push(...nextSources);
    },
    listSessions: () => [...sessions],
    saveSessions: () => {},
    listTenantMemberships: () => [...memberships],
    listConnectorAudit: () => [...connectorAudit],
    saveConnectorAudit: (nextAudit) => {
      connectorAudit.length = 0;
      connectorAudit.push(...nextAudit);
    },
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const created = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': 'owner-token' },
    body: JSON.stringify({ name: 'Website Docs', type: 'WEBSITE', site_url: 'https://example.com/help', tenant_id: 'public' }),
  }).then((r) => r.json());

  await fetch(`${baseUrl}/api/sources/${created.source.source_id}/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': 'owner-token' },
    body: JSON.stringify({ tenant_id: 'public' }),
  });

  const audit = await fetch(`${baseUrl}/api/sources/audit?tenant_id=public`, { headers: { 'x-session-token': 'owner-token' } }).then((r) => r.json());
  assert.equal(Array.isArray(audit.events), true);
  assert.equal(audit.events.some((event) => event.action === 'source.create'), true);
  assert.equal(audit.events.some((event) => event.action === 'source.test'), true);
});

test('source mutation endpoints enforce owner/admin RBAC', async (t) => {
  const sources = [];
  const sessions = [{ token: 'member-token', tenant_id: 'public', user_id: 'member-1', role: 'Member', status: 'active' }];
  const memberships = [{ tenant_id: 'public', user_id: 'member-1', role: 'Member', status: 'active' }];
  const storage = {
    listDocuments: () => [],
    saveDocuments: () => {},
    listSources: () => [...sources],
    saveSources: (nextSources) => {
      sources.length = 0;
      sources.push(...nextSources);
    },
    listSessions: () => [...sessions],
    saveSessions: () => {},
    listTenantMemberships: () => [...memberships],
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const createResponse = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': 'member-token' },
    body: JSON.stringify({ name: 'Blocked Source', type: 'WEBSITE', site_url: 'https://example.com/help', tenant_id: 'public' }),
  });
  assert.equal(createResponse.status, 403);

  const auditResponse = await fetch(`${baseUrl}/api/sources/audit?tenant_id=public`, {
    headers: { 'x-session-token': 'member-token' },
  });
  assert.equal(auditResponse.status, 403);
});

test('setup mode relaxes tenant session and role enforcement for source setup', async (t) => {
  const previousRelaxSecurity = process.env.KNOWLEDGEOS_RELAX_SECURITY;
  process.env.KNOWLEDGEOS_RELAX_SECURITY = 'true';
  t.after(() => {
    if (previousRelaxSecurity === undefined) {
      delete process.env.KNOWLEDGEOS_RELAX_SECURITY;
    } else {
      process.env.KNOWLEDGEOS_RELAX_SECURITY = previousRelaxSecurity;
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
    listSessions: () => [],
    saveSessions: () => {},
    listTenantMemberships: () => [],
    writeBundle: () => ({ bundleFileName: 'company.intelligence.bundle.json' }),
  };

  const app = createApp({ rootDir: os.tmpdir(), storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const createResponse = await fetch(`${baseUrl}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Setup Source', type: 'WEBSITE', site_url: 'https://example.com/help' }),
  });
  assert.equal(createResponse.status, 201);

  const auditResponse = await fetch(`${baseUrl}/api/sources/audit`);
  assert.equal(auditResponse.status, 200);
});
