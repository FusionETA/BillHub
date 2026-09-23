// AUTH_DISABLED=true: no sign-in, every request runs as the default account.
// Must set the flag before anything pulls in auth/middleware.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.AUTH_DISABLED = 'true';
process.env.DEFAULT_ACCOUNT_ID = '1';

const http = require('http');
const xero = require('../lib/xero');
const db = require('../db');

// Nothing here should reach Xero, but stub it so a stray call can't.
xero.api = async () => ({ Invoices: [] });

const app = require('../server');
const server = app.listen(3313);

function req(method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: 3313, path, method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out ? JSON.parse(out) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok    ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

(async () => {
  // Start from known fixture data, whatever ran before.
  await require('./seed').seed({ quiet: true });

  console.log('Open access');
  const bills = await req('GET', '/api/bills');
  check('bills load with no cookie at all', bills.status === 200 && bills.body.rows.length === 11, bills.status);

  const me = await req('GET', '/api/auth/me');
  check('/me reports the mode so the UI can warn', me.body.authDisabled === true, me.body);
  check('it runs as the default account', me.body.account && me.body.account.id === 1, me.body.account);
  check('the stand-in user is not a real row', me.body.user.id === 0, me.body.user);

  const entities = await req('GET', '/api/bills/entities');
  check('entity list works unauthenticated', entities.status === 200 && entities.body.entities.length === 5, entities.status);

  const status = await req('GET', '/api/xero/status');
  check('xero status works unauthenticated', status.status === 200 && status.body.connected === true, status.status);

  console.log('\nSign-in is genuinely off, not just hidden');
  const login = await req('POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'billhub-local-test' } });
  check('login is refused rather than issuing a dead session', login.status === 409, login.status);
  check('and no session cookie is set', !login.headers['set-cookie'], login.headers['set-cookie']);

  const logout = await req('POST', '/api/auth/logout');
  check('logout is refused too', logout.status === 409, logout.status);

  console.log('\nWrites are open as well — the reason for the banner');
  const bad = await req('POST', '/api/bills/bulk', { body: { action: 'submit', ids: [] } });
  check('a write endpoint is reachable with no credentials (400 for the empty body, not 401)',
    bad.status === 400, bad.status);

  // No stray user row should have been created for the stand-in.
  const users = await db.getOne('SELECT COUNT(*) AS n FROM users');
  check('no user row is created for open access', Number(users.n) === 1, users.n);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
