// Intercompany recharge.
//
// When one entity pays a bill on behalf of another, the cost is pushed across
// with two documents per subsidiary:
//
//   AR invoice (ACCREC) in the payer,     addressed to the subsidiary
//   draft bill (ACCPAY) in the subsidiary, addressed to the payer
//
// They are mirror images, so the group nets to zero and each side can reconcile
// its own ledger. An intercompany transfer later settles the pair, which is
// recorded here rather than guessed at.
//
// Nothing reaches Xero until someone posts a run. Rules only ever *suggest*.
const db = require('../db');
const xero = require('../lib/xero');
const model = require('../models/recharge');
const bills = require('../models/bills');
const entities = require('../models/entities');
const accounts = require('../models/accounts');

function err(message, statusCode = 400) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

// ── Contacts ────────────────────────────────────────────────────────────────

// Each side of a recharge needs the other entity to exist as a contact in its
// Xero. Found by exact name, created if missing. Cached per process: the same
// pair is looked up once per line, and these never change mid-run.
const _contactCache = new Map();   // `${tenantId}|${name}` -> ContactID

async function findOrCreateContact(accountId, tenantId, name) {
  const key = `${tenantId}|${name}`;
  if (_contactCache.has(key)) return _contactCache.get(key);

  const where = encodeURIComponent(`Name=="${String(name).replace(/"/g, '')}"`);
  const found = await xero.api(accountId, tenantId, `/Contacts?where=${where}`);
  let id = found?.Contacts?.[0]?.ContactID || null;

  if (!id) {
    const created = await xero.api(accountId, tenantId, '/Contacts', {
      method: 'POST',
      body: { Contacts: [{ Name: name }] }
    });
    id = created?.Contacts?.[0]?.ContactID || null;
    if (!id) throw err(`Could not create the contact "${name}" in Xero.`, 502);
  }
  _contactCache.set(key, id);
  return id;
}

// ── Planning ────────────────────────────────────────────────────────────────

// Splits an amount by percentage without losing or inventing cents: the last
// share absorbs the rounding difference so the parts always sum to the whole.
function splitAmount(total, shares) {
  const cents = Math.round(Number(total) * 100);
  const out = [];
  let used = 0;
  shares.forEach((share, i) => {
    const isLast = i === shares.length - 1;
    const part = isLast ? cents - used : Math.round(cents * (Number(share) / 100));
    used += part;
    out.push(part / 100);
  });
  return out;
}

// Validates a proposed recharge and works out each subsidiary's share.
async function planRun(accountId, { billId, targets, ruleId = null }) {
  const settings = await model.getSettings(accountId);
  if (!settings.ar_account_code || !settings.ap_account_code) {
    throw err(
      'Set the recharge account codes first — a recharge posts to a receivable account in the payer and an expense account in the subsidiary, and those differ per chart of accounts.',
      400
    );
  }

  const [bill] = await bills.getManyByIds(accountId, [Number(billId)]);
  if (!bill) throw err('Bill not found.', 404);

  // Recharging a bill nobody has paid yet would invoice a subsidiary for money
  // that has not left the group.
  if (bill.xero_status !== 'PAID' && Number(bill.amount_paid) <= 0) {
    throw err(
      `"${bill.reference || bill.invoice_number}" has not been paid yet, so there is nothing to recharge. Pay it first.`,
      400
    );
  }

  const existing = await db.getOne(
    "SELECT id, status FROM recharge_runs WHERE account_id = ? AND bill_id = ? AND status <> 'cancelled'",
    [accountId, bill.id]
  );
  if (existing) throw err(`That bill is already recharged (run #${existing.id}, ${existing.status}).`, 409);

  const wazzocrAccountId = await accounts.wazzocrIdFor(accountId);
  const known = await entities.listByAccount(accountId, wazzocrAccountId);
  const byTenant = new Map(known.map((e) => [e.xero_tenant_id, e]));

  if (!Array.isArray(targets) || !targets.length) throw err('Choose at least one entity to recharge to.');

  for (const t of targets) {
    if (!byTenant.has(t.tenantId)) throw err(`"${t.tenantId}" is not a connected Xero organisation.`);
    if (t.tenantId === bill.xero_tenant_id) {
      throw err(`${byTenant.get(t.tenantId).short_name} paid this bill — an entity cannot recharge itself.`);
    }
  }

  // Either explicit amounts, or percentage shares of the bill total.
  const usingPercent = targets.every((t) => t.amount == null);
  let amounts;
  if (usingPercent) {
    model.validateTargets(targets);
    amounts = splitAmount(bill.total, targets.map((t) => t.sharePercent ?? 100));
  } else {
    amounts = targets.map((t) => Number(t.amount));
    if (amounts.some((a) => !Number.isFinite(a) || a <= 0)) throw err('Every amount must be a positive number.');
    const sum = amounts.reduce((n, a) => n + a, 0);
    if (sum - Number(bill.total) > 0.01) {
      throw err(`The shares add up to ${sum.toFixed(2)}, more than the bill's ${Number(bill.total).toFixed(2)}.`);
    }
  }

  const prefix = settings.reference_prefix || 'IC-';
  const base = (bill.reference || bill.invoice_number || `BILL${bill.id}`).replace(/\s+/g, '-');

  const lines = targets.map((t, i) => {
    const e = byTenant.get(t.tenantId);
    return {
      tenantId: t.tenantId,
      code: e.code,
      shortName: e.short_name,
      sharePercent: usingPercent ? Number(t.sharePercent ?? 100) : null,
      amount: amounts[i],
      reference: `${prefix}${base}-${e.code}`.slice(0, 255)
    };
  });

  return {
    bill,
    payer: byTenant.get(bill.xero_tenant_id) || null,
    settings,
    lines,
    total: lines.reduce((n, l) => n + l.amount, 0),
    ruleId
  };
}

