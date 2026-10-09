// Intercompany recharge API.
//
//   GET    /api/recharge                    the Recharge view model
//   GET    /api/recharge/suggestions        paid bills a rule covers, not yet recharged
//   GET    /api/recharge/bills/:id/decide   what would happen to one bill, and why
//   PATCH  /api/recharge/settings           tax type, reference prefix, due days,
//                                          and optional account-code overrides
//   GET/POST/PATCH/DELETE /api/recharge/rules[/:id]
//   POST   /api/recharge/plan               dry-run a recharge
//   POST   /api/recharge/runs               create one (nothing in Xero yet)
//   POST   /api/recharge/runs/:id/post      create the documents in Xero
//   POST   /api/recharge/runs/:id/cancel
const express = require('express');
const router = express.Router();

const recharge = require('./recharge');
const model = require('../models/recharge');
const entities = require('../models/entities');
const grantSource = require('../lib/grantSource');
const vm = require('./viewModel');
const testMode = require('../lib/testMode');
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
    // Xero's own code for each organisation, so a link into Xero opens the
    // right one rather than whichever the person was last in.
    const codes = await entities.shortCodes(accountId);
    // While testing mode is on, runs worked out under it are shown alongside
    // the real ones; afterwards they disappear, the same as a test batch.
    const testing = await testMode.isOn(accountId);
    const [runs, rules, textRules, stats, settings] = await Promise.all([
      model.listRuns(accountId, { status: req.query.status || null, includeTest: testing }),
      model.listRules(accountId),
      model.listTextRules(accountId),
      model.summary(accountId, { includeTest: testing }),
      model.getSettings(accountId)
    ]);
    let pending = [];
    let waiting = new Map();
    try {
      pending = await recharge.suggestions(accountId, { limit: 20 });
      if (textRules.length) waiting = await recharge.waitingCounts(accountId);
    } catch (e) {
      // A rule set that cannot be evaluated must not take the whole page
      // down with it — the rules still have to be reachable to be fixed.
      console.error('[recharge] could not evaluate rules:', e.message);
    }

    res.json({
      rechargeStats: vm.rechargeStatCards(stats, currency),
      rechargeTabs: [
        { value: 'runs', label: 'Recharge runs', count: runs.length },
        { value: 'rules', label: 'Supplier rules', count: rules.length },
        { value: 'text', label: 'Recharge rules', count: textRules.length }
      ],
      runRows: runs.map((r) => vm.rechargeRunRow(r, { currency, shortCodes: codes })),
      ruleCards: rules.map(vm.rechargeRuleCard),
      textRuleCards: textRules.map((r) => vm.rechargeTextRuleCard(r, waiting.get(r.id) || 0)),
      settings: vm.rechargeSettings(settings),
      suggestions: pending.map((p) => vm.rechargeSuggestion(p, currency)),
      // Bills a rule should have covered and did not. Reported rather than
      // left silent — a rule that never fires looks exactly like a rule that
      // had nothing to do.
      unmatched: (pending.unmatched || []).map((u) => ({
        billId: u.bill.id,
        supplier: u.bill.contact_name,
        reference: u.bill.reference || u.bill.invoice_number,
        totalFmt: vm.money(u.bill.total),
        address: u.bill.premises_address || null
      })),
      // What a recharge rule can test, and how. Sent rather than hardcoded in
      // the browser so the dialog can never offer a field the engine does
      // not understand.
      conditionFields: model.FIELDS,
      conditionOperators: model.OPERATORS,
      testMode: testing,
      // For the rule dialog's supplier field. A rule matches on the Xero
      // contact name, so offering the names that actually exist is the
      // difference between a rule that fires and one that silently never does.
      suppliers: (await require('../models/bills').contacts(accountId)).map((c) => c.contact_name || c.name || c).filter(Boolean),
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

// What the four steps say about one bill, without writing anything. The Bills
// tab asks this when someone is about to mark a bill paid, so the dialog can
// say which premises it matched and why the cost is moving.
router.get('/bills/:id(\\d+)/decide', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const bills = require('../models/bills');
    const [bill] = await bills.getManyByIds(accountId, [Number(req.params.id)]);
    if (!bill) return res.status(404).json({ error: 'Bill not found.' });
    const verdict = await recharge.decide(accountId, bill);
    res.json({
      billId: bill.id,
      supplier: bill.contact_name,
      reference: bill.reference || bill.invoice_number,
      totalFmt: vm.money(bill.total),
      outcome: verdict.outcome,
      reason: verdict.reason,
      consequence: verdict.consequence || verdict.reason,
      address: verdict.address || null,
      ownerTenantId: verdict.ownerTenantId || null,
      ownerCode: verdict.ownerCode || null,
      ownerShort: verdict.ownerShort || null,
      ruleId: verdict.rule ? verdict.rule.id : null,
      currency: (await currencyFor(req)).symbol
    });
  } catch (err) { fail(res, err); }
});

