/**
 * Give a user admin rights (can add / edit / delete products).
 *   npm run make-admin -- +970599123456
 *   npm run make-admin -- +970599123456 --remove
 */
const mongoose = require('mongoose');
const config = require('../src/config');
const User = require('../src/models/User');

(async () => {
  const phone = process.argv[2]?.replace(/[\s()-]/g, '');
  if (!phone) throw new Error('Usage: npm run make-admin -- <phone number>');
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
  const role = process.argv.includes('--remove') ? 'user' : 'admin';
  const user = await User.findOne({ phone });
  if (!user) throw new Error(`No account with phone ${phone}. Sign up in the app first.`);
  user.role = role;
  await user.save();
  console.log(`${user.fullName} (${user.phone}) is now: ${role}`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
