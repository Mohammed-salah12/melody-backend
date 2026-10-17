const { Schema, model } = require('mongoose');

/** One day of the Daily Routine: did the user do their morning / evening ritual, and when. */
const ritual = {
  done: { type: Boolean, default: false },
  at: Date,
  steps: { type: [String], default: undefined }, // keys of the steps ticked ("cleanser:<productId>")
  rating: { type: Number, min: 1, max: 5 }, // "Rate your experience"
};
const routineLogSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date: { type: String, required: true }, // YYYY-MM-DD in the user's own time zone (sent by the app)
    morning: ritual,
    evening: ritual,
  },
  { timestamps: true },
);
routineLogSchema.index({ user: 1, date: 1 }, { unique: true });

module.exports = model('RoutineLog', routineLogSchema);
