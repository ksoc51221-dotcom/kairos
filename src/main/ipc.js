// Every ipcMain handler in one place. Thin on purpose: each one calls into the module that owns the behaviour.
const { app, ipcMain, shell } = require('electron');
const store = require('../store');
const { transcribeAudioFile } = require('../agents/transcribe');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const permissions = require('./permissions');
const session = require('./session');
const screenshot = require('./screenshot');
const win = require('./windows');
const { W, alive } = win;

function register() {
  const on = (ch, fn) => ipcMain.on(ch, (_e, ...a) => fn(...a));
  const handle = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => fn(...a));

  // launcher
  on('launcher:close', win.hideLauncher);
  on('launcher:open', win.showLauncher); // the area picker hid the bar: bring it back
  on('launcher:size', win.sizeLauncher);
  handle('app:relaunch', permissions.relaunch);
  handle('ready:get', () => require('./readiness').get());
  handle('ready:refresh', () => require('./readiness').refresh());
  handle('ready:download', () => { require('./readiness').startDownload(); return require('./readiness').get(); });
  handle('settings:get', () => store.getSettings());
  handle('settings:set', (patch) => store.setSettings(patch));
  handle('library:open', () => shell.openExternal(config.ownerOrigin('/')));
  handle('screenshot:start', screenshot.start);
  handle('sources:list', (opts) => session.listSources(opts));
  handle('perm:status', () => (process.platform !== 'darwin' ? permissions.status() : { ...permissions.status(), host: permissions.hostName() }));
  handle('perm:open', (which) => permissions.openSettings(which));

  // recording session
  handle('record:start', (opts) => session.start(opts));
  on('rec:control', session.control);
  on('rec:tick', session.tick);
  on('rec:paused', session.paused);
  on('rec:mic', session.mic);
  on('rec:discard', session.discard);
  on('rec:chunk', session.chunk);                       // B3: every recorded chunk is appended to its segment file as it arrives
  handle('rec:segment-end', session.segmentEnd);
  handle('rec:drop', session.dropSegments);             // Live Rewind removed these segments
  handle('rec:reset', session.resetSegments);           // Restart
  on('rec:error', session.recorderError);
  handle('rec:finish', (payload) => session.finish(payload));
  on('tool', session.toggleTool);
  on('bubble:action', session.bubbleAction);
  on('controls:layout', session.controlsLayout);
  on('countdown:done', session.countdownDone);
  on('countdown:skip', session.countdownSkip);
  on('countdown:painted', session.countdownPainted);
  on('countdown:cancel', session.cancelStart);
  on('preview:set', session.previewSet);   // B27: the launcher asks for the camera preview bubble

  // area picker + screenshots
  handle('area:pick', ({ sourceId }) => screenshot.pickCrop(sourceId));
  on('area:done', screenshot.areaResult);
  on('area:cancel', () => screenshot.areaResult(null));
  on('annotate:cancel', screenshot.cancelAnnotate);
  on('annotate:copy', screenshot.copyAnnotated);
  on('annotate:save', screenshot.saveAnnotated);

  // speaker notes
  handle('notes:open', () => { win.hideLauncher(); session.openNotes('edit'); });
  on('notes:save', (text) => store.setSettings({ notes: text }));
  on('notes:close', () => { session.closeNotes(); win.showLauncher(); });
  handle('notes:dictate', async (buf) => {
    const f = path.join(app.getPath('temp'), `spool-dictate-${Date.now()}.f32`); fs.writeFileSync(f, Buffer.from(buf));
    try { const r = await transcribeAudioFile(f, path.join(app.getPath('userData'), 'models')); return r.text; } catch (e) { console.error(e); return ''; } finally { fs.rmSync(f, { force: true }); }
  });
}

module.exports = { register };
