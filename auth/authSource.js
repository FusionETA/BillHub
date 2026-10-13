// Where Bills Hub's users and sessions live.
//
//   AUTH_SOURCE=own       (default) Bills Hub has its own users, its own
//                         passwords and its own sign-in. Standalone.
//
//   AUTH_SOURCE=wazzocr   There is no sign-in. Bills Hub reads WazzOCR's
//                         session cookie and WazzOCR's users table, so
//                         whoever is signed into WazzOCR is signed into
//                         Bills Hub. No second password exists to forget,
//                         leak or rotate.
//
// Deliberately the same shape as lib/grantSource.js, which does this for the
// Xero grant: one env var, two qualified table names, `own` as the default
// because it is self-contained and cannot affect anything else.
//
// Why this works at all: the two apps share a MySQL server, and
// WazzOCR/auth/sessions.js and this app's are the same file — same
// `wz_session` cookie, same SHA-256-of-the-token scheme, because Bills Hub
// was derived from WazzOCR. So a token minted there resolves here unchanged.
//
// What it needs: both apps on one registrable domain, and WazzOCR setting
// SESSION_COOKIE_DOMAIN so the browser sends the cookie to both. Without
// that the cookie never arrives and every request looks signed out.

const MODE = String(process.env.AUTH_SOURCE || 'own').trim().toLowerCase();

if (!['own', 'wazzocr'].includes(MODE)) {
  throw new Error(`AUTH_SOURCE must be "own" or "wazzocr"; got "${MODE}".`);
}

const WAZZOCR_DB = process.env.WAZZOCR_DB_NAME || 'wazzocr';
if (MODE === 'wazzocr' && !/^[A-Za-z0-9_$]{1,64}$/.test(WAZZOCR_DB)) {
  throw new Error(`WAZZOCR_DB_NAME must be a plain MySQL identifier; got "${WAZZOCR_DB}".`);
}

const BORROWED = MODE === 'wazzocr';
const SESSIONS = BORROWED ? `\`${WAZZOCR_DB}\`.\`sessions\`` : '`sessions`';
const USERS = BORROWED ? `\`${WAZZOCR_DB}\`.\`users\`` : '`users`';

// Said once at boot, because "who can sign in" is not something to discover
// from behaviour.
function announce() {
  if (!BORROWED) return;
  console.log(`[auth] AUTH_SOURCE=wazzocr — users and sessions read from \`${WAZZOCR_DB}\`.`);
  console.log('[auth] Bills Hub has no sign-in of its own; sign in to WazzOCR.');
}

module.exports = { MODE, BORROWED, SESSIONS, USERS, WAZZOCR_DB, announce };
