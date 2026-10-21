const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../../src/shared/gestures');
const REAL = require('./fixtures/gesture-recording.json'); // [label | null, score] every 125 ms: the owner's own 51 s camera test (palm, thumb up, palm, closed fist, ...)
const HANDS = require('./fixtures/hand-landmarks.json').map(([label, score, flat]) => ({ label, score, wl: Array.from({ length: 21 }, (_, i) => flat.slice(i * 3, i * 3 + 3)) })); // same recording, every 4th frame, world landmarks only

const P = 'pause', S = 'stop';
// Feeds samples [t, command, score] through step() and returns what came out of each one.
function run(samples, cfg = G.CFG) {
  let state = G.initial();
  return samples.map(([t, label, score = 0.9, at]) => { const r = G.step(state, { t, label, score, at }, cfg); state = r.state; return { t, progress: r.progress, fire: r.fire, seen: r.seen, at: r.at, held: r.held }; });
}
const every = (from, to, label, score, dt = 125) => { const a = []; for (let t = from; t <= to; t += dt) a.push([t, label, score]); return a; };
const fires = (out) => out.filter((o) => o.fire).map((o) => [o.t, o.fire]);

test('hold: a pause sign held for 1 s fires once, and the ring fills on the way', () => {
  const out = run(every(0, 1500, P));
  assert.deepEqual(fires(out), [[1000, P]]);
  assert.equal(out[0].progress, 0);
  assert.ok(out[4].progress > 0.45 && out[4].progress < 0.55, 'half way at 500 ms: ' + out[4].progress);
  assert.ok(out.slice(1, 8).every((o, i) => o.progress >= out[i].progress), 'the ring only fills');
});

test('hold: stop needs 2 s, twice as long as pause; zoom in and out never fire (they are holds); signs that are not commands do nothing', () => {
  assert.deepEqual(fires(run(every(0, 1875, S))), [], 'just short of 2 s');
  assert.deepEqual(fires(run(every(0, 2125, S))), [[2000, S]]);
  assert.deepEqual(fires(run(every(0, 12000, 'zoom'))), [], 'twelve seconds of crossed fingers: still no command, the bubble zooms by itself while it is held');
  assert.deepEqual(fires(run(every(0, 12000, 'zoomout'))), [], 'and twelve seconds of the X: the same');
  for (const l of ['Thumb_Up', 'Thumb_Down', 'Victory', 'Pointing_Up', 'ILoveYou', 'None', 'Open_Palm', 'Closed_Fist', null]) assert.deepEqual(fires(run(every(0, 4000, l))), [], String(l));
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
  const out = run([...every(0, 750, P), ...every(875, 3000, S)]);
  assert.deepEqual(fires(out), [[2875, S]], 'the pause never fires, stop needs its own 2 s from 875');
});

test('score: each command has its own bar, and a short dip in confidence is forgiven like a gap', () => {
  assert.deepEqual(fires(run(every(0, 1000, P, 0.5))), [[1000, P]], 'a palm at exactly 0.5 is enough (a real palm scored 0.53-0.78)');
  assert.deepEqual(fires(run(every(0, 3000, P, 0.49))), []);
  assert.deepEqual(fires(run(every(0, 2000, S, 0.6))), [[2000, S]], 'stop at 0.6 is enough');
  assert.deepEqual(fires(run(every(0, 3000, S, 0.59))), [], 'stop, which ends the recording, needs a clearer score than pause');
  const dip = run([...every(0, 500, P, 0.9), [625, P, 0.3], [750, P, 0.3], ...every(875, 1500, P, 0.9)]);
  assert.deepEqual(fires(dip), [[1000, P]], '250 ms of low confidence does not restart the hold');
  const longDip = run([...every(0, 500, P, 0.9), ...every(625, 1000, P, 0.3), ...every(1125, 2500, P, 0.9)]);
  assert.deepEqual(fires(longDip), [[2125, P]], '500 ms of it does');
});

test('cooldown: after a command fires, 1.5 s of any sign does nothing, then a fresh hold is needed', () => {
  const out = run([...every(0, 1000, P), ...every(1125, 5000, S)]);
  // pause fires at 1000; cooldown to 2500; stop (held through it) starts counting at the first sample at/after 2500 and fires 2 s later
  assert.deepEqual(fires(out), [[1000, P], [4500, S]]);
  assert.ok(out.filter((o) => o.t > 1000 && o.t < 2500).every((o) => o.progress === 0 && !o.fire && !o.seen), 'ring and hint stay empty during the cooldown');
  assert.deepEqual(fires(run([...every(0, 1000, P), ...every(1125, 4375, S)])), [[1000, P]], 'a stop sign that ends before its own 2 s never fires');
});

