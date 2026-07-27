const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BrowserLocalKnowledgeStore,
  ManagedCloudKnowledgeStore,
  CustomerManagedKnowledgeStore,
  createKnowledgeStore,
} = require('../src/lib/knowledgeStore');

test('browser local knowledge store supports CRUD and search contract', async () => {
  const store = new BrowserLocalKnowledgeStore({ id: 'public-store' });
  await store.initialize();
  await store.insert({ id: 'k1', text: 'Refund policy allows returns in 30 days' });
  await store.insert({ id: 'k2', text: 'Warranty policy covers defects' });

  const results = await store.search('refund');
  assert.equal(results[0].id, 'k1');

  const loaded = await store.get('k1');
  assert.ok(loaded.text.includes('Refund policy'));

  const updated = await store.update('k1', { text: 'Updated refund policy' });
  assert.equal(updated.text, 'Updated refund policy');

  const removed = await store.delete('k2');
  assert.equal(removed, true);
});

test('managed and customer managed stores delegate to client hooks', async () => {
  const client = {
    search: async () => [{ id: 'remote-1', text: 'Private rule', score: 1 }],
    permissions: async () => ({ allowed: true, reason: null }),
  };
  const managed = new ManagedCloudKnowledgeStore({ client });
  const customer = new CustomerManagedKnowledgeStore({ client });
  const managedResults = await managed.search('rule', { role: 'Employee' });
  const customerResults = await customer.search('rule', { role: 'Employee' });
  assert.equal(managedResults[0].id, 'remote-1');
  assert.equal(customerResults[0].id, 'remote-1');
});

test('knowledge store factory returns provider by type', () => {
  assert.equal(createKnowledgeStore({ type: 'browser-local' }).constructor.name, 'BrowserLocalKnowledgeStore');
  assert.equal(createKnowledgeStore({ type: 'managed-cloud' }).constructor.name, 'ManagedCloudKnowledgeStore');
  assert.equal(createKnowledgeStore({ type: 'customer-managed' }).constructor.name, 'CustomerManagedKnowledgeStore');
});
