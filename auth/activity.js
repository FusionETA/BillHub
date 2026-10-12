// Record every request that changed something.
//
// Mounted once, above the API routers, so a new endpoint is logged the day it
// is written rather than the day somebody remembers to log it. That is the
// whole reason this is middleware and not a call inside each handler: the
// ones that get forgotten are exactly the ones worth having.
//
// GET is not logged. Reading is not an action somebody has to answer for, and
// logging it would bury the things that are under page loads.
//
// What a button does, rather than which button was pressed: a click that
// changes nothing never reaches the server, and one that does arrives here as
// the change it made. "Approved 3 bills" is the useful record; "clicked
// Approve" is the same fact with the outcome removed.
const activity = require('../models/activity');

// Calls the browser makes on its own. A log full of these is a log nobody
// reads, and none of them is an action a person took: the page fires them on
// load, and the answer is usually "nothing was stale".
const AUTOMATIC = [
  /^\/api\/bills\/sync\/if-stale$/,
  /^\/api\/recharge\/decide$/,
  /^\/api\/recharge\/plan$/,
  /^\/api\/recharge\/text-rules\/preview$/,
  /^\/api\/payments\/preview$/
];

// method + path -> a stable action name and a sentence. First match wins, so
// the specific patterns come before the general ones.
//
// A route with no entry is still recorded, under a name derived from its
// path. An unnamed action in the log beats a missing one.
const ROUTES = [
  [/^\/api\/auth\/login$/,                       'POST',   'login',                 () => 'Signed in'],
  [/^\/api\/auth\/logout$/,                      'POST',   'logout',                () => 'Signed out'],

  [/^\/api\/bills\/(\d+)\/approve$/,             'POST',   'bill.approve',          (m) => `Approved bill ${m[1]}`],
  [/^\/api\/bills\/(\d+)\/submit$/,              'POST',   'bill.submit',           (m) => `Submitted bill ${m[1]} for approval`],
  [/^\/api\/bills\/approve$/,                    'POST',   'bill.approve',          (m, b) => `Approved ${(b?.billIds || []).length} bill(s)`],
  [/^\/api\/bills\/(\d+)\/premises$/,            'PATCH',  'bill.premises',         (m) => `Set the premises on bill ${m[1]}`],
  [/^\/api\/bills\/sync$/,                       'POST',   'bills.sync',            () => 'Started a Xero sync'],

  [/^\/api\/payments\/batches\/(\d+)\/uploaded$/, 'POST',  'payment.paid',          (m) => `Marked payment batch ${m[1]} as paid`],
  [/^\/api\/payments\/batches\/(\d+)\/cancel$/,  'POST',   'payment.cancel',        (m) => `Cancelled payment batch ${m[1]}`],
  [/^\/api\/payments\/batches\/(\d+)\/receipt$/, 'POST',   'payment.receipt',       (m) => `Attached a receipt to batch ${m[1]}`],
  [/^\/api\/payments\/batches$/,                 'POST',   'payment.batch',         (m, b) => `Created a payment batch of ${(b?.billIds || []).length} bill(s)`],

  [/^\/api\/recharge\/text-rules\/(\d+)\/run$/,  'POST',   'recharge.rule.run',     (m) => `Ran recharge rule ${m[1]}`],
  [/^\/api\/recharge\/text-rules\/(\d+)$/,       'PATCH',  'recharge.rule.update',  (m) => `Changed recharge rule ${m[1]}`],
  [/^\/api\/recharge\/text-rules\/(\d+)$/,       'DELETE', 'recharge.rule.delete',  (m) => `Deleted recharge rule ${m[1]}`],
  [/^\/api\/recharge\/text-rules$/,              'POST',   'recharge.rule.create',  (m, b) => `Created recharge rule "${b?.name || ''}"`],
  [/^\/api\/recharge\/runs\/(\d+)\/post$/,       'POST',   'recharge.post',         (m) => `Posted recharge ${m[1]} to Xero`],
  [/^\/api\/recharge\/runs\/(\d+)\/cancel$/,     'POST',   'recharge.cancel',       (m) => `Cancelled recharge ${m[1]}`],
  [/^\/api\/recharge\/runs$/,                    'POST',   'recharge.create',       (m, b) => `Recharged bill ${b?.billId ?? ''}`],
  [/^\/api\/recharge\/settings$/,                'PATCH',  'recharge.settings',     () => 'Changed the recharge settings'],

  [/^\/api\/xero\/disconnect/,                   'POST',   'xero.disconnect',       () => 'Disconnected a Xero organisation'],
  [/^\/api\/xero\//,                             'POST',   'xero.change',           () => 'Changed the Xero connection'],

  [/^\/api\/bills\/test-mode$/,                  'POST',   'testmode',              (m, b) => `Turned testing mode ${b?.on ? 'on' : 'off'}`],
  [/^\/api\/digest\//,                           null,     'notifications',         () => 'Changed the notification settings']
];

function describe(method, path, body) {
  for (const [pattern, verb, action, say] of ROUTES) {
    if (verb && verb !== method) continue;
    const m = path.match(pattern);
    if (m) return { action, summary: say(m, body) };
  }
  // Unnamed, but still recorded: "POST /api/something/42" tells whoever reads
  // it where to look, which is more than an absent row does.
  const action = path.replace(/^\/api\//, '').replace(/\/\d+/g, '').replace(/\//g, '.').slice(0, 64)
    || 'request';
  return { action, summary: `${method} ${path}` };
}

function middleware(req, res, next) {
  const method = req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  // Captured now: a handler is free to mutate req.body, and the log should
  // say what was sent, not what was left afterwards.
  const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
    ? req.body : null;
  const path = req.originalUrl.split('?')[0];

  res.on('finish', () => {
    // The two sign-in routes record themselves: they know whether the
    // attempt succeeded and who it was for, which this cannot see.
    if (path === '/api/auth/login') return;
    if (AUTOMATIC.some((p) => p.test(path))) return;

    const { action, summary } = describe(method, path, body);
    activity.record({
      accountId: req.account?.id || req.user?.account_id || null,
      user: req.user || null,
      action,
      summary,
      method,
      path,
      statusCode: res.statusCode,
      detail: body && Object.keys(body).length ? body : null,
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });
  });

  next();
}

module.exports = { middleware, describe };
