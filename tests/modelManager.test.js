const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelManager } = require('../src/lib/modelManager');

test('modelManager discovers, downloads, verifies, initializes, and removes models', async () => {
  const manager = createModelManager();
  manager.discoverModels({
    models: [
      {
        id: 'company-assistant-small',
        size: '350mb',
        checksum: { algorithm: 'sha256', value: 'abc123' },
      },
    ],
  });

  const downloaded = await manager.downloadModel('company-assistant-small');
  assert.equal(downloaded.id, 'company-assistant-small');

  const verified = manager.verifyModel('company-assistant-small');
  assert.equal(verified.ok, true);

  const initialized = await manager.initializeModel('company-assistant-small');
  assert.equal(initialized.initialized, true);

  const usage = manager.getStorageUsage();
  assert.ok(usage.usedBytes > 0);
  assert.equal(usage.modelCount, 1);

  const removed = manager.removeModel('company-assistant-small');
  assert.equal(removed.downloaded, false);
});
