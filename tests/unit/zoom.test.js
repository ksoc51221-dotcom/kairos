const test = require('node:test');
const assert = require('node:assert/strict');
const Z = require('../../src/shared/zoom');

const near = (a, b, e = 1e-3, m = '') => assert.ok(Math.abs(a - b) <= e, `${m} ${a} vs ${b}`);
const RA = 16 / 9; // a 1280x720 camera

test('norm: z stays between 1 and 4 and the window stays inside the picture', () => {
  assert.deepEqual(Z.norm({ cx: 0.5, cy: 0.5, z: 1 }), Z.FULL);
  assert.equal(Z.norm({ cx: 0.5, cy: 0.5, z: 9 }).z, 4);
  assert.equal(Z.norm({ cx: 0.5, cy: 0.5, z: 0.2 }).z, 1);
  assert.deepEqual(Z.norm({ cx: 0, cy: 1, z: 2 }), { cx: 0.25, cy: 0.75, z: 2 }, 'a 2x window is half the picture, so its centre cannot go nearer an edge than a quarter');
  assert.deepEqual(Z.norm({ cx: 0.9, cy: 0.1, z: 1 }), Z.FULL, 'at 1x there is nowhere to go');
  assert.deepEqual(Z.norm(null), Z.FULL);
  assert.deepEqual(Z.norm({ cx: 'x', cy: NaN, z: undefined }), Z.FULL);
});

test('isZoomed / same', () => {
  assert.ok(!Z.isZoomed(Z.FULL) && !Z.isZoomed(null) && Z.isZoomed({ cx: 0.5, cy: 0.5, z: 1.5 }));
  assert.ok(Z.same(Z.norm({ z: 2 }), Z.norm({ z: 2 })) && !Z.same(Z.FULL, Z.norm({ z: 2 })));
});

test('cover: a box of another shape than the camera sees only the middle of the frame', () => {
  assert.deepEqual(Z.cover(16 / 9, 1), { fx: 9 / 16, fy: 1 }, 'a square bubble shows the middle 56% of the width of a 16:9 frame');
  assert.deepEqual(Z.cover(1, 1), { fx: 1, fy: 1 });
  const t = Z.cover(16 / 9, 9 / 16); // a tall box: even less of the width
  near(t.fx, 0.3164, 1e-3); assert.equal(t.fy, 1);
  const w = Z.cover(1, 2); // a wide box on a square camera: the middle band of the height
  assert.equal(w.fx, 1); near(w.fy, 0.5);
});

test('toBox / fromBox are inverses, and the zoom centre lands in the middle of the box', () => {
  const zm = Z.norm({ cx: 0.4, cy: 0.55, z: 2.5 });
  const c = Z.toBox({ x: zm.cx, y: zm.cy }, zm, RA, 1);
  near(c.x, 0.5); near(c.y, 0.5);
  for (const u of [{ x: 0.3, y: 0.5 }, { x: 0.45, y: 0.62 }]) { const b = Z.toBox(u, zm, RA, 1), back = Z.fromBox(b, zm, RA, 1); near(back.x, u.x); near(back.y, u.y); }
  const whole = Z.toBox({ x: 0.5, y: 0.5 }, Z.FULL, RA, 1);
  near(whole.x, 0.5); near(whole.y, 0.5);
  // at 1x in a square bubble the left edge of the box is the left edge of the middle strip of the frame
  near(Z.fromBox({ x: 0, y: 0 }, Z.FULL, RA, 1).x, 0.5 - 9 / 32);
});

test('fromRect: a selection becomes the zoom that fills the box with it', () => {
  // the top-left quarter of a square bubble on a square camera: 2x, centred a quarter in
  const q = Z.fromRect({ x0: 0, y0: 0, x1: 0.5, y1: 0.5 }, Z.FULL, 1, 1);
  assert.deepEqual(q, { cx: 0.25, cy: 0.25, z: 2 });
  // drawn the other way round gives the same
  assert.deepEqual(Z.fromRect({ x0: 0.5, y0: 0.5, x1: 0, y1: 0 }, Z.FULL, 1, 1), q);
  // a thin sliver zooms only as far as its longer side allows, so all of it is shown
  assert.deepEqual(Z.fromRect({ x0: 0.4, y0: 0.1, x1: 0.5, y1: 0.9 }, Z.FULL, 1, 1), { cx: 0.45, cy: 0.5, z: 1.25 });
});

