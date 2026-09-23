// Connectivity check: pings the database and lists the Bills Hub tables.
// Usage: node scripts/db-test.js
require('dotenv').config();
const db = require('../db');

(async () => {
  console.log(`Connecting to ${process.env.DB_NAME} @ ${process.env.DB_HOST}:${process.env.DB_PORT || 25060} ...`);
  console.log('ping:', await db.ping() ? 'ok' : 'FAILED');
  const tables = await db.query('SHOW TABLES');
  console.log(`${tables.length} table(s):`);
  for (const t of tables) {
    const name = Object.values(t)[0];
    const row = await db.getOne(`SELECT COUNT(*) AS n FROM \`${name}\``);
    console.log(`  - ${name} (${row.n} rows)`);
  }
  await db.close();
})().catch((err) => {
  console.error('FAILED:', err.code || '', err.message);
  process.exit(1);
});
