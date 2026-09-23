// Express auth middleware: attach the logged-in user/account from the session
// cookie, and guards for protected routes.
//
// AUTH_DISABLED=true turns sign-in off entirely: every request is treated as the
// owner of DEFAULT_ACCOUNT_ID (or the only account, if there is one). Intended
// for building and demoing before sign-in matters. It leaves the app completely
// open — and Bills Hub can approve bills in a live Xero — so the server logs a
// warning on boot and the UI carries a permanent banner.
const db = require('../db');
const sessions = require('./sessions');
const accountsModel = require('../models/accounts');

const AUTH_DISABLED = String(process.env.AUTH_DISABLED || '').toLowerCase() === 'true';

// Resolved once: the account every request runs as while sign-in is off.
let _openAccount;
async function openAccount() {
  if (_openAccount !== undefined) return _openAccount;
  const wanted = Number(process.env.DEFAULT_ACCOUNT_ID) || null;
  _openAccount = wanted
    ? await accountsModel.getById(wanted)
    : await db.getOne('SELECT * FROM accounts ORDER BY id LIMIT 1');
  if (!_openAccount) {
    console.error('[auth] AUTH_DISABLED is set but there is no account to run as. Create one with scripts/create-account.js.');
  }
  return _openAccount;
}

// A stand-in for a signed-in owner. Not a database row — nothing is created, so
// turning sign-in back on leaves no stray user behind.
function openUser(account) {
  return {
    id: 0,
    account_id: account ? account.id : null,
    email: 'open-access@localhost',
    name: account ? account.name : 'Open access',
    role: 'owner',
    is_super_admin: 0,
    status: 'active'
  };
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

// Sets req.user (+ req.account if the user belongs to one) when a valid session
// cookie is present. No-op (and cheap) when there's no cookie.
async function attachUser(req, res, next) {
  if (AUTH_DISABLED) {
    try {
      const account = await openAccount();
      req.user = openUser(account);
      req.account = account || null;
    } catch (err) {
      console.error('[auth] open-access lookup failed:', err.message);
    }
    return next();
  }
  try {
    const raw = parseCookies(req.headers.cookie)[sessions.COOKIE_NAME];
    if (raw) {
      const user = await sessions.resolveUser(raw);
      if (user) {
        req.user = user;
        req.sessionToken = raw;
        if (user.account_id) req.account = await accountsModel.getById(user.account_id);
      }
    }
  } catch (err) {
    console.error('[auth] attachUser error:', err.message);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    // With sign-in off, a missing user means there is no account to run as —
    // which is a setup problem, not an authentication one.
    if (AUTH_DISABLED) {
      return res.status(503).json({ error: 'No account exists yet. Create one with scripts/create-account.js.' });
    }
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (AUTH_DISABLED) return next();
  if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
  if (!req.user.is_super_admin) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

function setSessionCookie(req, res, rawToken) {
  res.cookie(sessions.COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: req.secure || process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: sessions.TTL_DAYS * 86400000,
    path: '/'
  });
}

function clearSessionCookie(res) {
  res.clearCookie(sessions.COOKIE_NAME, { path: '/' });
}

module.exports = {
  attachUser, requireAuth, requireSuperAdmin,
  setSessionCookie, clearSessionCookie, parseCookies,
  AUTH_DISABLED
};
