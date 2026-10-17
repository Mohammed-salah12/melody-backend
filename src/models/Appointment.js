const { Schema, model } = require('mongoose');

const appointmentSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    doctor: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true, index: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    type: { type: String, enum: ['video', 'chat'], default: 'video' },
    problem: { type: String, maxlength: 60 },
    note: { type: String, maxlength: 500 }, // from the patient
    status: { type: String, enum: ['requested', 'booked', 'cancelled', 'completed', 'no_show', 'missed'], default: 'booked', index: true },
    free: { type: Boolean, default: false }, // used one of the free consultations
    instant: { type: Boolean, default: false }, // "Chat" now — waits for the doctor to accept
    acceptedAt: Date,
    endedAt: Date,
    endedBy: { type: String, enum: ['patient', 'doctor'] },
    patientTypingAt: Date,
    doctorTypingAt: Date,
    // the doctor asks to see the patient's skin tracking from the last 7 days; the patient decides
    reportAccess: {
      status: { type: String, enum: ['none', 'requested', 'approved', 'declined'], default: 'none' },
      requestedAt: Date,
      decidedAt: Date,
    },
    scanId: { type: Schema.Types.ObjectId, ref: 'Scan' }, // latest scan shared with the doctor
    // written by the doctor/admin when the consultation is completed → Clinical Archive
    summary: { type: String, maxlength: 3000 },
    protocol: [{ product: { type: Schema.Types.ObjectId, ref: 'Product' }, name: String, note: String }],
    durationMinutes: Number,
    completedAt: Date,
  },
  { timestamps: true },
);
// one booking per doctor per start time (cancelled ones free the slot again)
appointmentSchema.index({ doctor: 1, start: 1, status: 1 });

module.exports = model('Appointment', appointmentSchema);
