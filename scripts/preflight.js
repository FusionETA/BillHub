// Checks everything a real sync needs, before running one.
//
//   node scripts/preflight.js            read-only; touches Xero not at all
//   node scripts/preflight.js --xero     also does ONE real Xero call
//
// What it checks depends on XERO_GRANT_SOURCE:
//
//   own       Bills Hub's own tables, its own consent. Self-contained.
//   wazzocr   WazzOCR's tables, borrowed. The default run is the stage-2 dry
//             run: it proves the cross-database GRANTs, proves the encryption
//             key decrypts WazzOCR's token, and reads the granted SCOPES off
//             the stored grant — all without a single Xero call, so WazzOCR's
//             refresh token is not rotated and its live pipeline is untouched.
//
// --xero refreshes the grant to call /connections. In `wazzocr` mode that
// ROTATES WazzOCR's refresh token (Xero invalidates the old one on use). It is
// the same thing WazzOCR itself does many times a day and the new token is
// saved back, but run it when nobody is pushing bills through WazzOCR, and take
// a backup first:
//   SELECT id, refresh_token FROM wazzocr.xero_grants;
require('dotenv').config();
const db = require('../db');
const entities = require('../models/entities');
const grantSource = require('../lib/grantSource');
const xero = require('../lib/xero');

const { GRANTS, CONNECTIONS, WAZZOCR_DB: DB_NAME, BORROWED } = grantSource;

let problems = 0;
let warnings = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, hint) => { problems += 1; console.log(`  FAIL  ${m}`); if (hint) console.log(`        → ${hint}`); };
const warn = (m, hint) => { warnings += 1; console.log(`  warn  ${m}`); if (hint) console.log(`        → ${hint}`); };
const note = (m) => console.log(`  note  ${m}`);

// Whose tables these are, in words, so `own` mode never claims to have proved
// something about WazzOCR that it has not looked at.
const STORE = BORROWED ? `WazzOCR's Xero tables (${DB_NAME})` : "Bills Hub's own Xero tables";

