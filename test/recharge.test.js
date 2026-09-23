// Intercompany recharge: the split arithmetic, rule matching, and the
// two-sided posting into Xero. Xero is stubbed at lib/xero.api so both
// documents' payloads are asserted.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.AUTH_DISABLED = 'false';

const http = require('http');
const db = require('../db');
const xero = require('../lib/xero');

const calls = [];
let invoiceSeq = 0;
let failOn = null;   // { tenantId, type } -> that Invoices POST throws

xero.api = async (accountId, tenantId, path, opts = {}) => {
  calls.push({ tenantId, path, method: opts.method || 'GET', body: opts.body });

  if (path.startsWith('/Contacts') && (opts.method || 'GET') === 'GET') {
    // Pretend the counterparty contact does not exist, so the create path runs.
    return { Contacts: [] };
  }
  if (path === '/Contacts' && opts.method === 'POST') {
    return { Contacts: [{ ContactID: 'contact-' + opts.body.Contacts[0].Name.replace(/\W/g, ''), Name: opts.body.Contacts[0].Name }] };
  }
  if (path === '/Invoices' && opts.method === 'POST') {
    const inv = opts.body.Invoices[0];
    if (failOn && failOn.tenantId === tenantId && failOn.type === inv.Type) {
      const e = new Error('Account code ' + inv.LineItems[0].AccountCode + ' does not exist in this organisation.');
      e.statusCode = 400;
      throw e;
    }
    invoiceSeq += 1;
    return {
      Invoices: [{
        InvoiceID: String(invoiceSeq).padStart(8, '0') + '-0000-0000-0000-000000000000',
        InvoiceNumber: (inv.Type === 'ACCREC' ? 'AR-IC-' : 'BILL-IC-') + (1000 + invoiceSeq),
        Type: inv.Type, Status: inv.Status
      }]
    };
  }
  return {};
};

const app = require('../server');
const server = app.listen(3316);

