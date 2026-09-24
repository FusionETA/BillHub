// The shared Xero grant: Bills Hub reads WazzOCR's refresh token, rotates it,
// and writes the new one back to that same row — the only write it ever makes
// into WazzOCR's database.
//
// Xero's token endpoint is stubbed at the fetch layer, so lib/xero's real
// refresh, caching and locking all run.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
// Pin the auth mode: these suites exercise the real sign-in path, whatever
// the local .env happens to be set to. Must precede any require of server.js.
process.env.AUTH_DISABLED = 'false';
// Pin the grant source too: these suites exercise borrowed mode, the riskier
// of the two, whatever the local .env is set to. test/ownmode.test.js covers
// the other. Must precede any require of lib/grantSource.
process.env.XERO_GRANT_SOURCE = 'wazzocr';
// Xero is stubbed in these suites, so the credentials only need to exist —
// but they must exist, or ensureConfig refuses before the stub is reached.
process.env.XERO_CLIENT_ID = 'test-client-id';
process.env.XERO_CLIENT_SECRET = 'test-client-secret';
const db = require('../db');
const xero = require('../lib/xero');
const xc = require('../models/xeroConnections');
const accounts = require('../models/accounts');
const { encrypt, decrypt } = require('../lib/crypto');
const { GRANTS, CONNECTIONS, BORROWED } = require('../lib/grantSource');

const ACCOUNT = 1;
const WAZZOCR_ACCOUNT = 7;
const TENANT = 'tenant-abm';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok    ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

// Stub Xero's identity endpoint. Each refresh hands back the next token in the
// chain, and rejects a token that has already been spent — exactly how Xero
// behaves with single-use refresh tokens.
const spent = new Set();
let issued = 0;
const tokenCalls = [];
const realFetch = global.fetch;

function stubFetch({ failWith = null } = {}) {
  global.fetch = async (url, opts = {}) => {
    // lib/xero uses login.xero.com/identity/connect, the same base WazzOCR uses.
    if (!String(url).includes('/identity/connect/token')) return realFetch(url, opts);
    const body = new URLSearchParams(opts.body || '');
    const used = body.get('refresh_token');
    tokenCalls.push(used);
    if (failWith) {
      return { ok: false, status: failWith.status, json: async () => failWith.body };
    }
    if (spent.has(used)) {
      return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'refresh token already used' }) };
    }
    spent.add(used);
    issued += 1;
    const next = `rotated-token-${issued}`;
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: `access-${issued}`, refresh_token: next, expires_in: 1800 })
    };
  };
}

async function storedToken() {
  const row = await db.getOne(`SELECT refresh_token FROM ${GRANTS} WHERE account_id = ?`, [WAZZOCR_ACCOUNT]);
  return decrypt(row.refresh_token);
}

async function resetGrant(value = 'start-token') {
  await db.execute(`UPDATE ${GRANTS} SET refresh_token = ? WHERE account_id = ?`, [encrypt(value), WAZZOCR_ACCOUNT]);
  spent.clear();
  tokenCalls.length = 0;
  issued = 0;
  // lib/xero caches access tokens per grant; clear it between cases.
  await xero.invalidateToken(ACCOUNT, TENANT);
}

