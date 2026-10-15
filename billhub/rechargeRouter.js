// Intercompany recharge API.
//
//   GET    /api/recharge                    the Recharge view model
//   GET    /api/recharge/suggestions        paid bills a rule covers, not yet recharged
//   GET    /api/recharge/bills/:id/decide   what would happen to one bill, and why
//   PATCH  /api/recharge/settings           tax type, reference prefix, due days,
//                                          and optional account-code overrides
//   GET    /api/recharge/premises?address=…&address=…&supplier=…
//                                          WazzOCR: where does this bill go?
//   GET    /api/recharge/accounts/:tenantId  one organisation's chart of accounts
//   GET    /api/recharge/contacts/:tenantId  one organisation's supplier contacts
//   GET/POST/PATCH/DELETE /api/recharge/address-rules[/:id]   the premises register
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

// WazzOCR is a server, not a browser, so it has no session cookie. A shared
// token lets it — and only it — reach the premises lookup.
//
// Deliberately narrow: accepted on that one GET and nowhere else, read-only,
// and it never stands in for a user. Everything that changes anything still
// needs a real session.
//
// BILLHUB_SERVICE_TOKEN unset means no service caller is expected and the
// header is ignored entirely, so a deployment cannot be opened up by
// forgetting to set something.
const SERVICE_PATHS = new Set(['/premises']);

function serviceAccountId(req) {
  if (req.method !== 'GET' || !SERVICE_PATHS.has(req.path)) return null;
  const expected = String(process.env.BILLHUB_SERVICE_TOKEN || '');
  if (!expected) return null;
  const given = String(req.get('X-Billhub-Token') || '');
  // Same length and constant time, so a wrong token cannot be narrowed down
  // by how long the comparison takes.
  if (given.length !== expected.length) return null;
  if (!require('crypto').timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;
  return Number(process.env.BILLHUB_SERVICE_ACCOUNT_ID || 1);
}

// A valid service token stands in for the session guard; anything else goes
// through the normal chain untouched. One middleware rather than two, so
// there is no order in which a request could slip past both.
router.use((req, res, next) => {
  const id = serviceAccountId(req);
  if (id) { req.serviceAccountId = id; return next(); }
  attachUser(req, res, (err) => (err ? next(err) : requireAuth(req, res, next)));
});

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
    const [runs, addressRules, textRules, stats, settings] = await Promise.all([
      model.listRuns(accountId, { status: req.query.status || null, includeTest: testing }),
      model.listAddressRules(accountId),
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
        { value: 'rules', label: 'Address rules', count: addressRules.length },
        { value: 'text', label: 'Recharge rules', count: textRules.length }
      ],
      runRows: runs.map((r) => vm.rechargeRunRow(r, { currency, shortCodes: codes })),
      addressRuleRows: addressRules.map(vm.addressRuleRow),
      textRuleCards: textRules.map((r) => vm.rechargeTextRuleCard(r, waiting.get(r.id) || 0)),
      settings: vm.rechargeSettings(settings),
      suggestions: pending.map((p) => vm.rechargeSuggestion(p, currency)),
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

// The accounts one organisation can post to, for the rule dialog's two
// account fields. One organisation per call: the two sides of a recharge land
// in two different charts, and the dialog asks for whichever it needs.
router.get('/accounts/:tenantId', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const accounts = await recharge.chartOfAccounts(accountId, req.params.tenantId);
    res.json({ accounts });
  } catch (err) {
    // Not fatal to the dialog: it falls back to a plain text box and says so.
    // A chart that cannot be read must not stop a rule being written.
    console.error('[recharge] chart of accounts failed:', err.message);
    res.status(200).json({ accounts: [], error: err.message });
  }
});

