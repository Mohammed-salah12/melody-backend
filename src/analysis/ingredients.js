/**
 * Ingredient knowledge base used by the product matcher.
 *
 * Each entry: which skin concerns it helps (0–1), a short plain-language "how", and safety data:
 *   time        'morning' | 'evening'   when it should be used (vitamin C AM, retinoids PM)
 *   avoidSkin   skin types it can be harsh on
 *   notMixWith  keys it shouldn't be layered with in the same routine
 *   irritation  0–1 how likely it is to irritate (scaled up at high %)
 *   pregnancy   'avoid' | 'caution'     (shown as a warning; 'avoid' excludes for pregnant users)
 *   group       family used by medication rules (e.g. isotretinoin → no exfoliants/retinoids)
 *   dose        [min, ideal] % where a % is given on the label ("niacinamide 10%")
 *   lowDose     true when it works at tiny amounts, so a late place in a full INCI list is fine
 *
 * Products can list just key actives ("hyaluronic acid, ceramides") or paste their full INCI list
 * ("Aqua, Glycerin, Niacinamide, …") — both are understood. Add entries freely: new products
 * are matched against this list automatically.
 */
const INGREDIENTS = [
  // ---------- hydration & barrier ----------
  { key: 'hyaluronic acid', aliases: ['hyaluronic acid', 'hyaluronic', 'sodium hyaluronate', 'hydrolyzed hyaluronic acid', 'sodium acetylated hyaluronate'], helps: { dehydration: 1, barrier: 0.3 }, how: 'draws water into the upper skin layers', dose: [0.1, 1], lowDose: true },
  { key: 'glycerin', aliases: ['glycerin', 'glycerol'], helps: { dehydration: 0.6 }, how: 'holds moisture in the skin' },
  { key: 'urea', aliases: ['urea'], helps: { dehydration: 0.8, texture: 0.6, barrier: 0.4 }, how: 'binds water and softens rough, flaky skin', dose: [2, 10], irritation: 0.15 },
  { key: 'ceramides', aliases: ['ceramide', 'ceramide np', 'ceramide ap', 'ceramide eop', 'phytosphingosine'], helps: { barrier: 1, dehydration: 0.6, redness: 0.3 }, how: 'rebuilds the skin barrier and reduces water loss', lowDose: true },
  { key: 'squalane', aliases: ['squalane'], helps: { dehydration: 0.6, barrier: 0.5 }, how: 'replaces lost lipids without clogging pores' },
  { key: 'shea butter', aliases: ['shea butter', 'butyrospermum parkii', 'shea'], helps: { dehydration: 0.6, barrier: 0.6 }, how: 'cushions very dry skin with rich lipids', avoidSkin: ['oily'], comedogenic: 0.3 },
  { key: 'cholesterol', aliases: ['cholesterol'], helps: { barrier: 0.6 }, how: 'restores the barrier’s natural lipid balance', lowDose: true },
  { key: 'fatty acids', aliases: ['linoleic acid', 'linolenic acid', 'omega'], helps: { barrier: 0.5, dehydration: 0.3 }, how: 'replenishes barrier lipids', lowDose: true },
  { key: 'panthenol', aliases: ['panthenol', 'provitamin b5', 'dexpanthenol'], helps: { barrier: 0.6, redness: 0.5, dehydration: 0.4 }, how: 'soothes and supports barrier repair', dose: [1, 5] },
  { key: 'beta-glucan', aliases: ['beta-glucan', 'beta glucan', 'oat beta glucan'], helps: { dehydration: 0.6, redness: 0.5, barrier: 0.4 }, how: 'hydrates and calms stressed skin', lowDose: true },
  { key: 'polyglutamic acid', aliases: ['polyglutamic acid', 'sodium polyglutamate'], helps: { dehydration: 0.8 }, how: 'holds a film of moisture on the skin surface', lowDose: true },
  { key: 'snail mucin', aliases: ['snail secretion filtrate', 'snail mucin'], helps: { dehydration: 0.5, barrier: 0.4, texture: 0.3 }, how: 'hydrates and supports skin recovery' },
  { key: 'aloe vera', aliases: ['aloe barbadensis', 'aloe vera', 'aloe'], helps: { dehydration: 0.4, redness: 0.4 }, how: 'cools and lightly hydrates' },

  // ---------- calming ----------
  { key: 'centella asiatica', aliases: ['centella', 'cica', 'madecassoside', 'asiaticoside', 'centella asiatica'], helps: { redness: 1, barrier: 0.6 }, how: 'calms visible redness and irritation', lowDose: true },
  { key: 'allantoin', aliases: ['allantoin'], helps: { redness: 0.5, barrier: 0.4 }, how: 'soothes sensitive skin', lowDose: true },
  { key: 'colloidal oatmeal', aliases: ['colloidal oatmeal', 'avena sativa', 'oat kernel'], helps: { redness: 0.7, barrier: 0.5, dehydration: 0.3 }, how: 'relieves dry, itchy and reactive skin' },
  { key: 'bisabolol', aliases: ['bisabolol', 'chamomile', 'chamomilla recutita'], helps: { redness: 0.6 }, how: 'calms irritation', lowDose: true },
  { key: 'green tea', aliases: ['camellia sinensis', 'green tea', 'egcg'], helps: { redness: 0.5, oil: 0.3, wrinkles: 0.2 }, how: 'antioxidant that calms redness and shine', lowDose: true },
  { key: 'licorice root', aliases: ['glycyrrhiza glabra', 'licorice', 'liquorice', 'dipotassium glycyrrhizate'], helps: { redness: 0.6, pigmentation: 0.6 }, how: 'calms redness and evens tone', lowDose: true },
  { key: 'ectoin', aliases: ['ectoin'], helps: { barrier: 0.6, redness: 0.5, dehydration: 0.4 }, how: 'protects skin from environmental stress', lowDose: true },
  { key: 'mugwort', aliases: ['artemisia', 'mugwort'], helps: { redness: 0.5 }, how: 'soothes reactive skin', lowDose: true },
  { key: 'thermal water', aliases: ['thermal water', 'thermal spring water'], helps: { redness: 0.3 }, how: 'soothes and refreshes' },

  // ---------- oil, pores, breakouts ----------
  { key: 'niacinamide', aliases: ['niacinamide', 'nicotinamide', 'vitamin b3'], helps: { pores: 0.8, oil: 0.7, redness: 0.5, pigmentation: 0.5, barrier: 0.5 }, how: 'regulates oil, refines pores and evens tone', dose: [2, 5], irritation: 0.05 },
  { key: 'salicylic acid', aliases: ['salicylic acid', 'salicylic', 'bha', 'betaine salicylate', 'willow bark'], helps: { pores: 1, oil: 0.8, texture: 0.6 }, how: 'clears inside pores and lifts excess sebum', dose: [0.5, 2], irritation: 0.35, avoidSkin: ['dry'], notMixWith: ['retinol'], pregnancy: 'caution', group: 'exfoliant' },
  { key: 'benzoyl peroxide', aliases: ['benzoyl peroxide'], helps: { pores: 0.8, oil: 0.6 }, how: 'kills breakout-causing bacteria', dose: [2.5, 5], irritation: 0.6, avoidSkin: ['dry', 'sensitive'], notMixWith: ['retinol', 'vitamin c'], group: 'exfoliant' },
  { key: 'zinc', aliases: ['zinc pca', 'zinc gluconate', 'zinc sulfate', 'zinc'], helps: { oil: 0.8, redness: 0.3 }, how: 'controls shine and calms breakouts' },
  { key: 'sulfur', aliases: ['sulfur', 'sulphur'], helps: { oil: 0.6, pores: 0.6 }, how: 'dries out blemishes and absorbs oil', irritation: 0.3, avoidSkin: ['dry'] },
  { key: 'tea tree', aliases: ['melaleuca alternifolia', 'tea tree'], helps: { oil: 0.4, pores: 0.4 }, how: 'helps calm blemishes', irritation: 0.25, avoidSkin: ['sensitive'] },
  { key: 'clay', aliases: ['kaolin', 'bentonite', 'clay', 'charcoal'], helps: { oil: 0.7, pores: 0.5 }, how: 'absorbs excess oil from the T-zone', avoidSkin: ['dry'] },
  { key: 'azelaic acid', aliases: ['azelaic acid', 'azelaic', 'potassium azeloyl diglycinate', 'azeloglycine'], helps: { redness: 0.8, pigmentation: 0.7, pores: 0.4 }, how: 'reduces redness and fades dark marks', dose: [5, 15], irritation: 0.2 },

  // ---------- exfoliation & texture ----------
  { key: 'glycolic acid', aliases: ['glycolic acid', 'glycolic', 'aha'], helps: { texture: 1, pigmentation: 0.5, pores: 0.4 }, how: 'gently exfoliates for smoother, brighter skin', dose: [5, 10], irritation: 0.45, time: 'evening', avoidSkin: ['sensitive'], notMixWith: ['retinol'], group: 'exfoliant' },
  { key: 'lactic acid', aliases: ['lactic acid', 'lactic'], helps: { texture: 0.8, dehydration: 0.3, pigmentation: 0.4 }, how: 'exfoliates gently while adding moisture', dose: [5, 10], irritation: 0.3, time: 'evening', notMixWith: ['retinol'], group: 'exfoliant' },
  { key: 'mandelic acid', aliases: ['mandelic acid', 'mandelic'], helps: { texture: 0.7, pores: 0.4, pigmentation: 0.4 }, how: 'a slow, gentle exfoliant for sensitive skin', dose: [5, 10], irritation: 0.2, time: 'evening', notMixWith: ['retinol'], group: 'exfoliant' },
  { key: 'pha', aliases: ['gluconolactone', 'lactobionic acid', 'pha'], helps: { texture: 0.6, dehydration: 0.2 }, how: 'the gentlest acid exfoliant, kind to sensitive skin', irritation: 0.1, group: 'exfoliant' },
  { key: 'enzymes', aliases: ['papain', 'bromelain', 'papaya enzyme'], helps: { texture: 0.5 }, how: 'dissolves dead cells without scrubbing', irritation: 0.15, group: 'exfoliant' },

  // ---------- tone & dark spots ----------
  { key: 'vitamin c', aliases: ['ascorbic acid', 'ascorbyl', 'vitamin c', 'tetrahexyldecyl ascorbate', 'ethyl ascorbic acid', '3-o-ethyl ascorbic acid', 'magnesium ascorbyl phosphate', 'sodium ascorbyl phosphate'], helps: { pigmentation: 1, wrinkles: 0.4 }, how: 'brightens and fades dark spots', dose: [5, 15], irritation: 0.25, time: 'morning', notMixWith: ['benzoyl peroxide'] },
  { key: 'alpha arbutin', aliases: ['alpha-arbutin', 'alpha arbutin', 'arbutin'], helps: { pigmentation: 0.9 }, how: 'targets dark spots and uneven tone', dose: [1, 2] },
  { key: 'tranexamic acid', aliases: ['tranexamic acid', 'tranexamic'], helps: { pigmentation: 0.9, redness: 0.3 }, how: 'fades stubborn discoloration', dose: [2, 5], lowDose: true },
  { key: 'kojic acid', aliases: ['kojic acid', 'kojic'], helps: { pigmentation: 0.8 }, how: 'lightens dark spots', irritation: 0.25, dose: [1, 2] },
  { key: 'hydroquinone', aliases: ['hydroquinone'], helps: { pigmentation: 1 }, how: 'strongly fades dark patches (use only under medical advice)', irritation: 0.5, pregnancy: 'avoid', medicalOnly: true },
  { key: 'thiamidol', aliases: ['thiamidol', 'isobutylamido thiazolyl resorcinol'], helps: { pigmentation: 0.9 }, how: 'blocks the enzyme that makes dark spots', lowDose: true },
  { key: 'ferulic acid', aliases: ['ferulic acid'], helps: { pigmentation: 0.4, wrinkles: 0.3 }, how: 'boosts antioxidant protection', lowDose: true },
  { key: 'vitamin e', aliases: ['tocopherol', 'tocopheryl acetate', 'vitamin e'], helps: { barrier: 0.3, wrinkles: 0.2 }, how: 'antioxidant that supports the barrier', lowDose: true },
  { key: 'resveratrol', aliases: ['resveratrol'], helps: { wrinkles: 0.4, pigmentation: 0.3 }, how: 'antioxidant against visible ageing', lowDose: true },

  // ---------- lines & firmness ----------
  { key: 'retinol', aliases: ['retinol', 'retinal', 'retinaldehyde', 'retinyl palmitate', 'retinyl retinoate', 'hydroxypinacolone retinoate', 'retinoid', 'granactive retinoid'], helps: { wrinkles: 1, texture: 0.7, pores: 0.5, pigmentation: 0.4 }, how: 'renews cells to smooth lines and texture', dose: [0.1, 0.5], lowDose: true, irritation: 0.5, time: 'evening', avoidSkin: ['sensitive'], notMixWith: ['glycolic acid', 'salicylic acid', 'lactic acid', 'mandelic acid', 'benzoyl peroxide'], pregnancy: 'avoid', group: 'retinoid' },
  { key: 'bakuchiol', aliases: ['bakuchiol'], helps: { wrinkles: 0.6, texture: 0.4, pigmentation: 0.3 }, how: 'a gentle, plant-based alternative to retinol', lowDose: true, irritation: 0.1 },
  { key: 'peptides', aliases: ['peptide', 'palmitoyl', 'matrixyl', 'argireline', 'acetyl hexapeptide', 'copper tripeptide', 'copper peptide'], helps: { wrinkles: 0.7, barrier: 0.3 }, how: 'supports firmness and collagen', lowDose: true },
  { key: 'adenosine', aliases: ['adenosine'], helps: { wrinkles: 0.5 }, how: 'smooths the look of fine lines', lowDose: true },
  { key: 'caffeine', aliases: ['caffeine'], helps: { wrinkles: 0.3, redness: 0.2 }, how: 'reduces puffiness, especially around the eyes', lowDose: true },
  { key: 'coenzyme q10', aliases: ['ubiquinone', 'coenzyme q10', 'q10'], helps: { wrinkles: 0.4 }, how: 'antioxidant support for mature skin', lowDose: true },

  // ---------- sun protection ----------
  { key: 'spf', aliases: ['spf', 'zinc oxide', 'titanium dioxide', 'uv filter', 'avobenzone', 'octocrylene', 'homosalate', 'bemotrizinol', 'bis-ethylhexyloxyphenol methoxyphenyl triazine', 'ethylhexyl triazone', 'tinosorb', 'uvinul', 'diethylamino hydroxybenzoyl hexyl benzoate'], helps: { pigmentation: 0.7, wrinkles: 0.5, redness: 0.3 }, how: 'protects from UV, the main cause of spots and lines', time: 'morning' },

  // ---------- things to flag ----------
  { key: 'fragrance', aliases: ['parfum', 'fragrance', 'linalool', 'limonene', 'citral', 'geraniol', 'eugenol', 'citronellol'], helps: {}, how: 'adds scent', irritation: 0.25, flagSensitive: true },
  { key: 'denatured alcohol', aliases: ['alcohol denat', 'denatured alcohol', 'sd alcohol'], helps: {}, how: 'makes a light, quick-drying texture', irritation: 0.2, avoidSkin: ['dry', 'sensitive'] },
  { key: 'essential oils', aliases: ['lavender oil', 'lavandula', 'peppermint oil', 'mentha piperita', 'eucalyptus', 'citrus aurantium', 'bergamot'], helps: {}, how: 'adds scent', irritation: 0.3, flagSensitive: true },
  { key: 'coconut oil', aliases: ['cocos nucifera oil', 'coconut oil'], helps: { dehydration: 0.4 }, how: 'rich oil for dry skin', comedogenic: 0.6, avoidSkin: ['oily', 'combination'] },
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// whole-word matching ("aha" must not match inside "shea"; "zinc" is fine inside "zinc pca")
const MATCHERS = INGREDIENTS.map((entry) => ({ entry, rx: new RegExp(`(^|[^a-z0-9])(${entry.aliases.map(esc).join('|')})([^a-z0-9]|$)`, 'i') }));

/** "Aqua, Glycerin, Niacinamide 10%" → ['aqua', 'glycerin', 'niacinamide 10%'] */
function splitList(list = []) {
  return list
    .flatMap((x) => String(x).split(/[,;\n•·]+/))
    .map((s) => s.replace(/\(.*?\)/g, (m) => (/%/.test(m) ? m : ' ')).trim().toLowerCase())
    .filter(Boolean);
}

const pctOf = (s) => {
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*%/);
  return m ? Number(m[1].replace(',', '.')) : null;
};

