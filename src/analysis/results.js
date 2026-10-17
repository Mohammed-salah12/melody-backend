/**
 * Turn per-frame measurements into scan results, and scan history into the
 * "Today's Skin Snapshot" the app shows (Skin Passport summary).
 */
const { clamp, median } = require('./image');

const METRICS = ['hydration', 'oil', 'redness', 'pigmentation', 'texture', 'pores', 'wrinkles', 'evenness'];

function aggregate(frames) {
  // zone-based measurements are only reliable on straight-on frames
  const used = frames.filter((f) => f.accepted && f.metrics);
  const front = used.filter((f) => (f.step ?? 'front') === 'front');
  const pool = front.length >= 2 ? front : used.length ? used : frames.filter((f) => f.metrics);
  const metrics = {};
  for (const k of METRICS) metrics[k] = Math.round(median(pool.map((f) => f.metrics[k])) * 10) / 10;

  // pores: prefer the real count from close, sharp straight-on frames
  const measured = used.filter((f) => (f.step ?? 'front') === 'front' && f.poreStats?.perCm2 != null);
  let pores = { measured: false, framesUsed: 0 };
  if (measured.length) {
    const ps = measured.map((f) => f.poreStats);
    metrics.pores = Math.round(median(ps.map((p) => p.score)) * 10) / 10;
    pores = {
      measured: true,
      count: Math.round(median(ps.map((p) => p.count))),
      perCm2: Math.round(median(ps.map((p) => p.perCm2)) * 10) / 10,
      avgSizeMm: Math.round(median(ps.map((p) => p.avgSizeMm)) * 100) / 100,
      framesUsed: measured.length,
    };
  }
  // T-zone vs cheeks (older frames don't have zones)
  const zoned = pool.filter((f) => f.zones?.cheekOil != null);
  const zones = zoned.length
    ? Object.fromEntries(['tzoneOil', 'cheekOil', 'cheekHydration'].map((k) => [k, Math.round(median(zoned.map((f) => f.zones[k])) * 10) / 10]))
    : undefined;
  return { metrics, pores, zones, framesUsed: pool.length, pool };
}

/* ---------- how sure are we? ---------- */

// typical error of each measurement on a good photo (0–100 scale) — the camera is better at some
const BASE_MARGIN = { hydration: 7, oil: 5, redness: 5, pigmentation: 6, texture: 6, pores: 8, wrinkles: 9, evenness: 6 };

/**
 * Photo quality of the frames used, and per measurement a ± range and a level (high / medium /
 * low). The range grows when the frames disagree with each other, when there were few of them,
 * and when the photos were soft, side-lit or taken in warm light.
 */
function confidenceOf(pool, metrics, pores) {
  const qs = pool.map((f) => f.quality ?? {});
  const has = (k) => qs.some((q) => q[k] != null);
  const score = has('score') ? Math.round(median(qs.map((q) => q.score ?? 80))) : null;
  const sharp = has('sharpness') ? median(qs.map((q) => q.sharpness ?? 40)) >= 26 : null;
  const evenLight = has('shadow') ? median(qs.map((q) => q.shadow ?? 0)) <= 0.3 : null;
  const warmLight = has('warmLight') ? qs.filter((q) => q.warmLight).length > qs.length / 2 : false;
  const qPenalty = score == null ? 2 : Math.max(0, (85 - score) / 8); // up to ~+10 for poor photos

  const confidence = {};
  for (const k of METRICS) {
    const vals = pool.map((f) => f.metrics?.[k]).filter((v) => v != null);
    const mad = vals.length > 1 ? median(vals.map((v) => Math.abs(v - median(vals)))) : 6;
    let margin = BASE_MARGIN[k] + 1.48 * mad * 0.8 + qPenalty + (vals.length < 3 ? 3 : 0);
    if (k === 'pores' && pores?.measured) margin -= 3;
    if (warmLight && (k === 'redness' || k === 'pigmentation' || k === 'evenness')) margin += 4;
    if (sharp === false && (k === 'texture' || k === 'pores' || k === 'wrinkles')) margin += 4;
    margin = Math.round(clamp(margin, 3, 25));
    confidence[k] = { margin, level: margin <= 8 ? 'high' : margin <= 13 ? 'medium' : 'low', low: Math.round(clamp(metrics[k] - margin)), high: Math.round(clamp(metrics[k] + margin)) };
  }

  const notes = [];
  if (score != null && score >= 80) notes.push('Clear photos in good, even light.');
  if (sharp === false) notes.push('Some photos were a little blurry, so texture, pores and fine lines are less certain.');
  if (evenLight === false) notes.push('One side of your face was darker, which makes the results less certain.');
  if (warmLight) notes.push('Warm indoor light can make redness look stronger — scan in daylight for the most accurate reading.');
  if (pool.length < 3) notes.push('Only a few clear photos were used — scan again for a more certain result.');
  if (!pores?.measured) notes.push('Pores were estimated from texture — hold the phone a little closer next time for an exact count.');
  const avgMargin = METRICS.reduce((s, k) => s + confidence[k].margin, 0) / METRICS.length;
  const level = avgMargin <= 8.5 && (score ?? 80) >= 70 ? 'high' : avgMargin <= 13 ? 'medium' : 'low';
  return { quality: { score: score ?? undefined, level, sharp: sharp ?? undefined, evenLight: evenLight ?? undefined, warmLight, notes }, confidence };
}

