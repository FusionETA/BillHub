// Exercises the sync engine against a stubbed Xero: pagination, the
// If-Modified-Since cursor, 304 handling and per-organisation error isolation.
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
const xero = require('../lib/xero');
const db = require('../db');
const sync = require('../billhub/sync');
const syncState = require('../models/syncState');
const { encrypt } = require('../lib/crypto');
const { GRANTS, CONNECTIONS, BORROWED } = require('../lib/grantSource');

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
    if (path === '/Organisation') return { Organisations: [{ BaseCurrency: 'MYR' }] };
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
  const pagesFor = (t) => requests.filter(r => r.tenantId === t && String(r.path || '').startsWith('/Invoices'));
  check('the first run sends no If-Modified-Since',
    pagesFor('synctA').every(r => r.ifModifiedSince === null));
  check('it stopped after the short final page', pagesFor('synctA').length === 3, pagesFor('synctA').length);
  check('and it asked Xero for the organisation\'s base currency',
    requests.some(r => r.tenantId === 'synctA' && r.path === '/Organisation'),
    requests.map(r => r.path));

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

  const entA = await db.getOne("SELECT code, short_name, base_currency FROM entities WHERE xero_tenant_id = 'synctA'");
  check('sync seeds the entity code', entA.code === 'SOA' && entA.short_name === 'Sync Org A', entA);
  check('and records the organisation\'s base currency', entA.base_currency === 'MYR', entA.base_currency);

  console.log('\nSecond run (incremental)');
  requests.length = 0;
  let served304 = false;
  xero.api = async (accountId, tenantId, path, opts = {}) => {
    requests.push({ tenantId, path, ifModifiedSince: (opts.headers || {})['If-Modified-Since'] || null });
    served304 = true;
    return null; // Xero 304: nothing changed
  };
  const r2 = await sync.syncAccount(ACCOUNT, { tenantIds: ['synctA'] });
  const firstPage = requests.find(r => String(r.path || '').startsWith('/Invoices'));
  check('the second run sends If-Modified-Since', firstPage.ifModifiedSince !== null, firstPage);
  check('the cursor is rewound a minute to avoid dropping same-second updates',
    firstPage.ifModifiedSince === '2026-09-03T12:33:56', firstPage.ifModifiedSince);
  check('and it does not re-ask for a currency it already knows',
    !requests.some(r => r.path === '/Organisation'), requests.map(r => r.path));
  check('a 304 upserts nothing', served304 && r2.upserted === 0, r2.upserted);

  const stateA2 = await syncState.get(ACCOUNT, 'synctA');
  check('a 304 keeps the existing cursor',
    new Date(stateA2.cursor_utc).toISOString().startsWith('2026-09-03T12:34:56'), stateA2.cursor_utc);

  console.log('\nThird run (full rebuild)');
  requests.length = 0;
  xero.api = async (accountId, tenantId, path, opts = {}) => {
    requests.push({ tenantId, path, ifModifiedSince: (opts.headers || {})['If-Modified-Since'] || null });
    if (path === '/Organisation') return { Organisations: [{ BaseCurrency: 'MYR' }] };
    return { Invoices: [invoice(0, tenantId, '2026-09-05T00:00:00Z')] };
  };
  await sync.syncAccount(ACCOUNT, { tenantIds: ['synctA'], full: true });
  const fullFirst = requests.find(r => String(r.path || '').startsWith('/Invoices'));
  check('a full run ignores the cursor', fullFirst.ifModifiedSince === null, fullFirst);

  const dupes = await db.getOne("SELECT COUNT(*) AS n FROM bills WHERE xero_tenant_id = 'synctA'");
  check('re-syncing the same invoice updates rather than duplicates', Number(dupes.n) === 250, dupes.n);

  // ── Oversized fields ──────────────────────────────────────────────────────
  // What actually happened on the first real sync: 24 of 41 organisations died
  // with "Data too long for column 'reference'". MySQL does not fail one row,
  // it aborts the statement — so a single long reference cost each of those
  // organisations every bill it had.
  console.log('\nFields longer than their columns');

  const bills = require('../models/bills');
  check('fit() cuts to the column width', bills.fit('x'.repeat(900), 'reference').length === 500);
  check('and leaves anything shorter alone', bills.fit('SYNC-REF-1', 'reference') === 'SYNC-REF-1');
  check('null stays null', bills.fit(null, 'reference') === null);
  check('every width it knows about is a real column',
    Object.keys(bills.WIDTHS).every((c) => /^[a-z_]+$/.test(c)), Object.keys(bills.WIDTHS));

  await db.execute(
    `INSERT INTO ${CONNECTIONS} (account_id, grant_id, xero_tenant_id, tenant_name, status) VALUES (?,?,?,?,'active')`,
    [WAZZOCR_ACCOUNT, grantId, 'synctD', 'Sync Org D Sdn Bhd']
  );

  xero.api = async (accountId, tenantId, path) => {
    if (path === '/Organisation') return { Organisations: [{ BaseCurrency: 'MYR' }] };
    const page = Number(new URL('http://x' + path).searchParams.get('page'));
    if (page !== 1) return { Invoices: [] };
    const long = invoice(1, 'synctD', '2026-09-04T00:00:00Z');
    long.Reference = 'R'.repeat(900);              // longer than the column
    long.Contact = { ContactID: 'c1'.padEnd(36, '0'), Name: 'N'.repeat(400) };
    const broken = invoice(2, 'synctD', '2026-09-04T00:01:00Z');
    broken.InvoiceID = 'x'.repeat(80);             // too long for CHAR(36) — nothing can save this one
    return { Invoices: [long, broken, invoice(3, 'synctD', '2026-09-04T00:02:00Z')] };
  };

  const rD = await sync.syncAccount(ACCOUNT, { tenantIds: ['synctD'] });
  check('the organisation is no longer lost to one bad field', rD.failed === 0, rD);
  check('the oversized bill is stored rather than dropped', rD.upserted === 2, rD.upserted);

  const cut = await db.getOne(
    "SELECT reference, contact_name FROM bills WHERE xero_tenant_id = 'synctD' AND invoice_number = 'SYNC-1'");
  check('its reference was cut to fit', cut && cut.reference.length === 500, cut && cut.reference.length);
  check('and so was the contact name', cut && cut.contact_name.length === 255, cut && cut.contact_name.length);

  const stateD = await syncState.get(ACCOUNT, 'synctD');
  check('a genuinely unstorable bill is skipped, not fatal', stateD.last_status === 'ok', stateD.last_status);
  check('but the run says so rather than looking clean',
    /1 bill\(s\) skipped/.test(stateD.last_error || ''), stateD.last_error);
  check('and it names how to get it back', /--full/.test(stateD.last_error || ''), stateD.last_error);
  check('the bills either side of it still landed',
    Number((await db.getOne("SELECT COUNT(*) AS n FROM bills WHERE xero_tenant_id = 'synctD'")).n) === 2);

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
