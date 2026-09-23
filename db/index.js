// Database access layer for WazzOCR.
// Pooled, verified-TLS MySQL connection plus small query helpers.
// Reads config from process.env (the app loads dotenv at startup).
//
//   const db = require('./db');
//   const user = await db.getOne('SELECT * FROM users WHERE email = ?', [email]);
//   const id   = await db.insert('INSERT INTO accounts (name) VALUES (?)', [name]);
//   await db.transaction(async (tx) => { ... tx.execute(...) ... });

const fs = require('fs');
const mysql = require('mysql2/promise');

let pool = null;

function buildSsl() {
  // CA cert can come from a file (DB_CA_CERT path) OR inline (DB_CA_CERT_PEM).
  // Inline is handy on hosts where uploading a file is awkward — paste the cert
  // (literal newlines or \n escapes both work) into the env var.
  let ca = null;
  const inline = process.env.DB_CA_CERT_PEM;
  if (inline && inline.includes('BEGIN CERTIFICATE')) {
    ca = inline.replace(/\\n/g, '\n');
  } else {
    const caPath = process.env.DB_CA_CERT;
    if (caPath && fs.existsSync(caPath)) ca = fs.readFileSync(caPath, 'utf8');
  }
  // Escape hatch for a local MySQL/MariaDB that isn't running TLS at all. Only
  // honoured outside production, so a missing cert on the server can never
  // silently downgrade the live connection.
  if (!ca && process.env.DB_SSL === 'disable' && process.env.NODE_ENV !== 'production') {
    console.warn('[db] DB_SSL=disable — connecting WITHOUT TLS. Local development only.');
    return null;
  }
  // Refuse to connect without verified TLS — DigitalOcean MySQL is SSL-required.
  if (!ca) {
    throw new Error('No CA cert. Set DB_CA_CERT (file path) or DB_CA_CERT_PEM (inline cert); refusing to connect without verified TLS.');
  }
  return { ca, rejectUnauthorized: true };
}

function getPool() {
  if (pool) return pool;
  if (!process.env.DB_HOST) {
    throw new Error('DB_HOST is not set; database is not configured.');
  }
  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 25060),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: buildSsl() || undefined,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
    maxIdle: Number(process.env.DB_POOL_SIZE || 10),
    idleTimeout: 60000,
    enableKeepAlive: true,
    namedPlaceholders: true,
    timezone: 'Z',
    charset: 'utf8mb4'
  });
  return pool;
}

// Returns all rows for a SELECT.
async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

// Returns the first row or null.
async function getOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

// Runs an INSERT and returns the new auto-increment id.
async function insert(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return result.insertId;
}

// Runs any write (UPDATE/DELETE/INSERT) and returns the raw result
// (affectedRows, insertId, changedRows, ...).
async function execute(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return result;
}

// Runs fn inside a transaction. fn receives a connection; commit on success,
// rollback on throw. Use conn.execute(...) inside.
async function transaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

// Liveness check.
async function ping() {
  const row = await getOne('SELECT 1 AS ok');
  return Boolean(row && row.ok === 1);
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, getOne, insert, execute, transaction, ping, close };
