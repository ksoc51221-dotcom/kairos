// Camera zoom on the export side: the keyframes in timeline.json, the ffmpeg stage, and (with a real ffmpeg) the pixels that come out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Timeline } = require('../../src/shared/timeline');
const { buildComposite, piecewise, zoomFilter } = require('../../src/pipeline/composite');
const { ffmpeg, runFfmpeg } = require('../../src/pipeline/encode');
const { ensureMask } = require('../../src/pipeline/masks');

const T0 = 1_000_000;
const base = (over = {}) => ({ version: 2, mode: 'screen-cam', quality: 'source', crop: null, bubbleSpace: 'display', audio: false, screen: { width: 640, height: 360 }, cam: { width: 320, height: 180 }, segments: [], bubble: [], ...over });
const seg = (n, dur, extra = {}) => ({ n, dur, screen: `/v/screen_${n}.mp4`, cam: `/v/cam_${n}.mp4`, ...extra });
const mask = (s, w, h) => `/m/${s}_${w}x${h}.png`;
const graph = (r) => r.args[r.args.indexOf('-filter_complex') + 1];

// ---------------- timeline keyframes ----------------
test('timeline: zoom keyframes are recorded at the recorded time, duplicates skipped, a later one at the same time replaces', () => {
  const t = new Timeline({ mode: 'screen-cam', cam: {} });
  assert.deepEqual(t.zoom, []);
  t.start(T0);
  assert.ok(t.setZoom(T0, { cx: 0.5, cy: 0.5, z: 1 }));
  assert.ok(!t.setZoom(T0 + 500, { cx: 0.5, cy: 0.5, z: 1 }), 'no change = no keyframe');
  assert.ok(t.setZoom(T0 + 2000, { cx: 0.31234567, cy: 0.4, z: 2 }));
  assert.ok(t.setZoom(T0 + 2000, { cx: 0.3, cy: 0.35, z: 2.5 }));
  assert.deepEqual(t.zoom, [[0, 0.5, 0.5, 1], [2, 0.3, 0.35, 2.5]]);
  t.stop(T0 + 4000);
  assert.ok(t.setZoom(T0 + 99999, { cx: 0.5, cy: 0.5, z: 1 }), 'while paused the keyframe lands where the recording stands (t = 2.0 + 2.0 = 4)');
  assert.deepEqual(t.zoom[2], [4, 0.5, 0.5, 1]);
  assert.deepEqual(t.toJSON().zoom, t.zoom);
});

test('timeline: a zoom that grew while a sign was held keeps how long the move took, never longer than the recording so far', () => {
  const t = new Timeline({ mode: 'screen-cam', cam: {} });
  t.start(T0);
  t.setZoom(T0 + 1500, { cx: 0.4, cy: 0.45, z: 1.5 }, 1.5);
  t.setZoom(T0 + 3000, { cx: 0.35, cy: 0.4, z: 2.1 }, 1.5);
  t.setZoom(T0 + 3500, { cx: 0.35, cy: 0.4, z: 2.4 }, 9);
  t.setZoom(T0 + 4000, { cx: 0.5, cy: 0.5, z: 1 });
  t.setZoom(T0 + 4100, { cx: 0.5, cy: 0.45, z: 1 }, 0.005);
  assert.deepEqual(t.zoom, [[1.5, 0.4, 0.45, 1.5, 1.5], [3, 0.35, 0.4, 2.1, 1.5], [3.5, 0.35, 0.4, 2.4, 3.5], [4, 0.5, 0.5, 1], [4.1, 0.5, 0.45, 1]], 'a span of 9 s at 3.5 s is 3.5 s; a plain move and a span under 16 ms carry none');
  assert.deepEqual(t.toJSON().zoom, t.zoom);
  assert.ok(!t.setZoom(T0 + 5000, { cx: 0.5, cy: 0.45, z: 1 }), 'the same picture again is still no keyframe');
});

