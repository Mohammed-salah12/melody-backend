/**
 * Automatic first-run setup, so a fresh deploy (e.g. on Render) works straight away:
 *   - sample products  when the catalogue is empty   (scripts/seed-products.js)
 *   - sample doctors   when there are no doctors     (scripts/seed-doctors.js)
 *   - a clinic / admin login from STAFF_PHONE + STAFF_PASSWORD (+ STAFF_NAME), if set
 *
 * Safe to run on every start: it only fills what is missing and never deletes or overwrites
 * anything (an existing staff password is only changed with STAFF_RESET_PASSWORD=true).
 * Turn it off with AUTO_SEED=off.
 */
const bcrypt = require('bcryptjs');

const Doctor = require('../models/Doctor');
const Product = require('../models/Product');
const User = require('../models/User');

const strongPassword = (p) => p.length >= 8 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p);

async function seedProducts() {
  if ((await Product.estimatedDocumentCount()) > 0) return 'products: already there';
  const { SAMPLES, BRAND } = require('../../scripts/seed-products');
  await Product.insertMany(SAMPLES.map((s) => ({ brand: BRAND, stock: 50, currency: 'USD', ...s })));
  return `products: added ${SAMPLES.length} samples`;
}

async function seedDoctors() {
  if ((await Doctor.estimatedDocumentCount()) > 0) return 'doctors: already there';
  const { SAMPLES } = require('../../scripts/seed-doctors');
  await Doctor.insertMany(SAMPLES);
  return `doctors: added ${SAMPLES.length} samples`;
}

async function seedStaff() {
  const phone = (process.env.STAFF_PHONE || '').replace(/[\s()-]/g, '');
  const password = process.env.STAFF_PASSWORD || '';
  if (!phone || !password) return 'staff login: skipped (set STAFF_PHONE and STAFF_PASSWORD to create one)';
  if (!/^\+\d{8,15}$/.test(phone)) return 'staff login: skipped — STAFF_PHONE must look like +970599111222';
  if (!strongPassword(password)) return 'staff login: skipped — STAFF_PASSWORD needs 8+ characters with upper and lower case, a number and a symbol';
  const user = await User.findOne({ phone });
  if (!user) {
    await User.create({ fullName: process.env.STAFF_NAME || 'Clinic Admin', phone, passwordHash: await bcrypt.hash(password, 10), phoneVerified: true, role: 'admin' });
    return `staff login: created ${phone}`;
  }
  let changed = false;
  if (user.role !== 'admin') (user.role = 'admin'), (changed = true);
  if (process.env.STAFF_RESET_PASSWORD === 'true') (user.passwordHash = await bcrypt.hash(password, 10)), (changed = true);
  if (changed) await user.save();
  return `staff login: ${phone} ${changed ? 'updated' : 'already there'}`;
}

/** Runs every step; a failing step is logged and never stops the server. */
async function autoSeed() {
  if ((process.env.AUTO_SEED || 'on').toLowerCase() === 'off') return;
  for (const step of [seedProducts, seedDoctors, seedStaff]) {
    try {
      console.log(`Auto-seed → ${await step()}`);
    } catch (e) {
      console.error(`Auto-seed (${step.name}) failed:`, e.message);
    }
  }
}

module.exports = { autoSeed };
