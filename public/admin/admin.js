/* Melody Admin — product management (talks to the same server's /products API). */
const $ = (id) => document.getElementById(id);
let token = null;
try { token = localStorage.getItem('melodyAdminToken'); } catch {}
let meta = null;
let page = 1;
let editing = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error('Please log in again.'); }
  if (!res.ok) throw new Error(data.message || 'Request failed (' + res.status + ')');
  return data;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

function logout() {
  token = null;
  try { localStorage.removeItem('melodyAdminToken'); } catch {}
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
}

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('lerr').textContent = '';
  try {
    const r = await api('/auth/login', { method: 'POST', body: { phone: $('lphone').value, password: $('lpass').value } });
    if (r.user.role !== 'admin') throw new Error('This account is not an admin. Run: npm run make-admin -- ' + r.user.phone);
    token = r.token;
    try { localStorage.setItem('melodyAdminToken', token); } catch {}
    start(r.user);
  } catch (err) { $('lerr').textContent = err.message; }
});
$('logout').onclick = logout;

async function start(user) {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('who').textContent = user ? user.fullName : '';
  if (!meta) {
    meta = await api('/products/meta');
    for (const c of meta.categories) $('fcat').insertAdjacentHTML('beforeend', `<option>${c}</option>`);
    $('form').category.innerHTML = meta.categories.map((c) => `<option>${c}</option>`).join('');
    $('skinTypes').innerHTML = meta.skinTypes.map((s) => `<label><input type="checkbox" value="${s}" /> ${s}</label>`).join('');
    $('concerns').innerHTML = meta.concerns.map((s) => `<label><input type="checkbox" value="${s}" /> ${s}</label>`).join('');
  }
  load();
}

async function load() {
  const params = new URLSearchParams({ page, limit: 20, sort: 'newest' });
  if ($('q').value.trim()) { params.set('q', $('q').value.trim()); params.delete('sort'); }
  if ($('fcat').value) params.set('category', $('fcat').value);
  if ($('fstatus').value === 'all') params.set('includeInactive', 'true');
  const r = await api('/products?' + params);
  $('count').textContent = r.total + ' products';
  $('pageinfo').textContent = `Page ${r.page} of ${Math.max(1, r.pages)}`;
  $('prev').disabled = r.page <= 1;
  $('next').disabled = r.page >= r.pages;
  $('rows').innerHTML = r.items.map((p) => `
    <tr>
      <td>${p.hasImage ? `<img src="/products/${p.id}/image?v=${Date.parse(p.updatedAt)}" alt="" />` : p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="" />` : '<div class="thumb"></div>'}</td>
      <td><b>${esc(p.name)}</b><div class="muted">${esc(p.brand)}${p.active ? '' : ' · <span class="off">hidden</span>'}</div></td>
      <td>${esc(p.category)}</td>
      <td>${p.salePercent ? `<s class="muted">${p.price}</s> ${p.finalPrice}` : p.price} ${esc(p.currency)}${p.salePercent ? ` <span class="tag">-${p.salePercent}%</span>` : ''}</td>
      <td>${p.stock}</td>
      <td>${(p.concerns || []).map((c) => `<span class="tag">${c}</span>`).join('')}</td>
      <td style="white-space:nowrap">
        <button class="ghost" data-edit="${p.id}">Edit</button>
        ${p.active ? `<button class="ghost" data-hide="${p.id}">Hide</button>` : `<button class="ghost" data-show="${p.id}">Show</button>`}
        <button class="danger" data-del="${p.id}">Delete</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">No products yet. Click “Add product”, or run npm run seed:products.</td></tr>';
  window._items = r.items;
}

let qTimer;
$('q').oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(() => { page = 1; load(); }, 300); };
$('fcat').onchange = $('fstatus').onchange = () => { page = 1; load(); };
$('prev').onclick = () => { page--; load(); };
$('next').onclick = () => { page++; load(); };

$('rows').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.edit) openForm(window._items.find((p) => p.id === b.dataset.edit));
    if (b.dataset.hide) { await api('/products/' + b.dataset.hide, { method: 'PATCH', body: { active: false } }); load(); }
    if (b.dataset.show) { await api('/products/' + b.dataset.show, { method: 'PATCH', body: { active: true } }); load(); }
    if (b.dataset.del && confirm('Delete this product permanently?')) { await api('/products/' + b.dataset.del + '?hard=true', { method: 'DELETE' }); load(); }
  } catch (err) { alert(err.message); }
});

function openForm(p) {
  editing = p || null;
  const f = $('form');
  f.reset();
  $('ferr').textContent = '';
  $('dtitle').textContent = p ? 'Edit product' : 'Add product';
  if (p) {
    for (const k of ['name', 'brand', 'category', 'routine', 'price', 'salePercent', 'currency', 'size', 'stock', 'description', 'imageUrl']) f[k].value = p[k] ?? '';
    f.ingredients.value = (p.ingredients || []).join(', ');
    f.badges.value = (p.badges || []).join(', ');
    f.fragranceFree.checked = !!p.fragranceFree;
    f.nonComedogenic.checked = !!p.nonComedogenic;
    f.active.checked = p.active !== false;
  }
  for (const box of $('skinTypes').querySelectorAll('input')) box.checked = !!p?.skinTypes?.includes(box.value);
  for (const box of $('concerns').querySelectorAll('input')) box.checked = !!p?.concerns?.includes(box.value);
  $('dlg').showModal();
  preview();
}

