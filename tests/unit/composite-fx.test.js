// Phase 2 composite: camera filters, frame rings, the Privacy Guard side outputs, and snapshots of the full ffmpeg arguments for four representative timelines.
// Snapshots live in tests/unit/composite.snap.json. After an intended change, regenerate them with UPDATE_SNAPSHOTS=1 npm test and review the diff.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildComposite, SCAN_FPS, HASH_W, HASH_H } = require('../../src/pipeline/composite');
const { ffmpeg, runFfmpeg } = require('../../src/pipeline/encode');
const { ensureMask, ensureFrame } = require('../../src/pipeline/masks');
const { FILTERS, filterChain, FRAMES } = require('../../src/pipeline/filters');
const C = require('../../src/shared/constants');

const base = (over = {}) => ({ version: 2, mode: 'screen-cam', quality: 'source', crop: null, bubbleSpace: 'display', audio: true, screen: { width: 2880, height: 1800 }, cam: { width: 1920, height: 1080 }, segments: [], bubble: [], ...over });
const seg = (n, dur) => ({ n, dur, screen: `/v/screen_${n}.mp4`, cam: `/v/cam_${n}.mp4` });
const mask = (s, w, h) => `/m/${s}_${w}x${h}.png`;
const frame = (f, s, w, h) => `/m/frame_${f}_${s}_${w}x${h}.png`;
const build = (tl, inputs, opts = {}) => buildComposite(tl, inputs, { out: '/o.mp4', hw: true, maskPath: mask, framePath: frame, ...opts });

test('every filter and frame the UI offers has an ffmpeg equivalent', () => {
  for (const k of C.FILTER_KEYS) assert.ok(k in FILTERS, `filter ${k}`);
  for (const k of C.FRAME_KEYS) assert.ok(k in FRAMES, `frame ${k}`);
  assert.equal(filterChain('none'), ''); assert.equal(filterChain('nonsense'), '', 'unknown filter = untouched picture');
  assert.match(filterChain('bw'), /hue=s=0/);
  assert.match(filterChain('warm'), /colorchannelmixer=rr=0\.848/, 'sepia(.25) is the identity blended 25% with the sepia matrix');
});

test('a style change (filter or frame) starts its own bubble run with its own mask and frame inputs', () => {
  const tl = base({ bubble: [[0, 0.05, 0.6, 0.1, 0.17, 'circle', 'none', 'ring', 1], [1, 0.05, 0.6, 0.1, 0.17, 'circle', 'vivid', 'ring', 1], [2, 0.05, 0.6, 0.1, 0.17, 'circle', 'vivid', 'none', 1]] });
  const r = build(tl, [seg(0, 3)]);
  assert.deepEqual(r.runs.map((x) => [x.filter, x.frame]), [['none', 'ring'], ['vivid', 'ring'], ['vivid', 'none']]);
  const g = r.args[r.args.indexOf('-filter_complex') + 1];
  assert.match(g, /eq=saturation=1\.6:contrast=1\.1/);
  assert.equal((g.match(/overlay=0:0:format=auto/g) || []).length, 2, 'the run with frame "none" gets no frame overlay');
  assert.equal(r.args.filter((a) => a === '-loop').length, 5, 'mask + frame for two runs, mask only for the third');
});

test('scanDir adds a second and third output from the same graph (JPEGs for OCR, 9x8 gray for the hash) without touching the encode', () => {
  const plain = build(base(), [seg(0, 2)]);
  const scan = build(base(), [seg(0, 2)], { scanDir: '/scan' });
  assert.equal(plain.scan, null);
  assert.deepEqual(scan.scan, { fps: SCAN_FPS, hashSize: HASH_W * HASH_H });
  const g = scan.args[scan.args.indexOf('-filter_complex') + 1];
  assert.match(g, /split=3\[enc\]\[scj\]\[sch\]/);
  assert.match(g, new RegExp(`fps=${SCAN_FPS},scale=${HASH_W}:${HASH_H}:flags=area,format=gray\\[hash\\]`));
  assert.ok(scan.args.includes('/scan/f%04d.jpg') && scan.args.includes('/scan/hash.raw'));
  assert.ok(scan.args.indexOf('/o.mp4') < scan.args.indexOf('/scan/f%04d.jpg'), 'the video is the first output');
});

