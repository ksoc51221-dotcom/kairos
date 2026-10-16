// Recorder menu: source → camera → microphone → Start, with Effects / Quality / Notes / More in the toolbar underneath.
const C = window.SPOOL, I = window.IrisIcons, $ = (id) => document.getElementById(id);
const MARGIN = 6; // transparent margin around the card, for its shadow

// What the user has chosen. `source` is what is recorded; the camera row decides between Screen and Screen + Cam.
const st = {
  source: 'screen',            // screen | window | custom | camera
  sourceId: null, sourceName: '', crop: null,
  camOn: false, camId: '', camName: '',
  micOn: true, micId: '', micName: '',
  shape: 'circle', size: 200, filter: 'none', frame: 'ring',
  quality: C.DEFAULT_QUALITY, sysAudio: false, hideMenu: false, cursorFx: false, clickFx: true, pg: true,
};
const devices = { cams: [], mics: [] };
let displays = [], windows = [], openMenu = null, openPanel = null;

I.fill(document);

// ---------- preferences ----------
function load(c) {
  const p = c.prefs || {};
  // preferences from the first launcher (no `v`) keep their camera, shape and toggles, but not the old defaults for quality and the cursor ring
  const mode = p.mode;
  st.source = p.source || (mode === 'cam' ? 'camera' : 'screen');
  if (st.source === 'window') st.source = 'screen'; // a window id from a past session is not valid any more
  st.camOn = p.camOn !== undefined ? p.camOn : mode === 'screen-cam';
  st.micOn = p.micOn !== undefined ? p.micOn : true;
  for (const k of ['camId', 'camName', 'micId', 'micName', 'shape', 'size', 'filter', 'frame', 'sysAudio', 'hideMenu', 'clickFx']) if (p[k] !== undefined) st[k] = p[k];
  if (p.v === 2) { st.quality = p.quality; st.cursorFx = !!p.cursorFx; }
  st.pg = c.privacyGuard !== false;
}
function save() {
  const keys = ['source', 'camOn', 'micOn', 'camId', 'camName', 'micId', 'micName', 'shape', 'size', 'filter', 'frame', 'quality', 'sysAudio', 'hideMenu', 'cursorFx', 'clickFx'];
  const prefs = { v: 2 }; for (const k of keys) prefs[k] = st[k];
  spool.invoke('settings:set', { prefs, privacyGuard: st.pg });
  syncPreview();
}
// B27: tell the main process what camera preview to show behind the launcher (it closes it again when `on` is false or the launcher hides)
function syncPreview() {
  const on = mode() !== 'screen' && devices.cams.length > 0;
  spool.send('preview:set', { on, camId: st.camId, size: st.size, shape: st.shape, filter: st.filter, frame: st.frame });
}
const mode = () => (st.source === 'camera' ? 'cam' : st.camOn ? 'screen-cam' : 'screen');

// ---------- menus: one open at a time, height animated ----------
function setOpen(el, row, on) { el.classList.toggle('open', on); if (row) row.setAttribute('aria-expanded', String(on)); }
function toggleMenu(name) {
  const same = openMenu === name;
  if (openMenu) setOpen($(openMenu + 'Menu'), $(openMenu + 'Row'), false);
  openMenu = same ? null : name;
  if (openMenu) setOpen($(openMenu + 'Menu'), $(openMenu + 'Row'), true);
}
function closeMenus() { if (openMenu) toggleMenu(openMenu); }
function togglePanel(name) {
  const same = openPanel === name;
  openPanel = same ? null : name;
  document.querySelectorAll('#tools button').forEach((b) => b.classList.toggle('on', b.dataset.p === openPanel));
  if (openPanel === 'notes') { openPanel = null; document.querySelectorAll('#tools button').forEach((b) => b.classList.remove('on')); setOpen($('panel'), null, false); spool.invoke('notes:open'); return; }
  if (openPanel) renderPanel();
  setOpen($('panel'), null, !!openPanel);
}

