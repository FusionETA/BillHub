// Turn supplier rules into recharge rules, then retire them.
//
//   node scripts/convert-supplier-rules.js            report
//   node scripts/convert-supplier-rules.js --write    convert
//
// A supplier rule was "this contact, that entity". A recharge rule with one
// condition — supplier is "…" — says exactly the same thing, and says a great
// deal more besides, so there is no longer a reason for two kinds. This moves
// the rules across rather than leaving them to stop working quietly.
//
// Two differences between the kinds have to be handled, or a converted rule
// does not behave like the one it replaces:
//
//   Order.  Supplier rules were consulted BEFORE every recharge rule. A
//           converted one therefore takes position -1, ahead of the lot, so a
//           broad rule written earlier cannot start claiming its bills.
//
//   Scope.  A recharge rule only acts on bills marked paid AFTER it was
//           written; a supplier rule had no such limit. The converted rule
//           inherits the original's created_at, so the set of bills it covers
//           does not move under anybody.
//
// Suppliers match with `is` rather than `contains`: a supplier rule matched
// the contact exactly, and "Tenaga Nasional Berhad" as a contains rule would
// swallow every per-premises contact named after it.
require('../lib/env');
const db = require('../db');

async function main() {
  const write = process.argv.includes('--write');

  const rules = await db.query(
    `SELECT r.*, e.code AS owner_code
       FROM recharge_rules r
       LEFT JOIN entities e ON e.account_id = r.account_id AND e.xero_tenant_id = r.owner_tenant_id
      ORDER BY r.account_id, r.id`
  );
  if (!rules.length) { console.log('\nNo supplier rules. Nothing to convert.\n'); return; }

  const sup = await db.query(
    'SELECT rule_id, supplier_name FROM recharge_rule_suppliers ORDER BY supplier_name');
  const byRule = new Map();
  for (const x of sup) {
    if (!byRule.has(x.rule_id)) byRule.set(x.rule_id, []);
    byRule.get(x.rule_id).push(x.supplier_name);
  }

  console.log(`\n${rules.length} supplier rule(s):\n`);
  const doable = [];
  for (const r of rules) {
    const names = byRule.get(r.id) || [];
    const why = !names.length ? 'no supplier — it already matched nothing'
      : !r.owner_tenant_id ? 'no entity to recharge to'
      : null;
    console.log(`  #${r.id}  ${names.join(', ') || '(no supplier)'} → ${r.owner_code || '?'}`
      + `${r.reference_contains ? `  [ref contains "${r.reference_contains}"]` : ''}`
      + `${r.enabled ? '' : '  (off)'}`);
    if (why) console.log(`        skipped: ${why}`);
    else doable.push({ rule: r, names });
  }

  if (!doable.length) { console.log('\nNothing convertible.\n'); return; }
  if (!write) {
    console.log(`\n${doable.length} would become recharge rules. Re-run with --write.\n`);
    return;
  }

  let made = 0;
  for (const { rule, names } of doable) {
    const name = names.length === 1 ? names[0] : `${names[0]} + ${names.length - 1} more`;
    const conditions = [
      ...names.map((n) => ({ field: 'supplier', operator: 'is', value: n })),
      ...(rule.reference_contains
        ? [{ field: 'reference', operator: 'contains', value: rule.reference_contains }] : [])
    ];
    // Several suppliers on one rule meant "any of these", and a reference
    // narrowed it — which cannot both be said in one match mode. Those are
    // listed rather than converted, because guessing would be worse.
    if (names.length > 1 && rule.reference_contains) {
      console.log(`\n  #${rule.id} names ${names.length} suppliers AND a reference.`);
      console.log('      "any supplier" and "and this reference" cannot both hold in one');
      console.log('      rule, so this one is left for you to write by hand.');
      continue;
    }
    const mode = names.length > 1 ? 'any' : 'all';

    await db.transaction(async (conn) => {
      const [res] = await conn.execute(
        `INSERT INTO recharge_text_rules
           (account_id, name, match_mode, payer_tenant_id, owner_tenant_id, enabled, position, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [rule.account_id, name.slice(0, 120), mode, null, rule.owner_tenant_id,
         rule.enabled ? 1 : 0, -1, rule.created_at]
      );
      let i = 0;
      for (const c of conditions) {
        await conn.execute(
          'INSERT INTO recharge_text_conditions (rule_id, field, operator, value, position) VALUES (?,?,?,?,?)',
          [res.insertId, c.field, c.operator, c.value, i]);
        i += 1;
      }
      // The old rule goes, so the two cannot both claim a bill. Its runs keep
      // rule_id pointing at a row that no longer exists, which is why the run
      // carries its own snapshot of the supplier and the reference.
      await conn.execute('DELETE FROM recharge_rule_suppliers WHERE rule_id = ?', [rule.id]);
      await conn.execute('DELETE FROM recharge_rules WHERE id = ?', [rule.id]);
      console.log(`  #${rule.id} → recharge rule #${res.insertId}  "${name}"`);
      made += 1;
    });
  }
  console.log(`\nConverted ${made}. Open the Recharge rules tab and read them.\n`);
}

main()
  .then(() => db.close())
  .catch(async (e) => { console.error('\nFAILED:', e.message, '\n'); await db.close(); process.exit(1); });
