// Intercompany recharge: address matching, the four-step decision, and the
// two-sided posting into Xero. Xero is stubbed at lib/xero.api so both
// documents' payloads are asserted.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.AUTH_DISABLED = 'false';
// Pin the grant source too: these suites exercise borrowed mode, the riskier
// of the two, whatever the local .env is set to. test/ownmode.test.js covers
// the other. Must precede any require of lib/grantSource.
process.env.XERO_GRANT_SOURCE = 'wazzocr';
// Xero is stubbed in these suites, so the credentials only need to exist —
// but they must exist, or ensureConfig refuses before the stub is reached.
process.env.XERO_CLIENT_ID = 'test-client-id';
process.env.XERO_CLIENT_SECRET = 'test-client-secret';

const http = require('http');
const db = require('../db');
const xero = require('../lib/xero');
const premises = require('../lib/premises');

const calls = [];
let invoiceSeq = 0;
let failOn = null;        // { tenantId, type } -> that Invoices POST throws
let lineItems = {};       // xeroInvoiceId -> [{ Description }]
let contactAddresses = {};// contactId -> [{ AddressType, AddressLine1, ... }]

xero.api = async (accountId, tenantId, path, opts = {}) => {
  calls.push({ tenantId, path, method: opts.method || 'GET', body: opts.body });

  // A single contact by id: where the premises lives when somebody puts it
  // on the supplier in Xero rather than on the bill.
  const oneContact = path.match(/^\/Contacts\/([^?]+)$/);
  if (oneContact && (opts.method || 'GET') === 'GET') {
    return { Contacts: [{ ContactID: oneContact[1], Addresses: contactAddresses[oneContact[1]] || [] }] };
  }
  if (path.startsWith('/Contacts') && (opts.method || 'GET') === 'GET') {
    // Pretend the counterparty contact does not exist, so the create path runs.
    return { Contacts: [] };
  }
  if (path === '/Contacts' && opts.method === 'POST') {
    return { Contacts: [{ ContactID: 'contact-' + opts.body.Contacts[0].Name.replace(/\W/g, ''), Name: opts.body.Contacts[0].Name }] };
  }
  // A single bill read, which is how the premises is found when nothing has
  // written it onto the bill yet.
  const one = path.match(/^\/Invoices\/([^?]+)$/);
  if (one && (opts.method || 'GET') === 'GET') {
    return { Invoices: [{ InvoiceID: one[1], LineItems: lineItems[one[1]] || [] }] };
  }
  if (path === '/TrackingCategories') return { TrackingCategories: [] };
  if (path === '/Invoices' && opts.method === 'POST') {
    const inv = opts.body.Invoices[0];
    if (failOn && failOn.tenantId === tenantId && failOn.type === inv.Type) {
      const e = new Error('Account code ' + inv.LineItems[0].AccountCode + ' does not exist in this organisation.');
      e.statusCode = 400;
      throw e;
    }
    invoiceSeq += 1;
    return {
      Invoices: [{
        InvoiceID: String(invoiceSeq).padStart(8, '0') + '-0000-0000-0000-000000000000',
        InvoiceNumber: (inv.Type === 'ACCREC' ? 'AR-IC-' : 'BILL-IC-') + (1000 + invoiceSeq),
        Type: inv.Type, Status: inv.Status
      }]
    };
  }
  return {};
};

const app = require('../server');
const server = app.listen(3316);

