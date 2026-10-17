const { Schema, model } = require('mongoose');

/**
 * Daily health data that affects the skin (sleep for now). Sent by the app — later from
 * Apple Health / Google Health Connect — with POST /health/sleep.
 */
const healthLogSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date: { type: String, required: true }, // YYYY-MM-DD (the morning the user woke up)
    sleepHours: { type: Number, min: 0, max: 24 },
    source: { type: String, default: 'manual' }, // manual | apple-health | health-connect
  },
  { timestamps: true },
);
healthLogSchema.index({ user: 1, date: 1 }, { unique: true });

module.exports = model('HealthLog', healthLogSchema);
