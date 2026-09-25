// Payment batches: a set of bills paid together from one bank account.
//
// A batch maps onto a Xero BatchPayment (PAYBATCH), which constrains its shape:
// Xero's API only accepts batches within a single organisation, in that
// organisation's base currency, containing bills and nothing else. Those rules
// are enforced when the batch is built, not discovered when Xero rejects it.
const db = require('../db');

// Statuses a batch can still be worked on from. A cancelled batch releases its
// bills so they can go into another run.
const LIVE_STATUSES = ['ready', 'downloaded', 'uploaded', 'posted'];

function list(accountId, { status = null, tenantId = null, limit = 100 } = {}) {
  const where = ['b.account_id = ?'];
  const params = [accountId];
  if (status && status !== 'all') { where.push('b.status = ?'); params.push(status); }
  if (tenantId) { where.push('b.xero_tenant_id = ?'); params.push(tenantId); }
  return db.query(
    `SELECT b.*, ba.name AS bank_account_name, ba.bank_name, ba.currency_code AS bank_currency,
            e.code AS entity_code, e.short_name AS entity_short
       FROM payment_batches b
       JOIN bank_accounts ba ON ba.id = b.bank_account_id
       LEFT JOIN entities e
         ON e.account_id = b.account_id AND e.xero_tenant_id = b.xero_tenant_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT ?`,
    [...params, Number(limit)]
  );
}

function getById(accountId, id) {
  return db.getOne(
    `SELECT b.*, ba.name AS bank_account_name, ba.bank_name, ba.account_number AS payer_account,
            ba.xero_account_id, ba.currency_code AS bank_currency, ba.format_key AS bank_format_key,
            e.code AS entity_code, e.short_name AS entity_short,
            e.short_name AS payer_name
       FROM payment_batches b
       JOIN bank_accounts ba ON ba.id = b.bank_account_id
       LEFT JOIN entities e
         ON e.account_id = b.account_id AND e.xero_tenant_id = b.xero_tenant_id
      WHERE b.account_id = ? AND b.id = ?`,
    [accountId, id]
  );
}

function lines(batchId) {
  return db.query(
    'SELECT * FROM payment_batch_lines WHERE batch_id = ? ORDER BY id', [batchId]
  );
}

// Bills already committed to a live batch, so they can't be paid twice.
async function billsInLiveBatches(accountId, billIds = []) {
  if (!billIds.length) return new Map();
  const rows = await db.query(
    `SELECT l.bill_id, b.reference, b.status
       FROM payment_batch_lines l
       JOIN payment_batches b ON b.id = l.batch_id
      WHERE b.account_id = ?
        AND b.status IN (${LIVE_STATUSES.map(() => '?').join(',')})
        AND l.bill_id IN (${billIds.map(() => '?').join(',')})`,
    [accountId, ...LIVE_STATUSES, ...billIds]
  );
  return new Map(rows.map((r) => [r.bill_id, { reference: r.reference, status: r.status }]));
}

// PAY-0001, PAY-0002, … Unique per account.
async function nextReference(accountId) {
  const row = await db.getOne(
    `SELECT reference FROM payment_batches
      WHERE account_id = ? AND reference REGEXP '^PAY-[0-9]+$'
      ORDER BY CAST(SUBSTRING(reference, 5) AS UNSIGNED) DESC LIMIT 1`,
    [accountId]
  );
  const last = row ? Number(row.reference.slice(4)) : 0;
  return `PAY-${String(last + 1).padStart(4, '0')}`;
}