/** 0–100 skin score: higher is healthier-looking. */
function skinScore(m) {
  const oilBalance = 100 - Math.abs(m.oil - 40) * 1.4; // some oil is healthy
  return Math.round(
    clamp(
      0.2 * m.hydration +
        0.15 * m.evenness +
        0.12 * (100 - m.redness) +
        0.13 * (100 - m.pigmentation) +
        0.13 * (100 - m.texture) +
        0.1 * (100 - m.wrinkles) +
        0.09 * (100 - m.pores) +
        0.08 * clamp(oilBalance),
    ),
  );
}

function skinType(m) {
  if (m.oil >= 60 && m.hydration >= 50) return 'Oily';
  if (m.oil >= 45 && m.hydration < 50) return 'Combination';
  if (m.oil < 25 && m.hydration < 55) return 'Dry';
  return 'Normal';
}

const CONCERNS = [
  ['hydration', (v) => v < 50, 'Dehydration', 'Hydrating serum with hyaluronic acid', 'Your skin looks less plump and smooth than ideal.'],
  ['oil', (v) => v > 65, 'Excess shine', 'Oil-free gel moisturiser + niacinamide', 'Strong shine was detected in your T-zone.'],
  ['redness', (v) => v > 55, 'Redness', 'Soothing cream with centella or azelaic acid', 'Your skin shows more redness than average.'],
  ['pigmentation', (v) => v > 45, 'Dark spots', 'Daily SPF 50 + vitamin C serum', 'Darker spots stand out against your skin tone.'],
  ['texture', (v) => v > 55, 'Uneven texture', 'Gentle exfoliant (lactic acid) twice a week', 'Fine surface roughness was detected.'],
  ['pores', (v) => v > 55, 'Visible pores', 'BHA (salicylic acid) toner', 'Pores on your cheeks look enlarged.'],
  ['wrinkles', (v) => v > 50, 'Fine lines', 'Night cream with retinol (start slowly)', 'Fine lines were found on the forehead / eye area.'],
];

function buildResults(frames, override = null) {
  const agg = aggregate(frames);
  const { pores, zones, framesUsed, pool } = agg;
  // `override` = metrics refined by the trained skin model; everything below is derived from them
  const metrics = override ?? agg.metrics;
  const concerns = [];
  const recommendations = [];
  for (const [key, test, concern, title, reason] of CONCERNS) {
    if (test(metrics[key])) {
      concerns.push(concern);
      recommendations.push({ title, reason });
    }
  }
  if (!recommendations.length) {
    recommendations.push({ title: 'Keep your routine: cleanser, moisturiser, SPF', reason: 'Your skin looks balanced today.' });
  }
  const { quality, confidence } = confidenceOf(pool, metrics, pores);
  return { score: skinScore(metrics), metrics, zones, pores, skinType: skinType(metrics), concerns, recommendations, framesUsed, quality, confidence };
}

