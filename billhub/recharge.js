// Intercompany recharge.
//
// One entity pays a bill that belongs to another, and the cost has to end up
// with whoever it belongs to. Ayu Borneo Management pays a great many of them.
//
// Two kinds of rule decide this, and they are tried in order:
//
//   1. Address rules  — the premises printed on the bill. The strongest
//      evidence there is: an address is a statement about the real world.
//      Only some bills carry one.
//
//   2. Recharge rules — conditions on the text Xero definitely has: the
//      supplier, the reference, the invoice number, the line descriptions,
//      the tracking categories. This is what covers rent, a tenancy, a
//      supplier bill, a central payroll deduction — everything with no
//      address on it.
//
// Address first, because a premises identifies a building and a supplier name
// identifies a company that bills many buildings. A recharge rule is only
// consulted once no address rule has claimed the bill.
//
// Either way a recharge pushes the cost across with two documents:
//
//   AR invoice (ACCREC) in the payer,  addressed to the owner
//   draft bill (ACCPAY) in the owner,  addressed to the payer
//
// They are mirror images, so the group nets to zero and each side can
// reconcile its own ledger. The intercompany transfer that later clears the
// pair is reconciled in Xero, where both documents live — Bills Hub does not
// keep a second record of it to disagree with.
//
// Nothing reaches Xero until someone posts a run. Rules only ever suggest.
const db = require('../db');
const grantSource = require('../lib/grantSource');
const xero = require('../lib/xero');
const model = require('../models/recharge');
const testMode = require('../lib/testMode');
const premisesLib = require('../lib/premises');
const entityRef = require('../lib/entityRef');
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
      body: { Contacts: [{ Name: name }] },
      // A recharge cannot draft anything without the other entity existing
      // as a contact, so this goes with the drafts testing mode allows.
      draftDocument: true
    });
    id = created?.Contacts?.[0]?.ContactID || null;
    if (!id) throw err(`Could not create the contact "${name}" in Xero.`, 502);
  }
  _contactCache.set(key, id);
  return id;
}

// ── What a bill says about itself ───────────────────────────────────────────

// A Xero ACCPAY bill carries no premises address. What it does carry:
//
//   Contact.Name                       the supplier
//   Reference, InvoiceNumber           free text, synced
//   LineItems[].Description            free text, NOT synced
//   LineItems[].Tracking               category options, NOT synced
//   Attachments                        the PDF, which is where a printed
//                                      premises actually lives
//
// The last two are not in the local row because the bill list is fetched
// summaryOnly, which is what keeps a 41-organisation sync inside Xero's rate
// limit. They are read one bill at a time, and only when a rule actually
// asks for them. The printed address can only come from the PDF, so
// `bills.premises_address` is where WazzOCR puts what it read; until then a
// premises can still be matched from whatever a bookkeeper typed into the
// reference or the line descriptions.
const _textCache = new Map();          // billId -> { description, tracking, accountCode, at }
const TEXT_TTL_MS = 5 * 60 * 1000;

// The supplier contact's own address, which is where somebody can put the
// premises when the bill itself does not carry one.
//
// Cached per CONTACT, not per bill. One contact carries 1,681 bills on this
// account; fetching per bill would be 1,681 calls for one answer. An address
// on a contact also changes about never, so the window is long.
const _contactCache2 = new Map();      // `${tenantId}|${contactId}` -> { text, at }
const CONTACT_TTL_MS = 30 * 60 * 1000;

// Both address types, because Xero's UI and its API disagree about the
// names: the "Billing address" somebody fills in comes back as POBOX, and
// "Delivery address" as STREET. Reading only one is how a field somebody
// carefully filled in goes unnoticed. Checked against real contacts rather
// than remembered.
// Emitted in both orders, because nobody agrees where the postcode goes.
// Xero holds City and PostalCode as separate fields and gives no hint which
// comes first; a Malaysian address prints "68100 Batu Caves" while the
// obvious join produces "Batu Caves, 68100". Matching is containment on a
// key with separators stripped, so one ordering silently fails to match an
// address that is otherwise identical.
//
// Rather than guess a convention, or loosen the matcher for everybody, the
// contact's address is offered both ways round and whichever the rule was
// written as will match.
function addressText(contact) {
  const out = [];
  for (const a of contact?.Addresses || []) {
    const lines = [a.AddressLine1, a.AddressLine2, a.AddressLine3, a.AddressLine4]
      .map((v) => String(v || '').trim()).filter(Boolean);
    const city = String(a.City || '').trim();
    const region = String(a.Region || '').trim();
    const post = String(a.PostalCode || '').trim();
    if (!lines.length && !city && !post) continue;

    const cityFirst = [...lines, city, region, post].filter(Boolean).join(', ');
    const postFirst = [...lines, post, city, region].filter(Boolean).join(', ');
    out.push(cityFirst);
    if (postFirst !== cityFirst) out.push(postFirst);
  }
  return out.join(' | ');
}

// `refresh` skips the cache and replaces it. The rule dialog passes it:
// somebody filling an address into Xero and switching straight back here
// should not be shown a half-hour-old answer and conclude the field did not
// save. Matching keeps the cache, where staleness costs nothing.
async function contactAddress(accountId, bill, { fetch = true, refresh = false } = {}) {
  if (!bill.contact_id) return '';
  const key = `${bill.xero_tenant_id}|${bill.contact_id}`;
  const hit = _contactCache2.get(key);
  if (!refresh && hit && Date.now() - hit.at < CONTACT_TTL_MS) return hit.text;
  if (!fetch) return '';

  let text = '';
  try {
    const payload = await xero.api(accountId, bill.xero_tenant_id, `/Contacts/${bill.contact_id}`);
    text = addressText(payload?.Contacts?.[0]);
  } catch (e) {
    console.error(`[recharge] could not read the contact for bill ${bill.id}: ${e.message}`);
  }
  // Cached either way: a contact that cannot be read fails every time, and
  // asking again on every bill would turn one dead organisation into a
  // steady trickle of calls that can never work.
  _contactCache2.set(key, { text, at: Date.now() });
  return text;
}

// The parts of a bill that cost nothing to look at.
function localFields(bill) {
  return {
    supplier: bill.contact_name || '',
    reference: bill.reference || '',
    invoice_number: bill.invoice_number || '',
    premises: String(bill.premises_address || '').trim()
  };
}

// The parts that need the bill read back. Cached either way: an organisation
// whose token has expired fails every time, and without remembering that it
// would be asked again on every page load.
async function remoteFields(accountId, bill, { fetch = true } = {}) {
  const hit = _textCache.get(bill.id);
  if (hit && Date.now() - hit.at < TEXT_TTL_MS) return hit;
  if (!fetch) return { description: '', tracking: '', accountCode: null, at: 0 };

  let description = '';
  let tracking = '';
  let accountCode = null;
  try {
    const payload = await xero.api(accountId, bill.xero_tenant_id, `/Invoices/${bill.xero_invoice_id}`);
    const lines = payload?.Invoices?.[0]?.LineItems || [];
    description = lines.map((l) => l.Description).filter(Boolean).join(' ');
    tracking = lines.flatMap((l) => (l.Tracking || []).map((t) => `${t.Name} ${t.Option}`)).join(' ');
    // The account the cost was booked to. A recharge moves the cost, not its
    // nature: electricity stays electricity in whichever company ends up
    // carrying it. A bill with several lines gets the biggest one's code,
    // since the recharge itself is a single line.
    accountCode = lines
      .filter((l) => l.AccountCode)
      .sort((a, b) => Math.abs(Number(b.LineAmount || 0)) - Math.abs(Number(a.LineAmount || 0)))[0]?.AccountCode || null;
  } catch (e) {
    // Not fatal. Without them the bill simply fails to match, which reads as
    // "no rule covers this" rather than as a wrong recharge.
    console.error(`[recharge] could not read line items for bill ${bill.id}: ${e.message}`);
  }
  const out = { description, tracking, accountCode, at: Date.now() };
  _textCache.set(bill.id, out);
  return out;
}

