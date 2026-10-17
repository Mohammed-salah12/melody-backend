/* Melody Admin — clinic: doctors (add/edit/photo/break/hide) and consultations (complete with summary). */
const $ = (id) => document.getElementById(id);
let token = null;
try { token = localStorage.getItem('melodyAdminToken'); } catch {}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATUS = { online: 'Online', busy: 'In consultation', soon: 'Free soon', break: 'On break', offline: 'Offline' };
let meta, doctors = [], editing = null, completing = null;

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { $('needlogin').classList.remove('hidden'); throw new Error('Please log in again.'); }
  if (!res.ok) throw new Error(data.message || 'Request failed (' + res.status + ')');
  return data;
}

async function loadDoctors() {
  const r = await api('/doctors?includeInactive=true');
  doctors = r.items;
  $('docs').innerHTML = doctors.map((d) => `
    <tr>
      <td>${d.hasImage ? `<img src="/doctors/${d.id}/image?v=${Date.parse(d.updatedAt)}" style="width:44px;height:44px;border-radius:10px;object-fit:cover" />` : '<div class="thumb"></div>'}</td>
      <td><b>${esc(d.name)}</b><div class="muted">${esc(d.bio)}${d.active ? '' : ' · <span class="off">hidden</span>'}</div></td>
      <td>${d.specialties.map((s) => `<span class="tag">${s}</span>`).join('')}</td>
      <td class="muted">${d.workDays.map((x) => DAYS[x]).join(' ')}<br/>${d.startHour}:00–${d.endHour}:00</td>
      <td>${STATUS[d.availability.status]}${d.availability.untilText ? ' until ' + d.availability.untilText : ''}</td>
      <td style="white-space:nowrap">
        <button class="ghost" data-edit="${d.id}">Edit</button>
        <button class="ghost" data-break="${d.id}">${d.availability.status === 'break' ? 'End break' : 'Break 30m'}</button>
        <button class="ghost" data-toggle="${d.id}">${d.active ? 'Hide' : 'Show'}</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">No doctors yet — add one, or run npm run seed:doctors.</td></tr>';
}

async function loadAppts() {
  const st = $('astatus').value;
  const r = await api('/appointments/admin/all' + (st ? '?status=' + st : ''));
  window._appts = r.items;
  $('appts').innerHTML = r.items.map((a) => `
    <tr>
      <td>${new Date(a.start).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
      <td>${esc(a.patient?.name)}<div class="muted">${esc(a.patient?.phone)}${a.problem ? ' · ' + esc(a.problem) : ''}</div></td>
      <td>${esc(a.doctor?.name)}</td>
      <td>${a.type}${a.free ? ' <span class="tag">free</span>' : ''}</td>
      <td>${a.status}</td>
      <td style="white-space:nowrap">${a.status === 'booked' ? `<button data-done="${a.id}">Complete</button> <button class="ghost" data-noshow="${a.id}">No-show</button>` : a.status === 'completed' ? `<button class="ghost" data-done="${a.id}">Edit summary</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">No consultations.</td></tr>';
}

$('docs').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  try {
    if (b.dataset.edit) openDoc(doctors.find((d) => d.id === b.dataset.edit));
    if (b.dataset.break) { const d = doctors.find((x) => x.id === b.dataset.break); await api(`/doctors/${d.id}/break`, { method: 'PATCH', body: { minutes: d.availability.status === 'break' ? 0 : 30 } }); loadDoctors(); }
    if (b.dataset.toggle) { const d = doctors.find((x) => x.id === b.dataset.toggle); await api(`/doctors/${d.id}`, { method: 'PATCH', body: { active: !d.active } }); loadDoctors(); }
  } catch (err) { alert(err.message); }
});

$('appts').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  try {
    if (b.dataset.noshow && confirm('Mark as no-show?')) { await api(`/appointments/${b.dataset.noshow}/no-show`, { method: 'POST' }); loadAppts(); }
    if (b.dataset.done) {
      completing = window._appts.find((a) => a.id === b.dataset.done);
      const f = $('doneForm');
      f.summary.value = completing.summary || '';
      f.protocol.value = (completing.protocol || []).map((p) => p.name + (p.note ? ' — ' + p.note : '')).join('\n');
      f.duration.value = completing.durationMinutes || 45;
      $('doneWho').textContent = `${completing.patient?.name} with ${completing.doctor?.name}`;
      $('doneErr').textContent = '';
      $('doneDlg').showModal();
    }
  } catch (err) { alert(err.message); }
});

$('doneCancel').onclick = () => $('doneDlg').close();
$('doneForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = $('doneForm');
  const protocol = f.protocol.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [name, ...rest] = l.split(/\s+[—-]\s+/); return { name, note: rest.join(' — ') }; });
  try {
    await api(`/appointments/${completing.id}/complete`, { method: 'POST', body: { summary: f.summary.value, protocol, durationMinutes: Number(f.duration.value) } });
    $('doneDlg').close(); loadAppts();
  } catch (err) { $('doneErr').textContent = err.message; }
});
$('astatus').onchange = loadAppts;

function openDoc(d) {
  editing = d || null;
  const f = $('docForm'); f.reset(); $('docErr').textContent = '';
  $('docTitle').textContent = d ? 'Edit doctor' : 'Add doctor';
  if (d) for (const k of ['name', 'title', 'bio', 'about', 'yearsExperience', 'startHour', 'endHour']) f[k].value = d[k] ?? '';
  f.expertise.value = (d?.expertise || []).join(', ');
  f.video.checked = !d || d.consultTypes.includes('video');
  f.chat.checked = !d || d.consultTypes.includes('chat');
  for (const box of $('days').querySelectorAll('input')) box.checked = d ? d.workDays.includes(Number(box.value)) : box.value !== '5';
  for (const box of $('specs').querySelectorAll('input')) box.checked = !!d?.specialties.includes(box.value);
  $('docDlg').showModal();
}
$('newDoc').onclick = () => openDoc(null);
$('docCancel').onclick = () => $('docDlg').close();
const readFile = (file) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(file); });

$('docForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = $('docForm');
  const body = {
    name: f.name.value, title: f.title.value, bio: f.bio.value,
    about: f.about.value, expertise: f.expertise.value.split(',').map((x) => x.trim()).filter(Boolean),
    yearsExperience: Number(f.yearsExperience.value || 0),
    startHour: Number(f.startHour.value), endHour: Number(f.endHour.value),
    workDays: [...$('days').querySelectorAll('input:checked')].map((i) => Number(i.value)),
    specialties: [...$('specs').querySelectorAll('input:checked')].map((i) => i.value),
    consultTypes: [f.video.checked && 'video', f.chat.checked && 'chat'].filter(Boolean),
  };
  if (!body.consultTypes.length) return ($('docErr').textContent = 'Choose at least one consultation type.');
  try {
    const saved = editing ? await api('/doctors/' + editing.id, { method: 'PATCH', body }) : await api('/doctors', { method: 'POST', body });
    const file = $('docFile').files[0];
    if (file) await api('/doctors/' + saved.id + '/image', { method: 'PUT', body: { image: await readFile(file) } });
    $('docDlg').close(); loadDoctors();
  } catch (err) { $('docErr').textContent = err.message; }
});

/* ---------- live chats ---------- */
async function loadChats() {
  const r = await api('/appointments/admin/chats');
  window._chats = r.items;
  $('chats').innerHTML = r.items.map((a) => `
    <tr>
      <td>${new Date(a.createdAt || a.start).toLocaleTimeString([], { timeStyle: 'short' })}</td>
      <td>${esc(a.patient?.name)}<div class="muted">${esc(a.patient?.phone)}</div></td>
      <td>${esc(a.doctor?.name)}</td>
      <td>${a.type === 'video' ? 'Video' : 'Chat'} · ${a.status === 'requested' ? '<span class="tag">waiting</span>' : a.chatOpen ? 'in progress' : 'scheduled'}</td>
      <td>${a.status === 'requested' ? `<button data-accept="${a.id}">Accept</button>` : `<button class="ghost" data-open="${a.id}">${a.type === 'video' ? 'Open call' : 'Open chat'}</button>`}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No live consultations right now.</td></tr>';
}
$('chats').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  try {
    if (b.dataset.accept) {
      const w = window.open('', '_blank'); // opened now so the browser doesn't block it as a pop-up
      try { await api(`/appointments/${b.dataset.accept}/accept`, { method: 'POST' }); } catch (err) { w?.close(); throw err; }
      await loadChats();
      if (w) w.location = `consult.html?id=${b.dataset.accept}`;
    }
    if (b.dataset.open) window.open(`consult.html?id=${b.dataset.open}`, '_blank');
  } catch (err) { alert(err.message); loadChats(); }
});

(async () => {
  if (!token) return $('needlogin').classList.remove('hidden');
  try {
    const me = await api('/auth/me');
    if (me.user.role !== 'admin') return $('needlogin').classList.remove('hidden');
    $('who').textContent = me.user.fullName;
    meta = await api('/doctors/meta');
    $('days').innerHTML = DAYS.map((d, i) => `<label><input type="checkbox" value="${i}" style="width:auto" /> ${d}</label>`).join('');
    $('specs').innerHTML = meta.specialties.map((s) => `<label><input type="checkbox" value="${s}" style="width:auto" /> ${s}</label>`).join('');
    await Promise.all([loadDoctors(), loadAppts(), loadChats()]);
    setInterval(loadDoctors, 60e3);
    setInterval(() => loadChats().catch(() => {}), 5000);
  } catch (err) { console.error(err); }
})();
