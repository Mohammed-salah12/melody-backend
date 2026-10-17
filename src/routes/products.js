const { Router } = require('express');
const { isValidObjectId } = require('mongoose');

const Product = require('../models/Product');
const ProductImage = require('../models/ProductImage');
const { HttpError } = require('../lib/http');
const { productInsights } = require('../analysis/insights');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = Router();
const admin = [requireAuth, requireAdmin];

const EDITABLE = [
  'name', 'brand', 'category', 'description', 'price', 'salePercent', 'currency', 'size', 'imageUrl',
  'skinTypes', 'concerns', 'ingredients', 'routine', 'fragranceFree', 'nonComedogenic',
  'stock', 'active', 'badges', 'rating', 'reviews',
];
const pick = (body = {}) => Object.fromEntries(EDITABLE.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

async function findProduct(id, { includeInactive = false } = {}) {
  if (!isValidObjectId(id)) throw new HttpError(404, 'Product not found.');
  const p = await Product.findById(id);
  if (!p || (!includeInactive && !p.active)) throw new HttpError(404, 'Product not found.');
  return p;
}

function validationError(e) {
  if (e.name === 'ValidationError') {
    const first = Object.values(e.errors)[0];
    return new HttpError(400, first?.message?.replace(/^Path /, '') ?? 'Invalid product.');
  }
  return e;
}

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : null);

/**
 * GET /products — public catalogue with search, filters, sorting and pages.
 *   ?q=serum&category=serum,moisturizer&group=face,body&skinType=dry&concern=acne,redness&brand=…
 *   &minPrice=&maxPrice=&inStock=true&onSale=true&sort=price|-price|rating|-rating|newest|name&page=1&limit=20
 * Admins can add &includeInactive=true.
 */
router.get('/', async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.q) {
    // case-insensitive "contains" search on name, brand, description and ingredients
    const rx = new RegExp(String(q.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$and = [{ $or: [{ name: rx }, { brand: rx }, { description: rx }, { ingredients: rx }] }];
  }
  const cats = [...(list(q.category) ?? []), ...(list(q.group) ?? []).flatMap((g) => Product.GROUPS[g] ?? [])];
  if (cats.length) filter.category = { $in: cats };
  if (list(q.brand)) filter.brand = { $in: list(q.brand) };
  if (list(q.skinType)) filter.$or = [{ skinTypes: { $in: list(q.skinType) } }, { skinTypes: { $size: 0 } }];
  // problems from the filter screen: acne also matches products made for pores / oil, dryness for the barrier
  const EXPAND = { acne: ['acne', 'pores', 'oil'], dryness: ['dehydration', 'barrier'], dehydration: ['dehydration', 'barrier'] };
  if (list(q.concern)) filter.concerns = { $in: [...new Set(list(q.concern).flatMap((c) => EXPAND[c] ?? [c]))] };
  if (q.onSale === 'true') {
    filter.$and = [...(filter.$and ?? []), { $or: [{ salePercent: { $gt: 0 } }, { badges: { $regex: /%\s*off/i } }] }];
  }
  if (q.minPrice || q.maxPrice) filter.price = { ...(q.minPrice && { $gte: Number(q.minPrice) }), ...(q.maxPrice && { $lte: Number(q.maxPrice) }) };
  if (q.inStock === 'true') filter.stock = { $gt: 0 };
  if (q.includeInactive !== 'true') filter.active = true;

  const SORTS = { price: { price: 1 }, '-price': { price: -1 }, rating: { rating: 1 }, '-rating': { rating: -1 }, newest: { createdAt: -1 }, name: { name: 1 } };
  const sort = SORTS[q.sort] ?? { createdAt: -1 };
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
  const page = Math.max(1, Number(q.page) || 1);

  const [items, total] = await Promise.all([
    Product.find(filter).sort(sort).skip((page - 1) * limit).limit(limit),
    Product.countDocuments(filter),
  ]);
  res.json({ items: items.map((p) => p.toPublic()), total, page, pages: Math.ceil(total / limit) });
});

/** GET /products/meta — allowed values for forms and filters. */
router.get('/meta', (_req, res) => {
  res.json({ categories: Product.CATEGORIES, groups: Product.GROUPS, skinTypes: Product.SKIN_TYPES, concerns: Product.CONCERNS, routine: ['morning', 'evening', 'both'] });
});

