// Point Bills Hub's notifications at a different Wazzup channel.
//
//   node scripts/wazzup-channel.js                   what is set now
//   node scripts/wazzup-channel.js --write           apply what .env holds
//   node scripts/wazzup-channel.js --test +60123456789
//   node scripts/wazzup-channel.js --recipients     who it sends to, and why one failed
//
// Reads the new values from .env — WAZZUP_CHANNEL_ID, WAZZUP_API_KEY,
// WAZZUP_SENDER_PHONE — rather than from the command line, so an API key
// does not end up in a shell history, in `ps`, or on somebody's screen
// share. Edit .env on the server, then run this.
//
// models/digest.seedFromEnv fills these in once on a fresh deployment and
// never overwrites, because after that the app is the source of truth and a
// stale .env must not quietly undo a rotation done through the UI. This is
// the deliberate override for when the channel really has moved.
//
// Nothing is printed in full: a key is shown as its first six characters so
// two of them can be told apart without either being readable.
require('../lib/env');
const db = require('../db');
const model = require('../models/digest');
const wazzup = require('../lib/wazzup');
const { decrypt } = require('../lib/crypto');

const ACCOUNT_ID = Number(process.env.BILLHUB_ACCOUNT_ID || process.env.DEMO_ACCOUNT_ID || 1);
const mask = (v) => (v ? `${String(v).slice(0, 8)}… (${String(v).length} chars)` : '(not set)');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : null;
}

async function stored() {
  const row = await model.getSettings(ACCOUNT_ID);
  let key = null;
  try { key = row.api_key ? decrypt(row.api_key) : null; } catch { key = '(cannot decrypt)'; }
  return { channelId: row.channel_id, apiKey: key, senderPhone: row.sender_phone };
}

async function main() {
  const now = await stored();
  const env = {
    channelId: process.env.WAZZUP_CHANNEL_ID || null,
    apiKey: process.env.WAZZUP_API_KEY || null,
    senderPhone: process.env.WAZZUP_SENDER_PHONE || null
  };

  console.log('\n                  in the database            in .env');
  for (const f of ['channelId', 'apiKey', 'senderPhone']) {
    const same = now[f] && env[f] && now[f] === env[f];
    console.log(`  ${f.padEnd(14)}  ${mask(now[f]).padEnd(26)}  ${mask(env[f])}${same ? '   same' : ''}`);
  }

  if (process.argv.includes('--recipients')) {
    const people = await model.listRecipients(ACCOUNT_ID);
    const fails = await db.query(
      `SELECT r1.* FROM digest_runs r1
        WHERE r1.account_id = ? AND r1.status = 'failed'
          AND r1.id = (SELECT MAX(r2.id) FROM digest_runs r2
                        WHERE r2.account_id = r1.account_id AND r2.phone = r1.phone
                          AND r2.status = 'failed')`, [ACCOUNT_ID]);
    const lastFail = new Map(fails.map((f) => [wazzup.normalisePhone(f.phone), f]));

    console.log(`\n${people.length} recipient(s):\n`);
    for (const p of people) {
      const num = wazzup.normalisePhone(p.phone);
      const self = num && num === wazzup.normalisePhone(now.senderPhone);
      console.log(`  ${p.enabled ? '●' : '○'}  ${String(p.name || '(no name)').padEnd(18)} ${wazzup.formatPhone(p.phone)}`);
      if (self) {
        console.log("       ^ this is the channel's own number. A channel cannot message itself,");
        console.log('         which Wazzup answers with HTTP 400.');
      }
      const f = lastFail.get(num);
      if (f) console.log(`       last failure: ${f.error}`);
    }
    console.log('');
    return;
  }

  const phone = arg('test');
  if (phone) {
    if (!now.channelId || !now.apiKey) {
      console.log('\nNo channel is configured, so there is nothing to test.\n');
      process.exitCode = 1;
      return;
    }
    console.log(`\nSending one message to ${wazzup.formatPhone(phone)} from ${now.senderPhone}…`);
    const out = await wazzup.sendMessage({
      channelId: now.channelId, apiKey: now.apiKey, phone,
      text: 'Bills Hub test — notifications now come from this number. '
          + 'Nothing to action; this is just checking it arrives.'
    });
    console.log(out.ok ? `  sent, message ${out.messageId}\n` : `  FAILED: ${out.error}\n`);
    if (!out.ok) process.exitCode = 1;
    return;
  }

  const changes = ['channelId', 'apiKey', 'senderPhone'].filter((f) => env[f] && env[f] !== now[f]);
  if (!changes.length) {
    console.log('\nThe database already matches .env. Nothing to apply.');
    console.log('Send a test with:  node scripts/wazzup-channel.js --test +60123456789\n');
    return;
  }

  if (!process.argv.includes('--write')) {
    console.log(`\n${changes.length} value(s) in .env differ: ${changes.join(', ')}.`);
    console.log('Re-run with --write to apply them.');
    console.log('Every notification goes out on the new channel from that moment.\n');
    return;
  }

  const patch = {};
  for (const f of changes) patch[f] = env[f];
  await model.updateSettings(ACCOUNT_ID, patch);

  const after = await stored();
  const ok = changes.every((f) => after[f] === env[f]);
  console.log(`\nApplied ${changes.join(', ')}.`);
  // Read back rather than trusting the write: the key goes through
  // encryption on the way in, and a key that cannot be decrypted again is a
  // channel that silently stops sending.
  console.log(ok ? '  read back and matches.' : '  WARNING: read back does NOT match. Check the encryption key.');
  console.log('\nNow send one to yourself:');
  console.log('  node scripts/wazzup-channel.js --test +60123456789\n');
  if (!ok) process.exitCode = 1;
}

main()
  .then(() => db.close())
  .catch(async (e) => { console.error('\nFAILED:', e.message, '\n'); await db.close(); process.exit(1); });
