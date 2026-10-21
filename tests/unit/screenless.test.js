// A segment whose screen recorder wrote nothing (a screen that does not change delivers no frames to a fresh MediaRecorder) used to be dropped from the
// export, which cut the camera picture, the voice and everything after it. These tests pin the other behaviour: the segment stays, the screen is held
// (screenshot, else black), and the voice comes from the camera file (else silence), so the video is as long as the recording.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildComposite } = require('../../src/pipeline/composite');
const { ffmpeg, runFfmpeg } = require('../../src/pipeline/encode');
const { ensureMask } = require('../../src/pipeline/masks');
const { segmentInputs } = require('../../src/pipeline/segments');
const { grabStill } = require('../../src/main/screen-still');
const { Timeline } = require('../../src/shared/timeline');

const mask = (s, w, h) => `/m/${s}_${w}x${h}.png`;
const base = (over = {}) => ({ version: 2, mode: 'screen-cam', quality: 'source', crop: null, bubbleSpace: 'display', audio: true, camAudio: true, screen: { width: 1280, height: 800 }, cam: { width: 640, height: 360 }, segments: [], bubble: [], ...over });
const build = (tl, inputs) => buildComposite(tl, inputs, { out: '/o.mp4', hw: false, maskPath: mask });
const graph = (r) => r.args[r.args.indexOf('-filter_complex') + 1];
const full = (n, dur) => ({ n, dur, screen: `/v/screen_${n}.mp4`, cam: `/v/cam_${n}.mp4` });
const gap = (n, dur, extra = {}) => ({ n, dur, screen: null, cam: `/v/cam_${n}.mp4`, still: null, ...extra });

