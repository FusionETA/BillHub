// The daily WhatsApp digest of draft bills.
//
// Each recipient gets the same message scoped to the organisations they are
// responsible for, so a branch accountant sees their own drafts and a director
// sees the group. The numbers come from the same queries the Bills screen uses,
// so a digest can never disagree with the hub.
const db = require('../db');
const grantSource = require('../lib/grantSource');
const digestModel = require('../models/digest');
const entities = require('../models/entities');
const accounts = require('../models/accounts');
const wazzup = require('../lib/wazzup');
const schedule = require('../lib/schedule');
const { money, shortDate } = require('./viewModel');

// ── The numbers ─────────────────────────────────────────────────────────────

// Draft totals, optionally narrowed to a recipient's organisations.
async function draftSummary(accountId, tenantIds = null) {
  const scoped = tenantIds && tenantIds.length;
  const params = [accountId];
  let where = "b.account_id = ? AND b.xero_status = 'DRAFT'";
  if (scoped) {
    where += ` AND b.xero_tenant_id IN (${tenantIds.map(() => '?').join(',')})`;
    params.push(...tenantIds);
  }

  const totals = await db.getOne(
    `SELECT COUNT(*) AS n, COALESCE(SUM(b.amount_due), 0) AS total,
            COUNT(DISTINCT b.xero_tenant_id) AS entities, MIN(b.bill_date) AS oldest
       FROM bills b WHERE ${where}`,
    params
  );

  const byEntity = await db.query(
    `SELECT b.xero_tenant_id, e.code, e.short_name,
            COUNT(*) AS n, COALESCE(SUM(b.amount_due), 0) AS total
       FROM bills b
       LEFT JOIN entities e ON e.account_id = b.account_id AND e.xero_tenant_id = b.xero_tenant_id
      WHERE ${where}
      GROUP BY b.xero_tenant_id, e.code, e.short_name
      ORDER BY total DESC`,
    params
  );

  // Which organisation the oldest draft sits in, for the nudge line.
  let oldestEntity = null;
  if (totals?.oldest) {
    const row = await db.getOne(
      `SELECT e.short_name, e.code
         FROM bills b
         LEFT JOIN entities e ON e.account_id = b.account_id AND e.xero_tenant_id = b.xero_tenant_id
        WHERE ${where} AND b.bill_date = ?
        LIMIT 1`,
      [...params, totals.oldest]
    );
    oldestEntity = row ? (row.short_name || row.code) : null;
  }

  return {
    count: Number(totals?.n || 0),
    total: Number(totals?.total || 0),
    entities: Number(totals?.entities || 0),
    oldest: totals?.oldest || null,
    oldestEntity,
    byEntity: byEntity.map((r) => ({
      tenantId: r.xero_tenant_id,
      name: r.short_name || r.code || r.xero_tenant_id,
      count: Number(r.n),
      total: Number(r.total)
    }))
  };
}

// ── The message ─────────────────────────────────────────────────────────────

// WhatsApp caps a text message at 4096 characters. 41 entities at roughly 45
// characters each fits comfortably, but "every entity" has no natural ceiling —
// so the breakdown is trimmed to whatever the budget allows rather than being
// allowed to produce a message the API will reject.
const MAX_MESSAGE = 4000;

// WhatsApp treats *text* as bold.
function buildMessage({ settings, summary, accountName, entityCount, currency = 'RM', now = new Date(), scopeLabel = null }) {
  const lines = [];
  const tail = [];          // oldest draft, the link — kept whatever else is cut
  let breakdown = [];       // one line per entity
  let omitted = 0;          // entities a deliberate top-N left out
  lines.push('*Bills Hub · Draft bills*');
  lines.push(`${schedule.describeNow(settings.timezone, now)}`);
  lines.push(scopeLabel || `${accountName} · ${entityCount} Xero ${entityCount === 1 ? 'entity' : 'entities'}`);
  lines.push('');

  if (!summary.count) {
    lines.push('No draft bills waiting. Nothing to clear today.');
  } else {
    const ent = `${summary.entities} ${summary.entities === 1 ? 'entity' : 'entities'}`;
    lines.push(`Draft bills to clear: *${summary.count}* across ${ent}`);
    lines.push(`Total value: *${currency} ${money(summary.total)}*`);

    if (settings.include_breakdown && summary.byEntity.length) {
      // 0 means every entity. Anything else is a deliberate top-N.
      const configured = Number(settings.breakdown_limit);
      const limit = Number.isFinite(configured) && configured > 0 ? configured : summary.byEntity.length;
      breakdown = summary.byEntity.slice(0, limit).map((e) =>
        `• ${e.name} — ${e.count} bill${e.count === 1 ? '' : 's'} · ${currency} ${money(e.total)}`);
      omitted = summary.byEntity.length - breakdown.length;
    }

    if (summary.oldest) {
      tail.push('');
      tail.push(`Oldest draft: ${shortDate(summary.oldest)}${summary.oldestEntity ? ` · ${summary.oldestEntity}` : ''}`);
    }
  }

  if (settings.queue_url) {
    tail.push('');
    tail.push(`Open the queue: ${settings.queue_url}`);
  }

  // Fit the breakdown into what is left of the message budget. Everything else
  // — the totals, the oldest draft, the link — matters more than the last few
  // entity lines, so those are reserved first and the list gives way.
  if (breakdown.length) {
    const fixed = [...lines, '', ...tail].join('\n').length;
    const more = (n) => `• …and ${n} more ${n === 1 ? 'entity' : 'entities'}`;
    let budget = MAX_MESSAGE - fixed;
    let shown = 0;
    let used = 0;
    for (const line of breakdown) {
      // Keep room for the "…and N more" line we may still have to add.
      const reserve = shown + 1 < breakdown.length ? more(breakdown.length - shown - 1).length + 1 : 0;
      if (used + line.length + 1 + reserve > budget) break;
      used += line.length + 1;
      shown += 1;
    }
    const dropped = omitted + (breakdown.length - shown);
    lines.push('');
    lines.push(...breakdown.slice(0, shown));
    if (dropped > 0) lines.push(more(dropped));
  }

  lines.push(...tail);
  return lines.join('\n');
}

