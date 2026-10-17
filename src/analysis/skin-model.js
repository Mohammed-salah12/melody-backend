/**
 * Trained skin model (optional). When `ml-model/melody-skin.onnx` + `model.json` exist (made by
 * ml/train.py from doctor-graded photos) and `onnxruntime-node` is installed, each completed
 * scan's face crop is run through the model and its grades are blended with the rule-based
 * numbers. The blend weight per measurement comes from the model's own validation: where the
 * model agreed with doctors better than the rules did, it gets more say (up to 0.8); where it
 * didn't, the rules stay in charge. Without a model everything works exactly as before.
 *
 * Set SKIN_MODEL_DIR to use another folder. Install the runtime with: npm install onnxruntime-node
 */
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const DIR = process.env.SKIN_MODEL_DIR || path.join(__dirname, '..', '..', 'ml-model');
let state = null; // { session, meta, ort } | false (disabled)

async function load() {
  if (state !== null) return state;
  state = false;
  try {
    const metaPath = path.join(DIR, 'model.json');
    const onnxPath = path.join(DIR, 'melody-skin.onnx');
    if (!fs.existsSync(metaPath) || !fs.existsSync(onnxPath)) return state;
    // eslint-disable-next-line global-require
    const ort = require('onnxruntime-node');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const session = await ort.InferenceSession.create(onnxPath);
    state = { ort, meta, session };
    console.log(`Skin model ${meta.version} loaded (${meta.outputs.join(', ')})`);
  } catch (e) {
    console.warn('Skin model not used:', e.message);
  }
  return state;
}

/** JPEG → Float32 NCHW tensor data, resized (bilinear) and normalised like in training. */
function toTensor(buf, size, mean, std) {
  const img = jpeg.decode(buf, { useTArray: true });
  const out = new Float32Array(3 * size * size);
  const sx = img.width / size;
  const sy = img.height / size;
  for (let y = 0; y < size; y++) {
    const fy = Math.min(img.height - 1, (y + 0.5) * sy - 0.5);
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = Math.max(0, fy - y0);
    for (let x = 0; x < size; x++) {
      const fx = Math.min(img.width - 1, (x + 0.5) * sx - 0.5);
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = Math.max(0, fx - x0);
      for (let c = 0; c < 3; c++) {
        const p = (yy, xx) => img.data[(yy * img.width + xx) * 4 + c];
        const v = (p(y0, x0) * (1 - wx) + p(y0, x1) * wx) * (1 - wy) + (p(y1, x0) * (1 - wx) + p(y1, x1) * wx) * wy;
        out[c * size * size + y * size + x] = (v / 255 - mean[c]) / std[c];
      }
    }
  }
  return out;
}

/**
 * @param crop JPEG Buffer (square face crop)
 * @param ruleMetrics rule-based metrics 0–100
 * @returns { metrics, model } or null when no model is installed / it fails
 */
async function refineWithModel(crop, ruleMetrics) {
  const s = await load();
  if (!s) return null;
  try {
    const { meta, session, ort } = s;
    const size = meta.inputSize ?? 224;
    const data = toTensor(crop, size, meta.mean ?? [0.485, 0.456, 0.406], meta.std ?? [0.229, 0.224, 0.225]);
    const input = new ort.Tensor('float32', data, [1, 3, size, size]);
    const out = await session.run({ [session.inputNames[0]]: input });
    const grades = out[session.outputNames[0]].data; // 1–5 per output, same order as meta.outputs
    const metrics = { ...ruleMetrics };
    const blend = {};
    meta.outputs.forEach((key, i) => {
      const w = Math.max(0, Math.min(0.8, meta.blend?.[key] ?? 0));
      if (!w || !(key in metrics)) return;
      const modelValue = Math.max(0, Math.min(100, ((grades[i] - 1) / 4) * 100));
      metrics[key] = Math.round(((1 - w) * ruleMetrics[key] + w * modelValue) * 10) / 10;
      blend[key] = w;
    });
    return { metrics, model: { version: meta.version, blend } };
  } catch (e) {
    console.warn('Skin model failed on this scan:', e.message);
    return null;
  }
}

module.exports = { refineWithModel };
