// Exercises the sync engine against a stubbed Xero: pagination, the
// If-Modified-Since cursor, 304 handling and per-organisation error isolation.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
// Pin the auth mode: these suites exercise the real sign-in path, whatever
// the local .env happens to be set to. Must precede any require of server.js.
process.env.AUTH_DISABLED = 'false';
const xero = require('../lib/xero');
const db = require('../db');
const sync = require('../billhub/sync');
const syncState = require('../models/syncState');
const { encrypt } = require('../lib/crypto');
const { GRANTS, CONNECTIONS } = require('../lib/wazzocrDb');

const ACCOUNT = 1;          // Bills Hub account
const WAZZOCR_ACCOUNT = 7;  // its counterpart in the WazzOCR database
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok    ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

const xdate = (iso) => `/Date(${Date.parse(iso)}+0000)/`;

function invoice(n, tenant, updated) {
  return {
    // A real GUID shape, unique per (tenant, n) — padEnd on the number would
    // make n=10 and n=100 collide.
    InvoiceID: '00000000-0000-0000-' + tenant.slice(-1) + '000-' + String(n).padStart(12, '0'),
    Type: 'ACCPAY',
    InvoiceNumber: 'SYNC-' + n,
    Reference: 'SYNC-REF-' + n,
    Contact: { ContactID: ('c' + n).padEnd(36, '0'), Name: 'Supplier ' + (n % 3) },
    Status: 'DRAFT',
    Date: xdate('2026-09-01T00:00:00Z'),
    DueDate: xdate('2026-09-30T00:00:00Z'),
    CurrencyCode: 'MYR',
    SubTotal: 100, TotalTax: 0, Total: 100, AmountPaid: 0, AmountDue: 100, AmountCredited: 0,
    HasAttachments: false,
    UpdatedDateUTC: xdate(updated)
  };
}

const requests = [];

