// Supplier bank details.
//
// Xero holds these as free text on the contact (Contact.BankAccountDetails), so
// they are often blank, or typed with spaces and dashes. A value corrected here
// is marked 'manual' and a re-sync leaves it alone.
const db = require('../db');

function get(accountId, tenantId, contactId) {
  return db.getOne(
    'SELECT * FROM payees WHERE account_id = ? AND xero_tenant_id = ? AND contact_id = ?',
    [accountId, tenantId, contactId]
  );
}

function listByAccount(accountId, { tenantId = null, missingOnly = false } = {}) {
  const where = ['p.account_id = ?'];
  const params = [accountId];
  if (tenantId) { where.push('p.xero_tenant_id = ?'); params.push(tenantId); }
  if (missingOnly) where.push("(p.account_number IS NULL OR p.account_number = '')");
  return db.query(
    `SELECT p.*, e.code AS entity_code
       FROM payees p
       LEFT JOIN entities e
         ON e.account_id = p.account_id AND e.xero_tenant_id = p.xero_tenant_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.contact_name`,
    params
  );
}

// From a Xero Contact. Leaves a manually corrected row untouched.
async function upsertFromXero(accountId, tenantId, contact) {
  // BankAccountDetails is the old single free-text field. The BatchPayments
  // block is what the contact screen's "Financial details" panel writes, and it
  // is where the bank code, the account and the narrative actually live — so
  // prefer it and fall back only when it is empty.
  const bp = contact.BatchPayments || {};
  const accountNumber = cleanAccountNumber(bp.BankAccountNumber || contact.BankAccountDetails);
  await db.execute(
    `INSERT INTO payees (account_id, xero_tenant_id, contact_id, contact_name, account_number,
                         bank_account_name, details, payee_code, tax_number, email, source)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'xero')
     ON DUPLICATE KEY UPDATE
       contact_name = VALUES(contact_name),
       account_number = IF(source = 'manual', account_number, VALUES(account_number)),
       bank_account_name = IF(source = 'manual', bank_account_name, VALUES(bank_account_name)),
       details = IF(source = 'manual', details, VALUES(details)),
       payee_code = IF(source = 'manual', payee_code, VALUES(payee_code)),
       tax_number = VALUES(tax_number),
       email = VALUES(email)`,
    [accountId, tenantId, contact.ContactID, contact.Name || null, accountNumber,
     trim(bp.BankAccountName, 100), trim(bp.Details, 255), trim(bp.Code, 40),
     trim(contact.TaxNumber, 50), trim(contact.EmailAddress, 500)]
  );
}

const trim = (v, n) => (v == null || v === '' ? null : String(v).trim().slice(0, n));

// A hand correction, which a re-sync must not undo. Of the five "Financial
// details" fields Xero shows on a contact, its API accepts only
// BankAccountNumber on write — BankAccountName, Details and Code are silently
// dropped. So anything not typed into the Xero UI has to be correctable here,
// or it cannot be set at all.
async function setManual(accountId, tenantId, contactId, f = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(f, k);
  const sets = [];
  const params = [];
  const put = (col, value) => { sets.push(col + ' = ?'); params.push(value); };

  if (has('contactName')) put('contact_name', f.contactName || null);
  if (has('accountNumber')) put('account_number', cleanAccountNumber(f.accountNumber));
  if (has('bankName')) put('bank_name', f.bankName || null);
  if (has('bankAccountName')) put('bank_account_name', f.bankAccountName || null);
  if (has('details')) put('details', f.details || null);
  if (has('payeeCode')) put('payee_code', f.payeeCode || null);
  if (has('email')) put('email', f.email || null);
  if (has('taxNumber')) put('tax_number', f.taxNumber || null);
  if (!sets.length) return 0;

  // The row may not exist yet for a contact nobody has paid.
  await db.execute(
    `INSERT INTO payees (account_id, xero_tenant_id, contact_id, contact_name, source)
     VALUES (?,?,?,?, 'manual')
     ON DUPLICATE KEY UPDATE source = 'manual'`,
    [accountId, tenantId, contactId, f.contactName || null]
  );
  const res = await db.execute(
    `UPDATE payees SET ${sets.join(', ')}, source = 'manual'
      WHERE account_id = ? AND xero_tenant_id = ? AND contact_id = ?`,
    [...params, accountId, tenantId, contactId]
  );
  return res.affectedRows;
}

// Xero's field is free text: "Maybank 5142-3312-9987" or "  551234567  ".
// Keep digits and dashes, drop the rest; the file layout decides whether to
// strip the dashes as well.
function cleanAccountNumber(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9-]/g, '').replace(/^-+|-+$/g, '');
  return cleaned || null;
}

// Bills in a proposed batch whose payee has no account number. Called before a
// batch is created, so the gap is visible while it can still be fixed.
async function missingFor(accountId, tenantId, contactIds = []) {
  if (!contactIds.length) return [];
  const rows = await db.query(
    `SELECT contact_id, contact_name, account_number
       FROM payees
      WHERE account_id = ? AND xero_tenant_id = ?
        AND contact_id IN (${contactIds.map(() => '?').join(',')})`,
    [accountId, tenantId, ...contactIds]
  );
  const known = new Map(rows.map((r) => [r.contact_id, r]));
  return contactIds
    .filter((id) => !known.get(id) || !known.get(id).account_number)
    .map((id) => ({ contactId: id, contactName: known.get(id)?.contact_name || null }));
}

async function summary(accountId) {
  const row = await db.getOne(
    `SELECT COUNT(*) AS total,
            SUM(account_number IS NULL OR account_number = '') AS missing
       FROM payees WHERE account_id = ?`,
    [accountId]
  );
  return { total: Number(row?.total || 0), missing: Number(row?.missing || 0) };
}

module.exports = { get, listByAccount, upsertFromXero, setManual, missingFor, summary, cleanAccountNumber };
