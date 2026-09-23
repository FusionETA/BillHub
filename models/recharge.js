// Recharge settings, rules and runs.
const db = require('../db');

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

// ── Rules ───────────────────────────────────────────────────────────────────

async function listRules(accountId) {
  const rules = await db.query(
    `SELECT r.*, e.code AS payer_code, e.short_name AS payer_short
       FROM recharge_rules r
       LEFT JOIN entities e ON e.account_id = r.account_id AND e.xero_tenant_id = r.payer_tenant_id
      WHERE r.account_id = ?
      ORDER BY r.position, r.supplier_name`,
    [accountId]
  );
  if (!rules.length) return [];
  const targets = await db.query(
    `SELECT t.rule_id, t.target_tenant_id, t.share_percent, e.code, e.short_name
       FROM recharge_rule_targets t
       JOIN recharge_rules r ON r.id = t.rule_id
       LEFT JOIN entities e ON e.account_id = r.account_id AND e.xero_tenant_id = t.target_tenant_id
      WHERE r.account_id = ?`,
    [accountId]
  );
  const byRule = new Map();
  for (const t of targets) {
    if (!byRule.has(t.rule_id)) byRule.set(t.rule_id, []);
    byRule.get(t.rule_id).push({
      tenantId: t.target_tenant_id, code: t.code, shortName: t.short_name,
      sharePercent: Number(t.share_percent)
    });
  }
  return rules.map((r) => ({ ...r, targets: byRule.get(r.id) || [] }));
}

async function getRule(accountId, id) {
  return (await listRules(accountId)).find((r) => r.id === Number(id)) || null;
}

// Shares must add up, or a recharge would silently under- or over-bill.
function validateTargets(targets) {
  if (!Array.isArray(targets) || !targets.length) {
    throw Object.assign(new Error('A rule needs at least one entity to recharge to.'), { statusCode: 400 });
  }
  const sum = targets.reduce((n, t) => n + Number(t.sharePercent ?? 100), 0);
  if (Math.abs(sum - 100) > 0.01) {
    throw Object.assign(
      new Error(`The shares add up to ${sum.toFixed(2)}%, not 100%.`),
      { statusCode: 400 }
    );
  }
}

async function createRule(accountId, { payerTenantId, supplierName, matchType = 'any', matchValue = null, enabled = true, targets = [] }) {
  if (!payerTenantId) throw Object.assign(new Error('A paying entity is required.'), { statusCode: 400 });
  if (!supplierName || !String(supplierName).trim()) throw Object.assign(new Error('A supplier is required.'), { statusCode: 400 });
  if (matchType === 'reference_contains' && !String(matchValue || '').trim()) {
    throw Object.assign(new Error('A reference match needs some text to look for.'), { statusCode: 400 });
  }
  validateTargets(targets);

  return db.transaction(async (conn) => {
    const [res] = await conn.execute(
      `INSERT INTO recharge_rules (account_id, payer_tenant_id, supplier_name, match_type, match_value, enabled)
       VALUES (?,?,?,?,?,?)`,
      [accountId, payerTenantId, String(supplierName).trim(), matchType,
       matchType === 'any' ? null : String(matchValue).trim(), enabled ? 1 : 0]
    );
    for (const t of targets) {
      await conn.execute(
        'INSERT INTO recharge_rule_targets (rule_id, target_tenant_id, share_percent) VALUES (?,?,?)',
        [res.insertId, t.tenantId, Number(t.sharePercent ?? 100).toFixed(4)]
      );
    }
    return res.insertId;
  });
}

async function updateRule(accountId, id, fields = {}) {
  const owned = await db.getOne('SELECT id FROM recharge_rules WHERE account_id = ? AND id = ?', [accountId, id]);
  if (!owned) throw Object.assign(new Error('Rule not found.'), { statusCode: 404 });
  if (fields.targets !== undefined) validateTargets(fields.targets);

  const map = {
    payerTenantId: 'payer_tenant_id', supplierName: 'supplier_name',
    matchType: 'match_type', matchValue: 'match_value', enabled: 'enabled', position: 'position'
  };
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(map)) {
    if (!(key in fields)) continue;
    sets.push(`${col} = ?`);
    params.push(key === 'enabled' ? (fields[key] ? 1 : 0) : fields[key]);
  }
  await db.transaction(async (conn) => {
    if (sets.length) {
      params.push(accountId, id);
      await conn.execute(`UPDATE recharge_rules SET ${sets.join(', ')} WHERE account_id = ? AND id = ?`, params);
    }
    if (fields.targets !== undefined) {
      await conn.execute('DELETE FROM recharge_rule_targets WHERE rule_id = ?', [id]);
      for (const t of fields.targets) {
        await conn.execute(
          'INSERT INTO recharge_rule_targets (rule_id, target_tenant_id, share_percent) VALUES (?,?,?)',
          [id, t.tenantId, Number(t.sharePercent ?? 100).toFixed(4)]
        );
      }
    }
  });
  return 1;
}

