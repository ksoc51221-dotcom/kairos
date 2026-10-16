// Factory for every BrowserWindow Spool opens (one function each) and the registry that finds them by name.
// No recording logic lives here: session.js decides when a window is needed and what it shows.
const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const store = require('../store');

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, 'preload.js');
const W = {}; // live windows by name
let quitting = false;

const alive = (w) => !!w && !w.isDestroyed();
const send = (name, ch, ...a) => { if (alive(W[name])) W[name].webContents.send(ch, ...a); };
const setQuitting = () => { quitting = true; };

const baseWin = (extra = {}) => ({
  show: false, frame: false, resizable: false, hasShadow: true, transparent: true, skipTaskbar: true,
  webPreferences: { preload: PRELOAD, backgroundThrottling: false }, ...extra,
});
function load(name, rel, opts) {
  const w = new BrowserWindow(baseWin(opts));
  w.loadFile(path.join(RENDERER, rel));
  W[name] = w; w.on('closed', () => { if (W[name] === w) delete W[name]; });
  return w;
}

// ---- B25: overlay windows must be able to float above full-screen apps ----
// macOS only lets an "accessory" app (no Dock icon) put windows over a full-screen Space, and calling setVisibleOnAllWorkspaces()
// with visibleInFullScreen on every window re-transforms the process type each time, which makes the earlier windows vanish.
// So: the Dock icon is hidden while any Spool window that must float is on screen, and floatTop() skips the per-window transform.
const holders = new Set();
let dockIcon = null;
function holdOverlay(key) { if (holders.has(key)) return; holders.add(key); if (holders.size === 1) app.dock?.hide(); }
// B28: the Dock icon is NOT shown again when the last overlay goes. app.dock.show() turns the process back into a foreground app, which activates
// Spool and switches the user to its Space or pulls it in front of the app they were using, after every recording. Once a Spool window has been
// up, Spool stays a menu-bar app (tray icon and ⌥⇧R open the launcher); the Dock icon is only there at launch, before the first overlay.
function releaseOverlay(key) { holders.delete(key); }
const setDockIcon = (img) => { dockIcon = img; };
const floatTop = (w) => { w.setAlwaysOnTop(true, 'screen-saver'); w.setVisibleOnAllWorkspaces(true, { visibleInFullScreen: true, skipTransformProcessType: true }); };
const showWhenReady = (w) => w.once('ready-to-show', () => w.showInactive());

// Moves a window's frame to `to` over `ms` with an ease-out curve, using ordinary setBounds calls from a timer.
// Not setBounds(..., true): macOS runs that animation inside the call and blocks the main process for its whole duration (about 320 ms, measured),
// which froze screen capture and the cursor feed whenever the control bar opened a panel or the bubble snapped during a recording.
function easeBounds(w, to, ms = 140) {
  if (!alive(w)) return;
  clearInterval(w._ease);
  const from = w.getBounds(), t0 = performance.now();
  w._ease = setInterval(() => {
    if (!alive(w)) return clearInterval(w._ease);
    const p = Math.min(1, (performance.now() - t0) / ms), k = 1 - Math.pow(1 - p, 3), at = (a, b) => Math.round(a + (b - a) * k);
    w.setBounds({ x: at(from.x, to.x), y: at(from.y, to.y), width: at(from.width, to.width), height: at(from.height, to.height) });
    if (p >= 1) clearInterval(w._ease);
  }, 16);
}

const displayFor = (sourceId) => {
  const id = /^screen:(\d+):/.exec(sourceId || '')?.[1];
  return screen.getAllDisplays().find((d) => String(d.id) === id) || screen.getPrimaryDisplay();
};

// ---- launcher ----
// A 280 px card (see launcher.css) plus a 6 px transparent margin each side for its shadow. Its height follows the card (launcher:size),
// its position is remembered between runs (U4), and it fades in and slides up 8 px every time it is shown.
const LAUNCHER_W = 292;
function placeLauncher() {
  const saved = store.getSettings().launcherPos, b = W.launcher.getBounds();
  const onScreen = saved && screen.getAllDisplays().some((d) => saved.x >= d.workArea.x - 40 && saved.x <= d.workArea.x + d.workArea.width - 80 && saved.y >= d.workArea.y - 8 && saved.y <= d.workArea.y + d.workArea.height - 80);
  if (onScreen) { W.launcher.setBounds({ x: saved.x, y: saved.y, width: LAUNCHER_W, height: b.height }); return; }
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  W.launcher.setBounds({ x: wa.x + wa.width - LAUNCHER_W - 14, y: wa.y + 12, width: LAUNCHER_W, height: b.height });
}
let rememberTimer;
const rememberLauncher = () => { clearTimeout(rememberTimer); rememberTimer = setTimeout(() => { if (alive(W.launcher)) { const { x, y } = W.launcher.getBounds(); store.setSettings({ launcherPos: { x, y } }); } }, 400); };
function showLauncher() {
  if (require('./session').isActive()) return;
  if (!alive(W.launcher)) {
    const w = load('launcher', 'launcher/index.html', { width: LAUNCHER_W, height: 470, alwaysOnTop: true });
    w.on('close', (e) => { if (!quitting) { e.preventDefault(); w.hide(); } }); // closing only hides; the Dock icon brings it back
    w.on('show', () => { holdOverlay('launcher'); w.webContents.send('launcher:shown'); prepareCountdown(); }); w.on('hide', () => { releaseOverlay('launcher'); require('./session').launcherHidden(); });
    w.on('moved', rememberLauncher);
  }
  placeLauncher();
  W.launcher.show(); W.launcher.focus();
}
const hideLauncher = () => { if (alive(W.launcher)) W.launcher.hide(); };
const toggleLauncher = () => { if (alive(W.launcher) && W.launcher.isVisible() && W.launcher.isFocused()) hideLauncher(); else showLauncher(); }; // ⌥⇧R
function sizeLauncher(h) {
  if (!alive(W.launcher)) return;
  const b = W.launcher.getBounds(), wa = screen.getDisplayMatching(b).workArea, nh = Math.max(160, Math.min(Math.round(h), wa.height - 8));
  if (nh !== b.height) W.launcher.setBounds({ ...b, height: nh });
}

