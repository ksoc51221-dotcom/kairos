// Recording manifests: what a video folder holds after recording and how to read it back.
//   recording  timeline.json + screen_N / cam_N files (written by the v2 recorder)
//   upload     segments.json { upload: "upload.mp4" } (Loomify: any video file dropped into the library)
const fs = require('fs');
const path = require('path');
const C = require('../shared/constants');

const timelinePath = (dir) => path.join(dir, C.FILES.timeline);

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}
const writeTimeline = (dir, tl) => writeJsonAtomic(timelinePath(dir), tl);
const readTimeline = (dir) => JSON.parse(fs.readFileSync(timelinePath(dir), 'utf8'));

function readManifest(dir) {
  if (fs.existsSync(timelinePath(dir))) return { kind: 'recording', timeline: readTimeline(dir) };
  const seg = path.join(dir, 'segments.json');
  if (fs.existsSync(seg)) {
    const m = JSON.parse(fs.readFileSync(seg, 'utf8'));
    if (m.upload) return { kind: 'upload', file: path.join(dir, m.upload) };
  }
  return null;
}

// The segments that can actually be composited: long enough to hold a frame, with the file(s) the mode needs present on disk.
function segmentInputs(dir, timeline, minDur = 0.05) {
  const has = (f) => (f && fs.existsSync(path.join(dir, f)) && fs.statSync(path.join(dir, f)).size > 0 ? path.join(dir, f) : null);
  return (timeline.segments || [])
    .filter((s) => s.dur >= minDur)
    .map((s) => ({ n: s.n, t0: s.t0, dur: s.dur, screen: has(s.screen), cam: has(s.cam), width: s.width, height: s.height }))
    .filter((s) => (timeline.mode === 'cam' ? s.cam : s.screen));
}
const totalDuration = (inputs) => inputs.reduce((a, s) => a + s.dur, 0);

module.exports = { timelinePath, writeTimeline, readTimeline, readManifest, segmentInputs, totalDuration, writeJsonAtomic };