test('timeline: Live Rewind drops the zoom keyframes after the rewind point', () => {
  const t = new Timeline({ cam: {} });
  t.start(T0); t.setZoom(T0 + 1000, { cx: 0.4, cy: 0.4, z: 2 }); t.setZoom(T0 + 3000, { cx: 0.5, cy: 0.5, z: 1 }); t.stop(T0 + 5000);
  t.rewind(2);
  assert.deepEqual(t.zoom, [[1, 0.4, 0.4, 2]]);
});

// ---------------- the ffmpeg stage ----------------
test('piecewise: a longer glide for the zoom, and the default glide for the bubble is unchanged', () => {
  const rows = [[0, 100], [5, 300]], pick = (r) => r[1];
  assert.match(piecewise(rows, pick), /min\(1,\(t-5\)\/0\.2\)/);
  assert.match(piecewise(rows, pick, 0.45), /min\(1,\(t-5\)\/0\.45\)/);
  assert.equal(piecewise([[0, 1], [5, 2]], (r) => r[1], 0.45).includes('1.0000000'), false);
  assert.match(piecewise([[0, 0.1], [4, 0.4]], (r) => r[1], 0.45), /0\.1\+0\.3\*/, 'no 0.30000000000000004');
});

test('piecewise: a row with a span moves evenly over exactly that stretch before its time; the zoom by a constant factor per second, the centre in a line', () => {
  const rows = [[0, 1], [3, 1.9, 3], [4.5, 2.7, 1.5], [8, 1]], pick = (r) => r[1], span = (r) => r[2] || 0;
  const z = piecewise(rows, pick, 0.45, { span, geo: true }), c = piecewise(rows, pick, 0.45, { span });
  assert.match(z, /^if\(lt\(t,0\),1,if\(lt\(t,3\),\(1\*pow\(1\.9,min\(1,\(t-0\)\/3\)\)\),if\(lt\(t,8\),\(1\.9\*pow\(1\.421053,min\(1,\(t-3\)\/1\.5\)\)\),\(2\.7\+-1\.7\*/, z);
  assert.match(c, /\(1\+0\.9\*min\(1,\(t-0\)\/3\)\)/, 'a straight line, no smoothstep: ' + c);
  assert.ok(!/\(t-0\)\/3\)\*min/.test(c));
  // the plain row after the hold glides from the end of the hold, and a plain row that is followed by a hold ends its glide where the hold starts
  assert.match(z, /min\(1,\(t-8\)\/0\.45\)/);
  const squeezed = piecewise([[0, 1], [5, 2], [5.3, 3, 0.2]], pick, 0.45, { span, geo: false });
  assert.match(squeezed, /if\(lt\(t,5\),1,if\(lt\(t,5\.1\),\(1\+1\*min\(1,\(t-5\)\/0\.1\)/, 'the glide to 2 gets only the 0.1 s before the hold begins: ' + squeezed);
  // without opts nothing changes (the bubble's positions)
  assert.equal(piecewise([[0, 1], [3, 1.9, 3]], pick), piecewise([[0, 1], [3, 1.9]], pick));
});

test('composite: no zoom keyframes (or only 1x) leaves the graph exactly as it was', () => {
  const tl = base({ bubble: [[0, 0.05, 0.6, 0.1, 0.17, 'circle', 'none', 'none', 1]] });
  const a = buildComposite(tl, [seg(0, 3)], { out: '/o.mp4', hw: false, maskPath: mask, framePath: () => null });
  const b = buildComposite({ ...tl, zoom: [[0, 0.5, 0.5, 1], [2, 0.5, 0.5, 1]] }, [seg(0, 3)], { out: '/o.mp4', hw: false, maskPath: mask, framePath: () => null });
  assert.deepEqual(a.args, b.args);
  assert.ok(!graph(a).includes('eval=frame'));
});

test('composite: a zoom goes between the camera concat and the bubble scale (screen + camera), and once only however many bubble runs there are', () => {
  const bubble = [[0, 0.05, 0.6, 0.1, 0.17, 'circle', 'none', 'none', 1], [1, 0.05, 0.6, 0.1, 0.17, 'circle', 'bw', 'none', 1]];
  const r = buildComposite(base({ bubble, zoom: [[1, 0.3, 0.4, 2]] }), [seg(0, 3)], { out: '/o.mp4', hw: false, maskPath: mask, framePath: () => null });
  const g = graph(r);
  assert.equal((g.match(/eval=frame/g) || []).length, 1);
  assert.match(g, /\[1:v\]concat=n=1:v=1:a=0\[cc\];\[cc\]scale=320:180,scale=w='/);
  assert.match(g, /\[ccz\];\[ccz\]split=2\[cs0\]\[cs1\]/);
  assert.ok(!/\[cc\]split/.test(g));
});

test('composite: camera-only, the zoom is applied before the output fit', () => {
  const r = buildComposite(base({ mode: 'cam', screen: null, zoom: [[0, 0.5, 0.5, 1], [1, 0.25, 0.25, 2]] }), [seg(0, 3)], { out: '/o.mp4', hw: false, maskPath: mask, framePath: () => null });
  assert.match(graph(r), /concat=n=1:v=1:a=0\[cc0\];\[cc0\]scale=320:180,scale=w='.*eval=frame,crop=320:180:x='.*\[cc0z\];\[cc0z\]scale=320:180:force_original_aspect_ratio=increase/);
});

test('composite: a screen-only recording has no zoom stage even if the timeline carries keyframes', () => {
  const r = buildComposite(base({ mode: 'screen', cam: null, zoom: [[1, 0.3, 0.4, 2]] }), [seg(0, 3)], { out: '/o.mp4', hw: false, maskPath: mask, framePath: () => null });
  assert.ok(!graph(r).includes('eval=frame'));
});

test('composite: a held zoom (rows with a span) reaches the filter graph as an even move', () => {
  const r = buildComposite(base({ mode: 'cam', screen: null, zoom: [[0, 0.5, 0.5, 1], [4, 0.125, 0.125, 4, 4]] }), [seg(0, 6)], { out: '/o.mp4', hw: false, maskPath: mask, framePath: () => null });
  assert.match(graph(r), /pow\(4,min\(1,\(t-0\)\/4\)\)/);
  assert.ok(!/\(3-2\*/.test(graph(r)), 'no smoothstep anywhere: the only move is the hold');
});

test('composite: a held zoom out (the zoom falling, with a span) reaches the filter graph as an even move down, the centre in a line to the middle', () => {
  const r = buildComposite(base({ mode: 'cam', screen: null, zoom: [[0, 0.5, 0.5, 1], [1, 0.125, 0.125, 4], [4, 0.5, 0.5, 1, 2]] }), [seg(0, 6)], { out: '/o.mp4', hw: false, maskPath: mask, framePath: () => null });
  assert.match(graph(r), /\(4\*pow\(0\.25,min\(1,\(t-2\)\/2\)\)\)/, 'z = 4 * (1/4)^u');
  assert.match(graph(r), /\(0\.125\+0\.375\*min\(1,\(t-2\)\/2\)\)/, 'the centre: a straight line');
});

test('zoomFilter: the expression stays small for 40 keyframes', () => {
  const rows = Array.from({ length: 40 }, (_, i) => [i * 3, 0.3 + (i % 5) * 0.05, 0.4 + (i % 3) * 0.05, 1.5 + (i % 4) * 0.5]);
  const f = zoomFilter(rows, 1920, 1080);
  assert.ok(f.length < 40000, 'filter length ' + f.length);
});

// ---------------- real ffmpeg ----------------
const run = (args, o = {}) => { const r = spawnSync(ffmpeg, ['-y', '-v', 'error', ...args], { encoding: o.text ? 'utf8' : null, maxBuffer: 1 << 26 }); assert.equal(r.status, 0, String(r.stderr)); return r.stdout; };
// the whole picture in four colours: x < W/2 -> red 255 else 0, y < H/2 -> green 255 else 0, blue 128. So the top-left quarter is (255, 255, 128), the bottom-right (0, 0, 128).
const quads = (dir, name, w, h, d) => {
  const f = path.join(dir, name);
  run(['-f', 'lavfi', '-i', `nullsrc=s=${w}x${h}:r=10:d=${d},format=gbrp,geq=r='if(lt(X,W/2),255,0)':g='if(lt(Y,H/2),255,0)':b=128`, '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', f]);
  return f;
};
// the colour at (x, y) of the frame at time t, as [r, g, b]; the output is w x h
const px = (file, t, w, h, points) => {
  const buf = run(['-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.equal(buf.length, w * h * 3, 'one frame of ' + w + 'x' + h);
  return points.map(([x, y]) => { const o = (Math.round(y) * w + Math.round(x)) * 3; return [buf[o], buf[o + 1], buf[o + 2]]; });
};
const close = (c, want, tol = 40) => assert.ok(c.every((v, i) => Math.abs(v - want[i]) <= tol), `${c} should be near ${want}`);
const TL = [255, 255, 128], TR = [0, 255, 128], BL = [255, 0, 128], BR = [0, 0, 128];

test('real ffmpeg, camera only: zoom in on the top-left quarter, hold, then back out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-zoom-'));
  try {
    const cam = quads(dir, 'cam_0.mp4', 320, 180, 6);
    const tl = base({ mode: 'cam', screen: null, zoom: [[0, 0.5, 0.5, 1], [1, 0.25, 0.25, 2], [4, 0.5, 0.5, 1]] });
    const out = path.join(dir, 'out.mp4'), plan = buildComposite(tl, [{ n: 0, dur: 5.9, cam }], { out, hw: false, maskPath: mask, framePath: () => null });
    await runFfmpeg(plan.args, { duration: plan.total });
    const corners = [[8, 8], [311, 8], [8, 171], [311, 171]];
    const [a, b, c, d] = px(out, 0.5, 320, 180, corners);
    close(a, TL); close(b, TR); close(c, BL); close(d, BR);                    // before the zoom: the four quarters
    for (const col of px(out, 2.5, 320, 180, [...corners, [160, 90]])) close(col, TL); // zoomed 2x on the top-left quarter: that quarter fills the picture
    const mid = px(out, 1.25, 320, 180, [[8, 8], [311, 171]]);                   // half way through the glide (0.45 s from t = 1): still moving, not a cut
    assert.ok(mid[1][0] < 200 || mid[1][1] < 200, 'the far corner is still leaving at 1.25 s: ' + mid[1]);
    const [e, f, g, h] = px(out, 5.5, 320, 180, corners);                        // back out
    close(e, TL); close(f, TR); close(g, BL); close(h, BR);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// the first x of row y (0 at the left) where the red channel is below half: in the four-colour picture that is the vertical line between the left and right quarters
const edgeX = (file, t, w, h, y) => {
  const buf = run(['-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.equal(buf.length, w * h * 3, 'one frame');
  for (let x = 0; x < w; x++) if (buf[(y * w + x) * 3] < 128) return x;
  return w;
};
test('real ffmpeg, camera only: a held zoom grows evenly while the sign is held (1x to 4x in 4 s), at the pace of the hold, not in one glide', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-zoom-'));
  try {
    const cam = quads(dir, 'cam_0.mp4', 320, 180, 7);
    const tl = base({ mode: 'cam', screen: null, zoom: [[0, 0.5, 0.5, 1], [4, 0.125, 0.125, 4, 4]] }); // the whole hold is one row: 4 s, ending at 4x on the top-left corner
    const out = path.join(dir, 'out.mp4'), plan = buildComposite(tl, [{ n: 0, dur: 6.9, cam }], { out, hw: false, maskPath: mask, framePath: () => null });
    await runFfmpeg(plan.args, { duration: plan.total });
    // the line between red and black is at raw x = 0.5. With the zoom z(t) = 4^(t/4) and the centre c(t) = 0.5 - 0.375 t/4 it is on screen at (0.5 - (c - 0.5/z)) * z * 320 px
    const want = (t) => { const z = Math.pow(4, t / 4), c = 0.5 - 0.375 * (t / 4); return (0.5 - Math.max(0, c - 0.5 / z)) * z * 320; };
    const seen = [0.5, 1, 1.5, 2].map((t) => edgeX(out, t, 320, 180, 20));
    [0.5, 1, 1.5, 2].forEach((t, i) => assert.ok(Math.abs(seen[i] - want(t)) <= 5, `at ${t} s the line is at ${seen[i]}, expected ${want(t).toFixed(1)} (even growth)`));
    assert.ok(seen.every((x, i) => i === 0 || x > seen[i - 1] + 15), 'and it moves the whole time: ' + seen);
    const [a, b, c, d] = px(out, 5.5, 320, 180, [[8, 8], [311, 8], [8, 171], [311, 171]]);
    for (const col of [a, b, c, d]) close(col, TL);  // held at 4x on the top-left corner after the sign was let go
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real ffmpeg, camera only: a held zoom OUT falls evenly from 4x to the whole picture (the zoom by a constant factor, the centre in a line to the middle) and ends whole', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-zoom-'));
  try {
    const cam = quads(dir, 'cam_0.mp4', 320, 180, 7);
    const tl = base({ mode: 'cam', screen: null, zoom: [[0, 0.5, 0.5, 1], [1, 0.125, 0.125, 4], [4, 0.5, 0.5, 1, 2]] }); // in to 4x on the top-left corner at 1 s, held, and from 2 s to 4 s the X brings it back
    const out = path.join(dir, 'out.mp4'), plan = buildComposite(tl, [{ n: 0, dur: 6.9, cam }], { out, hw: false, maskPath: mask, framePath: () => null });
    await runFfmpeg(plan.args, { duration: plan.total });
    // the line between red and black is at raw x = 0.5; on screen it is at (0.5 - (c - 0.5/z)) * z * 320 with z(t) = 4^(1-u), c(t) = 0.125 + 0.375u and u = (t - 2) / 2
    const want = (t) => { const u = (t - 2) / 2, z = Math.pow(4, 1 - u), c = 0.125 + 0.375 * u; return (0.5 - Math.max(0, c - 0.5 / z)) * z * 320; };
    const times = [3, 3.5, 3.8], seen = times.map((t) => edgeX(out, t, 320, 180, 20));
    times.forEach((t, i) => assert.ok(Math.abs(seen[i] - want(t)) <= 6, `at ${t} s the line is at ${seen[i]}, expected ${want(t).toFixed(1)} (even fall)`));
    assert.ok(seen.every((x, i) => i === 0 || x < seen[i - 1] - 15), 'and it moves the whole time, towards the middle of the picture: ' + seen);
    const corners = [[8, 8], [311, 8], [8, 171], [311, 171]];
    for (const col of px(out, 1.8, 320, 180, corners)) close(col, TL); // held at 4x until the X starts
    const [a, b, c, d] = px(out, 5.5, 320, 180, corners);
    close(a, TL); close(b, TR); close(c, BL); close(d, BR);            // whole again
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real ffmpeg, camera only: a zoom out held only part of the way (the sign was let go at 2x) stays at 2x', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-zoom-'));
  try {
    const cam = quads(dir, 'cam_0.mp4', 320, 180, 6);
    const tl = base({ mode: 'cam', screen: null, zoom: [[0, 0.5, 0.5, 1], [1, 0.125, 0.125, 4], [3, 0.3125, 0.3125, 2, 1]] }); // 4x, then 1 s of the X: half way out in log z (2x), the centre half way to the middle
    const out = path.join(dir, 'out.mp4'), plan = buildComposite(tl, [{ n: 0, dur: 5.9, cam }], { out, hw: false, maskPath: mask, framePath: () => null });
    await runFfmpeg(plan.args, { duration: plan.total });
    // 2x centred at (0.3125, 0.3125): the window is raw x, y in 0.0625..0.5625, so the red/black line (x = 0.5) and the green/black line (y = 0.5) are at 280 px across and 157.5 px down
    assert.ok(Math.abs(edgeX(out, 5, 320, 180, 20) - 280) <= 6, 'the line stays where 2x puts it');
    const [a, b, c, d] = px(out, 5, 320, 180, [[8, 8], [311, 8], [8, 171], [311, 171]]);
    close(a, TL); close(b, TR); close(c, BL); close(d, BR); // at 2x on (0.31, 0.31) the window reaches just past the middle of the picture, so all four quarters show
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real ffmpeg, camera only: a zoom that is still on at the end of the recording stays on, and the last keyframe off-centre stays inside the picture', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-zoom-'));
  try {
    const cam = quads(dir, 'cam_0.mp4', 320, 180, 4);
    const tl = base({ mode: 'cam', screen: null, zoom: [[1, 0.9, 0.9, 3]] }); // asks for a centre near the corner: the window is held inside the picture
    const out = path.join(dir, 'out.mp4'), plan = buildComposite(tl, [{ n: 0, dur: 3.9, cam }], { out, hw: false, maskPath: mask, framePath: () => null });
    await runFfmpeg(plan.args, { duration: plan.total });
    for (const col of px(out, 3.5, 320, 180, [[8, 8], [311, 8], [8, 171], [311, 171]])) close(col, BR); // 3x at the bottom-right corner: only the bottom-right quarter's colour (the window is a third of the picture)
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real ffmpeg, camera only: the window follows the centre (top-right, bottom-left), not just the corner it starts in', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-zoom-'));
  try {
    const cam = quads(dir, 'cam_0.mp4', 320, 180, 6);
    const tl = base({ mode: 'cam', screen: null, zoom: [[1, 0.75, 0.25, 2], [3, 0.25, 0.75, 2]] });
    const out = path.join(dir, 'out.mp4'), plan = buildComposite(tl, [{ n: 0, dur: 5.9, cam }], { out, hw: false, maskPath: mask, framePath: () => null });
    await runFfmpeg(plan.args, { duration: plan.total });
    for (const col of px(out, 2.5, 320, 180, [[8, 8], [311, 8], [8, 171], [311, 171], [160, 90]])) close(col, TR);
    for (const col of px(out, 5, 320, 180, [[8, 8], [311, 8], [8, 171], [311, 171], [160, 90]])) close(col, BL);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real ffmpeg, screen + camera: the camera inside the bubble is zoomed, the screen is not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-zoom-'));
  try {
    const screen = path.join(dir, 'screen_0.mp4');
    run(['-f', 'lavfi', '-i', 'color=c=0x303030:s=640x360:r=10:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', screen]);
    const cam = quads(dir, 'cam_0.mp4', 320, 180, 5);
    // a square bubble of 160 px at (40, 100): it shows the middle 180x180 of the camera; two runs (a filter change) so the split path is used too
    const bubble = [[0, 40 / 640, 100 / 360, 160 / 640, 160 / 360, 'squircle', 'none', 'none', 1], [3, 40 / 640, 100 / 360, 160 / 640, 160 / 360, 'squircle', 'vivid', 'none', 1]];
    const tl = base({ bubble, zoom: [[0, 0.5, 0.5, 1], [1, 0.25, 0.25, 2]] });
    const out = path.join(dir, 'out.mp4'), plan = buildComposite(tl, [{ n: 0, dur: 4.9, screen, cam }], { out, hw: false, maskPath: (sh, w, h) => ensureMask(path.join(dir, 'm'), sh, w, h), framePath: () => null });
    assert.equal(plan.runs.length, 2);
    await runFfmpeg(plan.args, { duration: plan.total });
    // bubble point at 70 % across and 70 % down: bottom-right quarter before the zoom, top-left quarter after it. The screen corner stays the plain grey.
    const at = [[40 + 112, 100 + 112], [600, 20]];
    const before = px(out, 0.5, 640, 360, at), after = px(out, 2.0, 640, 360, at), late = px(out, 4.0, 640, 360, at);
    close(before[0], BR); close(after[0], TL); close(late[0], TL, 80); // (after the style change, the vivid filter shifts the colour a little)
    for (const s of [before[1], after[1], late[1]]) close(s, [48, 48, 48], 12);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