async function createRun(accountId, input) {
  const plan = await planRun(accountId, input);
  const created = await model.createRun(accountId, {
    ruleId: plan.ruleId,
    bill: plan.bill,
    targets: plan.lines,
    referencePrefix: plan.settings.reference_prefix
  });
  return { ...created, lines: plan.lines, payer: plan.payer };
}

// ── Posting ─────────────────────────────────────────────────────────────────

// Creates both documents for every line that does not already have them.
//
// A line is posted in two steps and each id is saved as soon as Xero returns
// it, so a failure halfway leaves a precise record: retrying creates only what
// is missing, and never a duplicate of what already exists.
async function postRun(accountId, runId) {
  const run = await model.getRun(accountId, runId);
  if (!run) throw err('Recharge not found.', 404);
  if (run.status === 'cancelled') throw err('That recharge was cancelled.', 409);

  const settings = await model.getSettings(accountId);
  if (!settings.ar_account_code || !settings.ap_account_code) {
    throw err('Set the recharge account codes before posting.', 400);
  }

  const wazzocrAccountId = await accounts.wazzocrIdFor(accountId);
  const known = new Map((await entities.listByAccount(accountId, wazzocrAccountId))
    .map((e) => [e.xero_tenant_id, e]));
  const payer = known.get(run.payer_tenant_id);
  if (!payer) throw err('The paying organisation is no longer connected.', 409);

  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + Number(settings.due_days || 30) * 86400000).toISOString().slice(0, 10);
  const taxType = settings.tax_type || 'NONE';

  const results = [];
  for (const line of run.lines) {
    const target = known.get(line.target_tenant_id);
    if (!target) {
      await model.setLineError(line.id, 'That organisation is no longer connected.');
      results.push({ tenantId: line.target_tenant_id, ok: false, error: 'not connected' });
      continue;
    }

    const description = `Recharge: ${run.supplier_name || 'supplier bill'}`
      + `${run.bill_reference ? ` (${run.bill_reference})` : ''} paid by ${payer.short_name}`;

    try {
      let arId = line.ar_invoice_id;
      let arNumber = line.ar_invoice_number;
      let apId = line.ap_invoice_id;
      let apNumber = line.ap_invoice_number;

      // 1. AR invoice in the payer, billed to the subsidiary.
      if (!arId) {
        const contactId = await findOrCreateContact(accountId, run.payer_tenant_id, target.short_name);
        const res = await xero.api(accountId, run.payer_tenant_id, '/Invoices', {
          method: 'POST',
          body: {
            Invoices: [{
              Type: 'ACCREC',
              Contact: { ContactID: contactId },
              Date: today,
              DueDate: due,
              Reference: line.reference,
              Status: 'AUTHORISED',
              LineAmountTypes: 'Exclusive',
              LineItems: [{
                Description: description,
                Quantity: 1,
                UnitAmount: Number(line.amount),
                AccountCode: settings.ar_account_code,
                TaxType: taxType
              }]
            }]
          }
        });
        const inv = res?.Invoices?.[0];
        if (!inv?.InvoiceID) throw new Error('Xero did not return an AR invoice id.');
        arId = inv.InvoiceID;
        arNumber = inv.InvoiceNumber || null;
        await model.setLinePosted(line.id, { arInvoiceId: arId, arInvoiceNumber: arNumber });
      }

      // 2. The mirror bill in the subsidiary, from the payer. Left as DRAFT so
      //    the subsidiary approves it through the normal Bills flow rather than
      //    having a payable appear already authorised.
      if (!apId) {
        const contactId = await findOrCreateContact(accountId, line.target_tenant_id, payer.short_name);
        const res = await xero.api(accountId, line.target_tenant_id, '/Invoices', {
          method: 'POST',
          body: {
            Invoices: [{
              Type: 'ACCPAY',
              Contact: { ContactID: contactId },
              Date: today,
              DueDate: due,
              Reference: line.reference,
              Status: 'DRAFT',
              LineAmountTypes: 'Exclusive',
              LineItems: [{
                Description: description,
                Quantity: 1,
                UnitAmount: Number(line.amount),
                AccountCode: settings.ap_account_code,
                TaxType: taxType
              }]
            }]
          }
        });
        const inv = res?.Invoices?.[0];
        if (!inv?.InvoiceID) throw new Error('Xero did not return a bill id.');
        apId = inv.InvoiceID;
        apNumber = inv.InvoiceNumber || null;
        await model.setLinePosted(line.id, { apInvoiceId: apId, apInvoiceNumber: apNumber });
      }

      results.push({ tenantId: line.target_tenant_id, code: target.code, ok: true, arNumber, apNumber });
    } catch (e) {
      await model.setLineError(line.id, e.message);
      console.error(`[recharge] run ${runId} line ${target.code}: ${e.message}`);
      results.push({ tenantId: line.target_tenant_id, code: target.code, ok: false, error: e.message });
    }
  }

  const failed = results.filter((r) => !r.ok);
  await model.setRunError(accountId, runId, failed.length ? `${failed.length} line(s) failed: ${failed[0].error}` : null);
  const status = await model.refreshRunStatus(accountId, runId);

  return { status, posted: results.filter((r) => r.ok).length, failed: failed.length, results };
}

