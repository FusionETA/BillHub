// Password hashing with Node's built-in scrypt (no native dependency, portable
// across cPanel / DigitalOcean). Stored format:
//   scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const N = 16384, r = 8, p = 1, KEYLEN = 64;

async function hashPassword(password) {
  if (!password || String(password).length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${dk.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (!password || !stored) return false;
  const parts = stored.toString().split('$'); // [scrypt, N, r, p, salt, hash]
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, ns, rs, ps, saltHex, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  const dk = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(ns), r: Number(rs), p: Number(ps)
  });
  return expected.length === dk.length && crypto.timingSafeEqual(expected, dk);
}

module.exports = { hashPassword, verifyPassword };
