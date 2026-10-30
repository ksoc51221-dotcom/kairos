// The recorder. Lives in an offscreen document so it survives tab changes and page navigations.
// Screen: getDisplayMedia, asked for here (Chrome shows its own picker). Camera and mic: getUserMedia (the extension's own origin holds the permission).
// Output: one MediaRecorder file, written to IndexedDB in 1-second chunks, then assembled into a recording the library shows.
const C = self.KairosCore, DB = self.KairosDB;
let s = null;   // the active session, or null
const cancelled = new Set();   // recordings aborted while their devices were still being opened

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});
const stopTracks = (...streams) => streams.forEach((st) => st && st.getTracks().forEach((t) => t.stop()));

// Animated stand-in for the screen, used only by the end-to-end test (the real picker cannot be clicked by a script).
function testPattern() {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
  const g = c.getContext('2d'); let n = 0;
  const timer = setInterval(() => {
    g.fillStyle = '#0f172a'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#34d399'; g.fillRect((n * 8) % 1100, 200 + 120 * Math.sin(n / 10), 160, 160);
    g.fillStyle = '#f8fafc'; g.font = '48px sans-serif'; g.fillText('Kairos test pattern ' + n++, 40, 80);
  }, 33);
  const stream = c.captureStream(30);
  stream.__timer = timer;
  return stream;
}

// Which permission was refused? The service worker sends the person to a real tab to grant it.
async function gum(constraints, need) {
  try { return await navigator.mediaDevices.getUserMedia(constraints); }
  catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'SecurityError') { const err = new Error('permission'); err.code = 'permission'; err.need = [need]; throw err; }
    if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') { const err = new Error(need === 'camera' ? 'No camera was found.' : 'No microphone was found.'); err.code = 'missing'; err.need = [need]; throw err; }
    throw e;
  }
}

// Is camera / microphone access already granted to Kairos? (Without opening a device.) What is missing is asked for on a real tab.
async function preflight({ camera, mic }) {
  const need = [];
  for (const [wanted, name, label] of [[camera, 'camera', 'camera'], [mic, 'microphone', 'mic']]) {
    if (!wanted) continue;
    try { if ((await navigator.permissions.query({ name })).state !== 'granted') need.push(label); } catch { need.push(label); }
  }
  return { ok: true, need };
}

async function prepare({ recId, mode, fake, mic }) {
  if (s) await abort(s.recId);
  const m = C.MODES[mode];
  const fmt = C.pickMime((t) => MediaRecorder.isTypeSupported(t));
  if (!fmt) return { ok: false, message: 'This browser cannot record video (no supported format).' };
  let screen = null, cam = null, micStream = null, ctx = null;
  try {
    if (m.screen) {
      if (fake) screen = testPattern();
      else {
        // Chrome's own "Choose what to share" dialog. A stream picked by the service worker cannot be handed to this page (Chrome ties it to the page that asked),
        // so this page asks for the screen itself; offscreen documents with the DISPLAY_MEDIA reason may do that without a click.
        try { screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true, selfBrowserSurface: 'include', surfaceSwitching: 'include' }); }
        catch (e) {
          if (e.name === 'NotAllowedError') return { ok: false, code: 'cancelled' };   // the person closed the dialog or pressed Cancel
          const hint = e.name === 'NotReadableError' || e.name === 'AbortError' ? ' On a Mac, allow your browser under System Settings > Privacy & Security > Screen Recording, then restart it.' : '';
          throw Object.assign(new Error('Kairos could not capture the screen (' + e.name + (e.message ? ': ' + e.message : '') + ').' + hint), { code: 'screen' });
        }
      }
    }
    if (m.camera) {
      cam = await gum({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false }, 'camera');
      if (mode === 'both') { stopTracks(cam); cam = null; }   // screen + cam: the face bubble is drawn in the page. This only proved the camera works and is allowed.
    }
    if (mic) {
      try { micStream = await gum({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }, 'mic'); }
      catch (e) { if (e.code !== 'missing') throw e; }         // no microphone plugged in: record without a voice rather than refuse
    }
  } catch (e) {
    stopTracks(screen, cam, micStream);
    if (screen && screen.__timer) clearInterval(screen.__timer);
    if (e.code === 'permission') return { ok: false, code: 'permission', need: e.need };
    return { ok: false, message: e.message || String(e) };
  }
  if (cancelled.delete(recId)) { stopTracks(screen, cam, micStream); if (screen && screen.__timer) clearInterval(screen.__timer); return { ok: false, message: 'Cancelled.' }; }

  // One video track, and at most one audio track (mic and system sound are mixed when both exist).
  const video = (screen || cam).getVideoTracks()[0];
  const sources = [micStream && micStream.getAudioTracks()[0], screen && screen.getAudioTracks()[0]].filter(Boolean);
  let audio = null, note = null;
  if (sources.length === 1) audio = sources[0];
  else if (sources.length === 2) {
    ctx = new AudioContext(); await ctx.resume().catch(() => {});
    if (ctx.state === 'running') {
      const dest = ctx.createMediaStreamDestination();
      sources.forEach((t) => ctx.createMediaStreamSource(new MediaStream([t])).connect(dest));
      audio = dest.stream.getAudioTracks()[0];
    } else { audio = sources[0]; note = 'Only your microphone is recorded (this browser would not mix in the system sound).'; ctx.close().catch(() => {}); ctx = null; }
  }
  const stream = new MediaStream([video, ...(audio ? [audio] : [])]);
  const recorder = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: mode === 'camera' ? 4e6 : 8e6, audioBitsPerSecond: 128e3 });
  s = { recId, mode, fmt, screen, cam, micStream, ctx, stream, recorder, hasAudio: !!audio, seq: 0, writes: Promise.resolve(), accMs: 0, since: 0, startedWall: 0, state: 'ready', writeError: null };
  recorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const mine = s, seq = mine.seq++;
    mine.writes = mine.writes.then(() => DB.putChunk(mine.recId, seq, e.data)).catch((err) => { mine.writeError = err; });
  };
  video.addEventListener('ended', () => requestStop('ended'));
  return { ok: true, hasAudio: !!audio, mime: fmt.mime, note };
}

