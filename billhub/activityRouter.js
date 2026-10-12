// The activity log, for a super admin.
//
//   GET /api/activity            the page, with filters
//   GET /api/activity/filters    who appears in it, and what kinds of action
//
// Guarded by requireSuperAdmin. With sign-in switched off there is nobody to
// check, so the guard waves everything through — which is the same bargain
// the rest of the app makes under AUTH_DISABLED, and the banner says so.
const express = require('express');
const router = express.Router();

const activity = require('../models/activity');
const { attachUser, requireAuth, requireSuperAdmin } = require('../auth/middleware');

router.use(attachUser, requireAuth, requireSuperAdmin);

const when = (d) => (d instanceof Date ? d : new Date(d));

function row(r) {
  const at = when(r.created_at);
  return {
    id: r.id,
    // Who, as the row recorded it — not a join that may no longer resolve.
    who: r.user_name || r.user_email || 'Unknown',
    email: r.user_email || null,
    userId: r.user_id || null,
    action: r.action,
    summary: r.summary || `${r.method || ''} ${r.path || ''}`.trim(),
    method: r.method || null,
    path: r.path || null,
    statusCode: r.status_code || null,
    // A failed request is the interesting one, so it is marked rather than
    // left to be spotted in a column of numbers.
    failed: Boolean(r.status_code && r.status_code >= 400),
    detail: r.detail || null,
    ip: r.ip || null,
    at: at.toISOString(),
    atLabel: at.toISOString().slice(0, 16).replace('T', ' ')
  };
}

router.get('/', async (req, res) => {
  const accountId = req.account?.id || req.user?.account_id || null;
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = await activity.list(accountId, {
      limit: limit + 1,
      before: req.query.before || null,
      userId: req.query.userId || null,
      action: req.query.action || null,
      days: req.query.days || null,
      q: req.query.q || null
    });
    // One more than asked for, so "there is another page" is known rather
    // than guessed from a full page.
    const more = rows.length > limit;
    res.json({ events: rows.slice(0, limit).map(row), more });
  } catch (err) {
    console.error('[activity] list failed:', err.message);
    res.status(500).json({ error: 'Could not read the activity log.' });
  }
});

router.get('/filters', async (req, res) => {
  const accountId = req.account?.id || req.user?.account_id || null;
  try {
    const [actors, kinds] = await Promise.all([
      activity.actors(accountId), activity.kinds(accountId)
    ]);
    res.json({
      actors: actors.map((a) => ({
        userId: a.user_id, label: a.name || a.email || `User ${a.user_id}`, events: Number(a.events)
      })),
      // Grouped to the part before the first dot, so the filter offers
      // "recharge" rather than nine separate recharge actions.
      kinds: [...new Set(kinds.map((k) => String(k.action).split('.')[0]))].sort()
        .map((k) => ({ value: k, label: k }))
    });
  } catch (err) {
    console.error('[activity] filters failed:', err.message);
    res.status(500).json({ error: 'Could not read the activity log.' });
  }
});

module.exports = router;
