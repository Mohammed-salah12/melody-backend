/**
 * Small, dependency-free image helpers (pure JS, so the server installs anywhere).
 */
const jpeg = require('jpeg-js');

function decodeJpeg(buffer) {
  const img = jpeg.decode(buffer, { useTArray: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 512 });
  return { width: img.width, height: img.height, data: img.data }; // RGBA
}

function encodeJpeg({ width, height, data }, quality = 70) {
  return jpeg.encode({ width, height, data }, quality).data;
}

/** Area-average resample of an RGBA region into a new RGBA image. */
function resampleRegion(img, box, outW, outH) {
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sx = box.w / outW;
  const sy = box.h / outH;
  for (let oy = 0; oy < outH; oy++) {
    const y0 = box.y + oy * sy;
    const y1 = y0 + sy;
    for (let ox = 0; ox < outW; ox++) {
      const x0 = box.x + ox * sx;
      const x1 = x0 + sx;
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        if (y < 0 || y >= img.height) continue;
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          if (x < 0 || x >= img.width) continue;
          const i = (y * img.width + x) * 4;
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
          n++;
        }
      }
      const o = (oy * outW + ox) * 4;
      out[o] = n ? r / n : 0;
      out[o + 1] = n ? g / n : 0;
      out[o + 2] = n ? b / n : 0;
      out[o + 3] = 255;
    }
  }
  return { width: outW, height: outH, data: out };
}

// sRGB → CIE Lab (D65)
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

function toLab(img) {
  const n = img.width * img.height;
  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const r = LIN[img.data[p * 4] | 0];
    const g = LIN[img.data[p * 4 + 1] | 0];
    const b = LIN[img.data[p * 4 + 2] | 0];
    const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const fx = f(x), fy = f(y), fz = f(z);
    L[p] = 116 * fy - 16;
    A[p] = 500 * (fx - fy);
    B[p] = 200 * (fy - fz);
  }
  return { L, A, B };
}

/** Separable box blur of a float channel. */
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / (2 * r + 1);
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

module.exports = { decodeJpeg, encodeJpeg, resampleRegion, toLab, boxBlur, clamp, median, percentile };
