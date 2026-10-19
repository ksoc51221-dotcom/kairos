// Headless self-test runner. Loaded only when SPOOL_SELFTEST is set (B24), never part of normal startup.
//   SPOOL_SELFTEST='{"mode":"screen-cam","seconds":10,"script":[[3000,"pause"],[4000,"resume"]]}' electron .
//   SPOOL_SELFTEST='{"snapshots":"/some/dir"}' electron .      renders each UI window off-screen to PNGs (no screen capture involved)
// Recording scenarios capture the real screen, so they stay short and tests/e2e/run.js deletes the output afterwards. Scenario keys:
//   mode, seconds, script [[ms, action, arg]], quality, cursorFx, clickFx, patch (noise window: steady frames + demanding content),
//   guards (flat green windows placed under the bubble, control bar and ring, to prove they are not in the capture),
//   windowSource:'patch' (records the noise window itself as a window source: no screen content involved),
//   ui:{prefs} (starts through the real launcher: sets these preferences, opens it and clicks Start Recording).
// Results are printed as one line:  SELFTEST_RESULT {json}  which tests/e2e/run.js turns into measurements.
const { app, BrowserWindow, desktopCapturer, nativeImage, screen } = require('electron');
const store = require('../store');
const path = require('path');
const fs = require('fs');
const C = require('../shared/constants');
const session = require('./session');
const win = require('./windows');
const { W } = win;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSnapshots(outDir, t) {
  fs.mkdirSync(outDir, { recursive: true });
  const save = async (name, w, settle = 700) => { await wait(settle); const img = await w.webContents.capturePage(); fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG()); };
  const click = (w, sel) => w.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(sel)}).click()`);
  win.showLauncher(); await wait(1500); await save('launcher', W.launcher);
  await click(W.launcher, '#more'); await save('launcher-more', W.launcher, 600);
  await click(W.launcher, '.mrow:nth-child(2)'); await save('launcher-effects', W.launcher, 600);
  await click(W.launcher, '.ph button'); await click(W.launcher, '.mrow:nth-child(3)'); await save('launcher-settings', W.launcher, 600);
  await click(W.launcher, '#camCaret'); await save('launcher-camera-menu', W.launcher, 600);
  W.launcher.close();
  let w = win.load('bubble', 'bubble/index.html', { width: 246, height: 390, show: true, x: 40, y: 60 });
  await wait(600); w.webContents.send('bubble:init', { fake: true }); w.webContents.send('bubble:style', { w: 200, h: 240, shape: 'portrait', filter: 'warm', frame: 'gradient' }); await save('bubble', w); w.close();
  w = win.load('controls', 'controls/index.html', { width: 324, height: 470, show: true, x: 40, y: 40 });
  await wait(500); w.webContents.send('rec:tick', 83.4); w.webContents.send('tool:state', { pen: true, cursor: true, notes: false, cam: true, hasCam: true }); await save('controls-pen', w, 800);
  w.webContents.send('rec:paused', true, 83.4); w.webContents.send('tool:state', { pen: false, cursor: true, notes: false, cam: false, hasCam: true }); w.webContents.send('rec:mic', false);
  await wait(300); await click(w, '#rewind'); await save('controls-paused-rewind', w, 800); w.close();
  w = win.load('countdown', 'countdown/index.html', { width: 600, height: 420, show: true, x: 40, y: 40 });
  await save('countdown', w, 450); w.close();
  w = win.load('notes', 'notes/index.html', { width: 440, height: 340, show: true, x: 40, y: 600 });
  await wait(500); w.webContents.send('notes:mode', { mode: 'prompt', text: 'Welcome everyone. Today I will walk you through the new billing dashboard.\n\nFirst, open Settings.' }); await save('notes', w); w.close();
  if (t.image) {
    w = win.load('annotate', 'annotate/index.html', { frame: true, transparent: false, show: true, width: 1000, height: 640, x: 100, y: 100 });
    await wait(500); w.webContents.send('annotate:init', { image: nativeImage.createFromPath(t.image).toDataURL() }); await save('annotate', w); w.close();
  }
  console.log('SNAPSHOTS_DONE'); app.quit();
}

// ---- helper windows for recording scenarios (ordinary, capturable windows, one level below the content-protected overlays) ----
const NOISE_HTML = `<!doctype html><body style="margin:0;background:#000;overflow:hidden"><canvas id="c" style="display:block;width:100vw;height:100vh"></canvas><script>
const c = document.getElementById('c'); c.width = Math.round(innerWidth * devicePixelRatio); c.height = Math.round(innerHeight * devicePixelRatio);
const x = c.getContext('2d'), img = x.createImageData(c.width, c.height), d = new Uint32Array(img.data.buffer); let s = 0x9e3779b9 | 0;
(function frame() { for (let i = 0; i < d.length; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; d[i] = s | 0xff000000; } x.putImageData(img, 0, 0); requestAnimationFrame(frame); })();
</script>`;
// A window of ordinary text with a fake e-mail address and a fake API key in it, for the Privacy Guard scenario. Both are obvious fixtures.
const SECRETS_HTML = `<!doctype html><body style="margin:0;background:#fff;color:#111;font:600 30px Menlo,monospace;padding:28px 34px;line-height:64px;overflow:hidden">
<div>Quarterly planning notes</div><div>Send questions to <span data-secret="email">jane.doe@example.com</span></div>
<div>Deploy key: <span data-secret="key">sk-live-9f8e7d6c5b4a3210abcd</span></div><div>Next review on Friday afternoon</div></body>`;
const GREEN = '#00ff00'; // test fixtures: the guard colour must be exact, these are not product UI colours

// `normal: true` keeps the window at the normal level: Chromium only lists layer-0 windows as capture sources, so a floating helper cannot be recorded as a window.
function helperWindow(rect, { html, color, normal }) {
  const w = new BrowserWindow({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.w), height: Math.round(rect.h), show: false, frame: false, resizable: false, hasShadow: false,
    transparent: false, backgroundColor: color || '#000000', focusable: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false } });
  if (!normal) w.setAlwaysOnTop(true, 'floating');
  w.setVisibleOnAllWorkspaces(true, { visibleInFullScreen: true, skipTransformProcessType: true });
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html || `<body style="margin:0;background:${color}">`));
  w.once('ready-to-show', () => w.showInactive());
  return w;
}

// Starts a recording the way a user does: through the launcher window, with the given preferences.
async function startViaLauncher(t) {
  store.setSettings({ prefs: { v: 2, source: 'screen', camOn: false, micOn: false, cursorFx: false, ...(t.ui.quality ? { quality: t.ui.quality } : {}), ...(t.ui.prefs || {}) } }); // the quality is chosen in the bar's Recording settings; seeding it is the same preference
  win.showLauncher(); await wait(1800);
  await W.launcher.webContents.executeJavaScript(`document.getElementById('start').click()`);
  for (let i = 0; i < 300 && !session.getS()?.live; i++) await wait(100);
  return !!session.getS()?.live;
}

async function runRecording(t) {
  process.env.SPOOL_KEEP_RAW = '1'; // the tests measure the raw tracks, which are normally deleted once the composite exists
  const helpers = [], closeHelpers = () => { for (const h of helpers) if (!h.isDestroyed()) h.close(); helpers.length = 0; };
  const watchdog = setTimeout(() => { console.log('SELFTEST_TIMEOUT'); app.exit(2); }, ((t.seconds || 5) + (t.fullAI ? 240 : 90)) * 1000);
  const screens = t.mode === 'cam' ? [] : await desktopCapturer.getSources({ types: ['screen'] });
  const display = t.mode === 'cam' ? screen.getPrimaryDisplay() : win.displayFor(screens[0]?.id), wa = display.workArea, b = display.bounds;
  const rel = (r) => ({ x: r.x - b.x, y: r.y - b.y, w: r.w, h: r.h });

  const needsScreen = t.mode !== 'cam';
  if (needsScreen && (t.patch || t.guards)) { win.holdOverlay('selftest'); await wait(400); } // an accessory app, so these windows show over full-screen Spaces too (B25)
  const patchRect = { x: wa.x + 40, y: wa.y + 60, w: t.patch?.w || 480, h: t.patch?.h || 270 };
  const patchWin = needsScreen && t.patch ? helperWindow(patchRect, { html: NOISE_HTML, normal: t.windowSource === 'patch' }) : null;
  if (patchWin) helpers.push(patchWin);
  if (patchWin && t.windowSource === 'patch') await wait(600);
  let secretRects = [];
  if (needsScreen && t.secrets) {
    const sr = { x: wa.x + 40, y: wa.y + 360, w: 900, h: 300 };
    const sw = helperWindow(sr, { html: SECRETS_HTML }); helpers.push(sw); await wait(900);
    const dom = await sw.webContents.executeJavaScript(`[...document.querySelectorAll('[data-secret]')].map((e) => { const r = e.getBoundingClientRect(); return { name: e.dataset.secret, x: r.x, y: r.y, w: r.width, h: r.height }; })`);
    secretRects = dom.map((d) => ({ name: d.name, rect: rel({ x: sr.x + d.x, y: sr.y + d.y, w: d.w, h: d.h }) }));
  }
  const sourceId = t.windowSource === 'patch' && patchWin ? patchWin.getMediaSourceId() : screens[0]?.id;
  // a known spot for the presenter ring. Another app's window on top of that spot makes the guard test fail for reasons that are not ours,
  // so the spot can be moved: SPOOL_E2E_RING=0.25,0.6 (fractions of the work area)
  const ringFrac = (process.env.SPOOL_E2E_RING || '0.62,0.3').split(',').map(Number);
  if (needsScreen && t.guards) t.ringAt = { x: wa.x + Math.round(wa.width * ringFrac[0]), y: wa.y + Math.round(wa.height * ringFrac[1]) };

  // Flat green windows go exactly where the bubble, control bar and ring are, before capture begins. Those three are content-protected, so the
  // capture must show the green underneath; if one of them leaked into the track, its region would not be green.
  const guards = [], RING = 110; // RING must match the ring window size in session.js
  const placeGuards = async () => {
    if (!(needsScreen && t.guards)) return;
    const c = W.controls?.getBounds(), br = session.bubbleRect();
    const rects = { controls: c && { x: c.x, y: c.y, w: c.width, h: c.height }, bubble: br, ring: { x: t.ringAt.x - RING / 2, y: t.ringAt.y - RING / 2, w: RING, h: RING } };
    for (const [name, r] of Object.entries(rects)) if (r) { guards.push({ name, rect: rel(r) }); helpers.push(helperWindow(r, { color: GREEN })); }
    await wait(600); // let them paint before capture starts
  };
  const boundsOf = (w) => { const r = w.getBounds(); return rel({ x: r.x, y: r.y, w: r.width, h: r.height }); };
  const overlayState = () => Object.fromEntries(['controls', 'bubble', 'ring'].map((n) => [n, win.alive(W[n]) ? { visible: W[n].isVisible(), bounds: boundsOf(W[n]) } : null]));

  const ok = t.ui ? await startViaLauncher(t) : await session.start({ mode: 'screen-cam', sourceId, camId: '', micId: '', micOn: true, quality: C.DEFAULT_QUALITY, cursorFx: true, clickFx: false, systemAudio: !!t.systemAudio,
    fakeCam: true, fakeMic: true, ...t, windowSource: t.windowSource === 'patch', bubble: t.bubble || {}, beforeBegin: placeGuards });
  const S = session.getS();
  console.log('SELFTEST started:', ok, JSON.stringify(S?.info));
  if (!ok) { console.log('SELFTEST_FAIL start'); closeHelpers(); app.exit(1); return; }

  for (const [ms, a, arg] of t.script || []) setTimeout(() => { if (['pen', 'cursor', 'notes', 'cam'].includes(a)) session.toggleTool(a, arg); else session.control(a, arg); }, ms);
  let overlays = null;
  setTimeout(() => {
    overlays = overlayState(); // what was on screen at the end of capture
    session.control('stop');
    const poll = setInterval(() => { if (!session.isActive()) { clearInterval(poll); closeHelpers(); win.releaseOverlay('selftest'); } }, 100); // give the screen back as soon as capture ends
  }, (t.seconds || 5) * 1000);

  session.events.once('processed', ({ id, dir, timeline }) => {
    clearTimeout(watchdog);
    console.log('SELFTEST_RESULT ' + JSON.stringify({ id, dir, display: { x: b.x, y: b.y, width: b.width, height: b.height, scaleFactor: display.scaleFactor }, guards, overlays, patch: t.patch ? rel(patchRect) : null,
      secrets: secretRects, ringAt: t.ringAt ? { x: t.ringAt.x - b.x, y: t.ringAt.y - b.y } : null, timeline: { duration: timeline.duration, segments: timeline.segments, stats: timeline.stats, cursorSamples: timeline.cursor.length, clicks: timeline.clicks.length,
        bubbleKeyframes: timeline.bubble.length, bubble: timeline.bubble, drawing: timeline.drawing, mode: timeline.mode, quality: timeline.quality, bubbleSpace: timeline.bubbleSpace, screen: timeline.screen, cam: timeline.cam, audio: timeline.audio, mime: timeline.mime } }));
    setTimeout(() => app.quit(), 300);
  });
}

// ---- B26 / B27: countdown and camera preview, driven through the real launcher (no screen content is read) ----
//   {"preview":true,"fakeCam":true,"countdown":true}   launcher open -> preview bubble -> toggles -> hide -> Start -> same window reused -> discard
//   {"cancel":true,"fakeCam":true,"countdown":true}    launcher -> Start -> click the countdown's cancel -> nothing left behind
const fs_ = fs;
const windowsNow = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => ({ id: w.id, title: w.getTitle(), visible: w.isVisible() }));
const named = (n) => windowsNow().filter((w) => w.title === n);
const until = async (fn, ms = 4000, step = 25) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await wait(step); } return null; };
const inLauncher = (js) => W.launcher.webContents.executeJavaScript(js);
const clickStart = () => inLauncher('document.getElementById("start").click()');
const BUBBLE = 'Iris camera', COUNTDOWN = 'Iris countdown';
const videoCount = () => store.list().length;
const dirsOnDisk = () => { try { return fs_.readdirSync(path.join(store.videoDir('x'), '..')).filter((n) => n !== 'x').length; } catch { return 0; } };

async function seedLauncher(camOn) {
  store.setSettings({ prefs: { v: 2, source: 'screen', camOn, micOn: false, cursorFx: false } });
  win.showLauncher(); await wait(1500);
}

async function runPreview(t) {
  const r = { checks: {} }, ok = (k, v, detail) => { r.checks[k] = { ok: !!v, detail }; };
  const before = videoCount();
  await seedLauncher(true);
  const shownMs = await until(() => named(BUBBLE).some((w) => w.visible), 5000);
  const id1 = named(BUBBLE)[0]?.id;
  ok('bubble preview appears while the launcher is open in Screen + Cam', shownMs != null && named(BUBBLE).length === 1, `${shownMs} ms after the launcher was shown`);
  const b1 = W.bubble?.getBounds();
  ok('preview is at its default or saved position, on a display', !!b1 && screen.getAllDisplays().some((d) => b1.x >= d.bounds.x - 5 && b1.x < d.bounds.x + d.bounds.width), JSON.stringify(b1));

  await inLauncher('document.getElementById("camBtn").click()'); // the camera button on the bar
  const goneOff = await until(() => named(BUBBLE).length === 0, 3000);
  ok('camera turned off on the bar: preview closes', goneOff != null, `${goneOff} ms`);
  await inLauncher('document.getElementById("camBtn").click()');
  const backOn = await until(() => named(BUBBLE).length === 1, 3000);
  ok('camera turned on again: preview returns', backOn != null, `${backOn} ms`);
  const bw = W.bubble.getBounds(); await wait(400);
  session.bubbleAction('shape', 'portrait'); await wait(500);
  ok('bubble panel: picking a shape resizes the window and keeps the camera on', named(BUBBLE).length === 1 && W.bubble.getBounds().height >= bw.height, `${bw.height} -> ${W.bubble.getBounds().height} px high`);
  session.bubbleAction('power'); // the power icon in the bubble's hover panel
  const goneByPanel = await until(() => named(BUBBLE).length === 0, 3000);
  ok('bubble panel: the power icon turns the camera off (preview closes, bar follows)', goneByPanel != null, `${goneByPanel} ms`);
  await inLauncher('document.getElementById("camBtn").click()');
  const backOn2 = await until(() => named(BUBBLE).length === 1, 3000);
  ok('camera turned on again after the power icon', backOn2 != null, `${backOn2} ms`);

  win.hideLauncher();
  const goneHide = await until(() => named(BUBBLE).length === 0, 3000);
  ok('launcher closed without recording: preview closes', goneHide != null, `${goneHide} ms`);
  win.showLauncher();
  await until(() => named(BUBBLE).some((w) => w.visible), 5000);
  const id2 = named(BUBBLE)[0]?.id;
  ok('launcher shown again: preview returns', !!id2);

  const startAt = performance.now(); await clickStart();
  const cdMs = await until(() => named(COUNTDOWN).some((w) => w.visible), 4000, 10);
  ok('Start: countdown visible', cdMs != null, `${cdMs} ms (polled) after the click`);
  await wait(600); session.countdownSkip();
  const live = await until(() => session.getS()?.live, 8000);
  ok('recording went live after skip', live != null);
  ok('the same bubble window is used for the recording (not closed and recreated)', named(BUBBLE).length === 1 && named(BUBBLE)[0].id === id2, `window ${id2} before, ${named(BUBBLE).map((w) => w.id)} during`);
  ok('control bar is up and the countdown window is gone', win.alive(W.controls) && !win.alive(W.countdown));
  const m = session.getS()?.metrics || {};
  ok('B26: the countdown is painted < 150 ms after the click on Start', m.sinceClickMs != null && m.sinceClickMs < 150, `${m.sinceClickMs} ms since the click`);
  r.metrics = m; r.elapsedToLiveMs = Math.round(performance.now() - startAt);
  session.control('delete'); await until(() => !session.isActive(), 5000); await wait(500);
  ok('after discard: no bubble, no controls, nothing recorded', named(BUBBLE).length === 0 && !win.alive(W.controls) && videoCount() === before, `${videoCount() - before} new videos`);
  void id1; console.log('SELFTEST_PREVIEW ' + JSON.stringify(r)); app.quit();
}

async function runCancel(t) {
  const r = { checks: {} }, ok = (k, v, detail) => { r.checks[k] = { ok: !!v, detail }; };
  const before = videoCount(), dirsBefore = dirsOnDisk(), cam = t.camOn !== false; // camOn:false = Screen only: the latency run (no camera prompt, no preview bubble)
  await seedLauncher(cam);
  if (cam) await until(() => named(BUBBLE).some((w) => w.visible), 5000);
  await clickStart();
  const cd = await until(() => named(COUNTDOWN).some((w) => w.visible), 4000, 10);
  ok('countdown visible after Start', cd != null, `${cd} ms (polled)`);
  await wait(150); const m = { ...(session.getS()?.metrics || {}) }; r.metrics = m;
  ok('B26: the countdown is painted < 150 ms after the click on Start', m.sinceClickMs != null && m.sinceClickMs < 150, `${m.sinceClickMs} ms since the click (${m.countdownPaintedMs} ms since start() was entered, window shown at ${m.countdownShownMs} ms)`);
  const midRecord = videoCount() - before;
  await wait(700);
  await W.countdown.webContents.executeJavaScript('document.getElementById("cancel").click()');
  const settled = await until(() => !session.isActive() && named(COUNTDOWN).length === 0, 6000);
  ok('cancel: the session ends and the countdown closes', settled != null, `${settled} ms after the click`);
  await wait(800);
  const stray = ['controls', 'outline', 'ring', 'draw', 'countdown', 'notes'].filter((n) => win.alive(W[n]) && (n !== 'countdown' || W[n].isVisible())) // the launcher has prepared the next countdown window, hidden;
  ok('cancel: no control bar, outline, ring, pen or countdown left', stray.length === 0, stray.join(', ') || 'none');
  ok('cancel: the empty record and its folder are gone', videoCount() === before && dirsOnDisk() === dirsBefore, `records ${videoCount() - before} (was ${midRecord} while counting), folders ${dirsOnDisk() - dirsBefore}`);
  const live = await W.recorder.webContents.executeJavaScript('window.__live()');
  ok('cancel: the recorder released its screen and camera streams', live === false, `streams open: ${live}`);
  ok('cancel: the launcher is back and usable', W.launcher.isVisible() && (await inLauncher('!document.getElementById("start").classList.contains("busy") && !document.getElementById("start").disabled')), 'visible, Start enabled');
  ok(cam ? 'cancel: the camera preview is back with the launcher' : 'cancel: no camera preview in Screen only mode', named(BUBBLE).length === (cam ? 1 : 0));
  console.log('SELFTEST_CANCEL ' + JSON.stringify(r)); app.quit();
}

async function run(t) {
  if (t.preview) return runPreview(t);
  if (t.cancel) return runCancel(t);
  if (t.snapshots) return runSnapshots(t.snapshots, t);
  return runRecording(t);
}

module.exports = { run };
