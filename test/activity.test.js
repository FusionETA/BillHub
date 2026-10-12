// The activity log: who did what, and who may read it.
//
// Two things it has to get right, and both are easy to get wrong quietly:
// a password must never reach the table, and the log must never be able to
// fail the thing it is recording.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.AUTH_DISABLED = 'true';

const http = require('http');
const db = require('../db');
const activity = require('../models/activity');
const { describe } = require('../auth/activity');

const app = require('../server');
const server = app.listen(3314);

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok    ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

function req(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: 3314, path, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = out ? JSON.parse(out) : null; } catch { parsed = { raw: out.slice(0, 200) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const settle = () => new Promise((r) => setTimeout(r, 250));

(async () => {
  await db.execute('DELETE FROM activity_log');

  console.log('\nNaming what happened');
  // The name is what the log groups on, so it must not carry ids.
  for (const [m, p, b, action] of [
    ['POST', '/api/recharge/runs', { billId: 7 }, 'recharge.create'],
    ['PATCH', '/api/recharge/text-rules/9', { enabled: false }, 'recharge.rule.update'],
    ['DELETE', '/api/recharge/text-rules/9', null, 'recharge.rule.delete'],
    ['POST', '/api/payments/batches', { billIds: [1, 2] }, 'payment.batch']
  ]) check(`${m} ${p} is "${action}"`, describe(m, p, b).action === action, describe(m, p, b));

  check('an endpoint nobody named is still recorded, under something readable',
    describe('POST', '/api/future/42/thing', null).action === 'future.thing',
    describe('POST', '/api/future/42/thing', null));

  console.log('\nSecrets never reach the table');
  // The one thing that would make this log worse than not having it.
  const scrubbed = activity.scrub({
    email: 'a@b.com', password: 'hunter2', apiKey: 'k-123',
    nested: { refreshToken: 't-9', amount: 10 }
  });
  check('a password is removed', scrubbed.password === '[removed]', scrubbed);
  check('and so is anything key-shaped, at any depth',
    scrubbed.apiKey === '[removed]' && scrubbed.nested.refreshToken === '[removed]', scrubbed);
  check('while the rest is kept',
    scrubbed.email === 'a@b.com' && scrubbed.nested.amount === 10, scrubbed);
  check('a long value is cut rather than stored whole',
    activity.scrub({ x: 'y'.repeat(1000) }).x.length < 320);

  console.log('\nWhat gets written');
  await req('PATCH', '/api/recharge/settings', { body: { dueDays: 31 } });
  await settle();
  const after = await db.query("SELECT * FROM activity_log WHERE action = 'recharge.settings'");
  check('a change is recorded', after.length === 1, after.length);
  check('with the method, the path and the outcome',
    after[0]?.method === 'PATCH' && after[0]?.path === '/api/recharge/settings'
    && after[0]?.status_code === 200, after[0]);
  check('and a sentence somebody can read',
    after[0]?.summary === 'Changed the recharge settings', after[0]?.summary);

  // Reading is not an action anybody answers for, and page loads would bury
  // the things that are.
  const before = Number((await db.getOne('SELECT COUNT(*) AS n FROM activity_log')).n);
  await req('GET', '/api/recharge');
  await settle();
  check('reading is not logged',
    Number((await db.getOne('SELECT COUNT(*) AS n FROM activity_log')).n) === before);

  // The browser fires this on load; it is not something a person did.
  await req('POST', '/api/bills/sync/if-stale');
  await settle();
  check('nor is a call the page makes on its own',
    Number((await db.getOne('SELECT COUNT(*) AS n FROM activity_log')).n) === before);

  console.log('\nA refused action is the interesting one');
  const bad = await req('POST', '/api/recharge/text-rules', { body: { name: '' } });
  await settle();
  const refused = await db.getOne(
    "SELECT * FROM activity_log WHERE action = 'recharge.rule.create' ORDER BY id DESC LIMIT 1");
  check('an attempt that failed is recorded too',
    bad.status >= 400 && refused && refused.status_code === bad.status,
    { attempted: bad.status, logged: refused?.status_code });

  console.log('\nThe log cannot break what it records');
  // Proved by taking the table away: the action must still succeed.
  await db.execute('RENAME TABLE activity_log TO activity_log_hidden');
  try {
    const stillWorks = await req('PATCH', '/api/recharge/settings', { body: { dueDays: 30 } });
    check('an action succeeds even when the log cannot be written',
      stillWorks.status === 200, stillWorks);
    await settle();
  } finally {
    await db.execute('RENAME TABLE activity_log_hidden TO activity_log');
  }

  console.log('\nReading it');
  const page = await req('GET', '/api/activity?days=1');
  check('the page comes back', page.status === 200 && Array.isArray(page.body.events), page.body);
  check('newest first', page.body.events.length < 2
    || page.body.events[0].id > page.body.events[1].id);
  check('a failed row is marked as one rather than left as a number',
    page.body.events.some((e) => e.failed === true), page.body.events.map((e) => e.statusCode));
  const filters = await req('GET', '/api/activity/filters');
  check('the filters offer the kinds that are actually in the log',
    filters.body.kinds.some((k) => k.value === 'recharge'), filters.body.kinds);

  console.log('\nWho may read it');
  // This suite runs with AUTH_DISABLED, which waves the guard through — the
  // same bargain the rest of the app makes, and the banner says so. So the
  // guard is loaded in a second process with sign-in ON, which is the only
  // way to see what it does on a real deployment.
  const { execFileSync } = require('child_process');
  const guard = (isSuper) => execFileSync(process.execPath, ['-e', `
    process.env.AUTH_DISABLED = 'false';
    const { requireSuperAdmin } = require('${require('path').join(__dirname, '..', 'auth', 'middleware').replace(/\\/g, '/')}');
    let out = 'allowed';
    const res = { status: (c) => ({ json: () => { out = String(c); } }) };
    requireSuperAdmin({ user: { id: 1, is_super_admin: ${isSuper} } }, res, () => { out = 'allowed'; });
    console.log(out);
  `], { encoding: 'utf8', env: { ...process.env, AUTH_DISABLED: 'false' } }).trim();

  check('with sign-in on, a user who is not an admin is refused', guard(0) === '403', guard(0));
  check('and one who is gets through', guard(1) === 'allowed', guard(1));

  // Nothing hands it out on the way in. A deployment starts with the
  // Activity tab readable by nobody, which is the right way round for a page
  // showing every action every user has taken — so it has to be granted
  // deliberately, with scripts/super-admin.js.
  const users = require('../models/users');
  const account = await db.getOne('SELECT id FROM accounts ORDER BY id LIMIT 1');
  const email = `guard-check-${process.pid}@example.com`;
  const newId = await users.createOwner({ accountId: account.id, email, name: 'Guard Check' });
  const made = await db.getOne('SELECT is_super_admin FROM users WHERE id = ?', [newId]);
  check('a new owner is not one, so the permission is never granted by accident',
    Number(made.is_super_admin) === 0, made);

  const invitedId = await users.createInvited({ accountId: account.id, email: `inv-${email}` });
  const invited = await db.getOne('SELECT is_super_admin FROM users WHERE id = ?', [invitedId]);
  check('nor is an invited user', Number(invited.is_super_admin) === 0, invited);
  await db.execute('DELETE FROM users WHERE id IN (?, ?)', [newId, invitedId]);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await db.execute('RENAME TABLE activity_log_hidden TO activity_log'); } catch { /* not renamed */ }
  server.close();
  process.exit(1);
});
