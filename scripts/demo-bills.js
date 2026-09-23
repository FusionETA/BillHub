// Creates draft supplier bills in a Xero organisation, so every Bills Hub
// screen has something to exercise.
//
//   node scripts/demo-bills.js                 list the organisations it will refuse
//   node scripts/demo-bills.js --tenant DEMO   create the bills
//   node scripts/demo-bills.js --tenant DEMO --count 12
//
// Guarded: it refuses any organisation whose name does not look like a Xero
// demo or trial company, unless --force is given. These are real Xero
// documents; creating a dozen of them in a live ledger is not a small mess.
require('dotenv').config();
const db = require('../db');
const grantSource = require('../lib/grantSource');
const xero = require('../lib/xero');
const entities = require('../models/entities');

const ACCOUNT = Number(process.env.DEFAULT_ACCOUNT_ID) || 1;

// Shaped to cover what the modules need: a spread of amounts, some due dates
// already past (overdue once approved), and repeat suppliers so the contact
// filter and the recharge rules have something to match on.
const TEMPLATES = [
  ['City Power & Utilities', 'UTIL-0926', 1840.50, -12],
  ['City Power & Utilities', 'UTIL-0927', 2210.75, 6],
  ['Harbour Office Supplies', 'HOS-8821', 342.10, 14],
  ['Meridian IT Services', 'MIT-2026-114', 5600.00, 21],
  ['Meridian IT Services', 'MIT-2026-115', 1250.00, -3],
  ['Cascade Logistics', 'CL-77401', 988.40, 9],
  ['Northwind Insurance', 'NWI-RENEW-26', 7400.00, 30],
  ['Harbour Office Supplies', 'HOS-8834', 129.95, -20],
  ['Ridgeway Legal', 'RL-INV-3390', 3150.00, 18],
  ['Cascade Logistics', 'CL-77488', 476.25, 2],
  ['Summit Facilities', 'SF-MNT-0926', 2050.00, -7],
  ['Meridian IT Services', 'MIT-2026-121', 860.00, 25]
];

const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}
const has = (name) => process.argv.includes(name);

// Xero demo and trial organisations are the only safe targets by default.
function looksLikeDemo(name) {
  return /\b(demo|trial|sandbox|test)\b/i.test(String(name || ''));
}

(async () => {
  const connAccountId = await grantSource.connectionsAccountId(ACCOUNT);
  const orgs = await entities.listByAccount(ACCOUNT, connAccountId, { includedOnly: false });
  if (!orgs.length) {
    console.log('No organisations connected. Connect Xero first.');
    return;
  }

  const key = arg('--tenant');
  if (!key) {
    console.log('\nPick one with --tenant <CODE|tenantId>:\n');
    for (const o of orgs) {
      const mark = looksLikeDemo(o.tenant_name || o.short_name) ? ' ' : '!';
      console.log(` [${mark}] ${String(o.code).padEnd(10)} ${o.tenant_name || o.short_name}`);
    }
    console.log('\n  [!] does not look like a demo or trial organisation — --force required.\n');
    return;
  }

  const needle = key.trim().toLowerCase();
  const org = orgs.find((o) =>
    (o.code || '').toLowerCase() === needle || o.xero_tenant_id.toLowerCase() === needle);
  if (!org) throw new Error(`No organisation matches "${key}".`);

  const name = org.tenant_name || org.short_name;
  if (!looksLikeDemo(name) && !has('--force')) {
    throw new Error(
      `"${name}" does not look like a demo or trial organisation.\n`
      + '      These are real Xero bills. Re-run with --force only if you genuinely want them there.'
    );
  }

  const count = Math.min(Number(arg('--count')) || TEMPLATES.length, TEMPLATES.length);
  console.log(`\nCreating ${count} draft bill(s) in "${name}" …\n`);

  let made = 0;
  const failures = [];
  for (const [supplier, reference, amount, dueIn] of TEMPLATES.slice(0, count)) {
    try {
      const res = await xero.api(ACCOUNT, org.xero_tenant_id, '/Invoices', {
        method: 'POST',
        body: {
          Invoices: [{
            Type: 'ACCPAY',
            // Name alone is enough: Xero matches an existing contact or makes one.
            Contact: { Name: supplier },
            Date: iso(-Math.abs(dueIn) - 5),
            DueDate: iso(dueIn),
            Reference: reference,
            Status: 'DRAFT',
            LineAmountTypes: 'NoTax',
            LineItems: [{
              Description: `${supplier} — ${reference}`,
              Quantity: 1,
              UnitAmount: amount,
              AccountCode: arg('--account-code') || '400'
            }]
          }]
        }
      });
      const inv = res?.Invoices?.[0];
      console.log(`  ok    ${reference.padEnd(16)} ${supplier.padEnd(26)} ${amount.toFixed(2)}  due ${iso(dueIn)}${dueIn < 0 ? '  (already overdue)' : ''}`);
      if (inv?.InvoiceID) made += 1;
    } catch (e) {
      console.log(`  FAIL  ${reference.padEnd(16)} ${e.message}`);
      failures.push(e.message);
    }
  }

  console.log(`\n${made} created, ${failures.length} failed.`);
  if (failures.some((f) => /account code/i.test(f))) {
    console.log('An account code does not exist in this organisation — pass --account-code <code>.');
  }
  if (made) console.log('\nNow press Sync Xero in Bills Hub, or run: npm run sync\n');
})()
  .then(() => db.close())
  .catch(async (err) => {
    console.error('\nFAILED:', err.message, '\n');
    try { await db.close(); } catch { /* already closed */ }
    process.exit(1);
  });
