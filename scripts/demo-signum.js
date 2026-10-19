// Three more recharge-ready bills in the live demo pair, for showing the
// Recharge tab to somebody.
//
//   node scripts/demo-signum.js            create them
//   node scripts/demo-signum.js --tag B    another set, so a run can be
//                                          repeated without clashing
//   node scripts/demo-signum.js --list     show what is there already
//   node scripts/demo-signum.js --files    hang a PDF and an image on each,
//                                          so the recharge has something to
//                                          carry into the other organisation
//
// Unlike scripts/demo-recharge.js, which seeds mock organisations straight
// into the database, this writes REAL bills into the real Xero organisation
// that pays them, pays them there, and syncs them back. That is the only way
// to demonstrate a recharge end to end, because posting one writes a document
// into two organisations and both have to exist.
//
// The pair:
//   payer  Demo Company (Global)   raises the invoice, holds the bills
//   owner  Signum DEMO             receives the draft bill
//
// Two bills land on the TNB contact, whose Xero BILLING ADDRESS is the Signum
// Tower address, so the ADDRESS rule claims them. One lands on the EPF
// contact, which no address can identify, so the RECHARGE rule claims it on
// the supplier instead. Between them they show both halves of the tab.
//
// They are left AWAITING PAYMENT on purpose. A recharge is a consequence of
// marking a bill paid on the Bills tab — see isPaid() in billhub/recharge.js
// — so a bill that arrives already paid skips the step that causes
// everything else, and the demo would start at the end. Pay them from the
// Bills tab and watch them turn up under Recharge.
//
// Testing mode has to be OFF: it blocks every write to Xero, which is the
// whole point of it. The script says so rather than failing deep in a call.
require('../lib/env');
const db = require('../db');
const xero = require('../lib/xero');
const testMode = require('../lib/testMode');
const sync = require('../billhub/sync');

const ACCOUNT_ID = Number(process.env.DEMO_ACCOUNT_ID || 1);
const PAYER_CODE = process.env.DEMO_PAYER || 'DCGLOBAL2';

// A suffix on every reference, so the same three bills can be made again for
// a second run-through without the "already there" check skipping them.
const tagIdx = process.argv.indexOf('--tag');
const TAG = tagIdx > -1 ? String(process.argv[tagIdx + 1] || '').trim() : '';
const ref = (base) => (TAG ? `${base}-${TAG}` : base);

// Each bill names the contact it belongs to and the rule it is there to
// demonstrate, so a run that produces the wrong count is diagnosable.
const BILLS = [
  { contact: 'Tenaga Nasional Berhad - Signum Tower', shows: 'address rule',
    reference: 'TNB-SIGNUM-1226', amount: 2104.75,
    description: 'Electricity — Level 12, Signum Tower (Dec 2026)' },
  { contact: 'Tenaga Nasional Berhad - Signum Tower', shows: 'address rule',
    reference: 'TNB-SIGNUM-0127', amount: 1766.20,
    description: 'Electricity — Level 12, Signum Tower (Jan 2027)' },
  { contact: 'KWSP (EPF) Signum', shows: 'recharge rule',
    reference: 'EPF-SIGNUM-1226', amount: 3480.00,
    description: 'EPF employer contribution — Signum staff (Dec 2026)' }
];

// --files hangs a readable PDF and a small image on each bill it creates, so
// a recharge can be watched carrying the supplier's own paperwork into the
// other organisation — alongside the sales invoice PDF the recharge renders
// for itself. Without them the bill has nothing to copy and only half the
// behaviour is visible.
const WITH_FILES = process.argv.includes('--files');