test('lock: a pause sign kept up after it fired does nothing more, so pause and resume never flip-flop on their own', () => {
  assert.deepEqual(fires(run(every(0, 12000, P))), [[1000, P]], 'ten more seconds of the same hand up: no second command');
  // hand away for 750 ms (not enough), then the sign is back: still locked, and it stays locked while it is held
  assert.deepEqual(fires(run([...every(0, 1000, P), ...every(1125, 1750, null), ...every(1875, 8000, P)])), [[1000, P]]);
  // hand away for 1.25 s (more than the 0.8 s release): the sign counts again, from the first sample after the cooldown
  assert.deepEqual(fires(run([...every(0, 1000, P), ...every(1125, 2375, null), ...every(2500, 4000, P)])), [[1000, P], [3500, P]]);
  // another sign in between also releases it
  assert.deepEqual(fires(run([...every(0, 1000, P), ...every(1125, 2375, 'Thumb_Up'), ...every(2500, 4000, P)])), [[1000, P], [3500, P]]);
});

test('seen: reports the sign being held (for the "hold to pause" hint), and nothing otherwise', () => {
  const out = run(every(0, 875, P));
  assert.ok(out.every((o) => o.seen === P));
  assert.ok(run(every(0, 875, 'Thumb_Up')).every((o) => o.seen === null), 'a sign that is not a command is not announced');
  assert.ok(run(every(0, 875, P, 0.2)).every((o) => o.seen === null), 'neither is one below its score bar');
  const mid = run([...every(0, 500, S), [625, null], ...every(750, 875, S)]);
  assert.ok(mid.every((o) => o.seen === S), 'a forgiven gap keeps the hint up');
  const after = run(every(0, 2000, P));
  assert.ok(after.filter((o) => o.t >= 1000 && o.t <= 2000).every((o) => o.seen === null), 'no hint once it has fired');
});

test('zoom is a hold, not a command: nothing fires, held says for how long, the ring fills in 0.4 s and then clears', () => {
  const out = run(every(0, 3000, 'zoom'));
  assert.ok(out.every((o) => o.fire === null && o.seen === 'zoom'), 'seen the whole time, never fired');
  assert.deepEqual(out.slice(0, 4).map((o) => o.held), [0, 125, 250, 375], 'held = how long the sign has been up');
  assert.equal(out[24].held, 3000);
  assert.ok(out[2].progress > 0.5 && out[2].progress < 0.7, 'the ring is filling: ' + out[2].progress);
  assert.ok(out.filter((o) => o.t >= 500).every((o) => o.progress === 0), 'once the sign counts (400 ms) the ring is gone and the zoom takes over');
  assert.ok(out.filter((o) => o.held < G.COMMANDS.zoom.holdMs).length === 4, 'the first four samples (0..375 ms) are still arming');
  // a forgiven gap keeps the hold (and its clock); a longer one ends it and the next sample starts again at 0
  const gap = run([...every(0, 1000, 'zoom'), [1125, null], [1250, null], ...every(1375, 2000, 'zoom')]);
  assert.equal(gap.find((o) => o.t === 2000).held, 2000, 'two missed samples are forgiven: one hold of 2 s');
  assert.equal(gap.find((o) => o.t === 1125).held, 1125, 'and the hold carries on through them');
  const broken = run([...every(0, 1000, 'zoom'), ...every(1125, 1625, null), ...every(1750, 2000, 'zoom')]);
  assert.equal(broken.find((o) => o.t === 1750).held, 0, 'half a second without the sign: a new hold');
  // another command in the middle of it is not blocked, and does not inherit the clock
  const then = run([...every(0, 2000, 'zoom'), ...every(2125, 3250, P)]);
  assert.deepEqual(fires(then), [[3125, P]]);
});

test('position: the zoom sign carries where the hand points for as long as it is held', () => {
  const at = (t) => ({ x: 0.2 + t / 10000, y: 0.6 });
  const out = run(every(0, 2000, 'zoom').map(([t, l, s]) => [t, l, s, at(t)]));
  assert.deepEqual(out[0].at, at(0), 'the hint can show a marker from the first sample');
  assert.deepEqual(out[16].at, at(2000), 'and it follows the hand while the picture zooms in');
  const gone = run([...every(0, 500, 'zoom').map(([t, l, s]) => [t, l, s, at(t)]), [625, null]]);
  assert.deepEqual(gone[gone.length - 1].at, at(500), 'a forgiven gap keeps the last position');
  const ended = run([...every(0, 500, 'zoom').map(([t, l, s]) => [t, l, s, at(t)]), ...every(625, 1250, null)]);
  assert.equal(ended[ended.length - 1].at, null, 'nothing is pointed at once the sign is gone');
});