test('fromRect: the real thing in a square bubble over a 16:9 camera, then selecting again inside a zoom', () => {
  const r = Z.fromRect({ x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 }, Z.FULL, RA, 1);
  near(r.z, 2); near(r.cx, 0.5); near(r.cy, 0.5);
  // inside that zoom, the top-left quarter of what is shown is 2x again (4x in all) in the top-left of the window
  const deeper = Z.fromRect({ x0: 0, y0: 0, x1: 0.5, y1: 0.5 }, r, RA, 1);
  near(deeper.z, 4);
  const at = Z.fromBox({ x: 0.25, y: 0.25 }, r, RA, 1);
  near(deeper.cx, at.x, 2e-3); near(deeper.cy, at.y, 2e-3);
  // never past the limit
  assert.equal(Z.fromRect({ x0: 0, y0: 0, x1: 0.5, y1: 0.5 }, deeper, RA, 1).z, 4);
});

test('fromRect: a click or a drag that asks for (nearly) everything is not a zoom', () => {
  assert.equal(Z.fromRect({ x0: 0.5, y0: 0.5, x1: 0.51, y1: 0.52 }, Z.FULL, RA, 1), null, 'a click');
  assert.equal(Z.fromRect({ x0: 0.02, y0: 0.02, x1: 0.98, y1: 0.98 }, Z.FULL, RA, 1), null, 'the whole picture');
  assert.equal(Z.fromRect({ x0: 0, y0: 0, x1: 1, y1: 0.03 }, Z.FULL, RA, 1), null, 'a line');
});

// ---------------- holding the zoom sign ----------------
// Runs a hold: one recognition every 125 ms (good until `until`), a frame every 16 ms. Returns the zoom at each whole second and when it stopped growing.
function hold({ from = Z.FULL, dir = 1, until = 6000, total = 8000, at = { x: 0.3, y: 0.4 }, good = (t) => t <= until } = {}) {
  let st = Z.rampInit(from, dir), zoom = from, active = true, lastActive = 0;
  const bySecond = {};
  for (let t = 0; t <= total; t += 16) {
    if (t % 128 < 16) st = Z.rampSample(st, { t, good: good(t), at });
    const r = Z.rampFrame(st, t); st = r.state; zoom = r.zoom; active = r.active;
    if (active) lastActive = t;
    if (t % 1000 < 16) bySecond[Math.round(t / 1000)] = zoom;
  }
  return { zoom, bySecond, lastActive, state: st };
}

test('ramp: the zoom grows by the same factor every second, so 1x reaches the limit after rampS seconds', () => {
  const h = hold({ until: 8000 }), k = Math.pow(Z.ZOOM.max, 1 / Z.ZOOM.rampS);
  near(h.bySecond[1].z, k, 0.02); near(h.bySecond[2].z, k * k, 0.03); near(h.bySecond[3].z, k ** 3, 0.04);
  assert.equal(h.bySecond[Z.ZOOM.rampS].z, Z.ZOOM.max, 'six seconds of holding = the deepest zoom');
  assert.equal(h.zoom.z, Z.ZOOM.max, 'and it stays there however long the sign is held');
  assert.ok(h.bySecond[2].z > h.bySecond[1].z && h.bySecond[4].z > h.bySecond[2].z, 'the longer the hold, the bigger the zoom');
});

