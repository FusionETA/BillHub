// The Xero grant Bills Hub borrows from WazzOCR.
//
// Reads are against `wazzocr.xero_grants` and `wazzocr.xero_connections`; the
// only write is the rotated refresh token on an existing grant row. Nothing is
// created, dropped or altered in WazzOCR's schema.
//
// `wazzocrAccountId` throughout is WazzOCR's account id, not Bills Hub's — the
// mapping lives in `billhub.accounts.wazzocr_account_id`.
//
// APP_ENCRYPTION_KEY must be the SAME value WazzOCR uses, or the stored refresh
// token cannot be decrypted.
const db = require('../db');
const { encrypt, decrypt } = require('../lib/crypto');
const { GRANTS, CONNECTIONS, DB_NAME } = require('../lib/wazzocrDb');

// Organisations WazzOCR has connected for this account.
function listByAccount(wazzocrAccountId) {
  return db.query(
    `SELECT id, account_id, grant_id, xero_tenant_id, tenant_name, status, needs_reconnect
       FROM ${CONNECTIONS} WHERE account_id = ?`,
    [wazzocrAccountId]
  );
}

// { grantId, refreshToken } for one organisation, or null when WazzOCR has no
// active connection to it.
async function getGrantForTenant(wazzocrAccountId, tenantId) {
  const row = await db.getOne(
    `SELECT g.id AS grant_id, g.refresh_token
       FROM ${CONNECTIONS} c JOIN ${GRANTS} g ON g.id = c.grant_id
      WHERE c.account_id = ? AND c.xero_tenant_id = ? AND c.status = 'active'`,
    [wazzocrAccountId, tenantId]
  );
  if (!row) return null;
  try {
    return { grantId: row.grant_id, refreshToken: decrypt(row.refresh_token) };
  } catch (err) {
    // Almost always a mismatched APP_ENCRYPTION_KEY — say so, because the raw
    // "Unsupported state or unable to authenticate data" is unhelpful.
    throw new Error(
      `Could not decrypt WazzOCR's Xero refresh token. APP_ENCRYPTION_KEY must match the one WazzOCR uses. (${err.message})`
    );
  }
}

// Runs `fn(currentRefreshToken)` with the grant row locked FOR UPDATE, then
// persists the rotated token. Serialising here means two Bills Hub workers (or
// two Bills Hub processes) can never refresh the same grant at once — Xero
// refresh tokens are single-use, so a double refresh would leave one holding a
// consumed token.
//
// WazzOCR does not take this lock, so a simultaneous refresh from WazzOCR is
// still possible. That case self-heals: both apps re-read this row before every
// refresh, Xero honours the previous token for 30 minutes, and each app's next
// refresh picks up whatever token is in the row. Adding the same FOR UPDATE to
// WazzOCR's refresh path would close the window entirely.
//
// `fn` returns { refreshToken, result }; `result` is passed back to the caller.
async function withGrantLock(grantId, fn) {
  return db.transaction(async (conn) => {
    // The lock is held across a call to Xero (a few hundred ms). Fail fast
    // rather than piling up connections if something holds it longer.
    await conn.execute('SET innodb_lock_wait_timeout = 20');
    const [rows] = await conn.execute(
      `SELECT refresh_token FROM ${GRANTS} WHERE id = ? FOR UPDATE`,
      [grantId]
    );
    if (!rows.length) {
      const err = new Error('That Xero grant no longer exists in WazzOCR. Reconnect Xero in WazzOCR.');
      err.statusCode = 401;
      throw err;
    }
    const current = decrypt(rows[0].refresh_token);
    const { refreshToken, result } = await fn(current);
    if (refreshToken && refreshToken !== current) {
      await conn.execute(`UPDATE ${GRANTS} SET refresh_token = ? WHERE id = ?`, [encrypt(refreshToken), grantId]);
    }
    return result;
  });
}

// Which WazzOCR account owns an active connection to this organisation.
async function findAccountByTenant(tenantId) {
  const row = await db.getOne(
    `SELECT account_id FROM ${CONNECTIONS} WHERE xero_tenant_id = ? AND status = 'active' LIMIT 1`,
    [tenantId]
  );
  return row ? row.account_id : null;
}

// Is the shared grant store reachable, and does this account have one? Called by
// /api/health and /api/xero/status so a missing GRANT shows up as a clear
// message instead of every sync failing one organisation at a time.
async function check(wazzocrAccountId) {
  try {
    const row = await db.getOne(
      `SELECT COUNT(*) AS n,
              SUM(status = 'active') AS active,
              SUM(needs_reconnect = 1) AS stale
         FROM ${CONNECTIONS} WHERE account_id = ?`,
      [wazzocrAccountId]
    );
    return {
      ok: true,
      database: DB_NAME,
      total: Number(row?.n || 0),
      active: Number(row?.active || 0),
      needsReconnect: Number(row?.stale || 0)
    };
  } catch (err) {
    return { ok: false, database: DB_NAME, error: err.message };
  }
}

module.exports = { listByAccount, getGrantForTenant, withGrantLock, findAccountByTenant, check };
