// What the recharge rules would do, without doing any of it.
//
//   npm run recharge-preview
//   npm run recharge-preview -- --supplier "Tenaga Nasional"
//   npm run recharge-preview -- --entity ABM --limit 60
//   npm run recharge-preview -- --suppliers --supplier "Tenaga Nasional"
//   npm run recharge-preview -- --addresses --supplier "Tenaga Nasional"
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
const xero = require('../lib/xero');
const model = require('../models/recharge');
const premises = require('../lib/premises');

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

// Among a set of premises codes, the first pair where one is a prefix of
// another — "TD 11-1" inside "TD 11-10". A `contains` rule written for the
// shorter one claims the longer one's bills too, and pays the wrong company.
// Naming the real pair beats warning in the abstract.
function shortestAmbiguous(members) {
  const codes = members.map((m) => m.premises);
  for (const a of codes) {
    const b = codes.find((c) => c !== a && c.startsWith(a));
    if (b) return `"${a}" is also inside "${b}"`;
  }
  return null;
}

// The premises code inside a reference.
//
// Ayu Borneo's TNB references are the meter's account number, then the
// premises: "006975997185-TS-17-M", "000323819565-HQ-J-28-02". The premises
// itself contains hyphens, so the split is after the account number — a run
// of ten or more digits — not at the first hyphen. Some are written with
// spaces around the dash instead, "001170153115 - TD 11-1", so both.
//
// Returns null rather than guessing when there is no account number to split
// on: a reference this cannot read is one somebody has to look at, and
// saying so beats inventing a premises for it.
function premisesFromReference(reference) {
  const ref = String(reference || '').trim();
  const withAccount = /^\s*\d{10,}\s*-\s*(.+)$/.exec(ref);
  if (withAccount) return withAccount[1].trim();
  const spaced = /^.*?\s+-\s+(.+)$/.exec(ref);
  if (spaced) return spaced[1].trim();
  return null;
}