// Everything an address rule can be matched against, best source first:
//
//   bills.premises_address   read off the document by WazzOCR, or typed here
//   the contact's address    where somebody puts the premises in Xero when
//                            the contact is one per premises
//   reference, line items    free text, where a bookkeeper writes it
//
// A read address is the whole answer and nothing is fetched for it. The
// other two each cost a Xero call, the contact one per contact and the line
// items one per bill — so the contact is tried first, being far cheaper on
// an account where one contact carries hundreds of bills.
async function premisesText(accountId, bill, { fetch = true } = {}) {
  const f = localFields(bill);
  const local = [f.premises, f.reference, f.invoice_number].filter(Boolean).join(' ');
  if (f.premises) return { text: local, source: bill.premises_source || 'manual' };

  const contact = await contactAddress(accountId, bill, { fetch });
  if (contact) return { text: `${local} ${contact}`.trim(), source: 'contact' };

  const r = await remoteFields(accountId, bill, { fetch });
  return { text: `${local} ${r.description}`.trim(), source: r.description ? 'xero' : 'reference' };
}

// ── Conditions ──────────────────────────────────────────────────────────────

// Compared with case and surrounding space ignored, because nobody typing
// "Petronas" into a rule means to exclude "PETRONAS DAGANGAN BERHAD".
function testCondition(haystack, operator, value) {
  const h = String(haystack || '').toLowerCase().trim();
  const v = String(value || '').toLowerCase().trim();
  if (!v) return false;
  switch (operator) {
    case 'is':           return h === v;
    case 'starts_with':  return h.startsWith(v);
    case 'ends_with':    return h.endsWith(v);
    case 'not_contains': return !h.includes(v);
    case 'contains':
    default:             return h.includes(v);
  }
}

// Does a bill satisfy a recharge rule's conditions?
//
// The remote fields are fetched only if a condition actually names one —
// a rule testing the supplier and the reference costs no API call at all.
async function conditionsMatch(accountId, bill, rule, { fetch = true } = {}) {
  const conds = rule.conditions || [];
  if (!conds.length) return false;

  const values = localFields(bill);
  if (conds.some((c) => model.fieldNeedsXero(c.field))) {
    const r = await remoteFields(accountId, bill, { fetch });
    values.description = r.description;
    values.tracking = r.tracking;
  }

  const results = conds.map((c) => testCondition(values[c.field], c.operator, c.value));
  return rule.match_mode === 'any' ? results.some(Boolean) : results.every(Boolean);
}

