// Bills Hub display metadata for connected Xero organisations.
//
// Xero gives us the full legal name ("Ayu Borneo (KK) Sdn Bhd"); the Bills Hub
// table needs a short code ("ABKK") and short name ("Ayu Borneo (KK)"). Rows are
// seeded from the tenant name on first sync and are editable afterwards, so a
// re-sync never overwrites a code someone has corrected by hand.
const db = require('../db');
const { CONNECTIONS } = require('../lib/grantSource');

// Legal-form suffixes stripped before deriving a code. Longest first so
// "Sdn Bhd" wins over "Bhd".
const LEGAL_SUFFIXES = [
  'sendirian berhad', 'sdn\\.? bhd\\.?', 'private limited', 'pte\\.? ltd\\.?',
  'berhad', 'bhd\\.?', 'limited', 'ltd\\.?', 'llp', 'plt', 'inc\\.?', 'corp\\.?'
];
const SUFFIX_RE = new RegExp(`\\s*\\b(${LEGAL_SUFFIXES.join('|')})\\s*$`, 'i');

// "Ayu Borneo (KK) Sdn Bhd" -> "Ayu Borneo (KK)"
function shortNameFrom(tenantName) {
  let s = String(tenantName || '').trim();
  // Two passes: "Ayu Borneo Sdn. Bhd." leaves a trailing "Sdn." after "Bhd.".
  s = s.replace(SUFFIX_RE, '').replace(SUFFIX_RE, '').trim();
  return s.replace(/[,\s]+$/, '') || String(tenantName || '').trim();
}

// "Ayu Borneo (KK)" -> "ABKK";  "Ayu Borneo Management" -> "ABM"
function codeFrom(tenantName) {
  const short = shortNameFrom(tenantName);
  const bracket = short.match(/\(([^)]+)\)/);
  const branch = bracket ? bracket[1].replace(/[^A-Za-z0-9]/g, '').toUpperCase() : '';
  const base = short
    .replace(/\([^)]*\)/g, ' ')
    .split(/[\s\-/&.]+/)
    .filter((w) => /^[A-Za-z0-9]/.test(w))
    .map((w) => w[0].toUpperCase())
    .join('');
  const code = `${base}${branch}`.slice(0, 16);
  return code || 'ORG';
}

// The two id spaces meet on the Xero tenant id: `entities` is keyed by the Bills
// Hub account, `xero_connections` by the WazzOCR one, so both are passed in.
function listByAccount(accountId, wazzocrAccountId, { includedOnly = true } = {}) {
  return db.query(
    `SELECT e.id, e.xero_tenant_id, e.code, e.short_name, e.position, e.included,
            c.tenant_name, c.status, c.needs_reconnect
       FROM entities e
       JOIN ${CONNECTIONS} c
         ON c.account_id = ? AND c.xero_tenant_id = e.xero_tenant_id
      WHERE e.account_id = ? ${includedOnly ? 'AND e.included = 1' : ''}
        AND c.status = 'active'
      ORDER BY e.position, e.short_name`,
    [wazzocrAccountId, accountId]
  );
}

// Organisations Bills Hub should sync: everything WazzOCR has connected, minus
// any the user has excluded here.
function listSyncable(accountId, wazzocrAccountId) {
  return db.query(
    `SELECT c.xero_tenant_id, c.tenant_name, e.code, e.short_name
       FROM ${CONNECTIONS} c
       LEFT JOIN entities e
         ON e.account_id = ? AND e.xero_tenant_id = c.xero_tenant_id
      WHERE c.account_id = ? AND c.status = 'active'
        AND (e.included IS NULL OR e.included = 1)
      ORDER BY e.position, c.tenant_name`,
    [accountId, wazzocrAccountId]
  );
}

// Create the row for a newly connected org if it doesn't have one yet. Existing
// rows are left alone so hand-edited codes and names survive a re-sync.
// Returns { code, shortName }.
async function ensure(accountId, tenantId, tenantName) {
  const existing = await db.getOne(
    'SELECT code, short_name FROM entities WHERE account_id = ? AND xero_tenant_id = ?',
    [accountId, tenantId]
  );
  if (existing) return { code: existing.code, shortName: existing.short_name };

  const shortName = shortNameFrom(tenantName);
  const base = codeFrom(tenantName);

  // Codes are shown as an identifier in the UI, so keep them unique per account.
  let code = base;
  for (let n = 2; n <= 99; n += 1) {
    const clash = await db.getOne(
      'SELECT id FROM entities WHERE account_id = ? AND code = ?',
      [accountId, code]
    );
    if (!clash) break;
    code = `${base}${n}`.slice(0, 16);
  }

  const next = await db.getOne(
    'SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM entities WHERE account_id = ?',
    [accountId]
  );
  await db.execute(
    `INSERT INTO entities (account_id, xero_tenant_id, code, short_name, position)
     VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE short_name = short_name`,
    [accountId, tenantId, code, shortName, next ? Number(next.pos) : 1]
  );
  return { code, shortName };
}

async function update(accountId, tenantId, { code, shortName, included, position } = {}) {
  const sets = [];
  const params = [];
  if (code !== undefined) { sets.push('code = ?'); params.push(String(code).trim().toUpperCase().slice(0, 16)); }
  if (shortName !== undefined) { sets.push('short_name = ?'); params.push(String(shortName).trim().slice(0, 255)); }
  if (included !== undefined) { sets.push('included = ?'); params.push(included ? 1 : 0); }
  if (position !== undefined) { sets.push('position = ?'); params.push(Number(position) || 0); }
  if (!sets.length) return 0;
  params.push(accountId, tenantId);
  const res = await db.execute(
    `UPDATE entities SET ${sets.join(', ')} WHERE account_id = ? AND xero_tenant_id = ?`,
    params
  );
  return res.affectedRows;
}

// Map of tenantId -> { code, shortName } for decorating bill rows.
async function map(accountId) {
  const rows = await db.query(
    'SELECT xero_tenant_id, code, short_name FROM entities WHERE account_id = ?',
    [accountId]
  );
  const out = new Map();
  for (const r of rows) out.set(r.xero_tenant_id, { code: r.code, shortName: r.short_name });
  return out;
}

module.exports = { listByAccount, listSyncable, ensure, update, map, codeFrom, shortNameFrom };
