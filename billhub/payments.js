// Building payment batches, rendering their bank files, and recording them in
// Xero as batch payments.
//
// When Xero is written to:
//
//   pay by bank file   create → download → upload to the portal → mark uploaded
//                      Xero is posted at "mark uploaded", because that is when
//                      the money is actually committed. Posting earlier would
//                      show bills as paid while the file still sat on someone's
//                      desktop.
//
//   already paid       create with generateFile: false. The payment has already
//                      happened by some other route, so Xero is posted straight
//                      away and no file is produced.
const xero = require('../lib/xero');
const grantSource = require('../lib/grantSource');
const bills = require('../models/bills');
const batches = require('../models/batches');
const testMode = require('../lib/testMode');
const bankAccounts = require('../models/bankAccounts');
const bankFormats = require('../models/bankFormats');
const payees = require('../models/payees');
const entities = require('../models/entities');
const banks = require('../lib/malaysianBanks');
const accounts = require('../models/accounts');
const { render } = require('../lib/bankFile');

// Xero caps the batch-level reference sent to the bank at 18 characters
// (non-NZ). Longer and the whole batch is rejected.
const DETAILS_MAX = 18;

function err(message, statusCode = 400) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

// ── Sync from Xero ──────────────────────────────────────────────────────────

// Bank accounts an organisation can pay from. Xero requires the account to be
// type BANK, or to have payments enabled.
async function syncBankAccounts(accountId, tenantId) {
  const payload = await xero.api(accountId, tenantId, '/Accounts?where=' + encodeURIComponent('Type=="BANK"'));
  const list = (payload?.Accounts || []).filter((a) => a.Status !== 'ARCHIVED');
  for (const acc of list) await bankAccounts.upsertFromXero(accountId, tenantId, acc);
  return list.length;
}

// Supplier bank details. Only contacts that are actually suppliers matter, so
// the list is filtered to those with payable activity.
async function syncPayees(accountId, tenantId) {
  let page = 1;
  let seen = 0;
  for (; page <= 50; page += 1) {
    const qs = new URLSearchParams({
      where: 'IsSupplier==true',
      page: String(page),
      // Bank details are not in the summary view, so this one needs the full record.
      includeArchived: 'false'
    });
    const payload = await xero.api(accountId, tenantId, `/Contacts?${qs}`);
    const list = payload?.Contacts || [];
    if (!list.length) break;
    for (const c of list) await payees.upsertFromXero(accountId, tenantId, c);
    seen += list.length;
    if (list.length < 100) break;
  }
  return seen;
}

// Both, for every connected organisation.
async function syncAll(accountId, { tenantIds = null } = {}) {
  const wazzocrAccountId = await grantSource.connectionsAccountId(accountId);
  let targets = await entities.listSyncable(accountId, wazzocrAccountId);
  if (tenantIds && tenantIds.length) {
    const want = new Set(tenantIds);
    targets = targets.filter((t) => want.has(t.xero_tenant_id));
  }
  const results = [];
  for (const t of targets) {
    try {
      const banks = await syncBankAccounts(accountId, t.xero_tenant_id);
      const suppliers = await syncPayees(accountId, t.xero_tenant_id);
      results.push({ tenantId: t.xero_tenant_id, name: t.short_name || t.tenant_name, banks, suppliers, ok: true });
    } catch (e) {
      console.error(`[payments] sync ${t.tenant_name || t.xero_tenant_id}: ${e.message}`);
      results.push({ tenantId: t.xero_tenant_id, name: t.short_name || t.tenant_name, ok: false, error: e.message });
    }
  }
  return {
    organisations: results.length,
    banks: results.reduce((n, r) => n + (r.banks || 0), 0),
    suppliers: results.reduce((n, r) => n + (r.suppliers || 0), 0),
    failed: results.filter((r) => !r.ok).length,
    results
  };
}

