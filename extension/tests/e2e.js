// End-to-end check of the Kairos extension in a real Chromium: loads it unpacked and drives the launcher with real mouse clicks.
//   npm run test:ext:e2e   (optional: PLAYWRIGHT_CORE=/path/to/playwright-core, PLAYWRIGHT_CHROMIUM=/path/to/Chromium binary)
// What it covers: launcher and its three buttons, per-site turn-off (and undo), the countdown (and Esc), the camera bubble on a page with a strict
// Content-Security-Policy, pause/resume, the control bar, saving to the library, and the saved file. What it cannot cover: Chrome's native screen
// picker (nobody can click it from a script), so the "screen" is an animated test pattern the recorder draws when the test sets __testFakeScreen.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core')); } catch { console.error('This test needs playwright-core and its Chromium: npm i -D playwright-core  (or point PLAYWRIGHT_CORE at an install)'); process.exit(2); }

// Find a full Chromium (extensions do not work in the headless shell): env override, playwright's own build, else the newest one in the cache.
const chromiumPath = () => {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch {}
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  try {
    const dirs = fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => parseInt(b.slice(9), 10) - parseInt(a.slice(9), 10));
    for (const d of dirs) { const p = path.join(cache, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'); if (fs.existsSync(p)) return p; }
  } catch {}
  return null;
};
const CHROMIUM = chromiumPath();
if (!CHROMIUM) { console.error('No Chromium found. Install one with: npx playwright-core install chromium  (or set PLAYWRIGHT_CHROMIUM=/path/to/Chromium)'); process.exit(2); }

const EXT = path.resolve(__dirname, '..');
const FFMPEG = (() => { try { return require(path.resolve(EXT, '..', 'node_modules', 'ffmpeg-static')); } catch { return null; } })();
const OUT = process.env.E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-e2e-'));

let passed = 0; const failed = [];
const check = (name, ok, extra) => { if (ok) { passed++; console.log('  ok  ' + name); } else { failed.push(name); console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A page that looks like a locked-down web app: it forbids framing anything, so it proves the camera bubble still loads.
// /strict is the harshest case: no inline styles at all and Trusted Types enforced (some Google apps do this).
const server = http.createServer((req, res) => {
  const strict = req.url === '/strict';
  res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': strict
    ? "default-src 'none'; style-src 'self'; script-src 'self'; frame-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'"
    : "default-src 'self'; frame-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'" });
  res.end(strict ? '<!doctype html><title>Strict page</title><body><h1>Strict page</h1></body>'
    : '<!doctype html><title>Test inbox</title><body style="font:16px sans-serif;background:#fafbff"><h1>Test inbox</h1><p>Pretend this is Gmail.</p></body>');
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const A = `http://127.0.0.1:${port}/`, B = `http://localhost:${port}/`;   // two different "sites" for the per-site switch

  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-profile-')), {
    executablePath: CHROMIUM, headless: false, viewport: { width: 1100, height: 700 },
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-fake-ui-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const extUrl = (p) => `chrome-extension://${extId}/${p}`;
  const getState = () => sw.evaluate(async () => (await chrome.storage.session.get('rec')).rec || null);
  const waitPhase = async (phase, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const s = await getState(); if (s && s.phase === phase) return s; await sleep(100); } throw new Error('never reached phase ' + phase + ' (now ' + JSON.stringify(await getState()) + ')'); };
  const libraryRecs = async () => { const p = await ctx.newPage(); await p.goto(extUrl('library.html')); const r = await p.evaluate(async () => (await KairosDB.listRecordings()).map(({ blob, thumb, ...m }) => m)); await p.close(); return r; };
  await sleep(500);
  for (const p of ctx.pages()) if (p.url().includes('library.html')) await p.close();   // the welcome tab opened on install
  await sw.evaluate(() => chrome.storage.local.set({ __testFakeScreen: true }));

  const page = await ctx.newPage();
  const L = (sel) => page.locator(sel);
  async function openSite(url) { await page.goto(url); await page.waitForSelector('kairos-recorder', { state: 'attached', timeout: 8000 }).catch(() => {}); }

  console.log('launcher');
  await openSite(A);
  check('launcher mounts on a page with a strict CSP', await L('kairos-recorder').count() === 1);
  check('the main button is the Kairos logo, with no words', (await L('.pill').innerText()).trim() === '' && await L('.pill svg polygon').count() === 6 && (await L('.pill').getAttribute('aria-label')).includes('Kairos'));
  check('the three round buttons are hidden until hover', await L('.stack').evaluate((n) => getComputedStyle(n).opacity) === '0');
  await L('.pill').hover();
  await sleep(300);
  check('hovering shows the red, person and monitor buttons', await L('[data-act="disable"]').isVisible() && await L('[data-act="camera"]').isVisible() && await L('[data-act="screen"]').isVisible());
  await L('[data-act="camera"]').hover(); await sleep(200);
  await page.screenshot({ path: path.join(OUT, 'launcher.png'), clip: { x: 0, y: 360, width: 420, height: 340 } });
  const colors = await page.evaluate(() => { const r = document.querySelector('kairos-recorder').shadowRoot; const fg = (s) => getComputedStyle(r.querySelector(s)).color; return { off: fg('[data-act="disable"]'), cam: fg('[data-act="camera"]'), scr: fg('[data-act="screen"]') }; });
  check('power button is alert red, the other two are ink', colors.off === 'rgb(255, 90, 78)' && colors.cam !== colors.off && colors.scr !== colors.off, JSON.stringify(colors));

  console.log('the strictest page rules');
  const strict = await ctx.newPage();
  await strict.addInitScript(() => { window.__v = []; document.addEventListener('securitypolicyviolation', (e) => window.__v.push(e.effectiveDirective)); });
  await strict.goto(A + 'strict');
  await strict.waitForSelector('kairos-recorder', { state: 'attached', timeout: 8000 }).catch(() => {});
  const look = await strict.evaluate(() => { const h = document.querySelector('kairos-recorder'); if (!h) return null; const pill = h.shadowRoot.querySelector('.pill'); return { bg: getComputedStyle(pill).backgroundColor, h: Math.round(pill.getBoundingClientRect().height), violations: window.__v }; });
  check('no inline styles + Trusted Types: the launcher is drawn properly and breaks no page rule', !!look && look.bg === 'rgb(11, 11, 12)' && look.h === 60 && look.violations.length === 0, JSON.stringify(look));
  await strict.close();

  console.log('tabs that have no button yet');
  check('the worker looked through the open tabs once when it started', await sw.evaluate(async () => (await chrome.storage.session.get('injected')).injected) === true);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0].id, A);
  check('a tab with a working button answers the worker', await sw.evaluate((id) => hasLauncher(id), tabId));
  // Make the tab look like one that was open before Kairos was installed: take its copy of the button away.
  await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, func: () => { self.__kairos.destroy(); delete self.__kairos; } }), tabId);
  check('(setup) the tab has no button now', await L('kairos-recorder').count() === 0 && !(await sw.evaluate((id) => hasLauncher(id), tabId)));
  const fixer = await ctx.newPage(); await fixer.goto(extUrl('popup.html'));       // what the toolbar popup does for the tab it was opened on
  const fixed = await fixer.evaluate((id) => chrome.runtime.sendMessage({ t: 'ensureLauncher', tabId: id }), tabId); await fixer.close();
  await page.bringToFront();
  await page.waitForSelector('kairos-recorder', { state: 'attached', timeout: 5000 }).catch(() => {});
  check('opening the popup puts the button on a tab that has none, no refresh', !!fixed && fixed.ok === true && await L('[data-act="both"]').isVisible());
  await page.evaluate(() => { document.querySelector('kairos-recorder').dataset.same = '1'; });
  await sw.evaluate(() => injectIntoOpenTabs());
  check('the worker leaves a tab that already has a working button alone', await L('kairos-recorder').count() === 1 && await page.evaluate(() => document.querySelector('kairos-recorder').dataset.same === '1'));
  await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: CONTENT_FILES }), tabId);
  await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: CONTENT_FILES }), tabId);
  await sleep(300);
  check('injecting a copy twice never leaves two buttons', await L('kairos-recorder').count() === 1 && await L('[data-act="both"]').isVisible());

  console.log('a dead button left in a tab');
  // What an unloaded extension looks like to its old copy: chrome.runtime.id is gone.
  await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, func: () => { self.__realId = chrome.runtime.id; Object.defineProperty(chrome.runtime, 'id', { get: () => undefined, configurable: true }); } }), tabId);
  check('(setup) the dead copy no longer answers the worker', !(await sw.evaluate((id) => hasLauncher(id), tabId)));
  await L('.pill').click(); await sleep(300);
  check('clicking it says what to do instead of doing nothing', (await L('[data-toast-text]').innerText()).includes('Refresh this page') && (await getState() || { phase: 'idle' }).phase === 'idle');
  await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, func: () => { Object.defineProperty(chrome.runtime, 'id', { get: () => self.__realId, configurable: true }); } }), tabId);   // put it back for the rest of the run
  await sleep(300);

  console.log('the extension is reloaded while a tab is open');
  await page.evaluate(() => { document.querySelector('kairos-recorder').dataset.old = '1'; });
  const nextWorker = ctx.waitForEvent('serviceworker', { timeout: 15000 });
  await sw.evaluate(() => chrome.runtime.reload()).catch(() => {});                // the worker dies mid-call, so the call itself fails
  sw = await nextWorker;
  let replaced = false;
  for (let i = 0; i < 50 && !replaced; i++) { replaced = await page.evaluate(() => { const n = document.querySelectorAll('kairos-recorder'); return n.length === 1 && !n[0].dataset.old; }); if (!replaced) await sleep(200); }
  check('the old button is replaced by a working one without refreshing the tab', replaced && await sw.evaluate((id) => hasLauncher(id), tabId));
  await L('.pill').hover(); await sleep(250);
  check('and hovering it still shows the three round buttons', await L('[data-act="camera"]').isVisible());

  console.log('a web page cannot press the buttons');
  await page.evaluate(() => document.querySelector('kairos-recorder').shadowRoot.querySelector('[data-act="screen"]').click());
  await sleep(500);
  check('a script-made click does not start a recording', (await getState() || { phase: 'idle' }).phase === 'idle');

  console.log('turn off on this site');
  await L('.pill').hover(); await sleep(200);
  await L('[data-act="disable"]').click();
  await sleep(400);
  check('launcher disappears after the red button', await L('[data-act="both"]').count() === 0 || !(await L('[data-act="both"]').isVisible()));
  check('toast names the site and offers Undo', (await L('[data-toast-text]').innerText()).includes('127.0.0.1') && await L('[data-toast-act]').isVisible());
  const disabledList = await sw.evaluate(async () => (await chrome.storage.local.get('disabledSites')).disabledSites);
  check('the site is saved as turned off', JSON.stringify(disabledList) === JSON.stringify(['127.0.0.1']), JSON.stringify(disabledList));
  await L('[data-toast-act]').click(); await sleep(400);
  check('Undo brings the launcher back', await L('[data-act="both"]').isVisible());
  await L('.pill').hover(); await sleep(200); await L('[data-act="disable"]').click(); await sleep(300);
  await page.reload(); await sleep(1200);
  check('still off after a reload', await L('kairos-recorder').count() === 0);
  await openSite(B);
  check('a different site (localhost) still shows the launcher', await L('[data-act="both"]').isVisible());
  await sw.evaluate(() => chrome.storage.local.set({ disabledSites: [] }));
  await openSite(A);
  check('turning it back on (popup switch) shows the launcher again', await L('[data-act="both"]').isVisible());

  console.log('Esc cancels the countdown');
  await L('.pill').hover(); await sleep(200);
  await L('[data-act="screen"]').click();
  await waitPhase('countdown');
  check('countdown overlay is visible', await L('[data-countdown]').isVisible());
  await page.keyboard.press('Escape');
  await sleep(600);
  check('Esc returns to idle and nothing is saved', (await getState()).phase === 'idle' && (await libraryRecs()).length === 0);
  await sleep(500);

  console.log('permissions page hands back to the recording that was waiting');
  await sw.evaluate(() => chrome.storage.session.set({ pendingStart: { mode: 'screen', tabId: null } }));
  const perm = await ctx.newPage(); await perm.goto(extUrl('permissions.html?need=mic&mode=screen'));
  await waitPhase('countdown');
  await sleep(400);
  check('permissions tab closes itself and the waiting recording starts', perm.isClosed() && (await getState()).mode === 'screen');
  const ctl = await ctx.newPage(); await ctl.goto(extUrl('popup.html'));
  await ctl.evaluate(() => chrome.runtime.sendMessage({ t: 'cancel' })); await ctl.close();
  await waitPhase('idle'); await sleep(3500);   // let the cancelled setup flow wake from its countdown and prove it leaves the next recording alone

  console.log('camera only (person button)');
  await page.bringToFront(); await L('.pill').hover(); await sleep(200);
  await L('[data-act="camera"]').click();
  const cd = await waitPhase('countdown');
  check('camera-only: bubble appears during the countdown, larger preview', await L('[data-bubble]').isVisible() && (await L('[data-bubble]').boundingBox()).width === 260);
  const frame = page.frames().find((f) => f.url().includes('bubble.html'));
  check('the camera iframe loaded despite frame-src none', !!frame);
  await waitPhase('recording');
  const camPixels = frame ? await frame.evaluate(() => new Promise((r) => { const v = document.getElementById('v'); const t = setInterval(() => { if (v.videoWidth) { clearInterval(t); r(v.videoWidth); } }, 100); setTimeout(() => r(0), 4000); })) : 0;
  check('the camera picture is live in the bubble', camPixels > 0, String(camPixels));
  check('the recording bar shows a running timer', await L('[data-bar]').isVisible());
  await sleep(2200);
  const t1 = await L('[data-time]').innerText();
  await L('[data-act="pause"]').click(); await waitPhase('paused');
  await sleep(1200);
  const t2 = await L('[data-time]').innerText(), t3 = await (async () => { await sleep(1200); return L('[data-time]').innerText(); })();
  check('pause stops the timer', t2 === t3 && t1 !== '0:00', `${t1} / ${t2} / ${t3}`);
  await L('[data-act="resume"]').click(); await waitPhase('recording');
  await sleep(1500);
  const popup = await ctx.newPage(); await popup.goto(extUrl('popup.html'));
  check('the toolbar popup shows the live recording', await popup.locator('#live').isVisible());
  await popup.close();
  await page.bringToFront();
  await L('[data-act="stop"]').click();
  await waitPhase('idle', 20000);
  let libPage = ctx.pages().find((p) => p.url().includes('library.html#/v/'));
  for (let i = 0; !libPage && i < 30; i++) { await sleep(200); libPage = ctx.pages().find((p) => p.url().includes('library.html#/v/')); }
  check('Stop opens the recording in the library', !!libPage);
  const camRec = (await libraryRecs())[0];
  check('saved as a camera-only recording with sound', camRec && camRec.mode === 'camera' && camRec.hasAudio === true && camRec.size > 5000, JSON.stringify(camRec));
  check('duration excludes the pause (about 5 s of 8 s on the clock)', camRec && camRec.durationMs > 3000 && camRec.durationMs < 7500, String(camRec && camRec.durationMs));
  if (libPage) {
    await libPage.waitForSelector('#video'); await sleep(1200);
    const vid = await libPage.evaluate(() => { const v = document.getElementById('video'); return { w: v.videoWidth, h: v.videoHeight, d: v.duration, err: v.error && v.error.code }; });
    check('the library plays it (has a picture and a duration)', vid.w > 0 && vid.d > 1 && !vid.err, JSON.stringify(vid));
    await libPage.screenshot({ path: path.join(OUT, 'player.png') });
    await libPage.close();
  }

  console.log('screen only (monitor button)');
  await page.bringToFront(); await L('.pill').hover(); await sleep(200);
  await L('[data-act="screen"]').click();
  await waitPhase('countdown');
  check('screen-only: no camera bubble', await L('[data-bubble]').isVisible() === false);
  await page.screenshot({ path: path.join(OUT, 'countdown.png') });
  await waitPhase('recording');
  await page.screenshot({ path: path.join(OUT, 'recording-bar.png'), clip: { x: 0, y: 560, width: 520, height: 140 } });
  await sleep(2500);
  await L('[data-act="stop"]').click();
  await waitPhase('idle', 20000);
  await sleep(800);
  const recs = await libraryRecs();
  const scr = recs.find((r) => r.mode === 'screen');
  check('saved as a screen-only recording', !!scr && scr.size > 5000, JSON.stringify(scr));
  for (const p of ctx.pages()) if (p.url().includes('library.html')) await p.close();

  console.log('screen + cam (pill)');
  await page.bringToFront();
  await L('.pill').click();
  await waitPhase('countdown');
  check('both: bubble at the normal size', await L('[data-bubble]').isVisible() && (await L('[data-bubble]').boundingBox()).width === 180);
  await waitPhase('recording');
  await sleep(600);
  await page.screenshot({ path: path.join(OUT, 'both-recording.png') });
  // the dock and the bubble can be dragged
  const grip = await L('[data-grip]').boundingBox();
  const barBefore = await L('[data-dock]').boundingBox();
  await page.mouse.move(grip.x + 4, grip.y + 12); await page.mouse.down(); await page.mouse.move(grip.x + 164, grip.y - 100, { steps: 6 }); await page.mouse.up();
  const barAfter = await L('[data-dock]').boundingBox();
  check('the control bar can be dragged by its grip', barAfter.x > barBefore.x + 100 && barAfter.y < barBefore.y - 60, JSON.stringify([barBefore, barAfter]));
  await L('[data-act="collapse"]').click(); await sleep(200);
  check('"hide controls" shrinks the bar to a dot', (await L('[data-bar]').boundingBox()).width < 40);
  await L('[data-act="expand"]').click({ force: true }); await sleep(200);
  check('the dot expands again', (await L('[data-bar]').boundingBox()).width > 100);
  await sleep(1500);
  await L('[data-act="stop"]').click();
  await waitPhase('idle', 20000);
  await sleep(800);
  const both = (await libraryRecs()).find((r) => r.mode === 'both');
  check('saved as a screen + cam recording', !!both && both.size > 5000);

  console.log("Chrome's own \"Stop sharing\" button");
  await page.bringToFront(); await L('.pill').hover(); await sleep(200);
  await L('[data-act="screen"]').click();
  await waitPhase('recording'); await sleep(1800);
  // Chrome fires "ended" on the screen track when the person presses its Stop sharing bar. Fire the same event in the recorder page.
  const cdp = await ctx.newCDPSession(page);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const off = targetInfos.find((t) => t.url.endsWith('/offscreen.html'));
  check('the offscreen recorder page exists while recording', !!off);
  if (off) {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: off.targetId, flatten: false });
    await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "s.stream.getVideoTracks()[0].dispatchEvent(new Event('ended'))" } }) });
  }
  await waitPhase('idle', 20000); await sleep(800);
  const afterEnd = await libraryRecs();
  check('"Stop sharing" saves the recording', afterEnd.filter((r) => r.mode === 'screen').length === 2, JSON.stringify(afterEnd.map((r) => r.mode)));
  for (const p of ctx.pages()) if (p.url().includes('library.html')) await p.close();

  console.log("Chrome's real screen picker (no test pattern)");
  // The picker is auto-answered by a Chromium switch, but everything else is the real path: getDisplayMedia in the recorder, a real screen stream, MediaRecorder.
  await sw.evaluate(() => chrome.storage.local.set({ __testFakeScreen: false }));
  await page.bringToFront(); await L('.pill').hover(); await sleep(200);
  await L('[data-act="screen"]').click();
  await waitPhase('recording', 20000); await sleep(2500);
  await L('[data-act="stop"]').click();
  await waitPhase('idle', 20000); await sleep(800);
  const real = (await libraryRecs()).filter((r) => r.mode === 'screen');
  check('a real screen recording was saved (not the test pattern)', real.length === 3 && real[real.length - 1].size > 3000, JSON.stringify(real.map((r) => r.size)));
  await sw.evaluate(() => chrome.storage.local.set({ __testFakeScreen: true }));
  for (const p of ctx.pages()) if (p.url().includes('library.html')) await p.close();

  console.log('crash recovery');
  const rec = await ctx.newPage(); await rec.goto(extUrl('library.html'));
  await rec.evaluate(async () => { await KairosDB.putChunk('rzzzzzzzz1', 0, new Blob([new Uint8Array(4000)], { type: 'video/webm' })); await KairosDB.putChunk('rzzzzzzzz1', 1, new Blob([new Uint8Array(4000)], { type: 'video/webm' })); });
  await rec.reload(); await rec.waitForSelector('.card'); await sleep(500);
  const recovered = await rec.evaluate(async () => ({ list: (await KairosDB.listRecordings()).filter((r) => r.recovered).map((r) => [r.title, r.size]), chunksLeft: (await KairosDB.orphanedRecordingIds()).length }));
  check('chunks left behind by a crash become a "Recovered recording"', recovered.list.length === 1 && recovered.list[0][1] === 8000 && recovered.chunksLeft === 0, JSON.stringify(recovered));
  await rec.evaluate(async () => { for (const r of await KairosDB.listRecordings()) if (r.recovered) await KairosDB.deleteRecording(r.id); });
  await rec.close();

  console.log('discard');
  await page.bringToFront(); await sleep(300);
  await L('.pill').hover(); await sleep(200);
  await L('[data-act="screen"]').click();
  await waitPhase('recording');
  const before = (await libraryRecs()).length;
  await L('[data-act="cancel"]').click();
  await waitPhase('idle');
  await sleep(500);
  check('discard saves nothing and leaves no chunks behind', (await libraryRecs()).length === before && (await (async () => { const p = await ctx.newPage(); await p.goto(extUrl('library.html')); const n = await p.evaluate(async () => (await KairosDB.orphanedRecordingIds()).length); await p.close(); return n; })()) === 0);
  for (const p of ctx.pages()) if (p.url().includes('library.html')) await p.close();

  console.log('the welcome page');
  const welcome = await ctx.newPage(); await welcome.goto(extUrl('library.html#/welcome')); await sleep(600);
  check('it shows what the button looks like and offers "Show me the button"', await welcome.locator('.demo-pill').isVisible() && await welcome.locator('.demo-orb').count() === 3 && await welcome.locator('#tryit').isVisible());
  await welcome.screenshot({ path: path.join(OUT, 'welcome.png') });
  await welcome.close();

  console.log('the saved file');
  const lib = await ctx.newPage(); await lib.goto(extUrl('library.html')); await sleep(800);
  await lib.screenshot({ path: path.join(OUT, 'library.png') });
  const exported = await lib.evaluate(async () => { const r = (await KairosDB.listRecordings()).find((x) => x.mode === 'both'); const buf = new Uint8Array(await r.blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return { ext: r.ext, b64: btoa(s), durationMs: r.durationMs }; });
  const file = path.join(OUT, 'both.' + exported.ext);
  fs.writeFileSync(file, Buffer.from(exported.b64, 'base64'));
  if (FFMPEG) {
    let info = '';
    try { execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { info = String(e.stderr || ''); }
    check('ffmpeg reads a video and an audio stream from the file', /Video:/.test(info) && /Audio:/.test(info), info.split('\n').filter((l) => /Stream|Duration/.test(l)).join(' | '));
    check('the video is 1280x720 (the test screen)', /1280x720/.test(info));
  }
  await lib.close();

  await ctx.close(); server.close();
  console.log(`\n${passed} passed, ${failed.length} failed. Screenshots and the saved file: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('E2E crashed:', e); server.close(); process.exit(2); });
