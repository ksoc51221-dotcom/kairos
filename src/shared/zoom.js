// Camera zoom: a digital zoom of the FACE camera's picture (never the screen). A zoom is { cx, cy, z }: the centre of the part that is shown, as fractions of the
// RAW camera frame (the file on disk, not the mirrored preview), and the magnification z (1 = the whole picture). The bubble shows it live, timeline.json keeps it as
// keyframes, and the export applies it to the camera file before the bubble shape crops it. Pure maths so the preview and the export agree and both are unit-tested.
// Loaded two ways like constants.js: require() in tests and the main process, <script src> in the bubble window (window.KairosZoom).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KairosZoom = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ZOOM = {
    max: 4,          // most magnification (a 720p camera at 4x still gives a 320 px wide picture, plenty for a bubble)
    least: 1.15,     // a selection that would zoom less than this is ignored (it asked for the whole picture)
    minRect: 0.04,   // a drag smaller than this (fraction of the bubble) is a click, not a selection
    easeS: 0.45,     // seconds a zoom in or out glides (the export uses the same, the preview animates it with CSS)
    // the crossed-fingers sign is HELD: the picture goes in slowly for as long as it is held, so the longer the hold the deeper the zoom
    rampS: 6,        // seconds of holding that take the picture from 1x to max; a constant factor per second, so it looks as even at 3x as at 1.2x
    outS: 2,         // the same for the zoom-out sign (both index fingers crossed): seconds of holding that bring the picture from max back to 1x, three times faster
    graceMs: 300,    // the zoom keeps growing through a gap in the sign this short (one missed recognition of eight a second: real hands flicker), and stops by itself at a longer one
    followS: 0.35,   // the centre of the zoom follows the fingertips with this time constant
    chunkS: 1.5,     // while it grows, the timeline gets a keyframe this often (each one says how long the move to it took, see rows)
  };
  const FULL = { cx: 0.5, cy: 0.5, z: 1 };
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const r4 = (n) => Math.round(n * 10000) / 10000;
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);

  // Keeps z in range and the shown window inside the picture (a window of 1/z of the frame, so its centre can only go so near an edge).
  function norm(zm) {
    const z = clamp(num(zm && zm.z, 1), 1, ZOOM.max), h = 0.5 / z;
    return { cx: r4(clamp(num(zm && zm.cx, 0.5), h, 1 - h)), cy: r4(clamp(num(zm && zm.cy, 0.5), h, 1 - h)), z: r3(z) };
  }
  const isZoomed = (zm) => !!zm && num(zm.z, 1) > 1.001;
  const same = (a, b) => a.cx === b.cx && a.cy === b.cy && a.z === b.z;

  // The bubble shows the camera with object-fit: cover, so a box of another shape sees only the middle of the frame: fx, fy = the part of the frame
  // (width, height) it shows at z = 1. ra = frame width / height, ba = box width / height.
  const cover = (ra, ba) => (ra > ba ? { fx: ba / ra, fy: 1 } : { fx: 1, fy: ra / ba });
  // A point of the raw frame -> where it lands in the box under zoom zm, as fractions of the box (not mirrored). The inverse is fromBox.
  function toBox(u, zm, ra, ba) {
    const { fx, fy } = cover(ra, ba), n = norm(zm);
    return { x: 0.5 + (n.z * (u.x - n.cx)) / fx, y: 0.5 + (n.z * (u.y - n.cy)) / fy };
  }
  function fromBox(e, zm, ra, ba) {
    const { fx, fy } = cover(ra, ba), n = norm(zm);
    return { x: n.cx + ((e.x - 0.5) * fx) / n.z, y: n.cy + ((e.y - 0.5) * fy) / n.z };
  }

  // A rectangle picked on the bubble (fractions of the box, not mirrored: { x0, y0, x1, y1 } in any order) -> the zoom that shows all of it, or null when
  // it asks for (nearly) the whole picture or is too small to be a selection.
  function fromRect(rect, zm, ra, ba) {
    const x0 = Math.min(rect.x0, rect.x1), x1 = Math.max(rect.x0, rect.x1), y0 = Math.min(rect.y0, rect.y1), y1 = Math.max(rect.y0, rect.y1);
    if (x1 - x0 < ZOOM.minRect || y1 - y0 < ZOOM.minRect) return null;
    const a = fromBox({ x: x0, y: y0 }, zm, ra, ba), b = fromBox({ x: x1, y: y1 }, zm, ra, ba), { fx, fy } = cover(ra, ba);
    const z = Math.min(fx / Math.max(b.x - a.x, 1e-6), fy / Math.max(b.y - a.y, 1e-6));
    if (z < ZOOM.least) return null;
    return norm({ cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, z });
  }
  // ---- holding the zoom sign ----
  // The sign (crossed fingers) is held over a spot and the picture zooms in on it, slowly, until the sign is gone. The zoom-out sign (an X of both index fingers)
  // is held the same way and the picture comes back out, faster, until it is whole again or the sign is gone. Three small pure steps so the bubble, which owns
  // the clock and the camera, only has to call them: rampInit when a hold starts, rampSample for every recognition, rampFrame as time moves (every screen
  // frame, and with every recognition). The state is returned, never changed.
  //   state  { t (last frame, ms), x, y (centre, raw-frame fractions, not yet kept inside the picture), z, at (where the fingertips are), lastGood (ms),
  //            dir (1 in, -1 out), x0, y0, z0 (where a zoom out started) }
  const rampInit = (zm, dir = 1) => { const n = norm(zm); return { t: null, x: n.cx, y: n.cy, z: n.z, at: null, lastGood: -Infinity, dir: dir < 0 ? -1 : 1, x0: n.cx, y0: n.cy, z0: n.z }; };
  // A recognition: good = it showed the zoom sign (held long enough to count), at = the fingertips, as fractions of the raw frame.
  const rampSample = (st, { t, good, at }) => (good ? { ...st, lastGood: t, at: at || st.at } : st);
  // → { state, zoom, active }: the zoom to show at time t (ms) and whether it is still moving. It moves while a good recognition is at most graceMs old (and, going
  // out, until the picture is whole). A frame is never counted as more than a quarter of a second, so a stalled window does not make the picture leap.
  // Going in, the centre follows the fingertips. Going out, it runs in a straight line to the middle, in step with the zoom (that is how the export draws a
  // move between two keyframes, so the preview and the export agree and the picture never needs pushing back inside the frame).
  function rampFrame(st, t) {
    const dt = st.t == null ? 0 : clamp((t - st.t) / 1000, 0, 0.25), out = st.dir < 0;
    let { x, y, z } = st, active = t - st.lastGood <= ZOOM.graceMs;
    if (active && dt > 0) {
      if (out) {
        z = Math.max(1, z * Math.exp((-Math.log(ZOOM.max) / ZOOM.outS) * dt));
        const f = st.z0 > 1.001 ? clamp(Math.log(st.z0 / z) / Math.log(st.z0), 0, 1) : 1; // 0 where it started, 1 when whole
        x = st.x0 + (FULL.cx - st.x0) * f; y = st.y0 + (FULL.cy - st.y0) * f;
      } else {
        z = Math.min(ZOOM.max, z * Math.exp((Math.log(ZOOM.max) / ZOOM.rampS) * dt));
        if (st.at) { const k = 1 - Math.exp(-dt / ZOOM.followS); x += (st.at.x - x) * k; y += (st.at.y - y) * k; }
      }
    }
    if (out && z <= 1.0005) active = false; // all the way out: the hold is over, whatever the hand does
    return { state: { ...st, t, x, y, z }, zoom: norm({ cx: x, cy: y, z }), active };
  }

  // CSS for the preview <video> (transform-origin 0 0, object-fit: cover, mirrored like a mirror): `translate(..%, ..%) scale(-z, z)`. Percentages are of the
  // video's own box, so they hold for any bubble size. At z = 1 this is a plain mirror, translate(100%, 0%) scale(-1, 1).
  function css(zm, ra, ba) {
    const { fx, fy } = cover(ra, ba), n = norm(zm);
    const tx = 0.5 + (n.z * ((1 - fx) / 2 - n.cx)) / fx, ty = 0.5 + (n.z * ((1 - fy) / 2 - n.cy)) / fy;
    return `translate(${r3(100 * (1 - tx))}%, ${r3(100 * ty)}%) scale(${-n.z}, ${n.z})`;
  }

  // The timeline's keyframes -> rows for the export: [[t, cx, cy, z, span?]] sorted and normalised, starting at t = 0 with the whole picture, or null when the
  // picture is never zoomed. Repeats are dropped, so a long recording with a few zooms stays a short expression. A plain row glides to its value from its own
  // time (ZOOM.easeS). A row with a span is part of a hold: the move to it took `span` seconds and is made evenly (the zoom by a constant factor, the centre
  // in a straight line), which is how the picture looked while the sign was held. A span never reaches back past the row before it.
  const MAX_ROWS = 40;
  function rows(tl) {
    const raw = (tl && tl.zoom || []).filter((r) => Array.isArray(r) && r.length >= 4 && r.slice(0, 4).every((v) => Number.isFinite(+v))).map((r) => ({ t: +r[0], n: norm({ cx: r[1], cy: r[2], z: r[3] }), span: Number.isFinite(+r[4]) ? +r[4] : 0 })).sort((a, b) => a.t - b.t);
    if (!raw.some((r) => r.n.z > 1.001)) return null;
    const out = [];
    if (!raw.length || raw[0].t > 0) out.push([0, FULL.cx, FULL.cy, FULL.z]);
    for (const { t, n, span } of raw) {
      const last = out[out.length - 1];
      if (last && last[1] === n.cx && last[2] === n.cy && last[3] === n.z) continue;
      const sp = last ? Math.min(span, t - last[0]) : 0, row = sp > 0.016 ? [t, n.cx, n.cy, n.z, r3(sp)] : [t, n.cx, n.cy, n.z];
      if (last && last[0] === t) out[out.length - 1] = row; else out.push(row);
    }
    // too many for an expression: first merge neighbouring stretches of one hold (the end result is the same, with fewer pieces), then thin the rest evenly
    const mergePass = () => { // pairs of neighbours, left to right: a ramp that ends where the next one starts becomes one longer ramp (only when both go the same way: a zoom in
      let did = false;        // followed straight away by a zoom out must keep its peak)
      for (let k = 1; k + 1 < out.length && out.length > MAX_ROWS; k++) {
        const a = out[k], b = out[k + 1];
        if (a[4] && b[4] && Math.abs(b[0] - b[4] - a[0]) < 0.05 && (a[3] - out[k - 1][3]) * (b[3] - a[3]) >= 0) { out.splice(k, 2, [b[0], b[1], b[2], b[3], r3(a[4] + b[4])]); did = true; }
      }
      return did;
    };
    while (out.length > MAX_ROWS && mergePass());
    if (out.length > MAX_ROWS) return Array.from({ length: MAX_ROWS }, (_, k) => out[Math.round((k * (out.length - 1)) / (MAX_ROWS - 1))]);
    return out;
  }

  return { ZOOM, FULL, norm, isZoomed, same, cover, toBox, fromBox, fromRect, rampInit, rampSample, rampFrame, css, rows };
});
