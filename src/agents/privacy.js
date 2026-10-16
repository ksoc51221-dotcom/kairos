// Agent — Privacy Guard: finds secrets/PII on screen (OCR → regex + LLM judgement) and blurs them.
const fs = require('fs');
const path = require('path');
const llm = require('./llm');
const { run } = require('./media');
const { ocrFrames } = require('./ocr');
const { runFfmpeg, videoArgs } = require('../pipeline/encode');
const { SCAN_FPS, SCAN_WIDTH, HASH_W, HASH_H } = require('../pipeline/composite');

const luhn = (s) => { const d = s.replace(/\D/g, ''); if (d.length < 13 || d.length > 19) return false;
  let sum = 0; for (let i = 0; i < d.length; i++) { let n = +d[d.length - 1 - i]; if (i % 2) { n *= 2; if (n > 9) n -= 9; } sum += n; } return sum % 10 === 0; };

const PATTERNS = [
  { type: 'email', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { type: 'api key', re: /\b(?:sk|pk|rk|api|key|tok|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}\b/g },
  { type: 'api key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'token', re: /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}\b/g },
  { type: 'credit card', re: /\b(?:\d[ -]?){13,19}\b/g, check: luhn },
  { type: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: 'phone', re: /(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g },
  { type: 'password', re: /(?:password|passwd|pwd|secret|passcode)\s*[:=]\s*(\S+)/gi, group: 1 },
  { type: 'secret', re: /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{28,}\b/g },
  // R9: an AWS secret access key is 40 characters of base64 and often contains / or +, which the rule above does not allow
  { type: 'secret', re: /(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+=]*\d)(?=[A-Za-z0-9/+=]*[A-Za-z])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g },
];

// character range of `value` inside line text -> union box of the words it overlaps
function boxFor(line, start, end) {
  let pos = 0; const hit = [];
  for (const w of line.words) {
    const s = pos, e = pos + w.text.length; pos = e + 1;
    if (e > start && s < end) hit.push(w);
  }
  if (!hit.length) return null;
  return { x0: Math.min(...hit.map((w) => w.x0)), y0: Math.min(...hit.map((w) => w.y0)),
           x1: Math.max(...hit.map((w) => w.x1)), y1: Math.max(...hit.map((w) => w.y1)) };
}

// OCR does not read a key the way it was typed: it turns "-" into a long dash, puts spaces next to dashes ("sk- live-9f8e"), and swaps O/0, l/1 and I/1.
// So the rules run on three views of each line and every hit is mapped back to the characters of the ORIGINAL text, which is what the word boxes
// and the "mask this value everywhere" step are based on:
//   1. the line as read;  2. normalised: dashes unified, spaces next to - or _ removed;  3. normalised and folded: O→0, l→1, I→1 (same length).
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
function normalise(text) {
  const t = text.replace(DASHES, '-'); let s = ''; const map = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === ' ') {
      let j = i; while (t[j] === ' ') j++;
      const prev = s[s.length - 1], next = t[j];
      if (prev === '-' || prev === '_' || next === '-' || next === '_') continue;
    }
    s += t[i]; map.push(i);
  }
  return { s, map };
}
const fold = (s) => s.replace(/[OQ]/g, '0').replace(/[lI|]/g, '1');

function regexFindings(line) {
  const out = [], seen = new Set(), n = normalise(line.text), views = [{ s: line.text, map: null }, n, { s: fold(n.s), map: n.map }];
  views.forEach((view, vi) => {
    for (const p of PATTERNS) {
      if (vi === 2 && (p.type === 'secret' || p.type === 'email' || p.type === 'password')) continue; // folding l/O into digits would turn long ordinary words into "secrets"
      for (const m of view.s.matchAll(p.re)) {
        const value = p.group ? m[p.group] : m[0];
        if (!value || (p.check && !p.check(value))) continue;
        const start = m.index + (p.group ? m[0].indexOf(value) : 0), end = start + value.length;
        const o0 = view.map ? view.map[start] : start, o1 = view.map ? view.map[end - 1] + 1 : end; // span in the original text
        const key = `${p.type}:${o0}-${o1}`; if (seen.has(key)) continue; seen.add(key);
        const box = boxFor(line, o0, o1);
        if (box) out.push({ type: p.type, value: line.text.slice(o0, o1), box, by: 'rule' });
      }
    }
  });
  return out;
}

