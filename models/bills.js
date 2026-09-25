// Bills: the local mirror of Xero ACCPAY invoices, plus the queries the Bills
// list and its stat cards run against it.
const db = require('../db');
const { CONNECTIONS } = require('../lib/grantSource');

// Xero's status vocabulary mapped to the four tabs the UI shows. AUTHORISED
// splits on whether anything is still owed, because Xero leaves a part-paid
// bill AUTHORISED and only flips it to PAID once amount_due hits zero.
const UI_STATUS_SQL = `
  CASE
    WHEN b.xero_status = 'DRAFT'     THEN 'draft'
    WHEN b.xero_status = 'SUBMITTED' THEN 'approval'
    WHEN b.xero_status = 'PAID'      THEN 'paid'
    WHEN b.xero_status = 'AUTHORISED' AND b.amount_due <= 0 THEN 'paid'
    WHEN b.xero_status = 'AUTHORISED' THEN 'payment'
    ELSE 'other'
  END`;

// Bills that are visible in the hub at all. VOIDED and DELETED stay in the table
// (so a re-sync doesn't resurrect them) but never appear in a list or a total.
const LIVE = "b.xero_status IN ('DRAFT','SUBMITTED','AUTHORISED','PAID')";

// Build the shared WHERE clause + params from the UI's filter set.
function buildWhere(accountId, f = {}) {
  const where = ['b.account_id = ?', LIVE];
  const params = [accountId];

  if (f.tenantIds && f.tenantIds.length) {
    where.push(`b.xero_tenant_id IN (${f.tenantIds.map(() => '?').join(',')})`);
    params.push(...f.tenantIds);
  }
  if (f.status && f.status !== 'all') {
    where.push(`${UI_STATUS_SQL} = ?`);
    params.push(f.status);
  }
  if (f.contact) {
    // One name or several. Kept as separate values rather than a joined string
    // because supplier names contain commas often enough to matter.
    const names = (Array.isArray(f.contact) ? f.contact : [f.contact]).filter(Boolean);
    if (names.length === 1) {
      where.push('b.contact_name = ?');
      params.push(names[0]);
    } else if (names.length > 1) {
      where.push(`b.contact_name IN (${names.map(() => '?').join(',')})`);
      params.push(...names);
    }
  }
  // Free-text box: matches a reference, an invoice number, a supplier, or an
  // exact amount, because the UI offers one field for all four.
  if (f.search) {
    const q = String(f.search).trim();
    const like = `%${q}%`;
    const amount = Number(q.replace(/,/g, ''));
    if (Number.isFinite(amount) && /^[\d,.]+$/.test(q)) {
      where.push('(b.reference LIKE ? OR b.invoice_number LIKE ? OR b.contact_name LIKE ? OR b.total = ? OR b.amount_due = ?)');
      params.push(like, like, like, amount, amount);
    } else {
      where.push('(b.reference LIKE ? OR b.invoice_number LIKE ? OR b.contact_name LIKE ?)');
      params.push(like, like, like);
    }
  }
  if (f.amountFrom != null && f.amountFrom !== '') { where.push('b.total >= ?'); params.push(Number(f.amountFrom)); }
  if (f.amountTo   != null && f.amountTo   !== '') { where.push('b.total <= ?'); params.push(Number(f.amountTo)); }

  // dateType picks which column the range applies to.
  const col = { bill: 'b.bill_date', due: 'b.due_date', paid: 'b.fully_paid_on' }[f.dateType] || null;
  if (col && f.dateFrom) { where.push(`${col} >= ?`); params.push(f.dateFrom); }
  if (col && f.dateTo)   { where.push(`${col} <= ?`); params.push(f.dateTo); }
  // "Any date" range: match if either the bill date or the due date falls inside.
  if (!col && (f.dateFrom || f.dateTo)) {
    if (f.dateFrom) { where.push('(b.bill_date >= ? OR b.due_date >= ?)'); params.push(f.dateFrom, f.dateFrom); }
    if (f.dateTo)   { where.push('(b.bill_date <= ? OR b.due_date <= ?)'); params.push(f.dateTo, f.dateTo); }
  }

  return { sql: where.join(' AND '), params };
}

// What the table may be sorted by. A whitelist rather than interpolation:
// the value arrives from a query string, and ORDER BY cannot be parameterised.
//
// Status sorts by where a bill is in its life rather than alphabetically —
// "approval, draft, paid, payment" is the wrong answer to "sort by status".
const SORTS = {
  entity: 'e.code',
  contact: 'b.contact_name',
  status: "CASE ui_status WHEN 'draft' THEN 1 WHEN 'approval' THEN 2 WHEN 'payment' THEN 3 WHEN 'paid' THEN 4 ELSE 5 END",
  reference: 'b.reference',
  date: 'b.bill_date',
  dueDate: 'b.due_date',
  paid: 'b.amount_paid',
  outstanding: 'b.amount_due',
  files: 'b.attachment_count'
};

