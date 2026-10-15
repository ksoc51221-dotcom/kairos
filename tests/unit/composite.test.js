// The composite step is a pure function from (timeline, segment files) to ffmpeg arguments, so most checks need no ffmpeg at all.
// The last tests run the real ffmpeg binary on tiny synthetic clips to prove the filter graph is valid and the result is what the timeline says.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildComposite, outputSize, bubbleRuns, framePx, piecewise } = require('../../src/pipeline/composite');
const { ffmpeg, runFfmpeg, bitrateFor, videoArgs } = require('../../src/pipeline/encode');
const { ensureMask } = require('../../src/pipeline/masks');
const { segmentInputs, totalDuration, readManifest, writeTimeline } = require('../../src/pipeline/segments');

const seg = (n, dur, extra = {}) => ({ n, dur, screen: `/v/screen_${n}.mp4`, cam: `/v/cam_${n}.mp4`, ...extra });
const mask = (s, w, h) => `/m/${s}_${w}x${h}.png`;
const base = (over = {}) => ({ version: 2, mode: 'screen-cam', quality: 'source', crop: null, bubbleSpace: 'display', audio: true, screen: { width: 2880, height: 1800 }, cam: { width: 1280, height: 720 }, segments: [], bubble: [], ...over });
const build = (tl, inputs, opts = {}) => buildComposite(tl, inputs, { out: '/o.mp4', hw: true, maskPath: mask, ...opts });
const graph = (r) => r.args[r.args.indexOf('-filter_complex') + 1];

test('output size: Source keeps the native size, presets only ever scale down', () => {
  assert.deepEqual(outputSize(base(), 'source'), { w: 2880, h: 1800 });
  assert.deepEqual(outputSize(base(), '1080p'), { w: 1728, h: 1080 });
  assert.deepEqual(outputSize(base({ screen: { width: 1280, height: 800 } }), '4k'), { w: 1280, h: 800 }, 'never upscaled');
  assert.deepEqual(outputSize(base({ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }), 'source'), { w: 1440, h: 900 }, 'a custom area is cropped at native size');
  assert.deepEqual(outputSize(base({ crop: { x: 0, y: 0.04, w: 1, h: 0.96 } }), '720p'), { w: 1200, h: 720 }, 'hide-menu-bar crop, then scaled');
  assert.deepEqual(outputSize(base({ mode: 'cam', cam: { width: 1280, height: 720 } }), '720p'), { w: 1280, h: 720 });
  const odd = outputSize(base({ screen: { width: 1001, height: 601 } }), 'source');
  assert.ok(odd.w % 2 === 0 && odd.h % 2 === 0, 'video dimensions are even');
});

test('screen only: concat, 60 fps, no scaling at Source, audio joined, hardware encoder', () => {
  const r = build(base({ mode: 'screen', cam: null }), [seg(0, 3.5), seg(1, 2)]);
  const g = graph(r);
  assert.equal(r.args.filter((a) => a === '-i').length, 2, 'one input per segment, no camera');
  assert.match(g, /\[0:v\]\[1:v\]concat=n=2:v=1:a=0\[sc\]/);
  assert.match(g, /fps=60,format=yuv420p\[base\]/);
  assert.doesNotMatch(g, /scale=|crop=|overlay/);
  assert.match(g, /\[0:a\]\[1:a\]concat=n=2:v=0:a=1\[a\]/);
  assert.equal(r.args.slice(r.args.indexOf('-t'), r.args.indexOf('-t') + 2).join(' '), '-t 3.5', 'each segment is trimmed to its recorded length');
  assert.ok(r.args.includes('h264_videotoolbox') && r.args.includes('35M'), '2880x1800 gets the 4K-class bitrate');
  assert.deepEqual([r.size, r.total], [{ w: 2880, h: 1800 }, 5.5]);
});

