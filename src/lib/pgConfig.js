const fs = require('fs');

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function normalizeInlinePem(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function resolveSslConfig() {
  const sslMode = String(process.env.PGSSLMODE || '').trim().toLowerCase();
  if (sslMode === 'disable') return false;

  const inlineCa = normalizeInlinePem(process.env.DATABASE_SSL_CA);
  const inlineCaBase64 = String(process.env.DATABASE_SSL_CA_BASE64 || '').trim();
  const caFilePath = String(process.env.PGSSLROOTCERT || '').trim();
  const rejectUnauthorized = parseBoolean(process.env.PGSSL_REJECT_UNAUTHORIZED, true);

  let ca = '';
  if (inlineCa) {
    ca = inlineCa;
  } else if (inlineCaBase64) {
    try {
      ca = Buffer.from(inlineCaBase64, 'base64').toString('utf8').trim();
    } catch (_error) {
      ca = '';
    }
  } else if (caFilePath) {
    try {
      ca = fs.readFileSync(caFilePath, 'utf8').trim();
    } catch (_error) {
      ca = '';
    }
  }

  if (!ca) {
    return { rejectUnauthorized };
  }

  return {
    rejectUnauthorized,
    ca,
  };
}

function buildPgConnectionConfig() {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  const host = String(process.env.PGHOST || '').trim();

  if (databaseUrl) {
    return {
      connectionString: databaseUrl,
      ssl: resolveSslConfig(),
    };
  }

  if (!host) return null;

  const config = {
    host,
    port: Number(process.env.PGPORT || 5432),
    user: String(process.env.PGUSER || ''),
    password: String(process.env.PGPASSWORD || ''),
    database: String(process.env.PGDATABASE || ''),
    ssl: resolveSslConfig(),
  };

  return config;
}

function hasPgConnectionConfig() {
  return Boolean(buildPgConnectionConfig());
}

module.exports = {
  buildPgConnectionConfig,
  hasPgConnectionConfig,
};