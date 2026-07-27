const { Pool } = require('pg');
const { createStorage } = require('./storage');
const { buildPgConnectionConfig, hasPgConnectionConfig } = require('./pgConfig');

const STATE_KEYS = {
  documents: 'documents',
  telemetry: 'telemetry',
  tenants: 'tenants',
  users: 'users',
  tenantMemberships: 'tenant_memberships',
  subscriptions: 'subscriptions',
  deployments: 'deployments',
  runtimeInstances: 'runtime_instances',
  onboarding: 'onboarding',
  sessions: 'sessions',
  sources: 'sources',
  connectorSecrets: 'connector_secrets',
  connectorAudit: 'connector_audit',
};

function cloneArray(value) {
  const arr = Array.isArray(value) ? value : [];
  return JSON.parse(JSON.stringify(arr));
}

function createPgStorage(baseDir) {
  if (!hasPgConnectionConfig()) {
    throw new Error('Postgres storage requested but DATABASE_URL/PGHOST configuration is missing.');
  }

  const fileStorage = createStorage(baseDir);
  const pool = new Pool(buildPgConnectionConfig());
  const state = {
    documents: [],
    telemetry: [],
    tenants: [],
    users: [],
    tenantMemberships: [],
    subscriptions: [],
    deployments: [],
    runtimeInstances: [],
    onboarding: [],
    sessions: [],
    sources: [],
    connectorSecrets: [],
    connectorAudit: [],
  };

  let ready = false;
  let writeChain = Promise.resolve();

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        state_key TEXT PRIMARY KEY,
        payload JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async function loadState() {
    const result = await pool.query('SELECT state_key, payload FROM app_state');
    const map = new Map(result.rows.map((row) => [String(row.state_key), row.payload]));

    for (const [localKey, stateKey] of Object.entries(STATE_KEYS)) {
      const payload = map.get(stateKey);
      state[localKey] = Array.isArray(payload) ? payload : [];
    }
  }

  async function initialize() {
    await ensureSchema();
    await loadState();
    ready = true;
  }

  function persist(localKey) {
    const stateKey = STATE_KEYS[localKey];
    const payload = cloneArray(state[localKey]);

    writeChain = writeChain.then(async () => {
      await pool.query(
        `
          INSERT INTO app_state (state_key, payload, updated_at)
          VALUES ($1, $2::jsonb, NOW())
          ON CONFLICT (state_key)
          DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
        `,
        [stateKey, JSON.stringify(payload)],
      );
    }).catch((error) => {
      console.error(`Failed to persist ${stateKey} to Postgres app_state: ${error.message}`);
    });
  }

  function mustBeReady() {
    if (ready) return;
    throw new Error('Postgres storage is not initialized. Call initialize() before use.');
  }

  function list(localKey) {
    mustBeReady();
    return cloneArray(state[localKey]);
  }

  function save(localKey, value) {
    mustBeReady();
    state[localKey] = cloneArray(value);
    persist(localKey);
  }

  return {
    dataDir: fileStorage.dataDir,
    bundlesDir: fileStorage.bundlesDir,
    initialize,
    flush: async () => writeChain,
    close: async () => {
      await writeChain;
      await pool.end();
    },

    listDocuments: () => list('documents'),
    saveDocuments: (value) => save('documents', value),

    listTelemetry: () => list('telemetry'),
    saveTelemetry: (value) => save('telemetry', value),

    listTenants: () => list('tenants'),
    saveTenants: (value) => save('tenants', value),

    listUsers: () => list('users'),
    saveUsers: (value) => save('users', value),

    listTenantMemberships: () => list('tenantMemberships'),
    saveTenantMemberships: (value) => save('tenantMemberships', value),

    listSubscriptions: () => list('subscriptions'),
    saveSubscriptions: (value) => save('subscriptions', value),

    listDeployments: () => list('deployments'),
    saveDeployments: (value) => save('deployments', value),

    listRuntimeInstances: () => list('runtimeInstances'),
    saveRuntimeInstances: (value) => save('runtimeInstances', value),

    listOnboarding: () => list('onboarding'),
    saveOnboarding: (value) => save('onboarding', value),

    listSessions: () => list('sessions'),
    saveSessions: (value) => save('sessions', value),

    listSources: () => list('sources'),
    saveSources: (value) => save('sources', value),

    listConnectorSecrets: () => list('connectorSecrets'),
    saveConnectorSecrets: (value) => save('connectorSecrets', value),

    listConnectorAudit: () => list('connectorAudit'),
    saveConnectorAudit: (value) => save('connectorAudit', value),

    writeBundle: (name, bundle) => fileStorage.writeBundle(name, bundle),
  };
}

module.exports = {
  createPgStorage,
};
