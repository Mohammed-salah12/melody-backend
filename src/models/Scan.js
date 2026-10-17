const { Schema, model } = require('mongoose');

const metricsShape = {
  hydration: Number, // 0–100 (higher = more hydrated-looking)
  oil: Number, // 0–100 (higher = more shine / sebum)
  redness: Number, // 0–100 (higher = more redness)
  pigmentation: Number, // 0–100 (higher = more spots / uneven tone)
  texture: Number, // 0–100 (higher = rougher)
  pores: Number, // 0–100 (higher = more visible pores)
  wrinkles: Number, // 0–100 (higher = more fine lines)
  evenness: Number, // 0–100 (higher = more even tone)
};

const frameSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    step: { type: String, default: 'front' }, // front | side1 | side2 | up
    headPose: { yaw: Number, pitch: Number, asym: Number },
    accepted: Boolean,
    quality: {
      faceFound: Boolean,
      brightness: Number,
      light: String,
      distance: String,
      motion: Number,
      still: Boolean,
      sharpness: Number,
      blur: String,
      shadow: Number,
      sideShadow: String,
      warmth: Number,
      warmLight: Boolean,
      score: Number, // 0–100 photo quality
    },
    metrics: metricsShape,
    zones: { tzoneOil: Number, cheekOil: Number, cheekHydration: Number }, // T-zone vs cheeks
    poreStats: { count: Number, perCm2: Number, avgSizeMm: Number, score: Number, mmPerPx: Number },
  },
  { _id: false },
);

const scanSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: ['in_progress', 'complete', 'abandoned'], default: 'in_progress' },
    source: { type: String, default: 'camera' }, // later: 'smart-pen'
    frames: [frameSchema],
    lastSignature: { type: [Number], select: false }, // tiny greyscale thumb of the previous frame, for motion
    side1Sign: Number, // which way the user turned first (+1 / -1), so the second turn is the other way
    stepAttempts: { type: Map, of: Number, default: {} }, // good-quality frames that missed the pose, per step
    thumbnail: { type: String, select: false }, // small JPEG (base64) of the best front frame, for before/after
    thumbnailArea: { type: Number, select: false },
    faceCrop: { type: Buffer, select: false }, // best front face crop, kept only until the scan is completed
    faceCropArea: { type: Number, select: false },
    results: {
      score: Number,
      metrics: metricsShape,
      zones: { tzoneOil: Number, cheekOil: Number, cheekHydration: Number },
      pores: { measured: Boolean, count: Number, perCm2: Number, avgSizeMm: Number, framesUsed: Number },
      skinType: String,
      concerns: [String],
      recommendations: [{ title: String, reason: String }],
      framesUsed: Number,
      model: { version: String, blend: Object }, // when the trained skin model contributed
      // how sure we are: photo quality of the frames used, and a ± range / level per measurement
      quality: { score: Number, level: String, sharp: Boolean, evenLight: Boolean, warmLight: Boolean, notes: [String] },
      confidence: { type: Object },
    },
    completedAt: Date,
  },
  { timestamps: true },
);

module.exports = model('Scan', scanSchema);
