// Renders a payment batch into a bank's upload file.
//
// Layouts are data, not code (see the `bank_formats` table). Every Malaysian
// bank wants something slightly different, and Maybank alone issues both CSV and
// pipe-delimited variants depending on what the customer registered for — so the
// column list, delimiter, padding and header/trailer rows all come from the
// format row. Correcting a layout is an edit, never a deploy.
//
//   const { render } = require('./lib/bankFile');
//   const { text, fileName } = render(format, batch, lines);

// Fields a column can map to. Anything else is treated as a literal.
//
//   seq            1-based line number
//   payeeName      supplier name
//   payeeAccount   supplier bank account number
//   payeeBank      supplier bank name
//   amount         line amount, 2dp, no separators  (1276.40)
//   amountCents    line amount in cents, no dot     (127640)
//   reference      bill reference shown to the payee
//   paymentDate    batch payment date
//   batchRef       our batch reference (PAY-4469)
//   payerName      the paying entity's name
//   payerAccount   the paying bank account number
//   currency       currency code
//   total          batch total, 2dp
//   totalCents     batch total in cents
//   count          number of lines in the batch
const TRANSFORMS = {
  // Strip anything a bank portal is likely to reject. Maybank's own guidance
  // warns against * ! @ # $ ( ) - and friends in payment templates.
  safe: (v) => String(v ?? '').replace(/[^A-Za-z0-9 .\/]/g, ' ').replace(/\s+/g, ' ').trim(),
  digits: (v) => String(v ?? '').replace(/\D/g, ''),
  upper: (v) => String(v ?? '').toUpperCase(),
  lower: (v) => String(v ?? '').toLowerCase(),
  trim: (v) => String(v ?? '').trim(),
  none: (v) => String(v ?? '')
};

const DATE_FORMATS = {
  'YYYY-MM-DD': (d) => d.toISOString().slice(0, 10),
  'YYYYMMDD': (d) => d.toISOString().slice(0, 10).replace(/-/g, ''),
  'DD/MM/YYYY': (d) => `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`,
  'DDMMYYYY': (d) => `${pad2(d.getUTCDate())}${pad2(d.getUTCMonth() + 1)}${d.getUTCFullYear()}`
};
const pad2 = (n) => String(n).padStart(2, '0');

