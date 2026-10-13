// Bills Hub signing people in with WazzOCR's session.
//
// Run in a child process with AUTH_SOURCE=wazzocr, because auth/authSource.js
// reads the env once at require time — which is the point of it, and also
// why it cannot be flipped inside a running suite.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { execFileSync } = require('child_process');
const path = require('path');
const db = require('../db');
const { randomToken, sha256hex } = require('../lib/tokens');

const WZ = `wz_sso_${process.pid}`;
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok    ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

// One child, one question. Returns whatever the snippet prints.
function inBorrowedMode(snippet, env = {}) {
  return execFileSync(process.execPath, ['-e', snippet], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, AUTH_SOURCE: 'wazzocr', WAZZOCR_DB_NAME: WZ, AUTH_DISABLED: 'false', ...env }
  }).trim();
}

(async () => {
  console.log('\nWhich tables identity comes from');
  const own = execFileSync(process.execPath,
    ['-e', "const a=require('./auth/authSource');console.log(a.MODE,a.SESSIONS,a.USERS)"],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8',
      env: { ...process.env, AUTH_SOURCE: '' } }).trim();
  check('unset means its own tables, unqualified', own === 'own `sessions` `users`', own);
  const borrowed = inBorrowedMode("const a=require('./auth/authSource');console.log(a.MODE,a.SESSIONS,a.USERS)");
  check('wazzocr mode qualifies them with that database',
    borrowed === `wazzocr \`${WZ}\`.\`sessions\` \`${WZ}\`.\`users\``, borrowed);

  // A typo must stop the server, not quietly fall back to one of them.
  let refused = '';
  try {
    execFileSync(process.execPath, ['-e', "require('./auth/authSource')"],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, AUTH_SOURCE: 'wazzcor' } });
  } catch (e) { refused = `${e.stdout || ''}${e.stderr || ''}`; }
  check('a misspelt AUTH_SOURCE stops the app rather than guessing',
    /AUTH_SOURCE must be/.test(refused), refused.slice(0, 120));

  console.log('\nResolving a session WazzOCR issued');
  await db.execute(`CREATE DATABASE IF NOT EXISTS \`${WZ}\``);
  await db.execute(`CREATE TABLE \`${WZ}\`.\`users\` (
    id BIGINT UNSIGNED PRIMARY KEY, account_id BIGINT UNSIGNED NULL,
    email VARCHAR(255) NOT NULL, name VARCHAR(255),
    is_super_admin TINYINT(1) DEFAULT 0, status VARCHAR(16) DEFAULT 'active')`);
  await db.execute(`CREATE TABLE \`${WZ}\`.\`sessions\` (
    id CHAR(64) PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL, expires_at DATETIME NOT NULL)`);

  const account = await db.getOne('SELECT id, wazzocr_account_id FROM accounts ORDER BY id LIMIT 1');
  const wzAccount = 90000 + (process.pid % 1000);
  await db.execute('UPDATE accounts SET wazzocr_account_id = ? WHERE id = ?', [wzAccount, account.id]);

  const mk = async (id, wzAcc, superAdmin, expires = 'DATE_ADD(NOW(), INTERVAL 1 DAY)') => {
    await db.execute(
      `INSERT INTO \`${WZ}\`.\`users\` (id, account_id, email, name, is_super_admin)
       VALUES (?,?,?,?,?)`, [id, wzAcc, `u${id}@example.com`, `User ${id}`, superAdmin]);
    const raw = randomToken(32);
    await db.execute(
      `INSERT INTO \`${WZ}\`.\`sessions\` (id, user_id, expires_at) VALUES (?,?,${expires})`,
      [sha256hex(raw), id]);
    return raw;
  };
  const admin = await mk(1, wzAccount, 1);
  const member = await mk(2, wzAccount, 0);
  const unlinked = await mk(3, 999999, 0);
  const stale = await mk(4, wzAccount, 1, 'DATE_SUB(NOW(), INTERVAL 1 DAY)');

  const resolve = (token) => JSON.parse(inBorrowedMode(`
    require('./lib/env');
    const s = require('./auth/sessions');
    s.resolveUser(${JSON.stringify(token)}).then(async (u) => {
      const accounts = require('./models/accounts');
      const acc = u ? await accounts.byWazzocrAccountId(u.account_id) : null;
      console.log(JSON.stringify(u ? {
        email: u.email, superAdmin: Number(u.is_super_admin), billhubAccount: acc ? acc.id : null
      } : null));
      process.exit(0);
    });`));

  check('a live WazzOCR session resolves to its user',
    resolve(admin)?.email === 'u1@example.com', resolve(admin));
  check('and maps to the Bills Hub account linked to theirs',
    resolve(admin)?.billhubAccount === account.id, resolve(admin));
  check('the super-admin flag comes across with them',
    resolve(admin)?.superAdmin === 1 && resolve(member)?.superAdmin === 0,
    [resolve(admin)?.superAdmin, resolve(member)?.superAdmin]);
  // Signed in, but with nothing here. It must read as no account rather
  // than fall through to somebody else's.
  check('a user whose WazzOCR account is not linked gets no account',
    resolve(unlinked)?.billhubAccount === null, resolve(unlinked));
  check('an expired session resolves to nobody', resolve(stale) === null, resolve(stale));
  check('and so does a token nobody issued', resolve(randomToken(32)) === null);

  console.log('\nBills Hub stops being a place you can sign in');
  const minted = inBorrowedMode(`
    require('./lib/env');
    require('./auth/sessions').create(1).then(() => console.log('CREATED'))
      .catch((e) => console.log('REFUSED: ' + e.message));`);
  check("it will not mint a session into WazzOCR's table",
    /^REFUSED/.test(minted), minted);

  // Signing out of Bills Hub must not delete a row in WazzOCR's table and
  // sign somebody out of the app they are actually using.
  const before = await db.getOne(`SELECT COUNT(*) AS n FROM \`${WZ}\`.\`sessions\``);
  inBorrowedMode(`
    require('./lib/env');
    require('./auth/sessions').destroy(${JSON.stringify(admin)}).then(() => console.log('done'));`);
  const after = await db.getOne(`SELECT COUNT(*) AS n FROM \`${WZ}\`.\`sessions\``);
  check('and it will not delete one either', Number(after.n) === Number(before.n),
    { before: before.n, after: after.n });

  await db.execute('UPDATE accounts SET wazzocr_account_id = ? WHERE id = ?',
    [account.wazzocr_account_id, account.id]);
  await db.execute(`DROP DATABASE IF EXISTS \`${WZ}\``);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await db.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e.message);
  try { await db.execute(`DROP DATABASE IF EXISTS \`${WZ}\``); } catch { /* never created */ }
  process.exit(1);
});
