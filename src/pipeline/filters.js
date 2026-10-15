// Camera filters and frame rings as ffmpeg filter chains. The live bubble preview uses the CSS strings in shared/constants.js; these are the
// published-video equivalents. They match closely but not exactly:
//   - CSS hue-rotate turns the colour wheel in RGB, ffmpeg's `hue` turns it in YUV, so tints land a few percent apart
//   - CSS brightness() multiplies, ffmpeg's `eq=brightness` adds, so +0.02 stands in for brightness(1.02)
//   - CSS blur(.7px) is in screen points; the camera is scaled to the bubble first, so sigma 0.7 at output size is the same blur on screen
// All chains are pure strings (no files), so they are unit-tested by snapshot.

// CSS sepia(a) is identity blended with the sepia matrix by a. Rows are the output r, g, b.
function sepiaMix(a) {
  const S = [[.393, .769, .189], [.349, .686, .168], [.272, .534, .131]];
  const m = S.map((row, i) => row.map((v, j) => +((i === j ? 1 - a : 0) + a * v).toFixed(4)));
  return `colorchannelmixer=rr=${m[0][0]}:rg=${m[0][1]}:rb=${m[0][2]}:gr=${m[1][0]}:gg=${m[1][1]}:gb=${m[1][2]}:br=${m[2][0]}:bg=${m[2][1]}:bb=${m[2][2]}`;
}

const FILTERS = {
  none: '',
  warm: `${sepiaMix(0.25)},eq=saturation=1.25,hue=h=-8`,
  cool: 'eq=saturation=1.1:brightness=0.02,hue=h=12',
  bw: 'hue=s=0,eq=contrast=1.1',
  vivid: 'eq=saturation=1.6:contrast=1.1',
  soft: 'gblur=sigma=0.7,eq=brightness=0.03:saturation=0.95',
  film: `${sepiaMix(0.4)},eq=contrast=0.92:brightness=0.02`,
};
const filterChain = (key) => (key in FILTERS ? FILTERS[key] : '');

// Frame rings, drawn inside the bubble edge. `bands` are listed from the outer edge inwards, each `t` is a fraction of the bubble's short side.
// `glow` adds a soft inner falloff of that fraction. Colours are content (they end up in the video), so they live here, not in the UI skin.
const FRAMES = {
  none: null,
  ring: { bands: [{ c: [255, 255, 255], t: 0.015 }] },
  purple: { bands: [{ c: [123, 92, 240], t: 0.015 }] },
  mint: { bands: [{ c: [34, 192, 138], t: 0.015 }] },
  gradient: { bands: [{ c: [123, 92, 240], t: 0.015 }, { c: [34, 192, 138], t: 0.01 }] },
  glow: { bands: [{ c: [52, 224, 161], t: 0.015 }], glow: 0.07 },
};
const frameSpec = (key) => FRAMES[key] || null;

module.exports = { FILTERS, filterChain, FRAMES, frameSpec, sepiaMix };
