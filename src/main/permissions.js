// macOS permission status, deep links into System Settings, relaunch, and the checks a recording needs before it starts.
// Spool never changes a permission itself: it only reports, asks macOS to show its own prompt, and links to the right pane.
const { app, systemPreferences, shell, dialog } = require('electron');

const isMac = process.platform === 'darwin';
const PANES = { screen: 'Privacy_ScreenCapture', camera: 'Privacy_Camera', mic: 'Privacy_Microphone', input: 'Privacy_ListenEvent' };

// getMediaAccessStatus costs 10–20 ms per call (measured) and Start asks several times, which ate into the countdown's 150 ms budget (B26).
// A 'granted' answer is remembered for the life of the process: macOS restarts an app whose permission is revoked, and the launcher's
// status check (every time it opens) warms this before the user can press Start.
const granted = new Set();
const access = (k) => { if (granted.has(k)) return 'granted'; const v = systemPreferences.getMediaAccessStatus(k); if (v === 'granted') granted.add(k); return v; };
const status = () => (isMac
  ? { screen: access('screen'), camera: access('camera'), mic: access('microphone') }
  : { screen: 'granted', camera: 'granted', mic: 'granted' });
const report = () => (isMac ? status() : {});
// Which app macOS will list in System Settings for Screen Recording
const hostName = () => (app.isPackaged || process.env.SPOOL_APP ? 'Spool' : 'Terminal (or the app you started it from)');
const openSettings = (which) => shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PANES[which] || PANES.screen}`);
const relaunch = () => { app.relaunch(); app.exit(0); };

// Asks macOS to show its own prompts where needed, then checks Screen Recording. B7: cam-only mode does not need the screen,
// so the screen check is skipped when `screen` is false.
async function ensure({ cam = false, screen = true, quiet = false } = {}) {
  if (!isMac) return true;
  // askForMediaAccess costs about 60 ms even when the answer is already known (measured), which was a third of the countdown's 150 ms budget,
  // so macOS is only asked while the answer is still "not determined"; once decided, the prompt cannot reappear anyway.
  const undecided = (k) => access(k) === 'not-determined';
  if (undecided('microphone')) await systemPreferences.askForMediaAccess('microphone');
  if (cam && undecided('camera')) await systemPreferences.askForMediaAccess('camera');
  if (screen && access('screen') !== 'granted') {
    if (quiet) return true; // self-tests run without a dialog and fail later with a clear message
    const r = await dialog.showMessageBox({ type: 'info', message: 'Spool needs Screen Recording permission',
      detail: 'Open System Settings → Privacy & Security → Screen & System Audio Recording, enable this app, then quit and reopen it.', buttons: ['Open Settings', 'Cancel'] });
    if (r.response === 0) openSettings('screen');
    return false;
  }
  return true;
}

module.exports = { status, report, hostName, openSettings, relaunch, ensure, PANES };