(async () => {
  // Start from a clean slate for the tenants this test touches. The connections
  // live in the WazzOCR database, which is what Bills Hub reads.
  await db.execute("DELETE FROM bills WHERE xero_tenant_id LIKE 'synct%'");
  await db.execute("DELETE FROM bill_sync_state WHERE xero_tenant_id LIKE 'synct%'");
  await db.execute("DELETE FROM entities WHERE xero_tenant_id LIKE 'synct%'");
  await db.execute(`DELETE FROM ${CONNECTIONS} WHERE xero_tenant_id LIKE 'synct%'`);
  const grantId = await db.insert(
    `INSERT INTO ${GRANTS} (account_id, refresh_token, scope) VALUES (?,?,?)`,
    [WAZZOCR_ACCOUNT, encrypt('sync-test-refresh-token'), 'test']
  );
  for (const [id, name] of [['synctA', 'Sync Org A Sdn Bhd'], ['synctB', 'Sync Org B Sdn Bhd'], ['synctC', 'Sync Org C Sdn Bhd']]) {
    await db.execute(
      `INSERT INTO ${CONNECTIONS} (account_id, grant_id, xero_tenant_id, tenant_name, status) VALUES (?,?,?,?,'active')`,
      [WAZZOCR_ACCOUNT, grantId, id, name]
    );
  }

  // Org A pages (250 bills over 3 pages), org B returns nothing, org C fails.
  xero.api = async (accountId, tenantId, path, opts = {}) => {
    requests.push({ tenantId, path, ifModifiedSince: (opts.headers || {})['If-Modified-Since'] || null });
    if (tenantId === 'synctC') {
      const err = new Error('Xero token refresh failed (400)');
      err.statusCode = 401;
      throw err;
    }
    const page = Number(new URL('http://x' + path).searchParams.get('page'));
    if (tenantId === 'synctB') return { Invoices: [] };
    if (page === 1) return { Invoices: Array.from({ length: 100 }, (_, i) => invoice(i, tenantId, '2026-09-01T00:00:00Z')) };
    if (page === 2) return { Invoices: Array.from({ length: 100 }, (_, i) => invoice(100 + i, tenantId, '2026-09-02T00:00:00Z')) };
    if (page === 3) return { Invoices: Array.from({ length: 50 }, (_, i) => invoice(200 + i, tenantId, '2026-09-03T12:34:56Z')) };
    return { Invoices: [] };
  };

  console.log('First run (no cursor)');
  const r1 = await sync.syncAccount(ACCOUNT, { tenantIds: ['synctA', 'synctB', 'synctC'] });
  check('all three organisations were attempted', r1.tenants === 3, r1.tenants);
  check('250 bills pulled across 3 pages', r1.upserted === 250, r1.upserted);
  check('one organisation failed without stopping the others', r1.failed === 1, r1.failed);
  check('the first run sends no If-Modified-Since',
    requests.filter(r => r.tenantId === 'synctA').every(r => r.ifModifiedSince === null));
  check('it stopped after the short final page',
    requests.filter(r => r.tenantId === 'synctA').length === 3,
    requests.filter(r => r.tenantId === 'synctA').length);

  const stored = await db.getOne("SELECT COUNT(*) AS n FROM bills WHERE xero_tenant_id = 'synctA'");
  check('bills are stored', Number(stored.n) === 250, stored.n);

  const stateA = await syncState.get(ACCOUNT, 'synctA');
  check('cursor is the newest UpdatedDateUTC seen',
    new Date(stateA.cursor_utc).toISOString().startsWith('2026-09-03T12:34:56'),
    stateA.cursor_utc);
  check('a successful run is marked ok', stateA.last_status === 'ok', stateA.last_status);

  const stateC = await syncState.get(ACCOUNT, 'synctC');
  check('a failed run records the error', stateC.last_status === 'error' && stateC.last_error.includes('refresh failed'), stateC.last_error);
  check('the failed run leaves the cursor unset so it retries the same window', stateC.cursor_utc === null, stateC.cursor_utc);

  // Bills Hub must NOT write WazzOCR's needs_reconnect flag — that connection
  // belongs to WazzOCR, and the only column Bills Hub may write is the token.
  const connC = await db.getOne(`SELECT needs_reconnect, status FROM ${CONNECTIONS} WHERE xero_tenant_id = 'synctC'`);
  check('a failing org is not mutated in WazzOCR', connC.needs_reconnect === 0 && connC.status === 'active', connC);

  const entA = await db.getOne("SELECT code, short_name FROM entities WHERE xero_tenant_id = 'synctA'");
  check('sync seeds the entity code', entA.code === 'SOA' && entA.short_name === 'Sync Org A', entA);

  console.log('\nSecond run (incremental)');
  requests.length = 0;
  let served304 = false;
  xero.api = async (accountId, tenantId, path, opts = {}) => {
    requests.push({ tenantId, ifModifiedSince: (opts.headers || {})['If-Modified-Since'] || null });
    served304 = true;
    return null; // Xero 304: nothing changed
  };
  const r2 = await sync.syncAccount(ACCOUNT, { tenantIds: ['synctA'] });
  check('the second run sends If-Modified-Since', requests[0].ifModifiedSince !== null, requests[0]);
  check('the cursor is rewound a minute to avoid dropping same-second updates',
    requests[0].ifModifiedSince === '2026-09-03T12:33:56', requests[0].ifModifiedSince);
  check('a 304 upserts nothing', served304 && r2.upserted === 0, r2.upserted);

  const stateA2 = await syncState.get(ACCOUNT, 'synctA');
  check('a 304 keeps the existing cursor',
    new Date(stateA2.cursor_utc).toISOString().startsWith('2026-09-03T12:34:56'), stateA2.cursor_utc);

  console.log('\nThird run (full rebuild)');
  requests.length = 0;
  xero.api = async (accountId, tenantId, path, opts = {}) => {
    requests.push({ tenantId, ifModifiedSince: (opts.headers || {})['If-Modified-Since'] || null });
    return { Invoices: [invoice(0, tenantId, '2026-09-05T00:00:00Z')] };
  };
  await sync.syncAccount(ACCOUNT, { tenantIds: ['synctA'], full: true });
  check('a full run ignores the cursor', requests[0].ifModifiedSince === null, requests[0]);

  const dupes = await db.getOne("SELECT COUNT(*) AS n FROM bills WHERE xero_tenant_id = 'synctA'");
  check('re-syncing the same invoice updates rather than duplicates', Number(dupes.n) === 250, dupes.n);

  // Clean up so the seeded demo data is what remains.
  await db.execute("DELETE FROM bills WHERE xero_tenant_id LIKE 'synct%'");
  await db.execute("DELETE FROM bill_sync_state WHERE xero_tenant_id LIKE 'synct%'");
  await db.execute("DELETE FROM entities WHERE xero_tenant_id LIKE 'synct%'");
  await db.execute(`DELETE FROM ${CONNECTIONS} WHERE xero_tenant_id LIKE 'synct%'`);
  await db.execute(`DELETE FROM ${GRANTS} WHERE id = ?`, [grantId]);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await db.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
