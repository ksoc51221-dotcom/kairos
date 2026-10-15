const { app, BrowserWindow, ipcMain, desktopCapturer, session, screen, shell, systemPreferences, Tray, Menu,
        nativeImage, dialog, globalShortcut, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const { startServer } = require('./server/server');
const orchestrator = require('./agents/orchestrator');
const { transcribeAudioFile } = require('./agents/transcribe');

const SELFTEST = process.env.SPOOL_SELFTEST ? JSON.parse(process.env.SPOOL_SELFTEST) : null;
app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');

const PORT = +process.env.SPOOL_PORT || 4747;
if (!SELFTEST && !app.requestSingleInstanceLock()) app.exit(0); // one Spool at a time (they would fight over the port)
app.on('second-instance', () => showLauncher());
const PAD = 10, TOP = 38; // bubble window margins (toolbar above, transparent padding around)
const here = (...p) => path.join(__dirname, ...p);
const W = {}; // windows by name
let tray, S = null; // S = active recording session
let quitting = false;
app.on('before-quit', () => { quitting = true; });

// ---------------- log file (so a "it doesn't work" report can be diagnosed) ----------------
let logFile = null;
const log = (...a) => { const line = `${new Date().toISOString()} ${a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`; console.log(line); try { if (logFile) fs.appendFileSync(logFile, line + '\n'); } catch {} };
process.on('uncaughtException', (e) => log('uncaughtException', e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e));
const permReport = () => process.platform === 'darwin' ? { screen: systemPreferences.getMediaAccessStatus('screen'), camera: systemPreferences.getMediaAccessStatus('camera'), mic: systemPreferences.getMediaAccessStatus('microphone') } : {};

const baseWin = (extra = {}) => ({
  show: false, frame: false, resizable: false, hasShadow: true, transparent: true, skipTaskbar: true,
  webPreferences: { preload: here('preload.js'), backgroundThrottling: false }, ...extra,
});
const load = (name, file, opts) => { const w = new BrowserWindow(baseWin(opts)); w.loadFile(here(file)); W[name] = w; w.on('closed', () => { if (W[name] === w) delete W[name]; }); return w; };
const alive = (w) => w && !w.isDestroyed();
const send = (name, ch, ...a) => { if (alive(W[name])) W[name].webContents.send(ch, ...a); };
const floatTop = (w) => { w.setAlwaysOnTop(true, 'screen-saver'); w.setVisibleOnAllWorkspaces(true, { visibleInFullScreen: true }); };
const settings = () => store.getSettings();

// ---------------- launcher ----------------
function showLauncher() {
  if (S) return;
  if (!alive(W.launcher)) {
    const w = load('launcher', 'launcher/index.html', { width: 360, height: 760, alwaysOnTop: true });
    w.on('close', (e) => { if (!quitting) { e.preventDefault(); w.hide(); } }); // closing only hides; the Dock icon brings it back
  }
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()), wa = d.workArea;
  const h = Math.min(760, wa.height - 16);
  W.launcher.setBounds({ x: wa.x + wa.width - 380, y: wa.y + 8, width: 360, height: h });
  W.launcher.show(); W.launcher.focus();
}

// ---------------- recorder (hidden) ----------------
function createRecorder() {
  W.recorder = new BrowserWindow({ show: false, webPreferences: { preload: here('preload.js'), backgroundThrottling: false } });
  W.recorder.loadFile(here('recorder/index.html'));
}