// A planned line in the shape the renderer reads. The download path gets
// these columns from the database; the preview has only the plan, so without
// this the two disagree — and the preview is the one people trust before
// money moves.
function lineForRender(l) {
  return {
    contact_name: l.contactName,
    payee_account: l.payeeAccount,
    payee_bank: l.payeeBank,
    payee_bank_account_name: l.payeeBankAccountName,
    payee_details: l.payeeDetails,
    payee_code: l.payeeCode,
    payee_email: l.payeeEmail,
    amount: l.amount,
    reference: l.reference
  };
}

// Which rail a line travels on. Ayu Borneo's convention decides it with no
// extra field: an all-digit "Bank account name" on the Xero contact is a
// JomPay biller code, anything else is a bank.
function railOf(line) {
  return banks.isBillerCode(line.payeeBankAccountName) ? 'biller' : 'transfer';
}

// A selection can contain both. They are different files, uploaded to
// different places in the portal, so they are different batches — putting a
// utility into a bank-transfer file produces a line with no bank code and a
// D-prefixed meter number, which is worse than refusing.
function splitByRail(lines) {
  const out = { transfer: [], biller: [] };
  for (const l of lines) out[railOf(l)].push(l);
  return out;
}

// One plan per rail the selection actually contains. A run of only suppliers
// yields one; a run that also has utilities yields two, and they become two
// batches and two files.
async function planRuns(accountId, { billIds, bankAccountId, paymentDate }) {
  const plan = await planBatch(accountId, { billIds, bankAccountId, paymentDate });
  const split = splitByRail(plan.lines);

  const runs = [];
  for (const rail of ['transfer', 'biller']) {
    const lines = split[rail];
    if (!lines.length) continue;

    const format = await formatForRail(accountId, plan.bank, rail);
    const warnings = [];
    if (!format) {
      warnings.push(rail === 'biller'
        ? `${lines.length} bill(s) are paid by JomPay biller code, and ${plan.bank.name} has no JomPay layout set. Choose one on the Bank files tab.`
        : `${plan.bank.name} has no payment file layout set.`);
    }
    // Only the lines on this rail can be missing an account, so recount.
    const withoutAccount = lines.filter((l) => !l.payeeAccount);
    if (withoutAccount.length) {
      warnings.push(`${withoutAccount.length} payee(s) have no ${rail === 'biller' ? 'biller account number' : 'bank account number'}: `
        + `${withoutAccount.slice(0, 5).map((l) => l.contactName).join(', ')}${withoutAccount.length > 5 ? '…' : ''}.`);
    }

    runs.push({
      rail,
      railLabel: rail === 'biller' ? 'JomPay' : 'Bank transfer',
      format,
      lines,
      total: lines.reduce((sum, l) => sum + l.amount, 0),
      warnings,
      missingPayeeAccounts: withoutAccount.map((l) => ({ contactId: l.contactId, contactName: l.contactName }))
    });
  }

  return { bank: plan.bank, currencyCode: plan.currencyCode, paymentDate: plan.paymentDate, runs };
}

// The layout for one rail. Both default to Hong Leong, so a paying account
// needs nothing set before its files are right.
async function formatForRail(accountId, bank, rail) {
  if (rail !== 'biller') return formatFor(accountId, bank);
  return bankFormats.get(accountId, bank.biller_format_key || 'hlb-jompay');
}

// ── Building a batch ────────────────────────────────────────────────────────

