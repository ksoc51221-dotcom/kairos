// Recording session: idle → preparing → countdown → recording ⇄ paused → stopping → saved.
// Owns the overlay windows (bubble, controls, countdown, outline, pen, ring, notes), the cursor feed and the recording shortcuts, and writes
// the recorder's chunks to disk as they arrive (B3). The hidden recorder window owns the actual streams and the clock; this module directs it.
const { app, screen, shell, dialog, desktopCapturer } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const store = require('../store');
const orchestrator = require('../agents/orchestrator');
const C = require('../shared/constants');
const { writeTimeline } = require('../pipeline/segments');
const { makeFilter, nextDelay } = require('../shared/cursor');
const config = require('./config');
const { log } = require('./log');
const permissions = require('./permissions');
const shortcuts = require('./shortcuts');
const win = require('./windows');
const { W, alive, send } = win;

const PAD = 10, TOP = 10, BOT = 128, PANEL_W = 252; // bubble window margins: transparent padding around the camera, and room under it for the hover panel (bubble.css)
const bubbleWin = (st) => [Math.max(st.w, PANEL_W) + PAD * 2, st.h + TOP + BOT];
const EVENT_FLUSH_MS = 100;        // cursor / click / pen / bubble events travel to the recorder in batches
const CURSOR_KEEPALIVE_MS = 200;   // a still cursor still gets a sample this often
const BUBBLE_THROTTLE_MS = 40;
const ringSize = 110;
let S = null;                      // the active session, or null when idle
const events = new EventEmitter(); // 'processed' { id, dir } once the finished recording has been through the pipeline (self-test hook)
const isActive = () => !!S;
const getS = () => S;
const cycle = (arr, v, d = 1) => arr[(arr.indexOf(v) + d + arr.length) % arr.length];
const epoch = () => performance.timeOrigin + performance.now(); // same clock the recorder window stamps its segments with

// ---------------- events for the timeline ----------------
// ['c', at, x, y] cursor · ['k', at, x, y, button] click · ['d', at, on] pen on/off · ['b', at, bubble] camera bubble
function emit(ev) { if (!S) return; S.events.push(ev); if (!S.flushTimer) S.flushTimer = setTimeout(flushEvents, EVENT_FLUSH_MS); }
function flushEvents() {
  if (!S) return;
  clearTimeout(S.flushTimer); S.flushTimer = null;
  if (S.events.length) { send('recorder', 'rec:events', S.events); S.events = []; }
}

// ---------------- speaker notes ----------------
// B28: the teleprompter ('prompt') is opened while the user is presenting another app, so it must not pull focus away from it (that app would stop
// receiving keystrokes, and Iris would stay frontmost until the recording ended). Clicking into it still works at once (acceptFirstMouse).
// Editing ('edit', from the launcher) is the user asking to type, so it takes focus.
const showNotes = (w, mode) => (mode === 'prompt' ? w.showInactive() : w.show());
function openNotes(mode) {
  const text = store.getSettings().notes || '';
  if (!alive(W.notes)) {
    const wa = (S?.display || screen.getPrimaryDisplay()).workArea;
    const w = win.createNotes({ x: wa.x + Math.round(wa.width / 2) - 220, y: wa.y + 20, mode });
    w.webContents.once('did-finish-load', () => { w.webContents.send('notes:mode', { mode, text }); showNotes(w, mode); });
  } else { W.notes.webContents.send('notes:mode', { mode, text }); showNotes(W.notes, mode); }
}
const closeNotes = () => { if (alive(W.notes)) W.notes.close(); };

