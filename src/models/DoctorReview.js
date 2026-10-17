const { Schema, model } = require('mongoose');

/** A patient's review — only allowed after a completed consultation with that doctor. */
const schema = new Schema(
  {
    doctor: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    appointment: { type: Schema.Types.ObjectId, ref: 'Appointment', required: true, unique: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    text: { type: String, trim: true, maxlength: 1000 },
    authorName: String, // "Sarah M." (first name + last initial)
    hidden: { type: Boolean, default: false }, // moderation
  },
  { timestamps: true },
);
module.exports = model('DoctorReview', schema);