// ---------------- bubble ----------------
const bubbleDims = (shape, size) => ({ circle: [size, size], squircle: [size, size], portrait: [Math.round(size * 0.78), Math.round(size * 1.2)], landscape: [Math.round(size * 1.3), Math.round(size * 0.9)] }[shape] || [size, size]);
function bubbleRect() {
  const b = W.bubble.getBounds(), [w, h] = bubbleDims(S.bubble.shape, S.bubble.size);
  return { x: b.x + PAD, y: b.y + TOP, w, h };
}
function pushBubbleRel() {
  if (!S || !alive(W.bubble)) return;
  const r = bubbleRect(), d = S.display.bounds;
  send('recorder', 'rec:bubble', { ...S.bubble, rel: { x: (r.x - d.x) / d.width, y: (r.y - d.y) / d.height, w: r.w / d.width, h: r.h / d.height } });
}
function resizeBubble() {
  const [w, h] = bubbleDims(S.bubble.shape, S.bubble.size), b = W.bubble.getBounds(), oldH = b.height;
  const nw = w + PAD * 2, nh = h + TOP + PAD;
  W.bubble.setBounds({ x: b.x, y: b.y + oldH - nh, width: nw, height: nh });
  send('bubble', 'bubble:style', { w, h, shape: S.bubble.shape, filter: S.bubble.filter, frame: S.bubble.frame });
  pushBubbleRel();
}
function createBubble() {
  const wa = S.display.workArea, [w, h] = bubbleDims(S.bubble.shape, S.bubble.size);
  const win = load('bubble', 'bubble/index.html', { width: w + PAD * 2, height: h + TOP + PAD, x: wa.x + 20, y: wa.y + wa.height - (h + TOP + PAD) - 20, hasShadow: false, alwaysOnTop: true, focusable: false });
  floatTop(win); win.setContentProtection(true); // the compositor draws the camera into the video; the window is only a preview
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('bubble:init', { camId: S.opts.camId });
    send('bubble', 'bubble:style', { w, h, shape: S.bubble.shape, filter: S.bubble.filter, frame: S.bubble.frame });
    pushBubbleRel();
  });
  win.once('ready-to-show', () => win.showInactive());
  let snapT;
  win.on('move', () => { pushBubbleRel(); clearTimeout(snapT); snapT = setTimeout(snapBubble, 220); });
}
function snapBubble() { // edge snapping
  if (!S || !alive(W.bubble)) return;
  const r = bubbleRect(), wa = S.display.workArea, m = 20, t = 48; let { x, y } = r;
  if (Math.abs(x - wa.x) < t) x = wa.x + m; else if (Math.abs(x + r.w - (wa.x + wa.width)) < t) x = wa.x + wa.width - r.w - m;
  if (Math.abs(y - wa.y) < t) y = wa.y + m; else if (Math.abs(y + r.h - (wa.y + wa.height)) < t) y = wa.y + wa.height - r.h - m;
  if (x !== r.x || y !== r.y) { const b = W.bubble.getBounds(); W.bubble.setBounds({ ...b, x: x - PAD, y: y - TOP }, true); }
}
const SHAPES = ['circle', 'squircle', 'portrait', 'landscape'], FILTER_KEYS = ['none', 'warm', 'cool', 'bw', 'vivid', 'soft', 'film'], FRAME_KEYS = ['ring', 'none', 'purple', 'mint', 'gradient', 'glow'];
const cycle = (arr, v) => arr[(arr.indexOf(v) + 1) % arr.length];
ipcMain.on('bubble:action', (_e, a, v) => {
  if (!S) return;
  if (a === 'size') S.bubble.size = +v; else if (a === 'shape') S.bubble.shape = cycle(SHAPES, S.bubble.shape);
  else if (a === 'filter') S.bubble.filter = cycle(FILTER_KEYS, S.bubble.filter); else if (a === 'frame') S.bubble.frame = cycle(FRAME_KEYS, S.bubble.frame);
  resizeBubble();
});

// ---------------- controls / countdown / overlays ----------------
function createControls() {
  const wa = S.display.workArea;
  const w = load('controls', 'controls/index.html', { width: 520, height: 56, x: wa.x + Math.round(wa.width / 2) - 260, y: wa.y + wa.height - 90, alwaysOnTop: true, focusable: false });
  floatTop(w); w.setContentProtection(true); w.once('ready-to-show', () => { w.showInactive(); broadcastTools(); });
}
ipcMain.on('controls:size', (_e, h) => { if (alive(W.controls)) { const b = W.controls.getBounds(); W.controls.setBounds({ ...b, y: b.y - (h - b.height), height: h }); } });

