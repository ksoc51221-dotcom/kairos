// macOS permission status, deep links into System Settings, relaunch, and the checks a recording needs before it starts.
// Spool never changes a permission itself: it only reports, asks macOS to show its own prompt, and links to the right pane.
const { app, systemPreferences, shell, dialog } = require('electron');

const isMac = process.platform === 'darwin';
const PANES = { screen: 'Privacy_ScreenCapture', camera: 'Privacy_Camera', mic: 'Privacy_Microphone', input: 'Privacy_ListenEvent' };

const status = () => (isMac
  ? { screen: systemPreferences.getMediaAccessStatus('screen'), camera: systemPreferences.getMediaAccessStatus('camera'), mic: systemPreferences.getMediaAccessStatus('microphone') }
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
  await systemPreferences.askForMediaAccess('microphone');
  if (cam) await systemPreferences.askForMediaAccess('camera');
  if (screen && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    if (quiet) return true; // self-tests run without a dialog and fail later with a clear message
    const r = await dialog.showMessageBox({ type: 'info', message: 'Spool needs Screen Recording permission',
      detail: 'Open System Settings → Privacy & Security → Screen & System Audio Recording, enable this app, then quit and reopen it.', buttons: ['Open Settings', 'Cancel'] });
    if (r.response === 0) openSettings('screen');
    return false;
  }
  return true;
}

module.exports = { status, report, hostName, openSettings, relaunch, ensure, PANES };