// ---------------- camera bubble ----------------
// B27: the bubble is a preview before it is part of a recording. While the launcher is open in Screen + Cam or Cam mode the launcher keeps it up
// (previewSet), showing the camera at its saved position; start() then reuses this same window (no close and recreate, which also removes a
// window creation from the start path). It closes when the launcher closes without recording, when the mode drops the camera, or when the camera is off.
// PB is the bubble's style while no session exists; a session copies it into S.bubble.
const PB = { on: false, size: 200, shape: 'circle', filter: 'none', frame: 'ring', camOn: true, camId: '' };
const bs = () => (S ? S.bubble : PB);
const bubbleDisplay = () => (S ? S.display : alive(W.bubble) ? screen.getDisplayMatching(W.bubble.getBounds()) : screen.getPrimaryDisplay());
function bubbleRect() {
  const b = W.bubble.getBounds(), [w, h] = C.bubbleDims(bs().shape, bs().size);
  return { x: b.x + PAD, y: b.y + TOP, w, h };
}
// Every move, resize, style change and camera toggle becomes a keyframe in timeline.json (throttled while dragging).
function pushBubble() {
  if (!S || !alive(W.bubble) || S.opts.mode !== 'screen-cam') return;
  if (S.bubbleTimer) { S.bubbleDirty = true; return; }
  const r = bubbleRect(), d = S.display.bounds, b = S.bubble;
  emit(['b', epoch(), { x: (r.x - d.x) / d.width, y: (r.y - d.y) / d.height, w: r.w / d.width, h: r.h / d.height, shape: b.shape, filter: b.filter, frame: b.frame, visible: b.camOn !== false }]);
  S.bubbleTimer = setTimeout(() => { if (!S) return; S.bubbleTimer = null; if (S.bubbleDirty) { S.bubbleDirty = false; pushBubble(); } }, BUBBLE_THROTTLE_MS);
}
const bubbleStyle = () => { const b = bs(), [w, h] = C.bubbleDims(b.shape, b.size); return { w, h, size: b.size, shape: b.shape, filter: b.filter, frame: b.frame }; };
function resizeBubble() {
  const st = bubbleStyle(), b = W.bubble.getBounds(), [nw, nh] = bubbleWin(st);
  win.easeBounds(W.bubble, { x: b.x, y: b.y, width: nw, height: nh }, 140); // eased (U10), but never with the blocking animated setBounds
  send('bubble', 'bubble:style', st);
  pushBubble();
}
function snapBubble() { // edge snapping
  if (!alive(W.bubble)) return;
  const r = bubbleRect(), wa = bubbleDisplay().workArea, m = 20, t = 48; let { x, y } = r;
  if (Math.abs(x - wa.x) < t) x = wa.x + m; else if (Math.abs(x + r.w - (wa.x + wa.width)) < t) x = wa.x + wa.width - r.w - m;
  if (Math.abs(y - wa.y) < t) y = wa.y + m; else if (Math.abs(y + r.h + BOT - (wa.y + wa.height)) < t) y = wa.y + wa.height - r.h - BOT - m; // the hover panel under the camera stays on screen
  if (x !== r.x || y !== r.y) { const b = W.bubble.getBounds(); win.easeBounds(W.bubble, { ...b, x: x - PAD, y: y - TOP }, 120); }
}
// Default and remembered position: the saved spot when it is still on a screen, otherwise the bottom-left corner of the work area.
const bubbleHome = (display, w, h) => {
  const saved = store.getSettings().bubblePos, wa = display.workArea;
  if (saved && saved.x >= wa.x - 40 && saved.x <= wa.x + wa.width - 60 && saved.y >= wa.y - 8 && saved.y <= wa.y + wa.height - 60) return saved;
  return { x: wa.x + 20, y: wa.y + wa.height - (h + TOP + BOT) - 8 };
};
let bubbleSaveTimer;
function createBubble(display, fake) {
  const st = bubbleStyle(), [width, height] = bubbleWin(st), pos = bubbleHome(display, st.w, st.h);
  const win_ = win.createBubble({ width, height, x: pos.x, y: pos.y });
  win_.webContents.once('did-finish-load', () => {
    win_.webContents.send('bubble:init', { camId: bs().camId, fake: !!fake });
    send('bubble', 'bubble:style', bubbleStyle());
    pushBubble();
  });
  let snapT;
  win_.on('move', () => {
    pushBubble(); clearTimeout(snapT); snapT = setTimeout(snapBubble, 220);
    clearTimeout(bubbleSaveTimer); bubbleSaveTimer = setTimeout(() => { if (alive(W.bubble)) { const b = W.bubble.getBounds(); store.setSettings({ bubblePos: { x: b.x, y: b.y } }); } }, 600);
  });
  return win_;
}
const closeBubble = () => { if (alive(W.bubble)) W.bubble.close(); };
// The launcher reports what it wants: { on, camId, size, shape, filter, frame }. `on` = a camera is part of this mode.
function previewSet(p = {}) {
  if (S) return; // while a session exists the session owns the bubble
  Object.assign(PB, { size: p.size ?? PB.size, shape: p.shape ?? PB.shape, filter: p.filter ?? PB.filter, frame: p.frame ?? PB.frame });
  const camChanged = p.camId !== undefined && p.camId !== PB.camId; if (p.camId !== undefined) PB.camId = p.camId;
  PB.on = !!p.on;
  if (!PB.on) return closeBubble();
  const fake = !!(config.SELFTEST && config.SELFTEST.fakeCam);
  if (!alive(W.bubble)) { const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); createBubble(d, fake); return; }
  const st = bubbleStyle(), b = W.bubble.getBounds(), [nw, nh] = bubbleWin(st);
  if (nw !== b.width || nh !== b.height) win.easeBounds(W.bubble, { x: b.x, y: b.y, width: nw, height: nh }, 140);
  send('bubble', 'bubble:style', st);
  if (camChanged) send('bubble', 'bubble:init', { camId: PB.camId, fake });
}
function bubbleAction(a, v) {
  if (!alive(W.bubble)) return;
  const b = bs();
  // the hover panel sends a value; a missing or unknown one steps to the next (the "‹ ›" pickers)
  const pick = (list, cur) => (list.includes(v) ? v : cycle(list, cur, v === 'prev' ? -1 : 1));
  if (a === 'power') { if (S) return toggleTool('cam'); send('launcher', 'preview:style', { camOn: false }); return; } // before recording the launcher owns the camera switch
  if (a === 'size') b.size = +v; else if (a === 'shape') b.shape = pick(C.SHAPES, b.shape);
  else if (a === 'filter') b.filter = pick(C.FILTER_KEYS, b.filter); else if (a === 'frame') b.frame = pick(C.FRAME_KEYS, b.frame);
  resizeBubble();
  if (!S) send('launcher', 'preview:style', { size: b.size, shape: b.shape, filter: b.filter, frame: b.frame }); // keep the launcher's choices in step with the panel
}

