const { Schema, model } = require('mongoose');

const orderSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    number: { type: String, required: true, unique: true }, // "MB-8829"
    items: [
      {
        product: { type: Schema.Types.ObjectId, ref: 'Product' },
        name: String,
        brand: String,
        size: String,
        category: String,
        unitPrice: Number, // price paid per item (after the offer)
        regularPrice: Number,
        qty: Number,
        hasImage: Boolean,
        imageUrl: String,
      },
    ],
    currency: { type: String, default: 'USD' },
    subtotal: Number,
    shipping: Number,
    total: Number,
    address: {
      fullName: String,
      street: String,
      suite: String,
      city: String,
      state: String,
      zip: String,
      country: String,
      phone: String,
    },
    payment: {
      method: { type: String, enum: ['card', 'bank'] },
      brand: String,
      last4: String,
      status: { type: String, enum: ['paid', 'pending', 'failed'], default: 'pending' },
      provider: String, // 'test' until a real payment provider is connected
    },
    status: { type: String, enum: ['confirmed', 'awaiting_payment', 'shipped', 'delivered', 'cancelled'], default: 'confirmed', index: true },
    estimatedDelivery: Date,
  },
  { timestamps: true },
);

orderSchema.methods.toPublic = function toPublic() {
  const o = this.toObject({ versionKey: false });
  o.id = o._id.toString();
  delete o._id;
  delete o.user;
  return o;
};

module.exports = model('Order', orderSchema);
