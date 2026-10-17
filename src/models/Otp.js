const { Schema, model } = require('mongoose');

// One-time codes for phone verification and password reset. Mongo deletes them after expiry.
const otpSchema = new Schema({
  phone: { type: String, required: true, index: true },
  purpose: { type: String, enum: ['verify', 'reset'], required: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

module.exports = model('Otp', otpSchema);