test('zoom out is a hold like zoom in: nothing fires, it counts after 0.4 s, and switching from one to the other starts the new clock', () => {
  const out = run(every(0, 3000, 'zoomout'));
  assert.ok(out.every((o) => o.fire === null && o.seen === 'zoomout'), 'seen the whole time, never fired');
  assert.equal(out.filter((o) => o.held < G.COMMANDS.zoomout.holdMs).length, 4, 'the first four samples (0..375 ms) are still arming');
  assert.equal(out[24].held, 3000);
  assert.ok(out.filter((o) => o.t >= 500).every((o) => o.progress === 0), 'once it counts the ring is gone and the zoom takes over');
  const sw = run([...every(0, 1000, 'zoom'), ...every(1125, 2000, 'zoomout')]);
  assert.deepEqual([sw.find((o) => o.t === 1125).seen, sw.find((o) => o.t === 1125).held, sw.find((o) => o.t === 2000).held], ['zoomout', 0, 875], 'the X after crossed fingers starts at 0');
  assert.deepEqual(fires(run([...every(0, 2000, 'zoomout'), ...every(2125, 3250, P)])), [[3125, P]], 'and a pause sign right after it is not blocked');
});

test('step is pure: it never changes the state it was given, and the same input gives the same output', () => {
  const s0 = Object.freeze(G.initial()), a = G.step(s0, { t: 100, label: P, score: 0.9 });
  assert.deepEqual(a, G.step(s0, { t: 100, label: P, score: 0.9 }));
  assert.deepEqual(s0, G.initial());
  const locked = Object.freeze({ ...G.initial(), lock: P, cooldownUntil: 5000 });
  assert.doesNotThrow(() => G.step(locked, { t: 200, label: null, score: 0 }));
});

test('commands: pause = the ⌥⇧P message after 1 s, stop = the ⌥⇧S message after 2 s, zoom in and out = holds that count after 0.4 s; defaults are palm, fist, crossed fingers and an X of both index fingers', () => {
  assert.deepEqual(G.COMMANDS, {
    pause: { control: 'toggle-pause', holdMs: 1000, minScore: 0.5 },
    stop: { control: 'stop', holdMs: 2000, minScore: 0.6 },
    zoom: { control: 'zoom-in', continuous: true, holdMs: 400, minScore: 0.5 },
    zoomout: { control: 'zoom-out', continuous: true, holdMs: 400, minScore: 0.5, twoHands: true },
  });
  assert.deepEqual(G.DEFAULT_SIGN, { pause: 'Open_Palm', stop: 'Closed_Fist', zoom: 'crossed', zoomout: 'cross-x' });
  assert.deepEqual(G.NAMES, { pause: 'Pause', stop: 'Stop', zoom: 'Zoom in', zoomout: 'Zoom out' });
  assert.deepEqual([G.CFG.holdMs, G.CFG.breakMs, G.CFG.cooldownMs, G.CFG.releaseMs, G.CFG.minScore, G.CFG.hz, G.CFG.maxFrame], [1000, 450, 1500, 800, 0.5, 8, 320]);
});

// ---------------- classify: which command is a hand asking for ----------------
// A synthetic hand: 21 world landmarks in metres, fingers up (-y), bending towards +z. curl = bend per joint for thumb..pinky (radians, 1.0 = a fully curled finger),
// tilt = sideways lean of each finger at its knuckle (radians, +x). Sizes are those of a real hand (palm about 9 cm).
function hand({ curl = [0, 0, 0, 0, 0], tilt = [0, 0, 0, 0, 0] } = {}) {
  const base = [[-0.03, -0.025, 0], [-0.03, -0.09, 0], [-0.005, -0.095, 0], [0.02, -0.09, 0], [0.04, -0.08, 0]];
  const seg = [[0.04, 0.03, 0.03], [0.04, 0.025, 0.02], [0.045, 0.028, 0.022], [0.04, 0.026, 0.02], [0.032, 0.02, 0.018]];
  const p = [[0, 0, 0]];
  for (let f = 0; f < 5; f++) {
    let q = base[f], phi = 0; p.push(q);
    for (let s = 0; s < 3; s++) {
      phi += curl[f];
      const d = [Math.sin(tilt[f]) * Math.cos(phi), -Math.cos(tilt[f]) * Math.cos(phi), Math.sin(phi)];
      q = [q[0] + d[0] * seg[f][s], q[1] + d[1] * seg[f][s], q[2] + d[2] * seg[f][s]]; p.push(q);
    }
  }
  return p;
}
const PALM = hand(), FIST = hand({ curl: [0.5, 1, 1, 1, 1] }), POINT = hand({ curl: [0.5, 0, 1, 1, 1] });
const CROSSED = hand({ curl: [0.5, 0, 0, 1, 1], tilt: [0, 0.45, -0.3, 0, 0] }), VEE = hand({ curl: [0.5, 0, 0, 1, 1], tilt: [0, -0.25, 0.25, 0, 0] }), TOGETHER = hand({ curl: [0.5, 0, 0, 1, 1], tilt: [0, 0.1, -0.1, 0, 0] });
// image landmarks for the same hand: fractions of the frame, index and middle fingertips at (x, y)
const image = (x, y) => Array.from({ length: 21 }, (_, i) => ({ x: i === 8 || i === 12 ? x : 0.5, y: i === 8 || i === 12 ? y : 0.7, z: 0 }));
// a rotation about all three axes, a mirror and a different size: the same pose
function moved(p, scale = 1.7) {
  const [a, b, c] = [0.7, -1.1, 2.3], rx = ([x, y, z]) => [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)], ry = ([x, y, z]) => [x * Math.cos(b) + z * Math.sin(b), y, -x * Math.sin(b) + z * Math.cos(b)], rz = ([x, y, z]) => [x * Math.cos(c) - y * Math.sin(c), x * Math.sin(c) + y * Math.cos(c), z];
  return p.map(([x, y, z]) => rz(ry(rx([-x * scale, y * scale, z * scale]))));
}

