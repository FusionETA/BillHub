// Server-side sessions. The cookie holds a random token; the DB stores only its
// SHA-256 hash, and sessions can be revoked by deleting the row.
const db = require('../db');
const { randomToken, sha256hex } = require('../lib/tokens');

const TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);
const COOKIE_NAME = 'wz_session';

// Creates a session for a user and returns the raw token to set in the cookie.
async function create(userId, { ip = null, userAgent = null } = {}) {
  const raw = randomToken(32);
  const id = sha256hex(raw);
  const expiresAt = new Date(Date.now() + TTL_DAYS * 86400000);
  await db.execute(
    'INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
    [id, userId, expiresAt, ip, String(userAgent || '').slice(0, 255)]
  );
  return raw;
}

// Resolves a raw cookie token to its user row (or null if missing/expired).
async function resolveUser(rawToken) {
  if (!rawToken) return null;
  const id = sha256hex(rawToken);
  return db.getOne(
    `SELECT u.* FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > NOW()`,
    [id]
  );
}

async function destroy(rawToken) {
  if (!rawToken) return;
  await db.execute('DELETE FROM sessions WHERE id = ?', [sha256hex(rawToken)]);
}

// Housekeeping: remove expired sessions.
async function purgeExpired() {
  const res = await db.execute('DELETE FROM sessions WHERE expires_at <= NOW()');
  return res.affectedRows;
}

module.exports = { create, resolveUser, destroy, purgeExpired, COOKIE_NAME, TTL_DAYS };
