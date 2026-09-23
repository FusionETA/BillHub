// The two guards that keep a test deployment away from live Xero organisations.
//
//   XERO_TENANT_ALLOWLIST  refuses Xero writes outside the list (hard guard)
//   entities.included      stops an org being synced or shown (soft guard)
//
// The allowlist is read when lib/xero loads, so it is set before the require.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.AUTH_DISABLED = 'false';
// Pin the grant source too: these suites exercise borrowed mode, the riskier
// of the two, whatever the local .env is set to. test/ownmode.test.js covers
// the other. Must precede any require of lib/grantSource.
process.env.XERO_GRANT_SOURCE = 'wazzocr';
// Xero is stubbed in these suites, so the credentials only need to exist —
// but they must exist, or ensureConfig refuses before the stub is reached.
process.env.XERO_CLIENT_ID = 'test-client-id';
process.env.XERO_CLIENT_SECRET = 'test-client-secret';
process.env.XERO_TENANT_ALLOWLIST = 'tenant-abkk, tenant-demo';

const db = require('../db');
const xero = require('../lib/xero');
const entities = require('../models/entities');
const accounts = require('../models/accounts');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok    ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
function refused(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

(async () => {
  await require('./seed').seed({ quiet: true });

  console.log('Write allowlist');
  check('the list is parsed, whitespace and all', xero.ALLOWLIST && xero.ALLOWLIST.size === 2, xero.ALLOWLIST && [...xero.ALLOWLIST]);
  check('reads are allowed anywhere', refused(() => xero.assertWritable('tenant-abm', 'GET')) === null);
  check('a write to a listed org is allowed', refused(() => xero.assertWritable('tenant-abkk', 'POST')) === null);

  const blocked = refused(() => xero.assertWritable('tenant-abm', 'POST'));
  check('a write to an unlisted org is refused', blocked !== null && blocked.statusCode === 403, blocked && blocked.message);
  check('and the message names the organisation', blocked && /tenant-abm/.test(blocked.message), blocked && blocked.message);
  check('PUT is refused too', refused(() => xero.assertWritable('tenant-abm', 'PUT')) !== null);

  // The real api() call must refuse before it reaches the network or the token.
  let apiErr = null;
  try { await xero.api(1, 'tenant-abm', '/Invoices', { method: 'POST', body: {} }); }
  catch (e) { apiErr = e; }
  check('api() refuses the write before touching Xero at all',
    apiErr && apiErr.statusCode === 403, apiErr && apiErr.message);

  console.log('\nExcluding an organisation');
  const wazzocrAccountId = await accounts.wazzocrIdFor(1);
  const before = await entities.listSyncable(1, wazzocrAccountId);
  check('every org syncs by default', before.length === 5, before.length);

  await entities.update(1, 'tenant-abm', { included: false });
  const after = await entities.listSyncable(1, wazzocrAccountId);
  check('an excluded org is not synced', after.length === 4 && !after.some((e) => e.xero_tenant_id === 'tenant-abm'), after.length);

  const listed = await entities.listByAccount(1, wazzocrAccountId);
  check('and is hidden from the entity list', !listed.some((e) => e.xero_tenant_id === 'tenant-abm'), listed.length);

  const withExcluded = await entities.listByAccount(1, wazzocrAccountId, { includedOnly: false });
  check('but is still visible when asked for', withExcluded.length === 5, withExcluded.length);

  await entities.update(1, 'tenant-abm', { included: true });
  check('and can be put back', (await entities.listSyncable(1, wazzocrAccountId)).length === 5);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await db.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
