// Localhost demo data for the Recharge tab.
//
//   node scripts/demo-recharge.js            add the rules and bills
//   node scripts/demo-recharge.js --reset    remove them and start again
//
// Six address rules and six bills, chosen so that every branch of the
// decision is visible on screen at once rather than having to be imagined:
//
//   a recharge        ABM paid TNB for a building that belongs to ABKJ
//   a recharge        ABM paid for water at a building that belongs to ABKK
//   a recharge        ABM paid the rent on that same building
//   no recharge       ABKK paid its own electricity bill
//   not yet           an approved bill nobody has paid
//   no match          a supplier with rules, at a premises none of them names
//
// The mock organisations have no real Xero behind them, so the premises is
// written straight onto the bill as though WazzOCR had already read it off
// the document. That is where it will come from in production.
require('../lib/env');
const db = require('../db');
const model = require('../models/recharge');

const ACCOUNT_ID = Number(process.env.DEMO_ACCOUNT_ID || 1);

const KAJANG_KILANG = 'Kilang Ayu Borneo, Jalan Reko, 43000 Kajang';
const KAJANG_LOT3   = 'Lot 3, Kawasan Perindustrian Sungai Chua, 43000 Kajang';
const KK_WISMA      = 'Wisma Ayu Borneo, Jalan Lintas, 88300 Kota Kinabalu';
const KUCHING_LOT88 = 'Lot 88, Jalan Tun Jugah, 93350 Kuching';

const RULES = [
  { supplier: 'Tenaga Nasional Berhad',   address: KAJANG_KILANG, owner: 'ABKJ' },
  { supplier: 'Tenaga Nasional Berhad',   address: KAJANG_LOT3,   owner: 'ABKJ' },
  { supplier: 'Tenaga Nasional Berhad',   address: KK_WISMA,      owner: 'ABKK' },
  { supplier: 'Jabatan Air Negeri Sabah', address: KK_WISMA,      owner: 'ABKK' },
  { supplier: 'Syarikat Air Sarawak',     address: KUCHING_LOT88, owner: 'ABMYY' },
  { supplier: 'Wisma Prima Properties',   address: KK_WISMA,      owner: 'ABKK' }
];

// Recharge rules: the fallback for bills with no premises on them. These are
// the cases the address side cannot reach — a central payroll deduction and a
// fuel account — which is the whole reason the second rule type exists.
const TEXT_RULES = [
  {
    name: 'EPF paid centrally for Kajang staff',
    matchMode: 'all',
    conditions: [{ field: 'supplier', operator: 'is', value: 'KWSP (EPF)' }],
    payer: 'ABM', owner: 'ABKJ', startDate: '2026-08-01'
  },
  {
    name: 'Fleet fuel for Kota Kinabalu',
    matchMode: 'all',
    conditions: [
      { field: 'supplier', operator: 'contains', value: 'Petronas' },
      { field: 'reference', operator: 'starts_with', value: 'PDB-FLEET' }
    ],
    payer: null, owner: 'ABKK', startDate: '2026-08-01'
  },
  {
    name: 'Kuching office tenancy',
    matchMode: 'all',
    conditions: [{ field: 'supplier', operator: 'contains', value: 'Hartanah Sejahtera' }],
    payer: 'ABM', owner: 'ABMYY', startDate: '2026-08-01'
  }
];

