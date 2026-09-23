// User (login identity) data access. Email is the unique identifier.
const db = require('../db');

const norm = (email) => String(email || '').trim().toLowerCase();

function getById(id) {
  return db.getOne('SELECT * FROM users WHERE id = ?', [id]);
}

function getByEmail(email) {
  return db.getOne('SELECT * FROM users WHERE email = ?', [norm(email)]);
}

function getByGoogleSub(googleSub) {
  if (!googleSub) return null;
  return db.getOne('SELECT * FROM users WHERE google_sub = ?', [googleSub]);
}

function getByXeroSub(xeroSub) {
  if (!xeroSub) return null;
  return db.getOne('SELECT * FROM users WHERE xero_sub = ?', [xeroSub]);
}

// Create a pending (invited) user. account_id may be null for super admins.
async function createInvited({ accountId = null, email, phone = null, name = null, role = 'owner', isSuperAdmin = false }) {
  if (!email) throw new Error('Email is required.');
  return db.insert(
    `INSERT INTO users (account_id, email, phone_number, name, role, is_super_admin, status)
     VALUES (?, ?, ?, ?, ?, ?, 'invited')`,
    [accountId, norm(email), phone, name, role, isSuperAdmin ? 1 : 0]
  );
}

// Link a Google identity to a user (claim-on-first-login). Activates if invited.
async function attachGoogle(userId, { googleSub, name = null, avatarUrl = null }) {
  await db.execute(
    `UPDATE users
     SET google_sub = ?,
         name = COALESCE(name, ?),
         avatar_url = COALESCE(avatar_url, ?),
         status = IF(status = 'invited', 'active', status)
     WHERE id = ?`,
    [googleSub, name, avatarUrl, userId]
  );
}

// Link a Xero identity to a user (claim-on-first-login). Activates if invited.
async function attachXero(userId, { xeroSub, name = null }) {
  await db.execute(
    `UPDATE users
     SET xero_sub = ?,
         name = COALESCE(name, ?),
         status = IF(status = 'invited', 'active', status)
     WHERE id = ?`,
    [xeroSub, name, userId]
  );
}

// Create an ACTIVE owner user for a self-service registration. Either passwordHash
// (email/password signup) or googleSub (Google signup) identifies them.
async function createOwner({ accountId, email, phone = null, name = null, passwordHash = null, googleSub = null, xeroSub = null, avatarUrl = null }) {
  if (!accountId) throw new Error('accountId is required.');
  if (!email) throw new Error('Email is required.');
  return db.insert(
    `INSERT INTO users (account_id, email, phone_number, name, role, is_super_admin, status, password_hash, google_sub, xero_sub, avatar_url)
     VALUES (?, ?, ?, ?, 'owner', 0, 'active', ?, ?, ?, ?)`,
    [accountId, norm(email), phone, name, passwordHash, googleSub, xeroSub, avatarUrl]
  );
}

// Set/replace the password hash. Activates if invited.
async function setPasswordHash(userId, passwordHash) {
  await db.execute(
    `UPDATE users SET password_hash = ?, status = IF(status = 'invited', 'active', status) WHERE id = ?`,
    [passwordHash, userId]
  );
}

async function markLogin(userId) {
  await db.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [userId]);
}

// Set the user's phone number (collected during onboarding).
async function setPhone(userId, phone) {
  await db.execute('UPDATE users SET phone_number = ? WHERE id = ?', [phone, userId]);
}

function listByAccount(accountId) {
  return db.query('SELECT * FROM users WHERE account_id = ? ORDER BY created_at', [accountId]);
}

module.exports = {
  getById, getByEmail, getByGoogleSub, getByXeroSub,
  createInvited, createOwner, attachGoogle, attachXero, setPasswordHash, setPhone, markLogin, listByAccount
};
