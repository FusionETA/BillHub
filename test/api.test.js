// Exercises the bill actions against a stubbed Xero, in-process.
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
const http = require('http');
const xero = require('../lib/xero');
const db = require('../db');
const { GRANTS, CONNECTIONS, WAZZOCR_DB: DB_NAME, BORROWED } = require('../lib/grantSource');
const { decrypt } = require('../lib/crypto');

const calls = [];
xero.api = async (accountId, tenantId, path, opts = {}) => {
  calls.push({ tenantId, path, method: opts.method || 'GET', body: opts.body });
  if (opts.method === 'POST' && path === '/Invoices') {
    const inv = opts.body.Invoices[0];
    // Xero rejects a bill with no line items when you try to approve it.
    if (inv.Status === 'AUTHORISED' && inv.InvoiceID.endsWith('7')) {
      const err = new Error('An Invoice must have at least one line item.');
      err.statusCode = 400;
      throw err;
    }
    return { Invoices: [{ ...inv }] };
  }
  return { Invoices: [] };
};

const app = require('../server');
const server = app.listen(3312);

function req(method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: 3312, path, method,
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
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? '  -> ' + JSON.stringify(detail) : '')); }
}

(async () => {
  // Start from known fixture data, whatever ran before.
  await require('./seed').seed({ quiet: true });

  const login = await req('POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'billhub-local-test' } });
  const cookie = (login.headers['set-cookie'] || [])[0].split(';')[0];
  check('login sets a session cookie', login.status === 200 && Boolean(cookie));

  console.log('\nFilters');
  const all = await req('GET', '/api/bills', { cookie });
  check('VOIDED bills are excluded', all.body.page.total === 11, all.body.page);

  const drafts = await req('GET', '/api/bills?status=draft', { cookie });
  check('status=draft returns only drafts', drafts.body.rows.every(r => r.uiStatus === 'draft') && drafts.body.rows.length === 5, drafts.body.rows.length);
  check('tab counts ignore the active status filter', drafts.body.statusTabs.find(t => t.value === 'paid').count === 1);

  const byEntity = await req('GET', '/api/bills?entities=tenant-abkj', { cookie });
  check('entity filter narrows to one org', byEntity.body.rows.every(r => r.entityCode === 'ABKJ') && byEntity.body.rows.length === 3, byEntity.body.rows.length);

  const byText = await req('GET', '/api/bills?q=GRB', { cookie });
  check('text search matches a reference', byText.body.rows.length === 1 && byText.body.rows[0].contact === 'Grab Malaysia', byText.body.rows.length);

  const byAmount = await req('GET', '/api/bills?q=612.40', { cookie });
  check('numeric search matches an amount', byAmount.body.rows.length === 1 && byAmount.body.rows[0].outFmt === '612.40', byAmount.body.rows.length);

  const byContact = await req('GET', '/api/bills?contact=' + encodeURIComponent('Simon Chim'), { cookie });
  check('contact filter works', byContact.body.rows.length === 2, byContact.body.rows.length);

  const byDate = await req('GET', '/api/bills?dateType=due&dateFrom=2026-09-01&dateTo=2026-09-20', { cookie });
  check('due-date range filter works', byDate.body.rows.length === 6, byDate.body.rows.map(r => r.dueFmt));

  const byRange = await req('GET', '/api/bills?amountFrom=5000&amountTo=15000', { cookie });
  // The amount filter is on the bill total, not the outstanding balance, so the
  // fully-paid 9,840.20 bill is inside the range even though nothing is due.
  check('amount range filter works (on bill total)', byRange.body.rows.length === 5, byRange.body.rows.map(r => r.total));

  console.log('\nActions');
  const draft = drafts.body.rows[0];
  const submitted = await req('POST', '/api/bills/' + draft.id + '/submit', { cookie });
  check('submit returns ok', submitted.status === 200 && submitted.body.xeroStatus === 'SUBMITTED', submitted.body);
  const lastCall = calls[calls.length - 1];
  check('submit POSTs the right payload to Xero',
    lastCall.path === '/Invoices' && lastCall.method === 'POST' && lastCall.body.Invoices[0].Status === 'SUBMITTED' && lastCall.tenantId === draft.tenantId,
    lastCall);

  const row = await db.getOne('SELECT xero_status FROM bills WHERE id = ?', [draft.id]);
  check('local row mirrors the new Xero status', row.xero_status === 'SUBMITTED', row);

  const again = await req('POST', '/api/bills/' + draft.id + '/submit', { cookie });
  check('re-submitting the same bill is refused with 409', again.status === 409, again.body);

  const wrongAction = await req('POST', '/api/bills/' + draft.id + '/approve', { cookie });
  check('a submitted bill can be approved', wrongAction.status === 200 && wrongAction.body.xeroStatus === 'AUTHORISED', wrongAction.body);

  console.log('\nBulk');
  const remainingDrafts = (await req('GET', '/api/bills?status=draft', { cookie })).body.rows;
  const bulk = await req('POST', '/api/bills/bulk', { cookie, body: { action: 'submit', ids: remainingDrafts.map(r => r.id) } });
  check('bulk submit moves every draft', bulk.body.succeeded.length === remainingDrafts.length && bulk.body.failed.length === 0, bulk.body);

  const approvals = (await req('GET', '/api/bills?status=approval', { cookie })).body.rows;
  const bulkApprove = await req('POST', '/api/bills/bulk', { cookie, body: { action: 'approve', ids: approvals.map(r => r.id) } });
  check('one Xero rejection does not strand the rest',
    bulkApprove.body.succeeded.length === approvals.length - 1 && bulkApprove.body.failed.length === 1,
    bulkApprove.body);
  check('the failure names the bill and the Xero message',
    bulkApprove.body.failed[0].error.includes('line item') && Boolean(bulkApprove.body.failed[0].reference),
    bulkApprove.body.failed[0]);

  const badAction = await req('POST', '/api/bills/bulk', { cookie, body: { action: 'delete', ids: [1] } });
  check('an unknown bulk action is rejected', badAction.status === 400, badAction.body);

  const empty = await req('POST', '/api/bills/bulk', { cookie, body: { action: 'submit', ids: [] } });
  check('an empty selection is rejected', empty.status === 400, empty.body);

  console.log('\nScoping');
  const otherAccount = await req('GET', '/api/bills/99999', { cookie });
  check('an unknown bill id is a 404', otherAccount.status === 404, otherAccount.body);

  const noCookie = await req('GET', '/api/bills');
  check('no session is a 401', noCookie.status === 401, noCookie.status);

  console.log('\nThe organisations panel');
  const panel = await req('GET', '/api/bills/entities?all=true', { cookie });
  check('it lists every organisation with its own currency',
    panel.body.entities.length === 5 && panel.body.entities.every(e => e.baseCurrency), panel.body.entities[0]);
  check('and says where the grant comes from',
    panel.body.grantSource === 'wazzocr' && panel.body.canConnectHere === false, panel.body.grantSource);
  check('with the resolved currency alongside', panel.body.currency.symbol === 'RM', panel.body.currency);

  const hidden = await req('PATCH', '/api/bills/entities/tenant-abkk', { cookie, body: { included: false } });
  check('an organisation can be taken out of use from the panel',
    hidden.status === 200 && hidden.body.entity.included === false, hidden.body);
  const stillListed = await req('GET', '/api/bills/entities', { cookie });
  check('and then it is not listed', stillListed.body.entities.length === 4, stillListed.body.entities.length);
  const withAll = await req('GET', '/api/bills/entities?all=true', { cookie });
  check('but ?all=true still shows it', withAll.body.entities.length === 5);

  const renamed = await req('PATCH', '/api/bills/entities/tenant-abkk', { cookie, body: { code: 'kk2', included: true } });
  check('a code can be renamed, and is upper-cased', renamed.body.entity.code === 'KK2', renamed.body.entity);
  await req('PATCH', '/api/bills/entities/tenant-abkk', { cookie, body: { code: 'ABKK' } });

  const noSuchOrg = await req('PATCH', '/api/bills/entities/not-a-tenant', { cookie, body: { included: false } });
  check('an unknown organisation is a 404', noSuchOrg.status === 404, noSuchOrg.status);

  console.log('\nCurrency follows the organisations, not a setting');
  const entitiesModel = require('../models/entities');
  const gs = require('../lib/grantSource');
  const connAcct = await gs.connectionsAccountId(1);

  await db.execute("UPDATE entities SET base_currency = 'MYR' WHERE account_id = 1");
  const myr = await req('GET', '/api/bills', { cookie });
  check('a Malaysian organisation is labelled RM', myr.body.currency === 'RM', myr.body.currency);
  check('and every figure carries it', myr.body.stats.every(c => c.amount.startsWith('RM ')), myr.body.stats.map(c => c.amount));
  check('with no caution needed', myr.body.currencyNote === null);

  await db.execute("UPDATE entities SET base_currency = 'USD' WHERE account_id = 1 AND xero_tenant_id = 'tenant-abkk'");
  const mixed = await req('GET', '/api/bills', { cookie });
  check('organisations in two currencies print no symbol at all',
    mixed.body.currency === '' && mixed.body.stats.every(c => !/^[A-Z]/.test(c.amount)), mixed.body.stats.map(c => c.amount));
  check('and the mismatch is stated rather than hidden',
    /MYR and USD/.test(mixed.body.currencyNote || ''), mixed.body.currencyNote);

  await db.execute("UPDATE entities SET base_currency = NULL WHERE account_id = 1");
  const unknown = await req('GET', '/api/bills', { cookie });
  check('an unsynced organisation claims no currency', unknown.body.currency === '' && unknown.body.currencyNote === null);
  await db.execute("UPDATE entities SET base_currency = 'MYR' WHERE account_id = 1");

  check('the resolver agrees', (await entitiesModel.currencyFor(1, connAcct)).symbol === 'RM');

  console.log('\nShared Xero grant');
  const status = await req('GET', '/api/xero/status', { cookie });
  check('status reports the borrowed grant', status.body.connected === true && status.body.count === 5, status.body);
  check('status names where the grant comes from',
    status.body.source.database === DB_NAME && status.body.source.wazzocrAccountId === 7, status.body.source);

  const connect = await req('GET', '/api/xero/connect', { cookie });
  check('Bills Hub refuses to start its own consent', connect.status === 409, connect.status);
  check('and explains it would break WazzOCR',
    /invalidate WazzOCR|WazzOCR's Xero connection/.test(connect.body.error), connect.body.error);

  // The only column Bills Hub may write in WazzOCR is the refresh token.
  const before = await db.getOne(`SELECT refresh_token FROM ${GRANTS} WHERE account_id = 7`);
  const connBefore = await db.query(`SELECT * FROM ${CONNECTIONS} WHERE account_id = 7 ORDER BY xero_tenant_id`);
  await req('GET', '/api/bills', { cookie });
  await req('POST', '/api/bills/sync', { cookie });
  const after = await db.getOne(`SELECT refresh_token FROM ${GRANTS} WHERE account_id = 7`);
  const connAfter = await db.query(`SELECT * FROM ${CONNECTIONS} WHERE account_id = 7 ORDER BY xero_tenant_id`);
  check('reading and syncing leave WazzOCR\'s connections untouched',
    JSON.stringify(connBefore) === JSON.stringify(connAfter));
  check('the stubbed sync never needed to rotate the token',
    decrypt(before.refresh_token) === decrypt(after.refresh_token));

  const tables = await db.query(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?`, [DB_NAME]);
  check('Bills Hub added no tables to WazzOCR\'s database',
    tables.length === 2 && tables.every(r => ['xero_grants', 'xero_connections'].includes(r.t)),
    tables.map(r => r.t));

  console.log('\nEntities & contacts');
  const ents = await req('GET', '/api/bills/entities', { cookie });
  check('entities endpoint lists all 5 orgs with codes', ents.body.entities.length === 5 && ents.body.entities[0].code === 'ABM', ents.body.entities);
  const cts = await req('GET', '/api/bills/contacts', { cookie });
  check('contacts endpoint lists distinct suppliers', cts.body.contacts.length === 10, cts.body.contacts.length);

  // ── Filtering by contact ──────────────────────────────────────────────────
  // Expected counts come from the database rather than from me counting the
  // fixture by eye, which is how a test ends up asserting the wrong number
  // and being "fixed" by changing the code.
  console.log('\nContact filter');
  const top = (await req('GET', '/api/bills/contacts', { cookie })).body.contacts.slice(0, 2);
  const countFor = async (names) => Number((await db.getOne(
    `SELECT COUNT(*) AS n FROM bills WHERE account_id = 1 AND contact_name IN (${names.map(() => '?').join(',')})`,
    names)).n);

  const one = await req('GET', '/api/bills?limit=500&contact=' + encodeURIComponent(top[0].name), { cookie });
  check('one contact filters to just that supplier',
    one.body.rows.length === await countFor([top[0].name]), { got: one.body.rows.length, name: top[0].name });
  check('and every row really is theirs',
    one.body.rows.every((r) => r.contact === top[0].name), one.body.rows.map((r) => r.contact));

  const both = await req('GET', '/api/bills?limit=500'
    + '&contact=' + encodeURIComponent(top[0].name)
    + '&contact=' + encodeURIComponent(top[1].name), { cookie });
  check('two contacts return both suppliers, not neither',
    both.body.rows.length === await countFor([top[0].name, top[1].name]),
    { got: both.body.rows.length, names: top.map((c) => c.name) });
  check('and it is genuinely wider than one of them',
    both.body.rows.length > one.body.rows.length, { one: one.body.rows.length, both: both.body.rows.length });
  check('the rows are drawn from both',
    new Set(both.body.rows.map((r) => r.contact)).size === 2,
    [...new Set(both.body.rows.map((r) => r.contact))]);

  // A supplier name with a comma used to be split in two by the old
  // comma-joined query string, matching nothing.
  await db.execute(
    "UPDATE bills SET contact_name = 'A TO Z CARPET, SDN BHD' WHERE account_id = 1 AND contact_name = ? LIMIT 1",
    [top[0].name]);
  const comma = await req('GET', '/api/bills?limit=500&contact=' + encodeURIComponent('A TO Z CARPET, SDN BHD'), { cookie });
  check('a comma in a supplier name is just a comma',
    comma.body.rows.length === 1 && comma.body.rows[0].contact === 'A TO Z CARPET, SDN BHD',
    comma.body.rows.map((r) => r.contact));
  await db.execute("UPDATE bills SET contact_name = ? WHERE account_id = 1 AND contact_name = 'A TO Z CARPET, SDN BHD'", [top[0].name]);

  const none = await req('GET', '/api/bills?limit=500', { cookie });
  check('no contact parameter still returns everything',
    none.body.rows.length > both.body.rows.length, none.body.rows.length);

  // The first thing anyone curls after a deploy, so it has to say which grant
  // the process is actually running on — the one setting that changes what the
  // deployment can reach.
  console.log('\nHealth');
  const health = await req('GET', '/api/health');
  check('health is served without a session', health.status === 200, health.status);
  check('and reports the database up', health.body.db === 'up', health.body);
  check('it names the grant mode', health.body.grantSource === 'wazzocr', health.body.grantSource);
  check('the grant store is readable', health.body.grantStore === 'up', health.body.grantStore);
  check("in borrowed mode it is also named as WazzOCR's",
    health.body.wazzocrGrantStore === 'up', health.body);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
