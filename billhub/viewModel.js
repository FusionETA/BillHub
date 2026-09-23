// Turns rows from the `bills` table into the exact view model the Bills Hub UI
// renders. Formatting lives here rather than in the browser so the numbers on
// screen, in the WhatsApp digest and in an export can never drift apart.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const { formatPhone } = require('../lib/wazzup');

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
      amount: money(stats.draft.amount),
      sub: `${plural(stats.draft.count, 'bill')} · ${entityCount(stats.draft.entities)}`,
      color: 'var(--neutral-400)'
    },
    { label: 'Awaiting approval', amount: money(stats.approval.amount), sub: plural(stats.approval.count, 'bill'), color: 'var(--amber-500)' },
    { label: 'Awaiting payment',  amount: money(stats.payment.amount),  sub: plural(stats.payment.count, 'bill'),  color: 'var(--blue-500)' },
    { label: 'Overdue',           amount: money(stats.overdue.amount),  sub: `${plural(stats.overdue.count, 'bill')} past due date`, color: 'var(--red-500)' }
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
    // A file only exists for batches that were meant to produce one.
    canDownload: Boolean(b.file_name) && b.status !== 'cancelled',
    // Confirming the upload is what posts to Xero, so it is offered only once
    // the file has actually been taken, and never twice.
    canUpload: b.status === 'downloaded' && !b.xero_batch_payment_id,
    canCancel: !b.xero_batch_payment_id && ['ready', 'downloaded'].includes(b.status),
    postedNote: b.xero_batch_payment_id ? `Recorded in Xero ${shortDate(b.xero_posted_at)}` : null,
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
      sub: 'recorded in Xero',
      color: 'var(--green-500)'
    },
    {
      label: 'Bank formats',
      amount: String(bankSummary.formats),
      sub: `across ${bankSummary.accounts} paying account${bankSummary.accounts === 1 ? '' : 's'}`
         + (bankSummary.unconfigured ? ` · ${bankSummary.unconfigured} unset` : ''),
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
    isDefault: Boolean(b.is_default),
    enabled: Boolean(b.enabled),
    label: `${b.name}${b.currency_code ? ` (${b.currency_code})` : ''}`
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
  posted:    { label: 'Awaiting settlement', bg: 'var(--amber-100)', fg: '#8a6300' },
  settled:   { label: 'Fully settled',   bg: 'var(--green-100)',   fg: '#126b42' },
  cancelled: { label: 'Cancelled',       bg: 'var(--neutral-100)', fg: 'var(--neutral-600)' }
};

function rechargeRunCard(r, currency = 'RM') {
  const status = RUN_STATUS[r.status] || RUN_STATUS.draft;
  const lines = r.lines || [];
  const posted = lines.filter((l) => l.ar_invoice_id).length;
  return {
    id: r.id,
    supplier: r.supplier_name || '—',
    billRef: r.bill_reference || '—',
    payerCode: r.payer_code || '—',
    payerShort: r.payer_short || '—',
    paidFmt: r.paid_on ? shortDate(r.paid_on) : 'not recorded',
    totalFmt: money(r.recharge_total),
    billTotalFmt: money(r.bill_total),
    // The AR document, when there is only one. With several subsidiaries each
    // gets its own invoice, so a single number would be a lie.
    arDoc: lines.length === 1
      ? (lines[0].ar_invoice_number || '—')
      : `${posted} of ${lines.length} invoices`,
    statusLabel: status.label,
    statusBg: status.bg,
    statusFg: status.fg,
    status: r.status,
    canPost: r.status === 'draft' && lines.length > 0,
    canCancel: r.status === 'draft' && !lines.some((l) => l.ar_invoice_id || l.ap_invoice_id),
    hasOpen: lines.some((l) => l.ar_invoice_id && !l.settled),
    postError: r.post_error || null,
    currency,
    lines: lines.map((l) => ({
      id: l.id,
      code: l.code || '—',
      short: l.short_name || '—',
      amountFmt: money(l.amount),
      sharePercent: l.share_percent == null ? null : Number(l.share_percent),
      doc: l.ap_invoice_number || l.reference || '—',
      arDoc: l.ar_invoice_number || null,
      posted: Boolean(l.ar_invoice_id && l.ap_invoice_id),
      partial: Boolean(l.ar_invoice_id) !== Boolean(l.ap_invoice_id),
      error: l.line_error || null,
      settled: Boolean(l.settled),
      canSettle: Boolean(l.ar_invoice_id) && !l.settled,
      settledNote: l.settled
        ? [l.settled_reference, l.settled_on ? shortDate(l.settled_on) : null].filter(Boolean).join(' · ')
        : null
    }))
  };
}

function rechargeRuleCard(r) {
  if (!r) return null;
  const targets = r.targets || [];
  return {
    id: r.id,
    supplier: r.supplier_name,
    payerTenantId: r.payer_tenant_id,
    payerCode: r.payer_code || '—',
    payerShort: r.payer_short || '—',
    on: Boolean(r.enabled),
    matchType: r.match_type,
    matchValue: r.match_value || null,
    splitLabel: r.match_type === 'reference_contains'
      ? `Reference contains "${r.match_value}"`
      : 'Any bill from this supplier',
    targets: targets.map((t) => ({
      tenantId: t.tenantId, code: t.code || '—', shortName: t.shortName || '—',
      sharePercent: t.sharePercent
    })),
    // The single-target case reads as one chip, which is the common shape.
    targetCode: targets.length === 1 ? (targets[0].code || '—') : null,
    targetShort: targets.length === 1 ? (targets[0].shortName || '—') : null,
    splitCount: targets.length
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
  return {
    billId: p.bill.id,
    supplier: p.bill.contact_name,
    reference: p.bill.reference || p.bill.invoice_number,
    totalFmt: money(p.bill.total),
    paidFmt: p.bill.fully_paid_on ? shortDate(p.bill.fully_paid_on) : shortDate(p.bill.bill_date),
    ruleId: p.rule.id,
    currency,
    lines: p.lines.map((l) => ({
      tenantId: l.tenantId, code: l.code || '—', shortName: l.shortName || '—',
      sharePercent: l.sharePercent, amountFmt: money(l.amount)
    }))
  };
}

function rechargeStatCards(stats, currency = 'RM') {
  return [
    {
      label: 'Recharged to date',
      amount: `${currency} ${money(stats.recharged)}`,
      sub: `${stats.runs} run${stats.runs === 1 ? '' : 's'}`,
      color: 'var(--blue-500)'
    },
    {
      label: 'Awaiting settlement',
      amount: `${currency} ${money(stats.openAmount)}`,
      sub: `${stats.openLines} intercompany bill${stats.openLines === 1 ? '' : 's'}`,
      color: 'var(--amber-500)'
    },
    {
      label: 'Settled',
      amount: `${currency} ${money(stats.settledAmount)}`,
      sub: `${stats.settledLines} transfer${stats.settledLines === 1 ? '' : 's'} recorded`,
      color: 'var(--green-500)'
    },
    {
      label: 'Active rules',
      amount: String(stats.rulesActive),
      sub: `of ${stats.rulesTotal} configured`,
      color: 'var(--neutral-400)'
    }
  ];
}

module.exports = {
  billRow, statCards, statusTabs, metaText, banner, money, shortDate,
  batchCard, bankStatCards, bankAccountRow, bankFormatRow, payeeRow,
  digestSettings, nextRunLabel, recipientRow, digestRunRow,
  rechargeRunCard, rechargeRuleCard, rechargeSettings, rechargeSuggestion, rechargeStatCards
};