function begin() {
  if (!s || s.state !== 'ready') return { ok: false, message: 'The recorder is not ready.' };
  s.recorder.start(1000);
  s.state = 'recording'; s.since = performance.now(); s.startedWall = Date.now();
  return { ok: true };
}
function pause() { if (s && s.state === 'recording') { s.recorder.pause(); s.accMs += performance.now() - s.since; s.state = 'paused'; } return { ok: true }; }
function resume() { if (s && s.state === 'paused') { s.recorder.resume(); s.since = performance.now(); s.state = 'recording'; } return { ok: true }; }

function release(x) {
  stopTracks(x.screen, x.cam, x.micStream, x.stream);
  if (x.screen && x.screen.__timer) clearInterval(x.screen.__timer);
  if (x.ctx) x.ctx.close().catch(() => {});
}

// Stop and save. Called by the service worker ("stop"), or by the video track ending (the person pressed Chrome's "Stop sharing").
let stopping = false;
async function requestStop(why) {
  if (!s || stopping || (s.state !== 'recording' && s.state !== 'paused')) return;
  stopping = true;
  const x = s;
  if (why === 'ended') await send({ t: 'ended', recId: x.recId });
  try {
    if (x.state === 'recording') x.accMs += performance.now() - x.since;
    x.state = 'stopping';
    await new Promise((resolve) => { x.recorder.onstop = resolve; x.recorder.stop(); });
    await x.writes;
    release(x);
    if (x.writeError) throw x.writeError;
    const parts = await DB.getChunks(x.recId);
    const blob = new Blob(parts.map((p) => p.blob), { type: x.fmt.mime.split(';')[0] });
    if (!blob.size) throw new Error('Nothing was recorded.');
    const rec = { id: x.recId, title: C.defaultTitle(new Date(x.startedWall)), mode: x.mode, createdAt: x.startedWall, durationMs: Math.round(x.accMs), size: blob.size, mime: blob.type, ext: x.fmt.ext, hasAudio: x.hasAudio, blob, thumb: null };
    await DB.putRecording(rec);
    await DB.deleteChunks(x.recId);
    s = null;
    await send({ t: 'finished', ok: true, id: rec.id, recId: x.recId });
  } catch (e) {
    release(x); s = null;
    await send({ t: 'finished', ok: false, message: String(e && e.message || e), recId: x.recId });
  } finally { stopping = false; }
}

async function abort(recId) {
  const x = s;
  if (recId && (!x || x.recId !== recId)) { if (!x) cancelled.add(recId); return { ok: true }; }   // not the recording in the recorder: leave that one alone
  if (!x) return { ok: true };
  s = null;
  try { x.recorder.onstop = null; x.recorder.ondataavailable = null; if (x.recorder.state !== 'inactive') x.recorder.stop(); } catch {}
  release(x);
  await x.writes; await DB.deleteChunks(x.recId).catch(() => {});
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  (async () => {
    switch (msg.t) {
      case 'preflight': return preflight(msg);
      case 'prepare': return prepare(msg);
      case 'begin': return begin();
      case 'pause': return pause();
      case 'resume': return resume();
      case 'stop': requestStop('stop'); return { ok: true };
      case 'abort': return abort(msg.recId);
      default: return { ok: false };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, message: String(e && e.message || e) }));
  return true;
});
