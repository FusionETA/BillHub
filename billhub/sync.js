// Pulls ACCPAY invoices (supplier bills) from every connected Xero org into the
// local `bills` table.
//
// Incremental by default: each tenant keeps a cursor (Xero's UpdatedDateUTC high
// -water mark) which is sent back as If-Modified-Since, so a routine run only
// transfers what changed. A full run ignores the cursor and re-reads everything.
//
//   const sync = require('./billhub/sync');
//   await sync.syncAccount(accountId);              // incremental, all tenants
//   await sync.syncAccount(accountId, { full: true });

const xero = require('../lib/xero');
const grantSource = require('../lib/grantSource');
const entities = require('../models/entities');
const bills = require('../models/bills');
const syncState = require('../models/syncState');
const accounts = require('../models/accounts');

// Xero returns 100 invoices per page on the Invoices endpoint.
const PAGE_SIZE = 100;
// Stop after this many pages per tenant, so a misbehaving cursor can't spin
// forever. 200 pages = 20,000 bills, well past any real month's volume.
const MAX_PAGES = Number(process.env.SYNC_MAX_PAGES || 200);

// One tenant can be syncing at a time per account; the Xero client already caps
// overall concurrency, this just keeps the progress log readable.
const CONCURRENCY = Number(process.env.SYNC_CONCURRENCY || 4);

function toXeroDateHeader(d) {
  // If-Modified-Since wants an ISO-ish UTC datetime without the trailing Z.
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 19);
}

// Sync one organisation. Returns { tenantId, upserted, pages, skipped }.
async function syncTenant(accountId, tenantId, tenantName, { full = false, intercoNames = new Set() } = {}) {
  await entities.ensure(accountId, tenantId, tenantName);
  await syncState.markRunning(accountId, tenantId);

  try {
    const state = await syncState.get(accountId, tenantId);
    // Re-read from a minute before the cursor: Xero's UpdatedDateUTC has
    // sub-second precision and If-Modified-Since is exclusive, so an exact
    // cursor can drop a bill updated in the same second as the last one seen.
    const since = full || !state?.cursor_utc
      ? null
      : new Date(new Date(state.cursor_utc).getTime() - 60000);

    let upserted = 0;
    let pages = 0;
    let maxUpdated = state?.cursor_utc ? new Date(state.cursor_utc) : null;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const qs = new URLSearchParams({
        where: 'Type=="ACCPAY"',
        page: String(page),
        pageSize: String(PAGE_SIZE),
        order: 'UpdatedDateUTC ASC',
        // Line items aren't shown in the list, and summaryOnly makes the call
        // far cheaper against Xero's rate limit.
        summaryOnly: 'true'
      });
      const payload = await xero.api(accountId, tenantId, `/Invoices?${qs}`, {
        headers: since ? { 'If-Modified-Since': toXeroDateHeader(since) } : {}
      });

      // 304: nothing has changed since the cursor.
      if (payload === null) break;

      const list = payload.Invoices || [];
      pages = page;
      if (!list.length) break;

      for (const inv of list) {
        if (!inv.InvoiceID) continue;
        const contactName = inv.Contact?.Name || '';
        await bills.upsertFromXero(accountId, tenantId, inv, {
          isInterco: contactName ? intercoNames.has(contactName.trim().toLowerCase()) : false
        });
        upserted += 1;
        const u = inv.UpdatedDateUTC ? parseXeroDate(inv.UpdatedDateUTC) : null;
        if (u && (!maxUpdated || u > maxUpdated)) maxUpdated = u;
      }

      if (list.length < PAGE_SIZE) break;
    }

    await syncState.markOk(
      accountId, tenantId,
      maxUpdated ? maxUpdated.toISOString().slice(0, 19).replace('T', ' ') : null,
      upserted
    );
    return { tenantId, tenantName, upserted, pages, ok: true };
  } catch (err) {
    // A tenant whose grant has gone stale shouldn't fail the whole run — record
    // it here and let the other 39 finish. The needs_reconnect flag belongs to
    // WazzOCR, which owns the connection; Bills Hub only ever reads it.
    await syncState.markError(accountId, tenantId, err.message).catch(() => {});
    console.error(`[sync] ${tenantName || tenantId}: ${err.message}`);
    return { tenantId, tenantName, upserted: 0, ok: false, error: err.message };
  }
}

function parseXeroDate(v) {
  const ms = /\/Date\((-?\d+)/.exec(v);
  const d = ms ? new Date(Number(ms[1])) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Sync every connected org for an account, a few at a time.
async function syncAccount(accountId, { full = false, tenantIds = null } = {}) {
  const wazzocrAccountId = await grantSource.connectionsAccountId(accountId);
  let targets = await entities.listSyncable(accountId, wazzocrAccountId);
  if (tenantIds && tenantIds.length) {
    const want = new Set(tenantIds);
    targets = targets.filter((t) => want.has(t.xero_tenant_id));
  }
  if (!targets.length) return { tenants: 0, upserted: 0, results: [] };

  // Bills addressed to another connected org are intercompany. Matching on the
  // Xero contact name is the only link available on a summary-only invoice.
  const intercoNames = new Set();
  for (const t of targets) {
    if (t.tenant_name) intercoNames.add(t.tenant_name.trim().toLowerCase());
    if (t.short_name) intercoNames.add(t.short_name.trim().toLowerCase());
  }

  const results = [];
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      results.push(await syncTenant(accountId, t.xero_tenant_id, t.tenant_name, { full, intercoNames }));
    }
  });
  await Promise.all(workers);

  const upserted = results.reduce((sum, r) => sum + r.upserted, 0);
  const failed = results.filter((r) => !r.ok);
  console.log(`[sync] account ${accountId}: ${results.length} org(s), ${upserted} bill(s)${failed.length ? `, ${failed.length} failed` : ''}`);
  return { tenants: results.length, upserted, failed: failed.length, results };
}

// ── Background schedule ─────────────────────────────────────────────────────

let timer = null;

// Runs syncAccount for every account on an interval. Started from server.js
// unless SYNC_INTERVAL_MINUTES is 0.
function startScheduler({ intervalMinutes = Number(process.env.SYNC_INTERVAL_MINUTES || 15) } = {}) {
  if (!intervalMinutes || timer) return;
  const db = require('../db');
  const tick = async () => {
    try {
      const accounts = await db.query("SELECT id FROM accounts WHERE status <> 'suspended'");
      for (const a of accounts) {
        await syncAccount(a.id).catch((e) => console.error(`[sync] account ${a.id}:`, e.message));
      }
    } catch (err) {
      console.error('[sync] scheduler tick failed:', err.message);
    }
  };
  timer = setInterval(tick, intervalMinutes * 60000);
  if (timer.unref) timer.unref();
  console.log(`[sync] scheduler every ${intervalMinutes} min`);
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { syncTenant, syncAccount, startScheduler, stopScheduler };
