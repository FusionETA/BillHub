// Which utility a supplier contact is.
//
// Used for two things that must not drift apart: the Utility column the
// premises register offers, and scripts/utilities.js, which reports what an
// account actually has.
//
// Matching is on the contact NAME, which is all there is. A pattern has to
// be specific enough that it cannot catch something else: "TM" would match
// half the contacts in the country, so Telekom is matched on "telekom" and
// "unifi" and nothing shorter. Where a name matches nothing, the answer is
// null — not a guess. The field is free text in the UI precisely so a miss
// here costs nothing.
//
// Malaysian utilities, grouped the way a person would say them. Electricity
// and water are regional: Sabah and Sarawak have their own, and a group
// operating in three states bills all of them.
const UTILITIES = [
  // Electricity
  { name: 'TNB',               match: /tenaga\s*nasional|\btnb\b/i },
  { name: 'SESB',              match: /sabah\s*electricity|\bsesb\b/i },
  { name: 'Sarawak Energy',    match: /sarawak\s*energy|\bsesco\b/i },
  // Water
  { name: 'Air Selangor',      match: /air\s*selangor/i },
  { name: 'Syabas',            match: /\bsyabas\b/i },
  { name: 'SAJ',               match: /\bsaj\b|ranhill\s*saj/i },
  { name: 'Jabatan Air',       match: /jabatan\s*air/i },
  { name: 'LAKU',              match: /\blaku\b/i },
  { name: 'Kuching Water',     match: /kuching\s*water/i },
  { name: 'Air Kelantan',      match: /air\s*kelantan|\baksb\b/i },
  { name: 'PBA Pulau Pinang',  match: /\bpba\b|perbadanan\s*bekalan\s*air/i },
  // Sewerage and waste
  { name: 'Indah Water',       match: /indah\s*water|\biwk\b/i },
  { name: 'Alam Flora',        match: /alam\s*flora/i },
  { name: 'SWCorp',            match: /\bswcorp\b|sisa\s*pepejal/i },
  // Gas
  { name: 'Gas Malaysia',      match: /gas\s*malaysia/i },
  { name: 'Petronas Gas',      match: /petronas\s*gas/i },
  // Telecoms
  { name: 'Telekom Malaysia',  match: /telekom\s*malaysia|\bunifi\b/i },
  { name: 'Maxis',             match: /\bmaxis\b/i },
  { name: 'Celcom',            match: /\bcelcom\b/i },
  { name: 'Digi',              match: /\bdigi\b/i },
  { name: 'U Mobile',          match: /\bu\s*mobile\b/i },
  { name: 'Time dotCom',       match: /time\s*dotcom|\btime\b\s*fibre/i },
  { name: 'Astro',             match: /\bastro\b/i },
  // Local authority
  { name: 'Assessment',        match: /majlis\s*(bandaraya|perbandaran|daerah)|\bdbkl\b|cukai\s*taksiran|assessment/i },
  { name: 'Quit rent',         match: /cukai\s*tanah|quit\s*rent|pejabat\s*tanah/i }
];

// The utility a contact name belongs to, or null when nothing fits.
function detect(contactName) {
  const name = String(contactName || '');
  if (!name.trim()) return null;
  const hit = UTILITIES.find((u) => u.match.test(name));
  return hit ? hit.name : null;
}

// What an account actually has, from the contact names on its bills. The
// register's dropdown is built from this rather than from the list above:
// offering a group Syabas when they are all in Sabah is a list nobody
// reads, and leaving out the one they do use is worse.
function fromContacts(contactNames = []) {
  const found = new Set();
  for (const n of contactNames) {
    const u = detect(n);
    if (u) found.add(u);
  }
  return [...found].sort();
}

module.exports = { UTILITIES, detect, fromContacts };
