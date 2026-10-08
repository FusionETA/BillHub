// Localhost test data for the Recharge tab, shaped like production.
//
//   node scripts/demo-recharge.js            add it
//   node scripts/demo-recharge.js --reset    take it away again
//   node scripts/demo-recharge.js --reset --seed
//
// Built from what Ayu Borneo's real bills turned out to look like, because
// test data that does not resemble the real thing teaches the wrong lesson.
// The live account has:
//
//   · 2,250 paid TNB bills, 98% of them on ONE generic contact
//   · the premises in the reference, after the meter's account number:
//     "006975997185-TS-17-M", "000323819565-HQ-J-28-02"
//   · 157 of them paid by the management company for premises it does not
//     occupy — that subset is the whole job
//   · no street address anywhere
//
// So most of what is seeded here exercises recharge rules on the reference.
// A few bills do carry a premises address, because that is what WazzOCR will
// eventually give us and the address rules have to keep working when it does.
//
// The mock organisations have no real Xero behind them, so a run can be
// drafted here but not posted: posting writes a document into each of two
// organisations, and that needs two live Xero connections.
require('../lib/env');
const db = require('../db');
const model = require('../models/recharge');

const ACCOUNT_ID = Number(process.env.DEMO_ACCOUNT_ID || 1);

// Premises code -> the entity that occupies it. In the real account this
// mapping is the part only the client has; here it is the answer key.
//
// CT-9-13-1 and CT-9-13-10 are both present on purpose: a rule written with
// "contains" for the shorter one claims the longer one's bills and pays the
// wrong company. Anything built here should be provable against that pair.
const PREMISES = [
  { code: 'TS-17-M',    owner: 'ABKJ',  meter: '006975997185', bills: 3 },
  { code: 'HQ-J-28-02', owner: 'ABKJ',  meter: '000323819565', bills: 2 },
  { code: 'CT-9-13-1',  owner: 'ABKK',  meter: '000523322227', bills: 2 },
  // Deliberately a DIFFERENT entity from CT-9-13-1. If somebody writes the
  // rule with "contains" instead of "ends with", these bills go to ABKK and
  // the mistake is visible on screen rather than theoretical.
  { code: 'CT-9-13-10', owner: 'ABMYY', meter: '000523322240', bills: 2 },
  { code: 'WM-7-2',     owner: 'ABSH',  meter: '001170153121', bills: 2 },
  { code: 'KW-85-1',    owner: 'ABMYY', meter: '001170154001', bills: 2 },
  // Occupied by the company that pays the bills, so nothing should happen.
  { code: 'HQ-A-1-01',  owner: 'ABM',   meter: '000323819500', bills: 2 }
];

// Only some premises get a rule, so `npm run recharge-preview` has something
// left to report and there is something to write by hand.
const RULED = ['TS-17-M', 'HQ-J-28-02', 'CT-9-13-1', 'CT-9-13-10'];

// The minority of bills that carry a premises address — the address rules'
// reason to exist, and what WazzOCR will make the common case.
const KK_WISMA = 'Wisma Ayu Borneo, Jalan Lintas, 88300 Kota Kinabalu';
const KAJANG   = 'Kilang Ayu Borneo, Jalan Reko, 43000 Kajang';

const ADDRESS_RULES = [
  { suppliers: ['Jabatan Air Negeri Sabah'], address: KK_WISMA, owner: 'ABKK' },
  { suppliers: ['Wisma Prima Properties'],   address: KK_WISMA, owner: 'ABKK' },
  { suppliers: ['Tenaga Nasional Berhad - Hostel No. 27'], address: KAJANG, owner: 'ABKJ' }
];

const TEXT_RULES = [
  {
    name: 'EPF paid centrally for Kajang staff',
    conditions: [{ field: 'supplier', operator: 'is', value: 'KWSP (EPF)' }],
    payer: 'ABM', owner: 'ABKJ'
  },
  {
    name: 'Fleet fuel for Kota Kinabalu',
    conditions: [
      { field: 'supplier', operator: 'contains', value: 'Petronas' },
      { field: 'reference', operator: 'starts_with', value: 'PDB-FLEET' }
    ],
    payer: null, owner: 'ABKK'
  }
];

