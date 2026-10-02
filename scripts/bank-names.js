// Every distinct "Bank account name" on the payees, and whether Bills Hub can
// turn it into a Hong Leong bank code.
//
//   node scripts/bank-names.js
//   node scripts/bank-names.js --unknown      only the ones that fail
//
// Read-only. Touches no Xero API and changes nothing.
//
// The point is to get the unknowns as one list rather than one dialog at a
// time. Ayu Borneo write abbreviations — PBB, ALB — where the lookup holds the
// bank names Hong Leong publishes, so each unrecognised value is a line the
// bank will reject for a missing beneficiary bank code.
//
// What it will NOT do is guess. PBB is obviously Public Bank, but abbreviations
// are not standardised and the cost of being wrong is a payment landing at the
// wrong bank. The output is for someone who knows the suppliers to confirm.
require('../lib/env');
const db = require('../db');
const banks = require('../lib/malaysianBanks');

const ACCOUNT = Number(process.env.DEFAULT_ACCOUNT_ID) || 1;
const onlyUnknown = process.argv.includes('--unknown');

(async () => {
  const rows = await db.query(
    `SELECT p.bank_account_name AS name, p.contact_name, e.code AS entity
       FROM payees p
       LEFT JOIN entities e ON e.account_id = p.account_id AND e.xero_tenant_id = p.xero_tenant_id
      WHERE p.account_id = ? AND p.bank_account_name IS NOT NULL AND p.bank_account_name <> ''
      ORDER BY p.bank_account_name, p.contact_name`,
    [ACCOUNT]
  );

  if (!rows.length) {
    console.log('\nNo payee has a bank account name yet. Run "Sync accounts & payees" first.\n');
    return;
  }

  const groups = new Map();
  for (const r of rows) {
    const key = String(r.name).trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const known = [];
  const biller = [];
  const unknown = [];
  for (const [name, payees] of groups) {
    const code = banks.bankCode(name, 'duitnow');
    if (banks.isBillerCode(name)) biller.push({ name, payees });
    else if (code) known.push({ name, code, payees });
    else unknown.push({ name, payees });
  }

  const line = (g, extra = '') =>
    `  ${String(g.name).slice(0, 34).padEnd(36)}${extra.padEnd(8)}${String(g.payees.length).padStart(4)} payee(s)   e.g. ${g.payees[0].contact_name.slice(0, 32)}`;

  if (!onlyUnknown) {
    console.log(`\nJomPay biller codes — ${biller.length} distinct, ${biller.reduce((n, g) => n + g.payees.length, 0)} payee(s)`);
    for (const g of biller.sort((a, b) => b.payees.length - a.payees.length)) console.log(line(g));

    console.log(`\nBanks Hong Leong lists — ${known.length} distinct, ${known.reduce((n, g) => n + g.payees.length, 0)} payee(s)`);
    for (const g of known.sort((a, b) => b.payees.length - a.payees.length)) console.log(line(g, g.code));
  }

  console.log(`\nNOT RECOGNISED — ${unknown.length} distinct, ${unknown.reduce((n, g) => n + g.payees.length, 0)} payee(s)`);
  if (!unknown.length) console.log('  (none — every payee resolves to a bank code or a biller code)');
  for (const g of unknown.sort((a, b) => b.payees.length - a.payees.length)) {
    console.log(line(g));
    if (g.payees.length > 1) {
      for (const p of g.payees.slice(1, 4)) console.log(`${' '.repeat(54)}${p.contact_name.slice(0, 32)}`);
      if (g.payees.length > 4) console.log(`${' '.repeat(54)}… and ${g.payees.length - 4} more`);
    }
  }

  if (unknown.length) {
    console.log(`
Each of those leaves the beneficiary bank code blank, and the bank rejects the
line. Two ways to clear them:

  • Put the full bank name in the contact's Financial details in Xero
    ("Public Bank Berhad" rather than "PBB"), then run Sync accounts & payees.
  • Or send this list back and the abbreviations can be added to the lookup
    once someone has confirmed what each one means.
`);
  }

  const total = rows.length;
  const ok = total - unknown.reduce((n, g) => n + g.payees.length, 0);
  console.log(`${ok} of ${total} payee(s) with a bank account name would produce a usable line.\n`);
  await db.close();
})().catch(async (e) => {
  console.error('\nFAILED:', e.message, '\n');
  try { await db.close(); } catch { /* already closed */ }
  process.exit(1);
});
