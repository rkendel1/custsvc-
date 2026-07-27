const test = require('node:test');
const assert = require('node:assert/strict');
const { createHybridRetriever, selectStores } = require('../src/lib/hybridRetriever');

test('selectStores routes by audience and enforces permissions', () => {
  const profile = {
    mode: 'hybrid',
    stores: [
      { id: 'public', type: 'browser-local', audiences: ['customer'] },
      { id: 'internal', type: 'customer-managed', audiences: ['employee'], permissions: ['store:internal'] },
    ],
  };
  const customerStores = selectStores(profile, { role: 'Customer' });
  assert.equal(customerStores.length, 1);
  assert.equal(customerStores[0].id, 'public');

  const blockedEmployee = selectStores(profile, { role: 'Support', permissions: [] });
  assert.equal(blockedEmployee.length, 0);

  const allowedEmployee = selectStores(profile, { role: 'Support', permissions: ['store:internal'] });
  assert.equal(allowedEmployee.length, 1);
  assert.equal(allowedEmployee[0].id, 'internal');
});

test('hybrid retriever merges parallel results and ranks by score', async () => {
  const retriever = createHybridRetriever({
    deploymentProfile: {
      mode: 'hybrid',
      stores: [
        { id: 'public', type: 'browser-local', audiences: ['customer'] },
        { id: 'internal', type: 'customer-managed', audiences: ['employee'] },
      ],
    },
    storesById: {
      public: { search: async () => [{ id: 'p1', score: 0.4 }] },
      internal: { search: async () => [{ id: 'i1', score: 0.9 }] },
    },
  });

  const customer = await retriever.search('refund', { role: 'Customer' });
  assert.equal(customer.length, 1);
  assert.equal(customer[0].sourceStoreId, 'public');

  const employee = await retriever.search('refund', { role: 'Support' });
  assert.equal(employee.length, 1);
  assert.equal(employee[0].sourceStoreId, 'internal');
});
