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
// A bill carries its supplier's name as a copy, taken when the bill last
// changed. That is what makes the list fast — no join across 36,000 rows — but
// it means the name only refreshes when the *invoice* does. A contact renamed
// or merged in Xero need not touch the invoices that reference it, and then the
// copy is wrong for good.
//
// So contacts get a pass of their own, with their own cursor: ask Xero which
// ones changed, and correct the copies. Usually a single call answering 304.
async function refreshContactNames(accountId, tenantId, cursor, full) {
  const bills = require('../models/bills');
  const db = require('../db');
  const since = full || !cursor ? null : new Date(new Date(cursor).getTime() - 60000);

  let corrected = 0;
  let newest = cursor ? new Date(cursor) : null;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const payload = await xero.api(accountId, tenantId, `/Contacts?page=${page}`, {
      headers: since ? { 'If-Modified-Since': toXeroDateHeader(since) } : {}
    });
    if (payload === null) break;                 // 304: nothing has changed
    const list = payload.Contacts || [];
    if (!list.length) break;

    for (const c of list) {
      if (!c.ContactID || !c.Name) continue;
      const name = bills.fit(c.Name, 'contact_name');
      // The <> is what keeps this cheap: the overwhelming majority of contacts
      // in a page have not actually changed name.
      const res = await db.execute(
        `UPDATE bills SET contact_name = ?
          WHERE account_id = ? AND xero_tenant_id = ? AND contact_id = ? AND contact_name <> ?`,
        [name, accountId, tenantId, c.ContactID, name]
      );
      corrected += res.affectedRows;
      const u = c.UpdatedDateUTC ? parseXeroDate(c.UpdatedDateUTC) : null;
      if (u && (!newest || u > newest)) newest = u;
    }
    if (list.length < 100) break;                // Xero pages contacts at 100
  }

  return { corrected, cursor: newest };
}

async function syncTenant(accountId, tenantId, tenantName, { full = false, intercoNames = new Set(), knownCurrency = null } = {}) {
  await entities.ensure(accountId, tenantId, tenantName);
  await syncState.markRunning(accountId, tenantId);

  try {
    // Each organisation has its own base currency and the UI labels figures
    // with it. Asked once, then only on a full re-read — it changes ~never.
    if (!knownCurrency || full) {
      try {
        const org = await xero.api(accountId, tenantId, '/Organisation');
        const code = org?.Organisations?.[0]?.BaseCurrency;
        if (code) await entities.setBaseCurrency(accountId, tenantId, code);
      } catch (e) {
        console.error(`[sync] could not read the base currency for ${tenantName || tenantId}: ${e.message}`);
      }
    }
    const state = await syncState.get(accountId, tenantId);
    // Re-read from a minute before the cursor: Xero's UpdatedDateUTC has
    // sub-second precision and If-Modified-Since is exclusive, so an exact
    // cursor can drop a bill updated in the same second as the last one seen.
    const since = full || !state?.cursor_utc
      ? null
      : new Date(new Date(state.cursor_utc).getTime() - 60000);

    let upserted = 0;
    let skipped = 0;
    let firstSkip = null;
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
        try {
          await bills.upsertFromXero(accountId, tenantId, inv, {
            isInterco: contactName ? intercoNames.has(contactName.trim().toLowerCase()) : false
          });
          upserted += 1;
        } catch (e) {
          // Whatever is wrong with this one bill, it is not a reason to lose the
          // other two thousand. Skip it, count it, and let the run finish —
          // an organisation that syncs 1999 of 2000 bills is worth far more
          // than one that reports a clean failure and holds nothing.
          skipped += 1;
          if (!firstSkip) firstSkip = `${inv.InvoiceID}: ${e.message}`;
          console.error(`[sync] ${tenantName || tenantId}: skipped ${inv.InvoiceID} — ${e.message}`);
          continue;
        }
        const u = inv.UpdatedDateUTC ? parseXeroDate(inv.UpdatedDateUTC) : null;
        if (u && (!maxUpdated || u > maxUpdated)) maxUpdated = u;
      }

      if (list.length < PAGE_SIZE) break;
    }

    // Not fatal: a bill with last week's spelling of a supplier is worth far
    // more than a sync that refused to finish over it.
    let renamed = 0;
    try {
      const out = await refreshContactNames(accountId, tenantId, state?.contacts_cursor_utc, full);
      renamed = out.corrected;
      if (out.cursor) {
        await syncState.markContactsCursor(accountId, tenantId,
          out.cursor.toISOString().slice(0, 19).replace('T', ' '));
      }
    } catch (e) {
      console.error(`[sync] ${tenantName || tenantId}: contact names not refreshed — ${e.message}`);
    }
    if (renamed) console.log(`[sync] ${tenantName || tenantId}: ${renamed} bill(s) had a supplier name corrected.`);

    await syncState.markOk(
      accountId, tenantId,
      maxUpdated ? maxUpdated.toISOString().slice(0, 19).replace('T', ' ') : null,
      upserted,
      // Recorded against a successful run, because the organisation did sync.
      // The cursor has moved past these, so recovering them needs --full.
      skipped ? `${skipped} bill(s) skipped; first was ${firstSkip}. Re-read with: node scripts/sync-bills.js --full` : null
    );
    return { tenantId, tenantName, upserted, skipped, renamed, pages, ok: true };
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

  const startedAt = Date.now();
  const results = [];
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      results.push(await syncTenant(accountId, t.xero_tenant_id, t.tenant_name,
        { full, intercoNames, knownCurrency: t.base_currency }));
    }
  });
  await Promise.all(workers);

  const upserted = results.reduce((sum, r) => sum + r.upserted, 0);
  const failed = results.filter((r) => !r.ok);
  // The duration is the number worth watching: a first run reads everything,
  // an incremental one should be a fraction of it. Without it in the log there
  // is no way to tell a slow sync from a large one.
  const took = ((Date.now() - startedAt) / 1000).toFixed(1);
  const skipped = results.reduce((sum, r) => sum + (r.skipped || 0), 0);
  const renamed = results.reduce((sum, r) => sum + (r.renamed || 0), 0);
  console.log(`[sync] account ${accountId}: ${results.length} org(s), ${upserted} bill(s) in ${took}s${renamed ? `, ${renamed} renamed` : ''}${skipped ? `, ${skipped} skipped` : ''}${failed.length ? `, ${failed.length} failed` : ''}`);
  return { tenants: results.length, upserted, skipped, renamed, failed: failed.length, tookSeconds: Number(took), results };
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