function runCountdown() {
  return new Promise((resolve) => {
    const d = S.display.bounds;
    const w = load('countdown', 'countdown/index.html', { x: d.x, y: d.y, width: d.width, height: d.height, alwaysOnTop: true, focusable: false, hasShadow: false });
    w.setIgnoreMouseEvents(true); floatTop(w); w.setContentProtection(true); w.once('ready-to-show', () => w.showInactive());
    ipcMain.once('countdown:done', () => { if (alive(w)) w.close(); resolve(); });
  });
}
function createOutline(crop) {
  const d = S.display.bounds;
  const b = { x: Math.round(d.x + crop.x * d.width) - 3, y: Math.round(d.y + crop.y * d.height) - 3, width: Math.round(crop.w * d.width) + 6, height: Math.round(crop.h * d.height) + 6 };
  const w = new BrowserWindow(baseWin({ ...b, alwaysOnTop: true, focusable: false, hasShadow: false })); W.outline = w;
  w.setIgnoreMouseEvents(true); floatTop(w); w.setContentProtection(true);
  w.loadURL('data:text/html,<body style="margin:0;background:transparent"><div style="position:fixed;inset:0;border:3px dashed #34e0a1;border-radius:4px;box-sizing:border-box"></div></body>');
  w.once('ready-to-show', () => w.showInactive());
}
function ensureDraw() {
  if (alive(W.draw)) return W.draw;
  const d = S.display.bounds;
  const w = load('draw', 'draw/index.html', { x: d.x, y: d.y, width: d.width, height: d.height, alwaysOnTop: true, hasShadow: false, focusable: true });
  floatTop(w); w.setIgnoreMouseEvents(true); w.showInactive(); // visible to capture on purpose: strokes appear in the video
  return w;
}
function ensureRing() {
  if (alive(W.ring)) return;
  const w = load('ring', 'ring/index.html', { width: 110, height: 110, alwaysOnTop: true, hasShadow: false, focusable: false });
  w.setIgnoreMouseEvents(true); floatTop(w); w.showInactive();
}
function openNotes(mode) {
  const text = settings().notes || '';
  if (!alive(W.notes)) {
    const wa = (S?.display || screen.getPrimaryDisplay()).workArea;
    const w = load('notes', 'notes/index.html', { width: 440, height: mode === 'prompt' ? 340 : 400, x: wa.x + Math.round(wa.width / 2) - 220, y: wa.y + 20, alwaysOnTop: true, focusable: true });
    floatTop(w); w.setContentProtection(true); // never part of the recording
    w.webContents.once('did-finish-load', () => { w.webContents.send('notes:mode', { mode, text }); w.show(); });
  } else { W.notes.webContents.send('notes:mode', { mode, text }); W.notes.show(); }
}
ipcMain.handle('notes:open', () => { if (alive(W.launcher)) W.launcher.hide(); openNotes('edit'); });
ipcMain.on('notes:save', (_e, text) => { store.setSettings({ notes: text }); });
ipcMain.on('notes:close', () => { if (alive(W.notes)) W.notes.close(); showLauncher(); });
ipcMain.handle('notes:dictate', async (_e, buf) => {
  const f = path.join(app.getPath('temp'), `spool-dictate-${Date.now()}.f32`); fs.writeFileSync(f, Buffer.from(buf));
  try { const r = await transcribeAudioFile(f, path.join(app.getPath('userData'), 'models')); return r.text; } catch (e) { console.error(e); return ''; } finally { fs.rmSync(f, { force: true }); }
});

function toolState() {
  return { pen: !!S?.pen, cursor: !!S?.cursorOn, notes: alive(W.notes), cam: S?.bubble.camOn !== false, hasCam: S?.opts.mode === 'screen-cam' };
}
function broadcastTools() { send('controls', 'tool:state', toolState()); }
function toggleTool(t, arg) {
  if (!S) return;
  if (t === 'pen') { S.pen = !S.pen; const w = ensureDraw(); w.setIgnoreMouseEvents(!S.pen); w.webContents.send('draw:mode', S.pen); if (S.pen) w.focus(); }
  else if (t === 'pen-color') send('draw', 'draw:color', arg);
  else if (t === 'cursor') { S.cursorOn = !S.cursorOn; if (S.cursorOn) ensureRing(); else if (alive(W.ring)) W.ring.close(); }
  else if (t === 'notes') { if (alive(W.notes)) W.notes.close(); else openNotes('prompt'); setTimeout(broadcastTools, 150); }
  else if (t === 'cam') { S.bubble.camOn = !S.bubble.camOn; if (alive(W.bubble)) (S.bubble.camOn ? W.bubble.showInactive() : W.bubble.hide()); pushBubbleRel(); }
  broadcastTools();
}
ipcMain.on('tool', (_e, t, arg) => toggleTool(t, arg));

