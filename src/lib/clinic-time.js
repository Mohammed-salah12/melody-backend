/**
 * Clinic time-zone helpers (no extra library): convert "2026-10-16 10:00 in Asia/Gaza" to UTC
 * and back, so slots are right for the clinic whatever time zone the server runs in.
 */
const config = require('../config');

const TZ = () => config.clinic.timezone;

function parts(date, tz = TZ()) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const o = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}

/** offset of tz at the given instant, in ms (local = utc + offset) */
function offsetAt(date, tz = TZ()) {
  const p = parts(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** "YYYY-MM-DD", hour, minute in clinic time → Date (UTC instant) */
function clinicToUtc(day, h, mi = 0, tz = TZ()) {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offsetAt(new Date(guess), tz);
  t = guess - offsetAt(new Date(t), tz); // second pass handles DST edges
  return new Date(t);
}

const pad = (n) => String(n).padStart(2, '0');
/** Date → "YYYY-MM-DD" in clinic time */
const clinicDay = (date, tz = TZ()) => {
  const p = parts(date, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
};
const clinicHM = (date, tz = TZ()) => {
  const p = parts(date, tz);
  return `${pad(p.h)}:${pad(p.mi)}`;
};
const weekdayOf = (day) => new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sunday

module.exports = { parts, clinicToUtc, clinicDay, clinicHM, weekdayOf };
