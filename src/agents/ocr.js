// Screen reading: OCR sampled frames into lines + word boxes (normalised 0..1).
const path = require('path');
const { createWorker } = require('tesseract.js');

const LANG_PATH = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');

async function ocrFrames(frames, { cachePath, workers = 2, onProgress = () => {} }) {
  const pool = await Promise.all(Array.from({ length: workers }, () =>
    createWorker('eng', 1, { langPath: LANG_PATH, cachePath, gzip: true })));
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
module.exports = { ocrFrames };
