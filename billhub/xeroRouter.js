// Xero status endpoints.
//
//   GET /api/xero/status  -> the borrowed grant's health and the orgs it covers
//   GET /api/xero/connect -> refuses, and says where to connect instead
//
// Bills Hub has no consent flow of its own on purpose. Xero supersedes the older
// token set whenever the same Xero user re-authorises the same app, so a consent
// started here would silently invalidate WazzOCR's refresh token and break its
// live pipeline. Connecting and reconnecting happen in WazzOCR; Bills Hub reads
// the grant WazzOCR holds.
const express = require('express');
const router = express.Router();

const xero = require('../lib/xero');
const xc = require('../models/xeroConnections');
const accounts = require('../models/accounts');
const { attachUser, requireAuth } = require('../auth/middleware');

const WAZZOCR_URL = (process.env.WAZZOCR_URL || '').replace(/\/$/, '');

// Kept as a route so an old link, or the UI's badge, lands on an explanation
// rather than a 404 — and never on a consent screen.
router.get('/connect', attachUser, requireAuth, (req, res) => {
  const where = WAZZOCR_URL ? `${WAZZOCR_URL}/account.html` : 'WazzOCR';
  res.status(409).json({
    error: 'Bills Hub shares WazzOCR\'s Xero connection, so it cannot start its own. '
         + 'Authorising again here would invalidate WazzOCR\'s token and stop its bill pipeline. '
         + `Connect or reconnect Xero in ${where} instead — Bills Hub picks it up straight away.`,
    connectAt: WAZZOCR_URL ? `${WAZZOCR_URL}/account.html` : null
  });
});

router.get('/status', attachUser, requireAuth, async (req, res) => {
  if (!req.user.account_id) return res.json({ connected: false, organisations: [] });
  try {
    let wazzocrAccountId;
    try {
      wazzocrAccountId = await accounts.wazzocrIdFor(req.user.account_id);
    } catch (err) {
      return res.json({ connected: false, count: 0, organisations: [], error: err.message });
    }

    const health = await xc.check(wazzocrAccountId);
    if (!health.ok) {
      // Usually a missing GRANT on wazzocr.xero_connections. Say that plainly
      // rather than letting it surface as 40 identical sync failures.
      return res.json({
        connected: false, count: 0, organisations: [],
        error: `Cannot read WazzOCR's Xero connections in "${health.database}": ${health.error}`
      });
    }

    const rows = await xc.listByAccount(wazzocrAccountId);
    res.json({
      connected: health.active > 0,
      count: health.active,
      needsReconnect: health.needsReconnect,
      source: { database: health.database, wazzocrAccountId },
      organisations: rows.map((r) => ({
        tenantId: r.xero_tenant_id,
        name: r.tenant_name,
        status: r.status,
        needsReconnect: Boolean(r.needs_reconnect)
      })),
      manageAt: WAZZOCR_URL ? `${WAZZOCR_URL}/account.html` : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Proves the borrowed token actually works, by asking Xero which organisations
// it can reach. Read-only — it changes nothing in either database.
router.get('/verify', attachUser, requireAuth, async (req, res) => {
  if (!req.user.account_id) return res.status(400).json({ error: 'This user has no account.' });
  try {
    const wazzocrAccountId = await accounts.wazzocrIdFor(req.user.account_id);
    const rows = await xc.listByAccount(wazzocrAccountId);
    const active = rows.filter((r) => r.status === 'active');
    if (!active.length) return res.status(424).json({ error: 'WazzOCR has no active Xero connections for this account.' });

    const token = await xero.accessTokenFor(req.user.account_id, active[0].xero_tenant_id);
    const live = await xero.fetchTenants(token);
    const known = new Set(active.map((r) => r.xero_tenant_id));
    res.json({
      ok: true,
      xeroSees: live.length,
      wazzocrHas: active.length,
      // Orgs Xero grants access to that WazzOCR hasn't recorded — reconnect in
      // WazzOCR to pick them up.
      missingLocally: live.filter((t) => !known.has(t.tenantId)).map((t) => t.tenantName)
    });
  } catch (err) {
    res.status(err.statusCode === 401 ? 424 : (err.statusCode || 500))
       .json({ error: err.message, ...(err.statusCode === 401 ? { needsXeroReconnect: true } : {}) });
  }
});

module.exports = router;
