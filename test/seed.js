// Seeds a local test environment: a stand-in WazzOCR database holding the shared
// Xero grant, plus Bills Hub's own bills.
//
// Everything goes through the real code paths — the grant is encrypted with
// lib/crypto, and bills are written with models/bills.upsertFromXero — so date
// parsing, status mapping, intercompany detection and the cross-database read
// are all exercised rather than faked.
//
//   node test/seed.js      (needs an account with id 1 — see npm run create-account)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../db');
const entities = require('../models/entities');
const bills = require('../models/bills');
const bankAccounts = require('../models/bankAccounts');
const bankFormats = require('../models/bankFormats');
const payees = require('../models/payees');
const { encrypt } = require('../lib/crypto');
const { DB_NAME, GRANTS, CONNECTIONS } = require('../lib/wazzocrDb');

const ACCOUNT = 1;          // Bills Hub account
const WAZZOCR_ACCOUNT = 7;  // its counterpart in the WazzOCR database

const ORGS = [
  ['tenant-abm', 'Ayu Borneo Management Sdn Bhd'],
  ['tenant-abkk', 'Ayu Borneo (KK) Sdn Bhd'],
  ['tenant-abkj', 'Ayu Borneo (KJ) Sdn Bhd'],
  ['tenant-absh', 'Ayu Borneo (SH) Sdn Bhd'],
  ['tenant-abmyy', 'Ayu Borneo (MYY) Sdn Bhd']
];

// Xero returns dates in the /Date(ms+0000)/ form on the Invoices endpoint.
const xdate = (iso) => `/Date(${Date.parse(iso + 'T00:00:00Z')}+0000)/`;

const INVOICES = [
  // tenant, Status, Reference, Contact, Total, Paid, Date, Due, attachment
  ['tenant-abm',  'DRAFT',      'Expense Claim',   'Simon Chim',                 1276.40, 0,       '2026-09-04', '2026-09-11', true],
  ['tenant-abkj', 'DRAFT',      'SAS-2026-0912',   'Setia Awan Supplies Sdn Bhd', 8740.00, 0,       '2026-09-03', '2026-10-03', false],
  ['tenant-abmyy','DRAFT',      'SHL-MYY-0826',    'Shell Malaysia Trading',       742.55, 0,       '2026-09-03', '2026-09-18', false],
  ['tenant-absh', 'SUBMITTED',  'Expense Claim',   'Simon Chim',                   358.00, 0,       '2026-09-03', '2026-09-04', true],
  ['tenant-abkj', 'DRAFT',      'INTERCO-KJ-0826', 'Ayu Borneo (LBU) Sdn Bhd',   14500.00, 0,       '2026-09-02', '2026-09-30', true],
  ['tenant-abkk', 'DRAFT',      'GRB-INV-77120',   'Grab Malaysia',                388.90, 0,       '2026-09-02', '2026-09-16', true],
  ['tenant-abkj', 'SUBMITTED',  'HN-KJ-55210',     'Harvey Norman Malaysia',      5299.00, 0,       '2026-09-01', '2026-09-30', true],
  ['tenant-abkk', 'AUTHORISED', 'MYIN26-283331',   'Telekom Malaysia',             246.15, 0,       '2026-09-01', '2026-09-15', true],
  // Overdue: authorised, nothing paid, due date already gone.
  ['tenant-absh', 'AUTHORISED', 'SESB-SH-0826',    'Sabah Electricity Sdn Bhd',    612.40, 0,       '2026-08-30', '2026-08-14', false],
  // Part-paid: Xero leaves it AUTHORISED, so it stays "awaiting payment".
  ['tenant-abm',  'AUTHORISED', 'EPF-0826',        'KWSP EPF',                   12000.00, 4000.00, '2026-08-20', '2026-09-20', true],
  ['tenant-abm',  'PAID',       'MBB-FT-0812',     'Maybank Berhad',              9840.20, 9840.20, '2026-08-02', '2026-08-30', true],
  // Never shown in a list or a total.
  ['tenant-abkk', 'VOIDED',     'CANCELLED-001',   'Some Supplier',                100.00, 0,       '2026-08-01', '2026-08-15', false]
];

