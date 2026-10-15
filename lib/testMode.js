// Testing mode: exercise the whole app against real Xero data without
// paying anything.
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

// Paying in testing mode marks the bill paid HERE and sends no payment to
// Xero, so that everything downstream of paying — the recharge deciding and
// drafting its two documents — can be exercised. That local mark is the one
// durable trace a test leaves, and marked_paid_at is precisely what makes a
// bill recharge-eligible, so leaving it behind would mean a test bill that
// looks paid in Bills Hub for ever while Xero says it is not.
//
// Cleared on the way out, and only for bills that were never in a real
// batch. The other columns the test touched are read back from Xero by the
// next sync, which still holds the truth about them.
async function undoTestPayments(accountId) {
  const id = Number(accountId);
  // The whole of what applyPaidLocally did, put back: the balance it moved,
  // the status it advanced and the two dates it set. Clearing only
  // marked_paid_at would leave a bill reading PAID with nothing outstanding,
  // which cannot be paid for real afterwards.
  //
  // The next sync is still the authority on the first four columns and will
  // correct anything this gets wrong at the edges; marked_paid_at it will
  // not, which is why that one has to be right here.
  const res = await db.execute(
    `UPDATE bills b
       JOIN (SELECT tl.bill_id, SUM(tl.amount) AS amt
               FROM payment_batch_lines tl
               JOIN payment_batches tb ON tb.id = tl.batch_id
              WHERE tb.account_id = ? AND tb.test_mode = 1
              GROUP BY tl.bill_id) t ON t.bill_id = b.id
        SET b.amount_paid    = GREATEST(b.amount_paid - t.amt, 0),
            b.amount_due     = b.amount_due + t.amt,
            b.xero_status    = IF(b.xero_status = 'PAID', 'AUTHORISED', b.xero_status),
            b.fully_paid_on  = NULL,
            b.marked_paid_at = NULL
      WHERE b.account_id = ?
        AND b.marked_paid_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM payment_batch_lines rl
            JOIN payment_batches rb ON rb.id = rl.batch_id
           WHERE rl.bill_id = b.id AND rb.test_mode = 0
             -- A cancelled batch paid nothing, so it is no reason to leave a
             -- test mark in place.
             AND rb.status <> 'cancelled')`,
    [id, id]
  );
  return res.affectedRows || 0;
}

async function set(accountId, on) {
  const id = Number(accountId);
  let undone = 0;
  if (!on) undone = await undoTestPayments(id);
  await db.execute('UPDATE accounts SET test_mode = ? WHERE id = ?', [on ? 1 : 0, id]);
  cache.set(id, { on: Boolean(on), at: Date.now() });
  console.warn(`[testMode] account ${id}: testing mode ${on
    ? 'ON — no payment will reach Xero; recharge drafts still will'
    : 'OFF — payments reach Xero again'}`);
  if (undone) {
    console.warn(`[testMode] account ${id}: ${undone} bill(s) paid only in testing are no longer marked paid.`);
  }
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

module.exports = { isOn, set, forget, refusal, undoTestPayments };
