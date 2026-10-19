// Recorder bar: ✕ · source · camera · mic · privacy lock · … · Record for agent · Record. Everything else opens as a popover above the button that asked for it.
const C = window.SPOOL, I = window.HermesIcons, $ = (id) => document.getElementById(id);
const WIN_W = 640, WRAP_PAD = 16; // keep in step with windows.js (LAUNCHER_W) and launcher.css (#wrap)

// What the user has chosen. `source` is what is recorded; the camera button decides between Screen and Screen + Cam.
const st = {
  source: 'screen',            // screen | window | custom | camera
  sourceId: null, sourceName: '', crop: null, cropSource: null,
  camOn: false, camId: '', camName: '',
  micOn: true, micId: '', micName: '',
  shape: 'landscape', size: 260, filter: 'none', frame: 'ring',
  quality: C.DEFAULT_QUALITY, sysAudio: false, hideMenu: false, cursorFx: false, clickFx: true, pg: true, countdown: true,
  pub: true, defPub: true,     // the lock: this video is public (link) or private. Reset to the workspace default every time the bar opens
};
const devices = { cams: [], mics: [] };
let displays = [], windows = [], pop = null; // pop = { kind, anchor }

I.fill(document);

// ---------- preferences ----------
function load(c) {
  const p = c.prefs || {}, mode = p.mode;
  st.source = p.source || (mode === 'cam' ? 'camera' : 'screen');
  if (st.source === 'window' || st.source === 'custom') st.source = 'screen'; // a window id or crop from a past session is not valid any more
  st.camOn = p.camOn !== undefined ? p.camOn : mode === 'screen-cam';
  st.micOn = p.micOn !== undefined ? p.micOn : true;
  for (const k of ['camId', 'camName', 'micId', 'micName', 'shape', 'size', 'filter', 'frame', 'sysAudio', 'hideMenu', 'clickFx', 'countdown']) if (p[k] !== undefined) st[k] = p[k];
  st.size = ({ 140: 180, 200: 260, 300: 380 })[st.size] ?? st.size; // the S / M / L stops grew: a size saved at the old stops keeps its place
  if (p.v === 2) { st.quality = p.quality; st.cursorFx = !!p.cursorFx; }
  st.pg = c.privacyGuard !== false;
  st.defPub = st.pub = (c.defaultPrivacy || 'link') !== 'private';
}
function save() {
  const keys = ['source', 'camOn', 'micOn', 'camId', 'camName', 'micId', 'micName', 'shape', 'size', 'filter', 'frame', 'quality', 'sysAudio', 'hideMenu', 'cursorFx', 'clickFx', 'countdown'];
  const prefs = { v: 2 }; for (const k of keys) prefs[k] = st[k];
  spool.invoke('settings:set', { prefs, privacyGuard: st.pg });
  syncPreview();
}
// B27: tell the main process what camera preview to show (it closes it again when `on` is false or the bar hides)
function syncPreview() {
  const on = mode() !== 'screen' && devices.cams.length > 0;
  spool.send('preview:set', { on, camId: st.camId, size: st.size, shape: st.shape, filter: st.filter, frame: st.frame });
}
const mode = () => (st.source === 'camera' ? 'cam' : st.camOn ? 'screen-cam' : 'screen');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- the bar ----------
function paintBar() {
  document.querySelectorAll('#src button').forEach((b) => b.classList.toggle('on', b.dataset.s === st.source));
  const camOn = st.camOn || st.source === 'camera';
  $('camBtn').innerHTML = I.svg(camOn ? 'video' : 'video-off'); $('camBtn').classList.toggle('off', !camOn);
  $('camBtn').dataset.tip = camOn ? `Camera: ${st.camName || 'on'}` : 'Camera is off';
  $('micIcon').innerHTML = I.svg(st.micOn ? 'mic' : 'mic-off'); $('micBtn').classList.toggle('off', !st.micOn);
  $('micBtn').dataset.tip = st.micOn ? `Microphone: ${st.micName || 'on'}` : 'Microphone is off';
  $('lock').innerHTML = I.svg(st.pub ? 'lock-open' : 'lock'); $('lock').dataset.tip = st.pub ? 'This video is Public' : 'This video is Private';
  $('src').querySelector('[data-s="window"]').dataset.tip = st.source === 'window' && st.sourceName ? `Window: ${st.sourceName}` : 'Window';
}