test('a segment recorded at another size is fitted to the timeline size before the concat (window resized between pause and resume)', () => {
  const r = build(base({ mode: 'screen', cam: null, audio: false, screen: { width: 1280, height: 800 } }), [seg(0, 1, { width: 1280, height: 800 }), seg(1, 1, { width: 1000, height: 700 })]);
  const g = graph(r);
  assert.match(g, /\[1:v\]scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:\(ow-iw\)\/2:\(oh-ih\)\/2\[fit1\]/);
  assert.match(g, /\[0:v\]\[fit1\]concat=n=2:v=1:a=0\[sc\]/);
  assert.doesNotMatch(graph(build(base({ mode: 'screen', cam: null, audio: false }), [seg(0, 1, { width: 2880, height: 1800 })])), /fit0/, 'same size: untouched');
});

test('no audio in the timeline means no audio mapping at all', () => {
  const r = build(base({ mode: 'screen', cam: null, audio: false }), [seg(0, 2)]);
  assert.doesNotMatch(graph(r), /:a\]/);
  assert.ok(!r.args.includes('-c:a') && !r.args.includes('aac'));
});

test('screen + cam with a custom area: crop first at native size, bubble mapped into the cropped frame', () => {
  const tl = base({ quality: '1080p', crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, bubble: [[0, 0.3, 0.5, 0.1, 0.16, 'circle', 'none', 'ring', 1]] });
  const r = build(tl, [seg(0, 4)]);
  const g = graph(r);
  assert.match(g, /\[sc\]crop=1440:900:720:450,fps=60,format=yuv420p\[base\]/, 'a 900-high area is below 1080p, so it is cropped but not scaled');
  assert.deepEqual(r.size, { w: 1440, h: 900 });
  assert.equal(r.runs.length, 1);
  assert.deepEqual(framePx(tl, tl.bubble[0], r.size), { x: 144, y: 450, w: 288, h: 288 });
  assert.match(g, /overlay=x='144':y='450':enable='between\(t,0,4\)'/);
  assert.ok(r.args.includes('12M'), 'bitrate follows the output height (900), not the display');
});

test('a preset below the source height scales after the crop, with an even-sized result', () => {
  const r = build(base({ mode: 'screen', cam: null, quality: '720p', crop: { x: 0, y: 0.04, w: 1, h: 0.96 } }), [seg(0, 2)]);
  assert.match(graph(r), /crop=2880:1728:0:72,scale=1200:720:flags=lanczos,fps=60/);
  assert.deepEqual(r.size, { w: 1200, h: 720 });
});

test('bubble keyframes: moves become piecewise x/y, a style change starts a new run, hidden spans leave a gap', () => {
  const size = { w: 1920, h: 1080 };
  const tl = base({ screen: { width: 1920, height: 1080 }, bubble: [
    [0, 0.05, 0.6, 0.1, 0.178, 'circle', 'none', 'ring', 1],
    [1, 0.5, 0.6, 0.1, 0.178, 'circle', 'none', 'ring', 1],
    [2, 0.5, 0.6, 0.1, 0.178, 'circle', 'none', 'ring', 0],
    [3, 0.5, 0.6, 0.15, 0.27, 'squircle', 'warm', 'glow', 1],
  ] });
  const runs = bubbleRuns(tl, size, 5);
  assert.deepEqual(runs.map((r) => [r.shape, r.start, r.end, r.positions.length]), [['circle', 0, 2, 2], ['squircle', 3, 5, 1]]);
  const g = graph(build(tl, [seg(0, 5)]));
  assert.match(g, /if\(lt\(t,1\),96,960\)/, 'x jumps from 5% to 50% of 1920 at t=1');
  assert.match(g, /enable='between\(t,3,5\)'/);
  assert.equal((g.match(/overlay=/g) || []).length, 2);
  assert.equal(piecewise([[0, 5], [1, 7], [2, 9]], (p) => p[1]), 'if(lt(t,1),5,if(lt(t,2),7,9))');
});

