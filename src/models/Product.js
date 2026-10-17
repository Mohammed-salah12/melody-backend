const { Schema, model } = require('mongoose');

const CATEGORIES = [
  'cleanser', 'toner', 'serum', 'treatment', 'moisturizer', 'sunscreen', 'mask', 'eye', // face
  'body', 'makeup', 'hair', 'oral', 'hand-foot', 'personal',
];
/** Shop groups ("Our available items" filter) → categories. */
const GROUPS = {
  face: ['cleanser', 'toner', 'serum', 'treatment', 'moisturizer', 'sunscreen', 'mask', 'eye'],
  body: ['body'],
  hair: ['hair'],
  oral: ['oral'],
  makeup: ['makeup'],
  'hand-foot': ['hand-foot'],
  personal: ['personal'],
};
const SKIN_TYPES = ['dry', 'oily', 'combination', 'normal', 'sensitive'];
const CONCERNS = ['dehydration', 'oil', 'redness', 'pigmentation', 'texture', 'pores', 'wrinkles', 'barrier', 'acne'];

const productSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    brand: { type: String, required: true, trim: true, maxlength: 80 },
    category: { type: String, enum: CATEGORIES, required: true, index: true },
    description: { type: String, trim: true, maxlength: 2000 },
    price: { type: Number, min: 0, required: true }, // regular price
    salePercent: { type: Number, min: 0, max: 90, default: 0 }, // "15% OFFER" — the app shows price − salePercent
    currency: { type: String, default: 'USD', maxlength: 3 },
    size: String, // "50 ml"
    imageUrl: String, // external image; or upload one with POST /products/:id/image
    hasImage: { type: Boolean, default: false }, // true when an uploaded image exists

    // what the matcher uses
    skinTypes: { type: [{ type: String, enum: SKIN_TYPES }], default: [] }, // empty = all skin types
    concerns: { type: [{ type: String, enum: CONCERNS }], default: [] }, // what the product is made for
    ingredients: { type: [String], default: [] }, // key actives, lower-case, e.g. "hyaluronic acid"
    routine: { type: String, enum: ['morning', 'evening', 'both'], default: 'both' },
    fragranceFree: { type: Boolean, default: false },
    nonComedogenic: { type: Boolean, default: false },

    // shop
    stock: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true, index: true },
    badges: { type: [String], default: [] }, // "New", "15% off", …
    rating: { type: Number, min: 0, max: 5 },
    reviews: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true },
);

productSchema.index({ name: 'text', brand: 'text', description: 'text', ingredients: 'text' });

productSchema.pre('validate', function normalise() {
  if (this.ingredients) this.ingredients = this.ingredients.map((i) => String(i).trim().toLowerCase()).filter(Boolean);
});

productSchema.methods.toPublic = function toPublic() {
  const o = this.toObject({ versionKey: false });
  o.id = o._id.toString();
  delete o._id;
  o.finalPrice = finalPrice(o);
  return o;
};

/** What the customer pays (regular price minus the sale percent), 2 decimals. */
function finalPrice(p) {
  const pct = Math.max(0, Math.min(90, Number(p.salePercent) || 0));
  return Math.round(p.price * (1 - pct / 100) * 100) / 100;
}

const Product = model('Product', productSchema);
module.exports = Product;
module.exports.CATEGORIES = CATEGORIES;
module.exports.SKIN_TYPES = SKIN_TYPES;
module.exports.CONCERNS = CONCERNS;
module.exports.GROUPS = GROUPS;
module.exports.finalPrice = finalPrice;
