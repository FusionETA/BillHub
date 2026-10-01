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

const banks = require('./malaysianBanks');

// Hong Leong's ConnectFirst limits depend on the payment mode, not just the
// column: a beneficiary name may be 70 characters by FT, 140 by DuitNow and
// only 20 by IBG. A column can therefore carry maxLengthByMode, and the mode
// of the line decides. Getting this wrong truncates a payee name silently,
// which is how a payment goes to the wrong place.
const MODE_LIMITS = {
  FT:      { name: 70,  reference: 20, details: 20, account: [11, 11] },
  IBG:     { name: 20,  reference: 20, details: 20, account: [5, 17] },
  RENTAS:  { name: 70,  reference: 20, details: 20, account: [5, 17] },
  DUITNW:  { name: 140, reference: 40, details: 140, account: [1, 34] }
};

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

  // Xero's "Financial details" panel is the routing: a bank name means a
  // transfer, an all-digit value is a JomPay biller code.
  const payeeBankName = line.payee_bank_account_name || line.payee_bank || '';
  const mode = String(line.payment_mode || format.payment_mode || 'DUITNW').toUpperCase();
  const scheme = mode === 'IBG' ? 'ibg' : mode === 'RENTAS' ? 'rentas' : 'duitnow';
  const code = banks.isBillerCode(payeeBankName) ? '' : (banks.bankCode(payeeBankName, scheme) || '');

  // Their live file prefixes DuitNow account numbers with D. Added only when
  // the stored value is bare digits, so an account already carrying a prefix
  // is left exactly as Xero has it.
  const account = String(line.payee_account || '');
  const duitnowAccount = mode === 'DUITNW' && /^\d+$/.test(account) && account
    ? `D${account}` : account;

  const period = `${pad2(date.getUTCMonth() + 1)}${String(date.getUTCFullYear()).slice(-2)}`;

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
    count: String(batch.line_count ?? 0),

    // ── Hong Leong ConnectFirst ──────────────────────────────────────────
    paymentMode: mode,
    payeeBankCode: code,
    payeeBankAccountName: payeeBankName,
    payeeAccountModal: duitnowAccount,
    payeeDetails: line.payee_details || '',
    payeeEmail: line.payee_email || '',
    // JomPay: the biller code lives where a bank name would be.
    billerCode: banks.isBillerCode(payeeBankName) ? payeeBankName.trim() : '',
    entityCode: batch.entity_code || '',
    period,
    // "MA GE 0826" — paying entity, supplier abbreviation, period. The
    // abbreviation comes from the payee when it has one; without it the
    // supplier's own reference is better than nothing.
    otherDetails: [batch.entity_code, line.payee_code || line.payee_details, period]
      .filter(Boolean).join(' ')
  };
}