// Validates a proposed batch and assembles its lines. Throws with a specific
// message rather than letting Xero reject the whole thing later.
async function planBatch(accountId, { billIds, bankAccountId, paymentDate }) {
  const ids = (Array.isArray(billIds) ? billIds : []).map(Number).filter(Number.isInteger);
  if (!ids.length) throw err('No bills selected.');
  if (ids.length > 500) throw err('A batch can hold at most 500 bills.');

  const bank = await bankAccounts.getById(accountId, Number(bankAccountId));
  if (!bank) throw err('That paying account does not exist.', 404);
  if (!bank.enabled) throw err(`${bank.name} is disabled as a paying account.`);

  const rows = await bills.getManyByIds(accountId, ids);
  const found = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw err(`${missing.length} of the selected bills no longer exist.`, 404);

  // Xero's API will only take a batch inside one organisation.
  const wrongOrg = rows.filter((r) => r.xero_tenant_id !== bank.xero_tenant_id);
  if (wrongOrg.length) {
    throw err(
      `${wrongOrg.length} bill(s) belong to a different Xero organisation from ${bank.name}. `
      + 'A batch payment is paid from one bank account, and a bank account belongs to one organisation, '
      + 'so Xero cannot span them. Pay each organisation in its own run.'
    );
  }

  // …and only in the organisation's base currency.
  const bankCurrency = bank.currency_code || null;
  const wrongCurrency = rows.filter((r) => r.currency_code && bankCurrency && r.currency_code !== bankCurrency);
  if (wrongCurrency.length) {
    throw err(
      `${wrongCurrency.length} bill(s) are not in ${bankCurrency}. `
      + 'Xero only accepts base-currency batch payments through the API; pay those in Xero directly.'
    );
  }

  // Only an approved, still-owing bill can be paid.
  const notPayable = rows.filter((r) => r.xero_status !== 'AUTHORISED' || Number(r.amount_due) <= 0);
  if (notPayable.length) {
    const sample = notPayable[0];
    throw err(
      `${notPayable.length} bill(s) cannot be paid — e.g. "${sample.reference || sample.invoice_number}" is `
      + `${sample.xero_status.toLowerCase()}${Number(sample.amount_due) <= 0 ? ' with nothing outstanding' : ''}. `
      + 'Approve bills first; only approved bills with a balance can go into a payment run.'
    );
  }

  // A bill already sitting in a live batch must not be paid twice.
  const committed = await batches.billsInLiveBatches(accountId, ids);
  if (committed.size) {
    const first = [...committed.entries()][0];
    throw err(
      `${committed.size} bill(s) are already in batch ${first[1].reference} (${first[1].status}). `
      + 'Cancel that batch first if you want to move them.'
    );
  }

  // Payee bank details, copied in now so the file reflects what was approved.
  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))];
  const payeeRows = await payees.listByAccount(accountId, { tenantId: bank.xero_tenant_id });
  const byContact = new Map(payeeRows.map((p) => [p.contact_id, p]));

  const lines = rows.map((r) => {
    const p = byContact.get(r.contact_id);
    return {
      billId: r.id,
      xeroInvoiceId: r.xero_invoice_id,
      contactName: r.contact_name,
      contactId: r.contact_id,
      payeeAccount: p?.account_number || null,
      payeeBank: p?.bank_name || null,
      // Xero's "Financial details" panel: a bank name or a JomPay biller code,
      // the lot reference, and who the bank should send the credit advice to.
      payeeBankAccountName: p?.bank_account_name || null,
      payeeDetails: p?.details || null,
      payeeCode: p?.payee_code || null,
      payeeEmail: p?.email || null,
      amount: Number(r.amount_due),
      reference: (r.reference || r.invoice_number || '').slice(0, 255)
    };
  });

  const withoutAccount = lines.filter((l) => !l.payeeAccount);
  const total = lines.reduce((sum, l) => sum + l.amount, 0);

  return {
    bank,
    lines,
    total,
    currencyCode: bankCurrency,
    paymentDate: paymentDate || new Date().toISOString().slice(0, 10),
    warnings: withoutAccount.length
      ? [`${withoutAccount.length} payee(s) have no bank account number: ${withoutAccount.slice(0, 5).map((l) => l.contactName).join(', ')}${withoutAccount.length > 5 ? '…' : ''}.`]
      : [],
    missingPayeeAccounts: withoutAccount.map((l) => ({ contactId: l.contactId, contactName: l.contactName }))
  };
}

