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
  await db.execute(
    `INSERT INTO payees (account_id, xero_tenant_id, contact_id, contact_name, account_number, source)
     VALUES (?,?,?,?,?, 'xero')
     ON DUPLICATE KEY UPDATE
       contact_name = VALUES(contact_name),
       account_number = IF(source = 'manual', account_number, VALUES(account_number))`,
    [accountId, tenantId, contact.ContactID, contact.Name || null, cleanAccountNumber(contact.BankAccountDetails)]
  );
}

async function setManual(accountId, tenantId, contactId, { accountNumber, bankName, contactName } = {}) {
  await db.execute(
    `INSERT INTO payees (account_id, xero_tenant_id, contact_id, contact_name, account_number, bank_name, source)
     VALUES (?,?,?,?,?,?, 'manual')
     ON DUPLICATE KEY UPDATE
       contact_name = COALESCE(VALUES(contact_name), contact_name),
       account_number = VALUES(account_number),
       bank_name = VALUES(bank_name),
       source = 'manual'`,
    [accountId, tenantId, contactId, contactName || null, cleanAccountNumber(accountNumber), bankName || null]
  );
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
