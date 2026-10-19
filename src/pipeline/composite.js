// Builds the ffmpeg command that turns a recording (separate screen + camera tracks and timeline.json) into one video.
// A pure function: (timeline, segment files, options) → args array. Nothing here touches the disk or runs ffmpeg, so it is unit-tested.
//
// Pipeline: concat segments (each trimmed to its recorded length) → crop → scale to the quality preset (never upscale) → 60 fps
//   → camera bubble: scale, filter (filters.js), shape mask (alphamerge), frame ring, positioned from the recorded keyframes
//   → one hardware encode (h264_videotoolbox, libx264 elsewhere), AAC audio, +faststart.
// A bubble "run" is a stretch of keyframes with the same size, shape, filter and frame. It gets one overlay whose x/y follow the recorded
// moves as piecewise-constant expressions (equivalent to one overlay per span, but the camera is scaled once per run, not once per span).
// Optional `scanDir`: the same filter graph also writes 2 fps JPEGs and a tiny gray thumbnail stream for the Privacy Guard, so scanning needs no second decode.
const C = require('../shared/constants');
const { videoArgs, audioArgs } = require('./encode');
const { filterChain, frameSpec } = require('./filters');
const { totalDuration } = require('./segments');

const evenFloor = (n) => { n = Math.floor(n); return n - (n % 2); };
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const num = (n) => +(+n).toFixed(3);
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const MAX_POSITIONS = 60;     // overlay positions per bubble run, thinned beyond this
const MIN_MOVE_PX = 2;        // smaller moves are merged
const EASE_S = 0.2;           // a move, resize or shape change eases in over this long instead of cutting
const SCAN_FPS = 2, SCAN_WIDTH = 2048, HASH_W = 9, HASH_H = 8; // Privacy Guard frames: dHash is 9x8 gray, 64 bits

// Pixel size of the finished video.
function outputSize(tl, quality) {
  let w, h;
  if (tl.mode === 'cam') { w = tl.cam.width; h = tl.cam.height; }
  else { const c = tl.crop || FULL; w = Math.round(tl.screen.width * c.w); h = Math.round(tl.screen.height * c.h); }
  const target = C.qualityHeight(quality);
  if (target && h > target) { w = Math.round((w * target) / h); h = target; } // scaling down only
  return { w: Math.max(2, evenFloor(w)), h: Math.max(2, evenFloor(h)) };
}

// Where a bubble keyframe lands in the output frame, in pixels, kept inside the frame.
function framePx(tl, row, size) {
  let [, x, y, w, h] = row;
  if (tl.bubbleSpace !== 'frame') { const c = tl.crop || FULL; x = (x - c.x) / c.w; y = (y - c.y) / c.h; w /= c.w; h /= c.h; } // display → cropped area
  const bw = clamp(evenFloor(w * size.w), 16, evenFloor(size.w)), bh = clamp(evenFloor(h * size.h), 16, evenFloor(size.h));
  return { x: clamp(Math.round(x * size.w), 0, size.w - bw), y: clamp(Math.round(y * size.h), 0, size.h - bh), w: bw, h: bh };
}

// Keyframes → runs of constant size and shape, each with the positions it moves through. Hidden spans end a run.
function bubbleRuns(tl, size, total) {
  let rows = (tl.bubble || []).filter((r) => Array.isArray(r) && r.length >= 9).sort((a, b) => a[0] - b[0]);
  if (!rows.length) { // no keyframes recorded: bottom-left, like windows recordings
    const bh = size.h * 0.28; rows = [[0, 0.02, 0.69, (bh / size.w), 0.28, 'circle', 'none', 'ring', 1]];
    tl = { ...tl, bubbleSpace: 'frame' };
  }
  const runs = []; let cur = null;
  rows.forEach((row, i) => {
    const start = i === 0 ? 0 : row[0], end = i + 1 < rows.length ? rows[i + 1][0] : total;
    if (end <= start) return;
    if (!row[8]) { cur = null; return; }
    const px = framePx(tl, row, size), filter = row[6] || 'none', frame = row[7] || 'none';
    if (cur && cur.w === px.w && cur.h === px.h && cur.shape === row[5] && cur.filter === filter && cur.frame === frame) {
      cur.end = end;
      const last = cur.positions[cur.positions.length - 1];
      if (Math.abs(last[1] - px.x) >= MIN_MOVE_PX || Math.abs(last[2] - px.y) >= MIN_MOVE_PX) cur.positions.push([start, px.x, px.y]);
    } else { cur = { start, end, w: px.w, h: px.h, shape: row[5], filter, frame, positions: [[start, px.x, px.y]] }; runs.push(cur); }
  });
  runs.forEach((r, k) => { // a style or size change that follows straight on from the last run cross-fades: the old one lingers while the new one fades in
    const prev = runs[k - 1];
    if (prev && Math.abs(prev.end - r.start) < 1e-6) { r.fadeIn = Math.min(EASE_S, r.end - r.start); prev.end = Math.min(total, prev.end + r.fadeIn); }
  });
  for (const r of runs) if (r.positions.length > MAX_POSITIONS) { // thin evenly, keeping the first and last
    const keep = Array.from({ length: MAX_POSITIONS }, (_, k) => r.positions[Math.round((k * (r.positions.length - 1)) / (MAX_POSITIONS - 1))]);
    r.positions = keep;
  }
  return runs;
}

