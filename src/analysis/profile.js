/**
 * Skin Profile page: patient card, weekly vitality, glow index, real-time analysis cards
 * and the clinical risk timeline — all computed from the user's completed scans.
 * Everything here is an estimate from camera scans, not a medical diagnosis.
 */
const { buildSnapshot } = require('./results');
const { needsFromMetrics } = require('./matcher');

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

function ageFrom(birthDate) {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let a = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) a--;
  return a >= 0 && a < 130 ? a : null;
}

function tZoneLabel(oil) {
  if (oil >= 60) return 'Oily / Hyper-active';
  if (oil >= 40) return 'Shiny / Active';
  if (oil >= 20) return 'Balanced';
  return 'Dry / Matte';
}

function cheekLabel(hydration, oil) {
  if (hydration < 45) return oil < 20 ? 'Dry / Alipidic' : 'Dry / Dehydrated';
  if (hydration < 60) return 'Normal / Slightly dry';
  return oil >= 50 ? 'Oily / Shiny' : 'Normal / Balanced';
}

/* ---------- weekly vitality (Mon–Sun of this week) ---------- */

function weekly(scans, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const mondayOffset = (today.getUTCDay() + 6) % 7;
  const monday = new Date(today.getTime() - mondayOffset * 864e5);
  const latestPerDay = new Map(); // scans are newest first → first seen per day is that day's latest
  for (const s of scans) {
    const k = dayKey(s.completedAt);
    if (!latestPerDay.has(k)) latestPerDay.set(k, s);
  }
  return DAYS.map((label, i) => {
    const d = new Date(monday.getTime() + i * 864e5);
    const s = latestPerDay.get(dayKey(d));
    return { day: label, date: dayKey(d), score: s ? Math.round(s.results.score) : null, isToday: i === mondayOffset, future: i > mondayOffset };
  });
}

/* ---------- real-time analysis cards ---------- */

const pick = (v, bands) => bands.find(([max]) => v < max) ?? bands[bands.length - 1];

function analysisCards(m, pores) {
  const r = (v) => Math.round(v);
  const card = (key, title, icon, value, [_, status, tone, text]) => ({ key, title, icon, value: r(value), status, tone, text });
  return [
    card('sensitivity', 'Sensitivity', 'alert-rhombus-outline', m.redness, pick(m.redness, [
      [25, 'Calm', 'good', 'Little visible redness. Your skin is tolerating your routine well.'],
      [50, 'Mild', 'ok', 'Some redness on the cheeks. Keep new actives to one at a time.'],
      [70, 'Reactive', 'bad', 'Your skin shows high reactivity to external stressors. Avoid active acids for 48 hours.'],
      [101, 'Highly reactive', 'bad', 'Strong redness detected. Pause exfoliants and use soothing, fragrance-free care.'],
    ])),
    card('moisture', 'Moisture', 'water-outline', m.hydration, pick(m.hydration, [
      [35, 'Low', 'bad', 'Your skin is very dry. Barrier function is currently compromised.'],
      [50, 'Fair', 'ok', 'Moisture is below the ideal range. Add a hydrating serum under your cream.'],
      [65, 'Good', 'good', 'Moisture is in a healthy range.'],
      [101, 'Optimal', 'good', 'Skin looks plump and well hydrated.'],
    ])),
    card('oil', 'Oil Control', 'water', m.oil, pick(m.oil, [
      [20, 'Dry', 'ok', 'Very little sebum. Your skin may need richer, lipid-replenishing care.'],
      [55, 'Balanced', 'good', 'Sebum production is within a healthy clinical range.'],
      [70, 'Shiny', 'ok', 'Noticeable shine in the T-zone by midday.'],
      [101, 'Oily', 'bad', 'High sebum output. Oil-free layers and niacinamide will help.'],
    ])),
    card('pores', 'Pores', 'dots-grid', m.pores, pick(m.pores, [
      [30, 'Refined', 'good', pores?.measured ? `Fine pores — about ${pores.perCm2} per cm² on the cheeks.` : 'Pores look small and clear.'],
      [55, 'Visible', 'ok', pores?.measured ? `Mild congestion — about ${pores.perCm2} visible pores per cm².` : 'Mild congestion observed in the T-zone area.'],
      [101, 'Enlarged', 'bad', 'Pores look enlarged and congested. A BHA can help keep them clear.'],
    ])),
    card('pigmentation', 'Pigmentation', 'circle-half-full', m.pigmentation, pick(m.pigmentation, [
      [25, 'Even', 'good', 'Skin tone looks even.'],
      [50, 'Uneven', 'ok', 'Slight hyperpigmentation noted on cheekbones.'],
      [101, 'Marked', 'bad', 'Dark spots stand out. Daily SPF is essential.'],
    ])),
    card('roughness', 'Roughness', 'texture-box', m.texture, pick(m.texture, [
      [25, 'Smooth', 'good', 'Skin surface looks smooth.'],
      [50, 'Mild', 'ok', 'Some uneven texture, often from mild dehydration.'],
      [101, 'High', 'bad', 'Texture is uneven due to lack of surface hydration.'],
    ])),
    card('wrinkles', 'Wrinkles', 'auto-fix', 100 - m.wrinkles, pick(100 - m.wrinkles, [
      [55, 'Visible', 'bad', 'Fine lines are visible on the forehead and around the eyes.'],
      [75, 'Good', 'ok', 'A few fine expression lines.'],
      [101, 'Excellent', 'good', 'Smooth, with minimal visible expression lines.'],
    ])),
  ];
}

