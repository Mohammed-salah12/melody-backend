const { Router } = require('express');

const Scan = require('../models/Scan');
const { buildSnapshot } = require('../analysis/results');
const { buildProfile } = require('../analysis/profile');
const { weatherFor } = require('../analysis/weather');
const { HttpError } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.use(requireAuth);

async function completedScans(userId, limit = 90) {
  return Scan.find({ user: userId, status: 'complete' }).sort({ completedAt: -1 }).limit(limit).select('results completedAt');
}

/**
 * GET /skin/snapshot          — "Today's Skin Snapshot" for the latest scan
 * GET /skin/snapshot?index=1  — the scan before that (2 = the one before, …)
 * Response includes hasOlder / hasNewer so the app can show the arrows.
 */
router.get('/snapshot', async (req, res) => {
  const index = Math.max(0, Math.floor(Number(req.query.index) || 0));
  const scans = await completedScans(req.user._id);
  if (!scans.length) throw new HttpError(404, 'No scans yet — do your first skin scan to see your snapshot.');
  if (index >= scans.length) throw new HttpError(404, 'No older scans.');
  res.json({ ...buildSnapshot(scans.slice(index)), index, hasOlder: index < scans.length - 1, hasNewer: index > 0 });
});

/**
 * GET /skin/profile — the Skin Profile page: patient card (T-zone, cheeks, skin type, age,
 * today's weather for the user's address), this week's scores, glow index, analysis cards and
 * the past / current / potential risk timeline.
 */
router.get('/profile', async (req, res) => {
  const [scans, weather] = await Promise.all([completedScans(req.user._id), weatherFor(req.user.address)]);
  res.json(buildProfile(req.user, scans, weather));
});

/** GET /skin/passport — profile + full scan history (the Skin Passport). */
router.get('/passport', async (req, res) => {
  const scans = await completedScans(req.user._id, 365);
  const u = req.user;
  res.json({
    user: u.toPublic(),
    profile: { gender: u.gender, birthDate: u.birthDate, address: u.address, health: u.health },
    latest: buildSnapshot(scans),
    history: scans.map((s) => ({ id: s.id, date: s.completedAt, score: s.results.score, skinType: s.results.skinType, metrics: s.results.metrics })),
  });
});

module.exports = router;
