// Session auth: email + password login against the local `users` table.
//   POST /api/auth/login   { email, password }
//   POST /api/auth/logout
//   GET  /api/auth/me
const express = require('express');
const router = express.Router();

const users = require('../models/users');
const sessions = require('./sessions');
const { verifyPassword } = require('./passwords');
const { attachUser, requireAuth, setSessionCookie, clearSessionCookie, AUTH_DISABLED } = require('./middleware');

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
    if (!ok) return res.status(401).json({ error: 'Incorrect email or password.' });

    const raw = await sessions.create(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setSessionCookie(req, res, raw);
    await users.markLogin(user.id);
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
      // Header avatar initials.
      initials: AUTH_DISABLED ? '—' : String(req.user.name || req.user.email || '?')
        .split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('')
    },
    account: req.account ? { id: req.account.id, name: req.account.name, baseCurrency: req.account.base_currency } : null
  });
});

module.exports = router;
