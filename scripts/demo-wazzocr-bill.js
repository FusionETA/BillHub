// Stand in for WazzOCR on localhost, so the recharge half can be tested
// without it.
//
//   node scripts/demo-wazzocr-bill.js            one bill per enabled address rule
//   node scripts/demo-wazzocr-bill.js --rule 9   just that rule
//   node scripts/demo-wazzocr-bill.js --paid     create it already paid
//   node scripts/demo-wazzocr-bill.js --reset    take them away again
//
// WazzOCR's half is: read the premises off the paper, ask the register, and
// create the bill IN XERO, in the organisation the register names, under
// the contact it names. Bills Hub then syncs it back. This does the same.
//
// It has to be a real Xero bill. A row written straight into Bills Hub's
// own table looks payable on screen and then fails at the moment of
// payment with "Invoice could not be found", because Xero has never heard
// of it — paying a bill here means recording a payment against the invoice
// in Xero.
//
// Deliberately no premises address is stored, because production has none:
// the sync carries no premises, so the recharge matches on the contact.
// Storing one would exercise a path real bills never take.
//
// Leaves the bill UNPAID by default, because paying it in the Bills tab is
// the thing being tested: a recharge follows from paying here, and a bill
// settled any other way sets nothing going.
require('../lib/env');
const db = require('../db');
const model = require('../models/recharge');
const bills = require('../models/bills');
const recharge = require('../billhub/recharge');
const testMode = require('../lib/testMode');
const xero = require('../lib/xero');

const ACCOUNT_ID = Number(process.env.DEMO_ACCOUNT_ID || 1);
const TAG = 'WZDEMO';

// The Pay dialog only offers bank accounts in the paying organisation's own
// currency — Xero takes batch payments in the base currency alone — so a
// bill written in the wrong one is created fine and then cannot be paid,
// which is a confusing place to discover it. Ask the organisation.
async function currencyFor(tenantId) {
  const bank = await db.getOne(
    'SELECT currency_code FROM bank_accounts WHERE account_id = ? AND xero_tenant_id = ? AND currency_code IS NOT NULL LIMIT 1',
    [ACCOUNT_ID, tenantId]);
  if (bank?.currency_code) return bank.currency_code;
  const seen = await db.getOne(
    `SELECT currency_code FROM bills WHERE account_id = ? AND xero_tenant_id = ? AND currency_code IS NOT NULL
      GROUP BY currency_code ORDER BY COUNT(*) DESC LIMIT 1`, [ACCOUNT_ID, tenantId]);
  return seen?.currency_code || 'MYR';
}

// The contact the register names has to exist in the paying organisation's
// Xero before a bill can be raised against it.
async function findOrCreateContact(tenantId, name) {
  const where = encodeURIComponent(`Name=="${String(name).replace(/"/g, '')}"`);
  const found = await xero.api(ACCOUNT_ID, tenantId, `/Contacts?where=${where}`);
  const id = found?.Contacts?.[0]?.ContactID;
  if (id) return id;
  const created = await xero.api(ACCOUNT_ID, tenantId, '/Contacts', {
    method: 'POST', body: { Contacts: [{ Name: name }] }
  });
  const made = created?.Contacts?.[0]?.ContactID;
  if (!made) throw new Error(`Could not create the contact "${name}" in Xero.`);
  return made;
}