/* ---------- clinical risk timeline (past · current · potential) ---------- */

const CONDITIONS = {
  dehydration: ['Transepidermal Water Loss', 'Moisture is evaporating faster than a healthy baseline.', 'Moisture loss was higher than a healthy baseline.', 'Hydration is trending down — water loss may increase.'],
  barrier: ['Barrier Compromise', 'Dryness and redness together point to a weakened skin barrier.', 'Earlier scans showed signs of a weakened, dry barrier.', 'Your barrier may weaken if dryness and redness keep rising.'],
  redness: ['Reactive Sensitivity', 'Visible redness suggests your skin is reacting to stressors.', 'Earlier scans showed more redness and reactivity.', 'Redness is trending up — watch for irritation.'],
  pigmentation: ['Phototoxic Sensitivity', 'Uneven pigment that sun exposure can darken.', 'Earlier scans showed more uneven pigmentation.', 'Pigment is trending up — high probability of hyper-pigmentation under UV stress.'],
  oil: ['Sebum Overproduction', 'Excess shine that can lead to congestion.', 'Earlier scans showed more excess oil.', 'Oil is trending up — congestion may follow.'],
  pores: ['Pore Congestion', 'Visible, congested pores.', 'Earlier scans showed more congested pores.', 'Pores are becoming more visible.'],
  texture: ['Surface Roughness', 'Uneven surface texture.', 'Earlier scans showed rougher texture.', 'Texture is getting rougher.'],
  wrinkles: ['Early Photo-ageing', 'Fine lines on the forehead and around the eyes.', 'Earlier scans showed more fine lines.', 'Fine lines are slowly becoming more visible.'],
};

