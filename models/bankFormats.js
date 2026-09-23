// Bank file layouts. Built-ins are seeded with account_id NULL; an account can
// override a built-in by creating its own row with the same format_key, or add
// entirely new ones.
const db = require('../db');
const { BUILT_IN } = require('../lib/bankFile');

const COLS = `id, account_id, format_key, name, bank_name, delimiter, extension,
              include_header, line_ending, quote_fields, date_format,
              columns, header_row, trailer_row, verified, notes`;

// Seeds the built-in layouts. Idempotent, and it never overwrites a layout
// someone has since corrected — the whole point of holding these as data.
async function seedBuiltIns() {
  for (const f of BUILT_IN) {
    const exists = await db.getOne(
      'SELECT id FROM bank_formats WHERE account_id IS NULL AND format_key = ?', [f.format_key]
    );
    if (exists) continue;
    await db.insert(
      `INSERT INTO bank_formats
        (account_id, format_key, name, bank_name, delimiter, extension, include_header,
         line_ending, quote_fields, date_format, columns, verified, notes)
       VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [f.format_key, f.name, f.bank_name, f.delimiter, f.extension, f.include_header,
       f.line_ending, f.quote_fields ? 1 : 0, f.date_format || 'YYYY-MM-DD',
       JSON.stringify(f.columns), f.verified ? 1 : 0, f.notes || null]
    );
  }
}

// Every layout this account can use: its own, plus built-ins it hasn't overridden.
async function listForAccount(accountId) {
  return db.query(
    `SELECT ${COLS} FROM bank_formats
      WHERE account_id = ?
         OR (account_id IS NULL
             AND format_key NOT IN (SELECT format_key FROM bank_formats WHERE account_id = ?))
      ORDER BY bank_name, name`,
    [accountId, accountId]
  );
}

// An account's own row wins over the built-in of the same key.
function get(accountId, formatKey) {
  return db.getOne(
    `SELECT ${COLS} FROM bank_formats
      WHERE format_key = ? AND (account_id = ? OR account_id IS NULL)
      ORDER BY account_id IS NULL
      LIMIT 1`,
    [formatKey, accountId]
  );
}

const EDITABLE = {
  name: 'name', bankName: 'bank_name', delimiter: 'delimiter', extension: 'extension',
  includeHeader: 'include_header', lineEnding: 'line_ending', quoteFields: 'quote_fields',
  dateFormat: 'date_format', columns: 'columns', headerRow: 'header_row',
  trailerRow: 'trailer_row', verified: 'verified', notes: 'notes'
};
const JSON_FIELDS = new Set(['columns', 'headerRow', 'trailerRow']);
const BOOL_FIELDS = new Set(['includeHeader', 'quoteFields', 'verified']);

function coerce(key, value) {
  if (JSON_FIELDS.has(key)) return value == null ? null : JSON.stringify(value);
  if (BOOL_FIELDS.has(key)) return value ? 1 : 0;
  return value;
}

// Create this account's own layout, or copy a built-in so it can be edited.
async function upsertForAccount(accountId, formatKey, fields = {}) {
  const existing = await db.getOne(
    'SELECT id FROM bank_formats WHERE account_id = ? AND format_key = ?', [accountId, formatKey]
  );

  if (!existing) {
    // Start from the built-in of the same key, so an edit to one column doesn't
    // require restating the whole layout.
    const base = await db.getOne(
      `SELECT ${COLS} FROM bank_formats WHERE account_id IS NULL AND format_key = ?`, [formatKey]
    );
    const merged = {
      name: fields.name ?? base?.name ?? formatKey,
      bank_name: fields.bankName ?? base?.bank_name ?? null,
      delimiter: fields.delimiter ?? base?.delimiter ?? ',',
      extension: fields.extension ?? base?.extension ?? 'csv',
      include_header: (fields.includeHeader ?? base?.include_header ?? 1) ? 1 : 0,
      line_ending: fields.lineEnding ?? base?.line_ending ?? 'crlf',
      quote_fields: (fields.quoteFields ?? base?.quote_fields ?? 0) ? 1 : 0,
      date_format: fields.dateFormat ?? base?.date_format ?? 'YYYY-MM-DD',
      columns: fields.columns ? JSON.stringify(fields.columns) : (base?.columns ?? '[]'),
      header_row: fields.headerRow ? JSON.stringify(fields.headerRow) : (base?.header_row ?? null),
      trailer_row: fields.trailerRow ? JSON.stringify(fields.trailerRow) : (base?.trailer_row ?? null),
      // Copying a built-in and changing it means it is no longer the thing that
      // was (or wasn't) checked — the caller has to assert verified again.
      verified: fields.verified ? 1 : 0,
      notes: fields.notes ?? base?.notes ?? null
    };
    return db.insert(
      `INSERT INTO bank_formats
        (account_id, format_key, name, bank_name, delimiter, extension, include_header,
         line_ending, quote_fields, date_format, columns, header_row, trailer_row, verified, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [accountId, formatKey, merged.name, merged.bank_name, merged.delimiter, merged.extension,
       merged.include_header, merged.line_ending, merged.quote_fields, merged.date_format,
       merged.columns, merged.header_row, merged.trailer_row, merged.verified, merged.notes]
    );
  }

  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(EDITABLE)) {
    if (key in fields) { sets.push(`${col} = ?`); params.push(coerce(key, fields[key])); }
  }
  // Any change to the layout clears the verified flag unless it is being set in
  // the same call, so an edited file can't inherit someone else's sign-off.
  const touchesLayout = ['columns', 'headerRow', 'trailerRow', 'delimiter', 'lineEnding', 'dateFormat', 'quoteFields', 'includeHeader']
    .some((k) => k in fields);
  if (touchesLayout && !('verified' in fields)) { sets.push('verified = 0'); }
  if (!sets.length) return existing.id;
  params.push(existing.id);
  await db.execute(`UPDATE bank_formats SET ${sets.join(', ')} WHERE id = ?`, params);
  return existing.id;
}

async function removeForAccount(accountId, formatKey) {
  const res = await db.execute(
    'DELETE FROM bank_formats WHERE account_id = ? AND format_key = ?', [accountId, formatKey]
  );
  return res.affectedRows;
}

module.exports = { seedBuiltIns, listForAccount, get, upsertForAccount, removeForAccount };
