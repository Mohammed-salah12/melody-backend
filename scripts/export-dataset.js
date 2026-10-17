/**
 * Export doctor-graded scan photos for training the skin model.
 *   npm run export:dataset -- ./dataset
 * Writes   ./dataset/images/<id>.jpg   and   ./dataset/labels.csv
 * (grades averaged across doctors; photos marked unusable by most doctors are left out).
 * The folder contains face photos — keep it private and delete it after training.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../src/config');
const TrainingSample = require('../src/models/TrainingSample');
const { LABEL_KEYS } = require('../src/models/TrainingSample');

(async () => {
  const out = path.resolve(process.argv[2] || './dataset');
  fs.mkdirSync(path.join(out, 'images'), { recursive: true });
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
  const cols = ['id', 'user', 'grades', 'fitzpatrick', ...LABEL_KEYS, ...LABEL_KEYS.map((k) => `rule_${k}`)];
  const rows = [cols.join(',')];
  let n = 0;
  for await (const s of TrainingSample.find({ gradeCount: { $gt: 0 } }).select('+image').cursor()) {
    if (s.unusable >= s.grades.length) continue;
    const avg = (k) => s.grades.reduce((a, g) => a + g[k], 0) / s.grades.length;
    const tones = s.grades.map((g) => g.fitzpatrick).filter(Boolean).sort();
    const ft = tones[Math.floor(tones.length / 2)] ?? '';
    fs.writeFileSync(path.join(out, 'images', `${s.id}.jpg`), s.image);
    rows.push([s.id, String(s.user), s.grades.length, ft, ...LABEL_KEYS.map((k) => avg(k).toFixed(2)), ...LABEL_KEYS.map((k) => s.ruleMetrics?.[k] ?? '')].join(','));
    n++;
  }
  fs.writeFileSync(path.join(out, 'labels.csv'), rows.join('\n') + '\n');
  console.log(`Exported ${n} graded photos to ${out}`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
