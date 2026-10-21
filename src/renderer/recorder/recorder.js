// Hidden renderer that owns every stream and the recording clock.
// Nothing is composited here any more: the screen is recorded exactly as the OS draws it (native size, 60 fps, OS cursor), the camera is
// its own file, and shape / position / styling are applied once at export from timeline.json. Quality never depends on a redraw loop.
//   segment   pause ends a segment, resume starts a new one, Live Rewind trims or drops segments. Screen and camera recorders start
//             and stop together, so a segment is the pair screen_N + cam_N.
//   chunks    every dataavailable chunk goes to the main process as it arrives (B3), so memory stays flat however long the recording is.
//   audio     mic and system audio are mixed into the screen recorder's stream (the camera recorder in camera-only mode). A third recorder, audio only, keeps
//             the same mix as its own file (audio_N): the voice must not depend on the screen, which writes nothing for a stretch where nothing changes.
const C = window.SPOOL;
const { Timeline } = window.KairosTimeline;
const epochNow = () => performance.timeOrigin + performance.now();
const TIMESLICE_MS = 1000;
const STILL_MIN_S = 0.25; // a screen-less segment shorter than this is not worth a screenshot
const WARMUP_MS = 400;
const FRAME_ASPECT = { circle: 1, squircle: 1, portrait: 0.65, landscape: 1.45 }; // window recordings: bubble width / height

let cfg = null, tl = null, fmt = null;
let screenStream = null, camStream = null, screenTrack = null, recScreenStream = null, recCamStream = null, recAudioStream = null;
let audioCtx = null, micGain = null, micOn = true, hasAudio = false;
const streamsToStop = [];            // extra streams (the microphone) released at the end
let live = null;                     // the running segment { n, screen: Rec | null, cam: Rec | null, audio: Rec | null }
let paused = false, finishing = false, tickTimer = null, fakeTimer = null;
let bubbleNow = null;                // latest bubble state from the main process, in the units it sends
let zoomNow = null;                  // latest camera zoom { cx, cy, z } from the bubble, null until the person zooms
let frame = null;                    // the size of the screen frames, measured from a real frame (see frameSize)
const files = {};                    // segment number -> { screen, cam } file names that really hold data
const stats = { chunks: 0, bytes: 0 };
let op = Promise.resolve();          // pause / resume / rewind / restart / stop run one at a time

const run = (fn) => (op = op.then(fn).catch((e) => { console.error('recorder:', e); spool.send('rec:error', String(e && e.message || e)); }));
// The size of the frames a track really delivers. track.getSettings() is not enough: for a window capture it reports the size that was asked for
// (7680x4320), and for a screen it only matches because the ask was the display's own size.
async function frameSize(track) {
  const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = new MediaStream([track]); v.play().catch(() => {});
  await Promise.race([new Promise((r) => v.addEventListener('loadeddata', r, { once: true })), new Promise((r) => setTimeout(r, 4000))]);
  const size = { width: v.videoWidth, height: v.videoHeight };
  v.pause(); v.srcObject = null;
  return size.width && size.height ? size : null;
}
const pickFormat = () => C.MIME_PREFERENCE.find((f) => MediaRecorder.isTypeSupported(f.mime)) || { mime: '', ext: 'webm' };

// One MediaRecorder for one segment. Chunks are sent in order; done() resolves once the main process has the last byte on disk.
class Rec {
  constructor(kind, n, stream, bps) {
    this.kind = kind; this.n = n; this.chain = Promise.resolve();
    const opts = kind === 'audio' ? { mimeType: C.AUDIO_ONLY_MIME, audioBitsPerSecond: C.AUDIO_BITRATE } : { videoBitsPerSecond: bps };
    if (kind !== 'audio' && fmt.mime) opts.mimeType = fmt.mime;
    if (kind !== 'audio' && stream.getAudioTracks().length) opts.audioBitsPerSecond = C.AUDIO_BITRATE;
    this.rec = new MediaRecorder(stream, opts);
    this.stopped = new Promise((res) => { this.rec.onstop = res; });
    this.rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      this.chain = this.chain.then(async () => { const buf = await e.data.arrayBuffer(); stats.chunks++; stats.bytes += buf.byteLength; spool.send('rec:chunk', kind, n, buf); });
    };
    this.rec.start(TIMESLICE_MS);
  }
  stop() { if (this.rec.state !== 'inactive') this.rec.stop(); }
  async done() { await this.stopped; await this.chain; return spool.invoke('rec:segment-end', this.kind, this.n); }
}

