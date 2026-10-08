// What the recharge rules would do, without doing any of it.
//
//   npm run recharge-preview
//   npm run recharge-preview -- --supplier "Tenaga Nasional"
//   npm run recharge-preview -- --entity ABM --limit 60
//   npm run recharge-preview -- --text --supplier "Tenaga Nasional"
//
// Read-only, all the way down. It creates no runs, writes nothing to Bills
// Hub and sends nothing to Xero — safe to point at a live account whatever
// testing mode is set to.
//
// Two questions it answers:
//
//   1. Which paid bills would be recharged, and where to. Run it before
//      drafting anything, so the first thing a rule does is not a surprise.
//
//   2. --text: what Bills Hub can actually SEE on each bill. A Xero bill has
//      no premises address field, so an address rule can only match what
//      WazzOCR read off the document, or what somebody typed into the
//      reference or the line descriptions. This says which of those exist in
//      real data, per supplier, rather than in theory.
require('../lib/env');
const db = require('../db');
const recharge = require('../billhub/recharge');
const model = require('../models/recharge');
const premises = require('../lib/premises');
const entityRef = require('../lib/entityRef');

const ACCOUNT_ID = Number(process.env.DEMO_ACCOUNT_ID || process.env.BILLHUB_ACCOUNT_ID || 1);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

// Things that look like part of a Malaysian premises address. Deliberately
// loose: the job here is to say "there is something here worth reading", not
// to decide where a cost belongs — that is what the rules are for, and they
// match on an address somebody wrote, not on a guess.
const POSTCODE = /\b\d{5}\b/;
const STREET = /\b(jalan|jln|lorong|lrg|lot|taman|wisma|kilang|bangunan|persiaran|kampung|kg|no\.?\s*\d|tingkat|blok|block|level|unit)\b/i;

function looksLikeAddress(text) {
  const t = String(text || '');
  return POSTCODE.test(t) || STREET.test(t);
}

const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