// Apply one column spec to a set of field values.
function cell(spec, fields, warn) {
  const raw = spec.field != null && spec.field in fields
    ? fields[spec.field]
    : (spec.literal != null ? spec.literal : (spec.default != null ? spec.default : ''));

  const transform = TRANSFORMS[spec.transform] || TRANSFORMS.none;
  let out = transform(raw);

  // A per-mode cap beats the column's own, because Hong Leong's limits move
  // with the payment mode.
  let cap = spec.maxLength;
  if (spec.maxLengthByMode) {
    const byMode = spec.maxLengthByMode[fields.paymentMode];
    if (byMode) cap = byMode;
  }
  if (cap && out.length > cap) {
    if (warn && out.trim()) {
      warn(`"${out.slice(0, 24)}…" was cut to ${cap} characters for ${spec.header || spec.field} (${fields.paymentMode}).`);
    }
    out = out.slice(0, cap);
  }
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
    // A bank Bills Hub cannot place is a line the portal will reject, and the
    // cell would otherwise just be blank.
    if (fields.payeeBankCode === '' && fields.billerCode === '' && fields.payeeBankAccountName) {
      warnings.push(`${line.contact_name || 'line ' + (i + 1)}: ${fields.payeeBankAccountName} is not a bank Hong Leong lists, and is not a JomPay biller code.`);
    }
    rows.push(joinRow(columns.map((spec) => cell(spec, fields, (m) => warnings.push(`${line.contact_name || 'line ' + (i + 1)}: ${m}`))), format));
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
  },
  {
    // Columns, order and limits taken from the "File Specification" sheet of
    // Hong Leong's own CFIRST_Bulk template, not inferred from a sample.
    //
    // The portal wants the bank's .xls template, so this renders the rows that
    // go into it. Keep the column order exactly as the template has it.
    format_key: 'hlb-connectfirst',
    name: 'Hong Leong ConnectFirst — bulk payment',
    bank_name: 'Hong Leong Bank',
    delimiter: ',',
    extension: 'csv',
    include_header: 1,
    quote_fields: 1,
    line_ending: 'crlf',
    verified: 0,
    payment_mode: 'DUITNW',
    notes: 'Column order and per-mode limits come from Hong Leong\'s own file specification. '
      + 'Still unverified end to end: ConnectFirst takes the bank\'s .xls template, so confirm '
      + 'the portal accepts this before a real run, and send one line first.',
    columns: [
      { header: '*Payment Mode', field: 'paymentMode', maxLength: 6 },
      { header: '*Beneficiary Bank Code', field: 'payeeBankCode', maxLength: 4 },
      { header: '*Beneficiary Account No.', field: 'payeeAccountModal', transform: 'trim', maxLength: 34 },
      { header: '*Beneficiary Name', field: 'payeeName', transform: 'trim',
        maxLengthByMode: { FT: 70, IBG: 20, RENTAS: 70, DUITNW: 140 } },
      { header: '*Currency', field: 'currency', default: 'MYR', maxLength: 3 },
      { header: '*Amount', field: 'amount' },
      { header: '*Recipient Reference', field: 'reference', transform: 'trim',
        maxLengthByMode: { FT: 20, IBG: 20, RENTAS: 20, DUITNW: 40 } },
      { header: 'Other Payment Details', field: 'otherDetails', transform: 'trim',
        maxLengthByMode: { FT: 20, IBG: 20, RENTAS: 20, DUITNW: 140 } },
      { header: '*ID Validation (Y/N)', literal: 'N', maxLength: 1 },
      { header: 'Validation ID Type', literal: '' },
      { header: 'Validation ID Value', literal: '' },
      { header: 'Transaction Type', literal: '' },
      { header: 'Transaction Code', literal: '' },
      { header: 'Purpose Of Transfer', literal: '' },
      { header: 'Beneficiary Email Address', field: 'payeeEmail', transform: 'trim', maxLength: 500 }
    ]
  },
  {
    // A different rail entirely: utilities are paid by biller code and their
    // own account number, with no bank account involved. Most of Ayu Borneo's
    // volume — 523 of 622 rows in their masterlist — goes this way.
    format_key: 'hlb-jompay',
    name: 'Hong Leong — JomPay bulk',
    bank_name: 'Hong Leong Bank',
    delimiter: ',',
    extension: 'csv',
    include_header: 1,
    quote_fields: 0,
    line_ending: 'crlf',
    verified: 0,
    notes: 'For utilities paid by JomPay. The biller code is the contact\'s Xero "Bank account name" '
      + 'when it is all digits; Ref-1 is the utility account number. Unverified against the portal.',
    columns: [
      { header: '*Biller Code', field: 'billerCode', transform: 'digits', maxLength: 8 },
      { header: '*Ref-1', field: 'payeeAccount', transform: 'trim', maxLength: 20 },
      { header: 'Ref-2', field: 'otherDetails', transform: 'safe', maxLength: 30 },
      { header: '*Amount', field: 'amount' }
    ]
  }
];

module.exports = {
  MODE_LIMITS, render, buildFileName, BUILT_IN, TRANSFORMS, DATE_FORMATS };
