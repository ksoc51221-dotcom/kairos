// npm run test:library:e2e. The real library window code and the real local server, with the window never shown and a throwaway library and port.
// What this cannot see: the title bar, the Dock, focus, a physical trackpad, and clipboard writes (Chromium requires a focused window).
const { app, BrowserWindow, session, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

app.dock?.hide();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-library-e2e-'));
process.env.SPOOL_PORT = String(47000 + Math.floor(Math.random() * 900));
process.env.SPOOL_DATA = TMP;
app.setPath('userData', TMP);
app.on('window-all-closed', (e) => e.preventDefault()); // as in the real app

const ROOT = path.join(__dirname, '..', '..');
const main = (f) => path.join(ROOT, 'src', 'main', f);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(50); } return null; };

app.whenReady().then(async () => {
  setTimeout(() => { console.log('FAIL  timed out'); app.exit(1); }, 120000);
  const opened = [];
  shell.openExternal = async (u) => { opened.push(u); };

  const store = require(path.join(ROOT, 'src', 'store.js'));
  store.init(path.join(TMP, 'library'), { log: () => {} });
  const v = store.create({ title: 'Fixture', status: 'ready', duration: 10 });
  const ffmpeg = require('ffmpeg-static'), dir = store.videoDir(v.id);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=15:d=10', '-f', 'lavfi', '-i', 'sine=d=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', path.join(dir, 'video.mp4')]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', path.join(dir, 'video.mp4'), '-frames:v', '1', path.join(dir, 'thumb.jpg')]);

  const config = require(main('config.js'));
  const { startServer } = require(path.join(ROOT, 'src', 'server', 'server.js'));
  startServer({ port: config.PORT, host: '127.0.0.1', models: path.join(TMP, 'models'), openLauncher: () => {} });

  const library = require(main('library-window.js'));
  const win = require(main('windows.js'));
  const O = config.origin();
  const w = library.createLibraryWindow('/', { showWhenLoaded: false }), wc = w.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const loaded = () => new Promise((r) => wc.once('did-finish-load', r));
  const goTo = async (p) => { const l = loaded(); wc.loadURL(O + p); await l; };
  const path_ = () => { const u = new URL(wc.getURL()); return u.pathname + u.hash; };
  const click = (href, attrs = '') => js(`(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(href)}; ${attrs} document.body.append(a); a.click(); a.remove(); })()`);

  await until(() => !wc.isLoading() && wc.getURL().startsWith(O));
  await wait(300);
  check('opens at the library, signed in as the owner', path_().startsWith('/') && (await js("fetch('/api/me').then((r) => r.json()).then((m) => m.owner)")) === true, wc.getURL());
  check('the sign-in code is not left in the address', !wc.getURL().includes('code='));
  check('the window stayed hidden during this test', !w.isVisible());

  // Electron protections, seen from the page itself
  check('the page has no Node', (await js('typeof require + typeof process + typeof module')) === 'undefinedundefinedundefined');
  check('the page has no Kairos bridge', (await js('typeof window.spool')) === 'undefined');
  check('screen capture is refused', (await js("navigator.mediaDevices.getDisplayMedia({video:true}).then(() => 'granted', (e) => 'refused')")) === 'refused');
  check('camera and microphone are refused', (await js("navigator.mediaDevices.getUserMedia({audio:true}).then(() => 'granted', () => 'refused')")) === 'refused');

  // Header fit
  const head = await js("(() => { const s = getComputedStyle(document.querySelector('header.top')), b = getComputedStyle(document.querySelector('header.top a')); return { pad: s.paddingLeft, drag: s.webkitAppRegion, child: b.webkitAppRegion, h: document.querySelector('header.top').offsetHeight }; })()").catch(() => ({}));
  check('the header clears the window buttons and drags the window', head.pad === '80px' && head.drag === 'drag', JSON.stringify(head));
  check('links in the header stay clickable', head.child === 'no-drag');

  // Navigation rule, driven by real clicks
  let n = 0; const sent = async (url) => { n++; return until(() => opened.includes(url), 3000); };
  await click('https://example.com/docs'); check('an external link goes to the browser', await sent('https://example.com/docs'));
  check('...and the window stays on its page', wc.getURL().startsWith(O));
  await click('https://example.com/new', "a.target = '_blank';"); check('an external new-tab link goes to the browser', await sent('https://example.com/new'));
  await js("void window.open('https://example.com/popup')"); check('window.open to the web goes to the browser', await sent('https://example.com/popup'));
  await js("void window.open('mailto:a@b.co?subject=hi', '_self')"); check('a mail link goes to the mail app', await sent('mailto:a@b.co?subject=hi'));
  await click(`http://localhost:${config.PORT + 1}/dev`); check('another localhost port is treated as external', await sent(`http://localhost:${config.PORT + 1}/dev`));
  const before = opened.length;
  await js("void window.open('file:///etc/hosts')"); await click('file:///etc/hosts'); await wait(300);
  check('a file link goes nowhere', opened.length === before && wc.getURL().startsWith(O));
  const l1 = loaded(); await click(`${O}/v/${v.id}`, "a.target = '_blank';"); await l1;
  check('a local new-tab link opens in this window', path_() === `/v/${v.id}`, path_());
  check('no second window ever opened', BrowserWindow.getAllWindows().filter((x) => x.getURL?.().startsWith?.('http')).length === 1);

  // Pages
  await goTo(`/v/${v.id}`);
  const vid = await until(() => js("(() => { const e = document.getElementById('v'); return e && e.readyState >= 1 ? { d: e.duration, w: e.videoWidth } : null; })()"));
  check('the watch page loads the H.264 video', vid && Math.round(vid.d) === 10 && vid.w === 640, JSON.stringify(vid));
  const seek = await js("new Promise((res) => { const e = document.getElementById('v'); e.addEventListener('seeked', () => res(e.currentTime), { once: true }); e.currentTime = 7; setTimeout(() => res(-1), 6000); })");
  check('seeking works', Math.abs(seek - 7) < 0.6, String(seek));
  const played = await js("new Promise(async (res) => { const e = document.getElementById('v'); e.muted = true; const t = e.currentTime; try { await e.play(); } catch (x) { return res('error ' + x.name); } setTimeout(() => { e.pause(); res(e.currentTime - t); }, 800); })");
  check('playback advances', typeof played === 'number' && played > 0.1, String(played));
  const put = await js(`fetch('/api/videos/${v.id}', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Renamed in app' }) }).then((r) => r.status)`);
  check('owner writes pass the server\'s origin and token checks', put === 200 && store.get(v.id).title === 'Renamed in app', String(put));
  check('the AI edit chat is on the page', await until(() => js('!!window.EditPrompt')));
  const chat = await js(`fetch('/api/videos/${v.id}/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(100000) }) }).then((r) => r.status)`);
  check('the AI edit chat route accepts this window as the owner', chat !== 401 && chat !== 403, String(chat));
  await goTo(`/edit/${v.id}`);
  check('the editor opens', path_() === `/edit/${v.id}` && await until(() => js("!!document.getElementById('play')")));
  await goTo('/#/settings'); check('settings opens', path_() === '/#/settings' && await until(() => js("document.querySelector('.topnav .on')?.dataset.k === 'settings'")));
  const sp = await js("fetch('/api/spaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'E2E' }) }).then((r) => r.ok ? r.json() : null).catch(() => null)");
  if (sp?.id) { await goTo(`/space/${sp.id}`); check('a space opens', await until(() => js("document.getElementById('n')?.textContent === 'E2E'"))); } else check('a space opens', false, 'could not create one');

  // The header at the smallest window size, on every page that has one
  w.setBounds({ width: 900, height: 600 });
  await wait(150);
  for (const [name, p] of [['library', '/'], ['watch', `/v/${v.id}`], ['editor', `/edit/${v.id}`]]) {
    await goTo(p); await wait(400);
    const fit = await js("(() => { const h = document.querySelector('header.top'), r = h.getBoundingClientRect(), last = [...h.children].filter((c) => c.getClientRects().length).pop().getBoundingClientRect(); return { over: h.scrollWidth - h.clientWidth, right: Math.round(last.right), width: Math.round(r.width) }; })()");
    check(`the ${name} header fits at the minimum size`, fit.over <= 0 && fit.right <= fit.width, JSON.stringify(fit));
    if (process.env.LIBRARY_E2E_SHOTS) fs.writeFileSync(path.join(process.env.LIBRARY_E2E_SHOTS, `${name}.png`), (await wc.capturePage()).toPNG());
  }
  await goTo(`/space/${sp?.id}`);

  // Back and forward
  const hist = wc.navigationHistory;
  const hl = loaded(); hist.goBack(); await hl;
  check('back returns to the previous page', path_() !== `/space/${sp?.id}`, path_());
  const fl = loaded(); hist.goForward(); await fl;
  check('forward returns again', path_() === `/space/${sp?.id}`, path_());

  // A sideways wheel gesture through Chromium's real input path proves the swipe code loads inside the sandbox
  const startPage = path_();
  const swiped = loaded();
  for (let i = 0; i < 12; i++) { wc.sendInputEvent({ type: 'mouseWheel', x: 500, y: 400, deltaX: 30, deltaY: 0, canScroll: true, hasPreciseScrollingDeltas: true }); await wait(16); }
  const moved = await Promise.race([swiped.then(() => true), wait(2500).then(() => false)]);
  check('a two-finger style swipe goes back', moved && path_() !== startPage, `${startPage} -> ${path_()}`);
  if (moved) { const r = loaded(); hist.goForward(); await r; }

  // Downloads
  const saved = path.join(TMP, 'dl');
  fs.mkdirSync(saved);
  const ses = session.fromPartition(library.PARTITION), results = [];
  ses.on('will-download', (_e, item) => { const to = path.join(saved, `${results.length}-${item.getFilename()}`); item.setSavePath(to); const r = { to }; results.push(r); item.once('done', (_d, state) => { r.state = state; }); });
  await goTo(`/v/${v.id}`);
  const at = wc.getURL();
  await click(`/media/${v.id}/download`);
  check('a video download completes', await until(() => results[0]?.state === 'completed') && fs.statSync(results[0].to).size > 1000, results[0]?.to);
  await js("(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['<p>hi</p>'], { type: 'text/html' })); a.download = 'guide.html'; a.click(); })()");
  check('a page-made file (guide export) downloads', await until(() => results[1]?.state === 'completed') && fs.readFileSync(results[1].to, 'utf8').includes('hi'));
  await click(`/api/videos/${v.id}/action-plan?download=1`);
  check('downloads leave the window on its page', wc.getURL() === at && !!(await until(() => results.length >= 2)));

  // Closing
  w.setBounds({ x: 40, y: 60, width: 1100, height: 760 });
  const expected = w.getNormalBounds();
  w.close();
  await until(() => w.isDestroyed());
  check('closing leaves the app running and frees the window', !library.isOpen());
  check('the size and place are remembered', JSON.stringify(store.getSettings().libraryBounds) === JSON.stringify(expected), JSON.stringify(store.getSettings().libraryBounds));
  const w2 = library.createLibraryWindow('/', { showWhenLoaded: false });
  check('reopening returns to them', JSON.stringify(w2.getBounds()) === JSON.stringify(expected), JSON.stringify(w2.getBounds()));
  check('min size is set', w2.getMinimumSize().join() === '900,600');
  await until(() => !w2.webContents.isLoading());
  check('the owner stays signed in after reopening', (await w2.webContents.executeJavaScript("fetch('/api/me').then((r) => r.json()).then((m) => m.owner)")) === true);
  w2.close();

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  store.flush?.();
  win.setQuitting();
  fs.rmSync(TMP, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FAIL ', e); app.exit(1); });
