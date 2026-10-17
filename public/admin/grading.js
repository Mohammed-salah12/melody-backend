/* Melody Admin — doctors grade consented scan photos (labels for the skin model). */
const $ = (id) => document.getElementById(id);
let token = null; try { token = localStorage.getItem('melodyAdminToken'); } catch {}
const LABELS = { hydration: ['Hydration', '1 very dry · 5 very hydrated'], oil: ['Oil / shine', ''], redness: ['Redness', ''], pigmentation: ['Dark spots', 'uneven tone'], texture: ['Texture', 'roughness'], pores: ['Pores', 'visibility'], wrinkles: ['Fine lines', ''] };
const TONES = ['I', 'II', 'III', 'IV', 'V', 'VI'];
let current = null, grade = {}, skipped = new Set();

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) { $('needlogin').classList.remove('hidden'); throw new Error('Please log in as admin.'); }
  if (!res.ok) throw new Error(data.message || 'Request failed');
  return data;
}
async function loadStats() {
  const s = await api('/training/stats');
  const tones = Object.entries(s.perSkinTone).map(([k, v]) => `${TONES[k - 1]}: ${v}`).join(' · ') || '—';
  $('stats').innerHTML = `<div class="stat"><b>${s.photos}</b>shared photos</div><div class="stat"><b>${s.graded}</b>graded (goal ${s.target.minimum}+, good ${s.target.good})</div><div class="stat"><b>${s.gradedTwice}</b>graded by 2+ doctors</div><div class="stat"><b>${s.unusable}</b>unusable</div><div class="stat"><b style="font-size:14px">${tones}</b>graded per skin tone</div>`;
}
function scale(container, n, labels, key) {
  container.innerHTML = Array.from({ length: n }, (_, i) => `<button type="button" data-k="${key}" data-v="${i + 1}">${labels ? labels[i] : i + 1}</button>`).join('');
}
async function next() {
  $('err').textContent = '';
  const r = await api('/training/next' + (skipped.size ? '?skip=' + [...skipped].join(',') : ''));
  if (r.done) { $('card').classList.add('hidden'); $('empty').classList.remove('hidden'); return; }
  current = r; grade = {};
  $('empty').classList.add('hidden'); $('card').classList.remove('hidden');
  const img = await fetch(`/training/${r.id}/image`, { headers: { authorization: 'Bearer ' + token } }).then((x) => x.blob());
  $('photo').src = URL.createObjectURL(img);
  $('meta').textContent = `Shared ${new Date(r.createdAt).toLocaleDateString()} · ${r.grades} doctor grade(s) so far`;
  $('rows').innerHTML = r.labels.map((k) => `<div class="row"><label>${LABELS[k][0]}<small>${LABELS[k][1]}</small></label><div class="scale" id="s-${k}"></div><span class="rule" title="what the current rule-based scanner measured (0–100)">${r.ruleMetrics?.[k] != null ? Math.round(r.ruleMetrics[k]) : ''}</span></div>`).join('');
  for (const k of r.labels) scale($(`s-${k}`), 5, null, k);
  scale($('tone'), 6, TONES, 'fitzpatrick');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]'); if (!b) return;
  grade[b.dataset.k] = Number(b.dataset.v);
  b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
});
$('save').onclick = async () => {
  try { await api(`/training/${current.id}/grade`, { method: 'POST', body: grade }); await loadStats(); await next(); } catch (err) { $('err').textContent = err.message; }
};
$('bad').onclick = async () => { try { await api(`/training/${current.id}/grade`, { method: 'POST', body: { unusable: true } }); await loadStats(); await next(); } catch (err) { $('err').textContent = err.message; } };
$('skip').onclick = () => { skipped.add(current.id); next(); };
(async () => { if (!token) return $('needlogin').classList.remove('hidden'); try { await loadStats(); await next(); } catch (err) { $('err').textContent = err.message; } })();