function req(method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: 3316, path, method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out ? JSON.parse(out) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// Marking a bill paid in Bills Hub, after something else has happened.
// A recharge rule only reaches bills marked paid after it was written, so a
// test that writes the rule second has to say when the paying happened.
async function paidNow(...ids) {
  for (const id of ids) {
    await db.execute('UPDATE bills SET marked_paid_at = NOW() WHERE id = ?', [id]);
  }
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok    ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

const KILANG = 'Kilang Ayu Borneo, Jalan Reko, 43000 Kajang';
const WISMA  = 'Wisma Ayu Borneo, Jalan Lintas, 88300 Kota Kinabalu';

let billSeq = 0;
// A paid bill in `tenant`, optionally with the premises already read onto it.
async function makeBill(tenant, { ref, supplier, total, address = null, paid = true, lines = null, tracking = null, paidOn = '2026-08-08', accountCode = '445' }) {
  billSeq += 1;
  const xid = `beefbeef-0000-4000-8000-${String(billSeq).padStart(12, '0')}`;
  // Every bill in Xero has an account code on its lines — Xero will not
  // approve one without. The recharge takes its own code from here.
  lineItems[xid] = (lines || ['Line']).map((d) => ({
    Description: d,
    AccountCode: accountCode,
    LineAmount: total,
    Tracking: (tracking || []).map((t) => ({ Name: t[0], Option: t[1] }))
  }));
  const res = await db.execute(
    `INSERT INTO bills (account_id, xero_tenant_id, xero_invoice_id, invoice_number, reference,
       contact_id, contact_name, xero_status, bill_date, due_date, fully_paid_on, currency_code,
       total, amount_paid, amount_due, premises_address, premises_source, marked_paid_at)
     VALUES (1,?,?,?,?,?,?,?,'2026-07-28','2026-08-25',?,'MYR',?,?,?,?,?, IF(?, NOW(), NULL))`,
    [tenant, xid, `INV-${ref}`, ref, `c-${supplier}`, supplier,
     paid ? 'PAID' : 'AUTHORISED', paid ? paidOn : null,
     total, paid ? total : 0, paid ? 0 : total,
     address, address ? 'ocr' : null, paid ? 1 : 0]
  );
  // The id of the row just written, not of whatever else shares the
  // reference — the seed carries its own EPF-0826.
  return res.insertId;
}

(async () => {
  await require('./seed').seed({ quiet: true });
  await db.execute('DELETE FROM recharge_run_lines');
  await db.execute('DELETE FROM recharge_runs');
  await db.execute('DELETE FROM recharge_rules');
  // Both rule tables, or rules left by the last run claim this run's bills
  // first and every waiting count comes out zero.
  await db.execute('DELETE FROM recharge_text_conditions');
  await db.execute('DELETE FROM recharge_text_rules');
  await db.execute('DELETE FROM recharge_settings');
  await db.execute("DELETE FROM bills WHERE account_id = 1 AND xero_invoice_id LIKE 'beefbeef-%'");

  const login = await req('POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'billhub-local-test' } });
  const cookie = (login.headers['set-cookie'] || [])[0].split(';')[0];

  const ents = (await req('GET', '/api/bills/entities', { cookie })).body.entities;
  const kk = ents.find((e) => e.code === 'ABKK');
  const kj = ents.find((e) => e.code === 'ABKJ');
  const abm = ents.find((e) => e.code === 'ABM');
  check('the three organisations this suite needs are connected', Boolean(kk && kj && abm),
    ents.map((e) => e.code));

  console.log('Normalising an address');
  check('spaces, commas and case are irrelevant',
    premises.normalise('Kilang Ayu Borneo, Jalan Reko, 43000 Kajang')
    === premises.normalise('KILANG AYU BORNEO JALAN REKO  43000 KAJANG.'));
  check('digits are kept — a postcode separates two premises on one street',
    premises.normalise('Lot 3, 43000').includes('43000'));
  check('an address inside a longer line still matches',
    Boolean(premises.match('Electricity — ' + KILANG + ' — Aug 2026', KILANG)));
  check('a different premises does not match', premises.match(WISMA, KILANG) === null);
  check('a near-empty address matches nothing, however it is written',
    premises.match('anything at all', 'Lot 3') === null);
  check('the more specific of two overlapping addresses wins',
    premises.best('unit 9 jalan reko 43000 kajang kilang block b', [
      { premises_address: 'Jalan Reko, 43000 Kajang' },
      { premises_address: 'Unit 9, Jalan Reko, 43000 Kajang' }
    ]).rule.premises_address === 'Unit 9, Jalan Reko, 43000 Kajang');

  console.log('\nShortening an entity for a reference');
  const entityRef = require('../lib/entityRef');
  const AB = [
    { code: 'ABKJ', short_name: 'Ayu Borneo (KJ)' },
    { code: 'ABKK', short_name: 'Ayu Borneo (KK)' },
    { code: 'ABSDK', short_name: 'Ayu Borneo (SDK)' },
    { code: 'ABM', short_name: 'Ayu Borneo Management' }
  ];
  const abCodes = AB.map((e) => e.code);
  check('the name says what distinguishes the organisation',
    AB.slice(0, 3).map((e) => entityRef.short(e, abCodes)).join() === 'KJ,KK,SDK',
    AB.map((e) => entityRef.short(e, abCodes)));
  // Read from the entity's own name, not from the set it sits in: connecting
  // an organisation from outside the group must not lengthen everyone else's
  // references.
  check('an unrelated organisation joining changes nothing',
    entityRef.short(AB[0], abCodes.concat(['DCGLOBAL'])) === 'KJ');
  check('a name with no bracketed suffix falls back to the shared prefix',
    entityRef.short({ code: 'ABSH', short_name: 'Ayu Borneo Sabah' }, ['ABSH', 'ABKJ', 'ABKK']) === 'SH');
  check('and to the code itself when there is no shared prefix either',
    entityRef.short({ code: 'ABSH', short_name: 'Ayu Borneo Sabah' }, ['ABSH', 'DCGLOBAL']) === 'ABSH');
  // Two entities whose references cannot be told apart is far worse than one
  // long reference.
  check('a prefix that would empty a code is not taken',
    entityRef.commonPrefix(['ABKJ', 'AB']) === '');
  check('punctuation in a bracketed name is dropped, not carried into a bank file',
    entityRef.short({ code: 'X', short_name: 'Something (K.J-1)' }) === 'KJ1');

  console.log('\nAccount codes come off the bill, not from a settings page');
  const billKilang = await makeBill(abm.tenantId, {
    ref: 'TNB-GRP-0726', supplier: 'Tenaga Nasional Berhad', total: 17980.00, address: KILANG
  });
  // Nothing to configure. A recharge moves a cost between companies without
  // changing what the cost is, so both documents carry the account the
  // original bill was booked to.
  const noCodes = await req('POST', '/api/recharge/plan', {
    cookie, body: { billId: billKilang, ownerTenantId: kj.tenantId }
  });
  check('planning needs no account codes set up first', noCodes.status === 200, noCodes.body);

  const cfg = await req('PATCH', '/api/recharge/settings', {
    cookie, body: { taxType: 'NONE', referencePrefix: 'IC-', dueDays: 30 }
  });
  check('the settings that remain still save', cfg.status === 200 && cfg.body.settings.referencePrefix === 'IC-', cfg.body.settings);

  console.log('\nAddress rules');
  const rule = await req('POST', '/api/recharge/rules', {
    cookie,
    body: { suppliers: ['Tenaga Nasional Berhad'], premisesAddress: KILANG, ownerTenantId: kj.tenantId }
  });
  check('a rule is created', rule.status === 201, rule.body);
  check('it reads as both of the things it can do',
    rule.body.rule.effect === `Header ABKJ: no recharge · Any other header: 100% recharged to ABKJ`,
    rule.body.rule.effect);
  check('it names the supplier it covers',
    rule.body.rule.supplierLabel === 'Tenaga Nasional Berhad', rule.body.rule.supplierLabel);

  const noAddress = await req('POST', '/api/recharge/rules', {
    cookie, body: { suppliers: ['X Supplier'], ownerTenantId: kj.tenantId }
  });
  check('a rule with no address is refused — it would decide nothing',
    noAddress.status === 400 && /premises address is required/i.test(noAddress.body.error), noAddress.body.error);

  const tooShort = await req('POST', '/api/recharge/rules', {
    cookie, body: { suppliers: ['X Supplier'], premisesAddress: 'Lot 3', ownerTenantId: kj.tenantId }
  });
  check('an address too short to identify a premises is refused',
    tooShort.status === 400 && /too short/i.test(tooShort.body.error), tooShort.body.error);

  const noOwner = await req('POST', '/api/recharge/rules', {
    cookie, body: { suppliers: ['X Supplier'], premisesAddress: WISMA }
  });
  check('a rule with no owner is refused',
    noOwner.status === 400 && /entity to recharge to/i.test(noOwner.body.error), noOwner.body.error);

  // Same supplier, same place, typed differently. The second says nothing the
  // first does not, and two rules for one bill is not a decision anybody made.
  const dup = await req('POST', '/api/recharge/rules', {
    cookie,
    body: { suppliers: ['TENAGA NASIONAL BERHAD'], premisesAddress: 'KILANG AYU BORNEO JALAN REKO 43000 KAJANG', ownerTenantId: kk.tenantId }
  });
  check('a duplicate supplier + premises is refused, however it is punctuated',
    dup.status === 409 && /already recharged to ABKJ/.test(dup.body.error), dup.body.error);

  // Same premises, different supplier: the water bill and the electricity bill
  // for one building are two different rules and both are legitimate.
  const water = await req('POST', '/api/recharge/rules', {
    cookie,
    body: { suppliers: ['Jabatan Air Negeri Sabah'], premisesAddress: WISMA, ownerTenantId: kk.tenantId }
  });
  check('a second supplier at a different premises is fine', water.status === 201, water.body);

  console.log('\nPaid means paid HERE');
  // The sync writes xero_status and fully_paid_on from Xero, so both are
  // true of every bill anyone has ever settled directly in Xero —
  // thousands of them, none the result of anything done in Bills Hub.
  const inXeroOnly = await makeBill(abm.tenantId, {
    ref: 'TNB-XERO-0826', supplier: 'Tenaga Nasional Berhad', total: 1200.00, address: KILANG
  });
  await db.execute('UPDATE bills SET marked_paid_at = NULL WHERE id = ?', [inXeroOnly]);
  const vXero = await verdict(inXeroOnly);
  check('a bill settled in Xero but not here does not set a recharge going',
    vXero.outcome === 'unpaid', vXero);
  check('and says where the paying has to happen',
    /marked paid in Bills Hub/.test(vXero.reason), vXero.reason);
  check('it is not offered as a candidate either',
    !(await req('GET', '/api/recharge/suggestions', { cookie })).body.suggestions
      .some((x) => x.reference === 'TNB-XERO-0826'));
  await paidNow(inXeroOnly);
  check('marking it paid here is what makes it one',
    (await verdict(inXeroOnly)).outcome === 'recharge');
  await db.execute('DELETE FROM bills WHERE id = ?', [inXeroOnly]);

  console.log('\nThe four steps');
  async function verdict(billId) {
    return (await req('GET', `/api/recharge/bills/${billId}/decide`, { cookie })).body;
  }

  const vRecharge = await verdict(billKilang);
  check('step 4: an address owned by another entity is recharged',
    vRecharge.outcome === 'recharge' && vRecharge.ownerCode === 'ABKJ', vRecharge);
  check('and says why, naming the premises', /Kilang Ayu Borneo/.test(vRecharge.reason), vRecharge.reason);

  // ABKJ owns this address and is on the header: it is paying its own bill.
  const ownBill = await makeBill(kj.tenantId, {
    ref: 'TNB-KJ-0826', supplier: 'Tenaga Nasional Berhad', total: 3410.75, address: KILANG
  });
  const vOwn = await verdict(ownBill);
  check('step 4: the address owner paying its own bill is not a recharge',
    vOwn.outcome === 'own', vOwn);

  const unpaidBill = await makeBill(abm.tenantId, {
    ref: 'TNB-GRP-0926', supplier: 'Tenaga Nasional Berhad', total: 5120.00, address: KILANG, paid: false
  });
  const vUnpaid = await verdict(unpaidBill);
  check('step 3: an unpaid bill is never recharged', vUnpaid.outcome === 'unpaid', vUnpaid);

  const otherBill = await makeBill(abm.tenantId, {
    ref: 'MISC-0826', supplier: 'Swanston Security', total: 400.00, address: KILANG
  });
  check('step 2: a supplier no rule names is left alone',
    (await verdict(otherBill)).outcome === 'no-rule');

  const elsewhere = await makeBill(abm.tenantId, {
    ref: 'TNB-OTHER-0826', supplier: 'Tenaga Nasional Berhad', total: 700.00,
    address: 'Lot 12, Jalan Bulan Sabit, 98000 Miri'
  });
  const vNoMatch = await verdict(elsewhere);
  check('step 4: a premises no rule names is reported, not guessed at',
    vNoMatch.outcome === 'no-rule' && /does not appear on this bill/.test(vNoMatch.reason), vNoMatch);

  console.log('\nFinding the premises when nothing has written it onto the bill');
  // No premises_address — the only place the address appears is the line
  // description, which the sync does not fetch.
  const fromLines = await makeBill(abm.tenantId, {
    ref: 'TNB-LINE-0826', supplier: 'Tenaga Nasional Berhad', total: 2200.00,
    address: null, lines: ['Electricity ' + KILANG + ' Aug 2026']
  });
  const vLines = await verdict(fromLines);
  check('the address is read off the bill in Xero', vLines.outcome === 'recharge', vLines);

  calls.length = 0;
  await verdict(fromLines);
  check('and not read again — a repeat costs Xero nothing',
    calls.filter((c) => /^\/Invoices\//.test(c.path)).length === 0, calls.map((c) => c.path));

  console.log('\nThe premises on the supplier contact');
  // Where it goes when somebody fills in Xero's "Billing address" on a
  // contact that bills one premises. Xero returns that box as POBOX and the
  // delivery one as STREET, so both are read — checking only STREET would
  // miss the field people actually fill in.
  const CONTACT_ADDR = 'Lot 9, Jalan Perusahaan Empat, 68100 Batu Caves';
  await req('POST', '/api/recharge/rules', {
    cookie, body: { suppliers: ['Tenaga Nasional Berhad - Lot 9'], premisesAddress: CONTACT_ADDR, ownerTenantId: kk.tenantId }
  });
  contactAddresses['c-Tenaga Nasional Berhad - Lot 9'] = [
    { AddressType: 'STREET' },
    { AddressType: 'POBOX', AddressLine1: 'Lot 9, Jalan Perusahaan Empat\n', City: 'Batu Caves', PostalCode: '68100' }
  ];
  const onContact = await makeBill(abm.tenantId, {
    ref: 'TNB-LOT9-0826', supplier: 'Tenaga Nasional Berhad - Lot 9', total: 1850.00
  });
  const vContact = await verdict(onContact);
  check('an address on the contact decides the bill',
    vContact.outcome === 'recharge' && vContact.ownerCode === 'ABKK', vContact);
  check('and the bill itself carried nothing to match',
    (await db.getOne('SELECT premises_address FROM bills WHERE id = ?', [onContact])).premises_address === null);

  // One contact carries 1,681 bills on the live account. Reading it per bill
  // would be 1,681 calls for one answer.
  calls.length = 0;
  await verdict(onContact);
  check('the contact is not read again for the same bill',
    calls.filter((c) => /^\/Contacts\//.test(c.path)).length === 0, calls.map((c) => c.path));
  const sibling = await makeBill(abm.tenantId, {
    ref: 'TNB-LOT9-0926', supplier: 'Tenaga Nasional Berhad - Lot 9', total: 1910.00
  });
  calls.length = 0;
  check('nor for another bill from the same contact',
    (await verdict(sibling)).outcome === 'recharge'
    && calls.filter((c) => /^\/Contacts\//.test(c.path)).length === 0, calls.map((c) => c.path));

  // The bill's own address still wins: WazzOCR read it off the document,
  // and the contact is only where somebody put it by hand. Both rules cover
  // this supplier, so the two sources genuinely compete.
  const MOVED = 'Lot 44, Jalan Perindustrian Tujuh, 47100 Puchong';
  await req('POST', '/api/recharge/rules', {
    cookie, body: { suppliers: ['Tenaga Nasional Berhad - Lot 9'], premisesAddress: MOVED, ownerTenantId: kj.tenantId }
  });
  await db.execute("UPDATE bills SET premises_address = ?, premises_source = 'ocr' WHERE id = ?", [MOVED, sibling]);
  const vMoved = await verdict(sibling);
  check('a premises read off the document outranks the contact',
    vMoved.ownerCode === 'ABKJ' && vMoved.address === MOVED, vMoved);

  console.log('\nOffering the contact\'s own wording');
  // Matching forgives punctuation but not a missing word, so retyping an
  // address across forty contacts is a silent miss waiting to happen. The
  // dialog offers Xero's exact wording to copy.
  const look = await req('POST', '/api/recharge/contact-addresses', {
    cookie, body: { suppliers: ['Tenaga Nasional Berhad - Lot 9'] }
  });
  const got = look.body.suppliers[0];
  check('the address Xero holds on a supplier can be looked up',
    look.status === 200 && /Jalan Perusahaan Empat/.test(got.address || ''), look.body);
  check('and it is offered one way round, not both',
    !(got.address || '').includes(' | '), got.address);
  check('a rule written from it matches the bills it covers',
    Boolean(require('../lib/premises').match(
      require('../billhub/recharge').addressText({ Addresses: contactAddresses['c-Tenaga Nasional Berhad - Lot 9'] }),
      got.address)));

  // A rule can name several suppliers — electricity, water and rent at one
  // building is one rule, not three — so the lookup takes them all. Their
  // contacts disagreeing is the thing worth knowing before saving.
  // The water board at the same building. Its own contact, its own address
  // field, the same premises — which is the case one rule is meant to cover.
  const WATER = 'Air Selangor - Lot 9';
  contactAddresses[`c-${WATER}`] = [
    { AddressType: 'POBOX', AddressLine1: 'Lot 9, Jalan Perusahaan Empat', City: 'Batu Caves', PostalCode: '68100' }
  ];
  await makeBill(abm.tenantId, { ref: 'AS-LOT9-0826', supplier: WATER, total: 310.00 });

  const several = await req('POST', '/api/recharge/contact-addresses', {
    cookie, body: { suppliers: ['Tenaga Nasional Berhad - Lot 9', WATER] }
  });
  check('several suppliers are looked up at once', several.body.suppliers.length === 2, several.body);
  check('and two contacts at one premises agree, so one rule covers both',
    new Set(several.body.suppliers.map((x) => x.address)).size === 1,
    several.body.suppliers.map((x) => x.address));

  // Two contacts at different premises cannot share a rule, and the dialog
  // has to say so rather than quietly offering the first address.
  const OTHER = 'Air Selangor - Lot 77';
  contactAddresses[`c-${OTHER}`] = [
    { AddressType: 'POBOX', AddressLine1: 'Lot 77, Jalan Lain Sekali', City: 'Shah Alam', PostalCode: '40000' }
  ];
  await makeBill(abm.tenantId, { ref: 'AS-LOT77-0826', supplier: OTHER, total: 290.00 });
  const mixed = await req('POST', '/api/recharge/contact-addresses', {
    cookie, body: { suppliers: [WATER, OTHER] }
  });
  check('two different premises come back as two different addresses',
    new Set(mixed.body.suppliers.map((x) => x.address)).size === 2,
    mixed.body.suppliers.map((x) => x.address));

  const none = await req('POST', '/api/recharge/contact-addresses', {
    cookie, body: { suppliers: ['Nobody At All'] }
  });
  check('a supplier with no bills says so rather than erroring',
    none.status === 200 && none.body.suppliers[0].address === null, none.body);

  console.log('\nAsking what a bill would do before it is paid');
  const ahead = await req('POST', '/api/recharge/decide', {
    cookie, body: { billIds: [unpaidBill], assumePaid: true }
  });
  check('assumePaid answers the question the Pay dialog is actually asking',
    ahead.body.decisions[0].outcome === 'recharge', ahead.body.decisions[0]);
  check('with a short form that does not repeat the address',
    !ahead.body.decisions[0].consequence.includes('Kilang'), ahead.body.decisions[0].consequence);

  console.log('\nPlanning');
  const self = await req('POST', '/api/recharge/plan', {
    cookie, body: { billId: billKilang, ownerTenantId: abm.tenantId }
  });
  check('an entity cannot recharge to itself',
    self.status === 400 && /paying its own bill/.test(self.body.error), self.body.error);

  const notPaid = await req('POST', '/api/recharge/plan', {
    cookie, body: { billId: unpaidBill, ownerTenantId: kj.tenantId }
  });
  check('a bill not marked paid in Bills Hub cannot be recharged',
    notPaid.status === 400 && /has not been marked paid in Bills Hub/.test(notPaid.body.error),
    notPaid.body.error);

  const plan = await req('POST', '/api/recharge/plan', { cookie, body: { billId: billKilang } });
  check('the rules work out the plan on their own', plan.status === 200, plan.body);
  check('the whole bill goes to the address owner',
    plan.body.lines.length === 1 && plan.body.lines[0].code === 'ABKJ'
    && plan.body.lines[0].amount === '17,980.00', plan.body.lines);
  // "Ayu Borneo (KJ)" says KJ is what distinguishes it; the group's own
  // prefix inside the group's own reference says nothing.
  check('the reference carries the short form of the entity',
    /^IC-TNB-GRP-0726-KJ$/.test(plan.body.lines[0].reference), plan.body.lines[0].reference);
  check('the plan carries the address that decided it', plan.body.address === KILANG, plan.body.address);
  check('planning writes nothing',
    Number((await db.getOne('SELECT COUNT(*) AS n FROM recharge_runs')).n) === 0);

  console.log('\nCreating a run');
  calls.length = 0;
  const run = await req('POST', '/api/recharge/runs', { cookie, body: { billId: billKilang } });
  check('the run is created', run.status === 201 && run.body.id, run.body);
  check('creating it does NOT touch Xero', calls.length === 0, calls.map((c) => c.path));
  const runId = run.body.id;
  const stored = await db.getOne('SELECT status, premises_address FROM recharge_runs WHERE id = ?', [runId]);
  check('it starts as a draft', stored.status === 'draft', stored.status);
  check('the address is snapshotted, so editing the rule later cannot rewrite history',
    stored.premises_address === KILANG, stored.premises_address);

  const twice = await req('POST', '/api/recharge/runs', { cookie, body: { billId: billKilang } });
  check('the same bill cannot be recharged twice',
    twice.status === 409 && /already recharged/.test(twice.body.error), twice.body.error);

  // The unique key has to say the same thing the message does. A plain
  // UNIQUE (account_id, bill_id) counts cancelled runs too, so cancelling
  // and starting again failed at the database with a duplicate-key error
  // rather than working, which is the opposite of what cancel is for.
  const scratch = await makeBill(abm.tenantId, {
    ref: 'TNB-CANCEL-0826', supplier: 'Tenaga Nasional Berhad', total: 42.00, address: KILANG
  });
  const first = await req('POST', '/api/recharge/runs', { cookie, body: { billId: scratch } });
  await req('POST', `/api/recharge/runs/${first.body.id}/cancel`, { cookie });
  const redrafted = await req('POST', '/api/recharge/runs', { cookie, body: { billId: scratch } });
  check('cancelling a run really does release its bill', redrafted.status === 201, redrafted.body);
  await req('POST', `/api/recharge/runs/${redrafted.body.id}/cancel`, { cookie });

  console.log('\nPosting both sides to Xero');
  calls.length = 0;
  const posted = await req('POST', `/api/recharge/runs/${runId}/post`, { cookie });
  check('the line posts', posted.body.posted === 1 && posted.body.failed === 0, posted.body);
  check('the run becomes posted', posted.body.status === 'posted', posted.body.status);

  const invoices = calls.filter((c) => c.path === '/Invoices' && c.method === 'POST');
  check('two documents are created', invoices.length === 2, invoices.length);

  const ar = invoices.filter((c) => c.body.Invoices[0].Type === 'ACCREC');
  const ap = invoices.filter((c) => c.body.Invoices[0].Type === 'ACCPAY');
  check('the AR invoice is raised in the payer', ar.every((c) => c.tenantId === abm.tenantId), ar.map((c) => c.tenantId));
  check('the mirror bill is raised in the address owner',
    ap.every((c) => c.tenantId === kj.tenantId), ap.map((c) => c.tenantId));
  check('the AR invoice is authorised, the subsidiary bill is a draft',
    ar[0].body.Invoices[0].Status === 'AUTHORISED' && ap[0].body.Invoices[0].Status === 'DRAFT',
    { ar: ar[0].body.Invoices[0].Status, ap: ap[0].body.Invoices[0].Status });
  // The payer's electricity expense nets to zero and the company that used
  // the electricity carries it as electricity. Nobody configured anything.
  check('both sides post to the account the original bill was booked to',
    ar[0].body.Invoices[0].LineItems[0].AccountCode === '445'
    && ap[0].body.Invoices[0].LineItems[0].AccountCode === '445',
    { ar: ar[0].body.Invoices[0].LineItems[0].AccountCode, ap: ap[0].body.Invoices[0].LineItems[0].AccountCode });
  check('both sides carry the same amount and reference',
    ar[0].body.Invoices[0].LineItems[0].UnitAmount === ap[0].body.Invoices[0].LineItems[0].UnitAmount
    && ar[0].body.Invoices[0].Reference === ap[0].body.Invoices[0].Reference,
    { ar: ar[0].body.Invoices[0].Reference, ap: ap[0].body.Invoices[0].Reference });
  check('the premises is on the face of both documents, which is why they exist',
    ar[0].body.Invoices[0].LineItems[0].Description.includes(KILANG)
    && ap[0].body.Invoices[0].LineItems[0].Description.includes(KILANG),
    ar[0].body.Invoices[0].LineItems[0].Description);
  check('the counterparty contact is created where it is missing',
    calls.some((c) => c.path === '/Contacts' && c.method === 'POST'), 'no contact created');

  calls.length = 0;
  const again = await req('POST', `/api/recharge/runs/${runId}/post`, { cookie });
  check('re-posting creates nothing new',
    calls.filter((c) => c.path === '/Invoices' && c.method === 'POST').length === 0 && again.body.posted === 1,
    calls.map((c) => c.path));

  const cancelPosted = await req('POST', `/api/recharge/runs/${runId}/cancel`, { cookie });
  check('a posted recharge cannot be cancelled', cancelPosted.status === 409, cancelPosted.body.error);

  // A group that wants a dedicated intercompany account can still say so.
  await req('PATCH', '/api/recharge/settings', { cookie, body: { arAccountCode: '260', apAccountCode: '429' } });
  const overridden = await makeBill(abm.tenantId, {
    ref: 'TNB-OVERRIDE-0826', supplier: 'Tenaga Nasional Berhad', total: 90.00,
    address: KILANG, accountCode: '445'
  });
  const ovRun = await req('POST', '/api/recharge/runs', { cookie, body: { billId: overridden } });
  calls.length = 0;
  await req('POST', `/api/recharge/runs/${ovRun.body.id}/post`, { cookie });
  const ovInv = calls.filter((c) => c.path === '/Invoices' && c.method === 'POST');
  check('a configured account code overrides the bill\'s own',
    ovInv.find((c) => c.body.Invoices[0].Type === 'ACCREC').body.Invoices[0].LineItems[0].AccountCode === '260'
    && ovInv.find((c) => c.body.Invoices[0].Type === 'ACCPAY').body.Invoices[0].LineItems[0].AccountCode === '429',
    ovInv.map((c) => `${c.body.Invoices[0].Type}:${c.body.Invoices[0].LineItems[0].AccountCode}`));
  await req('PATCH', '/api/recharge/settings', { cookie, body: { arAccountCode: '', apAccountCode: '' } });

  console.log('\nA failure on one side leaves an exact record');
  const billWisma = await makeBill(abm.tenantId, {
    ref: 'JANS-WL-0826', supplier: 'Jabatan Air Negeri Sabah', total: 1240.50, address: WISMA
  });
  const run2 = await req('POST', '/api/recharge/runs', { cookie, body: { billId: billWisma } });
  check('the water rule picks the other owner', run2.status === 201, run2.body);
  failOn = { tenantId: kk.tenantId, type: 'ACCPAY' };
  const partial = await req('POST', `/api/recharge/runs/${run2.body.id}/post`, { cookie });
  check('the failing line is reported', partial.body.failed === 1 && partial.body.posted === 0, partial.body);
  check('the run stays draft so it can be retried', partial.body.status === 'draft', partial.body.status);

  const halfLine = await db.getOne('SELECT ar_invoice_id, ap_invoice_id, line_error FROM recharge_run_lines WHERE run_id = ?', [run2.body.id]);
  check('the AR side that succeeded is remembered', Boolean(halfLine.ar_invoice_id), halfLine);
  check('the AP side is still missing, with the reason',
    !halfLine.ap_invoice_id && /Account code 445 does not exist/.test(halfLine.line_error), halfLine.line_error);

  failOn = null;
  calls.length = 0;
  const retry = await req('POST', `/api/recharge/runs/${run2.body.id}/post`, { cookie });
  const retryInvoices = calls.filter((c) => c.path === '/Invoices' && c.method === 'POST');
  check('a retry creates only the missing document',
    retryInvoices.length === 1 && retryInvoices[0].body.Invoices[0].Type === 'ACCPAY',
    retryInvoices.map((c) => c.body.Invoices[0].Type));
  check('and the run is then posted', retry.body.status === 'posted', retry.body.status);

  console.log('\nThe runs table');
  const view = await req('GET', '/api/recharge', { cookie });
  const row = view.body.runRows.find((c) => c.id === runId);
  check('the run row shows the address that decided it', row.address === KILANG, row.address);
  check('and names the rule in its notes', /^Address rule · /.test(row.notes), row.notes);
  check('it links all three documents into Xero',
    Boolean(row.billUrl && row.invoiceUrl && row.billNoUrl),
    { bill: row.billUrl, invoice: row.invoiceUrl, billNo: row.billNoUrl });
  check('the sales invoice and the bill use different Xero screens',
    /AccountsReceivable/.test(row.invoiceUrl) && /AccountsPayable/.test(row.billNoUrl),
    { invoice: row.invoiceUrl, billNo: row.billNoUrl });

  // A recharge spans two organisations. Without the short code a link opens
  // whichever org the person was last in, which is a coin toss between the
  // two — and silently shows the wrong company's ledger.
  await db.execute("UPDATE entities SET short_code = '!payer' WHERE account_id = 1 AND xero_tenant_id = ?", [abm.tenantId]);
  await db.execute("UPDATE entities SET short_code = '!owner' WHERE account_id = 1 AND xero_tenant_id = ?", [kj.tenantId]);
  const linked = (await req('GET', '/api/recharge', { cookie })).body.runRows.find((c) => c.id === runId);
  // Xero's own short codes begin with "!", and Xero's own links leave it
  // unescaped — encodeURIComponent agrees, so the two match.
  check('a known short code makes the link switch organisation first',
    /organisationlogin/.test(linked.invoiceUrl) && /shortcode=!payer/.test(linked.invoiceUrl),
    linked.invoiceUrl);
  check('and the mirror bill switches to the other organisation, not the payer',
    /shortcode=!owner/.test(linked.billNoUrl), linked.billNoUrl);
  check('the document itself is still the redirect target',
    decodeURIComponent(linked.billNoUrl).includes('/AccountsPayable/View.aspx?InvoiceID='),
    linked.billNoUrl);
  await db.execute('UPDATE entities SET short_code = NULL WHERE account_id = 1');

  check('a posted run reads as posted', row.statusLabel === 'Posted to Xero', row.statusLabel);
  check('settlement is not tracked here — Xero holds that answer',
    row.settled === undefined && row.canSettle === undefined, row);

  console.log('\nSuggestions');
  const sugg = await req('GET', '/api/recharge/suggestions', { cookie });
  const refs = sugg.body.suggestions.map((s) => s.reference);
  check('a paid bill whose premises belongs elsewhere is suggested',
    refs.includes('TNB-LINE-0826'), refs);
  check('the owner paying its own bill is not', !refs.includes('TNB-KJ-0826'), refs);
  check('an unpaid bill is not', !refs.includes('TNB-GRP-0926'), refs);
  check('a premises no rule names is not', !refs.includes('TNB-OTHER-0826'), refs);
  check('an already-recharged bill is not', !refs.includes('TNB-GRP-0726'), refs);

  // The silent-failure case: a rule names the supplier, the address on the
  // bill is not the one in the rule, and nothing happens. Said out loud,
  // because a rule that never fires looks like a rule with nothing to do.
  const viewNow = await req('GET', '/api/recharge', { cookie });
  const unmatchedRefs = (viewNow.body.unmatched || []).map((u) => u.reference);
  check('a bill a rule should have covered and did not is reported',
    unmatchedRefs.includes('TNB-OTHER-0826'), unmatchedRefs);
  check('and a supplier no rule names is not reported as a miss',
    !unmatchedRefs.includes('MISC-0826'), unmatchedRefs);

  const one = sugg.body.suggestions.find((s) => s.reference === 'TNB-LINE-0826');
  check('a suggestion carries the address and the owner',
    one && one.address === KILANG && one.ownerCode === 'ABKJ', one);

  const fromSugg = await req('POST', '/api/recharge/runs', {
    cookie, body: { billId: one.billId, ruleId: one.ruleId, ownerTenantId: one.ownerTenantId }
  });
  check('a suggestion can be turned into a run', fromSugg.status === 201, fromSugg.body);
  const after = await req('GET', '/api/recharge/suggestions', { cookie });
  check('and then stops being suggested',
    !after.body.suggestions.some((x) => x.reference === 'TNB-LINE-0826'),
    after.body.suggestions.map((s) => s.reference));

  console.log('\nEditing a rule');
  const moved = await req('PATCH', '/api/recharge/rules/' + rule.body.rule.id, {
    cookie, body: { ownerTenantId: kk.tenantId }
  });
  check('the owner can be changed', moved.status === 200 && moved.body.rule.ownerCode === 'ABKK', moved.body.rule);
  const offed = await req('PATCH', '/api/recharge/rules/' + rule.body.rule.id, { cookie, body: { enabled: false } });
  check('and it can be switched off without re-stating the address',
    offed.status === 200 && offed.body.rule.on === false, offed.body.rule);
  check('a disabled rule stops deciding',
    (await verdict(fromLines)).outcome !== 'recharge');

  console.log('\nRecharge rules — for bills with no premises on them');
  // Nothing about these bills carries an address. This is the case the
  // address side cannot reach, and the reason the second rule type exists.
  const epfAug = await makeBill(abm.tenantId, {
    ref: 'EPF-0826', supplier: 'KWSP (EPF)', total: 6420.00, paidOn: '2026-08-15'
  });
  const epfJul = await makeBill(abm.tenantId, {
    ref: 'EPF-0726', supplier: 'KWSP (EPF)', total: 6180.00, paidOn: '2026-07-15'
  });
  // Marked paid long before any rule here was written.
  await db.execute("UPDATE bills SET marked_paid_at = '2026-07-15 09:00:00' WHERE id = ?", [epfJul]);
  const fuel = await makeBill(abm.tenantId, {
    ref: 'PDB-FLEET-0826', supplier: 'Petronas Dagangan Berhad', total: 3180.40, paidOn: '2026-08-20'
  });
  const fuelCardBill = await makeBill(abm.tenantId, {
    ref: 'PDB-CARD-0826', supplier: 'Petronas Dagangan Berhad', total: 240.00, paidOn: '2026-08-21'
  });

  const noCond = await req('POST', '/api/recharge/text-rules', {
    cookie, body: { name: 'Everything', ownerTenantId: kj.tenantId, conditions: [] }
  });
  check('a rule with no conditions is refused — it would match every paid bill',
    noCond.status === 400 && /at least one condition/.test(noCond.body.error), noCond.body.error);

  const blank = await req('POST', '/api/recharge/text-rules', {
    cookie, body: { name: 'Blank', ownerTenantId: kj.tenantId,
      conditions: [{ field: 'supplier', operator: 'contains', value: '  ' }] }
  });
  check('a condition with no value is refused for the same reason',
    blank.status === 400 && /needs a word or phrase/.test(blank.body.error), blank.body.error);

  // There is no start date to get wrong any more: a rule covers bills marked
  // paid after it was written, and created_at says when that was. One fewer
  // field, and no second date to disagree with the first.
  const dated = await req('POST', '/api/recharge/text-rules', {
    cookie, body: { name: 'No date needed', ownerTenantId: kj.tenantId,
      conditions: [{ field: 'supplier', operator: 'is', value: 'NOBODY AT ALL' }] }
  });
  check('a rule needs no start date', dated.status === 201, dated.body);
  check('and nothing already paid is in its scope',
    (await req('GET', '/api/recharge/text-rules', { cookie })).body.rules
      .find((r) => r.id === dated.body.id).waiting === 0);
  await req('DELETE', '/api/recharge/text-rules/' + dated.body.id, { cookie });

  const epfRule = await req('POST', '/api/recharge/text-rules', {
    cookie,
    body: {
      name: 'EPF paid centrally for Kajang staff', matchMode: 'all',
      conditions: [{ field: 'supplier', operator: 'is', value: 'KWSP (EPF)' }],
      payerTenantId: abm.tenantId, ownerTenantId: kj.tenantId
    }
  });
  check('a recharge rule is created', epfRule.status === 201, epfRule.body);
  check('and reads back as its conditions',
    epfRule.body.rule.conditions[0].fieldLabel === 'Supplier'
    && epfRule.body.rule.conditions[0].operatorLabel === 'is exactly', epfRule.body.rule.conditions);
  check('saving it alone recharges nothing', epfRule.body.ran === undefined, epfRule.body.ran);

  // The rule exists; now the bill is paid. That order is the feature.
  await paidNow(epfAug);
  const vEpf = await verdict(epfAug);
  check('a bill its conditions match is recharged',
    vEpf.outcome === 'recharge' && vEpf.ownerCode === 'ABKJ', vEpf);
  check('and the reason names the rule, since there is no address to name',
    /EPF paid centrally/.test(vEpf.reason), vEpf.reason);

  const vJul = await verdict(epfJul);
  check('a bill paid before the start date is out of scope, not unmatched',
    vJul.outcome === 'out-of-scope', vJul);
  check('and says plainly that nothing will happen to it',
    /only ever acts on bills marked paid after it was written/.test(vJul.reason), vJul.reason);

  // Two conditions, both of which must hold.
  const fuelRule = await req('POST', '/api/recharge/text-rules', {
    cookie,
    body: {
      name: 'Fleet fuel for Kota Kinabalu', matchMode: 'all',
      conditions: [
        { field: 'supplier', operator: 'contains', value: 'Petronas' },
        { field: 'reference', operator: 'starts_with', value: 'PDB-FLEET' }
      ],
      ownerTenantId: kk.tenantId
    }
  });
  check('a two-condition rule is created', fuelRule.status === 201, fuelRule.body);
  await paidNow(fuel, fuelCardBill);
  check('a bill meeting both is recharged', (await verdict(fuel)).outcome === 'recharge');
  check('a bill meeting only one is not',
    (await verdict(fuelCardBill)).outcome === 'no-rule', await verdict(fuelCardBill));

  // Same two conditions, either of which is enough.
  await req('PATCH', '/api/recharge/text-rules/' + fuelRule.body.id, { cookie, body: { matchMode: 'any' } });
  check('switched to "any", the second bill matches too',
    (await verdict(fuelCardBill)).outcome === 'recharge');
  await req('PATCH', '/api/recharge/text-rules/' + fuelRule.body.id, { cookie, body: { matchMode: 'all' } });

  console.log('\nAddress rules win over recharge rules');
  // Both kinds could claim this bill. The address is the stronger evidence,
  // so it decides — otherwise a supplier-wide rule would quietly override a
  // statement about a specific building.
  const BLOCK = 'Blok C, Jalan Satu Dua, 50450 Kuala Lumpur';
  const KILANG2 = 'Kilang Dua, Jalan Tiga Empat, 43000 Kajang';
  await req('POST', '/api/recharge/rules', {
    cookie, body: { suppliers: ['Tenaga Nasional Berhad'], premisesAddress: KILANG2, ownerTenantId: kj.tenantId }
  });
  await req('POST', '/api/recharge/rules', {
    cookie, body: { suppliers: ['Tenaga Nasional Berhad'], premisesAddress: BLOCK, ownerTenantId: kj.tenantId }
  });
  const both = await makeBill(abm.tenantId, {
    ref: 'TNB-BOTH-0826', supplier: 'Tenaga Nasional Berhad', total: 500.00, address: BLOCK
  });
  const tnbWide = await req('POST', '/api/recharge/text-rules', {
    cookie,
    body: {
      name: 'All TNB to KK', matchMode: 'all',
      conditions: [{ field: 'supplier', operator: 'contains', value: 'Tenaga' }],
      ownerTenantId: kk.tenantId
    }
  });
  await paidNow(both);
  const vBoth = await verdict(both);
  check('the address rule decides, not the supplier-wide recharge rule',
    vBoth.outcome === 'recharge' && vBoth.ownerCode === 'ABKJ', vBoth);
  await req('DELETE', '/api/recharge/text-rules/' + tnbWide.body.id, { cookie });

  console.log('\nWaiting, and Run now');
  // A rule still being typed ranks last, so it only counts what no saved
  // rule has already claimed: the fuel rule owns PDB-FLEET, leaving the card
  // spend. Counting both would promise a draft that never arrives.
  const preview = await req('POST', '/api/recharge/text-rules/preview', {
    cookie,
    body: {
      conditions: [{ field: 'supplier', operator: 'contains', value: 'Petronas' }],
      matchMode: 'all', ownerTenantId: kj.tenantId
    }
  });
  check('the dialog counts what a rule would act on before it is saved',
    preview.body.count === 1 && preview.body.bills[0].reference === 'PDB-CARD-0826', preview.body);

  // The preview answers "do these conditions pick out what I mean", so it
  // looks past the written-date test — a rule that does not exist yet would
  // otherwise always report nothing, which checks nothing.
  const previewEpf = await req('POST', '/api/recharge/text-rules/preview', {
    cookie,
    body: {
      conditions: [{ field: 'supplier', operator: 'is', value: 'KWSP (EPF)' }],
      matchMode: 'all', payerTenantId: abm.tenantId, ownerTenantId: kj.tenantId
    }
  });
  check('it shows bills already paid as evidence the conditions are right',
    previewEpf.body.count === 1 && previewEpf.body.alreadyPaid === true, previewEpf.body);
  check('and they are all behind the rule, so none of them will be drafted',
    previewEpf.body.bills.every((b) => b.reference === 'EPF-0726'), previewEpf.body.bills);

  const selfPreview = await req('POST', '/api/recharge/text-rules/preview', {
    cookie,
    body: {
      conditions: [{ field: 'supplier', operator: 'is', value: 'KWSP (EPF)' }],
      matchMode: 'all', ownerTenantId: abm.tenantId
    }
  });
  check('recharging the payer to itself counts nothing', selfPreview.body.count === 0, selfPreview.body);

  const listed = await req('GET', '/api/recharge/text-rules', { cookie });
  const epfCard = listed.body.rules.find((r) => r.id === epfRule.body.id);
  check('the card says how many bills it is sitting on', epfCard.waiting === 1, epfCard.waitingLabel);
  check('and that it has not run yet', /Not run yet/.test(epfCard.meta), epfCard.meta);

  calls.length = 0;
  const ran = await req('POST', `/api/recharge/text-rules/${epfRule.body.id}/run`, { cookie });
  check('Run now drafts the waiting bill', ran.body.drafted === 1 && ran.body.failed === 0, ran.body);
  check('and reaches Xero not at all — these are drafts',
    calls.filter((c) => c.method === 'POST').length === 0, calls.map((c) => c.path));

  const afterRun = await req('GET', '/api/recharge/text-rules', { cookie });
  const epfAfter = afterRun.body.rules.find((r) => r.id === epfRule.body.id);
  check('the badge clears once there is nothing waiting', epfAfter.waiting === 0, epfAfter.waitingLabel);
  check('and the card records the run', /last run/.test(epfAfter.meta), epfAfter.meta);

  const ranTwice = await req('POST', `/api/recharge/text-rules/${epfRule.body.id}/run`, { cookie });
  check('running it again drafts nothing, because the bill is already recharged',
    ranTwice.body.drafted === 0, ranTwice.body);

  const runRow = await db.getOne(
    'SELECT text_rule_id, rule_id, premises_address FROM recharge_runs WHERE bill_id = ?', [epfAug]);
  check('the run records which recharge rule raised it',
    Number(runRow.text_rule_id) === Number(epfRule.body.id) && runRow.rule_id === null, runRow);
  check('and carries no address, because there was none',
    runRow.premises_address === null, runRow.premises_address);

  console.log('\nRule order decides who claims a bill');
  // Two recharge rules whose conditions both hold. The earlier one wins, and
  // the later one must not also offer to draft it.
  const second = await req('POST', '/api/recharge/text-rules', {
    cookie,
    body: {
      name: 'All Petronas to KJ', matchMode: 'all',
      conditions: [{ field: 'supplier', operator: 'contains', value: 'Petronas' }],
      ownerTenantId: kj.tenantId
    }
  });
  const secondList = await req('GET', '/api/recharge/text-rules', { cookie });
  const fuelCard = secondList.body.rules.find((r) => r.id === fuelRule.body.id);
  const secondCard = secondList.body.rules.find((r) => r.id === second.body.id);
  check('the earlier rule keeps the bill it already claimed', fuelCard.waiting === 1, fuelCard.waitingLabel);
  check('the later rule only counts what is left', secondCard.waiting === 1, secondCard.waitingLabel);
  await req('DELETE', '/api/recharge/text-rules/' + second.body.id, { cookie });

  console.log('\nMatching on what only Xero has');
  // Line descriptions and tracking are not synced. A rule naming them reads
  // the bill back; a rule that does not, does not.
  const tracked = await makeBill(abm.tenantId, {
    ref: 'RENT-TWU-0826', supplier: 'Hartanah Sejahtera Sdn Bhd', total: 4200.00,
    lines: ['Office rent September'], tracking: [['Region', 'Tawau']]
  });
  const trackRule = await req('POST', '/api/recharge/text-rules', {
    cookie,
    body: {
      name: 'Anything tracked to Tawau', matchMode: 'all',
      conditions: [{ field: 'tracking', operator: 'contains', value: 'Tawau' }],
      ownerTenantId: kk.tenantId
    }
  });
  check('a rule can match a Xero tracking category', trackRule.status === 201, trackRule.body);
  check('and it decides the bill', (await verdict(tracked)).outcome === 'recharge');

  const descRule = await req('POST', '/api/recharge/text-rules', {
    cookie,
    body: {
      name: 'Rent by description', matchMode: 'all',
      conditions: [{ field: 'description', operator: 'contains', value: 'Office rent' }],
      ownerTenantId: kk.tenantId
    }
  });
  check('a rule can match a line description too', descRule.status === 201, descRule.body);
  await req('DELETE', '/api/recharge/text-rules/' + descRule.body.id, { cookie });
  await req('DELETE', '/api/recharge/text-rules/' + trackRule.body.id, { cookie });

  console.log('\nA disabled recharge rule stops deciding');
  await req('PATCH', '/api/recharge/text-rules/' + fuelRule.body.id, { cookie, body: { enabled: false } });
  check('switched off, it no longer claims its bill', (await verdict(fuel)).outcome !== 'recharge');
  await req('PATCH', '/api/recharge/text-rules/' + fuelRule.body.id, { cookie, body: { enabled: true } });

  console.log('\nTesting mode');
  // Testing mode exists so the whole thing can be exercised against real
  // Xero data without a single document reaching Xero. A recharge worked out
  // under it is real arithmetic over real bills and must never be mistaken
  // for one that happened.
  const testModeLib = require('../lib/testMode');
  const tmBill = await makeBill(abm.tenantId, {
    ref: 'TNB-TEST-0826', supplier: 'Tenaga Nasional Berhad', total: 777.00, address: KILANG2
  });

  await testModeLib.set(1, true);
  calls.length = 0;
  const tmRun = await req('POST', '/api/recharge/runs', { cookie, body: { billId: tmBill } });
  check('a recharge can still be worked out in testing mode', tmRun.status === 201, tmRun.body);
  check('and it touches Xero not at all', calls.length === 0, calls.map((c) => c.path));

  const tmRow = (await req('GET', '/api/recharge', { cookie })).body.runRows.find((r) => r.id === tmRun.body.id);
  check('it is shown while testing mode is on', Boolean(tmRow), 'missing');
  check('marked as what it is', tmRow.testMode === true && tmRow.statusLabel === 'Testing mode', tmRow.statusLabel);
  // Offering a button whose only outcome is a refusal is worse than not
  // offering one.
  check('and it offers no way to post', tmRow.canPost === false, tmRow.canPost);

  // Refused on the run's own flag, not on whether the switch is still on.
  // lib/xero.js refuses the call as well; this is the one that survives
  // somebody turning testing mode off tomorrow.
  calls.length = 0;
  const tmPost = await req('POST', `/api/recharge/runs/${tmRun.body.id}/post`, { cookie });
  check('posting one is refused',
    tmPost.status === 409 && /worked out in testing mode/.test(tmPost.body.error), tmPost.body);
  check('and nothing was attempted against Xero', calls.length === 0, calls.map((c) => c.path));

  await testModeLib.set(1, false);
  testModeLib.forget(1);
  const stillRefused = await req('POST', `/api/recharge/runs/${tmRun.body.id}/post`, { cookie });
  check('and it stays refused once testing mode is off — it was always a test',
    stillRefused.status === 409 && /worked out in testing mode/.test(stillRefused.body.error),
    stillRefused.body);
  const afterOff = (await req('GET', '/api/recharge', { cookie })).body;
  check('turning testing mode off hides it, the same as a test payment batch',
    !afterOff.runRows.some((r) => r.id === tmRun.body.id),
    afterOff.runRows.map((r) => r.id));
  check('and it is out of the figures too',
    Number((await db.getOne("SELECT recharge_total FROM recharge_runs WHERE id = ?", [tmRun.body.id])).recharge_total) === 777
    && !/777/.test(afterOff.rechargeStats[0].amount),
    afterOff.rechargeStats[0].amount);

  // The dangerous one: a bill tried in testing mode must not be left
  // unrechargeable for good, held by a run nobody can see.
  const realRun = await req('POST', '/api/recharge/runs', { cookie, body: { billId: tmBill } });
  check('the bill it held is free to be recharged for real', realRun.status === 201, realRun.body);
  await req('POST', `/api/recharge/runs/${realRun.body.id}/cancel`, { cookie });

  console.log('\nThe view');
  const final = await req('GET', '/api/recharge', { cookie });
  check('stat cards are returned', final.body.rechargeStats.length === 4);
  check('a posted run still reads as posted',
    final.body.runRows.find((c) => c.id === runId).statusLabel === 'Posted to Xero');
  check('the stat cards count the documents that exist in Xero',
    final.body.rechargeStats[1].label === 'Xero invoices'
    && final.body.rechargeStats[2].label === 'Xero bills',
    final.body.rechargeStats.map((c) => c.label));
  check('both rule kinds get their own tab',
    final.body.rechargeTabs[1].label === 'Address rules'
    && final.body.rechargeTabs[2].label === 'Recharge rules', final.body.rechargeTabs);
  check('the condition vocabulary is offered to the dialog',
    final.body.conditionFields.some((f) => f.value === 'tracking')
    && final.body.conditionOperators.some((o) => o.value === 'starts_with'),
    { f: final.body.conditionFields.length, o: final.body.conditionOperators.length });
  check('the active-rules card splits the two kinds',
    /address · .* recharge rule/.test(final.body.rechargeStats[3].sub), final.body.rechargeStats[3].sub);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
