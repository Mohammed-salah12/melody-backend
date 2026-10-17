/**
 * Melody Beauty skin analyzer — v0 (computer-vision baseline).
 *
 * Takes one camera frame (JPEG) and returns:
 *   - quality: is a face in frame, is the light OK, is the user too far/close, are they still
 *   - metrics: 0–100 estimates for hydration, oil, redness, pigmentation, texture, pores,
 *              wrinkles and tone evenness, measured on the skin inside the face box
 *
 * How it works: skin pixels are found with a YCbCr colour rule, the face box is cropped and
 * resized to a fixed size, converted to CIE Lab, and each metric is a measurable image
 * statistic in a face zone (e.g. redness = mean a*, texture = fine-detail energy, oil = share
 * of specular highlights in the T-zone).
 *
 * These are *indicators*, not a diagnosis. The calibration constants below are first guesses;
 * once real scans are collected (and labelled by a dermatologist) they should be tuned, or the
 * whole module replaced by a trained model behind the same `analyzeFrame` interface.
 */
const { measurePores } = require('./pores');
const { photoChecks, frameScore } = require('./photo-quality');
const { decodeJpeg, encodeJpeg, resampleRegion, toLab, boxBlur, clamp, percentile } = require('./image');

const FACE_W = 120; // normalised face width in px

function isSkin(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 40 && y < 250 && cr >= 133 && cr <= 180 && cb >= 77 && cb <= 135;
}

/** Find the face box from skin pixels on a small copy of the frame. */
function findFace(img) {
  const W = 160;
  const H = Math.round((img.height / img.width) * W);
  const small = resampleRegion(img, { x: 0, y: 0, w: img.width, h: img.height }, W, H);
  const xs = [];
  const ys = [];
  let lumaSum = 0;
  let lumaSq = 0;
  for (let y = 0; y < H; y++) {
    for (let x = Math.floor(W * 0.06); x < Math.ceil(W * 0.94); x++) {
      const i = (y * W + x) * 4;
      const r = small.data[i], g = small.data[i + 1], b = small.data[i + 2];
      if (isSkin(r, g, b)) {
        xs.push(x);
        ys.push(y);
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        lumaSum += l;
        lumaSq += l * l;
      }
    }
  }
  const skinShare = xs.length / (W * H);
  if (skinShare < 0.025) return { found: false, skinShare };

  const x0 = percentile(xs, 0.04), x1 = percentile(xs, 0.96);
  const y0 = percentile(ys, 0.03);
  let y1 = percentile(ys, 0.97);
  const w = Math.max(1, x1 - x0);
  // ignore the neck: faces are ~1.35× taller than wide
  if (y1 - y0 > 1.4 * w) y1 = y0 + 1.35 * w;
  const h = Math.max(1, y1 - y0);

  const meanLuma = lumaSum / xs.length;
  const scale = img.width / W;
  return {
    found: true,
    skinShare,
    meanLuma,
    lumaStd: Math.sqrt(Math.max(0, lumaSq / xs.length - meanLuma * meanLuma)),
    box: { x: x0 * scale, y: y0 * scale, w: w * scale, h: h * scale },
    heightShare: h / H,
    centerX: (x0 + w / 2) / W,
    centerY: (y0 + h / 2) / H,
  };
}

/** 16×16 greyscale signature of the face crop, used to tell if the user is holding still. */
function signature(face) {
  const s = resampleRegion(face, { x: 0, y: 0, w: face.width, h: face.height }, 16, 16);
  const out = [];
  for (let i = 0; i < 256; i++) out.push(Math.round((s.data[i * 4] + s.data[i * 4 + 1] + s.data[i * 4 + 2]) / 3));
  return out;
}

function zoneMean(values, mask, w, h, u0, u1, v0, v1) {
  let s = 0, n = 0;
  for (let y = Math.floor(v0 * h); y < Math.ceil(v1 * h); y++) {
    for (let x = Math.floor(u0 * w); x < Math.ceil(u1 * w); x++) {
      const p = y * w + x;
      if (mask[p]) {
        s += values[p];
        n++;
      }
    }
  }
  return n ? s / n : 0;
}