const START = '2026-08-01';
const PAID_ON = '2026-09-20';

// Everything this script writes, so --reset can find it again.
const TAG = 'dec0de00-0000-4000-8000-';

function billRows() {
  const out = [];
  const add = (b) => out.push({ ...b, xid: `${TAG}${String(out.length + 1).padStart(12, '0')}` });

  // The dominant shape: one generic contact, premises in the reference.
  for (const p of PREMISES) {
    for (let i = 0; i < p.bills; i += 1) {
      add({
        supplier: 'Tenaga Nasional Berhad',
        reference: `${p.meter}-${p.code}`,
        payer: 'ABM',
        total: 400 + out.length * 37,
        paidOn: PAID_ON,
        note: p.owner === 'ABM'
          ? 'nothing — ABM occupies it'
          : (RULED.includes(p.code) ? `recharge rule -> ${p.owner}` : `no rule yet for ${p.code}`)
      });
    }
  }

  // A reference with no meter number in it, so the preview has something it
  // honestly cannot read rather than something it guesses at.
  add({
    supplier: 'Tenaga Nasional Berhad', reference: 'OCT ELECTRIC BULK',
    payer: 'ABM', total: 1250.00, paidOn: PAID_ON,
    note: 'no rule — the reference carries no premises'
  });

  add({
    supplier: 'Jabatan Air Negeri Sabah', reference: 'JANS-WL-0926',
    payer: 'ABM', total: 1240.50, paidOn: PAID_ON, address: KK_WISMA,
    note: 'address rule -> ABKK'
  });
  add({
    supplier: 'Wisma Prima Properties', reference: 'WPP-RENT-0926',
    payer: 'ABM', total: 8500.00, paidOn: PAID_ON, address: KK_WISMA,
    note: 'address rule -> ABKK'
  });
  add({
    // The owner paying its own bill. The rule exists precisely not to fire.
    supplier: 'Jabatan Air Negeri Sabah', reference: 'JANS-KK-0926',
    payer: 'ABKK', total: 980.00, paidOn: PAID_ON, address: KK_WISMA,
    note: 'nothing — ABKK owns the address and paid it'
  });
  add({
    supplier: 'Tenaga Nasional Berhad - Hostel No. 27', reference: '001170153115-H27',
    payer: 'ABM', total: 2410.00, paidOn: PAID_ON, address: KAJANG,
    note: 'address rule -> ABKJ (premises is in the contact name too)'
  });

  add({
    supplier: 'KWSP (EPF)', reference: 'EPF-0926',
    payer: 'ABM', total: 6420.00, paidOn: PAID_ON, note: 'recharge rule -> ABKJ'
  });
  add({
    supplier: 'KWSP (EPF)', reference: 'EPF-0726',
    payer: 'ABM', total: 6180.00, paidOn: '2026-07-15',
    note: `out of scope — paid before ${START}`
  });
  add({
    supplier: 'Petronas Dagangan Berhad', reference: 'PDB-FLEET-0926',
    payer: 'ABM', total: 3180.40, paidOn: PAID_ON, note: 'recharge rule -> ABKK'
  });
  add({
    supplier: 'Petronas Dagangan Berhad', reference: 'PDB-CARD-0926',
    payer: 'ABM', total: 240.00, paidOn: PAID_ON,
    note: 'no rule — the reference does not start with PDB-FLEET'
  });
  add({
    supplier: 'Tenaga Nasional Berhad', reference: '006975997185-TS-17-M-OCT',
    payer: 'ABM', total: 515.00, paidOn: null,
    note: 'not yet — unpaid'
  });

  return out;
}