(async () => {
  const limit = Number(arg('limit', 60));
  const supplier = arg('supplier');
  const entity = arg('entity');

  const rules = await recharge.loadRules(ACCOUNT_ID);
  console.log(`\nAccount ${ACCOUNT_ID}: ${rules.address.length} address rule(s), ${rules.text.length} recharge rule(s).`);
  if (!rules.address.length && !rules.text.length) {
    console.log('No rules yet, so nothing would be recharged. Add one on the Recharge tab.\n');
  }

  let tenantId = null;
  if (entity) {
    const ent = await db.getOne('SELECT xero_tenant_id FROM entities WHERE account_id = ? AND code = ?',
      [ACCOUNT_ID, entity]);
    if (!ent) { console.error(`No entity with the code "${entity}".`); process.exit(1); }
    tenantId = ent.xero_tenant_id;
  }
  // Both filters go into the query. Narrowing a page of results afterwards
  // would report three bills where the answer is three hundred.
  const matching = await recharge.candidateBills(ACCOUNT_ID, { limit: 5000, supplier, tenantId });
  const bills = matching.slice(0, limit);
  if (matching.length > bills.length) {
    console.log(`${matching.length} paid, un-recharged bill(s) match; reading the most recent ${bills.length}.`);
    console.log('Raise --limit to read more (each one costs a Xero call).');
  }

  if (!bills.length) {
    console.log('No paid, un-recharged bills match that.\n');
    await db.close();
    return;
  }

  // ── What is actually readable on a bill ──────────────────────────────────
  if (has('text')) {
    console.log(`\nWhat Bills Hub can see on ${bills.length} paid bill(s)`);
    console.log('─'.repeat(78));
    console.log('A Xero bill carries no premises address field. These are the only places');
    console.log('an address can come from, so this is what an address rule has to match.\n');

    const tally = { read: 0, reference: 0, lines: 0, nothing: 0 };
    const samples = [];
    for (const b of bills) {
      const stored = String(b.premises_address || '').trim();
      // Reads the bill back from Xero one at a time — the list sync is
      // summaryOnly, so line items are not held locally.
      const { text } = await recharge.premisesText(ACCOUNT_ID, b);
      const refText = `${b.reference || ''} ${b.invoice_number || ''}`;
      const lineText = text.replace(refText, '').replace(stored, '').trim();

      let where;
      if (stored) { tally.read += 1; where = 'read off the document'; }
      else if (looksLikeAddress(refText)) { tally.reference += 1; where = 'in the reference'; }
      else if (looksLikeAddress(lineText)) { tally.lines += 1; where = 'in the line items'; }
      else { tally.nothing += 1; where = 'no street address on it'; }

      if (samples.length < 12) {
        samples.push({ b, where, refText: refText.trim(), lineText, stored });
      }
    }

    const n = bills.length;
    const pct = (v) => `${String(v).padStart(4)}  ${String(Math.round((v / n) * 100)).padStart(3)}%`;
    console.log(`  premises read off the document   ${pct(tally.read)}   (WazzOCR writes this)`);
    console.log(`  address-like text in the reference ${pct(tally.reference)}`);
    console.log(`  address-like text in the line items${pct(tally.lines)}`);
    console.log(`  no street address anywhere on it  ${pct(tally.nothing)}`);

    console.log('\n  What is actually on them:');
    for (const s of samples) {
      console.log(`\n    ${s.b.contact_name || '(no supplier)'} · ${s.b.reference || s.b.invoice_number || s.b.id}`);
      console.log(`      address  ${s.where}`);
      if (s.stored) console.log(`      premises "${clip(s.stored, 68)}"`);
      if (s.refText) console.log(`      ref      "${clip(s.refText, 68)}"`);
      if (s.lineText) console.log(`      lines    "${clip(s.lineText, 68)}"`);
    }

    // The pattern Ayu Borneo actually uses: one Xero contact per meter,
    // "Tenaga Nasional Berhad - TD 11-1". The premises is in the supplier
    // name, so there is nothing to match an address against and nothing
    // wrong with that — it just means a different kind of rule.
    const names = [...new Set(matching.map((b) => b.contact_name).filter(Boolean))];
    const sharedPrefix = entityRef.commonPrefix(names);
    const perPremises = names.length > 1 && sharedPrefix.length >= 6;

    console.log('\n  Reading this:');
    if (tally.read) {
      console.log(`   · ${tally.read} bill(s) carry an address somebody read off the document.`);
      console.log('     Those are ready for an address rule today.');
    }
    if (tally.reference || tally.lines) {
      console.log(`   · ${tally.reference + tally.lines} have address-like text in the reference or`);
      console.log('     the line items. An address rule works on those if it is written');
      console.log('     exactly as the text above spells it.');
    }
    if (perPremises) {
      console.log(`\n   · ${names.length} different Xero contacts here share the name "${sharedPrefix.trim()}":`);
      for (const n of names.slice(0, 14)) {
        console.log(`       ${n}   (${matching.filter((b) => b.contact_name === n).length} paid bill(s))`);
      }
      if (names.length > 14) console.log(`       … and ${names.length - 14} more`);
      console.log('\n     That is one contact per premises, so the premises is already in');
      console.log('     the supplier name. Nothing to match an address against, and');
      console.log('     nothing wrong with that — use a recharge rule instead:');
      console.log('');
      console.log(`         Supplier  is exactly  "${names[0]}"   →  the entity that occupies it`);
      console.log('');
      console.log('     "is exactly" rather than "contains": a code like TD 11-1 is also');
      console.log('     inside TD 11-10, and that mistake pays the wrong company.');
    } else if (tally.nothing === bills.length) {
      console.log('   · None of them carries anything an address rule could match.');
      console.log('     Use a recharge rule: match the supplier, the reference, the');
      console.log('     line description or a tracking category instead.');
    }
    console.log('');
    await db.close();
    return;
  }

  // ── What the rules would decide ──────────────────────────────────────────
  const groups = new Map();
  for (const b of bills) {
    const v = await recharge.decide(ACCOUNT_ID, b, { rules });
    if (!groups.has(v.outcome)) groups.set(v.outcome, []);
    groups.get(v.outcome).push({ bill: b, verdict: v });
  }

  const ORDER = [
    ['recharge', 'Would be recharged'],
    ['own', 'No recharge — the entity that paid owns it'],
    ['out-of-scope', 'A rule covers it, but it was paid before that rule starts'],
    ['no-rule', 'No rule covers it'],
    ['unpaid', 'Not paid']
  ];

  console.log(`Checked ${bills.length} paid, un-recharged bill(s). Nothing was written.\n`);

  for (const [key, title] of ORDER) {
    const rows = groups.get(key) || [];
    if (!rows.length) continue;
    console.log(`${title} — ${rows.length}`);
    console.log('─'.repeat(78));
    for (const { bill, verdict } of rows) {
      const total = Number(bill.total).toLocaleString('en-MY', { minimumFractionDigits: 2 });
      console.log(`  ${pad(clip(bill.contact_name, 26), 27)}${pad(clip(bill.reference || bill.invoice_number, 16), 17)}${total.padStart(12)}`
        + (verdict.ownerCode ? `  → ${verdict.ownerCode}` : ''));
      if (key !== 'recharge' || process.argv.includes('--why')) {
        console.log(`    ${clip(verdict.reason, 70)}`);
      }
    }
    console.log('');
  }

  const would = (groups.get('recharge') || []);
  if (would.length) {
    const sum = would.reduce((n, x) => n + Number(x.bill.total), 0);
    console.log(`${would.length} bill(s), ${sum.toLocaleString('en-MY', { minimumFractionDigits: 2 })} in total, would move between companies.`);
    console.log('Nothing has happened. Draft them on the Recharge tab when the list looks right.\n');
  }

  const misses = (groups.get('no-rule') || []).filter((x) => x.verdict.nearMiss);
  if (misses.length) {
    console.log(`${misses.length} bill(s) have a rule for their supplier whose premises did not match.`);
    console.log('That is usually an address typed one way in the rule and another on the bill —');
    console.log('run again with --text --supplier "<name>" to see what the bill actually says.\n');
  }

  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
