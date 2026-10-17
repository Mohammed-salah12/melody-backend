/* Melody — the doctor's consultation console (chat, skin report, clinical protocol, video call). */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ID = new URLSearchParams(location.search).get('id');
let token = null;
try { token = localStorage.getItem('melodyAdminToken'); } catch {}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const ICON_DOC = '<svg viewBox="0 0 24 24"><path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></svg>';

let appt = null, state = { open: false }, lastAt = null, lastDay = '', initial = '?';
let tab = 'chat', suggestions = null;

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('Please log in on the clinic page first.');
  if (!res.ok) throw new Error(data.message || 'Request failed (' + res.status + ')');
  return data;
}
function toast(msg) {
  $('toast').textContent = msg; $('toast').hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => ($('toast').hidden = true), 3500);
}
const clock = (iso) => { const d = new Date(iso); return `${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`; };
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function dayLabel(iso) {
  const d = new Date(iso), t = new Date(), y = new Date(); y.setDate(t.getDate() - 1);
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (d.toDateString() === t.toDateString()) return `TODAY, ${md}`;
  if (d.toDateString() === y.toDateString()) return `YESTERDAY, ${md}`;
  return `${DAYS[d.getDay()]}, ${md}`;
}
function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60e3);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m > 1 ? 's' : ''} ago`;
  const h = Math.round(m / 60);
  return `${h} hour${h > 1 ? 's' : ''} ago`;
}

/* ---------- messages ---------- */
function render(m) {
  let html = '';
  const day = dayLabel(m.createdAt);
  if (day !== lastDay) { lastDay = day; html += `<div class="pill-date">${day}</div>`; }
  if (m.from === 'system') return html + `<div class="sys">${esc(m.text)}</div>`;
  if (m.kind === 'product' && m.product) {
    const p = m.product;
    return html + `<div class="card"><div class="img"><img src="${esc(p.imageUrl)}" alt="" data-fallback="1" /></div>
      ${p.match != null ? `<div class="score"><b>${p.match}%</b><span>MATCH SCORE</span></div>` : ''}
      <h4>Suggested Treatment</h4><div class="sub">${esc(p.name)}</div><p>${esc(m.text)}</p><div class="sent">Sent ${clock(m.createdAt)}</div></div>`;
  }
  if (m.kind === 'report') {
    return html + `<div class="card"><div class="img"><div class="doc">${ICON_DOC}</div></div>
      <h4>Report ID: #${esc(m.reportCode)}</h4><div class="sub" data-ago="${m.createdAt}">Processed ${ago(m.createdAt)}</div><p>${esc(m.text)}</p>
      <a class="btn" href="${esc(m.url)}" target="_blank" rel="noopener">DOWNLOAD PDF</a></div>`;
  }
  const patient = m.from === 'patient';
  let body = esc(m.text);
  let cls = patient ? 'patient' : 'theirs';
  if (m.url && m.kind === 'image') { cls += ' photo'; body = `<img class="att" src="${esc(m.url)}" alt="photo" data-view="${esc(m.url)}" />` + (m.text ? `<div style="padding:8px 6px 2px">${esc(m.text)}</div>` : ''); }
  else if (m.url && m.kind === 'audio') body = `<audio controls preload="none" src="${esc(m.url)}"></audio><small>Voice note${m.durationSec ? ' · ' + Math.floor(m.durationSec / 60) + ':' + String(m.durationSec % 60).padStart(2, '0') : ''}</small>`;
  else if (m.url) body = `<a class="file" href="${esc(m.url)}" target="_blank" rel="noopener">${ICON_DOC}<span><b>${esc(m.fileName || 'File')}</b><small>${Math.max(1, Math.round((m.size || 0) / 1024))} KB</small></span></a>`;
  return html + `<div class="row ${patient ? 'mine' : ''}"><div class="col"><div class="bubble ${cls}">${body}</div><div class="time">${clock(m.createdAt)}</div></div>${patient ? `<div class="pav">${esc(initial)}</div>` : ''}</div>`;
}

async function poll() {
  try {
    const r = await api(`/appointments/${ID}/messages${lastAt ? '?after=' + encodeURIComponent(lastAt) : ''}`);
    const log = $('log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    if (r.items.length) {
      $('empty')?.remove();
      log.insertAdjacentHTML('beforeend', r.items.map(render).join(''));
      lastAt = r.items[r.items.length - 1].createdAt;
      if (atBottom || !poll.done) log.scrollTop = log.scrollHeight;
    } else if (!poll.done && $('empty')) $('empty').textContent = 'No messages yet.';
    poll.done = true;
    const changed = r.open !== state.open || r.reportAccess !== state.reportAccess;
    state = r;
    $('typingRow').hidden = !r.patientTyping;
    $('pDot').classList.toggle('off', !r.open);
    applyOpen();
    if (changed && tab === 'report') renderReport();
    document.querySelectorAll('[data-ago]').forEach((el) => (el.textContent = 'Processed ' + ago(el.dataset.ago)));
  } catch (e) { toast(e.message); }
}

function applyOpen() {
  const open = state.open;
  $('form').hidden = !open;
  $('closed').hidden = open;
  if (!open) $('closed').innerHTML = `This consultation is closed. Write the clinical summary with <b>Complete</b> on the <a href="clinic.html">clinic page</a>.`;
  $('endBtn').setAttribute('aria-label', open ? 'End consultation' : 'Back to clinic');
  $('timer').hidden = !appt || appt.status === 'requested';
  if (appt?.type === 'video') {
    $('callBanner').hidden = !!room;
    $('joinBtn').disabled = !open || !appt.videoReady;
    $('callBannerText').textContent = !appt.videoReady ? 'Video calls aren’t set up on the server (LIVEKIT_URL / keys).' : open ? 'Video consultation' : 'The call opens 10 minutes before the start.';
  }
}

/* ---------- sending ---------- */
let typingSent = 0;
$('input').addEventListener('input', () => {
  if (Date.now() - typingSent < 3000) return;
  typingSent = Date.now();
  api(`/appointments/${ID}/staff-typing`, { method: 'POST' }).catch(() => {});
});
$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = $('input').value.trim();
  if (!t) return;
  $('sendBtn').disabled = true;
  try { await api(`/appointments/${ID}/staff-message`, { method: 'POST', body: { text: t } }); $('input').value = ''; await poll(); $('log').scrollTop = 1e9; }
  catch (err) { toast(err.message); }
  finally { $('sendBtn').disabled = false; }
});

$('plusBtn').onclick = () => ($('menu').hidden = !$('menu').hidden);
document.addEventListener('click', (e) => { if (!e.target.closest('#menu, #plusBtn')) $('menu').hidden = true; });
$('menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pick]'); if (!b) return;
  $('menu').hidden = true;
  if (b.dataset.pick === 'image') $('fileImage').click();
  if (b.dataset.pick === 'file') $('fileDoc').click();
  if (b.dataset.pick === 'voice') startRecording();
});
const readAsDataUrl = (blob) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = fail; r.readAsDataURL(blob); });
async function sendFile(file, kind, extra = {}) {
  if (file.size > 8 * 1024 * 1024) return toast('Files can be up to 8 MB.');
  try {
    const data = (await readAsDataUrl(file)).replace(/^data:([^;,]*)[^,]*,/, (_m, t) => `data:${t || file.type || 'application/octet-stream'};base64,`);
    await api(`/appointments/${ID}/staff-files`, { method: 'POST', body: { kind, data, name: file.name || extra.name, ...extra } });
    await poll(); $('log').scrollTop = 1e9;
  } catch (err) { toast(err.message); }
}
$('fileImage').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) sendFile(f, 'image'); };
$('fileDoc').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) sendFile(f, 'file'); };

/* voice notes (MediaRecorder) */
let recording = null;
async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('This browser can’t record audio.');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast('Please allow the microphone to record a voice note.'); }
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const ctx = new AudioContext();
  const an = ctx.createAnalyser(); an.fftSize = 256;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.fftSize);
  const levels = Array(22).fill(0.15);
  const began = Date.now();
  recording = { rec, stream, ctx, chunks, began, send: false };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop()); ctx.close();
    clearInterval(recording.timer);
    const r = recording; recording = null;
    $('recRow').hidden = true; $('recLabel').hidden = true; $('input').hidden = false;
    $('plusBtn').innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
    $('sendBtn').innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 12l16-8-6 16-2-6z"/></svg>';
    applyOpen();
    const secs = Math.round((Date.now() - r.began) / 1000);
    if (!r.send) return;
    if (secs < 1) return toast('The voice note was too short.');
    const blob = new Blob(r.chunks, { type: rec.mimeType || 'audio/webm' });
    await sendFile(new File([blob], 'voice-note.webm', { type: blob.type.split(';')[0] }), 'audio', { durationSec: secs });
  };
  rec.start(250);
  $('recRow').hidden = false; $('recLabel').hidden = false; $('input').hidden = true;
  $('plusBtn').innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  $('sendBtn').innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
  recording.timer = setInterval(() => {
    an.getByteTimeDomainData(buf);
    let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
    levels.shift(); levels.push(Math.max(0.08, Math.min(1, peak * 2.2)));
    $('levels').innerHTML = levels.map((l) => `<i style="height:${6 + l * 40}px"></i>`).join('');
    const s = (Date.now() - began) / 1000;
    $('recTime').textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    if (s > 300) stopRecording(true);
  }, 120);
}
function stopRecording(send) { if (!recording) return; recording.send = send; recording.rec.stop(); }
$('plusBtn').addEventListener('click', (e) => { if (recording) { e.stopImmediatePropagation(); $('menu').hidden = true; stopRecording(false); } }, true);
$('sendBtn').addEventListener('click', (e) => { if (recording) { e.preventDefault(); stopRecording(true); } });

/* product photos that fail to load → document icon (inline onerror is blocked by the page's CSP) */
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.dataset.fallback) img.replaceWith(Object.assign(document.createElement('div'), { className: 'doc', innerHTML: ICON_DOC }));
  else if (img.tagName === 'IMG' && img.classList.contains('thumb')) img.style.visibility = 'hidden';
}, true);

/* photos open full screen */
$('log').addEventListener('click', (e) => { const v = e.target.dataset?.view; if (v) { $('viewerImg').src = v; $('viewer').hidden = false; } });
$('viewer').onclick = () => ($('viewer').hidden = true);

/* ---------- rail: chat / skin report / clinical protocol ---------- */
document.querySelector('.rail').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  tab = b.dataset.tab === tab ? 'chat' : b.dataset.tab;
  document.querySelectorAll('.rail-btn').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  $('sheet-protocol').hidden = tab !== 'protocol';
  $('sheet-report').hidden = tab !== 'report';
  $('app').classList.toggle('sheet-open', tab !== 'chat');
  if (tab === 'protocol') loadProtocol();
  if (tab === 'report') renderReport();
});

async function loadProtocol() {
  $('protoList').innerHTML = '<p class="muted small">Matching products to the patient’s scan…</p>';
  try {
    suggestions = await api(`/appointments/${ID}/staff-suggestions`);
    $('protoSub').textContent = `Ranked for the scan of ${new Date(suggestions.scanDate).toLocaleDateString()}${suggestions.focusLabel ? ' · focus: ' + suggestions.focusLabel : ''}`;
    $('protoList').innerHTML = suggestions.items.map((p) => `
      <div class="pcard">
        <div class="top-row">${p.imageUrl ? `<img class="thumb" src="${esc(p.imageUrl)}" alt="" />` : '<div class="thumb"></div>'}<div class="score"><b>${p.match}%</b><span>MATCH SCORE</span></div></div>
        <h5>${esc(p.name)}</h5><p title="${esc(p.why)}">${esc(p.description || p.why)}</p>
        <button data-send="${p.id}" ${state.open ? '' : 'disabled'}>SEND</button>
      </div>`).join('') || '<p class="muted small">No products in the catalogue yet.</p>';
  } catch (err) {
    $('protoSub').textContent = '';
    $('protoList').innerHTML = `<p class="muted small">${esc(err.message)}</p>`;
  }
}
$('protoList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-send]'); if (!b) return;
  b.disabled = true; b.textContent = 'SENDING…';
  try { await api(`/appointments/${ID}/staff-product`, { method: 'POST', body: { productId: b.dataset.send } }); b.textContent = 'SENT ✓'; await poll(); $('log').scrollTop = 1e9; }
  catch (err) { toast(err.message); b.disabled = false; b.textContent = 'SEND'; }
});

async function renderReport() {
  const ra = state.reportAccess ?? 'none';
  let scans = '';
  if (ra === 'approved') {
    try {
      const r = await api(`/appointments/${ID}/patient-report`);
      scans = r.scans.length
        ? `<div class="scanlist">${r.scans.map((x) => `<div class="scan"><b>${new Date(x.at).toLocaleString()}</b> · score ${x.score ?? '—'}${x.skinType ? ' · ' + esc(x.skinType) : ''}<br>${Object.entries(x.metrics || {}).filter(([, v]) => v != null).map(([k, v]) => `${k} ${Math.round(v)}`).join(' · ')}${x.concerns.length ? '<br>Concerns: ' + esc(x.concerns.join(', ')) : ''}</div>`).join('')}</div>`
        : '<p class="muted small">No skin scans in the last 7 days.</p>';
      if (r.sleep.length) scans += `<p class="muted small">Sleep: ${r.sleep.map((h) => `${esc(h.date)} ${h.hours ?? '—'} h`).join(' · ')}</p>`;
    } catch (err) { scans = `<p class="muted small">${esc(err.message)}</p>`; }
  }
  const access = {
    none: `<p class="muted small">Ask the patient to share their skin scans and sleep logs from the last 7 days (access lasts 24 hours after they approve).</p><button class="btn-ghost" id="reqBtn" ${state.open ? '' : 'disabled'}>Request report access</button>`,
    requested: '<p class="muted small">Waiting for the patient to approve…</p>',
    declined: `<p class="muted small">The patient declined to share their tracking.</p><button class="btn-ghost" id="reqBtn" ${state.open ? '' : 'disabled'}>Ask again</button>`,
    approved: '<p class="muted small">The patient shared their last 7 days:</p>',
  }[ra];
  $('reportBody').innerHTML = `${access}${scans}
    <div class="eyebrow" style="margin-top:14px">SEND A REPORT</div>
    <p class="muted small">A PDF with the patient’s ${appt?.hasScan || ra === 'approved' ? 'latest shared scan' : 'scan (none shared yet)'} and your note.</p>
    <textarea id="repNote" placeholder="e.g. Hydration in the T-zone has improved; cheeks still show mild dehydration…"></textarea>
    <button class="btn-brown" id="repSend" ${state.open && (appt?.hasScan || ra === 'approved') ? '' : 'disabled'}>SEND REPORT</button>`;
}
$('reportBody').addEventListener('click', async (e) => {
  if (e.target.id === 'reqBtn') {
    e.target.disabled = true;
    try { await api(`/appointments/${ID}/request-report`, { method: 'POST' }); await poll(); renderReport(); } catch (err) { toast(err.message); e.target.disabled = false; }
  }
  if (e.target.id === 'repSend') {
    e.target.disabled = true;
    try { await api(`/appointments/${ID}/staff-report`, { method: 'POST', body: { note: $('repNote').value } }); $('repNote').value = ''; toast('Report sent.'); await poll(); $('log').scrollTop = 1e9; }
    catch (err) { toast(err.message); }
    e.target.disabled = false;
  }
});

/* ---------- end ---------- */
$('endBtn').onclick = () => (state.open ? $('endDlg').showModal() : (location.href = 'clinic.html'));
$('endCancel').onclick = () => $('endDlg').close();
$('endOk').onclick = async () => {
  try { await api(`/appointments/${ID}/end-chat`, { method: 'POST' }); $('endDlg').close(); leaveCall(); await poll(); } catch (err) { toast(err.message); }
};

/* ---------- video call (LiveKit) ---------- */
let room = null, callStarted = null, soundOn = true;
const LK = window.LivekitClient;
$('joinBtn').onclick = joinCall;
async function joinCall() {
  if (!LK) return toast('The video library didn’t load.');
  $('joinBtn').disabled = true;
  try {
    const { url, token: t } = await api(`/appointments/${ID}/staff-call`);
    room = new LK.Room({ adaptiveStream: true, dynacast: true });
    room
      .on(LK.RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === 'video') { track.attach($('remoteVideo')); $('callWait').hidden = true; callStarted ??= Date.now(); }
        if (track.kind === 'audio') { const el = track.attach(); el.muted = !soundOn; $('remoteAudio').appendChild(el); }
      })
      .on(LK.RoomEvent.TrackUnsubscribed, (track) => { track.detach().forEach((el) => el.id !== 'remoteVideo' && el.remove()); if (track.kind === 'video') $('callWait').hidden = false; })
      .on(LK.RoomEvent.ParticipantConnected, () => { $('callWait').textContent = 'Connecting video…'; callStarted ??= Date.now(); })
      .on(LK.RoomEvent.ParticipantDisconnected, () => { $('callWait').hidden = false; $('callWait').textContent = 'The patient left the call.'; })
      .on(LK.RoomEvent.LocalTrackPublished, (pub) => { if (pub.track?.kind === 'video') pub.track.attach($('localVideo')); })
      .on(LK.RoomEvent.Disconnected, () => { room = null; $('call').hidden = true; applyOpen(); });
    await room.connect(url, t);
    $('call').hidden = false; $('callBanner').hidden = true;
    $('callWait').hidden = false; $('callWait').textContent = 'Waiting for the patient to join…';
    if (room.remoteParticipants.size) $('callWait').textContent = 'Connecting video…';
    try { await room.localParticipant.enableCameraAndMicrophone(); } catch { toast('Camera or microphone blocked — allow them in the browser.'); }
    for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) if (pub.track) room.emit(LK.RoomEvent.TrackSubscribed, pub.track, pub, p);
    syncButtons();
  } catch (err) { toast(err.message); room = null; }
  $('joinBtn').disabled = false;
}
function leaveCall() { if (room) room.disconnect(); }
function syncButtons() {
  if (!room) return;
  const lp = room.localParticipant;
  $('camBtn').classList.toggle('off', !lp.isCameraEnabled);
  $('micBtn').classList.toggle('off', !lp.isMicrophoneEnabled);
  $('spkBtn').classList.toggle('off', !soundOn);
  $('camBtn').setAttribute('aria-label', lp.isCameraEnabled ? 'Turn camera off' : 'Turn camera on');
  $('micBtn').setAttribute('aria-label', lp.isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone');
}
$('camBtn').onclick = async () => { await room?.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled); syncButtons(); };
$('micBtn').onclick = async () => { await room?.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled); syncButtons(); };
$('spkBtn').onclick = () => { soundOn = !soundOn; $('remoteAudio').querySelectorAll('audio').forEach((a) => (a.muted = !soundOn)); syncButtons(); };
$('hangBtn').onclick = leaveCall;
$('moreBtn').onclick = () => { $('call').hidden = true; $('callBanner').hidden = false; $('callBannerText').textContent = 'Call in progress'; $('joinBtn').textContent = 'Return to call'; $('joinBtn').onclick = () => { $('call').hidden = false; $('callBanner').hidden = true; }; };
$('flipBtn').onclick = async () => {
  if (!room) return;
  const cams = await LK.Room.getLocalDevices('videoinput');
  if (cams.length < 2) return toast('Only one camera found.');
  const cur = room.getActiveDevice('videoinput');
  const i = cams.findIndex((c) => c.deviceId === cur);
  await room.switchActiveDevice('videoinput', cams[(i + 1) % cams.length].deviceId);
};

/* ---------- start ---------- */
setInterval(() => {
  if (!appt) return;
  const began = Date.parse(appt.acceptedAt ?? appt.start);
  const end = state.endedAt ? Date.parse(state.endedAt) : Date.now();
  $('timerText').textContent = mmss(Math.max(0, (end - began) / 1000));
  $('cTimer').textContent = callStarted ? mmss((Date.now() - callStarted) / 1000) : '00:00';
}, 1000);

(async function start() {
  if (!ID) { $('empty').textContent = 'No consultation selected.'; return; }
  if (!token) { $('empty').innerHTML = 'Please <a href="clinic.html">log in on the clinic page</a> first.'; return; }
  try {
    appt = await api(`/appointments/${ID}/staff`);
    const name = appt.patient?.name ?? 'Patient';
    initial = (name.trim()[0] ?? '?').toUpperCase();
    document.title = `${name} — Melody consultation`;
    for (const [a, n] of [['pAvatar', 'pName'], ['cAvatar', 'cName']]) {
      $(a).firstChild.textContent = initial;
      $(n).textContent = name;
    }
    const sub = appt.type === 'video' ? 'VIDEO CONSULTATION' : 'CHAT CONSULTATION';
    $('top').title = `As ${appt.doctor?.name ?? 'the specialist'}`;
    $('pRole').textContent = sub; $('cRole').textContent = sub;
    applyOpen();
    await poll();
    setInterval(poll, 3000);
  } catch (err) { $('empty').textContent = err.message; }
})();
