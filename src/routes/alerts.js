const { Router } = require('express');

const Doctor = require('../models/Doctor');
const DoctorWatch = require('../models/DoctorWatch');
const HealthLog = require('../models/HealthLog');
const { statusOf } = require('../analysis/availability');
const Scan = require('../models/Scan');
const { buildAlerts, localDate } = require('../analysis/alerts');
const { airFor, weatherFor } = require('../analysis/weather');
const { HttpError } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.use(requireAuth);

/**
 * GET /alerts?spfAt=<ISO time the user last applied sunscreen>
 * → { alerts: [...], context: { weather, air } }
 */
router.get('/', async (req, res) => {
  const [scans, weather, air] = await Promise.all([
    Scan.find({ user: req.user._id, status: 'complete' }).sort({ completedAt: -1 }).limit(11).select('results completedAt'),
    weatherFor(req.user.address),
    airFor(req.user.address),
  ]);
  const today = localDate(new Date(), weather?.utcOffsetSec ?? 0);
  const yesterday = localDate(new Date(Date.now() - 864e5), weather?.utcOffsetSec ?? 0);
  const sleepLog = await HealthLog.findOne({ user: req.user._id, date: { $in: [today, yesterday] }, sleepHours: { $ne: null } }).sort({ date: -1 });
  const alerts = buildAlerts({ scans, weather, air, sleepLog: sleepLog?.date === today ? sleepLog : null, spfAt: req.query.spfAt });
  // "Notify me when available" → an alert while the doctor is free (watch ends a day after it fired)
  const watches = await DoctorWatch.find({ user: req.user._id });
  for (const w of watches) {
    if (w.notifiedAt && Date.now() - w.notifiedAt > 864e5) {
      await w.deleteOne();
      continue;
    }
    const d = await Doctor.findOne({ _id: w.doctor, active: true });
    if (!d) continue;
    const st = await statusOf(d);
    if (st.status !== 'online') continue;
    if (!w.notifiedAt) {
      w.notifiedAt = new Date();
      await w.save();
    }
    alerts.push({
      id: `doctor:${d.id}:${w.notifiedAt.toISOString().slice(0, 10)}`,
      type: 'doctor',
      priority: 0,
      icon: 'doctor',
      overline: 'Specialist available',
      title: `${d.name} is available now`,
      text: `You asked us to tell you when ${d.name} is free. Book a ${d.consultTypes.includes('video') ? 'video' : 'chat'} consultation while a slot is open.`,
      cta: { label: 'Book an appointment', action: 'doctor', doctorId: d.id },
    });
  }
  alerts.sort((a, b) => a.priority - b.priority);
  res.json({ alerts, context: { weather, air } });
});

/** POST /alerts/sleep { hours, date?, source? } — log last night's sleep (later: from Apple Health). */
router.post('/sleep', async (req, res) => {
  const hours = Number(req.body?.hours);
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) throw new HttpError(400, 'Send { hours } between 0 and 24.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.date ?? '') ? req.body.date : localDate(new Date());
  let log = await HealthLog.findOne({ user: req.user._id, date });
  if (!log) log = new HealthLog({ user: req.user._id, date });
  log.sleepHours = hours;
  log.source = String(req.body?.source ?? 'manual').slice(0, 30);
  await log.save();
  res.status(201).json({ date, sleepHours: log.sleepHours, source: log.source });
});

module.exports = router;
