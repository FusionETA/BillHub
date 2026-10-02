// Seeds one mixed pay run: suppliers that go down the bank-transfer rail and
// utilities that go down JomPay, so both workbooks come out of a single
// selection on the Bills tab.
//
//   node scripts/demo-payrun.js --tenant DCGLOBAL
//   node scripts/demo-payrun.js --tenant DCGLOBAL --no-sync
//
// Six bills by default: four suppliers, two utilities. All AUTHORISED, so they
// land straight in Awaiting payment.
//
// The payee bank details are written to Bills Hub, not to Xero. Xero's API
// accepts a Contact's BatchPayments block and then silently keeps only
// BankAccountNumber — BankAccountName, Details and Code come back empty on the
// next read, which was confirmed against this very demo data. Typing them into
// Xero's own UI works and a sync reads them back; it is only the API write
// that drops them. Since the rail is chosen from the bank account name, a seed
// that relied on Xero to hold it would produce six bills that all looked like
// transfers.
//
// Refuses an organisation that does not look like a demo one unless --force.
require('../lib/env');
const db = require('../db');
const grantSource = require('../lib/grantSource');
const xero = require('../lib/xero');
const entities = require('../models/entities');
const payees = require('../models/payees');
const testMode = require('../lib/testMode');

const ACCOUNT = Number(process.env.DEFAULT_ACCOUNT_ID) || 1;
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

// bankAccountName is the rail: a name is a bank transfer, four or five digits
// is a JomPay biller code. details/code build the "Other Payment Details"
// column — entity prefix, supplier abbreviation, then the period.
const BILLS = [
  // Four suppliers → ConnectFirst bulk payment file.
  { name: 'Sinaran Office Supplies Sdn Bhd', bankAccountName: 'Maybank',          account: '514027718842', code: 'SOS',  details: 'MA', email: 'accounts@sinaran.example.com', amount: 3280.00, ref: 'SOS-26-1041' },
  { name: 'Kinabalu Freight Services Sdn Bhd', bankAccountName: 'CIMB Bank Berhad', account: '8604113277',  code: 'KFS',  details: 'MA', email: 'billing@kinabalu.example.com', amount: 1875.40, ref: 'KF/2610/0088' },
  { name: 'Borneo Facility Care Sdn Bhd',    bankAccountName: 'Public Bank Berhad', account: '3192847561',  code: 'BFC',  details: 'HG', email: 'ar@bfcare.example.com',       amount:  940.00, ref: 'BFC-1026-12' },
  { name: 'Sabah Print House Sdn Bhd',       bankAccountName: 'Hong Leong Bank',  account: '17250094433',  code: 'SPH',  details: 'BM', email: 'sales@sabahprint.example.com', amount:  612.75, ref: 'SPH26-0477' },
  // Two utilities → JomPay file. The account number is the JomPay Ref-1.
  { name: 'Indah Water Konsortium Sdn Bhd',  bankAccountName: '7011',             account: '880142300561', code: 'IWK',  details: 'BM 69', email: '',                          amount:  128.90, ref: 'IWK 1026' },
  { name: 'Telekom Malaysia Berhad',         bankAccountName: '8888',             account: '100288473019', code: 'TM',   details: 'BM 69', email: '',                          amount:  459.20, ref: 'TM 1026' }
];

(async () => {
  // Writing to Xero is the entire job here, so refuse early and clearly rather
  // than failing on the first contact.
  if (await testMode.isOn(ACCOUNT)) {
    throw new Error(
      'Testing mode is on, so nothing can be written to Xero. Turn it off on the '
      + 'Bank files tab (or: node -e "require(\'./lib/env\');require(\'./lib/testMode\').set(1,false)") and run this again.'
    );
  }

  const connAccountId = await grantSource.connectionsAccountId(ACCOUNT);
  const orgs = await entities.listByAccount(ACCOUNT, connAccountId, { includedOnly: false });
  const key = (arg('--tenant') || '').trim().toLowerCase();
  const org = key
    ? orgs.find((o) => (o.code || '').toLowerCase() === key || o.xero_tenant_id.toLowerCase() === key)
    : orgs.find((o) => /demo/i.test(o.tenant_name || o.short_name || ''));
  if (!org) {
    console.log('Pick one with --tenant <CODE>:');
    for (const o of orgs) console.log(`  ${String(o.code).padEnd(10)} ${o.tenant_name || o.short_name}`);
    return;
  }

  const orgName = org.tenant_name || org.short_name;
  if (!/demo|trial|sandbox|test/i.test(orgName) && !process.argv.includes('--force')) {
    throw new Error(`"${orgName}" does not look like a demo organisation. Re-run with --force if you mean it.`);
  }
  const t = org.xero_tenant_id;
  console.log(`\nSeeding a pay run in "${orgName}"\n`);

  for (const b of BILLS) {
    const saved = (await xero.api(ACCOUNT, t, '/Contacts', {
      method: 'POST',
      body: { Contacts: [{
        Name: b.name,
        ...(b.email ? { EmailAddress: b.email } : {}),
        // Sent anyway: the account number does persist, and a human opening
        // the contact in Xero should see something sensible.
        BatchPayments: { BankAccountName: b.bankAccountName, BankAccountNumber: b.account, Details: b.details, Code: b.code }
      }] }
    })).Contacts[0];

    await xero.api(ACCOUNT, t, '/Invoices', {
      method: 'POST',
      body: { Invoices: [{
        Type: 'ACCPAY',
        Contact: { ContactID: saved.ContactID },
        Date: iso(-12), DueDate: iso(18),
        Reference: b.ref, Status: 'AUTHORISED', LineAmountTypes: 'NoTax',
        LineItems: [{ Description: `${b.name} — ${b.ref}`, Quantity: 1, UnitAmount: b.amount, AccountCode: arg('--account-code') || '400' }]
      }] }
    });

    // The part Xero will not keep.
    await payees.setManual(ACCOUNT, t, saved.ContactID, {
      contactName: b.name,
      accountNumber: b.account,
      bankAccountName: b.bankAccountName,
      details: b.details,
      payeeCode: b.code,
      ...(b.email ? { email: b.email } : {})
    });

    const rail = /^\d{4,5}$/.test(b.bankAccountName) ? 'JomPay' : 'transfer';
    console.log(`  ${b.name.slice(0, 36).padEnd(38)} ${rail.padEnd(9)} ${String(b.amount.toFixed(2)).padStart(9)}  ${b.bankAccountName}`);
  }

  const transfers = BILLS.filter((b) => !/^\d{4,5}$/.test(b.bankAccountName)).length;
  console.log(`\n  ${transfers} bank transfer + ${BILLS.length - transfers} JomPay = two files from one selection.`);

  if (!process.argv.includes('--no-sync')) {
    console.log('\nSyncing…');
    const { syncAccount } = require('../billhub/sync');
    const out = await syncAccount(ACCOUNT, { tenantIds: [t] });
    console.log(`  ${out.bills ?? out.total ?? '?'} bill(s) pulled.`);
  }

  console.log('\nNow: Bills → Awaiting payment, tick all six, Pay selected.\n');
  await db.close();
})().catch(async (e) => {
  console.error('\nFAILED:', e.message, '\n');
  try { await db.close(); } catch { /* already closed */ }
  process.exit(1);
});