// ---- snapshots ----
const SNAP = path.join(__dirname, 'composite.snap.json');
const CASES = {
  'screen only, Source, audio': () => build(base({ mode: 'screen', cam: null }), [seg(0, 3.5), seg(1, 2)]),
  'screen + cam, 1080p, bubble moves and restyles': () => build(base({ quality: '1080p', bubble: [
    [0, 0.02, 0.7, 0.1, 0.17, 'circle', 'none', 'ring', 1], [1.5, 0.6, 0.1, 0.1, 0.17, 'circle', 'none', 'ring', 1], [2.5, 0.6, 0.1, 0.14, 0.2, 'squircle', 'warm', 'glow', 1], [4, 0.6, 0.1, 0.14, 0.2, 'squircle', 'warm', 'glow', 0]] }), [seg(0, 3), seg(1, 2)]),
  'custom area + cam, 720p': () => build(base({ quality: '720p', crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, bubble: [[0, 0.3, 0.5, 0.1, 0.16, 'portrait', 'bw', 'gradient', 1]] }), [seg(0, 4)]),
  'cam only, 1080p, software fallback': () => build(base({ mode: 'cam', screen: null, quality: '1080p' }), [seg(0, 3)], { hw: false }),
};
test('ffmpeg arguments for four representative timelines match the snapshots', () => {
  const got = Object.fromEntries(Object.entries(CASES).map(([k, f]) => { const r = f(); return [k, { args: r.args, size: r.size, total: r.total }]; }));
  if (process.env.UPDATE_SNAPSHOTS || !fs.existsSync(SNAP)) { fs.writeFileSync(SNAP, JSON.stringify(got, null, 2) + '\n'); return; }
  assert.deepEqual(got, JSON.parse(fs.readFileSync(SNAP, 'utf8')), 'composite arguments changed; if intended, run UPDATE_SNAPSHOTS=1 npm test');
});

// ---- real ffmpeg ----
const clip = (dir, name, args) => { const f = path.join(dir, name); const r = spawnSync(ffmpeg, ['-y', '-v', 'error', ...args, f]); assert.equal(r.status, 0, String(r.stderr)); return f; };

test('real ffmpeg: every filter and frame renders, and the side outputs hold 2 fps JPEGs plus one 72-byte hash per frame', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-fx-'));
  const s = clip(dir, 'screen_0.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x800:r=60:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const c = clip(dir, 'cam_0.mp4', ['-f', 'lavfi', '-i', 'smptebars=s=640x360:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const bubble = []; C.FILTER_KEYS.forEach((f, i) => bubble.push([i * 0.4, 0.05 + i * 0.1, 0.6, 0.1, 0.16, C.SHAPES[i % 4], f, C.FRAME_KEYS[i % C.FRAME_KEYS.length], 1]));
  const tl = base({ mode: 'screen-cam', audio: false, quality: '720p', screen: { width: 1280, height: 800 }, cam: { width: 640, height: 360 }, bubble });
  const scanDir = path.join(dir, 'scan'); fs.mkdirSync(scanDir);
  const out = path.join(dir, 'out.mp4');
  const plan = buildComposite(tl, [{ n: 0, dur: 2.9, screen: s, cam: c }], { out, hw: false, scanDir,
    maskPath: (sh, w, h) => ensureMask(path.join(dir, 'm'), sh, w, h), framePath: (f, sh, w, h) => ensureFrame(path.join(dir, 'm'), f, sh, w, h) });
  await runFfmpeg(plan.args, { duration: plan.total });
  assert.ok(fs.statSync(out).size > 10000);
  const jpgs = fs.readdirSync(scanDir).filter((f) => f.endsWith('.jpg'));
  const hash = fs.statSync(path.join(scanDir, 'hash.raw')).size;
  assert.ok(Math.abs(jpgs.length - 2.9 * SCAN_FPS) <= 1, `${jpgs.length} jpgs`);
  assert.equal(hash, jpgs.length * HASH_W * HASH_H, 'one hash per JPEG, so frame k of the hash file is jpg k');
  fs.rmSync(dir, { recursive: true, force: true });
});
