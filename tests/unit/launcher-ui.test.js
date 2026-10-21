// Phase 7: the recorder bar and the bubble panel. No windows: the HTML and scripts are read as text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
global.self = global; require('../../src/shared/icons.js');
const R = path.join(__dirname, '..', '..', 'src', 'renderer');
const read = (f) => fs.readFileSync(path.join(R, f), 'utf8');

test('every icon the bar and the bubble panel ask for exists', () => {
  const names = new Set(global.KairosIcons.names);
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

test('the bubble panel: a continuous size slider, four shapes, filters and frames, power', () => {
  const html = read('bubble/index.html');
  assert.match(html, /id="size"[^>]*min="120"[^>]*max="420"/);
  assert.deepEqual([...html.matchAll(/data-v="(squircle|circle|landscape|portrait)"/g)].map((m) => m[1]), ['squircle', 'circle', 'landscape', 'portrait']);
  assert.match(html, /id="power"/); assert.match(html, /id="styl"/);
});

// The overlay windows float over the user's screen, so they stay dark glass, but they share one palette with the web UI:
// slate neutrals, one emerald accent, error red, amber for warnings. No emoji anywhere, no blue or purple, no decorative gradient.
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const overlayFiles = () => [...walk(R), path.join(R, '..', 'shared', 'ui.css')].filter((f) => /\.(css|js|html)$/.test(f));

test('overlay windows: no emoji or pictographs in any renderer file', () => {
  const PICT = /[\p{Extended_Pictographic}\u{FE0F}\u{1F1E6}-\u{1F1FF}✓✔✕✖]/u;
  for (const f of overlayFiles()) fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => assert.doesNotMatch(l, PICT, `${path.relative(R, f)}:${i + 1}`));
});

test('overlay windows: one palette (emerald + slate + red + amber), no blue or purple, no third-party fonts', () => {
  const ui = fs.readFileSync(path.join(R, '..', 'shared', 'ui.css'), 'utf8');
  assert.match(ui, /--accent:\s*#047857/); assert.match(ui, /--accent-lt:\s*#34d399/);
  assert.doesNotMatch(ui, /--blue\b|display-p3/);
  assert.match(ui, /--font:\s*"Geist"/); assert.match(ui, /--mono:\s*"JetBrains Mono"/);
  const hue = (hex) => { // [hue in degrees, HSL saturation]
    const n = hex.length === 3 ? [...hex].map((c) => parseInt(c + c, 16)) : [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [r, g, b] = n.map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0];
    const s = d / (1 - Math.abs(2 * l - 1)), h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s];
  };
  for (const f of overlayFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /@font-face|fonts\.googleapis|https?:\/\//, `${path.relative(R, f)}: nothing is downloaded`);
    for (const m of text.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
      const [h, s] = hue(m[1]);
      assert.ok(!(s > 0.6 && h >= 190 && h <= 320) && !(s > 0.4 && h > 235 && h <= 320), `${path.relative(R, f)}: #${m[1]} is a blue, indigo or purple accent`); // slate (hue ~215, low saturation) is the neutral and is allowed
    }
  }
});

test('overlay windows: a gradient is allowed only as a one-colour functional fill, and says so', () => {
  for (const f of overlayFiles()) fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (/gradient\(/.test(l)) assert.match(l, /ui-rules: allow/, `${path.relative(R, f)}:${i + 1}`); });
});

test('the default hand signs are drawn as SVG, not emoji', () => {
  const js = read('launcher/launcher.js');
  assert.match(js, /const DEFAULT_SK = \{/); assert.match(js, /defaultSign\(r\.id\)/); assert.doesNotMatch(js, /r\.emoji/);
});
