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
// The real guard, not the stub below: testing mode has to hold at the one
// place every Xero call passes through, or the opt-in is a hole.
const realXeroApi = require('../lib/xero').api;

const calls = [];
let invoiceSeq = 0;
let failOn = null;        // { tenantId, type } -> that Invoices POST throws
let lineItems = {};       // xeroInvoiceId -> [{ Description }]
let contactAddresses = {};// contactId -> [{ AddressType, AddressLine1, ... }]
let accountsFail = null;  // an Error thrown by GET /Accounts
let attachments = {};     // xeroInvoiceId -> [{ FileName, MimeType, ContentLength }]
let attachmentsFail = null;// an Error thrown by the Attachments endpoints
let pdfFail = null;        // an Error thrown when the sales invoice PDF is fetched
const uploaded = [];      // { tenantId, invoiceId, name, contentType, bytes }

// Contacts Xero holds for an organisation, which is not the same set as the
// contacts that have billed it — a register row usually names one created
// for the purpose, with nothing against it yet.
const xeroContacts = {};
// tenantId -> { 'Contact Name': contactId }, for the exact-name lookup above.
const namedContacts = {};
// contactId -> { SalesTrackingCategories, PurchasesTrackingCategories }
const contactTracking = {};

xero.api = async (accountId, tenantId, path, opts = {}) => {
  calls.push({ tenantId, path, method: opts.method || 'GET', body: opts.body, draftDocument: opts.draftDocument });
  opts = { ...opts, tenantIdForTest: tenantId };

  // A single contact by id: where the premises lives when somebody puts it
  // on the supplier in Xero rather than on the bill.
  const oneContact = path.match(/^\/Contacts\/([^?]+)$/);
  if (oneContact && (opts.method || 'GET') === 'GET') {
    // Xero omits these fields entirely when a contact has no defaults, which
    // is why the recharge treats an absent one as "nothing set".
    return { Contacts: [{
      ContactID: oneContact[1],
      Addresses: contactAddresses[oneContact[1]] || [],
      ...(contactTracking[oneContact[1]] || {})
    }] };
  }
  if (path.startsWith('/Contacts') && (opts.method || 'GET') === 'GET') {
    // A page of the organisation's contacts, when the register dialog asks.
    // Default empty, so the counterparty lookup still finds nothing and the
    // create path runs.
    const page = /[?&]page=(\d+)/.exec(path);
    if (page) return { Contacts: Number(page[1]) === 1 ? (xeroContacts[opts.tenantIdForTest] || []) : [] };
    // A lookup by exact name, which is how a recharge finds the organisation
    // on the other side. Empty unless a test has put one there, so the create
    // path still runs by default.
    const byName = /Name=="([^"]+)"/.exec(decodeURIComponent(path));
    if (byName) {
      const id = (namedContacts[opts.tenantIdForTest] || {})[byName[1]];
      return { Contacts: id ? [{ ContactID: id, Name: byName[1] }] : [] };
    }
    // searchTerm is Xero's contains-style search, which is how a recharge
    // finds a contact the ledger spells differently.
    const search = /[?&]searchTerm=([^&]+)/.exec(path);
    if (search) {
      const needle = decodeURIComponent(search[1]).toLowerCase();
      const all = namedContacts[opts.tenantIdForTest] || {};
      const hits = Object.entries(all)
        .filter(([n]) => n.toLowerCase().includes(needle))
        .map(([n, cid]) => ({ ContactID: cid, Name: n }));
      return { Contacts: hits };
    }
    return { Contacts: [] };
  }
  if (path === '/Contacts' && opts.method === 'POST') {
    return { Contacts: [{ ContactID: 'contact-' + opts.body.Contacts[0].Name.replace(/\W/g, ''), Name: opts.body.Contacts[0].Name }] };
  }
  // Attachments. Matched before the single-invoice read below, whose
  // pattern would otherwise swallow these paths.
  const attList = path.match(/^\/Invoices\/([^/?]+)\/Attachments$/);
  if (attList) {
    if (attachmentsFail) throw attachmentsFail;
    return { Attachments: attachments[attList[1]] || [] };
  }
  const attOne = path.match(/^\/Invoices\/([^/?]+)\/Attachments\/([^?]+)$/);
  if (attOne) {
    if (attachmentsFail) throw attachmentsFail;
    const name = decodeURIComponent(attOne[2]);
    if (opts.method === 'PUT') {
      uploaded.push({
        tenantId, invoiceId: attOne[1], name,
        contentType: (opts.headers || {})['Content-Type'],
        bytes: Buffer.isBuffer(opts.body) ? opts.body.length : -1
      });
      return { Attachments: [{ FileName: name }] };
    }
    return { buffer: Buffer.from(`pretend bytes of ${name}`), contentType: 'application/pdf' };
  }

  // A single bill read, which is how the premises is found when nothing has
  // written it onto the bill yet.
  const one = path.match(/^\/Invoices\/([^?]+)$/);
  if (one && (opts.method || 'GET') === 'GET') {
    // Xero renders a PDF off the same path when asked for one. That is how
    // the payer's sales invoice reaches the receiving entity's bill, and it
    // works on a draft — the documented draft restriction is on the online
    // invoice url, not on the PDF.
    if (opts.raw && /pdf/i.test((opts.headers || {}).Accept || '')) {
      if (pdfFail) throw pdfFail;
      return { buffer: Buffer.from('%PDF-1.4 pretend sales invoice ' + one[1]), contentType: 'application/pdf' };
    }
    return { Invoices: [{ InvoiceID: one[1], LineItems: lineItems[one[1]] || [] }] };
  }
  if (path === '/TrackingCategories') return { TrackingCategories: [] };
  if (path === '/Accounts') {
    if (accountsFail) throw accountsFail;
    return { Accounts: [
      { Code: '200', Name: 'Sales', Type: 'REVENUE', Class: 'REVENUE', Status: 'ACTIVE' },
      { Code: '429', Name: 'General Expenses', Type: 'EXPENSE', Class: 'EXPENSE', Status: 'ACTIVE' },
      { Code: '445', Name: 'Light, Power, Heating', Type: 'EXPENSE', Class: 'EXPENSE', Status: 'ACTIVE' },
      // Filtered out: archived, and a bank account nothing can be recharged to.
      { Code: '300', Name: 'Old Account', Type: 'EXPENSE', Class: 'EXPENSE', Status: 'ARCHIVED' },
      { Code: '090', Name: 'Business Bank', Type: 'BANK', Class: 'ASSET', Status: 'ACTIVE' },
      // No code: nothing can post to it, so offering it offers a choice
      // that cannot be made.
      { Name: 'Unnumbered', Type: 'EXPENSE', Class: 'EXPENSE', Status: 'ACTIVE' }
    ] };
  }
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
        // Xero numbers an ACCREC itself and echoes back the InvoiceNumber
        // supplied on an ACCPAY, which is what carries the payer's sales
        // invoice number onto the receiving entity's bill.
        InvoiceNumber: inv.InvoiceNumber
          || (inv.Type === 'ACCREC' ? 'AR-IC-' : 'BILL-IC-') + (1000 + invoiceSeq),
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

