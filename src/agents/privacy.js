// Agent — Privacy Guard: finds secrets/PII on screen (OCR → regex + LLM judgement) and blurs them.
const fs = require('fs');
const path = require('path');
const llm = require('./llm');
const { run, frameAt, sceneChanges } = require('./media');
const { ocrFrames } = require('./ocr');

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

function regexFindings(line) {
  const out = [];
  for (const p of PATTERNS) {
    for (const m of line.text.matchAll(p.re)) {
      const value = p.group ? m[p.group] : m[0];
      if (!value || (p.check && !p.check(value))) continue;
      const start = m.index + (p.group ? m[0].indexOf(value) : 0);
      const box = boxFor(line, start, start + value.length);
      if (box) out.push({ type: p.type, value, box, by: 'rule' });
    }
  }
  return out;
}

async function llmFindings(uniqueLines, log) {
  if (!uniqueLines.length || !(await llm.available())) return [];
  const numbered = uniqueLines.slice(0, 120).map((t, i) => `${i}: ${t.slice(0, 140)}`).join('\n');
  try {
    const res = await llm.json({
      system: 'You are the Privacy Guard of a screen recorder. You get OCR text lines from a screen recording. ' +
        'Find text that must be hidden before sharing: passwords, API keys, access tokens, private emails, phone numbers, ' +
        'payment card or bank numbers, home addresses, government IDs, private personal names in customer data. ' +
        'Do NOT flag normal UI labels, menu names, company/product names or code. ' +
        'For each hit return the line index, a short type, and `value`: the exact substring of that line to hide (copy it character for character).',
      user: numbered + '\n\nReturn JSON: {"hits":[{"i":0,"type":"password","value":"..."}]}. Use {"hits":[]} if nothing is sensitive.',
      schema: { type: 'object', properties: { hits: { type: 'array', items: { type: 'object',
        properties: { i: { type: 'integer' }, type: { type: 'string' }, value: { type: 'string' } }, required: ['i', 'type', 'value'] } } }, required: ['hits'] },
    });
    return (res.hits || []).filter((h) => uniqueLines[h.i] && h.value && uniqueLines[h.i].includes(h.value))
      .map((h) => ({ line: uniqueLines[h.i], type: String(h.type).slice(0, 30), value: h.value }));
  } catch (e) { log(`LLM pass skipped: ${e.message}`); return []; }
}

const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy, u = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return u > 0 ? inter / u : 0;
};

// Scan a video. Returns { findings, frames (OCR, secrets masked), redact(outPath) }
async function scan({ video, workDir, duration, width, height, cachePath, onStatus = () => {}, log = () => {} }) {
  const fdir = path.join(workDir, 'frames'); fs.mkdirSync(fdir, { recursive: true });
  const times = await sceneChanges(video, { every: 3, duration });
  const fw = Math.min(1600, width);
  const frames = [];
  for (let i = 0; i < times.length; i++) {
    const file = path.join(fdir, `f${i}.jpg`);
    await frameAt(video, times[i], file, fw);
    if (!fs.existsSync(file)) continue; // timestamp past the last decodable frame
    frames.push({ t: times[i], file, width: fw, height: Math.round(fw * height / width) });
  }
  onStatus(`reading ${frames.length} frames`);
  const ocr = await ocrFrames(frames, { cachePath, onProgress: (d, n) => onStatus(`reading screen ${d}/${n}`) });

  // 1) deterministic rules on every line
  const found = []; // {frame, type, value, box, by}
  ocr.forEach((f, fi) => f.lines.forEach((l) => regexFindings(l).forEach((r) => found.push({ frame: fi, ...r }))));

  // 2) LLM judgement on unique lines the rules didn't already cover
  const covered = new Set(found.map((f) => f.value));
  const uniq = [...new Set(ocr.flatMap((f) => f.lines.map((l) => l.text)))].filter((t) => t.length >= 4 && ![...covered].some((v) => t.includes(v)));
  onStatus('asking the model what is sensitive');
  const hits = await llmFindings(uniq, log);
  for (const h of hits) ocr.forEach((f, fi) => f.lines.forEach((l) => {
    if (l.text !== h.line) return;
    const s = l.text.indexOf(h.value); const box = boxFor(l, s, s + h.value.length);
    if (box) found.push({ frame: fi, type: h.type, value: h.value, box, by: 'model' });
  }));

  // 3) turn per-frame hits into time intervals (conservative: extend to neighbouring samples)
  const intervals = [];
  const byKey = new Map();
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
    iv.from = iv.firstFrame > 0 ? ocr[iv.firstFrame - 1].t : 0;
    iv.to = iv.lastFrame + 1 < ocr.length ? ocr[iv.lastFrame + 1].t : duration + 1;
  }

  // mask secrets in the OCR text that downstream agents will read
  const secrets = [...byKey.values()].map((l) => l[0].value);
  const masked = ocr.map((f) => ({ t: f.t, lines: f.lines.map((l) => secrets.reduce((txt, s) => txt.split(s).join('[REDACTED]'), l.text)) }));

  const redact = async (outPath) => {
    if (!intervals.length) return false;
    const pad = 0.012;
    const chain = []; let cur = '0:v';
    intervals.forEach((iv, i) => {
      const x = Math.max(0, Math.floor((iv.box.x0 - pad) * width)), y = Math.max(0, Math.floor((iv.box.y0 - pad * 1.2) * height));
      const w = Math.min(width - x, Math.ceil((iv.box.x1 - iv.box.x0 + pad * 2) * width)), h = Math.min(height - y, Math.ceil((iv.box.y1 - iv.box.y0 + pad * 2.4) * height));
      const r = Math.max(1, Math.min(30, Math.floor(Math.min(w, h) / 2) - 1));
      chain.push(`[${cur}]split[a${i}][b${i}];[b${i}]crop=${w}:${h}:${x}:${y},boxblur=${r}:3:${Math.floor(r / 2)}:3[c${i}];[a${i}][c${i}]overlay=${x}:${y}:enable='between(t,${iv.from.toFixed(2)},${iv.to.toFixed(2)})'[v${i}]`);
      cur = `v${i}`;
    });
    const script = path.join(workDir, 'blur.filter'); fs.writeFileSync(script, chain.join(';'));
    await run(['-y', '-i', video, '-filter_complex_script', script, '-map', `[${cur}]`, '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', outPath]);
    return true;
  };
  const report = intervals.map((iv) => ({ type: iv.type, from: +iv.from.toFixed(1), to: +iv.to.toFixed(1), by: iv.by }));
  return { report, masked, redact };
}
module.exports = { scan, regexFindings };
