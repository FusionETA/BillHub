// Matching the premises address printed on a supplier bill.
//
// A utility bill names the premises it is for, and that address — not the
// entity whose name is on the bill header — says whose cost it really is.
// Ayu Borneo Management pays a lot of bills for premises it does not occupy.
//
// The same address is never typed the same way twice:
//
//   Kilang Ayu Borneo, Jalan Reko, 43000 Kajang
//   KILANG AYU BORNEO JLN REKO 43000 KAJANG
//   Kilang Ayu Borneo , Jalan Reko , 43000 Kajang.
//
// So matching happens on a key with every separator removed, which makes
// spaces, commas, full stops and letter case irrelevant. Abbreviations
// ("Jalan" vs "Jln") are *not* equivalent here — guessing at those is how a
// bill gets charged to the wrong company, and the fix is to write the rule
// the way the bill prints it.

// Everything that is not a letter or a digit is noise. Keeping digits matters:
// a postcode and a lot number are often the only things separating two
// premises on the same street.
function normalise(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '');
}

// A rule's address has to carry enough to identify a premises. "Lot 3"
// normalises to "lot3", which appears inside "lot30", "lot35" and most
// industrial estates in the country — a rule that short would quietly recharge
// everything to one entity.
const MIN_KEY = 8;

function tooShort(value) {
  return normalise(value).length < MIN_KEY;
}

// Does the text on a bill carry this rule's premises?
//
// Containment rather than equality, because the address rarely arrives alone:
// it comes inside a line description like "Electricity — Kilang Ayu Borneo,
// Jalan Reko — Aug 2026", or with an account number in front of it. An exact
// match is reported separately so a caller can prefer it.
function match(billText, ruleAddress) {
  const key = normalise(ruleAddress);
  if (!key || key.length < MIN_KEY) return null;
  const hay = normalise(billText);
  if (!hay) return null;
  if (hay === key) return { exact: true, length: key.length };
  if (hay.includes(key)) return { exact: false, length: key.length };
  return null;
}

// The rule that best describes a bill's premises.
//
// Two rules can both match when one address sits inside another — a block and
// a unit within it, say. The longer address is the more specific statement
// about where this bill belongs, so it wins; an exact match beats a containment
// of the same length. Without this the winner would be whichever row the
// database happened to return first, which is not a decision anyone made.
function best(billText, rules, addressOf = (r) => r.premises_address) {
  let winner = null;
  let score = null;
  for (const rule of rules) {
    const m = match(billText, addressOf(rule));
    if (!m) continue;
    if (!score || m.length > score.length || (m.length === score.length && m.exact && !score.exact)) {
      winner = rule;
      score = m;
    }
  }
  return winner ? { rule: winner, ...score } : null;
}

// Two rules collide when they claim the same supplier and the same premises,
// because then neither says anything the other does not. Compared on the keys,
// so re-typing an address with different punctuation is still a duplicate.
function sameRule(a, b) {
  return normalise(a.supplierName ?? a.supplier_name) === normalise(b.supplierName ?? b.supplier_name)
    && normalise(a.premisesAddress ?? a.premises_address) === normalise(b.premisesAddress ?? b.premises_address);
}

module.exports = { normalise, match, best, sameRule, tooShort, MIN_KEY };
