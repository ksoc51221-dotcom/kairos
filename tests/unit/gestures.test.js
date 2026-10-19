const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../../src/shared/gestures');

// Feeds samples [t, label, score] through step() and returns what came out of each one.
function run(samples, cfg = G.CFG) {
  let state = G.initial();
  return samples.map(([t, label, score = 0.9]) => { const r = G.step(state, { t, label, score }, cfg); state = r.state; return { t, progress: r.progress, fire: r.fire }; });
}
const every = (from, to, label, score, dt = 125) => { const a = []; for (let t = from; t <= to; t += dt) a.push([t, label, score]); return a; };
const fires = (out) => out.filter((o) => o.fire).map((o) => [o.t, o.fire]);

test('hold: a palm held for 1 s fires once, and the ring fills on the way', () => {
  const out = run(every(0, 1500, 'Open_Palm'));
  assert.deepEqual(fires(out), [[1000, 'Open_Palm']]);
  assert.equal(out[0].progress, 0);
  assert.ok(out[4].progress > 0.45 && out[4].progress < 0.55, 'half way at 500 ms: ' + out[4].progress);
  assert.ok(out.slice(1, 8).every((o, i) => o.progress >= out[i].progress), 'the ring only fills');
});

test('hold: thumb up fires thumb up; unknown labels never do', () => {
  assert.deepEqual(fires(run(every(0, 1200, 'Thumb_Up'))), [[1000, 'Thumb_Up']]);
  for (const l of ['Victory', 'Closed_Fist', 'Pointing_Up', 'None', null]) assert.deepEqual(fires(run(every(0, 3000, l))), [], String(l));
});

test('hold: just short of 1 s does not fire', () => {
  assert.deepEqual(fires(run(every(0, 875, 'Open_Palm'))), []);
});

test('break: a gap of 200 ms or less is forgiven, a longer one restarts the timer', () => {
  // 0..500 held, a dropped sample at 625 (gap 125 ms), held again from 750: the original clock keeps running and fires at 1000
  const forgiven = run([...every(0, 500, 'Open_Palm'), [625, null], ...every(750, 1250, 'Open_Palm')]);
  assert.deepEqual(fires(forgiven), [[1000, 'Open_Palm']]);
  // two dropped samples (250 ms with nothing) -> the hold is over; the clock starts again at 875, so it fires at 1875, not 1000
  const broken = run([...every(0, 500, 'Open_Palm'), [625, null], [750, null], ...every(875, 2000, 'Open_Palm')]);
  assert.deepEqual(fires(broken), [[1875, 'Open_Palm']]);
  assert.equal(broken.find((o) => o.t === 875).progress, 0, 'ring empties when the hold breaks');
});

test('break: a gap with no samples at all (the loop stalled) also restarts, on exactly > 200 ms', () => {
  assert.deepEqual(fires(run([[0, 'Open_Palm'], [200, 'Open_Palm'], [400, 'Open_Palm'], [1000, 'Open_Palm'], [1100, 'Open_Palm']])), [], '600 ms silence resets');
  assert.deepEqual(fires(run([[0, 'Open_Palm'], [200, 'Open_Palm'], [400, 'Open_Palm'], [600, 'Open_Palm'], [800, 'Open_Palm'], [1000, 'Open_Palm']])), [[1000, 'Open_Palm']], '200 ms gaps are kept');
});

test('break: switching sign mid-hold restarts the clock for the new sign', () => {
  const out = run([...every(0, 750, 'Open_Palm'), ...every(875, 2000, 'Thumb_Up')]);
  assert.deepEqual(fires(out), [[1875, 'Thumb_Up']]);
});

test('low score: samples under 0.6 never count, and break a hold', () => {
  assert.deepEqual(fires(run(every(0, 3000, 'Open_Palm', 0.59))), []);
  assert.deepEqual(fires(run(every(0, 1000, 'Open_Palm', 0.6))), [[1000, 'Open_Palm']], '0.6 exactly is enough');
  // confidence dips below the bar for 250 ms in the middle -> restart
  const out = run([...every(0, 500, 'Open_Palm', 0.9), [625, 'Open_Palm', 0.3], [750, 'Open_Palm', 0.3], ...every(875, 1750, 'Open_Palm', 0.9)]);
  assert.deepEqual(fires(out), []);
});

test('cooldown: after a command fires, 2 s of the same sign does nothing, then a fresh 1 s hold is needed', () => {
  const out = run(every(0, 5000, 'Open_Palm'));
  // fires at 1000; cooldown to 3000; a new hold starts at the first sample at/after 3000 and fires 1 s later
  assert.deepEqual(fires(out), [[1000, 'Open_Palm'], [4000, 'Open_Palm']]);
  assert.ok(out.filter((o) => o.t > 1000 && o.t < 3000).every((o) => o.progress === 0 && !o.fire), 'ring stays empty during the cooldown');
});

test('cooldown: a different sign is ignored during it too (palm then thumb 1 s later does not stop)', () => {
  const out = run([...every(0, 1000, 'Open_Palm'), ...every(1125, 2875, 'Thumb_Up')]);
  assert.deepEqual(fires(out), [[1000, 'Open_Palm']], 'only the palm fired; the thumb held through the cooldown did not');
  assert.deepEqual(fires(run([...every(0, 1000, 'Open_Palm'), ...every(1125, 4500, 'Thumb_Up')])), [[1000, 'Open_Palm'], [4000, 'Thumb_Up']]);
});

test('step is pure: it never changes the state it was given, and the same input gives the same output', () => {
  const s0 = Object.freeze(G.initial()), a = G.step(s0, { t: 100, label: 'Open_Palm', score: 0.9 });
  assert.deepEqual(a, G.step(s0, { t: 100, label: 'Open_Palm', score: 0.9 }));
  assert.deepEqual(s0, G.initial());
});

test('commands go through the existing controls: palm = toggle-pause (the ⌥⇧P message), thumb = stop (the ⌥⇧S message)', () => {
  assert.deepEqual(G.COMMANDS, { Open_Palm: { control: 'toggle-pause' }, Thumb_Up: { control: 'stop' } });
  assert.deepEqual([G.CFG.holdMs, G.CFG.breakMs, G.CFG.cooldownMs, G.CFG.minScore, G.CFG.hz, G.CFG.maxFrame], [1000, 200, 2000, 0.6, 8, 320]);
});