(async () => {
  stubFetch();

  console.log('Rotation');
  await resetGrant();
  const token1 = await xero.accessTokenFor(ACCOUNT, TENANT);
  check('an access token is issued', token1 === 'access-1', token1);
  check('it refreshed using WazzOCR\'s stored token', tokenCalls[0] === 'start-token', tokenCalls);
  check('the rotated token is written back to WazzOCR', await storedToken() === 'rotated-token-1', await storedToken());

  console.log('\nCaching');
  tokenCalls.length = 0;
  const token2 = await xero.accessTokenFor(ACCOUNT, TENANT);
  check('a second call reuses the cached access token', token2 === 'access-1' && tokenCalls.length === 0, tokenCalls);

  const other = await xero.accessTokenFor(ACCOUNT, 'tenant-abkk');
  check('one access token serves every org on the grant', other === 'access-1' && tokenCalls.length === 0, tokenCalls);

  console.log('\nConcurrency');
  await resetGrant('concurrent-start');
  // Ten callers at once must produce exactly one refresh: a second would spend
  // a token the first had already rotated away.
  const results = await Promise.all(Array.from({ length: 10 }, () => xero.accessTokenFor(ACCOUNT, TENANT)));
  check('ten concurrent callers cause exactly one refresh', tokenCalls.length === 1, tokenCalls);
  check('they all get the same access token', new Set(results).size === 1, results);
  check('the grant row holds the rotated token', await storedToken() === `rotated-token-${issued}`, await storedToken());

  console.log('\nSequential refreshes hand off cleanly');
  await resetGrant('handoff-start');
  await xero.accessTokenFor(ACCOUNT, TENANT);
  const afterFirst = await storedToken();
  await xero.invalidateToken(ACCOUNT, TENANT);   // simulate the access token expiring
  await xero.accessTokenFor(ACCOUNT, TENANT);
  check('the second refresh used the token the first stored', tokenCalls[1] === afterFirst, tokenCalls);
  check('no token was ever spent twice', tokenCalls.length === new Set(tokenCalls).size, tokenCalls);

  console.log('\nFailure');
  await resetGrant('doomed-token');
  stubFetch({ failWith: { status: 400, body: { error: 'invalid_grant', error_description: 'expired' } } });
  let err = null;
  try { await xero.accessTokenFor(ACCOUNT, TENANT); } catch (e) { err = e; }
  check('a refused refresh throws 401 so the API can map it to 424', err && err.statusCode === 401, err && err.message);
  check('a failed refresh leaves WazzOCR\'s token untouched', await storedToken() === 'doomed-token', await storedToken());

  console.log('\nAccount mapping');
  stubFetch();
  await db.execute('UPDATE accounts SET wazzocr_account_id = NULL WHERE id = ?', [ACCOUNT]);
  accounts.forgetWazzocrId(ACCOUNT);
  let mapErr = null;
  try { await xero.accessTokenFor(ACCOUNT, TENANT); } catch (e) { mapErr = e; }
  check('an unlinked account fails with a clear 424', mapErr && mapErr.statusCode === 424, mapErr && mapErr.message);
  await db.execute('UPDATE accounts SET wazzocr_account_id = ? WHERE id = ?', [WAZZOCR_ACCOUNT, ACCOUNT]);
  accounts.forgetWazzocrId(ACCOUNT);

  console.log('\nUnknown organisation');
  await resetGrant();
  let tenantErr = null;
  try { await xero.accessTokenFor(ACCOUNT, 'tenant-not-connected'); } catch (e) { tenantErr = e; }
  check('an org WazzOCR has not connected fails with 401',
    tenantErr && tenantErr.statusCode === 401 && /WazzOCR/.test(tenantErr.message), tenantErr && tenantErr.message);

  // ── A rotation underneath us ──────────────────────────────────────────────
  // Xero refresh tokens are single-use. Bills Hub locks the grant row before
  // refreshing; WazzOCR does not, so it can spend the token between our read
  // and our use of it. The failure is indistinguishable from a dead grant
  // except for one thing: the stored token will have changed.
  console.log('\nA rotation underneath us');

  const realGet = xc.getGrantForTenant;
  async function withWazzocrRacingUs(fn) {
    let reads = 0;
    xc.getGrantForTenant = async (a, t) => {
      reads += 1;
      // The second read is our recovery re-read, by which point WazzOCR's own
      // UPDATE — blocked on the lock we just released — has landed.
      if (reads === 2) {
        await db.execute(`UPDATE ${GRANTS} SET refresh_token = ? WHERE account_id = ?`,
          [encrypt('wazzocr-wrote-this'), WAZZOCR_ACCOUNT]);
      }
      return realGet.call(xc, a, t);
    };
    try { return await fn(); } finally { xc.getGrantForTenant = realGet; }
  }

  await resetGrant('race-token');
  spent.add('race-token');            // WazzOCR got there first
  let raced = null, racedErr = null;
  try { raced = await withWazzocrRacingUs(() => xero.accessTokenFor(ACCOUNT, TENANT)); }
  catch (e) { racedErr = e; }

  check('it recovers instead of failing', racedErr === null && Boolean(raced), racedErr && racedErr.message);
  check('the first attempt spent the token we had read', tokenCalls[0] === 'race-token', tokenCalls);
  check('and the retry used what WazzOCR had stored', tokenCalls[1] === 'wazzocr-wrote-this', tokenCalls);
  check('exactly one retry, not a loop', tokenCalls.length === 2, tokenCalls);

  // The opposite case: the token has NOT moved, so nothing explains the
  // failure and the grant really is dead. Retrying would just spend calls.
  await resetGrant('dead-token');
  spent.add('dead-token');
  let deadErr = null;
  try { await xero.accessTokenFor(ACCOUNT, TENANT); } catch (e) { deadErr = e; }
  check('an unchanged token is reported as a real failure', deadErr !== null, deadErr);
  check('and it is not retried', tokenCalls.length === 1, tokenCalls);
  check('it surfaces as a 401 so the UI asks for a reconnect', deadErr && deadErr.statusCode === 401, deadErr && deadErr.statusCode);

  // A failure that is not invalid_grant must not trigger the recovery at all.
  await resetGrant('fine-token');
  stubFetch({ failWith: { status: 401, body: { error: 'invalid_client', error_description: 'bad secret' } } });
  let clientErr = null;
  try { await xero.accessTokenFor(ACCOUNT, TENANT); } catch (e) { clientErr = e; }
  check('a wrong client secret is not mistaken for a rotation',
    clientErr !== null && tokenCalls.length === 1, { msg: clientErr && clientErr.message, tokenCalls });
  stubFetch();

  // ── What the grant carries ────────────────────────────────────────────────
  // Read off xero_grants.scope, with no Xero call. This is the check that
  // decides whether borrowing WazzOCR's grant silently costs a feature, so the
  // rule it applies is worth pinning down.
  console.log('\nScopes the grant covers');

  const missing = (s) => xero.missingScopes(s).map(([scope]) => scope);

  const full = 'openid profile email offline_access accounting.invoices '
    + 'accounting.payments accounting.contacts accounting.settings.read';
  check('the granular set Bills Hub asks for is complete', missing(full).length === 0, missing(full));

  // WazzOCR's own scope string, verbatim. It never creates a payment, so this
  // is the gap stage 2 has to either close or work around.
  const wazzocr = 'openid profile email offline_access accounting.invoices '
    + 'accounting.contacts accounting.settings accounting.attachments';
  check("WazzOCR's grant is short exactly one scope",
    missing(wazzocr).join() === 'accounting.payments', missing(wazzocr));
  check('and the gap is reported with the feature it costs',
    /bank-file/.test(xero.missingScopes(wazzocr)[0][1]), xero.missingScopes(wazzocr)[0]);

  // Apps predating March 2026 hold the broad scope instead.
  const broad = 'openid offline_access accounting.transactions accounting.settings.read';
  check('accounting.transactions covers the three scopes it was split into',
    missing(broad).length === 0, missing(broad));
  check('but it does not cover settings.read on its own',
    missing('openid offline_access accounting.transactions').join() === 'accounting.settings.read',
    missing('openid offline_access accounting.transactions'));
  check('and the settings WRITE scope covers the read one',
    !missing('accounting.transactions accounting.settings').includes('accounting.settings.read'),
    missing('accounting.transactions accounting.settings'));

  check('a grant recording no scope makes no claim either way', missing('').length === 0, missing(''));
  check('every required scope is documented with what it buys',
    xero.SCOPES_REQUIRED.every(([s2, what]) => s2 && what && what.length > 10), xero.SCOPES_REQUIRED);

  // Leave the seed in a usable state.
  await resetGrant('fake-refresh-token-for-local-test');
  global.fetch = realFetch;

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await db.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
