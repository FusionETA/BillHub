// The short form of an entity, for writing into a reference.
//
// Every organisation in a group shares a prefix — Ayu Borneo's codes are
// ABKJ, ABKK, ABSDK, ABMYY — and repeating it inside a reference that is
// already scoped to that group says nothing and costs characters:
//
//   IC-TNB-GRP-0726-ABKJ      the code
//   IC-TNB-GRP-0726-KJ        what it needs to say
//
// Those characters are not free. Hong Leong's portal refused a Reference 2
// field at 20 characters, and CIMB's description column is read against one
// statement; two saved on every line is two more of the part that identifies
// the bill. On screen the whole code is still shown — a badge has room, and
// ABKJ is what somebody looking at Xero will see.

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

// `entity` is a row with `code` and `short_name`; `allCodes` is every code in
// the account, used only for the fallback.
function short(entity, allCodes = []) {
  const e = typeof entity === 'string' ? { code: entity } : (entity || {});
  const code = String(e.code || '').trim();
  if (!code) return '';

  const named = fromName(e.short_name || e.shortName);
  if (named) return named;

  const prefix = commonPrefix(allCodes);
  if (prefix && code.startsWith(prefix)) return code.slice(prefix.length);
  return code;
}

module.exports = { short, fromName, commonPrefix };