// contact_id is a Xero UUID. Derived from the name so the same contact keeps
// the same id across runs — the register's "N bills · N orgs" count reads
// these, and a fresh id each time would make one contact look like many.
function contactId(name) {
  const h = require('crypto').createHash('sha1').update(String(name)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const argv = process.argv.slice(2);
const only = argv.includes('--rule') ? Number(argv[argv.indexOf('--rule') + 1]) : null;
const paid = argv.includes('--paid');

// These are real Xero bills, so deleting the local row alone would leave
// them behind in the organisation — tidy on screen, untidy where it counts.
// A paid one cannot be voided without first removing its payment, which is
// not something a cleanup script should do quietly, so it says so instead.
async function reset() {
  const rows = await db.query(
    `SELECT id, xero_tenant_id, xero_invoice_id, reference, amount_paid
       FROM bills WHERE account_id = ? AND reference LIKE '${TAG}-%'`, [ACCOUNT_ID]);
  let voided = 0;
  const kept = [];
  for (const b of rows) {
    if (Number(b.amount_paid) > 0) { kept.push(b.reference); continue; }
    try {
      await xero.api(ACCOUNT_ID, b.xero_tenant_id, '/Invoices', {
        method: 'POST',
        body: { Invoices: [{ InvoiceID: b.xero_invoice_id, Status: 'VOIDED' }] }
      });
      voided += 1;
    } catch (e) {
      kept.push(`${b.reference} (${e.message})`);
    }
  }
  const res = await db.execute(
    `DELETE FROM bills WHERE account_id = ? AND reference LIKE '${TAG}-%'`, [ACCOUNT_ID]);
  console.log(`Removed ${res.affectedRows} demo bill(s); voided ${voided} in Xero.`);
  if (kept.length) {
    console.log('Still in Xero, because a paid bill cannot be voided until its payment is removed:');
    kept.forEach((k) => console.log(`  ${k}`));
  }
}

(async () => {
  if (argv.includes('--reset')) { await reset(); await db.close(); return; }

  let rules = (await model.listAddressRules(ACCOUNT_ID))
    .filter((r) => r.enabled && r.premises_address && r.payer_tenant_id);
  if (only) rules = rules.filter((r) => r.id === only);

  if (!rules.length) {
    console.log('\nNo enabled address rule to build a bill from.');
    console.log('Write one first on the Recharge tab → Address rules → New address rules.\n');
    process.exitCode = 1;
    await db.close();
    return;
  }

  // Paying one of these is a real payment. Bills Hub marks the bill paid in
  // Xero, and with auto-post on it then raises the invoice and the draft
  // bill in two organisations — on whatever grant this install is using,
  // which on a borrowed one is somebody's live Xero. Testing mode is the
  // switch that makes all of that local.
  if (!await testMode.isOn(ACCOUNT_ID)) {
    console.log('\n  ⚠  Testing mode is OFF.');
    console.log('     Paying one of these bills writes a payment into the connected Xero');
    console.log('     organisation, and auto-post then creates the recharge documents there');
    console.log('     too. Turn testing mode on from the Bank files tab first if you only');
    console.log('     want to watch the rules work.\n');
  }

  console.log(`\nStanding in for WazzOCR on ${rules.length} address rule(s).\n`);
  let n = 0;
  for (const r of rules) {
    n += 1;
    const ref = `${TAG}-${r.id}-${Date.now().toString().slice(-6)}`;
    const total = 1693.00 + n;
    const currency = await currencyFor(r.payer_tenant_id);

    // The contact the register names, in the paying organisation's Xero.
    const contactId = await findOrCreateContact(r.payer_tenant_id, r.contact_name);

    // Xero will not approve a bill whose lines have no account code, and an
    // unapproved bill cannot be paid.
    const chart = await recharge.chartOfAccounts(ACCOUNT_ID, r.payer_tenant_id);
    const expense = chart.find((a) => a.cls === 'EXPENSE') || chart[0];
    if (!expense) throw new Error(`No postable account in ${r.payer_code || r.payer_tenant_id}'s chart.`);

    // AUTHORISED, not DRAFT: a draft bill is not payable, and paying is the
    // whole point of this. No CurrencyCode, so Xero uses the organisation's
    // base currency and the Pay dialog can offer its bank accounts.
    const today = new Date().toISOString().slice(0, 10);
    const made = await xero.api(ACCOUNT_ID, r.payer_tenant_id, '/Invoices', {
      method: 'POST',
      body: { Invoices: [{
        Type: 'ACCPAY',
        Contact: { ContactID: contactId },
        Date: today,
        DueDate: today,
        Reference: ref,
        Status: 'AUTHORISED',
        LineAmountTypes: 'Exclusive',
        LineItems: [{
          Description: `Demo utility bill for ${r.premises_address}`,
          Quantity: 1,
          UnitAmount: total,
          AccountCode: expense.code
        }]
      }] }
    });
    const inv = made?.Invoices?.[0];
    if (!inv?.InvoiceID) throw new Error('Xero did not return an invoice id.');

    // The local row, carrying Xero's real id so a payment can be recorded
    // against it and so the next sync updates this row rather than adding a
    // second one.
    await db.execute(
      `INSERT INTO bills (account_id, xero_tenant_id, xero_invoice_id, invoice_number, reference,
         contact_id, contact_name, xero_status, bill_date, due_date, currency_code,
         total, amount_paid, amount_due, premises_source, marked_paid_at)
       VALUES (?,?,?,?,?,?,?,'AUTHORISED',?,?,?,?,0,?, NULL, ${paid ? 'NOW()' : 'NULL'})`,
      [ACCOUNT_ID, r.payer_tenant_id, inv.InvoiceID, inv.InvoiceNumber || `INV-${ref}`, ref,
       contactId, r.contact_name, today, today, inv.CurrencyCode || currency,
       total, total]
    );

    // What paying it will do, asked of the same decide() the Pay dialog
    // asks. assumePaid, because "not paid yet" is a true but useless answer
    // to the question being put here.
    const row = await db.getOne(
      'SELECT * FROM bills WHERE account_id = ? AND xero_invoice_id = ?', [ACCOUNT_ID, inv.InvoiceID]);
    const v = await recharge.decide(ACCOUNT_ID, row, { assumePaid: true, fetch: false });

    console.log(`  ${ref}   ${currency} ${total.toFixed(2)}   ${paid ? 'paid' : 'awaiting payment'}`);
    console.log(`    in        ${r.payer_code || r.payer_tenant_id}  (${r.payer_short || '—'})`);
    console.log(`    contact   ${r.contact_name}`);
    console.log(`    premises  ${r.premises_address}  (on the rule; the bill carries none, as in production)`);
    console.log(`    in Xero   ${inv.InvoiceNumber || inv.InvoiceID}`);
    console.log(v.outcome === 'recharge'
      ? `    ON PAYMENT → recharges to ${v.ownerCode} (${v.ownerShort}): invoice in the payer, draft bill there.`
      : `    ON PAYMENT → nothing. ${v.reason}`);
    console.log('');
  }

  console.log(paid
    ? 'Already paid, so the Recharge tab should be settling these now.'
    : 'Open the Bills tab, pay one, and watch the Recharge tab.');
  console.log(`Clean up with:  node scripts/demo-wazzocr-bill.js --reset\n`);
  await db.close();
})().catch(async (e) => { console.error('\nFAILED:', e.message, '\n'); await db.close(); process.exit(1); });
