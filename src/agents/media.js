// ffmpeg helpers shared by the agents.
const { spawn } = require('child_process');
const path = require('path');
const ffmpeg = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

function run(args, { collect = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 || collect ? resolve({ code, err }) : reject(new Error(`ffmpeg ${code}: ${err.slice(-400)}`))));
  });
}

const extractAudio = (video, out) => run(['-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', out]);
const frameAt = (video, t, out, width = 1280) => run(['-y', '-ss', String(t), '-i', video, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', out]);

// Timestamps (seconds) where the picture changes a lot, plus a floor of one frame every `every` seconds.
async function sceneChanges(video, { threshold = 0.04, every = 5, duration }) {
  const r = await run(['-i', video, '-vf', `select='gt(scene,${threshold})',showinfo`, '-an', '-f', 'null', '-'], { collect: true });
  const ts = [...r.err.matchAll(/pts_time:([\d.]+)/g)].map((m) => +m[1]);
  const set = new Set([0.5, ...ts]);
  for (let t = every; t < duration; t += every) set.add(t);
  const sorted = [...set].filter((t) => t < duration - 0.1).sort((a, b) => a - b);
  return sorted.reduce((acc, t) => (acc.length && t - acc[acc.length - 1] < 1.2 ? acc : [...acc, t]), []); // keep samples >=1.2s apart
}

module.exports = { run, ffmpeg, extractAudio, frameAt, sceneChanges, path };

// Duration + size from ffmpeg's banner (no ffprobe needed).
async function probe(video) {
  const { err } = await run(['-i', video], { collect: true });
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
  const v = /Video:.*?, (\d{2,5})x(\d{2,5})/.exec(err);
  return { duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0, width: v ? +v[1] : 1280, height: v ? +v[2] : 720 };
}
module.exports.probe = probe;
