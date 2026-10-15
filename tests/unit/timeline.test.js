const test = require('node:test');
const assert = require('node:assert/strict');
const { Timeline } = require('../../src/shared/timeline');

const near = (a, b, tol = 0.002) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const T0 = 1_000_000; // arbitrary epoch ms

test('segments: start, stop and elapsed time', () => {
  const t = new Timeline({ mode: 'screen' });
  assert.equal(t.start(T0), 0); assert.equal(t.start(T0 + 50), 0, 'starting twice is a no-op');
  near(t.t(T0 + 2500), 2.5);
  const seg = t.stop(T0 + 3000); assert.deepEqual(seg, { n: 0, t0: 0, dur: 3 });
  near(t.t(T0 + 99999), 3, 1e-9); // paused: time stands still
  assert.equal(t.stop(T0 + 4000), null, 'stopping twice is a no-op');
  assert.equal(t.start(T0 + 4000), 1);
  assert.deepEqual(t.stop(T0 + 6000), { n: 1, t0: 3, dur: 2 });
  assert.equal(t.totalDuration(), 5);
});

test('the plan scenario: pause@3 resume@4 [pause@6, rewind to 2 s @6.5], stop@10', () => {
  const t = new Timeline();
  t.start(T0); t.stop(T0 + 3000);            // 3.0 s recorded
  t.start(T0 + 4000); t.stop(T0 + 6000);     // +2.0 s -> 5.0 s
  assert.equal(t.totalDuration(), 5);
  const dropped = t.rewind(2);                // keep the first 2 s
  assert.deepEqual(dropped, [1], 'segment 1 no longer contributes');
  assert.equal(t.segments.length, 1); assert.equal(t.segments[0].dur, 2);
  t.start(T0 + 6500); t.stop(T0 + 10000);    // re-record 3.5 s
  assert.equal(t.totalDuration(), 5.5);
  assert.deepEqual(t.segments.map((s) => [s.n, s.t0, s.dur]), [[0, 0, 2], [2, 2, 3.5]]);
});

test('the simpler scenario: pause@3 resume@4 stop@10 records 9 s', () => {
  const t = new Timeline(); t.start(T0); t.stop(T0 + 3000); t.start(T0 + 4000); t.stop(T0 + 10000);
  assert.equal(t.totalDuration(), 9);
});

test('rewind needs a pause, clamps its range and drops what came after', () => {
  const t = new Timeline(); t.start(T0);
  assert.throws(() => t.rewind(1), /paused/);
  t.addCursor(T0 + 500, 0.1, 0.1); t.addCursor(T0 + 2500, 0.2, 0.2); t.addClick(T0 + 2600, 0.3, 0.3, 1); t.addDrawing(T0 + 2700, true);
  t.setBubble(T0 + 2800, { x: 0.1, y: 0.1, w: 0.1, h: 0.1, shape: 'circle', filter: 'none', frame: 'ring' });
  t.stop(T0 + 3000);
  t.rewind(99); assert.equal(t.totalDuration(), 3, 'cannot rewind past the end');
  t.rewind(1);
  assert.equal(t.cursor.length, 1); assert.equal(t.clicks.length, 0); assert.equal(t.drawing.length, 0); assert.equal(t.bubble.length, 0);
  assert.equal(t.totalDuration(), 1);
  t.rewind(0); assert.equal(t.segments.length, 0, 'rewinding to the start leaves nothing');
});

test('events are mapped onto the recorded timeline and ignored while paused', () => {
  const t = new Timeline();
  assert.equal(t.addCursor(T0, 0.5, 0.5), false, 'nothing is running yet');
  t.start(T0);
  assert.equal(t.addCursor(T0 - 5, 0.5, 0.5), false, 'older than the segment');
  assert.equal(t.addCursor(T0 + 1000, 0.25, 0.75), true); assert.equal(t.addClick(T0 + 1500, 0.1, 0.2, 2), true);
  t.stop(T0 + 2000);
  assert.equal(t.addCursor(T0 + 3000, 0.9, 0.9), false, 'paused');
  t.start(T0 + 5000); // second segment begins at t=2
  t.addCursor(T0 + 5500, 0.4, 0.4);
  assert.deepEqual(t.cursor, [[1, 0.25, 0.75], [2.5, 0.4, 0.4]]);
  assert.deepEqual(t.clicks, [[1.5, 0.1, 0.2, 2]]);
});

test('bubble keyframes skip duplicates and replace same-instant updates', () => {
  const t = new Timeline(); t.start(T0);
  const b = { x: 0.1, y: 0.7, w: 0.14, h: 0.25, shape: 'circle', filter: 'none', frame: 'ring', visible: true };
  assert.equal(t.setBubble(T0, b), true); assert.equal(t.setBubble(T0 + 100, b), false, 'unchanged');
  assert.equal(t.setBubble(T0 + 1000, { ...b, x: 0.5 }), true);
  assert.equal(t.setBubble(T0 + 1000, { ...b, x: 0.6 }), true); // same instant: latest wins
  assert.equal(t.setBubble(T0 + 2000, { ...b, x: 0.6, visible: false }), true);
  assert.deepEqual(t.bubble, [[0, 0.1, 0.7, 0.14, 0.25, 'circle', 'none', 'ring', 1], [1, 0.6, 0.7, 0.14, 0.25, 'circle', 'none', 'ring', 1], [2, 0.6, 0.7, 0.14, 0.25, 'circle', 'none', 'ring', 0]]);
});

test('toJSON has the timeline.json shape from the plan', () => {
  const t = new Timeline({ mode: 'screen-cam', crop: null, display: { width: 1440, height: 900, scaleFactor: 2 } });
  t.start(T0); t.addCursor(T0 + 16, 0.5, 0.5); t.stop(T0 + 1000);
  const j = t.toJSON({ 0: { screen: 'screen_0.mp4', cam: 'cam_0.mp4' } });
  assert.equal(j.version, 2); assert.equal(j.mode, 'screen-cam'); assert.equal(j.duration, 1);
  assert.deepEqual(j.segments, [{ n: 0, t0: 0, dur: 1, screen: 'screen_0.mp4', cam: 'cam_0.mp4' }]);
  for (const k of ['bubble', 'cursor', 'clicks', 'drawing']) assert.ok(Array.isArray(j[k]), k);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(j)));
});