/** GET /products/:id */
router.get('/:id', async (req, res) => {
  const p = await findProduct(req.params.id);
  res.json({ ...p.toPublic(), insights: productInsights(p.toObject()) });
});

/** GET /products/:id/image — the uploaded photo. */
router.get('/:id/image', async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'No image.');
  const img = await ProductImage.findOne({ product: req.params.id });
  if (!img) throw new HttpError(404, 'No image.');
  res.set('Cache-Control', 'public, max-age=3600').type(img.contentType).send(img.data);
});

/* ---------- admin ---------- */

const LABELS = { dehydration: 'Hydration', oil: 'Oil control', redness: 'Redness', pigmentation: 'Dark spots', texture: 'Texture', pores: 'Pores', wrinkles: 'Fine lines', barrier: 'Skin barrier' };

/**
 * POST /products/analyze — what the matcher will understand about a product (admin preview while
 * adding / editing): recognised actives, unknown ingredients, what it treats, safety notes and
 * suggested tags. Body: { ingredients: "Aqua, Glycerin, Niacinamide 10%, …" | [...], concerns, skinTypes, category, routine, fragranceFree, id? }
 */
router.post('/analyze', admin, async (req, res) => {
  const { analyzeIngredients } = require('../analysis/ingredients');
  const { productVector } = require('../analysis/matcher');
  const { getOutcomes, MIN_USERS } = require('../analysis/outcomes');
  const b = req.body ?? {};
  const list = Array.isArray(b.ingredients) ? b.ingredients : String(b.ingredients ?? '').split(',');
  const { found, unknown, fullInci } = analyzeIngredients(list);
  const concerns = Array.isArray(b.concerns) ? b.concerns : [];
  const vec = productVector({ ingredients: list, concerns });
  const treats = Object.entries(vec)
    .filter(([, v]) => v >= 0.3)
    .sort((a, b2) => b2[1] - a[1])
    .map(([k, v]) => ({ concern: k, label: LABELS[k], strength: Math.round(v * 100) }));

  const notes = [];
  if (!found.length && !concerns.length) notes.push({ level: 'error', text: 'No known actives found and no concerns ticked — this product will only match weakly. Add its ingredient list or tick what it treats.' });
  else if (!found.length) notes.push({ level: 'warn', text: 'No known actives found — matching relies only on the ticked concerns.' });
  for (const i of found) {
    if (i.pregnancy === 'avoid') notes.push({ level: 'warn', text: `${i.key}: hidden from pregnant / breastfeeding users.` });
    if (i.pregnancy === 'caution') notes.push({ level: 'info', text: `${i.key}: pregnant users see a “ask your doctor” warning.` });
    if (i.group === 'exfoliant' || i.group === 'retinoid') notes.push({ level: 'info', text: `${i.key}: hidden from users taking isotretinoin / prescription retinoids.` });
    if (i.medicalOnly) notes.push({ level: 'warn', text: `${i.key}: should only be sold / used with medical advice.` });
    if (i.irritation >= 0.4) notes.push({ level: 'info', text: `${i.key}${i.pct ? ` ${i.pct}%` : ''}: can irritate — ranked lower for sensitive skin.` });
    if (i.pct != null && i.dose && i.pct < i.dose[0]) notes.push({ level: 'info', text: `${i.key} ${i.pct}% is below the usual effective dose (${i.dose[0]}–${i.dose[1]}%).` });
    if (i.time && b.routine && b.routine !== 'both' && b.routine !== i.time) notes.push({ level: 'warn', text: `${i.key} is a ${i.time} ingredient but the product is set to ${b.routine}.` });
  }
  const scented = found.some((i) => i.flagSensitive);
  if (scented && b.fragranceFree) notes.push({ level: 'warn', text: 'Marked fragrance-free, but the list contains fragrance / essential oils.' });

  const suggest = {
    concerns: treats.filter((t) => t.strength >= 60 && !concerns.includes(t.concern)).map((t) => t.concern),
    routine: found.some((i) => i.time === 'evening') ? 'evening' : found.some((i) => i.time === 'morning') ? 'morning' : null,
    fragranceFree: fullInci ? !scented : null,
  };
  let evidence = null;
  if (b.id && isValidObjectId(b.id)) {
    const ev = (await getOutcomes()).get(String(b.id));
    evidence = ev ? { customers: ev.n, effect: ev.effect } : { customers: 0, needed: MIN_USERS };
  }
  res.json({
    actives: found.map((i) => ({ key: i.key, how: i.how, pct: i.pct, strength: Math.round(i.strength * 100), helps: i.helps, time: i.time ?? null })),
    unknown: unknown.slice(0, 60),
    fullInci,
    treats,
    notes,
    suggest,
    evidence,
  });
});

