// Applies db/schema.sql to the configured MySQL database (verified TLS).
// Usage: node scripts/db-migrate.js
//
// Two parts. The schema itself is all CREATE TABLE IF NOT EXISTS, so it only
// ever adds. ADJUSTMENTS below cover the case that does not reach — a column
// whose definition has changed since a database was created. Each one checks
// information_schema first and does nothing when the column is already right,
// so this stays safe to run against a live database as often as you like.
require('../lib/env');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// CA cert can come from a file (DB_CA_CERT) or inline (DB_CA_CERT_PEM), matching
// db/index.js. DigitalOcean MySQL requires SSL.
function ca() {
  const inline = process.env.DB_CA_CERT_PEM;
  if (inline && inline.includes('BEGIN CERTIFICATE')) return inline.replace(/\\n/g, '\n');
  const p = process.env.DB_CA_CERT;
  if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return null;
}

// Column changes that a CREATE TABLE IF NOT EXISTS cannot deliver to a database
// that already exists.
const width = (table, column) => `
  SELECT CHARACTER_MAXIMUM_LENGTH AS n FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}'`;

const ADJUSTMENTS = [
  {
    // Found the hard way: 24 of 41 organisations failed their first sync with
    // "Data too long for column 'reference'". Xero documents Reference as 255
    // and returns more.
    why: "bills.reference was too narrow for the references Xero actually sends",
    check: width('bills', 'reference'),
    needed: (row) => Number(row.n) < 500,
    sql: 'ALTER TABLE bills MODIFY reference VARCHAR(500)'
  }
];

(async () => {
  const cert = ca();
  // Mirrors db/index.js: a local, non-TLS database is allowed outside production.
  const plaintextOk = process.env.DB_SSL === 'disable' && process.env.NODE_ENV !== 'production';
  if (!cert && !plaintextOk) {
    console.error('Missing CA cert. Set DB_CA_CERT (file path) or DB_CA_CERT_PEM (inline) in .env.');
    process.exit(1);
  }
  if (!cert) console.warn('[db] DB_SSL=disable — connecting WITHOUT TLS. Local development only.');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 25060),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: cert ? { ca: cert, rejectUnauthorized: true } : undefined,
    multipleStatements: true
  });
  await conn.query(sql);

  for (const a of ADJUSTMENTS) {
    const [[row]] = await conn.query(a.check);
    if (!row || !a.needed(row)) continue;
    console.log(`  altering: ${a.why}`);
    await conn.query(a.sql);
    console.log(`  done:     ${a.sql}`);
  }

  const [tables] = await conn.query('SHOW TABLES');
  console.log(`Schema applied to "${process.env.DB_NAME}". ${tables.length} tables:`);
  for (const t of tables) console.log('  -', Object.values(t)[0]);
  await conn.end();
})().catch((err) => {
  console.error('Migration FAILED:', err.code || '', err.message);
  process.exit(1);
});