// A stand-in for WazzOCR's database, with just the two tables Bills Hub reads.
// Column types match WazzOCR's schema; its foreign keys are left out because
// nothing here depends on them.
async function createWazzocrFixture() {
  await db.execute(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4`);
  await db.execute(`CREATE TABLE IF NOT EXISTS ${GRANTS} (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    account_id    BIGINT UNSIGNED NOT NULL,
    refresh_token VARBINARY(1024) NOT NULL,
    scope         TEXT,
    obtained_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.execute(`CREATE TABLE IF NOT EXISTS ${CONNECTIONS} (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    account_id      BIGINT UNSIGNED NOT NULL,
    grant_id        BIGINT UNSIGNED NOT NULL,
    xero_tenant_id  VARCHAR(64) NOT NULL,
    tenant_name     VARCHAR(255),
    status          ENUM('active','expired','revoked') DEFAULT 'active',
    needs_reconnect TINYINT(1) DEFAULT 0,
    UNIQUE KEY uq_acct_tenant (account_id, xero_tenant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

// Wipes the tables this fixture owns, so a suite can call seed() and start from
// a known state regardless of what ran before it.
async function reset() {
  await db.execute('DELETE FROM payment_batch_lines');
  await db.execute('DELETE FROM payment_batches');
  await db.execute('DELETE FROM bank_accounts');
  await db.execute('DELETE FROM payees');
  await db.execute('DELETE FROM bank_formats WHERE account_id IS NOT NULL');
  await db.execute('DELETE FROM bills');
  await db.execute('DELETE FROM bill_sync_state');
  await db.execute('DELETE FROM entities');
}

async function seed({ quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  await createWazzocrFixture();
  await reset();
  await db.execute(`DELETE FROM ${CONNECTIONS} WHERE account_id = ?`, [WAZZOCR_ACCOUNT]);
  await db.execute(`DELETE FROM ${GRANTS} WHERE account_id = ?`, [WAZZOCR_ACCOUNT]);

  const grantId = await db.insert(
    `INSERT INTO ${GRANTS} (account_id, refresh_token, scope) VALUES (?,?,?)`,
    [WAZZOCR_ACCOUNT, encrypt('fake-refresh-token-for-local-test'), 'accounting.transactions']
  );

  // Point the Bills Hub account at that WazzOCR account.
  await db.execute('UPDATE accounts SET wazzocr_account_id = ? WHERE id = ?', [WAZZOCR_ACCOUNT, ACCOUNT]);

  for (const [tenantId, tenantName] of ORGS) {
    await db.execute(
      `INSERT INTO ${CONNECTIONS} (account_id, grant_id, xero_tenant_id, tenant_name, status)
       VALUES (?,?,?,?,'active')
       ON DUPLICATE KEY UPDATE grant_id = VALUES(grant_id), tenant_name = VALUES(tenant_name), status = 'active'`,
      [WAZZOCR_ACCOUNT, grantId, tenantId, tenantName]
    );
    const e = await entities.ensure(ACCOUNT, tenantId, tenantName);
    log(`  ${e.code.padEnd(6)} ${e.shortName}`);
  }

  // Bills addressed to another group company are intercompany.
  const intercoNames = new Set(ORGS.flatMap(([, n]) => [n.toLowerCase(), n.replace(/ Sdn Bhd$/, '').toLowerCase()]));
  intercoNames.add('ayu borneo (lbu) sdn bhd'); // a group company not connected here

  let i = 0;
  for (const [tenantId, status, reference, contact, total, paid, date, due, attach] of INVOICES) {
    i += 1;
    await bills.upsertFromXero(ACCOUNT, tenantId, {
      InvoiceID: '00000000-0000-0000-0000-' + String(i).padStart(12, '0'),
      Type: 'ACCPAY',
      InvoiceNumber: `INV-${1000 + i}`,
      Reference: reference,
      Contact: { ContactID: `c${i}`.padEnd(36, '0'), Name: contact },
      Status: status,
      Date: xdate(date),
      DueDate: xdate(due),
      FullyPaidOnDate: status === 'PAID' ? xdate('2026-08-28') : null,
      CurrencyCode: 'MYR',
      CurrencyRate: 1,
      SubTotal: total, TotalTax: 0, Total: total,
      AmountPaid: paid, AmountDue: total - paid, AmountCredited: 0,
      HasAttachments: attach,
      UpdatedDateUTC: `/Date(${Date.parse('2026-09-10T08:00:00Z') + i * 1000}+0000)/`
    }, {
      isInterco: intercoNames.has(contact.trim().toLowerCase()),
      attachmentCount: attach ? 1 : 0
    });
  }
  // ── Bank files fixtures ───────────────────────────────────────────────────
  await bankFormats.seedBuiltIns();

  // Paying accounts, shaped like Xero's BANK accounts.
  const BANKS = [
    ['tenant-abm',  'acct-abm-mbb',  '090', 'Maybank Current 5142', '514212345678', 'maybank-m2e-csv'],
    ['tenant-abm',  'acct-abm-cimb', '091', 'CIMB Operating 8830',  '883099887766', 'generic-csv'],
    ['tenant-abkk', 'acct-abkk-mbb', '090', 'Maybank Current 7781', '778154321098', 'maybank-m2e-csv'],
    // Deliberately left without a format, to exercise the fallback.
    ['tenant-abkj', 'acct-abkj-mbb', '090', 'Maybank Current 3320', '332011223344', null]
  ];
  for (const [tenantId, xeroAccountId, code, name, number, formatKey] of BANKS) {
    await bankAccounts.upsertFromXero(ACCOUNT, tenantId, {
      AccountID: xeroAccountId, Code: code, Name: name,
      BankAccountNumber: number, CurrencyCode: 'MYR', BankAccountType: 'BANK', Status: 'ACTIVE'
    });
    const row = (await bankAccounts.listByAccount(ACCOUNT, { tenantId })).find((b) => b.xero_account_id === xeroAccountId);
    if (row) {
      await bankAccounts.update(ACCOUNT, row.id, {
        formatKey,
        bankName: name.split(' ')[0],
        isDefault: name.includes('5142') || name.includes('7781') || name.includes('3320')
      });
    }
  }

  // Supplier bank details, as Xero's free-text field tends to look. One
  // supplier is deliberately left blank.
  const PAYEE_DETAILS = {
    'Simon Chim': '5121-9988-7766',
    'Setia Awan Supplies Sdn Bhd': 'Maybank 114455662200',
    'Shell Malaysia Trading': '  5566778899  ',
    'Grab Malaysia': '998877665544',
    'Telekom Malaysia': '223344556677',
    'Sabah Electricity Sdn Bhd': '667788990011',
    'Harvey Norman Malaysia': '445566778899',
    'KWSP EPF': '94781727',
    'Maybank Berhad': '111122223333',
    'Ayu Borneo (LBU) Sdn Bhd': '555566667777',
    'Some Supplier': null   // no bank details in Xero
  };
  let i2 = 0;
  for (const [tenantId, , , contact] of INVOICES) {
    i2 += 1;
    await payees.upsertFromXero(ACCOUNT, tenantId, {
      ContactID: `c${i2}`.padEnd(36, '0'),
      Name: contact,
      BankAccountDetails: PAYEE_DETAILS[contact] || null
    });
  }

  log(`Seeded ${INVOICES.length} invoices across ${ORGS.length} organisations.`);
  log(`Bank files: ${BANKS.length} paying accounts, ${Object.keys(PAYEE_DETAILS).length} payees.`);
  log(`WazzOCR fixture: database "${DB_NAME}", account ${WAZZOCR_ACCOUNT}, grant ${grantId}.`);
}

module.exports = { seed, reset, ACCOUNT, WAZZOCR_ACCOUNT, ORGS, INVOICES };

// Run as a script: node test/seed.js
if (require.main === module) {
  seed()
    .then(() => db.close())
    .catch((e) => { console.error(e); process.exit(1); });
}