const LLM_BUDGET_MS = +process.env.SPOOL_PRIVACY_LLM_MS || 10000; // the rules are the floor; the model is a bonus that must not hold up publishing

async function llmFindings(uniqueLines, log) {
  llmFindings.lastRan = false;
  if (!uniqueLines.length) { llmFindings.lastRan = true; return []; } // nothing left for the model to judge
  if (!(await llm.available())) return [];
  if (!(await llm.loaded())) { llm.warm(); log('LLM pass skipped: the model is not loaded yet (rules only for this video)'); return []; }
  const numbered = uniqueLines.slice(0, 60).map((t, i) => `${i}: ${t.slice(0, 140)}`).join('\n');
  try {
    const res = await llm.json({
      system: 'You are the Privacy Guard of a screen recorder. You get OCR text lines from a screen recording. ' +
        'Find text that must be hidden before sharing: passwords, API keys, access tokens, private emails, phone numbers, ' +
        'payment card or bank numbers, home addresses, government IDs, private personal names in customer data. ' +
        'Do NOT flag normal UI labels, menu names, company/product names or code. ' +
        'For each hit return the line index, a short type, and `value`: the exact substring of that line to hide (copy it character for character).',
      user: numbered + '\n\nReturn JSON: {"hits":[{"i":0,"type":"password","value":"..."}]}. Use {"hits":[]} if nothing is sensitive.',
      timeoutMs: LLM_BUDGET_MS, retries: 0,
      schema: { type: 'object', properties: { hits: { type: 'array', items: { type: 'object',
        properties: { i: { type: 'integer' }, type: { type: 'string' }, value: { type: 'string' } }, required: ['i', 'type', 'value'] } } }, required: ['hits'] },
    });
    llmFindings.lastRan = true;
    return (res.hits || []).filter((h) => uniqueLines[h.i] && h.value && uniqueLines[h.i].includes(h.value))
      .map((h) => ({ line: uniqueLines[h.i], type: String(h.type).slice(0, 30), value: h.value }));
  } catch (e) { log(`LLM pass skipped: ${e.message}`); return []; }
}

const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy, u = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return u > 0 ? inter / u : 0;
};

// ---- frames: 2 fps JPEGs + a 9x8 gray picture per frame, written by the composite step (or by extractScanFrames for uploads) ----

// One ffmpeg run, one decode: used for uploaded videos, which do not go through the composite step.
async function extractScanFrames(video, scanDir) {
  fs.mkdirSync(scanDir, { recursive: true });
  const g = `[0:v]split=2[a][b];[a]fps=${SCAN_FPS},scale='min(${SCAN_WIDTH},iw)':-2[scan];[b]fps=${SCAN_FPS},scale=${HASH_W}:${HASH_H}:flags=area,format=gray[hash]`;
  await runFfmpeg(['-y', '-i', video, '-filter_complex', g, '-map', '[scan]', '-q:v', '3', '-vsync', 'cfr', path.join(scanDir, 'f%04d.jpg'),
    '-map', '[hash]', '-f', 'rawvideo', '-pix_fmt', 'gray', '-vsync', 'cfr', path.join(scanDir, 'hash.raw')]);
}

// 64-bit difference hash of a 9x8 gray picture: bit = left pixel brighter than its right neighbour. The margin keeps video noise from flipping bits in flat areas.
const DHASH_MARGIN = 3;
function dhash(gray, offset = 0) {
  const bits = [];
  for (let y = 0; y < HASH_H; y++) for (let x = 0; x < HASH_W - 1; x++) bits.push(gray[offset + y * HASH_W + x] - gray[offset + y * HASH_W + x + 1] > DHASH_MARGIN ? 1 : 0);
  return bits;
}
const hamming = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);

