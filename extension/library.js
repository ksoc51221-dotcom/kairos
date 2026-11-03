// The recordings page: rows of what the extension saved on this device, and a player with download, rename and delete.
const C = self.KairosCore, DB = self.KairosDB;
KairosIcons.fill();
const $ = (id) => document.getElementById(id);
const BLOB_URLS = [];
const url = (blob) => { const u = URL.createObjectURL(blob); BLOB_URLS.push(u); return u; };
const releaseUrls = () => BLOB_URLS.splice(0).forEach((u) => URL.revokeObjectURL(u));
const when = (t) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const modeOf = (r) => C.MODES[r.mode] ? C.MODES[r.mode].label : '';
const metaOf = (r) => [when(r.createdAt), C.formatBytes(r.size), modeOf(r)].filter(Boolean).join(' · ');
const subOf = (r) => [C.formatBytes(r.size), modeOf(r)].filter(Boolean).join(' · ');

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

// ---- thumbnails: drawn once from the video itself, then saved (for both Rows and Grid) ----
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

// ---- view: Rows (default) or Grid ----
let VIEW = 'rows';
try { if (localStorage.getItem('kairosLibView') === 'grid') VIEW = 'grid'; } catch { /* storage may be blocked */ }
function setView(v) {
  VIEW = v; try { localStorage.setItem('kairosLibView', v); } catch { /* ignore */ }
  paintToggle(); showList();
}
function paintToggle() {
  $('viewRows').setAttribute('aria-pressed', String(VIEW === 'rows')); $('viewGrid').setAttribute('aria-pressed', String(VIEW === 'grid'));
  $('grid').classList.toggle('as-grid', VIEW === 'grid');
}

// ---- list ----
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
// number roll: the count climbs from 0 to n once (skipped under reduced motion)
function roll(node, n, fmt) {
  if (REDUCED.matches || n < 2) { node.textContent = fmt(n); return; }
  const t0 = performance.now(), dur = 420;
  const step = (t) => { const k = Math.min(1, (t - t0) / dur); node.textContent = fmt(Math.round(n * (1 - Math.pow(1 - k, 3)))); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
const MODE_ICON = { both: 'video', screen: 'monitor', camera: 'person' };
async function showList() {
  $('playerView').hidden = true; $('listView').hidden = false;
  const video = $('video'); video.pause(); video.removeAttribute('src'); video.load(); releaseUrls();
  await recoverOrphans().catch(() => {});
  const recs = await DB.listRecordings();
  const total = recs.reduce((n, r) => n + (r.size || 0), 0);
  const sum = $('summary');
  if (recs.length) { roll(sum, recs.length, (n) => `${n} ${recs.length === 1 ? 'recording' : 'recordings'} · ${C.formatBytes(total)}`); } else sum.textContent = '';
  $('empty').hidden = recs.length > 0; $('heading').hidden = recs.length === 0;
  const grid = $('grid'); grid.replaceChildren(); grid.classList.add('i-stagger'); paintToggle();
  recs.forEach((r, i) => { const c = card(r); c.style.setProperty('--i', Math.min(i, 8)); grid.appendChild(c); });
}
// Rows: the thumbnail is saved/generated only when its row scrolls into view
const THUMB_IO = 'IntersectionObserver' in self ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { THUMB_IO.unobserve(e.target); e.target._go(); } }), { rootMargin: '200px' }) : null;
function lazyThumb(r, box) {
  const paint = (b) => { box.style.backgroundImage = `url(${url(b)})`; box.classList.add('has'); };
  if (r.thumb) { paint(r.thumb); return; }
  box._go = () => makeThumb(r).then(async (b) => { if (!b) return; paint(b); const fresh = await DB.getRecording(r.id); if (fresh) { fresh.thumb = b; await DB.putRecording(fresh); } });
  if (THUMB_IO) THUMB_IO.observe(box); else box._go();
}
// Hover actions: copy link when the recording has a shareable URL, otherwise download; a "more" menu holds download and delete.
function iconBtn(name, label, fn, cls) {
  const b = el('button', 'icon-btn' + (cls ? ' ' + cls : '')); b.title = label; b.setAttribute('aria-label', label); b.innerHTML = KairosIcons.svg(name);
  b.onclick = (e) => { e.stopPropagation(); fn(b); }; return b;
}
function closeMenus() { document.querySelectorAll('.menu').forEach((m) => m.remove()); }
addEventListener('click', closeMenus); addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
function toolsFor(r) {
  const tl = el('div', 'tools');
  const primary = r.shareUrl
    ? iconBtn('link', 'Copy link', () => navigator.clipboard && navigator.clipboard.writeText(r.shareUrl).catch(() => {}))
    : iconBtn('download', 'Download', () => download(r));
  const more = iconBtn('more', 'More actions', (b) => {
    const open = b.nextElementSibling && b.nextElementSibling.classList.contains('menu'); closeMenus(); if (open) return;
    const m = el('div', 'menu'); m.setAttribute('role', 'menu'); m.onclick = (e) => e.stopPropagation();
    const item = (icon, text, fn, cls) => { const i = el('button', cls); i.setAttribute('role', 'menuitem'); i.innerHTML = KairosIcons.svg(icon) + '<span></span>'; i.lastChild.textContent = text; i.onclick = () => { closeMenus(); fn(); }; return i; };
    m.append(item('download', 'Download', () => download(r)), item('trash', 'Delete', () => remove(r), 'danger'));
    b.after(m); m.firstChild.focus();
  });
  tl.append(primary, more);
  return tl;
}
function card(r) {
  const c = el('article', VIEW === 'grid' ? 'card tile' : 'card');
  if (VIEW === 'grid') {
    const thumb = el('button', 'thumb'); thumb.setAttribute('aria-label', 'Play ' + r.title);
    if (r.thumb) thumb.style.backgroundImage = `url(${url(r.thumb)})`;
    else makeThumb(r).then(async (b) => { if (!b) return; thumb.style.backgroundImage = `url(${url(b)})`; const fresh = await DB.getRecording(r.id); if (fresh) { fresh.thumb = b; await DB.putRecording(fresh); } });
    thumb.append(el('span', 'dur', C.formatTime(r.durationMs || 0)));
    thumb.onclick = () => { location.hash = '#/v/' + r.id; };
    const body = el('div', 'body'); body.append(el('div', 'name', r.title), el('div', 'sub', when(r.createdAt) + ' · ' + subOf(r)));
    c.title = metaOf(r); c.append(thumb, body, toolsFor(r));
    return c;
  }
  const open = el('button', 'open'); open.setAttribute('aria-label', 'Play ' + r.title); open.onclick = () => { location.hash = '#/v/' + r.id; };
  const glyph = el('span', 'glyph'); glyph.innerHTML = KairosIcons.svg(MODE_ICON[r.mode] || 'film');
  glyph.append(el('span', 'dur', C.formatTime(r.durationMs || 0)));
  lazyThumb(r, glyph);
  c.title = metaOf(r);
  const text = el('div', 'text'); text.append(el('span', 'name', r.title), el('span', 'sub', subOf(r)));
  const end = el('div', 'end'); end.append(el('span', 'when', when(r.createdAt)), toolsFor(r));
  c.append(open, glyph, text, end);
  return c;
}