// ---------------- cursor + clicks + shortcuts ----------------
let cursorTimer, hook;
function startCursor() {
  const d = S.display.bounds;
  cursorTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    send('recorder', 'cur:pos', { x: +((p.x - d.x) / d.width).toFixed(4), y: +((p.y - d.y) / d.height).toFixed(4) });
    if (alive(W.ring)) W.ring.setPosition(Math.round(p.x - 55), Math.round(p.y - 55));
  }, 33);
  if (S.opts.clickFx !== false) try {
    const { uIOhook } = require('uiohook-napi'); hook = uIOhook;
    uIOhook.on('click', (e) => {
      const p = screen.getCursorScreenPoint(); // hook coords are physical px; the Electron cursor API is already in DIPs
      send('recorder', 'cur:click', { x: +((p.x - d.x) / d.width).toFixed(4), y: +((p.y - d.y) / d.height).toFixed(4), button: e.button });
      if (alive(W.ring)) W.ring.webContents.send('ring:click');
    });
    uIOhook.start();
  } catch (e) { console.warn('click hook unavailable:', e.message); }
}
function stopCursor() { clearInterval(cursorTimer); try { hook?.stop(); hook?.removeAllListeners(); } catch {} hook = null; }
function registerShortcuts() {
  let paused = false;
  globalShortcut.register('Alt+Shift+P', () => { paused = !paused; send('recorder', 'rec:control', paused ? 'pause' : 'resume'); });
  globalShortcut.register('Alt+Shift+S', () => send('recorder', 'rec:control', 'stop'));
  globalShortcut.register('Alt+Shift+D', () => toggleTool('pen'));
}
const unregisterShortcuts = () => ['Alt+Shift+P', 'Alt+Shift+S', 'Alt+Shift+D'].forEach((k) => globalShortcut.unregister(k));

// ---------------- area picker (recording + screenshots) ----------------
const displayFor = (sourceId) => {
  const id = /^screen:(\d+):/.exec(sourceId || '')?.[1];
  return screen.getAllDisplays().find((d) => String(d.id) === id) || screen.getPrimaryDisplay();
};
function pickArea({ display, image, mode }) {
  return new Promise((resolve) => {
    const d = display.bounds;
    const w = load('area', 'area/index.html', { x: d.x, y: d.y, width: d.width, height: d.height, alwaysOnTop: true, hasShadow: false, focusable: true, enableLargerThanScreen: true });
    w.setAlwaysOnTop(true, 'screen-saver'); w.setVisibleOnAllWorkspaces(true, { visibleInFullScreen: true });
    const done = (r) => { ipcMain.removeAllListeners('area:done'); ipcMain.removeAllListeners('area:cancel'); if (alive(w)) w.close(); resolve(r); };
    ipcMain.once('area:done', (_e, r) => done(r)); ipcMain.once('area:cancel', () => done(null));
    w.webContents.once('did-finish-load', () => { w.webContents.send('area:init', { mode, image }); w.show(); w.focus(); });
  });
}
ipcMain.handle('area:pick', async (_e, { sourceId }) => {
  const display = displayFor(sourceId); if (alive(W.launcher)) W.launcher.hide();
  const crop = await pickArea({ display, mode: 'record' });
  return crop ? { crop, sourceId: sourceId?.startsWith('screen:') ? sourceId : `screen:${display.id}:0` } : null;
});