// ---------------- control bar, countdown, outline ----------------
// The bar is a vertical pill (see controls.css). Its window is as tall as the bar and widens only while a side panel (pen colours, rewind) is open.
const CTRL_BAR_W = 72, CTRL_PANEL_W = 252;
const onSomeDisplay = (p) => !!p && screen.getAllDisplays().some((d) => p.x >= d.workArea.x - 20 && p.x <= d.workArea.x + d.workArea.width - 60 && p.y >= d.workArea.y - 8 && p.y <= d.workArea.y + d.workArea.height - 60);
let ctrlTimer;
function createControls() {
  const wa = S.display.workArea, saved = store.getSettings().controlsPos;
  const pos = onSomeDisplay(saved) ? saved : { x: wa.x + 4, y: wa.y + Math.round(wa.height * 0.12) }; // left edge, clear of the bubble's default corner
  const w = win.createControls({ width: CTRL_BAR_W, height: 470, x: pos.x, y: pos.y });
  w.once('ready-to-show', broadcastTools);
  w.on('moved', () => { clearTimeout(ctrlTimer); ctrlTimer = setTimeout(() => { if (alive(W.controls)) { const { x, y } = W.controls.getBounds(); store.setSettings({ controlsPos: { x, y } }); } }, 400); });
}
function controlsLayout({ height, panel } = {}) {
  if (!S || !alive(W.controls)) return;
  const b = W.controls.getBounds(), width = CTRL_BAR_W + (panel ? CTRL_PANEL_W : 0), h = Math.max(120, Math.min(Math.round(height) || b.height, S.display.workArea.height));
  if (width !== b.width) win.easeBounds(W.controls, { ...b, width, height: h }, 120); // eased when a panel opens or closes, never with the blocking animated setBounds
  else if (h !== b.height) W.controls.setBounds({ ...b, height: h });
}