test('features: the same pose gives the same 32 numbers when the hand is turned, mirrored or nearer to the camera', () => {
  for (const p of [PALM, FIST, CROSSED, HANDS[3].wl, HANDS[60].wl]) {
    const f = G.features(p), g = G.features(moved(p));
    assert.equal(f.length, 32);
    assert.ok(G.dist(f, g) < 1e-6, 'distance after moving: ' + G.dist(f, g));
  }
  assert.ok(G.dist(G.features(PALM), G.features(FIST)) > 0.3, 'a palm and a fist are far apart');
  assert.deepEqual(G.features(HANDS[3].wl), G.features(HANDS[3].wl.map(([x, y, z]) => ({ x, y, z }))), 'object landmarks (what MediaPipe returns) work like arrays');
});

test('crossed fingers: index and middle up and together or crossed, ring and pinky curled', () => {
  assert.ok(G.crossedScore(CROSSED) >= 0.5, 'crossed over: ' + G.crossedScore(CROSSED));
  assert.ok(G.crossedScore(TOGETHER) >= 0.5, 'side by side (what MediaPipe may report for crossed fingers): ' + G.crossedScore(TOGETHER));
  assert.ok(G.crossedScore(moved(CROSSED)) >= 0.5, 'turned and mirrored');
  assert.equal(G.crossedScore(VEE), 0, 'a peace sign, fingers apart, is not crossed');
  for (const [name, p] of [['open palm', PALM], ['fist', FIST], ['pointing', POINT]]) assert.equal(G.crossedScore(p), 0, name);
});

test('crossed fingers: none of the 101 frames of a real hand (palm, thumb up, fist, in between) counts as crossed', () => {
  const worst = Math.max(...HANDS.map((h) => G.crossedScore(h.wl)));
  assert.ok(worst < 0.5, 'highest score on real frames: ' + worst);
});

test('classify: by default an open palm is pause, a closed fist is stop, crossed fingers are zoom', () => {
  assert.equal(G.classify({ label: 'Open_Palm', score: 0.66 }).id, 'pause');
  assert.equal(G.classify({ label: 'Closed_Fist', score: 0.7 }).id, 'stop');
  assert.equal(G.classify({ label: 'Closed_Fist', score: 0.55 }), null, 'a fist below the stop bar of 0.6 is nothing');
  assert.equal(G.classify({ label: 'Open_Palm', score: 0.4 }), null);
  for (const l of ['Thumb_Up', 'Victory', 'Pointing_Up', 'None']) assert.equal(G.classify({ label: l, score: 0.9 }), null, l);
  assert.equal(G.classify(null), null);
  const z = G.classify({ label: 'Victory', score: 0.8, wl: CROSSED, lm: image(0.31, 0.42) });
  assert.equal(z.id, 'zoom');
  assert.deepEqual(z.at, { x: 0.31, y: 0.42 }, 'where the two fingertips are, in the raw frame');
  assert.equal(G.classify({ label: 'Victory', score: 0.8, wl: VEE, lm: image(0.3, 0.4) }), null, 'a peace sign does nothing');
  assert.equal(G.classify({ label: 'Open_Palm', score: 0.66, wl: PALM, lm: image(0.3, 0.4) }).id, 'pause', 'landmarks do not get in the way of the canned signs');
});

