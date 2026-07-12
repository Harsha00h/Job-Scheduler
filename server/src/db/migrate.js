// Applies schema.sql. The schema is written to be idempotent
// (CREATE TABLE IF NOT EXISTS) so this is safe to re-run.
const fs = require('fs');
const path = require('path');
const { pool } = require('./index');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('schema applied');
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('migration failed:', err.message);
      process.exit(1);
    });
}

module.exports = { migrate };
