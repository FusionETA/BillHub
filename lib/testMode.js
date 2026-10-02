// Testing mode: exercise the whole app against real Xero data without
// changing anything in Xero.
//
// The point is to test the thing that is hard to test — bank file generation —
// which needs real bills, real payees and real bank accounts, but must not
// move a single bill to Paid in a live organisation. So: reads go through
// untouched, and every call that would CHANGE something is refused.
//
// The refusal lives in lib/xero.js, at the one place every Xero call passes
// through. That is deliberate. A flag each caller is supposed to honour is a
// flag someone eventually forgets, and the whole value of this switch is that
// it holds even when the code above it is wrong.
//
// Held per account in the database rather than in an env var, so it survives a
// restart and can be turned off from the UI rather than a deploy.

const db = require('../db');

// Read once every few seconds rather than on every Xero call. A toggle updates
// this immediately, so the window only matters when another process changes
// the row — and then it closes on its own.
const TTL_MS = 5000;
const cache = new Map();   // accountId -> { on, at }

async function isOn(accountId) {
  const id = Number(accountId);
  if (!id) return false;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.on;
  let on = false;
  try {
    const row = await db.getOne('SELECT test_mode FROM accounts WHERE id = ?', [id]);
    on = Boolean(row && Number(row.test_mode));
  } catch (e) {
    // A column that does not exist yet, or a database hiccup. Fail open: this
    // switch protects a test, it is not what protects live organisations —
    // XERO_TENANT_ALLOWLIST is, and that one is read from the environment and
    // cannot fail this way.
    if (!/test_mode/.test(e.message)) throw e;
    on = false;
  }
  cache.set(id, { on, at: Date.now() });
  return on;
}

async function set(accountId, on) {
  const id = Number(accountId);
  await db.execute('UPDATE accounts SET test_mode = ? WHERE id = ?', [on ? 1 : 0, id]);
  cache.set(id, { on: Boolean(on), at: Date.now() });
  console.warn(`[testMode] account ${id}: testing mode ${on ? 'ON — no writes will reach Xero' : 'OFF — writes reach Xero again'}`);
  return Boolean(on);
}

function forget(accountId) {
  cache.delete(Number(accountId));
}

// Thrown instead of making the call. 409 rather than 403: nothing is wrong
// with the request or the permissions — the app is simply in a mode where it
// does not write.
function refusal(what = 'That') {
  const err = new Error(
    `${what} was not sent to Xero: testing mode is on. `
    + 'Everything else ran as normal — turn testing mode off to let changes through.'
  );
  err.statusCode = 409;
  err.testMode = true;
  return err;
}

module.exports = { isOn, set, forget, refusal };
