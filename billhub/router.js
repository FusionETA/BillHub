// Bills module API. Everything is scoped to the logged-in user's account.
//
//   GET  /api/bills                 -> { stats, statusTabs, rows, metaText, banner, entities }
//   GET  /api/bills/entities        -> connected orgs, for the entity filter
//   GET  /api/bills/contacts        -> distinct suppliers, for the Contact filter
//   GET  /api/bills/:id             -> one bill, with its Xero line items
//   POST /api/bills/:id/submit      -> DRAFT      -> SUBMITTED in Xero
//   POST /api/bills/:id/approve     -> SUBMITTED  -> AUTHORISED in Xero
//   POST /api/bills/bulk            -> the same two actions over a selection
//   POST /api/bills/sync            -> pull from Xero now
//   GET  /api/bills/sync/status     -> per-org sync state
const express = require('express');
const router = express.Router();

const bills = require('../models/bills');
const entities = require('../models/entities');
const syncState = require('../models/syncState');
const vm = require('./viewModel');
const sync = require('./sync');
const xero = require('../lib/xero');
const accounts = require('../models/accounts');
const { attachUser, requireAuth } = require('../auth/middleware');

router.use(attachUser, requireAuth);

function needAccount(req, res) {
  if (!req.user.account_id) { res.status(400).json({ error: 'This user has no account.' }); return null; }
  return req.user.account_id;
}

// A Xero authorisation failure is not an app-session failure. Passing Xero's 401
// straight through would make the browser think the user had been signed out and
// bounce them to the login page, when what they actually need is to reconnect
// Xero. 424 keeps the two apart, and the flag tells the client which to say.
function fail(res, err, fallback = 500) {
  const xeroAuth = err.statusCode === 401;
  res.status(xeroAuth ? 424 : (err.statusCode || fallback))
     .json({ error: err.message, ...(xeroAuth ? { needsXeroReconnect: true } : {}) });
}

// Turn the query string into the filter object the model understands.
function filtersFrom(query) {
  const tenantIds = String(query.entities || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    status: query.status || 'all',
    tenantIds,
    contact: query.contact || null,
    search: query.q || null,
    amountFrom: query.amountFrom || null,
    amountTo: query.amountTo || null,
    dateType: query.dateType || null,   // bill | due | paid | (unset = any)
    dateFrom: query.dateFrom || null,
    dateTo: query.dateTo || null
  };
}

router.get('/', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const filters = filtersFrom(req.query);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const wazzocrAccountId = await accounts.wazzocrIdFor(accountId);
    const [rows, meta, counts, stats, entityRows, lastSynced] = await Promise.all([
      bills.list(accountId, wazzocrAccountId, filters, { limit, offset }),
      bills.listMeta(accountId, filters),
      bills.tabCounts(accountId, filters),
      bills.stats(accountId, filters),
      entities.listByAccount(accountId, wazzocrAccountId),
      syncState.lastSyncedAt(accountId)
    ]);

    const currency = req.account?.base_currency === 'MYR' ? 'RM' : (req.account?.base_currency || 'RM');
    const bannerData = vm.banner(stats, { currency });

    res.json({
      stats: vm.statCards(stats, currency),
      statusTabs: vm.statusTabs(counts),
      rows: rows.map(vm.billRow),
      metaText: vm.metaText(meta, entityRows.length, currency),
      bannerHead: bannerData?.head || '',
      bannerTail: bannerData?.tail || '',
      hasBanner: Boolean(bannerData),
      entities: entityRows.map((e) => ({ code: e.code, short: e.short_name, tenantId: e.xero_tenant_id })),
      entityCount: entityRows.length,
      currency,
      lastSyncedAt: lastSynced,
      page: { limit, offset, total: meta.count, hasMore: offset + rows.length < meta.count }
    });
  } catch (err) {
    console.error('[bills] list failed:', err.message);
    fail(res, err);
  }
});

// The entity list on its own, for the filter dropdown and the assign dialogs.
router.get('/entities', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const rows = await entities.listByAccount(accountId, await accounts.wazzocrIdFor(accountId));
    res.json({
      entities: rows.map((e) => ({
        tenantId: e.xero_tenant_id,
        code: e.code,
        short: e.short_name,
        name: e.tenant_name,
        needsReconnect: Boolean(e.needs_reconnect)
      }))
    });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/contacts', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const rows = await bills.contacts(accountId);
    res.json({ contacts: rows.map((r) => ({ name: r.name, count: Number(r.n) })) });
  } catch (err) {
    fail(res, err);
  }
});

// ── Sync ────────────────────────────────────────────────────────────────────

router.post('/sync', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const full = req.body?.full === true || req.query.full === 'true';
    const result = await sync.syncAccount(accountId, { full });
    res.json(result);
  } catch (err) {
    console.error('[bills] sync failed:', err.message);
    fail(res, err);
  }
});