// ---------- popovers ----------
const POP_W = { more: 380, settings: 400, effects: 400, cam: 340, mic: 340, display: 300, windows: 560 };
function closePop() {
  if (!pop) return; const a = pop.anchor; pop = null; $('pop').hidden = true; $('popBody').innerHTML = '';
  document.body.classList.remove('popping'); document.querySelectorAll('.open').forEach((n) => n.classList.remove('open')); void a;
}
function openPop(kind, anchor) {
  const body = $('popBody'); body.innerHTML = '';
  const el = anchor || pop?.anchor; if (!el) return;
  document.querySelectorAll('.open').forEach((n) => n.classList.remove('open')); el.classList.add('open');
  pop = { kind, anchor: el };
  const w = POP_W[kind] || 340, r = el.getBoundingClientRect(), cx = r.left + r.width / 2, left = Math.max(WRAP_PAD, Math.min(WIN_W - WRAP_PAD - w, cx - w / 2));
  const p = $('pop'); p.hidden = false; p.style.width = w + 'px'; p.style.marginLeft = (left - WRAP_PAD) + 'px'; p.style.setProperty('--ax', Math.max(24, Math.min(w - 24, cx - left)) + 'px');
  document.body.classList.add('popping');
  ({ more: paintMore, settings: paintSettings, effects: paintEffects, cam: paintCamMenu, mic: paintMicMenu, display: paintDisplayMenu, windows: paintWindows })[kind](body);
}
const togglePop = (kind, anchor) => (pop && pop.kind === kind && pop.anchor === anchor ? closePop() : openPop(kind, anchor));

function mrow(icon, title, sub, fn) {
  const b = document.createElement('button'); b.className = 'mrow'; b.innerHTML = `${I.svg(icon)}<div class="tx"><b>${title}</b><span>${sub}</span></div>${I.svg('chevron-right', 'go')}`; b.onclick = fn; return b;
}
function paintMore(body) {
  body.appendChild(mrow('notes', 'Speaker notes', 'Keep notes nearby while you record', () => { closePop(); spool.invoke('notes:open'); }));
  body.appendChild(mrow('palette', 'Backgrounds', 'Camera filters and frames', () => openPop('effects')));
  body.appendChild(mrow('gear', 'Recording settings', 'Countdown, quality, audio, and more', () => openPop('settings')));
}
function head(title) {
  const h = document.createElement('div'); h.className = 'ph'; h.innerHTML = `<button class="ib" data-icon="chevron-left"></button><b>${title}</b>`; I.fill(h);
  h.querySelector('button').onclick = () => openPop('more'); return h;
}
function item(icon, label, on, fn) {
  const b = document.createElement('button'); b.className = 'menu-item' + (on ? ' on' : ''); b.innerHTML = `${icon ? I.svg(icon) : ''}<span class="grow">${label}</span>${on ? I.svg('check') : ''}`; b.onclick = fn; return b;
}
function chip(label, on, fn) { const b = document.createElement('button'); b.className = 'chip' + (on ? ' on' : ''); b.textContent = label; b.onclick = fn; return b; }
function group(title, chips) { const g = document.createElement('div'); g.innerHTML = `<h4>${title}</h4>`; const c = document.createElement('div'); c.className = 'chips'; chips.forEach((x) => c.appendChild(x)); g.appendChild(c); return g; }
function toggle(label, key, onchange) {
  const l = document.createElement('label'); l.className = 'toggle'; l.innerHTML = `<input type="checkbox"><span>${label}</span>`;
  const i = l.querySelector('input'); i.checked = st[key]; i.onchange = () => { st[key] = i.checked; if (onchange) onchange(); save(); }; return l;
}
function link(label, fn) { const b = document.createElement('button'); b.className = 'chip'; b.textContent = label; b.onclick = fn; return b; }

