/**
 * Product page content derived from a product's data (no hand-written copy needed per product):
 *  - keyIngredients: up to 3 actives from the ingredient knowledge base (side pill on the photo)
 *  - benefits: "Clinical profile" — what the product does, from its concerns + ingredients
 *  - usage: "Usage protocol" — 3 steps for its category
 * and, for a logged-in user with a scan, how well it matches their skin ("diagnostic alignment").
 */
const { matchIngredients } = require('./ingredients');
const { recommend, productVector } = require('./matcher');

const SHORT = {
  'hyaluronic acid': ['HYALURONIC', 'water-outline'],
  glycerin: ['GLYCERIN', 'water'],
  ceramides: ['CERAMIDES', 'wall'],
  squalane: ['SQUALANE', 'oil'],
  panthenol: ['B5', 'flask-outline'],
  niacinamide: ['NIACINAMIDE', 'flask-outline'],
  'salicylic acid': ['BHA', 'flask-outline'],
  zinc: ['ZINC', 'atom'],
  clay: ['CLAY', 'terrain'],
  'centella asiatica': ['CICA', 'leaf'],
  'azelaic acid': ['AZELAIC', 'flask-outline'],
  allantoin: ['ALLANTOIN', 'leaf'],
  'vitamin c': ['VITAMIN C', 'white-balance-sunny'],
  'alpha arbutin': ['ARBUTIN', 'flask-outline'],
  'tranexamic acid': ['TRANEXAMIC', 'flask-outline'],
  retinol: ['RETINOL', 'moon-waning-crescent'],
  peptides: ['PEPTIDES', 'microscope'],
  'glycolic acid': ['AHA', 'flask-outline'],
  spf: ['SPF', 'shield-sun-outline'],
};

const BENEFIT = {
  dehydration: ['Deep Hydration', 'waves', 'Multi-weight moisture binders help hydration reach every layer of the skin.'],
  barrier: ['Barrier Repair', 'shield-half-full', 'Strengthens the skin’s natural lipid barrier against environmental stressors.'],
  redness: ['Calming Care', 'leaf', 'Soothes visible redness and reactive, irritated skin.'],
  oil: ['Oil Balance', 'water-percent', 'Keeps shine in check without stripping the skin.'],
  pores: ['Pore Refining', 'dots-grid', 'Clears congestion so pores look smaller and smoother.'],
  pigmentation: ['Tone Correction', 'circle-half-full', 'Fades dark spots for a brighter, more even complexion.'],
  texture: ['Surface Renewal', 'texture-box', 'Smooths rough texture for a softer, polished feel.'],
  wrinkles: ['Line Smoothing', 'auto-fix', 'Softens the look of fine lines and supports firmness.'],
  acne: ['Blemish Control', 'target', 'Helps keep breakouts and blemishes under control.'],
};

const NEED_LABEL = {
  dehydration: 'TEWL Reduction',
  barrier: 'Epidermal Repair',
  redness: 'Inflammation',
  oil: 'Sebum Control',
  pores: 'Pore Clarity',
  pigmentation: 'Tone Correction',
  texture: 'Surface Renewal',
  wrinkles: 'Line Smoothing',
};

const METRIC_WORD = { oil: 'oil', redness: 'redness', pigmentation: 'dark-spot', texture: 'texture', pores: 'pore', wrinkles: 'fine-line' };