const testModeLib = require('../lib/testMode');

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
    { code: 'KJ', short_name: 'Ayu Borneo (KJ)' },
    { code: 'KK', short_name: 'Ayu Borneo (KK)' },
    { code: 'ICM', short_name: 'Ayu Borneo (PJ)' },
    { code: 'ABM', short_name: 'Ayu Borneo Management' }
  ];
  const abCodes = AB.map((e) => e.code);
  check('the reference is the code',
    AB.map((e) => entityRef.short(e, abCodes)).join() === 'KJ,KK,ICM,ABM',
    AB.map((e) => entityRef.short(e, abCodes)));
  // The whole reason this changed: a code set deliberately has to be what a
  // bank statement shows, or the code on screen and the code in the file
  // disagree and neither end says which one a line meant.
  check('a code that disagrees with the name still wins',
    entityRef.short({ code: 'ICM', short_name: 'Ayu Borneo (PJ)' }) === 'ICM');
  check('an unrelated organisation joining changes nothing',
    entityRef.short(AB[0], abCodes.concat(['DCGLOBAL'])) === 'KJ');
  // A reference crosses a bank's file format and Xero's Reference field, and
  // neither is a place to discover a space.
  check('a space in a code is dropped, not carried into a bank file',
    entityRef.short({ code: 'JS JP2' }) === 'JSJP2');
  check('and so is punctuation', entityRef.short({ code: 'K.J-1' }) === 'KJ1');
  check('a missing code is empty rather than something invented',
    entityRef.short({ code: '', short_name: 'Ayu Borneo (KJ)' }) === '');
  // Two entities whose references cannot be told apart is far worse than one
  // long reference — and stripping punctuation is what can collide two codes
  // that looked different.
  check('"EM J" and "EMJ" collapse to the same reference, which a caller must catch',
    entityRef.short({ code: 'EM J' }) === entityRef.short({ code: 'EMJ' }));

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

  console.log('\nA rule for one supplier');
  // The commonest rule there is, and the one the Recharge tab is built
  // around: a contact named after the premises it bills for, and the entity
  // that premises belongs to.
  const supplierRule = (supplier, ownerTenantId, extra = {}) =>
    req('POST', '/api/recharge/text-rules', {
      cookie,
      body: {
        name: extra.name || supplier,
        matchMode: 'all',
        conditions: [{ field: 'supplier', operator: 'is', value: supplier }].concat(
          extra.reference ? [{ field: 'reference', operator: 'contains', value: extra.reference }] : []),
        ownerTenantId,
        ...(extra.arAccountCode ? { arAccountCode: extra.arAccountCode } : {}),
        ...(extra.apAccountCode ? { apAccountCode: extra.apAccountCode } : {})
      }
    });

  const rule = await supplierRule('Tenaga Nasional Berhad', kj.tenantId);
  check('a rule is created', rule.status === 201, rule.body);
  check('it names the entity it recharges to', rule.body.rule.ownerCode === 'ABKJ', rule.body.rule);
  check('and reads back the condition it was given',
    rule.body.rule.conditions.length === 1
    && rule.body.rule.conditions[0].value === 'Tenaga Nasional Berhad', rule.body.rule.conditions);

  const noConditions = await req('POST', '/api/recharge/text-rules', {
    cookie, body: { name: 'Everything', conditions: [], ownerTenantId: kj.tenantId }
  });
  check('a rule with no condition is refused — it would claim every bill',
    noConditions.status === 400 && /match every paid bill/i.test(noConditions.body.error),
    noConditions.body.error);

  const noOwner = await req('POST', '/api/recharge/text-rules', {
    cookie, body: { name: 'Nowhere', conditions: [{ field: 'supplier', operator: 'is', value: 'X' }] }
  });
  check('a rule with no entity is refused',
    noOwner.status === 400 && /entity to recharge to/i.test(noOwner.body.error), noOwner.body.error);

  // The water bill and the electricity bill for one building are two rules,
  // and both are legitimate.
  const water = await supplierRule('Jabatan Air Negeri Sabah', kk.tenantId);
  check('a second rule for another supplier is fine', water.status === 201, water.body);

  console.log('\nThe premises register — reference data for WazzOCR');
  // Not a matcher for recharging. Somebody photographs a bill into
  // WazzOCR's WhatsApp; it reads the premises address and looks it up here
  // for the three things the paper cannot tell it — which organisation to
  // create the bill in, which contact, which account code.
  const register = (rows) => req('POST', '/api/recharge/address-rules', { cookie, body: { rules: rows } });
  const WISMA_ADDR = 'Wisma Ayu Borneo, Jalan Lintas, 88300 Kota Kinabalu';

  const made = await register([
    { premisesAddress: WISMA_ADDR, payerTenantId: abm.tenantId,
      contactName: 'Tenaga Nasional Berhad - Wisma', ownerTenantId: kk.tenantId },
    { premisesAddress: WISMA_ADDR, payerTenantId: abm.tenantId,
      contactName: 'Indah Water - Wisma', ownerTenantId: kk.tenantId }
  ]);
  check('several rows are added in one go', made.status === 201 && made.body.created === 2, made.body);
  check('and each reads back as the four columns the table shows',
    made.body.rules.some((r) => r.payerLabel === 'ABM' && r.address === WISMA_ADDR
      && r.contactName === 'Tenaga Nasional Berhad - Wisma' && r.ownerCode === 'ABKK'),
    made.body.rules);
  // A building has electricity and water. Keyed on the address alone, only
  // one of them could exist.
  check('two accounts at one building are two rows, not a clash',
    made.body.rules.filter((r) => r.address === WISMA_ADDR).length === 2, made.body.rules);

  console.log('\nWhat WazzOCR asks it');
  const ask = (address, supplier) =>
    req('GET', `/api/recharge/premises?address=${encodeURIComponent(address)}`
      + (supplier ? `&supplier=${encodeURIComponent(supplier)}` : ''), { cookie });

  const found = await ask(WISMA_ADDR, 'Tenaga Nasional');
  check('an address comes back with where the bill goes',
    found.status === 200 && found.body.paidBy.code === 'ABM'
    && found.body.contactName === 'Tenaga Nasional Berhad - Wisma', found.body);
  check('and with where it will end up, as a note',
    found.body.rechargeTo && found.body.rechargeTo.code === 'ABKK', found.body.rechargeTo);

  // WazzOCR reads an address off a photograph. Punctuation and case will
  // not survive that; a missing word should not be forgiven.
  const messy = await ask('WISMA AYU BORNEO  JALAN LINTAS  88300 KOTA KINABALU', 'Tenaga');
  check('punctuation and case do not matter', messy.status === 200, messy.body);
  const abbreviated = await ask('Wisma Ayu Borneo, Jln Lintas, 88300 Kota Kinabalu', 'Tenaga');
  check('but an abbreviation is not guessed at — that is how a bill lands on the wrong company',
    abbreviated.status === 404, abbreviated.body);

  // The address stored can be the distinctive part; a longer one printed on
  // the bill still finds it.
  const longer = await ask(`Aras 12, ${WISMA_ADDR}, Sabah, Malaysia`, 'Tenaga');
  check('a longer address on the bill still finds the row', longer.status === 200, longer.body);

  // Two rows share this address, so the supplier WazzOCR read off the bill
  // is what picks between them.
  check('the supplier on the bill picks between two rows at one address',
    (await ask(WISMA_ADDR, 'Indah Water')).body.contactName === 'Indah Water - Wisma');
  // WazzOCR cannot tell which block of text on a photographed bill is the
  // premises — the supplier's own office, the billing address and the
  // service address all look alike. It sends them all.
  const many = await req('GET', '/api/recharge/premises'
    + `?address=${encodeURIComponent('TNB Kawasan Selatan, Jalan Bangsar, 59200 Kuala Lumpur')}`
    + `&address=${encodeURIComponent(WISMA_ADDR)}`
    + `&address=${encodeURIComponent('PO Box 1234, 46000 Petaling Jaya')}`
    + '&supplier=Tenaga', { cookie });
  check('several candidate addresses resolve to the one it recognises',
    many.status === 200 && many.body.premisesAddress === WISMA_ADDR, many.body);
  const noneKnown = await req('GET', '/api/recharge/premises'
    + `?address=${encodeURIComponent('Somewhere Else, 10000 Penang')}`
    + `&address=${encodeURIComponent('PO Box 9, 46000 PJ')}`, { cookie });
  check('and candidates it recognises none of are still a 404',
    noneKnown.status === 404, noneKnown.body);

  const unmapped = await ask('Lot 5, Jalan Nowhere, 12345 Ipoh', 'Tenaga');
  check('a premises nobody has mapped says so, rather than guessing',
    unmapped.status === 404, unmapped.body);

  // WazzOCR is a server with no session cookie, so a shared token reaches
  // this one route. It must reach nothing else.
  console.log('\nThe service token');
  const { serviceAccountId } = require('../billhub/rechargeRouter');
  const asReq = (method, path, token) => ({
    method, path, get: (h) => (h === 'X-Billhub-Token' ? token : undefined)
  });
  const TOKEN = 'service-token-for-the-test';
  const was = process.env.BILLHUB_SERVICE_TOKEN;
  try {
    process.env.BILLHUB_SERVICE_TOKEN = TOKEN;
    check('the right token on the lookup is a service caller',
      serviceAccountId(asReq('GET', '/premises', TOKEN)) === 1);
    check('a wrong token of the same length is not',
      serviceAccountId(asReq('GET', '/premises', 'wrong-token-for-the-tests')) === null);
    check('nor is a token of a different length',
      serviceAccountId(asReq('GET', '/premises', 'x')) === null);
    check('nor is no token at all',
      serviceAccountId(asReq('GET', '/premises', undefined)) === null);
    // The whole point of the allow-list: a leaked token must not be a way
    // in to everything else.
    check('the token opens no other route',
      serviceAccountId(asReq('GET', '/address-rules', TOKEN)) === null
      && serviceAccountId(asReq('GET', '/', TOKEN)) === null,
      'a read route accepted it');
    check('and no write, even on the route it does open',
      serviceAccountId(asReq('POST', '/premises', TOKEN)) === null
      && serviceAccountId(asReq('DELETE', '/premises', TOKEN)) === null);

    delete process.env.BILLHUB_SERVICE_TOKEN;
    check('with no token configured the header is ignored entirely',
      serviceAccountId(asReq('GET', '/premises', TOKEN)) === null
      && serviceAccountId(asReq('GET', '/premises', '')) === null,
      'an unconfigured deployment accepted a token');
  } finally {
    if (was === undefined) delete process.env.BILLHUB_SERVICE_TOKEN;
    else process.env.BILLHUB_SERVICE_TOKEN = was;
  }

  console.log('\nSaving a table of them');
  // All or nothing. Saving eight of nine rows leaves somebody rereading the
  // table to work out which eight.
  const countBefore = (await req('GET', '/api/recharge/address-rules', { cookie })).body.rules.length;
  const partly = await register([
    { premisesAddress: 'Lot 9, Jalan Perusahaan Empat, 68100 Batu Caves',
      payerTenantId: abm.tenantId, contactName: 'Syabas - Lot 9', ownerTenantId: kk.tenantId },
    { premisesAddress: '', payerTenantId: abm.tenantId,
      contactName: 'Gas - Lot 9', ownerTenantId: kk.tenantId }
  ]);
  check('one bad row saves none of them', partly.status === 400, partly.body);
  check('and names the row it stopped on, counting the way the dialog does',
    partly.body.problems && partly.body.problems[0].at === 2, partly.body.problems);
  const countAfter = (await req('GET', '/api/recharge/address-rules', { cookie })).body.rules.length;
  check('nothing from that batch reached the table', countAfter === countBefore,
    { countBefore, countAfter });

  const noAddress = await register([
    { payerTenantId: abm.tenantId, contactName: 'X', ownerTenantId: kk.tenantId }]);
  check('a row with no address is refused — WazzOCR would never find it',
    noAddress.status === 400 && /premises address/i.test(noAddress.body.error), noAddress.body.error);

  const noPayer = await register([
    { premisesAddress: 'Lot 77, Jalan Lain, 40000 Shah Alam',
      contactName: 'X', ownerTenantId: kk.tenantId }]);
  check('and one with nobody paying it is refused too',
    noPayer.status === 400 && /create the bill in/i.test(noPayer.body.error), noPayer.body.error);

  const dupBatch = await register([
    { premisesAddress: 'Lot 3, Jalan Dua, 50000 KL',
      payerTenantId: abm.tenantId, contactName: 'A', ownerTenantId: kk.tenantId },
    { premisesAddress: 'LOT 3 JALAN DUA 50000 KL',
      payerTenantId: abm.tenantId, contactName: 'A', ownerTenantId: kj.tenantId }
  ]);
  check('one contact twice at one address is caught before the database sees it',
    dupBatch.status === 400 && dupBatch.body.problems.length === 1
    && dupBatch.body.problems[0].at === 2, dupBatch.body.problems);

  const repeat = await register([
    { premisesAddress: WISMA_ADDR, payerTenantId: abm.tenantId,
      contactName: 'Tenaga Nasional Berhad - Wisma', ownerTenantId: kk.tenantId }]);
  check('and so is one that repeats a row already saved', repeat.status === 409, repeat.body);

  console.log('\nOne row, both jobs: WazzOCR files the bill, paying it recharges');
  // A register row carries "Recharge to". Filling it in is what opts the row
  // into recharging, so one row does both jobs and nobody writes the same
  // premises down twice.
  //
  // Matched on the address when the bill carries one, and otherwise on the
  // contact — which is the path that actually runs, because a bill reaches
  // Bills Hub by syncing back from Xero and that sync carries no premises.
  const wismaBill = await makeBill(abm.tenantId, {
    ref: 'TNB-WISMA-0826', supplier: 'Tenaga Nasional Berhad - Wisma', total: 880.00
  });
  const contactOnly = await verdict(wismaBill);
  check('a contact naming one premises recharges on its own, with no address',
    contactOnly.outcome === 'recharge' && contactOnly.ownerCode === 'ABKK', contactOnly);
  check('and that costs Xero nothing either',
    (() => { calls.length = 0; return true; })() && true);
  calls.length = 0;
  await verdict(wismaBill);
  check('deciding by contact reads nothing back out of Xero',
    calls.length === 0, calls.map((c) => c.path));

  // The same contact, the same row, but this bill carries the premises
  // WazzOCR read off the document.
  const wismaOcr = await makeBill(abm.tenantId, {
    ref: 'TNB-WISMA-0926', supplier: 'Tenaga Nasional Berhad - Wisma', total: 910.00,
    address: WISMA_ADDR
  });
  const byAddress = await verdict(wismaOcr);
  check('a bill carrying the premises IS recharged by its register row',
    byAddress.outcome === 'recharge' && byAddress.ownerCode === 'ABKK', byAddress);
  check('and it names the premises rather than a rule nobody named',
    /address rule/.test(byAddress.reason), byAddress.reason);

  // The cost that retired address matching the first time. The address is on
  // the local row, so deciding reads nothing back out of Xero.
  calls.length = 0;
  await verdict(wismaOcr);
  check('deciding it by address still costs Xero nothing',
    calls.length === 0, calls.map((c) => c.path));

  // The generic-contact case. One contact, two premises, two different
  // answers about where the money goes — so it declines rather than
  // picking whichever row was saved first. This is what makes matching on
  // the contact safe to do at all.
  const clashRow = await register([
    { premisesAddress: 'Lot 44, Jalan Tuaran Baru, 88450 Kota Kinabalu',
      payerTenantId: abm.tenantId, contactName: 'Tenaga Nasional Berhad - Wisma',
      ownerTenantId: kj.tenantId }]);
  check('one contact may name a second premises', clashRow.status === 201, clashRow.body);
  const split = await verdict(wismaBill);
  check('a contact two rows disagree over recharges nothing',
    split.outcome === 'no-rule', split);
  check('and says so, naming both entities and both premises',
    /disagree/.test(split.reason)
    && /Ayu Borneo \(KK\)/.test(split.reason) && /Ayu Borneo \(KJ\)/.test(split.reason)
    && /Tuaran/.test(split.reason) && /Jalan Lintas/.test(split.reason), split.reason);
  // The bill that does carry its address is still decided, because the
  // address settles what the contact could not.
  check('but a bill carrying its premises is still decided',
    (await verdict(wismaOcr)).ownerCode === 'ABKK');
  await req('DELETE', '/api/recharge/address-rules/' + clashRow.body.rules.find(
    (r) => /Tuaran/.test(r.address)).id, { cookie });
  check('and removing the clash lets the contact decide again',
    (await verdict(wismaBill)).ownerCode === 'ABKK');

  // "Recharge to" is required, and always was: owner_tenant_id is NOT NULL,
  // so a blank one used to reach MySQL and come back as a column error.
  const padiRow = await register([
    { premisesAddress: 'Blok C, Jalan Padi Emas, 81200 Johor Bahru',
      payerTenantId: abm.tenantId, contactName: 'Tenaga Nasional Berhad - Padi' }]);
  check('a row without "Recharge to" is refused in words, not by MySQL',
    padiRow.status === 400 && /recharge to/i.test(padiRow.body.problems[0].error),
    padiRow.body);

  // Naming the payer on both sides is how a premises whose cost the payer
  // genuinely carries is written down — it reads as a decision, where a
  // blank read as an unfinished row.
  const ownRow = await register([
    { premisesAddress: 'Blok C, Jalan Padi Emas, 81200 Johor Bahru',
      payerTenantId: abm.tenantId, contactName: 'Tenaga Nasional Berhad - Padi',
      ownerTenantId: abm.tenantId }]);
  check('naming the payer on both sides is allowed', ownRow.status === 201, ownRow.body);
  const padiBill = await makeBill(abm.tenantId, {
    ref: 'TNB-PADI-0826', supplier: 'Tenaga Nasional Berhad - Padi', total: 420.00,
    address: 'Blok C, Jalan Padi Emas, 81200 Johor Bahru'
  });
  const own = await verdict(padiBill);
  check('and it recharges nothing, because the payer owns the cost',
    own.outcome === 'own', own);

  // A recharge rule still covers suppliers the register says nothing about —
  // the bills with no premises to detect, which is what that tab is for.
  const strayBill = await makeBill(abm.tenantId, {
    ref: 'OFFICE-SUPPLIES-0826', supplier: 'Pejabat Supplies Sdn Bhd', total: 310.00
  });
  check('a supplier in no register row is not recharged by the register',
    (await verdict(strayBill)).outcome === 'no-rule');
  const viaRule = await req('POST', '/api/recharge/text-rules', {
    cookie,
    body: { name: 'Office supplies', matchMode: 'all',
      conditions: [{ field: 'supplier', operator: 'is', value: 'Pejabat Supplies Sdn Bhd' }],
      ownerTenantId: kk.tenantId }
  });
  check('and a recharge rule is what covers it', 
    (await verdict(strayBill)).ownerCode === 'ABKK', viaRule.body);
  await req('DELETE', '/api/recharge/text-rules/' + viaRule.body.rule.id, { cookie });

  // Switching a row off has to stop WazzOCR finding it, or the toggle is
  // decoration.
  const offRow = made.body.rules.find((r) => r.contactName === 'Tenaga Nasional Berhad - Wisma');
  await req('PATCH', '/api/recharge/address-rules/' + offRow.id, { cookie, body: { enabled: false } });
  check('a row switched off is not returned by a lookup',
    (await ask(WISMA_ADDR, 'Tenaga')).status === 404);
  await req('PATCH', '/api/recharge/address-rules/' + offRow.id, { cookie, body: { enabled: true } });

  console.log('\nThe contacts a register row chooses from');
  // A contact belongs to one Xero organisation. Offering all of them on a
  // row that has already named the payer invites a pairing no real bill can
  // satisfy — and the register, matching on address alone, would hand that
  // unusable pair to WazzOCR rather than fall through.
  const kjContacts = await req('GET', '/api/recharge/contacts/' + kj.tenantId, { cookie });
  const kkContacts = await req('GET', '/api/recharge/contacts/' + kk.tenantId, { cookie });
  check('one entity\'s contacts can be read', kjContacts.status === 200, kjContacts.body);
  check('they are narrower than every contact on the account',
    kjContacts.body.contacts.length < (await req('GET', '/api/recharge', { cookie })).body.suppliers.length,
    { one: kjContacts.body.contacts.length });
  check('a contact that bills one entity is not offered for another',
    kjContacts.body.contacts.some((n) => !kkContacts.body.contacts.includes(n)),
    { kj: kjContacts.body.contacts, kk: kkContacts.body.contacts });
  check('an entity nobody has billed comes back empty rather than failing',
    (await req('GET', '/api/recharge/contacts/no-such-tenant', { cookie })).body.contacts.length === 0);

  // The case the register exists for: a contact made this morning for one
  // premises, with no bills against it yet. A list built from bills cannot
  // contain it, so the row could not be written at all.
  xeroContacts[kj.tenantId] = [
    { Name: 'TM Technology Services Sdn Bhd - KJ 267-G', ContactStatus: 'ACTIVE' },
    { Name: 'TM Technology Services Sdn Bhd (archived)', ContactStatus: 'ARCHIVED' }
  ];
  const freshList = await req('GET', '/api/recharge/contacts/' + kj.tenantId + '?refresh=true', { cookie });
  check('a contact with no bills yet is still offered',
    freshList.body.contacts.includes('TM Technology Services Sdn Bhd - KJ 267-G'),
    freshList.body.contacts);
  check('an archived one is not, because a bill cannot be filed under it',
    !freshList.body.contacts.some((n) => /archived/.test(n)), freshList.body.contacts);
  check('and the contacts that have billed it are still there too',
    kjContacts.body.contacts.every((n) => freshList.body.contacts.includes(n)),
    { was: kjContacts.body.contacts.length, now: freshList.body.contacts.length });

  console.log('\nThe chart of accounts a rule chooses from');
  // Typed account codes fail at the last step, after one document may
  // already be posted. The dialog offers the real chart instead, and asks
  // for the chart of whichever entity that side of the recharge lands in.
  const chart = await req('GET', '/api/recharge/accounts/' + kj.tenantId, { cookie });
  check('an entity\'s chart of accounts can be read', chart.status === 200, chart.body);
  check('it offers what a recharge can post to',
    chart.body.accounts.some((a) => a.code === '445') && chart.body.accounts.some((a) => a.code === '200'),
    chart.body.accounts.map((a) => a.code));
  check('and leaves out what it cannot — archived, bank, and anything with no code',
    !chart.body.accounts.some((a) => ['300', '090'].includes(a.code))
    && chart.body.accounts.every((a) => a.code),
    chart.body.accounts.map((a) => a.code));
  check('sorted by code, so the list reads the way a chart of accounts does',
    chart.body.accounts.map((a) => a.code).join() === '200,429,445',
    chart.body.accounts.map((a) => a.code));

  // Read once per organisation, not once per keystroke in the dialog.
  calls.length = 0;
  await req('GET', '/api/recharge/accounts/' + kj.tenantId, { cookie });
  check('and cached, so retyping a rule does not re-read it',
    calls.filter((c) => c.path === '/Accounts').length === 0, calls.map((c) => c.path));

  // A chart that cannot be read must not stop a rule being written: the
  // dialog falls back to a text box, so the route answers 200 with nothing.
  accountsFail = Object.assign(new Error('Xero is unavailable'), { statusCode: 503 });
  const broken = await req('GET', '/api/recharge/accounts/' + kk.tenantId, { cookie });
  accountsFail = null;
  check('a chart Xero will not give up is reported, not raised',
    broken.status === 200 && broken.body.accounts.length === 0 && broken.body.error,
    broken.body);

  console.log('\nAccounts a rule posts to');
  const coded = await supplierRule('Account Coded Supplier', kk.tenantId,
    { name: 'With accounts', arAccountCode: '260', apAccountCode: '429' });
  check('a rule can name the account for each side', coded.status === 201, coded.body);
  check('and reads them back',
    coded.body.rule.arAccountCode === '260' && coded.body.rule.apAccountCode === '429',
    coded.body.rule);
  check('with a line saying so, for somebody reading the card',
    /260/.test(coded.body.rule.accountsLabel || '') && /429/.test(coded.body.rule.accountsLabel || ''),
    coded.body.rule.accountsLabel);
  const cleared = await req('PATCH', '/api/recharge/text-rules/' + coded.body.rule.id, {
    cookie, body: { arAccountCode: '', apAccountCode: '' }
  });
  check('and blanking them puts it back to the account off the bill',
    cleared.body.rule.arAccountCode === '' && cleared.body.rule.accountsLabel === null,
    cleared.body.rule);
  await req('DELETE', '/api/recharge/text-rules/' + coded.body.rule.id, { cookie });

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
  // Paid now, after the rules above exist. Both timestamps are MySQL
  // DATETIMEs, so they compare at whole seconds: this bill and the rule
  // that covers it were written back to back, and the test only ever
  // passed because they landed inside the same second. One second of
  // drift anywhere earlier in the suite turned a recharge into
  // "out of scope" — a failure that says nothing about the code.
  await paidNow(billKilang);
  async function verdict(billId) {
    return (await req('GET', `/api/recharge/bills/${billId}/decide`, { cookie })).body;
  }

  const vRecharge = await verdict(billKilang);
  check('step 4: an address owned by another entity is recharged',
    vRecharge.outcome === 'recharge' && vRecharge.ownerCode === 'ABKJ', vRecharge);
  check('and says why, naming the supplier',
    /Tenaga Nasional Berhad/.test(vRecharge.reason), vRecharge.reason);

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

  // The consequence of matching on the supplier alone, asserted so nobody
  // has to find it out from a wrong recharge: a bill from a named supplier
  // goes to that supplier's entity whatever premises it is for. That is
  // correct only while each contact covers one building — which is why the
  // contact is named after the building. A contact that covers several needs
  // a reference on the rule, or a recharge rule instead.
  const elsewhere = await makeBill(abm.tenantId, {
    ref: 'TNB-OTHER-0826', supplier: 'Tenaga Nasional Berhad', total: 700.00,
    address: 'Lot 12, Jalan Bulan Sabit, 98000 Miri'
  });
  const vNoMatch = await verdict(elsewhere);
  check('step 4: a named supplier is recharged whatever premises the bill carries',
    vNoMatch.outcome === 'recharge' && vNoMatch.ownerCode === 'ABKJ', vNoMatch);

  // …and the way to stop that is a reference on the rule.
  const narrowed = await supplierRule('Swanston Security', kk.tenantId,
    { name: 'Security at KK', reference: 'SEC-KK' });
  check('a rule can be narrowed to a reference', narrowed.status === 201, narrowed.body);
  const wrongRef = await makeBill(abm.tenantId, {
    ref: 'SEC-KJ-0826', supplier: 'Swanston Security', total: 310.00
  });
  const vWrongRef = await verdict(wrongRef);
  check('and a bill without that reference is left alone',
    vWrongRef.outcome === 'no-rule', vWrongRef);
  const rightRef = await makeBill(abm.tenantId, {
    ref: 'SEC-KK-0826', supplier: 'Swanston Security', total: 290.00
  });
  check('while one carrying it is recharged',
    (await verdict(rightRef)).ownerCode === 'ABKK');
  await req('DELETE', '/api/recharge/text-rules/' + narrowed.body.rule.id, { cookie });

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

  console.log('\nOne supplier, one entity');
  // The whole of a supplier rule: the contact says which building it is,
  // because somebody named it after the building in Xero.
  const LOT9 = 'Tenaga Nasional Berhad - Lot 9';
  const madeLot9 = await supplierRule(LOT9, kk.tenantId);
  check('a rule is a supplier and an entity, and needs nothing else',
    madeLot9.status === 201, madeLot9.body);

  const onContact = await makeBill(abm.tenantId, {
    ref: 'TNB-LOT9-0826', supplier: LOT9, total: 1850.00
  });
  check('a bill from that contact is recharged to that entity',
    (await verdict(onContact)).ownerCode === 'ABKK');

  // Nothing is read out of Xero to decide this. The supplier is already on
  // the local row, which is what makes the tab usable over 2,250 bills: the
  // old address matching cost a call per contact and sometimes per bill.
  calls.length = 0;
  await verdict(onContact);
  check('and deciding it costs Xero nothing at all',
    calls.length === 0, calls.map((c) => c.path));

  const sibling = await makeBill(abm.tenantId, {
    ref: 'TNB-LOT9-0926', supplier: LOT9, total: 1910.00
  });
  calls.length = 0;
  check('nor does another bill from the same contact',
    (await verdict(sibling)).ownerCode === 'ABKK' && calls.length === 0, calls.map((c) => c.path));

  // Two rules naming one supplier. Rules are tried in order and the first
  // match wins, so the narrower one only does anything if it sits above the
  // broader one — which is the whole reason the tab lets them be ordered.
  const narrow = await supplierRule(LOT9, kj.tenantId,
    { name: LOT9 + ' (Sept)', reference: 'TNB-LOT9-09' });
  check('a second rule can narrow the same supplier by reference',
    narrow.status === 201, narrow.body);
  check('below the broader rule it never fires, which is what order means',
    (await verdict(sibling)).ownerCode === 'ABKK');
  await req('PATCH', '/api/recharge/text-rules/' + narrow.body.rule.id,
    { cookie, body: { position: -1 } });
  check('moved above it, the bill carrying that reference follows the narrower rule',
    (await verdict(sibling)).ownerCode === 'ABKJ');
  check('and the one that does not still follows the broader rule',
    (await verdict(onContact)).ownerCode === 'ABKK');
  await req('DELETE', '/api/recharge/text-rules/' + narrow.body.rule.id, { cookie });

  // Two rules that describe exactly the same bills: the second says nothing
  // the first does not, and silently shadowing one with the other is how a
  // recharge ends up somewhere nobody chose.
  // Two rules naming one supplier is allowed — the narrower one wins, which
  // is the case just above. The order they sit in is what decides, and that
  // is the rule tab's own concern.
  const sameAgain = await supplierRule(LOT9, kj.tenantId, { name: LOT9 + ' (second)' });
  check('a second rule for the same supplier is allowed, and ranks after the first',
    sameAgain.status === 201 && (await verdict(onContact)).ownerCode === 'ABKK',
    sameAgain.body);
  await req('DELETE', '/api/recharge/text-rules/' + sameAgain.body.rule.id, { cookie });

  console.log('\nAsking what a bill would do before it is paid');
  const ahead = await req('POST', '/api/recharge/decide', {
    cookie, body: { billIds: [unpaidBill], assumePaid: true }
  });
  check('assumePaid answers the question the Pay dialog is actually asking',
    ahead.body.decisions[0].outcome === 'recharge', ahead.body.decisions[0]);

  check('with a short form for a row that has already printed the bill',
    ahead.body.decisions[0].consequence !== ahead.body.decisions[0].reason
    && /ABKJ|Ayu Borneo \(KJ\)/.test(ahead.body.decisions[0].consequence),
    ahead.body.decisions[0].consequence);

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
  check('the whole bill goes to the entity the rule names',
    plan.body.lines.length === 1 && plan.body.lines[0].code === 'ABKJ'
    && plan.body.lines[0].amount === '17,980.00', plan.body.lines);
  // The code, not the bracketed part of the name. This fixture is still on
  // the old ABKJ-style codes, and that is the point: whatever the code says
  // is what a bank statement will show.
  check('the reference carries the entity code',
    /^IC-TNB-GRP-0726-ABKJ$/.test(plan.body.lines[0].reference), plan.body.lines[0].reference);
  check('planning writes nothing',
    Number((await db.getOne('SELECT COUNT(*) AS n FROM recharge_runs')).n) === 0);

  console.log('\nCreating a run');
  calls.length = 0;
  const run = await req('POST', '/api/recharge/runs', { cookie, body: { billId: billKilang } });
  check('the run is created', run.status === 201 && run.body.id, run.body);
  check('creating it does NOT touch Xero', calls.length === 0, calls.map((c) => c.path));
  const runId = run.body.id;
  const stored = await db.getOne(
    'SELECT status, supplier_name, bill_reference FROM recharge_runs WHERE id = ?', [runId]);
  check('it starts as a draft', stored.status === 'draft', stored.status);
  check('the supplier and reference are snapshotted, so editing the rule later cannot rewrite history',
    stored.supplier_name === 'Tenaga Nasional Berhad' && stored.bill_reference === 'TNB-GRP-0726',
    stored);

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
  check('the mirror bill is raised in the entity the rule names',
    ap.every((c) => c.tenantId === kj.tenantId), ap.map((c) => c.tenantId));
  // Both sides are a draft: a recharge is a proposal until somebody in each
  // company has looked at it, and an authorised invoice is a receivable that
  // has to be credited to undo rather than simply deleted.
  check('both documents are drafts',
    ar[0].body.Invoices[0].Status === 'DRAFT' && ap[0].body.Invoices[0].Status === 'DRAFT',
    { ar: ar[0].body.Invoices[0].Status, ap: ap[0].body.Invoices[0].Status });
  // The payer's electricity expense nets to zero and the company that used
  // the electricity carries it as electricity. Nobody configured anything.
  check('both sides post to the account the original bill was booked to',
    ar[0].body.Invoices[0].LineItems[0].AccountCode === '445'
    && ap[0].body.Invoices[0].LineItems[0].AccountCode === '445',
    { ar: ar[0].body.Invoices[0].LineItems[0].AccountCode, ap: ap[0].body.Invoices[0].LineItems[0].AccountCode });
  check('both sides are stated in the original bill\'s currency',
    ar[0].body.Invoices[0].CurrencyCode === 'MYR' && ap[0].body.Invoices[0].CurrencyCode === 'MYR',
    { ar: ar[0].body.Invoices[0].CurrencyCode, ap: ap[0].body.Invoices[0].CurrencyCode });
  // The receiving entity's bookkeeper is looking at a bill from a sister
  // company and needs to be able to ask about "invoice AR-IC-1001". The IC-
  // reference pairs the two for Bills Hub; the sales invoice number is what
  // pairs them for the two people reconciling.
  const postedLine = await db.getOne(
    'SELECT ar_invoice_number, ap_invoice_number FROM recharge_run_lines WHERE run_id = ?', [runId]);
  const arNumber = postedLine.ar_invoice_number;
  check('the bill carries the payer\'s sales invoice number as the supplier invoice number',
    ap[0].body.Invoices[0].InvoiceNumber === arNumber,
    { sent: ap[0].body.Invoices[0].InvoiceNumber, arNumber });
  check('and names it on the face of the bill',
    ap[0].body.Invoices[0].LineItems[0].Description.includes(arNumber),
    ap[0].body.Invoices[0].LineItems[0].Description);
  check('the sales invoice itself is not given one, so Xero numbers it',
    ar[0].body.Invoices[0].InvoiceNumber === undefined,
    ar[0].body.Invoices[0].InvoiceNumber);
  check('and Xero stores it back on the bill',
    postedLine.ap_invoice_number === arNumber, postedLine);

  // The contact is what somebody outside Bills Hub reads on the document.
  // "Ayu Borneo (KJ)" is a label for Bills Hub's own lists; the organisation
  // Xero knows, and the one the bill is really from, is "… Sdn Bhd".
  const madeContacts = calls.filter((c) => c.path === '/Contacts' && c.method === 'POST')
    .map((c) => c.body.Contacts[0].Name);
  check('the counterparty is named as Xero names the organisation, not by its short label',
    madeContacts.length > 0 && madeContacts.every((n) => /Sdn Bhd$/.test(n)), madeContacts);
  check('the bill is from the paying organisation under that name',
    madeContacts.includes('Ayu Borneo Management Sdn Bhd'), madeContacts);
  check('and the sales invoice is addressed to the receiving one',
    madeContacts.includes('Ayu Borneo (KJ) Sdn Bhd'), madeContacts);

  check('and the line on both documents names the payer the same way',
    [ar[0], ap[0]].every((c) =>
      /paid by Ayu Borneo Management Sdn Bhd/.test(c.body.Invoices[0].LineItems[0].Description)),
    [ar[0], ap[0]].map((c) => c.body.Invoices[0].LineItems[0].Description));

  check('both sides carry the same amount and reference',
    ar[0].body.Invoices[0].LineItems[0].UnitAmount === ap[0].body.Invoices[0].LineItems[0].UnitAmount
    && ar[0].body.Invoices[0].Reference === ap[0].body.Invoices[0].Reference,
    { ar: ar[0].body.Invoices[0].Reference, ap: ap[0].body.Invoices[0].Reference });
  check('the supplier and the original reference are on the face of both documents',
    [ar[0], ap[0]].every((c) => {
      const d = c.body.Invoices[0].LineItems[0].Description;
      return d.includes('Tenaga Nasional Berhad') && d.includes('TNB-GRP-0726');
    }),
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

  // The suggestion list posts in the same call now: working the recharge
  // out and then leaving it for a second click only made sense while the
  // first click produced something a person needed to read.
  console.log('\nOne click: worked out and posted together');
  const oneClickBill = await makeBill(abm.tenantId, {
    ref: 'TNB-ONECLICK-0826', supplier: 'Tenaga Nasional Berhad', total: 640.00, address: KILANG
  });
  calls.length = 0;
  const oneClick = await req('POST', '/api/recharge/runs', {
    cookie, body: { billId: oneClickBill, post: true }
  });
  check('post: true creates the documents in the same call',
    oneClick.status === 201 && oneClick.body.posted && oneClick.body.posted.posted === 1,
    oneClick.body);
  check('and both documents really were created',
    calls.filter((c) => c.path === '/Invoices' && c.method === 'POST').length === 2,
    calls.filter((c) => c.path === '/Invoices').length);

  // A run worked out under testing mode can never be posted, so asking to
  // post one is answered by not trying rather than by an error.
  await testModeLib.set(1, true);
  const tmOneClick = await makeBill(abm.tenantId, {
    ref: 'TNB-ONECLICK-0926', supplier: 'Tenaga Nasional Berhad', total: 660.00, address: KILANG
  });
  calls.length = 0;
  const tmClick = await req('POST', '/api/recharge/runs', {
    cookie, body: { billId: tmOneClick, post: true }
  });
  check('in testing mode it is worked out but not posted, and does not error',
    tmClick.status === 201 && tmClick.body.posted === null, tmClick.body);
  check('and Xero saw nothing', calls.length === 0, calls.map((c) => c.path));
  await testModeLib.set(1, false);
  testModeLib.forget(1);

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
  check('the run row names the rule that decided it',
    /^Recharge rule · Tenaga Nasional Berhad$/.test(row.notes), row.notes);
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
  // Suggested, not filtered out: the rule names this supplier, so every bill
  // from it is recharged wherever the bill was for. See the assertion in
  // "The four steps" — this is the same consequence seen from the tab.
  check('every bill from a named supplier is suggested, whatever premises it is for',
    refs.includes('TNB-OTHER-0826'), refs);
  check('an already-recharged bill is not', !refs.includes('TNB-GRP-0726'), refs);

  const one = sugg.body.suggestions.find((s) => s.reference === 'TNB-LINE-0826');
  check('a suggestion carries the supplier and the owner',
    one && one.supplier === 'Tenaga Nasional Berhad' && one.ownerCode === 'ABKJ', one);

  const fromSugg = await req('POST', '/api/recharge/runs', {
    cookie, body: { billId: one.billId, ruleId: one.ruleId, ownerTenantId: one.ownerTenantId }
  });
  check('a suggestion can be turned into a run', fromSugg.status === 201, fromSugg.body);
  const after = await req('GET', '/api/recharge/suggestions', { cookie });
  check('and then stops being suggested',
    !after.body.suggestions.some((x) => x.reference === 'TNB-LINE-0826'),
    after.body.suggestions.map((s) => s.reference));

  console.log('\nEditing a rule');
  const moved = await req('PATCH', '/api/recharge/text-rules/' + rule.body.rule.id, {
    cookie, body: { ownerTenantId: kk.tenantId }
  });
  check('the owner can be changed', moved.status === 200 && moved.body.rule.ownerCode === 'ABKK', moved.body.rule);
  const offed = await req('PATCH', '/api/recharge/text-rules/' + rule.body.rule.id, { cookie, body: { enabled: false } });
  check('and it can be switched off without re-stating the supplier',
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

  // A bill nobody has paid has no payment moment, so a recharge rule called
  // it out of scope and named a payment date that did not exist. Paying it
  // now is the premise of the question the Pay dialog asks, so now is the
  // moment to compare against.
  const neverPaid = await makeBill(abm.tenantId, {
    ref: 'EPF-FUTURE-0926', supplier: 'KWSP (EPF)', total: 700.00, paid: false
  });
  const askedAhead = await req('POST', '/api/recharge/decide', {
    cookie, body: { billIds: [neverPaid], assumePaid: true }
  });
  check('a bill never paid is judged as if it were paid now, not out of scope',
    askedAhead.body.decisions[0].outcome === 'recharge', askedAhead.body.decisions[0]);

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

  console.log('\nSupplier rules win over recharge rules');
  // Both kinds could claim this bill. The supplier rule is the narrower
  // statement — one contact, one entity — so it decides, and a recharge rule
  // written across a whole supplier family cannot quietly override it.
  const BOTH_SUPPLIER = 'Tenaga Nasional Berhad - Blok C';
  const named = await supplierRule(BOTH_SUPPLIER, kj.tenantId);
  check('a rule can name the contact for one building', named.status === 201, named.body);
  const both = await makeBill(abm.tenantId, {
    ref: 'TNB-BOTH-0826', supplier: BOTH_SUPPLIER, total: 500.00
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
  check('the supplier rule decides, not the supplier-wide recharge rule',
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
  // Paid after BOTH rules exist. A rule only counts bills marked paid after
  // it was written, and these were paid a moment before this second rule —
  // close enough that the two MySQL DATETIMEs usually landed in the same
  // second and the comparison passed by luck. One second of drift anywhere
  // earlier in the suite turned both counts to zero.
  await paidNow(fuel, fuelCardBill);

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

  console.log('\nThe bill\'s own paperwork travels with the recharge');
  // Both documents are drafts somebody has to approve, and approving one
  // means looking at what was actually billed. Making them go back to the
  // paying company's Xero to find the PDF is the difference between a
  // recharge that can be checked and one that gets waved through.
  const withFiles = await makeBill(abm.tenantId, {
    ref: 'TNB-ATTACH-0826', supplier: BOTH_SUPPLIER, total: 640.00
  });
  const withFilesXeroId = (await db.getOne(
    'SELECT xero_invoice_id FROM bills WHERE id = ?', [withFiles])).xero_invoice_id;
  attachments[withFilesXeroId] = [
    { FileName: 'tnb-august.pdf', MimeType: 'application/pdf', ContentLength: 48000 },
    { FileName: 'meter reading.jpg', MimeType: 'image/jpeg', ContentLength: 12000 }
  ];
  await paidNow(withFiles);
  uploaded.length = 0;
  const attRun = await req('POST', '/api/recharge/runs', {
    cookie, body: { billId: withFiles, post: true }
  });
  check('the recharge posts', attRun.status === 201 && attRun.body.posted, attRun.body);
  // Two source files onto two documents, plus the sales invoice PDF onto the
  // bill: the receiving entity gets the supplier's bill AND the document the
  // sister company is charging it with.
  check('both files reach both documents, and the sales invoice joins the bill',
    uploaded.length === 5, uploaded.map((u) => `${u.name}->${u.invoiceId}`));
  check('and each lands in a different organisation',
    new Set(uploaded.map((u) => u.tenantId)).size === 2,
    uploaded.map((u) => u.tenantId));
  check('under the name and type the original carried',
    uploaded.filter((u) => u.name === 'meter reading.jpg' && u.contentType === 'image/jpeg').length === 2,
    uploaded.map((u) => `${u.name} ${u.contentType}`));
  check('with the bytes, not an empty file',
    uploaded.every((u) => u.bytes > 0), uploaded.map((u) => u.bytes));

  // The sales invoice goes one way only. It belongs on the bill, which is
  // the document somebody in the receiving entity has to approve; putting it
  // back on the invoice it was rendered from would say nothing.
  const salesPdf = uploaded.filter((u) => /^Sales invoice .+\.pdf$/.test(u.name));
  const apLine = await db.getOne(
    'SELECT ar_invoice_number, ap_invoice_id FROM recharge_run_lines WHERE run_id = ?', [attRun.body.id]);
  check('the payer\'s sales invoice is attached, once',
    salesPdf.length === 1, salesPdf.map((u) => u.name));
  check('named for the invoice it is',
    salesPdf[0].name === `Sales invoice ${apLine.ar_invoice_number}.pdf`,
    { got: salesPdf[0].name, arNumber: apLine.ar_invoice_number });
  check('onto the bill in the receiving entity, as a PDF',
    salesPdf[0].invoiceId === apLine.ap_invoice_id
    && salesPdf[0].tenantId === kj.tenantId
    && salesPdf[0].contentType === 'application/pdf', salesPdf[0]);

  check('and the run says how many it carried',
    attRun.body.posted.attachments.copied === 5
    && attRun.body.posted.attachments.available === 2, attRun.body.posted.attachments);

  // Recharges posted before the contact was named properly left a contact
  // called "Ayu Borneo Management" in the receiving organisation. Creating a
  // second one beside it under the full name would split the intercompany
  // history in two and leave somebody merging them by hand.
  const legacyBill = await makeBill(abm.tenantId, {
    ref: 'TNB-LEGACYCONTACT-0826', supplier: BOTH_SUPPLIER, total: 55.00
  });
  await paidNow(legacyBill);
  namedContacts[kj.tenantId] = { 'Ayu Borneo Management': 'legacy-contact-abm' };
  // The counterparty is cached per process once resolved, so an earlier run in
  // this same test would answer before any lookup happened.
  require('../billhub/recharge')._contactCache.clear();
  calls.length = 0;
  const legacyRun = await req('POST', '/api/recharge/runs', {
    cookie, body: { billId: legacyBill, post: true }
  });
  delete namedContacts[kj.tenantId];
  const legacyMade = calls.filter((c) => c.path === '/Contacts' && c.method === 'POST')
    .map((c) => c.body.Contacts[0].Name);
  const legacyAp = calls.find((c) => c.path === '/Invoices' && c.method === 'POST'
    && c.body.Invoices[0].Type === 'ACCPAY');
  check('an existing contact under the old short name is reused',
    legacyAp.body.Invoices[0].Contact.ContactID === 'legacy-contact-abm',
    legacyAp.body.Invoices[0].Contact);
  check('rather than a second one created beside it',
    !legacyMade.includes('Ayu Borneo Management Sdn Bhd'), legacyMade);
  check('and the recharge still posts',
    legacyRun.body.posted && legacyRun.body.posted.failed === 0, legacyRun.body.posted);

  // The state each document is created in is a setting, because the right
  // answer depends on a tax regime rather than on software.
  console.log('\nWhat state the documents are created in');
  const badState = await req('PATCH', '/api/recharge/settings', { cookie, body: { arStatus: 'PAID' } });
  check('a state Xero cannot create a document in is refused',
    badState.status === 400 && /DRAFT, SUBMITTED, AUTHORISED/.test(badState.body.error || ''), badState.body);

  const defaults = await req('GET', '/api/recharge', { cookie });
  check('both default to draft, which is what the module always did',
    defaults.body.settings.arStatus === 'DRAFT' && defaults.body.settings.apStatus === 'DRAFT',
    defaults.body.settings);

  await req('PATCH', '/api/recharge/settings', { cookie, body: { arStatus: 'AUTHORISED', apStatus: 'DRAFT' } });
  const approvedBill = await makeBill(abm.tenantId, {
    ref: 'TNB-APPROVED-0826', supplier: BOTH_SUPPLIER, total: 77.00
  });
  await paidNow(approvedBill);
  calls.length = 0;
  const approvedRun = await req('POST', '/api/recharge/runs', {
    cookie, body: { billId: approvedBill, post: true }
  });
  check('the recharge posts', approvedRun.body.posted && approvedRun.body.posted.failed === 0, approvedRun.body.posted);
  const madeInv = calls.filter((c) => c.path === '/Invoices' && c.method === 'POST');
  const arDoc = madeInv.find((c) => c.body.Invoices[0].Type === 'ACCREC');
  const apDoc = madeInv.find((c) => c.body.Invoices[0].Type === 'ACCPAY');
  check('the sales invoice is raised in the state chosen',
    arDoc.body.Invoices[0].Status === 'AUTHORISED', arDoc.body.Invoices[0].Status);
  check('and the bill keeps its own, so the two are set independently',
    apDoc.body.Invoices[0].Status === 'DRAFT', apDoc.body.Invoices[0].Status);
  // draftDocument is what exempts a write from XERO_TENANT_ALLOWLIST, and
  // that exemption is only defensible for something that can be deleted.
  check('an authorised document no longer claims the draft exemption',
    arDoc.draftDocument === false && apDoc.draftDocument === true,
    { ar: arDoc.draftDocument, ap: apDoc.draftDocument });

  // Testing mode overrides both, and that is not configurable: a rehearsal
  // must never put a real invoice in front of LHDN.
  await req('PATCH', '/api/recharge/settings', { cookie, body: { arStatus: 'AUTHORISED', apStatus: 'AUTHORISED' } });
  await testModeLib.set(1, true);
  const rehearsal = await makeBill(abm.tenantId, {
    ref: 'TNB-REHEARSAL-0826', supplier: BOTH_SUPPLIER, total: 88.00
  });
  await paidNow(rehearsal);
  // Creating with post:true is answered by not trying while testing mode is
  // on, so the posting itself is asked for explicitly — that is the path the
  // sweep takes after a test payment, and the one where the state matters.
  const rehearsalRun = await req('POST', '/api/recharge/runs', { cookie, body: { billId: rehearsal } });
  calls.length = 0;
  await req('POST', `/api/recharge/runs/${rehearsalRun.body.id}/post`, { cookie });
  const testDocs = calls.filter((c) => c.path === '/Invoices' && c.method === 'POST');
  check('testing mode creates drafts whatever the setting says',
    testDocs.length === 2 && testDocs.every((c) => c.body.Invoices[0].Status === 'DRAFT'),
    testDocs.map((c) => c.body.Invoices[0].Type + ':' + c.body.Invoices[0].Status));
  check('and they keep the draft exemption, so the allowlist still lets them through',
    testDocs.every((c) => c.draftDocument === true), testDocs.map((c) => c.draftDocument));
  await testModeLib.set(1, false);
  testModeLib.forget(1);
  await req('PATCH', '/api/recharge/settings', { cookie, body: { arStatus: 'DRAFT', apStatus: 'DRAFT' } });

  // The ledger writes the same company its own way. Xero's Name== is exact,
  // so none of the lookups above find "AYU BORNEO MANAGEMENT SDN BHD" when
  // we ask for "Ayu Borneo Management Sdn Bhd". Creating a second contact
  // there is what produced invoices LHDN would not take: the real contact
  // carries the sales defaults, the duplicate carries nothing.
  const spelled = await makeBill(abm.tenantId, {
    ref: 'TNB-SPELLING-0826', supplier: BOTH_SUPPLIER, total: 64.00
  });
  await paidNow(spelled);
  namedContacts[kj.tenantId] = { 'AYU BORNEO MANAGEMENT SDN. BHD.': 'contact-existing-abm' };
  require('../billhub/recharge')._contactCache.clear();
  calls.length = 0;
  const spelledRun = await req('POST', '/api/recharge/runs', {
    cookie, body: { billId: spelled, post: true }
  });
  delete namedContacts[kj.tenantId];
  const spelledMade = calls.filter((c) => c.path === '/Contacts' && c.method === 'POST');
  const spelledAp = calls.find((c) => c.path === '/Invoices' && c.method === 'POST'
    && c.body.Invoices[0].Type === 'ACCPAY');
  check('a contact the ledger spells differently is matched, not duplicated',
    spelledAp.body.Invoices[0].Contact.ContactID === 'contact-existing-abm',
    spelledAp.body.Invoices[0].Contact);
  // Scoped to the one that already exists: the sales invoice still needs a
  // contact for the receiving entity in the payer's own ledger, and nothing
  // was seeded there, so creating that one is correct.
  const dupes = spelledMade.filter((c) =>
    /^ayuborneomanagement/.test(require('../lib/premises').normalise(c.body.Contacts[0].Name)));
  check('so no second contact is created beside it',
    dupes.length === 0, spelledMade.map((c) => c.body.Contacts[0].Name));
  check('and the recharge still posts',
    spelledRun.body.posted && spelledRun.body.posted.failed === 0, spelledRun.body.posted);

  // Malaysian e-invoicing keeps the MyInvois classification as a tracking
  // default on the contact. Xero fills it in for somebody typing an invoice
  // and does not for one created through the API, so every recharge went out
  // with the column empty and LHDN would not take it.
  const classified = await makeBill(abm.tenantId, {
    ref: 'TNB-CLASSIFY-0826', supplier: BOTH_SUPPLIER, total: 91.00
  });
  await paidNow(classified);
  namedContacts[abm.tenantId] = { 'Ayu Borneo (KJ) Sdn Bhd': 'contact-kj-in-abm' };
  namedContacts[kj.tenantId] = { 'Ayu Borneo Management Sdn Bhd': 'contact-abm-in-kj' };
  contactTracking['contact-kj-in-abm'] = {
    SalesTrackingCategories: [
      { Name: 'MyInvois Classification', Option: '022 - Others' },
      { Name: 'Outlet', Option: 'ABKW' }
    ]
  };
  contactTracking['contact-abm-in-kj'] = {
    PurchasesTrackingCategories: [{ Name: 'Outlet', Option: 'ABKJ' }]
  };
  require('../billhub/recharge')._contactCache.clear();
  require('../billhub/recharge')._trackingCache.clear();
  calls.length = 0;
  const classifiedRun = await req('POST', '/api/recharge/runs', {
    cookie, body: { billId: classified, post: true }
  });
  delete namedContacts[abm.tenantId]; delete namedContacts[kj.tenantId];
  const clsInv = calls.filter((c) => c.path === '/Invoices' && c.method === 'POST');
  const clsAr = clsInv.find((c) => c.body.Invoices[0].Type === 'ACCREC');
  const clsAp = clsInv.find((c) => c.body.Invoices[0].Type === 'ACCPAY');
  check('the recharge posts', classifiedRun.body.posted && classifiedRun.body.posted.failed === 0,
    classifiedRun.body.posted);
  check('the sales invoice carries the contact\'s MyInvois classification',
    JSON.stringify(clsAr.body.Invoices[0].LineItems[0].Tracking)
      === JSON.stringify([{ Name: 'MyInvois Classification', Option: '022 - Others' }, { Name: 'Outlet', Option: 'ABKW' }]),
    clsAr.body.Invoices[0].LineItems[0].Tracking);
  // A bill takes the purchases defaults, not the sales ones.
  check('and the bill takes the purchases defaults instead',
    JSON.stringify(clsAp.body.Invoices[0].LineItems[0].Tracking)
      === JSON.stringify([{ Name: 'Outlet', Option: 'ABKJ' }]),
    clsAp.body.Invoices[0].LineItems[0].Tracking);

  // A contact with nothing set must not produce an empty Tracking element.
  const untracked = await makeBill(abm.tenantId, {
    ref: 'TNB-NOTRACK-0826', supplier: BOTH_SUPPLIER, total: 33.00
  });
  await paidNow(untracked);
  require('../billhub/recharge')._contactCache.clear();
  require('../billhub/recharge')._trackingCache.clear();
  calls.length = 0;
  await req('POST', '/api/recharge/runs', { cookie, body: { billId: untracked, post: true } });
  const untrackedAr = calls.find((c) => c.path === '/Invoices' && c.method === 'POST'
    && c.body.Invoices[0].Type === 'ACCREC');
  check('a contact with no defaults sends no tracking at all',
    !('Tracking' in untrackedAr.body.Invoices[0].LineItems[0]),
    untrackedAr.body.Invoices[0].LineItems[0].Tracking);

  // Something too big to be worth moving is named rather than silently left.
  const bigBill = await makeBill(abm.tenantId, {
    ref: 'TNB-BIG-0826', supplier: BOTH_SUPPLIER, total: 90.00
  });
  const bigXeroId = (await db.getOne(
    'SELECT xero_invoice_id FROM bills WHERE id = ?', [bigBill])).xero_invoice_id;
  attachments[bigXeroId] = [
    { FileName: 'whole-cabinet.pdf', MimeType: 'application/pdf', ContentLength: 40 * 1024 * 1024 }
  ];
  await paidNow(bigBill);
  uploaded.length = 0;
  const bigRun = await req('POST', '/api/recharge/runs', {
    cookie, body: { billId: bigBill, post: true }
  });
  check('an oversized attachment is skipped, and said so',
    bigRun.body.posted.attachments.skipped.some((x) => /whole-cabinet\.pdf.*larger/.test(x)),
    bigRun.body.posted.attachments);
  // The sales invoice is rendered by Xero rather than carried from the
  // source, so a source file too big to move does not hold it back.
  check('and the sales invoice still reaches the bill',
    bigRun.body.posted.attachments.copied === 1, bigRun.body.posted.attachments);
  check('and the recharge itself still posted',
    bigRun.body.posted.failed === 0, bigRun.body.posted);
  check('with nothing carried from the source, only the sales invoice',
    uploaded.length === 1 && /^Sales invoice /.test(uploaded[0].name),
    uploaded.map((u) => u.name));

  // The grant predates the attachments scope. Xero answers 403 and the
  // recharge has to carry on: the documents are the point, the PDF is not.
  const noScope = await makeBill(abm.tenantId, {
    ref: 'TNB-NOSCOPE-0826', supplier: BOTH_SUPPLIER, total: 70.00
  });
  await paidNow(noScope);
  attachmentsFail = Object.assign(
    new Error('AuthorizationUnsuccessful: the scope accounting.attachments is missing'),
    { statusCode: 403 });
  const scopeRun = await req('POST', '/api/recharge/runs', {
    cookie, body: { billId: noScope, post: true }
  });
  attachmentsFail = null;
  check('a grant without the attachments scope does not fail the recharge',
    scopeRun.body.posted.failed === 0 && scopeRun.body.posted.posted === 1, scopeRun.body.posted);
  check('and the missing scope is reported rather than swallowed',
    scopeRun.body.posted.attachments.skipped.some((x) => /accounting\.attachments/.test(x)),
    scopeRun.body.posted.attachments);

  // Same rule for the sales invoice PDF. Both documents are in Xero by the
  // time it is fetched, so failing the run over it would undo nothing and
  // leave a posted recharge looking broken.
  const noPdf = await makeBill(abm.tenantId, {
    ref: 'TNB-NOPDF-0826', supplier: BOTH_SUPPLIER, total: 61.00
  });
  await paidNow(noPdf);
  pdfFail = Object.assign(new Error('Xero could not render this invoice.'), { statusCode: 500 });
  const pdfRun = await req('POST', '/api/recharge/runs', { cookie, body: { billId: noPdf, post: true } });
  pdfFail = null;
  check('a sales invoice Xero will not render does not fail the recharge',
    pdfRun.body.posted.failed === 0 && pdfRun.body.posted.posted === 1, pdfRun.body.posted);
  check('and is reported rather than swallowed',
    pdfRun.body.posted.attachments.skipped.some((x) => /Sales invoice .*could not render/.test(x)),
    pdfRun.body.posted.attachments);

  console.log('\nPaying a bill recharges it, with nobody clicking anything');
  // The button is the same answer every time once the rules are right, so
  // paying a bill posts its recharge. Both documents are drafts, which is
  // what makes doing it unattended safe.
  const recharge = require('../billhub/recharge');

  const autoBill = await makeBill(abm.tenantId, {
    ref: 'TNB-AUTO-0826', supplier: BOTH_SUPPLIER, total: 412.00
  });
  await paidNow(autoBill);
  const swept = await recharge.sweep(1);
  check('a sweep posts the bills a rule covers',
    swept.posted >= 1 && swept.failed === 0, swept);
  const autoRun = await db.getOne(
    `SELECT r.status, l.ar_invoice_id, l.ap_invoice_id
       FROM recharge_runs r JOIN recharge_run_lines l ON l.run_id = r.id
      WHERE r.bill_id = ?`, [autoBill]);
  check('and both documents exist, with no run left as a draft',
    autoRun && autoRun.status === 'posted' && autoRun.ar_invoice_id && autoRun.ap_invoice_id,
    autoRun);

  const sweptTwice = await recharge.sweep(1);
  check('a second sweep has nothing to do — it does not recharge anything twice',
    sweptTwice.posted === 0 && sweptTwice.failed === 0, sweptTwice);

  // Two sweeps at once is the normal case: the payment that just finished
  // fires one and the timer fires another. The second has to stand down
  // rather than race the first into a duplicate.
  const racer = await makeBill(abm.tenantId, {
    ref: 'TNB-RACE-0826', supplier: BOTH_SUPPLIER, total: 88.00
  });
  await paidNow(racer);
  const [a1, a2] = await Promise.all([recharge.sweep(1), recharge.sweep(1)]);
  check('two sweeps at once post it once between them',
    a1.posted + a2.posted === 1 && [a1, a2].some((x) => x.skipped === 'already running'),
    [a1, a2]);

  // A bill nothing covers must not be touched, or the sweep becomes the
  // most dangerous thing in the app.
  const untouched = await makeBill(abm.tenantId, {
    ref: 'MISC-AUTO-0826', supplier: 'Swanston Security', total: 150.00
  });
  await paidNow(untouched);
  await recharge.sweep(1);
  check('a bill no rule covers is left alone',
    Number((await db.getOne(
      'SELECT COUNT(*) AS n FROM recharge_runs WHERE bill_id = ?', [untouched])).n) === 0);

  // The stop switch.
  const offBill = await makeBill(abm.tenantId, {
    ref: 'TNB-OFF-0826', supplier: BOTH_SUPPLIER, total: 55.00
  });
  await paidNow(offBill);
  await req('PATCH', '/api/recharge/settings', { cookie, body: { autoPost: false } });
  const stopped = await recharge.sweep(1);
  check('switched off, the sweep posts nothing and says why',
    stopped.posted === 0 && stopped.skipped === 'switched off', stopped);
  check('and the bill is still offered with a button',
    (await req('GET', '/api/recharge/suggestions', { cookie }))
      .body.suggestions.some((x) => x.reference === 'TNB-OFF-0826'));
  const back = await req('PATCH', '/api/recharge/settings', { cookie, body: { autoPost: true } });
  check('the switch is reported to the browser',
    back.body.settings.autoPost === true, back.body.settings);

  console.log('\nTesting mode');
  // Testing mode blocks the payment, not the recharge. The two documents a
  // recharge posts are DRAFTS, and a draft in a live organisation is exactly
  // what somebody turning this switch on wants to look at: visible,
  // reviewable, deleted with one click. What stays blocked is moving a bill
  // to Paid in Xero, which is the irreversible half.
  const tmBill = await makeBill(abm.tenantId, {
    ref: 'TNB-TEST-0826', supplier: BOTH_SUPPLIER, total: 777.00
  });

  await testModeLib.set(1, true);
  calls.length = 0;
  const tmRun = await req('POST', '/api/recharge/runs', { cookie, body: { billId: tmBill } });
  check('a recharge can be worked out in testing mode', tmRun.status === 201, tmRun.body);

  const tmRow = (await req('GET', '/api/recharge', { cookie })).body.runRows.find((r) => r.id === tmRun.body.id);
  check('it is shown, and not as a pretend one', Boolean(tmRow) && tmRow.testMode !== true, tmRow && tmRow.statusLabel);
  check('and it offers a way to post, because posting now works', tmRow.canPost === true, tmRow.canPost);

  calls.length = 0;
  const tmPost = await req('POST', `/api/recharge/runs/${tmRun.body.id}/post`, { cookie });
  check('posting it in testing mode succeeds', tmPost.status === 200 && tmPost.body.posted === 1, tmPost.body);
  check('both documents reached Xero',
    calls.filter((c) => c.path === '/Invoices' && c.method === 'POST').length === 2,
    calls.map((c) => c.method + ' ' + c.path));
  check('and both are DRAFT, which is what makes this safe',
    calls.filter((c) => c.path === '/Invoices' && c.method === 'POST')
      .every((c) => c.body.Invoices[0].Status === 'DRAFT'),
    calls.filter((c) => c.path === '/Invoices').map((c) => c.body && c.body.Invoices[0].Status));
  check('no payment was attempted',
    !calls.some((c) => /Payment/i.test(c.path)), calls.map((c) => c.path));

  // The guard still holds for everything nobody opted in: lib/xero.js
  // refuses a write unless the call site asked for it by name.
  let stray = null;
  try {
    await realXeroApi(1, 'tenant-abm', '/BankTransactions', { method: 'POST', body: {} });
  } catch (e) { stray = e; }
  check('a write nobody opted in is still refused at the chokepoint',
    stray && stray.testMode === true, stray && stray.message);

  const tagged = (await req('GET', '/api/recharge', { cookie })).body.runRows
    .find((r) => r.id === tmRun.body.id);
  check('a run drafted under testing mode is labelled as one',
    tagged && tagged.madeInTest === true, tagged && tagged.madeInTest);

  await testModeLib.set(1, false);
  testModeLib.forget(1);
  const afterOff = (await req('GET', '/api/recharge', { cookie })).body;
  const still = afterOff.runRows.find((r) => r.id === tmRun.body.id);
  check('the run stays visible once testing mode is off — its documents are real',
    Boolean(still), afterOff.runRows.map((r) => r.id));
  check('and keeps the label, so the two can still be told apart',
    still && still.madeInTest === true, still && still.madeInTest);

  // The label is not the old hide-it flag. test_mode means "posted nothing"
  // and nothing sets it now; made_in_test means "drafted while the switch
  // was on" and the documents are real.
  check('and is not the flag that used to hide it',
    still && still.testMode === false, still && still.testMode);

  // Two callers that both passed planRun's check — the auto-post sweep and
  // somebody pressing Draft recharge. Before uq_run_bill dropped test_mode
  // from its columns, a bill with an old test_mode=1 run could take a
  // second live one, which is two sales invoices for one cost.
  const raceBill = await makeBill(abm.tenantId, {
    ref: 'TNB-RACE-0826', supplier: BOTH_SUPPLIER, total: 404.00
  });
  const raced = await Promise.allSettled([
    req('POST', '/api/recharge/runs', { cookie, body: { billId: raceBill } }),
    req('POST', '/api/recharge/runs', { cookie, body: { billId: raceBill } })
  ]);
  const won = raced.filter((r) => r.value && r.value.status === 201);
  check('two runs raced onto one bill produce exactly one',
    won.length === 1, raced.map((r) => r.value && r.value.status));
  const liveForBill = await db.getOne(
    "SELECT COUNT(*) AS n FROM recharge_runs WHERE bill_id = ? AND status <> 'cancelled'", [raceBill]);
  check('and the database holds one live run for that bill',
    Number(liveForBill.n) === 1, liveForBill);
  if (won.length) {
    const id = won[0].value.body.id;
    // Give it a failure, then cancel it: a cancelled run is settled, and a
    // red banner under a row nobody intends to post again reads as
    // something still wrong with the account.
    await db.execute("UPDATE recharge_runs SET post_error = 'Xero said no' WHERE id = ?", [id]);
    await req('POST', `/api/recharge/runs/${id}/cancel`, { cookie });
    const row = (await req('GET', '/api/recharge', { cookie })).body.runRows.find((r) => r.id === id);
    check('a cancelled run shows no error', row && !row.error, row && row.error);
    check('and is not flagged half-posted either', row && row.partial === false, row && row.partial);
    check('but still says why it was cancelled, quietly',
      row && /Xero said no/.test(row.cancelNote || ''), row && row.cancelNote);
  }

  // Its own bill, because a bill that already has a run is refused and the
  // check would skip without saying so.
  const plainBill = await makeBill(abm.tenantId, {
    ref: 'TNB-NOTEST-0826', supplier: BOTH_SUPPLIER, total: 555.00
  });
  const realRun2 = await req('POST', '/api/recharge/runs', { cookie, body: { billId: plainBill } });
  check('a second run can be drafted with testing mode off', realRun2.status === 201, realRun2.body);
  const plain = (await req('GET', '/api/recharge', { cookie })).body.runRows
    .find((r) => r.id === realRun2.body.id);
  check('and carries no label, because nothing about it was a test',
    plain && plain.madeInTest === false, plain && plain.madeInTest);
  await req('POST', `/api/recharge/runs/${realRun2.body.id}/cancel`, { cookie });

  console.log('\nThe view');
  const final = await req('GET', '/api/recharge', { cookie });
  check('stat cards are returned', final.body.rechargeStats.length === 4);
  check('a posted run still reads as posted',
    final.body.runRows.find((c) => c.id === runId).statusLabel === 'Posted to Xero');
  check('the stat cards count the documents that exist in Xero',
    final.body.rechargeStats[1].label === 'Xero invoices'
    && final.body.rechargeStats[2].label === 'Xero bills',
    final.body.rechargeStats.map((c) => c.label));
  check('both rule kinds get their own tab, in the order they are tried',
    final.body.rechargeTabs.map((t) => t.label).join(' | ')
      === 'Recharge runs | Address rules | Recharge rules', final.body.rechargeTabs);
  check('the condition vocabulary is offered to the dialog',
    final.body.conditionFields.some((f) => f.value === 'tracking')
    && final.body.conditionOperators.some((o) => o.value === 'starts_with'),
    { f: final.body.conditionFields.length, o: final.body.conditionOperators.length });
  check('the active-rules card says how many of the rules written are on',
    /^of \d+ rules? written$/.test(final.body.rechargeStats[3].sub), final.body.rechargeStats[3].sub);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