function paintSettings(body) {
  body.appendChild(head('Recording settings'));
  const pad = document.createElement('div'); pad.className = 'pad';
  pad.appendChild(toggle('Countdown before recording', 'countdown'));
  pad.appendChild(group('Quality', C.QUALITIES.map((q) => chip(q.label, st.quality === q.key, () => { st.quality = q.key; save(); openPop('settings'); }))));
  const t = document.createElement('div');
  t.appendChild(toggle('Record system audio', 'sysAudio'));
  if (mode() !== 'cam') t.appendChild(toggle('Hide the menu bar from the recording', 'hideMenu'));
  t.appendChild(toggle('Cursor ring while I present (only I see it)', 'cursorFx'));
  t.appendChild(toggle('Record clicks for effects in the player', 'clickFx'));
  t.appendChild(toggle('Privacy Guard: cover secrets automatically', 'pg'));
  pad.appendChild(t);
  const k = document.createElement('div'); k.className = 'keys';
  k.innerHTML = [['⌥⇧R', 'bar'], ['⌥⇧P', 'pause'], ['⌥⇧S', 'stop'], ['⌥⇧D', 'pen'], ['⌥⇧A', 'screenshot']].map(([a, b]) => `<span><kbd>${a}</kbd> ${b}</span>`).join('');
  pad.appendChild(k);
  const l = document.createElement('div'); l.className = 'links';
  l.appendChild(link('Take a screenshot', () => { closePop(); spool.invoke('screenshot:start'); })); l.appendChild(link('Open library', () => spool.invoke('library:open')));
  pad.appendChild(l);
  body.appendChild(pad);
}
function paintEffects(body) {
  body.appendChild(head('Backgrounds'));
  const pad = document.createElement('div'); pad.className = 'pad';
  if (mode() === 'screen') { const n = document.createElement('p'); n.className = 'note'; n.textContent = 'Turn the camera on to style it.'; pad.appendChild(n); }
  else {
    pad.appendChild(group('Filter', C.FILTER_KEYS.map((k) => chip(C.FILTER_LABELS[k], st.filter === k, () => { st.filter = k; save(); openPop('effects'); }))));
    pad.appendChild(group('Frame', C.FRAME_KEYS.map((k) => chip(C.FRAME_LABELS[k], st.frame === k, () => { st.frame = k; save(); openPop('effects'); }))));
  }
  body.appendChild(pad);
}
function paintDisplayMenu(body) {
  const pad = document.createElement('div'); pad.className = 'pad';
  displays.forEach((d) => pad.appendChild(item('laptop', esc(d.label), st.sourceId === d.id, () => { st.source = 'screen'; st.sourceId = d.id; paintBar(); save(); closePop(); })));
  body.appendChild(pad);
}
const deviceName = (d, i, kind) => d.label || `${kind} ${i + 1}`;
function paintCamMenu(body) {
  const pad = document.createElement('div'); pad.className = 'pad';
  devices.cams.forEach((d, i) => pad.appendChild(item('video', esc(deviceName(d, i, 'Camera')), (st.camOn || st.source === 'camera') && (st.camId === d.deviceId || (!st.camId && i === 0)), () => {
    st.camOn = true; st.camId = d.deviceId; st.camName = deviceName(d, i, 'Camera'); paintBar(); save(); closePop();
  })));
  if (!devices.cams.length) { const n = document.createElement('p'); n.className = 'note'; n.textContent = 'No camera found.'; pad.appendChild(n); }
  body.appendChild(pad);
}
function paintMicMenu(body) {
  const pad = document.createElement('div'); pad.className = 'pad';
  devices.mics.forEach((d, i) => pad.appendChild(item('mic', esc(deviceName(d, i, 'Microphone')), st.micOn && (st.micId === d.deviceId || (!st.micId && i === 0)), () => {
    st.micOn = true; st.micId = d.deviceId; st.micName = deviceName(d, i, 'Microphone'); paintBar(); save(); closePop(); startMeter();
  })));
  if (!devices.mics.length) { const n = document.createElement('p'); n.className = 'note'; n.textContent = 'No microphone found.'; pad.appendChild(n); }
  body.appendChild(pad);
}
async function paintWindows(body) {
  const g = document.createElement('div'); g.id = 'winGrid'; body.appendChild(g); g.innerHTML = '<span class="note">Looking for windows…</span>';
  const srcs = await spool.invoke('sources:list');
  if (!pop || pop.kind !== 'windows') return;
  windows = srcs.filter((s) => !s.isScreen); g.innerHTML = '';
  if (!windows.length) { g.innerHTML = '<span class="note" style="grid-column:1/4">No windows found. Is Screen Recording allowed?</span>'; return; }
  windows.forEach((s) => {
    const d = document.createElement('div'); d.innerHTML = `<img alt="" src="${s.thumb}"><span>${esc(s.name)}</span>`;
    d.onclick = () => { st.source = 'window'; st.sourceId = s.id; st.sourceName = s.name; paintBar(); save(); closePop(); };
    g.appendChild(d);
  });
}