// The countdown has three endings: it runs out or is skipped (⏭, Space, Enter) and the recording starts; or it is cancelled (✕, Esc) and the start is undone.
let countdownResolve = null;
function runCountdown() {
  return new Promise((resolve) => {
    let w = null;
    countdownResolve = (how) => { countdownResolve = null; if (alive(w || W.countdown)) (w || W.countdown).close(); resolve(how || 'done'); };
    win.beginCountdown(S.display.bounds).then((cw) => { w = cw; if (S) { S.metrics.countdownShownMs = +(performance.now() - S.t0).toFixed(1); S.metrics.cd = cw && cw._t; } });
  });
}
// The page reports its first painted frame after `countdown:begin`: that, not the window's show event, is when the user can see it (U7/B26).
function countdownPainted() {
  if (!S) return; S.metrics.countdownPaintedMs = +(performance.now() - S.t0).toFixed(1);
  if (S.opts.clickAt) S.metrics.sinceClickMs = +(epoch() - S.opts.clickAt).toFixed(1);
  log('record:countdown-visible', S.metrics);
}
const countdownDone = (how) => countdownResolve?.(typeof how === 'string' ? how : 'done');
const countdownSkip = () => countdownResolve?.('skip');
const CANCELLED = Symbol('cancelled');
// ✕ on the countdown: close the overlays now (the camera preview stays: it belongs to the launcher, which comes back), then start() sees the
// answer once the streams it was opening have settled, stops them, deletes the empty record and shows the launcher again.
function cancelStart() {
  if (!S || S.live || S.cancelled) return;
  S.cancelled = true;
  for (const n of ['controls', 'outline', 'ring', 'draw', 'notes']) if (alive(W[n])) W[n].close();
  countdownDone('cancel');
}

function createOutline(crop) {
  const d = S.display.bounds;
  win.createOutline({ x: Math.round(d.x + crop.x * d.width) - 3, y: Math.round(d.y + crop.y * d.height) - 3, width: Math.round(crop.w * d.width) + 6, height: Math.round(crop.h * d.height) + 6 });
}

// ---------------- tools: pen, cursor ring, notes, camera ----------------
function ensureDraw() { return alive(W.draw) ? W.draw : win.createDraw(S.display.bounds); } // B20: hidden until the first pen use, so nothing full-screen is composited for recordings that never draw
function ensureRing() {
  if (alive(W.ring)) return;
  const w = win.createRing(), at = config.SELFTEST && config.SELFTEST.ringAt; // tests pin the ring to a known spot
  if (at) w.setPosition(Math.round(at.x - ringSize / 2), Math.round(at.y - ringSize / 2));
}
const toolState = () => ({ pen: !!S?.pen, cursor: !!S?.cursorOn, notes: alive(W.notes), cam: S?.bubble.camOn !== false, hasCam: S?.opts.mode === 'screen-cam' });
const broadcastTools = () => send('controls', 'tool:state', toolState());
function toggleTool(t, arg) {
  if (!S) return;
  log('tool', t);
  if (t === 'pen') {
    S.pen = !S.pen; const w = ensureDraw(); if (!w.isVisible()) w.showInactive(); w.setIgnoreMouseEvents(!S.pen); w.webContents.send('draw:mode', S.pen); // B28: no w.focus() here. Drawing is mouse input and works without it; taking focus pulled the presenter's app out of the keyboard and Iris never gave it back

    emit(['d', epoch(), S.pen ? 1 : 0]);
  } else if (t === 'pen-color') send('draw', 'draw:color', arg);
  else if (t === 'cursor') { S.cursorOn = !S.cursorOn; if (S.cursorOn) ensureRing(); else if (alive(W.ring)) W.ring.close(); }
  else if (t === 'notes') { if (alive(W.notes)) W.notes.close(); else openNotes('prompt'); setTimeout(broadcastTools, 150); }
  else if (t === 'cam') { S.bubble.camOn = !S.bubble.camOn; if (alive(W.bubble)) (S.bubble.camOn ? W.bubble.showInactive() : W.bubble.hide()); pushBubble(); }
  broadcastTools();
}