const BILLS = [
  {
    ref: 'TNB-GRP-0726', supplier: 'Tenaga Nasional Berhad', payer: 'ABM',
    total: 17980.00, address: KAJANG_KILANG, paidOn: '2026-08-08',
    expect: 'recharged to ABKJ'
  },
  {
    ref: 'JANS-WL-0826', supplier: 'Jabatan Air Negeri Sabah', payer: 'ABM',
    total: 1240.50, address: KK_WISMA, paidOn: '2026-08-14',
    expect: 'recharged to ABKK'
  },
  {
    ref: 'WPP-RENT-0826', supplier: 'Wisma Prima Properties', payer: 'ABM',
    total: 8500.00, address: KK_WISMA, paidOn: '2026-08-02',
    expect: 'recharged to ABKK'
  },
  {
    // The case the rule exists to NOT fire on. ABKK owns this address and is
    // on the header, so it is paying its own bill.
    ref: 'TNB-KK-0826', supplier: 'Tenaga Nasional Berhad', payer: 'ABKK',
    total: 3410.75, address: KK_WISMA, paidOn: '2026-08-11',
    expect: 'no recharge — ABKK owns the address and paid it'
  },
  {
    // Step 3: approved, nobody has paid it. Never recharged.
    ref: 'TNB-SC-0926', supplier: 'Tenaga Nasional Berhad', payer: 'ABM',
    total: 5120.00, address: KAJANG_LOT3, paidOn: null,
    expect: 'not yet — unpaid'
  },
  {
    // A supplier with rules, at a premises none of them names. Reads as "no
    // rule covers this", which is the honest answer; inventing one would be
    // how a cost lands on the wrong company.
    ref: 'SAS-MIRI-0826', supplier: 'Syarikat Air Sarawak', payer: 'ABM',
    total: 980.25, address: 'Lot 12, Jalan Bulan Sabit, 98000 Miri', paidOn: '2026-08-19',
    expect: 'no match — no rule names that premises'
  },

  // No premises on any of these. They are what the recharge rules are for.
  {
    ref: 'EPF-0826', supplier: 'KWSP (EPF)', payer: 'ABM',
    total: 6420.00, address: null, paidOn: '2026-08-15',
    expect: 'recharge rule: EPF → ABKJ'
  },
  {
    ref: 'PDB-FLEET-0826', supplier: 'Petronas Dagangan Berhad', payer: 'ABM',
    total: 3180.40, address: null, paidOn: '2026-08-20',
    expect: 'recharge rule: fleet fuel → ABKK'
  },
  {
    // Right supplier, wrong reference: the second condition fails, so the
    // rule stays out of it rather than guessing.
    ref: 'PDB-CARD-0826', supplier: 'Petronas Dagangan Berhad', payer: 'ABM',
    total: 240.00, address: null, paidOn: '2026-08-21',
    expect: 'no rule — reference does not start with PDB-FLEET'
  },
  {
    // In scope by every condition except the date: paid before the rule's
    // start. Reaching back is deliberate, not automatic.
    ref: 'EPF-0726', supplier: 'KWSP (EPF)', payer: 'ABM',
    total: 6180.00, address: null, paidOn: '2026-07-15',
    expect: 'out of scope — paid before the rule start date'
  }
];

async function entityMap() {
  const rows = await db.query('SELECT code, xero_tenant_id FROM entities WHERE account_id = ?', [ACCOUNT_ID]);
  return new Map(rows.map((r) => [r.code, r.xero_tenant_id]));
}

async function reset() {
  const refs = BILLS.map((b) => b.ref);
  const marks = refs.map(() => '?').join(',');
  await db.execute(
    `DELETE l FROM recharge_run_lines l
       JOIN recharge_runs r ON r.id = l.run_id
      WHERE r.account_id = ? AND r.bill_reference IN (${marks})`, [ACCOUNT_ID, ...refs]);
  await db.execute(
    `DELETE FROM recharge_runs WHERE account_id = ? AND bill_reference IN (${marks})`, [ACCOUNT_ID, ...refs]);
  await db.execute(
    `DELETE FROM bills WHERE account_id = ? AND reference IN (${marks})`, [ACCOUNT_ID, ...refs]);
  await db.execute(
    `DELETE FROM recharge_text_rules WHERE account_id = ? AND name IN (${TEXT_RULES.map(() => '?').join(',')})`,
    [ACCOUNT_ID, ...TEXT_RULES.map((r) => r.name)]);
  // Address rules are identified by the premises they name, since the
  // supplier now lives in its own table.
  const addresses = [...new Set(RULES.map((r) => r.address))];
  await db.execute(
    `DELETE FROM recharge_rules WHERE account_id = ? AND premises_address IN (${addresses.map(() => '?').join(',')})`,
    [ACCOUNT_ID, ...addresses]);
  console.log('Removed the demo rules, bills and any recharges raised from them.\n');
}

