// Hidden renderer that owns every stream. It *composites* screen + camera bubble onto a canvas and records
// the canvas, so the face is baked into the video no matter which source (screen, window, area) is captured.
// Recording is segment-based: pause ends a segment, resume starts a new one, Live Rewind drops/trim segments.

const FILTERS = {
  none: 'none', warm: 'sepia(.25) saturate(1.25) hue-rotate(-8deg)', cool: 'saturate(1.1) hue-rotate(12deg) brightness(1.02)',
  bw: 'grayscale(1) contrast(1.1)', vivid: 'saturate(1.6) contrast(1.1)', soft: 'blur(.7px) brightness(1.06) saturate(.95)', film: 'sepia(.4) contrast(.92) brightness(1.04)',
};
const FRAMES = { none: null, ring: ['#ffffff'], purple: ['#7b5cf0'], mint: ['#22c08a'], gradient: ['#7b5cf0', '#22c08a'], glow: ['#34e0a1', 'glow'] };
const QUALITY_H = { '720p': 720, '1080p': 1080, '1440p': 1440, '4k': 2160 };

let o, screenV, camV, canvas, ctx, drawTimer, audioCtx, micGain, sources = [];
let crop = { x: 0, y: 0, w: 1, h: 1 };
let bubble = { rel: { x: 0.02, y: 0.7, w: 0.14, h: 0.25 }, shape: 'circle', filter: 'none', frame: 'ring', camOn: true };
let micOn = true;
let rec = null, cur = null, segs = [], base = 0, paused = false, tickTimer, finishing = false, cursorTrack = [], clicks = [], outSize = { W: 1280, H: 720 };
let ready = false;

const video = (stream) => { const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = stream; v.play().catch(() => {}); return v; };
const waitFor = (v) => new Promise((r) => (v.readyState >= 2 && v.videoWidth ? r() : v.addEventListener('loadeddata', r, { once: true })));

async function getScreen(cfg) {
  try { // getDisplayMedia lets the main process attach system-audio loopback
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30, width: { max: 3840 }, height: { max: 2160 } }, audio: !!cfg.systemAudio });
    return s;
  } catch (e) {
    console.warn('getDisplayMedia failed, falling back', e);
    return navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: cfg.sourceId, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 30 } } });
  }
}

// Test-only stand-in webcam (animated "face") so the compositor can be verified on machines without a camera.
function fakeCam() {
  const c = document.createElement('canvas'); c.width = 640; c.height = 480; const x = c.getContext('2d'); let t = 0;
  setInterval(() => { t += 0.1; x.fillStyle = '#3b2a7a'; x.fillRect(0, 0, 640, 480); x.fillStyle = '#f2c9a0'; x.beginPath(); x.ellipse(320, 250, 120, 150, 0, 0, 7); x.fill();
    x.fillStyle = '#222'; x.beginPath(); x.arc(280, 220, 14, 0, 7); x.arc(360, 220, 14, 0, 7); x.fill(); x.strokeStyle = '#a33'; x.lineWidth = 8; x.beginPath(); x.arc(320, 290 + Math.sin(t) * 6, 50, 0.15 * Math.PI, 0.85 * Math.PI); x.stroke(); }, 33);
  return c.captureStream(30);
}

