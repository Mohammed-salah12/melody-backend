const { Schema, model } = require('mongoose');

const SPECIALTIES = ['acne', 'pigmentation', 'eczema', 'anti-aging', 'scarring', 'laser', 'dryness', 'sensitivity'];

const doctorSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    title: { type: String, default: 'Dermatologist', trim: true, maxlength: 80 },
    bio: { type: String, trim: true, maxlength: 600 }, // "Expert in treating dry and sensitive skin"
    about: { type: String, trim: true, maxlength: 4000 }, // long "About" text on the doctor page
    expertise: { type: [String], default: [] }, // extra expertise lines, e.g. "Clinical Dermatology"
    yearsExperience: { type: Number, min: 0, max: 70, default: 0 },
    specialties: { type: [{ type: String, enum: SPECIALTIES }], default: [] },
    consultTypes: { type: [{ type: String, enum: ['video', 'chat'] }], default: ['video', 'chat'] },
    rating: { type: Number, min: 0, max: 5, default: 0 },
    reviews: { type: Number, min: 0, default: 0 },
    imageUrl: String,
    hasImage: { type: Boolean, default: false },
    // working hours in clinic time: days 0 = Sunday … 6 = Saturday, hours "09:00"–"21:00"
    workDays: { type: [Number], default: [0, 1, 2, 3, 4, 6] },
    startHour: { type: Number, min: 0, max: 23, default: 9 },
    endHour: { type: Number, min: 1, max: 24, default: 21 }, // last slot starts endHour-1
    breakUntil: Date, // "On break" until this time (set by admin)
    fastTrack: { type: Boolean, default: false }, // same-day priority slots
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

doctorSchema.methods.toPublic = function toPublic() {
  const o = this.toObject({ versionKey: false });
  o.id = o._id.toString();
  delete o._id;
  return o;
};

const Doctor = model('Doctor', doctorSchema);
module.exports = Doctor;
module.exports.SPECIALTIES = SPECIALTIES;
