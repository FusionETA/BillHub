// Digest settings, recipients and the send log.
//
// The Wazzup API key is AES-256-GCM encrypted at rest, like the Xero refresh
// token, and is never returned to the client — the API reports only whether one
// is set.
const db = require('../db');
const { encrypt, decrypt } = require('../lib/crypto');
const { normalisePhone } = require('../lib/wazzup');

const SETTINGS_COLS = `account_id, enabled, frequency, send_time, timezone, day_of_week,
                       day_of_month, working_days_only, include_breakdown, breakdown_limit,
                       send_when_empty, channel_id, api_key, sender_phone, queue_url,
                       last_sent_for, last_sent_at`;

// Settings for an account, creating the default row on first read so the rest
// of the code never has to handle "not configured yet".
async function getSettings(accountId) {
  let row = await db.getOne(`SELECT ${SETTINGS_COLS} FROM digest_settings WHERE account_id = ?`, [accountId]);
  if (!row) {
    await db.execute(
      `INSERT INTO digest_settings (account_id) VALUES (?)
       ON DUPLICATE KEY UPDATE account_id = account_id`,
      [accountId]
    );
    row = await db.getOne(`SELECT ${SETTINGS_COLS} FROM digest_settings WHERE account_id = ?`, [accountId]);
  }
  return row;
}

// Settings with the key decrypted, for the sender. Kept separate from
// getSettings so a plaintext key cannot leak into an API response by accident.
async function getSendingConfig(accountId) {
  const row = await getSettings(accountId);
  let apiKey = null;
  if (row.api_key) {
    try { apiKey = decrypt(row.api_key); }
    catch (err) { throw new Error(`Could not decrypt the Wazzup API key: ${err.message}`); }
  }
  return { ...row, apiKey };
}

const EDITABLE = {
  enabled: 'enabled', frequency: 'frequency', sendTime: 'send_time', timezone: 'timezone',
  dayOfWeek: 'day_of_week', dayOfMonth: 'day_of_month', workingDaysOnly: 'working_days_only',
  includeBreakdown: 'include_breakdown', breakdownLimit: 'breakdown_limit',
  sendWhenEmpty: 'send_when_empty', channelId: 'channel_id', senderPhone: 'sender_phone',
  queueUrl: 'queue_url'
};
const BOOLS = new Set(['enabled', 'workingDaysOnly', 'includeBreakdown', 'sendWhenEmpty']);

async function updateSettings(accountId, fields = {}) {
  await getSettings(accountId);   // make sure the row exists
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(EDITABLE)) {
    if (!(key in fields)) continue;
    sets.push(`${col} = ?`);
    if (BOOLS.has(key)) params.push(fields[key] ? 1 : 0);
    else if (key === 'sendTime') params.push(normaliseTime(fields[key]));
    else if (key === 'senderPhone') params.push(normalisePhone(fields[key]));
    else params.push(fields[key]);
  }
  // A key arriving as null clears it; an absent key leaves it alone, so saving
  // the settings form does not wipe a key the form never showed.
  if ('apiKey' in fields) {
    sets.push('api_key = ?');
    params.push(fields.apiKey ? encrypt(String(fields.apiKey)) : null);
  }
  if (!sets.length) return 0;
  params.push(accountId);
  const res = await db.execute(`UPDATE digest_settings SET ${sets.join(', ')} WHERE account_id = ?`, params);
  return res.affectedRows;
}

// Accepts 9:5, 09:05, 09:05:00. Refuses anything else rather than quietly
// substituting a default — a digest arriving at the wrong hour because a typo
// fell back to 09:00 is worse than a rejected save.
function normaliseTime(value) {
  const m = /^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/.exec(String(value == null ? '' : value).trim());
  if (!m) {
    throw Object.assign(new Error(`"${value}" is not a time I can read. Use HH:MM, e.g. 09:00.`), { statusCode: 400 });
  }
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) {
    throw Object.assign(new Error(`"${value}" is not a valid time of day.`), { statusCode: 400 });
  }
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
}

async function markSent(accountId, localDate) {
  await db.execute(
    'UPDATE digest_settings SET last_sent_for = ?, last_sent_at = NOW() WHERE account_id = ?',
    [localDate, accountId]
  );
}

// Fills in the Wazzup channel from the environment the first time, so a fresh
// deployment does not need anyone to paste a key into a form. Existing values
// are never overwritten — once the app holds the config, the app is the source
// of truth and rotating the key is an API call.
async function seedFromEnv(accountId) {
  const row = await getSettings(accountId);
  const patch = {};
  if (!row.channel_id && process.env.WAZZUP_CHANNEL_ID) patch.channelId = process.env.WAZZUP_CHANNEL_ID;
  if (!row.api_key && process.env.WAZZUP_API_KEY) patch.apiKey = process.env.WAZZUP_API_KEY;
  if (!row.sender_phone && process.env.WAZZUP_SENDER_PHONE) patch.senderPhone = process.env.WAZZUP_SENDER_PHONE;
  if (!row.queue_url && process.env.DIGEST_QUEUE_URL) patch.queueUrl = process.env.DIGEST_QUEUE_URL;
  if (!Object.keys(patch).length) return false;
  await updateSettings(accountId, patch);
  return true;
}

// ── Recipients ──────────────────────────────────────────────────────────────