test('classify: a taught sign replaces the default for that command only', () => {
  const thumb = HANDS.filter((h) => h.label === 'Thumb_Up'), palm = HANDS.filter((h) => h.label === 'Open_Palm'), fist = HANDS.filter((h) => h.label === 'Closed_Fist');
  const mean = (list) => list[0].map((_, i) => list.reduce((s, v) => s + v[i], 0) / list.length), tpl = (hs) => mean(hs.map((h) => G.features(h.wl)));
  const signs = { pause: { ex: [tpl(thumb.slice(0, 4)), tpl(thumb.slice(14, 18))] } };
  const asked = (h, s = signs) => (G.classify({ label: h.label, score: h.score, wl: h.wl }, s) || {}).id || null;
  assert.equal(thumb.filter((h) => asked(h) === 'pause').length, thumb.length, 'every thumb up frame is the taught pause sign');
  assert.equal(palm.filter((h) => asked(h) === 'pause').length, 0, 'the open palm no longer pauses once pause was taught');
  assert.equal(palm.length, palm.filter((h) => asked(h, {}) === 'pause').length, 'and it still does with no taught sign (default)');
  assert.equal(fist.filter((h) => asked(h) === 'stop').length, fist.length, 'stop keeps its default, the closed fist');
});

test('a taught palm (two takes a few seconds apart) is found in every palm frame of the recording and in no thumb up, fist or in-between frame', () => {
  const palm = HANDS.filter((h) => h.label === 'Open_Palm');
  const mean = (list) => list[0].map((_, i) => list.reduce((s, v) => s + v[i], 0) / list.length), tpl = (hs) => mean(hs.map((h) => G.features(h.wl)));
  const sign = { ex: [tpl(palm.slice(0, 4)), tpl(palm.slice(30, 34))] };
  const found = (label, bar) => HANDS.filter((h) => (h.label || 'none') === label && G.matchScore(G.features(h.wl), sign.ex) >= bar).length;
  assert.equal(found('Open_Palm', 0.5), palm.length, 'the pause bar (0.5)');
  assert.equal(found('Open_Palm', 0.6), palm.length, 'even the stop bar (0.6)');
  for (const l of ['Thumb_Up', 'Closed_Fist', 'None']) assert.equal(found(l, 0.5), 0, l);
});

// ---------------- zoom out: both index fingers crossed in an X ----------------
// A hand for the X: the index finger out and the rest curled (world landmarks), and the index finger drawn in the picture from its knuckle k to its tip t (fractions of the frame).
const pointer = (k, t, wl = POINT) => ({ wl, lm: Array.from({ length: 21 }, (_, i) => (i === 5 ? { x: k[0], y: k[1], z: 0 } : i === 8 ? { x: t[0], y: t[1], z: 0 } : { x: k[0], y: k[1] + 0.1, z: 0 })) });
const xHands = () => [pointer([0.4, 0.8], [0.52, 0.45]), pointer([0.6, 0.8], [0.48, 0.45])]; // the right finger leans left, the left one right, they cross half way up
const TWO = require('./fixtures/two-hands.json'); // 23 recognitions with two hands, landmarks only (see its note)
const seenHands = (f) => f.hands.map((h) => ({ label: h.label, score: h.score, lm: Array.from({ length: 21 }, (_, i) => ({ x: h.lm[i * 2], y: h.lm[i * 2 + 1], z: 0 })), wl: Array.from({ length: 21 }, (_, i) => h.wl.slice(i * 3, i * 3 + 3)) }));

test('X: two index fingers that cross in the picture, the other fingers curled, count; the order of the hands, and a third hand in view, do not matter', () => {
  const s = G.crossXScore(xHands());
  assert.ok(s >= 0.5 && s <= 1, 'score ' + s);
  assert.equal(G.crossXScore(xHands().reverse()), s);
  assert.ok(G.crossXScore([pointer([0.4, 0.8], [0.58, 0.45]), pointer([0.6, 0.8], [0.42, 0.45])]) >= 0.5, 'the tips past each other');
  assert.ok(G.crossXScore([pointer([0.1, 0.8], [0.1, 0.45], PALM), ...xHands()]) >= 0.5, 'a palm in the corner as well');
});