(async () => {
  const resetting = process.argv.includes('--reset');
  if (resetting) {
    await reset();
    if (!process.argv.includes('--seed')) { await db.close(); return; }
  }

  const byCode = await entityMap();
  const missing = [...new Set(RULES.map((r) => r.owner).concat(BILLS.map((b) => b.payer)))]
    .filter((c) => !byCode.has(c));
  if (missing.length) {
    console.error(`These organisations are not in this database: ${missing.join(', ')}.`);
    console.error('This demo expects the mock Ayu Borneo entities. Run the test seed first.');
    process.exit(1);
  }

  // The mock organisations are excluded from Bills Hub by default; a rule
  // pointing at a hidden entity would be invisible in the dialog that creates
  // it, which looks like the dialog is broken.
  const shown = await db.execute(
    `UPDATE entities SET included = 1
      WHERE account_id = ? AND code IN ('ABM','ABKJ','ABKK','ABMYY','ABSH') AND included = 0`,
    [ACCOUNT_ID]);
  if (shown.affectedRows) console.log(`Unhid ${shown.affectedRows} Ayu Borneo organisation(s).`);

  // A recharge cannot post without these, and a demo that stops at "set the
  // account codes first" demonstrates nothing.
  await model.getSettings(ACCOUNT_ID);
  await model.updateSettings(ACCOUNT_ID, {
    arAccountCode: '260', apAccountCode: '429', taxType: 'NONE', referencePrefix: 'IC-', dueDays: 30
  });
  console.log('Recharge account codes set to 260 (payer receivable) / 429 (subsidiary expense).\n');

  console.log('Address rules');
  let made = 0;
  for (const r of RULES) {
    try {
      await model.createRule(ACCOUNT_ID, {
        suppliers: [r.supplier],
        premisesAddress: r.address,
        ownerTenantId: byCode.get(r.owner)
      });
      made += 1;
      console.log(`  + ${r.owner.padEnd(6)} ${r.supplier} — ${r.address}`);
    } catch (e) {
      if (e.statusCode === 409) console.log(`  = ${r.owner.padEnd(6)} ${r.supplier} — already there`);
      else throw e;
    }
  }
  console.log(`  ${made} added.\n`);

  console.log('Recharge rules');
  let textMade = 0;
  for (const r of TEXT_RULES) {
    const existing = await db.getOne('SELECT id FROM recharge_text_rules WHERE account_id = ? AND name = ?', [ACCOUNT_ID, r.name]);
    if (existing) { console.log(`  = ${r.name} — already there`); continue; }
    await model.createTextRule(ACCOUNT_ID, {
      name: r.name, matchMode: r.matchMode, conditions: r.conditions,
      payerTenantId: r.payer ? byCode.get(r.payer) : null,
      ownerTenantId: byCode.get(r.owner), startDate: r.startDate
    });
    textMade += 1;
    console.log(`  + ${r.owner.padEnd(6)} ${r.name}`);
  }
  console.log(`  ${textMade} added.\n`);

  console.log('Bills');
  let seq = 0;
  for (const b of BILLS) {
    seq += 1;
    const tenant = byCode.get(b.payer);
    const paid = Boolean(b.paidOn);
    await db.execute(
      `INSERT INTO bills (account_id, xero_tenant_id, xero_invoice_id, invoice_number, reference,
         contact_id, contact_name, xero_status, bill_date, due_date, fully_paid_on, currency_code,
         sub_total, total_tax, total, amount_paid, amount_due, premises_address, premises_source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'ocr')
       ON DUPLICATE KEY UPDATE
         xero_status = VALUES(xero_status), fully_paid_on = VALUES(fully_paid_on),
         amount_paid = VALUES(amount_paid), amount_due = VALUES(amount_due),
         premises_address = VALUES(premises_address), premises_source = VALUES(premises_source)`,
      [
        ACCOUNT_ID, tenant,
        `dec0de00-0000-4000-8000-${String(seq).padStart(12, '0')}`,
        `INV-${b.ref}`, b.ref,
        `c-${b.supplier.toLowerCase().replace(/\W+/g, '-')}`, b.supplier,
        paid ? 'PAID' : 'AUTHORISED',
        '2026-07-28', '2026-08-25', b.paidOn, 'MYR',
        b.total, 0, b.total,
        paid ? b.total : 0, paid ? 0 : b.total,
        b.address
      ]
    );
    console.log(`  ${b.payer.padEnd(6)} ${b.ref.padEnd(16)} RM ${b.total.toFixed(2).padStart(10)}  ${b.expect}`);
  }

  console.log('\nOpen the Recharge tab. Five of these should be offered for recharge —');
  console.log('three matched by a premises address, two by a recharge rule — and the');
  console.log('other five are the cases where nothing should happen.');
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