// ---------------- cursor + clicks (B21) ----------------
// The cursor is sampled at 60 Hz by a drift-corrected timer (each tick aims at start + n × period, so a late tick does not push every later
// one back). Samples carry epoch timestamps; the recorder maps them onto the recorded timeline. Window and camera-only recordings have no
// screen position to track, so the sampler then only feeds the presenter ring.
let hook;
function startCursor() {
  const d = S.display.bounds, period = 1000 / C.CURSOR_HZ, track = S.trackCursor, fixed = config.SELFTEST && config.SELFTEST.ringAt;
  const st = (S.cursor = { n: 0, t0: performance.now(), ticks: 0, prev: 0, maxGap: 0, late: 0, timer: null, startedAt: performance.now(), keep: makeFilter({ keepaliveMs: CURSOR_KEEPALIVE_MS }) });
  const tick = () => {
    const now = performance.now();
    if (st.prev) { const gap = now - st.prev; if (gap > st.maxGap) st.maxGap = gap; if (gap > period * 1.5) st.late++; }
    st.prev = now; st.ticks++;
    const p = screen.getCursorScreenPoint();
    if (track) for (const [at, x, y] of st.keep(performance.timeOrigin + now, +((p.x - d.x) / d.width).toFixed(4), +((p.y - d.y) / d.height).toFixed(4))) emit(['c', at, x, y]);
    if (alive(W.ring)) W.ring.setPosition(Math.round((fixed ? fixed.x : p.x) - ringSize / 2), Math.round((fixed ? fixed.y : p.y) - ringSize / 2));
    st.timer = setTimeout(tick, nextDelay(st, performance.now(), period));
  };
  tick();
  if (track && S.opts.clickFx !== false) try {
    const { uIOhook } = require('uiohook-napi'); hook = uIOhook;
    uIOhook.on('click', (e) => {
      const p = screen.getCursorScreenPoint(); // hook coords are physical px; the Electron cursor API is already in DIPs
      emit(['k', epoch(), +((p.x - d.x) / d.width).toFixed(4), +((p.y - d.y) / d.height).toFixed(4), e.button]);
      if (alive(W.ring)) W.ring.webContents.send('ring:click');
    });
    uIOhook.start();
  } catch (e) { console.warn('click hook unavailable:', e.message); }
}
function stopCursor() {
  const st = S?.cursor; let out = null;
  if (st) { clearTimeout(st.timer); const secs = (performance.now() - st.startedAt) / 1000; out = { hz: +(st.ticks / Math.max(secs, 0.001)).toFixed(1), ticks: st.ticks, maxGapMs: +st.maxGap.toFixed(1), lateTicks: st.late }; S.cursor = null; }
  try { hook?.stop(); hook?.removeAllListeners(); } catch {}
  hook = null; return out;
}

// ---------------- sources (screens + windows) for the launcher ----------------
// { screens: true } lists the displays only, without thumbnails, which is quick enough to call every time the launcher opens.
async function listSources({ screens = false } = {}) {
  try { // throws when macOS has not granted Screen Recording to this process
    const srcs = await desktopCapturer.getSources({ types: screens ? ['screen'] : ['screen', 'window'], thumbnailSize: screens ? { width: 0, height: 0 } : { width: 240, height: 150 } });
    return srcs.map((s) => ({ id: s.id, name: s.name, thumb: screens ? '' : s.thumbnail.toDataURL(), isScreen: s.id.startsWith('screen:') }));
  } catch (e) { log('sources:list failed', e.message, permissions.report()); return []; }
}

