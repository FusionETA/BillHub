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

  // ── What the sign-in page is told ─────────────────────────────────────────
  // The page cannot work out which deployment it is on, and showing a password
  // box to somebody who has no password here is worse than useless: the server
  // refuses every attempt, so they retype the WazzOCR password they know is
  // right and are told again that it is wrong.
  console.log('\nWhat the sign-in page is told');

  const modeIn = (env) => JSON.parse(execFileSync(process.execPath, ['-e', `
    const express = require('express');
    const app = express();
    app.use('/api/auth', require('./auth/router'));
    const s = app.listen(0, () => {
      const http = require('http');
      http.get({ port: s.address().port, path: '/api/auth/mode' }, (r) => {
        let out = ''; r.on('data', (c) => { out += c; });
        r.on('end', () => { console.log(out); s.close(); });
      });
    });
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8',
        env: { ...process.env, WAZZOCR_DB_NAME: WZ, AUTH_DISABLED: 'false', ...env } }).trim());

  const ownMode = modeIn({ AUTH_SOURCE: '' });
  check('its own sign-in says so, and names nowhere else',
    ownMode.borrowed === false && ownMode.mode === 'own' && ownMode.signInAt === null, ownMode);

  const borrowedMode = modeIn({ AUTH_SOURCE: 'wazzocr', WAZZOCR_URL: 'https://wazzocr.example.com' });
  check('a borrowed one says there is no sign-in here',
    borrowedMode.borrowed === true && borrowedMode.mode === 'wazzocr', borrowedMode);
  check('and says where the real one is',
    borrowedMode.signInAt === 'https://wazzocr.example.com', borrowedMode);

  // Nowhere to send them is a real deployment state — the page says to ask an
  // administrator rather than offering a link to nothing.
  const noUrl = modeIn({ AUTH_SOURCE: 'wazzocr', WAZZOCR_URL: '' });
  check('with no WazzOCR address configured it offers none',
    noUrl.borrowed === true && noUrl.signInAt === null, noUrl);

  // The page is a static file, so what it does with that answer is only
  // checkable by reading it.
  const page = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
  check('the page asks before it shows either', page.includes('/api/auth/mode'), null);
  check('and keeps the form hidden until it knows',
    /\.card>\.body\s*\{\s*display:\s*none/.test(page), null);
  check('it refuses a sign-in link that is not http',
    page.includes('^https?:\\/\\//i') || /\^https\?/.test(page), null);

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
