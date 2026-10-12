// Who did what, and when.
//
// Written from one place — the middleware in auth/activity.js — plus the two
// sign-in events, which are the only interesting things that happen before
// there is a user to attribute them to.
//
// Nothing here ever throws into the caller. A log that can fail a payment is
// worse than no log: the thing being recorded matters more than the record.
const db = require('../db');

// Keys whose value must never reach the table, matched anywhere in the
// request body. A password in an audit log is a password in a backup, in a
// query result and on somebody's screen.
const SECRET = /pass|secret|token|key|credential|authorization|cookie|pin|otp/i;

function scrub(value, depth = 0) {
  if (value == null || depth > 4) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) {
      out[k] = SECRET.test(k) ? '[removed]' : scrub(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  return value;
}

async function record({
  accountId = null, user = null, action, summary = null,
  method = null, path = null, statusCode = null, detail = null,
  ip = null, userAgent = null, email = null
} = {}) {
  try {
    await db.execute(
      `INSERT INTO activity_log
         (account_id, user_id, user_email, user_name, action, summary,
          method, path, status_code, detail, ip, user_agent)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        accountId, user?.id || null,
        (user?.email || email || null)?.slice(0, 255) || null,
        user?.name ? String(user.name).slice(0, 255) : null,
        String(action).slice(0, 64),
        summary ? String(summary).slice(0, 512) : null,
        method, path ? String(path).slice(0, 255) : null, statusCode,
        detail == null ? null : JSON.stringify(scrub(detail)),
        ip ? String(ip).slice(0, 64) : null,
        userAgent ? String(userAgent).slice(0, 255) : null
      ]
    );
  } catch (e) {
    // Including the case where the table does not exist yet, on a deployment
    // that has not migrated. The app carries on.
    console.error('[activity] could not record:', e.message);
  }
}

// Newest first, with the filters the page offers. `before` is an id rather
// than a timestamp: two rows can share a second, and paging by time would
// drop or repeat them.
async function list(accountId, {
  limit = 100, before = null, userId = null, action = null, q = null, days = null
} = {}) {
  const where = ['(account_id = ? OR account_id IS NULL)'];
  const params = [accountId];
  if (before) { where.push('id < ?'); params.push(Number(before)); }
  if (userId) { where.push('user_id = ?'); params.push(Number(userId)); }
  // A prefix, so "recharge" picks up every recharge action without the page
  // having to know what they are called.
  if (action) { where.push('action LIKE ?'); params.push(`${action}%`); }
  if (days) { where.push('created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)'); params.push(Number(days)); }
  if (q) {
    where.push('(user_email LIKE ? OR user_name LIKE ? OR summary LIKE ? OR path LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  params.push(Math.min(Number(limit) || 100, 500));
  return db.query(
    `SELECT * FROM activity_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, params);
}

// Everyone who appears in the log, for the filter. From the log itself and
// not from `users`, so somebody since removed is still selectable — which is
// often exactly who is being looked for.
async function actors(accountId) {
  return db.query(
    `SELECT user_id, MAX(user_email) AS email, MAX(user_name) AS name, COUNT(*) AS events
       FROM activity_log
      WHERE (account_id = ? OR account_id IS NULL) AND user_id IS NOT NULL
      GROUP BY user_id ORDER BY MAX(id) DESC LIMIT 100`, [accountId]);
}

async function kinds(accountId) {
  return db.query(
    `SELECT action, COUNT(*) AS events FROM activity_log
      WHERE (account_id = ? OR account_id IS NULL)
      GROUP BY action ORDER BY action`, [accountId]);
}

// The log grows for ever otherwise. Kept long enough to answer a question
// about last quarter, which is what anybody actually asks it.
async function prune({ days = Number(process.env.ACTIVITY_RETENTION_DAYS || 400) } = {}) {
  try {
    const res = await db.execute(
      'DELETE FROM activity_log WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [days]);
    if (res.affectedRows) console.log(`[activity] pruned ${res.affectedRows} row(s) older than ${days} days`);
    return res.affectedRows;
  } catch (e) {
    console.error('[activity] prune failed:', e.message);
    return 0;
  }
}

module.exports = { record, list, actors, kinds, prune, scrub };