// ---------------- chunks to disk (B3) ----------------
const segFile = (kind, n) => (kind === 'screen' ? C.FILES.screen(n, S.ext) : C.FILES.cam(n, S.ext));
function chunk(kind, n, buf) {
  if (!S || !S.ext) return;
  const key = `${kind}_${n}`; let w = S.writers.get(key);
  if (!w) {
    const stream = fs.createWriteStream(path.join(S.dir, segFile(kind, n)), { flags: 'w' });
    stream.on('error', (e) => log('chunk write failed', key, e.message));
    w = { stream, bytes: 0 }; S.writers.set(key, w);
  }
  const b = Buffer.from(buf); w.bytes += b.length; w.stream.write(b);
}
// The recorder waits for this before it counts a segment as saved.
async function segmentEnd(kind, n) {
  const key = `${kind}_${n}`, w = S?.writers.get(key);
  if (!w) return { bytes: 0 };
  S.writers.delete(key); await new Promise((res) => w.stream.end(res));
  return { bytes: w.bytes };
}
const rmSegment = (dir, name) => fs.rmSync(path.join(dir, name), { force: true });
async function dropSegments(nums) { if (S) for (const n of nums) for (const k of ['screen', 'cam']) rmSegment(S.dir, segFile(k, n)); }
async function resetSegments() {
  if (!S) return;
  await Promise.all([...S.writers.values()].map((w) => new Promise((res) => w.stream.end(res)))); S.writers.clear();
  for (const f of fs.readdirSync(S.dir)) if (/^(screen|cam)_\d+\./.test(f)) rmSegment(S.dir, f);
}
async function closeWriters(s) { await Promise.all([...s.writers.values()].map((w) => new Promise((res) => w.stream.end(res)))); s.writers.clear(); }

// ---------------- start / end ----------------
const displayInfo = (d) => ({ id: d.id, x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, scaleFactor: d.scaleFactor, pxWidth: Math.round(d.bounds.width * d.scaleFactor), pxHeight: Math.round(d.bounds.height * d.scaleFactor) });

// Resolves once the bubble, control bar and ring are on screen and have had time to paint.
const shown = (w) => new Promise((res) => { if (!alive(w) || w.isVisible()) return res(); w.once('show', res); setTimeout(res, 1500); });
async function overlaysReady() {
  await Promise.all(['bubble', 'controls', 'ring'].map((n) => shown(W[n])));
  await new Promise((r) => setTimeout(r, config.SELFTEST ? 400 : 150));
}

