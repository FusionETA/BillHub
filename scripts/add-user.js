// Adds another login to an existing account.
//
//   node scripts/add-user.js janice@example.com --name "Janice Tan"
//   NEW_PASSWORD=… node scripts/add-user.js janice@example.com   (non-interactive)
//
// create-account makes an account and its first owner; this adds people to one
// that already exists. The password is typed with the echo off or read from
// NEW_PASSWORD, never from argv, so it stays out of shell history and out of
// the process list.
//
// Note there is no permission model yet: every login can see and do everything
// the account can. --role is recorded but nothing reads it.
require('../lib/env');
const db = require('../db');
const users = require('../models/users');
const { hashPassword } = require('../auth/passwords');
const { askHidden, rejectWeak } = require('../lib/prompt');

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

(async () => {
  const email = argv.find((a) => !a.startsWith('--') && a.includes('@'));
  if (!email) {
    console.error('Usage: node scripts/add-user.js <email> [--name "Their Name"] [--role member] [--account <id>]');
    process.exit(1);
  }

  const existing = await users.getByEmail(email);
  if (existing) {
    console.error(`${email} already has a login (user id ${existing.id}).`);
    console.error(`To change their password:  node scripts/set-password.js ${email}`);
    process.exit(1);
  }

  const accounts = await db.query('SELECT id, name FROM accounts ORDER BY id');
  if (!accounts.length) {
    console.error('No account exists yet. Run create-account first.');
    process.exit(1);
  }
  const wanted = arg('--account') ? Number(arg('--account')) : Number(process.env.DEFAULT_ACCOUNT_ID) || accounts[0].id;
  const account = accounts.find((a) => a.id === wanted);
  if (!account) {
    console.error(`No account with id ${wanted}. Known: ${accounts.map((a) => `${a.id} (${a.name})`).join(', ')}`);
    process.exit(1);
  }

  const role = arg('--role', 'owner');
  if (!['owner', 'member'].includes(role)) {
    console.error(`--role must be owner or member; got "${role}".`);
    process.exit(1);
  }

  const password = process.env.NEW_PASSWORD || await askHidden('Password for the new login: ');
  const weak = rejectWeak(password);
  if (weak) { console.error(`\n${weak}\n`); process.exit(1); }
  if (!process.env.NEW_PASSWORD) {
    const again = await askHidden('Again: ');
    if (again !== password) { console.error('\nThey do not match.\n'); process.exit(1); }
  }

  // Derive a display name from the address when none is given: better than a
  // blank in the header avatar, and easy to correct later.
  const name = arg('--name') || email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const userId = await users.createOwner({
    accountId: account.id, email, name, passwordHash: await hashPassword(password)
  });
  if (role !== 'owner') await db.execute('UPDATE users SET role = ? WHERE id = ?', [role, userId]);

  console.log(`\nAdded ${email} (user id ${userId}) to "${account.name}".`);
  console.log(`  Name   ${name}`);
  console.log(`  Role   ${role}  — recorded, but nothing checks it yet: this login can do everything.`);
  console.log('\nThey can sign in now. To change the password later:');
  console.log(`  node scripts/set-password.js ${email}\n`);
  await db.close();
})().catch(async (err) => {
  console.error('FAILED:', err.message);
  try { await db.close(); } catch { /* already closed */ }
  process.exit(1);
});
