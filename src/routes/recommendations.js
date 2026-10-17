const { Router } = require('express');
const { isValidObjectId } = require('mongoose');

const Product = require('../models/Product');
const Scan = require('../models/Scan');
const { recommend } = require('../analysis/matcher');
const { getOutcomes } = require('../analysis/outcomes');
const { productMatch } = require('../analysis/insights');
const { personaliseReasons, llmEnabled } = require('../analysis/llm');
const { HttpError } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.use(requireAuth);

/**
 * GET /recommendations            → for the latest completed scan
 * GET /recommendations?scanId=…   → for a specific scan
 *   &limit=8
 *
 * Returns ranked products (with match %, reasons, the full product), a morning/evening
 * routine, the skin focus, and products left out because of allergies.
 */
router.get('/', async (req, res) => {
  const { scanId } = req.query;
  if (scanId && !isValidObjectId(scanId)) throw new HttpError(404, 'Scan not found.');
  const scan = await Scan.findOne({ user: req.user._id, status: 'complete', ...(scanId ? { _id: scanId } : {}) })
    .sort({ completedAt: -1 })
    .select('results completedAt');
  if (!scan) throw new HttpError(404, 'Do a skin scan first, then we can match products to your skin.');

  const products = await Product.find({ active: true }).lean();
  if (!products.length) throw new HttpError(404, 'The product catalogue is empty. Add products first.');

  // the scan before this one (trend) and what customers' later scans showed (evidence)
  const previous = await Scan.findOne({ user: req.user._id, status: 'complete', completedAt: { $lt: scan.completedAt } }).sort({ completedAt: -1 }).select('results.metrics');
  const rec = recommend(products, scan.results, req.user, {
    limit: Math.min(20, Number(req.query.limit) || 8),
    previous: previous?.results?.metrics ?? null,
    outcomes: await getOutcomes(),
  });
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const items = rec.products.map((r) => {
    const p = byId.get(r.productId);
    const { _id, __v, ...rest } = p;
    return { ...r, why: r.reasons.join(' '), product: { id: String(_id), ...rest, finalPrice: Product.finalPrice(p) } };
  });

  // optional: friendlier wording from an LLM (top 3 only, ranking unchanged)
  if (llmEnabled) {
    const top = items.slice(0, 3);
    const rewritten = await personaliseReasons(
      top.map((i) => ({ productId: i.productId, name: i.product.name, category: i.product.category, ingredients: i.product.ingredients, reasons: i.reasons })),
      { skinType: rec.skinType, metrics: scan.results.metrics, focus: rec.focusLabel },
    );
    if (rewritten) for (const i of top) if (typeof rewritten[i.productId] === 'string') i.why = rewritten[i.productId];
  }

  const m = scan.results.metrics;
  // be open about it when the scan itself was uncertain for the main concern
  const focusKey = rec.focus === 'dehydration' ? 'hydration' : rec.focus;
  const focusSure = scan.results.confidence?.[focusKey]?.level ?? null;
  const confidenceNote =
    focusSure === 'low' || scan.results.quality?.level === 'low'
      ? `Your last scan was less certain about ${rec.focusLabel} — scan again in daylight for a more accurate match.`
      : null;
  const focusValue = rec.focus === 'dehydration' ? Math.round(m.hydration) : Math.round(m[rec.focus] ?? 0);
  res.json({
    scanId: scan.id,
    scanDate: scan.completedAt,
    skinType: rec.skinType,
    focus: rec.focus,
    focusLabel: rec.focusLabel,
    focusValue,
    needs: rec.needs,
    items,
    routine: rec.routine,
    excluded: rec.excluded,
    worsening: rec.worsening,
    safety: rec.safety,
    scanQuality: scan.results.quality ?? null,
    focusConfidence: focusSure,
    confidenceNote,
    explainedBy: llmEnabled ? 'ai' : 'rules',
  });
});

/**
 * GET /recommendations/product/:id — how one product matches the user's latest scan:
 * { match, reasons, alignment: [{ needLabel, agent, grade }], highlights, excluded? }
 * 404 when there is no scan yet; { applicable: false } for non-face products.
 */
router.get('/product/:id', async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Product not found.');
  const [p, scan] = await Promise.all([
    Product.findById(req.params.id).lean(),
    Scan.findOne({ user: req.user._id, status: 'complete' }).sort({ completedAt: -1 }).select('results completedAt'),
  ]);
  if (!p || !p.active) throw new HttpError(404, 'Product not found.');
  if (!scan) throw new HttpError(404, 'Do a skin scan first, then we can match products to your skin.');
  const m = productMatch(p, scan.results, req.user);
  res.json(m ? { applicable: true, scanDate: scan.completedAt, ...m } : { applicable: false });
});

module.exports = router;