router.get('/sync/status', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const rows = await syncState.listByAccount(accountId);
    res.json({
      lastSyncedAt: await syncState.lastSyncedAt(accountId),
      tenants: rows.map((r) => ({
        tenantId: r.xero_tenant_id,
        code: r.code,
        name: r.short_name || r.tenant_name,
        status: r.last_status,
        error: r.last_error,
        lastRunAt: r.last_run_at,
        billsUpserted: r.bills_upserted
      }))
    });
  } catch (err) {
    fail(res, err);
  }
});

// ── One bill ────────────────────────────────────────────────────────────────

// Line items aren't mirrored locally (the list doesn't need them), so the detail
// view reads them straight from Xero.
router.get('/:id(\\d+)', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const bill = await bills.getById(accountId, Number(req.params.id));
    if (!bill) return res.status(404).json({ error: 'Bill not found.' });

    let detail = null;
    try {
      const payload = await xero.api(accountId, bill.xero_tenant_id, `/Invoices/${bill.xero_invoice_id}`);
      detail = payload?.Invoices?.[0] || null;
    } catch (e) {
      // The row we already have is still worth showing if Xero is unreachable.
      console.error(`[bills] detail fetch failed for ${bill.xero_invoice_id}:`, e.message);
    }

    res.json({
      bill: vm.billRow({ ...bill, entity_code: null, entity_short: null }),
      lineItems: (detail?.LineItems || []).map((l) => ({
        description: l.Description,
        quantity: Number(l.Quantity || 0),
        unitAmount: Number(l.UnitAmount || 0),
        accountCode: l.AccountCode,
        taxType: l.TaxType,
        lineAmount: Number(l.LineAmount || 0)
      })),
      xeroStatus: detail?.Status || bill.xero_status
    });
  } catch (err) {
    fail(res, err);
  }
});

// ── Actions ─────────────────────────────────────────────────────────────────

// Xero only accepts a status it can legally move to, so each action states both
// the status it requires now and the one it sets.
const TRANSITIONS = {
  submit:  { from: 'DRAFT',     to: 'SUBMITTED',  uiFrom: 'draft' },
  approve: { from: 'SUBMITTED', to: 'AUTHORISED', uiFrom: 'approval' }
};

// Push one status change to Xero, then mirror it locally. Xero stays the source
// of truth — the local row is only updated after Xero has accepted the change.
async function transition(accountId, bill, action) {
  const t = TRANSITIONS[action];
  if (!t) throw Object.assign(new Error(`Unknown action "${action}".`), { statusCode: 400 });
  if (bill.xero_status !== t.from) {
    throw Object.assign(
      new Error(`Bill is ${bill.xero_status.toLowerCase()} in Xero, so it cannot be ${action === 'submit' ? 'submitted' : 'approved'}.`),
      { statusCode: 409 }
    );
  }

  await xero.api(accountId, bill.xero_tenant_id, '/Invoices', {
    method: 'POST',
    body: { Invoices: [{ InvoiceID: bill.xero_invoice_id, Status: t.to }] }
  });
  await bills.applyStatus(accountId, bill.id, t.to);
  return t.to;
}

for (const action of Object.keys(TRANSITIONS)) {
  router.post(`/:id(\\d+)/${action}`, async (req, res) => {
    const accountId = needAccount(req, res); if (!accountId) return;
    try {
      const bill = await bills.getById(accountId, Number(req.params.id));
      if (!bill) return res.status(404).json({ error: 'Bill not found.' });
      const status = await transition(accountId, bill, action);
      res.json({ ok: true, id: bill.id, xeroStatus: status });
    } catch (err) {
      console.error(`[bills] ${action} failed:`, err.message);
      fail(res, err);
    }
  });
}

// Bulk submit/approve. Each bill is attempted independently so one rejection
// doesn't strand the rest, and the response says exactly which ones moved.
router.post('/bulk', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  const { action, ids } = req.body || {};
  if (!TRANSITIONS[action]) return res.status(400).json({ error: 'action must be "submit" or "approve".' });
  const idList = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  if (!idList.length) return res.status(400).json({ error: 'No bills selected.' });
  if (idList.length > 200) return res.status(400).json({ error: 'Select at most 200 bills at a time.' });

  try {
    const rows = await bills.getManyByIds(accountId, idList);
    const found = new Map(rows.map((r) => [r.id, r]));
    const succeeded = [];
    const failed = [];

    for (const id of idList) {
      const bill = found.get(id);
      if (!bill) { failed.push({ id, error: 'Bill not found.' }); continue; }
      try {
        await transition(accountId, bill, action);
        succeeded.push(id);
      } catch (err) {
        failed.push({
          id,
          reference: bill.reference || bill.invoice_number,
          error: err.message,
          ...(err.statusCode === 401 ? { needsXeroReconnect: true } : {})
        });
      }
    }
    res.json({ action, succeeded, failed, total: idList.length });
  } catch (err) {
    console.error('[bills] bulk failed:', err.message);
    fail(res, err);
  }
});

module.exports = router;
