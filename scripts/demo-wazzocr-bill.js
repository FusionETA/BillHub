// Stand in for WazzOCR on localhost, so the recharge half can be tested
// without it.
//
//   node scripts/demo-wazzocr-bill.js            one bill per enabled address rule
//   node scripts/demo-wazzocr-bill.js --rule 9   just that rule
//   node scripts/demo-wazzocr-bill.js --paid     create it already paid
//   node scripts/demo-wazzocr-bill.js --reset    take them away again
//
// WazzOCR's half is: read the premises off the paper, ask the register, and
// create the bill in the organisation the register names, under the contact
// it names. That is all it leaves behind in Bills Hub — a bill in the payer
// org, on that contact, carrying the address it read. This writes exactly
// that, so the other half can be exercised by paying it.
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

async function reset() {
  const res = await db.execute(
    `DELETE FROM bills WHERE account_id = ? AND reference LIKE '${TAG}-%'`, [ACCOUNT_ID]);
  console.log(`Removed ${res.affectedRows} demo bill(s).`);
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
    // A real UUID. Xero validates InvoiceID as a System.Guid, so a
    // memorable-but-invalid id like "wzdemo00-…" is accepted by MySQL and
    // then rejected at the point of payment, which is a long way from here.
    const xid = require('crypto').randomUUID();
    const total = 1693.00 + n;
    const currency = await currencyFor(r.payer_tenant_id);
    await db.execute(
      `INSERT INTO bills (account_id, xero_tenant_id, xero_invoice_id, invoice_number, reference,
         contact_id, contact_name, xero_status, bill_date, due_date, fully_paid_on, currency_code,
         total, amount_paid, amount_due, premises_address, premises_source, marked_paid_at)
       VALUES (?,?,?,?,?,?,?,?,CURDATE(),CURDATE(),?,?, ?,?,?,?, 'ocr', ${paid ? 'NOW()' : 'NULL'})`,
      [ACCOUNT_ID, r.payer_tenant_id, xid, `INV-${ref}`, ref,
       contactId(r.contact_name), r.contact_name, paid ? 'PAID' : 'AUTHORISED',
       paid ? new Date().toISOString().slice(0, 10) : null, currency,
       total, paid ? total : 0, paid ? 0 : total, r.premises_address]
    );

    // What paying it will do, asked of the same code the Pay dialog asks.
    // assumePaid, because "not paid yet" is a true but useless answer to
    // the question being put here.
    const row = await db.getOne(
      'SELECT * FROM bills WHERE account_id = ? AND reference = ?', [ACCOUNT_ID, ref]);
    const v = await recharge.decide(ACCOUNT_ID, row, { assumePaid: true, fetch: false });

    console.log(`  ${ref}   ${currency} ${total.toFixed(2)}   ${paid ? 'paid' : 'awaiting payment'}`);
    console.log(`    in        ${r.payer_code || r.payer_tenant_id}  (${r.payer_short || '—'})`);
    console.log(`    contact   ${r.contact_name}`);
    console.log(`    premises  ${r.premises_address}`);
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