function measureSkin(face) {
  const w = face.width;
  const h = face.height;
  const n = w * h;
  const mask = new Uint8Array(n);
  let skinCount = 0;
  for (let p = 0; p < n; p++) {
    if (isSkin(face.data[p * 4], face.data[p * 4 + 1], face.data[p * 4 + 2])) {
      mask[p] = 1;
      skinCount++;
    }
  }
  const { L, A, B } = toLab(face);

  // remove large-scale lighting so only local detail is left
  const Lbig = boxBlur(L, w, h, 8);
  const Lsmall = boxBlur(L, w, h, 1);
  const residual = new Float32Array(n);
  const fine = new Float32Array(n);
  const gy = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      residual[p] = L[p] - Lbig[p];
      fine[p] = Math.abs(L[p] - Lsmall[p]);
      gy[p] = Math.max(0, Math.abs(L[p + w] - L[p - w]) - Math.abs(L[p + 1] - L[p - 1]));
    }
  }

  // tone + redness over all skin
  let aSum = 0, rSq = 0, cnt = 0, spots = 0, fineSum = 0;
  for (let p = 0; p < n; p++) {
    if (!mask[p]) continue;
    aSum += A[p];
    rSq += residual[p] * residual[p];
    fineSum += fine[p];
    cnt++;
  }
  const meanA = cnt ? aSum / cnt : 0;
  const localStd = cnt ? Math.sqrt(rSq / cnt) : 0;
  // dark spots: only on forehead + cheeks, so eyes, brows, nostrils and lips don't count
  const spotZones = [
    [0.22, 0.78, 0.08, 0.26],
    [0.1, 0.38, 0.5, 0.75],
    [0.62, 0.9, 0.5, 0.75],
  ];
  let zoneSkin = 0;
  for (const [u0, u1, v0, v1] of spotZones) {
    for (let y = Math.floor(v0 * h); y < Math.ceil(v1 * h); y++) {
      for (let x = Math.floor(u0 * w); x < Math.ceil(u1 * w); x++) {
        const p = y * w + x;
        if (!mask[p]) continue;
        zoneSkin++;
        if (residual[p] < -Math.max(5, 2.2 * localStd) && B[p] > 10) spots++;
      }
    }
  }
  const spotShare = zoneSkin ? spots / zoneSkin : 0;

  // zones (u = across, v = down the face box)
  const cheeks =
    (zoneMean(fine, mask, w, h, 0.12, 0.38, 0.5, 0.72) + zoneMean(fine, mask, w, h, 0.62, 0.88, 0.5, 0.72)) / 2;
  const foreheadLines = zoneMean(gy, mask, w, h, 0.25, 0.75, 0.08, 0.28);
  const eyeLines =
    (zoneMean(gy, mask, w, h, 0.05, 0.25, 0.33, 0.5) + zoneMean(gy, mask, w, h, 0.75, 0.95, 0.33, 0.5)) / 2;

  // shine: bright, colourless pixels in the T-zone (forehead + nose)
  const tL = [];
  for (let y = Math.floor(0.1 * h); y < Math.ceil(0.72 * h); y++) {
    for (let x = Math.floor(0.36 * w); x < Math.ceil(0.64 * w); x++) {
      const p = y * w + x;
      if (L[p] > 20) tL.push(L[p]);
    }
  }
  // a highlight must be brighter than its surroundings (specular), bright and nearly colourless
  const p95 = percentile(tL, 0.95);
  let shiny = 0;
  for (let y = Math.floor(0.1 * h); y < Math.ceil(0.72 * h); y++) {
    for (let x = Math.floor(0.36 * w); x < Math.ceil(0.64 * w); x++) {
      const p = y * w + x;
      const chroma = Math.hypot(A[p], B[p]);
      if (L[p] >= Math.max(p95, 70) && L[p] - Lbig[p] > 5 && chroma < 14) shiny++;
    }
  }
  const shineShare = tL.length ? shiny / tL.length : 0;

  // cheek shine (same specular test on both cheeks) → cheek oil, for the T-zone vs cheeks profile
  const cheekBoxes = [
    [0.1, 0.36, 0.48, 0.74],
    [0.64, 0.9, 0.48, 0.74],
  ];
  let cheekPx = 0;
  let cheekShiny = 0;
  for (const [u0, u1, v0, v1] of cheekBoxes) {
    for (let y = Math.floor(v0 * h); y < Math.ceil(v1 * h); y++) {
      for (let x = Math.floor(u0 * w); x < Math.ceil(u1 * w); x++) {
        const p = y * w + x;
        if (!mask[p]) continue;
        cheekPx++;
        if (L[p] >= Math.max(p95, 70) && L[p] - Lbig[p] > 5 && Math.hypot(A[p], B[p]) < 14) cheekShiny++;
      }
    }
  }
  const cheekShineShare = cheekPx ? cheekShiny / cheekPx : 0;

  const texture = clamp(((cnt ? fineSum / cnt : 0) - 0.6) * 38);
  const pores = clamp((cheeks - 0.5) * 42);
  const wrinkles = clamp(((foreheadLines * 0.6 + eyeLines * 0.4) - 0.9) * 22);
  const redness = clamp((meanA - 9) * 4.2);
  const pigmentation = clamp(spotShare * 1800);
  const evenness = clamp(100 - (localStd - 2) * 12);
  const oil = clamp(10 + shineShare * 900);
  const hydration = clamp(88 - 0.42 * texture - 0.22 * pores - 0.12 * wrinkles + 0.1 * oil);

  const round = (v) => Math.round(v * 10) / 10;
  const cheekOil = clamp(10 + cheekShineShare * 900);
  const cheekTexture = clamp((cheeks - 0.6) * 38);
  const cheekHydration = clamp(88 - 0.5 * cheekTexture - 0.22 * pores - 0.1 * wrinkles + 0.1 * cheekOil);
  return {
    skinCoverage: cnt / n,
    zones: { tzoneOil: round(oil), cheekOil: round(cheekOil), cheekHydration: round(cheekHydration) },
    metrics: {
      hydration: round(hydration),
      oil: round(oil),
      redness: round(redness),
      pigmentation: round(pigmentation),
      texture: round(texture),
      pores: round(pores),
      wrinkles: round(wrinkles),
      evenness: round(evenness),
    },
  };
}

