/**
 * TESTING ONLY — creates a consultation that starts right now, so you can try the video call
 * (or chat) without waiting for a free slot. Skips the booking rules (working hours, free slots).
 *   npm run test-call -- +970599000777            → video call now with the first video doctor
 *   npm run test-call -- +970599000777 --chat     → chat now
 *   npm run test-call -- +970599000777 --doctor "Eleanor"
 * Refuses to run when NODE_ENV=production.
 */
const mongoose = require('mongoose');
const config = require('../src/config');
const User = require('../src/models/User');
const Doctor = require('../src/models/Doctor');
const Scan = require('../src/models/Scan');
const Appointment = require('../src/models/Appointment');

(async () => {
  if (process.env.NODE_ENV === 'production') throw new Error('test-call is for development only.');
  const argv = process.argv.slice(2);
  const phone = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--doctor')?.replace(/[\s()-]/g, '');
  if (!phone) throw new Error('Usage: npm run test-call -- <patient phone> [--chat] [--doctor "name"]');
  const type = argv.includes('--chat') ? 'chat' : 'video';
  const dName = argv.includes('--doctor') ? argv[argv.indexOf('--doctor') + 1] : null;

  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
  const user = await User.findOne({ phone });
  if (!user) throw new Error(`No account with phone ${phone}. Use the phone number you log in with in the app.`);
  const doctor = await Doctor.findOne({ active: true, consultTypes: type, ...(dName ? { name: new RegExp(dName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } : {}) });
  if (!doctor) throw new Error(`No active doctor offering ${type}${dName ? ` named "${dName}"` : ''}. Run npm run seed:doctors first.`);

  // close any earlier test consultations of this patient that are still open, so they don't clash
  const now = new Date();
  await Appointment.updateMany({ user: user._id, status: { $in: ['booked', 'requested'] }, start: { $lte: now }, end: { $gte: now } }, { $set: { status: 'cancelled' } });

  const scan = await Scan.findOne({ user: user._id, status: 'complete' }).sort({ completedAt: -1 }).select('_id');
  const a = await Appointment.create({
    user: user._id,
    doctor: doctor._id,
    start: new Date(now.getTime() - 60e3),
    end: new Date(now.getTime() + config.clinic.slotMinutes * 60e3),
    type,
    status: 'booked',
    problem: 'test',
    scanId: scan?._id,
  });
  console.log(`✔ ${type === 'video' ? 'Video call' : 'Chat'} with ${doctor.name} for ${user.fullName} — open now for ${config.clinic.slotMinutes} minutes.`);
  console.log(`  Phone: Clinic tab (Clinical Archive) → ${type === 'video' ? 'Join call' : 'Open chat'}`);
  console.log(`  Web:   /admin/clinic.html → Live consultations → ${type === 'video' ? 'Open call → Join video call' : 'Open chat'}`);
  console.log(`  Direct doctor link: /admin/consult.html?id=${a.id}`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
