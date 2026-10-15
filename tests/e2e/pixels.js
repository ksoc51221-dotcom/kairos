// Numeric frame inspection for the self-tests: mean colour of regions at a given time, without opening the image.
// (Self-test captures can contain the user's screen, so checks read numbers instead of looking at frames.)
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

// regions: [{ x, y, w, h }] in video pixels. Returns [{ r, g, b }] (0-255 means), or null for a region that could not be read.
function sampleRegions(file, t, regions) {
  return regions.map((g) => {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
      '-vf', `crop=${g.w}:${g.h}:${g.x}:${g.y},scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
    return r.stdout && r.stdout.length >= 3 ? { r: r.stdout[0], g: r.stdout[1], b: r.stdout[2] } : null;
  });
}

// Fraction (0..1) of pixels in a region whose colour matches `test(r,g,b)` in the frame at time t. Region is read at full size.
function fractionMatching(file, t, g, test) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', `crop=${g.w}:${g.h}:${g.x}:${g.y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  const b = r.stdout; if (!b || b.length < 3) return null;
  let n = 0; const total = Math.floor(b.length / 3);
  for (let i = 0; i < total; i++) if (test(b[i * 3], b[i * 3 + 1], b[i * 3 + 2])) n++;
  return n / total;
}

const near = (c, ref, tol = 24) => !!c && Math.abs(c.r - ref[0]) <= tol && Math.abs(c.g - ref[1]) <= tol && Math.abs(c.b - ref[2]) <= tol;

module.exports = { sampleRegions, fractionMatching, near };

if (require.main === module) { // node tests/e2e/pixels.js <file> <t> x,y,w,h [x,y,w,h ...]
  const [, , file, t, ...rs] = process.argv;
  const regions = rs.map((s) => { const [x, y, w, h] = s.split(',').map(Number); return { x, y, w, h }; });
  console.log(JSON.stringify(sampleRegions(file, t, regions)));
}
