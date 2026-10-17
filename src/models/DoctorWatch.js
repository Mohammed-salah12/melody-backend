const { Schema, model } = require('mongoose');

/** "Notify me when available" — shown as a skin alert once the doctor is available. */
const schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    doctor: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true },
    notifiedAt: Date,
  },
  { timestamps: true },
);
schema.index({ user: 1, doctor: 1 }, { unique: true });
module.exports = model('DoctorWatch', schema);