// ---------- rows ----------
const SOURCE_ICON = { screen: 'monitor', window: 'window', custom: 'crop', camera: 'video' };
function paintRows() {
  $('srcIcon').innerHTML = I.svg(SOURCE_ICON[st.source]);
  $('srcLabel').textContent = st.source === 'screen' ? (displays.length > 1 ? displays.find((d) => d.id === st.sourceId)?.label || 'Full screen' : 'Full screen')
    : st.source === 'window' ? st.sourceName || 'Choose a window' : st.source === 'custom' ? 'Custom area' : 'Camera only';
  const camOn = st.camOn || st.source === 'camera';
  $('camIcon').innerHTML = I.svg(camOn ? 'video' : 'video-off'); $('camIcon').classList.toggle('off', !camOn);
  $('camLabel').textContent = camOn ? st.camName || 'Camera' : 'No Camera';
  $('camBadge').textContent = camOn ? 'On' : 'Off'; $('camBadge').className = 'badge ' + (camOn ? 'on' : 'off');
  $('micIcon').innerHTML = I.svg(st.micOn ? 'mic' : 'mic-off');
  $('micLabel').textContent = st.micOn ? st.micName || 'Microphone' : 'No microphone';
  $('micBadge').textContent = st.micOn ? 'On' : 'Off'; $('micBadge').className = 'badge ' + (st.micOn ? 'on' : 'off');
  paintSummary();
}
function paintSummary() {
  const q = C.QUALITIES.find((x) => x.key === st.quality) || C.QUALITIES[0], parts = [];
  if (mode() === 'screen-cam') parts.push(C.SHAPE_LABELS[st.shape]);
  if (mode() !== 'screen' && st.filter !== 'none') parts.push(C.FILTER_LABELS[st.filter]);
  parts.push(q.key === 'source' ? 'Source quality' : q.label);
  if (st.sysAudio) parts.push('system audio');
  if (st.cursorFx) parts.push('cursor ring');
  $('summary').textContent = parts.join(' · ');
}
function item(icon, label, on, fn) {
  const b = document.createElement('button'); b.className = 'menu-item' + (on ? ' on' : ''); b.innerHTML = `${icon ? I.svg(icon) : ''}<span class="grow">${label}</span>${on ? I.svg('check') : ''}`; b.onclick = fn; return b;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function paintSourceMenu() {
  const box = $('srcItems'); box.innerHTML = '';
  const screens = displays.length ? displays : [{ id: null, label: 'Full screen' }];
  for (const d of screens) box.appendChild(item('monitor', esc(d.label), st.source === 'screen' && (st.sourceId === d.id || (!st.sourceId && d === screens[0])), () => { st.source = 'screen'; st.sourceId = d.id; $('winGrid').hidden = true; afterPick(); }));
  box.appendChild(item('window', 'Window…', st.source === 'window', () => { st.source = 'window'; st.sourceId = null; st.sourceName = ''; showWindows(); paintRows(); save(); }));
  box.appendChild(item('crop', 'Custom area', st.source === 'custom', () => { st.source = 'custom'; st.sourceId = displays[0]?.id || null; $('winGrid').hidden = true; afterPick(); }));
  box.appendChild(item('video', 'Camera only', st.source === 'camera', () => { st.source = 'camera'; $('winGrid').hidden = true; if (!st.camOn) st.camOn = true; unlock('cam'); afterPick(); }));
}
function afterPick() { paintRows(); paintSourceMenu(); paintCamMenu(); save(); closeMenus(); }
async function showWindows() {
  const srcs = await spool.invoke('sources:list');
  windows = srcs.filter((s) => !s.isScreen);
  const g = $('winGrid'); g.innerHTML = ''; g.hidden = false;
  if (!windows.length) { g.innerHTML = '<span class="note" style="grid-column:1/3;padding:8px 2px">No windows found. Is Screen Recording allowed?</span>'; return; }
  windows.forEach((s) => {
    const d = document.createElement('div'); d.innerHTML = `<img alt="" src="${s.thumb}"><span>${esc(s.name)}</span>`;
    d.onclick = () => { st.sourceId = s.id; st.sourceName = s.name; g.hidden = true; paintRows(); paintSourceMenu(); save(); closeMenus(); };
    g.appendChild(d);
  });
}

function deviceName(d, i, kind) { return d.label || `${kind} ${i + 1}`; }
function paintCamMenu() {
  const box = $('camItems'); box.innerHTML = '';
  if (st.source !== 'camera') box.appendChild(item('video-off', 'No Camera', !st.camOn, () => { st.camOn = false; paintRows(); paintCamMenu(); save(); closeMenus(); }));
  devices.cams.forEach((d, i) => box.appendChild(item('video', esc(deviceName(d, i, 'Camera')), st.camOn && (st.camId === d.deviceId || (!st.camId && i === 0)), () => {
    st.camOn = true; st.camId = d.deviceId; st.camName = deviceName(d, i, 'Camera'); paintRows(); paintCamMenu(); save(); closeMenus();
  })));
  if (!devices.cams.length) { const n = document.createElement('p'); n.className = 'note'; n.style.padding = '8px 12px'; n.textContent = 'No camera found.'; box.appendChild(n); }
}
function paintMicMenu() {
  const box = $('micItems'); box.innerHTML = '';
  box.appendChild(item('mic-off', 'No microphone', !st.micOn, () => { st.micOn = false; paintRows(); paintMicMenu(); save(); closeMenus(); }));
  devices.mics.forEach((d, i) => box.appendChild(item('mic', esc(deviceName(d, i, 'Microphone')), st.micOn && (st.micId === d.deviceId || (!st.micId && i === 0)), () => {
    st.micOn = true; st.micId = d.deviceId; st.micName = deviceName(d, i, 'Microphone'); paintRows(); paintMicMenu(); save(); closeMenus();
  })));
}

// ---------- devices (B8: ask for permission once, and only when labels are empty; re-read on devicechange) ----------
const asked = {};
async function enumerate() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  devices.cams = devs.filter((d) => d.kind === 'videoinput'); devices.mics = devs.filter((d) => d.kind === 'audioinput');
  const cam = devices.cams.find((d) => d.deviceId === st.camId) || (st.camId ? null : devices.cams[0]), mic = devices.mics.find((d) => d.deviceId === st.micId) || (st.micId ? null : devices.mics[0]);
  if (cam && cam.label) st.camName = cam.label; if (mic && mic.label) st.micName = mic.label;
  paintRows(); paintCamMenu(); paintMicMenu(); syncPreview();
}
async function unlock(kind) {
  const list = kind === 'cam' ? devices.cams : devices.mics;
  if (asked[kind] || (list.length && list.every((d) => d.label))) return;
  asked[kind] = true;
  try { (await navigator.mediaDevices.getUserMedia(kind === 'cam' ? { video: true } : { audio: true })).getTracks().forEach((t) => t.stop()); } catch {}
  await enumerate();
}
navigator.mediaDevices.addEventListener('devicechange', enumerate);