// ---------- devices (B8: ask for permission once, and only when labels are empty; re-read on devicechange) ----------
const asked = {};
async function enumerate() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  devices.cams = devs.filter((d) => d.kind === 'videoinput'); devices.mics = devs.filter((d) => d.kind === 'audioinput');
  const cam = devices.cams.find((d) => d.deviceId === st.camId) || (st.camId ? null : devices.cams[0]), mic = devices.mics.find((d) => d.deviceId === st.micId) || (st.micId ? null : devices.mics[0]);
  if (cam && cam.label) st.camName = cam.label; if (mic && mic.label) st.micName = mic.label;
  paintBar(); syncPreview();
}
async function unlock(kind) {
  const list = kind === 'cam' ? devices.cams : devices.mics;
  if (asked[kind] || (list.length && list.every((d) => d.label))) return;
  asked[kind] = true;
  try { (await navigator.mediaDevices.getUserMedia(kind === 'cam' ? { video: true } : { audio: true })).getTracks().forEach((t) => t.stop()); } catch {}
  await enumerate();
}
navigator.mediaDevices.addEventListener('devicechange', enumerate);

// ---------- mic level: the arc under the microphone icon grows with your voice. Only while the bar is open, and only once the mic is already allowed ----------
let meter = null;
function stopMeter() { if (!meter) return; clearInterval(meter.t); meter.s.getTracks().forEach((t) => t.stop()); meter.ctx.close().catch(() => {}); meter = null; $('lvl').style.removeProperty('--lv'); }
async function startMeter() {
  stopMeter();
  if (!st.micOn || document.hidden || !devices.mics.some((d) => d.label)) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: st.micId ? { exact: st.micId } : undefined } });
    if (!st.micOn || meter) { s.getTracks().forEach((t) => t.stop()); return; }
    const ctx = new AudioContext(), an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(s).connect(an);
    const buf = new Uint8Array(an.fftSize);
    meter = { s, ctx, t: setInterval(() => { an.getByteTimeDomainData(buf); let sum = 0; for (const v of buf) sum += (v - 128) * (v - 128); const rms = Math.sqrt(sum / buf.length) / 128; $('lvl').style.setProperty('--lv', Math.min(1, 0.4 + rms * 5).toFixed(2)); }, 90) };
  } catch {}
}

// the bubble's own panel (size, shape, filter, frame, power) changed the style: follow it
spool.on('preview:style', (p) => { if (p.camOn === false && st.source === 'camera') delete p.camOn; Object.assign(st, p); save(); paintBar(); if (pop?.kind === 'effects') openPop('effects'); });

