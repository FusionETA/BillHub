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
      body: { Contacts: [{ Name: name }] }
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

// Load both rule sets once, so a scan over many bills does not re-query.
async function loadRules(accountId) {
  const [address, text] = await Promise.all([model.listRules(accountId), model.listTextRules(accountId)]);
  return {
    address: address.filter((r) => r.enabled && r.owner_tenant_id && r.suppliers.length),
    text: text.filter((r) => r.enabled && r.owner_tenant_id)
  };
}

// The address rule that best describes this bill's premises.
//
// A rule's suppliers narrow it: none means any supplier. Where several rules
// match, the most specific wins — a longer address beats a shorter one, then
// naming suppliers beats not, then a reference beats none. Without that the
// winner would be whichever row the database returned first, which is not a
// decision anybody made.
async function matchAddressRule(accountId, bill, rules) {
  const supplierKey = premisesLib.normalise(bill.contact_name);
  const reference = `${bill.reference || ''} ${bill.invoice_number || ''}`.toLowerCase();

  let best = null;
  for (const rule of rules) {
    // A rule with no supplier matches nothing. It cannot mean "any supplier":
    // that would recharge every paid bill in the account to one entity. Rules
    // written before the address came out can be in this state, and the tab
    // marks them as needing a supplier rather than quietly acting on them.
    if (!rule.suppliers.length) continue;
    if (!rule.suppliers.some((x) => x.key === supplierKey)) continue;
    if (rule.reference_contains
        && !reference.includes(String(rule.reference_contains).toLowerCase())) continue;

    // Where two rules name the same supplier, the one that also narrows on a
    // reference is the more specific and wins. Without this the winner would
    // be whichever row the database returned first, which is not a decision
    // anybody made.
    const score = rule.reference_contains ? String(rule.reference_contains).length + 1 : 0;
    if (!best || score > best.score) best = { rule, score, source: 'supplier' };
  }
  return best;
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

function verdictFor(rule, bill, { address = null, kind }) {
  const owner = rule.owner_short || rule.owner_code;
  const supplier = kind === 'address'
    ? (rule.suppliers.map((x) => x.name)[0] || bill.contact_name) : null;
  if (rule.owner_tenant_id === bill.xero_tenant_id) {
    return {
      outcome: 'own', rule, kind, address,
      reason: kind === 'address'
        ? `${owner} is both the entity ${supplier} is recharged to and the entity on the bill header, so it is paying its own bill. Nothing is recharged.`
        : `"${rule.name}" recharges to ${owner}, which is the entity on the bill header. Nothing is recharged.`
    };
  }
  return {
    outcome: 'recharge',
    rule, kind, address,
    ownerTenantId: rule.owner_tenant_id,
    ownerCode: rule.owner_code,
    ownerShort: rule.owner_short,
    // Two forms of the same sentence. `reason` stands alone; `consequence` is
    // for a view that has already named the supplier and would otherwise
    // name it twice.
    reason: kind === 'address'
      ? `${supplier} is recharged to ${owner}, so the full amount goes there.`
      : `"${rule.name}" matches this bill, so the full amount is recharged to ${owner}.`,
    consequence: kind === 'address'
      ? `${supplier} belongs to ${owner} — the full amount is recharged there.`
      : `Matches "${rule.name}" — the full amount is recharged to ${owner}.`
  };
}

// Runs one bill through both rule sets, supplier rules first. Never writes
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

  const hit = await matchAddressRule(accountId, bill, all.address);
  if (hit) return { ...verdictFor(hit.rule, bill, { kind: 'address' }), source: hit.source };

  const text = await matchTextRule(accountId, bill, all.text, { fetch, assumePaid });
  if (text) return verdictFor(text, bill, { kind: 'text' });

  // Separated from "no rule", because the two call for opposite actions. A
  // rule does cover this bill; it was paid before the rule's start date, and
  // the fix is to move that date back, not to write another rule.
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

  // Worth separating: a supplier rule names this supplier and was ruled out
  // by its reference. The rule looks configured and quietly never fires, and
  // that is invisible unless it is said out loud.
  const supplierKey = premisesLib.normalise(bill.contact_name);
  const named = all.address.filter((r) => r.suppliers.some((x) => x.key === supplierKey));
  if (named.length) {
    const refs = named.map((r) => r.reference_contains).filter(Boolean);
    return {
      outcome: 'no-rule',
      nearMiss: true,
      candidates: named,
      reason: refs.length
        ? `${named.length === 1 ? 'A supplier rule covers' : `${named.length} supplier rules cover`} `
          + `${bill.contact_name}, but ${named.length === 1 ? 'it is' : 'each is'} narrowed to a reference `
          + `(${refs.map((r) => `"${r}"`).join(', ')}) that this bill does not carry.`
        : `A supplier rule covers ${bill.contact_name} but has no supplier saved on it, so it matches nothing. `
          + 'Open it and choose the supplier.'
    };
  }

  return { outcome: 'no-rule', reason: `No rule covers ${bill.contact_name || 'this supplier'}.` };
}

