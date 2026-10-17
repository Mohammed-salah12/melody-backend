const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const config = require('../config');
const Otp = require('../models/Otp');
const { HttpError } = require('./http');

const signSession = (user) => jwt.sign({ sub: user._id.toString(), typ: 'session' }, config.jwtSecret, { expiresIn: config.tokenTtl });
const signReset = (phone) => jwt.sign({ phone, typ: 'reset' }, config.jwtSecret, { expiresIn: '15m' });

function verify(token, typ) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (payload.typ !== typ) throw new Error('wrong type');
    return payload;
  } catch {
    throw new HttpError(401, typ === 'reset' ? 'This reset link has expired. Please start again.' : 'Please log in again.');
  }
}

/** Create a 5-digit code, store its hash and "send" it. Returns the code so dev builds can show it. */
async function issueOtp(phone, purpose) {
  const code = config.fixedOtp ?? String(crypto.randomInt(0, 100000)).padStart(5, '0');
  await Otp.deleteMany({ phone, purpose });
  await Otp.create({
    phone,
    purpose,
    codeHash: await bcrypt.hash(code, 8),
    expiresAt: new Date(Date.now() + config.otpTtlMinutes * 60 * 1000),
  });
  // TODO: send by SMS (Twilio / Vonage / local provider). Until then it is printed here.
  console.log(`[otp] ${purpose} code for ${phone}: ${code}`);
  return code;
}

async function checkOtp(phone, purpose, code) {
  const otp = await Otp.findOne({ phone, purpose });
  if (!otp || otp.expiresAt < new Date()) throw new HttpError(400, 'This code has expired. Please request a new one.');
  if (otp.attempts >= 5) throw new HttpError(429, 'Too many attempts. Please request a new code.');
  if (!(await bcrypt.compare(String(code), otp.codeHash))) {
    otp.attempts += 1;
    await otp.save();
    throw new HttpError(400, 'That code is not correct.');
  }
  await otp.deleteOne();
}

module.exports = { signSession, signReset, verify, issueOtp, checkOtp };
