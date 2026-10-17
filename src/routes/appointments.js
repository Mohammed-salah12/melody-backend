/**
 * Consultations: booking, my appointments, the Clinical Archive and PDF reports.
 * Clinic staff (admins) complete a consultation with a summary + protocol → it appears in the archive.
 */
const { Router } = require('express');
const jwt = require('jsonwebtoken');
const { isValidObjectId } = require('mongoose');

const config = require('../config');
const Appointment = require('../models/Appointment');
const Doctor = require('../models/Doctor');
const ChatFile = require('../models/ChatFile');
const HealthLog = require('../models/HealthLog');
const Message = require('../models/Message');
const Product = require('../models/Product');
const { AccessToken } = require('livekit-server-sdk');
const Scan = require('../models/Scan');
const User = require('../models/User');
const { slotsForDay, statusOf } = require('../analysis/availability');
const { clinicDay } = require('../lib/clinic-time');
const { HttpError } = require('../lib/http');
const { writeReport, writeSkinReport } = require('../lib/report-pdf');
const { recommend } = require('../analysis/matcher');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = Router();

function publicAppt(a) {
  const o = a.toObject ? a.toObject({ versionKey: false }) : { ...a };
  o.id = String(o._id);
  delete o._id;
  delete o.user;
  if (o.doctor && typeof o.doctor === 'object' && o.doctor._id) {
    const d = o.doctor;
    o.doctor = { id: String(d._id), name: d.name, title: d.title, rating: d.rating, reviews: d.reviews, hasImage: d.hasImage, imageUrl: d.imageUrl, updatedAt: d.updatedAt };
  }
  return o;
}

const REQUEST_TIMEOUT_MS = 3 * 60e3; // an instant chat request waits 3 minutes for the doctor

/** Instant chat requests nobody accepted in time become "missed". */
async function expireRequests(filter = {}) {
  await Appointment.updateMany({ ...filter, status: 'requested', createdAt: { $lt: new Date(Date.now() - REQUEST_TIMEOUT_MS) } }, { $set: { status: 'missed' } });
}

/** Photos / voice notes / files are fetched with a signed link (images can't send a login header). */
function fileToken(apptId) {
  return jwt.sign({ appt: String(apptId), typ: 'chatfile' }, config.jwtSecret, { expiresIn: '12h' });
}
function messageOut(m, base, t) {
  const o = { id: String(m._id), from: m.from, kind: m.kind ?? 'text', text: m.text ?? '', createdAt: m.createdAt };
  if (m.file) Object.assign(o, { url: `${base}/appointments/${m.appointment}/files/${m.file}?t=${t}`, fileName: m.fileName, mime: m.mime, size: m.size, durationSec: m.durationSec });
  if (m.kind === 'product' && m.product) {
    o.product = { id: String(m.product), name: m.productName, imageUrl: m.productImage || `${base}/products/${m.product}/image`, match: m.match ?? null };
  }
  if (m.kind === 'report') Object.assign(o, { reportCode: m.reportCode, url: `${base}/appointments/${m.appointment}/messages/${m._id}/report.pdf?t=${t}` });
  return o;
}
const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;
const publicMessage = (m, req) => messageOut(m, baseUrl(req), fileToken(m.appointment));

const TYPING_MS = 6000;
const typingNow = (at) => !!at && Date.now() - at.getTime() < TYPING_MS;

/** What the patient may send: photos, voice notes and documents up to 8 MB. */
const MAX_FILE = 8 * 1024 * 1024;
const ALLOWED = {
  image: /^image\/(jpeg|png|webp|heic|heif)$/,
  audio: /^audio\/(mp4|m4a|x-m4a|aac|mpeg|webm|ogg|wav|x-wav|3gpp)$/,
  file: /^(application\/pdf|text\/plain|image\/(jpeg|png|webp|heic|heif))$/,
};

/**
 * The consultation room (chat, and the call for video consultations) is open from 10 minutes before
 * the start until 30 minutes after the end — instant chats once the doctor accepted — until someone ends it.
 */
function chatOpen(a, now = Date.now()) {
  if (a.status !== 'booked' || a.endedAt) return false;
  if (a.instant) return !!a.acceptedAt;
  return now >= a.start.getTime() - 10 * 60e3 && now <= a.end.getTime() + 30 * 60e3;
}
const callOpen = (a) => a.type === 'video' && chatOpen(a);
const videoReady = () => !!(config.livekit.url && config.livekit.apiKey && config.livekit.apiSecret);

