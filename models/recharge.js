// Recharge settings, rules and runs.
const crypto = require('crypto');
const db = require('../db');
const premises = require('../lib/premises');

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
function ruleKey(premisesAddress, referenceContains, supplierNames = []) {
  const suppliers = [...new Set(supplierNames.map(premises.normalise).filter(Boolean))].sort();
  return crypto.createHash('sha256')
    .update([premises.normalise(premisesAddress), premises.normalise(referenceContains), suppliers.join(',')].join('|'))
    .digest('hex');
}

async function listRules(accountId) {
  const rules = await db.query(
    `SELECT r.*, e.code AS owner_code, e.short_name AS owner_short
       FROM recharge_rules r
       LEFT JOIN entities e ON e.account_id = r.account_id AND e.xero_tenant_id = r.owner_tenant_id
      WHERE r.account_id = ?
      ORDER BY e.code, r.premises_address`,
    [accountId]
  );
  if (!rules.length) return [];
  const sup = await db.query(
    `SELECT s.rule_id, s.supplier_name, s.supplier_key
       FROM recharge_rule_suppliers s
       JOIN recharge_rules r ON r.id = s.rule_id
      WHERE r.account_id = ?
      ORDER BY s.supplier_name`,
    [accountId]
  );
  const byRule = new Map();
  for (const x of sup) {
    if (!byRule.has(x.rule_id)) byRule.set(x.rule_id, []);
    byRule.get(x.rule_id).push({ name: x.supplier_name, key: x.supplier_key });
  }
  return rules.map((r) => ({ ...r, suppliers: byRule.get(r.id) || [] }));
}

async function getRule(accountId, id) {
  return (await listRules(accountId)).find((r) => r.id === Number(id)) || null;
}

function bad(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function validateRule({ premisesAddress, ownerTenantId }) {
  if (!premisesAddress || !String(premisesAddress).trim()) {
    throw bad('The premises address is required — it is what decides which entity the cost belongs to.');
  }
  // Short enough to sit inside half the addresses in the country: a rule like
  // this would recharge far more than whoever wrote it intended.
  if (premises.tooShort(premisesAddress)) {
    throw bad(
      `"${String(premisesAddress).trim()}" is too short to identify a premises. `
      + 'Write it as the bill prints it, including the street and postcode.'
    );
  }
  if (!ownerTenantId) throw bad('Choose the entity to recharge to.');
}

// Suppliers are optional: none means every supplier, which is the right rule
// for a premises one company occupies outright.
function cleanSuppliers(list) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) {
    const name = String(raw || '').trim();
    const key = premises.normalise(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    out.push({ name, key });
  }
  return out;
}

async function clashingRule(accountId, key, exceptId = null) {
  return db.getOne(
    `SELECT r.id, r.premises_address, e.code
       FROM recharge_rules r
       LEFT JOIN entities e ON e.account_id = r.account_id AND e.xero_tenant_id = r.owner_tenant_id
      WHERE r.account_id = ? AND r.rule_key = ? ${exceptId ? 'AND r.id <> ?' : ''}`,
    exceptId ? [accountId, key, exceptId] : [accountId, key]
  );
}

async function createRule(accountId, { suppliers = [], premisesAddress, referenceContains = null, ownerTenantId, enabled = true }) {
  validateRule({ premisesAddress, ownerTenantId });
  const address = String(premisesAddress).trim();
  const reference = String(referenceContains || '').trim() || null;
  const list = cleanSuppliers(suppliers);
  const key = ruleKey(address, reference, list.map((x) => x.name));

  // Checked here as well as by the unique index, because a duplicate key
  // error says nothing about which rule already claims this.
  const clash = await clashingRule(accountId, key);
  if (clash) {
    throw Object.assign(
      new Error(`That premises is already recharged to ${clash.code || 'another entity'} by an identical rule. Edit that one instead.`),
      { statusCode: 409 }
    );
  }

  return db.transaction(async (conn) => {
    const [res] = await conn.execute(
      `INSERT INTO recharge_rules
         (account_id, premises_address, address_key, reference_contains, owner_tenant_id, rule_key, enabled)
       VALUES (?,?,?,?,?,?,?)`,
      [accountId, address, premises.normalise(address), reference, ownerTenantId, key, enabled ? 1 : 0]
    );
    for (const x of list) {
      await conn.execute(
        'INSERT INTO recharge_rule_suppliers (rule_id, supplier_name, supplier_key) VALUES (?,?,?)',
        [res.insertId, x.name, x.key]
      );
    }
    return res.insertId;
  });
}