// The message one recipient would get right now, without sending it.
async function previewFor(accountId, recipient = null, { now = new Date() } = {}) {
  const settings = await digestModel.getSettings(accountId);
  const account = await accounts.getById(accountId);
  const connAccountId = await grantSource.connectionsAccountId(accountId).catch(() => null);
  const allEntities = connAccountId
    ? await entities.listByAccount(accountId, connAccountId)
    : [];

  const scoped = recipient && !recipient.all_entities;
  const tenantIds = scoped ? (recipient.entities || []).map((e) => e.tenantId) : null;
  const summary = await draftSummary(accountId, tenantIds);

  const cur = await entities.currencyFor(accountId, connAccountId);
  const currency = cur.symbol || (account?.base_currency || '');
  const scopeLabel = scoped
    ? `${account?.name || 'Group'} · ${tenantIds.length} of ${allEntities.length} entities`
    : null;

  return {
    text: buildMessage({
      settings, summary,
      accountName: account?.name || 'Group',
      entityCount: allEntities.length,
      currency, now, scopeLabel
    }),
    summary
  };
}

// ── Sending ─────────────────────────────────────────────────────────────────

// Sends to every enabled recipient. `triggerType` separates a scheduled run from
// a manual "send now" in the log.
//
// A recipient whose send fails is logged and the run continues — one bad number
// must not stop the rest.
async function sendDigest(accountId, { triggerType = 'manual', now = new Date(), sentFor = null, onlyRecipientId = null } = {}) {
  const config = await digestModel.getSendingConfig(accountId);
  if (!config.channel_id || !config.apiKey) {
    throw Object.assign(new Error('The Wazzup channel is not configured yet.'), { statusCode: 400 });
  }

  let recipients = await digestModel.listRecipients(accountId, { enabledOnly: true });
  if (onlyRecipientId) recipients = recipients.filter((r) => r.id === Number(onlyRecipientId));
  if (!recipients.length) {
    return { sent: 0, failed: 0, skipped: 0, results: [], reason: 'no active recipients' };
  }

  const results = [];
  for (const r of recipients) {
    const { text, summary } = await previewFor(accountId, r, { now });

    // A recipient with nothing to clear is not messaged unless asked for.
    if (!summary.count && !config.send_when_empty) {
      await digestModel.logRun(accountId, {
        recipientId: r.id, phone: r.phone, triggerType, status: 'skipped',
        draftCount: 0, draftTotal: 0, error: 'no draft bills in scope', sentFor
      });
      results.push({ recipient: r.name, phone: r.phone, status: 'skipped', reason: 'nothing to clear' });
      continue;
    }

    const out = await wazzup.sendMessage({
      channelId: config.channel_id, apiKey: config.apiKey, phone: r.phone, text
    });

    await digestModel.logRun(accountId, {
      recipientId: r.id, phone: r.phone, triggerType,
      status: out.ok ? 'sent' : 'failed',
      draftCount: summary.count, draftTotal: summary.total,
      message: text, error: out.ok ? null : out.error, sentFor
    });
    results.push({ recipient: r.name, phone: r.phone, status: out.ok ? 'sent' : 'failed', error: out.error || null });
  }

  return {
    sent: results.filter((r) => r.status === 'sent').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results
  };
}

// ── Scheduler ───────────────────────────────────────────────────────────────

let timer = null;
let running = false;

// Ticks every minute and sends whatever is due. `last_sent_for` is written
// before the sending starts, so a slow run overlapping the next tick cannot
// produce a second digest.
async function tick({ now = new Date() } = {}) {
  if (running) return;
  running = true;
  try {
    const rows = await db.query("SELECT id FROM accounts WHERE status <> 'suspended'");
    for (const a of rows) {
      try {
        const settings = await digestModel.getSettings(a.id);
        const due = schedule.isDue(settings, now);
        if (!due.due) continue;

        await digestModel.markSent(a.id, due.localDate);
        const out = await sendDigest(a.id, { triggerType: 'schedule', now, sentFor: due.localDate });
        console.log(`[digest] account ${a.id} for ${due.localDate}: ${out.sent} sent, ${out.failed} failed, ${out.skipped} skipped`);
      } catch (err) {
        console.error(`[digest] account ${a.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[digest] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startScheduler({ intervalSeconds = Number(process.env.DIGEST_TICK_SECONDS || 60) } = {}) {
  if (!intervalSeconds || timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, intervalSeconds * 1000);
  if (timer.unref) timer.unref();
  console.log(`[digest] scheduler checking every ${intervalSeconds}s`);
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  draftSummary, buildMessage, previewFor, sendDigest,
  tick, startScheduler, stopScheduler
};
