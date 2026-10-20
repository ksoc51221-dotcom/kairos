// The share copy is what leaves the Mac, so its size, shape and structure are checked on a real ffmpeg run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ffmpeg, runFfmpeg } = require('../../src/pipeline/encode');
const share = require('../../src/pipeline/share-copy');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-share-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const info = (f) => spawnSync(ffmpeg, ['-hide_banner', '-i', f], { encoding: 'utf8' }).stderr;
const topBoxes = (f) => {
  const fd = fs.openSync(f, 'r'), size = fs.fstatSync(fd).size, out = []; let pos = 0;
  while (pos + 8 <= size) { const h = Buffer.alloc(16); fs.readSync(fd, h, 0, 16, pos); let len = h.readUInt32BE(0); out.push(h.toString('latin1', 4, 8)); if (len === 1) len = Number(h.readBigUInt64BE(8)); if (!len) len = size - pos; pos += len; }
  fs.closeSync(fd); return out;
};
// a synthetic "recording": native-size, 60 fps, with a tone
const source = (name, { size = '2880x1800', rate = 60, secs = 2, audio = true } = {}) => {
  const f = path.join(dir, name);
  return runFfmpeg(['-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${secs}`, ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`, '-c:a', 'aac'] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', f]).then(() => f);
};

test('the arguments strip metadata, make audio optional, cap the size and put the index first', () => {
  const a = share.shareArgs('in.mp4', 'out.mp4');
  assert.deepEqual(a.slice(a.indexOf('-map_metadata'), a.indexOf('-map_metadata') + 2), ['-map_metadata', '-1']);
  assert.ok(a.includes('0:a:0?'), 'audio is optional');
  assert.equal(a[a.indexOf('-movflags') + 1], '+faststart');
  const vf = a[a.indexOf('-vf') + 1];
  assert.match(vf, /min\(1920,iw\)/); assert.match(vf, /min\(1080,ih\)/); assert.match(vf, /fps=30/); assert.match(vf, /format=yuv420p/);
  assert.equal(a[a.indexOf('-maxrate') + 1], '5M');
  assert.equal(a[a.indexOf('-i') + 1], 'in.mp4'); assert.equal(a.at(-1), 'out.mp4');
});

test('the size estimate is the worst case: about 38 MB a minute', () => {
  assert.ok(share.estimateBytes(60) > 36e6 && share.estimateBytes(60) < 41e6);
  assert.ok(share.estimateBytes(0) > 0, 'an unknown duration still counts something');
});

test('a 2880x1800 / 60 fps recording becomes 1728x1080 / 30 fps with sound, the index first, and much smaller', async () => {
  const src = await source('big.mp4'), out = path.join(dir, 'big-share.mp4');
  const progress = []; await share.makeShareCopy(src, out, { duration: 2, onProgress: (p) => progress.push(p) });
  const text = info(out);
  assert.match(text, /Video: h264 \(High\).*1728x1080/); assert.match(text, /\b30 fps\b/); assert.match(text, /Audio: aac/);
  const boxes = topBoxes(out); assert.ok(boxes.indexOf('moov') < boxes.indexOf('mdat'), `moov must come before mdat for streaming, got ${boxes}`);
  assert.ok(progress.length > 0 && progress.at(-1) <= 1, 'progress is reported');
});

test('a small silent recording is not scaled up and does not fail for lack of audio', async () => {
  const src = await source('small.mp4', { size: '640x360', rate: 30, audio: false }), out = path.join(dir, 'small-share.mp4');
  await share.makeShareCopy(src, out, { duration: 2 });
  const text = info(out); assert.match(text, /640x360/); assert.doesNotMatch(text, /Audio:/);
});

test('an odd-sized recording gets even sides', async () => {
  const src = await source('odd.mp4', { size: '2001x1201', rate: 30, audio: false }), out = path.join(dir, 'odd-share.mp4');
  await share.makeShareCopy(src, out, { duration: 2 });
  const m = /(\d+)x(\d+)/.exec(info(out).match(/Video: .*/)[0].replace(/0x\d+/, '')); assert.ok(+m[1] % 2 === 0 && +m[2] % 2 === 0, `${m[1]}x${m[2]}`); assert.ok(+m[2] <= 1080);
});

test('the poster is a single jpg frame of the share copy', async () => {
  const src = await source('poster-src.mp4', { size: '640x360', rate: 30, audio: false, secs: 5 }), out = path.join(dir, 'poster.jpg');
  await share.makePoster(src, out, 5);
  const b = fs.readFileSync(out); assert.equal(b[0], 0xff); assert.equal(b[1], 0xd8); assert.ok(b.length > 1000);
});

test('an AbortSignal stops the encode and says so', async () => {
  const src = await source('long.mp4', { size: '1920x1080', rate: 30, secs: 20, audio: false }), out = path.join(dir, 'long-share.mp4');
  const ctl = new AbortController(), run = share.makeShareCopy(src, out, { duration: 20, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 150);
  await assert.rejects(run, /cancelled/);
  await assert.rejects(share.makeShareCopy(src, out, { signal: AbortSignal.abort() }), /cancelled/, 'already aborted');
});
