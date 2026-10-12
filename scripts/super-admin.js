// Who can read the activity log.
//
//   node scripts/super-admin.js                      who has it now
//   node scripts/super-admin.js grant  <email>
//   node scripts/super-admin.js revoke <email>
//
// Nothing else grants it. createOwner writes is_super_admin = 0 and the
// schema defaults to 0, so a deployment starts with nobody able to open
// Activity — which is the right default for a page that shows every action
// every user has taken, and the reason this script exists rather than a
// checkbox on a settings page somebody could click by accident.
//
// It is the only permission Bills Hub has. `role` is recorded and nothing
// reads it: everyone who can sign in can do everything else.
require('../lib/env');
const db = require('../db');

const norm = (e) => String(e || '').trim().toLowerCase();

async function list() {
  const rows = await db.query(
    `SELECT id, email, name, status, is_super_admin, last_login_at
       FROM users ORDER BY is_super_admin DESC, email`);
  if (!rows.length) { console.log('\nNo users yet.\n'); return rows; }
  const admins = rows.filter((r) => Number(r.is_super_admin));
  console.log(`\n${admins.length} of ${rows.length} user(s) can read the activity log:\n`);
  for (const r of rows) {
    console.log(`  ${Number(r.is_super_admin) ? '●' : '○'}  ${r.email}`
      + `${r.name ? `  (${r.name})` : ''}`
      + `${r.status !== 'active' ? `  [${r.status}]` : ''}`);
  }
  if (!admins.length) {
    console.log('\n  Nobody can open the Activity tab. Grant it to someone:');
    console.log('    node scripts/super-admin.js grant you@example.com');
  }
  console.log('');
  return rows;
}

async function set(email, on) {
  const user = await db.getOne('SELECT id, email, name, is_super_admin FROM users WHERE email = ?',
    [norm(email)]);
  if (!user) {
    console.error(`\nNo user with the email "${norm(email)}".`);
    console.error('Add them first:  node scripts/add-user.js <email>\n');
    process.exit(1);
  }
  if (Number(user.is_super_admin) === (on ? 1 : 0)) {
    console.log(`\n${user.email} already ${on ? 'can' : 'cannot'} read the activity log. Nothing to do.\n`);
    return;
  }
  if (!on) {
    // Taking it from the last one leaves the log unreadable by anybody. The
    // script can put it back, so this is a warning and not a refusal.
    const others = await db.getOne(
      'SELECT COUNT(*) AS n FROM users WHERE is_super_admin = 1 AND id <> ?', [user.id]);
    if (!Number(others.n)) {
      console.log(`\n  ${user.email} is the only one who can read it. Taking it away leaves`);
      console.log('  the Activity tab visible to nobody until somebody is granted it again.\n');
    }
  }
  await db.execute('UPDATE users SET is_super_admin = ? WHERE id = ?', [on ? 1 : 0, user.id]);
  console.log(`\n${user.email} ${on ? 'can now' : 'can no longer'} read the activity log.`);
  console.log('They will see the change the next time the page loads.\n');
}

(async () => {
  const [cmd, email] = process.argv.slice(2);
  if (!cmd) { await list(); }
  else if (cmd === 'grant' || cmd === 'revoke') {
    if (!email) { console.error(`\nUsage: node scripts/super-admin.js ${cmd} <email>\n`); process.exit(1); }
    await set(email, cmd === 'grant');
    await list();
  } else {
    console.error(`\nUnknown command "${cmd}". Use grant, revoke, or nothing to list.\n`);
    process.exit(1);
  }
})()
  .then(() => db.close())
  .catch(async (e) => { console.error('\nFAILED:', e.message, '\n'); await db.close(); process.exit(1); });