test('ramp: it stops with the sign, within graceMs of the last recognition, and the zoom it reached stays', () => {
  const h = hold({ until: 2000, total: 5100 }), lastGood = Math.floor(2000 / 128) * 128;
  assert.ok(h.lastActive - lastGood <= Z.ZOOM.graceMs, 'stopped growing ' + (h.lastActive - lastGood) + ' ms after the last recognition');
  assert.ok(h.lastActive >= lastGood, 'but not before it');
  assert.equal(h.bySecond[3].z, h.bySecond[5].z, 'no drift once it is over');
  near(h.zoom.z, Math.pow(Z.ZOOM.max, h.lastActive / 1000 / Z.ZOOM.rampS), 0.03);
});

test('ramp: one missed recognition does not stop it, a long gap pauses it', () => {
  const clean = hold({ until: 3000, total: 3500 }), flicker = hold({ until: 3000, total: 3500, good: (t) => t <= 3000 && Math.round(t) !== 1024 });
  assert.equal(flicker.bySecond[3].z, clean.bySecond[3].z, 'a single bad recognition of eight a second costs nothing');
  const gap = hold({ until: 3000, total: 3500, good: (t) => t <= 3000 && !(t >= 1000 && t < 1800) });
  assert.ok(gap.bySecond[3].z < clean.bySecond[3].z - 0.15, 'an 800 ms gap pauses the growth: ' + gap.bySecond[3].z + ' vs ' + clean.bySecond[3].z);
  assert.ok(gap.zoom.z > gap.bySecond[1].z, 'and it grows again once the sign is back');
});

test('ramp: the centre follows the fingertips, smoothly, and stays inside the picture', () => {
  const h = hold({ until: 6000, at: { x: 0.8, y: 0.3 } }), xs = [1, 2, 3, 4, 5, 6].map((k) => h.bySecond[k].cx);
  assert.ok(xs.every((x, i) => i === 0 || x >= xs[i - 1] - 1e-9), 'it moves towards the fingers and never back: ' + xs);
  assert.ok(xs.every((x, i) => x <= 1 - 0.5 / h.bySecond[i + 1].z + 2e-3), 'a window of 1/z of the frame never leaves the picture');
  near(xs[5], 0.8, 0.01, 'and it ends on them');
  near(h.zoom.cy, 0.3, 0.01);
  // a zoom that is already on moves from where it stands, and keeps going from its depth
  const again = hold({ from: { cx: 0.7, cy: 0.5, z: 2 }, until: 1000, at: { x: 0.7, y: 0.5 } });
  assert.ok(again.bySecond[0].z === 2 && again.bySecond[1].z > 2.4, 'a second hold carries on from 2x: ' + again.bySecond[1].z);
  near(again.bySecond[1].cx, 0.7, 1e-3);
});

test('ramp: a stalled window does not make the picture leap, and the state is never changed', () => {
  const at = { x: 0.5, y: 0.5 };
  let st = Z.rampSample(Z.rampInit(Z.FULL), { t: 0, good: true, at });
  st = Z.rampFrame(st, 16).state;
  const frozen = Object.freeze({ ...st }), woke = Z.rampSample(frozen, { t: 10000, good: true, at }), r = Z.rampFrame(woke, 10016); // ten seconds without a frame
  assert.ok(r.state.z < 1.1, 'counted as a quarter of a second at most: ' + r.state.z);
  assert.deepEqual(frozen, Object.freeze({ ...st }));
  assert.equal(Z.rampFrame(Z.rampInit(Z.FULL), 5).active, false, 'no recognition yet: nothing grows');
  assert.equal(Z.rampSample(Z.rampInit(Z.FULL), { t: 5, good: false, at: { x: 0.1, y: 0.1 } }).at, null, 'a recognition without the sign tells nothing');
});

// ---------------- holding the zoom-out sign (both index fingers crossed) ----------------
test('ramp out: the zoom falls by the same factor every second, 4x back to the whole picture in outS seconds, and the hold ends by itself there', () => {
  const from = { cx: 0.7, cy: 0.3, z: 4 }, h = hold({ from, dir: -1, until: 6000, total: 6000 });
  assert.equal(h.bySecond[0].z, 4);
  near(h.bySecond[1].z, 4 * Math.pow(Z.ZOOM.max, -1 / Z.ZOOM.outS), 0.03, 'one second in');
  near(h.bySecond[2].z, 1, 0.01, 'outS seconds in');
  assert.ok(Math.abs(h.lastActive - Z.ZOOM.outS * 1000) <= 40, 'it stopped by itself when whole, at ' + h.lastActive);
  assert.deepEqual(h.zoom, Z.FULL, 'and stays whole however long the sign is held');
  assert.equal(h.bySecond[6].z, 1);
  assert.ok(Z.ZOOM.outS < Z.ZOOM.rampS, 'going out is quicker than going in');
});

