// Bank files: batch validation, file rendering, the download/upload lifecycle,
// and posting to Xero as a BatchPayment. Xero is stubbed at lib/xero.api so the
// request bodies we send are asserted, not assumed.
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

const http = require('http');
const xero = require('../lib/xero');
const db = require('../db');

const xeroCalls = [];
let batchPaymentCounter = 0;
let failNextBatchPayment = null;
let paymentCounter = 0;
const attachments = [];
let failNextAttachment = null;
let failPaymentForInvoice = null;   // fail the single payment for this invoice

// Kept so the testing-mode case can exercise the REAL guard rather than this
// stub, which by definition has no guard in it.
const realXeroApi = xero.api;
xero.api = async (accountId, tenantId, path, opts = {}) => {
  xeroCalls.push({ tenantId, path, method: opts.method || 'GET', body: opts.body });

  if (opts.method === 'POST' && path === '/BatchPayments') {
    if (failNextBatchPayment) {
      const err = new Error(failNextBatchPayment);
      err.statusCode = 400;
      failNextBatchPayment = null;
      throw err;
    }
    batchPaymentCounter += 1;
    const sent = opts.body.BatchPayments[0];
    return {
      BatchPayments: [{
        BatchPaymentID: `bp-${batchPaymentCounter}`.padEnd(36, '0'),
        Status: 'AUTHORISED',
        Type: 'PAYBATCH',
        TotalAmount: sent.Payments.reduce((s, p) => s + p.Amount, 0),
        Payments: sent.Payments.map((p, i) => ({
          PaymentID: `pay-${batchPaymentCounter}-${i}`.padEnd(36, '0'),
          Invoice: { InvoiceID: p.Invoice.InvoiceID },
          Amount: p.Amount
        }))
      }]
    };
  }
  // Individual payments: the fallback used when an organisation's Xero edition
  // has no bill batch payments.
  if (opts.method === 'POST' && path === '/Payments') {
    const sent = opts.body.Payments[0];
    // Target the invoice, not the reference: every line in a batch now carries
    // the same user-typed reference, so that is no longer a way to single one out.
    if (failPaymentForInvoice && sent.Invoice.InvoiceID === failPaymentForInvoice) {
      failPaymentForInvoice = null;
      const err = new Error('Payment amount exceeds the amount outstanding on this invoice.');
      err.statusCode = 400;
      throw err;
    }
    paymentCounter += 1;
    return { Payments: [{
      PaymentID: `single-${paymentCounter}`.padEnd(36, '0'),
      Status: 'AUTHORISED',
      Amount: sent.Amount,
      Invoice: { InvoiceID: sent.Invoice.InvoiceID }
    }] };
  }
  // PUT /Invoices/{id}/Attachments/{name} — raw bytes, not JSON.
  if (opts.method === 'PUT' && /^\/Invoices\/[^/]+\/Attachments\//.test(path)) {
    if (failNextAttachment) { const e = new Error(failNextAttachment); e.statusCode = 400; failNextAttachment = null; throw e; }
    attachments.push({ path, bytes: Buffer.isBuffer(opts.body) ? opts.body.length : null,
                       type: (opts.headers || {})['Content-Type'] });
    return { Attachments: [{ AttachmentID: 'att-'.padEnd(36, '0'), FileName: decodeURIComponent(path.split('/').pop()) }] };
  }
  if (path.startsWith('/Accounts')) {
    return { Accounts: [{ AccountID: 'acct-synced-1', Code: '092', Name: 'HSBC Collections 2201', BankAccountNumber: '220199887766', CurrencyCode: 'MYR', Status: 'ACTIVE', BankAccountType: 'BANK' }] };
  }
  if (path.startsWith('/Contacts')) {
    return { Contacts: [{ ContactID: 'contact-synced-1', Name: 'Newly Synced Supplier', BankAccountDetails: 'CIMB 8899-0011-2233' }] };
  }
  return {};
};

const app = require('../server');
const server = app.listen(3314);

