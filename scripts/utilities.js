// Which utilities this account actually bills, and under which contacts.
//
//   node scripts/utilities.js                 what is recognised
//   node scripts/utilities.js --unmatched     the recurring suppliers it did not recognise
//   node scripts/utilities.js --utility TNB   every contact behind one utility
//
// Read-only. No Xero call, no write.
//
// Two questions, and the second matters more than the first. What the
// Utility column should offer is not a list somebody in another country
// guessed — it is what is on these bills. And anything recurring that went
// unrecognised is either a utility the patterns in lib/utilities.js miss,
// or a supplier that belongs in a recharge rule instead. Either way it has
// to be looked at rather than quietly dropped.
require('../lib/env');
const db = require('../db');
const { detect } = require('../lib/utilities');

const ACCOUNT_ID = Number(process.env.BILLHUB_ACCOUNT_ID || process.env.DEMO_ACCOUNT_ID || 1);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}

async function main() {
  const rows = await db.query(
    `SELECT b.contact_name AS name,
            COUNT(*) AS bills,
            COUNT(DISTINCT b.xero_tenant_id) AS orgs,
            SUM(b.marked_paid_at IS NOT NULL) AS paid_here,
            MAX(b.bill_date) AS latest
       FROM bills b
      WHERE b.account_id = ? AND b.contact_name IS NOT NULL AND b.contact_name <> ''
      GROUP BY b.contact_name
      ORDER BY bills DESC`,
    [ACCOUNT_ID]
  );
  if (!rows.length) { console.log('\nNo bills on this account yet.\n'); return; }

  const only = arg('utility');
  const byUtility = new Map();
  const unmatched = [];
  for (const r of rows) {
    const u = detect(r.name);
    if (!u) { unmatched.push(r); continue; }
    if (!byUtility.has(u)) byUtility.set(u, []);
    byUtility.get(u).push(r);
  }

  if (only) {
    const list = byUtility.get(only) || [];
    console.log(`\n${only}: ${list.length} contact(s)\n`);
    for (const r of list) {
      console.log(`  ${String(r.bills).padStart(5)} bills  ${String(r.orgs).padStart(2)} org(s)  ${r.name}`);
    }
    console.log('');
    return;
  }

  // A bill with no supplier cannot be matched by anything — not by the
  // register, which keys on the contact, and not by a recharge rule with a
  // supplier condition. Worth its own line rather than sitting in the
  // unmatched list looking like a supplier called "No Contact".
  const nameless = rows.find((r) => /^no contact$/i.test(String(r.name).trim()));

  if (process.argv.includes('--unmatched')) {
    // Only the ones that recur: a supplier with one bill is not a utility
    // account, and listing nine hundred of them hides the handful that are.
    const recurring = unmatched.filter((r) => Number(r.bills) >= 5).slice(0, 60);
    console.log(`\n${recurring.length} recurring supplier(s) the patterns did not recognise`);
    console.log('(5+ bills each. A utility among these means lib/utilities.js is missing a pattern.)\n');
    for (const r of recurring) {
      console.log(`  ${String(r.bills).padStart(5)} bills  ${String(r.orgs).padStart(2)} org(s)  ${r.name}`);
    }
    console.log('');
    return;
  }

  const total = rows.reduce((n, r) => n + Number(r.bills), 0);
  const matched = [...byUtility.values()].flat().reduce((n, r) => n + Number(r.bills), 0);

  console.log(`\n${byUtility.size} utilit${byUtility.size === 1 ? 'y' : 'ies'} recognised`
    + `, across ${matched} of ${total} bills\n`);
  const sorted = [...byUtility.entries()]
    .map(([name, list]) => ({
      name,
      contacts: list.length,
      bills: list.reduce((n, r) => n + Number(r.bills), 0),
      orgs: new Set(list.flatMap((r) => Array(Number(r.orgs)).fill(r.name))).size,
      paidHere: list.reduce((n, r) => n + Number(r.paid_here), 0)
    }))
    .sort((a, b) => b.bills - a.bills);

  console.log('   BILLS  CONTACTS  PAID VIA BILLS HUB  UTILITY');
  for (const u of sorted) {
    console.log(`  ${String(u.bills).padStart(6)}  ${String(u.contacts).padStart(8)}  `
      + `${String(u.paidHere).padStart(18)}  ${u.name}`);
  }

  if (nameless) {
    console.log(`\n  ${nameless.bills} bill(s) across ${nameless.orgs} organisation(s) have NO supplier contact.`);
    console.log('  Nothing can match those — not the register, which keys on the contact,');
    console.log('  and not a recharge rule with a supplier condition. They need a contact');
    console.log('  in Xero before any rule can reach them.');
  }

  console.log('\nContacts per utility tells you which ones can use the register as it');
  console.log('stands: one contact per premises is a row each, and one contact across');
  console.log('many premises needs a recharge rule on the reference instead.');
  console.log('\nAs a rough test: bills divided by contacts. Close to the number of');
  console.log('months you have been running means one account per premises, and the');
  console.log('register fits. Several times that means one contact covering many.');
  console.log('\nThen:  node scripts/utilities.js --unmatched');
  console.log('       node scripts/utilities.js --utility TNB\n');
}

main()
  .then(() => db.close())
  .catch(async (e) => { console.error('\nFAILED:', e.message, '\n'); await db.close(); process.exit(1); });
