// The library window's rules. No windows: the navigation and placement rules are plain functions, and the swipe preload runs with a stand-in window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { classifyNavigation: nav, fitBounds } = require('../../src/main/library-nav');

const O = 'http://localhost:4747';

test('only the local server\'s exact origin stays in the window', () => {
  for (const u of [`${O}/`, `${O}/v/abc`, `${O}/#/settings`, `${O}/edit/abc?x=1`, `blob:${O}/1f2e`]) assert.equal(nav(u, O), 'allow', u);
});

test('web and mail links go to the default apps, look-alikes included', () => {
  for (const u of ['https://github.com/settings/tokens/new', 'https://x.com/intent/tweet', 'mailto:a@b.co?subject=hi',
    'http://localhost:3000/', 'http://127.0.0.1:4747/', 'https://localhost:4747/', 'http://localhost.evil.com:4747/',
    'http://localhost:4747@evil.com/', `http://me:pw@localhost:4747/`]) assert.equal(nav(u, O), 'external', u);
});

test('every other scheme goes nowhere, so a page cannot launch apps or read files', () => {
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'x-apple.systempreferences:com.apple', 'ssh://host', 'blob:https://evil.com/1', 'http://localhost:4747.evil.com/', 'not a url', '']) assert.equal(nav(u, O), 'block', u);
});

const AREA = { x: 0, y: 25, width: 1440, height: 875 }, SIZE = { defaultWidth: 1280, defaultHeight: 840, minWidth: 900, minHeight: 600 };

test('the window returns to where it was', () => {
  const saved = { x: 100, y: 80, width: 1000, height: 700 };
  assert.deepEqual(fitBounds(saved, [AREA], AREA, SIZE), saved);
});

test('a place on an unplugged display, or under the menu bar, falls back to the centre', () => {
  const centred = { x: 80, y: 43, width: 1280, height: 840 };
  assert.deepEqual(fitBounds({ x: 3000, y: 100, width: 1000, height: 700 }, [AREA], AREA, SIZE), centred);
  assert.deepEqual(fitBounds({ x: 100, y: -300, width: 1000, height: 700 }, [AREA], AREA, SIZE), centred);
  assert.deepEqual(fitBounds(undefined, [AREA], AREA, SIZE), centred);
  assert.deepEqual(fitBounds({ x: 'a' }, [AREA], AREA, SIZE), centred);
});

test('a small screen and an undersized saved window are both handled', () => {
  const small = { x: 0, y: 25, width: 1024, height: 700 };
  assert.deepEqual(fitBounds(undefined, [small], small, SIZE), { ...small });
  assert.deepEqual(fitBounds({ x: 10, y: 40, width: 200, height: 100 }, [AREA], AREA, SIZE), { x: 10, y: 40, width: 900, height: 600 });
});

// ---- two-finger swipe ----
function swipeHarness({ pageWide = false } = {}) {
  let wheel, moves = [];
  const root = { scrollWidth: pageWide ? 2000 : 1000, clientWidth: 1000, nodeType: 1 };
  const timers = new Map(); let id = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'library-preload.js'), 'utf8'), {
    window: { addEventListener: (type, fn) => { assert.equal(type, 'wheel'); wheel = fn; } },
    document: { documentElement: root },
    history: { back: () => moves.push('back'), forward: () => moves.push('forward') },
    getComputedStyle: (el) => ({ overflowX: el.overflowX || 'visible' }),
    setTimeout: (fn) => { timers.set(++id, fn); return id; }, clearTimeout: (t) => timers.delete(t), Math,
  });
  const el = { nodeType: 1, parentElement: root, scrollWidth: 100, clientWidth: 100 };
  return {
    moves: () => moves, el,
    send: (deltaX, deltaY = 0, extra = {}) => wheel({ deltaX, deltaY, target: el, ...extra }),
    pause: () => { for (const fn of [...timers.values()]) fn(); timers.clear(); },
  };
}

test('fingers moving right go back, moving left go forward, once per swipe', () => {
  const s = swipeHarness();
  for (let i = 0; i < 12; i++) s.send(-30); // momentum keeps sending events after the first trigger
  assert.deepEqual(s.moves(), ['back']);
  s.pause();
  for (let i = 0; i < 6; i++) s.send(30);
  assert.deepEqual(s.moves(), ['back', 'forward']);
});

test('a vertical scroll with some sideways drift does not navigate', () => {
  const s = swipeHarness();
  for (let i = 0; i < 20; i++) s.send(-20, 60);
  assert.deepEqual(s.moves(), []);
});

test('a small wobble, or going one way and then the other, does not navigate', () => {
  const s = swipeHarness();
  s.send(-100); s.send(90); s.send(-100); s.pause(); s.send(-100);
  assert.deepEqual(s.moves(), []);
});

test('the page keeps sideways gestures it owns: scrollers, its own wheel handlers, wide pages, modifier keys', () => {
  let s = swipeHarness(); s.el.overflowX = 'auto'; s.el.scrollWidth = 900; s.el.clientWidth = 300;
  for (let i = 0; i < 10; i++) s.send(-40);
  assert.deepEqual(s.moves(), [], 'timeline-style scroller');
  s = swipeHarness();
  for (let i = 0; i < 10; i++) s.send(-40, 0, { defaultPrevented: true });
  assert.deepEqual(s.moves(), [], 'page handled it');
  s = swipeHarness({ pageWide: true });
  for (let i = 0; i < 10; i++) s.send(-40);
  assert.deepEqual(s.moves(), [], 'page scrolls sideways');
  for (const k of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) { s = swipeHarness(); for (let i = 0; i < 10; i++) s.send(-40, 0, { [k]: true }); assert.deepEqual(s.moves(), [], k); }
});

// ---- wiring: read as text, because these files need Electron to run ----
const main = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', f), 'utf8');

test('the library window keeps Electron\'s protections on and exposes no bridge', () => {
  const w = main('library-window.js');
  assert.match(w, /contextIsolation: true/); assert.match(w, /nodeIntegration: false/); assert.match(w, /sandbox: true/);
  assert.doesNotMatch(w, /webSecurity: false|allowRunningInsecureContent: true/);
  assert.doesNotMatch(main('library-preload.js'), /require\(|contextBridge|ipcRenderer/);
});

test('nothing opens the library in the browser any more', () => {
  for (const f of ['index.js', 'ipc.js', 'session.js', 'screenshot.js']) assert.doesNotMatch(main(f), /openExternal\(config\.owner/, f);
});
