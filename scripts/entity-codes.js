// Set each organisation's short code from a list somebody maintains.
//
//   node scripts/entity-codes.js list.csv
//   node scripts/entity-codes.js list.csv --apply
//
// Or with no file at all, which is how to run it on a server without
// leaving a client's company list sitting on the disk:
//
//   node scripts/entity-codes.js --apply <<'CSV'
//   Ayu Borneo (AP) Sdn Bhd,AP
//   CSV
//
// A CSV of two columns, name and code. The name is matched against the
// organisation name Xero gives and against the short name shown here,
// ignoring case, punctuation and "Sdn Bhd" — which is on every row and
// distinguishes nothing.
//
// Reports and changes nothing without --apply. Refuses to apply at all
// while any row is unmatched, ambiguous, or would give two organisations
// the same bank reference — doing the forty it understood and leaving three
// nobody is told about is the failure worth preventing.
//
// The code is also what a bank file and a recharge reference carry, with
// spaces and punctuation removed. That is why two codes differing only in
// punctuation — "EM J" and "EMJ" — are a collision, and are refused.
require('../lib/env');
const fs = require('fs');
const db = require('../db');
const entities = require('../models/entities');
const grantSource = require('../lib/grantSource');
const entityRef = require('../lib/entityRef');

const ACCOUNT_ID = Number(process.env.DEMO_ACCOUNT_ID || 1);
const apply = process.argv.includes('--apply');
const file = process.argv.slice(2).find((a) => !a.startsWith('--') && a !== '-');

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
  });
}

// "Ayu Borneo (AP) Sdn Bhd" and "Ayu Borneo (AP)" are the same company.
const key = (s) => String(s || '')
  .toLowerCase()
  .replace(/\b(sdn|bhd|berhad|sendirian)\b/g, '')
  .replace(/[^a-z0-9]+/g, '');

function parseCsv(text) {
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
  // A file if one is named, otherwise whatever is piped in. The second is
  // the point on a server: the list never lands on the disk.
  const text = file ? fs.readFileSync(file, 'utf8')
    : (process.stdin.isTTY ? '' : await readStdin());
  if (!text.trim()) {
    console.log('\nGive it a CSV of name,code — as a file:\n');
    console.log('  node scripts/entity-codes.js list.csv\n');
    console.log('or on standard input, which leaves nothing behind:\n');
    console.log("  node scripts/entity-codes.js <<'CSV'");
    console.log('  Ayu Borneo (AP) Sdn Bhd,AP');
    console.log('  CSV\n');
    process.exitCode = 1;
    await db.close();
    return;
  }

  const wanted = parseCsv(text);
  if (!wanted.length) throw new Error('No name,code rows found.');

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
  // Padded to the widest value actually present, not to a guess. ABMANAGEMENT
  // is twelve characters and ran straight into the column beside it.
  const cell = (v, n) => `${String(v == null ? '' : v)}  `.padEnd(n + 2);
  const widest = (...vals) => Math.max(...vals.map((v) => String(v || '').length));
  const wCode = widest('CODE', ...plan.map((p) => p.entity.code));
  // '(same)' is six characters and lands in both of these columns.
  const wNew = widest('→ NEW', '(same)', ...plan.map((p) => p.code));
  const wRef = widest('REFERENCE', ...plan.map((p) => entityRef.short(p.entity)));
  const w = cell;
  console.log(`  ${w('ORGANISATION', 38)}${w('CODE', wCode)}${w('→ NEW', wNew)}${w('REFERENCE', wRef)}→ NEW`);
  for (const p of plan) {
    const before = entityRef.short(p.entity, live.map((e) => e.code));
    const after = entityRef.short({ ...p.entity, code: p.code }, codes);
    const changed = p.entity.code !== p.code;
    console.log(`  ${w((p.entity.short_name || p.entity.tenant_name || '').slice(0, 36), 38)}`
      + `${w(p.entity.code, wCode)}${w(changed ? p.code : '(same)', wNew)}`
      + `${w(before, wRef)}${before === after ? '(same)' : after}`);
  }

  const spaced = plan.filter((p) => /[^A-Za-z0-9]/.test(p.code));
  if (spaced.length) {
    console.log(`\n  Note: ${spaced.length} code(s) carry a space or punctuation —`
      + ` ${spaced.map((p) => `"${p.code}" → "${entityRef.short({ code: p.code })}"`).join(', ')}.`);
    console.log('  The screen shows the code as written; a bank reference cannot, so it is');
    console.log('  stripped there.');
  }

  // Two organisations that cannot be told apart on a bank statement is far
  // worse than a long reference, and the strip is what can collide two
  // codes that looked different on the page: "EM J" and "EMJ".
  const byRef = new Map();
  for (const p of plan) {
    const r = entityRef.short({ code: p.code });
    if (!byRef.has(r)) byRef.set(r, []);
    byRef.get(r).push(p);
  }
  for (const [r, group] of byRef) {
    if (group.length < 2) continue;
    problems.push(`${group.map((g) => `"${g.code}"`).join(' and ')} both become "${r}" in a `
      + `bank reference (${group.map((g) => g.entity.short_name || g.entity.tenant_name).join(', ')})`);
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