// ---------- toolbar panels ----------
function chip(label, on, fn, icon) { const b = document.createElement('button'); b.className = 'chip' + (on ? ' on' : ''); b.innerHTML = (icon ? I.svg(icon) : '') + esc(label); b.onclick = fn; return b; }
function group(title, chips, cls = '') {
  const g = document.createElement('div'); g.innerHTML = `<h4>${title}</h4>`; const c = document.createElement('div'); c.className = 'chips ' + cls; chips.forEach((x) => c.appendChild(x)); g.appendChild(c); return g;
}
function toggle(label, key, onchange) {
  const l = document.createElement('label'); l.className = 'toggle'; l.innerHTML = `<input type="checkbox"><span>${label}</span>`;
  const i = l.querySelector('input'); i.checked = st[key]; i.onchange = () => { st[key] = i.checked; if (onchange) onchange(); paintSummary(); save(); }; return l;
}
function renderPanel() {
  const body = $('panelBody'); body.innerHTML = '';
  if (openPanel === 'effects') {
    const m = mode();
    if (m === 'screen') { const n = document.createElement('p'); n.className = 'note'; n.textContent = 'Turn the camera on to style it.'; body.appendChild(n); return; }
    if (m === 'screen-cam') {
      body.appendChild(group('Shape', C.SHAPES.map((s) => chip(C.SHAPE_LABELS[s], st.shape === s, () => { st.shape = s; renderPanel(); paintSummary(); save(); }, s))));
      body.appendChild(group('Size', Object.keys(C.BUBBLE_SIZES).map((k) => chip(k, st.size === C.BUBBLE_SIZES[k], () => { st.size = C.BUBBLE_SIZES[k]; renderPanel(); save(); }))));
    }
    body.appendChild(group('Filter', C.FILTER_KEYS.map((k) => chip(C.FILTER_LABELS[k], st.filter === k, () => { st.filter = k; renderPanel(); paintSummary(); save(); }))));
    if (m === 'screen-cam') body.appendChild(group('Frame', C.FRAME_KEYS.map((k) => chip(C.FRAME_LABELS[k], st.frame === k, () => { st.frame = k; renderPanel(); save(); }))));
  } else if (openPanel === 'quality') {
    const wrap = document.createElement('div'); wrap.className = 'chips quality';
    C.QUALITIES.forEach((q) => wrap.appendChild(item(null, q.label, st.quality === q.key, () => { st.quality = q.key; renderPanel(); paintSummary(); save(); })));
    const n = document.createElement('p'); n.className = 'note'; n.textContent = 'Source records your display at its own resolution; files are larger. A lower setting only shrinks the finished video, the recording is always full quality.';
    body.appendChild(wrap); body.appendChild(n);
  } else if (openPanel === 'more') {
    body.appendChild(toggle('Record system audio', 'sysAudio'));
    if (mode() !== 'cam') body.appendChild(toggle('Hide the menu bar from the recording', 'hideMenu'));
    body.appendChild(toggle('Cursor ring while I present (only I see it)', 'cursorFx'));
    body.appendChild(toggle('Record clicks for effects in the player', 'clickFx'));
    body.appendChild(toggle('Privacy Guard: blur secrets automatically', 'pg'));
  }
}