function download(r) {
  const a = document.createElement('a');
  a.href = url(r.blob); a.download = C.safeFileName(r.title) + '.' + r.ext;
  document.body.appendChild(a); a.click(); a.remove();
}
function confirmDelete(r) {
  return new Promise((resolve) => {
    const d = el('dialog', 'confirm');
    const h = el('h2', null, `Delete "${r.title}"?`), p = el('p', 'label', 'This cannot be undone.');
    const actions = el('div', 'row-actions'), no = el('button', 'btn', 'Cancel'), yes = el('button', 'btn danger solid', 'Delete');
    actions.append(no, yes); d.append(h, p, actions);
    let out = false;
    no.onclick = () => d.close(); yes.onclick = () => { out = true; d.close(); };
    d.addEventListener('close', () => { d.remove(); resolve(out); });
    document.body.appendChild(d); d.showModal(); no.focus();
  });
}
async function remove(r) {
  if (!(await confirmDelete(r))) return;
  await DB.deleteRecording(r.id);
  const gone = [...document.querySelectorAll('.card')].find((n) => n.title === metaOf(r));
  if (gone && !REDUCED.matches && !location.hash.startsWith('#/v/')) { gone.classList.add('out'); await new Promise((res) => setTimeout(res, 150)); }
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
  $('metaLine').textContent = (metaOf(r) + ' · ' + C.formatTime(r.durationMs || 0) + (r.hasAudio === false ? ' · no sound' : ''));
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
$('viewRows').onclick = () => setView('rows'); $('viewGrid').onclick = () => setView('grid');
$('dismiss').onclick = () => { location.hash = '#/'; };
$('setup').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html?need=camera,mic&mode=setup') });
$('tryit').onclick = () => chrome.tabs.create({ url: 'https://example.com/' });   // any ordinary website shows the button; this one is empty and always there
addEventListener('hashchange', route);
route();
