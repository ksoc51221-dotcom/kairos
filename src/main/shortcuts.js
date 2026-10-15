// Global keyboard shortcuts. App-level ones live for the whole run; recording ones only while a session is active.
// B9: the pause shortcut sends "toggle-pause" and never keeps its own paused flag: the recorder owns that state.
const { globalShortcut } = require('electron');

const SESSION_KEYS = ['Alt+Shift+P', 'Alt+Shift+S', 'Alt+Shift+D'];

function registerApp({ onScreenshot, onLauncher }) {
  globalShortcut.register('Alt+Shift+A', onScreenshot);
  globalShortcut.register('Alt+Shift+R', onLauncher);
}
function registerSession({ onTogglePause, onStop, onPen }) {
  globalShortcut.register('Alt+Shift+P', onTogglePause);
  globalShortcut.register('Alt+Shift+S', onStop);
  globalShortcut.register('Alt+Shift+D', onPen);
}
const unregisterSession = () => SESSION_KEYS.forEach((k) => globalShortcut.unregister(k));
const unregisterAll = () => globalShortcut.unregisterAll();

module.exports = { registerApp, registerSession, unregisterSession, unregisterAll };
