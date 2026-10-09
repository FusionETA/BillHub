// Put back the paid dates the sync used to blank.
//
//   node scripts/repair-paid-dates.js            report
//   node scripts/repair-paid-dates.js --write    repair
//
// Xero's summaryOnly response carries neither FullyPaidOnDate nor a
// populated Payments array, and the sync wrote the missing value straight
// through. So Bills Hub would record the date when it paid a bill and the
// next sync, minutes later, would wipe it. The Bills tab's Paid column and
// its paid-date filter were empty across whole accounts.
//
// models/bills.js no longer blanks it. This is the one-off repair for rows
// that already lost it — a data fix, not a schema change, which is why it
// is a script rather than a migration adjustment: a migration has to be a
// no-op the second time it runs, and "is there anything left to repair" is
// not a question about the shape of the database.
//
// Only Bills Hub's own payments can be recovered: it knows when it marked
// those paid. A bill settled directly in Xero left no record here and stays
// blank, which is honest — the date is in Xero.
require('../lib/env');
const db = require('../db');

(async () => {
  const write = process.argv.includes('--write');

  const recoverable = await db.query(
    `SELECT b.account_id, COUNT(*) AS n
       FROM bills b
      WHERE b.fully_paid_on IS NULL AND b.marked_paid_at IS NOT NULL
      GROUP BY b.account_id`
  );
  const stranded = await db.getOne(
    `SELECT COUNT(*) AS n FROM bills
      WHERE fully_paid_on IS NULL AND marked_paid_at IS NULL AND xero_status = 'PAID'`
  );

  const total = recoverable.reduce((sum, r) => sum + Number(r.n), 0);
  console.log(`\n${total} paid bill(s) have a date Bills Hub can put back.`);
  for (const r of recoverable) console.log(`   account ${r.account_id}: ${r.n}`);
  console.log(`${Number(stranded?.n || 0)} were paid straight in Xero, so there is nothing here to`);
  console.log('put back — those keep their date in Xero and show blank in Bills Hub.');

  if (!total) { console.log('\nNothing to do.\n'); await db.close(); return; }
  if (!write) {
    console.log('\nRun again with --write to repair them.\n');
    await db.close();
    return;
  }

  const res = await db.execute(
    `UPDATE bills SET fully_paid_on = DATE(marked_paid_at)
      WHERE fully_paid_on IS NULL AND marked_paid_at IS NOT NULL`
  );
  console.log(`\nRepaired ${res.affectedRows} bill(s). A sync will no longer blank them.\n`);
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
