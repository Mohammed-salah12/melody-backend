const { Router } = require('express');
const { isValidObjectId } = require('mongoose');

const config = require('../config');
const Doctor = require('../models/Doctor');
const DoctorImage = require('../models/DoctorImage');
const DoctorWatch = require('../models/DoctorWatch');
const DoctorReview = require('../models/DoctorReview');
const Appointment = require('../models/Appointment');
const { slotsForDay, nextFreeSlot, statusOf, bookedFor, addDays } = require('../analysis/availability');
const { clinicDay } = require('../lib/clinic-time');
const { HttpError } = require('../lib/http');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = Router();
const admin = [requireAuth, requireAdmin];
const EDITABLE = ['name', 'title', 'bio', 'about', 'expertise', 'yearsExperience', 'specialties', 'consultTypes', 'imageUrl', 'workDays', 'startHour', 'endHour', 'breakUntil', 'fastTrack', 'active'];
const pick = (b = {}) => Object.fromEntries(EDITABLE.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

async function findDoctor(id, includeInactive = false) {
  if (!isValidObjectId(id)) throw new HttpError(404, 'Doctor not found.');
  const d = await Doctor.findById(id);
  if (!d || (!includeInactive && !d.active)) throw new HttpError(404, 'Doctor not found.');
  return d;
}

function invalid(e) {
  if (e.name === 'ValidationError') return new HttpError(400, Object.values(e.errors)[0]?.message?.replace(/^Path /, '') ?? 'Invalid doctor.');
  return e;
}

async function withStatus(doctors, now = new Date()) {
  const booked = await bookedFor(doctors.map((d) => d._id), now, new Date(now.getTime() + 1));
  return Promise.all(
    doctors.map(async (d) => {
      const st = await statusOf(d, now, booked);
      // "Fast-track": a free slot later today
      const next = st.status === 'online' || st.status === 'soon' ? await nextFreeSlot(d, now, 1) : null;
      return { ...d.toPublic(), availability: { ...st, fastTrack: !!next, nextSlot: next?.start ?? null } };
    }),
  );
}

/** GET /doctors/meta — specialties, clinic time zone, slot length. */
router.get('/meta', (_req, res) => {
  res.json({ specialties: Doctor.SPECIALTIES, timezone: config.clinic.timezone, timezoneLabel: config.clinic.timezoneLabel, slotMinutes: config.clinic.slotMinutes, bookingDaysAhead: config.clinic.bookingDaysAhead });
});

/** GET /doctors?q=&specialty=acne,eczema&type=video|chat&availableNow=true&includeInactive=true */
router.get('/', async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.includeInactive !== 'true') filter.active = true;
  if (q.q) filter.$or = ['name', 'bio', 'title'].map((k) => ({ [k]: new RegExp(String(q.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }));
  if (list(q.specialty).length) filter.specialties = { $in: list(q.specialty) };
  if (list(q.type).length) filter.consultTypes = { $in: list(q.type) };
  let items = await withStatus(await Doctor.find(filter).sort({ rating: -1, name: 1 }).limit(100));
  if (q.availableNow === 'true') items = items.filter((d) => d.availability.status === 'online');
  const order = { online: 0, soon: 1, busy: 2, break: 3, offline: 4 };
  items.sort((a, b) => order[a.availability.status] - order[b.availability.status]);
  res.json({ items, total: items.length });
});

/** GET /doctors/:id */
router.get('/:id', async (req, res) => {
  const [d] = await withStatus([await findDoctor(req.params.id)]);
  res.json(d);
});

/** GET /doctors/:id/image */
router.get('/:id/image', async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'No image.');
  const img = await DoctorImage.findOne({ doctor: req.params.id });
  if (!img) throw new HttpError(404, 'No image.');
  res.set('Cache-Control', 'public, max-age=3600').type(img.contentType).send(img.data);
});

/**
 * GET /doctors/:id/slots?date=YYYY-MM-DD (clinic day) → { date, slots: [{ start, end, time, available, reason }] }
 * Without date: today. Also returns which days in the next weeks have free slots (for the calendar).
 */
router.get('/:id/slots', async (req, res) => {
  const d = await findDoctor(req.params.id);
  const today = clinicDay(new Date());
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? '') ? req.query.date : today;
  const last = addDays(today, config.clinic.bookingDaysAhead);
  if (date < today || date > last) return res.json({ date, slots: [], bookable: false });
  res.json({ date, slots: await slotsForDay(d, date), bookable: true, timezoneLabel: config.clinic.timezoneLabel, slotMinutes: config.clinic.slotMinutes });
});

/** POST /doctors/:id/watch — "Notify me when available" (DELETE to stop). */
router.post('/:id/watch', requireAuth, async (req, res) => {
  const d = await findDoctor(req.params.id);
  await DoctorWatch.deleteOne({ user: req.user._id, doctor: d._id });
  await DoctorWatch.create({ user: req.user._id, doctor: d._id });
  res.status(201).json({ watching: true });
});
router.delete('/:id/watch', requireAuth, async (req, res) => {
  await DoctorWatch.deleteOne({ user: req.user._id, doctor: req.params.id });
  res.json({ watching: false });
});
router.get('/watching/list', requireAuth, async (req, res) => {
  const w = await DoctorWatch.find({ user: req.user._id }).select('doctor').lean();
  res.json({ items: w.map((x) => String(x.doctor)) });
});

/* ---------- reviews ---------- */

async function refreshRating(doctorId) {
  const all = await DoctorReview.find({ doctor: doctorId, hidden: false }).select('rating').lean();
  const avg = all.length ? Math.round((all.reduce((t, r) => t + r.rating, 0) / all.length) * 10) / 10 : 0;
  await Doctor.updateOne({ _id: doctorId }, { $set: { rating: avg, reviews: all.length } });
}

