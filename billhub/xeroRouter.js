// Xero connection endpoints.
//
//   GET /api/xero/connect   start a consent  (XERO_GRANT_SOURCE=own)
//                           refuse, and point at WazzOCR  (=wazzocr)
//   GET /api/xero/callback  store the grant and its organisations
//   GET /api/xero/status    the grant's health and the orgs it covers
//   GET /api/xero/verify    ask Xero which orgs the token can actually reach
//
// Why the two modes exist: Xero supersedes the older token set whenever the same
// Xero user re-authorises the same app. In `wazzocr` mode Bills Hub shares
// WazzOCR's token, so a consent started here would invalidate it and stop
// WazzOCR's live pipeline — hence the refusal. In `own` mode Bills Hub has its
// own app and its own token, and nothing else is affected.
const express = require('express');
const router = express.Router();

const grantSource = require('../lib/grantSource');
const xero = require('../lib/xero');
const xc = require('../models/xeroConnections');
const entities = require('../models/entities');
const { attachUser, requireAuth } = require('../auth/middleware');

const WAZZOCR_URL = (process.env.WAZZOCR_URL || '').replace(/\/$/, '');

router.get('/connect', attachUser, requireAuth, (req, res) => {
  if (grantSource.BORROWED) {
    const where = WAZZOCR_URL ? `${WAZZOCR_URL}/account.html` : 'WazzOCR';
    return res.status(409).json({
      error: 'Bills Hub is sharing WazzOCR\'s Xero connection, so it cannot start its own. '
           + 'Authorising again here would invalidate WazzOCR\'s token and stop its bill pipeline. '
           + `Connect or reconnect Xero in ${where} instead — Bills Hub picks it up straight away.`,
      connectAt: WAZZOCR_URL ? `${WAZZOCR_URL}/account.html` : null
    });
  }
  if (!req.user.account_id) return res.status(400).send('Your login has no account.');
  try {
    res.redirect(xero.authorizeUrl(req.user.account_id, xero.redirectUri(req)));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Xero redirects the browser here. No session is needed — the account travels in
// the signed state, so the callback works even if the cookie was dropped.
router.get('/callback', async (req, res) => {
  const back = (params) => res.redirect(`/?${new URLSearchParams(params)}`);
  if (grantSource.BORROWED) return back({ xero: 'error', message: 'This deployment borrows WazzOCR\'s Xero grant; connect there instead.' });

  const { code, state, error, error_description: errorDescription } = req.query;
  if (error) return back({ xero: 'error', message: errorDescription || error });
  if (!code) return back({ xero: 'error', message: 'Xero did not return an authorisation code.' });

  const parsed = xero.parseState(state);
  if (!parsed) return back({ xero: 'error', message: 'Invalid or expired authorisation state. Please try again.' });

  try {
    const tokens = await xero.exchangeCode(code, xero.redirectUri(req));
    const tenants = await xero.fetchTenants(tokens.accessToken);
    if (!tenants.length) {
      return back({ xero: 'error', message: 'That Xero login has no organisations connected to this app.' });
    }

    const grantId = await xc.saveGrant(parsed.accountId, tokens.refreshToken, tokens.scope || null);
    let n = 0;
    for (const t of tenants) {
      if (!t.tenantId) continue;
      await xc.upsertConnection(parsed.accountId, grantId, t.tenantId, t.tenantName || null);
      await entities.ensure(parsed.accountId, t.tenantId, t.tenantName || t.tenantId);
      n += 1;
    }
    await xc.pruneOrphanGrants(parsed.accountId);

    console.log(`[xero] account ${parsed.accountId} connected ${n} organisation(s).`);
    return back({ xero: 'connected', orgs: String(n) });
  } catch (err) {
    console.error('[xero] connect failed:', err.message);
    return back({ xero: 'error', message: err.message });
  }
});

router.get('/status', attachUser, requireAuth, async (req, res) => {
  if (!req.user.account_id) return res.json({ connected: false, organisations: [] });
  try {
    let connAccountId;
    try {
      connAccountId = await grantSource.connectionsAccountId(req.user.account_id);
    } catch (err) {
      return res.json({ connected: false, count: 0, organisations: [], error: err.message });
    }

    const health = await xc.check(connAccountId);
    if (!health.ok) {
      // In borrowed mode this is usually a missing cross-database GRANT. Say so
      // plainly rather than letting it surface as 40 identical sync failures.
      return res.json({
        connected: false, count: 0, organisations: [],
        error: grantSource.BORROWED
          ? `Cannot read WazzOCR's Xero connections in "${health.database}": ${health.error}`
          : `Cannot read the Xero connections: ${health.error}`
      });
    }

    const rows = await xc.listByAccount(connAccountId);
    res.json({
      connected: health.active > 0,
      count: health.active,
      needsReconnect: health.needsReconnect,
      grantSource: grantSource.MODE,
      // Only borrowed deployments send people elsewhere to connect.
      canConnectHere: !grantSource.BORROWED,
      source: grantSource.BORROWED ? { database: health.database, wazzocrAccountId: connAccountId } : null,
      organisations: rows.map((r) => ({
        tenantId: r.xero_tenant_id,
        name: r.tenant_name,
        status: r.status,
        needsReconnect: Boolean(r.needs_reconnect)
      })),
      manageAt: grantSource.BORROWED && WAZZOCR_URL ? `${WAZZOCR_URL}/account.html` : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Proves the token actually works, by asking Xero which organisations it can
// reach. Read-only — it changes nothing in either database.
router.get('/verify', attachUser, requireAuth, async (req, res) => {
  if (!req.user.account_id) return res.status(400).json({ error: 'This user has no account.' });
  try {
    const connAccountId = await grantSource.connectionsAccountId(req.user.account_id);
    const rows = await xc.listByAccount(connAccountId);
    const active = rows.filter((r) => r.status === 'active');
    if (!active.length) return res.status(424).json({ error: 'There are no active Xero connections for this account.' });

    const token = await xero.accessTokenFor(req.user.account_id, active[0].xero_tenant_id);
    const live = await xero.fetchTenants(token);
    const known = new Set(active.map((r) => r.xero_tenant_id));
    res.json({
      ok: true,
      grantSource: grantSource.MODE,
      xeroSees: live.length,
      connectionsHeld: active.length,
      // Organisations Xero allows that are not recorded here — reconnect to add them.
      missingLocally: live.filter((t) => !known.has(t.tenantId)).map((t) => t.tenantName)
    });
  } catch (err) {
    res.status(err.statusCode === 401 ? 424 : (err.statusCode || 500))
       .json({ error: err.message, ...(err.statusCode === 401 ? { needsXeroReconnect: true } : {}) });
  }
});

module.exports = router;
