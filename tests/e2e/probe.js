#!/usr/bin/env node
// Measures a media file with the bundled ffmpeg (ffmpeg-static ships no ffprobe).
//   node tests/e2e/probe.js <file> [--json]
// Prints codec, size, frame count, average fps, bitrate and the spread of frame-to-frame timestamp gaps,
// which is the number that tells you whether a recording will look smooth ("judder").
const fs = require('fs');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

function bannerOf(file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  return r.stderr || '';
}

function parseBanner(txt) {
  const v = /Stream #\d+:\d+[^:]*: Video: (\w+)(?: \(([^)]*)\))?[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(txt);
  const a = /Stream #\d+:\d+[^:]*: Audio: (\w+)[^\n]*?, (\d+) Hz, (\w+)/.exec(txt);
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(txt);
  return {
    video: v ? { codec: v[1], profile: v[2] || '', width: +v[3], height: +v[4] } : null,
    audio: a ? { codec: a[1], rate: +a[2], layout: a[3] } : null,
    containerDuration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : null, // null for webm written by MediaRecorder (no duration header)
  };
}

// Every decoded video frame's presentation time, via the showinfo filter (no re-timing: passthrough).
function framePts(file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-map', '0:v:0', '-an', '-vf', 'showinfo', '-fps_mode', 'passthrough', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  return [...(r.stderr || '').matchAll(/pts_time:\s*(-?[\d.]+)/g)].map((m) => +m[1]);
}

function stats(deltasMs) {
  if (!deltasMs.length) return { mean: 0, std: 0, min: 0, max: 0, p99: 0 };
  const n = deltasMs.length, mean = deltasMs.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(deltasMs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const sorted = [...deltasMs].sort((a, b) => a - b);
  return { mean, std, min: sorted[0], max: sorted[n - 1], p99: sorted[Math.min(n - 1, Math.floor(n * 0.99))] };
}

function probe(file) {
  const bytes = fs.statSync(file).size, info = parseBanner(bannerOf(file)), pts = framePts(file);
  const out = { file, bytes, ...info, frames: pts.length };
  if (pts.length > 1) {
    const sorted = [...pts].sort((a, b) => a - b), deltas = [];
    for (let i = 1; i < sorted.length; i++) deltas.push((sorted[i] - sorted[i - 1]) * 1000);
    const median = [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)] / 1000;
    out.firstPts = sorted[0]; out.lastPts = sorted[sorted.length - 1];
    out.videoSeconds = out.lastPts - out.firstPts + median; // last frame still occupies one frame interval
    out.avgFps = (pts.length - 1) / (out.lastPts - out.firstPts);
    out.bitrateMbps = (bytes * 8) / out.videoSeconds / 1e6;
    out.ptsDeltaMs = stats(deltas);
  }
  return out;
}

module.exports = { probe, framePts, parseBanner, stats };

if (require.main === module) {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) { console.error('usage: node tests/e2e/probe.js <file> [--json]'); process.exit(2); }
  const r = probe(file);
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    const f = (x, d = 2) => (x == null ? 'n/a' : (+x).toFixed(d));
    console.log(`${r.file}\n  ${r.video ? `${r.video.codec} ${r.video.width}x${r.video.height}` : 'no video'}${r.audio ? ` + ${r.audio.codec}` : ''}  ${(r.bytes / 1e6).toFixed(2)} MB`);
    console.log(`  frames ${r.frames}  span ${f(r.videoSeconds)} s  avg ${f(r.avgFps, 1)} fps  bitrate ${f(r.bitrateMbps, 1)} Mb/s`);
    if (r.ptsDeltaMs) console.log(`  frame gaps: mean ${f(r.ptsDeltaMs.mean)} ms  std ${f(r.ptsDeltaMs.std)} ms  min ${f(r.ptsDeltaMs.min)}  max ${f(r.ptsDeltaMs.max)}  p99 ${f(r.ptsDeltaMs.p99)}`);
  }
}
