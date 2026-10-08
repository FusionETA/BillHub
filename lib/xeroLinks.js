// Links from Bills Hub into Xero.
//
// A recharge spans two organisations — the bill and the AR invoice live in
// the payer, the mirror bill lives in the entity the cost belongs to — so a
// link that does not say which organisation it means will open whichever one
// the person happened to be in last. On a forty-one organisation group that
// is not a small annoyance: it silently shows the wrong company's ledger.
//
// Xero's organisationlogin endpoint switches the session to a named
// organisation and then follows a redirect, which is the only link form that
// is safe to hand somebody here. It needs the organisation's ShortCode, read
// from /Organisation during sync and kept on `entities`.
//
// Without a short code — an organisation synced before this existed, or one
// whose /Organisation call failed — the bare link is still returned. It opens
// the right document if the person is already in that organisation and
// Xero's own "you don't have access" page if not, which is wrong but visibly
// wrong rather than quietly showing something else.

const BASE = 'https://go.xero.com';

// Xero files purchases and sales under different screens, and giving one the
// other's path lands on an error page.
const PATHS = {
  ACCPAY: '/AccountsPayable/View.aspx?InvoiceID=',
  ACCREC: '/AccountsReceivable/View.aspx?InvoiceID='
};

function invoiceUrl(type, invoiceId, shortCode = null) {
  const path = PATHS[type];
  if (!path || !invoiceId) return null;
  const target = `${path}${encodeURIComponent(invoiceId)}`;
  if (!shortCode) return `${BASE}${target}`;
  return `${BASE}/organisationlogin/default.aspx`
    + `?shortcode=${encodeURIComponent(shortCode)}`
    + `&redirecturl=${encodeURIComponent(target)}`;
}

// A supplier bill or an intercompany bill: both are ACCPAY.
const billUrl = (invoiceId, shortCode) => invoiceUrl('ACCPAY', invoiceId, shortCode);

// The AR invoice raised in the paying entity.
const salesInvoiceUrl = (invoiceId, shortCode) => invoiceUrl('ACCREC', invoiceId, shortCode);

module.exports = { invoiceUrl, billUrl, salesInvoiceUrl, BASE, PATHS };
