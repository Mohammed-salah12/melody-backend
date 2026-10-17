// Usage: node scripts/test-analyzer.js photo1.jpg photo2.jpg …
const fs = require('fs');
const { analyzeFrame } = require('../src/analysis/skin-analyzer');
const { buildResults } = require('../src/analysis/results');

const frames = [];
let prev;
for (const file of process.argv.slice(2)) {
  const t = Date.now();
  const r = analyzeFrame(fs.readFileSync(file), { previousSignature: prev });
  prev = r.signature;
  console.log(`\n${file}  (${Date.now() - t} ms)`);
  console.log('  accepted:', r.accepted, '| tip:', r.tip);
  console.log('  quality :', JSON.stringify(r.quality));
  if (r.metrics) console.log('  metrics :', JSON.stringify(r.metrics));
  if (r.zones) console.log('  zones   :', JSON.stringify(r.zones));
  frames.push({ accepted: r.accepted, metrics: r.metrics, zones: r.zones });
}
if (frames.some((f) => f.metrics)) console.log('\nresults:', JSON.stringify(buildResults(frames), null, 2));
