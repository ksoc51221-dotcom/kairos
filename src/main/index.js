// App lifecycle: single instance, library folder, local server, tray, Dock icon, global shortcuts, startup.
const { app, session: electronSession, desktopCapturer, Tray, Menu, nativeImage, shell, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('../store');
const { startServer } = require('../server/server');
const orchestrator = require('../agents/orchestrator');
const C = require('../shared/constants');
const config = require('./config');
const logger = require('./log');
const permissions = require('./permissions');
const readiness = require('./readiness');
const shortcuts = require('./shortcuts');
const screenshot = require('./screenshot');
const session = require('./session');
const win = require('./windows');
const ipc = require('./ipc');
const { log } = logger;

app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
if (!config.SELFTEST && !app.requestSingleInstanceLock()) app.exit(0); // one Spool at a time (they would fight over the port)
app.on('second-instance', () => win.showLauncher());
app.on('before-quit', () => { win.setQuitting(); store.flush(); });
process.on('uncaughtException', (e) => log('uncaughtException', e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e));
ipc.register();

app.whenReady().then(async () => {
  const dataDir = config.dataDir(app);
  logger.init(path.join(app.getPath('userData'), 'spool.log'));
  try { store.init(path.join(dataDir, 'library'), { log }); }
  catch (e) { // B1: never start on top of a library file we cannot read
    if (!(e instanceof store.StoreCorruptError)) throw e;
    log('library unreadable', e.message, e.files);
    dialog.showErrorBox('Spool cannot open your library', `${e.message}\n\nFiles: ${e.files.join(', ')}`);
    app.exit(1); return;
  }
  // A recording that was still being written when the app stopped keeps its files but is marked, instead of showing "Recording…" forever.
  for (const v of store.list()) if (v.status === C.LIBRARY_STATUS.RECORDING) store.update(v.id, { status: C.LIBRARY_STATUS.FAILED, stage: 'Recording was interrupted (files kept)' });
  orchestrator.init(dataDir, { log, isBusy: () => session.isActive() });
  startServer({ port: config.PORT, models: path.join(dataDir, 'models'), openLauncher: win.showLauncher });
  readiness.init(path.join(dataDir, 'models'));
  electronSession.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const S = session.getS(), srcs = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const pick = srcs.find((s) => s.id === S?.opts.sourceId) || srcs.find((s) => s.id.startsWith('screen:')) || srcs[0];
    callback(S?.opts.systemAudio ? { video: pick, audio: 'loopback' } : { video: pick });
  });
  win.createRecorder();
  log('start', { packaged: app.isPackaged, version: app.getVersion(), perms: permissions.report() });

  const tray = new Tray(nativeImage.createEmpty()); tray.setTitle('● Spool');
  const trayMenu = () => Menu.buildFromTemplate([
    ...(readiness.get().speechMissing ? [{ label: readiness.get().download.state === 'running' ? `Downloading speech model… ${readiness.get().download.percent}%` : `⚠ Download the speech model (${readiness.MODEL_MB} MB)`, enabled: readiness.get().download.state !== 'running', click: () => readiness.startDownload() }, { type: 'separator' }] : []),
    { label: 'New recording…  (⌥⇧R)', click: win.showLauncher }, { label: 'Screenshot  (⌥⇧A)', click: screenshot.start },
    { label: 'Open library', click: () => shell.openExternal(config.ownerOrigin('/')) }, { type: 'separator' },
    { label: 'Copy diagnostics', click: () => clipboard.writeText(`Spool diagnostics\nperms: ${JSON.stringify(permissions.report())}\n${logger.tail(60)}`) },
    { label: 'Show log file', click: () => shell.showItemInFolder(logger.file) }, { type: 'separator' }, { role: 'quit' },
  ]);
  tray.setContextMenu(trayMenu());
  readiness.onChange(() => { tray.setContextMenu(trayMenu()); tray.setTitle(readiness.get().speechMissing ? '⚠ Spool' : '● Spool'); });
  readiness.refresh().then((r) => log('readiness', { speechModel: !r.speechMissing, ollama: !r.ollamaMissing }));
  tray.on('click', win.showLauncher);
  shortcuts.registerApp({ onScreenshot: screenshot.start, onLauncher: win.toggleLauncher });
  const ico = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  if (app.dock && fs.existsSync(ico)) { const img = nativeImage.createFromPath(ico); app.dock.setIcon(img); win.setDockIcon(img); }
  if (config.SELFTEST) { setTimeout(() => require('./selftest').run(config.SELFTEST), 1500); return; }
  // B28: started by the system at login, Spool stays quiet in the menu bar; opened by the user, it shows the launcher
  if (!app.getLoginItemSettings().wasOpenedAtLogin) win.showLauncher();
});
app.on('window-all-closed', (e) => e.preventDefault());
app.on('activate', () => win.showLauncher()); // clicking the Dock icon always brings the launcher back
app.on('will-quit', () => shortcuts.unregisterAll());
