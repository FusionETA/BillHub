// Changes an existing login's password.
//   node scripts/set-password.js <email>
//
// The password is typed at the prompt with the echo off, or read from
// NEW_PASSWORD — never from argv, so it stays out of your shell history, out of
// the process list, and out of whatever is reading your terminal.
//
// There was no way to do this before, which meant a password set once at
// create-account time was the password forever.
require('../lib/env');
const readline = require('readline');
const db = require('../db');
const users = require('../models/users');
const { hashPassword } = require('../auth/passwords');

// readline echoes what you type, which is wrong for a password on a shared
// screen or a recorded session. Muting the output stream hides it.
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Not a terminal. Set NEW_PASSWORD instead, or run this interactively.'));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(prompt);
    rl._writeToOutput = () => {};          // swallow the echo
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

(async () => {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node scripts/set-password.js <email>');
    console.error('       NEW_PASSWORD=… node scripts/set-password.js <email>   (non-interactive)');
    process.exit(1);
  }

  const user = await users.getByEmail(email);
  if (!user) {
    console.error(`No user with the email ${email}.`);
    const all = await db.query('SELECT email FROM users ORDER BY id');
    if (all.length) console.error(`Known logins: ${all.map((u) => u.email).join(', ')}`);
    process.exit(1);
  }

  const password = process.env.NEW_PASSWORD || await askHidden('New password (min 12 chars): ');
  if (!password || password.length < 12) {
    console.error('\nToo short. Use at least 12 characters — this login reads 41 organisations\' bills.');
    process.exit(1);
  }
  if (!process.env.NEW_PASSWORD) {
    const again = await askHidden('Again: ');
    if (again !== password) { console.error('\nThey do not match.'); process.exit(1); }
  }

  await users.setPasswordHash(user.id, await hashPassword(password));
  console.log(`\nPassword changed for ${email} (user id ${user.id}).`);
  console.log('Existing sessions are unaffected — sign out elsewhere if that matters.');
  await db.close();
})().catch(async (err) => {
  console.error('FAILED:', err.message);
  try { await db.close(); } catch { /* already closed */ }
  process.exit(1);
});
