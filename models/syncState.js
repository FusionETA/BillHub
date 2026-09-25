// Per-tenant bill-sync bookkeeping: where the last run got to, and how it went.
const db = require('../db');

function get(accountId, tenantId) {
  return db.getOne(
    'SELECT * FROM bill_sync_state WHERE account_id = ? AND xero_tenant_id = ?',
    [accountId, tenantId]
  );
}

function listByAccount(accountId) {
  return db.query(
    `SELECT s.*, c.tenant_name, e.code, e.short_name
       FROM bill_sync_state s
       LEFT JOIN xero_connections c
         ON c.account_id = s.account_id AND c.xero_tenant_id = s.xero_tenant_id
       LEFT JOIN entities e
         ON e.account_id = s.account_id AND e.xero_tenant_id = s.xero_tenant_id
      WHERE s.account_id = ? ORDER BY e.position, c.tenant_name`,
    [accountId]
  );
}

async function markRunning(accountId, tenantId) {
  await db.execute(
    `INSERT INTO bill_sync_state (account_id, xero_tenant_id, last_status, last_run_at)
     VALUES (?,?, 'running', NOW())
     ON DUPLICATE KEY UPDATE last_status = 'running', last_run_at = NOW()`,
    [accountId, tenantId]
  );
}

// cursorUtc is the new high-water mark (a JS Date or 'YYYY-MM-DD HH:MM:SS').
// `note` records something worth knowing about an otherwise successful run —
// bills skipped, say. The status stays 'ok' because the organisation synced;
// the note is how anyone finds out it was not the whole story.
async function markOk(accountId, tenantId, cursorUtc, upserted, note = null) {
  await db.execute(
    `UPDATE bill_sync_state
        SET last_status = 'ok', last_error = ?, cursor_utc = ?,
            bills_upserted = ?, last_run_at = NOW()
      WHERE account_id = ? AND xero_tenant_id = ?`,
    [note ? String(note).slice(0, 512) : null, cursorUtc, Number(upserted) || 0, accountId, tenantId]
  );
}

// The cursor is deliberately left untouched on failure, so the next run retries
// the same window instead of skipping over whatever it missed.
async function markError(accountId, tenantId, message) {
  await db.execute(
    `UPDATE bill_sync_state
        SET last_status = 'error', last_error = ?, last_run_at = NOW()
      WHERE account_id = ? AND xero_tenant_id = ?`,
    [String(message || '').slice(0, 512), accountId, tenantId]
  );
}

// The contacts high-water mark, kept apart from the invoice one so a failed
// invoice page cannot rewind contacts or the other way round.
async function markContactsCursor(accountId, tenantId, cursorUtc) {
  if (!cursorUtc) return;
  await db.execute(
    `UPDATE bill_sync_state SET contacts_cursor_utc = ?
      WHERE account_id = ? AND xero_tenant_id = ?`,
    [cursorUtc, accountId, tenantId]
  );
}

// Newest successful run across all tenants, for the "last synced" label.
async function lastSyncedAt(accountId) {
  const row = await db.getOne(
    "SELECT MAX(last_run_at) AS at FROM bill_sync_state WHERE account_id = ? AND last_status = 'ok'",
    [accountId]
  );
  return row?.at || null;
}

module.exports = { get, listByAccount, markRunning, markOk, markError, markContactsCursor, lastSyncedAt };
