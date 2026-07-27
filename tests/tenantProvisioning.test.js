const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../src/createApp');
const { createStorage } = require('../src/lib/storage');
const { provisionTenant } = require('../src/lib/tenantProvisioner');

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knowledgeos-'));
}

test('tenant provisioner returns launch shape', () => {
  const tenant = provisionTenant({
    companyName: 'Blue Rocket Inc',
    ownerEmail: 'owner@blue-rocket.com',
    deploymentProfile: 'CUSTOMER_WEBSITE',
  });

  assert.equal(tenant.tenant_id, 'blue-rocket-inc');
  assert.equal(tenant.company_name, 'Blue Rocket Inc');
  assert.equal(tenant.owner, 'owner@blue-rocket.com');
  assert.ok(tenant.knowledge_space.id);
  assert.ok(Array.isArray(tenant.roles));
  assert.ok(tenant.runtime_config.deployment_domain.endsWith('.knowledgeos.com'));
});

test('signup provisions tenant and tenant lookup returns dashboard', async (t) => {
  const rootDir = createTempRoot();
  const app = createApp({ rootDir, storage: createStorage(rootDir) });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const signup = await fetch(`${baseUrl}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Taylor',
      email: 'taylor@example.com',
      company: 'Taylor Manufacturing',
      companySize: '51-200',
      primaryUseCase: 'Customer Website',
    }),
  });
  assert.equal(signup.status, 201);
  const data = await signup.json();
  assert.equal(data.tenant.company_name, 'Taylor Manufacturing');

  const tenant = await fetch(`${baseUrl}/api/tenant?tenant_id=${encodeURIComponent(data.tenant.tenant_id)}`);
  assert.equal(tenant.status, 200);
  const tenantData = await tenant.json();
  assert.equal(tenantData.tenant.tenant_id, data.tenant.tenant_id);
  assert.equal(typeof tenantData.dashboard.knowledge_health, 'number');
});

test('documents are tenant-scoped when tenant id is provided', async (t) => {
  const rootDir = createTempRoot();
  const app = createApp({ rootDir, storage: createStorage(rootDir) });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const tenantA = await fetch(`${baseUrl}/api/tenants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ company_name: 'Alpha Co', owner_email: 'owner@alpha.com' }),
  }).then((r) => r.json());

  const tenantB = await fetch(`${baseUrl}/api/tenants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ company_name: 'Beta Co', owner_email: 'owner@beta.com' }),
  }).then((r) => r.json());

  await fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': tenantA.tenant.tenant_id },
    body: JSON.stringify({ title: 'Alpha Policy', body: 'Alpha tenant policy text' }),
  });

  await fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': tenantB.tenant.tenant_id },
    body: JSON.stringify({ title: 'Beta Policy', body: 'Beta tenant policy text' }),
  });

  const docsA = await fetch(`${baseUrl}/api/documents`, {
    headers: { 'x-tenant-id': tenantA.tenant.tenant_id },
  }).then((r) => r.json());

  assert.equal(docsA.documents.length, 1);
  assert.equal(docsA.documents[0].title, 'Alpha Policy');
});

test('deploy enforces membership role and exposes deployment status', async (t) => {
  const rootDir = createTempRoot();
  const storage = createStorage(rootDir);
  const app = createApp({ rootDir, storage });
  const { server, baseUrl } = await startServer(app);
  t.after(() => server.close());

  const signup = await fetch(`${baseUrl}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Owner User',
      email: 'owner@launchco.com',
      company: 'Launch Co',
      companySize: '1-50',
      primaryUseCase: 'Both',
    }),
  }).then((r) => r.json());

  const viewerUser = { user_id: 'user-viewer', tenant_id: signup.tenant.tenant_id, name: 'View Only', email: 'viewer@launchco.com' };
  const users = storage.listUsers();
  users.push(viewerUser);
  storage.saveUsers(users);

  const memberships = storage.listTenantMemberships();
  memberships.push({ tenant_id: signup.tenant.tenant_id, user_id: 'user-viewer', role: 'Viewer', status: 'active' });
  storage.saveTenantMemberships(memberships);

  const denied = await fetch(`${baseUrl}/api/deploy`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': signup.tenant.tenant_id,
      'x-user-id': 'user-viewer',
    },
    body: JSON.stringify({ tenant_id: signup.tenant.tenant_id }),
  });
  assert.equal(denied.status, 403);

  const deployed = await fetch(`${baseUrl}/api/deploy`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': signup.tenant.tenant_id,
      'x-user-id': signup.user.user_id,
    },
    body: JSON.stringify({ tenant_id: signup.tenant.tenant_id }),
  });
  assert.equal(deployed.status, 201);
  const deploymentData = await deployed.json();
  assert.ok(deploymentData.outputs.runtime_url.includes(`${signup.tenant.tenant_id}.knowledgeos.com`));
  assert.ok(deploymentData.outputs.embed_code.includes('data-tenant-id'));

  const status = await fetch(
    `${baseUrl}/api/deployment/status?tenant_id=${encodeURIComponent(signup.tenant.tenant_id)}&deployment_id=${encodeURIComponent(
      deploymentData.deployment.deployment_id,
    )}`,
  );
  assert.equal(status.status, 200);
  const statusData = await status.json();
  assert.equal(statusData.status, 'active');
});