// ---------- streams ----------
async function getScreen(c) {
  const d = c.display || {};
  // Screens: ask for the display's own pixel size. Windows: a generous ideal, Chromium never upscales a capture.
  const size = c.windowSource ? { width: { ideal: 7680 }, height: { ideal: 4320 } } : { width: { ideal: d.pxWidth || 3840 }, height: { ideal: d.pxHeight || 2160 } };
  try { // getDisplayMedia lets the main process pick the source and attach system-audio loopback
    return await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: C.SCREEN_FPS, ...size }, audio: !!c.systemAudio });
  } catch (e) {
    console.warn('getDisplayMedia failed, falling back', e);
    return navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: c.sourceId, maxWidth: d.pxWidth || 3840, maxHeight: d.pxHeight || 2160, maxFrameRate: C.SCREEN_FPS } } });
  }
}

// Test-only stand-in webcam (an animated "face"), behind cfg.fakeCam, so the whole path can be checked on a machine without a camera.
// Its colours are a test fixture (tests/e2e/run.js looks for the skin tone), not UI.
function fakeCamStream(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); let t = 0;
  const draw = () => {
    t += 0.1; x.setTransform(w / 640, 0, 0, h / 480, 0, 0);
    x.fillStyle = '#3b2a7a'; x.fillRect(0, 0, 640, 480); x.fillStyle = '#f2c9a0'; x.beginPath(); x.ellipse(320, 250, 120, 150, 0, 0, 7); x.fill();
    x.fillStyle = '#222'; x.beginPath(); x.arc(280, 220, 14, 0, 7); x.arc(360, 220, 14, 0, 7); x.fill();
    x.strokeStyle = '#a33'; x.lineWidth = 8; x.beginPath(); x.arc(320, 290 + Math.sin(t) * 6, 50, 0.15 * Math.PI, 0.85 * Math.PI); x.stroke();
  };
  draw(); fakeTimer = setInterval(draw, 33);
  return c.captureStream(30);
}

async function getCamera(c, size) {
  if (c.fakeCam) return fakeCamStream(size.width, size.height);
  return navigator.mediaDevices.getUserMedia({ video: { deviceId: c.camId ? { exact: c.camId } : undefined, width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: 30 } }, audio: false });
}

// Mic (behind a mute gain) and system audio mixed into one track. cfg.fakeMic is a test tone instead of a real microphone.
async function buildAudio(c) {
  audioCtx = new AudioContext(); await audioCtx.resume().catch(() => {});
  const dest = audioCtx.createMediaStreamDestination(), spare = audioCtx.createMediaStreamDestination(); // spare = the same mix on a track of its own for the audio-only recorder (two recorders never share one track: that lost camera files once)
  micGain = audioCtx.createGain(); micGain.connect(dest); micGain.connect(spare);
  let sys = false, mic = false;
  if (c.micOn !== false) {
    if (c.fakeMic) { const o = audioCtx.createOscillator(); o.frequency.value = 440; const g = audioCtx.createGain(); g.gain.value = 0.1; o.connect(g).connect(micGain); o.start(); mic = true; }
    else {
      try {
        const m = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: c.micId ? { exact: c.micId } : undefined, noiseSuppression: true, echoCancellation: true, autoGainControl: true }, video: false });
        streamsToStop.push(m); audioCtx.createMediaStreamSource(m).connect(micGain); mic = true;
      } catch (e) { console.warn('no mic', e); }
    }
  }
  const sysTracks = screenStream ? screenStream.getAudioTracks() : [];
  if (c.systemAudio && sysTracks.length) { const src = audioCtx.createMediaStreamSource(new MediaStream(sysTracks)); src.connect(dest); src.connect(spare); sys = true; }
  hasAudio = mic || sys;
  return { audioTrack: hasAudio ? dest.stream.getAudioTracks()[0] : null, spareTrack: hasAudio ? spare.stream.getAudioTracks()[0] : null, mic, sys };
}
// A fresh MediaRecorder delivers its first two or three frames late (measured: gaps of 20 to 60 ms in the first 0.1 s, perfectly regular after).
// Running a throwaway recording of both streams while the user is still in the countdown makes the capture and encoder pipeline warm, so the real
// first segment does not start cold. The data is discarded and never sent anywhere.
async function warmUp() {
  const warm = [];
  for (const [stream, bps] of [[recScreenStream, tl0Bitrate()], [recCamStream, C.CAM_BITRATE]]) {
    if (!stream) continue;
    const opts = { videoBitsPerSecond: bps }; if (fmt.mime) opts.mimeType = fmt.mime;
    const r = new MediaRecorder(stream, opts); r.ondataavailable = () => {}; warm.push(r); r.start(100);
  }
  await new Promise((r) => setTimeout(r, WARMUP_MS));
  await Promise.all(warm.map((r) => new Promise((res) => { r.onstop = res; r.stop(); })));
}
const tl0Bitrate = () => C.screenBitrate(frame ? frame.height : 1080);