// ---------------- screenshots ----------------
async function startScreenshot() {
  if (S) return;
  if (alive(W.launcher)) W.launcher.hide();
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') { await ensurePermissions(false); return; }
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  await new Promise((r) => setTimeout(r, 120));
  const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = srcs.find((s) => s.id.startsWith(`screen:${d.id}:`)) || srcs[0]; const full = src.thumbnail;
  const crop = await pickArea({ display: d, image: full.toDataURL(), mode: 'screenshot' });
  if (!crop) return;
  const fs_ = full.getSize();
  const img = full.crop({ x: Math.round(crop.x * fs_.width), y: Math.round(crop.y * fs_.height), width: Math.round(crop.w * fs_.width), height: Math.round(crop.h * fs_.height) });
  openAnnotator(img, d);
}
function openAnnotator(img, d) {
  const w = load('annotate', 'annotate/index.html', { frame: true, titleBarStyle: 'hiddenInset', transparent: false, resizable: true, hasShadow: true,
    width: Math.min(1200, d.workArea.width - 80), height: Math.min(840, d.workArea.height - 60), x: d.workArea.x + 40, y: d.workArea.y + 30, backgroundColor: '#f1eefb', skipTaskbar: false });
  w.webContents.once('did-finish-load', () => { w.webContents.send('annotate:init', { image: img.toDataURL() }); w.show(); w.focus(); });
}
ipcMain.on('annotate:cancel', () => { if (alive(W.annotate)) W.annotate.close(); });
ipcMain.on('annotate:copy', (_e, url) => clipboard.writeImage(nativeImage.createFromDataURL(url)));
ipcMain.on('annotate:save', (_e, url) => {
  const img = nativeImage.createFromDataURL(url), sz = img.getSize();
  const v = store.create({ type: 'image', title: `Screenshot ${new Date().toLocaleString()}`, titleAuto: false, status: 'ready', stage: 'done', width: sz.width, height: sz.height });
  fs.writeFileSync(path.join(store.videoDir(v.id), 'image.png'), img.toPNG());
  fs.writeFileSync(path.join(store.videoDir(v.id), 'thumb.jpg'), img.resize({ width: 480 }).toJPEG(80));
  clipboard.writeText(`http://localhost:${PORT}/v/${v.id}`);
  if (alive(W.annotate)) W.annotate.close();
  shell.openExternal(`http://localhost:${PORT}/v/${v.id}`);
});

// ---------------- permissions ----------------
async function ensurePermissions(needCam) {
  if (process.platform !== 'darwin') return true;
  await systemPreferences.askForMediaAccess('microphone');
  if (needCam) await systemPreferences.askForMediaAccess('camera');
  if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    if (SELFTEST) return true;
    const r = await dialog.showMessageBox({ type: 'info', message: 'Spool needs Screen Recording permission',
      detail: 'Open System Settings → Privacy & Security → Screen & System Audio Recording, enable this app, then quit and reopen it.', buttons: ['Open Settings', 'Cancel'] });
    if (r.response === 0) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return false;
  }
  return true;
}

// ---------------- recording session ----------------
ipcMain.handle('sources:list', async () => {
  try { // throws when macOS has not granted Screen Recording to this process
    const srcs = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 240, height: 150 } });
    return srcs.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL(), isScreen: s.id.startsWith('screen:') }));
  } catch (e) { log('sources:list failed', e.message, permReport()); return []; }
});
const PANES = { screen: 'Privacy_ScreenCapture', camera: 'Privacy_Camera', mic: 'Privacy_Microphone', input: 'Privacy_ListenEvent' };
ipcMain.handle('perm:status', () => process.platform !== 'darwin' ? { screen: 'granted', camera: 'granted', mic: 'granted' }
  : { screen: systemPreferences.getMediaAccessStatus('screen'), camera: systemPreferences.getMediaAccessStatus('camera'), mic: systemPreferences.getMediaAccessStatus('microphone'), host: app.isPackaged || process.env.SPOOL_APP ? 'Spool' : 'Terminal (or the app you started it from)' });
ipcMain.handle('perm:open', (_e, which) => shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PANES[which] || PANES.screen}`));
ipcMain.on('launcher:close', () => { if (alive(W.launcher)) W.launcher.hide(); });
ipcMain.handle('app:relaunch', () => { app.relaunch(); app.exit(0); });
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => store.setSettings(patch));
ipcMain.handle('library:open', () => shell.openExternal(`http://localhost:${PORT}/`));
ipcMain.handle('screenshot:start', () => startScreenshot());