// ---- which segments survive ----
test('segmentInputs: a screen + camera recording keeps every segment that is long enough, with its screenshot when there is one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-gap-'));
  for (const f of ['screen_0.webm', 'cam_0.webm', 'cam_1.webm', 'screen_1.png', 'cam_2.webm', 'screen_2.webm', 'screen_3.webm', 'screen_4.png']) fs.writeFileSync(path.join(dir, f), 'x');
  fs.writeFileSync(path.join(dir, 'screen_3.webm'), '');
  const tl = { mode: 'screen-cam', segments: [
    { n: 0, t0: 0, dur: 2, screen: 'screen_0.webm', cam: 'cam_0.webm' },
    { n: 1, t0: 2, dur: 3, cam: 'cam_1.webm', still: 'screen_1.png' },
    { n: 2, t0: 5, dur: 1, cam: 'cam_2.webm' },
    { n: 3, t0: 6, dur: 1, screen: 'screen_3.webm' },
    { n: 4, t0: 7, dur: 1, still: 'screen_4.png' },
    { n: 5, t0: 8, dur: 1 },
    { n: 6, t0: 9, dur: 0.01, cam: 'cam_2.webm' },
  ] };
  const got = segmentInputs(dir, tl);
  assert.deepEqual(got.map((s) => s.n), [0, 1, 2, 3, 4, 5], 'what happened happened, even if no recorder wrote a file for it; only a few milliseconds are dropped');
  assert.equal(got[1].screen, null); assert.equal(got[1].still, path.join(dir, 'screen_1.png')); assert.equal(got[1].cam, path.join(dir, 'cam_1.webm'));
  assert.equal(got[2].still, null); assert.equal(got[3].screen, null, 'an empty file is no file');
  assert.deepEqual([got[4].cam, got[5].screen, got[5].cam, got[5].still], [null, null, null, null]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('segmentInputs: screen-only and camera-only recordings keep every segment too (screen-only used to drop a stretch with no screen file)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-gap-'));
  for (const f of ['screen_0.webm', 'cam_1.webm', 'cam_0.webm']) fs.writeFileSync(path.join(dir, f), 'x');
  const segs = [{ n: 0, t0: 0, dur: 1, screen: 'screen_0.webm', cam: 'cam_0.webm' }, { n: 1, t0: 1, dur: 1, cam: 'cam_1.webm' }];
  assert.deepEqual(segmentInputs(dir, { mode: 'screen', segments: segs }).map((s) => s.n), [0, 1], 'a screen recording keeps a stretch with no screen file as well: it is held on a screenshot or black, with its own voice');
  assert.deepEqual(segmentInputs(dir, { mode: 'cam', segments: segs }).map((s) => s.n), [0, 1]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the graph ----
test('normal recordings build exactly the graph they always did (no stand-ins, no fit, no extra inputs)', () => {
  const r = build(base(), [full(0, 2), full(1, 2)]);
  assert.deepEqual(r.fills, { still: 0, black: 0, voice: 0, camAudio: 0, silence: 0, camBlack: 0 });
  assert.equal(r.args.filter((a) => a === '-i').length, 4 + r.runs.length);
  assert.match(graph(r), /\[0:v\]\[2:v\]concat=n=2:v=1:a=0\[sc\]/);
  assert.match(graph(r), /\[0:a\]\[2:a\]concat=n=2:v=0:a=1\[a\]/);
  assert.doesNotMatch(graph(r), /fit|setsar|anullsrc/);
});

test('a segment without a screen file is held on its screenshot, fitted to the timeline size, and its voice comes from the camera file', () => {
  const r = build(base(), [full(0, 2), gap(1, 3, { still: '/v/screen_1.png' }), full(2, 1)]);
  const a = r.args, g = graph(r);
  assert.deepEqual(r.fills, { still: 1, black: 0, voice: 0, camAudio: 1, silence: 0, camBlack: 0 });
  const k = a.indexOf('/v/screen_1.png');
  assert.deepEqual(a.slice(k - 7, k + 1), ['-loop', '1', '-framerate', '30', '-t', '3', '-i', '/v/screen_1.png'], 'a looped picture of exactly the segment length');
  assert.match(g, /scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:\(ow-iw\)\/2:\(oh-ih\)\/2,setsar=1,format=yuv420p\[fit1\]/);
  assert.match(g, /\[0:v\]\[fit1\]\[\d+:v\]concat=n=3:v=1:a=0\[sc\]/);
  // the camera is used for the bubble in every segment, and the gap's audio is the camera file of segment 1
  assert.equal(r.useCam, true);
  const camIdx = (n) => a.reduce((acc, x, i) => (x === `/v/cam_${n}.mp4` ? i : acc), -1);
  assert.ok(camIdx(1) > 0);
  const inputIndex = (file) => a.slice(0, a.indexOf(file)).filter((x) => x === '-i').length - 1; // the '-i' just before the file is its own
  assert.match(g, new RegExp(`\\[0:a\\]\\[${inputIndex('/v/cam_1.mp4')}:a\\]\\[${inputIndex('/v/screen_2.mp4')}:a\\]concat=n=3:v=0:a=1\\[a\\]`));
  assert.equal(a.filter((x) => x === '/v/cam_1.mp4').length, 1, 'the camera file is opened once, not once for the bubble and once for the voice');
});

test('without a screenshot the screen is black; without camera audio the gap is silence of the right length', () => {
  const r = build(base({ camAudio: false }), [full(0, 2), gap(1, 1.5)]);
  const a = r.args, g = graph(r);
  assert.deepEqual(r.fills, { still: 0, black: 1, voice: 0, camAudio: 0, silence: 1, camBlack: 0 });
  assert.ok(a.join(' ').includes('-f lavfi -t 1.5 -i color=c=black:s=1280x800:r=30'));
  assert.ok(a.join(' ').includes('-f lavfi -t 1.5 -i anullsrc=r=48000:cl=stereo'));
  assert.match(g, /\[\d+:v\]scale=1280:800.*\[fit1\]/);
  assert.match(g, /concat=n=2:v=0:a=1\[a\]/);
});

test('a camera file the caller found to have no audio stream gives silence instead of a broken graph', () => {
  const r = build(base(), [full(0, 1), gap(1, 2, { camSound: false })]);
  assert.deepEqual(r.fills, { still: 0, black: 1, voice: 0, camAudio: 0, silence: 1, camBlack: 0 });
  assert.match(graph(r), /anullsrc|concat=n=2:v=0:a=1\[a\]/);
  assert.ok(r.args.join(' ').includes('anullsrc=r=48000:cl=stereo'));
});

test('an odd-sized timeline (a window can be) pads at the even size below and adds the pixel back, because scale/pad fail on odd targets', () => {
  const r = build(base({ screen: { width: 1279, height: 719 } }), [full(0, 1), gap(1, 1, { still: '/v/screen_1.png' })]);
  assert.match(graph(r), /\[\d+:v\]scale=1278:718:force_original_aspect_ratio=decrease,pad=1278:718:\(ow-iw\)\/2:\(oh-ih\)\/2,scale=1279:719,setsar=1,format=yuv420p\[fit1\]/);
  const f = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=1000x600:d=0.2', '-vf', 'scale=1278:718:force_original_aspect_ratio=decrease,pad=1278:718:(ow-iw)/2:(oh-ih)/2,scale=1279:719,setsar=1,format=yuv420p', '-f', 'null', '-']);
  assert.equal(f.status, 0, String(f.stderr));
});

test('a segment where the camera recorder wrote nothing gets a black camera and no bubble, the rest of the video keeps its bubble', () => {
  const tl = base({ bubble: [[0, 0.1, 0.1, 0.1, 0.17, 'circle', 'none', 'ring', 1]] });
  const r = build(tl, [full(0, 2), { ...full(1, 3), cam: null }, full(2, 1)]);
  assert.equal(r.useCam, true); assert.equal(r.fills.camBlack, 1);
  assert.ok(r.args.join(' ').includes('-f lavfi -t 3 -i color=c=black:s=640x360:r=30'));
  assert.match(graph(r), /enable='between\(t,0,6\)\*not\(between\(t,2,5\)\)'/, 'the bubble is hidden exactly while its camera is missing');
  assert.match(graph(r), /concat=n=3:v=1:a=0\[cc\]/);
  const none = build(tl, [{ ...full(0, 2), cam: null }, { ...full(1, 3), cam: null }]);
  assert.equal(none.useCam, false, 'no camera footage at all: no bubble, as before');
  const adjacent = build(tl, [full(0, 1), { ...full(1, 1), cam: null }, { ...full(2, 1), cam: null }, full(3, 1)]);
  assert.match(graph(adjacent), /not\(between\(t,1,3\)\)'/, 'neighbouring gaps are one hole');
});

test('when the camera bubble is off the gap still takes its voice from the camera file', () => {
  const r = build(base({ bubble: [] }), [full(0, 1), gap(1, 1)]);
  assert.equal(r.fills.camAudio, 1); assert.equal(r.fills.silence, 0);
  assert.equal(r.args.filter((x) => x === '/v/cam_1.mp4').length, 1);
});

test('a first segment, or every segment, without a screen file still builds a full-length graph', () => {
  const r = build(base(), [gap(0, 2, { still: '/v/screen_0.png' }), full(1, 1)]);
  assert.match(graph(r), /\[fit0\]\[\d+:v\]concat=n=2/);
  assert.equal(r.total, 3);
  const all = build(base(), [gap(0, 2), gap(1, 2)]);
  assert.equal(all.total, 4); assert.equal(all.fills.black, 2); assert.equal(all.fills.camAudio, 2);
});

// ---- the screenshot grabber ----
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const thumb = (empty = false) => ({ isEmpty: () => empty, toPNG: () => (empty ? Buffer.alloc(0) : png) });
const display = { id: 7, size: { width: 1440, height: 900 }, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-still-')), 'screen_1.png');

test('grabStill: writes the picture of the recorded screen, asking for its pixel size', async () => {
  const file = tmp(); let asked;
  const desktopCapturer = { getSources: async (o) => { asked = o; return [{ id: 'screen:9:0', display_id: '3', thumbnail: thumb() }, { id: 'screen:1:0', display_id: '7', thumbnail: thumb() }]; } };
  assert.equal(await grabStill({ desktopCapturer, sourceId: 'screen:1:0', display, windowSource: false, file }), file);
  assert.deepEqual(fs.readFileSync(file), png);
  assert.deepEqual(asked, { types: ['screen'], thumbnailSize: { width: 2880, height: 1800 } });
});

test('grabStill: falls back to the display id; a window recording asks for windows', async () => {
  const file = tmp(); let asked;
  const desktopCapturer = { getSources: async (o) => { asked = o; return [{ id: 'screen:5:0', display_id: '7', thumbnail: thumb() }]; } };
  assert.equal(await grabStill({ desktopCapturer, sourceId: 'screen:gone', display, windowSource: false, file }), file, 'source ids change between runs, the display does not');
  const wfile = tmp();
  const wc = { getSources: async (o) => { asked = o; return [{ id: 'window:42:0', display_id: '', thumbnail: thumb() }]; } };
  assert.equal(await grabStill({ desktopCapturer: wc, sourceId: 'window:42:0', display, windowSource: true, file: wfile }), wfile);
  assert.deepEqual(asked.types, ['window']);
  assert.equal(await grabStill({ desktopCapturer: wc, sourceId: 'window:99:0', display, windowSource: true, file: tmp() }), null, 'another window is never substituted');
});

test('grabStill: nothing to show, an empty thumbnail, an error or a hang all give null and leave no file', async () => {
  const none = tmp(), cases = [
    { getSources: async () => [] },
    { getSources: async () => [{ id: 'screen:1:0', display_id: '7', thumbnail: thumb(true) }] },
    { getSources: async () => { throw new Error('no permission'); } },
    { getSources: () => new Promise(() => {}) },
  ];
  for (const desktopCapturer of cases) assert.equal(await grabStill({ desktopCapturer, sourceId: 'screen:1:0', display, windowSource: false, file: none, timeoutMs: 50 }), null);
  assert.equal(fs.existsSync(none), false);
  assert.equal(await grabStill({ desktopCapturer: cases[0], sourceId: 'x', display: null, windowSource: false, file: none }), null, 'a missing display does not throw');
});

// ---- the timeline keeps the new fields ----
test('timeline: still and camAudio travel through toJSON', () => {
  const t = new Timeline({ mode: 'screen-cam', camAudio: true });
  t.start(1000); t.stop(3000);
  const j = t.toJSON({ 0: { cam: 'cam_0.webm', still: 'screen_0.png' } });
  assert.equal(j.camAudio, true); assert.deepEqual(j.segments[0], { n: 0, t0: 0, dur: 2, cam: 'cam_0.webm', still: 'screen_0.png' });
});

// ---- real ffmpeg: the video is as long as the recording, with the right picture and sound in the gap ----
const clip = (dir, name, args) => { const f = path.join(dir, name); const r = spawnSync(ffmpeg, ['-y', '-v', 'error', ...args, f]); assert.equal(r.status, 0, String(r.stderr)); return f; };
const info = (file) => { const e = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr; const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(e), v = /Video:.*?, (\d{2,5})x(\d{2,5})/.exec(e); return { duration: +d[1] * 3600 + +d[2] * 60 + +d[3], w: +v[1], h: +v[2], audio: /Audio:/.test(e) }; };
// the mean colour of one frame, and the loudness of a stretch of the audio
const pixel = (file, t) => { const r = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' }); return [...r.stdout.subarray(0, 3)]; };
const volume = (file, from, to) => { const e = spawnSync(ffmpeg, ['-hide_banner', '-ss', String(from), '-t', String(to - from), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr; const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(e); return m ? +m[1] : -Infinity; };

async function runGap({ camAudio, still, voice, expect }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-gap-'));
  const s0 = clip(dir, 'screen_0.mp4', ['-f', 'lavfi', '-i', 'color=c=0x0000ff:s=1280x800:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  const s2 = clip(dir, 'screen_2.mp4', ['-f', 'lavfi', '-i', 'color=c=0x0000ff:s=1280x800:r=30:d=1', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  const cam = (n, d, withAudio) => clip(dir, `cam_${n}.mp4`, ['-f', 'lavfi', '-i', `color=c=0x00ff00:s=640x360:r=30:d=${d}`, ...(withAudio ? ['-f', 'lavfi', '-i', `sine=f=880:d=${d}`, '-c:a', 'aac', '-shortest'] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const shot = still ? clip(dir, 'screen_1.png', ['-f', 'lavfi', '-i', 'color=c=0xff0000:s=800x500:r=1:d=1', '-frames:v', '1']) : null; // 800x500: not the timeline's size, so it has to be fitted
  let backup = null;
  if (voice) { // like a MediaRecorder file: opus in webm written to a pipe, so no duration in its header, and a little shorter than its segment
    const r = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=660:d=2.9', '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-f', 'webm', 'pipe:1'], { encoding: 'buffer' });
    assert.equal(r.status, 0, String(r.stderr)); backup = path.join(dir, 'audio_1.webm'); fs.writeFileSync(backup, r.stdout);
  }
  const tl = base({ camAudio, bubble: [], screen: { width: 1280, height: 800 } });
  const inputs = [{ n: 0, dur: 2, screen: s0, cam: cam(0, 2, camAudio) }, { n: 1, dur: 3, screen: null, cam: cam(1, 3, camAudio), still: shot, audio: backup }, { n: 2, dur: 1, screen: s2, cam: cam(2, 1, camAudio) }];
  const out = path.join(dir, 'out.mp4');
  const plan = buildComposite(tl, inputs, { out, hw: false, maskPath: (s, w, h) => ensureMask(path.join(dir, 'masks'), s, w, h) });
  await runFfmpeg(plan.args, { duration: plan.total });
  const i = info(out);
  assert.ok(Math.abs(i.duration - 6) < 0.15, `as long as the recording: ${i.duration}`);
  assert.deepEqual([i.w, i.h], [1280, 800]); assert.ok(i.audio);
  const near = (c, want, m) => assert.ok(c.every((v, k) => Math.abs(v - want[k]) < 40), `${m}: ${c} vs ${want}`);
  near(pixel(out, 1), [0, 0, 255], 'before the gap: the screen');
  near(pixel(out, 3.5), expect.pic, 'in the gap');
  near(pixel(out, 5.5), [0, 0, 255], 'after the gap: the screen again');
  const v = volume(out, 2.3, 4.7);
  assert.ok(expect.sound ? v > -30 : v < -60, `sound in the gap: ${v} dB`);
  assert.ok(volume(out, 5.1, 5.9) > -30, 'and after it, in step with the picture');
  fs.rmSync(dir, { recursive: true, force: true });
}

test('real ffmpeg: a gap with a screenshot and camera audio keeps its length, its picture and its voice', async () => runGap({ camAudio: true, still: true, expect: { pic: [255, 0, 0], sound: true } }));
test('real ffmpeg: a gap with neither screenshot nor camera audio is black and silent but still the right length', async () => runGap({ camAudio: false, still: false, expect: { pic: [0, 0, 0], sound: false } }));

test('real ffmpeg: a gap whose screen file is empty and whose camera has no sound takes its voice from the audio backup, at the right length and in step', async () => runGap({ camAudio: false, still: true, voice: true, expect: { pic: [255, 0, 0], sound: true } }));

// ---- the voice backup: audio_N.webm stands in for the sound of a segment whose screen file is empty ----
test('a segment without a screen file takes its voice from its own audio file, ahead of the camera file and silence; a screen file with sound makes it unnecessary', () => {
  const r = build(base(), [full(0, 2), gap(1, 3, { audio: '/v/audio_1.webm' }), full(2, 1)]);
  const a = r.args, g = graph(r);
  assert.deepEqual(r.fills, { still: 0, black: 1, voice: 1, camAudio: 0, silence: 0, camBlack: 0 });
  const k = a.indexOf('/v/audio_1.webm');
  assert.deepEqual(a.slice(k - 3, k + 1).map(String), ['-t', '3', '-i', '/v/audio_1.webm'], 'read for exactly the length of the segment');
  assert.match(g, /aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=3\[va1\]/);
  assert.match(g, /\[0:a\]\[va1\]\[\d+:a\]concat=n=3:v=0:a=1\[a\]/);
  const covered = build(base(), [full(0, 2), { ...full(1, 3), audio: '/v/audio_1.webm' }]);
  assert.equal(covered.args.includes('/v/audio_1.webm'), false, 'not even opened when the screen file carries the sound');
  assert.equal(covered.fills.voice, 0);
});

test('segmentInputs: the voice backup file is passed on when it has bytes and counts as no file when it is empty; screen-only keeps such stretches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-gap-'));
  fs.writeFileSync(path.join(dir, 'audio_0.webm'), 'x'); fs.writeFileSync(path.join(dir, 'audio_1.webm'), '');
  const tl = { mode: 'screen', segments: [{ n: 0, t0: 0, dur: 2, audio: 'audio_0.webm' }, { n: 1, t0: 2, dur: 2, audio: 'audio_1.webm' }] };
  const got = segmentInputs(dir, tl);
  assert.deepEqual(got.map((s) => s.n), [0, 1]);
  assert.equal(got[0].audio, path.join(dir, 'audio_0.webm')); assert.equal(got[1].audio, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
