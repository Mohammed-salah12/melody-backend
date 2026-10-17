/**
 * Photo-quality checks for one camera frame, on top of the light / distance / stillness checks in
 * skin-analyzer.js:
 *   - sharpness: is the face in focus? (strong edges on eyes, brows, lips stay strong when sharp)
 *   - shadow:    is one side of the face much darker than the other?
 *   - warmth:    is the light very yellow/orange (indoor bulbs)? That makes skin look redder.
 * Plus one 0–100 photo-quality score, used for the scan's confidence.
 *
 * Thresholds were set on test photos (sharp vs. blurred, side-lit, warm-tinted); they are kept
 * loose on purpose — a blurry frame is rejected only when it is clearly blurry.
 */
const { resampleRegion, percentile, clamp } = require('./image');

const W = 200;
const BLUR_REJECT = 16; // below: clearly blurry → frame not used
const BLUR_WARN = 26; // below: a bit soft → tip, frame still used
const SHADOW_REJECT = 0.45;
const SHADOW_WARN = 0.3;
const WARM_WARN = 2.1;

function isSkin(r, g, b) {
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return cr >= 133 && cr <= 180 && cb >= 77 && cb <= 135;
}

/**
 * @param img decoded frame { width, height, data }
 * @param box face box in frame pixels
 */
function photoChecks(img, box) {
  const h = Math.max(60, Math.round((box.h / box.w) * W));
  const crop = resampleRegion(img, box, W, h);
  const L = new Float32Array(W * h);
  for (let p = 0; p < W * h; p++) L[p] = 0.299 * crop.data[p * 4] + 0.587 * crop.data[p * 4 + 1] + 0.114 * crop.data[p * 4 + 2];

  // sharpness: 97th percentile of the local gradient inside the face (features, not background)
  const grads = [];
  for (let y = Math.floor(h * 0.15); y < Math.ceil(h * 0.85); y++) {
    for (let x = Math.floor(W * 0.12); x < Math.ceil(W * 0.88); x++) {
      const p = y * W + x;
      grads.push(Math.abs(L[p + 1] - L[p - 1]) + Math.abs(L[p + W] - L[p - W]));
    }
  }
  const faceL = [];
  for (let y = Math.floor(h * 0.15); y < Math.ceil(h * 0.85); y += 2) for (let x = Math.floor(W * 0.12); x < Math.ceil(W * 0.88); x += 2) faceL.push(L[y * W + x]);
  const contrast = Math.max(20, percentile(faceL, 0.95) - percentile(faceL, 0.05));
  // relative to the face's own contrast, so dim or low-contrast faces aren't called blurry
  const sharpness = Math.round((percentile(grads, 0.97) / contrast) * 1000) / 10;

  // shadow: left third vs right third of the skin (cheeks)
  let lSum = 0, lN = 0, rSum = 0, rN = 0;
  for (let y = Math.floor(h * 0.3); y < Math.ceil(h * 0.8); y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (!isSkin(crop.data[p * 4], crop.data[p * 4 + 1], crop.data[p * 4 + 2])) continue;
      if (x < W / 3) (lSum += L[p]), lN++;
      else if (x > (2 * W) / 3) (rSum += L[p]), rN++;
    }
  }
  const lm = lN ? lSum / lN : 0;
  const rm = rN ? rSum / rN : 0;
  const shadow = lN > 30 && rN > 30 ? Math.round((Math.abs(lm - rm) / Math.max(lm, rm, 1)) * 100) / 100 : 0;

  // warmth: red/blue balance of the skin (daylight ≈ 1.3–1.9, warm bulbs push it well above 2)
  let R = 0, B = 0;
  for (let p = 0; p < W * h; p += 3) {
    const r = crop.data[p * 4], g = crop.data[p * 4 + 1], b = crop.data[p * 4 + 2];
    if (!isSkin(r, g, b)) continue;
    R += r;
    B += b;
  }
  const warmth = Math.round((R / Math.max(1, B)) * 100) / 100;

  const blur = sharpness < BLUR_REJECT ? 'blurry' : sharpness < BLUR_WARN ? 'soft' : 'sharp';
  const sideShadow = shadow > SHADOW_REJECT ? 'strong' : shadow > SHADOW_WARN ? 'some' : 'none';
  const warmLight = warmth > WARM_WARN;
  return { sharpness, blur, shadow, sideShadow, warmth, warmLight };
}

/** 0–100 photo-quality score for one frame (light, focus, shadow, distance, colour). */
function frameScore(q) {
  if (!q?.faceFound) return 0;
  let s = 100;
  const b = q.brightness ?? 150;
  if (b < 90) s -= (90 - b) * 0.6;
  if (b > 210) s -= (b - 210) * 0.8;
  if (q.sharpness != null) s -= clamp((36 - q.sharpness) * 2.2, 0, 45);
  if (q.shadow != null) s -= clamp((q.shadow - 0.2) * 90, 0, 35);
  if (q.warmLight) s -= 10;
  if (q.distance && q.distance !== 'good') s -= 20;
  if (q.still === false) s -= 10;
  return Math.round(clamp(s));
}

module.exports = { photoChecks, frameScore, BLUR_REJECT, BLUR_WARN };
