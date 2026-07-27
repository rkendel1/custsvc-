const fs = require('fs');

function sanitizeConnectionString(raw) {
  const input = String(raw || '').trim();
  if (!input) return '';
  try {
    const parsed = new URL(input);
    // Avoid pg-connection-string sslmode warning by using explicit Node ssl config instead.
    parsed.searchParams.delete('sslmode');
    parsed.searchParams.delete('sslrootcert');
    parsed.searchParams.delete('sslcert');
    parsed.searchParams.delete('sslkey');
    parsed.searchParams.delete('uselibpqcompat');
    return parsed.toString();
  } catch (_error) {
    return input;
  }
}

function resolveSslMode(databaseUrl) {
  const envMode = String(process.env.PGSSLMODE || '').trim().toLowerCase();
  if (envMode) return envMode;

  const input = String(databaseUrl || '').trim();
  if (!input) return '';
  try {
    const parsed = new URL(input);
    return String(parsed.searchParams.get('sslmode') || '').trim().toLowerCase();
  } catch (_error) {
    return '';
  }
}

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

function resolveSslConfig(databaseUrl = '') {
  const sslMode = resolveSslMode(databaseUrl);
  if (sslMode === 'disable') return false;

  const inlineCa = normalizeInlinePem(process.env.DATABASE_SSL_CA);
  const inlineCaBase64 = String(process.env.DATABASE_SSL_CA_BASE64 || '').trim();
  const caFilePath = String(process.env.PGSSLROOTCERT || '').trim();
  const rejectUnauthorizedOverride = process.env.PGSSL_REJECT_UNAUTHORIZED;
  const strictRequireCa = parseBoolean(process.env.PGSSL_STRICT_REQUIRE_CA, false);
  let rejectUnauthorized = parseBoolean(rejectUnauthorizedOverride, true);

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
    // libpq `require` does encryption without CA verification. Keep strict verification for verify-full.
    // If strict CA mode is enabled, respect explicit rejectUnauthorized settings.
    if (!strictRequireCa && ['require', 'prefer', 'allow'].includes(sslMode)) {
      rejectUnauthorized = false;
    }
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
      connectionString: sanitizeConnectionString(databaseUrl),
      ssl: resolveSslConfig(databaseUrl),
    };
  }

  if (!host) return null;

  const config = {
    host,
    port: Number(process.env.PGPORT || 5432),
    user: String(process.env.PGUSER || ''),
    password: String(process.env.PGPASSWORD || ''),
    database: String(process.env.PGDATABASE || ''),
    ssl: resolveSslConfig(''),
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