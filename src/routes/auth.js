const bcrypt = require('bcryptjs');
const { Router } = require('express');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const User = require('../models/User');
const { HttpError, need } = require('../lib/http');
const { signSession, signReset, verify, issueOtp, checkOtp } = require('../lib/tokens');
const { requireAuth } = require('../middleware/auth');

const router = Router();
router.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false }));

const normPhone = (p) => String(p).replace(/[\s()-]/g, '');
const dev = (code) => (config.isProd ? {} : { devCode: code });

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || !/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw) || !/[^A-Za-z0-9]/.test(pw)) {
    throw new HttpError(400, 'Password needs 8+ characters with upper and lower case letters, a number and a symbol.');
  }
}

/** POST /auth/register — create (or refresh) an unverified account and text a code. */
router.post('/register', async (req, res) => {
  const { fullName, phone: rawPhone, password } = need(req.body, 'fullName', 'phone', 'password');
  checkPassword(password);
  const phone = normPhone(rawPhone);
  const b = req.body;

  const existing = await User.findOne({ phone });
  if (existing?.phoneVerified) throw new HttpError(409, 'An account with this phone number already exists. Please log in.');

  const fields = {
    fullName,
    phone,
    email: b.email,
    passwordHash: await bcrypt.hash(password, 10),
    birthDate: b.birthDate ? new Date(b.birthDate) : undefined,
    address: b.address,
    gender: b.gender,
    maritalStatus: b.maritalStatus,
    health: {
      skinCondition: b.skinCondition,
      medications: b.medications,
      productAllergy: b.productAllergy,
      ingredientAllergy: b.ingredientAllergy,
    },
    acceptedTerms: Boolean(b.acceptedTerms),
  };
  if (existing) await existing.set(fields).save();
  else await User.create(fields);

  const code = await issueOtp(phone, 'verify');
  res.status(201).json({ message: 'We sent a 5-digit code to your phone.', ...dev(code) });
});

/** POST /auth/verify-phone — confirm the code, return a session. */
router.post('/verify-phone', async (req, res) => {
  const { phone: rawPhone, code } = need(req.body, 'phone', 'code');
  const phone = normPhone(rawPhone);
  await checkOtp(phone, 'verify', code);
  const user = await User.findOne({ phone });
  if (!user) throw new HttpError(404, 'Account not found.');
  user.phoneVerified = true;
  await user.save();
  res.json({ token: signSession(user), user: user.toPublic() });
});

/** POST /auth/login */
router.post('/login', async (req, res) => {
  const { phone: rawPhone, password } = need(req.body, 'phone', 'password');
  const user = await User.findOne({ phone: normPhone(rawPhone) }).select('+passwordHash');
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new HttpError(401, 'Wrong phone number or password.');
  }
  if (!user.phoneVerified) throw new HttpError(403, 'Please verify your phone number first.');
  res.json({ token: signSession(user), user: user.toPublic() });
});

/** POST /auth/forgot-password — text a reset code (same answer whether or not the phone exists). */
router.post('/forgot-password', async (req, res) => {
  const phone = normPhone(need(req.body, 'phone').phone);
  const user = await User.findOne({ phone });
  const code = user ? await issueOtp(phone, 'reset') : undefined;
  res.json({ message: 'If this number has an account, we sent a code to it.', ...(code ? dev(code) : {}) });
});

/** POST /auth/verify-reset-code → { resetToken } */
router.post('/verify-reset-code', async (req, res) => {
  const { phone: rawPhone, code } = need(req.body, 'phone', 'code');
  const phone = normPhone(rawPhone);
  await checkOtp(phone, 'reset', code);
  res.json({ resetToken: signReset(phone) });
});

/** POST /auth/reset-password { resetToken, password } */
router.post('/reset-password', async (req, res) => {
  const { resetToken, password } = need(req.body, 'resetToken', 'password');
  checkPassword(password);
  const { phone } = verify(resetToken, 'reset');
  const { matchedCount } = await User.updateOne({ phone }, { passwordHash: await bcrypt.hash(password, 10) });
  if (!matchedCount) throw new HttpError(404, 'Account not found.');
  res.json({ message: 'Your password has been changed.' });
});

/** GET /auth/me */
/**
 * GET /auth/me — the logged-in user plus a fresh 30-day token. The app calls this when it opens,
 * so anyone who uses the app at least once a month stays logged in.
 */
router.get('/me', requireAuth, (req, res) => res.json({ user: req.user.toPublic(), token: signSession(req.user) }));

module.exports = router;
