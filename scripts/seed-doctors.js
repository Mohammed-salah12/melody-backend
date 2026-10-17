/**
 * Adds SAMPLE doctors (placeholder names and bios — replace them with your real specialists in
 * the admin page). npm run seed:doctors   ·   npm run seed:doctors -- --reset
 */
const mongoose = require('mongoose');
const config = require('../src/config');
const Doctor = require('../src/models/Doctor');

const SAMPLES = [
  { name: 'Dr. Eleanor Vance', bio: 'Expert in treating dry and sensitive skin', yearsExperience: 10, specialties: ['dryness', 'sensitivity', 'eczema'], rating: 0, reviews: 0, fastTrack: true, expertise: ['Clinical Dermatology'], about: 'Sample profile — replace with the doctor’s real biography in the clinic admin page. Focuses on barrier repair for dry and reactive skin, with gentle, evidence-based routines.' },
  { name: 'Dr. Sarah Chen', bio: 'Acne and scarring specialist with a focus on gentle protocols', yearsExperience: 12, specialties: ['acne', 'scarring'], rating: 0, reviews: 0, expertise: ['Clinical Dermatology'], about: 'Sample profile — replace with the doctor’s real biography. Treats acne and post-acne marks step by step, from gentle routines to in-clinic options.' },
  { name: 'Dr. Layla Haddad', bio: 'Pigmentation and melasma care for every skin tone', yearsExperience: 8, specialties: ['pigmentation', 'laser'], rating: 0, reviews: 0, startHour: 12, endHour: 20 },
  { name: 'Dr. Omar Nasser', bio: 'Anti-aging and laser therapy', yearsExperience: 15, specialties: ['anti-aging', 'laser', 'scarring'], rating: 0, reviews: 0, consultTypes: ['video'] },
  { name: 'Dr. Maya Khalil', bio: 'Eczema and reactive skin in adults and teens', yearsExperience: 6, specialties: ['eczema', 'sensitivity', 'acne'], rating: 0, reviews: 0, workDays: [0, 1, 2, 3] },
];

module.exports = { SAMPLES };

if (require.main === module) (async () => {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
  if (process.argv.includes('--reset')) console.log(`Deleted ${(await Doctor.deleteMany({})).deletedCount} doctors.`);
  let added = 0;
  for (const s of SAMPLES) {
    if (await Doctor.exists({ name: s.name })) continue;
    await Doctor.create(s);
    added++;
  }
  console.log(`Added ${added} sample doctors.`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
