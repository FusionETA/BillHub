// Xero API client for Bills Hub.
//
// Bills Hub does not run its own OAuth consent. It borrows the grant WazzOCR
// already holds, because Xero supersedes the older token set whenever the same
// Xero user re-authorises the same app — a consent here would break WazzOCR.
// Connecting and reconnecting happen in WazzOCR; this module only spends the
// token.
//
// An access token is valid for EVERY organisation under its grant, so it is
// cached per grant rather than per tenant: one refresh serves all 40 orgs.
//
//   const xero = require('./lib/xero');
//   const page = await xero.api(accountId, tenantId, '/Invoices?page=1');
//
// `accountId` is always the Bills Hub account id; the WazzOCR one is resolved
// from accounts.wazzocr_account_id.

const xc = require('../models/xeroConnections');
const accounts = require('../models/accounts');

const IDENTITY_BASE = 'https://login.xero.com/identity/connect';
const API_BASE = 'https://api.xero.com/api.xro/2.0';
const CONNECTIONS_URL = 'https://api.xero.com/connections';

// accounting.transactions covers reading and writing invoices (bills). The
// .read scopes keep the contact/settings lookups least-privilege.
const SCOPES = process.env.XERO_SCOPES
  || 'openid profile email offline_access accounting.transactions accounting.contacts.read accounting.settings.read accounting.attachments.read';

function clientId() { return process.env.XERO_CLIENT_ID; }
function clientSecret() { return process.env.XERO_CLIENT_SECRET; }

function ensureConfig() {
  const missing = ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Xero is not configured. Missing: ${missing.join(', ')}`);
}

function basicAuthHeader() {
  return `Basic ${Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64')}`;
}

// The organisations Xero itself says this token can reach. Read-only, and a
// useful health check: it proves the borrowed grant still works, independently
// of what WazzOCR's connections table claims.
async function fetchTenants(accessToken) {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.detail || `Failed to fetch Xero connections (${res.status})`);
  return (Array.isArray(payload) ? payload : []).filter((c) => c.tenantType === 'ORGANISATION');
}

// ── Access tokens ───────────────────────────────────────────────────────────

const _accessCache = new Map();   // grantId -> { accessToken, expiresAt }
const _refreshInflight = new Map(); // grantId -> Promise<string>

// A live access token for this organisation, refreshing the shared grant when
// the cached one is stale.
//
// Two layers of mutual exclusion, because Xero refresh tokens are single-use:
// `_refreshInflight` coalesces callers inside this process, and the FOR UPDATE
// row lock in withGrantLock serialises separate Bills Hub processes.
async function accessTokenFor(accountId, tenantId) {
  ensureConfig();
  const wazzocrAccountId = await accounts.wazzocrIdFor(accountId);
  const grant = await xc.getGrantForTenant(wazzocrAccountId, tenantId);
  if (!grant) {
    const err = new Error('WazzOCR has no active Xero connection to this organisation. Reconnect Xero in WazzOCR.');
    err.statusCode = 401;
    throw err;
  }

  const cached = _accessCache.get(grant.grantId);
  if (cached && cached.expiresAt - Date.now() > 60000) return cached.accessToken;

  let inflight = _refreshInflight.get(grant.grantId);
  if (!inflight) {
    inflight = xc.withGrantLock(grant.grantId, async (currentRefreshToken) => {
      // Another process may have refreshed while we waited for the lock, in
      // which case currentRefreshToken is already the rotated one — but its
      // access token lives in that process's memory, not ours, so we still
      // refresh. Rotating again from the token we just read under the lock is
      // safe; what is not safe is refreshing from a token someone else has
      // already spent.
      const res = await fetch(`${IDENTITY_BASE}/token`, {
        method: 'POST',
        headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: currentRefreshToken }).toString()
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(payload.error_description || payload.error || `Xero token refresh failed (${res.status})`);
        err.statusCode = 401;
        throw err;
      }
      _accessCache.set(grant.grantId, {
        accessToken: payload.access_token,
        expiresAt: Date.now() + Number(payload.expires_in || 1800) * 1000
      });
      return { refreshToken: payload.refresh_token || null, result: payload.access_token };
    }).finally(() => _refreshInflight.delete(grant.grantId));
    _refreshInflight.set(grant.grantId, inflight);
  }
  return inflight;
}

