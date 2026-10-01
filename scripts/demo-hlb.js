// Seeds a Xero demo organisation with the data shape Ayu Borneo actually use,
// so the Hong Leong bank file can be exercised end to end.
//
//   node scripts/demo-hlb.js --tenant DCGLOBAL
//
// Creates supplier and utility contacts with the "Financial details" panel
// filled the way their convention requires, then an approved bill for each.
// Deliberately includes the awkward cases — a name too long for IBG, a bank
// Hong Leong does not list, a payee with no account at all — because those are
// what the file has to catch before the bank does.
require('../lib/env');
const db = require('../db');
const grantSource = require('../lib/grantSource');
const xero = require('../lib/xero');
const entities = require('../models/entities');

const ACCOUNT = Number(process.env.DEFAULT_ACCOUNT_ID) || 1;
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

// name, bank-account-name, account number, code, lot/details, email, amount, their invoice ref
const PAYEES = [
  ['Green Element Marketing Sdn Bhd',  'Maybank',            '512763301383', 'GE',      'MA', 'greenelement@example.com',  4351.70, '29793'],
  ['Aircom Telecommunication Sdn Bhd', 'Public Bank Berhad', '3187293902',   'AIRCOM',  'MA', 'aircom@example.com',          50.00, 'UT001083 IA000123284'],
  ['A Two Z Marketing Sdn Bhd',        'Public Bank Berhad', '3814110704',   'A2Z',     'HG', 'atwoz@example.com',         1065.50, '300-A0231 IV26080181'],
  ['Wengwall Interior Design Sdn Bhd', 'Hong Leong Bank',    '12345678901',  'WENGWALL','BM', 'wengwall@example.com',      2800.00, 'WW-26-0881'],
  // Utilities: an all-digit "bank account name" is a JomPay biller code.
  ['Tenaga Nasional Berhad',           '5454',               '210478569003', 'TNB',     'BM 69',    '',                    1648.60, 'TNB 0826'],
  ['Air Selangor Sdn Bhd',             '4200',               '1344802340',   'AIS',     'BM 69',    '',                      36.00, 'AIS 0826'],
  // The awkward ones.
  ['Bank Of Narnia Trading Sdn Bhd',   'Bank of Narnia',     '999888777',    'NARNIA',  'HQ', '',                           420.00, 'NARNIA-1'],
  ['Supplier With No Bank Details Sdn Bhd', '',              '',             'NOBANK',  'HQ', '',                           125.00, 'NB-1']
];

(async () => {
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
  const name = org.tenant_name || org.short_name;
  if (!/demo|trial|sandbox|test/i.test(name) && !process.argv.includes('--force')) {
    throw new Error(`"${name}" does not look like a demo organisation. Re-run with --force if you mean it.`);
  }
  const t = org.xero_tenant_id;
  console.log(`\nSeeding "${name}"\n`);

  for (const [contact, bankAccountName, account, code, details, email, amount, reference] of PAYEES) {
    // The contact, with Xero's "Financial details" panel filled the way Ayu
    // Borneo maintain it.
    const body = { Contacts: [{
      Name: contact,
      ...(email ? { EmailAddress: email } : {}),
      BatchPayments: {
        BankAccountName: bankAccountName,
        BankAccountNumber: account,
        Details: details,
        Code: code
      }
    }] };
    const saved = (await xero.api(ACCOUNT, t, '/Contacts', { method: 'POST', body })).Contacts[0];

    await xero.api(ACCOUNT, t, '/Invoices', { method: 'POST', body: { Invoices: [{
      Type: 'ACCPAY',
      Contact: { ContactID: saved.ContactID },
      Date: iso(-20), DueDate: iso(10),
      Reference: reference, Status: 'AUTHORISED', LineAmountTypes: 'NoTax',
      LineItems: [{ Description: `${contact} — ${reference}`, Quantity: 1, UnitAmount: amount, AccountCode: arg('--account-code') || '400' }]
    }] } });

    const kind = /^\d{4,8}$/.test(bankAccountName) ? 'JomPay' : (bankAccountName ? 'transfer' : 'NO BANK');
    console.log(`  ${contact.slice(0, 38).padEnd(40)} ${kind.padEnd(9)} ${String(amount).padStart(8)}  ${bankAccountName || '—'}`);
  }

  console.log('\nNow: npm run sync, then "Sync accounts & payees" on the Bank files tab.\n');
  await db.close();
})().catch(async (e) => { console.error('\nFAILED:', e.message, '\n'); try { await db.close(); } catch {} process.exit(1); });
