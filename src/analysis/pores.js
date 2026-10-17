/**
 * Pore detection on the cheeks at full camera resolution.
 *
 * A visible pore is a small, roughly round spot that is darker than the skin right around it.
 * For each cheek we:
 *   1. cut the cheek out of the ORIGINAL photo (no down-scaling, so detail is kept)
 *   2. work out the real-world scale: an adult face is ~14 cm wide, so mm per pixel =
 *      140 / face width in pixels
 *   3. subtract a local average (≈1.2 mm window) so only small dark dips remain — shadows,
 *      lighting and skin tone cancel out
 *   4. mark pixels clearly darker than their surroundings (relative to the cheek's own noise)
 *   5. group touching pixels into spots and keep the ones whose size and shape fit a pore:
 *      0.1–1.1 mm across and roughly round (long thin spots are lines, big ones are freckles)
 * The result is a pore count, density per cm² and average size.
 *
 * If the face is too small in the photo (coarser than 0.25 mm per pixel) pores can't be resolved,
 * so it returns { measured: false } and the app asks the user to come closer.
 */
const FACE_WIDTH_MM = 140;
const MAX_MM_PER_PX = 0.25; // coarser than this a pore is smaller than a pixel
const MIN_DIAM_MM = 0.1;
const MAX_DIAM_MM = 1.1;

function isSkin(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 40 && y < 250 && cr >= 133 && cr <= 180 && cb >= 77 && cb <= 135;
}

/** Mean over a (2r+1)² window using an integral image — fast for any radius. */
function localMean(v, w, h, r) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += v[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

function analyzeCheek(img, box, mmPerPx, debug) {
  const x0 = Math.max(0, Math.round(box.x)), y0 = Math.max(0, Math.round(box.y));
  const w = Math.min(img.width - x0, Math.round(box.w)), h = Math.min(img.height - y0, Math.round(box.h));
  if (w < 20 || h < 20) return null;

  const L = new Float32Array(w * h);
  const skin = new Uint8Array(w * h);
  let skinN = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * img.width + x0 + x) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      L[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      if (isSkin(r, g, b)) {
        skin[y * w + x] = 1;
        skinN++;
      }
    }
  }
  if (skinN < w * h * 0.5) return null; // mostly hair / background

  // light smoothing removes sensor noise, the wide mean is the "surrounding skin"
  const smooth = localMean(L, w, h, 1);
  const around = localMean(smooth, w, h, Math.max(3, Math.round(1.2 / mmPerPx)));
  const resid = new Float32Array(w * h);
  let sq = 0;
  for (let p = 0; p < w * h; p++) {
    resid[p] = smooth[p] - around[p];
    if (skin[p]) sq += resid[p] * resid[p];
  }
  const noise = Math.sqrt(sq / skinN);
  const thresh = -Math.max(2.5, 1.5 * noise);

  // ignore folds and shadow edges (nose side, smile line). A smooth slope of light is fine
  // (the local average follows it); a fold is where the local average itself bends sharply.
  const wide = localMean(smooth, w, h, Math.max(9, Math.round(3.6 / mmPerPx)));
  const dark = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    if (!skin[p] || resid[p] >= thresh) continue;
    if (Math.abs(around[p] - wide[p]) > 5) continue;
    dark[p] = 1;
  }

  // connected spots
  const minArea = Math.PI * (MIN_DIAM_MM / 2 / mmPerPx) ** 2;
  const maxArea = Math.PI * (MAX_DIAM_MM / 2 / mmPerPx) ** 2;
  const seen = new Uint8Array(w * h);
  const stack = [];
  let count = 0, sizeSum = 0, depthSum = 0;
  for (let start = 0; start < w * h; start++) {
    if (!dark[start] || seen[start]) continue;
    let area = 0, minX = w, maxX = 0, minY = h, maxY = 0, depth = 0, edge = false;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p - x) / w;
      area++;
      depth = Math.min(depth, resid[p]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= w * h || seen[q] || !dark[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (edge || area < Math.max(1, minArea) || area > maxArea) continue;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const aspect = Math.max(bw, bh) / Math.min(bw, bh);
    const fillRatio = area / (bw * bh);
    if (aspect > 2.2 || fillRatio < 0.35) continue; // lines / irregular marks
    count++;
    debug?.push({ x: x0 + (minX + maxX) / 2, y: y0 + (minY + maxY) / 2, r: Math.max(bw, bh) / 2 });
    sizeSum += 2 * Math.sqrt(area / Math.PI) * mmPerPx;
    depthSum += -depth;
  }

  const areaCm2 = (skinN * mmPerPx * mmPerPx) / 100;
  return { count, areaCm2, sizeSum, depthSum };
}