async function prepare(c) {
  cfg = c; paused = false; finishing = false; live = null; micOn = c.micOn !== false; bubbleNow = null; zoomNow = null; stats.chunks = stats.bytes = 0;
  for (const k of Object.keys(files)) delete files[k];
  fmt = pickFormat();

  if (c.mode !== 'cam') {
    screenStream = await getScreen(c); screenTrack = screenStream.getVideoTracks()[0];
    screenTrack.contentHint = 'detail'; // keep text sharp rather than smooth motion
    screenTrack.addEventListener('ended', () => { if (!finishing && tl) stop(); }); // the captured window was closed
  }
  const s = screenTrack ? screenTrack.getSettings() : null;
  frame = screenTrack ? (await frameSize(screenTrack)) || { width: s.width, height: s.height } : null;
  const quality = c.quality || C.DEFAULT_QUALITY;
  const nativeH = frame ? frame.height : 1080;

  let camSize = null;
  if (c.mode !== 'screen') {
    const wantH = C.qualityHeight(quality) || nativeH;
    camSize = c.mode === 'cam' ? (wantH >= 1080 ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }) : C.camSize(Math.min(wantH, nativeH));
    camStream = await getCamera(c, camSize);
  }
  const camTrack = camStream ? camStream.getVideoTracks()[0] : null;
  const cs = camTrack ? camTrack.getSettings() : null;

  const audio = await buildAudio(c);
  // what each recorder gets: screen + audio, camera alone (camera-only mode carries the audio instead). The camera recorder must NOT also take the audio track:
  // when it did, the camera file went missing in about half of the resumed segments (checked on the owner's recordings), and with it the bubble.
  if (screenTrack) recScreenStream = new MediaStream([screenTrack, ...(audio.audioTrack ? [audio.audioTrack] : [])]);
  if (camTrack) recCamStream = new MediaStream([camTrack, ...(!screenTrack && audio.audioTrack ? [audio.audioTrack] : [])]);
  recAudioStream = screenTrack && audio.spareTrack && MediaRecorder.isTypeSupported(C.AUDIO_ONLY_MIME) ? new MediaStream([audio.spareTrack]) : null; // (camera-only takes the voice in the camera file, which always has frames)

  await warmUp(); // see below: the first frames of a fresh encoder arrive late

  const d = c.display || null;
  tl = new Timeline({
    mode: c.mode, quality, crop: c.crop || null, bubbleSpace: c.windowSource || c.mode === 'cam' ? 'frame' : 'display',
    display: d, startedAt: Date.now(), audio: hasAudio, mime: fmt.mime, ext: fmt.ext,
    screen: frame ? { width: frame.width, height: frame.height, fps: C.SCREEN_FPS, bitrate: C.screenBitrate(nativeH), contentHint: screenTrack.contentHint } : null,
    cam: cs ? { width: cs.width || camSize.width, height: cs.height || camSize.height, bitrate: C.CAM_BITRATE, mirrored: false } : null,
  });
  return { screen: s && { ...s, width: frame.width, height: frame.height }, cam: cs, ext: fmt.ext, mime: fmt.mime, audio: { mic: audio.mic, system: audio.sys }, screenBitrate: C.screenBitrate(nativeH) };
}