// Does the supplier's Xero contact carry an address, and is it the premises?
//
// Worth asking, because a Xero contact has an Addresses block and it would
// be the tidiest place for a premises to live. The catch is whose address it
// is: for one contact billing many buildings it is the SUPPLIER's own —
// Tenaga Nasional's head office, the same on every bill, useless for
// deciding which building the electricity was for.
//
// But a contact created per meter ("Tenaga Nasional Berhad - TD 11-1") may
// well have the site address on it, because whoever set it up had nowhere
// else to put it. That is a question about real data, so this reads the
// contacts and reports rather than assuming either way.
//
// One call per 50 contacts, not per bill: contacts are fetched by id in
// batches, so this is cheap even against hundreds of them.
async function contactAddresses(accountId, rows) {
  const byTenant = new Map();
  for (const b of rows) {
    if (!b.contact_id) continue;
    if (!byTenant.has(b.xero_tenant_id)) byTenant.set(b.xero_tenant_id, new Map());
    byTenant.get(b.xero_tenant_id).set(b.contact_id, b.contact_name);
  }

  const out = [];
  for (const [tenantId, contacts] of byTenant) {
    const ids = [...contacts.keys()];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      try {
        const payload = await xero.api(accountId, tenantId, `/Contacts?IDs=${chunk.join(',')}`);
        for (const c of payload?.Contacts || []) {
          const street = (c.Addresses || []).find((a) => a.AddressType === 'STREET') || {};
          const parts = [street.AddressLine1, street.AddressLine2, street.AddressLine3,
            street.City, street.PostalCode].filter(Boolean);
          out.push({ name: c.Name, address: parts.join(', ') });
        }
      } catch (e) {
        console.error(`[preview] could not read contacts in ${tenantId}: ${e.message}`);
        for (const id of chunk) out.push({ name: contacts.get(id), address: null, failed: true });
      }
    }
  }
  return out;
}

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
  // Only --text reads bills back from Xero; the rest is local and complete.
  if (has('text') && matching.length > bills.length) {
    console.log(`${matching.length} paid, un-recharged bill(s) match; reading the most recent ${bills.length}.`);
    console.log('Raise --limit to read more (each one costs a Xero call).');
  }

  if (!bills.length) {
    console.log('No paid, un-recharged bills match that.\n');
    await db.close();
    return;
  }

  // ── What is actually readable on a bill ──────────────────────────────────
  // Who the suppliers are, and who has been paying them. Entirely local —
  // contact names are synced, so this costs no Xero call and covers every
  // matching bill rather than the handful --text can afford to read.
  //
  // On Ayu Borneo's TNB this is the whole answer: one contact per meter, so
  // the premises is already in the supplier name and the only question left
  // is which entity occupies each one.
  function supplierTable(rows) {
    const byName = new Map();
    for (const b of rows) {
      const name = b.contact_name || '(no supplier)';
      if (!byName.has(name)) byName.set(name, { bills: 0, payers: new Map(), samples: [] });
      const e = byName.get(name);
      e.bills += 1;
      // The reference is synced, so showing it is free — and on a contact
      // whose name carries no premises it is the only place one can be.
      const ref = (b.reference || b.invoice_number || '').trim();
      if (ref && e.samples.length < 3 && !e.samples.includes(ref)) e.samples.push(ref);
      e.payers.set(b.entity_code || b.xero_tenant_id, (e.payers.get(b.entity_code || b.xero_tenant_id) || 0) + 1);
    }
    return [...byName.entries()]
      .map(([name, e]) => ({
        name, bills: e.bills, payers: [...e.payers.keys()], samples: e.samples
      }))
      .sort((a, b) => b.bills - a.bills || a.name.localeCompare(b.name));
  }

  // "Tenaga Nasional Berhad - TD 11-1" — one Xero contact per meter, with the
  // premises after a dash. Worth naming, because it means the premises is
  // already in the supplier and there is no address to go looking for.
  //
  // Not entityRef.commonPrefix: that refuses a prefix which would empty one
  // of its inputs, and here the plain "Tenaga Nasional Berhad" sitting
  // alongside its own suffixed variants is the very thing being detected.
  function perPremisesGroups(table) {
    const groups = new Map();
    for (const t of table) {
      const m = /^(.+?)\s+-\s+(.+)$/.exec(t.name);
      if (!m) continue;
      const base = m[1].trim();
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push({ ...t, premises: m[2].trim() });
    }
    return [...groups.entries()]
      .filter(([, members]) => members.length >= 2)
      .sort((a, b) => b[1].length - a[1].length);
  }

  if (has('addresses')) {
    const found = await contactAddresses(ACCOUNT_ID, matching);
    const failed = found.filter((f) => f.failed);
    const read = found.filter((f) => !f.failed);
    const withAddress = read.filter((f) => f.address);
    const distinct = new Set(withAddress.map((f) => f.address));

    console.log(`\n${found.length} supplier contact(s), ${read.length} read from Xero`);
    console.log('─'.repeat(78));
    if (failed.length) console.log(`  could not be read        ${String(failed.length).padStart(4)}`);
    console.log(`  carry a street address   ${String(withAddress.length).padStart(4)} / ${read.length}`);
    console.log(`  distinct addresses       ${String(distinct.size).padStart(4)}`);
    console.log('');
    for (const f of found.slice(0, 24)) {
      console.log(`  ${clip(f.name, 44)}`);
      console.log(`      ${f.failed ? '(could not read)' : (f.address || '(no street address on the contact)')}`);
    }
    if (found.length > 24) console.log(`  … and ${found.length - 24} more`);

    console.log('\n  Reading this:');
    // "None of them has an address" and "none of them could be read" are
    // different answers, and reporting the first when the second is true is
    // how a report talks somebody out of an option that was open.
    if (!read.length) {
      console.log('   · None of them could be read, so this says nothing either way.');
      console.log('     Those organisations have no working Xero connection here.');
    } else if (!withAddress.length) {
      console.log('   · None of them has one, so there is nothing here for an address');
      console.log('     rule to match. Use a recharge rule on the reference instead.');
    } else if (distinct.size === 1 && found.length > 1) {
      console.log(`   · All of them share one address — "${clip([...distinct][0], 48)}".`);
      console.log('     That is the supplier\'s own address, not the premises being billed,');
      console.log('     so it cannot say which building a bill is for. A recharge rule on');
      console.log('     the reference is what distinguishes them.');
    } else if (distinct.size === withAddress.length) {
      console.log(`   · ${distinct.size} contacts, ${distinct.size} different addresses — one per contact.`);
      console.log('     That looks like the premises rather than the supplier, which means');
      console.log('     address rules would work on these. Check a couple against the real');
      console.log('     bills before trusting it.');
    } else {
      console.log(`   · ${withAddress.length} contacts share ${distinct.size} address(es). Partly the supplier\'s own and`);
      console.log('     partly per-premises, so neither rule type covers all of them alone.');
    }
    console.log('');
    await db.close();
    return;
  }

  if (has('suppliers')) {
    const table = supplierTable(matching);
    console.log(`\n${table.length} supplier contact(s) across ${matching.length} paid, un-recharged bill(s)`);
    console.log('─'.repeat(78));
    for (const t of table) {
      console.log(`\n  ${clip(t.name, 60)}`);
      console.log(`    ${t.bills} paid bill(s) · paid by ${clip(t.payers.join(' '), 60)}`);
      // Where the premises has to be, if it is not in the contact name.
      for (const r of t.samples) console.log(`    ref  "${clip(r, 62)}"`);
    }

    const groups = perPremisesGroups(table);
    for (const [base, members] of groups) {
      console.log(`\n  ${members.length} of these are "${base} - <premises>".`);
      console.log('  The premises is already in the supplier name, so there is no address');
      console.log('  to go looking for. Each needs a recharge rule, and the only thing');
      console.log('  left to decide is which entity occupies it:');
      console.log('');
      console.log(`      Supplier  is exactly  "${members[0].name}"   →  ?`);
      console.log('');
      const clash = shortestAmbiguous(members);
      if (clash) console.log(`  "is exactly", not "contains" — ${clash}.`);
      else console.log('  Prefer "is exactly": a short premises code is often inside a longer one.');
    }
    // The shape that actually dominates: a handful of generic contacts
    // carrying most of the bills, with the premises somewhere in the
    // reference instead. Worth saying how much of the total that is, so a
    // pattern covering 2% is not mistaken for the answer.
    const named = groups.reduce((n, [, m]) => n + m.reduce((x, t) => x + t.bills, 0), 0);
    const generic = matching.length - named;
    if (generic > 0) {
      const pc = Math.round((generic / matching.length) * 100);
      console.log(`\n  ${generic} of the ${matching.length} bill(s) — ${pc}% — are on a contact whose name`);
      console.log('  carries no premises. For those the premises can only be in the');
      console.log('  reference, so the rule goes on the reference instead:');

      // Their references read "<account number> - <premises>", so the
      // premises is the tail. "ends with" pins it there, which "contains"
      // does not: a reference ending "WM Hostel 1-20" contains "WM Hostel
      // 1-2" and a contains rule would claim it.
      // How many distinct premises are in those references — which is how
      // many rules this comes to, and the only number that says whether
      // this is ten minutes of typing or an import.
      const byPremises = new Map();
      const unreadable = [];
      for (const b of matching) {
        if (/\s+-\s+/.test(b.contact_name || '')) continue;   // premises is in the name
        const code = premisesFromReference(b.reference || b.invoice_number);
        if (!code) { unreadable.push(b); continue; }
        byPremises.set(code, (byPremises.get(code) || 0) + 1);
      }
      const premisesList = [...byPremises.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

      if (premisesList.length) {
        console.log(`\n  ${premisesList.length} distinct premises in those references:`);
        for (const [code, n] of premisesList.slice(0, 30)) {
          console.log(`      ${pad(code, 26)}${String(n).padStart(4)} bill(s)`);
        }
        if (premisesList.length > 30) console.log(`      … and ${premisesList.length - 30} more`);

        const first = premisesList[0][0];
        console.log('');
        console.log(`      Reference  ends with  "-${first}"   →  the entity that occupies it`);
        console.log('');
        console.log('  "ends with" rather than "contains", and keep the leading dash: it');
        console.log('  pins the premises to the end of the reference, where it is.');
        console.log(`\n  That is ${premisesList.length} rule(s) — one per premises. If that is more than you`);
        console.log('  want to type, the mapping of premises to entity can be imported');
        console.log('  from a spreadsheet instead.');
      }
      if (unreadable.length) {
        console.log(`\n  ${unreadable.length} reference(s) have no account number to split on, so the`);
        console.log('  premises could not be read out of them. A few to look at:');
        for (const b of unreadable.slice(0, 5)) {
          console.log(`      "${clip(b.reference || b.invoice_number || '(none)', 56)}"`);
        }
      }
    }
    if (new Set(table.flatMap((t) => t.payers)).size > 3) {
      console.log('\n  These are paid by several entities. Only the ones paid by a company');
      console.log('  that does not occupy the premises need recharging at all — narrow');
      console.log('  with --entity <CODE> to the company that pays on behalf of others.');
    }
    console.log('');
    await db.close();
    return;
  }

  if (has('text')) {
    // Printed before the slow part. Reading line items costs a Xero call per
    // bill, and on Ayu Borneo's TNB the supplier list answers the question
    // on its own — there is no sense making anyone wait for forty reads to
    // find that out.
    const groups = perPremisesGroups(supplierTable(matching));
    if (groups.length) {
      console.log(`\n${groups[0][1].length} supplier contacts here are "${groups[0][0]} - <premises>".`);
      console.log('That is the answer on its own: run with --suppliers to see them all.');
      console.log('Reading the bills below only confirms there is no street address too.\n');
    }

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
    if (groups.length) {
      console.log(`   · ${groups[0][1].length} contacts are "${groups[0][0]} - <premises>", so the premises`);
      console.log('     is in the supplier name and there is no address to look for.');
      console.log('     --suppliers lists them with who has been paying each one.');
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
      // The reference gets the room, because on these bills it is where the
      // premises is and the premises is the whole question.
      console.log(`  ${pad(clip(bill.contact_name, 22), 23)}${pad(clip(bill.reference || bill.invoice_number, 28), 29)}${total.padStart(11)}`
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
