// The library's native window: the same pages the local server gives a browser, in one Kairos window with a macOS title bar.
// The pages get no Kairos powers here. They have no `spool` bridge, and their own session has no screen-capture handler, so a bug in a page cannot start a capture.
const { app, BrowserWindow, Menu, clipboard, nativeTheme, screen, session: electronSession, shell } = require('electron');
const path = require('path');
const store = require('../store');
const config = require('./config');
const { log } = require('./log');
const win = require('./windows');
const { classifyNavigation, fitBounds } = require('./library-nav');

const { W, alive } = win;
const PARTITION = 'persist:library';
const SIZE = { defaultWidth: 1280, defaultHeight: 840, minWidth: 900, minHeight: 600 };
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']); // copy link and fullscreen video; the pages ask for nothing else
const TOPBAR_H = 48, LIGHT_H = 14, LIGHT_X = 16, INSET = 80, RETRIES = 20, RETRY_MS = 300, ABORTED = -3;

// Added from here rather than the page CSS so that share pages in people's browsers can never pick it up.
const chromeCss = (fullScreen) => `
  html body header.top { -webkit-app-region: drag; padding-left: ${fullScreen ? 12 : INSET}px; }
  html body header.top > * { -webkit-app-region: no-drag; }
  html body header.top > .grow, html body header.top > .vsep { -webkit-app-region: drag; }
  html body:not(:has(header.top))::before { content: ''; position: fixed; inset: 0 0 auto 0; height: 28px; z-index: 2147483647; -webkit-app-region: drag; }
`;
async function applyChrome(w) {
  if (!alive(w)) return;
  const wc = w.webContents, previous = w._chromeCss;
  try {
    w._chromeCss = await wc.insertCSS(chromeCss(w.isFullScreen()));
    if (previous && alive(w)) await wc.removeInsertedCSS(previous).catch(() => {}); // a new page no longer has the old key
  } catch (e) { log('library chrome css', e.message); }
}

function hardenSession() {
  const ses = electronSession.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_wc, permission, done) => done(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  return ses;
}

function openOutside(url) { shell.openExternal(url).catch((e) => log('open link', e.message)); }

function guardNavigation(wc) {
  const route = (e) => {
    const verdict = classifyNavigation(e.url, config.origin());
    if (verdict === 'allow') return;
    e.preventDefault();
    if (verdict === 'external') openOutside(e.url);
  };
  wc.on('will-frame-navigate', route);
  wc.on('will-redirect', route);
  wc.setWindowOpenHandler(({ url }) => { // one window: a local "new tab" link opens here
    const verdict = classifyNavigation(url, config.origin());
    if (verdict === 'allow') wc.loadURL(url);
    else if (verdict === 'external') openOutside(url);
    return { action: 'deny' };
  });
}

// Electron has no right-click menu of its own.
function contextMenu(w, p) {
  const items = [];
  if (p.linkURL) items.push({ label: 'Copy link', click: () => clipboard.writeText(p.linkURL) });
  if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
  else if (p.selectionText) items.push({ role: 'copy' });
  if (items.length) Menu.buildFromTemplate(items).popup({ window: w });
}

let saveTimer;
function saveBounds(w) {
  if (!alive(w) || w.isFullScreen()) return;
  store.setSettings({ libraryBounds: w.getNormalBounds() });
}

function createLibraryWindow(pagePath = '/', { showWhenLoaded = true } = {}) {
  hardenSession();
  const current = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const bounds = fitBounds(store.getSettings().libraryBounds, screen.getAllDisplays().map((d) => d.workArea), current, SIZE);
  const w = new BrowserWindow({
    ...bounds, minWidth: SIZE.minWidth, minHeight: SIZE.minHeight, show: false, title: 'Kairos',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: LIGHT_X, y: Math.round((TOPBAR_H - LIGHT_H) / 2) },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B0B0C' : '#F6F6F3', // no white flash before the first paint
    webPreferences: { preload: path.join(__dirname, 'library-preload.js'), partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  W.library = w;
  const wc = w.webContents;
  guardNavigation(wc);
  wc.on('did-navigate', () => applyChrome(w));
  w.on('enter-full-screen', () => applyChrome(w));
  w.on('leave-full-screen', () => applyChrome(w));
  wc.on('context-menu', (_e, p) => contextMenu(w, p));
  // The older three-finger swipe, for people who set their trackpad that way. The two-finger one is in library-preload.js.
  w.on('swipe', (_e, dir) => { if (dir === 'left') goBack(w); else if (dir === 'right') goForward(w); });

  const remember = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveBounds(w), 400); };
  w.on('resized', remember); w.on('moved', remember);
  w.on('close', () => { clearTimeout(saveTimer); saveBounds(w); });
  w.on('focus', () => win.showDockForWindow());
  w.on('closed', () => { if (W.library === w) delete W.library; win.hideDockAfterWindow(); }); // a closed window is gone (and any playing video stops); recording and the app carry on

  // The server may still be starting, or restarting after the network setting changes.
  let tries = 0;
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === ABORTED) return; // ABORTED is also how a download ends a navigation
    if (tries++ >= RETRIES) { log('library failed to load', code, desc); return; }
    setTimeout(() => { if (alive(w)) wc.loadURL(config.ownerOrigin(pagePath)); }, RETRY_MS);
  });
  wc.on('did-finish-load', () => { tries = 0; });
  if (showWhenLoaded) {
    let shown = false;
    const first = () => { if (!shown) { shown = true; reveal(w); } };
    w.once('ready-to-show', first);
    setTimeout(first, 1200); // never leave the user with nothing if the first load is slow
  }
  wc.loadURL(config.ownerOrigin(pagePath));
  return w;
}

function reveal(w) {
  if (!alive(w)) return;
  if (w.isMinimized()) w.restore();
  win.showDockForWindow();
  w.show(); w.focus();
  app.focus({ steal: true }); // Kairos is often a menu-bar app with nothing in front; the user just asked for this window
}

// Opens the library, or brings the one window back. With a path it also goes to that page, as after a recording.
function showLibrary(pagePath) {
  win.hideLauncher(); // the bar floats above every window and would sit on top of the library
  if (!alive(W.library)) { createLibraryWindow(pagePath || '/'); return; }
  if (pagePath) W.library.webContents.loadURL(config.ownerOrigin(pagePath));
  reveal(W.library);
}
const isOpen = () => alive(W.library);

const history = (w) => (alive(w) ? w.webContents.navigationHistory : null);
function goBack(w) { const h = history(w); if (h?.canGoBack()) h.goBack(); }
function goForward(w) { const h = history(w); if (h?.canGoForward()) h.goForward(); }
const onLibrary = (fn) => () => { if (alive(W.library)) fn(W.library); };

// The app's menu: once Kairos has a menu bar it should be a real one, and its View items only touch the library, never an overlay.
function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Back', accelerator: 'CmdOrCtrl+[', click: onLibrary(goBack) },
      { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: onLibrary(goForward) },
      { type: 'separator' },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: onLibrary((w) => w.webContents.reload()) },
      ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
  ]));
}

module.exports = { showLibrary, isOpen, createLibraryWindow, installMenu, chromeCss, PARTITION };