async function listRecipients(accountId, { enabledOnly = false } = {}) {
  const rows = await db.query(
    `SELECT * FROM digest_recipients
      WHERE account_id = ? ${enabledOnly ? 'AND enabled = 1' : ''}
      ORDER BY name`,
    [accountId]
  );
  if (!rows.length) return [];
  const assignments = await db.query(
    `SELECT a.recipient_id, a.xero_tenant_id, e.code, e.short_name
       FROM digest_recipient_entities a
       JOIN digest_recipients r ON r.id = a.recipient_id
       LEFT JOIN entities e ON e.account_id = r.account_id AND e.xero_tenant_id = a.xero_tenant_id
      WHERE r.account_id = ?`,
    [accountId]
  );
  const byRecipient = new Map();
  for (const a of assignments) {
    if (!byRecipient.has(a.recipient_id)) byRecipient.set(a.recipient_id, []);
    byRecipient.get(a.recipient_id).push({ tenantId: a.xero_tenant_id, code: a.code, shortName: a.short_name });
  }
  return rows.map((r) => ({ ...r, entities: byRecipient.get(r.id) || [] }));
}

async function getRecipient(accountId, id) {
  const all = await listRecipients(accountId);
  return all.find((r) => r.id === Number(id)) || null;
}

async function createRecipient(accountId, { name, phone, role, enabled = true, allEntities = true, tenantIds = [] }) {
  const clean = normalisePhone(phone);
  if (!name || !String(name).trim()) throw Object.assign(new Error('A name is required.'), { statusCode: 400 });
  if (!clean || clean.length < 9) throw Object.assign(new Error('A valid WhatsApp number is required, with its country code.'), { statusCode: 400 });

  const existing = await db.getOne('SELECT id FROM digest_recipients WHERE account_id = ? AND phone = ?', [accountId, clean]);
  if (existing) throw Object.assign(new Error('That number is already a recipient.'), { statusCode: 409 });

  const id = await db.insert(
    'INSERT INTO digest_recipients (account_id, name, phone, role, enabled, all_entities) VALUES (?,?,?,?,?,?)',
    [accountId, String(name).trim(), clean, role || null, enabled ? 1 : 0, allEntities ? 1 : 0]
  );
  if (!allEntities) await setRecipientEntities(accountId, id, tenantIds);
  return id;
}

async function updateRecipient(accountId, id, fields = {}) {
  const sets = [];
  const params = [];
  if (fields.name !== undefined) { sets.push('name = ?'); params.push(String(fields.name).trim()); }
  if (fields.role !== undefined) { sets.push('role = ?'); params.push(fields.role || null); }
  if (fields.enabled !== undefined) { sets.push('enabled = ?'); params.push(fields.enabled ? 1 : 0); }
  if (fields.allEntities !== undefined) { sets.push('all_entities = ?'); params.push(fields.allEntities ? 1 : 0); }
  if (fields.phone !== undefined) {
    const clean = normalisePhone(fields.phone);
    if (!clean) throw Object.assign(new Error('A valid WhatsApp number is required.'), { statusCode: 400 });
    sets.push('phone = ?'); params.push(clean);
  }
  let affected = 0;
  if (sets.length) {
    params.push(accountId, id);
    const res = await db.execute(`UPDATE digest_recipients SET ${sets.join(', ')} WHERE account_id = ? AND id = ?`, params);
    affected = res.affectedRows;
  }
  if (fields.tenantIds !== undefined) {
    await setRecipientEntities(accountId, id, fields.tenantIds);
    affected = Math.max(affected, 1);
  }
  return affected;
}

// Replaces a recipient's entity assignment wholesale.
async function setRecipientEntities(accountId, recipientId, tenantIds = []) {
  const owned = await db.getOne('SELECT id FROM digest_recipients WHERE account_id = ? AND id = ?', [accountId, recipientId]);
  if (!owned) throw Object.assign(new Error('Recipient not found.'), { statusCode: 404 });
  await db.transaction(async (conn) => {
    await conn.execute('DELETE FROM digest_recipient_entities WHERE recipient_id = ?', [recipientId]);
    for (const t of [...new Set(tenantIds)].filter(Boolean)) {
      await conn.execute(
        'INSERT IGNORE INTO digest_recipient_entities (recipient_id, xero_tenant_id) VALUES (?,?)',
        [recipientId, t]
      );
    }
  });
}

async function deleteRecipient(accountId, id) {
  const res = await db.execute('DELETE FROM digest_recipients WHERE account_id = ? AND id = ?', [accountId, id]);
  return res.affectedRows;
}

// ── Run log ─────────────────────────────────────────────────────────────────

async function logRun(accountId, { recipientId = null, phone, triggerType = 'schedule', status, draftCount = 0, draftTotal = 0, message = null, error = null, sentFor = null }) {
  return db.insert(
    `INSERT INTO digest_runs
      (account_id, recipient_id, phone, trigger_type, status, draft_count, draft_total, message, error, sent_for)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [accountId, recipientId, phone || null, triggerType, status,
     draftCount, Number(draftTotal || 0).toFixed(2),
     message ? String(message).slice(0, 16000) : null,
     error ? String(error).slice(0, 512) : null, sentFor]
  );
}

function listRuns(accountId, { limit = 50 } = {}) {
  return db.query(
    `SELECT r.*, d.name AS recipient_name
       FROM digest_runs r
       LEFT JOIN digest_recipients d ON d.id = r.recipient_id
      WHERE r.account_id = ?
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ?`,
    [accountId, Number(limit)]
  );
}

module.exports = {
  getSettings, getSendingConfig, updateSettings, markSent, normaliseTime, seedFromEnv,
  listRecipients, getRecipient, createRecipient, updateRecipient,
  setRecipientEntities, deleteRecipient,
  logRun, listRuns
};
