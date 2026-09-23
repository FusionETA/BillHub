// Checks everything a real sync needs, before running one.
//
//   node scripts/preflight.js            read-only; touches Xero not at all
//   node scripts/preflight.js --xero     also does ONE real Xero call
//
// The default run is safe against production: it reads WazzOCR's tables, proves
// the UPDATE privilege with a no-op inside a rolled-back transaction, and shows
// the entity codes that would be derived from the real organisation names.
// Nothing is written and no token is rotated.
//
// --xero refreshes the shared token to call /connections. That ROTATES WazzOCR's
// refresh token (Xero invalidates the old one on use). It is the same thing
// WazzOCR itself does many times a day and the new token is saved back, but run
// it when nobody is pushing bills through WazzOCR, and take a backup first:
//   SELECT id, refresh_token FROM wazzocr.xero_grants;
require('dotenv').config();
const db = require('../db');
const entities = require('../models/entities');
const accounts = require('../models/accounts');
const { GRANTS, CONNECTIONS, WAZZOCR_DB: DB_NAME, BORROWED } = require('../lib/grantSource');

let problems = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, hint) => { problems += 1; console.log(`  FAIL  ${m}`); if (hint) console.log(`        → ${hint}`); };

(async () => {
  const withXero = process.argv.includes('--xero');

  console.log(`\nBills Hub preflight — database "${process.env.DB_NAME}", WazzOCR schema "${DB_NAME}"\n`);

  console.log('Configuration');
  for (const key of ['DB_HOST', 'DB_NAME', 'APP_ENCRYPTION_KEY', 'XERO_CLIENT_ID', 'XERO_CLIENT_SECRET']) {
    if (process.env[key]) ok(`${key} is set`);
    else bad(`${key} is not set`, 'see .env.example');
  }
  if (/not-real|placeholder|changeme/i.test(process.env.XERO_CLIENT_SECRET || '')) {
    bad('XERO_CLIENT_SECRET looks like a placeholder', "copy the real one from WazzOCR's .env");
  }
  if (String(process.env.AUTH_DISABLED).toLowerCase() === 'true') {
    console.log('  note  AUTH_DISABLED=true — no sign-in. Fine locally; not for a public host.');
  }

  console.log('\nOwn database');
  try { await db.ping(); ok('connected'); }
  catch (err) { bad(`cannot connect: ${err.message}`); await finish(); return; }

  const tables = await db.query('SHOW TABLES');
  const names = tables.map((t) => Object.values(t)[0]);
  for (const t of ['accounts', 'entities', 'bills', 'bill_sync_state']) {
    if (names.includes(t)) ok(`table ${t}`);
    else bad(`table ${t} is missing`, 'run npm run db:migrate');
  }

  console.log(`\nWazzOCR's Xero tables (${DB_NAME})`);
  let connections = [];
  try {
    connections = await db.query(`SELECT * FROM ${CONNECTIONS}`);
    ok(`SELECT on xero_connections — ${connections.length} row(s)`);
  } catch (err) {
    bad(`cannot read ${CONNECTIONS}: ${err.code || err.message}`,
        `GRANT SELECT ON \`${DB_NAME}\`.\`xero_connections\` TO '${process.env.DB_USER}'@'%';`);
  }

  let grants = [];
  try {
    grants = await db.query(`SELECT id, account_id, scope FROM ${GRANTS}`);
    ok(`SELECT on xero_grants — ${grants.length} grant(s)`);
  } catch (err) {
    bad(`cannot read ${GRANTS}: ${err.code || err.message}`,
        `GRANT SELECT, UPDATE ON \`${DB_NAME}\`.\`xero_grants\` TO '${process.env.DB_USER}'@'%';`);
  }

  // Prove UPDATE without changing anything: assign the column to itself, then
  // roll back. Needs the privilege, leaves no trace either way.
  if (grants.length) {
    try {
      await db.transaction(async (conn) => {
        await conn.execute(`UPDATE ${GRANTS} SET refresh_token = refresh_token WHERE id = ?`, [grants[0].id]);
        throw new Error('__rollback__');
      });
    } catch (err) {
      if (err.message === '__rollback__') ok('UPDATE on xero_grants (no-op, rolled back)');
      else bad(`no UPDATE on ${GRANTS}: ${err.code || err.message}`,
               `GRANT UPDATE ON \`${DB_NAME}\`.\`xero_grants\` TO '${process.env.DB_USER}'@'%';`);
    }
  }

  console.log('\nEncryption key');
  if (grants.length) {
    const xc = require('../models/xeroConnections');
    const sample = connections.find((c) => c.status === 'active');
    if (!sample) {
      bad('no active connection to test the key against');
    } else {
      try {
        const g = await xc.getGrantForTenant(sample.account_id, sample.xero_tenant_id);
        // Never print the token; its length is enough to show it decrypted.
        if (g && g.refreshToken) ok(`APP_ENCRYPTION_KEY decrypts the token (${g.refreshToken.length} chars)`);
        else bad('could not load the grant for an active connection');
      } catch (err) {
        bad(err.message, "copy APP_ENCRYPTION_KEY from WazzOCR's .env — do not generate a new one");
      }
    }
  }

  console.log('\nAccount mapping');
  const localAccounts = await db.query('SELECT id, name, wazzocr_account_id FROM accounts ORDER BY id');
  if (!localAccounts.length) bad('no Bills Hub account', 'npm run create-account "<name>" <email> <wazzocrAccountId>');
  const byWazzocr = new Map();
  for (const c of connections) byWazzocr.set(c.account_id, (byWazzocr.get(c.account_id) || 0) + 1);
  for (const a of localAccounts) {
    if (a.wazzocr_account_id == null) {
      bad(`account ${a.id} "${a.name}" has no wazzocr_account_id`,
          `candidates in ${DB_NAME}: ${[...byWazzocr.entries()].map(([id, n]) => `${id} (${n} orgs)`).join(', ') || 'none'}`);
    } else if (!byWazzocr.has(a.wazzocr_account_id)) {
      bad(`account ${a.id} points at WazzOCR account ${a.wazzocr_account_id}, which has no connections`,
          `candidates: ${[...byWazzocr.entries()].map(([id, n]) => `${id} (${n} orgs)`).join(', ') || 'none'}`);
    } else {
      ok(`account ${a.id} "${a.name}" → WazzOCR account ${a.wazzocr_account_id} (${byWazzocr.get(a.wazzocr_account_id)} orgs)`);
    }
  }

  console.log('\nOrganisations that would sync, and their derived codes');
  for (const a of localAccounts.filter((x) => x.wazzocr_account_id != null)) {
    let list = [];
    try { list = await entities.listSyncable(a.id, a.wazzocr_account_id); } catch (err) { bad(err.message); continue; }
    if (!list.length) { bad(`account ${a.id} has no syncable organisations`); continue; }
    console.log(`  account ${a.id}: ${list.length} organisation(s)`);
    const seen = new Map();
    for (const t of list) {
      const code = t.code || entities.codeFrom(t.tenant_name);
      const short = t.short_name || entities.shortNameFrom(t.tenant_name);
      seen.set(code, (seen.get(code) || 0) + 1);
      console.log(`      ${code.padEnd(8)} ${short.padEnd(30)} ${t.code ? '' : '(would be created)'}`);
    }
    const clashes = [...seen.entries()].filter(([, n]) => n > 1);
    if (clashes.length) {
      console.log(`  note  ${clashes.length} code(s) would collide and get a numeric suffix: ${clashes.map(([c]) => c).join(', ')}`);
    }
  }

  if (withXero) {
    console.log('\nLive Xero call  (this rotates the shared refresh token)');
    const xero = require('../lib/xero');
    const target = localAccounts.find((a) => a.wazzocr_account_id != null);
    const conn = connections.find((c) => c.account_id === (target && target.wazzocr_account_id) && c.status === 'active');
    if (!target || !conn) {
      bad('nothing to call with — fix the problems above first');
    } else {
      try {
        const token = await xero.accessTokenFor(target.id, conn.xero_tenant_id);
        ok('refreshed the shared grant and got an access token');
        const live = await xero.fetchTenants(token);
        ok(`Xero reports ${live.length} organisation(s) reachable with this token`);
        const known = new Set(connections.filter((c) => c.status === 'active').map((c) => c.xero_tenant_id));
        const missing = live.filter((t) => !known.has(t.tenantId));
        if (missing.length) {
          console.log(`  note  ${missing.length} org(s) Xero allows but WazzOCR has not recorded: ${missing.map((t) => t.tenantName).join(', ')}`);
          console.log('        reconnect in WazzOCR to pick them up.');
        } else {
          ok('WazzOCR\'s connection list matches what Xero allows');
        }
        const scopes = (grants[0] && grants[0].scope) || '';
        if (scopes && !/accounting\.transactions/.test(scopes)) {
          bad(`the grant's scopes do not include accounting.transactions: "${scopes}"`,
              'submit/approve will fail; add the scope in Xero and reconnect in WazzOCR');
        } else if (scopes) {
          ok('the grant includes accounting.transactions (submit/approve will work)');
        }
      } catch (err) {
        bad(`Xero call failed: ${err.message}`);
      }
    }
  } else {
    console.log('\n  (skipped the live Xero call — add --xero to include it)');
  }

  await finish();

  async function finish() {
    console.log(problems ? `\n${problems} problem(s) to fix before syncing.\n` : '\nAll checks passed.\n');
    await db.close();
    process.exit(problems ? 1 : 0);
  }
})().catch(async (err) => {
  console.error('\npreflight FAILED:', err.message, '\n');
  try { await db.close(); } catch { /* already closed */ }
  process.exit(1);
});
