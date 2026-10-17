const { Router } = require('express');
const { isValidObjectId } = require('mongoose');

const Scan = require('../models/Scan');
const { analyzeFrame } = require('../analysis/skin-analyzer');
const { buildResults, METRICS } = require('../analysis/results');
const { median } = require('../analysis/image');
const { HttpError } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const TrainingSample = require('../models/TrainingSample');
const { refineWithModel } = require('../analysis/skin-model');

const router = Router();
router.use(requireAuth);

/**
 * Guided capture (Face-ID style): look straight, turn one way, turn the other way, tilt up.
 * The server decides the current step and checks the head actually moved; if the pose check
 * keeps missing on good-quality frames it accepts anyway so nobody gets stuck.
 */
const PLAN = [
  { step: 'front', frames: 4 },
  { step: 'side1', frames: 2 },
  { step: 'side2', frames: 2 },
  { step: 'up', frames: 2 },
];
const STORE_REJECTED_UP_TO = 40; // keep a few rejected frames for debugging, never fail on volume
const FALLBACK_AFTER = 5; // good frames that missed the pose before we accept anyway
const TURN = 0.05; // feature shift that counts as a head turn
const TILT = 0.035; // feature shift that counts as a tilt up

async function ownScan(req, extraSelect = '') {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Scan not found.');
  const scan = await Scan.findOne({ _id: req.params.id, user: req.user._id }).select(extraSelect);
  if (!scan) throw new HttpError(404, 'Scan not found.');
  return scan;
}

function progressOf(scan) {
  const steps = PLAN.map((p) => ({
    step: p.step,
    needed: p.frames,
    have: Math.min(p.frames, scan.frames.filter((f) => f.accepted && f.step === p.step).length),
  }));
  const total = PLAN.reduce((s, p) => s + p.frames, 0);
  const have = steps.reduce((s, c) => s + c.have, 0);
  const current = steps.find((c) => c.have < c.needed);
  return { steps, percent: Math.round((have / total) * 100), step: current?.step ?? null, ready: !current };
}

function baseline(scan) {
  const front = scan.frames.filter((f) => f.accepted && f.step === 'front' && f.headPose?.yaw != null);
  if (!front.length) return null;
  return { yaw: median(front.map((f) => f.headPose.yaw)), pitch: median(front.map((f) => f.headPose.pitch)) };
}

/** Did the head do what this step asks? Returns { ok, tip, sign }. */
function checkPose(step, pose, base, side1Sign) {
  if (step === 'front' || !base) return { ok: true };
  if (!pose) return { ok: false, tip: null };
  const dy = pose.yaw - base.yaw;
  if (step === 'side1') {
    return Math.abs(dy) > TURN ? { ok: true, sign: Math.sign(dy) } : { ok: false, tip: 'Turn your head a little more.' };
  }
  if (step === 'side2') {
    if (Math.abs(dy) > TURN && Math.sign(dy) !== side1Sign) return { ok: true, sign: Math.sign(dy) };
    return { ok: false, tip: Math.sign(dy) === side1Sign && Math.abs(dy) > TURN ? 'Now turn to the other side.' : 'Turn your head a little more.' };
  }
  if (step === 'up') {
    return base.pitch - pose.pitch > TILT ? { ok: true } : { ok: false, tip: 'Tilt your chin up a little more.' };
  }
  return { ok: true };
}

function running(scan) {
  const used = scan.frames.filter((f) => f.accepted && f.metrics);
  if (!used.length) return null;
  const out = {};
  for (const k of METRICS) out[k] = Math.round((used.reduce((s, f) => s + (f.metrics[k] ?? 0), 0) / used.length) * 10) / 10;
  return out;
}

/** POST /scans — start a scan session. */
router.post('/', async (req, res) => {
  await Scan.updateMany({ user: req.user._id, status: 'in_progress' }, { status: 'abandoned' });
  const scan = await Scan.create({ user: req.user._id });
  res.status(201).json({ scanId: scan._id.toString(), plan: PLAN });
});