/* ---------- live "how will this match" preview ---------- */
let previewTimer = null, lastSuggest = null;
const NOTE_COLOR = { error: '#b42318', warn: '#B54708', info: 'var(--muted)' };
async function preview() {
  const f = $('form');
  const body = {
    id: editing?.id,
    ingredients: f.ingredients.value,
    category: f.category.value,
    routine: f.routine.value,
    fragranceFree: f.fragranceFree.checked,
    concerns: [...$('concerns').querySelectorAll('input:checked')].map((i) => i.value),
  };
  if (!body.ingredients.trim() && !body.concerns.length) { $('mpBody').textContent = 'Type or paste ingredients to see what the matcher understands.'; return; }
  try {
    const r = await api('/products/analyze', { method: 'POST', body });
    lastSuggest = r.suggest;
    const actives = r.actives.length
      ? r.actives.map((a) => `<span class="tag" title="${esc(a.how)}">${esc(a.key)}${a.pct != null ? ' ' + a.pct + '%' : ''} · ${a.strength}%</span>`).join(' ')
      : '<span class="muted">none recognised</span>';
    const treats = r.treats.length ? r.treats.map((t) => `${esc(t.label)} <b>${t.strength}</b>`).join(' · ') : '<span class="muted">nothing yet</span>';
    const notes = r.notes.map((n) => `<div style="color:${NOTE_COLOR[n.level]}">• ${esc(n.text)}</div>`).join('');
    const sug = [];
    if (r.suggest.concerns.length) sug.push('tick ' + r.suggest.concerns.join(', '));
    if (r.suggest.routine && r.suggest.routine !== body.routine) sug.push('routine → ' + r.suggest.routine);
    if (r.suggest.fragranceFree != null && r.suggest.fragranceFree !== body.fragranceFree) sug.push(r.suggest.fragranceFree ? 'mark fragrance-free' : 'untick fragrance-free');
    const ev = r.evidence ? (r.evidence.customers ? `<div style="margin-top:4px">Real results: ${r.evidence.customers} customers rescanned after buying.</div>` : `<div class="muted" style="margin-top:4px">Real results: not enough customers yet (needs ${r.evidence.needed}).</div>`) : '';
    $('mpBody').innerHTML = `
      <div>Actives: ${actives}</div>
      <div style="margin-top:4px">Treats: ${treats}</div>
      ${r.unknown.length ? `<div class="muted" style="margin-top:4px">Not in the knowledge base (ignored): ${esc(r.unknown.slice(0, 15).join(', '))}${r.unknown.length > 15 ? '…' : ''}</div>` : ''}
      ${notes ? `<div style="margin-top:6px">${notes}</div>` : ''}
      ${sug.length ? `<div style="margin-top:6px">Suggested: ${esc(sug.join(' · '))} <button type="button" class="ghost" id="applySug" style="padding:4px 10px">Apply</button></div>` : ''}
      ${ev}`;
  } catch (err) { $('mpBody').textContent = err.message; }
}
const queuePreview = () => { clearTimeout(previewTimer); previewTimer = setTimeout(preview, 400); };
$('form').addEventListener('input', queuePreview);
$('form').addEventListener('change', queuePreview);
$('mpBody').addEventListener('click', (e) => {
  if (e.target.id !== 'applySug' || !lastSuggest) return;
  const f = $('form');
  for (const box of $('concerns').querySelectorAll('input')) if (lastSuggest.concerns.includes(box.value)) box.checked = true;
  if (lastSuggest.routine) f.routine.value = lastSuggest.routine;
  if (lastSuggest.fragranceFree != null) f.fragranceFree.checked = lastSuggest.fragranceFree;
  preview();
});
$('new').onclick = () => openForm(null);
$('cancel').onclick = () => $('dlg').close();

const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
const readFile = (file) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(file); });

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = $('form');
  const body = {
    name: f.name.value, brand: f.brand.value, category: f.category.value, routine: f.routine.value,
    price: Number(f.price.value), salePercent: Number(f.salePercent.value || 0), currency: f.currency.value || 'USD', size: f.size.value, stock: Number(f.stock.value || 0),
    description: f.description.value, imageUrl: f.imageUrl.value || undefined,
    ingredients: split(f.ingredients.value), badges: split(f.badges.value),
    fragranceFree: f.fragranceFree.checked, nonComedogenic: f.nonComedogenic.checked, active: f.active.checked,
    skinTypes: [...$('skinTypes').querySelectorAll('input:checked')].map((i) => i.value),
    concerns: [...$('concerns').querySelectorAll('input:checked')].map((i) => i.value),
  };
  $('save').disabled = true;
  try {
    const saved = editing
      ? await api('/products/' + editing.id, { method: 'PATCH', body })
      : await api('/products', { method: 'POST', body });
    const file = $('file').files[0];
    if (file) await api('/products/' + saved.id + '/image', { method: 'PUT', body: { image: await readFile(file) } });
    $('dlg').close();
    load();
  } catch (err) {
    $('ferr').textContent = err.message;
  } finally {
    $('save').disabled = false;
  }
});

// boot
if (token) api('/auth/me').then((r) => (r.user.role === 'admin' ? start(r.user) : logout())).catch(logout);
else logout();
