require('dotenv').config();

const path = require('path');
const { createApp } = require('./createApp');
const { createStorage } = require('./lib/storage');
const { createPgStorage } = require('./lib/pgStorage');
const { hasPgConnectionConfig } = require('./lib/pgConfig');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const rootDir = path.resolve(__dirname, '..');

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parseInteger(value, defaultValue) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultValue;
  return parsed;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function initializePgLifecycleStorage() {
  const maxAttempts = parseInteger(process.env.PG_CONNECT_RETRIES, 8);
  const baseDelayMs = parseInteger(process.env.PG_CONNECT_RETRY_DELAY_MS, 1500);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const pgStorage = createPgStorage(rootDir);
      await pgStorage.initialize();
      return pgStorage;
    } catch (error) {
      lastError = error;
      const retryable = attempt < maxAttempts;
      if (!retryable) break;

      const backoffMs = Math.min(baseDelayMs * attempt, 10_000);
      console.warn(`Postgres lifecycle init failed (attempt ${attempt}/${maxAttempts}): ${error.message}. Retrying in ${backoffMs}ms...`);
      await wait(backoffMs);
    }
  }

  throw lastError || new Error('Postgres lifecycle initialization failed');
}

async function start() {
  let storage = createStorage(rootDir);
  const disablePgLifecycle = String(process.env.PG_LIFECYCLE_BACKEND || '').toLowerCase() === 'false';
  const pgConfigured = hasPgConnectionConfig();
  const allowJsonFallback = parseBoolean(process.env.PG_ALLOW_JSON_FALLBACK, false);
  const requirePgOnStartup = parseBoolean(
    process.env.PG_REQUIRE_ON_STARTUP,
    String(process.env.NODE_ENV || '').toLowerCase() === 'production',
  );

  if (pgConfigured && !disablePgLifecycle) {
    try {
      const pgStorage = await initializePgLifecycleStorage();
      storage = pgStorage;
      console.log('KnowledgeOS lifecycle storage: postgres(app_state)');
    } catch (error) {
      if (requirePgOnStartup && !allowJsonFallback) {
        throw new Error(`Postgres lifecycle required but unavailable: ${error.message}`);
      }
      console.warn(`KnowledgeOS lifecycle storage fallback to json: ${error.message}`);
      storage = createStorage(rootDir);
    }
  } else {
    console.log('KnowledgeOS lifecycle storage: json');
  }

  const app = createApp({
    rootDir,
    storage,
    companyName: process.env.COMPANY_NAME || 'KnowledgeOS',
  });

  const server = app.listen(PORT, HOST, () => {
    console.log(`KnowledgeOS listening on http://${HOST}:${PORT}`);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`KnowledgeOS received ${signal}. Flushing storage and shutting down...`);

    try {
      await Promise.resolve(typeof storage.flush === 'function' ? storage.flush() : null);
      await Promise.resolve(typeof storage.close === 'function' ? storage.close() : null);
    } catch (error) {
      console.error(`KnowledgeOS shutdown flush failed: ${error.message}`);
    }

    server.close(() => {
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
      console.error(`KnowledgeOS shutdown failed: ${error.message}`);
      process.exit(1);
    });
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      console.error(`KnowledgeOS shutdown failed: ${error.message}`);
      process.exit(1);
    });
  });
}

start().catch((error) => {
  console.error(`Failed to start KnowledgeOS: ${error.message}`);
  process.exitCode = 1;
});
