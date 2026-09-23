// Bank files API.
//
//   GET    /api/payments                 the Bank files view model
//   POST   /api/payments/sync            pull bank accounts + payee details from Xero
//   GET    /api/payments/bank-accounts   paying accounts, with their file formats
//   PATCH  /api/payments/bank-accounts/:id
//   GET    /api/payments/formats         available file layouts
//   PUT    /api/payments/formats/:key    create or edit this account's layout
//   GET    /api/payments/payees          supplier bank details
//   PUT    /api/payments/payees/:tenantId/:contactId
//   POST   /api/payments/preview         dry-run a batch: totals, warnings, sample file
//   POST   /api/payments/batches         create a batch
//   GET    /api/payments/batches/:id/file    download it
//   POST   /api/payments/batches/:id/uploaded   confirm sent, and post to Xero
//   POST   /api/payments/batches/:id/cancel
const express = require('express');
const router = express.Router();

const payments = require('./payments');
const batches = require('../models/batches');
const bankAccounts = require('../models/bankAccounts');
const bankFormats = require('../models/bankFormats');
const payees = require('../models/payees');
const entities = require('../models/entities');
const grantSource = require('../lib/grantSource');
const vm = require('./viewModel');
const { attachUser, requireAuth } = require('../auth/middleware');

router.use(attachUser, requireAuth);

function needAccount(req, res) {
  if (!req.user.account_id) { res.status(400).json({ error: 'This user has no account.' }); return null; }
  return req.user.account_id;
}

// Same split as the bills router: a Xero auth problem is not a lost session.
// The label for money on screen: the organisations' own base currency, or
// nothing at all when they disagree — see models/entities.currencyFor.
async function currencyFor(req) {
  const connAccountId = await grantSource.connectionsAccountId(req.user.account_id);
  return entities.currencyFor(req.user.account_id, connAccountId);
}

function fail(res, err, fallback = 500) {
  const xeroAuth = err.statusCode === 401;
  res.status(xeroAuth ? 424 : (err.statusCode || fallback))
     .json({ error: err.message, ...(xeroAuth ? { needsXeroReconnect: true } : {}) });
}

// ── The view ────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const cur = await currencyFor(req);
    const currency = cur.symbol;
    const [batchRows, stats, bankSummary, payeeSummary] = await Promise.all([
      batches.list(accountId, { status: req.query.status || null, limit: 100 }),
      batches.summary(accountId),
      bankAccounts.summary(accountId),
      payees.summary(accountId)
    ]);

    const cards = [];
    for (const b of batchRows) {
      cards.push(vm.batchCard(b, await batches.lines(b.id), currency));
    }

    res.json({
      bankStats: vm.bankStatCards(stats, bankSummary, currency),
      batchCards: cards,
      payeeWarning: payeeSummary.missing
        ? `${payeeSummary.missing} supplier${payeeSummary.missing === 1 ? ' has' : 's have'} no bank account number.`
        : null,
      unconfiguredFormats: bankSummary.unconfigured,
      currency
    });
  } catch (err) {
    console.error('[payments] view failed:', err.message);
    fail(res, err);
  }
});

router.post('/sync', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    res.json(await payments.syncAll(accountId));
  } catch (err) {
    console.error('[payments] sync failed:', err.message);
    fail(res, err);
  }
});

// ── Paying accounts ─────────────────────────────────────────────────────────

router.get('/bank-accounts', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const rows = await bankAccounts.listByAccount(accountId, {
      tenantId: req.query.tenantId || null,
      enabledOnly: req.query.all !== 'true'
    });
    res.json({ bankAccounts: rows.map(vm.bankAccountRow) });
  } catch (err) { fail(res, err); }
});

router.patch('/bank-accounts/:id(\\d+)', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const n = await bankAccounts.update(accountId, Number(req.params.id), req.body || {});
    if (!n) return res.status(404).json({ error: 'Paying account not found.' });
    res.json({ ok: true, bankAccount: vm.bankAccountRow(await bankAccounts.getById(accountId, Number(req.params.id))) });
  } catch (err) { fail(res, err); }
});

// ── File layouts ────────────────────────────────────────────────────────────

router.get('/formats', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const rows = await bankFormats.listForAccount(accountId);
    res.json({ formats: rows.map(vm.bankFormatRow) });
  } catch (err) { fail(res, err); }
});

