// Ayu Borneo's abbreviations for the utilities they pay — the "TNB" in
// "BM 69 TNB 0826".
//
// These live here rather than on the payee rows, for three reasons. Xero has
// nowhere to put them: its API silently drops a Contact's Code field, and the
// Financial details panel does not show it. Writing them into `payees` would
// flip those rows to source='manual', which freezes bank_account_name and
// details against the next sync — and those are the very fields being
// corrected in Xero right now. And one entry here covers every organisation at
// once: Tenaga is a contact in most of the 41, and a new one picks the
// abbreviation up without anybody doing anything.
//
// Matching is on the supplier's name within the contact name, because the
// contacts carry the premises too: "Tenaga Nasional Berhad - Hostel",
// "Indah Water Konsortium Sdn Bhd-MA Shop 49, 49-1, 49-2".
//
// Nothing here is guessed. Each entry is one the client has confirmed; a
// utility with no entry simply leaves that part of the narrative out, which is
// shorter and still correct. `npm run payee-codes` lists the ones still
// missing so they can be asked about as a set.

const CODES = [
  { match: 'TENAGA NASIONAL', code: 'TNB' },   // Tenaga Nasional Berhad
  { match: 'AIR SELANGOR', code: 'AIS' },      // Syarikat Bekalan Air Selangor
  { match: 'INDAH WATER', code: 'ID' }         // Indah Water Konsortium
];

const squash = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

// Longest match wins, so a more specific entry can be added later without the
// order of this list deciding the outcome.
const BY_LENGTH = [...CODES].sort((a, b) => b.match.length - a.match.length);

function codeFor(contactName) {
  const name = squash(contactName);
  if (!name) return null;
  const hit = BY_LENGTH.find((c) => name.includes(squash(c.match)));
  return hit ? hit.code : null;
}

module.exports = { codeFor, CODES };