// The suppliers one organisation buys from, for the address-rule dialog.
// Asked per organisation rather than shipped whole: a contact belongs to one
// Xero organisation, and a row that already says who pays should not be
// offered the other forty-two organisations' contacts.
router.get('/contacts/:tenantId', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  const tenantId = req.params.tenantId;
  // Everything Xero has, UNION what has already billed here.
  //
  // Xero is the real answer: a register row usually names a contact created
  // for the purpose, with no bills against it yet, and a list built from
  // bills cannot contain it. The bills are added anyway so the list survives
  // a Xero call that fails, and so a contact renamed in Xero still shows the
  // name the existing bills carry.
  let fromXero = [];
  let problem = null;
  try {
    fromXero = await recharge.contactsInXero(accountId, tenantId,
      { refresh: String(req.query.refresh || '') === 'true' });
  } catch (err) {
    problem = err.message;
    console.error('[recharge] reading contacts from Xero failed:', err.message);
  }
  try {
    const billed = await require('../models/bills').contactsForTenant(accountId, tenantId);
    const names = [...new Set(fromXero.concat(billed.map((r) => r.name)))]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    res.json({ contacts: names, error: problem });
  } catch (err) {
    // The dialog falls back to every contact on the account and says so.
    // Not being able to narrow is not a reason to stop somebody writing the
    // row they came to write.
    console.error('[recharge] contacts for tenant failed:', err.message);
    res.status(200).json({ contacts: fromXero, error: problem || err.message });
  }
});

// ── Address rules: the premises register ────────────────────────────────────
//
// Reference data for WazzOCR. Nothing here decides a recharge.

// The lookup itself: WazzOCR has read an address off a bill and needs to
// know where the bill goes. Answers with the organisation to create it in
// and the contact to use — or 404, which is a real answer and means
// "nobody has mapped this premises".
router.get('/premises', async (req, res) => {
  const accountId = req.serviceAccountId || needAccount(req, res);
  if (!accountId) return;
  // Repeat ?address= for each candidate block of text; the register says
  // which one it recognises.
  const address = req.query.address;
  if (!address || (Array.isArray(address) && !address.length)) {
    return res.status(400).json({ error: 'address is required (repeat it for each candidate).' });
  }
  try {
    const hit = await model.lookupPremises(accountId, { address, supplier: req.query.supplier || null });
    if (!hit) return res.status(404).json({ error: 'No premises in the register matches that address.' });
    res.json({
      premisesAddress: hit.premises_address,
      paidBy: { tenantId: hit.payer_tenant_id, code: hit.payer_code || null },
      contactName: hit.contact_name,
      // A note, for anybody reading the answer. Bills Hub recharges from
      // its own rules once the bill is paid, not from this.
      rechargeTo: hit.owner_tenant_id ? { tenantId: hit.owner_tenant_id, code: hit.owner_code || null } : null
    });
  } catch (err) { fail(res, err); }
});

router.get('/address-rules', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    res.json({ rules: (await model.listAddressRules(accountId)).map(vm.addressRuleRow) });
  } catch (err) { fail(res, err); }
});

// Takes an array. Adding forty premises one dialog at a time is the thing
// this screen exists to avoid, so the whole table arrives in one request
// and is saved in one transaction — all of it or none.
router.post('/address-rules', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  const body = req.body || {};
  const rows = Array.isArray(body) ? body : (Array.isArray(body.rules) ? body.rules : [body]);
  try {
    const ids = await model.createAddressRules(accountId, rows);
    res.status(201).json({
      ok: true, created: ids.length,
      rules: (await model.listAddressRules(accountId)).map(vm.addressRuleRow)
    });
  } catch (err) {
    // `problems` names the row, so the dialog can mark it rather than
    // making somebody reread forty of them.
    if (err.problems) return res.status(400).json({ error: err.message, problems: err.problems });
    fail(res, err, 400);
  }
});

router.patch('/address-rules/:id(\\d+)', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    await model.updateAddressRule(accountId, Number(req.params.id), req.body || {});
    res.json({ ok: true, rule: vm.addressRuleRow(await model.getAddressRule(accountId, Number(req.params.id))) });
  } catch (err) { fail(res, err, 400); }
});

router.delete('/address-rules/:id(\\d+)', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const gone = await model.deleteAddressRule(accountId, Number(req.params.id));
    if (!gone) return res.status(404).json({ error: 'Rule not found.' });
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

// Exported for the test: the allow-list is the security boundary, and a
// boundary nobody checks is a boundary that moves.
module.exports = router;
module.exports.serviceAccountId = serviceAccountId;
