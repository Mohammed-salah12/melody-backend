/**
 * Product matcher — turns a skin scan into ranked product suggestions and a routine.
 *
 * Model (content-based recommender):
 *   1. NEED vector: how much the user's skin needs help with each concern, from the scan
 *      (e.g. hydration 52 → dehydration need 0.6; pores 70 → pores need 0.6).
 *   2. PRODUCT vector: what each product treats — its declared concerns plus what its key
 *      ingredients are known to do (ingredients.js knowledge base).
 *   3. Score = how well the product covers the user's biggest needs (weighted overlap)
 *      × skin-type fit × safety (allergies, ingredients to avoid for this skin type).
 *   4. Match % shown to the user is that score on a 0–100 scale; reasons name the measured
 *      numbers and the ingredient that addresses them.
 *   5. A routine (morning / evening) is built from the best product per step, never pairing
 *      actives that shouldn't be used together.
 *
 * Personal safety: pregnancy (from the health answers), medicines like isotretinoin, allergies,
 * sensitive skin (irritation of each active, fragrance), comedogenic oils for oily skin.
 * Trends: concerns that got worse since the previous scan get a little more weight.
 * Evidence: products whose buyers' later scans improved more than average get a small boost
 * (outcomes.js) — only with enough customers, and never more than ±10%.
 *
 * It is deterministic and explainable. An optional LLM step (llm.js) can rewrite the
 * explanations in friendlier language; it never changes the ranking.
 */
const { matchIngredients } = require('./ingredients');

const FACE_CATEGORIES = ['cleanser', 'toner', 'serum', 'treatment', 'moisturizer', 'sunscreen', 'mask', 'eye'];
const CONCERNS = ['dehydration', 'oil', 'redness', 'pigmentation', 'texture', 'pores', 'wrinkles', 'barrier'];

const LABEL = {
  dehydration: 'hydration',
  oil: 'oil level',
  redness: 'redness',
  pigmentation: 'dark spots',
  texture: 'texture',
  pores: 'visible pores',
  wrinkles: 'fine lines',
  barrier: 'skin barrier',
};

const ramp = (v, from, to) => Math.max(0, Math.min(1, (v - from) / (to - from)));

/** 0–1 need per concern from scan metrics (0–100). */
function needsFromMetrics(m) {
  const need = {
    dehydration: ramp(100 - m.hydration, 25, 70),
    oil: ramp(m.oil, 40, 85),
    redness: ramp(m.redness, 25, 75),
    pigmentation: ramp(m.pigmentation, 25, 75),
    texture: ramp(m.texture, 25, 75),
    pores: ramp(m.pores, 25, 75),
    wrinkles: ramp(m.wrinkles, 20, 70),
  };
  need.barrier = Math.min(1, 0.6 * need.dehydration + 0.6 * need.redness);
  // a little baseline care is always useful, so nothing ends up at exactly zero
  for (const k of CONCERNS) need[k] = Math.round((0.05 + 0.95 * need[k]) * 1000) / 1000;
  return need;
}

/** What a product treats, 0–1 per concern (ingredient strength × what each active does). */
function productVector(p) {
  const v = Object.fromEntries(CONCERNS.map((c) => [c, 0]));
  const ings = matchIngredients(p.ingredients);
  // a declared concern counts fully when an active backs it up, a bit less on its own
  for (const c of p.concerns ?? []) {
    const cc = c === 'acne' ? ['pores', 'oil'] : [c];
    for (const k of cc) if (k in v) v[k] = Math.max(v[k], ings.some((i) => i.helps[k]) ? 0.85 : 0.6);
  }
  for (const ing of ings) {
    for (const [c, w] of Object.entries(ing.helps)) if (c in v) v[c] = Math.max(v[c], w * (ing.strength ?? 1));
  }
  return v;
}

const PREGNANT = /pregnan|breastfeed|breast-feed|nursing|حامل|حمل|رضاعة|مرضع/i;
const ISOTRETINOIN = /isotretinoin|accutane|roaccutane|roacutan|absorica|claravis|tretinoin|adapalene|differin|tazarotene|ايزوتريتينوين|روكتان|روأكيوتان/i;

/** Health answers → personal safety flags. */
function healthFlags(health = {}) {
  const text = [health.skinCondition, health.medications].filter(Boolean).join(' ');
  return { pregnant: PREGNANT.test(text), retinoidMedicine: ISOTRETINOIN.test(text) };
}