function req(method, path, { body, cookie, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: 3314, path, method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: raw ? out : (out ? JSON.parse(out) : null)
      }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function rawPost(path, buf, { cookie, fileName = 'receipt.pdf', type = 'application/pdf' } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: 3314, path, method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': type, 'X-File-Name': fileName,
                 'Content-Length': buf.length, ...(cookie ? { Cookie: cookie } : {}) }
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => { let b = null; try { b = JSON.parse(out); } catch { b = out; } resolve({ status: res.statusCode, body: b }); });
    });
    r.on('error', reject);
    r.write(buf);
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

  const login = await req('POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'billhub-local-test' } });
  const cookie = (login.headers['set-cookie'] || [])[0].split(';')[0];

  // Payable bills live in tenant-abm: the EPF one (8,000 due, part paid).
  const payable = (await req('GET', '/api/bills?status=payment', { cookie })).body.rows;
  const abmBills = payable.filter((r) => r.tenantId === 'tenant-abm');
  const abmBank = (await req('GET', '/api/payments/bank-accounts?tenantId=tenant-abm', { cookie }))
    .body.bankAccounts.find((b) => b.name.includes('5142'));

  console.log('Setup');
  check('paying accounts came through with their formats', Boolean(abmBank) && abmBank.formatKey === 'maybank-m2e-csv', abmBank);
  check('there is a payable bill to work with', abmBills.length >= 1, abmBills.length);

  console.log('\nValidation');
  const draftBill = (await req('GET', '/api/bills?status=draft', { cookie })).body.rows[0];
  const notApproved = await req('POST', '/api/payments/preview', {
    cookie, body: { billIds: [draftBill.id], bankAccountId: abmBank.id }
  });
  check('an unapproved bill is refused with a reason',
    notApproved.status === 400 && /cannot be paid/.test(notApproved.body.error), notApproved.body.error);

  const otherOrgBill = payable.find((r) => r.tenantId !== 'tenant-abm');
  if (otherOrgBill) {
    const crossOrg = await req('POST', '/api/payments/preview', {
      cookie, body: { billIds: [otherOrgBill.id], bankAccountId: abmBank.id }
    });
    check('a bill from another organisation is refused',
      crossOrg.status === 400 && /different Xero organisation/.test(crossOrg.body.error), crossOrg.body.error);
  }

  const empty = await req('POST', '/api/payments/batches', { cookie, body: { billIds: [], bankAccountId: abmBank.id } });
  check('an empty selection is refused', empty.status === 400, empty.status);

  console.log('\nPreview');
  const preview = await req('POST', '/api/payments/preview', {
    cookie, body: { billIds: abmBills.map((b) => b.id), bankAccountId: abmBank.id, paymentDate: '2026-09-22' }
  });
  // One entry per rail now: these bills are all bank transfers, so there is
  // one file. A selection that also held a utility would come back with two.
  check('preview returns a reference, total and a file per rail',
    preview.status === 200 && preview.body.reference === 'PAY-0001'
    && preview.body.files.length === 1 && preview.body.files[0].filePreview.length > 0,
    { ref: preview.body.reference, files: (preview.body.files || []).map((x) => x.rail) });
  check('the one file is the transfer rail',
    preview.body.files[0].rail === 'transfer', preview.body.files[0].rail);
  check('preview flags the layout as unverified',
    preview.body.files[0].format.verified === false, preview.body.files[0].format);
  check('preview writes nothing',
    (await db.getOne('SELECT COUNT(*) AS n FROM payment_batches')).n === 0);

  console.log('\nCreating a batch');
  const created = await req('POST', '/api/payments/batches', {
    cookie, body: { billIds: abmBills.map((b) => b.id), bankAccountId: abmBank.id, paymentDate: '2026-09-22' }
  });
  check('the batch is created', created.status === 201 && created.body.reference === 'PAY-0001', created.body);
  const batchId = created.body.id;

  const row = await db.getOne('SELECT * FROM payment_batches WHERE id = ?', [batchId]);
  check('it starts as ready, not posted', row.status === 'ready' && row.xero_batch_payment_id === null, row.status);
  check('creating the batch does NOT touch Xero',
    !xeroCalls.some((c) => c.path === '/BatchPayments'), xeroCalls.map((c) => c.path));
  check('the file name uses the reference and bank', row.file_name === 'PAY-0001_Maybank.csv', row.file_name);

  const reused = await req('POST', '/api/payments/batches', {
    cookie, body: { billIds: abmBills.map((b) => b.id), bankAccountId: abmBank.id }
  });
  check('the same bill cannot go into a second live batch',
    reused.status === 400 && /already in batch PAY-0001/.test(reused.body.error), reused.body.error);

  console.log('\nThe file');
  const file = await req('GET', `/api/payments/batches/${batchId}/file`, { cookie, raw: true });
  check('the file downloads as CSV', file.status === 200 && /text\/csv/.test(file.headers['content-type']), file.headers['content-type']);
  check('it is served as an attachment with the right name',
    /filename="PAY-0001_Maybank.csv"/.test(file.headers['content-disposition']), file.headers['content-disposition']);
  const epfLine = file.body.split(/\r?\n/).find((l) => l.includes('8000.00'));
  check('the line carries the payee account, amount and date', Boolean(epfLine) && epfLine.startsWith('94781727'), epfLine);
  check('the maybank starter writes no header row', !file.body.startsWith('PayeeAccount'), file.body.slice(0, 40));

  const afterDownload = await db.getOne('SELECT status, downloaded_at FROM payment_batches WHERE id = ?', [batchId]);
  check('downloading moves it to downloaded', afterDownload.status === 'downloaded' && afterDownload.downloaded_at, afterDownload);

  console.log('\nPosting to Xero');
  const beforeBill = await db.getOne('SELECT amount_due, amount_paid, xero_status FROM bills WHERE id = ?', [abmBills[0].id]);
  const uploaded = await req('POST', `/api/payments/batches/${batchId}/uploaded`, { cookie });
  check('marking uploaded posts the batch', uploaded.status === 200 && uploaded.body.batchPaymentId, uploaded.body);

  const sent = xeroCalls.filter((c) => c.path === '/BatchPayments').pop();
  check('it posts to the right organisation', sent.tenantId === 'tenant-abm', sent.tenantId);
  check('the Account is the Xero bank account id',
    sent.body.BatchPayments[0].Account.AccountID === 'acct-abm-mbb', sent.body.BatchPayments[0].Account);
  check('Details is within Xero\'s 18-character limit',
    sent.body.BatchPayments[0].Details.length <= 18, sent.body.BatchPayments[0].Details);
  check('each payment carries the invoice id, amount and payee account',
    sent.body.BatchPayments[0].Payments.every((p) => p.Invoice.InvoiceID && p.Amount > 0)
    && sent.body.BatchPayments[0].Payments[0].BankAccountNumber === '94781727',
    sent.body.BatchPayments[0].Payments[0]);

  const afterBill = await db.getOne('SELECT amount_due, amount_paid, xero_status, fully_paid_on FROM bills WHERE id = ?', [abmBills[0].id]);
  check('the bill balance is settled locally too',
    Number(afterBill.amount_due) === 0 && Number(afterBill.amount_paid) === Number(beforeBill.amount_paid) + Number(beforeBill.amount_due),
    { before: beforeBill, after: afterBill });
  check('and it shows as paid', afterBill.xero_status === 'PAID' && afterBill.fully_paid_on, afterBill);

  // Marking uploaded again is harmless bookkeeping; what must never happen is a
  // second trip to Xero, so count the calls rather than the status code.
  const postsBefore = xeroCalls.filter((c) => c.method === 'POST' && /Payment/.test(c.path)).length;
  const twice = await req('POST', `/api/payments/batches/${batchId}/uploaded`, { cookie });
  const postsAfter = xeroCalls.filter((c) => c.method === 'POST' && /Payment/.test(c.path)).length;
  check('marking an already-posted batch uploaded does not pay it twice',
    twice.status === 200 && twice.body.alreadyPosted === true && postsAfter === postsBefore,
    { status: twice.status, body: twice.body, postsBefore, postsAfter });

  const cancelPosted = await req('POST', `/api/payments/batches/${batchId}/cancel`, { cookie });
  check('a posted batch cannot be cancelled', cancelPosted.status === 409, cancelPosted.status);

  console.log('\nFailure leaves nothing half-done');
  const kkBills = payable.filter((r) => r.tenantId === 'tenant-abkk');
  const kkBank = (await req('GET', '/api/payments/bank-accounts?tenantId=tenant-abkk', { cookie })).body.bankAccounts[0];
  if (kkBills.length && kkBank) {
    const b2 = await req('POST', '/api/payments/batches', {
      cookie, body: { billIds: kkBills.map((x) => x.id), bankAccountId: kkBank.id }
    });
    await req('GET', `/api/payments/batches/${b2.body.id}/file`, { cookie, raw: true });
    failNextBatchPayment = 'Payment amount exceeds the amount outstanding on this invoice.';
    const rejected = await req('POST', `/api/payments/batches/${b2.body.id}/uploaded`, { cookie });
    check('a Xero rejection is surfaced, not swallowed',
      rejected.status === 400 && /exceeds the amount outstanding/.test(rejected.body.error), rejected.body.error);
    const stillOpen = await db.getOne('SELECT status, xero_batch_payment_id, post_error FROM payment_batches WHERE id = ?', [b2.body.id]);
    check('the batch stays unposted and records why',
      stillOpen.xero_batch_payment_id === null && stillOpen.status === 'downloaded' && stillOpen.post_error,
      stillOpen);
    const billUntouched = await db.getOne('SELECT amount_due FROM bills WHERE id = ?', [kkBills[0].id]);
    check('the bill balance is untouched after a failed post',
      Number(billUntouched.amount_due) === Number(kkBills[0].amountDue), billUntouched);

    // Cancelling releases the bills for another attempt.
    const cancelled = await req('POST', `/api/payments/batches/${b2.body.id}/cancel`, { cookie });
    check('an unposted batch can be cancelled', cancelled.status === 200, cancelled.body);
    const retry = await req('POST', '/api/payments/preview', {
      cookie, body: { billIds: kkBills.map((x) => x.id), bankAccountId: kkBank.id }
    });
    check('cancelling releases its bills', retry.status === 200, retry.body.error);
  }

  console.log('\nPay without a file (already paid elsewhere)');
  const shBills = payable.filter((r) => r.tenantId === 'tenant-absh');
  if (shBills.length) {
    // tenant-absh has no bank account seeded, so this also proves the error.
    const noBank = await req('POST', '/api/payments/batches', {
      cookie, body: { billIds: shBills.map((x) => x.id), bankAccountId: 99999 }
    });
    check('an unknown paying account is a 404', noBank.status === 404, noBank.status);
  }

  console.log('\nFormats');
  const formats = await req('GET', '/api/payments/formats', { cookie });
  // Named rather than counted: adding a bank should not break this, but
  // losing one silently should.
  const keys = formats.body.formats.map((f) => f.key);
  check('every built-in layout is offered',
    ['generic-csv', 'maybank-m2e-csv', 'hlb-connectfirst', 'hlb-jompay'].every((k) => keys.includes(k)), keys);
  check('only the generic one claims to be verified',
    formats.body.formats.filter((f) => f.verified).map((f) => f.key).join() === 'generic-csv',
    formats.body.formats.filter((f) => f.verified).map((f) => f.key));
  check('generic-csv is the verified one',
    formats.body.formats.find((f) => f.key === 'generic-csv').verified === true
    && formats.body.formats.find((f) => f.key === 'maybank-m2e-csv').verified === false);

  const edited = await req('PUT', '/api/payments/formats/maybank-m2e-csv', {
    cookie,
    body: { columns: [{ header: 'Acct', field: 'payeeAccount', transform: 'digits' }, { header: 'Amt', field: 'amount' }] }
  });
  check('an account can override a built-in layout', edited.status === 200 && edited.body.format.builtIn === false, edited.body.format);
  check('editing a layout clears any verified flag', edited.body.format.verified === false, edited.body.format.verified);

  const badCols = await req('PUT', '/api/payments/formats/my-bank', { cookie, body: { columns: [{ header: 'x' }] } });
  check('a column with no field or literal is refused', badCols.status === 400, badCols.body.error);

  console.log('\nPayees');
  const payeeList = await req('GET', '/api/payments/payees?missing=true', { cookie });
  check('payees with no account number are listable',
    payeeList.body.payees.every((p) => !p.hasAccount), payeeList.body.payees.length);
  const fixed = await req('PUT', '/api/payments/payees/tenant-abkk/c12000000000000000000000000000000000'.slice(0, 60), {
    cookie, body: { accountNumber: '7788-9900-1122', bankName: 'RHB' }
  });
  check('a payee account can be corrected by hand', fixed.status === 200, fixed.body);
  check('and the dashes are kept for the layout to decide',
    fixed.body.payee && fixed.body.payee.accountNumber === '7788-9900-1122', fixed.body.payee);
  check('a corrected payee is marked manual', fixed.body.payee.source === 'manual', fixed.body.payee.source);

  console.log('\nSync from Xero');
  const synced = await req('POST', '/api/payments/sync', { cookie });
  check('bank accounts and payees sync per organisation',
    synced.status === 200 && synced.body.banks === 5 && synced.body.suppliers === 5,
    { banks: synced.body.banks, suppliers: synced.body.suppliers });
  const manualAfterSync = await db.getOne(
    "SELECT account_number, source FROM payees WHERE source = 'manual' LIMIT 1"
  );
  check('a re-sync does not overwrite a manual correction',
    manualAfterSync && manualAfterSync.account_number === '7788-9900-1122', manualAfterSync);

  console.log('\nThe view');
  const view = await req('GET', '/api/payments', { cookie });
  check('the bank view returns stat cards and batch cards',
    view.body.bankStats.length === 4 && view.body.batchCards.length >= 1, view.body.bankStats.length);
  const posted = view.body.batchCards.find((c) => c.ref === 'PAY-0001');
  check('a posted batch shows as recorded and cannot be re-uploaded',
    posted.canUpload === false && posted.postedNote, posted);
  check('its lines carry payee, account and amount',
    posted.lines.length >= 1 && posted.lines[0].hasAccount, posted.lines[0]);

  // ── When Xero has no bill batch payments ──────────────────────────────────
  // Verified against a real GLOBAL organisation: POST /BatchPayments is refused
  // with "Batch payment status not valid for update" while POST /Payments for
  // the same bill and bank account is accepted seconds later. Malaysian orgs
  // are GLOBAL, so for this deployment the fallback is the normal path, not the
  // exception — it gets the same scrutiny as the batch path.
  console.log('\nFalling back to individual payments');

  // Two bills in one organisation, forced payable. The resume case needs a
  // second line to still be owing after the first one fails.
  const twoBills = await db.query(
    "SELECT id, reference FROM bills WHERE account_id = 1 AND xero_tenant_id = 'tenant-abm' ORDER BY id LIMIT 2");
  const ids = twoBills.map((r) => r.id);
  // Earlier cases in this suite left these bills sitting in a posted batch, and
  // a bill may only be in one live batch at a time.
  await db.execute("UPDATE payment_batches SET status = 'cancelled' WHERE account_id = 1");
  const repay = () => db.execute(
    `UPDATE bills SET xero_status = 'AUTHORISED', amount_due = 500, amount_paid = 0 WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  await repay();
  const mkBatch = async () => (await req('POST', '/api/payments/batches', { cookie, body: {
    billIds: twoBills.map((r) => r.id), bankAccountId: abmBank.id, paymentDate: '2026-09-25'
  } })).body;

  const b1 = await mkBatch();
  failNextBatchPayment = 'Batch payment status not valid for update';
  xeroCalls.length = 0;
  const fb = await req('POST', '/api/payments/batches/' + b1.id + '/uploaded', { cookie, body: {} });

  check('the refusal is not surfaced as a failure', fb.status === 200, fb.body);
  check('it says it fell back', fb.body.method === 'individual', fb.body);
  check('one Xero payment per bill', fb.body.payments === twoBills.length, fb.body);
  check('and it used /Payments, not /BatchPayments',
    xeroCalls.filter((c) => c.path === '/Payments' && c.method === 'POST').length === twoBills.length,
    xeroCalls.map((c) => c.method + ' ' + c.path));
  check('the note explains why, in words a person can act on',
    /does not accept bill batch payments/.test(fb.body.note || ''), fb.body.note);

  const b1lines = await db.query('SELECT xero_payment_id FROM payment_batch_lines WHERE batch_id = ?', [b1.id]);
  check('every line records the payment that settled it',
    b1lines.every((l) => l.xero_payment_id), b1lines);
  const b1row = await db.getOne('SELECT status, xero_batch_payment_id FROM payment_batches WHERE id = ?', [b1.id]);
  check('the batch is uploaded with no batch-payment id', b1row.status === 'uploaded' && !b1row.xero_batch_payment_id, b1row);
  const paidNow = await db.getOne(
    `SELECT COUNT(*) AS n FROM bills WHERE xero_status = 'PAID' AND id IN (${ids.map(() => '?').join(',')})`, ids);
  check('the bills show as paid without waiting for a sync', Number(paidNow.n) === ids.length, paidNow);

  // The one that must never go wrong.
  // Paid bill by bill, so there is no batch payment id to guard on — only
  // xero_posted_at stands between this and paying every bill a second time.
  const beforeAgain = xeroCalls.filter((c) => c.path === '/Payments' && c.method === 'POST').length;
  const again = await req('POST', '/api/payments/batches/' + b1.id + '/uploaded', { cookie, body: {} });
  const afterAgain = xeroCalls.filter((c) => c.path === '/Payments' && c.method === 'POST').length;
  check('marking it uploaded a second time does not pay it twice',
    again.status === 200 && again.body.alreadyPosted === true && afterAgain === beforeAgain,
    { status: again.status, body: again.body, beforeAgain, afterAgain });
  check('and no further payment was sent',
    xeroCalls.filter((c) => c.path === '/Payments' && c.method === 'POST').length === twoBills.length,
    xeroCalls.filter((c) => c.path === '/Payments').length);

  console.log('\nResuming a run that died halfway');
  // Reset the bills so a second batch is possible.
  await repay();
  await db.execute("UPDATE payment_batches SET status = 'cancelled' WHERE account_id = 1");
  const b2 = await mkBatch();
  failNextBatchPayment = 'Batch payment status not valid for update';
  failPaymentForInvoice = (await db.getOne('SELECT xero_invoice_id FROM bills WHERE id = ?', [ids[1]])).xero_invoice_id;
  xeroCalls.length = 0;
  const partial = await req('POST', '/api/payments/batches/' + b2.id + '/uploaded', { cookie, body: {} });
  check('a mid-run refusal is reported, not swallowed', partial.status >= 400, partial.status);

  const b2lines = await db.query('SELECT xero_invoice_id, xero_payment_id FROM payment_batch_lines WHERE batch_id = ? ORDER BY id', [b2.id]);
  const done = b2lines.filter((l) => l.xero_payment_id).length;
  check('the payments that succeeded are recorded', done >= 1 && done < b2lines.length, b2lines);

  const sentBefore = xeroCalls.filter((c) => c.path === '/Payments' && c.method === 'POST').length;
  const resumed = await req('POST', '/api/payments/batches/' + b2.id + '/uploaded', { cookie, body: {} });
  const sentAfter = xeroCalls.filter((c) => c.path === '/Payments' && c.method === 'POST').length;
  check('retrying finishes the job', resumed.status === 200, resumed.body);
  check('and only pays what was still owing, not the whole batch again',
    sentAfter - sentBefore === b2lines.length - done, { sentBefore, sentAfter, done, total: b2lines.length });
  check('every line is settled now',
    (await db.query('SELECT xero_payment_id FROM payment_batch_lines WHERE batch_id = ?', [b2.id]))
      .every((l) => l.xero_payment_id));

  {
    // ── The bank's acknowledgement, attached to every bill it paid ────────────
    // One document per batch, on each of its bills, so "how was this paid" is
    // answerable from the bill rather than from somebody's inbox.
    console.log('\nAttaching the bank receipt');

    const pdf = Buffer.from('%PDF-1.4 pretend receipt');
    // The cases above left these bills paid and in a posted batch; put them back.
    await db.execute("UPDATE payment_batches SET status = 'cancelled' WHERE account_id = 1");
    await repay();
    const rb = await mkBatch();

    // Nothing to acknowledge until the bank has had the file.
    const early = await rawPost('/api/payments/batches/' + rb.id + '/receipt', pdf, { cookie });
    check('a batch that was never uploaded refuses the receipt', early.status === 409, early.body);

    failNextBatchPayment = 'Batch payment status not valid for update';
    await req('POST', '/api/payments/batches/' + rb.id + '/uploaded', { cookie, body: {} });
    attachments.length = 0;

    const got = await rawPost('/api/payments/batches/' + rb.id + '/receipt', pdf, { cookie });
    const lineCount = (await db.query('SELECT id FROM payment_batch_lines WHERE batch_id = ?', [rb.id])).length;
    check('it attaches once per bill in the batch', got.status === 200 && got.body.attached === lineCount, got.body);
    check('and Xero got the bytes, not a JSON wrapper',
      attachments.length === lineCount && attachments.every((a) => a.bytes === pdf.length), attachments);
    check('with the content type the browser sent',
      attachments.every((a) => a.type === 'application/pdf'), attachments.map((a) => a.type));

    // The name is what makes a second attempt safe: Xero replaces by filename.
    check('the file is named after the batch, so re-attaching cannot duplicate',
      attachments.every((a) => decodeURIComponent(a.path).endsWith(rb.reference + '-bank-receipt.pdf')),
      decodeURIComponent(attachments[0].path));

    const secondAttach = await rawPost('/api/payments/batches/' + rb.id + '/receipt', pdf, { cookie });
    check("attaching the same batch twice is refused", secondAttach.status === 409, secondAttach.body);

    const bills = await db.query(
      `SELECT b.has_attachments, b.attachment_count FROM bills b
         JOIN payment_batch_lines l ON l.bill_id = b.id WHERE l.batch_id = ?`, [rb.id]);
    check('the bills show a file without waiting for a sync',
      bills.every((b) => b.has_attachments === 1 && Number(b.attachment_count) >= 1), bills);

    // Half-done must be resumable, the same as the payments themselves.
    console.log('\nResuming a half-finished attach');
    await db.execute('UPDATE payment_batch_lines SET receipt_attached = 0 WHERE batch_id = ?', [rb.id]);
    await db.execute('UPDATE payment_batches SET receipt_name = NULL, receipt_attached_at = NULL WHERE id = ?', [rb.id]);
    attachments.length = 0;
    failNextAttachment = 'Xero is unavailable';
    const broke = await rawPost('/api/payments/batches/' + rb.id + '/receipt', pdf, { cookie });
    check('a refusal mid-run is reported', broke.status >= 400, broke.status);
    const doneSoFar = (await db.query('SELECT receipt_attached FROM payment_batch_lines WHERE batch_id = ?', [rb.id]))
      .filter((l) => l.receipt_attached).length;
    const sentBefore = attachments.length;
    const resumed = await rawPost('/api/payments/batches/' + rb.id + '/receipt', pdf, { cookie });
    check('and the retry finishes it', resumed.status === 200, resumed.body);
    check('re-uploading only what was still missing',
      attachments.length - sentBefore === lineCount - doneSoFar,
      { sentBefore, now: attachments.length, doneSoFar, lineCount });

    // Replacing. Verified against real Xero: PUT with the same filename
    // overwrites — one attachment per bill, new bytes — so the only thing
    // stopping a second upload should be the lack of an explicit intent.
    console.log('\nReplacing a receipt');
    const revised = Buffer.from('%PDF-1.4 pretend receipt, corrected');

    const blocked = await rawPost('/api/payments/batches/' + rb.id + '/receipt', revised, { cookie });
    check('without asking to replace, it still refuses', blocked.status === 409, blocked.body);

    attachments.length = 0;
    const done = await rawPost('/api/payments/batches/' + rb.id + '/receipt?replace=1', revised, { cookie });
    check('asking to replace goes through', done.status === 200 && done.body.replaced === true, done.body);
    check('and it re-attaches to every bill, not just the pending ones',
      done.body.attached === lineCount && attachments.length === lineCount,
      { attached: done.body.attached, sent: attachments.length, lineCount });
    check('under the same name, which is what makes it a replace not a second copy',
      attachments.every((a) => decodeURIComponent(a.path).endsWith(rb.reference + '-bank-receipt.pdf')),
      decodeURIComponent(attachments[0].path));
    check('carrying the new bytes', attachments.every((a) => a.bytes === revised.length), attachments[0]);

    // A different extension is a different filename, and Xero's API cannot
    // delete an attachment — so the old one survives and we have to say so.
    const png = Buffer.from('\x89PNG pretend scan');
    const other = await rawPost('/api/payments/batches/' + rb.id + '/receipt?replace=1', png,
      { cookie, fileName: 'scan.png', type: 'image/png' });
    check('a different file type is accepted', other.status === 200, other.body);
    check('named for its own type', /-bank-receipt\.png$/.test(other.body.fileName), other.body.fileName);
    check('and it warns that the previous file cannot be removed',
      /cannot remove an attachment/.test(other.body.note || ''), other.body);

    const tooBig = Buffer.alloc(11 * 1024 * 1024, 0x41);
    await db.execute('UPDATE payment_batch_lines SET receipt_attached = 0 WHERE batch_id = ?', [rb.id]);
    const big = await rawPost('/api/payments/batches/' + rb.id + '/receipt', tooBig, { cookie });
    check('an oversized file is refused before anything is uploaded',
      big.status >= 400 && /10MB/.test(JSON.stringify(big.body)), big.body);

  }

  // ── Marking bills paid ────────────────────────────────────────────────────
  // The one action the Bills tab offers. It has to do both halves at once: pay
  // Xero, because the user is telling us the money has left, and leave a file
  // to take to the portal. Doing only one was the old behaviour, and it forced
  // a choice between a bill with the right status and a file you could upload.
  {
    console.log('\nMarking bills paid in one action');
    const two = await db.query(
      "SELECT id FROM bills WHERE account_id = 1 AND xero_tenant_id = 'tenant-abm' ORDER BY id LIMIT 2");
    const billIds = two.map((r) => r.id);
    await db.execute("UPDATE payment_batches SET status = 'cancelled' WHERE account_id = 1");
    await db.execute(
      `UPDATE bills SET xero_status = 'AUTHORISED', amount_due = 300, amount_paid = 0 WHERE id IN (${billIds.map(() => '?').join(',')})`,
      billIds);
    xeroCalls.length = 0;

    const paid = await req('POST', '/api/payments/batches', { cookie, body: {
      billIds, bankAccountId: abmBank.id, paymentDate: '2026-10-01',
      generateFile: true, postNow: true, reference: 'HLB-DN-20261001-01'
    } });
    check('the batch is created', paid.status === 201, paid.body);
    const pb = paid.body.batches[0];

    check('Xero was paid there and then',
      xeroCalls.some((c) => c.method === 'POST' && /Payment/.test(c.path)), xeroCalls.map((c) => c.method + ' ' + c.path));
    const stillDue = await db.getOne(
      `SELECT COUNT(*) AS n FROM bills WHERE xero_status <> 'PAID' AND id IN (${billIds.map(() => '?').join(',')})`, billIds);
    check('the bills are paid, not awaiting payment', Number(stillDue.n) === 0, stillDue);

    const row = await db.getOne('SELECT status, file_name, uploaded_at, xero_posted_at FROM payment_batches WHERE id = ?', [pb.id]);
    check('a file was still generated', Boolean(row.file_name), row.file_name);
    check('and it waits at ready to download, not uploaded',
      row.status === 'ready' && row.uploaded_at === null, row);
    check('while the Xero posting is recorded', Boolean(row.xero_posted_at), row.xero_posted_at);

    // The reference typed on the dialog is the only thing tying these payments
    // back to one bank transfer, so it has to survive whichever path Xero's
    // edition forces us down — Details on a batch, Reference on each payment.
    const batched = xeroCalls.filter((c) => c.path === '/BatchPayments' && c.method === 'POST').pop();
    const single = xeroCalls.filter((c) => c.path === '/Payments' && c.method === 'POST').pop();
    const onXero = batched
      ? batched.body.BatchPayments[0].Details
      : single && single.body.Payments[0].Reference;
    check('the typed reference is on the Xero payment', onXero === 'HLB-DN-20261001-01', onXero);

    const card = (await req('GET', '/api/payments', { cookie })).body.batchCards.find((c) => c.id === pb.id);
    check('the tab shows it as ready to download', card && card.statusLabel === 'Ready to download', card && card.statusLabel);
    check('and says it is already in Xero', Boolean(card && card.postedNote), card && card.postedNote);
    // Cancelling would release bills that are already paid.
    check('a paid batch cannot be cancelled', card && card.canCancel === false, card && card.canCancel);

    await req('GET', `/api/payments/batches/${pb.id}/file`, { cookie, raw: true });
    const before = xeroCalls.filter((c) => c.method === 'POST' && /Payment/.test(c.path)).length;
    const up = await req('POST', `/api/payments/batches/${pb.id}/uploaded`, { cookie });
    const after = xeroCalls.filter((c) => c.method === 'POST' && /Payment/.test(c.path)).length;
    check('marking it uploaded is bookkeeping only, with no second payment',
      up.status === 200 && up.body.alreadyPosted === true && after === before,
      { body: up.body, before, after });
    const done = await db.getOne('SELECT status, uploaded_at FROM payment_batches WHERE id = ?', [pb.id]);
    check('and it lands at uploaded', done.status === 'uploaded' && done.uploaded_at, done);
  }

  // ── Testing mode ──────────────────────────────────────────────────────────
  // The claim is narrow and absolute: reads work, the bank file is real, and
  // nothing at all reaches Xero. Each half is worth a test, because a switch
  // that is only mostly off is worse than none — it would be trusted.
  {
    console.log('\nTesting mode');
    const testMode = require('../lib/testMode');
    const two = await db.query(
      "SELECT id FROM bills WHERE account_id = 1 AND xero_tenant_id = 'tenant-abm' ORDER BY id LIMIT 2");
    const billIds = two.map((r) => r.id);
    await db.execute("UPDATE payment_batches SET status = 'cancelled' WHERE account_id = 1");
    await db.execute(
      `UPDATE bills SET xero_status = 'AUTHORISED', amount_due = 250, amount_paid = 0 WHERE id IN (${billIds.map(() => '?').join(',')})`,
      billIds);

    await testMode.set(1, true);
    xeroCalls.length = 0;

    const prev = await req('POST', '/api/payments/preview', { cookie, body: {
      billIds, bankAccountId: abmBank.id, paymentDate: '2026-10-02' } });
    check('the preview tells the dialog the mode is on', prev.body.testMode === true, prev.body.testMode);

    const made = await req('POST', '/api/payments/batches', { cookie, body: {
      billIds, bankAccountId: abmBank.id, paymentDate: '2026-10-02',
      generateFile: true, postNow: true, reference: 'TEST-RUN-1' } });
    check('a pay run still goes through', made.status === 201, made.body);
    const tb = made.body.batches[0];

    check('but NOTHING was written to Xero',
      !xeroCalls.some((c) => c.method !== 'GET'), xeroCalls.map((c) => c.method + ' ' + c.path));
    const stillOwing = await db.getOne(
      `SELECT COUNT(*) AS n FROM bills WHERE xero_status = 'AUTHORISED' AND id IN (${billIds.map(() => '?').join(',')})`, billIds);
    check('the bills are untouched, still awaiting payment', Number(stillOwing.n) === billIds.length, stillOwing);

    const trow = await db.getOne('SELECT status, test_mode, file_name, xero_posted_at FROM payment_batches WHERE id = ?', [tb.id]);
    check('the batch is marked as a test', Number(trow.test_mode) === 1, trow.test_mode);
    check('with nothing posted', trow.xero_posted_at === null, trow.xero_posted_at);
    check('and a real file to look at', Boolean(trow.file_name), trow.file_name);

    const dl = await req('GET', `/api/payments/batches/${tb.id}/file`, { cookie, raw: true });
    check('which downloads', dl.status === 200, dl.status);

    // The point of not reserving them: the layout gets checked by running the
    // same bills over and over.
    const again2 = await req('POST', '/api/payments/batches', { cookie, body: {
      billIds, bankAccountId: abmBank.id, paymentDate: '2026-10-02', generateFile: true, postNow: true } });
    check('the same bills can be run again', again2.status === 201, again2.body);

    const card = (await req('GET', '/api/payments', { cookie })).body.batchCards.find((c) => c.id === tb.id);
    check('the card says so', card && card.testMode === true && /testing mode/i.test(card.postedNote || ''), card && card.postedNote);

    // Marking uploaded is the other door into postToXero.
    await req('GET', `/api/payments/batches/${tb.id}/file`, { cookie, raw: true });
    const up = await req('POST', `/api/payments/batches/${tb.id}/uploaded`, { cookie });
    check('marking a test batch uploaded posts nothing',
      up.status === 200 && up.body.testMode === true && !xeroCalls.some((c) => c.method !== 'GET'), up.body);

    // The guard that matters is not the pay flow being polite — it is
    // lib/xero.js refusing whatever it is handed. Call it straight, with a
    // write no part of this app would otherwise make.
    // Not the stub above — the real lib/xero.js, which is where the refusal
    // has to live for the switch to be worth anything. It throws before it
    // reaches a token or the network, so this makes no request.
    let refused = null;
    try {
      await realXeroApi(1, 'tenant-abm', '/Invoices', { method: 'POST', body: { Invoices: [] } });
    } catch (e) { refused = e; }
    check('any Xero write at all is refused at the one chokepoint',
      refused && refused.testMode === true, refused && refused.message);
    check('the refusal names the call, so the log says what was stopped',
      refused && /POST \/Invoices/.test(refused.message), refused && refused.message);
    check('and still nothing but GETs reached Xero',
      !xeroCalls.some((c) => c.method !== 'GET'), xeroCalls.map((c) => c.method + ' ' + c.path));

    // Reads are the whole reason this mode is useful, so prove the guard lets
    // one through rather than inferring it from the file having been built.
    let readBlocked = false;
    try {
      await realXeroApi(1, 'tenant-abm', '/Organisation', { retries: 0 });
    } catch (e) { readBlocked = Boolean(e.testMode); }
    check('a read is not refused by the guard', readBlocked === false);

    const onView = (await req('GET', '/api/payments', { cookie })).body;

    await testMode.set(1, false);
    const off = await req('POST', '/api/payments/preview', { cookie, body: {
      billIds, bankAccountId: abmBank.id, paymentDate: '2026-10-02' } });
    check('turning it off takes effect at once', off.body.testMode === false, off.body.testMode);

    // A test batch paid nothing and will never go to a bank. Left in the list
    // once the switch is off, it looks exactly like a file someone still has
    // to upload.
    const offView = (await req('GET', '/api/payments', { cookie })).body;
    check('test batches are listed while testing is on',
      onView.batchCards.some((c) => c.testMode), onView.batchCards.length);
    check('and gone once it is off',
      offView.batchCards.every((c) => !c.testMode)
      && offView.batchCards.length < onView.batchCards.length,
      { on: onView.batchCards.length, off: offView.batchCards.length });
    // Stats that disagree with the list are worse than either on its own.
    // `again2` above is still sitting at ready, so that card has to move.
    const ready = (v) => v.bankStats.find((x) => x.label === 'Ready to download').sub;
    check('the stat cards count the same batches the list shows',
      ready(offView) !== ready(onView), { on: ready(onView), off: ready(offView) });
    check('the real batches are still there', offView.batchCards.length > 0, offView.batchCards.length);
  }

  // ── Choosing a layout ─────────────────────────────────────────────────────
  // biller_format_key was in the schema and read by the renderer, and nothing
  // could write it. A deployment hit the consequence: no layout set, so every
  // file came out of the generic fallback, in a shape no bank accepts.
  {
    console.log('\nSetting a paying account\'s layout');
    const before = (await req('GET', '/api/payments/bank-accounts?all=true', { cookie })).body.bankAccounts[0];
    check('the row reports both rails', 'formatKey' in before && 'billerFormatKey' in before, Object.keys(before));

    const set = await req('PATCH', `/api/payments/bank-accounts/${before.id}`,
      { cookie, body: { formatKey: 'hlb-connectfirst', billerFormatKey: 'hlb-jompay' } });
    check('both can be set in one call',
      set.status === 200 && set.body.bankAccount.formatKey === 'hlb-connectfirst'
      && set.body.bankAccount.billerFormatKey === 'hlb-jompay', set.body.bankAccount);

    const stored = await db.getOne('SELECT format_key, biller_format_key FROM bank_accounts WHERE id = ?', [before.id]);
    check('and they reach the database', stored.biller_format_key === 'hlb-jompay', stored);

    // Clearing matters too: an account that never pays JomPay should be able
    // to say so, rather than silently inheriting a layout.
    const cleared = await req('PATCH', `/api/payments/bank-accounts/${before.id}`,
      { cookie, body: { billerFormatKey: null } });
    check('a rail can be cleared', cleared.body.bankAccount.billerFormatKey === null, cleared.body.bankAccount);

    await req('PATCH', `/api/payments/bank-accounts/${before.id}`,
      { cookie, body: { formatKey: before.formatKey, billerFormatKey: before.billerFormatKey } });
  }

  // ── Correcting a payee's bank ─────────────────────────────────────────────
  // Xero's field is called "Bank account name" and a great many of Ayu
  // Borneo's contacts use it for just that: the name on the account, a
  // premises code, two banks with a slash. None names a bank, so the
  // beneficiary bank code comes out blank and the line is rejected.
  // payees.bank_name exists for the correction and was being shadowed by the
  // Xero value, so setting it did nothing.
  {
    console.log('\nCorrecting a payee whose Xero field is not a bank');
    const { render } = require('../lib/bankFile');
    const fmt = { format_key: 't', delimiter: ',', extension: 'csv', include_header: 0,
                  payment_mode: 'DUITNW', columns: [{ header: 'c', field: 'payeeBankCode' }] };
    const batch = { reference: 'X', payment_date: '2026-10-02', currency_code: 'MYR', total: 1, line_count: 1 };
    const codeOf = (line) => render(fmt, batch, [line]).text.trim();

    check('a hand-set bank wins over a holder name in Xero',
      codeOf({ contact_name: 'A', payee_account: '1',
               payee_bank_account_name: 'Analin Binti Abdusali', payee_bank: 'Public Bank Berhad' }) === 'PBBB');
    check('Xero still works on its own',
      codeOf({ contact_name: 'B', payee_account: '1', payee_bank_account_name: 'Public Bank Berhad' }) === 'PBBB');
    // The correction may only ever select a published code, never invent one.
    check('an unusable correction does not break a good Xero value',
      codeOf({ contact_name: 'E', payee_account: '1',
               payee_bank_account_name: 'Maybank', payee_bank: 'Not A Bank' }) === 'MBBB');
    check('neither resolving still leaves it blank',
      codeOf({ contact_name: 'C', payee_account: '1',
               payee_bank_account_name: 'PBB / MBB', payee_bank: 'Also Not A Bank' }) === '');
    // A biller code is the rail signal and must not acquire a bank code.
    check('a JomPay biller code stays blank even with a bank set',
      codeOf({ contact_name: 'D', payee_account: '1',
               payee_bank_account_name: '5454', payee_bank: 'Maybank' }) === '');
    check('and it is still routed to the JomPay rail',
      require('../billhub/payments').railOf({ payeeBankAccountName: '5454' }) === 'biller');
  }

  // ── Ref-2 ─────────────────────────────────────────────────────────────────
  // Hong Leong's portal refused a real upload with "Line 2 : Reference 2 field
  // must not exceed 20 characters". The column was capped at 30, and a plain
  // truncation would have taken the period off the end — the one part saying
  // which month's bill this is, while keeping premises that Ref-1 already
  // identifies.
  {
    console.log('\nThe JomPay narrative fits what the portal accepts');
    const bf = require('../lib/bankFile');
    const jom = { format_key: 'hlb-jompay', delimiter: ',', extension: 'csv', include_header: 0,
                  payment_mode: 'DUITNW',
                  columns: [{ header: 'Ref-2', field: 'otherDetails', transform: 'safe', maxLength: 20 }] };
    const ref2 = (entity, details, code) => bf.render(jom,
      { reference: 'X', payment_date: '2026-10-02', currency_code: 'MYR', total: 1, line_count: 1, entity_code: entity },
      [{ contact_name: 'C', payee_account: '1', payee_bank_account_name: '5454',
         payee_details: details, payee_code: code, amount: 1 }]).text.trim();

    const long = ref2('MA', 'Shop 49, 49-1, 49-2', null);
    check('a long premises is brought within 20', long.length <= 20, { value: long, length: long.length });
    check('and the period survives it', /1026$/.test(long), long);

    const live = ref2('BM', '69', 'TNB');
    check('a narrative that already fits is untouched', live === 'BM 69 TNB 1026', live);

    const both = ref2('DCGLOBAL', 'BM 69', 'IWK');
    check('entity and supplier abbreviation are kept over the premises',
      both.length <= 20 && /^DCGLOBAL/.test(both) && /IWK 1026$/.test(both), both);

    check('nothing to trim still works', ref2('MA', null, null) === 'MA 1026');

    // ConnectFirst's own cap is per mode and far wider on DuitNow; it must not
    // have been dragged down to 20 with it.
    const cf = require('../lib/bankFile');
    const wide = { format_key: 'hlb-connectfirst', delimiter: ',', extension: 'csv', include_header: 0,
                   payment_mode: 'DUITNW',
                   columns: [{ header: 'Other Payment Details', field: 'otherDetails', transform: 'trim',
                               maxLengthByMode: { FT: 20, IBG: 20, RENTAS: 20, DUITNW: 140 } }] };
    const dn = cf.render(wide,
      { reference: 'X', payment_date: '2026-10-02', currency_code: 'MYR', total: 1, line_count: 1, entity_code: 'MA' },
      [{ contact_name: 'C', payee_account: '1', payee_bank_account_name: 'Maybank',
         payee_details: 'Shop 49, 49-1, 49-2', payee_code: 'GE', amount: 1 }]).text.trim();
    check('DuitNow keeps the full narrative', dn === 'MA Shop 49, 49-1, 49-2 GE 1026', dn);
  }

  // ── Ref-2 ─────────────────────────────────────────────────────────────────
  // The narrative Ayu Borneo's own JomPay file uses: branch, premises,
  // utility, period. "BM 69 TNB 0826". The period is the BILL's — four
  // monthly bills settled in one run share a payment date, so using that
  // would leave four identical lines, which is what the client spotted.
  {
    console.log('\nRef-2 reproduces their own JomPay narrative');
    const bf = require('../lib/bankFile');
    const jom = { format_key: 'hlb-jompay', delimiter: '|', extension: 'csv', include_header: 0,
                  payment_mode: 'DUITNW',
                  columns: [{ header: 'Biller', field: 'billerCode', transform: 'digits' },
                            { header: 'Ref-1', field: 'payeeAccount' },
                            { header: 'Ref-2', field: 'otherDetails', transform: 'ref', maxLength: 20 },
                            { header: 'Amount', field: 'amount' }] };
    const mk = (details, code, amt, billDate) => ({ contact_name: 'Utility',
      payee_bank_account_name: '5454', payee_account: '210478569003',
      payee_details: details, payee_code: code, amount: amt, bill_date: billDate });
    const run = (entity, lines) => bf.render(jom,
      { reference: 'X', payment_date: '2026-10-02', currency_code: 'MYR', total: 1,
        line_count: lines.length, entity_code: entity }, lines);
    const ref2 = (entity, line) => run(entity, [line]).text.trim().split('|')[2];

    check('it reproduces a line from their live file',
      ref2('BM', mk('69', 'TNB', 1648.60, '2026-08-10')) === 'BM 69 TNB 0826');
    check('including the hyphenated premises',
      ref2('BM', mk('16-13A', 'AIS', 6.50, '2026-07-10')) === 'BM 16-13A AIS 0726');

    // The period is the bill's, not the run's. Both of these are paid in
    // October; only the bill date separates them.
    const months = run('BM', [mk('69', 'TNB', 1, '2026-07-10'), mk('69', 'TNB', 1, '2026-08-10')]);
    const refs = months.text.trim().split(/\r?\n/).map((l) => l.split('|')[2]);
    check('two months of the same bill stay distinct', new Set(refs).size === 2, refs);
    check('each dated from its own bill', refs.join(',') === 'BM 69 TNB 0726,BM 69 TNB 0826', refs);
    check('so neither is reported as a duplicate',
      !months.warnings.some((w) => /identical/.test(w)), months.warnings);

    // Still reported when lines really are alike in every respect.
    const same = run('BM', [mk('69', 'TNB', 1, '2026-08-10'), mk('69', 'TNB', 1, '2026-08-10')]);
    check('genuinely identical lines are still reported',
      same.warnings.some((w) => /Lines 1, 2/.test(w)), same.warnings);

    // Over 20 characters, the period is what survives: four characters of
    // month identify nothing alone, and Ref-1 already says which premises.
    const long = ref2('ABMA', mk('MA Shop 49, 49-1, 49-2', null, 184.15, '2026-09-18'));
    check('a long premises is brought within 20', long.length <= 20, { value: long, length: long.length });
    check('and the period survives it', /0926$/.test(long), long);

    // Cutting mid-token turned "MA 49 49-1 49-2" into "MA 49 4", which does
    // not read as a shortened premises — it reads as a different one, and the
    // stray digit is the first thing anyone asks about.
    const clipped = ref2('ABMA', mk('MA 49 49-1 49-2', 'ID', 1, '2026-08-19'));
    check('a trimmed premises breaks on a word, not mid-token',
      clipped === 'ABMA MA 49 ID 0826', clipped);
    check('a single word too long to break is still cut',
      ref2('ABMA', mk('Averyverylongsinglewordpremises', 'ID', 1, '2026-08-19')).length <= 20);

    check('a bill with no date falls back to the payment period',
      /1026$/.test(ref2('BM', mk('69', 'TNB', 1, null))));

    // The abbreviation is a name mapping, not a payee field — Xero drops its
    // Code on write and writing it to the payee row would freeze that row
    // against the next sync of the fields being corrected in Xero.
    const codes = require('../lib/payeeCodes');
    check('a utility abbreviation resolves from the contact name',
      codes.codeFor('Tenaga Nasional Berhad - MA 75-02') === 'TNB');
    check('through every variant of that name',
      codes.codeFor('Syarikat Bekalan Air Selangor Sd') === 'AIS'
      && codes.codeFor('Air Selangor Sdn Bhd') === 'AIS');
    check('and a supplier with no entry resolves to nothing, not a guess',
      codes.codeFor('Celcom Mobile Sdn Bhd - JS 17-1') === null);
    check('so its narrative simply leaves that part out',
      ref2('MA', mk('49', codes.codeFor('Celcom Mobile Sdn Bhd'), 1, '2026-09-18')) === 'MA 49 0926');
    check('while one with an entry carries it',
      ref2('MA', mk('49', codes.codeFor('Indah Water Konsortium Sdn Bhd-MA Shop 49'), 1, '2026-09-18')) === 'MA 49 ID 0926');
  }

  // ── Shipped layouts track the code ────────────────────────────────────────
  // seedBuiltIns used to skip any layout already in the table, so a layout was
  // frozen at whatever it looked like when that database first saw it. Every
  // correction since reached new databases and no existing one, in silence.
  // Hong Leong refused a file over a 20-character limit; the limit was changed
  // to 20; the next file was still built to 30.
  {
    console.log('\nA changed layout reaches a database that already has it');
    const bankFormats = require('../models/bankFormats');
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

    // Put it back the way the deployment had it, then re-seed.
    await db.execute(
      "UPDATE bank_formats SET columns = ?, name = ? WHERE account_id IS NULL AND format_key = 'hlb-jompay'",
      [JSON.stringify([{ header: 'Ref-2', field: 'otherDetails', transform: 'safe', maxLength: 30 }]), 'Stale name']
    );
    await bankFormats.seedBuiltIns();

    const row = await db.getOne(
      "SELECT name, columns FROM bank_formats WHERE account_id IS NULL AND format_key = 'hlb-jompay'");
    const ref2 = parse(row.columns).find((c) => c.header === 'Ref-2');
    check('the stale column definition is replaced', ref2 && ref2.maxLength === 20, ref2);
    check('and so is the rest of the row', row.name !== 'Stale name', row.name);

    // A layout the customer has adjusted is their data and must survive it.
    await bankFormats.upsertForAccount(1, 'hlb-jompay', { name: 'Ours, edited' });
    await bankFormats.seedBuiltIns();
    const mine = await db.getOne(
      "SELECT name FROM bank_formats WHERE account_id = 1 AND format_key = 'hlb-jompay'");
    check('an account\'s own layout is left alone', mine && mine.name === 'Ours, edited', mine);
    await db.execute("DELETE FROM bank_formats WHERE account_id = 1 AND format_key = 'hlb-jompay'");

    // The insert path, which only runs on a database that does not already
    // have the layout — so every test here took the update path instead, and
    // an INSERT listing seventeen columns against sixteen values went to a
    // deployment before anything noticed.
    await db.execute("DELETE FROM bank_formats WHERE account_id IS NULL AND format_key = 'cimb-bulk'");
    await bankFormats.seedBuiltIns();
    const reborn = await bankFormats.get(1, 'cimb-bulk');
    check('a layout missing from the database is inserted, not just updated',
      Boolean(reborn), 'cimb-bulk did not come back');
    check('with every column it was given',
      reborn && reborn.template_sheet === 'Bulk Payments - Without Email'
      && Number(reborn.template_header_rows) === 3,
      reborn && { sheet: reborn.template_sheet, hdr: reborn.template_header_rows });
  }

  // ── CIMB ──────────────────────────────────────────────────────────────────
  // A second bank, and almost nothing about it matches the first: two-digit
  // BNM codes instead of four-character ones, the paying account repeated on
  // every JomPAY row, three header rows, 30 characters of Ref-2 rather than
  // 20, and hyphens forbidden where Hong Leong accepts them.
  {
    console.log('\nCIMB');
    const banks = require('../lib/malaysianBanks');
    const bf = require('../lib/bankFile');
    const bankFormats = require('../models/bankFormats');
    await bankFormats.seedBuiltIns();

    check('BNM codes are a different scheme, not shorter ones',
      banks.bankCode('CIMB Bank Berhad', 'bnm') === '35'
      && banks.bankCode('CIMB Bank Berhad', 'duitnow') === 'CIMB');
    check('and Maybank resolves despite CIMB calling it Malayan Banking',
      banks.bankCode('Maybank', 'bnm') === '27');
    // The same trap as AMB: a parent's code is not its subsidiary's.
    check('an investment bank is not collapsed onto its parent',
      banks.bankCode('Alliance Investment Bank', 'bnm') === null);
    check('a bank CIMB does not list resolves to nothing',
      banks.bankCode('Bank of Narnia', 'bnm') === null);

    const bulk = await bankFormats.get(1, 'cimb-bulk');
    const jom = await bankFormats.get(1, 'cimb-jompay');
    check('both layouts are shipped', Boolean(bulk && jom));
    check('and expect three header rows',
      Number(bulk.template_header_rows) === 3 && Number(jom.template_header_rows) === 3,
      { bulk: bulk.template_header_rows, jompay: jom.template_header_rows });

    const batch = { reference: 'PAY-X', payment_date: '2026-10-06', currency_code: 'MYR',
                    total: 1, line_count: 1, entity_code: 'MA', payer_account: '8010072820' };
    const row = (fmt, line) => bf.render(fmt, batch, [line]).text.trim().split(/\r?\n/)[1].split(',')
      .map((v) => v.replace(/^"|"$/g, ''));

    const t = row(bulk, { contact_name: 'Sinaran Office Supplies Sdn Bhd', payee_account: '514027718842',
                          payee_bank_account_name: 'Maybank', payee_code: 'SOS',
                          reference: 'SOS-26-1041', amount: 3280, bill_date: '2026-09-18' });
    // The whole dropdown entry, not the two digits its column rule describes:
    // the rule is about what BizConverter writes into the .txt, and their own
    // filled sheets carry the label.
    check('the transfer row carries the full BNM dropdown entry',
      t[2] === '27-Malayan Banking Berhad', t);
    check('and strips the hyphen CIMB forbids', t[5] === 'SOS 26 1041', t[5]);

    // The same seven columns plus six that drive the advice email.
    const mail = await bankFormats.get(1, 'cimb-bulk-email');
    check('the with-email layout is shipped with thirteen columns',
      mail && JSON.parse(typeof mail.columns === 'string' ? mail.columns : JSON.stringify(mail.columns)).length === 13,
      mail && mail.columns.length);
    const m = row(mail, { contact_name: 'Sinaran Office Supplies Sdn Bhd', payee_account: '514027718842',
                          payee_bank_account_name: 'Maybank', payee_code: 'SOS', payee_email: 'ar@sinaran.example.com',
                          reference: 'SOS-26-1041', amount: 3280, bill_date: '2026-09-18' });
    check('it carries the payee email', m[6] === 'ar@sinaran.example.com', m[6]);
    check('and the bill date in the day/month/year the column names', m[10] === '18/09/2026', m[10]);
    check('and repeats the reference as the detail number', m[9] === m[5], [m[5], m[9]]);
    check('and the amount as the detail amount', m[12] === m[4], [m[4], m[12]]);

    // Not selected by default any more — Ayu Borneo pay JomPay from Hong
    // Leong — but still correct, and still reachable via biller_format_key.
    const j = row(jom, { contact_name: 'Indah Water', payee_bank_account_name: '7011',
                         payee_account: '880142300561', payee_details: 'BM 69',
                         payee_code: 'IWK', amount: 128.90, bill_date: '2026-09-18' });
    check('the JomPAY row repeats the paying account, which Hong Leong does not',
      j[1] === '8010072820', j);
    check('and dates Ref-2 from the bill', /0926$/.test(j[3]), j[3]);

    // The layout follows the bank, with nothing configured.
    const pay = require('../billhub/payments');
    const abm = (await req('GET', '/api/payments/bank-accounts?all=true', { cookie })).body.bankAccounts[0];
    await db.execute("UPDATE bank_accounts SET bank_name = 'CIMB Bank Berhad', format_key = NULL, biller_format_key = NULL WHERE id = ?", [abm.id]);
    const cimbBank = await require('../models/bankAccounts').getById(1, abm.id);
    // The advice sheet is preferred; planRuns steps down to the plain one when
    // a payee has no email, which is tested on its own further down.
    check('a CIMB paying account picks a CIMB layout without being told',
      (await pay.formatForRail(1, cimbBank, 'transfer')).format_key === 'cimb-bulk-email');
    // Ayu Borneo pay suppliers from CIMB and every JomPay bill from Hong
    // Leong, so a utility routed to CIMB would make a file nobody uploads.
    check('and does NOT take JomPay, because that is not what the account is for',
      (await pay.formatForRail(1, cimbBank, 'biller')) === null);
    check('which the code can state rather than infer', pay.doesBiller(cimbBank) === false);

    const bills = await db.query(
      "SELECT id FROM bills WHERE account_id = 1 AND xero_tenant_id = ? LIMIT 20", [cimbBank.xero_tenant_id]);
    const mixed = await pay.planRuns(1, { billIds: bills.map((b) => b.id),
      bankAccountId: cimbBank.id, paymentDate: '2026-10-06' }).catch(() => null);
    if (mixed) {
      const biller = mixed.runs.find((r) => r.rail === 'biller');
      if (biller) {
        check('and says where those bills should go instead',
          biller.warnings.some((w) => /does not pay JomPay/.test(w) && /Hong Leong/.test(w)),
          biller.warnings);
      }
    }

    await db.execute("UPDATE bank_accounts SET bank_name = 'Hong Leong Bank' WHERE id = ?", [abm.id]);
    const hlbBank = await require('../models/bankAccounts').getById(1, abm.id);
    check('and a Hong Leong one still picks Hong Leong',
      (await pay.formatForRail(1, hlbBank, 'transfer')).format_key === 'hlb-connectfirst');
    check('and still takes JomPay',
      (await pay.formatForRail(1, hlbBank, 'biller')).format_key === 'hlb-jompay');
  }

  // ── The template is the bank's own form ───────────────────────────────────
  // The client's standard for this was "don't change a single thing inside",
  // and they were right to set it there: a filled sheet that does not look
  // like the blank one is a sheet somebody has to check before trusting.
  {
    console.log('\nCIMB templates reproduce the form, not an approximation of it');
    const { readZip, inflate, fillTemplate } = require('../lib/xlsx');
    const fs = require('fs');
    const path = require('path');
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'templates', 'cimb-bulk.xlsx'));

    const out = fillTemplate(tpl, [
      ['Lembah Jaya Hardware Sdn Bhd', 'LJH', '27-Malayan Banking Berhad', '512088143077', 2140, 'LJH 26 0912', 'MA 12 LJH 0926']
    ], { headerRows: 3 });
    const sheet = inflate(readZip(out).find((z) => /sheet1/.test(z.name))).toString('utf8');
    const styles = inflate(readZip(out).find((z) => z.name === 'xl/styles.xml')).toString('utf8');

    const rowOf = (n) => (sheet.match(new RegExp('<row[^>]*r="' + n + '"[\\s\\S]*?</row>')) || [''])[0];
    check('row 1 stays hidden, as it is in their workbook', / r="1"[^>]*hidden="1"/.test(sheet), rowOf(1).slice(0, 60));
    check('and the header rows keep their heights',
      /r="3"[^>]*ht="28.5"/.test(sheet), rowOf(3).slice(0, 50));

    // Grey header, red on the mandatory columns, black on the optional.
    const fonts = (styles.match(/<fonts[\s\S]*?<\/fonts>/) || [''])[0];
    const fills = (styles.match(/<fills[\s\S]*?<\/fills>/) || [''])[0];
    check('their grey is carried through', /FF969696/.test(fills), fills.slice(0, 120));
    check('and their red', /FFFF0000/.test(fonts), fonts.slice(0, 120));

    // Every written cell is styled, or the filled rows look foreign.
    const data = rowOf(4);
    const cells = (data.match(/<c r="[A-Z]+4"/g) || []).length;
    const styled = (data.match(/<c r="[A-Z]+4" s="\d+"/g) || []).length;
    check('every data cell carries the bank\'s own column style', cells > 0 && cells === styled, { cells, styled });

    // Text format on the account column is what stops Excel rewriting a long
    // account number as 3.45679E+11 when somebody opens and saves the file.
    const sIdx = (data.match(/<c r="D4" s="(\d+)"/) || [])[1];
    const xfs = [...styles.split('<cellXfs')[1].matchAll(/<xf ([^>]*?)(?:\/>|>)/g)].map((m) => m[1]);
    check('the account column is formatted as text', /numFmtId="49"/.test(xfs[Number(sIdx)] || ''), xfs[Number(sIdx)]);

    // The prototype row defines the styling and must not survive as data.
    const values = [...data.matchAll(/<t[^>]*>([^<]*)</g)].map((m) => m[1]);
    check('the prototype row is consumed, not left in the file',
      values[0] === 'Lembah Jaya Hardware Sdn Bhd', values);
    check('and nothing is written past the rows given', rowOf(5) === '', rowOf(5));
  }

  // ── Filling one sheet of the bank's own workbook ──────────────────────────
  // BizConverter is not an upload format, it is an application that reads a
  // whole workbook: CompanyInfo is compulsory, the biller lists are looked up,
  // and eighteen sheets have to be there. Handing it a one-sheet file was
  // wrong — what it wants back is its own workbook with the payments in it.
  {
    console.log('\nFilling one sheet and leaving the rest alone');
    const { readZip, writeZip, fillTemplate, sheetPathByName, inflate } = require('../lib/xlsx');

    // A stand-in for BizConverter: several named sheets, a shared string
    // table, and a macro part — the things that have to survive.
    const sheetXml = (rows) =>
      Buffer.from('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + '<sheetData>' + rows + '</sheetData></worksheet>');
    const names = ['Introduction', 'CompanyInfo', 'Bulk Payments - With Email',
                   'Bulk Payments - Without Email', 'BNM Code'];
    const entries = [
      { name: 'xl/workbook.xml', data: Buffer.from('<?xml version="1.0"?><workbook><sheets>'
          + names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
          + '</sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<?xml version="1.0"?><Relationships>'
          + names.map((n, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
          + '</Relationships>') },
      { name: 'xl/sharedStrings.xml', data: Buffer.from('<sst><si><t>shared</t></si></sst>') },
      { name: 'xl/vbaProject.bin', data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]) },
      { name: 'xl/calcChain.xml', data: Buffer.from('<calcChain><c r="A1"/></calcChain>') }
    ];
    names.forEach((n, i) => entries.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: sheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>${n} header</t></is></c></row>`)
    }));
    const book = writeZip(entries);

    check('a sheet is found by name, not by file order',
      sheetPathByName(readZip(book), 'Bulk Payments - Without Email') === 'xl/worksheets/sheet4.xml',
      sheetPathByName(readZip(book), 'Bulk Payments - Without Email'));

    const filled = fillTemplate(book, [['Lembah Jaya', 'LJH', '27-Malayan Banking Berhad']],
      { sheetName: 'Bulk Payments - Without Email', headerRows: 1 });
    const after = readZip(filled);
    const byName = Object.fromEntries(after.map((e) => [e.name, inflate(e)]));
    const before = Object.fromEntries(readZip(book).map((e) => [e.name, inflate(e)]));

    const target = 'xl/worksheets/sheet4.xml';
    const others = Object.keys(before).filter((n) => n !== target && n !== 'xl/calcChain.xml');
    const changed = others.filter((n) => !byName[n] || !byName[n].equals(before[n]));
    check('every other part is byte for byte identical', changed.length === 0, changed);
    check('including the other sheets', byName['xl/worksheets/sheet2.xml'].equals(before['xl/worksheets/sheet2.xml']));
    check('the shared string table', byName['xl/sharedStrings.xml'].equals(before['xl/sharedStrings.xml']));
    check('and the macros', byName['xl/vbaProject.bin'].equals(before['xl/vbaProject.bin']));

    check('the named sheet has the records', /Lembah Jaya/.test(byName[target].toString('utf8')));
    check('and keeps its own header row',
      /Bulk Payments - Without Email header/.test(byName[target].toString('utf8')));
    check('a sheet in the same workbook is untouched',
      !/Lembah Jaya/.test(byName['xl/worksheets/sheet3.xml'].toString('utf8')));

    // A stale calcChain against changed cells makes Excel call the file corrupt.
    check('the stale calcChain is dropped', !byName['xl/calcChain.xml']);

    let err = null;
    try { fillTemplate(book, [['x']], { sheetName: 'No Such Sheet', headerRows: 1 }); }
    catch (e) { err = e; }
    check('a missing sheet name is refused by name', err && /No Such Sheet/.test(err.message), err && err.message);
  }

  // ── Warnings name the right bank ──────────────────────────────────────────
  // A run paid from CIMB reported that a payee's bank was "not a bank Hong
  // Leong lists", which sends whoever reads it to check the wrong list.
  {
    console.log('\nWarnings name the bank that was actually consulted');
    const bf = require('../lib/bankFile');
    const fmt = (bank) => ({ format_key: 'x', bank_name: bank, delimiter: ',', extension: 'csv',
                             include_header: 0, columns: [{ header: 'c', field: 'payeeBankCode' }] });
    const warn = (bank, value) => bf.render(fmt(bank),
      { reference: 'X', payment_date: '2026-10-07', currency_code: 'MYR', total: 1, line_count: 1 },
      [{ contact_name: 'C', payee_account: '1', payee_bank_account_name: value, amount: 1 }]).warnings.join(' ');

    check('a CIMB run says CIMB', /does not name a bank CIMB Bank Berhad lists/.test(warn('CIMB Bank Berhad', 'Bank of Narnia')),
      warn('CIMB Bank Berhad', 'Bank of Narnia'));
    check('and a Hong Leong run says Hong Leong',
      /does not name a bank Hong Leong Bank lists/.test(warn('Hong Leong Bank', 'Bank of Narnia')));

    // A SWIFT code is wrong in a different way from a name nobody recognises:
    // it identifies the bank exactly, so it is a question rather than a gap.
    // A BIC names exactly one institution, so a confirmed one resolves and
    // an unconfirmed one warns — it does not fall back to a near match.
    const banks2 = require('../lib/malaysianBanks');
    check('a confirmed BIC resolves in both schemes',
      banks2.bankCode('PBBEMYKL', 'bnm') === '33' && banks2.bankCode('PBBEMYKL', 'duitnow') === 'PBBB');
    check('including one carrying a branch', banks2.bankCode('PBBEMYKLXXX', 'bnm') === '33');
    check('an unconfirmed BIC resolves to nothing rather than something close',
      banks2.fromBic('ABCDMYKL') === null && banks2.bankCode('ABCDMYKL', 'bnm') === null);
    check('and a bank name is not mistaken for a BIC', banks2.fromBic('Public Bank Berhad') === null);
    check('an unmapped SWIFT code is still called one',
      /SWIFT\/BIC code/.test(warn('CIMB Bank Berhad', 'ABCDMYKL')),
      warn('CIMB Bank Berhad', 'ABCDMYKL'));
    check('and a bank name is not mistaken for one',
      !/SWIFT/.test(warn('CIMB Bank Berhad', 'Bank of Narnia')));
    // Eight or eleven characters with MY in the country position; "MAYBANK" is
    // seven letters and must not trip it.
    check('nor is something merely short and upper case',
      !/SWIFT/.test(warn('CIMB Bank Berhad', 'MAYBANK')));

    // The dialog used to append "the bank will reject them" to every warning,
    // including one about a missing template, which it does not.
    const planner = require('../billhub/payments');
    check('the missing-account warning carries its own consequence',
      /will reject them/.test(warn('CIMB Bank Berhad', 'Bank of Narnia')) === false,
      'the bank-code warning should not claim rejection wording it does not own');
  }

  // ── A download must be what its name says ─────────────────────────────────
  // The batch is named when it is created, from the layout — ".xlsm", because
  // CIMB's layout fills their macro workbook. What comes out when that
  // workbook is not on the server is the .xlsx fallback sheet. Serving one
  // under the other's name is precisely what Excel refuses to open, and it
  // did: "the file format or file extension is not valid".
  {
    console.log('\nA download is named for what was produced');
    const bankFormats = require('../models/bankFormats');
    const bf = require('../lib/bankFile');
    await bankFormats.seedBuiltIns();
    const fmt = await bankFormats.get(1, 'cimb-bulk');
    check('the layout asks for the macro workbook', /\.xlsm$/.test(fmt.template), fmt.template);

    const out = bf.render(fmt,
      { reference: 'PAY-NAME', payment_date: '2026-10-07', currency_code: 'MYR', total: 1, line_count: 1, entity_code: 'MA' },
      [{ contact_name: 'A Supplier Sdn Bhd', payee_account: '512088143077',
         payee_bank_account_name: 'Maybank', amount: 1, bill_date: '2026-09-24' }]);

    const fs = require('fs');
    const path = require('path');
    const have = fs.existsSync(path.join(__dirname, '..', 'templates', 'local', 'CIMB BizConverter.xlsm'));
    if (have) {
      check('with the workbook present it is .xlsm', /\.xlsm$/.test(out.fileName), out.fileName);
    } else {
      check('without it the name falls back to .xlsx too, not just the content',
        /\.xlsx$/.test(out.fileName), out.fileName);
      check('and it says why', out.warnings.some((w) => /BizConverter/.test(w)), out.warnings);
    }
    check('something was still produced either way', Boolean(out.buffer), out.fileName);
  }

  // ── The advice sheet, when it is possible ─────────────────────────────────
  // The client prefers the sheet that emails the payee an advice. Its email
  // column is mandatory and 87% of their payees have no address, so making it
  // the default outright would mostly produce lines CIMB refuses.
  {
    console.log('\nPreferring the advice sheet without insisting on it');
    const bf = require('../lib/bankFile');
    const bankFormats = require('../models/bankFormats');
    const pay = require('../billhub/payments');
    await bankFormats.seedBuiltIns();

    check('a CIMB account asks for the advice sheet first',
      (await pay.formatForRail(1, { name: 'CIMB Bank 123', bank_name: 'CIMB Bank Berhad' }, 'transfer'))
        .format_key === 'cimb-bulk-email');

    // The entity code leads Hong Leong's narrative by their own convention and
    // says nothing on a CIMB statement read against one entity.
    const batch = { reference: 'X', payment_date: '2026-10-07', currency_code: 'MYR',
                    total: 1, line_count: 1, entity_code: 'ABSETIAALAM' };
    const line = { contact_name: 'Cwc Eng Plt', payee_account: '3208379420',
                   payee_bank_account_name: 'PBBEMYKL', payee_details: 'Aud',
                   payee_email: 'ar@cwc.example.com', reference: 'IV-06472', amount: 1,
                   bill_date: '2026-04-26' };
    const cols = (key, fmt) => bf.render(fmt, batch, [line]).text.trim().split(/\r?\n/)[1]
      .split(',').map((v) => v.replace(/^"|"$/g, ''));

    const plain = await bankFormats.get(1, 'cimb-bulk');
    check('the CIMB description drops the entity code',
      cols('cimb-bulk', plain)[6] === 'Aud 0426', cols('cimb-bulk', plain)[6]);
    const mail = await bankFormats.get(1, 'cimb-bulk-email');
    const m = cols('cimb-bulk-email', mail);
    check('on the advice sheet too, in both description columns',
      m[8] === 'Aud 0426' && m[11] === 'Aud 0426', { short: m[8], long: m[11] });

    // Hong Leong keeps it: "BM 69 TNB 0826" is their own file's convention.
    const hlb = await bankFormats.get(1, 'hlb-connectfirst');
    const h = bf.render(hlb, { ...batch, entity_code: 'BM' },
      [{ ...line, payee_details: '69', payee_code: 'TNB' }]).text.trim().split(/\r?\n/)[1].split(',');
    check('Hong Leong still leads with the entity', /BM 69 TNB 0426/.test(h.join(' ')), h.join(' ').slice(0, 90));

    // A mandatory column left empty is a line the bank refuses.
    const noEmail = bf.render(mail, batch, [{ ...line, payee_email: null }]);
    check('a missing mandatory field is reported by name',
      noEmail.warnings.some((w) => /Beneficiary Email Address is required and empty/.test(w)),
      noEmail.warnings);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