// Resolves the layout for a batch: the bank account's own, else the readable
// generic one so a batch is never blocked by an unconfigured format.
async function formatFor(accountId, bank) {
  // Hong Leong unless an account says otherwise. Ayu Borneo pays from Hong
  // Leong, so making that the default means nothing has to be configured
  // before the first file is right.
  const key = bank.format_key || 'hlb-connectfirst';
  const format = await bankFormats.get(accountId, key);
  if (!format) throw err(`Bank format "${key}" is not defined.`, 404);
  return format;
}

// Creates a batch per rail, so a selection of suppliers and utilities comes
// out as two files rather than one wrong one.
//
// The two options are independent. `generateFile` decides whether a bank file
// is produced; `postNow` decides whether Xero is paid straight away. Marking
// bills paid does both: the payment is recorded the moment the user says the
// money left, and the file is there to take to the portal afterwards. It used
// to be either/or, which forced a choice between a bill that showed the right
// status and a file that could be uploaded.
async function createRuns(accountId, { billIds, bankAccountId, paymentDate, generateFile = true, postNow, reference }) {
  const planned = await planRuns(accountId, { billIds, bankAccountId, paymentDate });
  const created = [];
  for (const run of planned.runs) {
    created.push(await createBatch(accountId, {
      billIds: run.lines.map((l) => l.billId),
      bankAccountId, paymentDate, generateFile, postNow, reference, rail: run.rail
    }));
  }
  return created;
}

async function createBatch(accountId, { billIds, bankAccountId, paymentDate, generateFile = true, postNow, reference, rail }) {
  // Testing mode is checked here as well as in lib/xero.js. The guard there is
  // what makes it safe; this is what makes it usable — otherwise a test run
  // would build the file and then fail on the posting, leaving a batch with an
  // error on it rather than a file to inspect.
  const testing = await testMode.isOn(accountId);
  const pay = testing ? false : (postNow === undefined ? !generateFile : Boolean(postNow));
  const plan = await planBatch(accountId, { billIds, bankAccountId, paymentDate });
  const useRail = rail || railOf(plan.lines[0] || {});
  const format = (generateFile || testing) ? await formatForRail(accountId, plan.bank, useRail) : null;

  const created = await batches.create(accountId, {
    tenantId: plan.bank.xero_tenant_id,
    bankAccountId: plan.bank.id,
    paymentDate: plan.paymentDate,
    currencyCode: plan.currencyCode,
    formatKey: format ? format.format_key : null,
    fileName: null,
    // A test run always leaves a file to look at; there is nothing else it
    // could usefully produce.
    status: (generateFile || testing) ? 'ready' : 'posted',
    testMode: testing,
    lines: plan.lines
  });


  // The file name needs the batch reference, which only exists after the insert.
  if (format) {
    const { buildFileName } = require('../lib/bankFile');
    const fileName = buildFileName(format, { reference: created.reference });
    const db = require('../db');
    await db.execute('UPDATE payment_batches SET file_name = ? WHERE id = ?', [fileName, created.id]);
  }

  // A batch that still has a file to send stays "ready to download" — the
  // payment is in Xero, but nothing has gone to the bank's portal yet.
  let posted = null;
  if (pay) {
    posted = await postToXero(accountId, created.id, {
      reference, status: generateFile ? 'ready' : 'posted'
    });
  }

  return {
    ...created, warnings: plan.warnings,
    format: format ? format.format_key : null, posted, testMode: testing
  };
}

// ── The file ────────────────────────────────────────────────────────────────

async function renderFile(accountId, batchId) {
  const batch = await batches.getById(accountId, batchId);
  if (!batch) throw err('Batch not found.', 404);
  const format = await bankFormats.get(accountId, batch.format_key || batch.bank_format_key || 'hlb-connectfirst');
  if (!format) throw err(`Bank format "${batch.format_key}" is not defined.`, 404);
  const lineRows = await batches.lines(batchId);
  const out = render(format, batch, lineRows);
  return { ...out, batch, format };
}

// ── Posting to Xero ─────────────────────────────────────────────────────────

