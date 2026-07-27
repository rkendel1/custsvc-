let Pool = null;
try {
  ({ Pool } = require('pg'));
} catch (_error) {
  Pool = null;
}

const { buildPgConnectionConfig, hasPgConnectionConfig } = require('./pgConfig');

function normalizeEmbedding(value) {
  if (!Array.isArray(value)) return null;
  const vector = value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  if (!vector.length) return null;
  return vector;
}

function toVectorLiteral(vector) {
  const safe = normalizeEmbedding(vector);
  if (!safe) return null;
  return `[${safe.join(',')}]`;
}

function createPgVectorStore() {
  const enabled = Boolean(Pool && hasPgConnectionConfig());
  let pool = null;
  let schemaReady = false;

  async function ensureSchema() {
    if (!enabled) return;
    if (schemaReady) return;
    if (!pool) {
      const connectionConfig = buildPgConnectionConfig();
      if (!connectionConfig) return;
      pool = new Pool(connectionConfig);
    }

    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await pool.query(`
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
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_tenant ON knowledge_embeddings (tenant_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_vector_cosine ON knowledge_embeddings USING ivfflat (embedding vector_cosine_ops)');
    schemaReady = true;
  }

  async function upsertDocument({ tenantId, docId, body, embedding, metadata = {} }) {
    if (!enabled) return { ok: false, reason: 'pgvector_disabled' };
    const vectorLiteral = toVectorLiteral(embedding);
    if (!vectorLiteral) return { ok: false, reason: 'embedding_missing_or_invalid' };

    await ensureSchema();
    await pool.query(
      `
      INSERT INTO knowledge_embeddings (tenant_id, doc_id, embedding, dimensions, body, metadata, updated_at)
      VALUES ($1, $2, $3::vector, $4, $5, $6::jsonb, NOW())
      ON CONFLICT (tenant_id, doc_id)
      DO UPDATE SET
        embedding = EXCLUDED.embedding,
        dimensions = EXCLUDED.dimensions,
        body = EXCLUDED.body,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      `,
      [tenantId, docId, vectorLiteral, embedding.length, String(body || ''), JSON.stringify(metadata || {})],
    );

    return { ok: true, dimensions: embedding.length };
  }

  async function searchByEmbedding({ tenantId, embedding, limit = 5 }) {
    if (!enabled) return [];
    const vectorLiteral = toVectorLiteral(embedding);
    if (!vectorLiteral) return [];
    const safeLimit = Math.min(Math.max(Number(limit || 5), 1), 50);

    await ensureSchema();
    const result = await pool.query(
      `
      SELECT
        doc_id,
        body,
        metadata,
        dimensions,
        1 - (embedding <=> $2::vector) AS score
      FROM knowledge_embeddings
      WHERE tenant_id = $1 AND dimensions = $3
      ORDER BY embedding <=> $2::vector
      LIMIT $4
      `,
      [tenantId, vectorLiteral, embedding.length, safeLimit],
    );

    return result.rows.map((row) => ({
      doc_id: row.doc_id,
      body: row.body,
      metadata: row.metadata || {},
      dimensions: Number(row.dimensions || 0),
      score: Number(row.score || 0),
    }));
  }

  function getState() {
    return {
      enabled,
      driver: enabled ? 'postgres-pgvector' : 'disabled',
    };
  }

  return {
    normalizeEmbedding,
    upsertDocument,
    searchByEmbedding,
    getState,
  };
}

module.exports = {
  createPgVectorStore,
  normalizeEmbedding,
};
