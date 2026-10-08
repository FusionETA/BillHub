// Turns rows from the `bills` table into the exact view model the Bills Hub UI
// renders. Formatting lives here rather than in the browser so the numbers on
// screen, in the WhatsApp digest and in an export can never drift apart.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const { formatPhone } = require('../lib/wazzup');
const rechargeModel = require('../models/recharge');
const xeroLinks = require('../lib/xeroLinks');

// 1276.4 -> "1,276.40"
function money(n) {
  return Number(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Date -> "4 Sep 2026"
function shortDate(d) {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function todayUtc() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

// Status chip colours, keyed by the four UI statuses. Values are the design
// tokens already defined in the page's :root.
const STATUS_STYLE = {
  draft:    { label: 'Draft',             bg: 'var(--neutral-100)', fg: 'var(--neutral-600)' },
  approval: { label: 'Awaiting approval', bg: 'var(--amber-100)',   fg: '#8a6300' },
  payment:  { label: 'Awaiting payment',  bg: 'var(--blue-50)',     fg: 'var(--blue-600)' },
  paid:     { label: 'Paid',              bg: 'var(--green-100)',   fg: '#126b42' }
};

// What the row's button does next, in Xero terms.
const ACTION = {
  draft:    'Submit',
  approval: 'Approve',
  payment:  'Mark paid'
};

function billRow(b) {
  const status = STATUS_STYLE[b.ui_status] || STATUS_STYLE.draft;
  const due = b.due_date ? new Date(b.due_date) : null;
  const overdue = b.ui_status === 'payment' && due && due < todayUtc();

  // The reference column shows Xero's Reference, falling back to the invoice
  // number — a bill entered from a photo often has one but not the other.
  const reference = b.reference || b.invoice_number || '—';

  return {
    id: b.id,
    tenantId: b.xero_tenant_id,
    xeroInvoiceId: b.xero_invoice_id,
    uiStatus: b.ui_status,

    entityCode: b.entity_code || '—',
    entityShort: b.entity_short || b.tenant_name || '—',
    contact: b.contact_name || '—',

    statusLabel: status.label,
    statusBg: status.bg,
    statusFg: status.fg,

    reference,
    refNote: b.is_interco ? ' Intercompany' : '',

    dateFmt: shortDate(b.bill_date),
    dueFmt: shortDate(b.due_date),
    dueColor: overdue ? 'var(--color-danger)' : 'var(--text-body)',
    dueWeight: overdue ? '700' : '400',

    paidFmt: money(b.amount_paid),
    outFmt: money(b.amount_due),
    filesFmt: b.attachment_count > 0 ? String(b.attachment_count) : (b.has_attachments ? '1' : '—'),

    hasAction: Boolean(ACTION[b.ui_status]),
    actionLabel: ACTION[b.ui_status] || '',
    isPaid: b.ui_status === 'paid',
    paidNote: b.ui_status === 'paid' ? shortDate(b.fully_paid_on) : '',

    // Kept out of the visible columns but useful to the client for tooltips and
    // for the multi-currency warning on a group total.
    currency: b.currency_code || null,
    total: Number(b.total || 0),
    amountDue: Number(b.amount_due || 0)
  };
}

function statCards(stats, currency = 'RM') {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const entityCount = (n) => `${n} entit${n === 1 ? 'y' : 'ies'}`;
  return [
    {
      label: 'Draft',
      amount: `${currency} ${money(stats.draft.amount)}`,
      sub: `${plural(stats.draft.count, 'bill')} · ${entityCount(stats.draft.entities)}`,
      color: 'var(--neutral-400)'
    },
    { label: 'Awaiting approval', amount: `${currency} ${money(stats.approval.amount)}`, sub: plural(stats.approval.count, 'bill'), color: 'var(--amber-500)' },
    { label: 'Awaiting payment',  amount: `${currency} ${money(stats.payment.amount)}`,  sub: plural(stats.payment.count, 'bill'),  color: 'var(--blue-500)' },
    { label: 'Overdue',           amount: `${currency} ${money(stats.overdue.amount)}`,  sub: `${plural(stats.overdue.count, 'bill')} past due date`, color: 'var(--red-500)' }
  ];
}

function statusTabs(counts) {
  return [
    { value: 'all',      label: 'All',               count: counts.all },
    { value: 'draft',    label: 'Draft',             count: counts.draft },
    { value: 'approval', label: 'Awaiting approval', count: counts.approval },
    { value: 'payment',  label: 'Awaiting payment',  count: counts.payment },
    { value: 'paid',     label: 'Paid',              count: counts.paid }
  ];
}

// "28 items · RM 115,399.35 outstanding · all 40 entities"
function metaText(meta, totalEntities, currency = 'RM') {
  const scope = meta.entities >= totalEntities && totalEntities > 0
    ? `all ${totalEntities} entities`
    : `${meta.entities} of ${totalEntities} entities`;
  return `${meta.count} item${meta.count === 1 ? '' : 's'} · ${currency} ${money(meta.outstanding)} outstanding · ${scope}`;
}

// The orange banner above the stat cards. Returns null when there is nothing to
// nudge about, and the UI hides the banner.
function banner(stats, { digestRecipients = 0, digestTime = '09:00', currency = 'RM' } = {}) {
  if (!stats.draft.count) return null;
  const head = `${stats.draft.count} draft bill${stats.draft.count === 1 ? '' : 's'} across ${stats.draft.entities} entit${stats.draft.entities === 1 ? 'y' : 'ies'} ${stats.draft.count === 1 ? 'is' : 'are'} waiting to be cleared.`;
  const tail = digestRecipients
    ? `${currency} ${money(stats.draft.amount)} in total. The WhatsApp digest goes to ${digestRecipients} recipient${digestRecipients === 1 ? '' : 's'} every working day at ${digestTime}.`
    : `${currency} ${money(stats.draft.amount)} in total.`;
  return { head, tail };
}

// ── Bank files ──────────────────────────────────────────────────────────────

const BATCH_STATUS = {
  ready:      { label: 'Ready to download',  bg: 'var(--orange-50)',   fg: 'var(--orange-700)' },
  downloaded: { label: 'Downloaded',         bg: 'var(--amber-100)',   fg: '#8a6300' },
  uploaded:   { label: 'Uploaded to portal', bg: 'var(--green-100)',   fg: '#126b42' },
  posted:     { label: 'Recorded in Xero',   bg: 'var(--green-100)',   fg: '#126b42' },
  cancelled:  { label: 'Cancelled',          bg: 'var(--neutral-100)', fg: 'var(--neutral-600)' }
};

function batchCard(b, lineRows = [], currency = 'RM') {
  const status = BATCH_STATUS[b.status] || BATCH_STATUS.ready;
  const n = lineRows.length || b.line_count || 0;
  return {
    id: b.id,
    ref: b.reference,
    bank: b.bank_name || b.bank_account_name || '—',
    entityCode: b.entity_code || '—',
    entityLabel: b.entity_short || '—',
    account: b.bank_account_name + (b.bank_currency ? ` (${b.bank_currency})` : ''),
    format: b.format_key || '—',
    dateFmt: shortDate(b.payment_date),
    fileName: b.file_name || '—',
    totalFmt: money(b.total),
    countLabel: `${n} payment${n === 1 ? '' : 's'}`,
    statusLabel: status.label,
    statusBg: status.bg,
    statusFg: status.fg,
    status: b.status,
    // A real file built from real Xero data, with nothing posted to Xero. The
    // card has to say so, because otherwise it is indistinguishable from a
    // batch that paid 40 live bills.
    testMode: Boolean(b.test_mode),
    // A file only exists for batches that were meant to produce one.
    canDownload: Boolean(b.file_name) && b.status !== 'cancelled',
    // Offered once the file has actually been taken, and never twice.
    canUpload: b.status === 'downloaded',
    // `xero_posted_at`, not the batch payment id: an organisation whose edition
    // has no bill batch payments is paid bill by bill and leaves that id null,
    // so checking it would offer to cancel a batch whose bills are already paid.
    canCancel: !b.xero_posted_at && ['ready', 'downloaded'].includes(b.status),
    postedNote: b.test_mode
      ? 'Nothing was sent to Xero — testing mode'
      : (b.xero_posted_at ? `Recorded in Xero ${shortDate(b.xero_posted_at)}` : null),
    postError: b.post_error || null,
    downloadedNote: b.downloaded_at ? `Downloaded ${shortDate(b.downloaded_at)}` : 'Not downloaded yet',
    currency,
    lines: lineRows.map((l) => ({
      contact: l.contact_name || '—',
      acct: l.payee_account || '— no account —',
      hasAccount: Boolean(l.payee_account),
      amountFmt: money(l.amount),
      ref: l.reference || '—'
    }))
  };
}

function bankStatCards(stats, bankSummary, currency = 'RM') {
  const files = (n) => `${n} file${n === 1 ? '' : 's'}`;
  return [
    {
      label: 'Ready to download',
      amount: `${currency} ${money(stats.ready.amount)}`,
      sub: files(stats.ready.count),
      color: 'var(--color-primary)'
    },
    {
      label: 'Downloaded',
      amount: String(stats.downloaded.count),
      sub: 'awaiting upload to the portal',
      color: 'var(--amber-500)'
    },
    {
      label: 'Uploaded',
      amount: String(stats.uploaded.count),
      sub: 'confirmed in the banking portal',
      color: 'var(--green-500)'
    },
    {
      // There is one bank and nothing to configure, so counting layouts and
      // warning about "unset" accounts described a choice that no longer
      // exists. What is worth knowing is how many accounts can pay at all.
      label: 'Paying accounts',
      amount: String(bankSummary.accounts),
      sub: bankSummary.accounts
        ? 'all on the Hong Leong layouts'
        : 'none yet — run Sync accounts & payees',
      color: 'var(--blue-500)'
    }
  ];
}

function bankAccountRow(b) {
  if (!b) return null;
  return {
    id: b.id,
    tenantId: b.xero_tenant_id,
    entityCode: b.entity_code || '—',
    entityShort: b.entity_short || '—',
    name: b.name,
    bankName: b.bank_name || null,
    accountNumber: b.account_number || null,
    currency: b.currency_code || null,
    formatKey: b.format_key || null,
    billerFormatKey: b.biller_format_key || null,
    isDefault: Boolean(b.is_default),
    enabled: Boolean(b.enabled),
    // Every Ayu Borneo organisation names its Xero bank account after the
    // bank, so a list of them reads "Hong Leong Bank Berhad" forty-one times.
    // The account number is the only thing that distinguishes them.
    label: [b.name, b.account_number, b.currency_code && `(${b.currency_code})`]
      .filter(Boolean).join(' · ')
  };
}

function bankFormatRow(f) {
  if (!f) return null;
  const columns = typeof f.columns === 'string' ? JSON.parse(f.columns || '[]') : (f.columns || []);
  return {
    key: f.format_key,
    name: f.name,
    bankName: f.bank_name || null,
    delimiter: f.delimiter,
    extension: f.extension,
    includeHeader: Boolean(f.include_header),
    quoteFields: Boolean(f.quote_fields),
    lineEnding: f.line_ending,
    dateFormat: f.date_format,
    columns,
    // Built-ins have no account_id. A layout nobody has checked against the
    // bank's spec is flagged everywhere it appears.
    builtIn: f.account_id == null,
    verified: Boolean(f.verified),
    notes: f.notes || null
  };
}

function payeeRow(p) {
  if (!p) return null;
  return {
    tenantId: p.xero_tenant_id,
    entityCode: p.entity_code || null,
    contactId: p.contact_id,
    contactName: p.contact_name || '—',
    accountNumber: p.account_number || null,
    bankName: p.bank_name || null,
    source: p.source,
    hasAccount: Boolean(p.account_number)
  };
}

// ── Notifications ───────────────────────────────────────────────────────────

const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function digestSettings(s) {
  return {
    enabled: Boolean(s.enabled),
    frequency: s.frequency,
    // TIME comes back as HH:MM:SS; the form wants HH:MM.
    sendTime: String(s.send_time || '09:00:00').slice(0, 5),
    timezone: s.timezone,
    dayOfWeek: Number(s.day_of_week),
    dayOfMonth: Number(s.day_of_month),
    workingDaysOnly: Boolean(s.working_days_only),
    includeBreakdown: Boolean(s.include_breakdown),
    breakdownLimit: Number(s.breakdown_limit),
    sendWhenEmpty: Boolean(s.send_when_empty),
    channelId: s.channel_id || null,
    senderPhone: s.sender_phone || null,
    senderPhoneFmt: s.sender_phone ? formatPhone(s.sender_phone) : null,
    queueUrl: s.queue_url || null,
    // The key itself is never returned — only whether one is stored.
    hasApiKey: Boolean(s.api_key),
    configured: Boolean(s.channel_id && s.api_key),
    lastSentAt: s.last_sent_at || null,
    lastSentFor: s.last_sent_for || null
  };
}

// "Every working day at 09:00 (Asia/Kuala_Lumpur)" — plain words, because a cron
// expression tells a finance manager nothing.
function nextRunLabel(s) {
  if (!s.enabled) return 'Switched off — no digests are being sent.';
  if (!s.channel_id) return 'No WhatsApp channel configured yet.';
  const time = String(s.send_time || '09:00:00').slice(0, 5);
  const where = s.timezone || 'UTC';
  if (s.frequency === 'weekly') return `Every ${DAY_NAMES[Number(s.day_of_week) || 1]} at ${time} (${where}).`;
  if (s.frequency === 'monthly') {
    const d = Number(s.day_of_month);
    const day = d === 0 ? 'the last day of the month' : `day ${d}`;
    return `Monthly on ${day} at ${time} (${where}).`;
  }
  return `Every ${s.working_days_only ? 'working day' : 'day'} at ${time} (${where}).`;
}

function recipientRow(r, entityCount = 0) {
  if (!r) return null;
  const chips = (r.entities || []).map((e) => ({ code: e.code || '—', tenantId: e.tenantId }));
  const shown = chips.slice(0, 4);
  return {
    id: r.id,
    name: r.name,
    phone: formatPhone(r.phone),
    phoneRaw: r.phone,
    role: r.role || '—',
    on: Boolean(r.enabled),
    allEntities: Boolean(r.all_entities),
    chips: shown,
    hasMore: chips.length > shown.length,
    moreLabel: `+${chips.length - shown.length} more`,
    entityIds: chips.map((c) => c.tenantId),
    scopeLabel: r.all_entities
      ? `All ${entityCount || ''} entities`.replace('  ', ' ').trim()
      : `${chips.length} entit${chips.length === 1 ? 'y' : 'ies'}`
  };
}

function digestRunRow(r) {
  return {
    id: r.id,
    // A test send has no recipient row, so fall back to the number — formatted,
    // not the raw digits we put on the wire.
    recipient: r.recipient_name || (r.phone ? formatPhone(r.phone) : '—'),
    phone: r.phone ? formatPhone(r.phone) : null,
    trigger: r.trigger_type,
    status: r.status,
    draftCount: Number(r.draft_count || 0),
    draftTotal: money(r.draft_total),
    error: r.error || null,
    at: r.created_at,
    atFmt: r.created_at ? shortDate(r.created_at) + ' ' + String(new Date(r.created_at).toISOString().slice(11, 16)) : '—',
    message: r.message || null
  };
}

// ── Recharge ────────────────────────────────────────────────────────────────

const RUN_STATUS = {
  draft:     { label: 'Not posted yet',  bg: 'var(--neutral-100)', fg: 'var(--neutral-600)' },
  posted:    { label: 'Posted to Xero', bg: 'var(--green-100)', fg: '#126b42' },
  cancelled: { label: 'Cancelled',       bg: 'var(--neutral-100)', fg: 'var(--neutral-600)' }
};

// One line of the Recharge runs table.
//
// A run carries exactly one line in this model, so a row is a run: the bill
// that was paid, the invoice raised in the payer, and the mirror bill in the
// entity the cost belongs to. All three link into Xero, and the three links
// are not interchangeable — two of the documents are in one organisation and
// the third is in another.
function rechargeRunRow(r, { currency = 'RM', shortCodes = new Map() } = {}) {
  const line = (r.lines || [])[0] || {};
  const payerCode = r.payer_code || '—';
  const ownerCode = line.code || '—';
  const payerShort = shortCodes.get(r.payer_tenant_id) || null;
  const ownerShort = shortCodes.get(line.target_tenant_id) || null;

  // Which rule decided this, as a line somebody can read against the rules
  // tabs. Snapshotted values first: the rule may since have been edited.
  const notes = r.text_rule_name
    ? `Recharge rule · ${r.text_rule_name}`
    : r.premises_address
      ? `Address rule · ${r.premises_address}`
      : r.rule_id
        ? 'Address rule'
        : 'Raised by hand';

  const status = RUN_STATUS[r.status] || RUN_STATUS.draft;
  return {
    id: r.id,
    status: r.status,
    // Worked out under testing mode: real arithmetic over real bills, but
    // nothing was sent to Xero and nothing ever will be. It has to read as
    // that rather than as a draft somebody forgot to post.
    testMode: Boolean(r.test_mode),
    statusLabel: r.test_mode ? 'Testing mode' : status.label,
    statusBg: r.test_mode ? 'var(--amber-100)' : status.bg,
    statusFg: r.test_mode ? '#8a6300' : status.fg,
    // The premises that decided it, where one did. The notes line renders it;
    // kept separate so a caller can use it on its own.
    address: r.premises_address || null,
    // The organisation the paid bill sits in.
    entityCode: payerCode,
    entityShort: r.payer_short || '—',

    billRef: r.bill_reference || '—',
    billSupplier: r.supplier_name || '—',
    billTotalFmt: money(r.bill_total),
    paidFmt: r.paid_on ? shortDate(r.paid_on) : 'not recorded',
    billUrl: xeroLinks.billUrl(r.xero_invoice_id, payerShort),

    // Who raises the AR invoice. The payer, by construction — shown as its
    // own column because that is the question being answered.
    invoicingCode: payerCode,
    invoicingShort: r.payer_short || '—',

    invoiceNo: line.ar_invoice_number || null,
    invoiceUrl: xeroLinks.salesInvoiceUrl(line.ar_invoice_id, payerShort),

    rechargeCode: ownerCode,
    rechargeShort: line.short_name || '—',

    // The reference we wrote on both sides, which is what reads back as the
    // intercompany bill. Xero's own number is the fallback.
    billNo: line.reference || line.ap_invoice_number || null,
    billNoUrl: xeroLinks.billUrl(line.ap_invoice_id, ownerShort),
    rechargeFmt: money(line.amount),

    notes,
    currency,

    // A run that has not reached Xero has no documents to link to, so the
    // row has to offer the thing that would create them.
    posted: Boolean(line.ar_invoice_id && line.ap_invoice_id),
    partial: Boolean(line.ar_invoice_id) !== Boolean(line.ap_invoice_id),
    // A test run can never be posted: the Xero guard would refuse it, and
    // offering a button that always fails is worse than not offering one.
    canPost: r.status === 'draft' && !r.test_mode,
    canCancel: r.status === 'draft' && !line.ar_invoice_id && !line.ap_invoice_id,
    error: line.line_error || r.post_error || null,

    lineId: line.id || null
  };
}

function rechargeRuleCard(r) {
  if (!r) return null;
  const code = r.owner_code || '—';
  const suppliers = (r.suppliers || []).map((x) => x.name);
  return {
    id: r.id,
    ownerTenantId: r.owner_tenant_id,
    ownerCode: code,
    ownerShort: r.owner_short || '—',
    suppliers,
    // No suppliers means every supplier, which is a real rule and has to read
    // as one rather than as a blank cell.
    supplierLabel: suppliers.length === 0 ? 'Any supplier'
      : suppliers.length === 1 ? suppliers[0]
      : `${suppliers[0]} + ${suppliers.length - 1} more`,
    address: r.premises_address || null,
    referenceContains: r.reference_contains || null,
    on: Boolean(r.enabled),
    effect: `Header ${code}: no recharge · Any other header: 100% recharged to ${code}`,
    // A rule with no address decides nothing. That can only come from an
    // older database, and saying so beats a row that looks configured.
    incomplete: !r.premises_address || !r.owner_tenant_id
  };
}

// A recharge rule. `waiting` is how many paid bills it is sitting on.
function rechargeTextRuleCard(r, waiting = 0) {
  if (!r) return null;
  const conditions = (r.conditions || []).map((c) => ({
    field: c.field,
    fieldLabel: rechargeModel.fieldLabel(c.field),
    operator: c.operator,
    operatorLabel: rechargeModel.operatorLabel(c.operator),
    value: c.value
  }));
  const start = r.start_date ? shortDate(r.start_date) : null;
  return {
    id: r.id,
    name: r.name,
    matchMode: r.match_mode,
    joiner: r.match_mode === 'any' ? 'OR' : 'AND',
    conditions,
    payerTenantId: r.payer_tenant_id || null,
    payerLabel: r.payer_tenant_id ? `${r.payer_code || '—'} · ${r.payer_short || '—'}` : 'Any entity',
    ownerTenantId: r.owner_tenant_id,
    ownerCode: r.owner_code || '—',
    ownerShort: r.owner_short || '—',
    startDate: r.start_date ? String(r.start_date instanceof Date
      ? r.start_date.toISOString().slice(0, 10)
      : r.start_date).slice(0, 10) : null,
    on: Boolean(r.enabled),
    waiting: Number(waiting) || 0,
    waitingLabel: waiting ? `${waiting} paid bill${waiting === 1 ? '' : 's'} waiting` : null,
    meta: `Bills paid on or after ${start || '—'} · `
        + (r.last_run_at ? `last run ${shortDate(r.last_run_at)}` : 'Not run yet')
  };
}

function rechargeSettings(s) {
  return {
    arAccountCode: s.ar_account_code || null,
    apAccountCode: s.ap_account_code || null,
    taxType: s.tax_type || 'NONE',
    referencePrefix: s.reference_prefix || 'IC-',
    dueDays: Number(s.due_days || 30),
    // Nothing can be posted until both codes are set.
    configured: Boolean(s.ar_account_code && s.ap_account_code)
  };
}

function rechargeSuggestion(p, currency = 'RM') {
  const owner = p.lines[0] || {};
  return {
    billId: p.bill.id,
    supplier: p.bill.contact_name,
    reference: p.bill.reference || p.bill.invoice_number,
    totalFmt: money(p.bill.total),
    paidFmt: p.bill.fully_paid_on ? shortDate(p.bill.fully_paid_on) : shortDate(p.bill.bill_date),
    ruleId: p.kind === 'address' ? p.rule.id : null,
    textRuleId: p.kind === 'text' ? p.rule.id : null,
    kind: p.kind,
    ruleName: p.ruleName || null,
    address: p.address || null,
    reason: p.reason || null,
    ownerTenantId: owner.tenantId || null,
    ownerCode: owner.code || '—',
    ownerShort: owner.shortName || '—',
    amountFmt: money(owner.amount != null ? owner.amount : p.bill.total),
    currency
  };
}

function rechargeStatCards(stats, currency = 'RM') {
  return [
    {
      label: 'Recharged to date',
      amount: `${currency} ${money(stats.recharged)}`,
      sub: `${stats.runs} bill${stats.runs === 1 ? '' : 's'} recharged`,
      color: 'var(--blue-500)'
    },
    {
      label: 'Xero invoices',
      amount: String(stats.arInvoices),
      sub: 'Raised by the invoicing entity',
      color: 'var(--color-primary)'
    },
    {
      label: 'Xero bills',
      amount: String(stats.apBills),
      sub: `Across ${stats.apEntities} recharge ${stats.apEntities === 1 ? 'entity' : 'entities'}`,
      color: 'var(--green-500)'
    },
    {
      label: 'Active rules',
      amount: String(stats.rulesActive),
      // Split by kind, because "10 rules" says nothing about whether the
      // premises side or the text side is doing the work.
      sub: `${stats.addressRules} address · ${stats.textRules} recharge rule${stats.textRules === 1 ? '' : 's'}`,
      color: 'var(--neutral-400)'
    }
  ];
}

module.exports = {
  billRow, statCards, statusTabs, metaText, banner, money, shortDate,
  batchCard, bankStatCards, bankAccountRow, bankFormatRow, payeeRow,
  digestSettings, nextRunLabel, recipientRow, digestRunRow,
  rechargeRunRow, rechargeRuleCard, rechargeTextRuleCard, rechargeSettings,
  rechargeSuggestion, rechargeStatCards
};