async function deleteRule(accountId, id) {
  const res = await db.execute('DELETE FROM recharge_rules WHERE account_id = ? AND id = ?', [accountId, id]);
  return res.affectedRows;
}

// ── Runs ────────────────────────────────────────────────────────────────────

async function listRuns(accountId, { status = null, limit = 100 } = {}) {
  const where = ['r.account_id = ?'];
  const params = [accountId];
  if (status && status !== 'all') { where.push('r.status = ?'); params.push(status); }
  const runs = await db.query(
    `SELECT r.*, e.code AS payer_code, e.short_name AS payer_short
       FROM recharge_runs r
       LEFT JOIN entities e ON e.account_id = r.account_id AND e.xero_tenant_id = r.payer_tenant_id
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
  const runs = await listRuns(accountId, { limit: 1000 });
  return runs.find((r) => r.id === Number(id)) || null;
}

async function createRun(accountId, { ruleId = null, bill, targets, referencePrefix = 'IC-' }) {
  return db.transaction(async (conn) => {
    const total = targets.reduce((n, t) => n + Number(t.amount), 0);
    const [res] = await conn.execute(
      `INSERT INTO recharge_runs
        (account_id, rule_id, bill_id, payer_tenant_id, xero_invoice_id, supplier_name,
         bill_reference, bill_total, recharge_total, currency_code, paid_on, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'draft')`,
      [accountId, ruleId, bill.id, bill.xero_tenant_id, bill.xero_invoice_id,
       bill.contact_name, bill.reference || bill.invoice_number,
       Number(bill.total).toFixed(2), total.toFixed(2),
       bill.currency_code, bill.fully_paid_on || null]
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
  const lines = await db.query('SELECT ar_invoice_id, ap_invoice_id, settled FROM recharge_run_lines WHERE run_id = ?', [runId]);
  if (!lines.length) return null;
  const allPosted = lines.every((l) => l.ar_invoice_id && l.ap_invoice_id);
  const allSettled = allPosted && lines.every((l) => l.settled);
  const status = allSettled ? 'settled' : allPosted ? 'posted' : 'draft';
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

async function settleLine(accountId, runId, lineId, { reference, settledOn }) {
  const owned = await db.getOne(
    `SELECT l.id, l.ar_invoice_id FROM recharge_run_lines l
       JOIN recharge_runs r ON r.id = l.run_id
      WHERE r.account_id = ? AND r.id = ? AND l.id = ?`,
    [accountId, runId, lineId]
  );
  if (!owned) throw Object.assign(new Error('Recharge line not found.'), { statusCode: 404 });
  if (!owned.ar_invoice_id) {
    throw Object.assign(new Error('That line has not been posted to Xero yet.'), { statusCode: 409 });
  }
  await db.execute(
    'UPDATE recharge_run_lines SET settled = 1, settled_reference = ?, settled_on = ? WHERE id = ?',
    [reference || null, settledOn || new Date().toISOString().slice(0, 10), lineId]
  );
  return refreshRunStatus(accountId, runId);
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

async function summary(accountId) {
  const runs = await db.getOne(
    `SELECT
       COUNT(*) AS runs,
       SUM(status <> 'cancelled') AS live,
       SUM(CASE WHEN status <> 'cancelled' THEN recharge_total ELSE 0 END) AS recharged,
       SUM(status = 'settled') AS settled_runs
     FROM recharge_runs WHERE account_id = ?`,
    [accountId]
  );
  const lines = await db.getOne(
    `SELECT
       SUM(l.settled = 0 AND l.ar_invoice_id IS NOT NULL) AS open_lines,
       SUM(CASE WHEN l.settled = 0 AND l.ar_invoice_id IS NOT NULL THEN l.amount ELSE 0 END) AS open_amount,
       SUM(l.settled = 1) AS settled_lines,
       SUM(CASE WHEN l.settled = 1 THEN l.amount ELSE 0 END) AS settled_amount
     FROM recharge_run_lines l
     JOIN recharge_runs r ON r.id = l.run_id
     WHERE r.account_id = ? AND r.status <> 'cancelled'`,
    [accountId]
  );
  const rules = await db.getOne(
    'SELECT COUNT(*) AS total, SUM(enabled) AS active FROM recharge_rules WHERE account_id = ?',
    [accountId]
  );
  const n = (v) => Number(v || 0);
  return {
    runs: n(runs?.live),
    recharged: n(runs?.recharged),
    openLines: n(lines?.open_lines),
    openAmount: n(lines?.open_amount),
    settledLines: n(lines?.settled_lines),
    settledAmount: n(lines?.settled_amount),
    rulesTotal: n(rules?.total),
    rulesActive: n(rules?.active)
  };
}

module.exports = {
  getSettings, updateSettings,
  listRules, getRule, createRule, updateRule, deleteRule, validateTargets,
  listRuns, getRun, createRun, setLinePosted, setLineError, refreshRunStatus,
  setRunError, settleLine, cancelRun, summary
};