function asDate(v) {
  if (!v) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

function asTime(v) {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

// A rule acts on bills marked paid in Bills Hub *after the rule was written*.
//
// Writing a rule must not reach back through the history and start claiming
// bills somebody settled months ago; that is a deliberate act, and Run now
// is where it lives. The rule's own created_at is the line — there is no
// separate date to set, and so no way for the two to disagree.
// `assumePaid` means the caller is asking what happens if this bill is paid
// now — the Pay dialog, about to do exactly that. Every rule that exists was
// written before now, so every rule is in scope and there is nothing to
// compare. Without this the dialog told somebody a rule matched but the
// bill was "out of scope", naming a payment date of null, for a bill they
// were in the middle of paying.
//
// Deliberately NOT Date.now() >= created_at. The driver reads a MySQL
// DATETIME back as UTC while MySQL wrote it in its own local time, so a
// timestamp from the database and one from Node's clock are hours apart and
// cannot be compared. Two values that both came from the database can be,
// which is the only comparison left here.
function withinStart(bill, rule, { assumePaid = false } = {}) {
  if (assumePaid) return true;
  const paid = asTime(bill.marked_paid_at);
  if (!paid) return false;
  const written = asTime(rule.created_at);
  if (!written) return true;
  return paid >= written;
}

// ── Deciding ────────────────────────────────────────────────────────────────

// Every answer this can give, so a caller never has to infer one from a null.
//
//   unpaid        the money has not left the group yet
//   no-rule       no rule of either kind covers this bill
//   out-of-scope  a recharge rule covers it, but it was paid before that
//                 rule's start date
//   own           the owner is the entity that paid — it paid its own bill
//   recharge      the owner is somebody else
//   done          already recharged
const OUTCOMES = ['unpaid', 'no-rule', 'out-of-scope', 'own', 'recharge', 'done'];

// Paid *here*. Not bill.xero_status, which the sync overwrites from Xero and
// which is therefore true of every bill anyone has ever settled directly in
// Xero — thousands of them, none the result of an action in Bills Hub.
//
// A recharge is a consequence of marking a bill paid on the Bills tab, so
// that is the moment it keys on and the only one.
function isPaid(bill) {
  return Boolean(bill.marked_paid_at);
}

// Loaded once, so a scan over many bills does not re-query.
//
// Recharge rules only. The premises register is NOT consulted here and must
// not be: it tells WazzOCR which organisation to create a bill in and under
// which contact, upstream of Bills Hub ever seeing it. By the time a bill is
// here that decision has already been made, and a second opinion on it would
// be a rule nobody wrote claiming bills a recharge rule was meant to.
async function loadRules(accountId) {
  const text = await model.listTextRules(accountId);
  const address = await model.listAddressRules(accountId);
  return {
    // An address rule only recharges once somebody fills in "Recharge to".
    // Without it the row is still doing its other job — telling WazzOCR
    // where to create the bill — and that job is the reason most rows
    // exist, so a blank there is a choice rather than an unfinished row.
    address: address.filter((r) => r.enabled && r.owner_tenant_id && r.premises_address),
    text: text.filter((r) => r.enabled && r.owner_tenant_id)
  };
}

// The first recharge rule whose conditions the bill satisfies. Ordered by
// position, so putting a specific rule above a general one does what it
// looks like it does.
async function matchTextRule(accountId, bill, rules, { fetch = true, assumePaid = false } = {}) {
  for (const rule of rules) {
    if (rule.payer_tenant_id && rule.payer_tenant_id !== bill.xero_tenant_id) continue;
    if (!withinStart(bill, rule, { assumePaid })) continue;
    if (await conditionsMatch(accountId, bill, rule, { fetch })) return rule;
  }
  return null;
}

// The address rule whose premises this bill carries.
//
// Matched on the ADDRESS, never on the contact. The contact is what WazzOCR
// files the bill under, and on this account one contact carries 1,834 bills
// across 29 organisations — matching on it would hand every one of them to
// whichever premises happened to be written first. The address is the thing
// that names a single building.
//
// Read from the local row ONLY — bills.premises_address, which is where
// WazzOCR puts what it read off the document, plus the reference and
// invoice number a bookkeeper can type it into.
//
// Deliberately not premisesText(), which also reaches for the contact's
// address and the line items. Those cost a Xero call per contact and per
// bill, and this runs over every paid bill on an account with 2,250 of
// them: that cost is what retired address matching the first time. The
// trade is honest and matches what the tab is for — an address rule fires
// for the bills WazzOCR recognised, because those are the ones carrying an
// address locally. Anything else is a recharge rule's job.
function matchAddressRule(bill, rules, { assumePaid = false } = {}) {
  const usable = rules.filter((r) =>
    (!r.payer_tenant_id || r.payer_tenant_id === bill.xero_tenant_id)
    && withinStart(bill, r, { assumePaid }));
  if (!usable.length) return null;

  // 1. The address, when the bill carries one. The most precise thing
  //    available, and best() settles one address sitting inside another —
  //    a block and a unit within it — on length, so the more specific row
  //    wins rather than whichever the database returned first.
  const f = localFields(bill);
  const text = [f.premises, f.reference, f.invoice_number].filter(Boolean).join(' ');
  const byAddress = text ? premisesLib.best(text, usable) : null;
  if (byAddress) return { rule: byAddress.rule, by: 'address' };

  // 2. The contact, when it identifies the premises on its own.
  //
  //    This is the path that actually runs. A bill reaches Bills Hub by
  //    syncing back from Xero, and that sync carries no premises: WazzOCR
  //    writes the address nowhere Xero keeps it, so bills.premises_address
  //    stays empty on every real bill. The contact is the one thing that
  //    does survive the round trip.
  //
  //    Safe only while the contact names one premises, which is what a
  //    per-premises contact ("TNB - 187A") is for. Two rows sharing a
  //    contact and disagreeing about where to recharge is the generic
  //    "TENAGA NASIONAL BERHAD" case — 1,834 bills across 29
  //    organisations — and there the honest answer is to decline, not to
  //    pick whichever row was written first.
  const contactKey = premisesLib.normalise(bill.contact_name);
  if (!contactKey) return null;
  const sharing = usable.filter((r) => premisesLib.normalise(r.contact_name) === contactKey);
  if (!sharing.length) return null;

  const owners = new Set(sharing.map((r) => r.owner_tenant_id));
  if (owners.size > 1) {
    return { ambiguous: sharing, by: 'contact' };
  }
  return { rule: sharing[0], by: 'contact' };
}

// What to call a rule in a sentence. Address rules have no name of their
// own; the premises is the only thing that identifies one, and it is also
// the thing somebody would look for on the tab.
function ruleLabel(rule, kind) {
  return kind === 'address'
    ? `the address rule for ${rule.premises_address}`
    : `"${rule.name}"`;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function verdictFor(rule, bill, { address = null, kind }) {
  const owner = rule.owner_short || rule.owner_code;
  const what = ruleLabel(rule, kind);
  if (rule.owner_tenant_id === bill.xero_tenant_id) {
    return {
      outcome: 'own', rule, kind, address: address || rule.premises_address || null,
      reason: `${cap(what)} recharges to ${owner}, which is the entity on the bill header. Nothing is recharged.`
    };
  }
  return {
    outcome: 'recharge',
    rule, kind, address: address || rule.premises_address || null,
    ownerTenantId: rule.owner_tenant_id,
    ownerCode: rule.owner_code,
    ownerShort: rule.owner_short,
    // Two forms of the same sentence. `reason` stands alone; `consequence` is
    // for a view that has already named the supplier and would otherwise
    // name it twice.
    reason: `${cap(what)} matches this bill, so the full amount is recharged to ${owner}.`,
    consequence: `Matches ${what} — the full amount is recharged to ${owner}.`
  };
}

// Runs one bill through the rules. Never writes
// anything — the Pay dialog uses it to explain what will happen, and
// suggestions() uses it to decide what to offer.
//
// `assumePaid` skips the paid check. The Pay dialog needs it: it is asking
// what will happen to a bill it is about to mark paid, and "not paid yet" is
// a true but useless answer to that question.
async function decide(accountId, bill, { rules = null, fetch = true, assumePaid = false } = {}) {
  const all = rules || (await loadRules(accountId));

  if (!assumePaid && !isPaid(bill)) {
    return {
      outcome: 'unpaid',
      reason: 'Not marked paid in Bills Hub yet. A recharge follows from paying a bill here — '
            + 'one settled directly in Xero does not set one going.'
    };
  }

  // Asked before the recharge rules, because an address rule is the more
  // specific statement: it names one building, where a recharge rule names
  // a pattern that can cover a supplier's whole account. Most specific wins
  // is also what makes the two tabs divide the work the way they read —
  // address rules for bills WazzOCR recognised, recharge rules for the rest.
  const addr = matchAddressRule(bill, all.address, { assumePaid });
  // Two register rows share this contact and disagree about where its bills
  // go. Guessing would be a decision nobody made, and silence would read as
  // "no rule covers this" — which is the one thing it is not.
  if (addr && addr.ambiguous) {
    const where = addr.ambiguous
      .map((r) => `${r.owner_short || r.owner_code} (${r.premises_address})`).join(' and ');
    return {
      outcome: 'no-rule',
      reason: `${bill.contact_name} is on ${addr.ambiguous.length} register rows that disagree about `
            + `where its bills belong — ${where}. Nothing is recharged until the bill says which `
            + 'premises it is for, or that contact is split into one per premises.'
    };
  }
  if (addr) return verdictFor(addr.rule, bill, { kind: 'address', address: addr.rule.premises_address });

  const text = await matchTextRule(accountId, bill, all.text, { fetch, assumePaid });
  if (text) return verdictFor(text, bill, { kind: 'text' });

  // Separated from "no rule", because the two call for opposite actions. A
  // rule does cover this bill; it was paid before the rule's start date, and
  // the fix is to move that date back, not to write another rule.
  // An address rule somebody has just filled "Recharge to" in on would
  // otherwise match every bill that premises has ever had, back years. It
  // acts from when it was written, like a recharge rule — and saying so is
  // better than "no rule covers this supplier", which would send somebody
  // off to write a second rule that also would not fire.
  const staleAddr = matchAddressRule(bill, all.address.filter(
    (r) => !withinStart(bill, r, { assumePaid })), { assumePaid: true });
  if (staleAddr && staleAddr.rule) {
    return {
      outcome: 'out-of-scope',
      rule: staleAddr.rule,
      kind: 'address',
      reason: `${cap(ruleLabel(staleAddr.rule, 'address'))} matches this bill, but the bill was marked `
            + `paid on ${asDate(bill.marked_paid_at)}, before that row was written on `
            + `${asDate(staleAddr.rule.created_at)}. A rule only ever acts on bills marked paid after `
            + 'it was written, so this one is outside it. Nothing will happen to it.'
    };
  }

  for (const rule of all.text) {
    if (rule.payer_tenant_id && rule.payer_tenant_id !== bill.xero_tenant_id) continue;
    if (withinStart(bill, rule, { assumePaid })) continue;
    if (!await conditionsMatch(accountId, bill, rule, { fetch })) continue;
    return {
      outcome: 'out-of-scope',
      rule,
      kind: 'text',
      reason: `"${rule.name}" matches this bill, but the bill was marked paid on `
            + `${asDate(bill.marked_paid_at)}, before the rule was written on ${asDate(rule.created_at)}. `
            + 'A rule only ever acts on bills marked paid after it was written, so this one is '
            + 'outside it. Nothing will happen to it.'
    };
  }

  return { outcome: 'no-rule', reason: `No rule covers ${bill.contact_name || 'this supplier'}.` };
}

// ── Planning ────────────────────────────────────────────────────────────────

// Validates a proposed recharge. One supplier, one owner, the whole amount —
// there is no split to work out, because a rule names a single entity.
async function planRun(accountId, { billId, ownerTenantId = null, textRuleId = null, ruleId = null }) {
  const settings = await model.getSettings(accountId);
  const [bill] = await bills.getManyByIds(accountId, [Number(billId)]);
  if (!bill) throw err('Bill not found.', 404);

  // Recharging a bill nobody has paid yet would invoice a subsidiary for money
  // that has not left the group.
  if (!isPaid(bill)) {
    throw err(
      `"${bill.reference || bill.invoice_number}" has not been marked paid in Bills Hub, so there is `
      + 'nothing to recharge yet. Pay it from the Bills tab first — a bill settled directly in Xero '
      + 'does not set a recharge going.',
      400
    );
  }

  // A run raised in testing mode blocks the bill only while testing mode is
  // still on. Otherwise a bill tried once during testing would be quietly
  // unrechargeable for good, held by a run nobody can see.
  const testing = await testMode.isOn(accountId);
  const existing = await db.getOne(
    `SELECT id, status, test_mode FROM recharge_runs
      WHERE account_id = ? AND bill_id = ? AND status <> 'cancelled'
        ${testing ? '' : 'AND test_mode = 0'}`,
    [accountId, bill.id]
  );
  if (existing) {
    throw err(
      `That bill is already recharged (run #${existing.id}, ${existing.status}`
      + `${existing.test_mode ? ', testing mode' : ''}).`, 409);
  }

  const wazzocrAccountId = await grantSource.connectionsAccountId(accountId);
  const known = await entities.listByAccount(accountId, wazzocrAccountId);
  const byTenant = new Map(known.map((e) => [e.xero_tenant_id, e]));

  // Either the caller names the owner, or the rules work it out. Asking the
  // rules is the normal path; naming an owner is how a person overrides them
  // for one bill.
  let owner = ownerTenantId;
  let kind = null;
  let rule = null;
  let address = null;

  if (!owner) {
    const verdict = await decide(accountId, bill);
    if (verdict.outcome !== 'recharge') throw err(verdict.reason, 400);
    owner = verdict.ownerTenantId;
    rule = verdict.rule;
    kind = verdict.kind;
    address = verdict.address;
  } else if (textRuleId) {
    rule = await model.getTextRule(accountId, textRuleId);
    kind = rule ? 'text' : null;
  } else if (ruleId) {
    rule = await model.getAddressRule(accountId, ruleId);
    kind = rule ? 'address' : null;
    address = rule ? rule.premises_address : null;
  }

  if (!byTenant.has(owner)) throw err(`"${owner}" is not a connected Xero organisation.`);
  if (owner === bill.xero_tenant_id) {
    throw err(`${byTenant.get(owner).short_name} is on the bill header, so it is paying its own bill — there is nothing to recharge.`);
  }

  const e = byTenant.get(owner);
  const prefix = settings.reference_prefix || 'IC-';
  const base = (bill.reference || bill.invoice_number || `BILL${bill.id}`).replace(/\s+/g, '-');
  // The group prefix every code shares adds nothing inside a reference that
  // is already this group's — see lib/entityRef.js. The badge on screen
  // still shows the whole code.
  const suffix = entityRef.short(e, known.map((x) => x.code));

  const lines = [{
    tenantId: owner,
    code: e.code,
    shortName: e.short_name,
    sharePercent: 100,
    amount: Number(bill.total),
    reference: `${prefix}${base}-${suffix}`.slice(0, 255)
  }];

  return {
    bill,
    payer: byTenant.get(bill.xero_tenant_id) || null,
    settings,
    lines,
    address,
    total: Number(bill.total),
    // Which of the two kinds decided it, so the run can say so afterwards
    // and so a rule can be told what it has already acted on.
    ruleId: kind === 'address' && rule ? rule.id : null,
    textRuleId: kind === 'text' && rule ? rule.id : null
  };
}

async function createRun(accountId, input) {
  const plan = await planRun(accountId, input);
  const created = await model.createRun(accountId, {
    ruleId: plan.ruleId,
    textRuleId: plan.textRuleId,
    bill: plan.bill,
    targets: plan.lines,
    premisesAddress: plan.address,
    // Labelled, not hidden. The two DRAFT documents a run posts under
    // testing mode are real, so it stays on the list when the switch goes
    // off — with a TEST tag, so nobody has to remember which were which.
    madeInTest: await testMode.isOn(accountId)
  });
  return { ...created, lines: plan.lines, payer: plan.payer, address: plan.address };
}

// ── Posting ─────────────────────────────────────────────────────────────────

// Creates both documents for every line that does not already have them.
//
// A line is posted in two steps and each id is saved as soon as Xero returns
// it, so a failure halfway leaves a precise record: retrying creates only what
// is missing, and never a duplicate of what already exists.
// ── Charts of accounts ──────────────────────────────────────────────────────

// The accounts a recharge can post to, for one organisation.
//
// Read from Xero rather than typed, because an account code typed from memory
// is a recharge that fails at the last step — after both documents have been
// worked out and one of them may already exist.
//
// Cached for half an hour per organisation. A chart of accounts changes about
// never, and the rule dialog would otherwise ask again on every keystroke
// that changes an entity.
const chartCache = new Map();   // tenantId -> { at, accounts }
const CHART_TTL_MS = 30 * 60 * 1000;

async function chartOfAccounts(accountId, tenantId, { refresh = false } = {}) {
  if (!tenantId) return [];
  const hit = chartCache.get(tenantId);
  if (!refresh && hit && Date.now() - hit.at < CHART_TTL_MS) return hit.accounts;

  const payload = await xero.api(accountId, tenantId, '/Accounts');
  const accounts = (payload?.Accounts || [])
    // No code means nothing can post to it, so offering it would be offering
    // a choice that cannot be made.
    .filter((a) => a.Code && a.Status === 'ACTIVE')
    // Archived and system accounts are in the list and are not places a
    // recharge belongs.
    .filter((a) => a.Class === 'EXPENSE' || a.Class === 'REVENUE' || a.Type === 'CURRLIAB' || a.Type === 'CURRENT')
    .map((a) => ({ code: a.Code, name: a.Name, type: a.Type, cls: a.Class }))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  chartCache.set(tenantId, { at: Date.now(), accounts });
  return accounts;
}

// ── Contacts, for the register dialog ───────────────────────────────────────

// Every contact one organisation has in Xero.
//
// Read from Xero, not from the bills already here. A register row names the
// contact WazzOCR should file a premises' bills UNDER, and that is very often
// a contact somebody created this morning for exactly this purpose — "TM
// Technology Services Sdn Bhd - KJ 267-G" with no bills against it yet. A
// list built from bills cannot contain it, so the row could not be written
// for the one case the register exists to serve.
//
// Xero pages at a hundred, so this is cached per organisation — otherwise
// the dialog would ask again on every keystroke that changes an entity.
//
// Two minutes, not the chart of accounts' half hour. A chart changes about
// never; a contact list changes precisely when somebody is sitting in Xero
// creating the per-premises contact they are about to come here and pick,
// and half an hour of "it isn't there" is the whole feature failing at the
// only moment it is used. ?refresh=true skips it outright.
const CONTACTS_TTL_MS = Number(process.env.CONTACT_LIST_TTL_MS || 120000);
const CONTACT_PAGE_SIZE = 100;
const CONTACT_MAX_PAGES = Number(process.env.CONTACT_MAX_PAGES || 40);
const contactListCache = new Map();   // tenantId -> { at, names }

async function contactsInXero(accountId, tenantId, { refresh = false } = {}) {
  if (!tenantId) return [];
  const hit = contactListCache.get(tenantId);
  if (!refresh && hit && Date.now() - hit.at < CONTACTS_TTL_MS) return hit.names;

  const names = [];
  for (let page = 1; page <= CONTACT_MAX_PAGES; page += 1) {
    const payload = await xero.api(accountId, tenantId, `/Contacts?page=${page}`);
    const list = payload?.Contacts || [];
    for (const c of list) {
      // ARCHIVED contacts cannot take a new bill, so offering one is
      // offering a choice that fails later.
      if (c.Name && c.ContactStatus !== 'ARCHIVED') names.push(c.Name);
    }
    if (list.length < CONTACT_PAGE_SIZE) break;
  }
  const sorted = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  contactListCache.set(tenantId, { at: Date.now(), names: sorted });
  return sorted;
}

// ── Attachments ─────────────────────────────────────────────────────────────

// Xero caps an attachment at 25MB. Nothing here would be useful at that size
// anyway, and a recharge should not spend a minute moving a scan of a filing
// cabinet, so the copy stops well short and says which file it skipped.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// What the original bill has attached, listed once per run rather than once
// per document. Returns [] when the bill has nothing, and also when the grant
// predates the attachments scope — the caller reports that, because a
// recharge that posted correctly has not failed just because a PDF did not
// come with it.
async function sourceAttachments(accountId, { tenantId, invoiceId }) {
  if (!tenantId || !invoiceId) return { files: [], skipped: null };
  try {
    const res = await xero.api(accountId, tenantId, `/Invoices/${invoiceId}/Attachments`);
    return { files: res?.Attachments || [], skipped: null };
  } catch (e) {
    // 403 is the shape a missing scope arrives in. Anything else is worth the
    // same treatment: report it, do not fail the recharge over it.
    return { files: [], skipped: e.message };
  }
}

// Put the original bill's attachments onto a document a recharge just made,
// so whoever opens either side sees the same paperwork the payer saw.
//
// Every failure here is reported and swallowed. The documents are already in
// Xero by the time this runs; throwing would mark a line failed that in fact
// posted, and a retry would then try to create them a second time.
async function copyAttachments(accountId, source, { tenantId, invoiceId }) {
  if (!source.files.length) {
    return { tenantId, copied: 0, skipped: source.skipped ? [source.skipped] : [] };
  }
  const skipped = [];
  let copied = 0;
  for (const file of source.files) {
    const name = String(file.FileName || '').trim();
    if (!name) continue;
    if (Number(file.ContentLength) > MAX_ATTACHMENT_BYTES) {
      skipped.push(`${name} is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB`);
      continue;
    }
    try {
      const got = await xero.api(accountId, source.tenantId,
        `/Invoices/${source.invoiceId}/Attachments/${encodeURIComponent(name)}`, { raw: true });
      await xero.api(accountId, tenantId,
        `/Invoices/${invoiceId}/Attachments/${encodeURIComponent(name)}`, {
          method: 'PUT',
          body: got.buffer,
          headers: { 'Content-Type': file.MimeType || got.contentType },
          // Part of the draft it hangs on, so it follows the same rule.
          draftDocument: true
        });
      copied += 1;
    } catch (e) {
      skipped.push(`${name}: ${e.message}`);
    }
  }
  return { tenantId, copied, skipped };
}

// The payer's own sales invoice, rendered by Xero as a PDF and hung on the
// bill it produced.
//
// The original supplier bill travels across too (copyAttachments above), but
// that is the TNB bill — it says what the group was charged, not what this
// sister company is charging this one. The document the receiving entity is
// actually being asked to approve is the sales invoice, and until now it was
// only visible by opening the other organisation.
//
// Xero renders the PDF from GET /Invoices/{id} with Accept: application/pdf.
// The documented DRAFT restriction is on the online invoice URL, not on the
// PDF, so this works while both documents are still drafts — which is the
// only moment that matters here, because the bill is created as one.
//
// Best effort, always. A recharge that put both documents into Xero has done
// its job; failing it over an attachment would leave a half-finished run
// behind and make the next attempt harder than the thing it was protecting.
async function salesInvoicePdf(accountId, { payerTenantId, arInvoiceId, arNumber, tenantId, invoiceId }) {
  if (!arInvoiceId) return { tenantId, copied: 0, skipped: [] };
  // Named for what it is, because it lands beside the supplier bill and the
  // two are not interchangeable. Slashes would break the attachment path.
  const name = `Sales invoice ${arNumber || arInvoiceId}.pdf`.replace(/[\\/]/g, '-');
  try {
    const got = await xero.api(accountId, payerTenantId, `/Invoices/${arInvoiceId}`, {
      raw: true,
      // Last spread wins in lib/xero.js, so this overrides the raw default.
      headers: { Accept: 'application/pdf' }
    });
    // A zero-byte or JSON body is Xero declining in a way that did not throw.
    // Attaching it would put a broken file on the bill, which is worse than
    // saying it could not be fetched.
    if (!got.buffer || !got.buffer.length) throw new Error('Xero returned an empty PDF.');
    if (!/pdf/i.test(got.contentType || '')) throw new Error(`Xero returned ${got.contentType} rather than a PDF.`);
    await xero.api(accountId, tenantId, `/Invoices/${invoiceId}/Attachments/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: got.buffer,
      headers: { 'Content-Type': 'application/pdf' },
      // Part of the draft it hangs on, so it follows the same rule.
      draftDocument: true
    });
    return { tenantId, copied: 1, skipped: [] };
  } catch (e) {
    return { tenantId, copied: 0, skipped: [`${name}: ${e.message}`] };
  }
}

// A Xero tenant id in a message, swapped for the organisation it belongs to.
// Used where a failure is recorded: the allowlist and a few Xero errors name
// the organisation by GUID, and nobody reading the Recharge tab knows which
// company that is.
function withEntityNames(message, known) {
  return String(message || '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => {
    const e = known.get(id);
    return e ? `${e.short_name || e.code} (${e.code})` : id;
  });
}

async function postRun(accountId, runId) {
  const run = await model.getRun(accountId, runId);
  if (!run) throw err('Recharge not found.', 404);
  if (run.status === 'cancelled') throw err('That recharge was cancelled.', 409);
  // Only runs drafted before testing mode started posting real drafts carry
  // this flag; nothing stamps it now. They were worked out when a test
  // posted nothing, so they have no documents behind them and turning the
  // switch off later must not quietly promote them into real ones.
  if (run.test_mode) {
    throw err(
      'That recharge was worked out in testing mode, so it can never be posted. '
      + 'Turn testing mode off and draft it again.', 409);
  }

  const settings = await model.getSettings(accountId);

  // Which ledger account the two documents post to.
  //
  // A recharge moves a cost between companies; it does not change what the
  // cost is. So both sides carry the account the original bill was booked
  // to: the payer's expense nets to zero, and the company that actually
  // used the electricity carries it as electricity. Nobody has to configure
  // anything, and nothing has to be kept in step with a chart of accounts.
  //
  // Read off the bill in Xero, which must have had an account code or Xero
  // would not have let it be approved in the first place. An account code
  // set in the settings overrides it, for a group that wants a dedicated
  // intercompany account instead.
  const { accountCode: billCode } = await remoteFields(accountId, {
    id: run.bill_id, xero_tenant_id: run.payer_tenant_id, xero_invoice_id: run.xero_invoice_id
  });
  // Most specific first: the rule that decided this recharge, then the
  // account-wide override, then the account the original bill was booked to.
  // A rule naming its own accounts is the case where the two companies' charts
  // do not line up, and that is a fact about one rule, not about the group.
  const rule = run.text_rule_id ? await model.getTextRule(accountId, run.text_rule_id) : null;
  const arCode = rule?.ar_account_code || settings.ar_account_code || billCode;
  const apCode = rule?.ap_account_code || settings.ap_account_code || billCode;
  if (!arCode || !apCode) {
    throw err(
      `Could not read which account "${run.bill_reference || run.supplier_name}" was booked to, `
      + 'so there is nothing to post the recharge against. Open the bill in Xero and check it has '
      + 'an account code on its lines.', 400);
  }

  const wazzocrAccountId = await grantSource.connectionsAccountId(accountId);
  const known = new Map((await entities.listByAccount(accountId, wazzocrAccountId))
    .map((e) => [e.xero_tenant_id, e]));
  const payer = known.get(run.payer_tenant_id);
  if (!payer) {
    throw err('The paying organisation is not in use — either it was switched off in Settings → '
      + 'Xero organisations, or its Xero connection is gone. Switching it back on is the usual fix.', 409);
  }

  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + Number(settings.due_days || 30) * 86400000).toISOString().slice(0, 10);
  const taxType = settings.tax_type || 'NONE';

  // Both documents carry the ORIGINAL bill's currency.
  //
  // Left unset, Xero gives each document the currency of the organisation
  // it lands in — so a USD 1,000 bill recharged into an MYR company became
  // a USD 1,000 receivable against an MYR 1,000 payable. Same number,
  // different money, and the group no longer nets to zero. Nothing says so
  // on screen; the figures simply stop meaning what they claim.
  //
  // Where the receiving organisation does not have that currency enabled,
  // Xero refuses that line and says so against the run — which is the right
  // outcome: a recharge it cannot state correctly is one it must not state.
  const currency = run.currency_code || null;

  // Listed once for the whole run: every document it makes gets the same
  // files, and a run with several targets should not ask Xero the same
  // question once per target.
  const source = {
    tenantId: run.payer_tenant_id,
    invoiceId: run.xero_invoice_id,
    ...(await sourceAttachments(accountId, {
      tenantId: run.payer_tenant_id, invoiceId: run.xero_invoice_id
    }))
  };

  const results = [];
  const copied = [];
  for (const line of run.lines) {
    const target = known.get(line.target_tenant_id);
    if (!target) {
      await model.setLineError(line.id,
        'That organisation is not in use — switched off in Settings, or no longer connected to Xero.');
      results.push({ tenantId: line.target_tenant_id, ok: false, error: 'not connected' });
      continue;
    }

    // The supplier and the original reference are the reason this document
    // exists, so they go on the face of it. Whoever opens the invoice in six
    // months should not have to come back here to find out what it was for.
    const description = `Recharge: ${run.supplier_name || 'supplier bill'}`
      + `${run.bill_reference ? ` (${run.bill_reference})` : ''} paid by ${payer.short_name}`
      + `${run.premises_address ? ` — ${run.premises_address}` : ''}`;

    try {
      let arId = line.ar_invoice_id;
      let arNumber = line.ar_invoice_number;
      let apId = line.ap_invoice_id;
      let apNumber = line.ap_invoice_number;

      // 1. The sales invoice in the payer, billed to the subsidiary. DRAFT,
      //    like the bill below: a recharge is a proposal until somebody in
      //    the paying entity has looked at it, and an authorised invoice is
      //    a receivable that has to be credited to undo rather than simply
      //    deleted.
      if (!arId) {
        const contactId = await findOrCreateContact(accountId, run.payer_tenant_id, target.short_name);
        const res = await xero.api(accountId, run.payer_tenant_id, '/Invoices', {
          method: 'POST',
          // A DRAFT in a live organisation is what testing mode is for:
          // visible, reviewable, and deleted with one click if it is wrong.
          // The payment that would have preceded it is what stays blocked.
          draftDocument: true,
          body: {
            Invoices: [{
              Type: 'ACCREC',
              Contact: { ContactID: contactId },
              Date: today,
              DueDate: due,
              ...(currency ? { CurrencyCode: currency } : {}),
              Reference: line.reference,
              Status: 'DRAFT',
              LineAmountTypes: 'Exclusive',
              LineItems: [{
                Description: description,
                Quantity: 1,
                UnitAmount: Number(line.amount),
                AccountCode: arCode,
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
        copied.push(await copyAttachments(accountId, source, {
          tenantId: run.payer_tenant_id, invoiceId: arId
        }));
      }

      // 2. The mirror bill in the subsidiary, from the payer. DRAFT so the
      //    subsidiary approves it through the normal Bills flow rather than
      //    having a payable appear already authorised.
      //
      //    By now Xero has numbered the sales invoice above, so this bill can
      //    name it. InvoiceNumber on an ACCPAY is "the supplier's invoice
      //    number", and the payer is the supplier here — so the payer's own
      //    INV-0048 is literally the right value for the field, and it is the
      //    one the receiving entity's bookkeeper will be asked about. Without
      //    it the two documents share only the IC- reference, which exists
      //    for Bills Hub's benefit rather than for anyone reading Xero.
      //
      //    On a re-post of a half-finished run arNumber is read back from the
      //    line, so the second attempt carries it too. Left off entirely when
      //    Xero returned no number, rather than inventing one.
      if (!apId) {
        const apDescription = arNumber ? `${description} · against invoice ${arNumber}` : description;
        const contactId = await findOrCreateContact(accountId, line.target_tenant_id, payer.short_name);
        const res = await xero.api(accountId, line.target_tenant_id, '/Invoices', {
          method: 'POST',
          // A DRAFT in a live organisation is what testing mode is for:
          // visible, reviewable, and deleted with one click if it is wrong.
          // The payment that would have preceded it is what stays blocked.
          draftDocument: true,
          body: {
            Invoices: [{
              Type: 'ACCPAY',
              Contact: { ContactID: contactId },
              Date: today,
              DueDate: due,
              ...(currency ? { CurrencyCode: currency } : {}),
              Reference: line.reference,
              ...(arNumber ? { InvoiceNumber: arNumber } : {}),
              Status: 'DRAFT',
              LineAmountTypes: 'Exclusive',
              LineItems: [{
                Description: apDescription,
                Quantity: 1,
                UnitAmount: Number(line.amount),
                AccountCode: apCode,
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
        copied.push(await copyAttachments(accountId, source, {
          tenantId: line.target_tenant_id, invoiceId: apId
        }));
        // And the sales invoice itself, so the receiving entity can read the
        // document it is being charged by rather than only the one behind it.
        copied.push(await salesInvoicePdf(accountId, {
          payerTenantId: run.payer_tenant_id, arInvoiceId: arId, arNumber,
          tenantId: line.target_tenant_id, invoiceId: apId
        }));
      }

      results.push({ tenantId: line.target_tenant_id, code: target.code, ok: true, arNumber, apNumber });
    } catch (e) {
      // The allowlist refuses by tenant id, because lib/xero.js is below the
      // layer that knows an organisation has a name. Here both are in hand,
      // and "e1434619-aa20-…" on screen is a question rather than an answer.
      const named = withEntityNames(e.message, known);
      await model.setLineError(line.id, named);
      console.error(`[recharge] run ${runId} line ${target.code}: ${named}`);
      results.push({ tenantId: line.target_tenant_id, code: target.code, ok: false, error: named });
    }
  }

  const failed = results.filter((r) => !r.ok);
  await model.setRunError(accountId, runId, failed.length ? `${failed.length} line(s) failed: ${failed[0].error}` : null);
  const status = await model.refreshRunStatus(accountId, runId);

  // Said out loud rather than left to be noticed. A recharge whose documents
  // went up without the bill behind them is not wrong, but somebody looking
  // for the PDF needs to know it is not there.
  const attachments = {
    available: source.files.length,
    copied: copied.reduce((n, c) => n + c.copied, 0),
    skipped: [...new Set(copied.flatMap((c) => c.skipped))]
  };
  if (attachments.skipped.length) {
    console.error(`[recharge] run ${runId} attachments: ${attachments.skipped.join('; ')}`);
  }

  return {
    status, posted: results.filter((r) => r.ok).length, failed: failed.length, results, attachments
  };
}

// ── Suggestions ─────────────────────────────────────────────────────────────

// Paid bills Bills Hub can actually act on: in a connected organisation, not
// already recharged. Bills in an organisation that is no longer connected
// cannot be recharged — planRun refuses them — so there is no sense reading
// them, and a dead tenant's orphaned bills would otherwise cost a failing
// Xero call each.
async function candidateBills(accountId, { limit = 200, billIds = null, supplier = null, tenantId = null } = {}) {
  const wazzocrAccountId = await grantSource.connectionsAccountId(accountId);
  const live = (await entities.listByAccount(accountId, wazzocrAccountId)).map((e) => e.xero_tenant_id);
  if (!live.length) return [];

  // A run raised in testing mode holds its bill only while testing mode is
  // still on — otherwise a bill tried once during testing would drop out of
  // the suggestions for good, held by a run nobody can see.
  const heldByTest = await testMode.isOn(accountId) ? '' : 'AND r.test_mode = 0';

  const where = [
    'b.account_id = ?',
    `b.xero_tenant_id IN (${live.map(() => '?').join(',')})`,
    // Marked paid in Bills Hub. A bill settled straight in Xero was not an
    // action here and does not set a recharge going.
    'b.marked_paid_at IS NOT NULL',
    `NOT EXISTS (SELECT 1 FROM recharge_runs r
                  WHERE r.account_id = b.account_id AND r.bill_id = b.id
                    AND r.status <> 'cancelled' ${heldByTest})`
  ];
  const params = [accountId, ...live];
  if (billIds && billIds.length) {
    where.push(`b.id IN (${billIds.map(() => '?').join(',')})`);
    params.push(...billIds.map(Number));
  }
  // Narrowed in SQL, not after the fact. Filtering a page of results would
  // report "3 bills" where the answer is three hundred, and a report that
  // undercounts is worse than no report.
  if (supplier) {
    where.push('b.contact_name LIKE ?');
    params.push(`%${String(supplier).replace(/[%_]/g, '\\$&')}%`);
  }
  if (tenantId) {
    where.push('b.xero_tenant_id = ?');
    params.push(tenantId);
  }
  // An organisation switched off in Settings is not synced and not shown, so
  // it must not be recharged either — its bills would otherwise be suggested
  // from a list nobody can see them in.
  where.push(bills.IN_USE);
  // The entity code comes along for the ride: a caller reporting on these
  // needs to say which company paid, and a tenant GUID tells nobody that.
  return db.query(
    `SELECT b.*, e.code AS entity_code, e.short_name AS entity_short
       FROM bills b
       LEFT JOIN entities e ON e.account_id = b.account_id AND e.xero_tenant_id = b.xero_tenant_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.fully_paid_on DESC, b.bill_date DESC LIMIT ?`,
    [...params, Number(limit)]
  );
}

// Paid bills a rule says belong somewhere else, which have not been
// recharged yet. This is the whole point of rules: surfacing what is owed
// between companies before somebody has to remember it.
async function suggestions(accountId, { limit = 50 } = {}) {
  const rules = await loadRules(accountId);
  if (!rules.text.length) return [];

  const candidates = await candidateBills(accountId, { limit: Math.max(limit * 4, 200) });
  const out = [];

  for (const bill of candidates) {
    if (out.length >= limit) break;
    const verdict = await decide(accountId, bill, { rules });
    if (verdict.outcome !== 'recharge') continue;
    out.push({
      bill,
      kind: verdict.kind,
      rule: verdict.rule,
      address: verdict.address || null,
      reason: verdict.reason,
      // An address rule has no name; the premises is what identifies it, and
      // it is also what somebody would look for on the tab.
      ruleName: verdict.kind === 'text'
        ? verdict.rule.name
        : verdict.rule.premises_address || null,
      lines: [{
        tenantId: verdict.ownerTenantId,
        code: verdict.ownerCode,
        shortName: verdict.ownerShort,
        sharePercent: 100,
        amount: Number(bill.total)
      }]
    });
  }
  return out;
}

// ── Posting them without being asked ────────────────────────────────────────

// A recharge is a consequence of paying a bill, not a separate decision
// somebody makes afterwards. Once the rules are right, the button is a
// chore: the same answer, clicked. So paying a bill posts its recharge.
//
// What makes that safe is that both documents are drafts. Nothing is
// authorised, nothing becomes a receivable, and a recharge raised from a
// rule that turns out to be wrong is deleted rather than credited.
//
// Not a loop over everything paid, ever: candidateBills already limits
// itself to bills marked paid in Bills Hub with no run against them, and a
// bill whose posting failed keeps its draft run, so the next sweep passes
// over it and leaves it for the Post to Xero button rather than retrying
// into the same error for ever.
const sweeping = new Set();

async function sweep(accountId, { limit = 50 } = {}) {
  const id = Number(accountId);
  const idle = { posted: 0, failed: 0, skipped: null };

  // The payment that just finished and the timer can arrive together. Both
  // would read the same suggestions and createRun would refuse the second,
  // which is correct but reads as an error for something that is not wrong.
  //
  // Claimed synchronously, before the first await. Checking the flag and
  // then awaiting anything before setting it leaves both callers past the
  // guard, which is the whole failure it is here to prevent.
  if (sweeping.has(id)) return { ...idle, skipped: 'already running' };
  sweeping.add(id);

  try {
    const settings = await model.getSettings(id);
    // Absent, on a database that has not been migrated yet, reads as off.
    // The wrong answer in that direction is a recharge nobody posted; in
    // the other it is documents in two organisations nobody asked for.
    if (!Number(settings.auto_post)) return { ...idle, skipped: 'switched off' };

    // Testing mode no longer stops this. It blocks the payment, not the
    // recharge: the two documents a recharge posts are DRAFTS, which is
    // exactly what somebody turning this switch on wants to inspect.

    const pending = await suggestions(id, { limit });
    let posted = 0;
    let failed = 0;
    for (const p of pending) {
      try {
        const run = await createRun(id, {
          billId: p.bill.id,
          ruleId: p.kind === 'address' ? p.rule.id : null,
          textRuleId: p.kind === 'text' ? p.rule.id : null
        });
        const out = await postRun(id, run.id);
        if (out.failed) {
          failed += 1;
          console.error(`[recharge] auto ${p.bill.reference || p.bill.id}: ${out.results.find((r) => !r.ok)?.error}`);
        } else {
          posted += 1;
          console.log(`[recharge] auto ${p.bill.reference || p.bill.id} → ${p.lines[0].code}`);
        }
      } catch (e) {
        // One bill that cannot be recharged must not stop the rest. Its run,
        // if one was made, carries the error and the runs tab offers it.
        failed += 1;
        console.error(`[recharge] auto ${p.bill.reference || p.bill.id} failed: ${e.message}`);
      }
    }
    return { posted, failed, skipped: null };
  } finally {
    sweeping.delete(id);
  }
}

// Called where a bill becomes paid. Deliberately not awaited by the payment:
// a batch of two hundred bills would hold the request open for four hundred
// Xero calls, and a recharge failing must never make a payment that
// succeeded look like it did not. Anything missed here is picked up by the
// timer below.
function sweepSoon(accountId) {
  setTimeout(() => {
    sweep(accountId).catch((e) => console.error('[recharge] auto sweep failed:', e.message));
  }, 1500).unref?.();
}

let timer = null;

// The safety net. sweepSoon fires in the same process that took the payment,
// so a restart in between loses it; Xero being briefly unreachable loses it
// too. Neither should mean a recharge never happens, so the same sweep runs
// on a timer and finds whatever is still waiting.
function startScheduler({ intervalMinutes = Number(process.env.RECHARGE_INTERVAL_MINUTES || 20) } = {}) {
  if (!intervalMinutes || timer) return;
  const db = require('../db');
  const tick = async () => {
    try {
      const accounts = await db.query("SELECT id FROM accounts WHERE status <> 'suspended'");
      for (const a of accounts) {
        const r = await sweep(a.id).catch((e) => {
          console.error(`[recharge] account ${a.id}:`, e.message);
          return null;
        });
        if (r && (r.posted || r.failed)) {
          console.log(`[recharge] account ${a.id}: ${r.posted} posted, ${r.failed} failed`);
        }
      }
    } catch (err) {
      console.error('[recharge] scheduler tick failed:', err.message);
    }
  };
  timer = setInterval(tick, intervalMinutes * 60000);
  if (timer.unref) timer.unref();
  console.log(`[recharge] posting recharges automatically, sweeping every ${intervalMinutes} min`);
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

// ── Recharge rules: waiting and Run now ─────────────────────────────────────

// Paid bills this one rule would act on: in scope by date and payer, no
// address rule has claimed them, and its conditions hold. The card's "N paid
// bills waiting" badge and Run now are the same question asked twice.
// `ignoreWritten` drops the "paid after the rule was written" test. Only the
// dialog's preview uses it, and only to answer a different question: not
// "what will this draft" — which for a rule that does not exist yet is
// always nothing — but "are these conditions picking out the bills I mean".
async function waitingFor(accountId, rule, { rules = null, limit = 200, ignoreWritten = false } = {}) {
  const all = rules || (await loadRules(accountId));

  // Rules are tried in order and the first match wins, so a bill an earlier
  // rule already claims is not this one's — even if its conditions hold. A
  // rule still being typed in the dialog has no id yet and is treated as
  // last, which is where saving would put it.
  const rank = (r) => [Number(r.position) || 0, Number(r.id) || Number.MAX_SAFE_INTEGER];
  const mine = rank(rule);
  const earlier = all.text.filter((r) => {
    if (Number(r.id) === Number(rule.id)) return false;
    const other = rank(r);
    return other[0] < mine[0] || (other[0] === mine[0] && other[1] < mine[1]);
  });

  const candidates = await candidateBills(accountId, { limit });
  const out = [];
  for (const bill of candidates) {
    if (rule.payer_tenant_id && rule.payer_tenant_id !== bill.xero_tenant_id) continue;
    if (!ignoreWritten && !withinStart(bill, rule)) continue;
    // Recharging an entity to itself does nothing.
    if (rule.owner_tenant_id === bill.xero_tenant_id) continue;
    if (!await conditionsMatch(accountId, bill, rule)) continue;
    if (earlier.length && await matchTextRule(accountId, bill, earlier)) continue;
    out.push(bill);
  }
  return out;
}

// How many bills each recharge rule is sitting on, for the badges. One pass
// over the candidates rather than one per rule.
async function waitingCounts(accountId, { rules = null } = {}) {
  const all = rules || (await loadRules(accountId));
  const counts = new Map(all.text.map((r) => [r.id, 0]));
  if (!all.text.length) return counts;

  for (const bill of await candidateBills(accountId, { limit: 400 })) {
    const hit = await matchTextRule(accountId, bill, all.text);
    if (hit && hit.owner_tenant_id !== bill.xero_tenant_id) {
      counts.set(hit.id, (counts.get(hit.id) || 0) + 1);
    }
  }
  return counts;
}

// Draft a recharge for every bill a rule is waiting on.
//
// Drafts only. Nothing reaches Xero here — the same rule as everywhere else
// in this module, and the reason Run now is safe to press.
async function runTextRule(accountId, ruleId) {
  const rule = await model.getTextRule(accountId, ruleId);
  if (!rule) throw err('Rule not found.', 404);
  if (!rule.owner_tenant_id) throw err('That rule has no entity to recharge to.', 400);

  const waiting = await waitingFor(accountId, rule);
  const drafted = [];
  const failed = [];
  for (const bill of waiting) {
    try {
      const out = await createRun(accountId, {
        billId: bill.id, ownerTenantId: rule.owner_tenant_id, textRuleId: rule.id
      });
      drafted.push({ billId: bill.id, runId: out.id, reference: bill.reference || bill.invoice_number });
    } catch (e) {
      // One bill that cannot be drafted is not a reason to abandon the rest.
      failed.push({ billId: bill.id, reference: bill.reference || bill.invoice_number, error: e.message });
    }
  }
  await model.markTextRuleRun(accountId, ruleId);
  return { drafted: drafted.length, failed: failed.length, runs: drafted, errors: failed };
}

module.exports = {
  decide, loadRules, premisesText, planRun, createRun, postRun, suggestions,
  contactsInXero,
  sweep, sweepSoon, startScheduler, stopScheduler, chartOfAccounts,
  waitingFor, waitingCounts, runTextRule, candidateBills,
  conditionsMatch, testCondition, withinStart, findOrCreateContact,
  isPaid, OUTCOMES, contactAddress, addressText,
  _contactCache, _textCache, _contactCache2
};