// the bubble's own toolbar (size, shape, filter, frame) changed the style: follow it
spool.on('preview:style', (p) => { Object.assign(st, p); save(); if (openPanel === 'effects') renderPanel(); paintSummary(); });

// ---------- permission box ----------
async function checkPerm() {
  const p = await spool.invoke('perm:status'), bad = p.screen !== 'granted' && mode() !== 'cam';
  $('perm').hidden = !bad; $('start').disabled = bad;
  if (bad) $('permtxt').innerHTML = `macOS needs your OK first. Click <b>Open Settings</b>, switch on <b>${esc(p.host || 'Iris')}</b> under Screen &amp; System Audio Recording, then click <b>Restart Iris</b>.`;
}

// ---------- start ----------
let starting = false;
function busy(on, text) { starting = on; $('start').classList.toggle('busy', on); $('startSpin').hidden = !on; $('startLabel').textContent = text || 'Start Recording'; }
let clickT = 0;
async function start() {
  if (starting) return; clickT = performance.now();
  busy(true, 'Preparing…'); // U7: feedback in the same frame as the click
  const m = mode();
  try {
    if (m !== 'screen' && !st.camId && !devices.cams.length) { await unlock('cam'); }
    if (m !== 'screen' && !devices.cams.length) { busy(false); flash('No camera found'); return; }
    let sourceId = st.sourceId, crop = null;
    if (m !== 'cam') {
      if (st.source === 'window' && !sourceId) { busy(false); flash('Pick a window first'); if (!openMenu) toggleMenu('src'); return; }
      if (st.source !== 'window' && sourceId && displays.some((d) => d.id === sourceId)) { /* the display is already known from refreshScreens(): no round trip */ }
      else {
        const srcs = await spool.invoke('sources:list', { screens: st.source !== 'window' });
        if (!sourceId || st.source !== 'window') sourceId = (srcs.find((s) => s.id === st.sourceId) || srcs.find((s) => s.isScreen) || srcs[0])?.id;
        if (!sourceId) { busy(false); flash('No screen to record'); return; }
      }
      if (st.source === 'custom') { const r = await spool.invoke('area:pick', { sourceId }); if (!r) { busy(false); return; } crop = r.crop; sourceId = r.sourceId; }
    }
    const ok = await spool.invoke('record:start', {
      mode: m, sourceId, crop, camId: st.camId, micId: st.micId, micOn: st.micOn && devices.mics.length > 0,
      windowSource: st.source === 'window', quality: st.quality, systemAudio: st.sysAudio, hideMenuBar: st.hideMenu && m !== 'cam',
      clickAt: performance.timeOrigin + clickT, cursorFx: st.cursorFx, clickFx: st.clickFx, bubble: { size: st.size, shape: st.shape, filter: st.filter, frame: st.frame },
    });
    if (ok === false) busy(false); // the launcher is hidden when recording really starts; stay usable if it did not
  } catch (e) { console.error(e); busy(false); flash('Could not start'); }
}
function flash(text) { const b = $('startLabel'); b.textContent = text; setTimeout(() => { if (!starting) b.textContent = 'Start Recording'; }, 1600); }