async function prepare(cfg) {
  o = cfg; sources = []; segs = []; base = 0; paused = false; finishing = false; cursorTrack = []; clicks = []; ready = false;
  crop = cfg.crop || { x: 0, y: 0, w: 1, h: 1 };
  bubble = { ...bubble, ...cfg.bubble };
  micOn = cfg.micOn !== false;

  if (cfg.mode !== 'cam') {
    const s = await getScreen(cfg); sources.push(s); screenV = video(s); await waitFor(screenV);
  }
  if (cfg.mode !== 'screen') {
    const c = cfg.fakeCam ? fakeCam() : await navigator.mediaDevices.getUserMedia({ video: { deviceId: cfg.camId ? { exact: cfg.camId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    sources.push(c); camV = video(c); await waitFor(camV);
  } else camV = null;

  // audio graph: mic (with mute gain) + optional system audio -> one track
  audioCtx = new AudioContext(); const dest = audioCtx.createMediaStreamDestination();
  let hasAudio = false;
  if (cfg.micOn !== false) {
    try {
      const m = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: cfg.micId ? { exact: cfg.micId } : undefined, noiseSuppression: true, echoCancellation: true, autoGainControl: true }, video: false });
      sources.push(m); micGain = audioCtx.createGain(); audioCtx.createMediaStreamSource(m).connect(micGain).connect(dest); hasAudio = true;
    } catch (e) { console.warn('no mic', e); }
  }
  const sys = sources.flatMap((s) => s.getAudioTracks()).find((t) => t.kind === 'audio' && !t.label.toLowerCase().includes('mic'));
  const sysTracks = sources[0]?.getAudioTracks?.() || [];
  if (cfg.systemAudio && sysTracks.length) { audioCtx.createMediaStreamSource(new MediaStream(sysTracks)).connect(dest); hasAudio = true; }

  // canvas size
  let W, H;
  if (screenV) {
    const sw = screenV.videoWidth * crop.w, sh = screenV.videoHeight * crop.h;
    H = Math.min(QUALITY_H[cfg.quality] || 1080, Math.round(sh)); W = Math.round((H * sw) / sh);
  } else { H = Math.min(QUALITY_H[cfg.quality] || 1080, 1080); W = Math.round((H * 16) / 9); }
  W -= W % 2; H -= H % 2; outSize = { W, H };
  canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H; ctx = canvas.getContext('2d');
  clearInterval(drawTimer); drawFrame(); drawTimer = setInterval(drawFrame, 1000 / 30);

  const vtrack = canvas.captureStream(30).getVideoTracks()[0];
  window.__stream = new MediaStream([vtrack, ...(hasAudio ? dest.stream.getAudioTracks() : [])]);
  ready = true;
  return { W, H, hasSystemAudio: !!(cfg.systemAudio && sysTracks.length), screenSize: screenV ? [screenV.videoWidth, screenV.videoHeight] : null };
}

// ---------- drawing ----------
function shapePath(c, shape, x, y, w, h) {
  c.beginPath();
  if (shape === 'circle') c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else c.roundRect(x, y, w, h, shape === 'squircle' ? Math.min(w, h) * 0.32 : Math.min(w, h) * 0.1);
}
function coverDraw(c, v, x, y, w, h) {
  const vr = v.videoWidth / v.videoHeight, br = w / h; let sx = 0, sy = 0, sw = v.videoWidth, sh = v.videoHeight;
  if (vr > br) { sw = v.videoHeight * br; sx = (v.videoWidth - sw) / 2; } else { sh = v.videoWidth / br; sy = (v.videoHeight - sh) / 2; }
  c.drawImage(v, sx, sy, sw, sh, x, y, w, h);
}
function drawFrame() {
  if (!ctx) return; const { W, H } = outSize;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (screenV && screenV.videoWidth) {
    const vw = screenV.videoWidth, vh = screenV.videoHeight;
    ctx.drawImage(screenV, crop.x * vw, crop.y * vh, crop.w * vw, crop.h * vh, 0, 0, W, H);
  }
  if (!camV || !camV.videoWidth) return;
  if (o.mode === 'cam') { ctx.filter = FILTERS[bubble.filter] || 'none'; coverDraw(ctx, camV, 0, 0, W, H); ctx.filter = 'none'; return; }
  if (!bubble.camOn) return;
  let bx, by, bw, bh;
  if (o.windowSource) { bh = H * 0.28; bw = bubble.shape === 'portrait' ? bh * 0.65 : bubble.shape === 'landscape' ? bh * 1.45 : bh; bx = W * 0.02; by = H - bh - H * 0.03; }
  else {
    const r = bubble.rel;
    bw = (r.w / crop.w) * W; bh = (r.h / crop.h) * H; bx = ((r.x - crop.x) / crop.w) * W; by = ((r.y - crop.y) / crop.h) * H;
    bx = Math.min(Math.max(bx, 0), W - bw); by = Math.min(Math.max(by, 0), H - bh); // keep inside a custom area
  }
  ctx.save();
  if (bubble.frame === 'glow') { ctx.shadowColor = 'rgba(52,224,161,.9)'; ctx.shadowBlur = bw * 0.12; shapePath(ctx, bubble.shape, bx, by, bw, bh); ctx.fillStyle = '#000'; ctx.fill(); ctx.shadowBlur = 0; }
  else { ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = bw * 0.06; shapePath(ctx, bubble.shape, bx, by, bw, bh); ctx.fillStyle = '#000'; ctx.fill(); ctx.shadowBlur = 0; }
  shapePath(ctx, bubble.shape, bx, by, bw, bh); ctx.clip();
  ctx.filter = FILTERS[bubble.filter] || 'none'; coverDraw(ctx, camV, bx, by, bw, bh); ctx.filter = 'none';
  ctx.restore();
  const fr = FRAMES[bubble.frame];
  if (fr) {
    ctx.save(); const lw = Math.max(3, bw * 0.03); ctx.lineWidth = lw;
    const g = fr.length > 1 && fr[1] !== 'glow' ? (() => { const gg = ctx.createLinearGradient(bx, by, bx + bw, by + bh); gg.addColorStop(0, fr[0]); gg.addColorStop(1, fr[1]); return gg; })() : fr[0];
    ctx.strokeStyle = g; shapePath(ctx, bubble.shape, bx + lw / 2, by + lw / 2, bw - lw, bh - lw); ctx.stroke(); ctx.restore();
  }
}

// ---------- recording ----------
const elapsed = () => base + (cur && !paused ? (performance.now() - cur.started) / 1000 : 0);
const mime = () => ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
function startSegment() {
  const bps = Math.round(outSize.W * outSize.H * 30 * 0.11);
  const r = new MediaRecorder(window.__stream, { mimeType: mime(), videoBitsPerSecond: bps });
  const seg = { chunks: [], t0: base, started: performance.now(), done: null };
  seg.done = new Promise((res) => { r.onstop = () => { seg.dur = (performance.now() - seg.started) / 1000; seg.blob = new Blob(seg.chunks, { type: 'video/webm' }); res(seg); }; });
  r.ondataavailable = (e) => { if (e.data.size) seg.chunks.push(e.data); };
  r.start(1000); rec = r; cur = seg;
}
async function endSegment() {
  if (!rec || rec.state === 'inactive') return;
  rec.stop(); const seg = await cur.done; base += seg.dur; segs.push(seg); rec = null; cur = null; return seg;
}
function begin() {
  startSegment(); tickTimer = setInterval(() => spool.send('rec:tick', elapsed()), 200);
}
function cleanup() {
  clearInterval(tickTimer); clearInterval(drawTimer); ready = false;
  sources.forEach((s) => s.getTracks().forEach((t) => t.stop())); sources = [];
  audioCtx?.close().catch(() => {}); audioCtx = null; ctx = null; window.__stream = null; screenV = camV = null;
}
async function pause() { if (paused || !cur) return; await endSegment(); paused = true; spool.send('rec:paused', true, base); }
function resume() { if (!paused) return; paused = false; startSegment(); spool.send('rec:paused', false, base); }
// Live Rewind: keep only the first `t` seconds of what has been recorded (call while paused), then continue from there.
function rewind(t) {
  t = Math.max(0, Math.min(t, base));
  segs = segs.filter((s) => s.t0 < t - 0.05); const last = segs[segs.length - 1];
  if (last) last.dur = Math.min(last.dur, t - last.t0);
  base = t; cursorTrack = cursorTrack.filter((p) => p[0] <= t); clicks = clicks.filter((c) => c.t <= t);
  spool.send('rec:tick', t); resume();
}
async function stop() {
  if (finishing) return; finishing = true;
  if (!paused) await endSegment();
  const out = []; for (const s of segs) out.push({ buffer: await s.blob.arrayBuffer(), dur: s.dur, t0: s.t0 });
  const duration = segs.reduce((a, s) => a + s.dur, 0);
  const payload = { segments: out, duration, mode: o.mode, size: outSize, cursor: cursorTrack, clicks, hasAudio: !!window.__stream?.getAudioTracks().length };
  cleanup(); await spool.invoke('rec:finish', payload);
}
function discard() { finishing = true; try { rec?.stop(); } catch {} cleanup(); spool.send('rec:discard'); }
async function restart() { try { if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); } } catch {} rec = cur = null; segs = []; base = 0; paused = false; cursorTrack = []; clicks = []; startSegment(); }

window.__prepare = prepare;
window.__begin = begin;
spool.on('rec:control', (a, arg) => {
  if (a === 'pause') pause(); else if (a === 'resume') resume(); else if (a === 'stop') stop(); else if (a === 'delete') discard();
  else if (a === 'restart') restart(); else if (a === 'rewind') rewind(arg);
  else if (a === 'mic') { micOn = !micOn; if (micGain) micGain.gain.value = micOn ? 1 : 0; spool.send('rec:mic', micOn); }
});
spool.on('rec:bubble', (b) => { bubble = { ...bubble, ...b, rel: { ...bubble.rel, ...(b.rel || {}) } }; });
spool.on('cur:pos', (p) => { if (cur && !paused) cursorTrack.push([+elapsed().toFixed(2), p.x, p.y]); });
spool.on('cur:click', (c) => { if (cur && !paused) clicks.push({ t: +elapsed().toFixed(2), x: c.x, y: c.y, button: c.button }); });
spool.on('rec:note', (n) => { if (cur && !paused) clicks.push({ t: +elapsed().toFixed(2), note: n }); });
