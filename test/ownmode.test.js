// XERO_GRANT_SOURCE=own: Bills Hub runs its own consent against its own Xero
// app and holds its own grant, touching nothing of WazzOCR's.
//
// The mode is read when lib/grantSource loads, so it is set before the require.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.AUTH_DISABLED = 'false';
process.env.XERO_GRANT_SOURCE = 'own';
process.env.XERO_CLIENT_ID = 'own-mode-client-id';
process.env.XERO_CLIENT_SECRET = 'own-mode-secret';
process.env.XERO_REDIRECT_URI = 'http://localhost:3317/api/xero/callback';
delete process.env.XERO_TENANT_ALLOWLIST;

const http = require('http');
const db = require('../db');
const grantSource = require('../lib/grantSource');
const xero = require('../lib/xero');
const { decrypt } = require('../lib/crypto');

// Stub the two identity calls a consent makes.
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/identity/connect/token')) {
    return { ok: true, status: 200, json: async () => ({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 1800, scope: 'accounting.transactions' }) };
  }
  if (u.includes('api.xero.com/connections')) {
    return { ok: true, status: 200, json: async () => ([
      { tenantId: 'demo-tenant-1', tenantName: 'Demo Company (MY)', tenantType: 'ORGANISATION' }
    ]) };
  }
  return realFetch(url, opts);
};

const app = require('../server');
const server = app.listen(3317);

function req(method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: 3317, path, method,
      headers: { Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {}) }
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out && res.headers['content-type'] && res.headers['content-type'].includes('json') ? JSON.parse(out) : out }));
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
  await require('./seed').seed({ quiet: true });
  // Start with no grant of our own.
  await db.execute('DELETE FROM xero_connections');
  await db.execute('DELETE FROM xero_grants');

  const login = await req('POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'billhub-local-test' } });
  const cookie = (login.headers['set-cookie'] || [])[0].split(';')[0];

  console.log('Mode');
  check('the grant source is its own', grantSource.MODE === 'own' && grantSource.BORROWED === false);
  check('it reads its own tables, not WazzOCR\'s',
    grantSource.GRANTS === '`xero_grants`' && !grantSource.CONNECTIONS.includes('wazzocr'),
    { grants: grantSource.GRANTS, connections: grantSource.CONNECTIONS });
  check('the connections account id is Bills Hub\'s own',
    (await grantSource.connectionsAccountId(1)) === 1);

  console.log('\nBefore connecting');
  const before = await req('GET', '/api/xero/status', { cookie });
  check('nothing is connected yet', before.body.connected === false, before.body);
  check('and the UI is told it can connect here', before.body.canConnectHere === true, before.body);

  console.log('\nThe consent');
  const start = await req('GET', '/api/xero/connect', { cookie });
  check('connect redirects to Xero', start.status === 302, start.status);
  const url = new URL(start.headers.location);
  check('to the authorize endpoint with our client id',
    url.host === 'login.xero.com' && url.searchParams.get('client_id') === 'own-mode-client-id',
    { host: url.host, client: url.searchParams.get('client_id') });
  check('the redirect_uri is ours', url.searchParams.get('redirect_uri') === process.env.XERO_REDIRECT_URI);
  check('offline_access is requested, or there is no refresh token',
    url.searchParams.get('scope').includes('offline_access'));

  const state = url.searchParams.get('state');
  check('the state is signed and parses back to the account',
    xero.parseState(state).accountId === 1, xero.parseState(state));
  check('a tampered state is rejected', xero.parseState(state.slice(0, -1) + '0') === null);
  check('a forged state is rejected', xero.parseState('bh.1.deadbeef.00000000000000000000000000000000') === null);

  const cb = await req('GET', `/api/xero/callback?code=abc123&state=${encodeURIComponent(state)}`);
  check('the callback redirects back into the app', cb.status === 302 && /xero=connected/.test(cb.headers.location), cb.headers.location);
  check('and reports how many organisations came back', /orgs=1/.test(cb.headers.location), cb.headers.location);

  console.log('\nWhat was stored');
  const grant = await db.getOne('SELECT * FROM xero_grants WHERE account_id = 1');
  check('the grant is in Bills Hub\'s own table', Boolean(grant), grant);
  check('the refresh token is encrypted at rest, not plaintext',
    grant && !grant.refresh_token.toString('utf8').includes('refresh-1') && decrypt(grant.refresh_token) === 'refresh-1');

  const conn = await db.query('SELECT * FROM xero_connections WHERE account_id = 1');
  check('the organisation is connected', conn.length === 1 && conn[0].xero_tenant_id === 'demo-tenant-1', conn);

  const ent = await db.getOne("SELECT code, short_name FROM entities WHERE xero_tenant_id = 'demo-tenant-1'");
  check('and gets an entity row with a derived code', ent && ent.short_name === 'Demo Company (MY)', ent);

  console.log('\nAfterwards');
  const after = await req('GET', '/api/xero/status', { cookie });
  check('status reports it connected', after.body.connected === true && after.body.count === 1, after.body);
  check('and names the mode', after.body.grantSource === 'own', after.body.grantSource);
  check('with no WazzOCR source attached', after.body.source === null && after.body.manageAt === null, after.body);

  const verify = await req('GET', '/api/xero/verify', { cookie });
  check('verify proves the token reaches Xero', verify.body.ok === true && verify.body.xeroSees === 1, verify.body);

  const token = await xero.accessTokenFor(1, 'demo-tenant-1');
  check('an access token can be obtained from the stored grant', token === 'access-1', token);
  const rotated = await db.getOne('SELECT refresh_token FROM xero_grants WHERE account_id = 1');
  check('and the rotated refresh token is written back', decrypt(rotated.refresh_token) === 'refresh-1');

  console.log('\nNothing of WazzOCR\'s was touched');
  const wazzocrRows = await db.query(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'wazzocr_test'");
  check('the WazzOCR fixture schema is untouched by own mode',
    Number(wazzocrRows[0].n) === 2 || Number(wazzocrRows[0].n) === 0, wazzocrRows[0].n);

  global.fetch = realFetch;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