function req(method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: 3316, path, method,
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
  await require('./seed').seed({ quiet: true });
  await db.execute('DELETE FROM recharge_run_lines');
  await db.execute('DELETE FROM recharge_runs');
  await db.execute('DELETE FROM recharge_rule_targets');
  await db.execute('DELETE FROM recharge_rules');
  await db.execute('DELETE FROM recharge_settings');

  const login = await req('POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'billhub-local-test' } });
  const cookie = (login.headers['set-cookie'] || [])[0].split(';')[0];

  console.log('Splitting without losing cents');
  const { splitAmount } = require('../billhub/recharge');
  check('an even split is exact', splitAmount(100, [50, 50]).join() === '50,50');
  const thirds = splitAmount(100, [33.3333, 33.3333, 33.3334]);
  check('thirds still add up to the whole', thirds.reduce((a, b) => a + b, 0) === 100, thirds);
  const awkward = splitAmount(1276.40, [33.3333, 33.3333, 33.3334]);
  check('the last share absorbs the rounding', awkward.reduce((a, b) => a + b, 0) === 1276.40, awkward);
  check('a single target takes the lot', splitAmount(17980, [100]).join() === '17980');

  console.log('\nAccount codes are required before anything posts');
  const paid = (await req('GET', '/api/bills?status=paid', { cookie })).body.rows;
  check('there is a paid bill to recharge', paid.length >= 1, paid.length);
  const bill = paid[0];
  const kk = (await req('GET', '/api/bills/entities', { cookie })).body.entities.find((e) => e.code === 'ABKK');
  const kj = (await req('GET', '/api/bills/entities', { cookie })).body.entities.find((e) => e.code === 'ABKJ');

  const noCodes = await req('POST', '/api/recharge/plan', {
    cookie, body: { billId: bill.id, targets: [{ tenantId: kk.tenantId, sharePercent: 100 }] }
  });
  check('planning is refused until the codes are set',
    noCodes.status === 400 && /account codes/.test(noCodes.body.error), noCodes.body.error);

  const cfg = await req('PATCH', '/api/recharge/settings', {
    cookie, body: { arAccountCode: '260', apAccountCode: '429', taxType: 'NONE', referencePrefix: 'IC-', dueDays: 30 }
  });
  check('settings save and report configured', cfg.body.settings.configured === true, cfg.body.settings);

  console.log('\nValidation');
  const unpaid = (await req('GET', '/api/bills?status=draft', { cookie })).body.rows[0];
  const notPaid = await req('POST', '/api/recharge/plan', {
    cookie, body: { billId: unpaid.id, targets: [{ tenantId: kk.tenantId, sharePercent: 100 }] }
  });
  check('an unpaid bill cannot be recharged',
    notPaid.status === 400 && /has not been paid/.test(notPaid.body.error), notPaid.body.error);

  const self = await req('POST', '/api/recharge/plan', {
    cookie, body: { billId: bill.id, targets: [{ tenantId: bill.tenantId, sharePercent: 100 }] }
  });
  check('an entity cannot recharge itself',
    self.status === 400 && /cannot recharge itself/.test(self.body.error), self.body.error);

  const badSplit = await req('POST', '/api/recharge/plan', {
    cookie, body: { billId: bill.id, targets: [{ tenantId: kk.tenantId, sharePercent: 60 }, { tenantId: kj.tenantId, sharePercent: 30 }] }
  });
  check('shares that do not reach 100% are refused',
    badSplit.status === 400 && /90.00%/.test(badSplit.body.error), badSplit.body.error);

  const over = await req('POST', '/api/recharge/plan', {
    cookie, body: { billId: bill.id, targets: [{ tenantId: kk.tenantId, amount: 999999 }] }
  });
  check('an amount above the bill total is refused',
    over.status === 400 && /more than the bill/.test(over.body.error), over.body.error);

  console.log('\nPlanning');
  const plan = await req('POST', '/api/recharge/plan', {
    cookie, body: { billId: bill.id, targets: [{ tenantId: kk.tenantId, sharePercent: 60 }, { tenantId: kj.tenantId, sharePercent: 40 }] }
  });
  check('the plan splits the bill', plan.status === 200 && plan.body.lines.length === 2, plan.body);
  check('the parts sum to the whole',
    plan.body.lines.reduce((n, l) => n + Number(l.amount.replace(/,/g, '')), 0).toFixed(2) === plan.body.bill.total.replace(/,/g, ''),
    { lines: plan.body.lines.map((l) => l.amount), bill: plan.body.bill.total });
  check('each line gets a traceable reference',
    plan.body.lines.every((l) => /^IC-.*-(ABKK|ABKJ)$/.test(l.reference)), plan.body.lines.map((l) => l.reference));
  check('planning writes nothing',
    Number((await db.getOne('SELECT COUNT(*) AS n FROM recharge_runs')).n) === 0);

  console.log('\nCreating a run');
  calls.length = 0;
  const run = await req('POST', '/api/recharge/runs', {
    cookie, body: { billId: bill.id, targets: [{ tenantId: kk.tenantId, sharePercent: 60 }, { tenantId: kj.tenantId, sharePercent: 40 }] }
  });
  check('the run is created', run.status === 201 && run.body.id, run.body);
  check('creating it does NOT touch Xero', calls.length === 0, calls.map((c) => c.path));
  const runId = run.body.id;
  const stored = await db.getOne('SELECT status FROM recharge_runs WHERE id = ?', [runId]);
  check('it starts as a draft', stored.status === 'draft', stored.status);

  const twice = await req('POST', '/api/recharge/runs', {
    cookie, body: { billId: bill.id, targets: [{ tenantId: kk.tenantId, sharePercent: 100 }] }
  });
  check('the same bill cannot be recharged twice',
    twice.status === 409 && /already recharged/.test(twice.body.error), twice.body.error);

  console.log('\nPosting both sides to Xero');
  calls.length = 0;
  const posted = await req('POST', `/api/recharge/runs/${runId}/post`, { cookie });
  check('every line posts', posted.body.posted === 2 && posted.body.failed === 0, posted.body);
  check('the run becomes posted', posted.body.status === 'posted', posted.body.status);

  const invoices = calls.filter((c) => c.path === '/Invoices' && c.method === 'POST');
  check('four documents are created — two per subsidiary', invoices.length === 4, invoices.length);

  const ar = invoices.filter((c) => c.body.Invoices[0].Type === 'ACCREC');
  const ap = invoices.filter((c) => c.body.Invoices[0].Type === 'ACCPAY');
  check('the AR invoices are raised in the payer', ar.every((c) => c.tenantId === bill.tenantId), ar.map((c) => c.tenantId));
  check('the mirror bills are raised in the subsidiaries',
    ap.map((c) => c.tenantId).sort().join() === [kk.tenantId, kj.tenantId].sort().join(), ap.map((c) => c.tenantId));
  check('the AR invoice is authorised, the subsidiary bill is a draft',
    ar.every((c) => c.body.Invoices[0].Status === 'AUTHORISED') && ap.every((c) => c.body.Invoices[0].Status === 'DRAFT'),
    { ar: ar[0].body.Invoices[0].Status, ap: ap[0].body.Invoices[0].Status });
  check('each side uses its own configured account code',
    ar.every((c) => c.body.Invoices[0].LineItems[0].AccountCode === '260')
    && ap.every((c) => c.body.Invoices[0].LineItems[0].AccountCode === '429'),
    { ar: ar[0].body.Invoices[0].LineItems[0].AccountCode, ap: ap[0].body.Invoices[0].LineItems[0].AccountCode });
  check('both sides of a pair carry the same amount and reference',
    ar[0].body.Invoices[0].LineItems[0].UnitAmount === ap[0].body.Invoices[0].LineItems[0].UnitAmount
    && ar[0].body.Invoices[0].Reference === ap[0].body.Invoices[0].Reference,
    { ar: ar[0].body.Invoices[0].Reference, ap: ap[0].body.Invoices[0].Reference });
  check('the counterparty contact is created where it is missing',
    calls.some((c) => c.path === '/Contacts' && c.method === 'POST'), 'no contact created');

  calls.length = 0;
  const again = await req('POST', `/api/recharge/runs/${runId}/post`, { cookie });
  check('re-posting creates nothing new',
    calls.filter((c) => c.path === '/Invoices').length === 0 && again.body.posted === 2,
    calls.map((c) => c.path));

  const cancelPosted = await req('POST', `/api/recharge/runs/${runId}/cancel`, { cookie });
  check('a posted recharge cannot be cancelled', cancelPosted.status === 409, cancelPosted.body.error);

  console.log('\nA failure on one side leaves an exact record');
  // Recharge the part-paid EPF bill into a second run, failing the AP side.
  await db.execute("UPDATE bills SET xero_status='PAID', amount_due=0, amount_paid=total, fully_paid_on='2026-09-01' WHERE reference='EPF-0826'");
  const epf = (await req('GET', '/api/bills?q=EPF-0826', { cookie })).body.rows[0];
  const run2 = await req('POST', '/api/recharge/runs', {
    cookie, body: { billId: epf.id, targets: [{ tenantId: kk.tenantId, sharePercent: 100 }] }
  });
  failOn = { tenantId: kk.tenantId, type: 'ACCPAY' };
  const partial = await req('POST', `/api/recharge/runs/${run2.body.id}/post`, { cookie });
  check('the failing line is reported', partial.body.failed === 1 && partial.body.posted === 0, partial.body);
  check('the run stays draft so it can be retried', partial.body.status === 'draft', partial.body.status);

  const halfLine = await db.getOne('SELECT ar_invoice_id, ap_invoice_id, line_error FROM recharge_run_lines WHERE run_id = ?', [run2.body.id]);
  check('the AR side that succeeded is remembered', Boolean(halfLine.ar_invoice_id), halfLine);
  check('the AP side is still missing, with the reason', !halfLine.ap_invoice_id && /Account code 429/.test(halfLine.line_error), halfLine.line_error);

  failOn = null;
  calls.length = 0;
  const retry = await req('POST', `/api/recharge/runs/${run2.body.id}/post`, { cookie });
  const retryInvoices = calls.filter((c) => c.path === '/Invoices' && c.method === 'POST');
  check('a retry creates only the missing document',
    retryInvoices.length === 1 && retryInvoices[0].body.Invoices[0].Type === 'ACCPAY',
    retryInvoices.map((c) => c.body.Invoices[0].Type));
  check('and the run is then posted', retry.body.status === 'posted', retry.body.status);

  console.log('\nSettlement');
  const view = await req('GET', '/api/recharge', { cookie });
  const card = view.body.runCards.find((c) => c.id === runId);
  check('an unsettled line offers settlement', card.lines.every((l) => l.canSettle), card.lines);
  const settled = await req('POST', `/api/recharge/runs/${runId}/lines/${card.lines[0].id}/settle`, {
    cookie, body: { reference: 'MBB-FT-20260912-04', settledOn: '2026-09-12' }
  });
  check('a line can be settled', settled.status === 200, settled.body);
  check('the run is not settled until every line is', settled.body.status === 'posted', settled.body.status);
  const settled2 = await req('POST', `/api/recharge/runs/${runId}/lines/${card.lines[1].id}/settle`, {
    cookie, body: { reference: 'MBB-FT-20260912-05' }
  });
  check('settling the last line settles the run', settled2.body.status === 'settled', settled2.body.status);

  console.log('\nRules');
  const rule = await req('POST', '/api/recharge/rules', {
    cookie,
    body: {
      payerTenantId: bill.tenantId, supplierName: 'Tenaga Nasional Berhad',
      matchType: 'reference_contains', matchValue: 'TNB-KK',
      targets: [{ tenantId: kk.tenantId, sharePercent: 100 }]
    }
  });
  check('a rule is created', rule.status === 201 && rule.body.rule.splitLabel === 'Reference contains "TNB-KK"', rule.body.rule);

  const badRule = await req('POST', '/api/recharge/rules', {
    cookie,
    body: { payerTenantId: bill.tenantId, supplierName: 'X', targets: [{ tenantId: kk.tenantId, sharePercent: 70 }] }
  });
  check('a rule whose shares miss 100% is refused', badRule.status === 400 && /70.00%/.test(badRule.body.error), badRule.body.error);

  const noRef = await req('POST', '/api/recharge/rules', {
    cookie,
    body: { payerTenantId: bill.tenantId, supplierName: 'X', matchType: 'reference_contains', targets: [{ tenantId: kk.tenantId }] }
  });
  check('a reference rule needs text to match on', noRef.status === 400, noRef.body.error);

  console.log('\nSuggestions');
  // A paid TNB bill in the payer that matches the rule above.
  await db.execute(
    `INSERT INTO bills (account_id, xero_tenant_id, xero_invoice_id, invoice_number, reference,
       contact_id, contact_name, xero_status, bill_date, due_date, fully_paid_on, currency_code,
       total, amount_paid, amount_due)
     VALUES (1,?,'aaaaaaaa-0000-0000-0000-000000000001','INV-TNB','TNB-KK-0926',
       'c-tnb','Tenaga Nasional Berhad','PAID','2026-09-05','2026-09-25','2026-09-20','MYR',
       4200.00, 4200.00, 0)`,
    [bill.tenantId]
  );
  const sugg = await req('GET', '/api/recharge/suggestions', { cookie });
  const mine = sugg.body.suggestions.find((x) => x.reference === 'TNB-KK-0926');
  check('a paid bill matching a rule is suggested', Boolean(mine), sugg.body.suggestions.map((s) => s.reference));
  check('with the split already worked out',
    mine && mine.lines.length === 1 && mine.lines[0].code === 'ABKK' && mine.lines[0].amountFmt === '4,200.00', mine && mine.lines);

  const runFromRule = await req('POST', '/api/recharge/runs', {
    cookie, body: { billId: mine.billId, ruleId: mine.ruleId, targets: [{ tenantId: kk.tenantId, sharePercent: 100 }] }
  });
  check('a suggestion can be turned into a run', runFromRule.status === 201, runFromRule.body);
  const after = await req('GET', '/api/recharge/suggestions', { cookie });
  check('and then stops being suggested',
    !after.body.suggestions.some((x) => x.reference === 'TNB-KK-0926'), after.body.suggestions.map((s) => s.reference));

  console.log('\nThe view');
  const final = await req('GET', '/api/recharge', { cookie });
  check('stat cards are returned', final.body.rechargeStats.length === 4);
  check('a fully settled run reads as settled',
    final.body.runCards.find((c) => c.id === runId).statusLabel === 'Fully settled');
  check('tabs count runs and rules',
    final.body.rechargeTabs[0].count >= 2 && final.body.rechargeTabs[1].count >= 1, final.body.rechargeTabs);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