function riskTimeline(scans) {
  const [latest, ...older] = scans;
  const now = needsFromMetrics(latest.results.metrics);
  const rank = (needs) => Object.entries(needs).sort((a, b) => b[1] - a[1]);
  const items = [];

  // past: the worst issue in earlier scans that has improved since
  if (older.length) {
    const avgNeeds = {};
    for (const k of Object.keys(now)) avgNeeds[k] = older.reduce((s, sc) => s + needsFromMetrics(sc.results.metrics)[k], 0) / older.length;
    const currentKey = rank(now)[0][0];
    const improved = rank(avgNeeds).find(([k, v]) => v >= 0.3 && v - now[k] >= 0.05);
    const worstPast = improved ?? rank(avgNeeds).find(([k]) => k !== currentKey);
    if (worstPast && worstPast[1] >= 0.2) {
      const [k] = worstPast;
      const text = improved ? `${CONDITIONS[k][2]} It has improved since.` : `Already present in earlier scans — ${CONDITIONS[k][1].charAt(0).toLowerCase()}${CONDITIONS[k][1].slice(1)}`;
      items.push({ status: 'past', key: k, title: CONDITIONS[k][0], text, improved: !!improved });
    }
  }

  // current: the biggest need today
  const [curKey, curVal] = rank(now)[0];
  if (curVal >= 0.3) items.push({ status: 'current', key: curKey, title: CONDITIONS[curKey][0], text: CONDITIONS[curKey][1] });
  else items.push({ status: 'current', key: 'none', title: 'No Active Concerns', text: 'All measured values are within a healthy range.' });

  // potential: the fastest-worsening metric, or the next biggest need
  let potential = null;
  if (older.length) {
    const prev = needsFromMetrics(older[0].results.metrics);
    const rising = Object.keys(now)
      .filter((k) => k !== curKey)
      .map((k) => [k, now[k] - prev[k]])
      .sort((a, b) => b[1] - a[1])[0];
    if (rising && rising[1] > 0.05) potential = rising[0];
  }
  if (!potential) potential = rank(now).find(([k, v]) => k !== curKey && v >= 0.2)?.[0];
  if (!potential) potential = 'pigmentation'; // UV is always the main long-term risk
  items.push({ status: 'potential', key: potential, title: CONDITIONS[potential][0], text: CONDITIONS[potential][3] });
  return items;
}

function reportId(scanId) {
  let h = 0;
  for (const c of String(scanId)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `#MV-${String(h % 10000).padStart(4, '0')}`;
}

/* ---------- biological skin age (estimate) ---------- */

const round1 = (v) => Math.round(v * 10) / 10;
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));

function exactAge(birthDate, now = new Date()) {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  if (Number.isNaN(b.getTime())) return null;
  const years = (now - b) / (365.2425 * 864e5);
  return years > 0 && years < 130 ? round1(years) : null;
}

/**
 * Compares the user's visible ageing signs with what is typical for their age:
 * fine lines, dark spots, rough texture, tone evenness and dehydration each add or remove
 * a little "apparent age". Uses the median of the last 3 scans so one bad photo doesn't swing it.
 */
