// Can Bills Hub actually sign people in with WazzOCR's session?
//
//   node scripts/auth-preflight.js
//
// Read-only. Checks the three things that have to be true, and says which
// one is not — because when this is broken every symptom looks the same: a
// login page. attachUser swallows a database error on purpose, so that a
// failure to read a session never takes the whole app down, which also
// means the reason never reaches the screen.
require('../lib/env');
const db = require('../db');
const authSource = require('../auth/authSource');

let bad = 0;
const ok = (m) => console.log('  ok    ' + m);
const no = (m, fix) => { bad += 1; console.log('  NO    ' + m); if (fix) console.log('        → ' + fix); };

(async () => {
  console.log(`\nAUTH_SOURCE=${authSource.MODE}`);
  console.log(`MySQL ${process.env.DB_USER || '?'}@${process.env.DB_HOST || '?'}`
    + ` database \`${process.env.DB_NAME || '?'}\``);
  if (!authSource.BORROWED) {
    console.log('\nBills Hub is using its own users and sessions, so there is nothing');
    console.log('to check. Set AUTH_SOURCE=wazzocr to borrow WazzOCR\'s.\n');
    return;
  }
  console.log(`Reading sessions and users from \`${authSource.WAZZOCR_DB}\`.\n`);

  // 1. Can this database user see WazzOCR's tables at all? A missing GRANT
  //    and a misspelt schema both land here, and they are not the same fix.
  let reachable = true;
  for (const table of ['sessions', 'users']) {
    try {
      await db.getOne(`SELECT COUNT(*) AS n FROM \`${authSource.WAZZOCR_DB}\`.\`${table}\` LIMIT 1`);
      ok(`\`${authSource.WAZZOCR_DB}\`.\`${table}\` is readable`);
    } catch (e) {
      reachable = false;
      const missing = /Unknown database|doesn't exist/i.test(e.message);
      no(`\`${authSource.WAZZOCR_DB}\`.\`${table}\` — ${e.message}`,
        missing
          ? `check WAZZOCR_DB_NAME; it is currently "${authSource.WAZZOCR_DB}"`
          : `grant this database user SELECT on \`${authSource.WAZZOCR_DB}\`.\`${table}\``);
    }
  }
  if (!reachable) {
    try {
      const rows = await db.query('SHOW DATABASES');
      const names = rows.map((r) => Object.values(r)[0])
        .filter((n) => !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(n));
      console.log(`\nSchemas this MySQL user can see: ${names.join(', ') || '(none)'}`);
      const near = names.filter((n) => /wazz|ocr/i.test(n) && n !== authSource.WAZZOCR_DB);
      if (near.length) {
        console.log(`\nThat list has ${near.map((n) => `"${n}"`).join(' and ')}, which looks like`);
        console.log(`what you want. Set WAZZOCR_DB_NAME to it and restart.`);
      } else {
        console.log('\nNothing in that list looks like WazzOCR\'s database. Either this');
        console.log('MySQL user has no grant on it, or Bills Hub is pointed at a');
        console.log('different server than WazzOCR — compare DB_HOST in the two .env');
        console.log('files. A grant looks like:');
        console.log(`\n  GRANT SELECT ON \`${authSource.WAZZOCR_DB}\`.\`sessions\` TO '${process.env.DB_USER || 'billhub'}'@'%';`);
        console.log(`  GRANT SELECT ON \`${authSource.WAZZOCR_DB}\`.\`users\` TO '${process.env.DB_USER || 'billhub'}'@'%';`);
        console.log('  FLUSH PRIVILEGES;');
      }
    } catch (e) {
      console.log(`\nCould not list schemas either: ${e.message}`);
    }
    console.log('\nNothing below can be checked until that is fixed.\n');
    process.exitCode = 1;
    return;
  }

  // 2. Is anyone signed in over there? An empty table is not a fault, but it
  //    does mean nobody can arrive, and it is worth saying so rather than
  //    leaving it to be inferred.
  const live = await db.getOne(
    `SELECT COUNT(*) AS n FROM \`${authSource.WAZZOCR_DB}\`.\`sessions\` WHERE expires_at > NOW()`);
  if (Number(live.n)) ok(`${live.n} live session(s) in WazzOCR right now`);
  else no('no live sessions in WazzOCR', 'sign in to WazzOCR, then run this again');

  // 3. The mapping. A WazzOCR user's account_id numbers WAZZOCR's accounts,
  //    so without this link they arrive signed in with no account and every
  //    page answers "This user has no account".
  const links = await db.query(
    'SELECT id, name, wazzocr_account_id FROM accounts WHERE wazzocr_account_id IS NOT NULL');
  if (!links.length) {
    no('no Bills Hub account is linked to a WazzOCR account',
      'set accounts.wazzocr_account_id to the matching WazzOCR account id');
  } else {
    for (const a of links) {
      const users = await db.getOne(
        `SELECT COUNT(*) AS n FROM \`${authSource.WAZZOCR_DB}\`.\`users\` WHERE account_id = ?`,
        [a.wazzocr_account_id]);
      if (Number(users.n)) ok(`${a.name} ← WazzOCR account ${a.wazzocr_account_id} (${users.n} user(s))`);
      else no(`${a.name} is linked to WazzOCR account ${a.wazzocr_account_id}, which has no users`,
        'check the id is the right one');
    }
  }

  // 4. Who can read the activity log once identity comes from over there.
  const admins = await db.query(
    `SELECT email FROM \`${authSource.WAZZOCR_DB}\`.\`users\` WHERE is_super_admin = 1`);
  if (admins.length) ok(`${admins.length} super admin(s) in WazzOCR: ${admins.map((a) => a.email).join(', ')}`);
  else no('no super admin in WazzOCR, so nobody can open the Activity tab',
    'set is_super_admin = 1 on the right WazzOCR user');

  console.log(bad
    ? '\nFix the NO lines above, then run this again.\n'
    : '\nAll clear on this side. If people still land on a login page, the cookie'
      + '\nis not reaching Bills Hub — check SESSION_COOKIE_DOMAIN in WazzOCR and'
      + '\nlook for wz_session under billhub in the browser\'s cookie list.\n');
  process.exitCode = bad ? 1 : 0;
})()
  .then(() => db.close())
  .catch(async (e) => { console.error('\nFAILED:', e.message, '\n'); await db.close(); process.exit(1); });
