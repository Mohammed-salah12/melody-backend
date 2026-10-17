const { Schema, model } = require('mongoose');

/** Chat messages of a consultation (patient ↔ doctor). Photos, voice notes and files live in ChatFile. */
const schema = new Schema(
  {
    appointment: { type: Schema.Types.ObjectId, ref: 'Appointment', required: true, index: true },
    from: { type: String, enum: ['patient', 'doctor', 'system'], required: true },
    kind: { type: String, enum: ['text', 'image', 'audio', 'file', 'product', 'report'], default: 'text' },
    text: { type: String, maxlength: 2000, default: '' },
    file: { type: Schema.Types.ObjectId, ref: 'ChatFile' },
    fileName: { type: String, maxlength: 200 },
    mime: String,
    size: Number,
    durationSec: Number, // voice notes
    // "Suggested Treatment" card sent by the doctor (snapshot of the product + match score)
    product: { type: Schema.Types.ObjectId, ref: 'Product' },
    productName: String,
    productImage: String,
    match: Number,
    // skin report (PDF) sent by the doctor
    reportCode: String,
    scan: { type: Schema.Types.ObjectId, ref: 'Scan' },
  },
  { timestamps: true },
);
schema.index({ appointment: 1, createdAt: 1 });
module.exports = model('Message', schema);
