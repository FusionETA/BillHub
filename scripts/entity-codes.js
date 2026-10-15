// Set each organisation's short code from a list somebody maintains.
//
//   node scripts/entity-codes.js templates/local/entity-codes.csv
//   node scripts/entity-codes.js templates/local/entity-codes.csv --apply
//
// A CSV of two columns, name and code. The name is matched against the
// organisation name Xero gives and against the short name shown here,
// ignoring case, punctuation and "Sdn Bhd" — which is on every row and
// distinguishes nothing.
//
// Reports and changes nothing without --apply. Refuses to apply at all
// while any row is unmatched or ambiguous, rather than doing the forty it
// understood and leaving three nobody is told about.
//
// The code is what every screen shows beside a bill. What a BANK FILE and a
// recharge reference carry is a shorter form, and for a name ending in
// brackets that form comes from the NAME, not from this code — see
// lib/entityRef.js. So the table below prints both, because changing a code
// and expecting a reference to follow is the mistake this is for avoiding.
require('../lib/env');
const fs = require('fs');
const db = require('../db');
const entities = require('../models/entities');
const grantSource = require('../lib/grantSource');
const entityRef = require('../lib/entityRef');

const ACCOUNT_ID = Number(process.env.DEMO_ACCOUNT_ID || 1);
const apply = process.argv.includes('--apply');
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));

// "Ayu Borneo (AP) Sdn Bhd" and "Ayu Borneo (AP)" are the same company.
const key = (s) => String(s || '')
  .toLowerCase()
  .replace(/\b(sdn|bhd|berhad|sendirian)\b/g, '')
  .replace(/[^a-z0-9]+/g, '');

function readCsv(path) {
  const text = fs.readFileSync(path, 'utf8');
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Good enough for two columns: a company name may carry a comma inside
    // quotes, and nothing here has a quoted comma in the code.
    const m = /^\s*("([^"]*)"|[^,]*)\s*,\s*("([^"]*)"|.*?)\s*$/.exec(line);
    if (!m) continue;
    const name = (m[2] !== undefined ? m[2] : m[1]).trim();
    const code = (m[4] !== undefined ? m[4] : m[3]).trim();
    if (!name || !code) continue;
    if (/^name$/i.test(name)) continue;          // header
    rows.push({ name, code });
  }
  return rows;
}

(async () => {
  if (!file) {
    console.log('\nGive it a CSV of name,code:\n');
    console.log('  node scripts/entity-codes.js templates/local/entity-codes.csv\n');
    process.exitCode = 1;
    await db.close();
    return;
  }

  const wanted = readCsv(file);
  if (!wanted.length) throw new Error(`No name,code rows in ${file}.`);

  const connAccountId = await grantSource.connectionsAccountId(ACCOUNT_ID);
  const live = await entities.listByAccount(ACCOUNT_ID, connAccountId, { includedOnly: false });

  // Index both names an organisation answers to.
  const byKey = new Map();
  for (const e of live) {
    for (const n of [e.tenant_name, e.short_name]) {
      const k = key(n);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, new Set());
      byKey.get(k).add(e);
    }
  }

  const plan = [];
  const problems = [];
  const seen = new Map();
  for (const row of wanted) {
    if (seen.has(row.code.toUpperCase())) {
      problems.push(`"${row.code}" is given twice — to ${seen.get(row.code.toUpperCase())} and ${row.name}`);
    }
    seen.set(row.code.toUpperCase(), row.name);

    const hit = byKey.get(key(row.name));
    if (!hit || !hit.size) { problems.push(`no organisation here is called "${row.name}"`); continue; }
    if (hit.size > 1) {
      problems.push(`"${row.name}" matches ${hit.size} organisations: ${[...hit].map((e) => e.code).join(', ')}`);
      continue;
    }
    plan.push({ entity: [...hit][0], code: row.code.trim().toUpperCase().slice(0, 16) });
  }

  const codes = plan.map((p) => p.code);
  console.log(`\n${plan.length} of ${wanted.length} row(s) matched an organisation here.\n`);
  const w = (s, n) => String(s == null ? '' : s).padEnd(n);
  console.log(`  ${w('ORGANISATION', 38)}${w('CODE', 16)}${w('→ NEW', 16)}${w('REFERENCE', 12)}→ NEW`);
  for (const p of plan) {
    const before = entityRef.short(p.entity, live.map((e) => e.code));
    const after = entityRef.short({ ...p.entity, code: p.code }, codes);
    const changed = p.entity.code !== p.code;
    console.log(`  ${w((p.entity.short_name || p.entity.tenant_name || '').slice(0, 36), 38)}`
      + `${w(p.entity.code, 16)}${w(changed ? p.code : '(same)', 16)}`
      + `${w(before, 12)}${before === after ? '(same)' : after}`);
  }

  const spaced = plan.filter((p) => /\s/.test(p.code));
  if (spaced.length) {
    console.log(`\n  ⚠  ${spaced.length} code(s) contain a space: ${spaced.map((p) => `"${p.code}"`).join(', ')}`);
    console.log('     A code is written into bank file references. Check the bank accepts');
    console.log('     a space there before relying on it.');
  }

  const refSame = plan.filter((p) => {
    const before = entityRef.short(p.entity, live.map((e) => e.code));
    return p.entity.code !== p.code && before === entityRef.short({ ...p.entity, code: p.code }, codes);
  });
  if (refSame.length) {
    console.log(`\n  Note: ${refSame.length} organisation(s) keep the same reference, because their`);
    console.log('  name ends in brackets and lib/entityRef.js reads the suffix from the name.');
    console.log('  The new code shows on screen; the bank file and the recharge keep the old one.');
  }

  const untouched = live.filter((e) => !plan.some((p) => p.entity.xero_tenant_id === e.xero_tenant_id));
  if (untouched.length) {
    console.log(`\n  ${untouched.length} organisation(s) here are not in the file, and are left alone:`);
    untouched.forEach((e) => console.log(`    ${e.code}  ${e.short_name || e.tenant_name}`));
  }

  if (problems.length) {
    console.log(`\n  ${problems.length} problem(s):`);
    problems.forEach((p) => console.log(`    ${p}`));
    console.log('\n  Nothing was changed. Fix the file and run it again —  applying the rows');
    console.log('  it understood would leave the rest wrong and unreported.\n');
    process.exitCode = 1;
    await db.close();
    return;
  }

  if (!apply) {
    console.log('\n  Dry run. Add --apply to write these codes.\n');
    await db.close();
    return;
  }

  let changed = 0;
  for (const p of plan) {
    if (p.entity.code === p.code) continue;
    await entities.update(ACCOUNT_ID, p.entity.xero_tenant_id, { code: p.code });
    changed += 1;
  }
  console.log(`\n  ${changed} code(s) updated.\n`);
  await db.close();
})().catch(async (e) => { console.error('\nFAILED:', e.message, '\n'); await db.close(); process.exit(1); });
