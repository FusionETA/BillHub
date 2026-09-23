// Creates the first account and its owner login.
//   node scripts/create-account.js "Demo Group" owner@example.com [wazzocrAccountId]
//
// The third argument links this account to the WazzOCR account whose Xero grant
// it borrows (WazzOCR's `accounts.id`). Without it Bills Hub has no Xero access;
// you can set it later with:
//   UPDATE accounts SET wazzocr_account_id = <id> WHERE id = <id>;
//
// The password is read from the OWNER_PASSWORD environment variable, or typed
// at the prompt — never from argv, so it stays out of your shell history and
// out of the process list.
require('dotenv').config();
const readline = require('readline');
const db = require('../db');
const accounts = require('../models/accounts');
const users = require('../models/users');
const { hashPassword } = require('../auth/passwords');

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => { rl.close(); resolve(answer); });
  });
}

(async () => {
  const [name, email, wazzocrIdArg] = process.argv.slice(2);
  if (!name || !email) {
    console.error('Usage: node scripts/create-account.js "<Account name>" <owner email> [wazzocrAccountId]');
    process.exit(1);
  }
  const wazzocrAccountId = wazzocrIdArg ? Number(wazzocrIdArg) : null;
  if (wazzocrIdArg && !Number.isInteger(wazzocrAccountId)) {
    console.error('wazzocrAccountId must be a whole number (WazzOCR\'s accounts.id).');
    process.exit(1);
  }
  if (await users.getByEmail(email)) {
    console.error(`A user with the email ${email} already exists.`);
    process.exit(1);
  }

  const password = process.env.OWNER_PASSWORD || await ask('Password for the owner login (min 8 chars): ');
  const passwordHash = await hashPassword(password);

  const accountId = await accounts.create({ name, wazzocrAccountId });
  const userId = await users.createOwner({ accountId, email, name, passwordHash });
  await db.execute("UPDATE users SET status = 'active' WHERE id = ?", [userId]);

  console.log(`Account "${name}" created (id ${accountId}).`);
  console.log(`Owner login: ${email} (user id ${userId}).`);
  if (wazzocrAccountId) {
    console.log(`Borrowing the Xero grant of WazzOCR account ${wazzocrAccountId}.`);
    console.log('Next: sign in and press "Sync Xero".');
  } else {
    console.log('No WazzOCR account linked yet, so there is no Xero access.');
    console.log(`Set it with: UPDATE accounts SET wazzocr_account_id = <WazzOCR accounts.id> WHERE id = ${accountId};`);
  }
  await db.close();
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
