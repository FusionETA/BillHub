// Recharge settings, rules and runs.
const crypto = require('crypto');
const db = require('../db');
const premises = require('../lib/premises');
const utilities = require('../lib/utilities');

// ── Settings ────────────────────────────────────────────────────────────────

async function getSettings(accountId) {
  let row = await db.getOne('SELECT * FROM recharge_settings WHERE account_id = ?', [accountId]);
  if (!row) {
    await db.execute(
      'INSERT INTO recharge_settings (account_id) VALUES (?) ON DUPLICATE KEY UPDATE account_id = account_id',
      [accountId]
    );
    row = await db.getOne('SELECT * FROM recharge_settings WHERE account_id = ?', [accountId]);
  }
  return row;
}

async function updateSettings(accountId, fields = {}) {
  await getSettings(accountId);
  const map = {
    arAccountCode: 'ar_account_code', apAccountCode: 'ap_account_code',
    taxType: 'tax_type', referencePrefix: 'reference_prefix', dueDays: 'due_days'
  };
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(map)) {
    if (key in fields) { sets.push(`${col} = ?`); params.push(fields[key] === '' ? null : fields[key]); }
  }
  // Not in the map above because it is a flag, not a value: '' has to mean
  // off rather than NULL.
  if ('autoPost' in fields) { sets.push('auto_post = ?'); params.push(fields.autoPost ? 1 : 0); }
  if (!sets.length) return 0;
  params.push(accountId);
  const res = await db.execute(`UPDATE recharge_settings SET ${sets.join(', ')} WHERE account_id = ?`, params);
  return res.affectedRows;
}

// ── Address rules ───────────────────────────────────────────────────────────
//
// A rule is a statement about a place: "a bill for this premises belongs to
// that entity". It names no payer — whoever Xero has on the bill header pays
// the supplier, and the address decides whose cost it is.