// Creates the batch and its lines in one transaction, so a failure part-way
// through can't leave bills attached to a batch that has no total.
async function create(accountId, {
  tenantId, bankAccountId, paymentDate, currencyCode, formatKey, fileName, status = 'ready', lines: lineRows
}) {
  return db.transaction(async (conn) => {
    const reference = await nextReference(accountId);
    const total = lineRows.reduce((sum, l) => sum + Number(l.amount), 0);

    const [res] = await conn.execute(
      `INSERT INTO payment_batches
        (account_id, xero_tenant_id, reference, bank_account_id, payment_date, currency_code,
         total, line_count, status, file_name, format_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [accountId, tenantId, reference, bankAccountId, paymentDate, currencyCode,
       total.toFixed(2), lineRows.length, status, fileName || null, formatKey || null]
    );
    const batchId = res.insertId;

    for (const l of lineRows) {
      await conn.execute(
        `INSERT INTO payment_batch_lines
          (batch_id, bill_id, xero_invoice_id, contact_name, payee_account, payee_bank, amount, reference)
         VALUES (?,?,?,?,?,?,?,?)`,
        [batchId, l.billId, l.xeroInvoiceId, l.contactName || null,
         l.payeeAccount || null, l.payeeBank || null, Number(l.amount).toFixed(2), l.reference || null]
      );
    }
    return { id: batchId, reference, total };
  });
}

async function markDownloaded(accountId, id) {
  const res = await db.execute(
    `UPDATE payment_batches
        SET status = IF(status = 'ready', 'downloaded', status),
            downloaded_at = COALESCE(downloaded_at, NOW())
      WHERE account_id = ? AND id = ? AND status IN ('ready','downloaded')`,
    [accountId, id]
  );
  return res.affectedRows;
}

// Called once Xero has accepted the batch payment. Storing the id is what stops
// a second post: the router refuses when it is already set.
async function markPosted(accountId, id, { xeroBatchPaymentId, payments = [], status = 'uploaded' }) {
  await db.transaction(async (conn) => {
    await conn.execute(
      `UPDATE payment_batches
          SET xero_batch_payment_id = ?, xero_posted_at = NOW(), post_error = NULL,
              status = ?, uploaded_at = COALESCE(uploaded_at, NOW())
        WHERE account_id = ? AND id = ?`,
      [xeroBatchPaymentId, status, accountId, id]
    );
    // Xero returns the payments in the order they were sent.
    for (const p of payments) {
      if (!p.paymentId || !p.xeroInvoiceId) continue;
      await conn.execute(
        'UPDATE payment_batch_lines SET xero_payment_id = ? WHERE batch_id = ? AND xero_invoice_id = ?',
        [p.paymentId, id, p.xeroInvoiceId]
      );
    }
  });
}

// Written per payment rather than in one go at the end, so a run that dies
// halfway leaves an honest record: the bills already paid in Xero are marked
// here too, and a retry can tell them from the ones still owing.
async function recordLinePayment(batchId, xeroInvoiceId, paymentId) {
  await db.execute(
    'UPDATE payment_batch_lines SET xero_payment_id = ? WHERE batch_id = ? AND xero_invoice_id = ?',
    [paymentId, batchId, xeroInvoiceId]
  );
}

async function markPostFailed(accountId, id, message) {
  await db.execute(
    'UPDATE payment_batches SET post_error = ? WHERE account_id = ? AND id = ?',
    [String(message || '').slice(0, 512), accountId, id]
  );
}

// Only a batch that never reached Xero can be cancelled; once a payment exists
// there, reversing it is a Xero operation and not ours to fake.
async function cancel(accountId, id) {
  const res = await db.execute(
    `UPDATE payment_batches SET status = 'cancelled'
      WHERE account_id = ? AND id = ? AND xero_batch_payment_id IS NULL
        AND status IN ('ready','downloaded')`,
    [accountId, id]
  );
  return res.affectedRows;
}

// The four stat cards on the Bank files screen.
async function summary(accountId) {
  const row = await db.getOne(
    `SELECT
       SUM(status = 'ready')                                        AS ready_n,
       SUM(CASE WHEN status = 'ready'      THEN total ELSE 0 END)    AS ready_amt,
       SUM(status = 'downloaded')                                   AS downloaded_n,
       SUM(CASE WHEN status = 'downloaded' THEN total ELSE 0 END)    AS downloaded_amt,
       SUM(status IN ('uploaded','posted'))                         AS uploaded_n,
       SUM(CASE WHEN status IN ('uploaded','posted') THEN total ELSE 0 END) AS uploaded_amt
     FROM payment_batches WHERE account_id = ?`,
    [accountId]
  );
  const n = (v) => Number(v || 0);
  return {
    ready: { count: n(row?.ready_n), amount: n(row?.ready_amt) },
    downloaded: { count: n(row?.downloaded_n), amount: n(row?.downloaded_amt) },
    uploaded: { count: n(row?.uploaded_n), amount: n(row?.uploaded_amt) }
  };
}

module.exports = {
  recordLinePayment,
  list, getById, lines, billsInLiveBatches, nextReference, create,
  markDownloaded, markPosted, markPostFailed, cancel, summary, LIVE_STATUSES
};
