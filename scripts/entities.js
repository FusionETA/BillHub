// Which Xero organisations Bills Hub works with.
//
//   node scripts/entities.js list                 show every connected org
//   node scripts/entities.js only <CODE|id> ...   include ONLY these, exclude the rest
//   node scripts/entities.js include <CODE|id>    put one back
//   node scripts/entities.js exclude <CODE|id>    take one out
//   node scripts/entities.js code <CODE|id> <NEW> rename an org's short code
//
// `only` is what makes a test deployment safe: point it at the Demo Company and
// nothing else is synced or shown. Pair it with XERO_TENANT_ALLOWLIST, which
// refuses Xero *writes* outside the list no matter what the database says.
require('dotenv').config();
const db = require('../db');
const entities = require('../models/entities');
const accounts = require('../models/accounts');

const ACCOUNT = Number(process.env.DEFAULT_ACCOUNT_ID) || 1;

function resolve(rows, key) {
  const needle = String(key).trim().toLowerCase();
  return rows.find((r) =>
    (r.code || '').toLowerCase() === needle
    || r.xero_tenant_id.toLowerCase() === needle
    || (r.short_name || '').toLowerCase() === needle);
}

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  const wazzocrAccountId = await accounts.wazzocrIdFor(ACCOUNT);
  const rows = await entities.listByAccount(ACCOUNT, wazzocrAccountId, { includedOnly: false });

  if (!rows.length) {
    console.log('No organisations yet. Connect Xero in WazzOCR, then run a sync.');
    return;
  }

  const show = () => {
    const allowlist = String(process.env.XERO_TENANT_ALLOWLIST || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    console.log(`\n${rows.length} organisation(s) for account ${ACCOUNT}:\n`);
    for (const r of rows) {
      const inc = r.included ? ' ' : 'x';
      const writable = !allowlist.length || allowlist.includes(r.xero_tenant_id) ? '' : '  (read-only here)';
      console.log(` [${inc}] ${String(r.code || '—').padEnd(8)} ${String(r.short_name || r.tenant_name).padEnd(32)} ${r.xero_tenant_id}${writable}`);
    }
    const excluded = rows.filter((r) => !r.included).length;
    console.log(`\n${rows.length - excluded} included, ${excluded} excluded.`);
    if (allowlist.length) console.log(`XERO_TENANT_ALLOWLIST permits writes to ${allowlist.length} organisation(s).`);
    console.log('');
  };

  if (!cmd || cmd === 'list') { show(); return; }

  if (cmd === 'only') {
    if (!args.length) throw new Error('Name at least one organisation to keep.');
    const keep = new Set();
    for (const a of args) {
      const row = resolve(rows, a);
      if (!row) throw new Error(`No organisation matches "${a}".`);
      keep.add(row.xero_tenant_id);
    }
    for (const r of rows) {
      await entities.update(ACCOUNT, r.xero_tenant_id, { included: keep.has(r.xero_tenant_id) });
      r.included = keep.has(r.xero_tenant_id) ? 1 : 0;
    }
    console.log(`Included ${keep.size}, excluded ${rows.length - keep.size}.`);
    console.log('Bills Hub will now sync and show only those. To stop writes to the others entirely, set:');
    console.log(`  XERO_TENANT_ALLOWLIST=${[...keep].join(',')}`);
    show();
    return;
  }

  if (cmd === 'include' || cmd === 'exclude') {
    const row = resolve(rows, args[0]);
    if (!row) throw new Error(`No organisation matches "${args[0]}".`);
    await entities.update(ACCOUNT, row.xero_tenant_id, { included: cmd === 'include' });
    console.log(`${row.code} ${cmd === 'include' ? 'included' : 'excluded'}.`);
    return;
  }

  if (cmd === 'code') {
    const row = resolve(rows, args[0]);
    if (!row) throw new Error(`No organisation matches "${args[0]}".`);
    if (!args[1]) throw new Error('Give the new code.');
    await entities.update(ACCOUNT, row.xero_tenant_id, { code: args[1] });
    console.log(`${row.code} renamed to ${args[1].toUpperCase()}.`);
    return;
  }

  throw new Error(`Unknown command "${cmd}". Try: list | only | include | exclude | code`);
})()
  .then(() => db.close())
  .catch(async (err) => {
    console.error('FAILED:', err.message);
    try { await db.close(); } catch { /* already closed */ }
    process.exit(1);
  });
