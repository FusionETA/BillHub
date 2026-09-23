// Account (customer workspace) data access.
const db = require('../db');

async function create({ name, status = 'active', baseCurrency = 'MYR', wazzocrAccountId = null, setupComplete = true } = {}) {
  if (!name) throw new Error('Account name is required.');
  return db.insert(
    'INSERT INTO accounts (name, status, base_currency, wazzocr_account_id, setup_complete) VALUES (?, ?, ?, ?, ?)',
    [name, status, baseCurrency, wazzocrAccountId, setupComplete ? 1 : 0]
  );
}

// The WazzOCR account whose Xero grant this account borrows. Cached: it is read
// on every Xero call and never changes outside a deliberate reconfiguration.
const _wazzocrIds = new Map();
async function wazzocrIdFor(accountId) {
  if (_wazzocrIds.has(accountId)) return _wazzocrIds.get(accountId);
  const row = await db.getOne('SELECT wazzocr_account_id FROM accounts WHERE id = ?', [accountId]);
  const id = row ? row.wazzocr_account_id : null;
  if (id == null) {
    const err = new Error('This account is not linked to a WazzOCR account yet, so it has no Xero connection. Set accounts.wazzocr_account_id.');
    err.statusCode = 424;
    throw err;
  }
  _wazzocrIds.set(accountId, id);
  return id;
}

function forgetWazzocrId(accountId) { _wazzocrIds.delete(accountId); }

function getById(id) {
  return db.getOne('SELECT * FROM accounts WHERE id = ?', [id]);
}

function list() {
  return db.query('SELECT * FROM accounts ORDER BY created_at DESC');
}

// Update a whitelisted set of fields. Returns affectedRows.
async function update(id, fields = {}) {
  const allowed = {
    name: 'name',
    status: 'status',
    baseCurrency: 'base_currency',
    wazzocrAccountId: 'wazzocr_account_id',
    setupComplete: 'setup_complete'
  };
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(allowed)) {
    if (key in fields) {
      sets.push(`${col} = ?`);
      params.push(key === 'setupComplete' ? (fields[key] ? 1 : 0) : fields[key]);
    }
  }
  if (!sets.length) return 0;
  params.push(id);
  const res = await db.execute(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, params);
  forgetWazzocrId(id);
  return res.affectedRows;
}

module.exports = { create, getById, list, update, wazzocrIdFor, forgetWazzocrId };