const USAGE = {
  cleanser: [
    ['Wet', 'hand-wash-outline', 'Splash your face with lukewarm water.'],
    ['Massage', 'gesture-tap', 'Work a small amount over the skin for 30–60 seconds.'],
    ['Rinse', 'water-outline', 'Rinse well and pat dry — follow with your treatment step.'],
  ],
  toner: [
    ['Cleanse', 'hand-wash-outline', 'Start with freshly cleansed skin.'],
    ['Apply', 'gesture-tap', 'Press a few drops into the skin with your palms or a pad.'],
    ['Layer', 'layers-outline', 'Follow with serum and moisturizer while skin is still damp.'],
  ],
  serum: [
    ['Cleanse', 'hand-wash-outline', 'Begin with a thoroughly cleansed and slightly damp face.'],
    ['Apply', 'gesture-tap', 'Dispense 2–3 drops onto fingertips and gently press into skin.'],
    ['Seal', 'lock-outline', 'Follow immediately with your prescribed Melody Beauty moisturizer.'],
  ],
  treatment: [
    ['Cleanse', 'hand-wash-outline', 'Use on clean, completely dry skin in the evening.'],
    ['Apply', 'gesture-tap', 'Smooth a pea-sized amount over the face, avoiding eyes and lips.'],
    ['Seal', 'lock-outline', 'Moisturize after — start 2–3 nights a week and wear SPF every morning.'],
  ],
  moisturizer: [
    ['Cleanse', 'hand-wash-outline', 'Apply after cleansing and any serum.'],
    ['Apply', 'gesture-tap', 'Warm a small amount between fingertips and press over face and neck.'],
    ['Protect', 'shield-sun-outline', 'In the morning, finish with SPF.'],
  ],
  sunscreen: [
    ['Prep', 'hand-wash-outline', 'Apply as the last step of your morning routine.'],
    ['Apply', 'gesture-tap', 'Use two finger-lengths for face and neck, 15 minutes before sun.'],
    ['Re-apply', 'restore', 'Re-apply every 2 hours outdoors, and after sweating or swimming.'],
  ],
  mask: [
    ['Cleanse', 'hand-wash-outline', 'Start with clean skin.'],
    ['Apply', 'gesture-tap', 'Spread an even layer and leave on as directed.'],
    ['Rinse', 'water-outline', 'Rinse or leave on overnight, then moisturize.'],
  ],
  eye: [
    ['Cleanse', 'hand-wash-outline', 'Apply on clean skin, morning and evening.'],
    ['Tap', 'gesture-tap', 'Gently tap a rice-sized amount around the orbital bone with your ring finger.'],
    ['Protect', 'shield-sun-outline', 'Follow with SPF in the morning.'],
  ],
};
USAGE.body = [
  ['Shower', 'shower', 'Apply after showering, on slightly damp skin.'],
  ['Massage', 'gesture-tap', 'Massage in with circular movements until absorbed.'],
  ['Repeat', 'restore', 'Use daily; focus on rough areas like elbows and knees.'],
];
USAGE['hand-foot'] = [
  ['Clean', 'hand-wash-outline', 'Wash and dry hands or feet.'],
  ['Massage', 'gesture-tap', 'Massage a small amount into dry areas and heels.'],
  ['Overnight', 'moon-waning-crescent', 'For cracked heels, apply at night under cotton socks.'],
];
USAGE.hair = [
  ['Towel-dry', 'hair-dryer-outline', 'Use on towel-dried or dry hair.'],
  ['Apply', 'gesture-tap', 'Warm 2–3 drops in your palms and smooth over mid-lengths and ends.'],
  ['Style', 'brush-variant', 'Style as usual — no need to rinse.'],
];
USAGE.oral = [
  ['Brush', 'toothbrush', 'Brush twice a day for two minutes with a pea-sized amount.'],
  ['Spit', 'water-outline', 'Spit out — don’t rinse straight away, so the fluoride keeps working.'],
  ['Repeat', 'restore', 'Use morning and night.'],
];
USAGE.personal = [
  ['Clean', 'hand-wash-outline', 'Apply to clean, dry skin.'],
  ['Apply', 'gesture-tap', 'Use 2–3 strokes or a small amount.'],
  ['Re-apply', 'restore', 'Re-apply during the day as needed.'],
];
USAGE.makeup = [
  ['Prep', 'hand-wash-outline', 'Apply over your moisturizer and SPF.'],
  ['Apply', 'gesture-tap', 'Build up a thin layer for a natural finish.'],
  ['Re-apply', 'restore', 'Touch up during the day as needed.'],
];

const GENERIC_USAGE = [
  ['Prepare', 'hand-wash-outline', 'Use on clean skin.'],
  ['Apply', 'gesture-tap', 'Apply as needed and massage in gently.'],
  ['Repeat', 'restore', 'Use daily for best results.'],
];

