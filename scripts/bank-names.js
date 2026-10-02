// Every distinct "Bank account name" on the payees, and whether Bills Hub can
// turn it into a Hong Leong bank code.
//
//   node scripts/bank-names.js
//   node scripts/bank-names.js --unknown      only the ones that fail
//   node scripts/bank-names.js --panel        and their whole Financial details
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
    `SELECT p.bank_account_name AS name, p.contact_name, p.account_number, p.details,
            p.payee_code, p.bank_name, e.code AS entity
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

  // The flat list was a pile of 46 values with nothing to do about them. The
  // same rows sorted by WHAT IS WRONG is a worklist, and each kind needs a
  // different fix — one is a field swap, one is a question for the client, one
  // cannot be paid by file at all.
  const squash = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const kinds = new Map();
  const put = (kind, payee, note) => {
    if (!kinds.has(kind)) kinds.set(kind, []);
    kinds.get(kind).push({ ...payee, note });
  };

  for (const g of unknown) {
    for (const p of g.payees) {
      const name = String(p.name || '').trim();
      const holder = squash(p.contact_name);
      const value = squash(name);

      if (!p.account_number) {
        put('No account number at all — nothing can pay these by file', p, '');
      } else if (banks.isBillerCode(String(p.details || '').trim())) {
        // The convention is biller code in "Bank account name", premises in
        // "Details". These two have it the other way round, which is a swap
        // rather than a mystery.
        put('Biller code is in Details, premises in Bank account name — the two are swapped', p,
            `biller ${String(p.details).trim()}`);
      } else if (name.includes('/')) {
        put('Two banks in one field — somebody has to choose which gets paid', p, '');
      } else if (value && holder && (value === holder || holder.startsWith(value) || value.startsWith(holder))) {
        put('The account holder\'s name, so no bank is recorded anywhere', p, '');
      } else if (/^[A-Z0-9]{2,9}$/.test(name.toUpperCase().replace(/\s/g, '')) && !/\s/.test(name)) {
        put('Looks like a bank abbreviation — needs confirming before it can be used', p, '');
      } else {
        put('Something else — neither a bank nor a biller code', p, '');
      }
    }
  }

  const totalUnknown = unknown.reduce((n, g) => n + g.payees.length, 0);
  console.log(`\nNOT USABLE — ${totalUnknown} payee(s), by what is wrong\n`);
  if (!totalUnknown) console.log('  (none — every payee resolves to a bank code or a biller code)');

  for (const [kind, list] of [...kinds.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${kind} — ${list.length}`);
    const show = process.argv.includes('--panel') ? list : list.slice(0, 6);
    for (const p of show) {
      console.log('    ' + String(p.contact_name || '').slice(0, 32).padEnd(34)
        + String(p.name || '').slice(0, 24).padEnd(26)
        + String(p.account_number || '—').slice(0, 17).padEnd(19)
        + (p.note || (p.details ? 'details: ' + String(p.details).slice(0, 18) : '')));
    }
    if (!process.argv.includes('--panel') && list.length > show.length) {
      console.log(`    … and ${list.length - show.length} more (--panel for all)`);
    }
    console.log('');
  }

  const swapped = (kinds.get('Biller code is in Details, premises in Bank account name — the two are swapped') || []).length;
  const abbrev = (kinds.get('Looks like a bank abbreviation — needs confirming before it can be used') || []).length;
  if (swapped || abbrev) {
    console.log('What to do with each:\n');
    if (swapped) console.log(`  • ${swapped} swapped: in Xero, move the biller code up into "Bank account name"\n    and the premises down into "Details". Then Sync accounts & payees.`);
    const distinctAbbrev = new Set((kinds.get('Looks like a bank abbreviation — needs confirming before it can be used') || []).map((p) => String(p.name).trim().toUpperCase())).size;
    if (abbrev) console.log(`  • ${distinctAbbrev} distinct abbreviation(s) across ${abbrev} payee(s): confirm what each means.`
      + `\n    One answer fixes every payee using it, so this is a short list, not a long one.\n    They are NOT guessed — "AMB" is itself a published code meaning Alliance\n    Investment Bank, so assuming it means AmBank would pay the wrong bank.`);
    console.log('');
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