function normaliseSkinType(t = '') {
  const s = t.toLowerCase();
  return ['dry', 'oily', 'combination', 'normal', 'sensitive'].find((k) => s.includes(k)) ?? 'normal';
}

/** Words from the user's allergy answers (only real text, not "yes"/"no"). */
function allergyTerms(health = {}) {
  return [health.ingredientAllergy, health.productAllergy]
    .filter((v) => v && !['yes', 'no', 'none'].includes(String(v).trim().toLowerCase()))
    .flatMap((v) => String(v).toLowerCase().split(/[,;/]+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

function scoreProduct(p, ctx) {
  const vec = productVector(p);
  const needSum = CONCERNS.reduce((s, c) => s + ctx.need[c] ** 2, 0) || 1;

  // coverage: how much of the user's need (weighted by need) the product addresses
  let covered = 0;
  const contributions = [];
  for (const c of CONCERNS) {
    const part = ctx.need[c] ** 2 * vec[c];
    covered += part;
    if (vec[c] > 0) contributions.push({ concern: c, part, need: ctx.need[c], strength: vec[c] });
  }
  let score = Math.sqrt(covered / needSum); // 0..1

  // skin-type fit
  const st = ctx.skinType;
  const types = p.skinTypes ?? [];
  let fit = types.length === 0 || types.includes(st) ? 1 : st === 'combination' && (types.includes('oily') || types.includes('normal')) ? 0.9 : 0.72;
  if (ctx.sensitive && types.includes('sensitive')) fit = Math.min(1, fit + 0.08);
  if (st === 'oily' && p.nonComedogenic) fit = Math.min(1, fit + 0.05);
  score *= fit;

  // safety
  const ings = matchIngredients(p.ingredients);
  const warnings = [];
  const allText = [p.name, ...(p.ingredients ?? [])].join(' ').toLowerCase();
  const allergen = ctx.allergies.find((a) => allText.includes(a));
  if (allergen) return { score: 0, excluded: `Contains ${allergen}, which you told us you’re allergic to.` };
  if (ctx.pregnant) {
    const bad = ings.find((i) => i.pregnancy === 'avoid');
    if (bad) return { score: 0, excluded: `Contains ${bad.key}, which is not recommended during pregnancy or breastfeeding.` };
    const careful = ings.find((i) => i.pregnancy === 'caution');
    if (careful) {
      score *= 0.85;
      warnings.push(`Ask your doctor before using ${careful.key} during pregnancy.`);
    }
  }
  if (ctx.retinoidMedicine) {
    const clash = ings.find((i) => i.group === 'exfoliant' || i.group === 'retinoid');
    if (clash) return { score: 0, excluded: `Contains ${clash.key} — skip exfoliating and retinoid products while you take your prescribed retinoid medicine.` };
  }
  for (const i of ings) {
    if (i.medicalOnly) {
      score *= 0.7;
      warnings.push(`${i.key} should only be used with a doctor’s advice.`);
    }
    const harshFor = i.avoidSkin?.includes(st) ? st : ctx.sensitive && i.avoidSkin?.includes('sensitive') ? 'sensitive' : null;
    if (harshFor) {
      score *= 0.8;
      warnings.push(`${i.key} can be harsh on ${harshFor} skin — start slowly.`);
    }
    // irritation hurts sensitive / red skin much more
    if (i.irritation) score *= 1 - (ctx.sensitive ? 0.5 : 0.15) * i.irritation;
    if (i.comedogenic && (st === 'oily' || st === 'combination')) score *= 1 - 0.4 * i.comedogenic;
  }
  const scented = ings.some((i) => i.flagSensitive);
  if (ctx.sensitive && (scented || !p.fragranceFree)) {
    score *= scented ? 0.85 : 0.94;
    if (scented) warnings.push('Contains fragrance, which can irritate sensitive skin.');
  }

  // evidence from customers' later scans (small, capped, only with enough customers)
  const ev = ctx.outcomes?.get(String(p._id ?? p.id));
  let evidence = null;
  if (ev) {
    let e = 0;
    let w = 0;
    for (const c of CONCERNS) {
      e += (ev.effect[c] ?? 0) * ctx.need[c];
      w += ctx.need[c];
    }
    const effect = w ? e / w : 0;
    score *= 1 + Math.max(-0.1, Math.min(0.1, effect * 0.5));
    // what to tell the user: the concern they need most where buyers clearly did better than average
    const shown = CONCERNS.filter((c) => ev.seen?.[c] && ctx.need[c] >= 0.15 && ev.seen[c].pct > 0 && ev.seen[c].pct - ev.seen[c].everyone >= 3 && (ev.effect[c] ?? 0) > 0)
      .sort((a, b) => ctx.need[b] - ctx.need[a])[0];
    evidence = { customers: ev.n, effect: Math.round(effect * 100) / 100, weeks: ev.weeks };
    if (shown) {
      Object.assign(evidence, { concern: shown, label: LABEL[shown], pct: ev.seen[shown].pct, everyone: ev.seen[shown].everyone });
      evidence.text = `${ev.n} Melody customers rescanned about ${ev.weeks} weeks after buying it: their ${LABEL[shown]} was ${ev.seen[shown].pct}% better on average (everyone: ${ev.seen[shown].everyone}%).`;
    }
  }

  // sunscreen is always worth recommending in the morning
  if (p.category === 'sunscreen') score = Math.max(score, 0.62 * fit);

  contributions.sort((a, b) => b.part - a.part);
  return { score, vec, ings, contributions: contributions.slice(0, 3), warnings, evidence };
}

function measuredText(concern, metrics) {
  if (concern === 'dehydration') return `your ${Math.round(metrics.hydration)}% hydration (${Math.round(100 - metrics.hydration)}% moisture deficit)`;
  if (concern === 'barrier') return 'your stressed skin barrier';
  return `your ${LABEL[concern]} score of ${Math.round(metrics[concern] ?? 0)}`;
}

function reasonsFor(p, scored, metrics) {
  // measured concerns first, the derived "barrier" last; one sentence per ingredient
  const picked = scored.contributions
    .filter((c) => c.need >= 0.15)
    .sort((a, b) => (a.concern === 'barrier') - (b.concern === 'barrier') || b.part - a.part)
    .slice(0, 2);
  const groups = new Map();
  for (const c of picked) {
    const ing = scored.ings.filter((i) => i.helps[c.concern]).sort((a, b) => b.helps[c.concern] - a.helps[c.concern])[0];
    const key = ing?.key ?? `_${c.concern}`;
    if (!groups.has(key)) groups.set(key, { ing, concerns: [] });
    groups.get(key).concerns.push(c.concern);
  }
  const reasons = [];
  for (const { ing, concerns } of groups.values()) {
    const what = concerns.map((c) => measuredText(c, metrics)).join(' and ');
    reasons.push(ing ? `Targets ${what} — ${ing.key} ${ing.how}.` : `Made for ${concerns.map((c) => LABEL[c]).join(' and ')}, matching ${what}.`);
  }
  if (!reasons.length) reasons.push(p.category === 'sunscreen' ? 'Daily UV protection keeps your results from slipping.' : 'Gentle daily care that suits your skin type.');
  return reasons;
}

const METRIC_KEY = { dehydration: 'hydration' };
const TARGET_LABEL = { dehydration: 'Hydration', oil: 'Oil', redness: 'Redness', pigmentation: 'Dark spots', texture: 'Texture', pores: 'Pores', wrinkles: 'Fine lines', barrier: 'Skin barrier' };

/** Chips for the "why": [{ concern, label, value, ingredient, sure }] — measured value + the active that addresses it. */
function targetDetails(r, metrics, confidence) {
  return r.contributions
    .filter((c) => c.need >= 0.15 && c.concern !== 'barrier')
    .slice(0, 3)
    .map((c) => {
      const key = METRIC_KEY[c.concern] ?? c.concern;
      const ing = r.ings.filter((i) => i.helps[c.concern]).sort((a, b) => b.helps[c.concern] - a.helps[c.concern])[0];
      return { concern: c.concern, label: TARGET_LABEL[c.concern], value: Math.round(metrics[key] ?? 0), ingredient: ing?.key ?? null, sure: confidence?.[key]?.level ?? null };
    });
}

/* ---------- routine ---------- */

const STEPS = {
  morning: ['cleanser', 'serum', 'moisturizer', 'sunscreen'],
  evening: ['cleanser', 'treatment', 'serum', 'moisturizer'],
};

function fitsTime(p, time, ings) {
  if (p.routine !== 'both' && p.routine !== time) return false;
  return !ings.some((i) => i.time && i.time !== time);
}

function buildRoutine(ranked) {
  const out = { morning: [], evening: [] };
  const used = new Set();
  for (const time of ['morning', 'evening']) {
    const actives = [];
    for (const step of STEPS[time]) {
      const pick = ranked.find((r) => {
        const cat = r.product.category === 'toner' ? 'serum' : r.product.category;
        if (cat !== step || !fitsTime(r.product, time, r.ings)) return false;
        if (step === 'serum' && out[time].some((x) => x.step === 'treatment')) return false; // one active per night
        const clash = r.ings.some((i) => i.notMixWith?.some((n) => actives.includes(n)));
        return !clash && (!used.has(r.id) || step === 'cleanser' || step === 'moisturizer');
      });
      if (!pick) continue;
      out[time].push({ step, productId: pick.id, name: pick.product.name, brand: pick.product.brand, category: pick.product.category, hasImage: !!pick.product.hasImage, imageUrl: pick.product.imageUrl, updatedAt: pick.product.updatedAt });
      if (step !== 'cleanser') pick.ings.forEach((i) => actives.push(i.key)); // rinse-off: doesn't clash
      used.add(pick.id);
    }
  }
  return out;
}

/**
 * @param products plain product objects (active ones)
 * @param results scan results ({ metrics, skinType })
 * @param user user document (for health/allergies)
 */
function recommend(products, results, user, { limit = 8, previous = null, outcomes = null } = {}) {
  const metrics = results.metrics;
  const need = needsFromMetrics(metrics);
  // concerns that are getting worse since the previous scan get up to +0.15 need
  const worsening = [];
  if (previous) {
    const before = needsFromMetrics(previous);
    for (const c of CONCERNS) {
      const d = need[c] - before[c];
      if (d > 0.08) {
        need[c] = Math.min(1, need[c] + Math.min(0.15, d * 0.5));
        worsening.push(c);
      }
    }
  }
  const flags = healthFlags(user?.health);
  const ctx = {
    need,
    skinType: normaliseSkinType(results.skinType),
    sensitive: /yes|sensitiv|eczema|rosacea|dermatitis|حساس|اكزيما|إكزيما|وردية/i.test(user?.health?.skinCondition ?? '') || metrics.redness > 60,
    allergies: allergyTerms(user?.health),
    pregnant: flags.pregnant,
    retinoidMedicine: flags.retinoidMedicine,
    outcomes,
  };

  const excluded = [];
  const ranked = [];
  for (const p of products) {
    if (!FACE_CATEGORIES.includes(p.category)) continue; // the face scan only suggests face care
    const s = scoreProduct(p, ctx);
    const id = String(p._id ?? p.id);
    if (s.excluded) {
      excluded.push({ productId: id, name: p.name, reason: s.excluded });
      continue;
    }
    ranked.push({ id, product: p, score: s.score, ings: s.ings, contributions: s.contributions, warnings: s.warnings, evidence: s.evidence });
  }
  ranked.sort((a, b) => b.score - a.score);

  // variety: at most 2 products of the same category in the suggestion list
  const perCat = {};
  const varied = ranked.filter((r) => (perCat[r.product.category] = (perCat[r.product.category] ?? 0) + 1) <= 2);
  const top = varied.slice(0, limit).map((r) => ({
    productId: r.id,
    match: Math.round(Math.min(0.99, r.score) * 100),
    reasons: reasonsFor(r.product, r, metrics),
    warnings: r.warnings,
    targets: r.contributions.filter((c) => c.need >= 0.15).map((c) => c.concern),
    targetDetails: targetDetails(r, metrics, results.confidence),
    evidence: r.evidence, // { customers, effect, text? } once enough buyers rescanned
  }));

  const focus = Object.entries(ctx.need)
    .filter(([k]) => k !== 'barrier')
    .sort((a, b) => b[1] - a[1])[0][0];
  return {
    skinType: ctx.skinType,
    needs: ctx.need,
    focus,
    focusLabel: LABEL[focus],
    products: top,
    routine: buildRoutine(ranked),
    excluded,
    worsening,
    safety: { pregnant: ctx.pregnant, retinoidMedicine: ctx.retinoidMedicine, sensitive: ctx.sensitive },
  };
}

module.exports = { recommend, needsFromMetrics, productVector, healthFlags, LABEL, CONCERNS };
