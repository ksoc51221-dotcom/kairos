// The Privacy Guard reads about one frame in four: near-identical frames are folded together by a 64-bit difference hash.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickFrames, dhash, hamming } = require('../../src/agents/privacy');
const { HASH_W, HASH_H, SCAN_FPS } = require('../../src/pipeline/composite');

const SIZE = HASH_W * HASH_H;
// a 9x8 picture: left half bright, right half dark, with the dark/bright edge at column `edge`
const pic = (edge = 4, noise = 0) => Buffer.from(Array.from({ length: SIZE }, (_, i) => ((i % HASH_W) < edge ? 200 : 60) + (noise ? (i % 3) * noise : 0)));
const film = (frames) => Buffer.concat(frames);

test('dhash is 64 bits, ignores brightness shifts and tiny noise, and sees structure changes', () => {
  const a = dhash(pic(4)); assert.equal(a.length, 64);
  assert.equal(hamming(a, dhash(pic(4, 1))), 0, 'noise of 1-2 levels does not flip bits');
  assert.ok(hamming(a, dhash(pic(2))) > 2, 'moving the edge changes the hash');
});

test('a still screen is read once per 2 seconds, not once per sampled frame', () => {
  const n = 48; // 24 s at 2 fps
  const picked = pickFrames(film(Array.from({ length: n }, () => pic())), n);
  assert.deepEqual(picked.map((p) => p.t), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
  assert.equal(picked[picked.length - 1].until, 24, 'the last stretch runs to the end of the video');
  picked.slice(0, -1).forEach((p, i) => assert.equal(p.until, picked[i + 1].t, 'each frame stands for everything up to the next one'));
});

test('a change is always picked up, the moment it appears', () => {
  const frames = [...Array(6).fill(pic(4)), ...Array(6).fill(pic(1))]; // changes at sample 6 = 3.0 s
  const picked = pickFrames(film(frames), frames.length);
  assert.ok(picked.some((p) => p.index === 6 && p.t === 6 / SCAN_FPS), 'the first frame after the change is kept');
});

test('every sample counts when the screen keeps changing', () => {
  const frames = Array.from({ length: 8 }, (_, i) => pic(i + 1));
  const picked = pickFrames(film(frames), frames.length);
  assert.equal(picked.length, frames.length);
});