/**
 * Rough head pose from where the dark facial features (eyes, brows, nostrils, mouth) sit inside
 * the skin box. Turning the head moves them sideways; tilting it up moves them up.
 * Returns null when not enough features are visible.
 */
function estimatePose(face) {
  const w = face.width;
  const h = face.height;
  const { L } = toLab(face);
  let skinL = 0, skinN = 0;
  const skin = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    if (isSkin(face.data[p * 4], face.data[p * 4 + 1], face.data[p * 4 + 2])) {
      skin[p] = 1;
      skinL += L[p];
      skinN++;
    }
  }
  if (!skinN) return null;
  const meanL = skinL / skinN;
  let sx = 0, sy = 0, n = 0, left = 0, right = 0;
  for (let y = Math.floor(h * 0.18); y < Math.ceil(h * 0.85); y++) {
    for (let x = Math.floor(w * 0.12); x < Math.ceil(w * 0.88); x++) {
      const p = y * w + x;
      if (L[p] < meanL - 18) {
        sx += x / w;
        sy += y / h;
        n++;
      }
      if (skin[p] && y > h * 0.35 && y < h * 0.75) {
        if (x < w / 2) left++;
        else right++;
      }
    }
  }
  if (n < w * h * 0.004) return null;
  return {
    yaw: Math.round((sx / n - 0.5) * 1000) / 1000, // + = features shifted to the image's right
    pitch: Math.round((sy / n) * 1000) / 1000, // smaller = features higher = head tilted up
    asym: Math.round(((right - left) / Math.max(1, right + left)) * 1000) / 1000,
  };
}

/**
 * Analyse one frame.
 * @param {Buffer} jpegBuffer
 * @param {{ previousSignature?: number[] }} [opts]
 */