function productInsights(p) {
  // in the order the product lists them (the first ones are its hero actives)
  const text = (p.ingredients ?? []).join(' | ').toLowerCase();
  const pos = (i) => Math.min(...i.aliases.map((a) => text.indexOf(a)).filter((x) => x >= 0));
  const ings = matchIngredients(p.ingredients ?? []).sort((a, b) => pos(a) - pos(b));
  const keyIngredients = ings.slice(0, 3).map((i) => ({ key: i.key, label: SHORT[i.key]?.[0] ?? i.key.toUpperCase(), icon: SHORT[i.key]?.[1] ?? 'flask-outline' }));

  // what it treats, strongest first (declared concerns count as strong)
  const vec = productVector(p);
  for (const c of p.concerns ?? []) if (c in BENEFIT) vec[c] = Math.max(vec[c] ?? 0, 0.85);
  const ranked = Object.entries(vec)
    .filter(([k, v]) => v >= 0.5 && BENEFIT[k])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => ({ key: k, title: BENEFIT[k][0], icon: BENEFIT[k][1], text: BENEFIT[k][2] }));
  const benefits = [...ranked];
  if (p.fragranceFree) benefits.push({ key: 'gentle', title: 'Gentle Formula', icon: 'flower-outline', text: 'Fragrance-free, made for sensitive and reactive skin.' });
  else if (p.nonComedogenic) benefits.push({ key: 'noncomedogenic', title: 'Non-comedogenic', icon: 'check-decagram-outline', text: 'Formulated not to clog pores.' });
  else if (ings.length) benefits.push({ key: 'stability', title: 'Molecular Stability', icon: 'infinity', text: 'Formulated for optimal pH balance and long-term efficacy.' });
  else benefits.push({ key: 'daily', title: 'Daily Essential', icon: 'heart-outline', text: 'Made for simple, consistent everyday use.' });

  const usage = (USAGE[p.category] ?? GENERIC_USAGE).map(([title, icon, text]) => ({ title, icon, text }));
  const routineLabel = p.routine === 'morning' ? 'MORNING ROUTINE' : p.routine === 'evening' ? 'NIGHT ROUTINE' : 'DAILY ROUTINE';
  return { keyIngredients, benefits: benefits.slice(0, 3), usage, routineLabel };
}

/**
 * How one product matches the user's latest scan. Returns null for products the face scan
 * doesn't cover (body, hair, …).
 */
function productMatch(p, scanResults, user) {
  const rec = recommend([p], scanResults, user, { limit: 1 });
  if (rec.excluded.length) return { match: 0, excluded: rec.excluded[0].reason, alignment: [], highlights: [] };
  const item = rec.products[0];
  if (!item) return null;

  const vec = productVector(p);
  const ings = matchIngredients(p.ingredients ?? []);
  const alignment = Object.entries(rec.needs)
    .filter(([k, need]) => need >= 0.15 && vec[k] > 0 && NEED_LABEL[k])
    .sort((a, b) => b[1] * vec[b[0]] - a[1] * vec[a[0]])
    .slice(0, 3)
    .map(([k, need]) => {
      const best = ings.filter((i) => i.helps[k]).sort((a, b) => b.helps[k] - a.helps[k])[0];
      const strength = vec[k];
      return {
        need: k,
        needLabel: NEED_LABEL[k],
        agent: best ? best.key.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Formula',
        grade: strength >= 0.85 ? 'Exact' : strength >= 0.6 ? 'High' : 'Moderate',
        needPct: Math.round(need * 100),
      };
    });

  return {
    match: item.match,
    reasons: item.reasons,
    warnings: item.warnings,
    alignment,
    // the two biggest needs this product addresses, for the summary card
    highlights: alignment
      .filter((a) => a.need !== 'barrier')
      .slice(0, 2)
      .map((a) => {
        const m = scanResults.metrics;
        return a.need === 'dehydration'
          ? { label: 'Your hydration level', value: `${Math.round(m.hydration)}%` }
          : { label: `Your ${METRIC_WORD[a.need] ?? a.need} score`, value: `${Math.round(m[a.need] ?? 0)}` };
      }),
    skinType: rec.skinType,
  };
}

module.exports = { productInsights, productMatch };
