// Session auth: email + password login against the local `users` table.
//   POST /api/auth/login   { email, password }
//   POST /api/auth/logout
//   GET  /api/auth/me
const express = require('express');
const router = express.Router();

const users = require('../models/users');
const sessions = require('./sessions');
const { verifyPassword } = require('./passwords');
const activity = require('../models/activity');
const { attachUser, requireAuth, setSessionCookie, clearSessionCookie, AUTH_DISABLED } = require('./middleware');

// Sign-in records itself rather than leaving it to the middleware: only here
// is it known whether the attempt succeeded, and for whom. A failed one is
// the single most useful line in the log, and the middleware would have no
// user to attribute it to.
const seen = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

router.post('/login', async (req, res) => {
  // Signing in while sign-in is switched off would hand back a session the app
  // ignores; say so rather than appearing to work.
  if (AUTH_DISABLED) return res.status(409).json({ error: 'Sign-in is disabled on this deployment.' });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  try {
    const user = await users.getByEmail(email);
    // One message for "no such user" and "wrong password", so the response
    // can't be used to enumerate which emails exist.
    const ok = user && user.status !== 'disabled' && await verifyPassword(password, user.password_hash);
    if (!ok) {
      // The email as typed, which is the point: a run of failures against an
      // address that does not exist reads differently from a run against one
      // that does. The password itself never goes near this.
      await activity.record({
        accountId: user?.account_id || null, email: String(email).slice(0, 255),
        action: 'login.failed', method: 'POST', path: '/api/auth/login', statusCode: 401,
        summary: user ? (user.status === 'disabled' ? 'Sign-in refused — account disabled' : 'Wrong password')
                      : 'Sign-in attempted for an address with no account',
        ...seen(req)
      });
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const raw = await sessions.create(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setSessionCookie(req, res, raw);
    await users.markLogin(user.id);
    await activity.record({
      accountId: user.account_id, user, action: 'login', summary: 'Signed in',
      method: 'POST', path: '/api/auth/login', statusCode: 200, ...seen(req)
    });
    res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('[auth] login failed:', err.message);
    res.status(500).json({ error: 'Sign-in failed.' });
  }
});

router.post('/logout', attachUser, async (req, res) => {
  if (AUTH_DISABLED) return res.status(409).json({ error: 'Sign-in is disabled on this deployment.' });
  try { await sessions.destroy(req.sessionToken); } catch { /* already gone */ }
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', attachUser, requireAuth, (req, res) => {
  res.json({
    // The UI shows a permanent banner while this is true.
    authDisabled: AUTH_DISABLED,
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      // Drives the Activity tab, which only a super admin can open. The
      // server checks it again on the route; this is only so the tab is not
      // offered to somebody who would be refused.
      isSuperAdmin: AUTH_DISABLED ? true : Boolean(req.user.is_super_admin),
      // Header avatar initials.
      initials: AUTH_DISABLED ? '—' : String(req.user.name || req.user.email || '?')
        .split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('')
    },
    account: req.account ? { id: req.account.id, name: req.account.name, baseCurrency: req.account.base_currency } : null
  });
});

module.exports = router;