async function startRecording(opts) {
  if (S) return false;
  log('record:start', { mode: opts.mode, area: opts.crop ? 'custom' : opts.windowSource ? 'window' : 'screen', quality: opts.quality, perms: permReport() });
  if (!(await ensurePermissions(opts.mode !== 'screen'))) return false;
  const display = opts.mode === 'cam' ? screen.getPrimaryDisplay() : displayFor(opts.sourceId);
  S = { opts, display, bubble: { size: 200, shape: 'circle', filter: 'none', frame: 'ring', camOn: true, ...(opts.bubble || {}) }, pen: false, cursorOn: false };
  if (alive(W.launcher)) W.launcher.hide();
  try {
    let crop = opts.crop;
    if (!crop && opts.hideMenuBar && opts.mode !== 'cam' && !opts.windowSource) {
      const top = (display.workArea.y - display.bounds.y) / display.bounds.height; if (top > 0) crop = { x: 0, y: top, w: 1, h: 1 - top };
    }
    if (opts.mode === 'screen-cam') createBubble();
    if (opts.crop) createOutline(opts.crop);
    const info = await W.recorder.webContents.executeJavaScript(`window.__prepare(${JSON.stringify({ ...opts, crop, bubble: S.bubble })})`, true);
    S.info = info; pushBubbleRel();
    if (!SELFTEST) await runCountdown();
    createControls();
    await W.recorder.webContents.executeJavaScript('window.__begin()', true);
    startCursor(); registerShortcuts();
    if (opts.cursorFx) { S.cursorOn = true; ensureRing(); }
    if (opts.mode !== 'cam') ensureDraw();
    broadcastTools();
    return true;
  } catch (e) {
    log('record:start failed', e); endSession(); if (!SELFTEST) dialog.showErrorBox('Could not start recording', String(e.message || e)); return false;
  }
}
ipcMain.handle('record:start', (_e, opts) => startRecording(opts));
ipcMain.on('rec:control', (_e, a, arg) => send('recorder', 'rec:control', a, arg));
ipcMain.on('rec:tick', (_e, t) => send('controls', 'rec:tick', t));
ipcMain.on('rec:paused', (_e, p, t) => send('controls', 'rec:paused', p, t));
ipcMain.on('rec:mic', (_e, on) => send('controls', 'rec:mic', on));
ipcMain.on('rec:discard', () => endSession());

function endSession() {
  stopCursor(); unregisterShortcuts();
  for (const n of ['bubble', 'controls', 'countdown', 'outline', 'draw', 'ring', 'notes']) if (alive(W[n])) W[n].close();
  S = null;
}
ipcMain.handle('rec:finish', async (_e, p) => {
  endSession();
  const v = store.create({ title: `Recording ${new Date().toLocaleString()}`, duration: p.duration, mode: p.mode, titleAuto: true, size: p.size });
  const dir = store.videoDir(v.id), segs = [];
  p.segments.forEach((s, i) => { const f = `seg${i}.webm`; fs.writeFileSync(path.join(dir, f), Buffer.from(s.buffer)); segs.push({ file: f, dur: s.dur }); });
  fs.writeFileSync(path.join(dir, 'segments.json'), JSON.stringify({ segs, hasAudio: p.hasAudio }));
  fs.writeFileSync(path.join(dir, 'track.json'), JSON.stringify({ cursor: p.cursor, clicks: p.clicks, size: p.size }));
  orchestrator.processVideo(v.id).then(() => { if (SELFTEST) { console.log('SELFTEST_DONE', v.id, dir); app.quit(); } });
  if (!SELFTEST) shell.openExternal(`http://localhost:${PORT}/v/${v.id}`);
  return v.id;
});