// Records the batch in Xero as a BatchPayment. Refuses a second attempt when one
// already exists, so a retry after a network wobble can't double-pay.
// One Xero payment per bill, for organisations whose edition has no bill batch
// payments. The outcome is the same — every bill reaches Paid — but Xero shows
// one payment per bill instead of a single batch, which is worth knowing when
// the bank statement shows one lump sum to reconcile against.
//
// Each id is saved the instant Xero returns it. If the tenth of twenty fails,
// the nine that succeeded are recorded as paid and a retry starts at the tenth.
async function payIndividually(accountId, batch, unpaid, details, status, allLines) {
  const paid = [];
  for (const line of unpaid) {
    let out;
    try {
      out = await xero.api(accountId, batch.xero_tenant_id, '/Payments', {
        method: 'POST',
        body: { Payments: [{
          Invoice: { InvoiceID: line.xero_invoice_id },
          Account: { AccountID: batch.xero_account_id },
          Date: batch.payment_date instanceof Date
            ? batch.payment_date.toISOString().slice(0, 10)
            : String(batch.payment_date).slice(0, 10),
          Amount: Number(line.amount),
          // The reference typed on the dialog wins: the field says it shows on
          // the Xero payment, and it is the one thing tying the payments back to
          // the bank transfer. The bill's own reference is the fallback.
          Reference: String(details || line.reference || '').slice(0, DETAILS_MAX)
        }] }
      });
    } catch (e) {
      const message = paid.length
        ? `Paid ${paid.length} of ${unpaid.length} bill(s), then Xero refused ${line.contact_name || line.xero_invoice_id}: ${e.message}. Marking uploaded again will resume from there.`
        : `Xero refused the payment for ${line.contact_name || line.xero_invoice_id}: ${e.message}`;
      await batches.markPostFailed(accountId, batch.id, message);
      throw err(message, e.statusCode || 502);
    }
    const payment = out?.Payments?.[0];
    if (!payment?.PaymentID) {
      const message = `Xero accepted a payment for ${line.contact_name || line.xero_invoice_id} but returned no id.`;
      await batches.markPostFailed(accountId, batch.id, message);
      throw err(message, 502);
    }
    await batches.recordLinePayment(batch.id, line.xero_invoice_id, payment.PaymentID);
    paid.push({ paymentId: payment.PaymentID, xeroInvoiceId: line.xero_invoice_id });
  }

  // No batch id exists in this mode; the line ids above are the record.
  await batches.markPosted(accountId, batch.id, { xeroBatchPaymentId: null, status, payments: [] });
  await applyPaidLocally(accountId, batch, unpaid);

  return {
    method: 'individual',
    payments: paid.length,
    total: Number(batch.total),
    note: `This Xero organisation does not accept bill batch payments, so ${paid.length} individual payment(s) were recorded instead.`
  };
}

// Reflect new balances locally so the Bills list is right immediately rather
// than after the next sync.
async function applyPaidLocally(accountId, batch, lines) {
  const db = require('../db');
  for (const l of lines) {
    await db.execute(
      `UPDATE bills
          SET amount_paid = amount_paid + ?, amount_due = GREATEST(amount_due - ?, 0),
              xero_status = IF(amount_due - ? <= 0, 'PAID', xero_status),
              fully_paid_on = IF(amount_due - ? <= 0, ?, fully_paid_on)
        WHERE account_id = ? AND id = ?`,
      [l.amount, l.amount, l.amount, l.amount, batch.payment_date, accountId, l.bill_id]
    );
  }
}

