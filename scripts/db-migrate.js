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

const hasColumn = (table, column) => `
  SELECT COUNT(*) AS n FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}'`;

const ADJUSTMENTS = [
  {
    why: 'bank_accounts.biller_format_key — the JomPay layout, for the utilities in the same pay run',
    check: hasColumn('bank_accounts', 'biller_format_key'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE bank_accounts ADD COLUMN biller_format_key VARCHAR(64) NULL AFTER format_key'
  },
  {
    // These were never bank names: the sync was writing Xero's
    // BankAccountType into bank_name, so every account claimed to be at a
    // bank called "BANK". A later sync will not clear them, because a
    // hand-entered bank name is meant to survive one.
    why: 'bank_accounts.bank_name — clear the BankAccountType values that were mistaken for bank names',
    check: "SELECT COUNT(*) AS n FROM bank_accounts WHERE bank_name IN ('BANK','CREDITCARD','PAYPAL')",
    needed: (row) => Number(row.n) > 0,
    sql: "UPDATE bank_accounts SET bank_name = NULL WHERE bank_name IN ('BANK','CREDITCARD','PAYPAL')"
  },
  {
    why: "bank_formats.payment_mode — Hong Leong's field limits depend on the rail",
    check: hasColumn('bank_formats', 'payment_mode'),
    needed: (row) => Number(row.n) === 0,
    sql: "ALTER TABLE bank_formats ADD COLUMN payment_mode VARCHAR(8) NULL AFTER date_format"
  },
  {
    why: "payees.payee_code / payment_batch_lines.payee_code — Xero's BatchPayments.Code, the supplier abbreviation",
    check: hasColumn('payees', 'payee_code'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE payees ADD COLUMN payee_code VARCHAR(40) NULL AFTER details'
  },
  {
    why: 'payment_batch_lines.payee_code',
    check: hasColumn('payment_batch_lines', 'payee_code'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE payment_batch_lines ADD COLUMN payee_code VARCHAR(40) NULL AFTER payee_details'
  },
  {
    why: 'payment_batch_lines — snapshot the payee payment details with the batch',
    check: hasColumn('payment_batch_lines', 'payee_bank_account_name'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE payment_batch_lines '
       + 'ADD COLUMN payee_bank_account_name VARCHAR(100) NULL AFTER payee_bank, '
       + 'ADD COLUMN payee_details VARCHAR(255) NULL AFTER payee_bank_account_name, '
       + 'ADD COLUMN payee_email VARCHAR(500) NULL AFTER payee_details'
  },
  {
    why: "payees — the rest of Xero's BatchPayments block, which is where Ayu Borneo keep the payment details",
    check: hasColumn('payees', 'bank_account_name'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE payees '
       + 'ADD COLUMN bank_account_name VARCHAR(100) NULL AFTER bank_name, '
       + 'ADD COLUMN details VARCHAR(255) NULL AFTER bank_account_name, '
       + 'ADD COLUMN tax_number VARCHAR(50) NULL AFTER details, '
       + 'ADD COLUMN email VARCHAR(500) NULL AFTER tax_number'
  },
  {
    why: 'payment_batches.receipt_name — the bank acknowledgement attached to a batch',
    check: hasColumn('payment_batches', 'receipt_name'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE payment_batches ADD COLUMN receipt_name VARCHAR(255) NULL, ADD COLUMN receipt_attached_at DATETIME NULL'
  },
  {
    why: 'payment_batch_lines.receipt_attached — so attaching can resume',
    check: hasColumn('payment_batch_lines', 'receipt_attached'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE payment_batch_lines ADD COLUMN receipt_attached TINYINT(1) NOT NULL DEFAULT 0'
  },
  {
    why: 'bill_sync_state.contacts_cursor_utc — contact changes need their own high-water mark',
    check: hasColumn('bill_sync_state', 'contacts_cursor_utc'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE bill_sync_state ADD COLUMN contacts_cursor_utc DATETIME NULL AFTER cursor_utc'
  },
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
