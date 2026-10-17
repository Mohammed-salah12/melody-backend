/**
 * Skin alerts shown as pop-up cards in the app (and in the bell list).
 * Each alert is only raised from real data — a scan, the weather / air-quality service, or a
 * logged sleep entry. Nothing is shown when the data is missing.
 *
 *   stressed   — latest scan is clearly worse than the user's own baseline (earlier scans)
 *   spf        — UV index ≥ 3 in daylight and the sunscreen has probably worn off
 *   pollution  — US AQI ≥ 101
 *   pollen     — pollen ≥ 50 grains/m³ (only modelled for Europe)
 *   sleep      — less than 6 h sleep logged for last night
 */
const DAY = 864e5;
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));

function localDate(now, offsetSec = 0) {
  return new Date(now.getTime() + offsetSec * 1000).toISOString().slice(0, 10);
}

function stressedAlert(scans, now, today) {
  const [latest, ...older] = scans;
  if (!latest || !older.length || now - new Date(latest.completedAt) > 1.5 * DAY) return null;
  const base = older.slice(0, 10).map((s) => s.results.metrics);
  const m = latest.results.metrics;
  const baseHyd = avg(base.map((b) => b.hydration));
  const baseRed = avg(base.map((b) => b.redness));
  const baseScore = avg(older.slice(0, 10).map((s) => s.results.score));

  const hydDrop = baseHyd ? ((m.hydration - baseHyd) / baseHyd) * 100 : 0;
  const redRise = baseRed ? ((m.redness - baseRed) / Math.max(baseRed, 10)) * 100 : 0;
  const scoreDrop = baseScore ? ((latest.results.score - baseScore) / baseScore) * 100 : 0;

  let status;
  let text;
  if (hydDrop <= -5) {
    status = { label: m.hydration < 40 ? 'Hydration Crisis' : 'Hydration Dip', change: Math.round(hydDrop), caption: 'Below baseline' };
    text = `Your moisture reading is ${Math.round(m.hydration)}%, down from your usual ${Math.round(baseHyd)}%. Reinforce your moisture barrier today to prevent irritation and inflammation.`;
  } else if (redRise >= 15 && m.redness >= 45) {
    status = { label: 'Reactive Flare-up', change: Math.round(redRise), caption: 'Above baseline' };
    text = `Redness is ${Math.round(m.redness)}, higher than your usual ${Math.round(baseRed)}. Pause exfoliating acids and use soothing, fragrance-free care for 48 hours.`;
  } else if (scoreDrop <= -6) {
    status = { label: 'Barrier Stress', change: Math.round(scoreDrop), caption: 'Below baseline' };
    text = `Today’s skin score is ${Math.round(latest.results.score)}, below your usual ${Math.round(baseScore)}. A gentle, barrier-repair routine will help your skin recover.`;
  } else return null;

  return {
    id: `stressed:${today}`,
    type: 'stressed',
    priority: 1,
    icon: 'alert-circle-outline',
    overline: 'Stressed skin alert',
    title: 'Your skin looks stressed today!',
    status,
    text,
    cta: { label: 'Activate recovery protocol', action: 'treatment' },
  };
}

function spfAlert(weather, spfAt, now, today) {
  if (!weather || !weather.isDay || weather.uv < 3) return null;
  const last = spfAt ? new Date(spfAt) : null;
  const valid = last && !Number.isNaN(last.getTime()) && localDate(last, weather.utcOffsetSec) === today;
  const hours = valid ? (now - last) / 3600e3 : null;
  // sunscreen is generally re-applied every ~2 hours outdoors: estimate what is left
  const protection = valid ? Math.round(clamp(100 - hours * 40)) : 0;
  if (valid && protection > 20) return null;
  return {
    id: `spf:${today}:${valid ? last.toISOString() : 'none'}`,
    type: 'spf',
    priority: 2,
    icon: 'shield-sun',
    overline: 'Environmental risk warning',
    title: valid ? 'Time to Re-apply SPF' : 'Apply Your SPF',
    text: valid
      ? `It’s been ${hours < 2.5 ? 'about 2' : Math.floor(hours)} hours since you last applied sunscreen and the UV index is ${weather.uv}. Re-apply now to keep full protection against photo-aging.`
      : `The UV index is ${weather.uv} in ${weather.place} right now. Apply a broad-spectrum SPF 30+ before going outside to protect against photo-aging.`,
    protection: {
      value: protection,
      label: 'Protection level',
      caption: valid ? 'Estimated protection has dropped below the recommended level.' : 'No sunscreen logged today.',
    },
    cta: { label: 'View protective routine', action: 'routine' },
    canLogSpf: true,
  };
}

function pollutionAlert(air, today) {
  if (!air || air.aqi == null || air.aqi < 101) return null;
  const level = air.aqi >= 201 ? 'very unhealthy' : air.aqi >= 151 ? 'unhealthy' : 'unhealthy for sensitive groups';
  return {
    id: `pollution:${today}`,
    type: 'pollution',
    priority: 3,
    icon: 'image-filter-hdr',
    overline: 'Environmental risk warning',
    title: 'High Pollution Levels Detected',
    text: `The air quality index in ${air.place} is ${air.aqi} (${level}). We recommend applying an antioxidant serum and a protective barrier to prevent pore clogging and oxidative stress.`,
    cta: { label: 'View protective routine', action: 'routine' },
  };
}

function pollenAlert(air, today) {
  if (!air || air.pollen == null || air.pollen < 50) return null;
  return {
    id: `pollen:${today}`,
    type: 'pollen',
    priority: 4,
    icon: 'leaf',
    overline: 'Environment alert',
    title: 'High Pollen Count Today',
    text: `${air.pollenType ? air.pollenType[0].toUpperCase() + air.pollenType.slice(1) + ' pollen' : 'Pollen'} levels are high in your area (${air.pollen} grains/m³), which might cause skin itchiness or redness. Use a soothing cleanser this evening.`,
    cta: { label: 'Recommended products', action: 'treatment' },
  };
}

function sleepAlert(log, today) {
  if (!log || log.sleepHours == null || log.sleepHours >= 6) return null;
  return {
    id: `sleep:${today}`,
    type: 'sleep',
    priority: 5,
    icon: 'moon-waning-crescent',
    overline: 'Biometric alert',
    title: 'Poor Sleep Recovery Detected',
    text: `You slept ${Math.round(log.sleepHours * 10) / 10} hours last night, so your skin didn’t get enough repair time. Use a gentle morning routine with hydration and SPF to reduce puffiness and brighten your complexion.`,
    cta: { label: 'Start recovery protocol', action: 'treatment' },
  };
}

function buildAlerts({ scans = [], weather = null, air = null, sleepLog = null, spfAt = null, now = new Date() }) {
  const today = localDate(now, weather?.utcOffsetSec ?? 0);
  return [
    stressedAlert(scans, now, today),
    spfAlert(weather, spfAt, now, today),
    pollutionAlert(air, today),
    pollenAlert(air, today),
    sleepAlert(sleepLog, today),
  ]
    .filter(Boolean)
    .sort((a, b) => a.priority - b.priority);
}

module.exports = { buildAlerts, localDate };