test('X: parallel fingers, a V, a meeting far beyond the tips, or a shallow angle are not an X; nor are palms, peace signs, one hand or nothing', () => {
  const below = (name, hands, ar) => assert.ok(G.crossXScore(hands, ar) < 0.5, name + ': ' + G.crossXScore(hands, ar));
  below('parallel', [pointer([0.4, 0.8], [0.4, 0.45]), pointer([0.6, 0.8], [0.6, 0.45])]);
  below('a V (pointing apart, never meeting)', [pointer([0.4, 0.8], [0.3, 0.45]), pointer([0.6, 0.8], [0.7, 0.45])]);
  below('lines that only meet far above the tips', [pointer([0.4, 0.8], [0.45, 0.6]), pointer([0.6, 0.8], [0.55, 0.6])]);
  below('they touch at the tips but at about 20 degrees', [pointer([0.47, 0.8], [0.5, 0.45]), pointer([0.53, 0.8], [0.5, 0.45])]);
  below('two open palms in the same places', [pointer([0.4, 0.8], [0.52, 0.45], PALM), pointer([0.6, 0.8], [0.48, 0.45], PALM)]);
  below('a peace sign in each hand', [pointer([0.4, 0.8], [0.52, 0.45], VEE), pointer([0.6, 0.8], [0.48, 0.45], VEE)]);
  below('one pointing hand and one palm', [pointer([0.4, 0.8], [0.52, 0.45]), pointer([0.6, 0.8], [0.48, 0.45], PALM)]);
  below('one hand', [xHands()[0]]);
  below('no hands', []);
  below('nothing at all', undefined);
  below('a finger with no length', [pointer([0.4, 0.8], [0.4, 0.8]), pointer([0.6, 0.8], [0.48, 0.45])]);
  below('image landmarks of one hand and world landmarks of the other', [{ wl: POINT }, { lm: xHands()[1].lm }]);
});

test('X: the angle is judged in the picture as it is, so the shape of the frame counts (the same lines are a clear X in 16:9 and too shallow in a square)', () => {
  const narrow = [pointer([0.47, 0.8], [0.53, 0.45]), pointer([0.53, 0.8], [0.47, 0.45])];
  assert.ok(G.crossXScore(narrow, 16 / 9) >= 0.5);
  assert.ok(G.crossXScore(narrow, 1) < 0.5);
});

test('X on real hands: all 9 recognitions of the owner crossing both index fingers count, none of the 14 other two-hand frames does', () => {
  const xs = TWO.frames.filter((f) => f.x), others = TWO.frames.filter((f) => !f.x);
  assert.deepEqual([xs.length, others.length], [9, 14]);
  const sx = xs.map((f) => G.crossXScore(seenHands(f), TWO.ar)), so = others.map((f) => G.crossXScore(seenHands(f), TWO.ar));
  assert.ok(Math.min(...sx) >= 0.5, 'lowest score on the X: ' + Math.min(...sx));
  assert.ok(Math.max(...so) < 0.5, 'highest score on the others (palms, a peace sign in each hand, hands moving): ' + Math.max(...so));
  // neither hand on its own is any other command (no pause, stop or zoom in fires while the X is made)
  assert.ok(xs.every((f) => seenHands(f).every((h) => G.classify(h) === null)), 'one hand of the X is no other sign');
});

test('X on real hands: held, it is a zoom out after 0.4 s and carries on for as long as the 9 recognitions last', () => {
  const xs = TWO.frames.filter((f) => f.x);
  const out = run(xs.map((f, i) => [i * 125, 'zoomout', G.crossXScore(seenHands(f), TWO.ar)]));
  assert.ok(out.every((o) => o.seen === 'zoomout' && o.fire === null));
  assert.equal(out.findIndex((o) => o.held >= G.COMMANDS.zoomout.holdMs), 4, 'it counts from the fifth recognition (500 ms)');
  assert.equal(out[8].held, 1000);
});

test('pick: with two hands in view the one that asks for a command wins, the better score first, and the command being held keeps its hand', () => {
  const palm = { label: 'Open_Palm', score: 0.7 }, fist = { label: 'Closed_Fist', score: 0.9 }, none = { label: 'None', score: 0.9 };
  assert.deepEqual(G.pick([none, palm]), { hand: palm, c: G.classify(palm) });
  assert.equal(G.pick([palm, fist]).c.id, 'stop', 'the clearer sign wins');
  assert.equal(G.pick([palm, fist], {}, 'pause').c.id, 'pause', 'unless the other one is the command already being held');
  assert.deepEqual(G.pick([none, none]), { hand: none, c: null }, 'nothing asked: the first hand, no command');
  assert.deepEqual(G.pick([]), { hand: null, c: null });
  assert.deepEqual(G.pick(undefined), { hand: null, c: null });
});

test('classify: the X is no single-hand pose by default, but zoom out can be taught a sign of its own like any command', () => {
  const pointing = { label: 'Pointing_Up', score: 0.9, wl: POINT, lm: Array.from({ length: 21 }, () => ({ x: 0.3, y: 0.4, z: 0 })) };
  assert.equal(G.classify(pointing), null, 'one pointing hand does nothing');
  const signs = { zoomout: { ex: [G.features(POINT)] } };
  const c = G.classify(pointing, signs);
  assert.equal(c.id, 'zoomout');
  assert.deepEqual(c.at, { x: 0.3, y: 0.4 });
  assert.equal(G.classify({ label: 'Open_Palm', score: 0.66, wl: PALM }, signs).id, 'pause', 'and the other commands keep theirs');
});

