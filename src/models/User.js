const { Schema, model } = require('mongoose');

const userSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, required: true, unique: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    phoneVerified: { type: Boolean, default: false },
    birthDate: Date,
    address: String,
    gender: String,
    maritalStatus: String,
    health: {
      skinCondition: String,
      medications: String,
      productAllergy: String,
      ingredientAllergy: String,
    },
    acceptedTerms: { type: Boolean, default: false },
    // opt-in: share scan photos (face crop) to train Melody's skin model
    trainingConsent: { granted: { type: Boolean, default: false }, at: Date },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    // shop
    addresses: [
      {
        fullName: { type: String, required: true, trim: true, maxlength: 120 },
        street: { type: String, required: true, trim: true, maxlength: 200 },
        suite: { type: String, trim: true, maxlength: 100 },
        city: { type: String, required: true, trim: true, maxlength: 100 },
        state: { type: String, trim: true, maxlength: 100 },
        zip: { type: String, trim: true, maxlength: 20 },
        country: { type: String, trim: true, maxlength: 80, default: 'Palestine' },
        phone: { type: String, trim: true, maxlength: 30 },
        isDefault: { type: Boolean, default: false },
      },
    ],
    // display-only card info (brand, last 4, expiry) — the full number and CVV are never stored
    cards: [
      {
        brand: String,
        last4: { type: String, match: /^\d{4}$/ },
        expMonth: Number,
        expYear: Number,
        holder: String,
      },
    ],
  },
  { timestamps: true },
);

userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    fullName: this.fullName,
    phone: this.phone,
    email: this.email,
    phoneVerified: this.phoneVerified,
    role: this.role,
    trainingConsent: !!this.trainingConsent?.granted,
  };
};

module.exports = model('User', userSchema);
