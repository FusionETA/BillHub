// Intercompany recharge API.
//
//   GET    /api/recharge                    the Recharge view model
//   GET    /api/recharge/suggestions        paid bills a rule covers, not yet recharged
//   PATCH  /api/recharge/settings           account codes, tax type, reference prefix
//   GET/POST/PATCH/DELETE /api/recharge/rules[/:id]
//   POST   /api/recharge/plan               dry-run a recharge
//   POST   /api/recharge/runs               create one (nothing in Xero yet)
//   POST   /api/recharge/runs/:id/post      create the documents in Xero
//   POST   /api/recharge/runs/:id/cancel
//   POST   /api/recharge/runs/:id/lines/:lineId/settle
const express = require('express');
const router = express.Router();

const recharge = require('./recharge');
const model = require('../models/recharge');
const entities = require('../models/entities');
const grantSource = require('../lib/grantSource');
const vm = require('./viewModel');
const { attachUser, requireAuth } = require('../auth/middleware');

router.use(attachUser, requireAuth);

function needAccount(req, res) {
  if (!req.user.account_id) { res.status(400).json({ error: 'This user has no account.' }); return null; }
  return req.user.account_id;
}
// The label for money on screen: the organisations' own base currency, or
// nothing at all when they disagree — see models/entities.currencyFor.
async function currencyFor(req) {
  const connAccountId = await grantSource.connectionsAccountId(req.user.account_id);
  return entities.currencyFor(req.user.account_id, connAccountId);
}

function fail(res, err, fallback = 500) {
  const xeroAuth = err.statusCode === 401;
  res.status(xeroAuth ? 424 : (err.statusCode || fallback))
     .json({ error: err.message, ...(xeroAuth ? { needsXeroReconnect: true } : {}) });
}

router.get('/', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const cur = await currencyFor(req);
    const currency = cur.symbol;
    const [runs, rules, stats, settings] = await Promise.all([
      model.listRuns(accountId, { status: req.query.status || null }),
      model.listRules(accountId),
      model.summary(accountId),
      model.getSettings(accountId)
    ]);
    let pending = [];
    try { pending = await recharge.suggestions(accountId, { limit: 20 }); } catch { /* rules may be unusable */ }

    res.json({
      rechargeStats: vm.rechargeStatCards(stats, currency),
      rechargeTabs: [
        { value: 'runs', label: 'Recharge runs', count: runs.length },
        { value: 'rules', label: 'Rules', count: rules.length }
      ],
      runCards: runs.map((r) => vm.rechargeRunCard(r, currency)),
      ruleCards: rules.map(vm.rechargeRuleCard),
      settings: vm.rechargeSettings(settings),
      suggestions: pending.map((p) => vm.rechargeSuggestion(p, currency)),
      currency
    });
  } catch (err) {
    console.error('[recharge] view failed:', err.message);
    fail(res, err);
  }
});

router.get('/suggestions', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const cur = await currencyFor(req);
    const currency = cur.symbol;
    const out = await recharge.suggestions(accountId, { limit: Math.min(Number(req.query.limit) || 50, 200) });
    res.json({ suggestions: out.map((p) => vm.rechargeSuggestion(p, currency)) });
  } catch (err) { fail(res, err); }
});

router.patch('/settings', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    await model.updateSettings(accountId, req.body || {});
    res.json({ ok: true, settings: vm.rechargeSettings(await model.getSettings(accountId)) });
  } catch (err) { fail(res, err, 400); }
});

// ── Rules ───────────────────────────────────────────────────────────────────

router.get('/rules', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    res.json({ rules: (await model.listRules(accountId)).map(vm.rechargeRuleCard) });
  } catch (err) { fail(res, err); }
});

router.post('/rules', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const id = await model.createRule(accountId, req.body || {});
    res.status(201).json({ ok: true, rule: vm.rechargeRuleCard(await model.getRule(accountId, id)) });
  } catch (err) { fail(res, err, 400); }
});

router.patch('/rules/:id(\\d+)', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    await model.updateRule(accountId, Number(req.params.id), req.body || {});
    res.json({ ok: true, rule: vm.rechargeRuleCard(await model.getRule(accountId, Number(req.params.id))) });
  } catch (err) { fail(res, err, 400); }
});

router.delete('/rules/:id(\\d+)', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const n = await model.deleteRule(accountId, Number(req.params.id));
    if (!n) return res.status(404).json({ error: 'Rule not found.' });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// ── Runs ────────────────────────────────────────────────────────────────────

// Everything createRun would check, plus the split, without writing anything.
router.post('/plan', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const cur = await currencyFor(req);
    const currency = cur.symbol;
    const plan = await recharge.planRun(accountId, req.body || {});
    res.json({
      bill: {
        id: plan.bill.id,
        supplier: plan.bill.contact_name,
        reference: plan.bill.reference || plan.bill.invoice_number,
        total: vm.money(plan.bill.total),
        paidOn: plan.bill.fully_paid_on
      },
      payer: plan.payer ? { code: plan.payer.code, shortName: plan.payer.short_name } : null,
      lines: plan.lines.map((l) => ({
        tenantId: l.tenantId, code: l.code, shortName: l.shortName,
        sharePercent: l.sharePercent, amount: vm.money(l.amount), reference: l.reference
      })),
      total: vm.money(plan.total),
      currency
    });
  } catch (err) { fail(res, err, 400); }
});

router.post('/runs', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const out = await recharge.createRun(accountId, req.body || {});
    // Posting straight away is opt-in: a recharge creates real documents in two
    // organisations, so the default is to look at it first.
    let posted = null;
    if ((req.body || {}).post === true) posted = await recharge.postRun(accountId, out.id);
    res.status(201).json({ ok: true, id: out.id, total: out.total, posted });
  } catch (err) {
    console.error('[recharge] create run failed:', err.message);
    fail(res, err, 400);
  }
});

router.post('/runs/:id(\\d+)/post', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    res.json({ ok: true, ...(await recharge.postRun(accountId, Number(req.params.id))) });
  } catch (err) {
    console.error('[recharge] post failed:', err.message);
    fail(res, err);
  }
});

router.post('/runs/:id(\\d+)/cancel', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const n = await model.cancelRun(accountId, Number(req.params.id));
    if (!n) return res.status(409).json({ error: 'Only a recharge that has not reached Xero can be cancelled.' });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

router.post('/runs/:id(\\d+)/lines/:lineId(\\d+)/settle', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const status = await model.settleLine(accountId, Number(req.params.id), Number(req.params.lineId), req.body || {});
    res.json({ ok: true, status });
  } catch (err) { fail(res, err); }
});

module.exports = router;
