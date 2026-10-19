const C = window.SPOOL, I = window.KairosIcons, $ = (id) => document.getElementById(id);
const cam = $('cam'), ring = $('ring'), v = $('v'), panel = $('panel'), hold = $('hold'), toast = $('toast'), MIN = C.BUBBLE_MIN, MAX = C.BUBBLE_MAX, G = window.KairosGestures;
I.fill(document);
// declared before apply() runs: a `let`/`const` used earlier throws and takes the whole script (and the camera) down with it
const fill = (n) => $('size').style.setProperty('--p', ((n - MIN) / (MAX - MIN)) * 100 + '%');
let sizing = false;
let st = { w: 260, h: 260, size: 260, shape: 'circle', filter: 'none', frame: 'ring' };
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
  try { v.srcObject = await navigator.mediaDevices.getUserMedia({ video: { deviceId: camId ? { exact: camId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); } catch (e) { console.error(e); camKey = null; }
});
// the size slider is continuous (MIN..MAX); each move is sent as it happens, so the bubble follows the thumb
$('size').onpointerdown = () => { sizing = true; };
addEventListener('pointerup', () => { sizing = false; });
$('size').oninput = (e) => { const n = +e.target.value; fill(n); if (n !== st.size) { st.size = n; spool.send('bubble:action', 'size', n); } };
document.querySelectorAll('#shapes button').forEach((b) => (b.onclick = () => spool.send('bubble:action', 'shape', b.dataset.v)));
$('power').onclick = () => spool.send('bubble:action', 'power');
$('styl').onclick = () => { $('main').hidden = true; $('style').hidden = false; };
$('back').onclick = () => { $('style').hidden = true; $('main').hidden = false; };
document.querySelectorAll('#style [data-a]').forEach((b) => (b.onclick = () => spool.send('bubble:action', b.dataset.a, b.dataset.v)));
spool.on('bubble:hover', (on) => document.body.classList.toggle('hover', !!on)); // main watches the cursor: the camera is a drag region, which gets no :hover

// ---------------- hand gestures (Phase 8) ----------------
// While a recording is live and the toggle is on, main tells this window to run (gesture:run). It looks at the camera preview it already has,
// about 8 times a second on a frame at most 320 px wide, and gestures.js decides when a sign has been held long enough. A fired sign goes to main
// (gesture:command), which sends the same pause / stop message the keyboard shortcuts send. Everything is bundled: no network at runtime.
const gs = { rec: null, loading: null, running: false, timer: null, state: G.initial(), canvas: null, ctx: null, frames: 0, sumMs: 0, maxMs: 0, loadMs: 0, error: '', statsT: 0 };
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
function holdRing(p) { hold.style.setProperty('--p', Math.round(p * 360) + 'deg'); hold.style.opacity = p > 0 ? '1' : '0'; }
let toastT;
function showToast(text) { toast.innerHTML = '<b></b>'; toast.firstChild.textContent = text; toast.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => toast.classList.remove('on'), 1600); }
function gTick() {
  if (!gs.running) return;
  const t0 = performance.now();
  try {
    const live = v.readyState >= 2 && v.videoWidth > 0, w = Math.min(G.CFG.maxFrame, live ? v.videoWidth : 320), h = live ? Math.round((w * v.videoHeight) / v.videoWidth) : Math.round((w * 9) / 16);
    if (gs.canvas.width !== w || gs.canvas.height !== h) { gs.canvas.width = w; gs.canvas.height = h; }
    if (live) gs.ctx.drawImage(v, 0, 0, w, h); // the raw frame, not the mirrored preview
    else { gs.ctx.fillStyle = '#556'; gs.ctx.fillRect(0, 0, w, h); } // self-test camera: no picture, the recognizer still does its full work
    const top = gs.rec.recognizeForVideo(gs.canvas, t0).gestures?.[0]?.[0];
    const out = G.step(gs.state, { t: t0, label: top?.categoryName, score: top?.score ?? 0 });
    gs.state = out.state; holdRing(out.progress);
    if (out.fire) spool.send('gesture:command', out.fire);
  } catch (e) { console.error('gesture tick failed: ' + (e && e.message || e)); gs.error = String(e && e.message || e); }
  const ms = performance.now() - t0; gs.frames++; gs.sumMs += ms; gs.maxMs = Math.max(gs.maxMs, ms);
  if (t0 - gs.statsT > 1000) { gs.statsT = t0; spool.send('gesture:stats', { frames: gs.frames, avgMs: +(gs.sumMs / gs.frames).toFixed(1), maxMs: +gs.maxMs.toFixed(1), loadMs: gs.loadMs, error: gs.error }); }
  gs.timer = setTimeout(gTick, Math.max(0, 1000 / G.CFG.hz - ms));
}
function gRun(on) {
  if (!on) { gs.running = false; clearTimeout(gs.timer); gs.state = G.initial(); holdRing(0); return; }
  if (gs.running) return;
  gs.running = true; gs.state = G.initial();
  gLoad().then(() => { if (gs.running && gs.rec) { clearTimeout(gs.timer); gs.timer = setTimeout(gTick, 0); } }); // a load that failed leaves gs.rec empty: gestures stay off
}
spool.on('gesture:load', gLoad);  // the recording is starting: read the model now, during the countdown, so the first second of capture is not spent on it
spool.on('gesture:run', gRun);
spool.on('gesture:toast', showToast);