// A one-page PDF, assembled by hand so the script needs no PDF library. The
// xref offsets have to be the real byte positions or a reader rejects the
// file, so the objects are measured as they are concatenated rather than
// guessed at.
function billPdf(lines) {
  const esc = (t) => String(t).replace(/([\\()])/g, '\\$1');
  const text = 'BT /F1 11 Tf 1.3 Tf\n'.replace('1.3 Tf', '') + lines
    .map((l, i) => `BT /F1 ${i === 0 ? 16 : 11} Tf 60 ${790 - i * 26} Td (${esc(l)}) Tj ET`)
    .join('\n');
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    `<</Length ${Buffer.byteLength(text)}>>\nstream\n${text}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// A real, if tiny, PNG. Fixed bytes rather than generated, because a valid
// PNG needs CRCs and the point here is only that a second file of a second
// type makes the trip.
const METER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

// Best effort, and loud about it: a demo bill without its attachment is still
// a usable demo bill, but silently producing one would waste the run.
async function attach(tenant, invoiceId, name, buffer, contentType) {
  try {
    await xero.api(ACCOUNT_ID, tenant, `/Invoices/${invoiceId}/Attachments/${encodeURIComponent(name)}`, {
      method: 'PUT', body: buffer, headers: { 'Content-Type': contentType }
    });
    console.log(`    + ${name} (${buffer.length} bytes)`);
  } catch (e) {
    console.log(`    ! ${name} not attached: ${e.message}`);
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const plus = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

async function main() {
  const list = process.argv.includes('--list');

  const payer = await db.getOne(
    `SELECT code, short_name, xero_tenant_id, base_currency FROM entities
      WHERE account_id = ? AND code = ?`, [ACCOUNT_ID, PAYER_CODE]);
  if (!payer?.xero_tenant_id) {
    throw new Error(`No connected entity ${PAYER_CODE}. Connect it, or set DEMO_PAYER.`);
  }
  const tenant = payer.xero_tenant_id;
  console.log(`\nPayer: ${payer.short_name} (${payer.code}), ${payer.base_currency}`);

  if (list) {
    const rows = await db.query(
      `SELECT invoice_number, reference, contact_name, total, currency_code,
              xero_status, fully_paid_on
         FROM bills WHERE account_id = ? AND xero_tenant_id = ?
          AND (reference LIKE 'TNB-SIGNUM-%' OR reference LIKE 'EPF-SIGNUM-%')
        ORDER BY id`, [ACCOUNT_ID, tenant]);
    console.table(rows);
    return;
  }

  if (await testMode.isOn(ACCOUNT_ID)) {
    console.log('\nTesting mode is ON, so nothing can be written to Xero.');
    console.log('Turn it off from the Bank files tab, then run this again.\n');
    process.exitCode = 1;
    return;
  }

  // Resolve the contacts by name rather than hardcoding ids, so the script
  // survives the demo organisation being rebuilt.
  const wanted = [...new Set(BILLS.map((b) => b.contact))];
  const byName = new Map();
  for (const name of wanted) {
    const res = await xero.api(ACCOUNT_ID, tenant,
      `/Contacts?where=${encodeURIComponent(`Name="${name.replace(/"/g, '\\"')}"`)}`);
    const c = res?.Contacts?.[0];
    if (!c) throw new Error(`Contact not found in ${payer.code}: "${name}"`);
    byName.set(name, c.ContactID);
    const addr = (c.Addresses || []).find((a) => a.AddressType === 'POBOX');
    const printed = [addr?.AddressLine1, addr?.City, addr?.PostalCode].filter(Boolean).join(', ');
    console.log(`  ${name}`);
    console.log(`    billing address: ${printed || '(none — this one needs a recharge rule)'}`);
  }

  // An expense account to post to. Discovered
  // rather than assumed: a demo organisation's chart of accounts is whatever
  // somebody last left it as.
  const accounts = await xero.api(ACCOUNT_ID, tenant, '/Accounts');
  const all = accounts?.Accounts || [];
  const expense = all.find((a) => a.Type === 'OVERHEADS' && a.Status === 'ACTIVE')
               || all.find((a) => a.Class === 'EXPENSE' && a.Status === 'ACTIVE');
  if (!expense) throw new Error('No active expense account in the payer organisation.');
  console.log(`\n  posting to ${expense.Code} ${expense.Name}`);

  for (const spec of BILLS) {
    const reference = ref(spec.reference);
    const existing = await db.getOne(
      `SELECT id FROM bills WHERE account_id = ? AND xero_tenant_id = ? AND reference = ?`,
      [ACCOUNT_ID, tenant, reference]);
    if (existing) { console.log(`\n  ${reference} — already there, left alone`); continue; }

    const made = await xero.api(ACCOUNT_ID, tenant, '/Invoices', {
      method: 'POST',
      body: { Invoices: [{
        Type: 'ACCPAY',
        Contact: { ContactID: byName.get(spec.contact) },
        Date: today(),
        DueDate: plus(14),
        Reference: reference,
        Status: 'AUTHORISED',
        CurrencyCode: payer.base_currency,
        LineAmountTypes: 'Exclusive',
        LineItems: [{
          Description: spec.description, Quantity: 1,
          UnitAmount: spec.amount, AccountCode: expense.Code, TaxType: 'NONE'
        }]
      }] }
    });
    const inv = made?.Invoices?.[0];
    if (!inv?.InvoiceID) throw new Error(`Xero did not return an id for ${spec.reference}`);

    console.log(`\n  ${reference}  ${payer.base_currency} ${spec.amount.toFixed(2)}  → ${spec.shows}`);
    console.log(`    ${inv.InvoiceNumber || inv.InvoiceID} awaiting payment in ${payer.code}`);

    if (WITH_FILES) {
      await attach(tenant, inv.InvoiceID, `${reference}.pdf`, billPdf([
        spec.contact,
        '',
        `Reference      ${reference}`,
        `Premises       Level 12, Signum Tower, Jalan Kia Peng`,
        `               50450 Kuala Lumpur`,
        `Billed to      ${payer.short_name}`,
        `Period         ${today()}`,
        '',
        `Amount due     ${payer.base_currency} ${spec.amount.toFixed(2)}`,
        '',
        'Demo document. Created by scripts/demo-signum.js --files',
        'so a recharge can be watched carrying it across.'
      ]), 'application/pdf');
      await attach(tenant, inv.InvoiceID, 'meter reading.png', METER_PNG, 'image/png');
    }
  }

  console.log('\nSyncing them back into Bills Hub…');
  const res = await sync.syncAccount(ACCOUNT_ID, { tenantIds: [tenant] });
  console.log(`  ${res.upserted} bill(s) read back.`);
  for (const r of res.results.filter((x) => !x.ok)) console.log(`  ! ${r.error}`);

  console.log('\nThey are on the Bills tab, awaiting payment. Mark one paid there and');
  console.log('it appears under Recharge as a suggestion — that is the whole trigger.\n');
}

main()
  .then(() => db.close())
  .catch(async (e) => { console.error('\nFAILED:', e.message, '\n'); await db.close(); process.exit(1); });