test('ramp out: the centre runs in a straight line to the middle, in step with the zoom, and the fingers are ignored', () => {
  const h = hold({ from: { cx: 0.7, cy: 0.3, z: 4 }, dir: -1, until: 4000, total: 4000 });
  near(h.bySecond[1].cx, 0.6, 0.01); near(h.bySecond[1].cy, 0.4, 0.01); // half way (in log z) is half way there
  assert.ok([1, 2, 3].every((k) => h.bySecond[k].cx <= h.bySecond[k - 1].cx + 1e-9), 'it never goes the wrong way');
  const other = hold({ from: { cx: 0.7, cy: 0.3, z: 4 }, dir: -1, until: 4000, total: 4000, at: { x: 0.05, y: 0.95 } });
  assert.deepEqual(other.bySecond, h.bySecond, 'where the fingers are changes nothing');
  assert.ok(Object.values(h.bySecond).every((zm) => Z.same(zm, Z.norm(zm))), 'and every picture on the way is inside the frame');
});

test('ramp out: from a partial zoom it takes proportionally less, stops with the sign and keeps what it reached; at 1x it is over at once', () => {
  const half = hold({ from: { cx: 0.6, cy: 0.5, z: 2 }, dir: -1, until: 4000, total: 3000 });
  assert.ok(Math.abs(half.lastActive - 1000) <= 40, 'from 2x it is whole after about a second: ' + half.lastActive);
  const cut = hold({ from: { cx: 0.7, cy: 0.3, z: 4 }, dir: -1, until: 600, total: 3000 }), lastGood = Math.floor(600 / 128) * 128;
  assert.ok(cut.lastActive >= lastGood && cut.lastActive - lastGood <= Z.ZOOM.graceMs, 'stopped within graceMs of the last recognition: ' + cut.lastActive);
  near(cut.zoom.z, 4 * Math.pow(Z.ZOOM.max, -(cut.lastActive / 1000) / Z.ZOOM.outS), 0.03, 'part of the way out, as far as it got while active');
  assert.ok(cut.zoom.z > 1.5 && cut.zoom.z < 4);
  assert.deepEqual(cut.bySecond[1], cut.bySecond[2], 'no drift once the sign is gone');
  const whole = Z.rampFrame(Z.rampSample(Z.rampInit(Z.FULL, -1), { t: 0, good: true, at: { x: 0.5, y: 0.5 } }), 16);
  assert.equal(whole.active, false);
  assert.deepEqual(whole.zoom, Z.FULL);
});

test('ramp: rampInit remembers the direction (anything below zero is out) and where an out started, and never changes the zoom it was given', () => {
  const zm = Object.freeze({ cx: 0.4, cy: 0.6, z: 3 });
  assert.equal(Z.rampInit(zm).dir, 1);
  assert.equal(Z.rampInit(zm, 1).dir, 1);
  assert.equal(Z.rampInit(zm, -1).dir, -1);
  assert.equal(Z.rampInit(zm, -7).dir, -1);
  const st = Z.rampInit(zm, -1);
  assert.deepEqual([st.x0, st.y0, st.z0, st.z], [0.4, 0.6, 3, 3]);
});

