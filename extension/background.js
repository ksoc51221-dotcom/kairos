// Kairos extension service worker: owns the recording state machine and talks to the offscreen recorder.
// State lives in chrome.storage.session (this worker may be stopped at any time); every page and content script just reads and watches it.
importScripts('lib/core.js');
const C = self.KairosCore;
const KEY = 'rec', PENDING = 'pendingStart';

// Content scripts read the state and subscribe to changes themselves, so no tab ever needs a push message from here.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

// ---- state ----
const getState = async () => (await chrome.storage.session.get(KEY))[KEY] || C.idle();
let chain = Promise.resolve();
// Only the read-modify-write is serialised. The long steps around it (the screen picker, the countdown) must not block Stop.
function dispatch(ev) {
  const run = async () => {
    const s = await getState();
    const n = C.transition(s, ev, Date.now());
    if (n !== s) { await chrome.storage.session.set({ [KEY]: n }); paintBadge(n); }
    return n;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}
function paintBadge(s) {
  const live = s.phase === 'recording', paused = s.phase === 'paused';
  chrome.action.setBadgeText({ text: live ? 'REC' : paused ? 'II' : s.phase === 'saving' ? '...' : '' });
  chrome.action.setBadgeBackgroundColor({ color: live ? '#dc2626' : '#b45309' });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stillMine = async (recId, ...phases) => { const s = await getState(); return s.recId === recId && (!phases.length || phases.includes(s.phase)); };

// ---- offscreen recorder ----
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'], justification: 'Record the screen, camera and microphone with MediaRecorder' });
}
const hasOffscreen = async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
const toOffscreen = (msg) => chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
const closeOffscreen = async () => { if (await hasOffscreen()) try { await chrome.offscreen.closeDocument(); } catch {} };
// Drop what recording `recId` left in the recorder. The document itself is only closed when nothing else is going on (a newer recording may already use it).
async function cleanup(recId) {
  await toOffscreen({ t: 'abort', recId }).catch(() => {});
  if ((await getState()).phase === 'idle') await closeOffscreen();
}

// ---- settings and test seam ----
async function getSettings() { return { mic: true, ...((await chrome.storage.local.get('settings')).settings || {}) }; }

// Test seam: the end-to-end test cannot click Chrome's native picker, so it sets this key and the recorder draws a test pattern instead.
const fakeScreen = async () => !!(await chrome.storage.local.get('__testFakeScreen')).__testFakeScreen;

// ---- start / pause / resume / stop ----
async function startRecording(mode, tabId, opts = {}) {
  if (!C.isMode(mode)) return { ok: false, reason: 'bad-mode' };
  const settings = await getSettings();
  const recId = C.newId();
  const s = await dispatch({ type: 'start', mode, recId, tabId });
  if (s.recId !== recId) return { ok: false, reason: 'busy' };
  const fail = async (message) => { await cleanup(recId); await dispatch({ type: 'fail', message, recId }); return { ok: false, reason: 'error', message }; };
  const cancelled = async () => { await cleanup(recId); return { ok: false, reason: 'cancelled' }; };
  // Camera or microphone not allowed yet: leave a note, go to a real tab to ask, and the permissions page brings the person back here.
  const askPermission = async (need) => {
    await chrome.storage.session.set({ [PENDING]: { mode, tabId } });
    await dispatch({ type: 'cancel', recId });
    await cleanup(recId);
    await chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html?need=' + need.join(',') + '&mode=' + mode) });
    return { ok: false, reason: 'permission' };
  };
  try {
    await ensureOffscreen();
    // Ask for camera and microphone BEFORE the screen picker, so a first-time person does not have to pick a screen twice.
    if (!opts.fromPermissions) {
      const pre = await toOffscreen({ t: 'preflight', camera: C.MODES[mode].camera, mic: settings.mic });
      if (pre && pre.need && pre.need.length) return askPermission(pre.need);
    }
    // For a screen the recorder opens Chrome's picker now, so this can wait on the person.
    const r = await toOffscreen({ t: 'prepare', recId, mode, fake: C.MODES[mode].screen && await fakeScreen(), mic: settings.mic });
    if (!(await stillMine(recId))) return cancelled();
    if (r && r.code === 'cancelled') { await dispatch({ type: 'cancel', recId }); await cleanup(recId); return { ok: false, reason: 'cancelled' }; }   // the person closed the picker
    if (!r || !r.ok) {
      if (r && r.code === 'permission') {
        // Coming back from the permissions page and still refused: do not send them round in circles.
        if (opts.fromPermissions) return fail('Chrome did not keep the ' + (r.need || ['camera']).map((n) => (n === 'mic' ? 'microphone' : n)).join(' and ') + ' permission. Allow it for Kairos in chrome://settings/content, then try again.');
        return askPermission(r.need || []);
      }
      return fail((r && r.message) || 'Kairos could not start the recorder.');
    }
    await dispatch({ type: 'countdown', endsAt: Date.now() + C.COUNTDOWN_MS, recId });
    await sleep(C.COUNTDOWN_MS);
    if (!(await stillMine(recId, 'countdown'))) return cancelled();
    const b = await toOffscreen({ t: 'begin' });
    if (!b || !b.ok) return fail((b && b.message) || 'The recorder did not start.');
    await dispatch({ type: 'begin', recId });
    return { ok: true, recId };
  } catch (e) { return fail(String(e && e.message || e)); }
}

async function pauseRecording() { const s = await dispatch({ type: 'pause' }); if (s.phase === 'paused') await toOffscreen({ t: 'pause' }); return { ok: true }; }
async function resumeRecording() { const s = await dispatch({ type: 'resume' }); if (s.phase === 'recording') await toOffscreen({ t: 'resume' }); return { ok: true }; }
async function stopRecording() {
  const s = await dispatch({ type: 'stop' });
  if (s.phase === 'saving') await toOffscreen({ t: 'stop' });                   // the recorder answers later with a "finished" message
  return { ok: true };
}
async function cancelRecording() {
  const s = await getState();
  if (s.phase === 'idle') return { ok: true };
  await dispatch({ type: 'cancel', recId: s.recId });
  await cleanup(s.recId);
  return { ok: true };
}

async function onFinished(msg) {
  if (msg.ok) {
    await dispatch({ type: 'saved', id: msg.id, recId: msg.recId });
    await closeOffscreen();
    await chrome.tabs.create({ url: chrome.runtime.getURL('library.html#/v/' + msg.id) });
  } else {
    await dispatch({ type: 'fail', message: msg.message || 'The recording could not be saved.', recId: msg.recId });
    await cleanup(msg.recId);
  }
}

// ---- messages ----
async function handle(msg, sender) {
  switch (msg.t) {
    case 'start': return startRecording(msg.mode, msg.tabId ?? sender.tab?.id);
    case 'pause': return pauseRecording();
    case 'resume': return resumeRecording();
    case 'stop': return stopRecording();
    case 'cancel': return cancelRecording();
    case 'wake': return { ok: true };                                          // a content script asking us to run (this sets the storage access level)
    case 'openLibrary': await chrome.tabs.create({ url: chrome.runtime.getURL('library.html') }); return { ok: true };
    case 'ensureLauncher': return { ok: await ensureLauncher(msg.tabId) };      // the popup, for the tab it was opened on
    case 'ended': await dispatch({ type: 'stop', recId: msg.recId }); return { ok: true };      // the person pressed Chrome's own "Stop sharing"
    case 'finished': await onFinished(msg); return { ok: true };
    case 'permissionsGranted': {
      const pending = (await chrome.storage.session.get(PENDING))[PENDING];
      await chrome.storage.session.remove(PENDING);
      if (pending) {
        if (sender.tab) chrome.tabs.remove(sender.tab.id).catch(() => {});
        const tab = pending.tabId != null ? await chrome.tabs.get(pending.tabId).catch(() => null) : null;
        if (tab) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {}); }
        startRecording(pending.mode, tab ? tab.id : undefined, { fromPermissions: true });   // not awaited: it runs for the whole recording setup
      }
      return { ok: true };
    }
    default: return { ok: false, reason: 'unknown' };
  }
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;                       // addressed to the recorder page
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  const s = await getState();
  if (command === 'stop-recording' && C.isLive(s)) stopRecording();
  if (command === 'toggle-pause') { if (s.phase === 'recording') pauseRecording(); else if (s.phase === 'paused') resumeRecording(); }
});