// ---------------- app ----------------
app.whenReady().then(async () => {
  store.init(path.join(process.env.SPOOL_DATA || app.getPath('userData'), 'library'));
  orchestrator.init(process.env.SPOOL_DATA || app.getPath('userData'));
  startServer({ port: PORT });
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const srcs = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const pick = srcs.find((s) => s.id === S?.opts.sourceId) || srcs.find((s) => s.id.startsWith('screen:')) || srcs[0];
    callback(S?.opts.systemAudio ? { video: pick, audio: 'loopback' } : { video: pick });
  });
  createRecorder();
  logFile = path.join(app.getPath('userData'), 'spool.log'); log('start', { packaged: app.isPackaged, version: app.getVersion(), perms: permReport() });
  tray = new Tray(nativeImage.createEmpty()); tray.setTitle('● Spool');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'New recording…  (⌥⇧R)', click: showLauncher }, { label: 'Screenshot  (⌥⇧A)', click: startScreenshot },
    { label: 'Open library', click: () => shell.openExternal(`http://localhost:${PORT}/`) }, { type: 'separator' },
    { label: 'Copy diagnostics', click: () => { let t = ''; try { t = fs.readFileSync(logFile, 'utf8').split('\n').slice(-60).join('\n'); } catch {} clipboard.writeText(`Spool diagnostics\nperms: ${JSON.stringify(permReport())}\n${t}`); } },
    { label: 'Show log file', click: () => shell.showItemInFolder(logFile) }, { type: 'separator' }, { role: 'quit' },
  ]));
  tray.on('click', showLauncher);
  globalShortcut.register('Alt+Shift+A', startScreenshot);
  globalShortcut.register('Alt+Shift+R', showLauncher);
  const ico = path.join(__dirname, '..', 'assets', 'icon.png'); if (app.dock && fs.existsSync(ico)) app.dock.setIcon(nativeImage.createFromPath(ico));
  if (SELFTEST) { setTimeout(runSelfTest, 1500); return; }
  showLauncher();
});
app.on('window-all-closed', (e) => e.preventDefault());
app.on('activate', () => showLauncher()); // clicking the Dock icon always brings the launcher back
app.on('will-quit', () => globalShortcut.unregisterAll());

// Headless self-test: SPOOL_SELFTEST='{"mode":"screen-cam","seconds":6,"script":[[2000,"pause"],[3000,"resume"]]}' electron .
// Renders each UI window off-screen and saves PNGs (no screen capture involved) for visual review.
async function runSnapshots(outDir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fs.mkdirSync(outDir, { recursive: true });
  const snap = async (name, w) => { await wait(900); const img = await w.webContents.capturePage(); fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG()); w.close(); };
  showLauncher(); await wait(1500); await snap('launcher', W.launcher);
  let w = load('bubble', 'bubble/index.html', { width: 240, height: 290, show: true, x: 40, y: 60 });
  await wait(600); w.webContents.send('bubble:style', { w: 200, h: 240, shape: 'portrait', filter: 'warm', frame: 'gradient' }); await snap('bubble', w);
  w = load('controls', 'controls/index.html', { width: 520, height: 150, show: true, x: 40, y: 400 });
  await wait(500); w.webContents.send('rec:tick', 83.4); w.webContents.send('tool:state', { pen: true, cursor: true, notes: false, cam: true, hasCam: true }); await snap('controls', w);
  w = load('notes', 'notes/index.html', { width: 440, height: 340, show: true, x: 40, y: 600 });
  await wait(500); w.webContents.send('notes:mode', { mode: 'prompt', text: 'Welcome everyone. Today I will walk you through the new billing dashboard.\n\nFirst, open Settings.' }); await snap('notes', w);
  const imgP = SELFTEST.image; if (imgP) { w = load('annotate', 'annotate/index.html', { frame: true, transparent: false, show: true, width: 1000, height: 640, x: 100, y: 100 });
    await wait(500); w.webContents.send('annotate:init', { image: nativeImage.createFromPath(imgP).toDataURL() }); await snap('annotate', w); }
  console.log('SNAPSHOTS_DONE'); app.quit();
}

async function runSelfTest() {
  const t = SELFTEST;
  if (t.snapshots) return runSnapshots(t.snapshots); const srcs = await desktopCapturer.getSources({ types: ['screen'] });
  const ok = await startRecording({ mode: 'screen-cam', sourceId: srcs[0].id, camId: '', micId: '', micOn: true, quality: '720p', cursorFx: true, clickFx: false, systemAudio: !!t.systemAudio, ...t, bubble: t.bubble || {} });
  console.log('SELFTEST started:', ok, JSON.stringify(S?.info));
  for (const [ms, a, arg] of t.script || []) setTimeout(() => { if (['pen', 'cursor', 'notes', 'cam'].includes(a)) toggleTool(a, arg); else send('recorder', 'rec:control', a, arg); }, ms);
  setTimeout(() => send('recorder', 'rec:control', 'stop'), (t.seconds || 5) * 1000);
}
