// Runs a bill sync from the command line — useful from cron, or for the first
// full backfill right after connecting Xero.
//   node scripts/sync-bills.js              all accounts, incremental
//   node scripts/sync-bills.js --full       ignore cursors, re-read everything
//   node scripts/sync-bills.js --account 1
require('../lib/env');
const db = require('../db');
const sync = require('../billhub/sync');

(async () => {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const idx = args.indexOf('--account');
  const only = idx > -1 ? Number(args[idx + 1]) : null;

  const accounts = only
    ? [{ id: only }]
    : await db.query("SELECT id, name FROM accounts WHERE status <> 'suspended'");

  for (const a of accounts) {
    const t0 = Date.now();
    const result = await sync.syncAccount(a.id, { full });
    console.log(`account ${a.id}: ${result.upserted} bill(s) from ${result.tenants} org(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const r of result.results.filter((x) => !x.ok)) {
      console.log(`  ! ${r.tenantName || r.tenantId}: ${r.error}`);
    }
  }
  await db.close();
})().catch((err) => {
  console.error('Sync FAILED:', err.message);
  process.exit(1);
});
