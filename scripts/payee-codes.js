// The supplier abbreviations that go in a bank file's narrative — the "TNB" in
// "BM 69 TNB 0826" — and which payees still have none.
//
//   node scripts/payee-codes.js
//
// Read-only. Makes no Xero call and changes nothing.
//
// The abbreviations themselves live in lib/payeeCodes.js, as data. Adding one
// is a line there and it applies to that supplier in every organisation at
// once, including contacts nobody has created yet. This script exists to say
// which ones are still worth asking about, grouped by supplier rather than by
// payee row, since one answer covers all of them.
require('../lib/env');
const db = require('../db');
const banks = require('../lib/malaysianBanks');
const payeeCodes = require('../lib/payeeCodes');

const ACCOUNT = Number(process.env.DEFAULT_ACCOUNT_ID) || 1;

// "Tenaga Nasional Berhad - MA 75-02" and "Tenaga Nasional Berhad - Hostel"
// are one supplier. The premises is tacked on after a dash or the company
// suffix, so cut there and group on what is left.
function supplier(contactName) {
  return String(contactName || '')
    .split(/\s[-–]\s|(?<=Sdn\.?\s?Bhd\.?|Berhad|Bhd\.?)\s*[-–]?\s*/i)[0]
    .replace(/\s+/g, ' ')
    .trim() || String(contactName || '').trim();
}

(async () => {
  const rows = await db.query(
    `SELECT p.contact_name, p.bank_account_name, p.details, p.payee_code,
            COUNT(*) AS n
       FROM payees p
      WHERE p.account_id = ?
      GROUP BY p.contact_name, p.bank_account_name, p.details, p.payee_code`,
    [ACCOUNT]
  );
  if (!rows.length) { console.log('\nNo payees yet. Run "Sync accounts & payees" first.\n'); return; }

  console.log(`\nAbbreviations defined in lib/payeeCodes.js — ${payeeCodes.CODES.length}\n`);
  for (const c of payeeCodes.CODES) console.log(`  ${c.code.padEnd(6)}${c.match}`);

  // A utility is a payee that routes down JomPay — a biller code in either of
  // the two fields it might be sitting in while the Xero data is being tidied.
  const isUtility = (r) =>
    banks.isBillerCode(String(r.bank_account_name || '').trim())
    || banks.isBillerCode(String(r.details || '').trim());

  const groups = new Map();
  for (const r of rows) {
    const key = supplier(r.contact_name);
    if (!groups.has(key)) groups.set(key, { payees: 0, utility: false, code: null });
    const g = groups.get(key);
    g.payees += Number(r.n);
    if (isUtility(r)) g.utility = true;
    g.code = g.code || r.payee_code || payeeCodes.codeFor(r.contact_name);
  }

  const missing = [...groups.entries()]
    .filter(([, g]) => g.utility && !g.code)
    .sort((a, b) => b[1].payees - a[1].payees);
  const covered = [...groups.entries()].filter(([, g]) => g.utility && g.code);

  console.log(`\nUtilities with an abbreviation — ${covered.length}\n`);
  for (const [name, g] of covered.sort((a, b) => b[1].payees - a[1].payees)) {
    console.log(`  ${String(g.code).padEnd(6)}${String(name).slice(0, 44).padEnd(46)}${g.payees} payee(s)`);
  }

  console.log(`\nUtilities with NO abbreviation — ${missing.length}\n`);
  if (!missing.length) console.log('  (none)');
  for (const [name, g] of missing) {
    console.log(`  ${'—'.padEnd(6)}${String(name).slice(0, 44).padEnd(46)}${g.payees} payee(s)`);
  }

  if (missing.length) {
    console.log(`
Those leave the abbreviation out of the narrative — "MA 49 0926" rather than
"MA 49 ID 0926". Shorter and still correct, so nothing is broken by it.

Ask what each one is called, then add a line to lib/payeeCodes.js:

  { match: '${supplier(missing[0][0]).toUpperCase().slice(0, 20)}', code: 'XXX' },
`);
  }
  await db.close();
})().catch(async (e) => {
  console.error('\nFAILED:', e.message, '\n');
  try { await db.close(); } catch { /* already closed */ }
  process.exit(1);
});