/** POST /scans/:id/frames { image: <base64 JPEG> } — analyse one camera snapshot. */
router.post('/:id/frames', async (req, res) => {
  const scan = await ownScan(req, '+lastSignature +thumbnail +thumbnailArea +faceCrop +faceCropArea');
  if (scan.status !== 'in_progress') throw new HttpError(409, 'This scan is already finished.');

  const before = progressOf(scan);
  if (before.ready) return res.json({ accepted: false, tip: null, quality: null, metrics: null, running: running(scan), progress: before });
  const step = before.step;

  const { image } = req.body ?? {};
  if (typeof image !== 'string' || image.length < 100) throw new HttpError(400, 'Please send a JPEG image (base64).');
  const buffer = Buffer.from(image.replace(/^data:image\/\w+;base64,/, ''), 'base64');

  let result;
  try {
    result = analyzeFrame(buffer, { previousSignature: scan.lastSignature });
  } catch {
    throw new HttpError(400, 'We could not read that image.');
  }
  if (result.signature) scan.lastSignature = result.signature;

  let accepted = result.accepted && result.quality.still;
  let tip = result.tip;
  // blur / side shadow: insist for a while, then accept (with a lower photo-quality score) so nobody gets stuck
  if (!result.accepted && result.framingOk && result.quality.still) {
    const tries = (scan.stepAttempts.get('photo') ?? 0) + 1;
    scan.stepAttempts.set('photo', tries);
    if (tries >= 8) accepted = true;
  }
  // pores need a closer, sharper photo of the cheeks than the other measurements
  if (!tip && step === 'front' && result.quality?.faceFound && result.pores && !result.pores.measured) {
    tip = 'Bring the phone a little closer so we can count your pores.';
  }
  let turned = null;
  if (accepted) {
    const check = checkPose(step, result.pose, baseline(scan), scan.side1Sign);
    if (!check.ok) {
      const tries = (scan.stepAttempts.get(step) ?? 0) + 1;
      scan.stepAttempts.set(step, tries);
      if (tries < FALLBACK_AFTER) {
        accepted = false;
        tip = check.tip;
      }
    }
    if (accepted && step === 'side1') scan.side1Sign = check.sign || 1;
    // the preview is mirrored, so features moving to the image's right look like a turn to the left
    if (accepted && (step === 'side1' || step === 'side2')) {
      const sign = check.sign || (step === 'side1' ? scan.side1Sign : -scan.side1Sign) || 1;
      turned = sign > 0 ? 'left' : 'right';
    }
  }

  if (accepted || scan.frames.length < STORE_REJECTED_UP_TO) {
    scan.frames.push({
      step,
      accepted,
      quality: result.quality,
      metrics: result.metrics,
      zones: result.zones,
      headPose: result.pose ?? undefined,
      poreStats: result.pores?.measured ? result.pores : undefined,
    });
  }
  if (accepted && step === 'front' && result.faceArea > (scan.thumbnailArea ?? 0)) {
    scan.thumbnail = result.thumbnail();
    scan.thumbnailArea = result.faceArea;
  }
  // best front crop for the trained skin model / training set — removed when the scan completes
  if (accepted && step === 'front' && result.faceCrop && result.faceArea > (scan.faceCropArea ?? 0)) {
    scan.faceCrop = result.faceCrop();
    scan.faceCropArea = result.faceArea;
  }
  await scan.save();

  res.json({
    accepted,
    step,
    turned,
    tip,
    quality: result.quality,
    metrics: result.metrics ?? null,
    pores: result.pores?.measured ? { perCm2: result.pores.perCm2, count: result.pores.count } : null,
    running: running(scan),
    progress: progressOf(scan),
  });
});

/** POST /scans/:id/complete — combine the frames into results (Skin Passport entry). */
router.post('/:id/complete', async (req, res) => {
  const scan = await ownScan(req, '+faceCrop');
  if (scan.status === 'complete') return res.json({ scanId: scan.id, results: scan.results });
  if (scan.frames.filter((f) => f.metrics).length < 2) {
    throw new HttpError(422, 'We couldn’t get a clear look at your skin. Please try again in good light.');
  }
  const ruleResults = buildResults(scan.frames);
  let results = ruleResults;
  if (scan.faceCrop) {
    // trained skin model (when one is installed) refines the rule-based numbers
    const refined = await refineWithModel(scan.faceCrop, ruleResults.metrics);
    if (refined) results = { ...buildResults(scan.frames, refined.metrics), model: refined.model };
    // with the user's consent, keep the photo for training (graded later by a doctor)
    if (req.user.trainingConsent?.granted) {
      await TrainingSample.create({ user: req.user._id, scan: scan._id, image: scan.faceCrop, ruleMetrics: ruleResults.metrics }).catch(() => {});
    }
  }
  scan.results = results;
  scan.status = 'complete';
  scan.completedAt = new Date();
  scan.faceCrop = undefined;
  scan.faceCropArea = undefined;
  await scan.save();
  res.json({ scanId: scan.id, results: scan.results });
});

/** GET /scans — history, newest first. */
router.get('/', async (req, res) => {
  const scans = await Scan.find({ user: req.user._id, status: 'complete' })
    .sort({ completedAt: -1 })
    .limit(Math.min(100, Number(req.query.limit) || 30))
    .select('results completedAt');
  res.json({ scans: scans.map((s) => ({ id: s.id, completedAt: s.completedAt, results: s.results })) });
});

/* ---------- progress: before / after ---------- */

const PROGRESS_KEYS = [
  ['hydration', 'Hydration', true],
  ['redness', 'Redness', false],
  ['pigmentation', 'Dark spots', false],
  ['oil', 'Oil & shine', false],
  ['texture', 'Texture', false],
  ['pores', 'Pores', false],
  ['wrinkles', 'Fine lines', false],
  ['evenness', 'Even tone', true],
];
const DEFAULT_MARGIN = 7; // scans made before confidence was stored

