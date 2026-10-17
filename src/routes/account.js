/** Saved shipping addresses and (display-only) saved cards of the logged-in user. */
const { Router } = require('express');

const { HttpError } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.use(requireAuth);

const FIELDS = ['fullName', 'street', 'suite', 'city', 'state', 'zip', 'country', 'phone'];

function cleanAddress(body = {}) {
  const a = {};
  for (const k of FIELDS) if (body[k] !== undefined) a[k] = String(body[k]).trim();
  for (const k of ['fullName', 'street', 'city']) if (!a[k]) throw new HttpError(400, `Please enter the ${k === 'fullName' ? 'full name' : k === 'street' ? 'street address' : 'city'}.`);
  if (a.phone && !/^\+?[\d\s()-]{6,20}$/.test(a.phone)) throw new HttpError(400, 'Please enter a valid phone number.');
  return a;
}

const publicAddress = (a) => ({ id: a.id, ...Object.fromEntries(FIELDS.map((k) => [k, a[k] ?? ''])), isDefault: !!a.isDefault });

function setDefault(user, id) {
  for (const a of user.addresses) a.isDefault = a.id === id;
}

/** GET /account/addresses */
/**
 * PUT /account/training-consent { granted: true|false } — opt in / out of sharing scan photos to
 * train the skin model. Opting out deletes every photo already shared.
 */
router.put('/training-consent', async (req, res) => {
  const granted = !!req.body?.granted;
  req.user.trainingConsent = { granted, at: new Date() };
  await req.user.save();
  let deleted = 0;
  if (!granted) deleted = (await require('../models/TrainingSample').deleteMany({ user: req.user._id })).deletedCount ?? 0;
  res.json({ granted, deleted });
});

router.get('/training-consent', async (req, res) => {
  const count = await require('../models/TrainingSample').countDocuments({ user: req.user._id });
  res.json({ granted: !!req.user.trainingConsent?.granted, at: req.user.trainingConsent?.at ?? null, sharedPhotos: count });
});

router.get('/addresses', (req, res) => {
  res.json({ items: req.user.addresses.map(publicAddress) });
});

/** POST /account/addresses { fullName, street, suite?, city, state?, zip?, country?, phone?, isDefault? } */
router.post('/addresses', async (req, res) => {
  const user = req.user;
  if (user.addresses.length >= 10) throw new HttpError(400, 'You can save up to 10 addresses.');
  user.addresses.push(cleanAddress(req.body));
  const added = user.addresses[user.addresses.length - 1];
  if (req.body?.isDefault || user.addresses.length === 1) setDefault(user, added.id);
  await user.save();
  res.status(201).json(publicAddress(added));
});

/** PUT /account/addresses/:id */
router.put('/addresses/:id', async (req, res) => {
  const a = req.user.addresses.id(req.params.id);
  if (!a) throw new HttpError(404, 'Address not found.');
  Object.assign(a, cleanAddress({ ...publicAddress(a), ...req.body }));
  if (req.body?.isDefault) setDefault(req.user, a.id);
  await req.user.save();
  res.json(publicAddress(a));
});

/** DELETE /account/addresses/:id */
router.delete('/addresses/:id', async (req, res) => {
  const a = req.user.addresses.id(req.params.id);
  if (!a) throw new HttpError(404, 'Address not found.');
  const wasDefault = a.isDefault;
  a.deleteOne();
  if (wasDefault && req.user.addresses[0]) req.user.addresses[0].isDefault = true;
  await req.user.save();
  res.json({ deleted: true });
});

/** GET /account/cards — saved cards (brand, last 4, expiry only). */
router.get('/cards', (req, res) => {
  res.json({ items: req.user.cards.map((c) => ({ id: c.id, brand: c.brand, last4: c.last4, expMonth: c.expMonth, expYear: c.expYear, holder: c.holder })) });
});

/** DELETE /account/cards/:id */
router.delete('/cards/:id', async (req, res) => {
  const c = req.user.cards.id(req.params.id);
  if (!c) throw new HttpError(404, 'Card not found.');
  c.deleteOne();
  await req.user.save();
  res.json({ deleted: true });
});

module.exports = router;
module.exports.cleanAddress = cleanAddress;
