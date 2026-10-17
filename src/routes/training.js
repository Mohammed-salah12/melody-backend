/**
 * Doctor grading of consented scan photos → labels for training the skin model (admin only).
 *   GET  /training/stats            how many photos, graded, per skin tone
 *   GET  /training/next             the next photo I haven't graded (fewest grades first)
 *   GET  /training/:id/image        the photo (JPEG)
 *   POST /training/:id/grade        { hydration…wrinkles: 1–5, fitzpatrick: 1–6 } | { unusable: true }
 */
const { Router } = require('express');
const { isValidObjectId } = require('mongoose');

const TrainingSample = require('../models/TrainingSample');
const { LABEL_KEYS } = require('../models/TrainingSample');
const { HttpError } = require('../lib/http');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/stats', async (_req, res) => {
  const all = await TrainingSample.find().select('grades unusable').lean();
  const graded = all.filter((s) => s.grades.length);
  const tones = {};
  for (const s of graded) {
    const ft = s.grades.find((g) => g.fitzpatrick)?.fitzpatrick;
    if (ft) tones[ft] = (tones[ft] ?? 0) + 1;
  }
  res.json({
    photos: all.length,
    graded: graded.length,
    gradedTwice: graded.filter((s) => s.grades.length >= 2).length,
    unusable: all.filter((s) => s.unusable).length,
    perSkinTone: tones,
    target: { minimum: 300, good: 2000 },
  });
});

router.get('/next', async (req, res) => {
  const me = req.user._id;
  const skip = String(req.query.skip ?? '').split(',').filter(isValidObjectId);
  const sample = await TrainingSample.findOne({ 'grades.by': { $ne: me }, unusable: { $lt: 2 }, ...(skip.length ? { _id: { $nin: skip } } : {}) })
    .sort({ gradeCount: 1, createdAt: 1 })
    .select('ruleMetrics grades createdAt')
    .lean();
  if (!sample) return res.json({ done: true });
  res.json({ id: String(sample._id), ruleMetrics: sample.ruleMetrics, grades: sample.grades.length, createdAt: sample.createdAt, labels: LABEL_KEYS });
});

router.get('/:id/image', async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Not found.');
  const s = await TrainingSample.findById(req.params.id).select('+image');
  if (!s) throw new HttpError(404, 'Not found.');
  res.set('Cache-Control', 'private, no-store').type('jpeg').send(s.image);
});

router.post('/:id/grade', async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Not found.');
  const s = await TrainingSample.findById(req.params.id);
  if (!s) throw new HttpError(404, 'Not found.');
  if (req.body?.unusable) {
    s.unusable += 1;
    await s.save();
    return res.json({ ok: true });
  }
  const g = { by: req.user._id, at: new Date() };
  for (const k of LABEL_KEYS) {
    const v = Math.round(Number(req.body?.[k]));
    if (!(v >= 1 && v <= 5)) throw new HttpError(400, `Please grade ${k} from 1 to 5.`);
    g[k] = v;
  }
  const ft = Math.round(Number(req.body?.fitzpatrick));
  if (!(ft >= 1 && ft <= 6)) throw new HttpError(400, 'Please choose the skin tone (I–VI).');
  g.fitzpatrick = ft;
  s.grades = s.grades.filter((x) => String(x.by) !== String(req.user._id)).concat(g);
  s.gradeCount = s.grades.length;
  await s.save();
  res.json({ ok: true, grades: s.grades.length });
});

module.exports = router;
