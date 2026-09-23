// Notifications: the schedule maths, recipient scoping, the message, and
// sending. Wazzup is stubbed at lib/wazzup.sendMessage so the payloads we would
// put on the wire are asserted rather than assumed.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.env.AUTH_DISABLED = 'false';
// Pin the grant source too: these suites exercise borrowed mode, the riskier
// of the two, whatever the local .env is set to. test/ownmode.test.js covers
// the other. Must precede any require of lib/grantSource.
process.env.XERO_GRANT_SOURCE = 'wazzocr';
// Xero is stubbed in these suites, so the credentials only need to exist —
// but they must exist, or ensureConfig refuses before the stub is reached.
process.env.XERO_CLIENT_ID = 'test-client-id';
process.env.XERO_CLIENT_SECRET = 'test-client-secret';

const http = require('http');
const db = require('../db');
const wazzup = require('../lib/wazzup');
const schedule = require('../lib/schedule');

const sends = [];
let failFor = null;   // phone that should fail
wazzup.sendMessage = async ({ channelId, apiKey, phone, text }) => {
  sends.push({ channelId, apiKey, phone, text });
  if (failFor && phone === failFor) return { ok: false, error: 'Wazzup returned HTTP 400: invalid chatId' };
  return { ok: true, messageId: 'msg-' + sends.length };
};

const app = require('../server');
const server = app.listen(3315);

