const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFilter, nextDelay } = require('../../src/shared/cursor');

const feed = (push, rows) => rows.flatMap(([at, x, y]) => push(at, x, y));

test('a moving cursor keeps every tick (the 60 Hz feed)', () => {
  const push = makeFilter(); const out = feed(push, Array.from({ length: 60 }, (_, i) => [i * 16.667, i / 100, 0.5]));
  assert.equal(out.length, 60);
});

test('a still cursor is stored once, then once per keepalive interval', () => {
  const push = makeFilter({ keepaliveMs: 200 });
  const out = feed(push, Array.from({ length: 61 }, (_, i) => [i * 16.667, 0.3, 0.4])); // one second, not moving
  assert.deepEqual(out.map((r) => Math.round(r[0])), [0, 200, 400, 600, 800, 1000]);
});

test('a move after a still spell first stores the last still sample, so playback does not glide early', () => {
  const push = makeFilter({ keepaliveMs: 200 });
  const out = feed(push, [[0, 0.3, 0.4], [16, 0.3, 0.4], [33, 0.3, 0.4], [50, 0.3, 0.4], [66, 0.5, 0.4]]);
  assert.deepEqual(out, [[0, 0.3, 0.4], [50, 0.3, 0.4], [66, 0.5, 0.4]]);
});

test('the very first tick is always stored', () => {
  assert.deepEqual(makeFilter()(1234.5, 0.1, 0.2), [[1234.5, 0.1, 0.2]]);
});

test('the timer aims at a fixed grid: one late tick does not shift the ones after it', () => {
  const st = { t0: 1000, n: 0 }, period = 1000 / 60;
  let now = st.t0; const fired = [];
  for (let i = 0; i < 6; i++) {
    const wait = nextDelay(st, now, period); now += wait; if (i === 2) now += 9; // the third tick runs 9 ms late
    fired.push(now);
  }
  assert.ok(Math.abs(fired[3] - (st.t0 + 4 * period)) < 1e-6, 'tick 4 is back on the grid');
  assert.ok(Math.abs(fired[5] - (st.t0 + 6 * period)) < 1e-6);
});

test('a long stall skips ahead instead of firing a burst of catch-up ticks', () => {
  const st = { t0: 0, n: 10 }, period = 1000 / 60;
  const wait = nextDelay(st, 10 * period + 500, period); // 500 ms behind
  assert.ok(wait >= 0 && wait <= period, `waits ${wait.toFixed(2)} ms for the next slot`);
  assert.ok(st.n > 38, 'the tick counter jumped past the missed slots');
});