test('css: z = 1 is the plain mirror the bubble always had; zooming turns into a translate + scale of the same box', () => {
  assert.equal(Z.css(Z.FULL, RA, 1), 'translate(100%, 0%) scale(-1, 1)');
  assert.equal(Z.css(Z.FULL, 1, 1), 'translate(100%, 0%) scale(-1, 1)');
  // 2x on the middle of a square camera in a square box: the box is filled by the middle half, so the mirrored video is shifted back by half its size
  assert.equal(Z.css({ cx: 0.5, cy: 0.5, z: 2 }, 1, 1), 'translate(150%, -50%) scale(-2, 2)');
  // the maths in the string is the same as toBox: a raw point at the zoom centre lands in the middle of the box, whatever the shape
  for (const [ra, ba] of [[RA, 1], [1, 1], [RA, 1.4], [1.33, 0.7]]) {
    const zm = Z.norm({ cx: 0.35, cy: 0.6, z: 2.2 }), m = /translate\((-?[\d.]+)%, (-?[\d.]+)%\) scale\((-?[\d.]+), (-?[\d.]+)\)/.exec(Z.css(zm, ra, ba));
    const [tx, ty, sx, sy] = m.slice(1).map(Number), { fx, fy } = Z.cover(ra, ba);
    // the <video> element's own coordinates (object-fit: cover, not yet mirrored) hold raw x at box fraction (x - (1 - fx) / 2) / fx; the css maps those to the screen
    const box = (u) => { const bx = (u.x - (1 - fx) / 2) / fx, by = (u.y - (1 - fy) / 2) / fy; return { x: sx * bx + tx / 100, y: sy * by + ty / 100 }; };
    const c = box({ x: zm.cx, y: zm.cy });
    near(c.x, 0.5, 2e-3, `x ${ra},${ba}`); near(c.y, 0.5, 2e-3, `y ${ra},${ba}`);
  }
});

test('rows: the timeline keyframes for the export, or null when the picture is never zoomed', () => {
  assert.equal(Z.rows(null), null);
  assert.equal(Z.rows({}), null);
  assert.equal(Z.rows({ zoom: [] }), null);
  assert.equal(Z.rows({ zoom: [[0, 0.5, 0.5, 1], [4, 0.5, 0.5, 1]] }), null, 'only 1x');
  assert.deepEqual(Z.rows({ zoom: [[1500, 0.3, 0.4, 2]] }), [[0, 0.5, 0.5, 1], [1500, 0.3, 0.4, 2]], 'starts whole');
  assert.deepEqual(Z.rows({ zoom: [[0, 0.3, 0.4, 2], [2000, 0.5, 0.5, 1]] }), [[0, 0.3, 0.4, 2], [2000, 0.5, 0.5, 1]], 'a zoom from the very start, then out');
  assert.deepEqual(Z.rows({ zoom: [[3000, 0.5, 0.5, 1], [1000, 0.3, 0.4, 2]] }), [[0, 0.5, 0.5, 1], [1000, 0.3, 0.4, 2], [3000, 0.5, 0.5, 1]], 'sorted');
  assert.deepEqual(Z.rows({ zoom: [[1000, 0.3, 0.4, 2], [1500, 0.3, 0.4, 2], [2000, 0.3, 0.4, 2]] }), [[0, 0.5, 0.5, 1], [1000, 0.3, 0.4, 2]], 'repeats dropped');
  assert.deepEqual(Z.rows({ zoom: [[1000, 0.3, 0.4, 2], [1000, 0.6, 0.6, 3]] }), [[0, 0.5, 0.5, 1], [1000, 0.6, 0.6, 3]], 'two at the same time: the later one wins');
  assert.deepEqual(Z.rows({ zoom: [[1000, 0.0, 0.0, 9]] }), [[0, 0.5, 0.5, 1], [1000, 0.125, 0.125, 4]], 'out-of-range values are brought back in');
  assert.deepEqual(Z.rows({ zoom: [[1000, 'a', 0.5, 2], null, [1], [2000, 0.4, 0.4, 2]] }), [[0, 0.5, 0.5, 1], [2000, 0.4, 0.4, 2]], 'junk rows are ignored');
  const many = Array.from({ length: 300 }, (_, i) => [i * 100, 0.3 + (i % 7) * 0.05, 0.5, 2]);
  const r = Z.rows({ zoom: many });
  assert.ok(r.length <= 40, 'a long recording of constant re-aiming stays a short expression: ' + r.length);
  assert.equal(r[0][0], 0); assert.equal(r[r.length - 1][0], 29900, 'the end is kept');
});

