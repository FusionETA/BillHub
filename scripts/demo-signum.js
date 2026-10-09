// Three more recharge-ready bills in the live demo pair, for showing the
// Recharge tab to somebody.
//
//   node scripts/demo-signum.js            create them
//   node scripts/demo-signum.js --list     show what is there already
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
    const existing = await db.getOne(
      `SELECT id FROM bills WHERE account_id = ? AND xero_tenant_id = ? AND reference = ?`,
      [ACCOUNT_ID, tenant, spec.reference]);
    if (existing) { console.log(`\n  ${spec.reference} — already there, left alone`); continue; }

    const made = await xero.api(ACCOUNT_ID, tenant, '/Invoices', {
      method: 'POST',
      body: { Invoices: [{
        Type: 'ACCPAY',
        Contact: { ContactID: byName.get(spec.contact) },
        Date: today(),
        DueDate: plus(14),
        Reference: spec.reference,
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

    console.log(`\n  ${spec.reference}  ${payer.base_currency} ${spec.amount.toFixed(2)}  → ${spec.shows}`);
    console.log(`    ${inv.InvoiceNumber || inv.InvoiceID} awaiting payment in ${payer.code}`);
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