// contact_id is CHAR(36), and a name like "Tenaga Nasional Berhad - Hostel
// No. 27" slugs to more than that. A hash keeps it stable per supplier and
// inside the column.
function contactId(supplier) {
  return require('crypto').createHash('md5').update(String(supplier)).digest('hex');
}

async function entityMap() {
  const rows = await db.query('SELECT code, xero_tenant_id FROM entities WHERE account_id = ?', [ACCOUNT_ID]);
  return new Map(rows.map((r) => [r.code, r.xero_tenant_id]));
}

async function reset() {
  await db.execute(
    `DELETE l FROM recharge_run_lines l JOIN recharge_runs r ON r.id = l.run_id
      WHERE r.account_id = ? AND r.xero_invoice_id LIKE ?`, [ACCOUNT_ID, `${TAG}%`]);
  await db.execute('DELETE FROM recharge_runs WHERE account_id = ? AND xero_invoice_id LIKE ?',
    [ACCOUNT_ID, `${TAG}%`]);
  await db.execute('DELETE FROM bills WHERE account_id = ? AND xero_invoice_id LIKE ?',
    [ACCOUNT_ID, `${TAG}%`]);

  // By supplier, not by address: an earlier version of this script seeded
  // rules at addresses this one no longer lists, and leaving those behind
  // meant every TNB bill was still eligible for an address match — which
  // cost a failing Xero call each and muddied the preview.
  const suppliers = [...new Set(ADDRESS_RULES.flatMap((r) => r.suppliers)
    .concat(['Tenaga Nasional Berhad', 'Syarikat Air Sarawak']))];
  await db.execute(
    `DELETE r FROM recharge_rules r
       JOIN recharge_rule_suppliers s ON s.rule_id = r.id
      WHERE r.account_id = ? AND s.supplier_name IN (${suppliers.map(() => '?').join(',')})`,
    [ACCOUNT_ID, ...suppliers]);

  // Names this script has used at any point, not only the ones it uses now.
  // A rule left behind by an earlier version keeps claiming bills, and a
  // demo you cannot actually reset is worse than no demo.
  const RETIRED = ['Kuching office tenancy', 'Fleet fuel for Tawau', 'All TNB to KK'];
  const names = TEXT_RULES.map((r) => r.name)
    .concat(PREMISES.map((p) => `Electricity at ${p.code}`))
    .concat(RETIRED);
  await db.execute(
    `DELETE FROM recharge_text_rules WHERE account_id = ? AND name IN (${names.map(() => '?').join(',')})`,
    [ACCOUNT_ID, ...names]);
  console.log('Removed the demo rules, bills and any recharges raised from them.\n');
}