async function updateRule(accountId, id, fields = {}) {
  const current = await getRule(accountId, id);
  if (!current) throw Object.assign(new Error('Rule not found.'), { statusCode: 404 });

  // Only the toggle moves on its own; anything touching what a rule matches
  // is re-validated against the whole merged rule, not the patch alone.
  const merged = {
    premisesAddress: fields.premisesAddress ?? current.premises_address,
    referenceContains: 'referenceContains' in fields ? fields.referenceContains : current.reference_contains,
    ownerTenantId: fields.ownerTenantId ?? current.owner_tenant_id,
    suppliers: 'suppliers' in fields ? fields.suppliers : current.suppliers.map((x) => x.name)
  };
  const touches = ['premisesAddress', 'referenceContains', 'ownerTenantId', 'suppliers'].some((k) => k in fields);
  if (touches) validateRule(merged);

  const address = String(merged.premisesAddress).trim();
  const reference = String(merged.referenceContains || '').trim() || null;
  const list = cleanSuppliers(merged.suppliers);
  const key = ruleKey(address, reference, list.map((x) => x.name));

  if (touches && key !== current.rule_key) {
    const clash = await clashingRule(accountId, key, id);
    if (clash) {
      throw Object.assign(
        new Error(`Another rule already covers "${clash.premises_address}" in exactly the same way.`),
        { statusCode: 409 }
      );
    }
  }

  return db.transaction(async (conn) => {
    const sets = [];
    const params = [];
    if (touches) {
      sets.push('premises_address = ?', 'address_key = ?', 'reference_contains = ?', 'owner_tenant_id = ?', 'rule_key = ?');
      params.push(address, premises.normalise(address), reference, merged.ownerTenantId, key);
    }
    if ('enabled' in fields) { sets.push('enabled = ?'); params.push(fields.enabled ? 1 : 0); }
    if (sets.length) {
      params.push(accountId, id);
      await conn.execute(`UPDATE recharge_rules SET ${sets.join(', ')} WHERE account_id = ? AND id = ?`, params);
    }
    if ('suppliers' in fields) {
      await conn.execute('DELETE FROM recharge_rule_suppliers WHERE rule_id = ?', [id]);
      for (const x of list) {
        await conn.execute(
          'INSERT INTO recharge_rule_suppliers (rule_id, supplier_name, supplier_key) VALUES (?,?,?)',
          [id, x.name, x.key]
        );
      }
    }
    return 1;
  });
}

async function deleteRule(accountId, id) {
  const res = await db.execute('DELETE FROM recharge_rules WHERE account_id = ? AND id = ?', [accountId, id]);
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

async function createTextRule(accountId, {
  name, matchMode = 'all', conditions = [], payerTenantId = null, ownerTenantId, enabled = true
}) {
  validateTextRule({ name, ownerTenantId });
  const conds = cleanConditions(conditions);
  if (payerTenantId && payerTenantId === ownerTenantId) {
    throw bad('A rule that pays and recharges to the same entity would do nothing.');
  }

  return db.transaction(async (conn) => {
    const [res] = await conn.execute(
      `INSERT INTO recharge_text_rules
         (account_id, name, match_mode, payer_tenant_id, owner_tenant_id, enabled)
       VALUES (?,?,?,?,?,?)`,
      [accountId, String(name).trim(), matchMode === 'any' ? 'any' : 'all',
       payerTenantId || null, ownerTenantId, enabled ? 1 : 0]
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
  const addr = await db.getOne(
    'SELECT COUNT(*) AS total, SUM(enabled) AS active FROM recharge_rules WHERE account_id = ?',
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
    rulesTotal: n(addr?.total) + n(text?.total),
    rulesActive: n(addr?.active) + n(text?.active),
    addressRules: n(addr?.total),
    addressRulesActive: n(addr?.active),
    textRules: n(text?.total),
    textRulesActive: n(text?.active)
  };
}

module.exports = {
  getSettings, updateSettings,
  listRules, getRule, createRule, updateRule, deleteRule, validateRule, ruleKey,
  listTextRules, getTextRule, createTextRule, updateTextRule, deleteTextRule, markTextRuleRun,
  FIELDS, OPERATORS, fieldLabel, operatorLabel, fieldNeedsXero,
  listRuns, getRun, createRun, setLinePosted, setLineError, refreshRunStatus,
  setRunError, cancelRun, summary
};
