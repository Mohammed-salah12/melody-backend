const { Schema, model } = require('mongoose');

/** A photo, voice note or document sent in a consultation chat (max 8 MB). */
const schema = new Schema(
  {
    appointment: { type: Schema.Types.ObjectId, ref: 'Appointment', required: true, index: true },
    data: { type: Buffer, required: true },
    mime: { type: String, required: true },
    name: String,
    size: Number,
  },
  { timestamps: true },
);
module.exports = model('ChatFile', schema);