test('teach: a zoom out sign too close to another command is refused, and the others are kept clear of a taught zoom out', () => {
  assert.equal(G.conflict('zoomout', PALM, {}), 'pause');
  assert.equal(G.conflict('zoomout', FIST, {}), 'stop');
  assert.equal(G.conflict('zoomout', CROSSED, {}), 'zoom');
  assert.equal(G.conflict('zoomout', POINT, {}), null, 'a pointing hand is free (the default X has no single-hand pose to clash with)');
  assert.equal(G.conflict('pause', POINT, { zoomout: { ex: [G.features(POINT)] } }), 'zoomout', 'taught signs are checked too');
  assert.equal(G.conflict('pause', POINT, {}), null);
});

// ---------------- teaching ----------------
// Runs the teach machine on [f or null] one per 125 ms; returns every output.
function teaching(frames) {
  let state = G.teachInitial(0);
  return frames.map((f, i) => { const r = G.teach(state, { t: i * 125, f }); state = r.state; return r; });
}
const A = G.features(PALM), B = G.features(FIST), jitter = (f, d) => f.map((v, i) => v + (i % 2 ? d : -d));
const still = (f, n) => Array.from({ length: n }, (_, i) => jitter(f, 0.004 * (i % 3)));

test('teach: hold a pose still for 1 s, take the hand away, show it again: saved as two templates', () => {
  const out = teaching([...still(A, 10), null, null, null, null, ...still(A, 10)]);
  const done = out.find((r) => r.done);
  assert.ok(done, 'finished: ' + out.map((r) => r.prompt).join(' '));
  assert.equal(done.done.length, 2);
  assert.ok(G.dist(done.done[0], A) < 0.02 && G.dist(done.done[1], A) < 0.02);
  assert.deepEqual(out.slice(0, 3).map((r) => r.prompt), ['hold', 'hold', 'hold']);
  assert.ok(out[6].progress > out[2].progress, 'the ring fills while the pose is held');
  assert.equal(out.filter((r) => r.prompt === 'lower').pop().progress, 0, 'the ring is full when the first take is saved, then empty while waiting for the hand to go away');
  assert.ok(out.some((r) => r.prompt === 'again'), 'then asks for it again');
});

test('teach: a wobbling hand starts the second over; a hand that never goes away is not a second take', () => {
  const shaky = Array.from({ length: 9 }, (_, i) => (i % 2 ? A : B)); // jumping between two poses
  assert.ok(teaching(shaky).every((r) => !r.done && r.progress < 0.5));
  const stuck = teaching(still(A, 40)); // the same hand, never lowered
  assert.ok(stuck.every((r) => !r.done), 'one long hold is one take');
  assert.equal(stuck[stuck.length - 1].prompt, 'lower');
  const noHand = teaching([...still(A, 9), ...Array(10).fill(null)]);
  assert.equal(noHand[noHand.length - 1].prompt, 'again');
  assert.equal(noHand[noHand.length - 1].progress, 0);
});

test('teach: two takes that are not the same pose are refused and it starts over', () => {
  const out = teaching([...still(A, 9), null, null, null, null, ...still(B, 10)]);
  assert.ok(!out.some((r) => r.done));
  assert.ok(out.some((r) => r.prompt === 'different'), 'tells the person');
  const again = teaching([...still(A, 9), null, null, null, null, ...still(B, 10), null, null, ...still(A, 10), null, null, null, null, ...still(A, 10)]);
  assert.ok(again.some((r) => r.done), 'and a clean try afterwards works: ' + again.map((r) => r.prompt).join(' '));
});

test('teach: gives up after 40 s', () => {
  const r = G.teach(G.teachInitial(0), { t: 40001, f: null });
  assert.equal(r.fail, 'timeout');
  assert.equal(r.done, null);
  assert.equal(G.teach(G.teachInitial(0), { t: 39000, f: null }).fail, null);
});