// ---- recorder: hidden renderer that owns every stream ----
function createRecorder() {
  W.recorder = new BrowserWindow({ show: false, webPreferences: { preload: PRELOAD, backgroundThrottling: false } });
  W.recorder.loadFile(path.join(RENDERER, 'recorder/index.html'));
  return W.recorder;
}

// ---- overlays shown while recording ----
function createBubble(bounds) {
  const w = load('bubble', 'bubble/index.html', { ...bounds, hasShadow: false, alwaysOnTop: true, focusable: false });
  floatTop(w); w.setContentProtection(true); showWhenReady(w); return w;
}
function createControls(bounds) {
  const w = load('controls', 'controls/index.html', { ...bounds, alwaysOnTop: true, focusable: false });
  floatTop(w); w.setContentProtection(true); showWhenReady(w); return w;
}
// Clickable (✕ and ⏭ work on the first click) but never focused, so showing it cannot pull the user out of the app they are in (B28).
// Content-protected, so it is never in the recording.
// B26/U7: creating and loading a full-display window took about 90 ms of the 150 ms budget, so it is made hidden while the launcher is open
// (prepareCountdown) and beginCountdown only moves it onto the display, shows it and tells the page to start.
function createCountdown(d) {
  const w = load('countdown', 'countdown/index.html', { x: d.x, y: d.y, width: d.width, height: d.height, alwaysOnTop: true, hasShadow: false, acceptFirstMouse: true });
  floatTop(w); w.setContentProtection(true);
  w._loaded = new Promise((res) => w.webContents.once('did-finish-load', () => { w._isLoaded = true; res(); }));
  return w;
}
const prepareCountdown = () => { if (!alive(W.countdown)) createCountdown(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds); };
async function beginCountdown(d) {
  const t0 = performance.now(), prepared = alive(W.countdown), w = prepared ? W.countdown : createCountdown(d), wasLoaded = !!w._isLoaded;
  w.setBounds({ x: d.x, y: d.y, width: d.width, height: d.height }); const t1 = performance.now();
  await w._loaded;
  if (!alive(w)) return null;
  const t2 = performance.now(); w.showInactive(); w.webContents.send('countdown:begin'); w._t = { prepared, wasLoaded, boundsMs: +(t1 - t0).toFixed(1), loadWaitMs: +(t2 - t1).toFixed(1), showMs: +(performance.now() - t2).toFixed(1) }; // B28: never takes focus; acceptFirstMouse makes the first click on ✕ or ⏭ count
  return w;
}
function createOutline(b) {
  const w = load('outline', 'outline/index.html', { ...b, alwaysOnTop: true, focusable: false, hasShadow: false });
  w.setIgnoreMouseEvents(true); floatTop(w); w.setContentProtection(true); showWhenReady(w); return w;
}
// The drawing overlay is the one overlay that is captured on purpose: strokes appear in the video.
// It is created hidden before capture starts and only shown on first pen use. Creating a full-screen window in the middle of a recording
// froze capture for about 330 ms (measured), and a hidden window costs the compositor nothing.
function createDraw(d) {
  const w = load('draw', 'draw/index.html', { x: d.x, y: d.y, width: d.width, height: d.height, alwaysOnTop: true, hasShadow: false, focusable: true, acceptFirstMouse: true });
  floatTop(w); w.setIgnoreMouseEvents(true); return w;
}
// Presenter-only cursor ring: content-protected so it never appears in the recording (B21).
function createRing() {
  const w = load('ring', 'ring/index.html', { width: 110, height: 110, alwaysOnTop: true, hasShadow: false, focusable: false });
  w.setIgnoreMouseEvents(true); floatTop(w); w.setContentProtection(true); w.showInactive(); return w;
}
function createNotes({ x, y, mode }) {
  const w = load('notes', 'notes/index.html', { width: 440, height: mode === 'prompt' ? 340 : 400, x, y, alwaysOnTop: true, focusable: true, acceptFirstMouse: true });
  floatTop(w); w.setContentProtection(true); return w; // never part of the recording
}

// ---- area picker (recording + screenshots) ----
function createArea(d) {
  const w = load('area', 'area/index.html', { x: d.x, y: d.y, width: d.width, height: d.height, alwaysOnTop: true, hasShadow: false, focusable: true, enableLargerThanScreen: true });
  floatTop(w); return w;
}

// ---- screenshot annotator ----
function createAnnotator(d) {
  return load('annotate', 'annotate/index.html', { frame: true, titleBarStyle: 'hiddenInset', transparent: false, resizable: true, hasShadow: true,
    width: Math.min(1200, d.workArea.width - 80), height: Math.min(840, d.workArea.height - 60), x: d.workArea.x + 40, y: d.workArea.y + 30, skipTaskbar: false });
}

module.exports = {
  W, alive, send, load, baseWin, floatTop, easeBounds, holdOverlay, releaseOverlay, setDockIcon, setQuitting, displayFor,
  showLauncher, hideLauncher, toggleLauncher, sizeLauncher, createRecorder, createBubble, createControls, createCountdown, prepareCountdown, beginCountdown, createOutline, createDraw, createRing, createNotes, createArea, createAnnotator,
};
