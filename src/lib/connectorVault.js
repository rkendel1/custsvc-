const { randomUUID } = require('crypto');
const { buildPgConnectionConfig, hasPgConnectionConfig } = require('./pgConfig');

let Pool = null;
try {
  ({ Pool } = require('pg'));
} catch (_error) {
  Pool = null;
}

function nowIso() {
  return new Date().toISOString();
}

function createConnectorVault({ storage }) {
  const usePostgres = Boolean(Pool && hasPgConnectionConfig());
  const keyVersion = Number(process.env.SOURCE_SECRET_KEY_VERSION || 1);

  let pool = null;
  let initialized = false;

  async function ensureSchema() {
    if (!usePostgres) return;
    if (initialized) return;
    if (!pool) {
      const connectionConfig = buildPgConnectionConfig();
      if (!connectionConfig) return;
      pool = new Pool(connectionConfig);
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS connector_secrets (
        tenant_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        key_version INTEGER NOT NULL,
        algorithm TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, source_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS connector_audit_log (
        audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id TEXT NOT NULL,
        source_id TEXT NULL,
        actor_user_id TEXT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    initialized = true;
  }

  async function setSecrets({ tenantId, sourceId, encryptedPayload, algorithm = 'aes-256-gcm' }) {
    if (!tenantId || !sourceId) return;
    if (usePostgres) {
      await ensureSchema();
      await pool.query(
        `
          INSERT INTO connector_secrets (tenant_id, source_id, key_version, algorithm, encrypted_payload, rotated_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (tenant_id, source_id)
          DO UPDATE SET
            key_version = EXCLUDED.key_version,
            algorithm = EXCLUDED.algorithm,
            encrypted_payload = EXCLUDED.encrypted_payload,
            rotated_at = NOW()
        `,
        [tenantId, sourceId, keyVersion, algorithm, encryptedPayload],
      );
      return;
    }

    const items = typeof storage.listConnectorSecrets === 'function' ? storage.listConnectorSecrets() : [];
    const idx = items.findIndex((item) => item.tenant_id === tenantId && item.source_id === sourceId);
    const next = {
      tenant_id: tenantId,
      source_id: sourceId,
      key_version: keyVersion,
      algorithm,
      encrypted_payload: encryptedPayload,
      created_at: idx >= 0 ? items[idx].created_at : nowIso(),
      rotated_at: nowIso(),
    };
    if (idx >= 0) items[idx] = next;
    else items.push(next);
    if (typeof storage.saveConnectorSecrets === 'function') storage.saveConnectorSecrets(items);
  }

  async function getSecrets({ tenantId, sourceId }) {
    if (!tenantId || !sourceId) return null;

    if (usePostgres) {
      await ensureSchema();
      const result = await pool.query(
        `SELECT tenant_id, source_id, key_version, algorithm, encrypted_payload, created_at, rotated_at
         FROM connector_secrets WHERE tenant_id = $1 AND source_id = $2 LIMIT 1`,
        [tenantId, sourceId],
      );
      return result.rows[0] || null;
    }

    const items = typeof storage.listConnectorSecrets === 'function' ? storage.listConnectorSecrets() : [];
    return items.find((item) => item.tenant_id === tenantId && item.source_id === sourceId) || null;
  }

  async function deleteSecrets({ tenantId, sourceId }) {
    if (!tenantId || !sourceId) return;

    if (usePostgres) {
      await ensureSchema();
      await pool.query('DELETE FROM connector_secrets WHERE tenant_id = $1 AND source_id = $2', [tenantId, sourceId]);
      return;
    }

    const items = typeof storage.listConnectorSecrets === 'function' ? storage.listConnectorSecrets() : [];
    const filtered = items.filter((item) => !(item.tenant_id === tenantId && item.source_id === sourceId));
    if (typeof storage.saveConnectorSecrets === 'function') storage.saveConnectorSecrets(filtered);
  }

  async function appendAudit(event) {
    const entry = {
      audit_id: `audit-${randomUUID()}`,
      tenant_id: String(event.tenant_id || 'public'),
      source_id: event.source_id || null,
      actor_user_id: event.actor_user_id || null,
      action: String(event.action || 'unknown'),
      status: String(event.status || 'ok'),
      details: event.details && typeof event.details === 'object' ? event.details : {},
      created_at: nowIso(),
    };

    if (usePostgres) {
      await ensureSchema();
      await pool.query(
        `
          INSERT INTO connector_audit_log (tenant_id, source_id, actor_user_id, action, status, details)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        `,
        [entry.tenant_id, entry.source_id, entry.actor_user_id, entry.action, entry.status, JSON.stringify(entry.details)],
      );
      return entry;
    }

    const items = typeof storage.listConnectorAudit === 'function' ? storage.listConnectorAudit() : [];
    items.push(entry);
    if (typeof storage.saveConnectorAudit === 'function') storage.saveConnectorAudit(items);
    return entry;
  }

  async function listAudit({ tenantId, limit = 100 }) {
    const safeLimit = Math.min(Math.max(Number(limit || 100), 1), 500);

    if (usePostgres) {
      await ensureSchema();
      const result = await pool.query(
        `
          SELECT audit_id, tenant_id, source_id, actor_user_id, action, status, details, created_at
          FROM connector_audit_log
          WHERE tenant_id = $1
          ORDER BY created_at DESC
          LIMIT $2
        `,
        [tenantId, safeLimit],
      );
      return result.rows;
    }

    const items = typeof storage.listConnectorAudit === 'function' ? storage.listConnectorAudit() : [];
    return items
      .filter((item) => item.tenant_id === tenantId)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, safeLimit);
  }

  function getState() {
    return {
      driver: usePostgres ? 'postgres' : 'json-fallback',
      keyVersion,
    };
  }

  return {
    setSecrets,
    getSecrets,
    deleteSecrets,
    appendAudit,
    listAudit,
    getState,
  };
}

module.exports = {
  createConnectorVault,
};
