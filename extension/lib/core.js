// Pure logic shared by every part of the Kairos extension: the recording state machine, site keys, time and file helpers.
// No chrome.* calls in here, so it loads three ways: importScripts in the service worker, <script src> in pages and content scripts
// (as self.KairosCore), and require() in the unit tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KairosCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ---- what the three launcher buttons record ----
  const MODES = {
    both: { label: 'Screen + Cam', screen: true, camera: true },
    screen: { label: 'Screen only', screen: true, camera: false },
    camera: { label: 'Camera only', screen: false, camera: true },
  };
  const isMode = (m) => Object.prototype.hasOwnProperty.call(MODES, m);
  const COUNTDOWN_MS = 3000;

  // ---- sites ----
  // The red power button switches Kairos off per site. The key is the host without "www.", so www.example.com and example.com are one site.
  function siteKey(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.hostname.toLowerCase().replace(/^www\./, '') || null;
    } catch { return null; }
  }

  // ---- recording state machine ----
  // idle -> starting (picker, permissions) -> countdown -> recording <-> paused -> saving -> idle. Anything illegal is ignored (same object back).
  const idle = () => ({ phase: 'idle', mode: null, recId: null, tabId: null, startedAt: 0, accMs: 0, countdownEndsAt: 0, error: null, lastSavedId: null });
  function transition(s, ev, now) {
    const busy = s.phase !== 'idle';
    // Events say which recording they belong to. A setup flow that was cancelled keeps running for a moment and must not touch a newer recording.
    if (ev.type !== 'start' && ev.recId !== undefined && ev.recId !== s.recId) return s;
    switch (ev.type) {
      case 'start':
        if (busy || !isMode(ev.mode)) return s;
        return { ...idle(), phase: 'starting', mode: ev.mode, recId: ev.recId, tabId: ev.tabId ?? null };
      case 'countdown':
        return s.phase === 'starting' ? { ...s, phase: 'countdown', countdownEndsAt: ev.endsAt } : s;
      case 'begin':
        return s.phase === 'countdown' ? { ...s, phase: 'recording', startedAt: now, accMs: 0, countdownEndsAt: 0 } : s;
      case 'pause':
        return s.phase === 'recording' ? { ...s, phase: 'paused', accMs: s.accMs + (now - s.startedAt), startedAt: 0 } : s;
      case 'resume':
        return s.phase === 'paused' ? { ...s, phase: 'recording', startedAt: now } : s;
      case 'stop':
        if (s.phase !== 'recording' && s.phase !== 'paused') return s;
        return { ...s, phase: 'saving', accMs: elapsedMs(s, now), startedAt: 0 };
      case 'saved':
        return s.phase === 'saving' ? { ...idle(), lastSavedId: ev.id } : s;
      case 'cancel':
        return busy ? idle() : s;
      case 'fail':
        return { ...idle(), error: { message: String(ev.message || 'Something went wrong'), at: now } };
      default: return s;
    }
  }
  const elapsedMs = (s, now) => s.accMs + (s.phase === 'recording' ? Math.max(0, now - s.startedAt) : 0);
  const isLive = (s) => s.phase === 'recording' || s.phase === 'paused';
  // Does this phase need the recording UI (bubble, control bar, countdown) in every tab?
  const showsRecordingUi = (s) => s.phase === 'countdown' || s.phase === 'recording' || s.phase === 'paused';

  // ---- formatting ----
  function formatTime(ms) {
    const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }
  function formatBytes(n) {
    if (!(n > 0)) return '0 KB';
    if (n < 1e6) return Math.max(1, Math.round(n / 1e3)) + ' KB';
    return n < 1e9 ? (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + ' MB' : (n / 1e9).toFixed(2) + ' GB';
  }
  const defaultTitle = (date) => 'Kairos recording, ' + date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const safeFileName = (title) => (String(title || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)) || 'Kairos recording';
  const newId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---- recorder format ----
  // MP4 (H.264) first: seekable with a real duration and it plays in QuickTime and every chat app. WebM is the fallback for older Chromium.
  const MIME_PREFERENCE = [
    { mime: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4' },
    { mime: 'video/mp4', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
    { mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' },
  ];
  const pickMime = (isSupported) => MIME_PREFERENCE.find((m) => isSupported(m.mime)) || null;

  return { MODES, isMode, COUNTDOWN_MS, siteKey, idle, transition, elapsedMs, isLive, showsRecordingUi, formatTime, formatBytes, defaultTitle, safeFileName, newId, MIME_PREFERENCE, pickMime };
});
