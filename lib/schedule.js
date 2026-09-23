// Deciding whether a digest is due.
//
// The send time is local wall-clock — "09:00 MYT" must stay 09:00 whether the
// server runs in Singapore or a UTC container. Everything here works from the
// account's timezone via Intl, so there is no dependency on the host's TZ and no
// timezone library to keep up to date.

// The date and time in a given zone, as plain parts.
// Returns { date: 'YYYY-MM-DD', minutes: 0-1439, weekday: 1=Mon…7=Sun, day, lastDay }
function localNow(timezone, now = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
    }).formatToParts(now);
  } catch {
    // An unknown zone should not stop the digest; fall back to UTC and say so.
    console.error(`[schedule] unknown timezone "${timezone}" — falling back to UTC.`);
    return localNow('UTC', now);
  }

  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  // en-GB gives 24 for midnight; normalise it to 0.
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

  return {
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    minutes: hour * 60 + minute,
    weekday: weekdayMap[get('weekday')] || 1,
    day,
    // Day 0 of the next month is the last day of this one.
    lastDay: new Date(Date.UTC(year, month, 0)).getUTCDate()
  };
}

// 'HH:MM:SS' or 'HH:MM' -> minutes past midnight.
function timeToMinutes(value) {
  const [h, m] = String(value || '09:00').split(':').map(Number);
  return (Number.isFinite(h) ? h : 9) * 60 + (Number.isFinite(m) ? m : 0);
}

// Is today a day this schedule sends on?
function isSendDay(settings, local) {
  if (settings.frequency === 'weekly') return local.weekday === Number(settings.day_of_week || 1);
  if (settings.frequency === 'monthly') {
    // `|| 1` would turn 0 ("last day") into the 1st, so test for null instead.
    const want = settings.day_of_month == null ? 1 : Number(settings.day_of_month);
    // 0 means "last day", and a 31st asked for in February falls on the 28th
    // rather than being skipped for the month.
    if (want === 0) return local.day === local.lastDay;
    return local.day === Math.min(want, local.lastDay);
  }
  // daily
  if (settings.working_days_only) return local.weekday <= 5;
  return true;
}

// Should a digest go out right now?
//
// `last_sent_for` holds the local date already sent, so a tick that finds today
// there does nothing — a restart, a slow run or an overlapping tick cannot send
// the same digest twice.
//
// Returns { due: boolean, reason: string, localDate: string }.
function isDue(settings, now = new Date()) {
  if (!settings) return { due: false, reason: 'no settings' };
  if (!settings.enabled) return { due: false, reason: 'digest is switched off' };
  if (!settings.channel_id) return { due: false, reason: 'no Wazzup channel configured' };

  const local = localNow(settings.timezone || 'UTC', now);
  const target = timeToMinutes(settings.send_time);

  if (!isSendDay(settings, local)) {
    return { due: false, reason: `not a send day (${settings.frequency})`, localDate: local.date };
  }
  if (local.minutes < target) {
    return { due: false, reason: `not yet ${settings.send_time} in ${settings.timezone}`, localDate: local.date };
  }
  // A run that is more than 6 hours late is skipped rather than fired at a
  // strange hour — the server was probably down, and a 09:00 digest arriving at
  // 21:00 is worse than none.
  if (local.minutes - target > 6 * 60) {
    return { due: false, reason: 'missed today\'s window', localDate: local.date, missed: true };
  }

  const alreadySent = settings.last_sent_for
    ? new Date(settings.last_sent_for).toISOString().slice(0, 10)
    : null;
  if (alreadySent === local.date) {
    return { due: false, reason: 'already sent today', localDate: local.date };
  }

  return { due: true, reason: 'due', localDate: local.date };
}

// "Fri 4 Sep 2026, 09:00" for the message header. The month names are spelled
// out here rather than taken from Intl, which renders September as "Sept" and
// would disagree with every date elsewhere in the app.
const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function describeNow(timezone, now = new Date()) {
  const local = localNow(timezone, now);
  const [year, month, day] = local.date.split('-').map(Number);
  const hh = String(Math.floor(local.minutes / 60)).padStart(2, '0');
  const mm = String(local.minutes % 60).padStart(2, '0');
  return `${DAYS[local.weekday]} ${day} ${MONTHS[month - 1]} ${year}, ${hh}:${mm}`;
}

module.exports = { localNow, timeToMinutes, isSendDay, isDue, describeNow };
