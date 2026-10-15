// What the editor proposes before you apply anything: silences, filler words, waveform peaks. Each is a pure parser over ffmpeg's output or the
// word list, plus a thin runner. Proposals are only ever suggestions: they become cuts when the user accepts them.
const { spawn } = require('child_process');
const { ffmpeg } = require('./encode');

const round = (x) => Math.round(x * 1000) / 1000;

// ---- silences (ffmpeg silencedetect) ----
function parseSilences(stderr, duration) {
  const out = []; let open = null;
  for (const line of String(stderr).split('\n')) {
    const s = /silence_start: (-?[\d.]+)/.exec(line), e = /silence_end: ([\d.]+)/.exec(line);
    if (s) open = Math.max(0, +s[1]);
    if (e && open !== null) { out.push({ start: open, end: +e[1] }); open = null; }
  }
  if (open !== null && duration > open) out.push({ start: open, end: duration }); // silence that runs to the end of the file
  return out;
}
// A silence longer than `minDur` becomes a cut that leaves `keep` seconds of pause behind, so speech does not run together.
function silenceCuts(silences, { minDur = 0.8, keep = 0.3 } = {}) {
  const pad = keep / 2;
  return silences.filter((s) => s.end - s.start >= minDur).map((s) => ({ start: round(s.start + pad), end: round(s.end - pad), kind: 'silence' })).filter((c) => c.end - c.start >= 0.05);
}
function detectSilences(file, duration, { noiseDb = -35, minDur = 0.8 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minDur}`, '-f', 'null', '-']);
    let err = ''; p.stderr.on('data', (d) => (err += d)); p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(parseSilences(err, duration)) : reject(new Error(`ffmpeg ${code}: ${err.slice(-300)}`))));
  });
}

// ---- filler words (from word timestamps) ----
const FILLERS = new Set(['um', 'umm', 'uhm', 'uh', 'uhh', 'er', 'erm', 'ah', 'ahh', 'hmm', 'mm', 'mmm', 'eh']);
const norm = (w) => String(w).toLowerCase().replace(/[^a-z']/g, '');
// "like" is only a filler when it is set apart: a comma or a pause on either side. "I like it" and "looks like a" stay.
function findFillers(words, { likePause = 0.3 } = {}) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], t = norm(w.w), prev = words[i - 1], next = words[i + 1];
    if (FILLERS.has(t)) { out.push({ start: w.s, end: w.e, text: w.w.replace(/[,.!?]+$/, ''), kind: 'filler', i }); continue; }
    if (t === 'know' && prev && norm(prev.w) === 'you' && /,\s*$/.test(w.w)) { out.push({ start: prev.s, end: w.e, text: 'you know', kind: 'filler', i: i - 1 }); continue; } // "you know," as a tic, not "you know the answer"
    if (t === 'like') {
      const setApart = /,\s*$/.test(w.w) || (prev && /,\s*$/.test(prev.w)) || (prev && w.s - prev.e >= likePause) || (next && next.s - w.e >= likePause);
      if (setApart) out.push({ start: w.s, end: w.e, text: w.w.replace(/[,.!?]+$/, ''), kind: 'filler', i });
    }
  }
  // "you know" was recorded at its first word's index; drop the duplicate that the single-word pass may have produced for "know"
  return out.filter((f, k, a) => a.findIndex((g) => g.start === f.start && g.end === f.end) === k);
}

// ---- waveform: one peak per 10 ms, 0..127, from 8 kHz mono audio decoded once ----
const PEAK_RATE = 100;
function computePeaks(pcm, sampleRate = 8000, rate = PEAK_RATE) {
  const per = Math.max(1, Math.round(sampleRate / rate)), n = Math.ceil(pcm.length / per), peaks = new Array(n);
  for (let i = 0; i < n; i++) { let m = 0; const end = Math.min(pcm.length, (i + 1) * per); for (let j = i * per; j < end; j++) { const a = Math.abs(pcm[j]); if (a > m) m = a; } peaks[i] = Math.min(127, Math.round(Math.sqrt(m) * 127)); } // sqrt: quiet speech stays visible next to loud peaks
  return peaks;
}
function waveform(file, duration) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-']);
    const chunks = []; let err = '';
    p.stdout.on('data', (d) => chunks.push(d)); p.stderr.on('data', (d) => (err += d)); p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg ${code}: ${err.slice(-300)}`));
      const buf = Buffer.concat(chunks), pcm = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 4)));
      resolve({ rate: PEAK_RATE, duration, peaks: computePeaks(pcm) });
    });
  });
}

module.exports = { parseSilences, silenceCuts, detectSilences, findFillers, computePeaks, waveform, PEAK_RATE };
