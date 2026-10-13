// Server-side sessions. The cookie holds a random token; the DB stores only its
// SHA-256 hash, and sessions can be revoked by deleting the row.
//
// Which tables these are depends on AUTH_SOURCE — see auth/authSource.js.
// Under `wazzocr` they are WazzOCR's, so a session minted there resolves
// here and nobody signs in twice.
const db = require('../db');
const authSource = require('./authSource');
const { randomToken, sha256hex } = require('../lib/tokens');

const TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);
const COOKIE_NAME = 'wz_session';

// Creates a session for a user and returns the raw token to set in the cookie.
//
// Refused outright when the sessions are WazzOCR's. Writing a row into
// another app's table is not Bills Hub's to do, and a session it minted
// there would outlive anything it knows how to revoke.
async function create(userId, { ip = null, userAgent = null } = {}) {
  if (authSource.BORROWED) {
    throw Object.assign(
      new Error('Bills Hub does not create sessions while AUTH_SOURCE=wazzocr. Sign in to WazzOCR.'),
      { statusCode: 409 });
  }
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
    `SELECT u.* FROM ${authSource.SESSIONS} s
     JOIN ${authSource.USERS} u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > NOW()`,
    [id]
  );
}

// Deliberately NOT routed through authSource. Signing out of Bills Hub must
// not delete a row in WazzOCR's table and sign somebody out of the app they
// were actually using; auth/router.js refuses the logout instead and says
// where to go.
async function destroy(rawToken) {
  if (!rawToken) return;
  if (authSource.BORROWED) return;
  await db.execute('DELETE FROM sessions WHERE id = ?', [sha256hex(rawToken)]);
}

// Housekeeping: remove expired sessions.
// Housekeeping on its own table only, for the same reason.
async function purgeExpired() {
  if (authSource.BORROWED) return 0;
  const res = await db.execute('DELETE FROM sessions WHERE expires_at <= NOW()');
  return res.affectedRows;
}

module.exports = { create, resolveUser, destroy, purgeExpired, COOKIE_NAME, TTL_DAYS };