// ── Rule matching ───────────────────────────────────────────────────────────

function ruleMatches(rule, bill) {
  if (bill.xero_tenant_id !== rule.payer_tenant_id) return false;
  if ((bill.contact_name || '').trim().toLowerCase() !== rule.supplier_name.trim().toLowerCase()) return false;
  if (rule.match_type === 'reference_contains') {
    const haystack = `${bill.reference || ''} ${bill.invoice_number || ''}`.toLowerCase();
    return haystack.includes(String(rule.match_value || '').toLowerCase());
  }
  return true;
}

// Paid bills that a rule covers and which have not been recharged yet. This is
// the whole point of rules: surfacing what is owed between companies before
// someone has to remember it.
async function suggestions(accountId, { limit = 50 } = {}) {
  const rules = (await model.listRules(accountId)).filter((r) => r.enabled);
  if (!rules.length) return [];

  const payers = [...new Set(rules.map((r) => r.payer_tenant_id))];
  const candidates = await db.query(
    `SELECT b.* FROM bills b
      WHERE b.account_id = ?
        AND b.xero_tenant_id IN (${payers.map(() => '?').join(',')})
        AND (b.xero_status = 'PAID' OR b.amount_paid > 0)
        AND NOT EXISTS (
          SELECT 1 FROM recharge_runs r
           WHERE r.account_id = b.account_id AND r.bill_id = b.id AND r.status <> 'cancelled')
      ORDER BY b.bill_date DESC
      LIMIT ?`,
    [accountId, ...payers, Number(limit)]
  );

  const out = [];
  for (const bill of candidates) {
    // First matching rule wins, so ordering a specific reference rule above a
    // catch-all does what it looks like it does.
    const rule = rules.find((r) => ruleMatches(r, bill));
    if (!rule) continue;
    const amounts = splitAmount(bill.total, rule.targets.map((t) => t.sharePercent));
    out.push({
      bill,
      rule,
      lines: rule.targets.map((t, i) => ({ ...t, amount: amounts[i] }))
    });
  }
  return out;
}

module.exports = {
  planRun, createRun, postRun, suggestions, ruleMatches, splitAmount, findOrCreateContact,
  _contactCache
};