(async () => {
  const withXero = process.argv.includes('--xero');

  console.log(`\nBills Hub preflight — database "${process.env.DB_NAME}", ${grantSource.describe()}\n`);

  console.log('Configuration');
  for (const key of ['DB_HOST', 'DB_NAME', 'APP_ENCRYPTION_KEY', 'XERO_CLIENT_ID', 'XERO_CLIENT_SECRET']) {
    if (process.env[key]) ok(`${key} is set`);
    else bad(`${key} is not set`, 'see .env.example');
  }
  if (/not-real|placeholder|changeme/i.test(process.env.XERO_CLIENT_SECRET || '')) {
    bad('XERO_CLIENT_SECRET looks like a placeholder',
        BORROWED ? "copy the real one from WazzOCR's .env" : 'copy it from your own Xero app');
  }
  if (String(process.env.AUTH_DISABLED).toLowerCase() === 'true') {
    warn('AUTH_DISABLED=true — no sign-in at all.', 'fine on localhost; never on a public host');
  }

  // A borrowed grant reaches every live organisation. The allowlist is the only
  // thing that makes a write structurally impossible, so its absence is a
  // finding here rather than a footnote.
  if (BORROWED) {
    if (xero.ALLOWLIST) ok(`XERO_TENANT_ALLOWLIST limits writes to ${xero.ALLOWLIST.size} organisation(s)`);
    else warn('XERO_TENANT_ALLOWLIST is empty, on a borrowed grant',
              'writes would be allowed to every live organisation — set it while testing');
  }

  console.log('\nOwn database');
  try { await db.ping(); ok('connected'); }
  catch (err) { bad(`cannot connect: ${err.message}`); await finish(); return; }

  const tables = (await db.query('SHOW TABLES')).map((t) => Object.values(t)[0]);
  for (const t of ['accounts', 'entities', 'bills', 'bill_sync_state']) {
    if (tables.includes(t)) ok(`table ${t}`);
    else bad(`table ${t} is missing`, 'run npm run db:migrate');
  }

  console.log(`\n${STORE}`);
  let connections = [];
  try {
    connections = await db.query(`SELECT * FROM ${CONNECTIONS}`);
    ok(`SELECT on xero_connections — ${connections.length} row(s)`);
  } catch (err) {
    bad(`cannot read ${CONNECTIONS}: ${err.code || err.message}`,
        BORROWED ? `GRANT SELECT ON \`${DB_NAME}\`.\`xero_connections\` TO '${process.env.DB_USER}'@'%';` : 'run npm run db:migrate');
  }

  let grants = [];
  try {
    grants = await db.query(`SELECT id, account_id, scope FROM ${GRANTS}`);
    ok(`SELECT on xero_grants — ${grants.length} grant(s)`);
  } catch (err) {
    bad(`cannot read ${GRANTS}: ${err.code || err.message}`,
        BORROWED ? `GRANT SELECT, UPDATE ON \`${DB_NAME}\`.\`xero_grants\` TO '${process.env.DB_USER}'@'%';` : 'run npm run db:migrate');
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

  // ── Scopes, read off the stored grant ─────────────────────────────────────
  // No Xero call: the scope string was recorded at consent. This is the check
  // that decides whether switching to a borrowed grant costs a feature, and it
  // is free to run.
  console.log('\nScopes on the stored grant');
  if (!grants.length) {
    note('no grant to read scopes from');
  } else {
    const recorded = grants.map((g) => String(g.scope || '')).filter(Boolean);
    if (!recorded.length) {
      warn('the grant records no scope string', 'older grants predate the column — prove them with --xero instead');
    } else {
      const all = recorded.join(' ');
      if (/\baccounting\.transactions\b/.test(all)) {
        note('this grant uses the broad accounting.transactions scope (an app predating March 2026)');
      }
      const absent = new Set(xero.missingScopes(all).map(([s]) => s));
      for (const [scope, what] of xero.SCOPES_REQUIRED) {
        if (!absent.has(scope)) ok(`${scope.padEnd(26)} ${what}`);
        else {
          bad(`${scope.padEnd(26)} MISSING — needed for ${what}`,
              BORROWED
                ? `add ${scope} to WazzOCR's XERO_SCOPES, deploy it, and reconnect Xero IN WAZZOCR`
                : `add ${scope} to XERO_SCOPES and reconnect`);
        }
      }
    }
  }

  console.log('\nEncryption key');
  if (grants.length) {
    const xc = require('../models/xeroConnections');
    const sample = connections.find((c) => c.status === 'active');
    if (!sample) bad('no active connection to test the key against');
    else {
      try {
        const g = await xc.getGrantForTenant(sample.account_id, sample.xero_tenant_id);
        // Never print the token; its length is enough to show it decrypted.
        if (g && g.refreshToken) ok(`APP_ENCRYPTION_KEY decrypts the token (${g.refreshToken.length} chars)`);
        else bad('could not load the grant for an active connection');
      } catch (err) {
        bad(err.message, BORROWED
          ? "copy APP_ENCRYPTION_KEY from WazzOCR's .env — do not generate a new one"
          : 'the key has changed since you connected — reconnect Xero');
      }
    }
  }

  console.log('\nAccounts');
  const localAccounts = await db.query('SELECT id, name, wazzocr_account_id FROM accounts ORDER BY id');
  if (!localAccounts.length) {
    bad('no Bills Hub account', `npm run create-account "<name>" <email>${BORROWED ? ' <wazzocrAccountId>' : ''}`);
  }
  const byConnAccount = new Map();
  for (const c of connections) byConnAccount.set(c.account_id, (byConnAccount.get(c.account_id) || 0) + 1);
  const candidates = () => [...byConnAccount.entries()].map(([id, n]) => `${id} (${n} orgs)`).join(', ') || 'none';

  for (const a of localAccounts) {
    if (!BORROWED) {
      // The mapping is a `wazzocr` mode concept; in own mode it is correctly null.
      const n = byConnAccount.get(a.id) || 0;
      if (n) ok(`account ${a.id} "${a.name}" — ${n} organisation(s) connected`);
      else warn(`account ${a.id} "${a.name}" has no Xero connection`, 'press Connect Xero in the header');
      if (a.wazzocr_account_id != null) {
        note(`account ${a.id} has wazzocr_account_id ${a.wazzocr_account_id}, unused in own mode`);
      }
    } else if (a.wazzocr_account_id == null) {
      bad(`account ${a.id} "${a.name}" has no wazzocr_account_id`,
          `candidates in ${DB_NAME}: ${candidates()}`);
    } else if (!byConnAccount.has(a.wazzocr_account_id)) {
      bad(`account ${a.id} points at WazzOCR account ${a.wazzocr_account_id}, which has no connections`,
          `candidates: ${candidates()}`);
    } else {
      ok(`account ${a.id} "${a.name}" → WazzOCR account ${a.wazzocr_account_id} (${byConnAccount.get(a.wazzocr_account_id)} orgs)`);
    }
  }

  console.log('\nOrganisations that would sync, and their derived codes');
  for (const a of localAccounts) {
    let connAccountId;
    try { connAccountId = await grantSource.connectionsAccountId(a.id); }
    catch { continue; }   // already reported above as a missing mapping
    let list = [];
    try { list = await entities.listSyncable(a.id, connAccountId); }
    catch (err) { bad(err.message); continue; }
    if (!list.length) { warn(`account ${a.id} has no syncable organisations`); continue; }
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
      note(`${clashes.length} code(s) would collide and get a numeric suffix: ${clashes.map(([c]) => c).join(', ')}`);
    }
  }

  if (withXero) {
    console.log(`\nLive Xero call${BORROWED ? '  (this rotates WazzOCR\'s shared refresh token)' : ''}`);
    const target = localAccounts[0];
    let connAccountId = null;
    try { connAccountId = target && await grantSource.connectionsAccountId(target.id); } catch { /* reported above */ }
    const conn = connections.find((c) => c.account_id === connAccountId && c.status === 'active');
    if (!target || !conn) bad('nothing to call with — fix the problems above first');
    else {
      try {
        const token = await xero.accessTokenFor(target.id, conn.xero_tenant_id);
        ok('refreshed the grant and got an access token');
        const live = await xero.fetchTenants(token);
        ok(`Xero reports ${live.length} organisation(s) reachable with this token`);
        const known = new Set(connections.filter((c) => c.status === 'active').map((c) => c.xero_tenant_id));
        const missing = live.filter((t) => !known.has(t.tenantId));
        if (missing.length) {
          note(`${missing.length} org(s) Xero allows but the connections table has not recorded: ${missing.map((t) => t.tenantName).join(', ')}`);
          console.log(`        → reconnect ${BORROWED ? 'in WazzOCR' : 'here'} to pick them up`);
        } else ok('the connections table matches what Xero allows');
      } catch (err) {
        bad(`Xero call failed: ${err.message}`);
      }
    }
  } else {
    console.log('\n  (skipped the live Xero call — add --xero to include it)');
  }

  await finish();

  async function finish() {
    const bits = [];
    if (problems) bits.push(`${problems} problem(s)`);
    if (warnings) bits.push(`${warnings} warning(s)`);
    console.log(bits.length ? `\n${bits.join(', ')}.\n` : '\nAll checks passed.\n');
    await db.close();
    process.exit(problems ? 1 : 0);
  }
})().catch(async (err) => {
  console.error('\npreflight FAILED:', err.message, '\n');
  try { await db.close(); } catch { /* already closed */ }
  process.exit(1);
});
