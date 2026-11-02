// Contact groups: which Xero contact groups each supplier belongs to.
//
// Xero returns this on the full contact record, so the payee sync already has
// it — see billhub/payments.syncPayees. Nothing here calls Xero.
const db = require('../db');

// One organisation's membership, replaced outright.
//
// Delete-then-insert rather than upsert: a contact removed from a group in
// Xero leaves no trace to upsert against, and a stale "Landlord" row is worse
// than none — it is the row that makes somebody pay a bill they had already
// taken off the list. The caller collects every page before calling this, so
// a sync that fails partway never reaches the delete.
async function replaceForTenant(accountId, tenantId, rows = []) {
  await db.execute(
    'DELETE FROM contact_groups WHERE account_id = ? AND xero_tenant_id = ?',
    [accountId, tenantId]
  );
  if (!rows.length) return 0;

  // One statement rather than a loop. A hundred landlords across forty-odd
  // organisations is a few thousand rows a sync, and that is a lot of
  // round trips to a database on the other side of a TLS handshake.
  // Chunked because a statement has a size limit and 'a few thousand' is
  // the number before this group grows.
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const values = chunk.map(() => '(?,?,?,?,?)').join(',');
    const params = [];
    for (const r of chunk) {
      params.push(accountId, tenantId, r.contactId, r.groupId || null, r.name);
    }
    // A contact can be listed in the same group twice only if Xero says so,
    // which it does not — but IGNORE costs nothing and a duplicate must not
    // cost the organisation its sync.
    const res = await db.execute(
      `INSERT IGNORE INTO contact_groups
         (account_id, xero_tenant_id, contact_id, group_id, group_name)
       VALUES ${values}`,
      params
    );
    written += res?.affectedRows || chunk.length;
  }
  return written;
}

// Every group name in scope, with how many contacts are in it.
//
// Counted by contact rather than by bill: "Landlord · 103" answers "are they
// all in there?", which is the question somebody moving off a spreadsheet
// actually has. Organisations switched off in Settings are left out, the same
// rule the bills list applies — a group is no reason to show hidden bills.
function names(accountId, tenantIds = []) {
  const where = ['g.account_id = ?', `NOT EXISTS (
      SELECT 1 FROM entities ex
       WHERE ex.account_id = g.account_id
         AND ex.xero_tenant_id = g.xero_tenant_id
         AND ex.included = 0)`];
  const params = [accountId];
  if (tenantIds.length) {
    where.push(`g.xero_tenant_id IN (${tenantIds.map(() => '?').join(',')})`);
    params.push(...tenantIds);
  }
  return db.query(
    `SELECT g.group_name AS name, COUNT(DISTINCT g.contact_id) AS n
       FROM contact_groups g
      WHERE ${where.join(' AND ')}
      GROUP BY g.group_name
      ORDER BY g.group_name`,
    params
  );
}

// What one contact is in, for the bill detail panel.
function forContact(accountId, tenantId, contactId) {
  if (!contactId) return Promise.resolve([]);
  return db.query(
    `SELECT group_name AS name FROM contact_groups
      WHERE account_id = ? AND xero_tenant_id = ? AND contact_id = ?
      ORDER BY group_name`,
    [accountId, tenantId, contactId]
  );
}

module.exports = { replaceForTenant, names, forContact };
