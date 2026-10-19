const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../../src/shared/gestures');
const REAL = require('./fixtures/gesture-recording.json'); // [label | null, score] every 125 ms: the owner's own 51 s camera test (palm, thumb up, palm, closed fist, ...)

const P = 'Open_Palm', F = 'Closed_Fist';
// Feeds samples [t, label, score] through step() and returns what came out of each one.
function run(samples, cfg = G.CFG) {
  let state = G.initial();
  return samples.map(([t, label, score = 0.9]) => { const r = G.step(state, { t, label, score }, cfg); state = r.state; return { t, progress: r.progress, fire: r.fire, seen: r.seen }; });
}
const every = (from, to, label, score, dt = 125) => { const a = []; for (let t = from; t <= to; t += dt) a.push([t, label, score]); return a; };
const fires = (out) => out.filter((o) => o.fire).map((o) => [o.t, o.fire]);

test('hold: a palm held for 1 s fires once, and the ring fills on the way', () => {
  const out = run(every(0, 1500, P));
  assert.deepEqual(fires(out), [[1000, P]]);
  assert.equal(out[0].progress, 0);
  assert.ok(out[4].progress > 0.45 && out[4].progress < 0.55, 'half way at 500 ms: ' + out[4].progress);
  assert.ok(out.slice(1, 8).every((o, i) => o.progress >= out[i].progress), 'the ring only fills');
});

test('hold: a closed fist stops only after 1.5 s; thumb up and every other sign do nothing', () => {
  assert.deepEqual(fires(run(every(0, 1375, F))), [], 'just short of 1.5 s');
  assert.deepEqual(fires(run(every(0, 1625, F))), [[1500, F]]);
  for (const l of ['Thumb_Up', 'Thumb_Down', 'Victory', 'Pointing_Up', 'ILoveYou', 'None', null]) assert.deepEqual(fires(run(every(0, 3000, l))), [], String(l));
});

test('hold: just short of 1 s does not fire', () => {
  assert.deepEqual(fires(run(every(0, 875, P))), []);
});

test('gaps: up to 3 missed samples in a row are forgiven (real hands flicker), a 4th restarts the clock', () => {
  // held 0..500, three samples with nothing (625, 750, 875), held again from 1000: the original clock keeps running and fires at 1000
  const forgiven = run([...every(0, 500, P), [625, null], [750, null], [875, null], ...every(1000, 1250, P)]);
  assert.deepEqual(fires(forgiven), [[1000, P]]);
  // four in a row (625..1000, 500 ms with nothing): the hold is over; the clock starts again at 1125, so it fires at 2125, not 1000
  const broken = run([...every(0, 500, P), [625, null], [750, null], [875, null], [1000, null], ...every(1125, 2500, P)]);
  assert.deepEqual(fires(broken), [[2125, P]]);
  assert.equal(broken.find((o) => o.t === 1125).progress, 0, 'ring empties when the hold breaks');
});

test('gaps: a stretch with no samples at all (the loop stalled) restarts on more than 450 ms, and keeps on 450 or less', () => {
  assert.deepEqual(fires(run([[0, P], [200, P], [400, P], [1000, P], [1100, P]])), [], '600 ms of silence resets');
  assert.deepEqual(fires(run([[0, P], [400, P], [800, P], [1000, P]])), [[1000, P]], '400 ms gaps are kept');
});

test('gaps: switching sign mid-hold restarts the clock for the new sign', () => {
  const out = run([...every(0, 750, P), ...every(875, 2500, F)]);
  assert.deepEqual(fires(out), [[2375, F]], 'the palm never fires, the fist needs its own 1.5 s from 875');
});

test('score: each sign has its own bar, and a short dip in confidence is forgiven like a gap', () => {
  assert.deepEqual(fires(run(every(0, 1000, P, 0.5))), [[1000, P]], 'a palm at exactly 0.5 is enough (a real palm scored 0.53-0.78)');
  assert.deepEqual(fires(run(every(0, 3000, P, 0.49))), []);
  assert.deepEqual(fires(run(every(0, 1500, F, 0.6))), [[1500, F]], 'a fist at 0.6 is enough');
  assert.deepEqual(fires(run(every(0, 3000, F, 0.59))), [], 'the fist, which stops the recording, needs a clearer score than the palm');
  const dip = run([...every(0, 500, P, 0.9), [625, P, 0.3], [750, P, 0.3], ...every(875, 1500, P, 0.9)]);
  assert.deepEqual(fires(dip), [[1000, P]], '250 ms of low confidence does not restart the hold');
  const longDip = run([...every(0, 500, P, 0.9), ...every(625, 1000, P, 0.3), ...every(1125, 2500, P, 0.9)]);
  assert.deepEqual(fires(longDip), [[2125, P]], '500 ms of it does');
});

