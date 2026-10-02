// Which bills would produce a clean bank file today.
//
//   node scripts/ready-to-pay.js                 organisations, best first
//   node scripts/ready-to-pay.js --entity ABPJ   the bills in one of them
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
function assess(row) {
  const bankish = row.bank_account_name || row.bank_name || '';
  if (banks.isBillerCode(String(bankish).trim())) {
    return row.account_number
      ? { rail: 'JomPay', ok: true, why: 'biller ' + String(bankish).trim() }
      : { rail: 'JomPay', ok: false, why: 'no account number for Ref-1' };
  }
  const code = banks.bankCode(row.bank_name, 'duitnow') || banks.bankCode(bankish, 'duitnow');
  if (!row.account_number) return { rail: 'Transfer', ok: false, why: 'no account number' };
  if (!code) return { rail: 'Transfer', ok: false, why: `"${String(bankish).slice(0, 22) || '—'}" is not a bank` };
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

  const orgs = new Map();
  for (const r of rows) {
    const key = r.entity || r.xero_tenant_id;
    if (!orgs.has(key)) orgs.set(key, { name: r.entity_name || key, bills: [] });
    orgs.get(key).bills.push({ ...r, ...assess(r) });
  }

  const want = (arg('--entity') || '').trim().toUpperCase();
  if (want) {
    const org = orgs.get(want);
    if (!org) { console.log(`\nNo bills awaiting payment in "${want}".\n`); return; }
    console.log(`\n${want} — ${org.name}\n`);
    console.log('  ' + 'OK'.padEnd(4) + 'RAIL'.padEnd(10) + 'PAYEE'.padEnd(36) + 'AMOUNT'.padStart(11) + '   WHY');
    for (const b of org.bills.sort((x, y) => (y.ok - x.ok) || x.rail.localeCompare(y.rail))) {
      console.log('  ' + (b.ok ? 'yes ' : 'no  ') + b.rail.padEnd(10)
        + String(b.contact_name).slice(0, 34).padEnd(36)
        + Number(b.amount_due).toFixed(2).padStart(11) + '   ' + b.why);
    }
    const ok = org.bills.filter((b) => b.ok);
    console.log(`\n  Tick the ${ok.length} marked yes. `
      + `${ok.filter((b) => b.rail === 'Transfer').length} go in the ConnectFirst file, `
      + `${ok.filter((b) => b.rail === 'JomPay').length} in the JomPay file.\n`);
    await db.close();
    return;
  }

  const summary = [...orgs.entries()].map(([code, o]) => {
    const ok = o.bills.filter((b) => b.ok);
    return {
      code, name: o.name, total: o.bills.length,
      transfer: ok.filter((b) => b.rail === 'Transfer').length,
      biller: ok.filter((b) => b.rail === 'JomPay').length
    };
  });
  // Both rails clean is what produces two files from one selection, so those
  // sort first — that is the run worth testing with.
  summary.sort((a, b) =>
    (Math.min(b.transfer, 1) + Math.min(b.biller, 1)) - (Math.min(a.transfer, 1) + Math.min(a.biller, 1))
    || (b.transfer + b.biller) - (a.transfer + a.biller));

  console.log('\nOrganisations with bills awaiting payment — best to test with first\n');
  console.log('  ' + 'CODE'.padEnd(12) + 'ORGANISATION'.padEnd(32) + 'CLEAN'.padStart(6) + 'TRANSFER'.padStart(10) + 'JOMPAY'.padStart(8) + '  OF');
  for (const s of summary) {
    const both = s.transfer > 0 && s.biller > 0 ? '  <- both rails' : '';
    console.log('  ' + String(s.code).padEnd(12) + String(s.name).slice(0, 30).padEnd(32)
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
