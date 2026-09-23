// Read-only readiness check, module by module.
//
//   node scripts/smoke.js
//
// Says what is working, what is missing, and what to do about it. Every call is
// a GET — it creates nothing in Xero and changes nothing in the database, so it
// is safe to run against production.
require('dotenv').config();
const db = require('../db');
const grantSource = require('../lib/grantSource');
const xero = require('../lib/xero');
const xc = require('../models/xeroConnections');
const entities = require('../models/entities');
const digestModel = require('../models/digest');
const rechargeModel = require('../models/recharge');

const ACCOUNT = Number(process.env.DEFAULT_ACCOUNT_ID) || 1;

const ok = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
const no = (m, hint) => { console.log(`  \x1b[31mno\x1b[0m    ${m}`); if (hint) console.log(`        → ${hint}`); };
const note = (m) => console.log(`  ·     ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

const blockers = [];
function blocked(module, why) { blockers.push(`${module}: ${why}`); }

(async () => {
  console.log(`\nBills Hub smoke test — ${grantSource.describe()}\n`);

  // ── Connection ────────────────────────────────────────────────────────────
  head('Xero connection');
  const connAccountId = await grantSource.connectionsAccountId(ACCOUNT);
  const conns = (await xc.listByAccount(connAccountId)).filter((c) => c.status === 'active');
  if (!conns.length) {
    no('no organisation connected', 'open the app and press Connect Xero');
    await finish();
    return;
  }
  ok(`${conns.length} organisation(s) connected`);
  for (const c of conns) note(`${c.tenant_name}  ${c.xero_tenant_id}`);

  const tenant = conns[0].xero_tenant_id;

  // Prove each scope by making the cheapest real read against it. A scope the
  // grant lacks fails here rather than halfway through a payment run.
  head('Scopes, proven by calling the endpoints');
  const probes = [
    ['accounting.invoices', '/Invoices?page=1&pageSize=1&summaryOnly=true', 'Bills, submit/approve, recharge'],
    ['accounting.contacts', '/Contacts?page=1', 'Payee details, recharge counterparties'],
    ['accounting.settings.read', '/Accounts?where=' + encodeURIComponent('Type=="BANK"'), 'Bank accounts to pay from'],
    ['accounting.payments', '/BatchPayments?page=1', 'Paying a bank-file batch']
  ];
  const scopeOk = {};
  for (const [scope, path, what] of probes) {
    try {
      await xero.api(ACCOUNT, tenant, path);
      scopeOk[scope] = true;
      ok(`${scope.padEnd(26)} ${what}`);
    } catch (e) {
      scopeOk[scope] = false;
      no(`${scope.padEnd(26)} ${e.message}`,
        e.statusCode === 403
          ? 'the grant does not carry this scope — reconnect with it added'
          : null);
    }
  }

  // ── Bills ─────────────────────────────────────────────────────────────────
  head('Bills');
  const ents = await entities.listByAccount(ACCOUNT, connAccountId);
  ok(`${ents.length} organisation(s) included: ${ents.map((e) => e.code).join(', ') || '—'}`);

  const counts = await db.getOne(
    `SELECT COUNT(*) AS n,
            SUM(xero_status = 'DRAFT') AS draft,
            SUM(xero_status = 'SUBMITTED') AS submitted,
            SUM(xero_status = 'AUTHORISED' AND amount_due > 0) AS payable,
            SUM(xero_status = 'PAID') AS paid
       FROM bills WHERE account_id = ?`, [ACCOUNT]);
  const n = (v) => Number(v || 0);
  if (!n(counts?.n)) {
    no('no bills synced yet', 'npm run sync, or press Sync Xero in the app');
    blocked('Bills', 'nothing synced');
  } else {
    ok(`${n(counts.n)} bill(s) synced`);
    note(`${n(counts.draft)} draft · ${n(counts.submitted)} awaiting approval · ${n(counts.payable)} payable · ${n(counts.paid)} paid`);
    if (!n(counts.draft)) note('no drafts — create one in Xero to test Submit');
    if (!n(counts.submitted) && !n(counts.draft)) note('nothing to approve — submit a draft first');
  }

  // ── Bank files ────────────────────────────────────────────────────────────
  head('Bank files');
  const banks = await db.query('SELECT * FROM bank_accounts WHERE account_id = ? AND enabled = 1', [ACCOUNT]);
  if (!banks.length) {
    no('no paying accounts', 'POST /api/payments/sync, or press "Sync accounts & payees"');
    blocked('Bank files', 'no paying accounts');
  } else {
    ok(`${banks.length} paying account(s)`);
    const unset = banks.filter((b) => !b.format_key);
    if (unset.length) note(`${unset.length} without a file format — they fall back to generic-csv`);
  }

  const payees = await db.getOne(
    "SELECT COUNT(*) AS total, SUM(account_number IS NULL OR account_number = '') AS missing FROM payees WHERE account_id = ?",
    [ACCOUNT]);
  if (n(payees?.total)) {
    ok(`${n(payees.total)} payee(s) known`);
    if (n(payees.missing)) note(`${n(payees.missing)} have no bank account number — those lines would be blank in a file`);
  } else {
    note('no payees yet — run the payments sync');
  }
  if (!n(counts?.payable)) {
    note('no approved, unpaid bill to pay — approve one first');
    blocked('Bank files', 'nothing payable');
  }
  if (!scopeOk['accounting.payments']) blocked('Bank files', 'missing accounting.payments scope');

  // ── Notifications ─────────────────────────────────────────────────────────
  head('Notifications');
  const ds = await digestModel.getSettings(ACCOUNT);
  if (ds.channel_id && ds.api_key) ok('Wazzup channel configured');
  else { no('no Wazzup channel', 'set WAZZUP_CHANNEL_ID and WAZZUP_API_KEY'); blocked('Notifications', 'no channel'); }
  const recipients = await digestModel.listRecipients(ACCOUNT);
  const active = recipients.filter((r) => r.enabled).length;
  if (active) ok(`${active} active recipient(s) of ${recipients.length}`);
  else { no('no active recipients', 'add one in the Notifications tab'); blocked('Notifications', 'no recipients'); }
  note(ds.enabled ? 'the schedule is ON' : 'the schedule is off — "Send digest now" still works');

  // ── Recharge ──────────────────────────────────────────────────────────────
  head('Recharge');
  const rs = await rechargeModel.getSettings(ACCOUNT);
  if (rs.ar_account_code && rs.ap_account_code) ok(`account codes set: AR ${rs.ar_account_code}, AP ${rs.ap_account_code}`);
  else { no('account codes not set', 'Recharge tab → Account codes'); blocked('Recharge', 'no account codes'); }

  if (ents.length < 2) {
    no(`only ${ents.length} organisation connected`,
      'a recharge posts into TWO organisations. Create a free Xero trial org and add it in the same consent.');
    blocked('Recharge', 'needs a second organisation');
  } else {
    ok(`${ents.length} organisations — enough to recharge between`);
  }
  const rules = await rechargeModel.listRules(ACCOUNT);
  note(`${rules.filter((r) => r.enabled).length} active rule(s) of ${rules.length}`);
  if (!n(counts?.paid)) note('no paid bill to recharge — pay one first');

  await finish();

  async function finish() {
    head('Summary');
    if (!blockers.length) console.log('  Everything is ready to test.\n');
    else {
      console.log('  Ready except:\n');
      for (const b of blockers) console.log(`    · ${b}`);
      console.log('\n  See docs/TEST-PLAN.md for the order to work through.\n');
    }
    await db.close();
  }
})().catch(async (err) => {
  console.error('\nsmoke test FAILED:', err.message, '\n');
  try { await db.close(); } catch { /* already closed */ }
  process.exit(1);
});