// Which sampled frames to read: the first, any that differs from the last kept one, and at least one every `maxGap` seconds so a small change cannot hide.
// Returns [{ index, t, until }] where [t, until) is the stretch of near-identical frames this one stands for.
function pickFrames(hashBuf, count, { fps = SCAN_FPS, maxSame = 2, maxGap = 2 } = {}) {
  const size = HASH_W * HASH_H, kept = [];
  let last = null;
  for (let k = 0; k < count; k++) {
    const h = dhash(hashBuf, k * size), t = k / fps;
    if (!last || hamming(h, last.h) > maxSame || t - last.t >= maxGap) { last = { index: k, t, h }; kept.push(last); }
  }
  return kept.map((f, i) => ({ index: f.index, t: f.t, until: i + 1 < kept.length ? kept[i + 1].t : count / fps }));
}

// R8b: f9999.jpg must come before f10000.jpg; a plain sort() puts it after, and the hash frames (which are in time order) no longer line up.
const frameNumber = (f) => parseInt(f.slice(1), 10);
const sortFrames = (names) => names.filter((f) => /^f\d+\.jpg$/.test(f)).sort((a, b) => frameNumber(a) - frameNumber(b));

// R4: how many sampled frames a recording of `duration` seconds must have produced. Fewer means extraction failed part-way and the rest of the
// video was never looked at, so the guard fails closed instead of reporting "nothing found".
function assertCoverage({ jpgs, hashFrames, duration, fps = SCAN_FPS }) {
  const need = duration > 0 ? Math.max(1, Math.floor(duration * fps) - 2) : 0;
  if (jpgs < need) throw new Error(`only ${jpgs} of at least ${need} sample frames were extracted, so the whole video was not checked`);
  if (hashFrames < need) throw new Error(`only ${hashFrames} of at least ${need} frame hashes were written, so the whole video was not checked`);
  return need;
}

// The ffmpeg filter graph that hides each interval's box. R9: a solid black fill, not a blur: a box blur of large text can be partly reversible.
function blurGraph(intervals, width, height, pad = 0.012) {
  const chain = []; let src = '0:v';
  intervals.forEach((iv, i) => {
    const x = Math.max(0, Math.floor((iv.box.x0 - pad) * width)), y = Math.max(0, Math.floor((iv.box.y0 - pad * 1.2) * height));
    const w = Math.min(width - x, Math.ceil((iv.box.x1 - iv.box.x0 + pad * 2) * width)), h = Math.min(height - y, Math.ceil((iv.box.y1 - iv.box.y0 + pad * 2.4) * height));
    chain.push(`[${src}]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@1:t=fill:enable='between(t,${iv.from.toFixed(2)},${iv.to.toFixed(2)})'[v${i}]`);
    src = `v${i}`;
  });
  return { graph: chain.join(';'), last: src };
}

// Test aid, only when SPOOL_PRIVACY_TRACE=<file> is set (the e2e runs set it to learn how the OCR renders the fixture's fake key): appends the OCR lines
// that look like the fixture's "Deploy key" line, with what the rules made of them. Nothing else from the screen is written.
function traceOcr(file, ocr) {
  const rows = [];
  ocr.forEach((f) => f.lines.forEach((l) => { if (/deploy|sk.{0,3}live|9f8e|key:/i.test(l.text)) rows.push(JSON.stringify({ t: +f.t.toFixed(1), text: l.text, words: l.words.map((w) => w.text), hits: regexFindings(l).map((h) => `${h.type}:${h.value}`) })); }));
  if (rows.length) fs.appendFileSync(file, rows.join('\n') + '\n');
}