// ---------- wiring ----------
$('srcRow').onclick = () => { toggleMenu('src'); if (openMenu === 'src' && st.source === 'window') showWindows(); };
$('camRow').onclick = () => { toggleMenu('cam'); unlock('cam'); };
$('micRow').onclick = () => { toggleMenu('mic'); unlock('mic'); };
$('start').onclick = start;
$('home').onclick = () => spool.invoke('library:open');
$('x').onclick = () => spool.send('launcher:close');
$('kind').querySelector('[data-k="shot"]').onclick = () => spool.invoke('screenshot:start');
document.querySelectorAll('#tools button').forEach((b) => (b.onclick = () => togglePanel(b.dataset.p)));
$('permopen').onclick = () => spool.invoke('perm:open', 'screen'); $('permre').onclick = () => spool.invoke('app:relaunch');
addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (openMenu) closeMenus(); else if (openPanel) togglePanel(openPanel); else spool.send('launcher:close'); } });
// U4: every time the window is shown it fades in and slides up 8 px; and the main process is told the card's height so the window fits it
// finding 2: say it before recording if the speech model (viewers cannot watch without it) or Ollama is missing
let readyTimer = null;
function paintReady(r) {
  $('ready').hidden = !r.warning; $('readyText').textContent = r.warning || '';
  const dl = r.download || {}, btn = $('readyBtn');
  btn.hidden = !r.speechMissing; btn.disabled = dl.state === 'running';
  btn.textContent = dl.state === 'running' ? `Downloading… ${dl.percent}%` : dl.state === 'error' ? `Retry download (${dl.error.slice(0, 40)})` : `Download ${r.mb} MB`;
  clearTimeout(readyTimer); if (dl.state === 'running') readyTimer = setTimeout(() => spool.invoke('ready:get').then(paintReady), 700);
}
$('readyBtn').onclick = () => spool.invoke('ready:download').then(paintReady);
spool.on('launcher:shown', () => { spool.invoke('ready:get').then(paintReady); spool.invoke('ready:refresh').then(paintReady); const c = $('card'); c.classList.remove('enter'); void c.offsetWidth; c.classList.add('enter'); busy(false); checkPerm(); refreshScreens(); syncPreview(); });
new ResizeObserver(() => spool.send('launcher:size', Math.ceil($('card').getBoundingClientRect().height) + MARGIN * 2)).observe($('card'));

async function refreshScreens() {
  const srcs = await spool.invoke('sources:list', { screens: true }); // names and ids only: no window thumbnails, so this is quick
  const screens = srcs.filter((s) => s.isScreen);
  displays = screens.map((s, i) => ({ id: s.id, label: screens.length > 1 ? `Full screen · ${s.name || `Display ${i + 1}`}` : 'Full screen' }));
  if (st.source === 'screen' && !displays.some((d) => d.id === st.sourceId)) st.sourceId = displays[0]?.id || null;
  paintRows(); paintSourceMenu();
}

(async () => {
  load(await spool.invoke('settings:get'));
  paintRows(); paintSourceMenu(); paintCamMenu(); paintMicMenu(); // last-used device names show before enumeration finishes, so rows never jump (U5)
  $('card').classList.add('enter');
  await enumerate();
  if (st.micOn) unlock('mic'); if (st.camOn || st.source === 'camera') unlock('cam');
  checkPerm(); refreshScreens(); syncPreview();
})();
