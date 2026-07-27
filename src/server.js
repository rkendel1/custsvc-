require('dotenv').config();

const path = require('path');
const { createApp } = require('./createApp');
const { createStorage } = require('./lib/storage');
const { createPgStorage } = require('./lib/pgStorage');
const { hasPgConnectionConfig } = require('./lib/pgConfig');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const rootDir = path.resolve(__dirname, '..');

async function start() {
  let storage = createStorage(rootDir);
  const disablePgLifecycle = String(process.env.PG_LIFECYCLE_BACKEND || '').toLowerCase() === 'false';
  if (hasPgConnectionConfig() && !disablePgLifecycle) {
    const pgStorage = createPgStorage(rootDir);
    await pgStorage.initialize();
    storage = pgStorage;
    console.log('KnowledgeOS lifecycle storage: postgres(app_state)');
  } else {
    console.log('KnowledgeOS lifecycle storage: json');
  }

  const app = createApp({
    rootDir,
    storage,
    companyName: process.env.COMPANY_NAME || 'KnowledgeOS',
  });

  app.listen(PORT, HOST, () => {
    console.log(`KnowledgeOS listening on http://${HOST}:${PORT}`);
  });
}

start().catch((error) => {
  console.error(`Failed to start KnowledgeOS: ${error.message}`);
  process.exitCode = 1;
});
