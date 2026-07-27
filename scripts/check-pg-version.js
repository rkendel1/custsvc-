require('dotenv').config();

const { Client } = require('pg');
const { buildPgConnectionConfig } = require('../src/lib/pgConfig');

async function main() {
  const connectionConfig = buildPgConnectionConfig();
  if (!connectionConfig) {
    throw new Error('Missing PostgreSQL connection config. Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE.');
  }

  const client = new Client(connectionConfig);
  await client.connect();

  const versionResult = await client.query('SELECT VERSION() AS version');
  const extensionResult = await client.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");

  console.log(versionResult.rows[0].version);
  console.log(`pgvector extension installed: ${extensionResult.rows.length > 0 ? 'yes' : 'no'}`);

  await client.end();
}

main().catch((error) => {
  console.error('PostgreSQL connectivity check failed.');
  console.error(error.message || error);
  process.exitCode = 1;
});