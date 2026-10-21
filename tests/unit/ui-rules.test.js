'use strict';
// Enforces the UI rules on UI source: no emoji, no purple hues, no gradients,
// no third-party requests. A line (or the line above) carrying
// "ui-rules: allow" is exempt (user-chosen creative options only).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const EXT = /\.(html|css|js)$/;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.test(e.name)) out.push(p);
  }
  return out;
}

const files = [
  ...fs.readdirSync(path.join(ROOT, 'src/server/public'))
    .filter((f) => EXT.test(f)).map((f) => path.join(ROOT, 'src/server/public', f)),
  path.join(ROOT, 'src/shared/ui.css'),
  path.join(ROOT, 'src/shared/icons.js'),
  ...walk(path.join(ROOT, 'src/renderer')),
].filter((f) => fs.existsSync(f));

const ALLOW = 'ui-rules: allow';
const EMOJI = /\p{Extended_Pictographic}/u;
const GRADIENT = /gradient\(/;
const URL_RE = /https?:\/\/[^\s'"`)<>]+/g;
// Allowed: local hosts, placeholders, svg namespaces, the LAN-address template,
// and user-clicked share/help link-outs (target=_blank anchors: not requests the app makes).
const OK_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|example\.(com|org|net)|www\.w3\.org\/|\$\{|…|kairos-links\.yourname\.workers\.dev|hooks\.slack\.com\/services\/|github\.com\/settings\/tokens\/new|x\.com\/intent\/tweet|www\.linkedin\.com\/sharing\/|wa\.me\/)/i;
const BAD_HOST = /fonts\.googleapis|gstatic|tailwindcss|cdnjs|unpkg|jsdelivr/i;

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}
function purple({ h, s }) { return s > 0.15 && h >= 255 && h <= 320; }

function colourHits(line) {
  const hits = [];
  for (const m of line.matchAll(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi)) {
    let x = m[1];
    if (x.length <= 4) x = x.split('').map((c) => c + c).join('');
    const hsl = rgbToHsl(parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16));
    if (purple(hsl)) hits.push(m[0]);
  }
  for (const m of line.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/gi)) {
    if (purple(rgbToHsl(+m[1], +m[2], +m[3]))) hits.push(m[0]);
  }
  for (const m of line.matchAll(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%/gi)) {
    if (purple({ h: ((+m[1] % 360) + 360) % 360, s: +m[2] / 100 })) hits.push(m[0]);
  }
  return hits;
}

function scan() {
  const out = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const rel = path.relative(ROOT, f);
    lines.forEach((line, i) => {
      const allowed = line.includes(ALLOW) || (i > 0 && lines[i - 1].includes(ALLOW));
      const add = (rule, what) => out.push(`${rel}:${i + 1} [${rule}] ${what}`);
      if (line.includes(ALLOW)) return;
      if (EMOJI.test(line)) add('emoji', line.match(EMOJI)[0] + ' ' + line.trim().slice(0, 80));
      if (!allowed) {
        for (const h of colourHits(line)) add('purple', h);
        if (GRADIENT.test(line)) add('gradient', line.trim().slice(0, 80));
      }
      for (const u of line.match(URL_RE) || []) {
        if (BAD_HOST.test(u) || !OK_URL.test(u)) add('third-party', u);
      }
    });
  }
  return out;
}

test('UI source follows the rules (no emoji, purple, gradients, third-party URLs)', () => {
  assert.ok(files.length > 10, 'UI files found');
  const v = scan();
  assert.deepStrictEqual(v, [], '\n' + v.join('\n'));
});

test('colour detector flags purple and passes emerald', () => {
  assert.ok(colourHits('#7c3aed').length);
  assert.ok(colourHits('rgba(139,92,246,.5)').length);
  assert.ok(colourHits('hsl(270, 60%, 50%)').length);
  assert.equal(colourHits('#047857 #64748b #dc2626').length, 0);
});