function req(method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: 3315, path, method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out ? JSON.parse(out) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok    ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

const at = (iso) => new Date(iso);

(async () => {
  await require('./seed').seed({ quiet: true });
  await db.execute('DELETE FROM digest_recipient_entities');
  await db.execute('DELETE FROM digest_recipients');
  await db.execute('DELETE FROM digest_runs');
  await db.execute('DELETE FROM digest_settings');
  // seedFromEnv normally runs at boot; the wipe above happens after that.
  await require('../models/digest').seedFromEnv(1);

  const login = await req('POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'billhub-local-test' } });
  const cookie = (login.headers['set-cookie'] || [])[0].split(';')[0];

  console.log('Schedule maths');
  // 2026-09-22 is a Tuesday; 01:30Z is 09:30 in Kuala Lumpur.
  const base = { enabled: 1, channel_id: 'ch', frequency: 'daily', send_time: '09:00:00', timezone: 'Asia/Kuala_Lumpur', working_days_only: 1 };
  check('due once the local send time has passed', schedule.isDue(base, at('2026-09-22T01:30:00Z')).due);
  check('not due before it', !schedule.isDue(base, at('2026-09-22T00:30:00Z')).due);
  check('local time is read in the account timezone, not the host',
    schedule.localNow('Asia/Kuala_Lumpur', at('2026-09-22T01:30:00Z')).minutes === 570);
  check('a date already sent for is never sent again',
    !schedule.isDue({ ...base, last_sent_for: '2026-09-22' }, at('2026-09-22T01:30:00Z')).due);
  check('a window missed by more than six hours is skipped, not fired late',
    schedule.isDue(base, at('2026-09-22T12:00:00Z')).missed === true);
  check('weekends are skipped on working-days-only', !schedule.isDue(base, at('2026-09-26T01:30:00Z')).due);
  check('and included when that is switched off',
    schedule.isDue({ ...base, working_days_only: 0 }, at('2026-09-26T01:30:00Z')).due);
  check('weekly fires only on its day',
    schedule.isDue({ ...base, frequency: 'weekly', day_of_week: 2 }, at('2026-09-22T01:30:00Z')).due
    && !schedule.isDue({ ...base, frequency: 'weekly', day_of_week: 3 }, at('2026-09-22T01:30:00Z')).due);
  check('monthly day 31 lands on the last day of a short month',
    schedule.isDue({ ...base, frequency: 'monthly', day_of_month: 31 }, at('2027-02-28T01:30:00Z')).due);
  check('monthly day 0 means the last day',
    schedule.isDue({ ...base, frequency: 'monthly', day_of_month: 0 }, at('2026-09-30T01:30:00Z')).due);
  check('a disabled digest is never due', !schedule.isDue({ ...base, enabled: 0 }, at('2026-09-22T01:30:00Z')).due);
  check('an unconfigured channel is never due', !schedule.isDue({ ...base, channel_id: null }, at('2026-09-22T01:30:00Z')).due);

  console.log('\nPhone handling');
  check('a local 0-prefixed number gains the country code', wazzup.normalisePhone('012-345 6789') === '60123456789');
  check('punctuation is stripped', wazzup.normalisePhone('+60 19-887 3021') === '60198873021');
  check('it is displayed back in a readable form', wazzup.formatPhone('60123456789') === '+60 12-345 6789');

  console.log('\nSettings');
  const view = await req('GET', '/api/digest', { cookie });
  check('the channel is seeded from the environment', view.body.settings.configured === true, view.body.settings);
  check('the API key itself is never returned',
    view.body.settings.hasApiKey === true && !JSON.stringify(view.body).includes(process.env.WAZZUP_API_KEY),
    view.body.settings);
  check('it starts switched off', view.body.settings.enabled === false);
  check('the schedule is described in plain words', /Switched off/.test(view.body.nextRun), view.body.nextRun);

  const saved = await req('PATCH', '/api/digest/settings', {
    cookie, body: { enabled: true, sendTime: '9:5', frequency: 'daily', workingDaysOnly: true }
  });
  check('a sloppy time is normalised', saved.body.settings.sendTime === '09:05', saved.body.settings.sendTime);
  check('and the schedule now reads sensibly',
    saved.body.nextRun === 'Every working day at 09:05 (Asia/Kuala_Lumpur).', saved.body.nextRun);

  const badTz = await req('PATCH', '/api/digest/settings', { cookie, body: { timezone: 'Mars/Olympus' } });
  check('an unknown timezone is refused', badTz.status === 400, badTz.body);

  // Saving the form without an apiKey field must not wipe the stored key.
  await req('PATCH', '/api/digest/settings', { cookie, body: { includeBreakdown: true } });
  const still = await req('GET', '/api/digest', { cookie });
  check('saving other settings does not clear the API key', still.body.settings.hasApiKey === true);

  console.log('\nRecipients');
  const bad = await req('POST', '/api/digest/recipients', { cookie, body: { name: 'No Phone' } });
  check('a recipient without a number is refused', bad.status === 400, bad.body.error);

  const group = await req('POST', '/api/digest/recipients', {
    cookie, body: { name: 'Nurul Aisyah Rahim', phone: '012-345 6789', role: 'Finance Manager', allEntities: true }
  });
  check('a group-wide recipient is created', group.status === 201 && group.body.recipient.phone === '+60 12-345 6789', group.body);

  const dupe = await req('POST', '/api/digest/recipients', { cookie, body: { name: 'Same Number', phone: '+60 12 345 6789' } });
  check('the same number cannot be added twice', dupe.status === 409, dupe.body.error);

  const kj = (await req('GET', '/api/bills/entities', { cookie })).body.entities.find((e) => e.code === 'ABKJ');
  const scoped = await req('POST', '/api/digest/recipients', {
    cookie,
    body: { name: 'Chin Wei Loong', phone: '016-228 4410', role: 'Group Accountant', allEntities: false, tenantIds: [kj.tenantId] }
  });
  check('a scoped recipient keeps its entity assignment',
    scoped.status === 201 && scoped.body.recipient.chips.length === 1 && scoped.body.recipient.chips[0].code === 'ABKJ',
    scoped.body.recipient);

  const off = await req('POST', '/api/digest/recipients', {
    cookie, body: { name: 'Simon Chim', phone: '019-887 3021', role: 'Director', enabled: false }
  });
  check('a recipient can be created switched off', off.body.recipient.on === false);

  console.log('\nThe message');
  const groupPreview = await req('GET', '/api/digest/preview', { cookie });
  check('the group digest counts every draft',
    groupPreview.body.summary.count === 5 && groupPreview.body.summary.total === '25,647.85', groupPreview.body.summary);
  check('it is bolded the way WhatsApp expects', /\*Bills Hub · Draft bills\*/.test(groupPreview.body.text));
  check('it breaks down the top entities', /• Ayu Borneo \(KJ\) — 2 bills/.test(groupPreview.body.text), groupPreview.body.text);
  check('it names the oldest draft', /Oldest draft: 2 Sep 2026/.test(groupPreview.body.text));

  const scopedPreview = await req('GET', '/api/digest/preview?recipientId=' + scoped.body.recipient.id, { cookie });
  check('a scoped recipient sees only their own entities',
    scopedPreview.body.summary.count === 2 && scopedPreview.body.summary.entities === 1, scopedPreview.body.summary);
  check('and the header says so', /1 of 5 entities/.test(scopedPreview.body.text), scopedPreview.body.text.split('\n')[2]);

  await req('PATCH', '/api/digest/settings', { cookie, body: { includeBreakdown: false } });
  const noBreakdown = await req('GET', '/api/digest/preview', { cookie });
  check('the breakdown can be turned off', !/• Ayu Borneo/.test(noBreakdown.body.text));
  await req('PATCH', '/api/digest/settings', { cookie, body: { includeBreakdown: true } });

  console.log('\nSending');
  sends.length = 0;
  const sent = await req('POST', '/api/digest/send', { cookie });
  check('only enabled recipients are messaged', sent.body.sent === 2, sent.body);
  check('the switched-off recipient got nothing', !sends.some((s) => s.phone === '60198873021'), sends.map((s) => s.phone));
  check('the configured channel and key are used',
    sends.every((s) => s.channelId === process.env.WAZZUP_CHANNEL_ID && s.apiKey === process.env.WAZZUP_API_KEY),
    sends[0] && { channelId: sends[0].channelId });
  check('numbers are sent in Wazzup\'s digits-only form',
    sends.every((s) => /^\d+$/.test(s.phone)), sends.map((s) => s.phone));
  const scopedSend = sends.find((s) => s.phone === '60162284410');
  check('each recipient receives their own scoped text',
    scopedSend && /1 of 5 entities/.test(scopedSend.text), scopedSend && scopedSend.text.split('\n')[2]);

  const runs = (await req('GET', '/api/digest/runs', { cookie })).body.runs;
  check('every send is logged with its text', runs.length === 2 && runs.every((r) => r.message), runs.length);
  check('the log records what the numbers were at the time',
    runs.some((r) => r.draftCount === 5) && runs.some((r) => r.draftCount === 2), runs.map((r) => r.draftCount));

  console.log('\nOne bad number does not stop the rest');
  sends.length = 0;
  failFor = '60123456789';
  const partial = await req('POST', '/api/digest/send', { cookie });
  check('the failure is reported', partial.body.failed === 1 && partial.body.sent === 1, partial.body);
  check('the other recipient still got theirs', sends.length === 2, sends.length);
  const failedRun = (await req('GET', '/api/digest/runs', { cookie })).body.runs.find((r) => r.status === 'failed');
  check('and the reason is kept', failedRun && /invalid chatId/.test(failedRun.error), failedRun && failedRun.error);
  failFor = null;

  console.log('\nNothing to send');
  await db.execute("UPDATE bills SET xero_status = 'AUTHORISED' WHERE xero_status = 'DRAFT'");
  sends.length = 0;
  const empty = await req('POST', '/api/digest/send', { cookie });
  check('recipients with no drafts are skipped, not messaged', empty.body.skipped === 2 && sends.length === 0, empty.body);

  await req('PATCH', '/api/digest/settings', { cookie, body: { sendWhenEmpty: true } });
  sends.length = 0;
  const forced = await req('POST', '/api/digest/send', { cookie });
  check('unless "send even when empty" is on', forced.body.sent === 2, forced.body);
  check('and that message says there is nothing to clear',
    /No draft bills waiting/.test(sends[0].text), sends[0].text.split('\n')[4]);
  await req('PATCH', '/api/digest/settings', { cookie, body: { sendWhenEmpty: false } });
  await require('./seed').seed({ quiet: true });

  console.log('\nThe scheduler');
  const digest = require('../billhub/digest');
  await req('PATCH', '/api/digest/settings', {
    cookie, body: { enabled: true, sendTime: '09:00', frequency: 'daily', workingDaysOnly: true }
  });
  sends.length = 0;
  await digest.tick({ now: at('2026-09-22T01:30:00Z') });
  const firstTick = sends.length;
  check('a due digest is sent by the scheduler', firstTick === 2, firstTick);

  await digest.tick({ now: at('2026-09-22T01:31:00Z') });
  check('a second tick the same day sends nothing', sends.length === firstTick, sends.length);

  await digest.tick({ now: at('2026-09-23T01:30:00Z') });
  check('the next day sends again', sends.length === firstTick + 2, sends.length);

  sends.length = 0;
  await digest.tick({ now: at('2026-09-26T01:30:00Z') });  // Saturday
  check('the scheduler respects working days', sends.length === 0, sends.length);

  console.log('\nTest message');
  sends.length = 0;
  const test = await req('POST', '/api/digest/test', { cookie, body: { phone: '+60 3-1234 5678' } });
  check('a test goes to the number given', test.status === 200 && sends[0].phone === '60312345678', sends[0] && sends[0].phone);
  check('and is marked as a test', /test message from Bills Hub/.test(sends[0].text));
  const testRun = (await req('GET', '/api/digest/runs', { cookie })).body.runs[0];
  check('the log distinguishes it from a real digest', testRun.trigger === 'test', testRun.trigger);

  console.log('\nDeleting');
  const del = await req('DELETE', '/api/digest/recipients/' + off.body.recipient.id, { cookie });
  check('a recipient can be removed', del.status === 200);
  check('their history survives them',
    (await req('GET', '/api/digest/runs', { cookie })).body.runs.length > 0);

  // Disarm. These are invented numbers on what may be a real Wazzup channel,
  // and the scheduler would try them at the next send time.
  await db.execute('DELETE FROM digest_recipient_entities');
  await db.execute('DELETE FROM digest_recipients');
  await db.execute('DELETE FROM digest_runs');
  await db.execute('UPDATE digest_settings SET enabled = 0, last_sent_for = NULL');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
