/**
 * Create a clinic / doctor login for the web pages (/admin/clinic.html → consultations).
 *   npm run create-staff -- +970599111222 "Dr. Eleanor Vance" "Clinic#2026"
 * The account gets admin rights. If the phone number already has an account, it is made admin
 * and (only with --reset-password) gets the new password.
 */
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const config = require('../src/config');
const User = require('../src/models/User');

(async () => {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const [rawPhone, fullName, password] = args;
  if (!rawPhone || !fullName || !password) throw new Error('Usage: npm run create-staff -- <phone> "<full name>" "<password>"');
  const phone = rawPhone.replace(/[\s()-]/g, '');
  if (password.length < 8 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    throw new Error('Password needs 8+ characters with upper and lower case letters, a number and a symbol.');
  }
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
  let user = await User.findOne({ phone });
  if (user) {
    user.role = 'admin';
    if (process.argv.includes('--reset-password')) user.passwordHash = await bcrypt.hash(password, 10);
    await user.save();
    console.log(`${user.fullName} (${phone}) already existed — now admin${process.argv.includes('--reset-password') ? ', password updated' : ' (password unchanged; add --reset-password to change it)'}.`);
  } else {
    user = await User.create({ fullName, phone, passwordHash: await bcrypt.hash(password, 10), phoneVerified: true, role: 'admin' });
    console.log(`Created ${fullName} (${phone}) as admin. Log in at /admin/ with this phone and password.`);
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