function summary(s, withPhoto) {
  return {
    id: s.id,
    date: s.completedAt,
    score: s.results.score,
    metrics: s.results.metrics,
    quality: s.results.quality ?? null,
    ...(withPhoto ? { photo: s.thumbnail ? `data:image/jpeg;base64,${s.thumbnail}` : null } : {}),
  };
}

/**
 * GET /scans/progress?from=<scanId>&to=<scanId>
 * Before/after between two scans (default: first and latest of the last year), the series for the
 * trend chart, and per measurement whether the change is bigger than the scan's own uncertainty
 * ("real change") or within normal day-to-day variation.
 */
router.get('/progress', async (req, res) => {
  const since = new Date(Date.now() - 365 * 864e5);
  const scans = await Scan.find({ user: req.user._id, status: 'complete', completedAt: { $gte: since } })
    .sort({ completedAt: 1 })
    .select('results completedAt')
    .limit(200);
  if (scans.length < 2) return res.json({ count: scans.length, ready: false, series: scans.map((s) => summary(s, false)) });

  const pick = (id, fallback) => (id && isValidObjectId(id) && scans.find((s) => s.id === id)) || fallback;
  let from = pick(req.query.from, scans[0]);
  let to = pick(req.query.to, scans[scans.length - 1]);
  if (from.completedAt > to.completedAt) [from, to] = [to, from];
  const photos = await Scan.find({ _id: { $in: [from._id, to._id] } }).select('+thumbnail');
  const photoOf = new Map(photos.map((p) => [p.id, p]));
  const days = Math.max(0, Math.round((to.completedAt - from.completedAt) / 864e5));

  const changes = PROGRESS_KEYS.map(([key, label, higherIsBetter]) => {
    const a = from.results.metrics?.[key];
    const b = to.results.metrics?.[key];
    if (a == null || b == null) return null;
    const ma = from.results.confidence?.[key]?.margin ?? DEFAULT_MARGIN;
    const mb = to.results.confidence?.[key]?.margin ?? DEFAULT_MARGIN;
    const noise = Math.sqrt(ma * ma + mb * mb) * 0.75; // a change smaller than this could just be the camera
    const delta = Math.round((b - a) * 10) / 10;
    const improvement = higherIsBetter ? delta : -delta; // > 0 = better
    const pct = a > 0 ? Math.round((Math.abs(delta) / a) * 100) : 0;
    const real = Math.abs(delta) >= noise && Math.abs(delta) >= 3;
    return { key, label, from: Math.round(a), to: Math.round(b), delta, pct, better: improvement > 0, real, trend: !real ? 'same' : improvement > 0 ? 'better' : 'worse' };
  }).filter(Boolean);

  const best = changes.filter((c) => c.real && c.better).sort((x, y) => y.pct - x.pct)[0];
  const weeks = Math.max(1, Math.round(days / 7));
  const headline = best
    ? { key: best.key, text: `Your ${best.label.toLowerCase()} ${best.key === 'hydration' || best.key === 'evenness' ? 'improved' : 'dropped'} ${best.pct}% in ${days < 14 ? `${days} days` : `${weeks} weeks`}.` }
    : { key: null, text: days < 10 ? 'Too early to tell — skin changes show after 2–4 weeks.' : 'Your skin is holding steady.' };
  const poor = [from, to].some((s) => s.results.quality?.level === 'low');
  const warm = [from, to].some((s) => s.results.quality?.warmLight);

  res.json({
    count: scans.length,
    ready: true,
    days,
    from: summary(photoOf.get(from.id) ?? from, true),
    to: summary(photoOf.get(to.id) ?? to, true),
    scoreChange: to.results.score - from.results.score,
    headline,
    changes,
    comparable: !poor,
    comparisonNote: poor
      ? 'One of these scans had poor photo quality, so the comparison is less certain.'
      : warm
        ? 'One scan was taken in warm indoor light — compare scans taken in similar light.'
        : 'Changes smaller than the camera’s normal variation are shown as “steady”.',
    series: scans.map((s) => summary(s, false)),
  });
});

/** GET /scans/:id */
router.get('/:id', async (req, res) => {
  const s = await ownScan(req);
  res.json({ id: s.id, status: s.status, completedAt: s.completedAt, results: s.results, progress: progressOf(s) });
});

/** GET /scans/:id/photo — the saved face photo (JPEG). */
router.get('/:id/photo', async (req, res) => {
  const s = await ownScan(req, '+thumbnail');
  if (!s.thumbnail) throw new HttpError(404, 'No photo for this scan.');
  res.type('jpeg').send(Buffer.from(s.thumbnail, 'base64'));
});

module.exports = router;