// Scan a recording for secrets and personal data. Needs a folder of sampled frames (`scanDir`: f0001.jpg… + hash.raw) or, failing that, the video to sample.
// Returns { report, masked, redact(outPath), stats }.
async function scan({ video, scanDir, workDir, duration, width, height, cachePath, onStatus = () => {}, log = () => {} }) {
  const t0 = Date.now();
  if (!scanDir || !fs.existsSync(path.join(scanDir, 'hash.raw'))) { scanDir = path.join(workDir, 'scan'); onStatus('sampling frames'); await extractScanFrames(video, scanDir); }
  const jpgs = sortFrames(fs.readdirSync(scanDir));
  const hashBuf = fs.readFileSync(path.join(scanDir, 'hash.raw'));
  const hashFrames = Math.floor(hashBuf.length / (HASH_W * HASH_H));
  assertCoverage({ jpgs: jpgs.length, hashFrames, duration });
  const count = Math.min(jpgs.length, hashFrames);
  const picked = pickFrames(hashBuf, count);
  const fw = Math.min(SCAN_WIDTH, width), fh = Math.round((fw * height) / width);
  const frames = picked.map((f) => ({ t: f.t, until: f.until, file: path.join(scanDir, jpgs[f.index]), width: fw, height: fh }));
  onStatus(`reading ${frames.length} of ${count} frames`);
  const tOcr = Date.now();
  const ocr = await ocrFrames(frames, { cachePath, onProgress: (d, n) => onStatus(`reading screen ${d}/${n}`) });
  if (ocr.length !== frames.length || ocr.some((f) => !f || !Array.isArray(f.lines))) throw new Error('the screen reader did not return a result for every frame'); // R4
  const ocrMs = Date.now() - tOcr;
  ocr.forEach((f, i) => { f.until = frames[i].until; });
  if (process.env.SPOOL_PRIVACY_TRACE) traceOcr(process.env.SPOOL_PRIVACY_TRACE, ocr); // test aid: see below

  // 1) deterministic rules on every line. These are the floor: they gate publishing even when the model is cold, slow or absent.
  const found = []; // {frame, type, value, box, by}
  ocr.forEach((f, fi) => f.lines.forEach((l) => regexFindings(l).forEach((r) => found.push({ frame: fi, ...r }))));

  // 3) turn per-frame hits into time intervals. A hit on frame i covers [t_i - one sample, until_i): everything the dedupe folded into it.
  const build = () => {
    const intervals = [], byKey = new Map();
    for (const f of found) { const k = f.value.toLowerCase(); (byKey.get(k) || byKey.set(k, []).get(k)).push(f); }
    for (const list of byKey.values()) {
      list.sort((a, b) => a.frame - b.frame);
      let cur = null;
      for (const f of list) {
        if (cur && f.frame <= cur.lastFrame + 1 && iou(cur.box, f.box) > 0.3) {
          cur.lastFrame = f.frame;
          cur.box = { x0: Math.min(cur.box.x0, f.box.x0), y0: Math.min(cur.box.y0, f.box.y0), x1: Math.max(cur.box.x1, f.box.x1), y1: Math.max(cur.box.y1, f.box.y1) };
        } else {
          if (cur) intervals.push(cur);
          cur = { type: f.type, by: f.by, box: { ...f.box }, firstFrame: f.frame, lastFrame: f.frame };
        }
      }
      if (cur) intervals.push(cur);
    }
    for (const iv of intervals) {
      iv.from = Math.max(0, ocr[iv.firstFrame].t - 1 / SCAN_FPS);
      iv.to = iv.lastFrame + 1 < ocr.length ? ocr[iv.lastFrame].until + 1 / SCAN_FPS : duration + 1;
    }
    // mask secrets in the OCR text that downstream agents will read
    const secrets = [...byKey.values()].map((l) => l[0].value);
    const masked = ocr.map((f) => ({ t: f.t, lines: f.lines.map((l) => secrets.reduce((txt, s) => txt.split(s).join('[REDACTED]'), l.text)) }));
    return { intervals, masked, report: intervals.map((iv) => ({ type: iv.type, from: +iv.from.toFixed(1), to: +iv.to.toFixed(1), by: iv.by })) };
  };
  let cur = build();

  // 2) LLM judgement on unique lines the rules didn't already cover, time-boxed. Run it with refine() while the first blur pass is encoding
  // (the model uses the GPU, the encoder the media engine), so a clean video waits for max(blur, model) rather than blur + model.
  // Returns { changed } : true when the model found something the rules did not, so the caller must blur again with `intervals`.
  let llmMs = 0, llmHits = 0, modelRan = false;
  const refine = async () => {
    const covered = new Set(found.map((f) => f.value));
    const uniq = [...new Set(ocr.flatMap((f) => f.lines.map((l) => l.text)))].filter((t) => t.length >= 4 && ![...covered].some((v) => t.includes(v)));
    onStatus('asking the model what is sensitive');
    const tLlm = Date.now(), hits = await llmFindings(uniq, log); llmMs = Date.now() - tLlm; llmHits = hits.length; modelRan = llmFindings.lastRan === true;
    const before = found.length;
    for (const h of hits) ocr.forEach((f, fi) => f.lines.forEach((l) => {
      if (l.text !== h.line) return;
      const s = l.text.indexOf(h.value); const box = boxFor(l, s, s + h.value.length);
      if (box) found.push({ frame: fi, type: h.type, value: h.value, box, by: 'model' });
    }));
    if (found.length === before) return { changed: false };
    cur = build(); return { changed: true };
  };

  // The blur pass reads the published video and writes the blurred one with the hardware encoder. It only runs when something was found.
  const redact = async (outPath, { onProgress } = {}) => {
    const intervals = cur.intervals;
    if (!intervals.length) return false;
    const { graph, last: src } = blurGraph(intervals, width, height);
    const script = path.join(workDir, 'blur.filter'); fs.writeFileSync(script, graph);
    await runFfmpeg(['-y', '-i', video, '-filter_complex_script', script, '-map', `[${src}]`, '-map', '0:a?', ...videoArgs(height), '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', outPath],
      { duration, onProgress });
    return true;
  };
  return {
    get report() { return cur.report; }, get masked() { return cur.masked; }, refine, redact,
    get modelRan() { return modelRan; },
    get stats() { return { sampled: count, modelRan, read: frames.length, engine: ocr.engine, ocrMs, llmMs, llmHits, elapsedMs: Date.now() - t0 }; },
  };
}

