const { Schema, model } = require('mongoose');

module.exports = model(
  'DoctorImage',
  new Schema({
    doctor: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true, unique: true },
    contentType: { type: String, required: true },
    data: { type: Buffer, required: true },
  }),
);
