const C = window.SPOOL, I = window.KairosIcons, $ = (id) => document.getElementById(id);
const cam = $('cam'), ring = $('ring'), v = $('v'), panel = $('panel'), hold = $('hold'), toast = $('toast'), MIN = C.BUBBLE_MIN, MAX = C.BUBBLE_MAX, G = window.KairosGestures, Z = window.KairosZoom;
I.fill(document);
// declared before apply() runs: a `let`/`const` used earlier throws and takes the whole script (and the camera) down with it
const fill = (n) => $('size').style.setProperty('--p', ((n - MIN) / (MAX - MIN)) * 100 + '%');
let sizing = false;
let st = { w: 260, h: 260, size: 260, shape: 'circle', filter: 'none', frame: 'ring' };
let zm = Z.FULL; // the camera zoom shown now (see "camera zoom" below); declared here because apply() repaints it
const rawRatio = () => (v.videoWidth > 0 && v.videoHeight > 0 ? v.videoWidth / v.videoHeight : 16 / 9); // shape of the camera's own picture
function paintZoom() { v.style.transform = Z.css(zm, rawRatio(), st.w / st.h); document.body.classList.toggle('zoomed', Z.isZoomed(zm)); }
function apply(s) {
  st = { ...st, ...s };
  const r = Math.round(C.cornerRadius(st.shape) * Math.min(st.w, st.h)) + 'px';
  for (const el of [cam, ring]) Object.assign(el.style, { width: st.w + 'px', height: st.h + 'px', borderRadius: r });
  v.style.filter = C.FILTER_CSS[st.filter] || 'none';
  ring.style.cssText += ';border:' + (C.FRAME_CSS[st.frame] || 'none');
  panel.style.top = (10 + st.h + 10) + 'px'; // under the camera
  Object.assign(hold.style, { width: st.w + 8 + 'px', height: st.h + 8 + 'px', borderRadius: Math.round(C.cornerRadius(st.shape) * Math.min(st.w, st.h)) + 4 + 'px' }); // the gesture ring sits 4 px outside the camera
  Object.assign(toast.style, { width: st.w + 'px', top: 10 + st.h - 46 + 'px' }); // the gesture toast sits on the camera's lower edge
  $('bFilter').textContent = C.FILTER_LABELS[st.filter]; $('bFrame').textContent = C.FRAME_LABELS[st.frame];
  if (!sizing) { $('size').value = st.size; fill(st.size); } // while the slider is being dragged it is the source of truth, not the echo from main
  document.querySelectorAll('#shapes button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.shape));
  paintZoom();
}
apply({});
spool.on('bubble:style', apply);
// B27: this window outlives the launcher's preview and becomes the recording's bubble, so it opens the camera once and keeps it.
// A second bubble:init with the same camera does nothing; with another camera it swaps the stream.
let camKey = null;
spool.on('bubble:init', async ({ camId, fake }) => {
  const key = fake ? 'fake' : camId || 'default';
  if (key === camKey) return; camKey = key;
  v.srcObject?.getTracks().forEach((t) => t.stop()); v.srcObject = null;
  if (fake) { cam.style.background = 'linear-gradient(135deg, var(--key), var(--raised))'; return; } // self-test: no real camera, so no permission prompt
  // a camera that cannot be opened for a moment fails with NotReadable / Abort (busy: another app just let go of it) or Overconstrained / NotFound (the saved camera is not in
  // the system's list right now; the log showed one while an iPhone was also offering itself as a camera): try again twice before giving up. The reason goes to the log by name
  for (let attempt = 1; attempt <= 3 && camKey === key; attempt++) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: camId ? { exact: camId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (camKey !== key) { stream.getTracks().forEach((t) => t.stop()); return; } // another bubble:init replaced this one while the camera was opening
      v.srcObject = stream; return;
    } catch (e) {
      console.error(`camera failed (try ${attempt}): ${e && e.name}: ${e && e.message}`);
      if (!/NotReadable|Abort|Overconstrained|NotFound/.test(e && e.name)) break;
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  if (camKey === key) camKey = null; // not open: the next bubble:init tries again
});
// the size slider is continuous (MIN..MAX); each move is sent as it happens, so the bubble follows the thumb
$('size').onpointerdown = () => { sizing = true; document.body.classList.add('sizing'); };
addEventListener('pointerup', () => { sizing = false; document.body.classList.remove('sizing'); });
$('size').oninput = (e) => { const n = +e.target.value; fill(n); if (n !== st.size) { st.size = n; spool.send('bubble:action', 'size', n); } };
document.querySelectorAll('#shapes button').forEach((b) => (b.onclick = () => spool.send('bubble:action', 'shape', b.dataset.v)));
$('power').onclick = () => spool.send('bubble:action', 'power');
$('styl').onclick = () => { $('main').hidden = true; $('style').hidden = false; };
$('back').onclick = () => { $('style').hidden = true; $('main').hidden = false; };
document.querySelectorAll('#style [data-a]').forEach((b) => (b.onclick = () => spool.send('bubble:action', b.dataset.a, b.dataset.v)));
spool.on('bubble:hover', (on) => document.body.classList.toggle('hover', !!on)); // main watches the cursor: the camera is a drag region, which gets no :hover

// ---------------- hand signs (Phase 8) ----------------
// While a recording is live and the toggle is on, main tells this window to run (gesture:run). It looks at the camera preview it already has,
// about 8 times a second on a frame at most 320 px wide, and gestures.js decides which command the hand is asking for (pause, stop, zoom in) and when it
// has been held long enough. A fired pause / stop goes to main (gesture:command), which sends the same message the keyboard shortcuts send; zoom is done here.
// The person's own signs (taught in Settings, gesture:signs) replace the defaults. Everything is bundled: no network at runtime.
// The recognizer looks for one hand, and for two only while the picture is zoomed in (the zoom-out sign, an X of both index fingers, needs both, and two hands cost
// about 14 ms more per look). While the recording is paused no zoom sign does anything: nothing is being recorded, so a zoom made then could never be in the video.
const gs = { rec: null, loading: null, running: false, timer: null, state: G.initial(), canvas: null, ctx: null, frames: 0, sumMs: 0, maxMs: 0, loadMs: 0, error: '', statsT: 0, seen: {}, signs: {}, teach: null, numHands: 1, switching: false, paused: false };
const EMOJI = { pause: '✋', stop: '✊', zoom: '✌️', zoomout: '✕' }, VERB = { pause: 'pause', stop: 'stop', zoom: 'zoom in', zoomout: 'zoom out' };
const custom = (id) => !!(gs.signs[id] && gs.signs[id].ex);
const hintFor = (id) => (custom(id) ? '' : EMOJI[id] + ' ') + 'Hold to ' + VERB[id]; // what the pill says while a sign is being held
const ROOT = new URL('../../../', location.href).href; // the app folder (src/renderer/bubble/ is three levels down)
function gLoad() {
  if (gs.rec || gs.loading) return gs.loading;
  const t0 = performance.now(), models = ROOT + 'assets/models/';
  gs.loading = import(ROOT + 'node_modules/@mediapipe/tasks-vision/vision_bundle.mjs')
    .then(({ GestureRecognizer }) => GestureRecognizer.createFromOptions(
      { wasmLoaderPath: models + 'wasm/vision_wasm_internal.js', wasmBinaryPath: models + 'wasm/vision_wasm_internal.wasm' },
      { baseOptions: { modelAssetPath: models + 'gesture_recognizer.task' }, runningMode: 'VIDEO', numHands: 1 }))
    .then((r) => { gs.rec = r; gs.loadMs = Math.round(performance.now() - t0); gs.canvas = document.createElement('canvas'); gs.ctx = gs.canvas.getContext('2d', { willReadFrequently: false }); })
    .catch((e) => { gs.error = String(e && e.message || e); console.error('gesture recognizer failed to load: ' + gs.error); gs.loading = null; });
  return gs.loading;
}
function holdRing(p, stop) { hold.dataset.k = stop ? 'stop' : ''; hold.style.setProperty('--p', Math.round(p * 360) + 'deg'); hold.style.opacity = p > 0 ? '1' : '0'; }
// The pill under the camera does two jobs: a result ("Paused ✋", "Gestures on…") that stays for a moment, and a live hint while a sign is being held.
// A result on screen wins over the hint.
let toastT, toastUntil = 0, hinting = false;
function setToast(text) { toast.innerHTML = '<b></b>'; toast.firstChild.textContent = text; toast.classList.add('on'); }
function showToast(text, ms = 1600) { setToast(text); hinting = false; toastUntil = performance.now() + ms; clearTimeout(toastT); toastT = setTimeout(() => toast.classList.remove('on'), ms); }
function hideToast() { clearTimeout(toastT); toastUntil = 0; hinting = false; toast.classList.remove('on'); }
function showHint(text) {
  if (performance.now() < toastUntil) return;
  if (text) { if (!hinting || toast.textContent !== text) setToast(text); hinting = true; }
  else if (hinting) { toast.classList.remove('on'); hinting = false; }
}

// ---- camera zoom ----
// Zoom in: hold the zoom sign (crossed fingers) and the picture goes in slowly, towards the fingertips, for as long as the sign is held (the longer, the deeper), or drag
// over the part of the picture (the Zoom chip, then drag). Zoom out: hold the zoom-out sign (both index fingers crossed in an X) and it comes back out, faster; or the
// Exit zoom chip, which goes back at once. Only the face camera is zoomed, never the screen. The zoom is { cx, cy, z } in fractions
// of the RAW camera frame (zoom.js); main puts it in the timeline and the export applies it.
const sel = $('sel'), selbox = $('selbox'), ret = $('ret');
let selecting = false, drag = null;
function setZoom(next, by) {
  const n = Z.norm(next); if (Z.same(n, zm)) return;
  zm = n; paintZoom();
  if (by) spool.send('bubble:zoom', { zoom: n, by }); // not sent for the reset when a recording ends: nothing is recording then
}
function setSelecting(on) {
  if (selecting === on) return;
  selecting = on; drag = null; selbox.style.display = 'none';
  document.body.classList.toggle('selecting', on); $('zinL').textContent = on ? 'Cancel' : 'Zoom';
  if (on) showToast('Drag over the area to zoom into', 20000); else hideToast();
}
$('zin').onclick = () => { zrStop(false); setSelecting(!selecting); };
$('zout').onclick = () => { zrStop(false); setSelecting(false); setZoom(Z.FULL, 'exit'); showToast('Back to the whole picture', 1400); };
const inCam = (d, x, y) => ({ x: Math.min(1, Math.max(0, (x - d.r.left) / d.r.width)), y: Math.min(1, Math.max(0, (y - d.r.top) / d.r.height)) });
sel.onpointerdown = (e) => { sel.setPointerCapture?.(e.pointerId); drag = { r: cam.getBoundingClientRect(), x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY }; };
sel.onpointermove = (e) => {
  if (!drag) return;
  drag.x1 = e.clientX; drag.y1 = e.clientY;
  const a = inCam(drag, drag.x0, drag.y0), b = inCam(drag, drag.x1, drag.y1), w = drag.r.width, h = drag.r.height;
  Object.assign(selbox.style, { display: 'block', left: Math.min(a.x, b.x) * w + 'px', top: Math.min(a.y, b.y) * h + 'px', width: Math.abs(a.x - b.x) * w + 'px', height: Math.abs(a.y - b.y) * h + 'px' });
};
sel.onpointerup = () => {
  if (!drag) return;
  const d = drag, a = inCam(d, d.x0, d.y0), b = inCam(d, d.x1, d.y1); drag = null; selbox.style.display = 'none';
  // the picture is mirrored, so a point at x across the screen is at 1 - x in the video's own box
  const next = Z.fromRect({ x0: 1 - a.x, y0: a.y, x1: 1 - b.x, y1: b.y }, zm, rawRatio(), st.w / st.h);
  if (!next) { showToast('Drag over a bigger area to zoom into', 20000); return; } // stay in select mode
  setSelecting(false); setZoom(next, 'select'); showToast('Zoomed in · Exit zoom to go back', 2400);
};
sel.onpointercancel = () => { drag = null; selbox.style.display = 'none'; };
// The held sign. zr = the hold in progress (zoom.js rampInit / rampSample / rampFrame), or null. Frames come from the screen (smooth) and from every recognition
// (in case the window is not being painted). The timeline gets a keyframe every ZOOM.chunkS and one when the hold ends, each saying how long the move to it took.
let zr = null, zrMark = 0, zrEnd = 0, zrRaf = 0, zrShown = '', zrShownAt = 0, zrFrom = 1;
function zrKey(at) { // `at` = the last moment the picture was growing
  const d = (at - zrMark) / 1000; zrMark = at;
  if (d > 0.016) spool.send('bubble:zoom', { zoom: zm, by: 'hold', d: +d.toFixed(3) });
}
function zrFrame(now) {
  if (!zr) return;
  const r = Z.rampFrame(zr, now); zr = r.state;
  const n = r.zoom; if (!Z.same(n, zm)) { zm = n; paintZoom(); } // painted first: the frame that brings a zoom out back to the whole picture is also the one that ends it
  if (!r.active) { if (zr.dir < 0 && !Z.isZoomed(zm)) zrEnd = now; zrStop(true); return; } // (a zoom in that is no longer growing ended at its last frame, zrEnd)
  zrEnd = now;
  document.body.classList.add('holding'); // the picture is already moving evenly: no 450 ms glide on top of it
  if (now - zrMark >= Z.ZOOM.chunkS * 1000) zrKey(now);
  const label = zr.dir < 0 ? '🔍 ' + zm.z.toFixed(1) + '× · keep holding ✕ to zoom out'
    : zm.z >= Z.ZOOM.max - 0.005 ? '🔍 ' + Z.ZOOM.max + '× · deepest zoom' : '🔍 ' + zm.z.toFixed(1) + '× · keep holding to zoom more';
  if (label !== zrShown || now - zrShownAt > 500) { zrShown = label; zrShownAt = now; showToast(label, 900); }
  cancelAnimationFrame(zrRaf); zrRaf = requestAnimationFrame(zrFrame); // one chain of frames, however many recognitions call this
}
function zrStop(done) { // the sign is gone (done), or the hold is cancelled
  cancelAnimationFrame(zrRaf);
  if (!zr) return;
  const out = zr.dir < 0, moved = out ? zm.z < zrFrom - 0.005 : zm.z > zrFrom + 0.005;
  zr = null; zrShown = ''; document.body.classList.remove('holding');
  if (done) {
    zrKey(zrEnd);
    if (moved) showToast(out ? (Z.isZoomed(zm) ? zm.z.toFixed(1) + '× · hold ✕ again to zoom out more' : 'Back to the whole picture') : 'Zoomed ' + zm.z.toFixed(1) + '× · ✕ or Exit zoom to go back', 2400);
  }
}
// every recognition: good = the zoom sign has been held long enough to count and this sample shows it, at = the fingertips, dir = 1 for zoom in, -1 for zoom out
function zrSample(now, good, at, dir = 1) {
  if (good && zr && zr.dir !== dir) zrStop(true); // the other sign: this move ends where it is and the new one starts from there
  if (good && !zr) { zr = Z.rampInit(zm, dir); zrMark = zrEnd = now; zrFrom = zm.z; zrShown = ''; setSelecting(false); }
  if (!zr) return;
  zr = Z.rampSample(zr, { t: now, good: good && zr.dir === dir, at });
  zrFrame(now);
}
function reticle(at) { // a ring on the camera where the zoom sign points, while it is held (the preview is mirrored, so x is flipped)
  if (!at) { ret.classList.remove('on'); return; }
  const b = Z.toBox(at, zm, rawRatio(), st.w / st.h);
  ret.style.left = (1 - b.x) * 100 + '%'; ret.style.top = b.y * 100 + '%'; ret.classList.toggle('on', b.x >= 0 && b.x <= 1 && b.y >= 0 && b.y <= 1);
}
v.addEventListener('loadedmetadata', paintZoom); v.addEventListener('resize', paintZoom);

// ---- the loop ----
const PAUSED_HINT = 'Paused · nothing is recorded · hold ✋ to resume';
function commandTick(hands, t0) {
  // the X of both index fingers is only looked for while the picture is zoomed in (and unless a one-hand sign was taught for zoom out): that is when two hands are being looked for
  const x = hands.length > 1 && gs.numHands > 1 && !custom('zoomout') && Z.isZoomed(zm) ? G.crossXScore(hands, gs.canvas.width / gs.canvas.height) : 0;
  const pick = G.pick(hands, gs.signs, gs.state.label), hand = pick.hand;
  const c = x >= G.COMMANDS.zoomout.minScore ? { id: 'zoomout', score: x } : pick.c;
  const out = G.step(gs.state, { t: t0, label: c && c.id, score: c ? c.score : 0, at: c && c.at });
  const dir = out.seen === 'zoom' ? 1 : out.seen === 'zoomout' ? -1 : 0, moving = dir !== 0 && !gs.paused;
  gs.state = out.state; holdRing(out.progress, out.seen && G.COMMANDS[out.seen].control === 'stop'); reticle(out.seen === 'zoom' && moving ? out.at : null);
  // the zoom sign (or the zoom-out sign) is held long enough: the picture goes in (out). Never while paused, and no zooming out of a picture that is whole
  zrSample(t0, moving && !!c && c.id === out.seen && out.held >= G.COMMANDS[out.seen].holdMs && (dir > 0 || Z.isZoomed(zm)), out.at, dir || 1);
  showHint(!out.seen || zr ? '' : dir && gs.paused ? PAUSED_HINT : out.seen === 'zoomout' && !Z.isZoomed(zm) ? '' : hintFor(out.seen)); // while the picture is zooming, its own pill (zrFrame) says how far
  const k = hand && hand.label ? hand.label : 'nohand'; gs.seen[k] = (gs.seen[k] || 0) + 1; // what the recognizer saw, for the log
  if (c) gs.seen['→' + c.id] = (gs.seen['→' + c.id] || 0) + 1; // and which command that was taken for
  if (hand && hand.wl && G.crossedScore(hand.wl) > 0.25) gs.seen.nearZoom = (gs.seen.nearZoom || 0) + 1; // crossed fingers seen but not clearly enough: tells whether the zoom sign needs tuning
  if (hands.length > 1) { gs.seen.twoHands = (gs.seen.twoHands || 0) + 1; if (x > 0.25 && x < G.COMMANDS.zoomout.minScore) gs.seen.nearX = (gs.seen.nearX || 0) + 1; } // the same for the X
  if (gs.paused && dir) gs.seen.zoomWhilePaused = (gs.seen.zoomWhilePaused || 0) + 1; // a zoom sign shown while paused (it was ignored)
  if (out.fire) spool.send('gesture:command', out.fire); // zoom never fires: it is a hold (above)
}
// Teaching: the Settings page asks this window (gesture:teach) to learn one sign for one command. The hand is shown twice, held still for a second each time;
// only the 32 hand-shape numbers of the two takes (and a stick-figure sketch) go back to main, never the picture.
const TEACH_SAY = { show: (n) => `Show your ${n} sign to the camera`, hold: () => 'Hold it still…', lower: () => 'Good · now lower your hand', again: () => 'Show the same sign once more', done: () => 'Saved ✓' };
function teachEnd(res) {
  const cmd = gs.teach.cmd; gs.teach = null; holdRing(0); showHint(''); if (!gs.running) clearTimeout(gs.timer);
  spool.send('gesture:taught', { cmd, ...res });
  if (res.ok) showToast('Sign saved ✓', 1800);
}
function teachTick(hand, t0) {
  const T = gs.teach, name = G.NAMES[T.cmd].toLowerCase();
  const inside = !!(hand && hand.lm && hand.wl && G.handInside(hand.lm)), big = inside && G.handHeight(hand.lm) >= G.TEACH.minHand;
  const prev = T.state.phase, r = G.teach(T.state, { t: t0, f: big ? G.features(hand.wl) : null });
  T.state = r.state;
  if (r.fail) { teachEnd({ ok: false, reason: r.fail }); return; }
  if (r.done || (prev === 'first' && r.state.phase === 'away')) { // a take is complete: is it too like another command's sign?
    const other = G.conflict(T.cmd, hand.wl, gs.signs);
    if (other) { T.state = G.teachInitial(t0); holdRing(0); showToast(`Too close to your ${G.NAMES[other].toLowerCase()} sign · try a different one`, 3200); return; }
  }
  if (r.done) { teachEnd({ ok: true, ex: r.done, sk: G.sketch(hand.wl) }); return; }
  holdRing(r.progress, false);
  if (r.prompt === 'different') showToast('Not quite the same · start again', 2400);
  else {
    const seeing = camKey === 'fake' || (v.readyState >= 2 && v.videoWidth > 0);
    showHint(!seeing ? 'No camera picture' : hand && !inside ? 'Keep your whole hand in the picture' : hand && !big ? 'Bring your hand a bit closer' : TEACH_SAY[r.prompt] ? TEACH_SAY[r.prompt](name) : '');
  }
}
function gTick() {
  if (!gs.running && !gs.teach) return;
  const t0 = performance.now();
  try {
    // one hand, or two while the picture is zoomed in and the recording is running (see the top of this section); the switch takes a few ms, and this look waits for it
    const want = !gs.teach && !gs.paused && Z.isZoomed(zm) && !custom('zoomout') ? 2 : 1;
    if (gs.numHands !== want) {
      if (gs.switching) return;
      gs.switching = true; gs.numHands = want;
      let over = false;
      const done = () => { if (over) return; over = true; gs.switching = false; clearTimeout(gs.timer); if (gs.running || gs.teach) gs.timer = setTimeout(gTick, 0); };
      setTimeout(done, 1500); // a switch that never answers must not stop the looking for good
      Promise.resolve().then(() => gs.rec.setOptions({ numHands: want })).catch((e) => { console.error('hand count switch failed: ' + (e && e.message || e)); }).then(done);
      return;
    }
    const live = v.readyState >= 2 && v.videoWidth > 0, w = Math.min(G.CFG.maxFrame, live ? v.videoWidth : 320), h = live ? Math.round((w * v.videoHeight) / v.videoWidth) : Math.round((w * 9) / 16);
    if (gs.canvas.width !== w || gs.canvas.height !== h) { gs.canvas.width = w; gs.canvas.height = h; }
    if (live) gs.ctx.drawImage(v, 0, 0, w, h); // the raw frame, not the mirrored preview
    else { gs.ctx.fillStyle = '#556'; gs.ctx.fillRect(0, 0, w, h); } // self-test camera: no picture, the recognizer still does its full work
    const res = gs.rec.recognizeForVideo(gs.canvas, t0);
    const hands = (res.landmarks || []).map((lm, i) => { const top = res.gestures?.[i]?.[0]; return { label: top?.categoryName, score: top?.score ?? 0, lm, wl: res.worldLandmarks?.[i] }; });
    if (gs.teach) teachTick(hands[0] || null, t0); else commandTick(hands, t0);
  } catch (e) { console.error('gesture tick failed: ' + (e && e.message || e)); gs.error = String(e && e.message || e); }
  const ms = performance.now() - t0; gs.frames++; gs.sumMs += ms; gs.maxMs = Math.max(gs.maxMs, ms);
  if (t0 - gs.statsT > 1000) { gs.statsT = t0; spool.send('gesture:stats', { frames: gs.frames, avgMs: +(gs.sumMs / gs.frames).toFixed(1), maxMs: +gs.maxMs.toFixed(1), loadMs: gs.loadMs, error: gs.error, seen: gs.seen }); }
  gs.timer = setTimeout(gTick, Math.max(0, 1000 / G.CFG.hz - ms));
}
function gRun(on) {
  if (!on) { gs.running = false; if (!gs.teach) clearTimeout(gs.timer); gs.state = G.initial(); holdRing(0); showHint(''); reticle(null); zrStop(true); return; }
  if (gs.running) return;
  gs.running = true; gs.state = G.initial(); gs.frames = gs.sumMs = gs.maxMs = 0; gs.seen = {}; // numbers are per recording
  gLoad().then(() => {
    if (!gs.running) return;
    if (gs.rec) {
      const seeing = camKey === 'fake' || (v.readyState >= 2 && v.videoWidth > 0); // is there a camera picture to look at?
      const label = (id) => (custom(id) ? 'your ' : EMOJI[id] + ' ') + VERB[id];
      showToast(seeing ? `Gestures on · ${label('pause')} · ${label('stop')} · ${label('zoom')} · ${label('zoomout')}` : 'No camera picture · signs can’t see you', 4000); // the pill tells the user the feature is live, or why it cannot be
      clearTimeout(gs.timer); gs.timer = setTimeout(gTick, 0); // keep looking either way: a camera that is slow to open still works once it is up
    } else showToast('Gestures unavailable', 4000); // the load failed: nothing will happen, and the pill says so instead of leaving a silent camera
  });
}
function gTeach(a) {
  if (!a || !a.cmd) { if (gs.teach) { gs.teach = null; holdRing(0); hideToast(); if (!gs.running) clearTimeout(gs.timer); } return; } // cancelled from Settings
  gs.teach = { cmd: a.cmd, state: G.teachInitial(performance.now()) };
  showHint(TEACH_SAY.show(G.NAMES[a.cmd].toLowerCase()));
  gLoad().then(() => {
    if (!gs.teach) return;
    if (!gs.rec) { teachEnd({ ok: false, reason: 'unavailable' }); return; }
    clearTimeout(gs.timer); gs.timer = setTimeout(gTick, 0);
  });
}
spool.on('gesture:load', gLoad);  // the recording is starting: read the model now, during the countdown, so the first second of capture is not spent on it
spool.on('gesture:run', gRun);
spool.on('gesture:toast', showToast);
spool.on('gesture:signs', (s) => { gs.signs = s || {}; }); // the person's own signs
spool.on('gesture:teach', gTeach);
spool.on('bubble:live', (on) => { // a recording is running: the zoom chips are available. When it ends the picture goes back to the whole camera.
  document.body.classList.toggle('live', !!on);
  if (!on) { zrStop(false); setSelecting(false); setZoom(Z.FULL); reticle(null); gs.paused = false; }
});
spool.on('bubble:paused', (p) => { gs.paused = !!p; if (p) zrStop(true); }); // paused: a zoom in progress ends here (its last piece still counts: it was before the pause), and new zoom signs are ignored
