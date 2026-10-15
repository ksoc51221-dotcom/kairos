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

module.exports = { ensureMask, maskFilter };