/**
 * Find the eye line: the row where both eye areas (left and right) are darker than the nose
 * bridge between them. Brows match too, so of the strong matches we take the lowest one.
 * Returns y in image pixels, or null.
 */
function findEyeLine(img, box) {
  const lum = (x, y) => {
    const i = (Math.round(y) * img.width + Math.round(x)) * 4;
    return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  };
  const band = (y, u0, u1) => {
    let s = 0, n = 0;
    for (let k = 0; k <= 12; k++) {
      const x = box.x + (u0 + ((u1 - u0) * k) / 12) * box.w;
      if (x >= 0 && x < img.width && y >= 0 && y < img.height) {
        s += lum(x, y);
        n++;
      }
    }
    return n ? s / n : 0;
  };
  const rows = [];
  for (let v = 0.12; v <= 0.62; v += 0.004) {
    const y = box.y + v * box.h;
    let sc = 0;
    for (let d = -2; d <= 2; d++) {
      const yy = y + (d * box.h) / 400;
      const mid = band(yy, 0.44, 0.56);
      sc += mid - Math.max(band(yy, 0.22, 0.38), band(yy, 0.62, 0.78));
    }
    rows.push({ y, sc: sc / 5 });
  }
  const best = Math.max(...rows.map((r) => r.sc));
  if (!(best > 6)) return null;
  // local maxima that are at least half as strong as the best
  const peaks = rows.filter(
    (r, i) => i > 0 && i < rows.length - 1 && r.sc >= rows[i - 1].sc && r.sc >= rows[i + 1].sc && r.sc > best * 0.5,
  );
  // brows sit above the eyes: if two strong peaks are close, the lower one is the eyes
  peaks.sort((a, b) => b.sc - a.sc);
  const top = peaks.slice(0, 2).sort((a, b) => a.y - b.y);
  if (top.length === 2 && top[1].y - top[0].y < box.w * 0.22) return top[1].y;
  return top[0]?.y ?? null;
}

/**
 * @param img decoded RGBA photo at full resolution
 * @param faceBox face box in that photo's pixels
 */
function measurePores(img, faceBox, debug) {
  const mmPerPx = FACE_WIDTH_MM / faceBox.w;
  if (mmPerPx > MAX_MM_PER_PX) return { measured: false, mmPerPx: Math.round(mmPerPx * 100) / 100 };

  // cheeks: from just under the lower eyelid to above the mouth corners
  const eyeY = findEyeLine(img, faceBox) ?? faceBox.y + 0.42 * faceBox.h;
  const cheek = (u0, u1) => ({
    x: faceBox.x + u0 * faceBox.w,
    y: eyeY + 0.13 * faceBox.w,
    w: (u1 - u0) * faceBox.w,
    h: 0.22 * faceBox.w,
  });
  const parts = [analyzeCheek(img, cheek(0.14, 0.36), mmPerPx, debug), analyzeCheek(img, cheek(0.64, 0.86), mmPerPx, debug)].filter(Boolean);
  if (!parts.length) return { measured: false, mmPerPx: Math.round(mmPerPx * 100) / 100 };

  const count = parts.reduce((s, p) => s + p.count, 0);
  const areaCm2 = parts.reduce((s, p) => s + p.areaCm2, 0);
  const perCm2 = count / Math.max(0.01, areaCm2);
  const avgSizeMm = count ? parts.reduce((s, p) => s + p.sizeSum, 0) / count : 0;
  const contrast = count ? parts.reduce((s, p) => s + p.depthSum, 0) / count : 0;

  // 0–100 "visible pores" score: density matters most, bigger and darker pores push it up
  const score = Math.max(0, Math.min(100, perCm2 * 1.1 + Math.max(0, avgSizeMm - 0.25) * 60 + Math.max(0, contrast - 4) * 1.5));

  return {
    measured: true,
    eyeLine: Math.round(eyeY),
    count,
    perCm2: Math.round(perCm2 * 10) / 10,
    avgSizeMm: Math.round(avgSizeMm * 100) / 100,
    areaCm2: Math.round(areaCm2 * 10) / 10,
    mmPerPx: Math.round(mmPerPx * 1000) / 1000,
    score: Math.round(score * 10) / 10,
  };
}

module.exports = { measurePores };
