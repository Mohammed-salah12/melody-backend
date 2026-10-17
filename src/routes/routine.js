/**
 * Daily Routine: the morning & evening rituals (built from the user's matched products), a log of
 * which ones were done each day, the month calendar and the weekly vitality report.
 *
 * Dates are the user's own calendar days (YYYY-MM-DD) as sent by the app, so "today" follows the
 * phone's time zone.
 */
const { Router } = require('express');

const Product = require('../models/Product');
const RoutineLog = require('../models/RoutineLog');
const Scan = require('../models/Scan');
const { recommend, productVector, needsFromMetrics } = require('../analysis/matcher');
const { weatherFor } = require('../analysis/weather');
const { HttpError } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.use(requireAuth);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 864e5;
const RECOMMENDED = { morning: '8:00 AM', evening: '9:00 PM' };

/**
 * When each ritual can be logged, in the user's local time (minutes after midnight):
 *   morning 5:00 AM – 2:00 PM; evening 5:00 PM – 3:00 AM (after midnight still counts for the
 *   evening before). Outside its window a ritual can't be ticked — so nobody does the morning
 *   routine at night, and missed days stay missed.
 */
const WINDOW = { morning: { from: 5 * 60, to: 14 * 60 }, evening: { from: 17 * 60, to: 27 * 60 } };
const clock = (min) => {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/** The phone's local date + minutes, from the server's own clock and the phone's UTC offset. */
function localNow(tz) {
  const off = Number(tz);
  // Date.getTimezoneOffset(): minutes *behind* UTC (Gaza summer = -180)
  const offset = Number.isFinite(off) && Math.abs(off) <= 14 * 60 ? off : 0;
  const local = new Date(Date.now() - offset * 60e3);
  return { date: local.toISOString().slice(0, 10), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/** Window state of `time` on ritual day `day`: upcoming | open | closed. */
function windowOf(time, day, now) {
  const w = WINDOW[time];
  // minutes since the ritual day's midnight
  const dayDiff = Math.round((Date.parse(`${now.date}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY);
  const at = dayDiff * 1440 + now.minutes;
  const state = at < w.from ? 'upcoming' : at < w.to ? 'open' : 'closed';
  return { state, opens: clock(w.from), closes: clock(w.to) };
}
// without a scan we can't match products — a simple, safe routine everyone can follow
const BASIC = {
  morning: [{ step: 'cleanser' }, { step: 'moisturizer' }, { step: 'sunscreen' }],
  evening: [{ step: 'cleanser' }, { step: 'serum' }, { step: 'moisturizer' }],
};

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const utcDay = (date) => new Date(date).toISOString().slice(0, 10);

function checkDate(value, name = 'date') {
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(value))) throw new HttpError(400, `Please send ${name} as YYYY-MM-DD.`);
  // the phone's "today" can be at most a day away from the server's
  if (Math.abs(Date.parse(`${value}T12:00:00Z`) - Date.now()) > 2.5 * DAY) throw new HttpError(400, 'That date is too far from today.');
  return value;
}

// what each step does, and where on the face it matters most
const ROLE = {
  cleanser: ['PREPARE', 'Cleansing base for active penetration.'],
  toner: ['BALANCE', 'Rebalances the skin and preps it for actives.'],
  serum: ['TREAT', 'Concentrated actives for your main concern.'],
  treatment: ['TREAT', 'Targeted night treatment — use a thin layer.'],
  moisturizer: ['NOURISH', 'Seals in hydration and supports the barrier.'],
  sunscreen: ['PROTECT', 'UV shield — apply two finger-lengths, reapply every 2 hours outdoors.'],
  mask: ['TREAT', 'Leave on as directed, then rinse.'],
  eye: ['TREAT', 'Tap gently around the eye area.'],
};
const ZONE = {
  oil: 'Forehead & T-Zone',
  pores: 'Nose & T-Zone',
  redness: 'Cheeks & nose',
  pigmentation: 'Cheeks & forehead',
  texture: 'Cheeks & chin',
  wrinkles: 'Eyes & forehead',
  dehydration: 'Whole face',
  barrier: 'Whole face',
};

function describe(step, product, need) {
  const [role, purpose] = ROLE[step] ?? ['CARE', 'Gentle daily care.'];
  let zone = step === 'sunscreen' ? 'Face, neck & ears' : 'Whole face';
  if (product && need && step !== 'sunscreen') {
    const vec = productVector(product);
    const best = Object.keys(vec).filter((c) => vec[c] > 0).sort((a, b) => vec[b] * need[b] - vec[a] * need[a])[0];
    if (best && ZONE[best]) zone = ZONE[best];
  }
  return { role, purpose, zone };
}

async function rituals(user, scan) {
  const basic = (list) => list.map((x, i) => ({ ...x, key: `${x.step}:${i}`, ...describe(x.step) }));
  if (!scan) return { morning: basic(BASIC.morning), evening: basic(BASIC.evening), personal: false };
  const products = await Product.find({ active: true }).lean();
  if (!products.length) return { morning: basic(BASIC.morning), evening: basic(BASIC.evening), personal: false };
  const rec = recommend(products, scan.results, user, { limit: 8 });
  const need = needsFromMetrics(scan.results.metrics);
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const clean = (list) =>
    list.map(({ step, productId, name, brand, category, hasImage, imageUrl, updatedAt }) => ({
      key: `${step}:${productId}`,
      step,
      productId,
      name,
      brand,
      category,
      hasImage,
      imageUrl,
      updatedAt,
      ...describe(step, byId.get(String(productId)), need),
    }));
  const morning = clean(rec.routine.morning);
  const evening = clean(rec.routine.evening);
  return { morning: morning.length ? morning : basic(BASIC.morning), evening: evening.length ? evening : basic(BASIC.evening), personal: true };
}

async function planFor(user) {
  const scan = await Scan.findOne({ user: user._id, status: 'complete' }).sort({ completedAt: -1 }).select('results');
  return rituals(user, scan);
}

/**
 * GET /routine?today=YYYY-MM-DD[&day=YYYY-MM-DD][&month=YYYY-MM]
 *   today = the phone's date; day = the day shown on the ritual cards (default today);
 *   month = the calendar month (default today's month).
 */
router.get('/', async (req, res) => {
  const today = checkDate(req.query.today, 'today');
  const now = localNow(req.query.tz);
  const day = req.query.day && DATE.test(req.query.day) && req.query.day <= today ? req.query.day : today;
  const month = /^\d{4}-\d{2}$/.test(req.query.month ?? '') ? req.query.month : today.slice(0, 7);

  const [scans, firstLog, logs, weather] = await Promise.all([
    Scan.find({ user: req.user._id, status: 'complete' }).sort({ completedAt: -1 }).limit(120).select('results completedAt'),
    RoutineLog.findOne({ user: req.user._id }).sort({ date: 1 }).select('date'),
    RoutineLog.find({ user: req.user._id, date: { $gte: `${month}-01`, $lte: `${month}-31` } }),
    weatherFor(req.user.address).catch(() => null),
  ]);
  const latest = scans[0] ?? null;
  const plan = await rituals(req.user, latest);

  // calendar: green = both rituals, red = a past day missed (fully or half), grey = before you started / future
  const firstScan = scans.length ? utcDay(scans[scans.length - 1].completedAt) : null;
  const start = [firstLog?.date, firstScan].filter(Boolean).sort()[0] ?? today;
  const byDate = new Map(logs.map((l) => [l.date, l]));
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const calendar = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const l = byDate.get(date);
    const both = !!(l?.morning?.done && l?.evening?.done);
    let status = 'none';
    if (date > today) status = 'future';
    else if (both) status = 'done';
    else if (date === today) status = 'today';
    else if (date >= start) status = 'missed';
    calendar.push({ date, status });
  }

  // streak of fully completed days, counting back from today (today only counts once both are done)
  const recent = await RoutineLog.find({ user: req.user._id, date: { $gte: addDays(today, -400), $lte: today } }).select('date morning.done evening.done');
  const doneDays = new Set(recent.filter((l) => l.morning?.done && l.evening?.done).map((l) => l.date));
  let streak = 0;
  for (let d = doneDays.has(today) ? today : addDays(today, -1); doneDays.has(d); d = addDays(d, -1)) streak++;

  const log = byDate.get(day) ?? (await RoutineLog.findOne({ user: req.user._id, date: day }));
  const ritual = (time) => {
    const doneKeys = new Set(log?.[time]?.steps ?? []);
    const allDone = !!log?.[time]?.done;
    const steps = plan[time].map((x) => ({ ...x, done: allDone || doneKeys.has(x.key) }));
    return {
      steps,
      count: steps.length,
      doneCount: steps.filter((x) => x.done).length,
      done: allDone,
      completedAt: allDone ? log[time].at : null,
      rating: log?.[time]?.rating ?? null,
      recommendedAt: RECOMMENDED[time],
      window: windowOf(time, day, now),
    };
  };

  // weekly vitality: the skin score per day for the last 7 days (null = no scan that day)
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const date = addDays(today, -i);
    const same = scans.filter((s) => utcDay(s.completedAt) === date);
    week.push({ date, score: same.length ? Math.round(same.reduce((a, s) => a + s.results.score, 0) / same.length) : null });
  }

  res.json({
    today,
    day,
    personal: plan.personal,
    morning: ritual('morning'),
    evening: ritual('evening'),
    calendar: { month, days: calendar },
    streak,
    weekly: {
      trend: week,
      historicalHigh: scans.length ? Math.max(...scans.map((s) => s.results.score)) : null,
      latestScore: latest?.results.score ?? null,
      scansThisWeek: week.filter((w) => w.score != null).length,
    },
    weather: weather ? { uv: weather.uv, humidity: weather.humidity, place: weather.place } : null,
  });
});

function ritualOut(log, time, plan) {
  const r = log?.[time] ?? {};
  const keys = new Set(r.steps ?? []);
  return {
    done: !!r.done,
    completedAt: r.done ? r.at : null,
    rating: r.rating ?? null,
    doneCount: plan[time].filter((x) => r.done || keys.has(x.key)).length,
    count: plan[time].length,
    steps: plan[time].map((x) => ({ key: x.key, done: !!r.done || keys.has(x.key) })),
  };
}

function checkTime(time) {
  if (time !== 'morning' && time !== 'evening') throw new HttpError(400, 'time must be morning or evening.');
}
// a ritual can only be ticked inside its time window (see WINDOW)
function checkEditable(date, time, tz) {
  checkDate(date);
  checkTime(time);
  const w = windowOf(time, date, localNow(tz));
  if (w.state === 'open') return;
  const what = time === 'morning' ? 'morning' : 'evening';
  if (w.state === 'upcoming') throw new HttpError(409, `Your ${what} routine opens at ${w.opens}.`);
  throw new HttpError(409, `The ${what} routine for this day closed at ${w.closes}.`);
}

/** POST /routine/log { date, time, done } — tick / untick the whole ritual ("Verify all"). */
router.post('/log', async (req, res) => {
  const { date, time, done, tz } = req.body ?? {};
  checkEditable(date, time, tz);
  const plan = await planFor(req.user);
  const value = done !== false;
  const log = await RoutineLog.findOneAndUpdate(
    { user: req.user._id, date },
    { $set: { [`${time}.done`]: value, [`${time}.at`]: value ? new Date() : null, [`${time}.steps`]: value ? plan[time].map((x) => x.key) : [] } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
  res.json({ date, morning: ritualOut(log, 'morning', plan), evening: ritualOut(log, 'evening', plan) });
});

/** POST /routine/step { date, time, key, done } — one step; the ritual is done when every step is. */
router.post('/step', async (req, res) => {
  const { date, time, key, done, tz } = req.body ?? {};
  checkEditable(date, time, tz);
  const plan = await planFor(req.user);
  const keys = plan[time].map((x) => x.key);
  if (!keys.includes(key)) throw new HttpError(400, 'Unknown step — pull to refresh your routine.');
  const existing = await RoutineLog.findOne({ user: req.user._id, date });
  const prev = existing?.[time];
  const set = new Set(prev?.done ? keys : (prev?.steps ?? []).filter((k) => keys.includes(k)));
  if (done === false) set.delete(key);
  else set.add(key);
  const all = keys.every((k) => set.has(k));
  const log = await RoutineLog.findOneAndUpdate(
    { user: req.user._id, date },
    { $set: { [`${time}.steps`]: [...set], [`${time}.done`]: all, [`${time}.at`]: all ? (prev?.done ? prev.at : new Date()) : null } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
  res.json({ date, justCompleted: all && !prev?.done, morning: ritualOut(log, 'morning', plan), evening: ritualOut(log, 'evening', plan) });
});

/** POST /routine/rate { date, time, rating 1–5 } — "Rate your experience" after a completed ritual. */
router.post('/rate', async (req, res) => {
  const { date, time, rating } = req.body ?? {};
  checkDate(date);
  checkTime(time);
  const n = Number(rating);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new HttpError(400, 'Rating must be 1 to 5.');
  const log = await RoutineLog.findOne({ user: req.user._id, date });
  if (!log?.[time]?.done) throw new HttpError(409, 'Finish the ritual first, then rate it.');
  log[time].rating = n;
  await log.save();
  res.json({ ok: true, rating: n });
});

module.exports = router;