test('teach: a sign too close to another command is refused (thumb up is nearly a fist; a palm is the default pause)', () => {
  const at = (label) => HANDS.find((h) => h.label === label).wl;
  assert.equal(G.conflict('pause', at('Thumb_Up'), {}), 'stop', 'a thumb up looks like the default stop (a closed fist)');
  assert.equal(G.conflict('pause', at('Closed_Fist'), {}), 'stop');
  assert.equal(G.conflict('stop', at('Open_Palm'), {}), 'pause');
  assert.equal(G.conflict('zoom', at('Open_Palm'), {}), 'pause');
  assert.equal(G.conflict('zoom', CROSSED, {}), null, 'crossed fingers are zoom itself');
  assert.equal(G.conflict('pause', CROSSED, {}), 'zoom', 'crossed fingers belong to zoom unless zoom was taught something else');
  assert.equal(G.conflict('pause', CROSSED, { zoom: { ex: [G.features(PALM)] } }), null);
  assert.equal(G.conflict('stop', at('Thumb_Up'), {}), null, 'thumb up is far enough from a palm to be a stop sign');
  assert.equal(G.conflict('pause', at('Thumb_Up'), { stop: { ex: [G.features(PALM)] } }), null, 'once stop is taught, the default fist is out of the way');
  assert.equal(G.conflict('stop', at('Open_Palm'), { pause: { ex: [G.features(FIST)] } }), null, 'and so is the default palm once pause is taught');
  assert.equal(G.conflict('stop', FIST, { pause: { ex: [G.features(FIST)] } }), 'pause', 'taught signs are checked too');
  assert.equal(G.conflict('pause', PALM, {}), null, 'the same command is never in conflict with itself');
});

test('teach: the hand must be fully in the frame and big enough', () => {
  const lm = (x0, x1, y0, y1) => [{ x: x0, y: y0 }, { x: x1, y: y1 }, ...Array.from({ length: 19 }, () => ({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }))];
  assert.ok(G.handInside(lm(0.3, 0.6, 0.2, 0.8)));
  assert.ok(!G.handInside(lm(-0.01, 0.6, 0.2, 0.8)), 'cut off at the left edge');
  assert.ok(!G.handInside(lm(0.3, 0.6, 0.2, 1.0)), 'cut off at the bottom');
  assert.ok(G.handHeight(lm(0.3, 0.6, 0.2, 0.8)) >= G.TEACH.minHand);
  assert.ok(G.handHeight(lm(0.4, 0.5, 0.45, 0.55)) < G.TEACH.minHand, 'a hand far away is too small');
});

test('sketch: a small drawing of the pose, upright and the same however the hand was turned, with no picture of the person in it', () => {
  const spin = (p, a) => p.map(([x, y, z]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z]); // the hand turned in the picture (not towards or away from the camera)
  const s = G.sketch(CROSSED), t = G.sketch(spin(CROSSED, 2.3).map(([x, y, z]) => [x * 1.7, y * 1.7, z * 1.7]));
  assert.equal(s.length, 21);
  assert.deepEqual(s[0], [0, 0], 'wrist at the origin');
  assert.deepEqual(s[9], [0, -1], 'middle knuckle straight above it');
  s.forEach((p, i) => assert.ok(Math.abs(p[0] - t[i][0]) <= 0.011 && Math.abs(p[1] - t[i][1]) <= 0.011, 'point ' + i));
  assert.ok(s.every((p) => p.length === 2 && p.every(Number.isFinite)));
});

// The owner's own camera test (51 s, 410 recognitions at 8 a second): palm, thumb up, palm for half a minute, a closed fist for 1.25 s, palm, thumb up.
// The first version of the rules (palm bar 0.6, gap limit 200 ms) fired on this stream too, but the feature was switched off in that session; these
// numbers are what the rules do on a real hand, so a change that makes a real palm stop working shows up here.
test('real recording: palm toggles pause, a hand left up does not repeat it, thumb up does nothing, a 1.25 s fist is not enough to stop', () => {
  const samples = REAL.map(([label, score], i) => { const c = G.classify({ label, score }); return [i * 125, c && c.id, c ? c.score : 0]; });
  assert.equal(samples.length, 410);
  assert.deepEqual(fires(run(samples)), [[1250, P], [14250, P], [41875, P], [46125, P]]);
  // the same fist held 0.75 s longer (2 s) just misses stop; a little longer than that (2.125 s) does stop the recording, 2 s after it starts
  const i0 = REAL.findIndex(([l]) => l === 'Closed_Fist'), stretch = (n) => [...REAL.slice(0, i0), ...Array(n).fill(REAL[i0]), ...REAL.slice(i0)].map(([label, score], i) => { const c = G.classify({ label, score }); return [i * 125, c && c.id, c ? c.score : 0]; });
  assert.deepEqual(fires(run(stretch(6))).map((x) => x[1]), [P, P, P, P], 'a fist of 2 s: not yet');
  const f = fires(run(stretch(8)));
  assert.deepEqual(f.map((x) => x[1]), [P, P, S, P, P]);
  assert.equal(f[2][0], i0 * 125 + 2000, 'the stop fires 2 s after the fist first showed');
});