// The same question for a whole selection, in one call. The Pay dialog asks
// this before anything is paid, so it can say which of these bills will move
// a cost to another company and why — `assumePaid` is what makes that a
// sensible question to ask of a bill that is still awaiting payment.
router.post('/decide', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  const ids = (req.body || {}).billIds;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'billIds is required.' });
  try {
    const billsModel = require('../models/bills');
    const rows = await billsModel.getManyByIds(accountId, ids.slice(0, 200).map(Number));
    const rules = await recharge.loadRules(accountId);
    const assumePaid = (req.body || {}).assumePaid !== false;

    const out = [];
    for (const bill of rows) {
      const v = await recharge.decide(accountId, bill, { rules, assumePaid });
      out.push({
        billId: bill.id,
        supplier: bill.contact_name,
        reference: bill.reference || bill.invoice_number,
        totalFmt: vm.money(bill.total),
        outcome: v.outcome,
        reason: v.reason,
        consequence: v.consequence || v.reason,
        address: v.address || null,
        ownerCode: v.ownerCode || null,
        ownerShort: v.ownerShort || null
      });
    }
    res.json({ decisions: out, currency: (await currencyFor(req)).symbol });
  } catch (err) {
    console.error('[recharge] decide failed:', err.message);
    fail(res, err);
  }
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

// ── Recharge rules ──────────────────────────────────────────────────────────

router.get('/text-rules', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const rules = await model.listTextRules(accountId);
    const waiting = rules.length ? await recharge.waitingCounts(accountId) : new Map();
    res.json({ rules: rules.map((r) => vm.rechargeTextRuleCard(r, waiting.get(r.id) || 0)) });
  } catch (err) { fail(res, err); }
});

// Whether a rule's conditions pick out the bills somebody means.
//
// Not "how many will this draft": a rule acts on bills marked paid after it
// was written, so for a rule that does not exist yet the answer is always
// none. What the dialog needs is confirmation that the conditions are
// right, which the bills already paid can give — so this matches them
// ignoring that test, and says plainly that those ones are behind it.
router.post('/text-rules/preview', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const body = req.body || {};
    const draft = {
      id: 0,
      conditions: (body.conditions || []).filter((c) => c && c.field && String(c.value || '').trim()),
      match_mode: body.matchMode === 'any' ? 'any' : 'all',
      payer_tenant_id: body.payerTenantId || null,
      owner_tenant_id: body.ownerTenantId || null,
      // A rule being typed has not been written yet, so nothing is behind
      // it: the preview shows what it would catch from here on.
      created_at: new Date()
    };
    if (!draft.conditions.length || !draft.owner_tenant_id) {
      return res.json({ count: 0, bills: [], incomplete: true });
    }
    const bills = await recharge.waitingFor(accountId, draft, { limit: 200, ignoreWritten: true });
    res.json({
      count: bills.length,
      incomplete: false,
      // Every one of them is already paid, so the rule will not touch any.
      alreadyPaid: true,
      bills: bills.slice(0, 8).map((b) => ({
        id: b.id, supplier: b.contact_name,
        reference: b.reference || b.invoice_number,
        totalFmt: vm.money(b.total),
        paidFmt: b.fully_paid_on ? vm.shortDate(b.fully_paid_on) : '—'
      }))
    });
  } catch (err) {
    console.error('[recharge] rule preview failed:', err.message);
    fail(res, err, 400);
  }
});

router.post('/text-rules', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const id = await model.createTextRule(accountId, req.body || {});
    // Saving a rule only creates the rule. It acts on bills marked paid
    // after this moment and on nothing before it, so there is nothing to
    // sweep up here.
    const rule = await model.getTextRule(accountId, id);
    res.status(201).json({ ok: true, id, rule: vm.rechargeTextRuleCard(rule, 0) });
  } catch (err) {
    console.error('[recharge] create rule failed:', err.message);
    fail(res, err, 400);
  }
});

router.patch('/text-rules/:id(\\d+)', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    await model.updateTextRule(accountId, Number(req.params.id), req.body || {});
    const rule = await model.getTextRule(accountId, Number(req.params.id));
    res.json({ ok: true, rule: vm.rechargeTextRuleCard(rule, 0) });
  } catch (err) { fail(res, err, 400); }
});

router.delete('/text-rules/:id(\\d+)', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const n = await model.deleteTextRule(accountId, Number(req.params.id));
    if (!n) return res.status(404).json({ error: 'Rule not found.' });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// Draft a recharge for every bill this rule is waiting on. Drafts only —
// nothing reaches Xero until each one is posted.
router.post('/text-rules/:id(\\d+)/run', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    res.json({ ok: true, ...(await recharge.runTextRule(accountId, Number(req.params.id))) });
  } catch (err) {
    console.error('[recharge] run rule failed:', err.message);
    fail(res, err);
  }
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
      address: plan.address || null,
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

    // Posting in the same call is what the suggestion list asks for: working
    // the recharge out and then leaving it for a second click only made
    // sense while the first click did something a person needed to read.
    // The suggestion already says the entity, the amount and the reason.
    //
    // A run worked out under testing mode can never be posted, so asking to
    // post one is answered by not trying rather than by an error — the
    // point of testing mode is that the rest of the flow still runs.
    let posted = null;
    if ((req.body || {}).post === true && !(await testMode.isOn(accountId))) {
      posted = await recharge.postRun(accountId, out.id);
    }
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

module.exports = router;