// ── Planning ────────────────────────────────────────────────────────────────

// Validates a proposed recharge. One supplier, one owner, the whole amount —
// there is no split to work out, because a rule names a single entity.
async function planRun(accountId, { billId, ownerTenantId = null, ruleId = null, textRuleId = null }) {
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
  } else if (ruleId) {
    rule = await model.getRule(accountId, ruleId);
    kind = rule ? 'address' : null;
  } else if (textRuleId) {
    rule = await model.getTextRule(accountId, textRuleId);
    kind = rule ? 'text' : null;
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
    // Which kind of rule raised it, kept apart so a run can say so later.
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
    testMode: await testMode.isOn(accountId)
  });
  return { ...created, lines: plan.lines, payer: plan.payer, address: plan.address };
}

// ── Posting ─────────────────────────────────────────────────────────────────

// Creates both documents for every line that does not already have them.
//
// A line is posted in two steps and each id is saved as soon as Xero returns
// it, so a failure halfway leaves a precise record: retrying creates only what
// is missing, and never a duplicate of what already exists.
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
          headers: { 'Content-Type': file.MimeType || got.contentType }
        });
      copied += 1;
    } catch (e) {
      skipped.push(`${name}: ${e.message}`);
    }
  }
  return { tenantId, copied, skipped };
}

async function postRun(accountId, runId) {
  const run = await model.getRun(accountId, runId);
  if (!run) throw err('Recharge not found.', 404);
  if (run.status === 'cancelled') throw err('That recharge was cancelled.', 409);
  // Refused on the run's own flag, not on whether testing mode happens to be
  // on now. Somebody told this run it was a test; turning the switch off
  // later must not quietly turn it into a real one.
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
  const arCode = settings.ar_account_code || billCode;
  const apCode = settings.ap_account_code || billCode;
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
  if (!payer) throw err('The paying organisation is no longer connected.', 409);

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
      await model.setLineError(line.id, 'That organisation is no longer connected.');
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
              ...(currency ? { CurrencyCode: currency } : {}),
              Reference: line.reference,
              Status: 'DRAFT',
              LineAmountTypes: 'Exclusive',
              LineItems: [{
                Description: description,
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
  if (!rules.address.length && !rules.text.length) {
    const empty = [];
    empty.unmatched = [];
    return empty;
  }

  const candidates = await candidateBills(accountId, { limit: Math.max(limit * 4, 200) });
  const out = [];
  const unmatched = [];

  for (const bill of candidates) {
    if (out.length >= limit) break;
    const verdict = await decide(accountId, bill, { rules });
    if (verdict.outcome === 'no-rule' && verdict.nearMiss) {
      unmatched.push({ bill, reason: verdict.reason });
      continue;
    }
    if (verdict.outcome !== 'recharge') continue;
    out.push({
      bill,
      kind: verdict.kind,
      rule: verdict.rule,
      address: verdict.address || null,
      reason: verdict.reason,
      ruleName: verdict.kind === 'text' ? verdict.rule.name : null,
      lines: [{
        tenantId: verdict.ownerTenantId,
        code: verdict.ownerCode,
        shortName: verdict.ownerShort,
        sharePercent: 100,
        amount: Number(bill.total)
      }]
    });
  }
  out.unmatched = unmatched;
  return out;
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
    // An address rule outranks every recharge rule.
    if (await matchAddressRule(accountId, bill, all.address)) continue;
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
    if (await matchAddressRule(accountId, bill, all.address)) continue;
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
  waitingFor, waitingCounts, runTextRule, candidateBills,
  conditionsMatch, testCondition, withinStart, findOrCreateContact,
  isPaid, OUTCOMES, contactAddress, addressText,
  _contactCache, _textCache, _contactCache2
};
