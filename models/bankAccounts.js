// Paying accounts, mirrored from Xero's BANK accounts. One of these is the
// `Account` a Xero batch payment is posted against, and it decides which file
// layout the batch is rendered with.
const db = require('../db');

function listByAccount(accountId, { tenantId = null, enabledOnly = true } = {}) {
  const where = ['b.account_id = ?'];
  const params = [accountId];
  if (tenantId) { where.push('b.xero_tenant_id = ?'); params.push(tenantId); }
  if (enabledOnly) where.push('b.enabled = 1');
  return db.query(
    `SELECT b.*, e.code AS entity_code, e.short_name AS entity_short
       FROM bank_accounts b
       LEFT JOIN entities e
         ON e.account_id = b.account_id AND e.xero_tenant_id = b.xero_tenant_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.position, b.is_default DESC, b.name`,
    params
  );
}

function getById(accountId, id) {
  return db.getOne(
    `SELECT b.*, e.code AS entity_code, e.short_name AS entity_short
       FROM bank_accounts b
       LEFT JOIN entities e
         ON e.account_id = b.account_id AND e.xero_tenant_id = b.xero_tenant_id
      WHERE b.account_id = ? AND b.id = ?`,
    [accountId, id]
  );
}

// Insert or refresh from a Xero Accounts payload. Never overwrites the two
// fields a person sets here — the file format and the default flag.
async function upsertFromXero(accountId, tenantId, acc) {
  await db.execute(
    `INSERT INTO bank_accounts
       (account_id, xero_tenant_id, xero_account_id, code, name, bank_name, account_number, currency_code)
     VALUES (?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       code = VALUES(code), name = VALUES(name),
       bank_name = COALESCE(VALUES(bank_name), bank_name),
       account_number = VALUES(account_number),
       currency_code = VALUES(currency_code)`,
    [
      accountId, tenantId, acc.AccountID,
      acc.Code || null,
      acc.Name || 'Bank account',
      acc.BankAccountType || null,
      acc.BankAccountNumber || null,
      acc.CurrencyCode || null
    ]
  );
}

async function update(accountId, id, { formatKey, bankName, accountNumber, isDefault, enabled } = {}) {
  const sets = [];
  const params = [];
  if (formatKey !== undefined) { sets.push('format_key = ?'); params.push(formatKey || null); }
  if (bankName !== undefined) { sets.push('bank_name = ?'); params.push(bankName || null); }
  if (accountNumber !== undefined) { sets.push('account_number = ?'); params.push(accountNumber || null); }
  if (enabled !== undefined) { sets.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (isDefault !== undefined) { sets.push('is_default = ?'); params.push(isDefault ? 1 : 0); }
  if (!sets.length) return 0;
  params.push(accountId, id);
  const res = await db.execute(
    `UPDATE bank_accounts SET ${sets.join(', ')} WHERE account_id = ? AND id = ?`, params
  );
  // Only one default per organisation.
  if (isDefault) {
    const row = await getById(accountId, id);
    if (row) {
      await db.execute(
        'UPDATE bank_accounts SET is_default = 0 WHERE account_id = ? AND xero_tenant_id = ? AND id <> ?',
        [accountId, row.xero_tenant_id, id]
      );
    }
  }
  return res.affectedRows;
}

// Counts for the stat cards: how many accounts, and how many distinct formats.
async function summary(accountId) {
  const row = await db.getOne(
    `SELECT COUNT(*) AS accounts,
            COUNT(DISTINCT format_key) AS formats,
            SUM(format_key IS NULL) AS unconfigured
       FROM bank_accounts WHERE account_id = ? AND enabled = 1`,
    [accountId]
  );
  return {
    accounts: Number(row?.accounts || 0),
    formats: Number(row?.formats || 0),
    unconfigured: Number(row?.unconfigured || 0)
  };
}

module.exports = { listByAccount, getById, upsertFromXero, update, summary };