async function start(opts) {
  if (S) return false;
  const t0 = performance.now();
  opts = { ...opts, quality: opts.quality || C.DEFAULT_QUALITY };
  log('record:start', { mode: opts.mode, area: opts.crop ? 'custom' : opts.windowSource ? 'window' : 'screen', quality: opts.quality, perms: permissions.report() });
  const ok = await permissions.ensure({ cam: opts.mode !== 'screen' && !opts.fakeCam, screen: opts.mode !== 'cam', quiet: !!config.SELFTEST }); // B7: cam-only needs no screen permission
  const ensureMs = +(performance.now() - t0).toFixed(1);
  if (!ok) return false;
  const display = opts.mode === 'cam' ? screen.getPrimaryDisplay() : win.displayFor(opts.sourceId);
  S = {
    opts, display, bubble: { size: 200, shape: 'circle', filter: 'none', frame: 'ring', camOn: true, ...(opts.bubble || {}) }, pen: false, cursorOn: false,
    events: [], flushTimer: null, writers: new Map(), id: null, dir: null, ext: null, info: null, cursor: null,
    trackCursor: opts.mode !== 'cam' && !opts.windowSource, // a window recording has no screen position to follow
    t0, metrics: { ensureMs }, cancelled: false,
  };
  S.bubble.camId = opts.camId || '';
  win.holdOverlay('session'); win.hideLauncher();
  // The library record exists from the first chunk on, so a crash leaves a visible "interrupted" video with its files, not orphan files.
  const v = store.create({ title: `Recording ${new Date().toLocaleString()}`, titleAuto: true, mode: opts.mode, status: C.LIBRARY_STATUS.RECORDING, stage: 'Recording',
    ...(opts.privacy ? { privacy: { mode: opts.privacy } } : {}), ...(opts.forAgent ? { forAgent: true } : {}) }); // the bar's lock sets who can watch; Record for agent asks for the Action Plan
  S.id = v.id; S.dir = store.videoDir(v.id);
  try {
    let crop = opts.crop;
    if (!crop && opts.hideMenuBar && opts.mode !== 'cam' && !opts.windowSource) {
      const top = (display.workArea.y - display.bounds.y) / display.bounds.height; if (top > 0) crop = { x: 0, y: top, w: 1, h: 1 - top };
    }
    // The countdown shows at once and the streams open while it counts, as in Loom. Waiting for them first delayed it by however long the
    // camera took to wake up (often 1–2 s, varying run to run).
    S.metrics.setupMs = +(performance.now() - t0).toFixed(1); // permission check + library record + launcher hidden, before the countdown is asked for
    const countdown = (config.SELFTEST && !config.SELFTEST.countdown) || opts.countdown === false ? null : runCountdown(); // the Recording settings switch turns the countdown off
    // Every overlay exists, and has painted, before capture begins: creating a window mid-recording stalls the compositor for a moment,
    // which showed up as one long gap in the frames and in the cursor feed.
    if (opts.mode === 'screen') closeBubble(); // a stale preview (the camera was switched off after it opened)
    if (alive(W.bubble)) reuseBubble(); else if (opts.mode === 'screen-cam') createBubble(S.display, !!opts.fakeCam);
    if (opts.crop) createOutline(opts.crop);
    createControls();
    if (opts.cursorFx) { S.cursorOn = true; ensureRing(); }
    ensureDraw(); // hidden for now (see windows.createDraw)
    const cfg = {
      mode: opts.mode, sourceId: opts.sourceId, windowSource: !!opts.windowSource, systemAudio: !!opts.systemAudio, micOn: opts.micOn !== false, micId: opts.micId, camId: opts.camId,
      quality: opts.quality, crop: crop || null, fakeCam: !!opts.fakeCam, fakeMic: !!opts.fakeMic, display: displayInfo(display),
    };
    try { S.info = await W.recorder.webContents.executeJavaScript(`window.__prepare(${JSON.stringify(cfg)})`, true); }
    catch (e) { countdownDone(); throw e; }
    if (S.cancelled) throw CANCELLED;
    S.ext = S.info.ext; S.metrics.preparedMs = +(performance.now() - S.t0).toFixed(1); log('record:prepared', S.info);
    pushBubble();
    if ((await countdown) === 'cancel' || S.cancelled) throw CANCELLED;
    await overlaysReady();
    if (opts.beforeBegin) await opts.beforeBegin(); // test hook (in-process only): place helper windows once the overlays are in place
    await W.recorder.webContents.executeJavaScript('window.__begin()', true);
    flushEvents();
    startCursor();
    shortcuts.registerSession({ onTogglePause: () => send('recorder', 'rec:control', 'toggle-pause'), onStop: () => send('recorder', 'rec:control', 'stop'), onPen: () => toggleTool('pen') });
    broadcastTools();
    S.live = true; // capture has begun (the launcher-driven self-test waits for this)
    return true;
  } catch (e) {
    const cancelled = e === CANCELLED || !!S?.cancelled, id = S?.id;
    try { await W.recorder.webContents.executeJavaScript('window.__cancel && window.__cancel()', true); } catch {} // stop whatever prepare had already opened
    if (cancelled) { log('record:cancelled during countdown'); abort({ keepBubble: true }); if (id) store.remove(id); win.showLauncher(); return false; }
    log('record:start failed', e); abort(); if (id) store.remove(id);
    if (!config.SELFTEST) dialog.showErrorBox('Could not start recording', String(e.message || e)); return false;
  }
}