function analyzeFrame(jpegBuffer, opts = {}) {
  const img = decodeJpeg(jpegBuffer);
  const face = findFace(img);

  if (!face.found) {
    return {
      quality: { faceFound: false, brightness: 0, light: 'unknown', distance: 'unknown', motion: 0, still: false },
      tip: 'We can’t see your face — center it inside the circle.',
      accepted: false,
    };
  }

  const brightness = Math.round(face.meanLuma);
  const light = brightness < 60 ? 'low' : brightness > 232 ? 'harsh' : 'good';
  const distance = face.heightShare < 0.26 ? 'far' : face.heightShare > 0.97 ? 'close' : 'good';
  const offCenter = Math.abs(face.centerX - 0.5) > 0.27;

  const h = Math.round((face.box.h / face.box.w) * FACE_W);
  const crop = resampleRegion(img, face.box, FACE_W, Math.max(40, Math.min(220, h)));
  const sig = signature(crop);
  let motion = 0;
  if (opts.previousSignature?.length === sig.length) {
    for (let i = 0; i < sig.length; i++) motion += Math.abs(sig[i] - opts.previousSignature[i]);
    motion /= sig.length;
  }
  const still = !opts.previousSignature || motion < 18;

  const { metrics, skinCoverage, zones } = measureSkin(crop);
  // real pore count from the full-resolution cheeks (replaces the low-res estimate when possible)
  const pores = measurePores(img, face.box);
  if (pores.measured) metrics.pores = pores.score;
  const photo = photoChecks(img, face.box);
  // `blurry` / strong side shadow are reported separately so the route can stop insisting after a while
  const framingOk = light === 'good' && distance === 'good' && !offCenter && skinCoverage > 0.3;
  const accepted = framingOk && photo.blur !== 'blurry' && photo.sideShadow !== 'strong';
  const pose = estimatePose(crop);

  let tip = null;
  if (distance === 'far') tip = 'Too far, move a bit closer.';
  else if (distance === 'close') tip = 'Too close, move the phone back a little.';
  else if (offCenter) tip = 'Center your face inside the circle.';
  else if (light === 'low') tip = 'It’s too dark — face a window or a lamp.';
  else if (light === 'harsh') tip = 'The light is too strong — avoid direct sunlight.';
  else if (!still) tip = 'Hold still for a moment.';
  else if (photo.blur === 'blurry') tip = 'The photo is blurry — hold the phone steady and wipe the camera lens.';
  else if (photo.sideShadow === 'strong') tip = 'One side of your face is in shadow — turn to face the light.';
  else if (photo.blur === 'soft') tip = 'Hold the phone steady for a sharper photo.';
  else if (photo.sideShadow === 'some') tip = 'Try to get the light evenly on both cheeks.';
  else if (photo.warmLight) tip = 'Warm indoor light can make redness look stronger — daylight is best.';

  const quality = { faceFound: true, brightness, light, distance, motion: Math.round(motion * 10) / 10, still, ...photo };
  quality.score = frameScore(quality);

  return {
    accepted,
    framingOk,
    tip,
    quality,
    metrics,
    zones,
    pores,
    pose,
    signature: sig,
    faceArea: face.box.w * face.box.h,
    thumbnail: () => {
      const t = resampleRegion(img, face.box, 160, Math.round((face.box.h / face.box.w) * 160));
      return Buffer.from(encodeJpeg(t, 72)).toString('base64');
    },
    // square face crop for the trained skin model (and, with consent, the training set)
    faceCrop: () => {
      const side = Math.max(face.box.w, face.box.h) * 1.12;
      const box = { x: face.box.x + face.box.w / 2 - side / 2, y: face.box.y + face.box.h / 2 - side / 2, w: side, h: side };
      const t = resampleRegion(img, box, CROP_SIZE, CROP_SIZE);
      return Buffer.from(encodeJpeg(t, 88));
    },
  };
}

const CROP_SIZE = 320;

module.exports = { analyzeFrame, findFace, CROP_SIZE };