/** POST /products — create. */
router.post('/', admin, async (req, res) => {
  try {
    const p = await Product.create(pick(req.body));
    res.status(201).json(p.toPublic());
  } catch (e) {
    throw validationError(e);
  }
});

/** POST /products/bulk — create many at once: { products: [...] }. */
router.post('/bulk', admin, async (req, res) => {
  const items = req.body?.products;
  if (!Array.isArray(items) || !items.length || items.length > 500) throw new HttpError(400, 'Send { products: [...] } with 1–500 items.');
  const created = [];
  const failed = [];
  for (const [i, raw] of items.entries()) {
    try {
      created.push((await Product.create(pick(raw))).toPublic());
    } catch (e) {
      failed.push({ index: i, name: raw?.name, error: validationError(e).message });
    }
  }
  res.status(201).json({ created: created.length, failed, items: created });
});

/** PUT /products/:id — replace all editable fields. PATCH — change only what you send. */
async function update(req, res, replace) {
  const p = await findProduct(req.params.id, { includeInactive: true });
  const fields = pick(req.body);
  if (replace) {
    for (const k of EDITABLE) if (!(k in fields) && !['name', 'brand', 'category', 'price'].includes(k)) p.set(k, undefined);
  }
  p.set(fields);
  try {
    await p.save();
  } catch (e) {
    throw validationError(e);
  }
  res.json(p.toPublic());
}
router.put('/:id', admin, (req, res) => update(req, res, true));
router.patch('/:id', admin, (req, res) => update(req, res, false));

/** PATCH /products/:id/stock { change: -2 } or { stock: 10 } */
router.patch('/:id/stock', admin, async (req, res) => {
  const p = await findProduct(req.params.id, { includeInactive: true });
  if (typeof req.body?.stock === 'number') p.stock = Math.max(0, req.body.stock);
  else if (typeof req.body?.change === 'number') p.stock = Math.max(0, p.stock + req.body.change);
  else throw new HttpError(400, 'Send { stock } or { change }.');
  await p.save();
  res.json(p.toPublic());
});

/** DELETE /products/:id — hide it (soft delete). Add ?hard=true to remove it completely. */
router.delete('/:id', admin, async (req, res) => {
  const p = await findProduct(req.params.id, { includeInactive: true });
  if (req.query.hard === 'true') {
    await ProductImage.deleteOne({ product: p._id });
    await p.deleteOne();
    return res.json({ deleted: true, id: p.id });
  }
  p.active = false;
  await p.save();
  res.json({ deleted: false, hidden: true, id: p.id });
});

/** PUT /products/:id/image { image: <base64>, contentType? } — upload / replace the photo (max ~3 MB). */
router.put('/:id/image', admin, async (req, res) => {
  const p = await findProduct(req.params.id, { includeInactive: true });
  const raw = String(req.body?.image ?? '');
  const m = raw.match(/^data:(image\/(?:jpeg|png|webp));base64,/);
  const contentType = m?.[1] ?? req.body?.contentType ?? 'image/jpeg';
  const data = Buffer.from(raw.replace(/^data:[^,]+,/, ''), 'base64');
  if (data.length < 100) throw new HttpError(400, 'Please send an image (base64).');
  if (data.length > 3 * 1024 * 1024) throw new HttpError(413, 'Image must be under 3 MB.');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) throw new HttpError(400, 'Use JPEG, PNG or WebP.');
  await ProductImage.deleteOne({ product: p._id });
  await ProductImage.create({ product: p._id, contentType, data });
  p.hasImage = true;
  await p.save();
  res.json(p.toPublic());
});

/** DELETE /products/:id/image */
router.delete('/:id/image', admin, async (req, res) => {
  const p = await findProduct(req.params.id, { includeInactive: true });
  await ProductImage.deleteOne({ product: p._id });
  p.hasImage = false;
  await p.save();
  res.json(p.toPublic());
});

module.exports = router;
