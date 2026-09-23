// Notifications API.
//
//   GET    /api/digest                  settings, recipients, preview, history
//   PATCH  /api/digest/settings         schedule, content and channel
//   GET    /api/digest/preview          the message as it would be sent
//   POST   /api/digest/test             one message to one number
//   POST   /api/digest/send             send now, to everyone
//   GET    /api/digest/recipients
//   POST   /api/digest/recipients
//   PATCH  /api/digest/recipients/:id
//   DELETE /api/digest/recipients/:id
//   GET    /api/digest/runs             the send log
const express = require('express');
const router = express.Router();

const digest = require('./digest');
const digestModel = require('../models/digest');
const entities = require('../models/entities');
const accounts = require('../models/accounts');
const schedule = require('../lib/schedule');
const vm = require('./viewModel');
const { attachUser, requireAuth } = require('../auth/middleware');

router.use(attachUser, requireAuth);

function needAccount(req, res) {
  if (!req.user.account_id) { res.status(400).json({ error: 'This user has no account.' }); return null; }
  return req.user.account_id;
}

function fail(res, err, fallback = 500) {
  const xeroAuth = err.statusCode === 401;
  res.status(xeroAuth ? 424 : (err.statusCode || fallback))
     .json({ error: err.message, ...(xeroAuth ? { needsXeroReconnect: true } : {}) });
}

router.get('/', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const [settings, recipients, runs] = await Promise.all([
      digestModel.getSettings(accountId),
      digestModel.listRecipients(accountId),
      digestModel.listRuns(accountId, { limit: 20 })
    ]);

    let entityCount = 0;
    try {
      const wazzocrAccountId = await accounts.wazzocrIdFor(accountId);
      entityCount = (await entities.listByAccount(accountId, wazzocrAccountId)).length;
    } catch { /* Xero not linked yet; the digest still previews as empty */ }

    const preview = await digest.previewFor(accountId, null);
    const active = recipients.filter((r) => r.enabled).length;

    res.json({
      settings: vm.digestSettings(settings),
      recipients: recipients.map((r) => vm.recipientRow(r, entityCount)),
      recipientMeta: recipients.length
        ? `${active} of ${recipients.length} number${recipients.length === 1 ? '' : 's'} active. `
          + `Each recipient can be assigned all ${entityCount} entities or only the ones they are responsible for.`
        : 'No recipients yet. Add the numbers that should receive the digest.',
      digestText: preview.text,
      previewSummary: {
        count: preview.summary.count,
        total: vm.money(preview.summary.total),
        entities: preview.summary.entities
      },
      nextRun: vm.nextRunLabel(settings),
      runs: runs.map(vm.digestRunRow),
      entityCount
    });
  } catch (err) {
    console.error('[digest] view failed:', err.message);
    fail(res, err);
  }
});

router.patch('/settings', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  const body = req.body || {};
  if (body.frequency && !['daily', 'weekly', 'monthly'].includes(body.frequency)) {
    return res.status(400).json({ error: 'frequency must be daily, weekly or monthly.' });
  }
  if (body.timezone) {
    try { new Intl.DateTimeFormat('en-GB', { timeZone: body.timezone }); }
    catch { return res.status(400).json({ error: `"${body.timezone}" is not a timezone I recognise.` }); }
  }
  try {
    await digestModel.updateSettings(accountId, body);
    const settings = await digestModel.getSettings(accountId);
    res.json({ ok: true, settings: vm.digestSettings(settings), nextRun: vm.nextRunLabel(settings) });
  } catch (err) { fail(res, err); }
});

// The message as one recipient would receive it. ?recipientId= scopes it.
router.get('/preview', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const recipient = req.query.recipientId
      ? await digestModel.getRecipient(accountId, req.query.recipientId)
      : null;
    if (req.query.recipientId && !recipient) return res.status(404).json({ error: 'Recipient not found.' });
    const out = await digest.previewFor(accountId, recipient);
    res.json({
      text: out.text,
      summary: { count: out.summary.count, total: vm.money(out.summary.total), entities: out.summary.entities },
      recipient: recipient ? vm.recipientRow(recipient) : null
    });
  } catch (err) { fail(res, err); }
});

router.post('/test', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  const phone = (req.body || {}).phone;
  if (!phone) return res.status(400).json({ error: 'A WhatsApp number is required.' });
  try {
    res.json(await digest.sendTest(accountId, phone));
  } catch (err) {
    console.error('[digest] test send failed:', err.message);
    fail(res, err, 502);
  }
});

// Send the real digest now, outside the schedule. Does not touch
// `last_sent_for`, so the scheduled run still happens.
router.post('/send', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    res.json(await digest.sendDigest(accountId, {
      triggerType: 'manual',
      onlyRecipientId: (req.body || {}).recipientId || null
    }));
  } catch (err) {
    console.error('[digest] manual send failed:', err.message);
    fail(res, err, 502);
  }
});

// ── Recipients ──────────────────────────────────────────────────────────────

router.get('/recipients', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const rows = await digestModel.listRecipients(accountId);
    res.json({ recipients: rows.map((r) => vm.recipientRow(r)) });
  } catch (err) { fail(res, err); }
});

router.post('/recipients', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const id = await digestModel.createRecipient(accountId, req.body || {});
    res.status(201).json({ ok: true, recipient: vm.recipientRow(await digestModel.getRecipient(accountId, id)) });
  } catch (err) { fail(res, err, 400); }
});

router.patch('/recipients/:id(\\d+)', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const n = await digestModel.updateRecipient(accountId, Number(req.params.id), req.body || {});
    if (!n) return res.status(404).json({ error: 'Recipient not found.' });
    res.json({ ok: true, recipient: vm.recipientRow(await digestModel.getRecipient(accountId, Number(req.params.id))) });
  } catch (err) { fail(res, err, 400); }
});

router.delete('/recipients/:id(\\d+)', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const n = await digestModel.deleteRecipient(accountId, Number(req.params.id));
    if (!n) return res.status(404).json({ error: 'Recipient not found.' });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

router.get('/runs', async (req, res) => {
  const accountId = needAccount(req, res); if (!accountId) return;
  try {
    const rows = await digestModel.listRuns(accountId, { limit: Math.min(Number(req.query.limit) || 50, 200) });
    res.json({ runs: rows.map(vm.digestRunRow) });
  } catch (err) { fail(res, err); }
});

module.exports = router;