// ---------- segments ----------
function startSegment() {
  const startMs = epochNow();
  const n = tl.start(startMs);
  const seg = { n, screen: null, cam: null, audio: null, size: null };
  if (recScreenStream) { seg.screen = new Rec('screen', n, recScreenStream, C.screenBitrate(tl.meta.screen.height)); seg.size = n > 0 && cfg.windowSource ? frameSize(screenTrack) : Promise.resolve(frame); } // only a window can change size between segments; probing a screen mid-recording would cost frames
  if (recCamStream) seg.cam = new Rec('cam', n, recCamStream, C.CAM_BITRATE);
  if (recAudioStream) { // a backup only: if it cannot start, the recording goes on without it
    try { seg.audio = new Rec('audio', n, recAudioStream, 0); } catch (e) { recAudioStream = null; spool.send('rec:error', 'voice backup recorder could not start: ' + (e && e.message || e)); }
  }
  live = seg;
  applyBubble(startMs); // every segment begins with a keyframe, so the composite always knows where the camera is
  applyZoom(startMs);   // ...and where the camera picture is zoomed to
  return n;
}

async function endSegment() {
  if (!live) return null;
  const seg = live; live = null;
  const meta = tl.stop(epochNow());           // the segment's length is fixed when stop is requested
  seg.screen?.stop(); seg.cam?.stop(); seg.audio?.stop();
  const [s, c, size, a] = await Promise.all([seg.screen?.done(), seg.cam?.done(), seg.size, seg.audio?.done()]);
  files[meta.n] = { ...(s && s.bytes ? { screen: C.FILES.screen(meta.n, fmt.ext), ...(size || {}) } : {}), ...(c && c.bytes ? { cam: C.FILES.cam(meta.n, fmt.ext) } : {}) };
  // The screen recorder wrote nothing, and with it the voice (the microphone rides in the screen file): the audio-only file is the voice of this stretch.
  // When the screen file exists it holds the voice, the backup is not listed (the main process deletes it when the recording is saved).
  if (seg.screen && !(s && s.bytes) && a && a.bytes) files[meta.n].audio = C.FILES.audio(meta.n);
  // The screen recorder wrote nothing (the screen did not change, so it had no frames): keep a screenshot for the export to hold, so the take is not cut.
  if (seg.screen && !(s && s.bytes) && meta.dur >= STILL_MIN_S) {
    try { const still = await spool.invoke('rec:screen-still', meta.n); if (still) files[meta.n].still = still; } catch { /* black instead of the screen */ }
  }
  if (seg.cam && !(c && c.bytes) && tl.meta.mode === 'screen-cam') { // the bubble is hidden for this stretch (see segmentInputs); say why in the log, the cause of a missing camera file is not proven
    const t = recCamStream && recCamStream.getVideoTracks()[0];
    spool.send('rec:error', `camera segment ${meta.n} (${meta.dur.toFixed(1)} s) wrote nothing: track ${t ? [t.readyState, t.muted ? 'muted' : '', t.enabled ? '' : 'disabled'].filter(Boolean).join(' ') : 'gone'}`);
  }
  return meta;
}

function begin() {
  paused = false; finishing = false;
  startSegment();
  clearInterval(tickTimer); tickTimer = setInterval(() => spool.send('rec:tick', tl.t(epochNow())), 200);
  return true;
}

function stopStreams() {
  clearInterval(tickTimer); clearInterval(fakeTimer);
  for (const s of [screenStream, camStream, ...streamsToStop]) s?.getTracks().forEach((t) => t.stop());
  streamsToStop.length = 0; screenStream = camStream = screenTrack = recScreenStream = recCamStream = recAudioStream = null;
  audioCtx?.close().catch(() => {}); audioCtx = null; micGain = null;
}

// ---------- controls ----------
const pause = () => run(async () => {
  if (paused || !live || finishing) return;
  await endSegment(); paused = true; spool.send('rec:paused', true, tl.base);
});
const resume = () => run(async () => {
  if (!paused || finishing) return;
  paused = false; startSegment(); spool.send('rec:paused', false, tl.base);
});
const togglePause = () => run(async () => { if (finishing) return; if (paused) { paused = false; startSegment(); spool.send('rec:paused', false, tl.base); } else if (live) { await endSegment(); paused = true; spool.send('rec:paused', true, tl.base); } });

