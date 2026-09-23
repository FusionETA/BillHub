// The Xero grant: either Bills Hub's own, or WazzOCR's borrowed one.
// lib/grantSource.js decides which tables these queries hit.
//
// In borrowed mode the only write is the rotated refresh token on an existing
// grant row — nothing is created, dropped or altered in WazzOCR's schema, and
// APP_ENCRYPTION_KEY must be the same value WazzOCR uses.
//
// `connAccountId` throughout is the account id the CONNECTIONS table is keyed
// by: Bills Hub's own in `own` mode, WazzOCR's in borrowed mode.
const db = require('../db');
const { encrypt, decrypt } = require('../lib/crypto');
const { GRANTS, CONNECTIONS, WAZZOCR_DB: DB_NAME, BORROWED } = require('../lib/grantSource');

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
    throw new Error(BORROWED
      ? `Could not decrypt WazzOCR's Xero refresh token. APP_ENCRYPTION_KEY must match the one WazzOCR uses. (${err.message})`
      : `Could not decrypt the stored Xero refresh token — APP_ENCRYPTION_KEY has changed. Reconnect Xero. (${err.message})`);
  }
}

// Runs `fn(currentRefreshToken)` with the grant row locked FOR UPDATE, then
// persists the rotated token. Serialising here means two Bills Hub workers (or
// two Bills Hub processes) can never refresh the same grant at once — Xero
// refresh tokens are single-use, so a double refresh would leave one holding a
// consumed token.
//
// In borrowed mode WazzOCR does not take this lock, so a simultaneous refresh
// from WazzOCR is still possible. That case self-heals: both apps re-read this
// row before every refresh, Xero honours the previous token for 30 minutes, and
// each app's next refresh picks up whatever token is in the row. Adding the same
// FOR UPDATE to WazzOCR's refresh path would close the window entirely. In `own`
// mode the question does not arise — nothing else touches the grant.
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
      const err = new Error(BORROWED
        ? 'That Xero grant no longer exists in WazzOCR. Reconnect Xero in WazzOCR.'
        : 'That Xero grant no longer exists. Reconnect Xero.');
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

// ── Own-grant writes (XERO_GRANT_SOURCE=own only) ───────────────────────────

function assertOwned(action) {
  if (BORROWED) {
    throw Object.assign(
      new Error(`Bills Hub is borrowing WazzOCR's Xero grant, so it cannot ${action}. Do it in WazzOCR.`),
      { statusCode: 409 }
    );
  }
}

async function saveGrant(accountId, refreshToken, scope = null) {
  assertOwned('store a grant');
  return db.insert(
    `INSERT INTO ${GRANTS} (account_id, refresh_token, scope) VALUES (?,?,?)`,
    [accountId, encrypt(refreshToken), scope]
  );
}

async function upsertConnection(accountId, grantId, tenantId, tenantName) {
  assertOwned('add a connection');
  await db.execute(
    `INSERT INTO ${CONNECTIONS} (account_id, grant_id, xero_tenant_id, tenant_name, status)
     VALUES (?,?,?,?,'active')
     ON DUPLICATE KEY UPDATE grant_id = VALUES(grant_id), tenant_name = VALUES(tenant_name),
                             status = 'active', needs_reconnect = 0`,
    [accountId, grantId, tenantId, tenantName]
  );
}

// Every connection now points at the newest grant; drop any left with none, so
// a superseded refresh token is not kept around.
async function pruneOrphanGrants(accountId) {
  if (BORROWED) return 0;
  const rows = await db.query(
    `SELECT g.id FROM ${GRANTS} g
      WHERE g.account_id = ?
        AND NOT EXISTS (SELECT 1 FROM ${CONNECTIONS} c WHERE c.grant_id = g.id)`,
    [accountId]
  );
  for (const r of rows) await db.execute(`DELETE FROM ${GRANTS} WHERE id = ?`, [r.id]).catch(() => {});
  return rows.length;
}

async function markNeedsReconnect(accountId, tenantId) {
  if (BORROWED) return 0;   // WazzOCR owns that flag
  const res = await db.execute(
    `UPDATE ${CONNECTIONS} SET needs_reconnect = 1, status = 'expired'
      WHERE account_id = ? AND xero_tenant_id = ?`,
    [accountId, tenantId]
  );
  return res.affectedRows;
}

// Is the grant store reachable, and does this account have one? Called by
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

module.exports = {
  listByAccount, getGrantForTenant, withGrantLock, findAccountByTenant, check,
  saveGrant, upsertConnection, pruneOrphanGrants, markNeedsReconnect, assertOwned
};
