/**
 * Today's weather for the user's address (Open-Meteo — free, no API key).
 * Used on the Skin Profile card: heat, humidity and UV change what the skin needs.
 * Results are cached; any failure returns null and the app shows "—".
 */
const GEO_TTL = 7 * 24 * 3600e3;
const WX_TTL = 30 * 60e3;
const geoCache = new Map();
const wxCache = new Map();

async function getJson(url, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** "Gaza | Deir al Balah" → tries "Deir al Balah", then "Gaza". */
async function geocode(address) {
  const key = address.trim().toLowerCase();
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < GEO_TTL) return hit.value;
  const parts = address.split(/[|,/\-–]+/).map((s) => s.trim()).filter((s) => s.length > 1).reverse();
  let value = null;
  for (const name of parts) {
    const r = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en`);
    const g = r?.results?.[0];
    if (g) {
      value = { lat: g.latitude, lon: g.longitude, place: g.name, country: g.country };
      break;
    }
  }
  geoCache.set(key, { at: Date.now(), value });
  return value;
}

function describe(tempC, humidity, uv) {
  const label = tempC >= 32 ? 'Hot' : tempC >= 25 ? 'Warm' : tempC >= 15 ? 'Mild' : tempC >= 5 ? 'Cool' : 'Cold';
  let tip;
  if (uv >= 6) tip = 'High UV — reapply SPF every 2 hours.';
  else if (tempC >= 30 && humidity >= 60) tip = 'Hot and humid — use light, oil-free layers.';
  else if (humidity < 35) tip = 'Dry air — seal in moisture with a richer cream.';
  else if (tempC < 10) tip = 'Cold air — protect your barrier with ceramides.';
  else tip = 'Mild conditions — keep your usual routine.';
  return { label, tip };
}

async function weatherFor(address) {
  if (!address || process.env.WEATHER === 'off') return null;
  try {
    const geo = await geocode(address);
    if (!geo) return null;
    const key = `${geo.lat.toFixed(2)},${geo.lon.toFixed(2)}`;
    const hit = wxCache.get(key);
    if (hit && Date.now() - hit.at < WX_TTL) return hit.value;
    const r = await getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current=temperature_2m,relative_humidity_2m,uv_index,is_day&timezone=auto`,
    );
    const c = r?.current;
    if (!c) return null;
    const tempC = Math.round(c.temperature_2m);
    const humidity = Math.round(c.relative_humidity_2m);
    const uv = Math.round((c.uv_index ?? 0) * 10) / 10;
    const value = {
      tempC,
      humidity,
      uv,
      isDay: c.is_day === 1,
      utcOffsetSec: r.utc_offset_seconds ?? 0,
      place: geo.place,
      ...describe(tempC, humidity, uv),
    };
    wxCache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

const airCache = new Map();

/**
 * Current air quality + pollen (Open-Meteo air-quality API). Pollen is only modelled for
 * Europe — elsewhere those values are null and no pollen alert is shown.
 */
async function airFor(address) {
  if (!address || process.env.WEATHER === 'off') return null;
  try {
    const geo = await geocode(address);
    if (!geo) return null;
    const key = `${geo.lat.toFixed(2)},${geo.lon.toFixed(2)}`;
    const hit = airCache.get(key);
    if (hit && Date.now() - hit.at < WX_TTL) return hit.value;
    const r = await getJson(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${geo.lat}&longitude=${geo.lon}&current=us_aqi,pm2_5,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen&timezone=auto`,
    );
    const c = r?.current;
    if (!c) return null;
    const pollenKeys = ['alder_pollen', 'birch_pollen', 'grass_pollen', 'mugwort_pollen', 'olive_pollen', 'ragweed_pollen'];
    const pollenValues = pollenKeys.map((k) => c[k]).filter((v) => typeof v === 'number');
    const top = pollenValues.length ? pollenKeys.reduce((a, k) => ((c[k] ?? -1) > (c[a] ?? -1) ? k : a)) : null;
    const value = {
      aqi: typeof c.us_aqi === 'number' ? Math.round(c.us_aqi) : null,
      pm25: typeof c.pm2_5 === 'number' ? Math.round(c.pm2_5 * 10) / 10 : null,
      pollen: pollenValues.length ? Math.round(Math.max(...pollenValues)) : null, // grains / m³
      pollenType: top ? top.replace('_pollen', '') : null,
      place: geo.place,
    };
    airCache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

module.exports = { weatherFor, airFor, describe };