test('rows: a hold keeps its spans; a span never reaches back past the row before it; junk spans are ignored', () => {
  assert.deepEqual(Z.rows({ zoom: [[3, 0.4, 0.45, 1.9, 3], [4.5, 0.35, 0.4, 2.7, 1.5], [8, 0.5, 0.5, 1]] }), [[0, 0.5, 0.5, 1], [3, 0.4, 0.45, 1.9, 3], [4.5, 0.35, 0.4, 2.7, 1.5], [8, 0.5, 0.5, 1]]);
  assert.deepEqual(Z.rows({ zoom: [[1, 0.3, 0.4, 2], [2, 0.35, 0.4, 2.5, 5]] }), [[0, 0.5, 0.5, 1], [1, 0.3, 0.4, 2], [2, 0.35, 0.4, 2.5, 1]], 'it began after the row before it, not before');
  assert.deepEqual(Z.rows({ zoom: [[2, 0.4, 0.4, 2.2, 5]] }), [[0, 0.5, 0.5, 1], [2, 0.4, 0.4, 2.2, 2]], 'nor before the start of the recording');
  for (const bad of [-1, 0, 0.01, 'x', null, NaN]) assert.deepEqual(Z.rows({ zoom: [[2, 0.4, 0.4, 2.2, bad]] }), [[0, 0.5, 0.5, 1], [2, 0.4, 0.4, 2.2]], 'span ' + bad);
  assert.deepEqual(Z.rows({ zoom: [[2, 0.4, 0.4, 2.2, 1], [3, 0.4, 0.4, 2.2, 1]] }), [[0, 0.5, 0.5, 1], [2, 0.4, 0.4, 2.2, 1]], 'a hold that no longer changes the picture adds nothing');
});

test('rows: a long zoom in followed straight away by a long zoom out is merged on each side but keeps its peak', () => {
  const zin = Array.from({ length: 30 }, (_, i) => [0.5 * (i + 1), 0.5, 0.5, +Math.pow(4, (i + 1) / 30).toFixed(3), 0.5]);
  const zout = Array.from({ length: 30 }, (_, i) => [15 + 0.25 * (i + 1), 0.5, 0.5, +Math.pow(4, 1 - (i + 1) / 30).toFixed(3), 0.25]);
  const r = Z.rows({ zoom: [...zin, ...zout] });
  assert.ok(r.length <= 40 && r.length > 2, 'rows ' + r.length);
  assert.deepEqual(r.reduce((a, row) => (row[3] > a[3] ? row : a)).slice(0, 4), [15, 0.5, 0.5, 4], 'the deepest point is still there, at the moment it was reached');
  assert.deepEqual(r[r.length - 1].slice(0, 4), [22.5, 0.5, 0.5, 1], 'and it ends whole');
  r.slice(1).forEach((row, i) => assert.ok(!row[4] || Math.abs(row[0] - row[4] - r[i][0]) < 0.06, `piece ${i + 1} starts where the one before it ended`));
});

test('rows: a very long hold (60 pieces) is merged into fewer longer ones that still run end to end', () => {
  const zoom = Array.from({ length: 60 }, (_, i) => [0.5 * (i + 1), 0.5, 0.5, +Math.pow(4, (i + 1) / 60).toFixed(3), 0.5]);
  const r = Z.rows({ zoom });
  assert.ok(r.length <= 40 && r.length > 1, 'rows ' + r.length);
  assert.deepEqual(r[r.length - 1].slice(0, 4), [30, 0.5, 0.5, 4], 'it still ends where it ended');
  r.slice(1).forEach((row, i) => assert.ok(Math.abs(row[0] - row[4] - r[i][0]) < 0.06, `piece ${i + 1} starts where the one before it ended`));
  assert.ok(r.slice(1).reduce((a, row) => a + row[4], 0) > 29.9, 'and together they still cover all 30 seconds');
});
