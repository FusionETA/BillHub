// Tag a recharge run as one drafted while testing mode was on.
//
//   node scripts/mark-test-run.js              list recent runs and their tags
//   node scripts/mark-test-run.js 12           tag run 12
//   node scripts/mark-test-run.js 12 --off     take the tag off
//
// For runs made before made_in_test existed. The migration defaults it to 0
// because it cannot know which of them were tests, and guessing would be a
// migration with an opinion about history — so the few that matter are
// named here instead.
//
// Goes through the app's own database connection rather than the mysql
// client, so nobody has to find DB_PASSWORD to correct one row.
require('../lib/env');
const db = require('../db');

const ACCOUNT_ID = Number(process.env.DEFAULT_ACCOUNT_ID) || 1;
const argv = process.argv.slice(2);
const off = argv.includes('--off');
const id = Number(argv.find((a) => /^\d+$/.test(a)));

(async () => {
  if (!id) {
    const rows = await db.query(
      `SELECT r.id, r.bill_reference, r.supplier_name, r.status, r.made_in_test,
              r.recharge_total, r.created_at
         FROM recharge_runs r WHERE r.account_id = ? ORDER BY r.id DESC LIMIT 15`,
      [ACCOUNT_ID]);
    if (!rows.length) { console.log('\nNo recharge runs yet.\n'); await db.close(); return; }
    console.log('\nThe most recent recharge runs:\n');
    const w = (v, n) => String(v == null ? '' : v).padEnd(n);
    console.log(`  ${w('ID', 6)}${w('WHEN', 12)}${w('STATUS', 10)}${w('TAG', 7)}${w('AMOUNT', 12)}BILL`);
    for (const r of rows) {
      console.log(`  ${w(r.id, 6)}${w(r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '', 12)}${w(r.status, 10)}`
        + `${w(Number(r.made_in_test) ? 'TEST' : '', 7)}${w(Number(r.recharge_total).toFixed(2), 12)}`
        + `${r.bill_reference || ''} · ${r.supplier_name || ''}`);
    }
    // A real id from the list above, not <ID>. A placeholder gets pasted
    // verbatim, and bash reads the angle bracket as a redirect and fails
    // before node ever runs.
    const example = rows.find((r) => !Number(r.made_in_test)) || rows[0];
    console.log(`\n  Tag one with:  npm run mark-test-run -- ${example.id}`);
    console.log(`  Take it off:   npm run mark-test-run -- ${example.id} --off\n`);
    await db.close();
    return;
  }

  const run = await db.getOne(
    'SELECT id, bill_reference, supplier_name, made_in_test FROM recharge_runs WHERE account_id = ? AND id = ?',
    [ACCOUNT_ID, id]);
  if (!run) {
    console.log(`\nNo run ${id} on this account. Run it with no arguments to see the list.\n`);
    process.exitCode = 1;
    await db.close();
    return;
  }
  const want = off ? 0 : 1;
  if (Number(run.made_in_test) === want) {
    console.log(`\nRun ${id} is already ${want ? 'tagged TEST' : 'untagged'}. Nothing to do.\n`);
    await db.close();
    return;
  }
  await db.execute('UPDATE recharge_runs SET made_in_test = ? WHERE account_id = ? AND id = ?',
    [want, ACCOUNT_ID, id]);
  console.log(`\nRun ${id} (${run.bill_reference || ''} · ${run.supplier_name || ''}) is now `
    + `${want ? 'tagged TEST' : 'untagged'}.\n`);
  await db.close();
})().catch(async (e) => { console.error('\nFAILED:', e.message, '\n'); await db.close(); process.exit(1); });