function orderBy(sort, dir) {
  const col = SORTS[sort] || SORTS.date;
  const way = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // b.id last, always: two bills with the same date must come back in the same
  // order every time, or paging quietly repeats and skips rows.
  return `${col} ${way}, b.id DESC`;
}

// One page of bills, newest bill date first, decorated with entity code/name.
async function list(accountId, wazzocrAccountId, filters = {}, { limit = 100, offset = 0, sort = 'date', dir = 'desc' } = {}) {
  const { sql, params } = buildWhere(accountId, filters);
  const rows = await db.query(
    `SELECT b.*, ${UI_STATUS_SQL} AS ui_status,
            e.code AS entity_code, e.short_name AS entity_short, c.tenant_name
       FROM bills b
       LEFT JOIN entities e
         ON e.account_id = b.account_id AND e.xero_tenant_id = b.xero_tenant_id
       LEFT JOIN ${CONNECTIONS} c
         ON c.account_id = ? AND c.xero_tenant_id = b.xero_tenant_id
      WHERE ${sql}
      ORDER BY ${orderBy(sort, dir)}
      LIMIT ? OFFSET ?`,
    [wazzocrAccountId, ...params, Number(limit), Number(offset)]
  );
  return rows;
}

// Row count + outstanding total for the "28 items · RM … outstanding" line.
async function listMeta(accountId, filters = {}) {
  const { sql, params } = buildWhere(accountId, filters);
  const row = await db.getOne(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(b.amount_due), 0) AS outstanding,
            COUNT(DISTINCT b.xero_tenant_id) AS entities
       FROM bills b WHERE ${sql}`,
    params
  );
  return {
    count: Number(row?.n || 0),
    outstanding: Number(row?.outstanding || 0),
    entities: Number(row?.entities || 0)
  };
}

// Counts per tab. Ignores the status filter (a tab must show its own count even
// while another tab is selected) but honours every other filter.
async function tabCounts(accountId, filters = {}) {
  const { sql, params } = buildWhere(accountId, { ...filters, status: 'all' });
  const rows = await db.query(
    `SELECT ${UI_STATUS_SQL} AS ui_status, COUNT(*) AS n
       FROM bills b WHERE ${sql} GROUP BY ui_status`,
    params
  );
  const out = { all: 0, draft: 0, approval: 0, payment: 0, paid: 0 };
  for (const r of rows) {
    if (r.ui_status in out) out[r.ui_status] = Number(r.n);
    out.all += Number(r.n);
  }
  return out;
}

// The four stat cards. Overdue is a slice of "awaiting payment", not a fifth
// status, so it is counted separately rather than in the CASE above.
async function stats(accountId, filters = {}) {
  const { sql, params } = buildWhere(accountId, { ...filters, status: 'all' });
  const row = await db.getOne(
    `SELECT
       SUM(${UI_STATUS_SQL} = 'draft')                       AS draft_n,
       SUM(CASE WHEN ${UI_STATUS_SQL} = 'draft'    THEN b.amount_due ELSE 0 END) AS draft_amt,
       COUNT(DISTINCT CASE WHEN ${UI_STATUS_SQL} = 'draft' THEN b.xero_tenant_id END) AS draft_entities,
       SUM(${UI_STATUS_SQL} = 'approval')                    AS approval_n,
       SUM(CASE WHEN ${UI_STATUS_SQL} = 'approval' THEN b.amount_due ELSE 0 END) AS approval_amt,
       SUM(${UI_STATUS_SQL} = 'payment')                     AS payment_n,
       SUM(CASE WHEN ${UI_STATUS_SQL} = 'payment'  THEN b.amount_due ELSE 0 END) AS payment_amt,
       SUM(${UI_STATUS_SQL} = 'payment' AND b.due_date < CURDATE()) AS overdue_n,
       SUM(CASE WHEN ${UI_STATUS_SQL} = 'payment' AND b.due_date < CURDATE() THEN b.amount_due ELSE 0 END) AS overdue_amt
     FROM bills b WHERE ${sql}`,
    params
  );
  const n = (v) => Number(v || 0);
  return {
    draft:    { count: n(row?.draft_n),    amount: n(row?.draft_amt), entities: n(row?.draft_entities) },
    approval: { count: n(row?.approval_n), amount: n(row?.approval_amt) },
    payment:  { count: n(row?.payment_n),  amount: n(row?.payment_amt) },
    overdue:  { count: n(row?.overdue_n),  amount: n(row?.overdue_amt) }
  };
}

// Distinct suppliers, for the Contact filter.
function contacts(accountId) {
  return db.query(
    `SELECT contact_name AS name, COUNT(*) AS n
       FROM bills b
      WHERE b.account_id = ? AND ${LIVE} AND b.contact_name IS NOT NULL AND b.contact_name <> ''
      GROUP BY contact_name ORDER BY contact_name`,
    [accountId]
  );
}

function getById(accountId, id) {
  return db.getOne(
    `SELECT b.*, ${UI_STATUS_SQL} AS ui_status FROM bills b WHERE b.account_id = ? AND b.id = ?`,
    [accountId, id]
  );
}

// Look up several bills by id, scoped to the account (used by bulk actions).
async function getManyByIds(accountId, ids = []) {
  if (!ids.length) return [];
  return db.query(
    `SELECT b.*, ${UI_STATUS_SQL} AS ui_status
       FROM bills b
      WHERE b.account_id = ? AND b.id IN (${ids.map(() => '?').join(',')})`,
    [accountId, ...ids]
  );
}

// Insert or refresh one bill from a Xero Invoice payload.
// Widths of the VARCHAR columns that take free text straight from Xero. A
// value longer than its column does not fail one row in MySQL — it aborts the
// whole statement, and with it whatever the caller was part-way through. Xero's
// documented maxima are not reliable (Reference is documented as 255 and comes
// back longer), so cut to fit rather than trusting the source.
const WIDTHS = { invoice_number: 255, reference: 500, contact_name: 255, currency_code: 8, xero_status: 16 };

function fit(value, column) {
  if (value == null) return null;
  const s = String(value);
  const max = WIDTHS[column];
  return max && s.length > max ? s.slice(0, max) : s;
}

async function upsertFromXero(accountId, tenantId, inv, { isInterco = false, attachmentCount = null } = {}) {
  const num = (v) => (v == null || v === '' ? 0 : Number(v));
  // Xero dates arrive as "/Date(1693526400000+0000)/" on some endpoints and as
  // "2026-09-04T00:00:00" on others; normalise both to a plain DATE.
  const date = (v) => {
    if (!v) return null;
    const ms = /\/Date\((-?\d+)/.exec(v);
    const d = ms ? new Date(Number(ms[1])) : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };
  const datetime = (v) => {
    if (!v) return null;
    const ms = /\/Date\((-?\d+)/.exec(v);
    const d = ms ? new Date(Number(ms[1])) : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
  };

  await db.execute(
    `INSERT INTO bills (
       account_id, xero_tenant_id, xero_invoice_id, invoice_number, reference,
       contact_id, contact_name, xero_status, bill_date, due_date, fully_paid_on,
       currency_code, currency_rate, sub_total, total_tax, total,
       amount_paid, amount_due, amount_credited,
       has_attachments, attachment_count, is_interco, updated_date_utc
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       invoice_number = VALUES(invoice_number), reference = VALUES(reference),
       contact_id = VALUES(contact_id), contact_name = VALUES(contact_name),
       xero_status = VALUES(xero_status), bill_date = VALUES(bill_date),
       due_date = VALUES(due_date), fully_paid_on = VALUES(fully_paid_on),
       currency_code = VALUES(currency_code), currency_rate = VALUES(currency_rate),
       sub_total = VALUES(sub_total), total_tax = VALUES(total_tax), total = VALUES(total),
       amount_paid = VALUES(amount_paid), amount_due = VALUES(amount_due),
       amount_credited = VALUES(amount_credited),
       has_attachments = VALUES(has_attachments),
       -- A summary-only sync doesn't know the count; keep what we already had.
       attachment_count = COALESCE(VALUES(attachment_count), attachment_count),
       is_interco = VALUES(is_interco), updated_date_utc = VALUES(updated_date_utc)`,
    [
      accountId, tenantId, inv.InvoiceID,
      fit(inv.InvoiceNumber, 'invoice_number'), fit(inv.Reference, 'reference'),
      inv.Contact?.ContactID || null, fit(inv.Contact?.Name, 'contact_name'),
      fit(inv.Status, 'xero_status') || 'DRAFT',
      date(inv.Date), date(inv.DueDate), date(inv.FullyPaidOnDate),
      fit(inv.CurrencyCode, 'currency_code'), inv.CurrencyRate == null ? null : Number(inv.CurrencyRate),
      num(inv.SubTotal), num(inv.TotalTax), num(inv.Total),
      num(inv.AmountPaid), num(inv.AmountDue), num(inv.AmountCredited),
      inv.HasAttachments ? 1 : 0, attachmentCount,
      isInterco ? 1 : 0, datetime(inv.UpdatedDateUTC)
    ]
  );
}

// Apply a status change we've already made in Xero, so the list reflects it
// without waiting for the next sync.
async function applyStatus(accountId, id, xeroStatus) {
  const res = await db.execute(
    'UPDATE bills SET xero_status = ? WHERE account_id = ? AND id = ?',
    [xeroStatus, accountId, id]
  );
  return res.affectedRows;
}

module.exports = {
  list, listMeta, tabCounts, stats, contacts, SORTS,
  getById, getManyByIds, upsertFromXero, applyStatus, fit, WIDTHS,
  UI_STATUS_SQL
};
