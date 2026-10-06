// Which bills would produce a clean bank file today.
//
//   node scripts/ready-to-pay.js                 organisations, best first
//   node scripts/ready-to-pay.js --entity ABPJ   the bills in one of them
//   node scripts/ready-to-pay.js --bank CIMB     only organisations paying from CIMB
//   node scripts/ready-to-pay.js --entity X --from CIMB   as if paying from that account
//
// Read-only. Makes no Xero call and changes nothing.
//
// With most payees still missing a usable bank account name, "pick some bills
// and try it" means picking badly and reading a wall of warnings. This runs
// the same rail and bank-code rules the renderer does, per bill, so the answer
// to "which ones can I test with" is a list rather than a guess.
//
// A batch is paid from one bank account and a bank account belongs to one
// organisation, so the unit here is the organisation. The ones worth testing
// have clean bills on BOTH rails — that is what produces two files from one
// selection.
require('../lib/env');
const db = require('../db');
const banks = require('../lib/malaysianBanks');

const ACCOUNT = Number(process.env.DEFAULT_ACCOUNT_ID) || 1;
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };

// The renderer's rules, not an approximation of them.
// `scheme` is the paying bank's, not a default. CIMB wants BNM's two-digit
// code and lists 33 IBG participants; Hong Leong wants its own four-character
// one and lists 113. The same payee can be payable from one bank and not the
// other, so assessing everything against Hong Leong quietly overstated what a
// CIMB organisation could pay.
function assess(row, scheme, paysBiller = true) {
  const bankish = row.bank_account_name || row.bank_name || '';
  if (banks.isBillerCode(String(bankish).trim())) {
    // Ayu Borneo pay every JomPay bill from Hong Leong, so a utility in a
    // CIMB organisation is not ready — it is ready from a different account.
    if (!paysBiller) {
      return { rail: 'JomPay', ok: false, why: 'JomPay is not paid from this account — use the Hong Leong one' };
    }
    return row.account_number
      ? { rail: 'JomPay', ok: true, why: 'biller ' + String(bankish).trim() }
      : { rail: 'JomPay', ok: false, why: 'no account number for Ref-1' };
  }
  const code = banks.bankCode(row.bank_name, scheme) || banks.bankCode(bankish, scheme);
  if (!row.account_number) return { rail: 'Transfer', ok: false, why: 'no account number' };
  if (!code) {
    const elsewhere = scheme === 'bnm' && banks.bankCode(bankish, 'duitnow');
    return { rail: 'Transfer', ok: false,
      why: `"${String(bankish).slice(0, 22) || '—'}" is not a bank`
        + (elsewhere ? ' CIMB lists (Hong Leong does)' : '') };
  }
  return { rail: 'Transfer', ok: true, why: code };
}

