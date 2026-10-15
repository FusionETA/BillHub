// The short form of an entity, for writing into a reference.
//
// It is the code, and nothing else.
//
// It used to be derived — the bracketed part of the name if there was one,
// otherwise the code with any prefix shared by the whole group removed.
// That made sense while every code was ABKJ, ABKK, ABSDK and the name said
// the same thing twice. It stopped making sense the moment the codes were
// set deliberately: "Ayu Borneo (PJ)" recoded to ICM went on writing PJ
// into every payment file, because the name still said PJ, and the code on
// screen and the code in the bank file disagreed with no way to tell from
// either end which one a statement meant.
//
// So the code decides. Whoever sets it can see what a reference will carry,
// which is the whole reason it is theirs to set.

// What distinguishes one organisation from its siblings, taken from the name
// somebody gave it: "Ayu Borneo (KJ)" -> "KJ".
//
// Read from the entity's own name rather than from the set it sits in, so
// connecting an organisation from outside the group cannot silently lengthen
// every other entity's references.
const PARENTHESISED = /\(([A-Za-z0-9][A-Za-z0-9 .\-]{0,10})\)\s*$/;

function fromName(shortName) {
  const m = PARENTHESISED.exec(String(shortName || '').trim());
  if (!m) return '';
  // Spaces and dots would have to be stripped out of a reference anyway, and
  // a bank's description column is no place to discover that.
  return m[1].replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

// The longest prefix every code shares, as whole characters. The fallback
// for a group whose names carry no bracketed suffix.
//
// Only taken when it leaves something behind for every code — a prefix that
// consumed one code entirely would turn it into an empty suffix, and two
// entities whose references cannot be told apart is far worse than a long
// one. Needs at least two codes for "shared" to mean anything.
function commonPrefix(codes) {
  const list = [...new Set((codes || []).map((c) => String(c || '').trim()).filter(Boolean))];
  if (list.length < 2) return '';

  let prefix = list[0];
  for (const code of list.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < code.length && prefix[i] === code[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (!prefix) return '';
  }
  if (list.some((c) => c.length <= prefix.length)) return '';
  return prefix;
}

// `entity` is a row with `code`. `allCodes` is accepted and ignored: it was
// how the shared-prefix fallback saw its siblings, and callers still pass it.
//
// Spaces and punctuation come out. A reference crosses a bank's file format
// and Xero's Reference field, and neither is a place to find out that a code
// somebody typed had a space in it.
function short(entity, allCodes = []) {   // eslint-disable-line no-unused-vars
  const e = typeof entity === 'string' ? { code: entity } : (entity || {});
  return String(e.code || '').trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

module.exports = { short, fromName, commonPrefix };
