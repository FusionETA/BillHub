// Bank files: batch validation, file rendering, the download/upload lifecycle,
// and posting to Xero as a BatchPayment. Xero is stubbed at lib/xero.api so the
// request bodies we send are asserted, not assumed.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.AUTH_DISABLED = 'false';

const http = require('http');
const xero = require('../lib/xero');
const db = require('../db');

const xeroCalls = [];
let batchPaymentCounter = 0;
let failNextBatchPayment = null;

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
  check('preview returns a reference, total and file sample',
    preview.status === 200 && preview.body.reference === 'PAY-0001' && preview.body.filePreview.length > 0,
    { ref: preview.body.reference, total: preview.body.total });
  check('preview flags the layout as unverified',
    preview.body.format.verified === false, preview.body.format);
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

  const twice = await req('POST', `/api/payments/batches/${batchId}/uploaded`, { cookie });
  check('a batch cannot be posted to Xero twice',
    twice.status === 409 && /already recorded in Xero/.test(twice.body.error), twice.body.error);

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
  check('both built-ins are listed', formats.body.formats.length === 2, formats.body.formats.map((f) => f.key));
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

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
