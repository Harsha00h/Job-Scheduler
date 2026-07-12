const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('idle client error', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

// Run fn inside a transaction; rolls back on any throw.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
