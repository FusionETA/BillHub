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
const bankAccounts = require('../models/bankAccounts');
const bankFormats = require('../models/bankFormats');
const payees = require('../models/payees');
const entities = require('../models/entities');
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
  const key = bank.format_key || 'generic-csv';
  const format = await bankFormats.get(accountId, key);
  if (!format) throw err(`Bank format "${key}" is not defined.`, 404);
  return format;
}

// Creates the batch. `generateFile: false` means the money has already moved,
// so Xero is posted immediately and no file is produced.
async function createBatch(accountId, { billIds, bankAccountId, paymentDate, generateFile = true, reference }) {
  const plan = await planBatch(accountId, { billIds, bankAccountId, paymentDate });
  const format = generateFile ? await formatFor(accountId, plan.bank) : null;

  const created = await batches.create(accountId, {
    tenantId: plan.bank.xero_tenant_id,
    bankAccountId: plan.bank.id,
    paymentDate: plan.paymentDate,
    currencyCode: plan.currencyCode,
    formatKey: format ? format.format_key : null,
    fileName: null,
    status: generateFile ? 'ready' : 'posted',
    lines: plan.lines
  });

  // The file name needs the batch reference, which only exists after the insert.
  if (format) {
    const { buildFileName } = require('../lib/bankFile');
    const fileName = buildFileName(format, { reference: created.reference });
    const db = require('../db');
    await db.execute('UPDATE payment_batches SET file_name = ? WHERE id = ?', [fileName, created.id]);
  }

  let posted = null;
  if (!generateFile) {
    posted = await postToXero(accountId, created.id, { reference, status: 'posted' });
  }

  return { ...created, warnings: plan.warnings, format: format ? format.format_key : null, posted };
}

// ── The file ────────────────────────────────────────────────────────────────

async function renderFile(accountId, batchId) {
  const batch = await batches.getById(accountId, batchId);
  if (!batch) throw err('Batch not found.', 404);
  const format = await bankFormats.get(accountId, batch.format_key || batch.bank_format_key || 'generic-csv');
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
          Reference: String(line.reference || details || '').slice(0, DETAILS_MAX)
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

module.exports = {
  syncBankAccounts, syncPayees, syncAll,
  planBatch, createBatch, renderFile, postToXero, formatFor, DETAILS_MAX
};