test('bubble keyframes: tiny moves merge, very long drags are thinned, positions stay inside the frame', () => {
  const size = { w: 1000, h: 600 };
  const rows = []; for (let i = 0; i < 300; i++) rows.push([i / 30, i / 400, 0.5, 0.1, 0.17, 'circle', 'none', 'ring', 1]);
  const runs = bubbleRuns(base({ screen: { width: 1000, height: 600 }, bubble: rows }), size, 10);
  assert.equal(runs.length, 1); assert.ok(runs[0].positions.length <= 60, `thinned to ${runs[0].positions.length}`);
  assert.deepEqual(runs[0].positions[0].slice(1), [0, 300]);
  const still = bubbleRuns(base({ screen: { width: 1000, height: 600 }, bubble: [[0, 0.5, 0.5, 0.1, 0.17, 'circle', 'none', 'ring', 1], [1, 0.5004, 0.5, 0.1, 0.17, 'circle', 'none', 'ring', 1]] }), size, 3);
  assert.equal(still[0].positions.length, 1, 'a sub-2px move is not a new position');
  const out = framePx(base(), [0, 0.99, 0.99, 0.2, 0.3, 'circle', 'none', 'ring', 1], { w: 1000, h: 600 });
  assert.ok(out.x + out.w <= 1000 && out.y + out.h <= 600, 'clamped inside');
});

test('window recordings without keyframes get a bottom-left circle', () => {
  const tl = base({ bubbleSpace: 'frame', screen: { width: 1600, height: 900 }, bubble: [] });
  const [run] = bubbleRuns(tl, { w: 1600, h: 900 }, 4);
  assert.equal(run.positions[0][1] < 100 && run.positions[0][2] > 450, true);
  assert.equal(run.shape, 'circle');
});

test('cam-only: the camera track is the picture, scaled to cover, audio from the camera file', () => {
  const r = build(base({ mode: 'cam', screen: null, cam: { width: 1280, height: 720 }, quality: '1080p' }), [seg(0, 3)]);
  const g = graph(r);
  assert.match(g, /\[0:v\]concat=n=1:v=1:a=0\[cc0\]/);
  assert.match(g, /force_original_aspect_ratio=increase,crop=1280:720/);
  assert.match(g, /\[0:a\]concat=n=1:v=0:a=1\[a\]/);
  assert.doesNotMatch(g, /overlay/);
});

test('a segment without camera footage disables the bubble instead of misaligning the concat', () => {
  const r = build(base({ bubble: [[0, 0.1, 0.1, 0.1, 0.17, 'circle', 'none', 'ring', 1]] }), [seg(0, 2), seg(1, 2, { cam: null })]);
  assert.equal(r.useCam, false); assert.doesNotMatch(graph(r), /overlay/);
});

test('software fallback uses libx264, and bitrates follow the height', () => {
  const r = build(base({ mode: 'screen', cam: null, quality: '720p' }), [seg(0, 1)], { hw: false });
  assert.ok(r.args.includes('libx264') && !r.args.includes('h264_videotoolbox'));
  assert.deepEqual([bitrateFor(720), bitrateFor(1080), bitrateFor(1440), bitrateFor(2160)], ['12M', '12M', '20M', '35M']);
  assert.ok(videoArgs(1080, true).includes('-allow_sw'));
});

test('nothing to composite is an error, not an empty command', () => {
  assert.throws(() => build(base(), []), /nothing to composite/);
});