// Drop a grant's cached access token (used after a 401 so the next call refreshes).
async function invalidateToken(accountId, tenantId) {
  try {
    const wazzocrAccountId = await accounts.wazzocrIdFor(accountId);
    const grant = await xc.getGrantForTenant(wazzocrAccountId, tenantId);
    if (grant) _accessCache.delete(grant.grantId);
  } catch { /* nothing cached to drop */ }
}

// ── API calls ───────────────────────────────────────────────────────────────

// Xero allows 60 calls/minute and 5 concurrent calls per tenant. Bills Hub syncs
// 40 orgs, so a per-tenant minute window plus a global concurrency gate keeps us
// inside both without the caller having to think about it.
const MAX_CONCURRENT = Number(process.env.XERO_MAX_CONCURRENT || 5);
const CALLS_PER_MIN = Number(process.env.XERO_CALLS_PER_MIN || 55);

let _active = 0;
const _waiting = [];
const _tenantCalls = new Map(); // tenantId -> number[] of call timestamps

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function acquire() {
  if (_active < MAX_CONCURRENT) { _active += 1; return Promise.resolve(); }
  return new Promise((resolve) => _waiting.push(resolve));
}

function release() {
  const next = _waiting.shift();
  if (next) next();
  else _active -= 1;
}

// Blocks until this tenant is under its per-minute call budget.
async function tenantBudget(tenantId) {
  for (;;) {
    const now = Date.now();
    const calls = (_tenantCalls.get(tenantId) || []).filter((t) => now - t < 60000);
    if (calls.length < CALLS_PER_MIN) {
      calls.push(now);
      _tenantCalls.set(tenantId, calls);
      return;
    }
    await sleep(60000 - (now - calls[0]) + 50);
  }
}

// One Xero API call, scoped to a tenant. Retries on 429 (honouring Retry-After)
// and once on 401 after forcing a token refresh.
async function api(accountId, tenantId, pathname, { method = 'GET', body, headers = {}, retries = 3 } = {}) {
  if (!tenantId) throw new Error('tenantId is required for Xero API calls.');

  for (let attempt = 0; ; attempt += 1) {
    const accessToken = await accessTokenFor(accountId, tenantId);
    await tenantBudget(tenantId);
    await acquire();
    let res;
    try {
      res = await fetch(`${API_BASE}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Xero-tenant-id': tenantId,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } finally {
      release();
    }

    if (res.status === 429 && attempt < retries) {
      const wait = Number(res.headers.get('Retry-After') || 60);
      await sleep((wait + 1) * 1000);
      continue;
    }
    if (res.status === 401 && attempt < retries) {
      await invalidateToken(accountId, tenantId);
      continue;
    }
    // 304 from If-Modified-Since: nothing changed since the cursor.
    if (res.status === 304) return null;

    const text = await res.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }

    if (!res.ok) {
      const err = new Error(formatError(payload, res.status) || text || `Xero request failed (${res.status})`);
      err.statusCode = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }
}

function formatError(payload, status) {
  if (!payload) return null;
  if (payload.Elements?.length) {
    const errs = payload.Elements.flatMap((e) => (e.ValidationErrors || []).map((v) => v.Message));
    if (errs.length) return errs.join(' ');
  }
  return payload.Message || payload.detail || payload.Detail || `Xero request failed (${status})`;
}

module.exports = { SCOPES, ensureConfig, fetchTenants, accessTokenFor, invalidateToken, api };