test('cooldown: after a command fires, 1.5 s of any sign does nothing, then a fresh hold is needed', () => {
  const out = run([...every(0, 1000, P), ...every(1125, 4500, F)]);
  // palm fires at 1000; cooldown to 2500; the fist (held through it) starts counting at the first sample at/after 2500 and fires 1.5 s later
  assert.deepEqual(fires(out), [[1000, P], [4000, F]]);
  assert.ok(out.filter((o) => o.t > 1000 && o.t < 2500).every((o) => o.progress === 0 && !o.fire && !o.seen), 'ring and hint stay empty during the cooldown');
  assert.deepEqual(fires(run([...every(0, 1000, P), ...every(1125, 3875, F)])), [[1000, P]], 'a fist that ends before its own 1.5 s never fires');
});

test('lock: a palm kept up after it fired does nothing more, so pause and resume never flip-flop on their own', () => {
  assert.deepEqual(fires(run(every(0, 12000, P))), [[1000, P]], 'ten more seconds of the same hand up: no second command');
  // hand away for 750 ms (not enough), then the palm is back: still locked, and it stays locked while it is held
  assert.deepEqual(fires(run([...every(0, 1000, P), ...every(1125, 1750, null), ...every(1875, 8000, P)])), [[1000, P]]);
  // hand away for 1.25 s (more than the 0.8 s release): the palm counts again, from the first sample after the cooldown
  assert.deepEqual(fires(run([...every(0, 1000, P), ...every(1125, 2375, null), ...every(2500, 4000, P)])), [[1000, P], [3500, P]]);
  // another sign in between also releases it
  assert.deepEqual(fires(run([...every(0, 1000, P), ...every(1125, 2375, 'Thumb_Up'), ...every(2500, 4000, P)])), [[1000, P], [3500, P]]);
});

test('seen: reports the sign being held (for the "hold to pause" hint), and nothing otherwise', () => {
  const out = run(every(0, 875, P));
  assert.ok(out.every((o) => o.seen === P));
  assert.ok(run(every(0, 875, 'Thumb_Up')).every((o) => o.seen === null), 'a sign that is not a command is not announced');
  assert.ok(run(every(0, 875, P, 0.2)).every((o) => o.seen === null), 'neither is one below its score bar');
  const mid = run([...every(0, 500, F), [625, null], ...every(750, 875, F)]);
  assert.ok(mid.every((o) => o.seen === F), 'a forgiven gap keeps the hint up');
  const after = run(every(0, 2000, P));
  assert.ok(after.filter((o) => o.t >= 1000 && o.t <= 2000).every((o) => o.seen === null), 'no hint once it has fired');
});

test('step is pure: it never changes the state it was given, and the same input gives the same output', () => {
  const s0 = Object.freeze(G.initial()), a = G.step(s0, { t: 100, label: P, score: 0.9 });
  assert.deepEqual(a, G.step(s0, { t: 100, label: P, score: 0.9 }));
  assert.deepEqual(s0, G.initial());
  const locked = Object.freeze({ ...G.initial(), lock: P, cooldownUntil: 5000 });
  assert.doesNotThrow(() => G.step(locked, { t: 200, label: null, score: 0 }));
});

test('commands go through the existing controls: palm = toggle-pause (the ⌥⇧P message), fist = stop (the ⌥⇧S message)', () => {
  assert.deepEqual(G.COMMANDS, { Open_Palm: { control: 'toggle-pause', holdMs: 1000, minScore: 0.5 }, Closed_Fist: { control: 'stop', holdMs: 1500, minScore: 0.6 } });
  assert.deepEqual([G.CFG.holdMs, G.CFG.breakMs, G.CFG.cooldownMs, G.CFG.releaseMs, G.CFG.minScore, G.CFG.hz, G.CFG.maxFrame], [1000, 450, 1500, 800, 0.5, 8, 320]);
});

// The owner's own camera test (51 s, 410 recognitions at 8 a second): palm, thumb up, palm for half a minute, a closed fist for 1.25 s, palm, thumb up.
// The first version of the rules (palm bar 0.6, gap limit 200 ms) fired on this stream too, but the feature was switched off in that session; these
// numbers are what the rules do on a real hand, so a change that makes a real palm stop working shows up here.
test('real recording: palm toggles pause, a hand left up does not repeat it, thumb up does nothing, a 1.25 s fist is not enough to stop', () => {
  const samples = REAL.map(([label, score], i) => [i * 125, label, score]);
  assert.equal(samples.length, 410);
  assert.deepEqual(fires(run(samples)), [[1250, P], [14250, P], [41875, P], [46125, P]]);
  // the same fist held 0.75 s longer (2 s) does stop the recording, 1.5 s after it starts
  const i0 = REAL.findIndex(([l]) => l === F);
  const stretched = [...REAL.slice(0, i0), ...Array(6).fill(REAL[i0]), ...REAL.slice(i0)].map(([label, score], i) => [i * 125, label, score]);
  const f = fires(run(stretched));
  assert.deepEqual(f.map((x) => x[1]), [P, P, F, P, P]);
  assert.equal(f[2][0], i0 * 125 + 1500, 'the stop fires 1.5 s after the fist first showed');
});