router.put('/formats/:key', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  const key = String(req.params.key || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/i.test(key)) {
    return res.status(400).json({ error: 'A format key is 2–64 letters, digits or hyphens.' });
  }
  try {
    const body = req.body || {};
    if (body.columns !== undefined) {
      if (!Array.isArray(body.columns) || !body.columns.length) {
        return res.status(400).json({ error: 'columns must be a non-empty array.' });
      }
      const bad = body.columns.find((c) => !c || (c.field == null && c.literal == null));
      if (bad) return res.status(400).json({ error: 'Every column needs a "field" or a "literal".' });
    }
    await bankFormats.upsertForAccount(accountId, key, body);
    res.json({ ok: true, format: vm.bankFormatRow(await bankFormats.get(accountId, key)) });
  } catch (err) { fail(res, err); }
});

router.delete('/formats/:key', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const n = await bankFormats.removeForAccount(accountId, req.params.key);
    if (!n) return res.status(404).json({ error: 'No layout of your own with that key.' });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// ── Payees ──────────────────────────────────────────────────────────────────

router.get('/payees', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const rows = await payees.listByAccount(accountId, {
      tenantId: req.query.tenantId || null,
      missingOnly: req.query.missing === 'true'
    });
    res.json({ payees: rows.map(vm.payeeRow), summary: await payees.summary(accountId) });
  } catch (err) { fail(res, err); }
});

router.put('/payees/:tenantId/:contactId', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    await payees.setManual(accountId, req.params.tenantId, req.params.contactId, req.body || {});
    res.json({ ok: true, payee: vm.payeeRow(await payees.get(accountId, req.params.tenantId, req.params.contactId)) });
  } catch (err) { fail(res, err); }
});

// ── Batches ─────────────────────────────────────────────────────────────────

// Dry run: everything createBatch would check, plus the file it would produce,
// without writing anything.
router.post('/preview', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const plan = await payments.planBatch(accountId, req.body || {});
    const format = await payments.formatFor(accountId, plan.bank);
    const { render } = require('../lib/bankFile');
    const sample = render(format, {
      reference: await batches.nextReference(accountId),
      payment_date: plan.paymentDate,
      currency_code: plan.currencyCode,
      total: plan.total,
      line_count: plan.lines.length,
      payer_name: plan.bank.entity_short,
      payer_account: plan.bank.account_number
    }, plan.lines.map((l) => ({
      contact_name: l.contactName, payee_account: l.payeeAccount,
      payee_bank: l.payeeBank, amount: l.amount, reference: l.reference
    })));

    res.json({
      reference: await batches.nextReference(accountId),
      bankAccount: vm.bankAccountRow(plan.bank),
      paymentDate: plan.paymentDate,
      currency: plan.currencyCode || '',
      total: vm.money(plan.total),
      lineCount: plan.lines.length,
      warnings: plan.warnings,
      missingPayeeAccounts: plan.missingPayeeAccounts,
      format: vm.bankFormatRow(format),
      // Enough of the file to check the layout, without shipping the lot.
      filePreview: sample.text.split(/\r?\n/).slice(0, 12).join('\n'),
      fileName: sample.fileName
    });
  } catch (err) { fail(res, err); }
});

router.post('/batches', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const out = await payments.createBatch(accountId, req.body || {});
    res.status(201).json({ ok: true, ...out });
  } catch (err) {
    console.error('[payments] create batch failed:', err.message);
    fail(res, err);
  }
});

router.get('/batches/:id(\\d+)', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const batch = await batches.getById(accountId, Number(req.params.id));
    if (!batch) return res.status(404).json({ error: 'Batch not found.' });
    const cur = await currencyFor(req);
    const currency = cur.symbol;
    res.json({ batch: vm.batchCard(batch, await batches.lines(batch.id), currency) });
  } catch (err) { fail(res, err); }
});

// Downloading is what moves a batch from ready to downloaded, so the list shows
// what is still waiting to be sent to the bank.
router.get('/batches/:id(\\d+)/file', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const { text, fileName, batch } = await payments.renderFile(accountId, Number(req.params.id));
    if (batch.status === 'cancelled') return res.status(409).json({ error: 'That batch was cancelled.' });
    await batches.markDownloaded(accountId, batch.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${batch.file_name || fileName}"`);
    res.send(text);
  } catch (err) { fail(res, err); }
});

// Confirming the file reached the bank is what records the payment in Xero.
router.post('/batches/:id(\\d+)/uploaded', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const out = await payments.postToXero(accountId, Number(req.params.id), {
      reference: (req.body || {}).reference || null
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('[payments] post to Xero failed:', err.message);
    fail(res, err);
  }
});

router.post('/batches/:id(\\d+)/cancel', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const n = await batches.cancel(accountId, Number(req.params.id));
    if (!n) {
      return res.status(409).json({
        error: 'Only a batch that has not reached Xero can be cancelled. Reverse the payment in Xero instead.'
      });
    }
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

module.exports = router;
