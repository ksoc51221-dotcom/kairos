// Screen reading: OCR sampled frames into lines + word boxes (normalised 0..1, origin top left).
// macOS: the Vision framework through a tiny Swift CLI (native/vision-ocr.swift), compiled once into the models folder.
// Everywhere else, or when Xcode's command line tools are missing: tesseract.js (WASM, much slower, same output shape).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const SRC = path.join(__dirname, 'native', 'vision-ocr.swift');
const LANG_PATH = () => path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');

// ---- Vision ----
let visionBin; // undefined = not tried, null = unavailable, string = path
let compiling = null;
function hasSwiftc() {
  if (process.platform !== 'darwin') return false;
  const r = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
  return r.status === 0;
}
// Compiles once (about 10 s), keyed by a hash of the source so an edited tool is rebuilt. Safe to call early, in the background.
function ensureVision(cachePath) {
  if (visionBin !== undefined) return Promise.resolve(visionBin);
  if (compiling) return compiling;
  compiling = new Promise((resolve) => {
    try {
      if (process.env.SPOOL_OCR === 'tesseract' || !hasSwiftc()) return resolve((visionBin = null));
      const hash = crypto.createHash('sha1').update(fs.readFileSync(SRC)).digest('hex').slice(0, 10);
      const bin = path.join(cachePath, 'bin', `vision-ocr-${hash}`);
      if (fs.existsSync(bin)) return resolve((visionBin = bin));
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      const p = spawn('xcrun', ['swiftc', '-O', SRC, '-o', bin + '.tmp'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; p.stderr.on('data', (d) => (err += d));
      p.on('error', () => resolve((visionBin = null)));
      p.on('close', (code) => {
        if (code !== 0) { console.warn('vision-ocr: compile failed, using tesseract:', err.slice(-300)); return resolve((visionBin = null)); }
        fs.renameSync(bin + '.tmp', bin); resolve((visionBin = bin));
      });
    } catch (e) { resolve((visionBin = null)); }
  });
  return compiling;
}

// One process per chunk of files; each prints one JSON line per file as it finishes.
function runVision(bin, files) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, files), out = new Map(); let buf = '', err = '', bad = null;
    p.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
        try { const j = JSON.parse(line); if (typeof j.file !== 'string' || !Array.isArray(j.lines)) throw new Error('unexpected shape'); out.set(j.file, j.lines); }
        catch (e) { bad = `a result line did not parse (${e.message})`; } // R4: a garbled line is a failure, never "nothing found"
      }
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code !== 0 ? reject(new Error(`vision-ocr ${code}: ${err.slice(-200)}`)) : bad ? reject(new Error(`vision-ocr: ${bad}`)) : resolve(out)));
  });
}

async function visionFrames(bin, frames, onProgress) {
  const workers = Math.min(2, frames.length) || 1, chunks = Array.from({ length: workers }, () => []);
  frames.forEach((f, i) => chunks[i % workers].push(f));
  const result = new Map(); let done = 0;
  await Promise.all(chunks.map(async (c) => {
    // small batches keep progress moving and cap the memory one process holds
    for (let i = 0; i < c.length; i += 4) {
      const batch = c.slice(i, i + 4), m = await runVision(bin, batch.map((f) => f.file));
      // R4: a frame the reader skipped is an error. An empty list would read as "this frame has no text" and clear the video.
      batch.forEach((f) => { if (!m.has(f.file)) throw new Error(`vision-ocr returned no result for ${path.basename(f.file)}`); result.set(f.file, m.get(f.file)); });
      onProgress(done += batch.length, frames.length);
    }
  }));
  return frames.map((f) => ({ t: f.t, width: f.width, height: f.height, lines: result.get(f.file) }));
}

// ---- tesseract (fallback) ----
async function tesseractFrames(frames, { cachePath, workers = 2, onProgress }) {
  const { createWorker } = require('tesseract.js');
  const pool = await Promise.all(Array.from({ length: workers }, () => createWorker('eng', 1, { langPath: LANG_PATH(), cachePath, gzip: true })));
  const out = new Array(frames.length);
  let next = 0, done = 0;
  await Promise.all(pool.map(async (w) => {
    while (next < frames.length) {
      const i = next++;
      const { data } = await w.recognize(frames[i].file, {}, { blocks: true });
      out[i] = { t: frames[i].t, width: frames[i].width, height: frames[i].height, lines: extractLines(data, frames[i]) };
      onProgress(++done, frames.length);
    }
  }));
  await Promise.all(pool.map((w) => w.terminate()));
  return out;
}

function extractLines(data, f) {
  const lines = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const words = (l.words || []).filter((w) => w.text.trim() && w.confidence > 35).map((w) => ({
      text: w.text, x0: w.bbox.x0 / f.width, y0: w.bbox.y0 / f.height, x1: w.bbox.x1 / f.width, y1: w.bbox.y1 / f.height,
    }));
    if (!words.length) continue;
    lines.push({ text: words.map((w) => w.text).join(' '), words });
  }
  return lines;
}

// frames: [{ t, file, width, height }] → [{ t, width, height, lines }]. `engine` in the result says which reader did the work.
async function ocrFrames(frames, { cachePath, workers = 2, onProgress = () => {} } = {}) {
  if (!frames.length) { onProgress(0, 0); return Object.assign([], { engine: 'none' }); }
  const bin = await ensureVision(cachePath);
  if (bin) {
    try { return Object.assign(await visionFrames(bin, frames, onProgress), { engine: 'vision' }); }
    catch (e) { console.warn('vision-ocr failed, falling back to tesseract:', e.message); }
  }
  const out = await tesseractFrames(frames, { cachePath, workers, onProgress });
  if (out.length !== frames.length || out.some((f) => !f || !Array.isArray(f.lines))) throw new Error('tesseract did not read every frame'); // R4
  return Object.assign(out, { engine: 'tesseract' });
}

module.exports = { ocrFrames, ensureVision, extractLines, visionFrames };
