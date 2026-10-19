// Seeds one mixed pay run: suppliers that go down the bank-transfer rail and
// utilities that go down JomPay, so both workbooks come out of a single
// selection on the Bills tab.
//
//   node scripts/demo-payrun.js --tenant DCGLOBAL
//   node scripts/demo-payrun.js --tenant DCGLOBAL --cimb
//   node scripts/demo-payrun.js --tenant DCGLOBAL --no-sync
//
// Six bills by default: four suppliers, two utilities. All AUTHORISED, so they
// land straight in Awaiting payment.
//
// --cimb seeds for a CIMB account: suppliers at banks on CIMB's own list, plus
// utilities on JomPay. CIMB names 33 IBG participants against Hong Leong's
// 113, so a supplier has to be at one of those to produce a line at all — one
// deliberately is not, so the refusal shows up in a run rather than only in a
// unit test.
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
  // Four suppliers → ConnectPro bulk payment file.
  { name: 'Sinaran Office Supplies Sdn Bhd', bankAccountName: 'Maybank',          account: '514027718842', code: 'SOS',  details: 'MA', email: 'accounts@sinaran.example.com', amount: 3280.00, ref: 'SOS-26-1041' },
  { name: 'Kinabalu Freight Services Sdn Bhd', bankAccountName: 'CIMB Bank Berhad', account: '8604113277',  code: 'KFS',  details: 'MA', email: 'billing@kinabalu.example.com', amount: 1875.40, ref: 'KF/2610/0088' },
  { name: 'Borneo Facility Care Sdn Bhd',    bankAccountName: 'Public Bank Berhad', account: '3192847561',  code: 'BFC',  details: 'HG', email: 'ar@bfcare.example.com',       amount:  940.00, ref: 'BFC-1026-12' },
  { name: 'Sabah Print House Sdn Bhd',       bankAccountName: 'Hong Leong Bank',  account: '17250094433',  code: 'SPH',  details: 'BM', email: 'sales@sabahprint.example.com', amount:  612.75, ref: 'SPH26-0477' },
  // Two utilities → JomPay file. The account number is the JomPay Ref-1.
  { name: 'Indah Water Konsortium Sdn Bhd',  bankAccountName: '7011',             account: '880142300561', code: 'IWK',  details: 'BM 69', email: '',                          amount:  128.90, ref: 'IWK 1026' },
  { name: 'Telekom Malaysia Berhad',         bankAccountName: '8888',             account: '100288473019', code: 'TM',   details: 'BM 69', email: '',                          amount:  459.20, ref: 'TM 1026' }
];

// Banks on CIMB's own BNM list, so every line resolves to a two-digit code.
const CIMB_BILLS = [
  { name: 'Lembah Jaya Hardware Sdn Bhd',  bankAccountName: 'Maybank',            account: '512088143077', code: 'LJH', details: 'MA 12', email: 'ar@lembahjaya.example.com',  amount: 2140.00, ref: 'LJH-26-0912' },
  { name: 'Pacific Linen Supply Sdn Bhd',  bankAccountName: 'CIMB Bank Berhad',   account: '8009471263',   code: 'PLS', details: 'MA 12', email: 'billing@paclinen.example.com', amount: 5675.30, ref: 'PL/2609/0441' },
  { name: 'Teratai Engineering Sdn Bhd',   bankAccountName: 'Public Bank Berhad', account: '3188204551',   code: 'TES', details: 'HG 7',  email: 'accounts@teratai.example.com', amount:  980.45, ref: 'TE-0926-33' },
  { name: 'Suria Cold Chain Sdn Bhd',      bankAccountName: 'RHB Bank Berhad',    account: '21409500117722', code: 'SCC', details: 'BM 69', email: 'ap@suriacold.example.com',   amount: 1312.75, ref: 'SCC26/0908' },
  // One at a bank Hong Leong lists and CIMB does not, so the refusal shows up
  // in a run rather than only in a unit test.
  { name: 'Mahkota Investment Advisory Sdn Bhd', bankAccountName: 'Alliance Investment Bank', account: '140910020099881', code: 'MIA', details: 'HQ', email: '', amount: 4400.00, ref: 'MIA-2609-02' },
  // Two on JomPay. CIMB pays both rails out of the one BizConverter workbook
  // — the transfer sheet for suppliers, "JomPAY Payment" for utilities — so a
  // single selection has to produce two files. Kept distinct from the Hong
  // Leong set's billers so a run of each is told apart at a glance.
  { name: 'Syarikat Air Darul Aman Sdn Bhd', bankAccountName: '5454', account: '770351900284', code: 'SADA', details: 'MA 12', email: '', amount: 318.60, ref: 'SADA 2610' },
  { name: 'Astro Malaysia Sdn Bhd',          bankAccountName: '4200', account: '620044881277', code: 'ASTR', details: 'HQ',    email: '', amount: 189.00, ref: 'ASTRO 2610' }
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

  const set = process.argv.includes('--cimb') ? CIMB_BILLS : BILLS;
  for (const b of set) {
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

    // Running this twice used to put a second real invoice into Xero for every
    // line, which is a mess to unpick by hand. The payee details below are
    // refreshed either way, so a re-run still repairs a bank name somebody
    // changed without also doubling the pay run.
    const already = await db.getOne(
      'SELECT id FROM bills WHERE account_id = ? AND xero_tenant_id = ? AND reference = ?',
      [ACCOUNT, t, b.ref]);
    if (already) {
      console.log(`  ${b.name.slice(0, 36).padEnd(38)} already there, left alone`);
    } else {
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
    }

    // The part Xero will not keep.
    await payees.setManual(ACCOUNT, t, saved.ContactID, {
      contactName: b.name,
      accountNumber: b.account,
      bankAccountName: b.bankAccountName,
      details: b.details,
      payeeCode: b.code,
      ...(b.email ? { email: b.email } : {})
    });

    if (!already) {
      const rail = /^\d{4,5}$/.test(b.bankAccountName) ? 'JomPay' : 'transfer';
      console.log(`  ${b.name.slice(0, 36).padEnd(38)} ${rail.padEnd(9)} ${String(b.amount.toFixed(2)).padStart(9)}  ${b.bankAccountName}`);
    }
  }

  const transfers = set.filter((b) => !/^\d{4,5}$/.test(b.bankAccountName)).length;
  const billers = set.length - transfers;
  console.log(set === CIMB_BILLS
    ? `\n  ${transfers} supplier(s) + ${billers} JomPay = two CIMB files from one selection.`
      + '\n  Pay them from a CIMB account, or the Hong Leong layout is chosen instead.'
    : `\n  ${transfers} bank transfer + ${billers} JomPay = two files from one selection.`);

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
