/**
 * Learning from real results: did people's later scans improve after they bought a product?
 *
 * For every (customer, product) pair from orders that were not cancelled, we take the customer's
 * last scan before the order (≤ 60 days earlier) and their first scan 14–120 days after it, and
 * measure how much each skin need went down. Because almost everyone's numbers drift a little
 * (season, light, getting used to the scanner), we compare each product to the average of all
 * products, and shrink small samples towards zero, so a product only gains or loses ranking when
 * several customers show a consistent difference.
 *
 * Result per product: { n, effect: { concern: -1..1 }, overall: -1..1 } — cached for an hour.
 */
const Order = require('../models/Order');
const Scan = require('../models/Scan');
const { needsFromMetrics } = require('./matcher');

const DAY = 864e5;
// concern → measured value, and whether higher is better
const METRIC_OF = [
  ['dehydration', 'hydration', true],
  ['oil', 'oil', false],
  ['redness', 'redness', false],
  ['pigmentation', 'pigmentation', false],
  ['texture', 'texture', false],
  ['pores', 'pores', false],
  ['wrinkles', 'wrinkles', false],
];
const MIN_USERS = 3; // below this the product has no evidence (shown nowhere, no ranking effect)
const SHRINK = 4; // pseudo-count for shrinkage towards the average

let cache = { at: 0, data: new Map() };

async function computeOutcomes() {
  const orders = await Order.find({ status: { $ne: 'cancelled' } }).select('user items.product createdAt').lean();
  if (!orders.length) return new Map();
  const users = [...new Set(orders.map((o) => String(o.user)))];
  const scans = await Scan.find({ user: { $in: users }, status: 'complete' }).select('user completedAt results.metrics').sort({ completedAt: 1 }).lean();
  const byUser = new Map();
  for (const s of scans) {
    if (!s.results?.metrics) continue;
    const k = String(s.user);
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k).push(s);
  }

  // first purchase of each product per user
  const pairs = new Map();
  for (const o of orders) {
    for (const it of o.items ?? []) {
      if (!it.product) continue;
      const key = `${o.user}|${it.product}`;
      if (!pairs.has(key) || pairs.get(key).at > o.createdAt) pairs.set(key, { user: String(o.user), product: String(it.product), at: o.createdAt });
    }
  }

  const perProduct = new Map();
  const all = [];
  for (const { user, product, at } of pairs.values()) {
    const list = byUser.get(user) ?? [];
    const before = [...list].reverse().find((s) => s.completedAt <= at && at - s.completedAt <= 60 * DAY);
    const after = list.find((s) => s.completedAt - at >= 14 * DAY && s.completedAt - at <= 120 * DAY);
    if (!before || !after) continue;
    const nb = needsFromMetrics(before.results.metrics);
    const na = needsFromMetrics(after.results.metrics);
    const delta = Object.fromEntries(Object.keys(nb).map((c) => [c, nb[c] - na[c]])); // > 0 = improved
    // the same change in plain numbers: % better on the measured value (for "customers saw…")
    const mb = before.results.metrics;
    const ma = after.results.metrics;
    const pct = {};
    for (const [c, k, up] of METRIC_OF) {
      if (mb[k] == null || ma[k] == null || mb[k] < 5) continue;
      pct[c] = ((up ? ma[k] - mb[k] : mb[k] - ma[k]) / mb[k]) * 100;
    }
    const sample = { delta, pct, days: (after.completedAt - at) / DAY };
    all.push(sample);
    if (!perProduct.has(product)) perProduct.set(product, []);
    perProduct.get(product).push(sample);
  }
  if (!all.length) return new Map();

  const concerns = Object.keys(all[0].delta);
  const avgOf = (list, get) => {
    const xs = list.map(get).filter((v) => v != null && Number.isFinite(v));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const baseline = Object.fromEntries(concerns.map((c) => [c, avgOf(all, (d) => d.delta[c])]));
  const baselinePct = Object.fromEntries(METRIC_OF.map(([c]) => [c, avgOf(all, (d) => d.pct[c])]));
  const out = new Map();
  for (const [product, samples] of perProduct) {
    const n = samples.length;
    if (n < MIN_USERS) continue;
    const effect = {};
    for (const c of concerns) {
      const mean = avgOf(samples, (d) => d.delta[c]) - baseline[c];
      effect[c] = Math.max(-1, Math.min(1, (mean * n) / (n + SHRINK)));
    }
    // plain-number summary per concern: average % better for this product's buyers vs everyone
    const seen = {};
    for (const [c] of METRIC_OF) {
      const p = avgOf(samples, (d) => d.pct[c]);
      if (p != null) seen[c] = { pct: Math.round(p), everyone: Math.round(baselinePct[c] ?? 0) };
    }
    out.set(product, { n, effect, seen, weeks: Math.max(2, Math.round(avgOf(samples, (d) => d.days) / 7)) });
  }
  return out;
}

/** Cached outcomes (recomputed at most once an hour). Never throws. */
async function getOutcomes() {
  if (Date.now() - cache.at < 3600e3) return cache.data;
  try {
    cache = { at: Date.now(), data: await computeOutcomes() };
  } catch {
    cache = { at: Date.now(), data: cache.data };
  }
  return cache.data;
}

module.exports = { getOutcomes, computeOutcomes, MIN_USERS };
