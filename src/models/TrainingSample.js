const { Schema, model } = require('mongoose');

/**
 * A face photo the user agreed to share for improving the scan model, with the rule-based
 * measurements and (once a doctor grades it) the dermatologist labels used for training.
 * Deleted when the user withdraws consent.
 *
 * Labels use the same direction as the app's metrics, on a 1–5 scale:
 *   hydration 5 = very well hydrated · oil 5 = very oily · redness/pigmentation/texture/pores/wrinkles 5 = very visible
 */
const LABEL_KEYS = ['hydration', 'oil', 'redness', 'pigmentation', 'texture', 'pores', 'wrinkles'];

const gradeSchema = new Schema(
  {
    by: { type: Schema.Types.ObjectId, ref: 'User' },
    at: Date,
    ...Object.fromEntries(LABEL_KEYS.map((k) => [k, { type: Number, min: 1, max: 5 }])),
    fitzpatrick: { type: Number, min: 1, max: 6 }, // skin tone I–VI, to check the model is fair to every tone
  },
  { _id: false },
);

const schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    scan: { type: Schema.Types.ObjectId, ref: 'Scan', index: true },
    image: { type: Buffer, required: true, select: false }, // square face crop, JPEG
    ruleMetrics: Object, // what the rule-based analyzer measured (0–100), to compare against
    grades: { type: [gradeSchema], default: [] }, // one per doctor (several doctors = more reliable labels)
    gradeCount: { type: Number, default: 0, index: true },
    unusable: { type: Number, default: 0 }, // doctors who marked the photo as unusable (blur, makeup, filter…)
  },
  { timestamps: true },
);

module.exports = model('TrainingSample', schema);
module.exports.LABEL_KEYS = LABEL_KEYS;