function biologicalAge(scans, birthDate) {
  const chrono = exactAge(birthDate);
  if (chrono == null) return { chronoAge: null, bioAge: null, delta: null, score: null, note: 'Add your date of birth to see your skin age.' };
  const recent = scans.slice(0, 3).map((s) => s.results.metrics);
  const med = (k) => {
    const v = recent.map((m) => m[k]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  const a = Math.max(18, chrono);
  const expected = {
    wrinkles: clampN((a - 20) * 1.6 + 10, 5, 90),
    pigmentation: clampN((a - 20) * 1.2 + 15, 10, 85),
    texture: clampN((a - 20) * 0.8 + 25, 15, 80),
    evenness: clampN(80 - (a - 20) * 0.6, 35, 85),
    hydration: clampN(68 - (a - 20) * 0.3, 45, 70),
  };
  const delta = clampN(
    0.12 * (med('wrinkles') - expected.wrinkles) +
      0.05 * (med('pigmentation') - expected.pigmentation) +
      0.04 * (med('texture') - expected.texture) -
      0.03 * (med('evenness') - expected.evenness) -
      0.04 * (med('hydration') - expected.hydration),
    -10,
    10,
  );
  const bioAge = round1(chrono + delta);
  const latestScore = scans[0].results.score;
  const score = Math.round(clampN(0.7 * latestScore + 0.3 * clampN(50 - delta * 8, 0, 100), 0, 100));
  return { chronoAge: chrono, bioAge, delta: round1(bioAge - chrono), score, note: 'Estimated from visible signs in your scans — not a medical test.' };
}

/* ---------- pathology screening (camera signs only) ---------- */

function pathology(scans) {
  const recent = scans.slice(0, 5).map((s) => s.results.metrics);
  const m = recent[0];
  const share = (fn) => recent.filter(fn).length / recent.length;
  const items = [];

  const congestion = m.pores >= 50 && m.oil >= 50 && m.redness >= 40;
  items.push({
    key: 'acne',
    title: congestion ? 'Acne-prone Congestion' : 'Acne',
    active: congestion,
    text: congestion
      ? 'Enlarged pores, excess oil and redness together suggest breakout-prone skin. Hormonal triggers or barrier disruption can play a part.'
      : 'No signs of active congestion. Pores and oil are within a normal range.',
  });

  const persistentRed = recent.length >= 3 && share((x) => x.redness >= 55) >= 0.6;
  items.push({
    key: 'rosacea',
    title: 'Rosacea',
    active: persistentRed,
    text: persistentRed
      ? 'Redness has stayed high across several scans. Persistent redness can be a sign of rosacea — worth checking with a dermatologist.'
      : 'No persistent redness detected. Erythema levels remain within baseline parameters.',
  });

  const spots = m.pigmentation >= 50;
  items.push({
    key: 'pigmentation',
    title: 'Hyperpigmentation',
    active: spots,
    text: spots ? 'Dark spots stand out against your skin tone, mostly on the cheeks. Daily SPF helps stop them darkening.' : 'Skin tone looks even, with no marked dark spots.',
  });

  const tewl = m.hydration < 40;
  items.push({
    key: 'dehydration',
    title: 'Trans-epidermal Water Loss',
    active: tewl,
    text: tewl ? 'Your skin is losing moisture faster than it should. Barrier-repair care is the priority.' : 'Moisture levels are holding well.',
  });

  return items.sort((x, y) => Number(y.active) - Number(x.active));
}

/** @param scans completed scans, newest first */
function buildProfile(user, scans, weather) {
  const firstName = (user.fullName ?? '').split(' ')[0];
  const base = {
    patient: {
      name: firstName,
      fullName: user.fullName,
      age: ageFrom(user.birthDate),
      address: user.address ?? null,
      tZone: null,
      cheeks: null,
      skinType: null,
      weather,
    },
    hasScans: scans.length > 0,
  };
  if (!scans.length) return base;

  const latest = scans[0];
  const m = latest.results.metrics;
  const z = latest.results.zones ?? {};
  const snap = buildSnapshot(scans);
  return {
    ...base,
    patient: {
      ...base.patient,
      tZone: tZoneLabel(z.tzoneOil ?? m.oil),
      cheeks: cheekLabel(z.cheekHydration ?? m.hydration, z.cheekOil ?? m.oil),
      skinType: String(latest.results.skinType ?? '').toUpperCase(),
    },
    scanId: latest.id ?? String(latest._id),
    scanDate: latest.completedAt,
    week: weekly(scans),
    glow: {
      score: Math.round(latest.results.score),
      change: snap.weekChange,
      historicalHigh: Math.round(snap.historicalHigh),
      trend: snap.trend,
      highlight: snap.highlight,
    },
    analysis: analysisCards(m, latest.results.pores),
    risk: {
      reportId: reportId(latest.id ?? latest._id),
      items: riskTimeline(scans),
      note: 'Estimated from camera scans — not a medical diagnosis. See a dermatologist for any concern.',
    },
    longevity: biologicalAge(scans, user.birthDate),
    pathology: pathology(scans),
  };
}

module.exports = { buildProfile, tZoneLabel, cheekLabel, weekly, analysisCards, riskTimeline, biologicalAge, pathology };