/**
 * Detailed reading of an ingredient list:
 *   found:   [{ ...entry, strength 0.4–1, pct|null, position }]
 *   unknown: ingredient names we don't have in the knowledge base (shown in the admin preview)
 * Strength: full when the % is at the effective dose or the active is high in a full INCI list;
 * lower when the label % is below the effective dose or it sits at the very end of a long list.
 */
function analyzeIngredients(list = []) {
  const items = splitList(list);
  const fullInci = items.length >= 8;
  const found = new Map();
  const unknown = [];
  items.forEach((name, position) => {
    let hit = false;
    for (const { entry, rx } of MATCHERS) {
      if (!rx.test(name)) continue;
      hit = true;
      const pct = pctOf(name);
      let strength = 1;
      if (pct != null && entry.dose) strength = Math.max(0.45, Math.min(1, pct / entry.dose[1]));
      else if (fullInci && !entry.lowDose) strength = position < 6 ? 1 : position < 12 ? 0.85 : position < 20 ? 0.65 : 0.45;
      let irritation = entry.irritation ?? 0;
      if (pct != null && entry.dose && pct > entry.dose[1] * 1.5) irritation = Math.min(1, irritation + 0.2);
      const prev = found.get(entry.key);
      if (!prev || strength > prev.strength) found.set(entry.key, { ...entry, strength, pct, position, irritation });
    }
    if (!hit && !/^(aqua|water|eau)$/.test(name)) unknown.push(name);
  });
  return { found: [...found.values()].sort((a, b) => a.position - b.position), unknown, fullInci };
}

/** Which knowledge-base entries does a product's ingredient list contain? (entries, with strength/irritation) */
function matchIngredients(list = []) {
  return analyzeIngredients(list).found;
}

module.exports = { INGREDIENTS, matchIngredients, analyzeIngredients };