async function postToXero(accountId, batchId, { reference = null, status = 'uploaded' } = {}) {
  const batch = await batches.getById(accountId, batchId);
  if (!batch) throw err('Batch not found.', 404);
  if (batch.xero_batch_payment_id) {
    throw err(`Batch ${batch.reference} is already recorded in Xero (${batch.xero_batch_payment_id}).`, 409);
  }
  if (batch.status === 'cancelled') throw err(`Batch ${batch.reference} was cancelled.`, 409);

  const lineRows = await batches.lines(batchId);
  if (!lineRows.length) throw err('That batch has no lines.');

  // A batch posted as individual payments has no batch id to check, so its
  // lines carry the record instead. Getting this wrong pays bills twice.
  const unpaid = lineRows.filter((l) => !l.xero_payment_id);
  if (!unpaid.length) {
    throw err(`Every bill in ${batch.reference} is already recorded as paid in Xero.`, 409);
  }

  // Xero truncates or rejects a long Details; do it here so the value we send is
  // the value we stored.
  const details = String(reference || batch.reference || '').slice(0, DETAILS_MAX);

  // Part-way through an individual run: finish the rest rather than retrying
  // the batch, which would pay the ones that already went through again.
  if (unpaid.length < lineRows.length) {
    return payIndividually(accountId, batch, unpaid, details, status, lineRows);
  }

  const body = {
    BatchPayments: [{
      Account: { AccountID: batch.xero_account_id },
      Date: batch.payment_date instanceof Date
        ? batch.payment_date.toISOString().slice(0, 10)
        : String(batch.payment_date).slice(0, 10),
      Details: details,
      Payments: lineRows.map((l) => ({
        Invoice: { InvoiceID: l.xero_invoice_id },
        Amount: Number(l.amount),
        ...(l.payee_account ? { BankAccountNumber: String(l.payee_account).replace(/\D/g, '') } : {}),
        Details: String(l.reference || '').slice(0, DETAILS_MAX)
      }))
    }]
  };

  let payload;
  try {
    payload = await xero.api(accountId, batch.xero_tenant_id, '/BatchPayments', { method: 'POST', body });
  } catch (e) {
    // Xero rejects PAYBATCH on editions that do not carry bill batch payments —
    // GLOBAL among them — with "Batch payment status not valid for update",
    // which reads like a bug in the request rather than a missing feature.
    // Verified against a GLOBAL organisation: the same bill and the same bank
    // account are accepted by POST /Payments moments later.
    // Xero rejects PAYBATCH on editions without bill batch payments — GLOBAL
    // among them — with "Batch payment status not valid for update", which
    // reads like a malformed request rather than a missing feature. Verified
    // against a GLOBAL organisation: the same bill and the same bank account
    // are accepted by POST /Payments moments later. So do that instead.
    if (/status not valid for update/i.test(e.message || '')) {
      console.warn(`[payments] ${batch.reference}: Xero refused a batch payment; paying the ${unpaid.length} bill(s) individually.`);
      return payIndividually(accountId, batch, unpaid, details, status, lineRows);
    }
    await batches.markPostFailed(accountId, batchId, e.message);
    throw e;
  }

  const created = payload?.BatchPayments?.[0];
  if (!created?.BatchPaymentID) {
    const message = 'Xero accepted the request but returned no batch payment id.';
    await batches.markPostFailed(accountId, batchId, message);
    throw err(message, 502);
  }

  await batches.markPosted(accountId, batchId, {
    xeroBatchPaymentId: created.BatchPaymentID,
    status,
    payments: (created.Payments || []).map((p) => ({
      paymentId: p.PaymentID,
      xeroInvoiceId: p.Invoice?.InvoiceID
    }))
  });

  await applyPaidLocally(accountId, batch, lineRows);

  return {
    method: 'batch',
    batchPaymentId: created.BatchPaymentID,
    total: Number(created.TotalAmount || batch.total)
  };
}

// Xero caps an attachment at 25MB; stay well under it, and refuse early rather
// than after uploading most of a batch.
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

// Xero rejects a filename with a path separator or a colon, and the name is
// what makes this idempotent: PUT .../Attachments/<name> REPLACES by name, so
// attaching the same receipt twice cannot leave two copies on a bill.
function receiptFileName(batch, uploadedName, kind = 'bank-receipt') {
  const ext = (String(uploadedName || '').match(/\.[A-Za-z0-9]{1,8}$/) || ['.pdf'])[0].toLowerCase();
  return `${batch.reference}-${kind}${ext}`;
}

