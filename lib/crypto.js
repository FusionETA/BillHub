// AES-256-GCM encryption for secrets at rest (Xero refresh tokens, Wazzup API
// keys). Output is a Buffer suitable for a VARBINARY column: iv(12) | tag(16) |
// ciphertext. Key comes from APP_ENCRYPTION_KEY (64 hex chars = 32 bytes).
const crypto = require('crypto');

function key() {
  const k = process.env.APP_ENCRYPTION_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error('APP_ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
  }
  return Buffer.from(k, 'hex');
}

function encrypt(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

function decrypt(buf) {
  if (buf == null) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const iv = b.subarray(0, 12);
  const tag = b.subarray(12, 28);
  const enc = b.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