(async () => {
  const rows = await db.query(
    `SELECT b.id, b.contact_name, b.reference, b.amount_due, b.xero_tenant_id,
            e.code AS entity, e.short_name AS entity_name,
            p.bank_account_name, p.bank_name, p.account_number, p.details
       FROM bills b
       LEFT JOIN entities e ON e.account_id = b.account_id AND e.xero_tenant_id = b.xero_tenant_id
       LEFT JOIN payees p ON p.account_id = b.account_id AND p.xero_tenant_id = b.xero_tenant_id
                          AND p.contact_name = b.contact_name
      WHERE b.account_id = ? AND b.xero_status = 'AUTHORISED' AND b.amount_due > 0
      ORDER BY e.code, b.contact_name`,
    [ACCOUNT]
  );
  if (!rows.length) { console.log('\nNo bills are awaiting payment.\n'); return; }

  // Which bank an organisation pays from, and therefore which files it
  // produces. The layout follows the paying account, so this is the only
  // thing that decides whether a run comes out as ConnectFirst or
  // BizConverter — and an organisation can have accounts at both.
  const accounts = await db.query(
    `SELECT xero_tenant_id, name, bank_name, is_default, format_key
       , biller_format_key
       FROM bank_accounts WHERE account_id = ? AND enabled = 1
      ORDER BY is_default DESC, name`,
    [ACCOUNT]
  );
  const banksFor = new Map();
  for (const a of accounts) {
    if (!banksFor.has(a.xero_tenant_id)) banksFor.set(a.xero_tenant_id, []);
    banksFor.get(a.xero_tenant_id).push(a);
  }
  const bankOf = (a) => {
    const name = `${a.bank_name || ''} ${a.name || ''}`;
    if (banks.bnmCode(a.bank_name) === '35' || /\bCIMB\b/i.test(name)) return 'CIMB';
    if (banks.bankCode(a.bank_name, 'duitnow') === 'HLBB' || /HONG\s*LEONG/i.test(name)) return 'Hong Leong';
    return a.bank_name || '(no bank set)';
  };

  // Which code table each organisation's bills are judged against, decided by
  // the account its dialog preselects.
  const schemeFor = new Map();
  const billerFor = new Map();
  for (const [tenantId, accts] of banksFor) {
    const chosen = accts.find((a) => a.is_default) || accts[0];
    const isCimb = chosen && bankOf(chosen) === 'CIMB';
    schemeFor.set(tenantId, isCimb ? 'bnm' : 'duitnow');
    // A JomPay bill is payable here only if some account in the organisation
    // actually pays JomPay, which a CIMB-only organisation does not.
    billerFor.set(tenantId, accts.some((a) => a.biller_format_key || bankOf(a) !== 'CIMB'));
  }

  const orgs = new Map();
  for (const r of rows) {
    const key = r.entity || r.xero_tenant_id;
    if (!orgs.has(key)) orgs.set(key, { name: r.entity_name || key, tenantId: r.xero_tenant_id, bills: [] });
    orgs.get(key).bills.push({ ...r, ...assess(r,
      schemeFor.get(r.xero_tenant_id) || 'duitnow',
      billerFor.get(r.xero_tenant_id) !== false) });
  }

  const want = (arg('--entity') || '').trim().toUpperCase();
  if (want) {
    const org = orgs.get(want);
    if (!org) { console.log(`\nNo bills awaiting payment in "${want}".\n`); return; }
    // An organisation banking at two banks has two answers, and the dropdown
    // picks which. Without this the report assesses against whichever account
    // happens to be preselected, while you are about to choose the other.
    const accts0 = banksFor.get(org.tenantId) || [];
    const from = (arg('--from') || '').trim().toLowerCase();
    const chosenAcct = from
      ? accts0.find((a) => `${a.name} ${a.bank_name || ''}`.toLowerCase().includes(from))
      : (accts0.find((a) => a.is_default) || accts0[0]);
    if (from && !chosenAcct) {
      console.log(`\nNo paying account in ${want} matches "${arg('--from')}".`);
      console.log('  ' + accts0.map((a) => a.name).join('\n  ') + '\n');
      await db.close();
      return;
    }
    const scheme = chosenAcct && bankOf(chosenAcct) === 'CIMB' ? 'bnm' : 'duitnow';
    const paysBiller = !chosenAcct || Boolean(chosenAcct.biller_format_key) || bankOf(chosenAcct) !== 'CIMB';
    org.bills = org.bills.map((b) => ({ ...b, ...assess(b, scheme, paysBiller) }));
    console.log(`\n${want} — ${org.name}`);
    console.log(`  paying from ${chosenAcct ? chosenAcct.name : '(no account)'}, `
      + `judged against ${scheme === 'bnm' ? "CIMB's BNM codes" : "Hong Leong's codes"}`
      + (from ? '' : ' — the account its dialog preselects') + '\n');
    console.log('  ' + 'OK'.padEnd(4) + 'RAIL'.padEnd(10) + 'PAYEE'.padEnd(36) + 'AMOUNT'.padStart(11) + '   WHY');
    for (const b of org.bills.sort((x, y) => (y.ok - x.ok) || x.rail.localeCompare(y.rail))) {
      console.log('  ' + (b.ok ? 'yes ' : 'no  ') + b.rail.padEnd(10)
        + String(b.contact_name).slice(0, 34).padEnd(36)
        + Number(b.amount_due).toFixed(2).padStart(11) + '   ' + b.why);
    }
    const ok = org.bills.filter((b) => b.ok);
    // Which account to choose in the dialog, and therefore which files come
    // out. An organisation with accounts at two banks produces different
    // files depending on this one dropdown.
    const accts = banksFor.get(org.tenantId) || [];
    if (accts.length) {
      console.log('\n  Paid from:');
      for (const a of accts) {
        const b = bankOf(a);
        const files = b === 'CIMB'
          ? 'BizConverter bulk sheet (suppliers only, no JomPay)'
          : b === 'Hong Leong' ? 'ConnectFirst + JomPay workbooks'
          : 'ConnectFirst + JomPay workbooks (no bank set, so the default)';
        console.log('    ' + (a.is_default ? '* ' : '  ') + String(a.name).slice(0, 34).padEnd(36)
          + String(b).padEnd(14) + files);
      }
      if (accts.length > 1) console.log('    * is what the dialog preselects.');
    } else {
      console.log('\n  No paying account for this organisation — run Sync accounts & payees.');
    }

    // Two accounts can mean two runs. Saying "tick the nine" when three of
    // them cannot go through the preselected account sends someone into a
    // dialog that will refuse them.
    const t = ok.filter((b) => b.rail === 'Transfer').length;
    const j = ok.filter((b) => b.rail === 'JomPay').length;
    const chosen = chosenAcct;
    const chosenPaysBiller = paysBiller;

    console.log('');
    if (!j || chosenPaysBiller) {
      console.log(`  Tick the ${ok.length} marked yes — ${t} in the transfer file, ${j} in the JomPay file.`);
    } else {
      const other = accts.find((a) => a !== chosen && (a.biller_format_key || bankOf(a) !== 'CIMB'));
      console.log(`  Two runs, because ${chosen.name} does not pay JomPay:`);
      console.log(`    ${t} transfer bill(s) from ${chosen.name}`);
      console.log(`    ${j} JomPay bill(s) from ${other ? other.name : 'a Hong Leong account — this organisation has none'}`);
    }
    console.log('');
    await db.close();
    return;
  }

  let summary = [...orgs.entries()].map(([code, o]) => {
    const ok = o.bills.filter((b) => b.ok);
    const accts = banksFor.get(o.tenantId) || [];
    // The default is what the dialog preselects, so it is the one that
    // decides the file unless somebody changes it in the dialog.
    const paying = [...new Set(accts.map(bankOf))];
    return {
      code, name: o.name, total: o.bills.length,
      bank: paying[0] || '(no paying account)',
      alsoAt: paying.slice(1),
      transfer: ok.filter((b) => b.rail === 'Transfer').length,
      biller: ok.filter((b) => b.rail === 'JomPay').length
    };
  });

  const wantBank = (arg('--bank') || '').trim();
  if (wantBank) {
    const needle = wantBank.toLowerCase();
    summary = summary.filter((x) =>
      [x.bank, ...x.alsoAt].some((b) => String(b).toLowerCase().includes(needle)));
    // Show the bank that matched. Leaving the default there answers a
    // different question from the one asked, and "Maybank" under --bank CIMB
    // reads as a bug.
    for (const x of summary) {
      const all = [x.bank, ...x.alsoAt];
      const hit = all.find((b) => String(b).toLowerCase().includes(needle));
      if (hit && hit !== x.bank) {
        x.alsoAt = all.filter((b) => b !== hit);
        x.bank = hit + '*';
      }
    }
    if (!summary.length) {
      console.log(`\nNo organisation with bills awaiting payment pays from a bank matching "${wantBank}".`);
      console.log('Banks in use: ' + [...new Set(accounts.map(bankOf))].join(', ') + '\n');
      await db.close();
      return;
    }
  }
  // Both rails clean is what produces two files from one selection, so those
  // sort first — that is the run worth testing with.
  summary.sort((a, b) =>
    (Math.min(b.transfer, 1) + Math.min(b.biller, 1)) - (Math.min(a.transfer, 1) + Math.min(a.biller, 1))
    || (b.transfer + b.biller) - (a.transfer + a.biller));

  // Entity codes run to twelve characters and a fixed column ate the gap, so
  // ABMANAGEMENT ran straight into its own name and could not be copied.
  const w = Math.max(6, ...summary.map((s) => String(s.code).length)) + 2;
  console.log('\nOrganisations with bills awaiting payment — best to test with first\n');
  console.log('  ' + 'CODE'.padEnd(w) + 'ORGANISATION'.padEnd(28) + 'PAYS FROM'.padEnd(16)
    + 'CLEAN'.padStart(6) + 'TRANSFER'.padStart(10) + 'JOMPAY'.padStart(8) + '  OF');
  for (const s of summary) {
    const both = s.transfer > 0 && s.biller > 0 ? '  <- both rails' : '';
    const bank = s.bank + (s.alsoAt.length ? ' +' + s.alsoAt.length : '');
    console.log('  ' + String(s.code).padEnd(w) + String(s.name).slice(0, 26).padEnd(28)
      + String(bank).slice(0, 14).padEnd(16)
      + String(s.transfer + s.biller).padStart(6) + String(s.transfer).padStart(10)
      + String(s.biller).padStart(8) + '  ' + String(s.total) + both);
  }
  const best = summary.find((s) => s.transfer > 0 && s.biller > 0) || summary[0];
  console.log(`\n  node scripts/ready-to-pay.js --entity ${best.code}\n`);
  await db.close();
})().catch(async (e) => {
  console.error('\nFAILED:', e.message, '\n');
  try { await db.close(); } catch { /* already closed */ }
  process.exit(1);
});
