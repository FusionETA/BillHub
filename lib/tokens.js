// Small token helpers. Raw tokens go in cookies/links; only their SHA-256 hash
// is stored in the DB, so a DB read alone can't be used to impersonate.
const crypto = require('crypto');

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

module.exports = { randomToken, sha256hex };