// ---------- permission and model notices ----------
async function checkPerm() {
  const p = await spool.invoke('perm:status'), bad = p.screen !== 'granted' && mode() !== 'cam';
  $('perm').hidden = !bad; $('start').disabled = bad; $('agent').disabled = bad; notice();
  if (bad) $('permtxt').innerHTML = `macOS needs your OK first. Click <b>Open Settings</b>, switch on <b>${esc(p.host || 'Hermes')}</b> under Screen &amp; System Audio Recording, then click <b>Restart Hermes</b>.`;
}
const notice = () => { $('notice').hidden = $('perm').hidden && $('ready').hidden; };
let readyTimer = null;
function paintReady(r) {
  $('ready').hidden = !r.warning; $('readyText').textContent = r.warning || ''; notice();
  const dl = r.download || {}, btn = $('readyBtn');
  btn.hidden = !r.speechMissing; btn.disabled = dl.state === 'running';
  btn.textContent = dl.state === 'running' ? `Downloading… ${dl.percent}%` : dl.state === 'error' ? `Retry download (${dl.error.slice(0, 40)})` : `Download ${r.mb} MB`;
  clearTimeout(readyTimer); if (dl.state === 'running') readyTimer = setTimeout(() => spool.invoke('ready:get').then(paintReady), 700);
}

// ---------- source ----------
async function pickSource(s) {
  if (s === 'screen') { const again = st.source === 'screen'; st.source = 'screen'; paintBar(); save(); if (again && displays.length > 1) togglePop('display', $('src').querySelector('[data-s="screen"]')); else closePop(); }
  else if (s === 'window') { st.source = 'window'; st.sourceId = null; st.sourceName = ''; paintBar(); save(); openPop('windows', $('src').querySelector('[data-s="window"]')); }
  else if (s === 'camera') { st.source = 'camera'; st.camOn = true; paintBar(); closePop(); unlock('cam'); save(); }
  else if (s === 'custom') {
    closePop();
    const prev = st.source, sid = displays.some((d) => d.id === st.sourceId) ? st.sourceId : displays[0]?.id;
    const r = await spool.invoke('area:pick', { sourceId: sid }); // hides the bar and opens the existing area picker
    spool.send('launcher:open');
    if (r) { st.source = 'custom'; st.crop = r.crop; st.cropSource = r.sourceId; } else st.source = prev;
    paintBar(); save();
  }
}

// ---------- start ----------
let starting = false;
function busy(on, text) { starting = on; $('start').classList.toggle('busy', on); $('startSpin').hidden = !on; $('startIcon').hidden = on; $('startLabel').textContent = text || 'Record'; }
let clickT = 0;
async function start(forAgent = false) {
  if (starting) return; clickT = performance.now();
  busy(true, 'Preparing…'); // U7: feedback in the same frame as the click
  closePop(); stopMeter();
  const m = mode();
  try {
    if (m !== 'screen' && !st.camId && !devices.cams.length) { await unlock('cam'); }
    if (m !== 'screen' && !devices.cams.length) { busy(false); flash('No camera found'); return; }
    let sourceId = st.sourceId, crop = null;
    if (m !== 'cam') {
      if (st.source === 'window' && !sourceId) { busy(false); flash('Pick a window first'); openPop('windows', $('src').querySelector('[data-s="window"]')); return; }
      if (st.source !== 'window' && sourceId && displays.some((d) => d.id === sourceId)) { /* the display is already known from refreshScreens(): no round trip */ }
      else {
        const srcs = await spool.invoke('sources:list', { screens: st.source !== 'window' });
        if (!sourceId || st.source !== 'window') sourceId = (srcs.find((s) => s.id === st.sourceId) || srcs.find((s) => s.isScreen) || srcs[0])?.id;
        if (!sourceId) { busy(false); flash('No screen to record'); return; }
      }
      if (st.source === 'custom') {
        if (st.crop) { crop = st.crop; sourceId = st.cropSource || sourceId; }
        else { const r = await spool.invoke('area:pick', { sourceId }); if (!r) { busy(false); return; } crop = r.crop; sourceId = r.sourceId; }
      }
    }
    const ok = await spool.invoke('record:start', {
      mode: m, sourceId, crop, camId: st.camId, micId: st.micId, micOn: st.micOn && devices.mics.length > 0,
      windowSource: st.source === 'window', quality: st.quality, systemAudio: st.sysAudio, hideMenuBar: st.hideMenu && m !== 'cam',
      clickAt: performance.timeOrigin + clickT, cursorFx: st.cursorFx, clickFx: st.clickFx, bubble: { size: st.size, shape: st.shape, filter: st.filter, frame: st.frame },
      countdown: st.countdown, forAgent, privacy: st.pub === st.defPub ? null : st.pub ? 'link' : 'private',
    });
    if (ok === false) { busy(false); startMeter(); } // the bar is hidden when recording really starts; stay usable if it did not
  } catch (e) { console.error(e); busy(false); flash('Could not start'); }
}
function flash(text) { $('startLabel').textContent = text; setTimeout(() => { if (!starting) $('startLabel').textContent = 'Record'; }, 1600); }