// Live Rewind: keep only the first `t` seconds of what has been recorded, then carry on from there.
const rewind = (t) => run(async () => {
  if (finishing || !tl) return;
  if (!paused) { if (!live) return; await endSegment(); paused = true; }
  const dropped = tl.rewind(Math.max(0, +t || 0));
  for (const n of dropped) delete files[n];
  if (dropped.length) await spool.invoke('rec:drop', dropped);
  paused = false; startSegment();
  spool.send('rec:tick', tl.t(epochNow())); spool.send('rec:paused', false, tl.base);
});

const restart = () => run(async () => {
  if (finishing || !tl) return;
  if (live) { const seg = live; live = null; tl.stop(epochNow()); seg.screen?.stop(); seg.cam?.stop(); seg.audio?.stop(); await Promise.all([seg.screen?.done(), seg.cam?.done(), seg.audio?.done()]); }
  await spool.invoke('rec:reset');
  tl.reset(); for (const k of Object.keys(files)) delete files[k];
  paused = false; startSegment();
  spool.send('rec:paused', false, 0); spool.send('rec:tick', 0);
});

const stop = () => run(async () => {
  if (finishing || !tl) return; finishing = true;
  clearInterval(tickTimer);
  if (live) await endSegment();
  const timeline = tl.toJSON(files);
  stopStreams();
  await spool.invoke('rec:finish', { timeline, stats: { ...stats } });
});

const discard = () => run(async () => {
  if (finishing && !live) return; finishing = true;
  clearInterval(tickTimer);
  if (live) { const seg = live; live = null; seg.screen?.stop(); seg.cam?.stop(); seg.audio?.stop(); await Promise.all([seg.screen?.done(), seg.cam?.done(), seg.audio?.done()]).catch(() => {}); }
  stopStreams(); spool.send('rec:discard');
});

function toggleMic() { micOn = !micOn; if (micGain) micGain.gain.value = micOn ? 1 : 0; spool.send('rec:mic', micOn); }

// ---------- events from the main process (cursor, clicks, pen, bubble), stamped with epoch milliseconds ----------
// Window recordings have no position of the camera on screen: the bubble sits bottom-left of the captured frame.
function frameGeometry(b) {
  const h = 0.28, aspect = FRAME_ASPECT[b.shape] || 1, fw = frame ? frame.width : 16, fh = frame ? frame.height : 9;
  const w = Math.min(0.5, (h * aspect * fh) / fw);
  return { x: 0.02, y: 1 - h - 0.03, w, h };
}
function applyBubble(atMs) {
  if (!tl || !bubbleNow || !tl.meta.cam || tl.meta.mode === 'cam') return;
  const b = bubbleNow, g = tl.meta.bubbleSpace === 'frame' ? frameGeometry(b) : b;
  tl.setBubble(atMs, { x: g.x, y: g.y, w: g.w, h: g.h, shape: b.shape, filter: b.filter, frame: b.frame, visible: b.visible });
}
function applyZoom(atMs, span) {
  if (tl && zoomNow && tl.meta.cam) tl.setZoom(atMs, zoomNow, span);
}
function onEvents(batch) {
  if (!tl) return;
  for (const e of batch) {
    if (e[0] === 'c') tl.addCursor(e[1], e[2], e[3]);
    else if (e[0] === 'k') tl.addClick(e[1], e[2], e[3], e[4]);
    else if (e[0] === 'd') tl.addDrawing(e[1], e[2]);
    else if (e[0] === 'b') { bubbleNow = e[2]; applyBubble(e[1]); }
    else if (e[0] === 'z') { zoomNow = e[2]; applyZoom(e[1], e[3]); }
  }
}

// A start was cancelled during the countdown: release whatever prepare() had opened, without touching the library.
window.__cancel = () => { finishing = true; clearInterval(tickTimer); stopStreams(); tl = null; live = null; return true; };
window.__live = () => !!(screenStream || camStream);
window.__prepare = prepare;
window.__begin = begin;
window.__stats = () => ({ ...stats, segments: tl ? tl.segments.length : 0, live: !!live, paused });
spool.on('rec:control', (a, arg) => {
  if (a === 'pause') pause(); else if (a === 'resume') resume(); else if (a === 'toggle-pause') togglePause();
  else if (a === 'stop') stop(); else if (a === 'delete') discard();
  else if (a === 'restart') restart(); else if (a === 'rewind') rewind(arg); else if (a === 'mic') toggleMic();
});
spool.on('rec:events', onEvents);