// The preview bubble becomes the recording's bubble: same window, same camera stream. It only moves when it sits on a different display.
function reuseBubble() {
  const st = bubbleStyle(), b = W.bubble.getBounds(), [nw, nh] = bubbleWin(st), d = S.display.bounds, cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const here = cx >= d.x && cx <= d.x + d.width && cy >= d.y && cy <= d.y + d.height, home = bubbleHome(S.display, st.w, st.h);
  W.bubble.setBounds(here ? { x: b.x, y: b.y, width: nw, height: nh } : { x: home.x, y: home.y, width: nw, height: nh });
  send('bubble', 'bubble:style', st);
  if ((S.opts.camId || '') !== PB.camId) send('bubble', 'bubble:init', { camId: S.opts.camId || '', fake: !!S.opts.fakeCam });
}

// Closes every overlay and stops the feeds. Returns the cursor sampler's numbers.
// `keepBubble`: the start was cancelled and the launcher is coming back, so its camera preview stays up (with the style this session had).
function end({ keepBubble = false } = {}) {
  const cursor = stopCursor(); shortcuts.unregisterSession();
  for (const n of ['bubble', 'controls', 'countdown', 'outline', 'draw', 'ring', 'notes']) if (alive(W[n]) && !(keepBubble && n === 'bubble')) W[n].close();
  if (S) { clearTimeout(S.flushTimer); clearTimeout(S.bubbleTimer); if (keepBubble) Object.assign(PB, { size: S.bubble.size, shape: S.bubble.shape, filter: S.bubble.filter, frame: S.bubble.frame }); }
  S = null; win.releaseOverlay('session');
  return cursor;
}
function abort(o) { const s = S; if (!s) return; end(o); closeWriters(s).catch(() => {}); }

// The recorder hands over the finished recording: the timeline (the segment files are already on disk).
async function finish({ timeline, stats } = {}) {
  const s = S; if (!s) return null;
  flushEvents();
  const cursor = end();
  await closeWriters(s);
  const tl = { ...timeline, stats: { cursor, chunks: stats?.chunks, bytes: stats?.bytes } };
  writeTimeline(s.dir, tl);
  log('record:saved', { id: s.id, duration: tl.duration, segments: tl.segments.length, cursor, bytes: stats?.bytes });
  store.update(s.id, { status: C.LIBRARY_STATUS.PROCESSING, stage: 'Encoding video', duration: tl.duration, hasTrack: true });
  orchestrator.processVideo(s.id)
    .catch((e) => log('processVideo failed', e))
    .then(() => {
      if (!config.SELFTEST) return;
      console.log('SELFTEST_DONE', s.id, s.dir);
      if (events.listenerCount('processed')) events.emit('processed', { id: s.id, dir: s.dir, timeline: tl }); else app.quit();
    });
  if (!config.SELFTEST) shell.openExternal(config.ownerOrigin(`/v/${s.id}`));
  return s.id;
}

// Delete: the recorder has stopped its streams; this removes the half-made video and its files.
async function discard() {
  const s = S; if (!s) return;
  end(); await closeWriters(s); store.remove(s.id);
}

// control messages from the control bar, shortcuts and tests go straight to the recorder, which owns the state
const control = (a, arg) => send('recorder', 'rec:control', a, arg);
const recorderError = (msg) => log('recorder error', msg);
// The launcher went away. Unless that is because recording is starting, its camera preview goes with it.
function launcherHidden() { if (!S) { closeBubble(); if (alive(W.countdown)) W.countdown.close(); } }
const currentBubbleRect = () => (S && alive(W.bubble) ? bubbleRect() : null); // for tests

module.exports = {
  events, isActive, getS, listSources, start, end, finish, discard, control, toggleTool, bubbleAction, previewSet, launcherHidden, controlsLayout, countdownDone, countdownSkip, countdownPainted, cancelStart, openNotes, closeNotes, broadcastTools,
  chunk, segmentEnd, dropSegments, resetSegments, recorderError, bubbleRect: currentBubbleRect,
  tick: (t) => send('controls', 'rec:tick', t), paused: (p, t) => send('controls', 'rec:paused', p, t), mic: (on) => send('controls', 'rec:mic', on),
};