// Identity of a rule: everything it matches on, normalised. Two rules with
// the same key describe exactly the same bills, so the second adds nothing
// and the unique index refuses it.
// Two rules with the same key describe the same bills. Since a rule is now
// the supplier it names plus an optional reference, that is what the key is
// made of. Rules written before the address came out keep the key they were
// saved with; editing one recomputes it, and the clash check below is what
// catches a pair that have become duplicates of each other.
// A 400 rather than a 500: everything thrown through this is something the
// person typed, and the message is written to be shown to them.
function bad(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// ── Address rules: the premises register ────────────────────────────────────
//
// Reference data for WazzOCR, not for the recharge engine.
//
// Somebody photographs a utility bill into WazzOCR's WhatsApp. WazzOCR reads
// the premises address off it, looks it up here, and learns the three things
// the paper cannot tell it: which Xero organisation to create the bill in,
// which contact to put it under, and which account code to post it to.
//
// So the ADDRESS is the key — it is what is printed on the bill — and the
// other columns are the answer. That is the opposite way round from a
// recharge rule, which matches on what a Xero bill already carries.
//
// Nothing here decides a recharge. See billhub/recharge.js loadRules.

// What the Utility column offers. Built from the account's OWN contacts,
// not from a list written somewhere else: offering Syabas to a group that
// bills only in Sabah is a dropdown nobody reads, and leaving out the one
// they do use is worse. Utilities already typed into the register come
// first, because those are the names this account has settled on.
//
// The field is free text underneath, so a utility the patterns in
// lib/utilities.js do not recognise can still be typed — and
// scripts/utilities.js --unmatched is how one gets noticed.
async function utilityOptions(accountId) {
  const [used, contacts] = await Promise.all([
    db.query('SELECT DISTINCT utility FROM recharge_rules WHERE account_id = ? AND utility IS NOT NULL', [accountId]),
    db.query(
      `SELECT DISTINCT contact_name FROM bills
        WHERE account_id = ? AND contact_name IS NOT NULL AND contact_name <> ''`, [accountId])
  ]);
  const seen = utilities.fromContacts(contacts.map((c) => c.contact_name));
  const typed = used.map((u) => u.utility).filter(Boolean);
  return [...new Set([...typed, ...seen, ...utilities.ALWAYS_OFFERED])]
    .sort((a, b) => a.localeCompare(b));
}

// Keyed on what WazzOCR looks up: the utility at the address. Two rows for
// one utility at one building would leave it with two answers and no way to
// choose, which is worse than having none.
function addressRuleKey(utility, premisesAddress) {
  return crypto.createHash('sha256')
    .update([premises.normalise(utility), premises.normalise(premisesAddress)].join('|'))
    .digest('hex');
}

// How many bills already sit under each row's contact, and in how many
// organisations. Not a warning any more — nothing here claims a bill — but
// the number that says whether the contact is one premises or a generic one
// shared by thirty companies, which is the difference between a row that
// means something and a row that will put every building's bill in one
// place.
async function addressRuleBreadth(accountId) {
  const rows = await db.query(
    `SELECT contact_name AS name, COUNT(*) AS bills,
            COUNT(DISTINCT xero_tenant_id) AS orgs
       FROM bills
      WHERE account_id = ? AND contact_name IS NOT NULL AND contact_name <> ''
      GROUP BY contact_name`, [accountId]);
  const byKey = new Map();
  for (const r of rows) {
    const key = premises.normalise(r.name);
    if (!key) continue;
    const at = byKey.get(key) || { bills: 0, orgs: 0 };
    byKey.set(key, { bills: at.bills + Number(r.bills), orgs: Math.max(at.orgs, Number(r.orgs)) });
  }
  return byKey;
}

async function listAddressRules(accountId) {
  const breadth = await addressRuleBreadth(accountId);
  const rules = await db.query(
    `SELECT r.*,
            o.code AS owner_code, o.short_name AS owner_short,
            p.code AS payer_code, p.short_name AS payer_short
       FROM recharge_rules r
       LEFT JOIN entities o ON o.account_id = r.account_id AND o.xero_tenant_id = r.owner_tenant_id
       LEFT JOIN entities p ON p.account_id = r.account_id AND p.xero_tenant_id = r.payer_tenant_id
      WHERE r.account_id = ?
      ORDER BY r.premises_address, r.utility, r.id`,
    [accountId]
  );
  return rules.map((r) => ({ ...r, ...(breadth.get(r.contact_key) || { bills: 0, orgs: 0 }) }));
}

async function getAddressRule(accountId, id) {
  return (await listAddressRules(accountId)).find((r) => r.id === Number(id)) || null;
}

// One row's worth of validation, returned rather than thrown: a bulk save
// has to be able to say which of nine rows is wrong, and saving the other
// eight while reporting the ninth is worse than saving none — half a
// register is harder to finish than an empty one.
function checkAddressRule({ premisesAddress, contactName, payerTenantId }) {
  // The address is what WazzOCR has in its hand, so a row without one can
  // never be found.
  if (!premisesAddress || !String(premisesAddress).trim()) {
    return 'Write the premises address — it is what WazzOCR reads off the bill.';
  }
  if (premises.tooShort(premisesAddress)) {
    return 'That address is too short to identify a premises. Write it as the bill prints it.';
  }
  if (!contactName || !String(contactName).trim()) {
    return 'Choose the Xero contact WazzOCR should put the bill under.';
  }
  if (!payerTenantId) return 'Choose the entity WazzOCR should create the bill in.';
  return null;
}

// Save a whole table at once. Everything or nothing: a partial save leaves
// somebody rereading forty rows to find which eight went in.
async function createAddressRules(accountId, rows = []) {
  const clean = (Array.isArray(rows) ? rows : []).map((r, i) => ({
    at: i + 1,
    utility: String(r.utility || '').trim().slice(0, 64) || null,
    premisesAddress: String(r.premisesAddress || '').trim().slice(0, 512),
    payerTenantId: r.payerTenantId || null,
    contactName: String(r.contactName || '').trim().slice(0, 255),
    accountCode: String(r.accountCode || '').trim().slice(0, 32) || null,
    ownerTenantId: r.ownerTenantId || null,
    enabled: r.enabled === false ? 0 : 1
  }));
  if (!clean.length) throw bad('Nothing to save.');

  const problems = [];
  for (const row of clean) {
    const why = checkAddressRule(row);
    if (why) problems.push({ at: row.at, contactName: row.contactName, error: why });
  }

  // A duplicate inside the batch, before the database gets a chance to
  // complain about one of them in terms of a row number nobody can see.
  const seen = new Map();
  for (const row of clean) {
    if (!row.premisesAddress) continue;
    const key = addressRuleKey(row.utility, row.premisesAddress);
    if (seen.has(key)) {
      problems.push({ at: row.at, contactName: row.contactName,
        error: `The same utility at the same address as row ${seen.get(key)}.` });
    } else seen.set(key, row.at);
  }
  if (problems.length) throw Object.assign(new Error(problems[0].error), { statusCode: 400, problems });

  return db.transaction(async (conn) => {
    const ids = [];
    for (const row of clean) {
      const key = addressRuleKey(row.utility, row.premisesAddress);
      const [existing] = await conn.execute(
        'SELECT id, premises_address FROM recharge_rules WHERE account_id = ? AND rule_key = ?',
        [accountId, key]);
      if (existing.length) {
        throw Object.assign(
          new Error(`${row.utility || 'That utility'} at "${row.premisesAddress}" is already mapped (row ${row.at}).`),
          { statusCode: 409 });
      }
      const [res] = await conn.execute(
        `INSERT INTO recharge_rules
           (account_id, utility, premises_address, address_key, payer_tenant_id,
            contact_name, contact_key, account_code, owner_tenant_id, rule_key, enabled)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [accountId, row.utility, row.premisesAddress, premises.normalise(row.premisesAddress),
         row.payerTenantId, row.contactName, premises.normalise(row.contactName),
         row.accountCode, row.ownerTenantId, key, row.enabled]
      );
      ids.push(res.insertId);
    }
    return ids;
  });
}

// What WazzOCR asks: "I have read this address off a bill — where does it
// go?" Containment on the stripped key, the same matching lib/premises.js
// has always done, so punctuation and case do not matter but a missing word
// does. The most specific match wins: a longer stored address beats a
// shorter one, because the shorter is more likely to be a prefix of several.
async function lookupPremises(accountId, { address, utility = null } = {}) {
  const text = String(address || '');
  if (!premises.normalise(text)) return null;
  const rows = (await listAddressRules(accountId)).filter((r) => r.enabled);
  let best = null;
  for (const r of rows) {
    if (utility && premises.normalise(r.utility) !== premises.normalise(utility)) continue;
    const m = premises.match(text, r.premises_address);
    if (!m) continue;
    if (!best || m.length > best.length) best = { length: m.length, rule: r };
  }
  return best ? best.rule : null;
}

async function updateAddressRule(accountId, id, fields = {}) {
  const current = await getAddressRule(accountId, id);
  if (!current) throw Object.assign(new Error('Rule not found.'), { statusCode: 404 });

  const merged = {
    utility: 'utility' in fields ? fields.utility : current.utility,
    premisesAddress: 'premisesAddress' in fields ? fields.premisesAddress : current.premises_address,
    payerTenantId: 'payerTenantId' in fields ? (fields.payerTenantId || null) : current.payer_tenant_id,
    contactName: 'contactName' in fields ? fields.contactName : current.contact_name,
    accountCode: 'accountCode' in fields ? fields.accountCode : current.account_code,
    ownerTenantId: 'ownerTenantId' in fields ? (fields.ownerTenantId || null) : current.owner_tenant_id
  };
  const touches = ['utility', 'premisesAddress', 'payerTenantId', 'contactName',
                   'accountCode', 'ownerTenantId'].some((k) => k in fields);
  if (touches) {
    const why = checkAddressRule(merged);
    if (why) throw bad(why);
  }

  const key = addressRuleKey(merged.utility, merged.premisesAddress);
  if (touches && key !== current.rule_key) {
    const clash = await db.getOne(
      'SELECT id FROM recharge_rules WHERE account_id = ? AND rule_key = ? AND id <> ?',
      [accountId, key, id]);
    if (clash) {
      throw Object.assign(
        new Error(`Another row already maps ${merged.utility || 'that utility'} at "${merged.premisesAddress}".`),
        { statusCode: 409 });
    }
  }

  const sets = [];
  const params = [];
  if (touches) {
    sets.push('utility = ?', 'premises_address = ?', 'address_key = ?', 'payer_tenant_id = ?',
              'contact_name = ?', 'contact_key = ?', 'account_code = ?',
              'owner_tenant_id = ?', 'rule_key = ?');
    params.push(
      String(merged.utility || '').trim().slice(0, 64) || null,
      String(merged.premisesAddress).trim().slice(0, 512),
      premises.normalise(merged.premisesAddress),
      merged.payerTenantId || null,
      String(merged.contactName).trim().slice(0, 255),
      premises.normalise(merged.contactName),
      String(merged.accountCode || '').trim().slice(0, 32) || null,
      merged.ownerTenantId || null, key);
  }
  if ('enabled' in fields) { sets.push('enabled = ?'); params.push(fields.enabled ? 1 : 0); }
  if (!sets.length) return 0;
  params.push(accountId, id);
  const res = await db.execute(
    `UPDATE recharge_rules SET ${sets.join(', ')} WHERE account_id = ? AND id = ?`, params);
  return res.affectedRows;
}

async function deleteAddressRule(accountId, id) {
  const res = await db.execute(
    'DELETE FROM recharge_rules WHERE account_id = ? AND id = ?', [accountId, Number(id)]);
  return res.affectedRows;
}

// ── Recharge rules ──────────────────────────────────────────────────────────
//
// For everything with no premises on it. A Xero bill carries no address
// field, so these match on the text it does carry.

const FIELDS = [
  { value: 'supplier',       label: 'Supplier',       needsXero: false },
  { value: 'reference',      label: 'Reference',      needsXero: false },
  { value: 'invoice_number', label: 'Invoice number', needsXero: false },
  // Read back one bill at a time: the list sync is summaryOnly, so these are
  // not in the local row.
  { value: 'description',    label: 'Line description', needsXero: true },
  { value: 'tracking',       label: 'Tracking category', needsXero: true }
];

const OPERATORS = [
  { value: 'contains',     label: 'contains' },
  { value: 'is',           label: 'is exactly' },
  { value: 'starts_with',  label: 'starts with' },
  { value: 'ends_with',    label: 'ends with' },
  { value: 'not_contains', label: 'does not contain' }
];

const fieldLabel = (v) => (FIELDS.find((f) => f.value === v) || {}).label || v;
const operatorLabel = (v) => (OPERATORS.find((o) => o.value === v) || {}).label || v;
const fieldNeedsXero = (v) => Boolean((FIELDS.find((f) => f.value === v) || {}).needsXero);

async function listTextRules(accountId) {
  const rules = await db.query(
    `SELECT r.*,
            o.code AS owner_code, o.short_name AS owner_short,
            p.code AS payer_code, p.short_name AS payer_short
       FROM recharge_text_rules r
       LEFT JOIN entities o ON o.account_id = r.account_id AND o.xero_tenant_id = r.owner_tenant_id
       LEFT JOIN entities p ON p.account_id = r.account_id AND p.xero_tenant_id = r.payer_tenant_id
      WHERE r.account_id = ?
      ORDER BY r.position, r.id`,
    [accountId]
  );
  if (!rules.length) return [];
  const conds = await db.query(
    `SELECT c.* FROM recharge_text_conditions c
       JOIN recharge_text_rules r ON r.id = c.rule_id
      WHERE r.account_id = ?
      ORDER BY c.position, c.id`,
    [accountId]
  );
  const byRule = new Map();
  for (const c of conds) {
    if (!byRule.has(c.rule_id)) byRule.set(c.rule_id, []);
    byRule.get(c.rule_id).push(c);
  }
  return rules.map((r) => ({ ...r, conditions: byRule.get(r.id) || [] }));
}

async function getTextRule(accountId, id) {
  return (await listTextRules(accountId)).find((r) => r.id === Number(id)) || null;
}

function cleanConditions(list) {
  const out = [];
  for (const raw of (Array.isArray(list) ? list : [])) {
    const field = String(raw.field || '').trim();
    const operator = String(raw.operator || 'contains').trim();
    const value = String(raw.value == null ? '' : raw.value).trim();
    if (!FIELDS.some((f) => f.value === field)) throw bad(`"${field}" is not a field of a bill.`);
    if (!OPERATORS.some((o) => o.value === operator)) throw bad(`"${operator}" is not a test.`);
    // A blank value would match every bill, which is never what somebody
    // writing a condition meant.
    if (!value) throw bad(`The "${fieldLabel(field)} ${operatorLabel(operator)}" condition needs a word or phrase.`);
    out.push({ field, operator, value });
  }
  if (!out.length) throw bad('A rule needs at least one condition, or it would match every paid bill.');
  return out;
}

function validateTextRule({ name, ownerTenantId }) {
  if (!name || !String(name).trim()) throw bad('A rule needs a name, so it can be recognised in the list.');
  if (!ownerTenantId) throw bad('Choose the entity to recharge to.');
}

const code = (v) => {
  const t = String(v == null ? '' : v).trim();
  return t ? t.slice(0, 32) : null;
};

async function createTextRule(accountId, {
  name, matchMode = 'all', conditions = [], payerTenantId = null, ownerTenantId, enabled = true,
  arAccountCode = null, apAccountCode = null
}) {
  validateTextRule({ name, ownerTenantId });
  const conds = cleanConditions(conditions);
  if (payerTenantId && payerTenantId === ownerTenantId) {
    throw bad('A rule that pays and recharges to the same entity would do nothing.');
  }

  return db.transaction(async (conn) => {
    const [res] = await conn.execute(
      `INSERT INTO recharge_text_rules
         (account_id, name, match_mode, payer_tenant_id, owner_tenant_id, enabled,
          ar_account_code, ap_account_code)
       VALUES (?,?,?,?,?,?,?,?)`,
      [accountId, String(name).trim(), matchMode === 'any' ? 'any' : 'all',
       payerTenantId || null, ownerTenantId, enabled ? 1 : 0,
       code(arAccountCode), code(apAccountCode)]
    );
    let i = 0;
    for (const c of conds) {
      await conn.execute(
        'INSERT INTO recharge_text_conditions (rule_id, field, operator, value, position) VALUES (?,?,?,?,?)',
        [res.insertId, c.field, c.operator, c.value, i]
      );
      i += 1;
    }
    return res.insertId;
  });
}

async function updateTextRule(accountId, id, fields = {}) {
  const current = await getTextRule(accountId, id);
  if (!current) throw Object.assign(new Error('Rule not found.'), { statusCode: 404 });

  const merged = {
    name: fields.name ?? current.name,
    ownerTenantId: fields.ownerTenantId ?? current.owner_tenant_id
  };
  const touches = ['name', 'ownerTenantId', 'matchMode', 'payerTenantId'].some((k) => k in fields);
  if (touches) validateTextRule(merged);
  const conds = 'conditions' in fields ? cleanConditions(fields.conditions) : null;

  const payer = 'payerTenantId' in fields ? (fields.payerTenantId || null) : current.payer_tenant_id;
  if (payer && payer === merged.ownerTenantId) {
    throw bad('A rule that pays and recharges to the same entity would do nothing.');
  }

  return db.transaction(async (conn) => {
    const sets = [];
    const params = [];
    if ('name' in fields) { sets.push('name = ?'); params.push(String(fields.name).trim()); }
    if ('matchMode' in fields) { sets.push('match_mode = ?'); params.push(fields.matchMode === 'any' ? 'any' : 'all'); }
    if ('payerTenantId' in fields) { sets.push('payer_tenant_id = ?'); params.push(fields.payerTenantId || null); }
    if ('ownerTenantId' in fields) { sets.push('owner_tenant_id = ?'); params.push(fields.ownerTenantId); }
    if ('enabled' in fields) { sets.push('enabled = ?'); params.push(fields.enabled ? 1 : 0); }
    if ('position' in fields) { sets.push('position = ?'); params.push(Number(fields.position) || 0); }
    // Blank clears it, which is how a rule goes back to posting to whatever
    // the original bill was booked to.
    if ('arAccountCode' in fields) { sets.push('ar_account_code = ?'); params.push(code(fields.arAccountCode)); }
    if ('apAccountCode' in fields) { sets.push('ap_account_code = ?'); params.push(code(fields.apAccountCode)); }
    if (sets.length) {
      params.push(accountId, id);
      await conn.execute(`UPDATE recharge_text_rules SET ${sets.join(', ')} WHERE account_id = ? AND id = ?`, params);
    }
    if (conds) {
      await conn.execute('DELETE FROM recharge_text_conditions WHERE rule_id = ?', [id]);
      let i = 0;
      for (const c of conds) {
        await conn.execute(
          'INSERT INTO recharge_text_conditions (rule_id, field, operator, value, position) VALUES (?,?,?,?,?)',
          [id, c.field, c.operator, c.value, i]
        );
        i += 1;
      }
    }
    return 1;
  });
}

async function deleteTextRule(accountId, id) {
  const res = await db.execute('DELETE FROM recharge_text_rules WHERE account_id = ? AND id = ?', [accountId, id]);
  return res.affectedRows;
}

async function markTextRuleRun(accountId, id) {
  await db.execute('UPDATE recharge_text_rules SET last_run_at = NOW() WHERE account_id = ? AND id = ?', [accountId, id]);
}

// ── Runs ────────────────────────────────────────────────────────────────────

async function listRuns(accountId, { status = null, limit = 100, includeTest = false } = {}) {
  const where = ['r.account_id = ?'];
  const params = [accountId];
  // A run that can never be posted sitting among real ones is only
  // confusing, so it is shown while testing mode is on and hidden after —
  // the same rule as a test payment batch.
  if (!includeTest) where.push('r.test_mode = 0');
  if (status && status !== 'all') { where.push('r.status = ?'); params.push(status); }
  const runs = await db.query(
    `SELECT r.*, e.code AS payer_code, e.short_name AS payer_short,
            t.name AS text_rule_name
       FROM recharge_runs r
       LEFT JOIN entities e ON e.account_id = r.account_id AND e.xero_tenant_id = r.payer_tenant_id
       LEFT JOIN recharge_text_rules t ON t.id = r.text_rule_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ?`,
    [...params, Number(limit)]
  );
  if (!runs.length) return [];
  const lines = await db.query(
    `SELECT l.*, e.code, e.short_name
       FROM recharge_run_lines l
       JOIN recharge_runs r ON r.id = l.run_id
       LEFT JOIN entities e ON e.account_id = r.account_id AND e.xero_tenant_id = l.target_tenant_id
      WHERE r.account_id = ?
      ORDER BY l.id`,
    [accountId]
  );
  const byRun = new Map();
  for (const l of lines) {
    if (!byRun.has(l.run_id)) byRun.set(l.run_id, []);
    byRun.get(l.run_id).push(l);
  }
  return runs.map((r) => ({ ...r, lines: byRun.get(r.id) || [] }));
}

async function getRun(accountId, id) {
  const runs = await listRuns(accountId, { limit: 1000, includeTest: true });
  return runs.find((r) => r.id === Number(id)) || null;
}

async function createRun(accountId, { ruleId = null, textRuleId = null, bill, targets, premisesAddress = null, testMode = false }) {
  return db.transaction(async (conn) => {
    const total = targets.reduce((n, t) => n + Number(t.amount), 0);
    const [res] = await conn.execute(
      `INSERT INTO recharge_runs
        (account_id, rule_id, text_rule_id, bill_id, payer_tenant_id, xero_invoice_id, supplier_name,
         bill_reference, premises_address, bill_total, recharge_total, currency_code, paid_on,
         test_mode, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft')`,
      [accountId, ruleId, textRuleId, bill.id, bill.xero_tenant_id, bill.xero_invoice_id,
       bill.contact_name, bill.reference || bill.invoice_number,
       premisesAddress ? String(premisesAddress).slice(0, 512) : null,
       Number(bill.total).toFixed(2), total.toFixed(2),
       bill.currency_code,
       // Xero's date when there is one, otherwise the moment Bills Hub
       // marked it paid — which for a bill paid here is the same day and
       // beats showing "paid not recorded" for something it paid itself.
       bill.fully_paid_on || (bill.marked_paid_at
         ? new Date(bill.marked_paid_at).toISOString().slice(0, 10) : null),
       testMode ? 1 : 0]
    );
    for (const t of targets) {
      await conn.execute(
        `INSERT INTO recharge_run_lines (run_id, target_tenant_id, share_percent, amount, reference)
         VALUES (?,?,?,?,?)`,
        [res.insertId, t.tenantId, t.sharePercent == null ? null : Number(t.sharePercent).toFixed(4),
         Number(t.amount).toFixed(2), t.reference || null]
      );
    }
    return { id: res.insertId, total };
  });
}

async function setLinePosted(lineId, { arInvoiceId, arInvoiceNumber, apInvoiceId, apInvoiceNumber }) {
  await db.execute(
    `UPDATE recharge_run_lines
        SET ar_invoice_id = COALESCE(?, ar_invoice_id),
            ar_invoice_number = COALESCE(?, ar_invoice_number),
            ap_invoice_id = COALESCE(?, ap_invoice_id),
            ap_invoice_number = COALESCE(?, ap_invoice_number),
            line_error = NULL
      WHERE id = ?`,
    [arInvoiceId || null, arInvoiceNumber || null, apInvoiceId || null, apInvoiceNumber || null, lineId]
  );
}

async function setLineError(lineId, message) {
  await db.execute('UPDATE recharge_run_lines SET line_error = ? WHERE id = ?',
    [String(message || '').slice(0, 512), lineId]);
}

// A run is posted once every line has both documents; until then it stays draft
// so a retry picks up only what is missing.
async function refreshRunStatus(accountId, runId) {
  const lines = await db.query('SELECT ar_invoice_id, ap_invoice_id FROM recharge_run_lines WHERE run_id = ?', [runId]);
  if (!lines.length) return null;
  const status = lines.every((l) => l.ar_invoice_id && l.ap_invoice_id) ? 'posted' : 'draft';
  await db.execute(
    `UPDATE recharge_runs
        SET status = ?, posted_at = IF(? <> 'draft' AND posted_at IS NULL, NOW(), posted_at)
      WHERE account_id = ? AND id = ?`,
    [status, status, accountId, runId]
  );
  return status;
}

async function setRunError(accountId, runId, message) {
  await db.execute('UPDATE recharge_runs SET post_error = ? WHERE account_id = ? AND id = ?',
    [message ? String(message).slice(0, 512) : null, accountId, runId]);
}

// Only a run that never reached Xero can be cancelled; the documents it would
// have created are real accounting records, not ours to delete behind the scenes.
async function cancelRun(accountId, id) {
  const posted = await db.getOne(
    `SELECT COUNT(*) AS n FROM recharge_run_lines
      WHERE run_id = ? AND (ar_invoice_id IS NOT NULL OR ap_invoice_id IS NOT NULL)`,
    [id]
  );
  if (Number(posted?.n || 0) > 0) {
    throw Object.assign(
      new Error('This recharge already has documents in Xero. Void them there first.'),
      { statusCode: 409 }
    );
  }
  const res = await db.execute(
    "UPDATE recharge_runs SET status = 'cancelled' WHERE account_id = ? AND id = ? AND status = 'draft'",
    [accountId, id]
  );
  return res.affectedRows;
}

async function summary(accountId, { includeTest = false } = {}) {
  const runs = await db.getOne(
    `SELECT
       COUNT(*) AS runs,
       SUM(status <> 'cancelled') AS live,
       SUM(CASE WHEN status <> 'cancelled' THEN recharge_total ELSE 0 END) AS recharged
     FROM recharge_runs WHERE account_id = ?${includeTest ? '' : ' AND test_mode = 0'}`,
    [accountId]
  );
  const lines = await db.getOne(
    `SELECT
       -- What actually exists in Xero, counted from the ids Xero returned
       -- rather than from the run's status: a part-posted run has one of the
       -- two and the figures have to say so.
       SUM(l.ar_invoice_id IS NOT NULL) AS ar_invoices,
       SUM(l.ap_invoice_id IS NOT NULL) AS ap_bills,
       COUNT(DISTINCT CASE WHEN l.ap_invoice_id IS NOT NULL THEN l.target_tenant_id END) AS ap_entities
     FROM recharge_run_lines l
     JOIN recharge_runs r ON r.id = l.run_id
     WHERE r.account_id = ? AND r.status <> 'cancelled'${includeTest ? '' : ' AND r.test_mode = 0'}`,
    [accountId]
  );
  const text = await db.getOne(
    'SELECT COUNT(*) AS total, SUM(enabled) AS active FROM recharge_text_rules WHERE account_id = ?',
    [accountId]
  );
  const n = (v) => Number(v || 0);
  return {
    runs: n(runs?.live),
    recharged: n(runs?.recharged),
    arInvoices: n(lines?.ar_invoices),
    apBills: n(lines?.ap_bills),
    apEntities: n(lines?.ap_entities),
    rulesTotal: n(text?.total),
    rulesActive: n(text?.active),
    textRules: n(text?.total),
    textRulesActive: n(text?.active)
  };
}

module.exports = {
  getSettings, updateSettings,
  utilityOptions,
  listAddressRules, getAddressRule, createAddressRules, updateAddressRule, deleteAddressRule,
  lookupPremises,
  listTextRules, getTextRule, createTextRule, updateTextRule, deleteTextRule, markTextRuleRun,
  FIELDS, OPERATORS, fieldLabel, operatorLabel, fieldNeedsXero,
  listRuns, getRun, createRun, setLinePosted, setLineError, refreshRunStatus,
  setRunError, cancelRun, summary
};
