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

// Which rows the reader may see. A number narrows to one account, keeping
// the rows that belong to no account — a failed sign-in happens before
// anybody knows whose it was, and those are worth seeing.
//
// `null` means every account. Only the activity log is ever called that way:
// the permission that opens this page is held by whoever runs the
// deployment, not by a customer's administrator, and a question like "who
// changed that" does not arrive already sorted by company.
const scope = (accountId, where, params) => {
  if (accountId == null) return;
  where.push('(l.account_id = ? OR l.account_id IS NULL)');
  params.push(Number(accountId));
};

// Joined so a row can say which account it happened in, which is the only
// way a cross-account page reads as anything but a jumble.
const FROM = 'activity_log l LEFT JOIN accounts a ON a.id = l.account_id';

// Newest first, with the filters the page offers. `before` is an id rather
// than a timestamp: two rows can share a second, and paging by time would
// drop or repeat them.
async function list(accountId, {
  limit = 100, before = null, userId = null, action = null, q = null, days = null
} = {}) {
  const where = [];
  const params = [];
  scope(accountId, where, params);
  if (before) { where.push('l.id < ?'); params.push(Number(before)); }
  if (userId) { where.push('l.user_id = ?'); params.push(Number(userId)); }
  // A prefix, so "recharge" picks up every recharge action without the page
  // having to know what they are called.
  if (action) { where.push('l.action LIKE ?'); params.push(`${action}%`); }
  if (days) { where.push('l.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)'); params.push(Number(days)); }
  if (q) {
    where.push('(l.user_email LIKE ? OR l.user_name LIKE ? OR l.summary LIKE ? OR l.path LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  params.push(Math.min(Number(limit) || 100, 500));
  return db.query(
    `SELECT l.*, a.name AS account_name FROM ${FROM}
      WHERE ${where.join(' AND ') || '1'} ORDER BY l.id DESC LIMIT ?`, params);
}

// Everyone who appears in the log, for the filter. From the log itself and
// not from `users`, so somebody since removed is still selectable — which is
// often exactly who is being looked for.
async function actors(accountId) {
  const where = ['l.user_id IS NOT NULL'];
  const params = [];
  scope(accountId, where, params);
  return db.query(
    `SELECT l.user_id, MAX(l.user_email) AS email, MAX(l.user_name) AS name, COUNT(*) AS events
       FROM ${FROM} WHERE ${where.join(' AND ')}
      GROUP BY l.user_id ORDER BY MAX(l.id) DESC LIMIT 100`, params);
}

async function kinds(accountId) {
  const where = [];
  const params = [];
  scope(accountId, where, params);
  return db.query(
    `SELECT l.action, COUNT(*) AS events FROM ${FROM}
      WHERE ${where.join(' AND ') || '1'}
      GROUP BY l.action ORDER BY l.action`, params);
}

// The accounts that actually appear in the log, for the account filter.
// Named from `accounts` but counted from the log, so one that has never done
// anything is not offered as something to look at.
async function accounts() {
  return db.query(
    `SELECT l.account_id, MAX(a.name) AS name, COUNT(*) AS events
       FROM ${FROM} WHERE l.account_id IS NOT NULL
      GROUP BY l.account_id ORDER BY MAX(a.name)`);
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

module.exports = { record, list, actors, kinds, accounts, prune, scrub };