// ---- the button on tabs that were already open ----
// Chrome only gives a content script to pages that load after the extension was installed, updated or switched on. Without this the button would not
// show up until each tab was refreshed, and a tab left over from before an update would keep a button that does nothing.
const CONTENT_FILES = chrome.runtime.getManifest().content_scripts[0].js;
const hasLauncher = (tabId) => chrome.tabs.sendMessage(tabId, { t: 'ping' }).then((r) => !!(r && r.ok), () => false);
async function ensureLauncher(tabId) {
  if (await hasLauncher(tabId)) return true;
  try { await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES }); return true; }
  catch { return false; }                                                  // a Chrome page, the Web Store, a tab that went away
}
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'], discarded: false });
  await Promise.allSettled(tabs.map((t) => ensureLauncher(t.id)));
}
// chrome.storage.session starts empty every time the extension is installed, updated, reloaded, re-enabled or the browser starts: that is exactly when to look.
(async () => {
  if ((await chrome.storage.session.get('injected')).injected) return;
  await chrome.storage.session.set({ injected: true });
  await injectIntoOpenTabs();
})();

chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('library.html#/welcome') });
});

// If this worker was restarted while a recording was supposed to be running, make the saved state match reality.
(async () => {
  const s = await getState();
  paintBadge(s);
  if (s.phase === 'idle') return;
  const recorderAlive = await hasOffscreen();
  const orphaned = s.phase === 'starting' || s.phase === 'countdown' || !recorderAlive;   // the setup flow lived in the old worker; the recorder may be gone
  if (orphaned) { await dispatch({ type: 'fail', message: 'The recording was interrupted.' }); await closeOffscreen(); }
})();