const publicReview = (r) => ({ id: String(r._id), rating: r.rating, text: r.text, authorName: r.authorName, createdAt: r.createdAt });

/** GET /doctors/:id/reviews?page=1 — newest first */
router.get('/:id/reviews', async (req, res) => {
  const d = await findDoctor(req.params.id);
  const page = Math.max(1, Number(req.query.page) || 1);
  const [items, total] = await Promise.all([
    DoctorReview.find({ doctor: d._id, hidden: false }).sort({ createdAt: -1 }).skip((page - 1) * 10).limit(10).lean(),
    DoctorReview.countDocuments({ doctor: d._id, hidden: false }),
  ]);
  res.json({ items: items.map(publicReview), total, page, pages: Math.ceil(total / 10) });
});

/** A consultation can be reviewed once it's completed, or once a chat has been held and ended. */
const REVIEWABLE = { $or: [{ status: 'completed' }, { status: 'booked', type: 'chat', endedAt: { $ne: null } }] };

/** GET /doctors/:id/review-eligibility → { canReview, appointmentId } (completed consultation without a review) */
router.get('/:id/review-eligibility', requireAuth, async (req, res) => {
  const done = await Appointment.find({ user: req.user._id, doctor: req.params.id, ...REVIEWABLE }).select('_id').sort({ start: -1 }).lean();
  const reviewed = new Set((await DoctorReview.find({ appointment: { $in: done.map((a) => a._id) } }).select('appointment').lean()).map((r) => String(r.appointment)));
  const open = done.find((a) => !reviewed.has(String(a._id)));
  res.json({ canReview: !!open, appointmentId: open ? String(open._id) : null });
});

/** POST /doctors/:id/reviews { rating: 1–5, text } — only after a completed consultation, one per consultation */
router.post('/:id/reviews', requireAuth, async (req, res) => {
  const d = await findDoctor(req.params.id);
  const rating = Math.round(Number(req.body?.rating));
  if (!(rating >= 1 && rating <= 5)) throw new HttpError(400, 'Please choose 1 to 5 stars.');
  const text = String(req.body?.text ?? '').trim().slice(0, 1000);
  const done = await Appointment.find({ user: req.user._id, doctor: d._id, ...REVIEWABLE }).select('_id').sort({ start: -1 }).lean();
  const reviewed = new Set((await DoctorReview.find({ appointment: { $in: done.map((a) => a._id) } }).select('appointment').lean()).map((r) => String(r.appointment)));
  const appt = done.find((a) => !reviewed.has(String(a._id)));
  if (!appt) throw new HttpError(403, done.length ? 'You’ve already reviewed your consultations with this doctor.' : 'You can review a doctor after a finished consultation.');
  const parts = (req.user.fullName ?? '').trim().split(/\s+/);
  const authorName = `${parts[0] ?? 'Patient'}${parts.length > 1 ? ` ${parts[parts.length - 1][0].toUpperCase()}.` : ''}`;
  const r = await DoctorReview.create({ doctor: d._id, user: req.user._id, appointment: appt._id, rating, text, authorName });
  await refreshRating(d._id);
  res.status(201).json(publicReview(r));
});

/** PATCH /doctors/reviews/:rid { hidden } — moderation (admin) */
router.patch('/reviews/:rid', admin, async (req, res) => {
  if (!isValidObjectId(req.params.rid)) throw new HttpError(404, 'Review not found.');
  const r = await DoctorReview.findById(req.params.rid);
  if (!r) throw new HttpError(404, 'Review not found.');
  r.hidden = !!req.body?.hidden;
  await r.save();
  await refreshRating(r.doctor);
  res.json({ id: r.id, hidden: r.hidden });
});

/* ---------- admin ---------- */

router.post('/', admin, async (req, res) => {
  try {
    res.status(201).json((await Doctor.create(pick(req.body))).toPublic());
  } catch (e) {
    throw invalid(e);
  }
});

router.patch('/:id', admin, async (req, res) => {
  const d = await findDoctor(req.params.id, true);
  d.set(pick(req.body));
  try {
    await d.save();
  } catch (e) {
    throw invalid(e);
  }
  res.json(d.toPublic());
});

/** PATCH /doctors/:id/break { minutes: 30 } (0 / null ends the break) */
router.patch('/:id/break', admin, async (req, res) => {
  const d = await findDoctor(req.params.id, true);
  const m = Number(req.body?.minutes) || 0;
  d.breakUntil = m > 0 ? new Date(Date.now() + Math.min(m, 600) * 60e3) : undefined;
  await d.save();
  res.json(d.toPublic());
});

router.delete('/:id', admin, async (req, res) => {
  const d = await findDoctor(req.params.id, true);
  d.active = false; // keep history; appointments still reference the doctor
  await d.save();
  res.json({ hidden: true, id: d.id });
});

router.put('/:id/image', admin, async (req, res) => {
  const d = await findDoctor(req.params.id, true);
  const raw = String(req.body?.image ?? '');
  const ct = raw.match(/^data:(image\/(?:jpeg|png|webp));base64,/)?.[1] ?? 'image/jpeg';
  const data = Buffer.from(raw.replace(/^data:[^,]+,/, ''), 'base64');
  if (data.length < 100) throw new HttpError(400, 'Please send an image (base64).');
  if (data.length > 3 * 1024 * 1024) throw new HttpError(413, 'Image must be under 3 MB.');
  await DoctorImage.deleteOne({ doctor: d._id });
  await DoctorImage.create({ doctor: d._id, contentType: ct, data });
  d.hasImage = true;
  await d.save();
  res.json(d.toPublic());
});

module.exports = router;