(async () => {
  if (process.argv.includes('--reset')) {
    await reset();
    if (!process.argv.includes('--seed')) { await db.close(); return; }
  }

  const byCode = await entityMap();
  const needed = [...new Set(
    PREMISES.map((p) => p.owner)
      .concat(ADDRESS_RULES.map((r) => r.owner))
      .concat(TEXT_RULES.flatMap((r) => [r.owner, r.payer].filter(Boolean)))
      .concat(['ABM'])
  )];
  const missing = needed.filter((c) => !byCode.has(c));
  if (missing.length) {
    console.error(`These organisations are not in this database: ${missing.join(', ')}.`);
    console.error('This demo expects the mock Ayu Borneo entities. Run the test seed first.');
    process.exit(1);
  }

  const shown = await db.execute(
    `UPDATE entities SET included = 1
      WHERE account_id = ? AND code IN ('ABM','ABKJ','ABKK','ABMYY','ABSH') AND included = 0`,
    [ACCOUNT_ID]);
  if (shown.affectedRows) console.log(`Unhid ${shown.affectedRows} Ayu Borneo organisation(s).`);

  await model.getSettings(ACCOUNT_ID);

  console.log('Address rules — for the bills that carry a premises address');
  for (const r of ADDRESS_RULES) {
    try {
      await model.createRule(ACCOUNT_ID, {
        suppliers: r.suppliers, premisesAddress: r.address, ownerTenantId: byCode.get(r.owner)
      });
      console.log(`  + ${r.owner.padEnd(6)} ${r.suppliers[0]}`);
    } catch (e) {
      if (e.statusCode === 409) console.log(`  = ${r.owner.padEnd(6)} ${r.suppliers[0]} — already there`);
      else throw e;
    }
  }

  console.log('\nRecharge rules — for everything else');
  const all = TEXT_RULES.concat(
    PREMISES.filter((p) => RULED.includes(p.code)).map((p) => ({
      name: `Electricity at ${p.code}`,
      // "ends with", keeping the dash: the premises is the tail of the
      // reference, and CT-9-13-1 is inside CT-9-13-10.
      conditions: [{ field: 'reference', operator: 'ends_with', value: `-${p.code}` }],
      payer: 'ABM', owner: p.owner
    }))
  );
  for (const r of all) {
    const existing = await db.getOne(
      'SELECT id FROM recharge_text_rules WHERE account_id = ? AND name = ?', [ACCOUNT_ID, r.name]);
    if (existing) { console.log(`  = ${r.name} — already there`); continue; }
    await model.createTextRule(ACCOUNT_ID, {
      name: r.name, matchMode: 'all', conditions: r.conditions,
      payerTenantId: r.payer ? byCode.get(r.payer) : null,
      ownerTenantId: byCode.get(r.owner), startDate: START
    });
    console.log(`  + ${r.owner.padEnd(6)} ${r.name}`);
  }

  console.log('\nBills');
  const rows = billRows();
  for (const b of rows) {
    const paid = Boolean(b.paidOn);
    await db.execute(
      `INSERT INTO bills (account_id, xero_tenant_id, xero_invoice_id, invoice_number, reference,
         contact_id, contact_name, xero_status, bill_date, due_date, fully_paid_on, currency_code,
         sub_total, total_tax, total, amount_paid, amount_due, premises_address, premises_source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'MYR',?,0,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         reference = VALUES(reference), contact_name = VALUES(contact_name),
         xero_status = VALUES(xero_status), fully_paid_on = VALUES(fully_paid_on),
         amount_paid = VALUES(amount_paid), amount_due = VALUES(amount_due),
         premises_address = VALUES(premises_address), premises_source = VALUES(premises_source)`,
      [
        ACCOUNT_ID, byCode.get(b.payer), b.xid, `INV-${b.reference}`.slice(0, 255), b.reference,
        contactId(b.supplier), b.supplier,
        paid ? 'PAID' : 'AUTHORISED', '2026-09-01', '2026-09-28', b.paidOn,
        b.total, b.total, paid ? b.total : 0, paid ? 0 : b.total,
        b.address || null, b.address ? 'ocr' : null
      ]
    );
    console.log(`  ${b.payer.padEnd(5)} ${b.reference.padEnd(27)} ${b.total.toFixed(2).padStart(9)}  ${b.note}`);
  }

  const willRecharge = rows.filter((b) => /->/.test(b.note)).length;
  console.log(`\n${rows.length} bills. ${willRecharge} should be offered for recharge; the rest are the`);
  console.log('cases where nothing should happen, and those are worth checking too.\n');
  console.log('Try, in this order:');
  console.log('  1. npm run recharge-preview');
  console.log('     every bill grouped by what the rules decide. Writes nothing.');
  console.log('  2. npm run recharge-preview -- --suppliers --supplier Tenaga --entity ABM');
  console.log('     the production shape: one contact, the premises in the reference.');
  console.log('  3. The Recharge tab. WM-7-2 and KW-85-1 have no rule yet — write one');
  console.log('     ("Reference ends with -WM-7-2" to ABSH) and watch it appear.');
  console.log('  4. Recharge rules tab, Run now: drafts every waiting bill at once.\n');
  console.log('Posting to Xero needs two live Xero connections, and these organisations');
  console.log('are mock. Everything up to Post works; Post itself will report that Xero');
  console.log('has no token for them.\n');
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