test('segmentInputs skips segments that are too short or missing, totalDuration adds up what is left', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-seg-'));
  fs.writeFileSync(path.join(dir, 'screen_0.mp4'), 'x'); fs.writeFileSync(path.join(dir, 'screen_2.mp4'), 'x'); fs.writeFileSync(path.join(dir, 'screen_3.mp4'), '');
  const tl = { mode: 'screen', segments: [{ n: 0, t0: 0, dur: 2, screen: 'screen_0.mp4' }, { n: 1, t0: 2, dur: 1, screen: 'screen_1.mp4' }, { n: 2, t0: 3, dur: 0.01, screen: 'screen_2.mp4' }, { n: 3, t0: 3, dur: 2, screen: 'screen_3.mp4' }] };
  const inputs = segmentInputs(dir, tl);
  assert.deepEqual(inputs.map((s) => s.n), [0], 'missing, tiny and empty files are dropped');
  assert.equal(totalDuration(inputs), 2);
  writeTimeline(dir, tl); assert.equal(readManifest(dir).kind, 'recording');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- real ffmpeg on synthetic clips ----
const clip = (dir, name, args) => { const f = path.join(dir, name); const r = spawnSync(ffmpeg, ['-y', '-v', 'error', ...args, f]); assert.equal(r.status, 0, String(r.stderr)); return f; };
const info = (file) => { const e = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr; const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(e), v = /Video:.*?, (\d{2,5})x(\d{2,5})/.exec(e); return { duration: +d[1] * 3600 + +d[2] * 60 + +d[3], w: +v[1], h: +v[2], fps: +(/(\d+(?:\.\d+)?) fps/.exec(e) || [])[1], audio: /Audio:/.test(e) }; };

test('real ffmpeg: two segments + camera bubble that moves and changes shape make one valid 60 fps video of the recorded length', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-comp-'));
  const mk = (n, f) => ({ s: clip(dir, `screen_${n}.mp4`, ['-f', 'lavfi', '-i', 'testsrc2=s=1280x800:r=60:d=2', '-f', 'lavfi', '-i', `sine=f=${f}:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']),
    c: clip(dir, `cam_${n}.mp4`, ['-f', 'lavfi', '-i', 'smptebars=s=640x360:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']) });
  const a = mk(0, 440), b = mk(1, 660);
  const tl = base({ quality: '720p', screen: { width: 1280, height: 800 }, cam: { width: 640, height: 360 }, bubble: [
    [0, 0.02, 0.7, 0.1, 0.16, 'circle', 'none', 'ring', 1], [1, 0.6, 0.1, 0.1, 0.16, 'circle', 'none', 'ring', 1], [2, 0.6, 0.1, 0.14, 0.2, 'squircle', 'warm', 'none', 1]] });
  const out = path.join(dir, 'out.mp4');
  const plan = buildComposite(tl, [{ n: 0, dur: 1.5, screen: a.s, cam: a.c }, { n: 1, dur: 1.2, screen: b.s, cam: b.c }], { out, hw: false, maskPath: (s, w, h) => ensureMask(path.join(dir, 'masks'), s, w, h) });
  await runFfmpeg(plan.args, { duration: plan.total });
  const i = info(out);
  assert.ok(Math.abs(i.duration - 2.7) < 0.1, `duration ${i.duration}`);
  assert.deepEqual([i.w, i.h], [1152, 720]); assert.equal(i.fps, 60); assert.ok(i.audio);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('real ffmpeg: cam-only and a screen-only recording at Source both encode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-comp-'));
  const cam = clip(dir, 'cam_0.mp4', ['-f', 'lavfi', '-i', 'smptebars=s=640x360:r=30:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  const scr = clip(dir, 'screen_0.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=640x400:r=60:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const camPlan = buildComposite(base({ mode: 'cam', screen: null, cam: { width: 640, height: 360 } }), [{ n: 0, dur: 0.9, cam }], { out: path.join(dir, 'a.mp4'), hw: false, maskPath: mask });
  await runFfmpeg(camPlan.args, { duration: camPlan.total });
  const scrPlan = buildComposite(base({ mode: 'screen', cam: null, audio: false, screen: { width: 640, height: 400 } }), [{ n: 0, dur: 0.9, screen: scr }], { out: path.join(dir, 'b.mp4'), hw: false, maskPath: mask });
  await runFfmpeg(scrPlan.args, { duration: scrPlan.total });
  assert.deepEqual([info(path.join(dir, 'a.mp4')).w, info(path.join(dir, 'a.mp4')).h, info(path.join(dir, 'a.mp4')).audio], [640, 360, true]);
  assert.deepEqual([info(path.join(dir, 'b.mp4')).w, info(path.join(dir, 'b.mp4')).h, info(path.join(dir, 'b.mp4')).audio], [640, 400, false]);
  fs.rmSync(dir, { recursive: true, force: true });
});
