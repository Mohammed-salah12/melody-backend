const { Schema, model } = require('mongoose');

// Uploaded product photo, kept separate so product lists stay small.
const productImageSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true, unique: true },
    contentType: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp'], required: true },
    data: { type: Buffer, required: true },
  },
  { timestamps: true },
);

module.exports = model('ProductImage', productImageSchema);
