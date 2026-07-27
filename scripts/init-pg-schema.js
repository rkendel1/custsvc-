require('dotenv').config();

const { Client } = require('pg');
const { buildPgConnectionConfig } = require('../src/lib/pgConfig');

const statements = [
  'CREATE EXTENSION IF NOT EXISTS pgcrypto',
  'CREATE EXTENSION IF NOT EXISTS vector',
  `
  CREATE TABLE IF NOT EXISTS tenants (
    tenant_id TEXT PRIMARY KEY,
    company_name TEXT NOT NULL,
    owner TEXT NULL,
    deployment_profile TEXT NOT NULL DEFAULT 'BOTH',
    knowledge_space JSONB NOT NULL DEFAULT '{}'::jsonb,
    audiences JSONB NOT NULL DEFAULT '[]'::jsonb,
    roles JSONB NOT NULL DEFAULT '[]'::jsonb,
    runtime_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    company_size TEXT NULL,
    primary_use_case TEXT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    owner_user_id TEXT NULL,
    seeded BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  'CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users (tenant_id)',
  `
  CREATE TABLE IF NOT EXISTS tenant_memberships (
    tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, user_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
  )
  `,
  'CREATE INDEX IF NOT EXISTS idx_sessions_tenant_id ON sessions (tenant_id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id)',
  `
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    type TEXT NULL,
    visibility TEXT NULL,
    audience TEXT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  'CREATE INDEX IF NOT EXISTS idx_documents_tenant_id ON documents (tenant_id)',
  `
  CREATE TABLE IF NOT EXISTS subscriptions (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    plan TEXT NOT NULL,
    usage JSONB NOT NULL DEFAULT '{}'::jsonb,
    limits JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS deployments (
    deployment_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    company_name TEXT NULL,
    status TEXT NOT NULL,
    deployment_profile TEXT NOT NULL DEFAULT 'BOTH',
    runtime_url TEXT NOT NULL,
    audience_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
    bundle JSONB NOT NULL DEFAULT '{}'::jsonb,
    permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
    branding JSONB NOT NULL DEFAULT '{}'::jsonb,
    embed_code TEXT NOT NULL,
    api_key TEXT NOT NULL,
    deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  'CREATE INDEX IF NOT EXISTS idx_deployments_tenant_id ON deployments (tenant_id)',
  `
  CREATE TABLE IF NOT EXISTS runtime_instances (
    runtime_instance_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    deployment_id TEXT NULL REFERENCES deployments(deployment_id) ON DELETE SET NULL,
    status TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  'CREATE INDEX IF NOT EXISTS idx_runtime_instances_tenant_id ON runtime_instances (tenant_id)',
  `
  CREATE TABLE IF NOT EXISTS onboarding (
    onboarding_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    user_id TEXT NULL,
    step TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  'CREATE INDEX IF NOT EXISTS idx_onboarding_tenant_id ON onboarding (tenant_id)',
  `
  CREATE TABLE IF NOT EXISTS telemetry_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL DEFAULT 'public',
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    intent TEXT NULL,
    answered BOOLEAN NULL,
    score DOUBLE PRECISION NULL,
    confidence DOUBLE PRECISION NULL,
    knowledge_gap BOOLEAN NULL,
    process_started BOOLEAN NULL,
    duration INTEGER NULL,
    top_chunk_id TEXT NULL,
    role TEXT NULL,
    department TEXT NULL,
    permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb
  )
  `,
  'CREATE INDEX IF NOT EXISTS idx_telemetry_tenant_id_timestamp ON telemetry_events (tenant_id, timestamp DESC)',
  `
  CREATE TABLE IF NOT EXISTS sources (
    source_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    display_name TEXT NULL,
    status TEXT NULL,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  'CREATE INDEX IF NOT EXISTS idx_sources_tenant_id ON sources (tenant_id)',
  `
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
  `,
  `
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
  `,
  `
  CREATE TABLE IF NOT EXISTS knowledge_embeddings (
    tenant_id TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    embedding vector NOT NULL,
    dimensions INTEGER NOT NULL,
    body TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, doc_id)
  )
  `,
  'CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_tenant ON knowledge_embeddings (tenant_id)',
  `
  CREATE TABLE IF NOT EXISTS app_state (
    state_key TEXT PRIMARY KEY,
    payload JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
];

async function main() {
  const connectionConfig = buildPgConnectionConfig();
  if (!connectionConfig) {
    throw new Error('Missing PostgreSQL config. Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE.');
  }

  const client = new Client(connectionConfig);
  await client.connect();

  try {
    await client.query('BEGIN');
    for (const stmt of statements) {
      await client.query(stmt);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }

  console.log('PostgreSQL schema initialized successfully.');
}

main().catch((error) => {
  console.error('Failed to initialize PostgreSQL schema.');
  console.error(error.message || error);
  process.exitCode = 1;
});