/** A LiveKit access token for this consultation's room. */
async function callToken(a, identity, name) {
  if (!videoReady()) throw new HttpError(503, 'Video calls aren’t set up on the server yet (LIVEKIT_URL / keys).');
  if (a.type !== 'video') throw new HttpError(409, 'This is a chat consultation.');
  if (!callOpen(a)) throw new HttpError(409, a.endedAt || a.status === 'completed' ? 'This consultation has ended.' : 'The call opens 10 minutes before your consultation.');
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, { identity, name, ttl: '2h' });
  at.addGrant({ room: `consult-${a.id}`, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  return { url: config.livekit.url, token: await at.toJwt(), room: `consult-${a.id}` };
}

/** The scan the doctor may use: the one linked at booking, or the newest one while report access is approved. */
async function scanFor(a) {
  const ra = a.reportAccess ?? {};
  if (ra.status === 'approved' && ra.decidedAt && Date.now() - ra.decidedAt.getTime() < 24 * 3600e3) {
    const latest = await Scan.findOne({ user: a.user, status: 'complete' }).sort({ completedAt: -1 }).select('results completedAt source');
    if (latest) return latest;
  }
  return a.scanId ? Scan.findOne({ _id: a.scanId, status: 'complete' }).select('results completedAt source') : null;
}

async function freeUsed(userId) {
  return Appointment.countDocuments({ user: userId, free: true, status: { $in: ['booked', 'completed'] } });
}

/** GET /appointments/report.pdf?t=<signed link> — no login header needed (opened in the browser). */
router.get('/:id/report.pdf', async (req, res) => {
  let payload;
  try {
    payload = jwt.verify(String(req.query.t ?? ''), config.jwtSecret);
  } catch {
    throw new HttpError(401, 'This download link has expired. Open it again from the app.');
  }
  if (payload.typ !== 'report' || payload.appt !== req.params.id) throw new HttpError(401, 'Invalid download link.');
  const appt = await Appointment.findById(req.params.id).populate('doctor');
  if (!appt || String(appt.user) !== payload.sub || appt.status !== 'completed') throw new HttpError(404, 'Report not found.');
  const [user, scan] = await Promise.all([User.findById(appt.user), appt.scanId ? Scan.findById(appt.scanId).select('results') : null]);
  res.type('application/pdf').set('Content-Disposition', `inline; filename="melody-consultation-${clinicDay(appt.start)}.pdf"`);
  writeReport(res, { appt, doctor: appt.doctor, user, scan, tz: config.clinic.timezone });
});

/** GET /appointments/:id/files/:fid?t=<signed> — a chat attachment */
router.get('/:id/files/:fid', async (req, res) => {
  let payload;
  try {
    payload = jwt.verify(String(req.query.t ?? ''), config.jwtSecret);
  } catch {
    throw new HttpError(401, 'This link has expired. Reopen the chat.');
  }
  if (payload.typ !== 'chatfile' || payload.appt !== req.params.id || !isValidObjectId(req.params.fid)) throw new HttpError(401, 'Invalid link.');
  const f = await ChatFile.findOne({ _id: req.params.fid, appointment: req.params.id });
  if (!f) throw new HttpError(404, 'File not found.');
  const inline = /^(image|audio)\//.test(f.mime);
  const name = String(f.name ?? 'file').replace(/["\r\n]/g, '');
  res.set({ 'Content-Type': f.mime, 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"` });
  res.send(f.data);
});

/** GET /appointments/:id/messages/:mid/report.pdf?t=<signed> — a skin report the doctor sent */
router.get('/:id/messages/:mid/report.pdf', async (req, res) => {
  let payload;
  try {
    payload = jwt.verify(String(req.query.t ?? ''), config.jwtSecret);
  } catch {
    throw new HttpError(401, 'This link has expired. Reopen the chat.');
  }
  if (payload.typ !== 'chatfile' || payload.appt !== req.params.id || !isValidObjectId(req.params.mid)) throw new HttpError(401, 'Invalid link.');
  const m = await Message.findOne({ _id: req.params.mid, appointment: req.params.id, kind: 'report' });
  if (!m) throw new HttpError(404, 'Report not found.');
  const a = await Appointment.findById(req.params.id).populate('doctor');
  const [user, scan] = await Promise.all([User.findById(a.user).select('fullName'), m.scan ? Scan.findById(m.scan).select('results completedAt source') : null]);
  res.type('application/pdf').set('Content-Disposition', `inline; filename="melody-skin-report-${m.reportCode}.pdf"`);
  writeSkinReport(res, { code: m.reportCode, note: m.text, doctor: a.doctor, user, scan, at: m.createdAt, tz: config.clinic.timezone });
});

router.use(requireAuth);

/** GET /appointments/summary → free consultations used, upcoming, archive count */
router.get('/summary', async (req, res) => {
  const [used, upcoming, archived] = await Promise.all([
    freeUsed(req.user._id),
    Appointment.find({ user: req.user._id, status: 'booked', end: { $gt: new Date() } }).sort({ start: 1 }).limit(5).populate('doctor'),
    Appointment.countDocuments({ user: req.user._id, status: 'completed' }),
  ]);
  res.json({ freeTotal: config.clinic.freeConsultations, freeUsed: Math.min(used, config.clinic.freeConsultations), upcoming: upcoming.map(publicAppt), archived });
});

/** POST /appointments { doctorId, date: 'YYYY-MM-DD', time: 'HH:MM', type, problem?, note? } */
router.post('/', async (req, res) => {
  const b = req.body ?? {};
  if (!isValidObjectId(b.doctorId)) throw new HttpError(400, 'Please choose a doctor.');
  const doctor = await Doctor.findOne({ _id: b.doctorId, active: true });
  if (!doctor) throw new HttpError(404, 'Doctor not found.');
  const type = b.type === 'chat' ? 'chat' : 'video';
  if (!doctor.consultTypes.includes(type)) throw new HttpError(400, `${doctor.name} doesn’t offer ${type} consultations.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date ?? '') || !/^\d{2}:\d{2}$/.test(b.time ?? '')) throw new HttpError(400, 'Please choose a date and time.');

  const slot = (await slotsForDay(doctor, b.date)).find((s) => s.time === b.time);
  if (!slot) throw new HttpError(400, 'This time is outside the doctor’s working hours.');
  if (!slot.available) throw new HttpError(409, slot.reason === 'past' ? 'This time has passed — please choose a later slot.' : 'This time was just booked. Please choose another slot.');

  // one consultation at a time for the patient too
  const clash = await Appointment.exists({ user: req.user._id, status: 'booked', start: { $lt: new Date(slot.end) }, end: { $gt: new Date(slot.start) } });
  if (clash) throw new HttpError(409, 'You already have a consultation at this time.');

  const latestScan = await Scan.findOne({ user: req.user._id, status: 'complete' }).sort({ completedAt: -1 }).select('_id');
  const appt = await Appointment.create({
    user: req.user._id,
    doctor: doctor._id,
    start: slot.start,
    end: slot.end,
    type,
    problem: String(b.problem ?? '').slice(0, 60) || undefined,
    note: String(b.note ?? '').slice(0, 500) || undefined,
    free: (await freeUsed(req.user._id)) < config.clinic.freeConsultations,
    scanId: latestScan?._id,
  });
  // race check: if someone else booked the same slot at the same moment, the later one gives way
  const same = await Appointment.find({ doctor: doctor._id, start: appt.start, status: 'booked' }).sort({ createdAt: 1, _id: 1 });
  if (same.length > 1 && String(same[0]._id) !== String(appt._id)) {
    await appt.deleteOne();
    throw new HttpError(409, 'This time was just booked. Please choose another slot.');
  }
  await appt.populate('doctor');
  res.status(201).json(publicAppt(appt));
});

/**
 * POST /appointments/instant { doctorId } — "Chat" now with an online doctor.
 * Creates a request the doctor accepts in the clinic page (3-minute timeout).
 */
router.post('/instant', async (req, res) => {
  if (!isValidObjectId(req.body?.doctorId)) throw new HttpError(400, 'Please choose a doctor.');
  const doctor = await Doctor.findOne({ _id: req.body.doctorId, active: true });
  if (!doctor) throw new HttpError(404, 'Doctor not found.');
  if (!doctor.consultTypes.includes('chat')) throw new HttpError(400, `${doctor.name} doesn’t offer chat consultations.`);
  const st = await statusOf(doctor);
  if (st.status !== 'online') throw new HttpError(409, `${doctor.name} isn’t available for a chat right now. Book a time instead.`);
  const now = new Date();
  const end = new Date(now.getTime() + config.clinic.slotMinutes * 60e3);
  if (await Appointment.exists({ doctor: doctor._id, status: 'booked', start: { $lt: end }, end: { $gt: now } })) {
    throw new HttpError(409, `${doctor.name} has a consultation starting soon. Please book a time instead.`);
  }
  await expireRequests({ user: req.user._id });
  if (await Appointment.exists({ user: req.user._id, status: { $in: ['requested', 'booked'] }, start: { $lt: end }, end: { $gt: now } })) {
    throw new HttpError(409, 'You already have a consultation right now.');
  }
  const latestScan = await Scan.findOne({ user: req.user._id, status: 'complete' }).sort({ completedAt: -1 }).select('_id');
  const appt = await Appointment.create({
    user: req.user._id,
    doctor: doctor._id,
    start: now,
    end,
    type: 'chat',
    instant: true,
    status: 'requested',
    problem: String(req.body?.problem ?? '').slice(0, 60) || undefined,
    free: (await freeUsed(req.user._id)) < config.clinic.freeConsultations,
    scanId: latestScan?._id,
  });
  await appt.populate('doctor');
  res.status(201).json({ ...publicAppt(appt), timeoutSeconds: REQUEST_TIMEOUT_MS / 1000 });
});

/** GET /appointments/:id/messages?after=ISO — chat history (polled by the app) */
router.get('/:id/messages', async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Consultation not found.');
  const a = await Appointment.findById(req.params.id);
  if (!a || (String(a.user) !== String(req.user._id) && req.user.role !== 'admin')) throw new HttpError(404, 'Consultation not found.');
  const f = { appointment: a._id };
  if (req.query.after) f.createdAt = { $gt: new Date(String(req.query.after)) };
  const items = await Message.find(f).sort({ createdAt: 1 }).limit(500);
  const base = baseUrl(req);
  const t = fileToken(a._id);
  res.json({
    items: items.map((m) => messageOut(m, base, t)),
    open: chatOpen(a),
    status: a.status,
    endedAt: a.endedAt ?? null,
    endedBy: a.endedBy ?? null,
    doctorTyping: chatOpen(a) && typingNow(a.doctorTypingAt),
    patientTyping: chatOpen(a) && typingNow(a.patientTypingAt),
    reportAccess: a.reportAccess?.status ?? 'none',
  });
});

/** POST /appointments/:id/messages { text } — patient writes */
router.post('/:id/messages', async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Consultation not found.');
  const a = await Appointment.findOne({ _id: req.params.id, user: req.user._id });
  if (!a) throw new HttpError(404, 'Consultation not found.');
  if (!chatOpen(a)) {
    throw new HttpError(409, a.endedAt || a.status === 'completed' ? 'This chat has ended.' : a.status === 'requested' ? 'Waiting for the specialist to join.' : 'The chat opens 10 minutes before your consultation.');
  }
  const text = String(req.body?.text ?? '').trim();
  if (!text) throw new HttpError(400, 'Write a message first.');
  const m = await Message.create({ appointment: a._id, from: 'patient', text: text.slice(0, 2000) });
  a.patientTypingAt = undefined;
  await a.save();
  res.status(201).json(publicMessage(m, req));
});

/** Stores a photo / voice note / file and posts it as a message from `from`. */
async function saveAttachment(a, from, body) {
  const kind = ['image', 'audio', 'file'].includes(body?.kind) ? body.kind : null;
  if (!kind) throw new HttpError(400, 'Unknown attachment type.');
  const m = String(body?.data ?? '').match(/^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/s);
  if (!m) throw new HttpError(400, 'Please attach a file.');
  const mime = m[1].toLowerCase() === 'audio/x-m4a' ? 'audio/mp4' : m[1].toLowerCase();
  if (!ALLOWED[kind].test(mime)) throw new HttpError(415, kind === 'file' ? 'You can send PDF, image or text files.' : 'This file type isn’t supported.');
  const data = Buffer.from(m[2], 'base64');
  if (!data.length) throw new HttpError(400, 'The file is empty.');
  if (data.length > MAX_FILE) throw new HttpError(413, 'Files can be up to 8 MB.');
  const name = String(body?.name ?? '').replace(/[\\/]/g, '_').slice(0, 200) || (kind === 'audio' ? 'voice-note' : kind === 'image' ? 'photo' : 'file');
  const f = await ChatFile.create({ appointment: a._id, data, mime, name, size: data.length });
  return Message.create({
    appointment: a._id,
    from,
    kind,
    text: String(body?.text ?? '').trim().slice(0, 2000),
    file: f._id,
    fileName: name,
    mime,
    size: data.length,
    durationSec: kind === 'audio' ? Math.max(0, Math.round(Number(body?.durationSec) || 0)) : undefined,
  });
}

async function myOpenChat(req) {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Consultation not found.');
  const a = await Appointment.findOne({ _id: req.params.id, user: req.user._id });
  if (!a) throw new HttpError(404, 'Consultation not found.');
  if (!chatOpen(a)) throw new HttpError(409, a.endedAt ? 'This chat has ended.' : 'This chat is not open.');
  return a;
}

/**
 * POST /appointments/:id/files { kind: image|audio|file, data: "data:<mime>;base64,…", name?, durationSec?, text? }
 * Photo from the camera/gallery, voice note or document (PDF / image / text, max 8 MB).
 */
router.post('/:id/files', async (req, res) => {
  const a = await myOpenChat(req);
  res.status(201).json(publicMessage(await saveAttachment(a, 'patient', req.body), req));
});

/** POST /appointments/:id/typing — the patient is typing (shown to the doctor for a few seconds) */
router.post('/:id/typing', async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Consultation not found.');
  await Appointment.updateOne({ _id: req.params.id, user: req.user._id }, { $set: { patientTypingAt: new Date() } });
  res.json({ ok: true });
});

/** POST /appointments/:id/report-access { approve: true|false } — answer the doctor's request */
router.post('/:id/report-access', async (req, res) => {
  const a = await myOpenChat(req);
  if (a.reportAccess?.status !== 'requested') throw new HttpError(409, 'There is no pending request.');
  const approve = !!req.body?.approve;
  a.reportAccess = { status: approve ? 'approved' : 'declined', requestedAt: a.reportAccess.requestedAt, decidedAt: new Date() };
  await a.save();
  await Message.create({
    appointment: a._id,
    from: 'system',
    text: approve ? 'You shared your skin tracking from the last 7 days with the specialist (access lasts 24 hours).' : 'You declined to share your skin tracking.',
  });
  res.json({ reportAccess: a.reportAccess.status });
});

/** GET /appointments/:id/call → { url, token, room } to join the video consultation (LiveKit) */
router.get('/:id/call', async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Consultation not found.');
  const a = await Appointment.findOne({ _id: req.params.id, user: req.user._id });
  if (!a) throw new HttpError(404, 'Consultation not found.');
  res.json(await callToken(a, `patient-${req.user._id}`, req.user.fullName || 'Patient'));
});

/** POST /appointments/:id/finish — the patient ends the chat ("Conclude & Save") */
router.post('/:id/finish', async (req, res) => {
  const a = await myOpenChat(req);
  Object.assign(a, { endedAt: new Date(), endedBy: 'patient' });
  await a.save();
  const first = (req.user.fullName ?? '').trim().split(/\s+/)[0] || 'The patient';
  await Message.create({ appointment: a._id, from: 'system', text: `${first} ended the chat. The specialist’s summary will appear in the Clinical Archive.` });
  const began = a.acceptedAt ?? a.start;
  res.json({ ...publicAppt(a), durationSeconds: Math.max(0, Math.round((a.endedAt - began) / 1000)) });
});

/** GET /appointments?when=upcoming|past */
router.get('/', async (req, res) => {
  const now = new Date();
  const f = { user: req.user._id };
  if (req.query.when === 'upcoming') Object.assign(f, { status: 'booked', end: { $gt: now } });
  if (req.query.when === 'past') f.$or = [{ status: { $in: ['completed', 'cancelled', 'no_show'] } }, { end: { $lte: now } }];
  const items = await Appointment.find(f).sort({ start: req.query.when === 'upcoming' ? 1 : -1 }).limit(100).populate('doctor');
  res.json({ items: items.map(publicAppt) });
});

/** GET /appointments/archive — completed consultations with the doctor's summary (Clinical Archive). */
router.get('/archive', async (req, res) => {
  const items = await Appointment.find({ user: req.user._id, status: 'completed' }).sort({ start: -1 }).limit(100).populate('doctor');
  res.json({ items: items.map(publicAppt) });
});

/** POST /appointments/:id/cancel — up to CANCELLATION_HOURS before the start. */
router.post('/:id/cancel', async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Appointment not found.');
  const a = await Appointment.findOne({ _id: req.params.id, user: req.user._id });
  if (!a || !['booked', 'requested'].includes(a.status)) throw new HttpError(404, 'Appointment not found.');
  if (a.status === 'booked' && !a.instant && a.start - Date.now() < config.clinic.cancellationHours * 3600e3) {
    throw new HttpError(409, `Consultations can be cancelled up to ${config.clinic.cancellationHours} hours before they start.`);
  }
  a.status = 'cancelled';
  await a.save();
  res.json(publicAppt(a));
});

/** GET /appointments/:id/report-link → { url } valid for 10 minutes */
router.get('/:id/report-link', async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Report not found.');
  const a = await Appointment.findOne({ _id: req.params.id, user: req.user._id, status: 'completed' }).select('_id');
  if (!a) throw new HttpError(404, 'Report not found.');
  const t = jwt.sign({ sub: String(req.user._id), appt: a.id, typ: 'report' }, config.jwtSecret, { expiresIn: '10m' });
  res.json({ url: `${req.protocol}://${req.get('host')}/appointments/${a.id}/report.pdf?t=${t}` });
});

/** GET /appointments/:id — one of mine (the app polls this while "Connecting with Specialist…") */
router.get('/:id', async (req, res, next) => {
  if (!isValidObjectId(req.params.id)) return next();
  await expireRequests({ _id: req.params.id });
  const a = await Appointment.findOne({ _id: req.params.id, user: req.user._id }).populate('doctor');
  if (!a) throw new HttpError(404, 'Consultation not found.');
  res.json({ ...publicAppt(a), chatOpen: chatOpen(a), callOpen: callOpen(a), videoReady: videoReady() });
});

/* ---------- clinic staff (admins) ---------- */

/** GET /appointments/admin/requests — waiting instant chats + chats in progress */
router.get('/admin/chats', requireAdmin, async (_req, res) => {
  await expireRequests();
  const items = await Appointment.find({ $or: [{ status: 'requested' }, { status: 'booked', endedAt: null, end: { $gt: new Date(Date.now() - 30 * 60e3) }, start: { $lt: new Date(Date.now() + 10 * 60e3) } }] })
    .sort({ createdAt: 1 })
    .populate('doctor')
    .populate('user', 'fullName phone');
  res.json({ items: items.map((a) => ({ ...publicAppt(a), patient: a.user ? { name: a.user.fullName, phone: a.user.phone } : null, chatOpen: chatOpen(a), callOpen: callOpen(a) })), videoReady: videoReady() });
});

/** GET /appointments/:id/staff — one consultation for the doctor's console */
router.get('/:id/staff', requireAdmin, async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Consultation not found.');
  const a = await Appointment.findById(req.params.id).populate('doctor').populate('user', 'fullName phone');
  if (!a) throw new HttpError(404, 'Consultation not found.');
  const scan = await scanFor(a);
  res.json({
    ...publicAppt(a),
    patient: a.user ? { name: a.user.fullName, phone: a.user.phone } : null,
    chatOpen: chatOpen(a),
    callOpen: callOpen(a),
    videoReady: videoReady(),
    hasScan: !!scan,
  });
});

/** GET /appointments/:id/staff-call → the doctor's LiveKit token */
router.get('/:id/staff-call', requireAdmin, async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Consultation not found.');
  const a = await Appointment.findById(req.params.id).populate('doctor');
  if (!a) throw new HttpError(404, 'Consultation not found.');
  res.json(await callToken(a, `doctor-${a.id}`, a.doctor?.name ?? 'Specialist'));
});

async function staffOpenChat(req) {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Consultation not found.');
  const a = await Appointment.findById(req.params.id).populate('doctor');
  if (!a || !chatOpen(a)) throw new HttpError(409, 'This consultation is not open.');
  return a;
}

/** POST /appointments/:id/staff-files — the doctor sends a photo / voice note / file */
router.post('/:id/staff-files', requireAdmin, async (req, res) => {
  const a = await staffOpenChat(req);
  res.status(201).json(publicMessage(await saveAttachment(a, 'doctor', req.body), req));
});

/** GET /appointments/:id/staff-suggestions — products ranked for the patient's scan (Clinical Protocol sheet) */
router.get('/:id/staff-suggestions', requireAdmin, async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Consultation not found.');
  const a = await Appointment.findById(req.params.id).populate('user');
  if (!a) throw new HttpError(404, 'Consultation not found.');
  const scan = await scanFor(a);
  if (!scan) throw new HttpError(404, 'No skin scan is shared for this consultation — request the skin report first.');
  const products = await Product.find({ active: true }).lean();
  const rec = recommend(products, scan.results, a.user, { limit: 10, outcomes: await require('../analysis/outcomes').getOutcomes() });
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const base = baseUrl(req);
  res.json({
    scanDate: scan.completedAt,
    focusLabel: rec.focusLabel,
    items: rec.products.map((r) => {
      const p = byId.get(r.productId);
      return { id: r.productId, name: p.name, brand: p.brand, description: p.description, why: r.reasons.join(' '), match: r.match, imageUrl: p.hasImage ? `${base}/products/${p._id}/image` : p.imageUrl ?? null };
    }),
  });
});

/** POST /appointments/:id/staff-product { productId, note? } — sends a "Suggested Treatment" card */
router.post('/:id/staff-product', requireAdmin, async (req, res) => {
  const a = await staffOpenChat(req);
  if (!isValidObjectId(req.body?.productId)) throw new HttpError(400, 'Choose a product.');
  const p = await Product.findOne({ _id: req.body.productId, active: true }).lean();
  if (!p) throw new HttpError(404, 'Product not found.');
  await a.populate('user');
  const scan = await scanFor(a);
  const r = scan ? recommend([p], scan.results, a.user, { limit: 1 }).products[0] : null;
  const note = String(req.body?.note ?? '').trim().slice(0, 600) || (p.description ?? '').slice(0, 300);
  const m = await Message.create({
    appointment: a._id,
    from: 'doctor',
    kind: 'product',
    text: note,
    product: p._id,
    productName: p.name,
    productImage: p.hasImage ? '' : p.imageUrl ?? '',
    match: r?.match,
  });
  res.status(201).json(publicMessage(m, req));
});

/** POST /appointments/:id/staff-report { note } — sends a skin report (PDF of the shared scan + note) */
router.post('/:id/staff-report', requireAdmin, async (req, res) => {
  const a = await staffOpenChat(req);
  const note = String(req.body?.note ?? '').trim();
  if (note.length < 10) throw new HttpError(400, 'Write a short note for the report.');
  const scan = await scanFor(a);
  if (!scan) throw new HttpError(404, 'No skin scan is shared for this consultation — request the skin report first.');
  const count = await Message.countDocuments({ kind: 'report' });
  const code = `SK-${String(1000 + count + 1).padStart(4, '0')}`;
  const m = await Message.create({ appointment: a._id, from: 'doctor', kind: 'report', text: note.slice(0, 2000), reportCode: code, scan: scan._id });
  res.status(201).json(publicMessage(m, req));
});

/** POST /appointments/:id/accept — the doctor takes an instant chat */
router.post('/:id/accept', requireAdmin, async (req, res) => {
  await expireRequests({ _id: req.params.id });
  const a = await Appointment.findById(req.params.id).populate('doctor');
  if (!a || a.status !== 'requested') throw new HttpError(409, 'This request is no longer waiting.');
  const now = new Date();
  Object.assign(a, { status: 'booked', acceptedAt: now, start: now, end: new Date(now.getTime() + config.clinic.slotMinutes * 60e3) });
  await a.save();
  await Message.create({ appointment: a._id, from: 'system', text: `${a.doctor?.name ?? 'The specialist'} joined the chat.` });
  res.json(publicAppt(a));
});

/** POST /appointments/:id/staff-message { text } — the doctor writes */
router.post('/:id/staff-message', requireAdmin, async (req, res) => {
  const a = await Appointment.findById(req.params.id);
  if (!a || !chatOpen(a)) throw new HttpError(409, 'This chat is not open.');
  const text = String(req.body?.text ?? '').trim();
  if (!text) throw new HttpError(400, 'Write a message first.');
  const m = await Message.create({ appointment: a._id, from: 'doctor', text: text.slice(0, 2000) });
  a.doctorTypingAt = undefined;
  await a.save();
  res.status(201).json(publicMessage(m, req));
});

/** POST /appointments/:id/staff-typing — the doctor is typing */
router.post('/:id/staff-typing', requireAdmin, async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Consultation not found.');
  await Appointment.updateOne({ _id: req.params.id }, { $set: { doctorTypingAt: new Date() } });
  res.json({ ok: true });
});

/** POST /appointments/:id/request-report — the doctor asks to see the patient's last 7 days of skin tracking */
router.post('/:id/request-report', requireAdmin, async (req, res) => {
  const a = await Appointment.findById(req.params.id).populate('doctor');
  if (!a || !chatOpen(a)) throw new HttpError(409, 'This chat is not open.');
  if (a.reportAccess?.status === 'requested') throw new HttpError(409, 'Already waiting for the patient.');
  a.reportAccess = { status: 'requested', requestedAt: new Date() };
  await a.save();
  await Message.create({ appointment: a._id, from: 'system', text: `${a.doctor?.name ?? 'The specialist'} asked to see your skin tracking from the last 7 days.` });
  res.json({ reportAccess: 'requested' });
});

/** GET /appointments/:id/patient-report — only after the patient approved (valid 24 hours) */
router.get('/:id/patient-report', requireAdmin, async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Consultation not found.');
  const a = await Appointment.findById(req.params.id).populate('user', 'fullName');
  if (!a) throw new HttpError(404, 'Consultation not found.');
  const ra = a.reportAccess ?? {};
  if (ra.status !== 'approved') throw new HttpError(403, 'The patient hasn’t shared their skin tracking.');
  if (Date.now() - ra.decidedAt.getTime() > 24 * 3600e3) throw new HttpError(403, 'Access expired (24 hours after the patient approved).');
  const since = new Date(ra.decidedAt.getTime() - 7 * 24 * 3600e3);
  const [scans, sleep] = await Promise.all([
    Scan.find({ user: a.user._id, status: 'complete', completedAt: { $gte: since } }).sort({ completedAt: -1 }).select('source results completedAt').lean(),
    HealthLog.find({ user: a.user._id, date: { $gte: since.toISOString().slice(0, 10) } }).sort({ date: -1 }).lean(),
  ]);
  res.json({
    patient: a.user.fullName,
    since,
    scans: scans.map((x) => ({ at: x.completedAt, source: x.source, score: x.results?.score, skinType: x.results?.skinType, concerns: x.results?.concerns ?? [], metrics: x.results?.metrics ?? {} })),
    sleep: sleep.map((h) => ({ date: h.date, hours: h.sleepHours, source: h.source })),
  });
});

/** POST /appointments/:id/end-chat — closes the chat (then write the summary with Complete) */
router.post('/:id/end-chat', requireAdmin, async (req, res) => {
  const a = await Appointment.findById(req.params.id);
  if (!a) throw new HttpError(404, 'Consultation not found.');
  Object.assign(a, { endedAt: new Date(), endedBy: 'doctor' });
  await a.save();
  await Message.create({ appointment: a._id, from: 'system', text: 'The specialist ended the chat. Your summary will appear in your Clinical Archive.' });
  res.json(publicAppt(a));
});

/** GET /appointments/admin/all?status=booked&from=YYYY-MM-DD */
router.get('/admin/all', requireAdmin, async (req, res) => {
  const f = {};
  if (req.query.status) f.status = req.query.status;
  if (req.query.from) f.start = { $gte: new Date(`${req.query.from}T00:00:00Z`) };
  const items = await Appointment.find(f).sort({ start: 1 }).limit(200).populate('doctor').populate('user', 'fullName phone');
  res.json({
    items: items.map((a) => ({ ...publicAppt(a), patient: a.user ? { name: a.user.fullName, phone: a.user.phone } : null })),
  });
});

/** POST /appointments/:id/complete { summary, protocol: [{ productId?, name?, note? }], durationMinutes? } */
router.post('/:id/complete', requireAdmin, async (req, res) => {
  if (!isValidObjectId(req.params.id)) throw new HttpError(404, 'Appointment not found.');
  const a = await Appointment.findById(req.params.id);
  if (!a || a.status === 'cancelled') throw new HttpError(404, 'Appointment not found.');
  const summary = String(req.body?.summary ?? '').trim();
  if (summary.length < 10) throw new HttpError(400, 'Please write a short clinical summary.');
  const protocol = [];
  for (const p of (req.body?.protocol ?? []).slice(0, 10)) {
    if (p.productId && isValidObjectId(p.productId)) {
      const prod = await Product.findById(p.productId).select('name');
      if (prod) protocol.push({ product: prod._id, name: prod.name, note: String(p.note ?? '').slice(0, 200) });
    } else if (p.name) protocol.push({ name: String(p.name).slice(0, 120), note: String(p.note ?? '').slice(0, 200) });
  }
  Object.assign(a, {
    status: 'completed',
    summary: summary.slice(0, 3000),
    protocol,
    durationMinutes: Number(req.body?.durationMinutes) || Math.round((a.end - a.start) / 60e3),
    completedAt: new Date(),
  });
  await a.save();
  res.json(publicAppt(a));
});

/** POST /appointments/:id/no-show */
router.post('/:id/no-show', requireAdmin, async (req, res) => {
  const a = await Appointment.findById(req.params.id);
  if (!a) throw new HttpError(404, 'Appointment not found.');
  a.status = 'no_show';
  await a.save();
  res.json(publicAppt(a));
});

module.exports = router;
