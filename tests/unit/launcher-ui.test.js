// Phase 7: the recorder bar and the bubble panel. No windows: the HTML and scripts are read as text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
global.self = global; require('../../src/shared/icons.js');
const R = path.join(__dirname, '..', '..', 'src', 'renderer');
const read = (f) => fs.readFileSync(path.join(R, f), 'utf8');

test('every icon the bar and the bubble panel ask for exists', () => {
  const names = new Set(global.IrisIcons.names);
  for (const f of ['launcher/index.html', 'bubble/index.html']) for (const m of read(f).matchAll(/data-icon="([^"]+)"/g)) assert.ok(names.has(m[1]), `${f}: no icon "${m[1]}"`);
  for (const f of ['launcher/launcher.js', 'bubble/bubble.js']) for (const m of read(f).matchAll(/I\.svg\('([^']+)'/g)) assert.ok(names.has(m[1]), `${f}: no icon "${m[1]}"`);
});

test('the bar has exactly the Phase 7 controls, and the ids the self-test drives', () => {
  const html = read('launcher/index.html');
  for (const id of ['x', 'src', 'camBtn', 'micBtn', 'lock', 'more', 'agent', 'start', 'startLabel']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.deepEqual([...html.matchAll(/data-s="(\w+)"/g)].map((m) => m[1]), ['screen', 'window', 'custom', 'camera']);
  assert.match(html, /data-tip="Record for agent"/); assert.match(html, /data-tip="This video is Public"/);
});

test('the More menu has three rows and nothing else', () => {
  const js = read('launcher/launcher.js'), body = js.slice(js.indexOf('function paintMore'), js.indexOf('function head'));
  assert.equal([...body.matchAll(/mrow\(/g)].length, 3);
  for (const t of ['Speaker notes', 'Backgrounds', 'Recording settings']) assert.ok(body.includes(t), t);
});

test('every old launcher option is still inside two clicks (bar, or More -> a page)', () => {
  const js = read('launcher/launcher.js'), settings = js.slice(js.indexOf('function paintSettings'), js.indexOf('function paintEffects'));
  for (const k of ["'countdown'", "'sysAudio'", "'hideMenu'", "'cursorFx'", "'clickFx'", "'pg'", 'C.QUALITIES', 'screenshot:start', 'library:open']) assert.ok(settings.includes(k), k);
  const fx = js.slice(js.indexOf('function paintEffects'), js.indexOf('function paintDisplayMenu'));
  assert.ok(fx.includes('C.FILTER_KEYS') && fx.includes('C.FRAME_KEYS'));
});

test('the bubble panel: a 3-stop size slider, four shapes, filters and frames, power', () => {
  const html = read('bubble/index.html');
  assert.match(html, /id="size"[^>]*max="2"[^>]*step="1"/);
  assert.deepEqual([...html.matchAll(/data-v="(squircle|circle|landscape|portrait)"/g)].map((m) => m[1]), ['squircle', 'circle', 'landscape', 'portrait']);
  assert.match(html, /id="power"/); assert.match(html, /id="styl"/);
});
