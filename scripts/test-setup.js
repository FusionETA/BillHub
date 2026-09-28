// Builds the database the test suite runs against, from nothing.
//
//   npm run test:setup
//
// The suite seeds its own fixtures but assumes the database, the schema and one
// account already exist — seed() does UPDATE accounts, never INSERT. Without
// this the first failure on a fresh machine is a foreign key error from inside
// a fixture, which says nothing about what is actually missing.
require('../lib/env');
const mysql = require('mysql2/promise');
const { execFileSync } = require('child_process');
const path = require('path');

const DB = process.env.DB_NAME || 'billhub_suite';
const ROOT = path.join(__dirname, '..');

(async () => {
  // The database itself, which db:migrate expects to be there already.
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'disable' ? undefined : { rejectUnauthorized: true }
  });
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
  await admin.end();
  console.log(`database ${DB} is present`);

  const run = (file, args = [], env = {}) =>
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', file), ...args],
      { cwd: ROOT, stdio: 'inherit', env: { ...process.env, DB_NAME: DB, ...env } });

  run('db-migrate.js');

  // The suite signs in as this user; the password is the one its tests type.
  const db = require('../db');
  const existing = await db.getOne('SELECT id FROM users WHERE email = ?', ['owner@example.com']);
  if (existing) console.log('owner@example.com already exists');
  else run('create-account.js', ['Demo Group', 'owner@example.com', '7'], { OWNER_PASSWORD: 'billhub-local-test' });
  await db.close();

  console.log('\nReady. Run: npm test\n');
})().catch((err) => { console.error('test:setup FAILED:', err.message); process.exit(1); });