/* ---------- Skin Snapshot (shape matches the app's SkinSnapshot type) ---------- */

const day = (d) => new Date(d).toISOString().slice(0, 10);

function streak(scans) {
  const days = new Set(scans.map((s) => day(s.completedAt)));
  let n = 0;
  const d = new Date();
  if (!days.has(day(d))) d.setDate(d.getDate() - 1); // today not scanned yet doesn't break the streak
  while (days.has(day(d))) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const toTen = (v) => Math.round(v) / 10; // 0–100 → 0–10 with one decimal

/** @param scans completed scans, newest first */
function buildSnapshot(scans) {
  if (!scans.length) return null;
  const [latest, previous] = scans;
  const m = latest.results.metrics;
  const now = Date.now();
  const week = scans.filter((s) => now - new Date(s.completedAt) < 7 * 864e5);
  const lastWeek = scans.filter((s) => {
    const age = now - new Date(s.completedAt);
    return age >= 7 * 864e5 && age < 14 * 864e5;
  });
  const thisAvg = avg(week.map((s) => s.results.score));
  const prevAvg = avg(lastWeek.map((s) => s.results.score));

  const weekly = (k) => Math.round(avg(week.map((s) => s.results.metrics[k])));
  const trend = [
    { key: 'oil', label: 'OIL', value: weekly('oil') },
    { key: 'rough', label: 'ROUG', value: weekly('texture') },
    { key: 'moist', label: 'MOIST', value: weekly('hydration') },
    { key: 'sens', label: 'SENS', value: weekly('redness') },
    { key: 'pores', label: 'PORES', value: weekly('pores') },
    { key: 'pigm', label: 'PIGM', value: weekly('pigmentation') },
    { key: 'wrin', label: 'WRIN', value: weekly('wrinkles') },
  ];
  // the tallest bar is drawn in the strong colour
  const highlight = [...trend].sort((a, b) => b.value - a.value)[0].key;

  const change = previous ? latest.results.score - previous.results.score : 0;
  const verdict =
    latest.results.score >= 85
      ? { word: 'Excellent.', text: change > 0 ? `Skin barrier strength improved by ${change}%.` : 'Your skin is in great shape.' }
      : latest.results.score >= 70
        ? { word: change >= 0 ? 'Stable.' : 'Dipping.', text: change >= 0 ? 'Your skin is holding steady.' : 'Skin looks stressed today.' }
        : { word: 'Needs care.', text: 'Your skin looks stressed today — follow your routine.' };

  return {
    scanId: latest.id ?? String(latest._id),
    date: day(latest.completedAt),
    score: latest.results.score,
    moisture: Math.round(m.hydration),
    oilLevel: Math.round(m.oil),
    verdict,
    // previous scan's numbers for the "Optimal / Stable" cards
    moistureChange: previous ? Math.round(m.hydration - previous.results.metrics.hydration) : 0,
    oilChange: previous ? Math.round(m.oil - previous.results.metrics.oil) : 0,
    barrierChange: change,
    streak: streak(scans),
    stats: [
      { key: 'moisture', label: 'Moisture', value: toTen(m.hydration), icon: 'water-outline' },
      { key: 'oil', label: 'Oil', value: toTen(m.oil), icon: 'water' },
      { key: 'wrinkles', label: 'Wrinkles', value: toTen(m.wrinkles), icon: 'magic-staff' },
      { key: 'pores', label: 'Pores', value: toTen(m.pores), icon: 'dots-grid' },
      { key: 'pigmentation', label: 'Pigmentation', value: toTen(m.pigmentation), icon: 'circle-half-full' },
      { key: 'redness', label: 'Redness', value: toTen(m.redness), icon: 'fire' },
    ],
    weekChange: prevAvg ? Math.round(((thisAvg - prevAvg) / prevAvg) * 100) : 0,
    historicalHigh: Math.max(...scans.map((s) => s.results.score)),
    trend,
    highlight,
    skinType: latest.results.skinType,
    concerns: latest.results.concerns,
    recommendations: latest.results.recommendations,
  };
}

module.exports = { buildResults, buildSnapshot, confidenceOf, METRICS };
