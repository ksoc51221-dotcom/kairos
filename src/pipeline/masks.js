// Shape masks for the camera bubble: a grey PNG per (shape, size), white inside the shape, anti-aliased edge.
// Made once with ffmpeg itself (one frame, so it is instant) and cached; the composite step uses them with alphamerge.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const C = require('../shared/constants');

// Signed distance to a rounded rectangle of corner radius R, turned into coverage 0..1 (a circle is R = min(W,H)/2)
const maskFilter = (w, h, r) => {
  const qx = `(abs(X+0.5-W/2)-(W/2-${r}))`, qy = `(abs(Y+0.5-H/2)-(H/2-${r}))`;
  return `color=c=black:s=${w}x${h}:d=1,format=gray,geq=lum='255*clip(0.5-(hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0)-${r}),0,1)'`;
};

function ensureMask(cacheDir, shape, w, h) {
  const file = path.join(cacheDir, `mask_${shape}_${w}x${h}.png`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  fs.mkdirSync(cacheDir, { recursive: true });
  const r = +(C.cornerRadius(shape) * Math.min(w, h)).toFixed(2);
  const out = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', maskFilter(w, h, r), '-frames:v', '1', '-pix_fmt', 'gray', file], { encoding: 'utf8' });
  if (out.status !== 0 || !fs.existsSync(file)) throw new Error(`mask failed: ${(out.stderr || '').slice(-200)}`);
  return file;
}

// Frame ring for a bubble: an RGBA PNG the size of the bubble, with the ring drawn just inside the shape's edge (same signed distance as the mask).
// Bands are painted from the outer edge inwards; the glow is a soft falloff inside the last band.
function frameFilter(w, h, r, spec) {
  const short = Math.min(w, h);
  const qx = `(abs(X+0.5-W/2)-(W/2-${r}))`, qy = `(abs(Y+0.5-H/2)-(H/2-${r}))`;
  const d = `(hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0)-${r})`; // negative inside the shape, 0 on the edge
  let edge = 0; const parts = [];
  for (const b of spec.bands) {
    const t = Math.max(1.5, +(b.t * short).toFixed(2)); // never thinner than 1.5 px or it vanishes at small sizes
    // coverage of the band [-(edge+t), -edge], anti-aliased on both sides, and no more than the shape itself
    parts.push({ c: b.c, a: `clip(0.5-(${d}+${edge}),0,1)*clip(0.5+(${d}+${edge + t}),0,1)` });
    edge += t;
  }
  // depth = distance inward past the last band; alpha falls off quadratically over `glow` of the short side
  const depth = `(-(${d})-${edge})`;
  const glow = spec.glow ? { c: spec.bands[spec.bands.length - 1].c, a: `0.55*gte(${depth},0)*pow(clip(1-${depth}/${(spec.glow * short).toFixed(2)},0,1),2)` } : null;
  const layers = glow ? [...parts, glow] : parts;
  // "over" compositing of the layers in order; colours are the straight colour of whichever layer has the most alpha
  const ch = (k) => {
    const num = layers.map((l) => `(${l.c[k]}*(${l.a}))`).join('+');
    const den = layers.map((l) => `(${l.a})`).join('+');
    return `(${num})/max(${den},0.0001)`;
  };
  const alpha = `255*min(1,${layers.map((l) => `(${l.a})`).join('+')})`;
  return `color=c=black@0:s=${w}x${h}:d=1,format=rgba,geq=r='${ch(0)}':g='${ch(1)}':b='${ch(2)}':a='${alpha}'`;
}

function ensureFrame(cacheDir, frame, shape, w, h) {
  const spec = require('./filters').frameSpec(frame); if (!spec) return null;
  const file = path.join(cacheDir, `frame_${frame}_${shape}_${w}x${h}.png`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  fs.mkdirSync(cacheDir, { recursive: true });
  const r = +(C.cornerRadius(shape) * Math.min(w, h)).toFixed(2);
  const out = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', frameFilter(w, h, r, spec), '-frames:v', '1', '-pix_fmt', 'rgba', file], { encoding: 'utf8' });
  if (out.status !== 0 || !fs.existsSync(file)) throw new Error(`frame failed: ${(out.stderr || '').slice(-200)}`);
  return file;
}

module.exports = { ensureMask, maskFilter, ensureFrame, frameFilter };