// Value over time as an ffmpeg expression: positions [[t, v]...] → if(lt(t,t1),v0,if(lt(t,t2),v1,v2)).
// Each move to a new value glides there with a smoothstep over EASE_S (or until the next keyframe, if that comes sooner), so a snap or a
// drop onto a new spot is not a cut. Dense keyframes from a drag are short glides back to back, which looks the same as following the mouse.
function piecewise(positions, pick) {
  const seg = (k) => {
    const v = pick(positions[k]);
    if (k === 0) return String(v);
    const p = pick(positions[k - 1]), t0 = positions[k][0], next = k + 1 < positions.length ? positions[k + 1][0] : Infinity, d = Math.min(EASE_S, next - t0);
    if (p === v || !(d > 0.016)) return String(v);
    const u = `min(1,(t-${num(t0)})/${num(d)})`;
    return `(${p}+${v - p}*${u}*${u}*(3-2*${u}))`;
  };
  let acc = seg(positions.length - 1);
  for (let k = positions.length - 2; k >= 0; k--) acc = `if(lt(t,${num(positions[k + 1][0])}),${seg(k)},${acc})`;
  return acc;
}

// inputs: [{ n, dur, screen, cam, width?, height? }] absolute paths (see segments.segmentInputs)
// options: { out, quality (default: what the timeline was recorded with), hw, maskPath(shape, w, h) → png path, framePath(frame, shape, w, h) → png path | null, scanDir }
function buildComposite(tl, inputs, { out, quality, hw, maskPath, framePath, scanDir } = {}) {
  if (!inputs.length) throw new Error('nothing to composite');
  quality = quality || tl.quality || C.DEFAULT_QUALITY;
  const camMode = tl.mode === 'cam', size = outputSize(tl, quality), total = totalDuration(inputs);
  const useCam = !camMode && tl.mode === 'screen-cam' && !!tl.cam && inputs.every((s) => s.cam); // a segment without camera footage would misalign the concat
  const runs = useCam ? bubbleRuns(tl, size, total) : [];

  const args = ['-y'], idx = { screen: [], cam: [], mask: [], frame: [] };
  let i = 0;
  for (const s of inputs) {
    if (!camMode) { args.push('-t', String(num(s.dur)), '-i', s.screen); idx.screen.push(i++); }
    if (camMode || useCam) { args.push('-t', String(num(s.dur)), '-i', s.cam); idx.cam.push(i++); }
  }
  for (const r of runs) {
    args.push('-loop', '1', '-framerate', '30', '-t', String(num(total)), '-i', maskPath(r.shape, r.w, r.h)); idx.mask.push(i++);
    const fp = frameSpec(r.frame) && framePath ? framePath(r.frame, r.shape, r.w, r.h) : null;
    if (fp) { args.push('-loop', '1', '-framerate', '30', '-t', String(num(total)), '-i', fp); idx.frame.push(i++); } else idx.frame.push(null);
  }

  const lab = (list, k) => list.map((n) => `[${n}:${k}]`).join('');
  const g = [];
  if (camMode) {
    g.push(`${lab(idx.cam, 'v')}concat=n=${idx.cam.length}:v=1:a=0[cc0]`);
    g.push(`[cc0]scale=${size.w}:${size.h}:force_original_aspect_ratio=increase,crop=${size.w}:${size.h},fps=${C.SCREEN_FPS},format=yuv420p[base]`);
  } else {
    // A segment recorded at another size (a window resized between pause and resume) is fitted to the timeline's size, or concat would fail.
    const T = tl.screen, ins = idx.screen.map((n, k) => {
      const w = inputs[k].width, h = inputs[k].height;
      if (!w || !h || (w === T.width && h === T.height)) return `[${n}:v]`;
      g.push(`[${n}:v]scale=${T.width}:${T.height}:force_original_aspect_ratio=decrease,pad=${T.width}:${T.height}:(ow-iw)/2:(oh-ih)/2[fit${k}]`);
      return `[fit${k}]`;
    });
    g.push(`${ins.join('')}concat=n=${ins.length}:v=1:a=0[sc]`);
    const chain = [], c = tl.crop;
    if (c) {
      const cw = evenFloor(Math.round(tl.screen.width * c.w)), ch = evenFloor(Math.round(tl.screen.height * c.h));
      const cx = clamp(Math.round(tl.screen.width * c.x), 0, tl.screen.width - cw), cy = clamp(Math.round(tl.screen.height * c.y), 0, tl.screen.height - ch);
      chain.push(`crop=${cw}:${ch}:${cx}:${cy}`);
    }
    const nativeH = c ? evenFloor(Math.round(tl.screen.height * c.h)) : tl.screen.height;
    if (size.h < nativeH) chain.push(`scale=${size.w}:${size.h}:flags=lanczos`);
    chain.push(`fps=${C.SCREEN_FPS}`, 'format=yuv420p');
    g.push(`[sc]${chain.join(',')}[base]`);
  }

  let cur = 'base';
  if (runs.length) {
    g.push(`${lab(idx.cam, 'v')}concat=n=${idx.cam.length}:v=1:a=0[cc]`);
    if (runs.length > 1) g.push(`[cc]split=${runs.length}${runs.map((_, k) => `[cs${k}]`).join('')}`);
    runs.forEach((r, k) => {
      const fx = filterChain(r.filter);
      g.push(`${runs.length > 1 ? `[cs${k}]` : '[cc]'}scale=${r.w}:${r.h}:force_original_aspect_ratio=increase,crop=${r.w}:${r.h}${fx ? ',' + fx : ''},format=yuva420p[cf${k}]`);
      g.push(`[${idx.mask[k]}:v]format=gray[mk${k}]`);
      const framed = idx.frame[k] !== null;
      g.push(`[cf${k}][mk${k}]alphamerge[${framed ? 'cm' : 'ca'}${k}]`);
      if (framed) g.push(`[cm${k}][${idx.frame[k]}:v]overlay=0:0:format=auto,format=yuva420p[ca${k}]`);
      if (r.fadeIn) g.push(`[ca${k}]fade=t=in:st=${num(r.start)}:d=${num(r.fadeIn)}:alpha=1[caf${k}]`);
      g.push(`[${cur}][${r.fadeIn ? 'caf' : 'ca'}${k}]overlay=x='${piecewise(r.positions, (p) => p[1])}':y='${piecewise(r.positions, (p) => p[2])}':enable='between(t,${num(r.start)},${num(r.end)})':eof_action=pass[ov${k}]`);
      cur = `ov${k}`;
    });
  }

  const withAudio = !!tl.audio;
  if (withAudio) { const a = camMode ? idx.cam : idx.screen; g.push(`${lab(a, 'a')}concat=n=${a.length}:v=0:a=1[a]`); }

  let encLabel = cur;
  if (scanDir) { // one decode, three outputs: the video, JPEGs for OCR, and a 9x8 gray stream for the frame hash
    g.push(`[${cur}]split=3[enc][scj][sch]`);
    g.push(`[scj]fps=${SCAN_FPS},scale='min(${SCAN_WIDTH},iw)':-2[scan]`);
    g.push(`[sch]fps=${SCAN_FPS},scale=${HASH_W}:${HASH_H}:flags=area,format=gray[hash]`);
    encLabel = 'enc';
  }
  args.push('-filter_complex', g.join(';'), '-map', `[${encLabel}]`, ...(withAudio ? ['-map', '[a]'] : []),
    ...videoArgs(size.h, hw), ...(withAudio ? audioArgs() : []), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
  if (scanDir) {
    const path = require('path');
    args.push('-map', '[scan]', '-q:v', '3', '-vsync', 'cfr', path.join(scanDir, 'f%04d.jpg'),
      '-map', '[hash]', '-f', 'rawvideo', '-pix_fmt', 'gray', '-vsync', 'cfr', path.join(scanDir, 'hash.raw'));
  }
  return { args, size, total, runs, useCam, scan: scanDir ? { fps: SCAN_FPS, hashSize: HASH_W * HASH_H } : null };
}

module.exports = { buildComposite, outputSize, bubbleRuns, framePx, piecewise, SCAN_FPS, SCAN_WIDTH, HASH_W, HASH_H };