// ---------- wiring ----------
document.querySelectorAll('#src button').forEach((b) => (b.onclick = () => pickSource(b.dataset.s)));
$('camBtn').onclick = () => {
  if (st.source === 'camera') return togglePop('cam', $('camBtn')); // camera only: the camera is the recording, so this opens the device list instead of switching it off
  st.camOn = !st.camOn; paintBar(); save(); closePop(); if (st.camOn) unlock('cam');
};
$('micBtn').onclick = () => { st.micOn = !st.micOn; paintBar(); save(); closePop(); if (st.micOn) unlock('mic').then(startMeter); else stopMeter(); };
$('camCaret').onclick = () => { unlock('cam'); togglePop('cam', $('camBtn')); };
$('micCaret').onclick = () => { unlock('mic'); togglePop('mic', $('micBtn')); };
$('lock').onclick = () => { st.pub = !st.pub; paintBar(); closePop(); };
$('more').onclick = () => togglePop('more', $('more'));
$('agent').onclick = () => start(true);
$('start').onclick = () => start(false);
$('x').onclick = () => spool.send('launcher:close');
$('permopen').onclick = () => spool.invoke('perm:open', 'screen'); $('permre').onclick = () => spool.invoke('app:relaunch');
$('readyBtn').onclick = () => spool.invoke('ready:download').then(paintReady);
addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (pop) closePop(); else spool.send('launcher:close'); } });
addEventListener('mousedown', (e) => { if (pop && !e.target.closest('#pop') && !e.target.closest('#bar')) closePop(); });
// U4: every time the window is shown the bar fades in and slides up 8 px; the main process is told the content's height so the window fits it
spool.on('launcher:shown', () => {
  spool.invoke('ready:get').then(paintReady); spool.invoke('ready:refresh').then(paintReady);
  const w = $('wrap'); w.classList.remove('enter'); void w.offsetWidth; w.classList.add('enter');
  busy(false); closePop(); checkPerm(); refreshScreens(); syncPreview(); startMeter();
  spool.invoke('settings:get').then((c) => { st.defPub = st.pub = (c.defaultPrivacy || 'link') !== 'private'; paintBar(); });
});
spool.on('launcher:hidden', stopMeter);
new ResizeObserver(() => spool.send('launcher:size', Math.ceil($('wrap').getBoundingClientRect().height))).observe($('wrap'));

async function refreshScreens() {
  const srcs = await spool.invoke('sources:list', { screens: true }); // names and ids only: no window thumbnails, so this is quick
  const screens = srcs.filter((s) => s.isScreen);
  displays = screens.map((s, i) => ({ id: s.id, label: screens.length > 1 ? `Full screen · ${s.name || `Display ${i + 1}`}` : 'Full screen' }));
  if (st.source === 'screen' && !displays.some((d) => d.id === st.sourceId)) st.sourceId = displays[0]?.id || null;
  paintBar();
}

(async () => {
  load(await spool.invoke('settings:get'));
  paintBar(); // last-used device names show before enumeration finishes, so the bar never jumps (U5)
  $('wrap').classList.add('enter');
  await enumerate();
  if (st.micOn) unlock('mic').then(startMeter); if (st.camOn || st.source === 'camera') unlock('cam');
  checkPerm(); refreshScreens(); syncPreview();
})();