// The bank's acknowledgement for a batch, attached to every bill it paid.
//
// One document, many bills: Xero stores attachments per invoice, so the same
// bytes go up once per line. Each is recorded as it lands, so a run that stops
// halfway resumes instead of re-uploading what already arrived.
async function attachReceipt(accountId, batchId, { fileName, contentType, bytes, replace = false, kind = 'bank-receipt' }) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw err('No file was uploaded.');
  if (bytes.length > RECEIPT_MAX_BYTES) {
    throw err(`That file is ${(bytes.length / 1048576).toFixed(1)}MB. Xero will not take more than 10MB.`);
  }

  const batch = await batches.getById(accountId, batchId);
  if (!batch) throw err('Batch not found.', 404);
  if (batch.status === 'cancelled') throw err(`Batch ${batch.reference} was cancelled.`, 409);
  // The receipt only exists once the bank has processed the file.
  if (!['uploaded', 'posted'].includes(batch.status)) {
    throw err(`Batch ${batch.reference} has not been marked uploaded yet, so there is nothing to attach a ${kind === 'payment-slip' ? 'slip' : 'receipt'} to.`, 409);
  }

  const lineRows = await batches.lines(batchId);
  // Replacing is asked for explicitly, from a button that says so. Without that
  // the refusal stands, because the common way to end up here twice is a double
  // click, not a decision.
  const pending = replace ? lineRows : lineRows.filter((l) => !l.receipt_attached);
  if (!pending.length) {
    throw err(`Every bill in ${batch.reference} already has this batch's receipt.`, 409);
  }

  const name = receiptFileName(batch, fileName, kind);
  // Xero replaces an attachment by filename, so the same name overwrites. A
  // different extension is a different name, and Xero's API cannot delete an
  // attachment — so the old one stays, and saying so beats a silent surprise.
  const supersedes = batch.receipt_name && batch.receipt_name !== name ? batch.receipt_name : null;
  const type = contentType && contentType !== 'application/octet-stream' ? contentType : 'application/pdf';

  let attached = 0;
  for (const line of pending) {
    try {
      await xero.api(accountId, batch.xero_tenant_id,
        `/Invoices/${line.xero_invoice_id}/Attachments/${encodeURIComponent(name)}`,
        { method: 'PUT', body: bytes, headers: { 'Content-Type': type } });
    } catch (e) {
      const message = attached
        ? `Attached to ${attached} of ${pending.length} bill(s), then Xero refused ${line.contact_name || line.xero_invoice_id}: ${e.message}. Uploading the same file again will resume.`
        : `Xero refused the attachment: ${e.message}`;
      throw err(message, e.statusCode || 502);
    }
    await batches.markLineReceipted(batchId, line.xero_invoice_id);
    attached += 1;
  }

  await batches.markReceiptAttached(accountId, batchId, name);
  // Bills Hub's own copy of the count, so the Files column is right before the
  // next sync rather than after it.
  const db = require('../db');
  for (const line of pending) {
    await db.execute(
      `UPDATE bills SET has_attachments = 1, attachment_count = COALESCE(attachment_count, 0) + 1
        WHERE account_id = ? AND id = ?`,
      [accountId, line.bill_id]
    );
  }

  return {
    fileName: name,
    attached,
    bills: lineRows.length,
    replaced: Boolean(replace),
    ...(supersedes ? { supersedes, note:
      `The earlier ${supersedes} is still on these bills — Xero's API cannot remove an attachment, only overwrite one of the same name.` } : {})
  };
}

module.exports = {
  syncBankAccounts, syncPayees, syncAll,
  planBatch, planRuns, createBatch, createRuns, formatForRail, renderFile, lineForRender, railOf, splitByRail, postToXero, attachReceipt, receiptFileName, formatFor, DETAILS_MAX, RECEIPT_MAX_BYTES
};