// Finding 1: a screenshot is one still frame, and it goes through the same gate as a recording. OCR of the full-size PNG, the same rules, a solid
// fill over every hit. Rules only (no model pass: a still has no time to hide in and the rules are the floor). Throws when the screen reader
// returns nothing usable, so the caller keeps the image closed to viewers.
async function scanStill({ file, out, width, height, cachePath, read = ocrFrames }) {
  const ocr = await read([{ t: 0, file, width, height }], { cachePath });
  if (ocr.length !== 1 || !ocr[0] || !Array.isArray(ocr[0].lines)) throw new Error('the screen reader did not return a result for the screenshot');
  const found = ocr[0].lines.flatMap((l) => regexFindings(l));
  if (!found.length) return { report: [], blurred: false };
  const { graph, last } = blurGraph(found.map((f) => ({ box: f.box, from: 0, to: 1e6 })), width, height);
  await runFfmpeg(['-y', '-i', file, '-filter_complex', graph, '-map', `[${last}]`, '-frames:v', '1', out]);
  return { report: found.map((f) => ({ type: f.type, by: f.by })), blurred: true, engine: ocr.engine };
}
module.exports = { scan, scanStill, regexFindings, normalise, pickFrames, dhash, hamming, extractScanFrames, sortFrames, assertCoverage, blurGraph, PATTERNS };
