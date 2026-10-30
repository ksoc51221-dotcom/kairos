// The recordings page: a grid of what the extension saved on this device, and a player with download, rename and delete.
const C = self.KairosCore, DB = self.KairosDB;
KairosIcons.fill();
const $ = (id) => document.getElementById(id);
const BLOB_URLS = [];
const url = (blob) => { const u = URL.createObjectURL(blob); BLOB_URLS.push(u); return u; };
const releaseUrls = () => BLOB_URLS.splice(0).forEach((u) => URL.revokeObjectURL(u));
const when = (t) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const metaOf = (r) => [when(r.createdAt), C.formatBytes(r.size), C.MODES[r.mode] ? C.MODES[r.mode].label : ''].filter(Boolean).join(' · ');

// ---- crash recovery: chunks without a finished recording mean the browser or recorder died mid-recording ----
async function recoverOrphans() {
  const st = (await chrome.storage.session.get('rec')).rec;
  if (st && st.phase !== 'idle') return;                       // a recording is running right now: its chunks are not orphans
  const known = new Set((await DB.listRecordings()).map((r) => r.id));
  for (const id of await DB.orphanedRecordingIds()) {
    if (known.has(id)) { await DB.deleteChunks(id); continue; }
    const parts = await DB.getChunks(id);
    const type = parts[0] && parts[0].blob.type ? parts[0].blob.type : 'video/webm';
    const blob = new Blob(parts.map((p) => p.blob), { type });
    if (!blob.size) { await DB.deleteChunks(id); continue; }
    const created = parseInt(id.slice(1, 9), 36) || Date.now();   // newId() starts with the time in base 36
    await DB.putRecording({ id, title: 'Recovered recording', mode: 'screen', createdAt: created, durationMs: 0, size: blob.size, mime: type.split(';')[0], ext: type.includes('mp4') ? 'mp4' : 'webm', blob, thumb: null, recovered: true });
    await DB.deleteChunks(id);
  }
}

// ---- thumbnails: drawn once from the video itself, then saved ----
function makeThumb(rec) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const u = URL.createObjectURL(rec.blob);
    const done = (b) => { URL.revokeObjectURL(u); v.removeAttribute('src'); v.load(); resolve(b); };
    v.muted = true; v.preload = 'auto'; v.src = u;
    v.onerror = () => done(null);
    v.onloadeddata = () => { try { v.currentTime = Math.min(1, (isFinite(v.duration) ? v.duration : 2) / 2); } catch { done(null); } };
    v.onseeked = () => {
      const c = document.createElement('canvas'); c.width = 480; c.height = Math.round(480 * (v.videoHeight || 270) / (v.videoWidth || 480));
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((b) => done(b), 'image/jpeg', 0.8);
    };
    setTimeout(() => done(null), 8000);
  });
}

// ---- list ----
async function showList() {
  $('playerView').hidden = true; $('listView').hidden = false;
  const video = $('video'); video.pause(); video.removeAttribute('src'); video.load(); releaseUrls();
  await recoverOrphans().catch(() => {});
  const recs = await DB.listRecordings();
  const total = recs.reduce((n, r) => n + (r.size || 0), 0);
  $('summary').textContent = recs.length ? `${recs.length} recording${recs.length === 1 ? '' : 's'} · ${C.formatBytes(total)} on this device` : '';
  $('empty').hidden = recs.length > 0; $('heading').hidden = recs.length === 0;
  const grid = $('grid'); grid.replaceChildren();
  for (const r of recs) grid.appendChild(card(r));
}
function card(r) {
  const c = el('article', 'card');
  const thumb = el('button', 'thumb'); thumb.setAttribute('aria-label', 'Play ' + r.title);
  if (r.thumb) thumb.style.backgroundImage = `url(${url(r.thumb)})`;
  else makeThumb(r).then(async (b) => { if (!b) return; thumb.style.backgroundImage = `url(${url(b)})`; const fresh = await DB.getRecording(r.id); if (fresh) { fresh.thumb = b; await DB.putRecording(fresh); } });
  thumb.append(el('span', 'mode', C.MODES[r.mode] ? C.MODES[r.mode].label : ''), el('span', 'dur', C.formatTime(r.durationMs || 0)));
  thumb.onclick = () => { location.hash = '#/v/' + r.id; };
  const body = el('div', 'body'); body.append(el('div', 'name', r.title), el('div', 'sub', metaOf(r)));
  const tools = el('div', 'tools');
  const dl = el('button', 'icon-btn'); dl.title = 'Download'; dl.setAttribute('aria-label', 'Download'); dl.innerHTML = KairosIcons.svg('download'); dl.onclick = () => download(r);
  const del = el('button', 'icon-btn danger'); del.title = 'Delete'; del.setAttribute('aria-label', 'Delete'); del.innerHTML = KairosIcons.svg('trash'); del.onclick = () => remove(r);
  tools.append(dl, del);
  c.append(thumb, body, tools);
  return c;
}

function download(r) {
  const a = document.createElement('a');
  a.href = url(r.blob); a.download = C.safeFileName(r.title) + '.' + r.ext;
  document.body.appendChild(a); a.click(); a.remove();
}
async function remove(r) {
  if (!confirm(`Delete "${r.title}"? This cannot be undone.`)) return;
  await DB.deleteRecording(r.id);
  if (location.hash.startsWith('#/v/')) location.hash = '#/'; else showList();
}

// ---- player ----
async function showPlayer(id) {
  const r = await DB.getRecording(id);
  if (!r) { location.hash = '#/'; return; }
  $('listView').hidden = true; $('playerView').hidden = false;
  releaseUrls();
  const v = $('video');
  v.src = url(r.blob);
  // A WebM written by MediaRecorder has no duration until the end is found: jump there once so the seek bar works.
  v.onloadedmetadata = () => { if (v.duration === Infinity) { v.currentTime = 1e101; v.ontimeupdate = () => { v.ontimeupdate = null; v.currentTime = 0; }; } };
  const t = $('title'); t.value = r.title;
  t.onchange = async () => { r.title = t.value.trim() || r.title; t.value = r.title; const fresh = await DB.getRecording(id); fresh.title = r.title; await DB.putRecording(fresh); };
  $('metaLine').textContent = metaOf(r) + ' · ' + C.formatTime(r.durationMs || 0) + (r.hasAudio === false ? ' · no sound' : '');
  $('download').onclick = () => download(r);
  $('delete').onclick = () => remove(r);
  document.title = r.title + ' · Kairos';
}

// ---- routing ----
function route() {
  const h = location.hash;
  if (h.startsWith('#/v/')) return showPlayer(h.slice(4));
  document.title = 'Kairos recordings';
  $('welcome').hidden = h !== '#/welcome';
  return showList();
}
$('dismiss').onclick = () => { location.hash = '#/'; };
$('setup').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html?need=camera,mic&mode=setup') });
$('tryit').onclick = () => chrome.tabs.create({ url: 'https://example.com/' });   // any ordinary website shows the button; this one is empty and always there
addEventListener('hashchange', route);
route();