function money(n) {
  return Number(n || 0).toFixed(2);
}
function cents(n) {
  return String(Math.round(Number(n || 0) * 100));
}
function asDate(v) {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

// The values a column can reference, for one line of the batch.
function fieldsFor(batch, line, index, format) {
  const date = asDate(batch.payment_date);
  const dateFmt = DATE_FORMATS[format.date_format || 'YYYY-MM-DD'] || DATE_FORMATS['YYYY-MM-DD'];
  return {
    seq: String(index + 1),
    payeeName: line.contact_name || '',
    payeeAccount: line.payee_account || '',
    payeeBank: line.payee_bank || '',
    amount: money(line.amount),
    amountCents: cents(line.amount),
    reference: line.reference || '',
    paymentDate: dateFmt(date),
    batchRef: batch.reference || '',
    payerName: batch.payer_name || '',
    payerAccount: batch.payer_account || '',
    currency: batch.currency_code || '',
    total: money(batch.total),
    totalCents: cents(batch.total),
    count: String(batch.line_count ?? 0)
  };
}

// Apply one column spec to a set of field values.
function cell(spec, fields) {
  const raw = spec.field != null && spec.field in fields
    ? fields[spec.field]
    : (spec.literal != null ? spec.literal : (spec.default != null ? spec.default : ''));

  const transform = TRANSFORMS[spec.transform] || TRANSFORMS.none;
  let out = transform(raw);

  if (spec.maxLength && out.length > spec.maxLength) out = out.slice(0, spec.maxLength);
  if (spec.minLength && out.length < spec.minLength) {
    const ch = spec.padChar != null ? spec.padChar : ' ';
    out = spec.pad === 'left' ? out.padStart(spec.minLength, ch) : out.padEnd(spec.minLength, ch);
  }
  return out;
}

function quote(value, format) {
  if (!format.quote_fields) return value;
  return `"${String(value).replace(/"/g, '""')}"`;
}

function joinRow(cells, format) {
  return cells.map((c) => quote(c, format)).join(format.delimiter || ',');
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

// Renders the whole file. Returns { text, fileName, rowCount, warnings }.
function render(format, batch, lines) {
  const columns = parseJson(format.columns, []);
  if (!Array.isArray(columns) || !columns.length) {
    throw new Error(`Bank format "${format.format_key}" has no columns defined.`);
  }
  const headerRow = parseJson(format.header_row, null);
  const trailerRow = parseJson(format.trailer_row, null);
  const eol = format.line_ending === 'lf' ? '\n' : '\r\n';

  const rows = [];
  const warnings = [];

  // A file-level header record (some banks want the payer and totals up top).
  if (headerRow && Array.isArray(headerRow) && headerRow.length) {
    const fields = fieldsFor(batch, {}, 0, format);
    rows.push(joinRow(headerRow.map((spec) => cell(spec, fields)), format));
  }

  if (format.include_header) {
    rows.push(joinRow(columns.map((c, i) => c.header || c.field || `col${i + 1}`), format));
  }

  lines.forEach((line, i) => {
    const fields = fieldsFor(batch, line, i, format);
    // A missing payee account means the bank will reject the row, so surface it
    // rather than writing a blank cell and letting the portal find it.
    if (!line.payee_account) {
      warnings.push(`${line.contact_name || 'line ' + (i + 1)} has no bank account number.`);
    }
    rows.push(joinRow(columns.map((spec) => cell(spec, fields)), format));
  });

  if (trailerRow && Array.isArray(trailerRow) && trailerRow.length) {
    const fields = fieldsFor(batch, {}, lines.length, format);
    rows.push(joinRow(trailerRow.map((spec) => cell(spec, fields)), format));
  }

  const text = rows.join(eol) + eol;
  const fileName = buildFileName(format, batch);
  return { text, fileName, rowCount: lines.length, warnings };
}

// e.g. PAY-4469_Maybank.csv
function buildFileName(format, batch) {
  const bank = (format.bank_name || format.format_key || 'bank').replace(/[^A-Za-z0-9]+/g, '');
  const ref = (batch.reference || 'batch').replace(/[^A-Za-z0-9-]+/g, '');
  return `${ref}_${bank}.${format.extension || 'csv'}`;
}

// ── Built-in layouts ────────────────────────────────────────────────────────
//
// Only `generic-csv` is marked verified, because it is our own layout and there
// is no external spec to be wrong about. The Maybank starter is a reasonable
// shape for a bulk-payment upload, but the exact columns a given customer must
// send depend on the format they registered for (Maybank issues CSV and
// pipe-delimited variants), so it ships unverified and must be checked against
// the bank's own spec sheet before a real payment run.
const BUILT_IN = [
  {
    format_key: 'generic-csv',
    name: 'Generic CSV (readable)',
    bank_name: 'Generic',
    delimiter: ',',
    extension: 'csv',
    include_header: 1,
    quote_fields: 1,
    line_ending: 'crlf',
    verified: 1,
    notes: 'Plain, human-readable CSV. Safe starting point for a new bank layout, and useful for checking a batch before sending it.',
    // Quoted and for human eyes, so nothing is stripped — the sanitising
    // transforms exist for bank portals that reject punctuation.
    columns: [
      { header: 'No', field: 'seq' },
      { header: 'Payee', field: 'payeeName', transform: 'trim' },
      { header: 'Bank', field: 'payeeBank', transform: 'trim' },
      { header: 'Account No', field: 'payeeAccount', transform: 'trim' },
      { header: 'Amount', field: 'amount' },
      { header: 'Currency', field: 'currency' },
      { header: 'Payment Date', field: 'paymentDate' },
      { header: 'Reference', field: 'reference', transform: 'trim' },
      { header: 'Batch', field: 'batchRef' }
    ]
  },
  {
    format_key: 'maybank-m2e-csv',
    name: 'Maybank M2E (CSV) — starter',
    bank_name: 'Maybank',
    delimiter: ',',
    extension: 'csv',
    include_header: 0,
    quote_fields: 0,
    line_ending: 'crlf',
    verified: 0,
    notes: 'UNVERIFIED starter layout. Maybank issues different bulk-payment formats per customer registration (CSV and pipe-delimited variants exist). Check every column against the spec sheet Maybank gave you, send a single-line test payment first, and set verified once it is confirmed.',
    columns: [
      { header: 'PayeeAccount', field: 'payeeAccount', transform: 'digits', maxLength: 20 },
      { header: 'PayeeName', field: 'payeeName', transform: 'safe', maxLength: 40 },
      { header: 'Amount', field: 'amount' },
      { header: 'PaymentRef', field: 'reference', transform: 'safe', maxLength: 20 },
      { header: 'PaymentDate', field: 'paymentDate' }
    ],
    date_format: 'DDMMYYYY'
  }
];

module.exports = { render, buildFileName, BUILT_IN, TRANSFORMS, DATE_FORMATS };
