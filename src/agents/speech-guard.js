// Privacy Guard, the listening half (R6). The screen is read with OCR; this reads what was SAID. It runs the same secret rules (plus spoken-secret
// phrasing: "the password is ...", "my pin is four two ...", long digit runs) over the transcript, then
//   1. bleeps those words in the audio of video.mp4 (video stream copied, only the audio is re-encoded),
//   2. replaces them with "[bleep]" in the transcript, the word timings and the captions, before anything is published.
// Pure functions where possible so the rules can be unit-tested without a video.
const { PATTERNS } = require('./privacy');
const { runFfmpeg, audioArgs } = require('../pipeline/encode');

const BLEEP = '[bleep]';
const clean = (w) => String(w).toLowerCase().replace(/[^a-z0-9]/g, '');
const endsSentence = (w) => /[.,!?;]$/.test(String(w).trim());

const LINK = new Set(['is', 'was', 'are', 'equals', 'equal', 'be', 'it', 'its', 'to', 'as', 'of', 'set', 'my', 'the', 'your', 'our']);
const IS_LINK = new Set(['is', 'was', 'are', 'equals', 'equal', 'be', 'to', 'as']); // a real "is" between trigger and secret (or a ':' / '=')
const STOP = new Set(['and', 'then', 'but', 'so', 'ok', 'okay', 'now', 'next', 'because', 'or', 'which', 'that', 'when', 'if', 'you', 'we', 'i']);
const TRIG1 = new Set(['password', 'passwords', 'passcode', 'passphrase', 'pin', 'secret', 'token', 'credential', 'credentials', 'pwd']);
// Whisper often splits or mishears the trigger ("past word is test 123", heard in a real recording on 2026-10-16), so the two-word
// forms and any single word one letter away from "password" count too.
const near = (a, b) => { // edit distance <= 1
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
};
const isTrig1 = (c) => TRIG1.has(c) || (c.length >= 7 && near(c, 'password'));
const TRIG2 = [['pass', 'word'], ['past', 'word'], ['pass', 'words'], ['pass', 'code'], ['pass', 'phrase'], ['pin', 'code'], ['pin', 'number'], ['api', 'key'], ['access', 'key'], ['secret', 'key'], ['private', 'key'], ['auth', 'token'], ['social', 'security'], ['credit', 'card'], ['card', 'number'], ['account', 'number'], ['routing', 'number'], ['security', 'code'], ['login', 'code'], ['verification', 'code']];
const DIGIT_WORDS = new Set(['zero', 'oh', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']);
const digitCount = (w) => { const c = clean(w); if (DIGIT_WORDS.has(c)) return 1; return /^\d+$/.test(c) ? c.length : 0; };
const MIN_DIGITS = 9; // an SSN is 9, a phone number 10, a card 13+

// words: [{ w, s, e }] (the shape Whisper's word pass produces). Returns merged hits [{ type, i0, i1, from, to, phrase }].
function findSpokenSecrets(words, { pad = [0.05, 0.12] } = {}) {
  const hits = [];
  const add = (type, i0, i1) => { if (i0 <= i1 && i1 < words.length) hits.push({ type, i0, i1 }); };

  // 1) "the password is hunter2", "my api key is sk-...", "pin 4 2 1 9"
  for (let i = 0; i < words.length; i++) {
    let end = -1;
    if (i + 1 < words.length && TRIG2.some(([a, b]) => clean(words[i].w) === a && clean(words[i + 1].w) === b)) end = i + 1; // before TRIG1: "pin code" must skip "code"
    else if (isTrig1(clean(words[i].w))) end = i;
    if (end < 0) continue;
    let j = end + 1, sawIs = /[:=]$/.test(words[end].w.trim());
    while (j < words.length && j <= end + 3 && LINK.has(clean(words[j].w))) { if (IS_LINK.has(clean(words[j].w))) sawIs = true; j++; }
    if (j >= words.length) continue;
    if (!sawIs && !digitCount(words[j].w)) continue; // "the password reset page" is not a secret; "pin 4 2 1 9" is
    if (STOP.has(clean(words[j].w)) && !digitCount(words[j].w)) continue;
    let k = j;
    if (digitCount(words[j].w)) { while (k + 1 < words.length && digitCount(words[k + 1].w)) k++; } // "4 2 1 9"
    else if (/[0-9_\-/@]/.test(words[j].w)) k = j; // one token-like word ("hunter2", "sk-live-...")
    else while (k + 1 < words.length && k - j < 2 && !endsSentence(words[k].w) && !STOP.has(clean(words[k + 1].w))) k++; // a spoken passphrase
    add('spoken secret', j, k);
  }

  // 2) a long run of digits, spoken as numerals or number words
  for (let i = 0; i < words.length;) {
    if (!digitCount(words[i].w)) { i++; continue; }
    let j = i, total = 0;
    while (j < words.length && digitCount(words[j].w)) { total += digitCount(words[j].w); j++; }
    if (total >= MIN_DIGITS) add('number', i, j - 1);
    i = j;
  }

  // 3) the same patterns as on screen (e-mail, keys, tokens, card, SSN, phone, "password: x", long secrets) over the joined text
  let text = '', spans = [];
  words.forEach((w) => { spans.push([text.length, text.length + w.w.length]); text += w.w + ' '; });
  for (const p of PATTERNS) for (const m of text.matchAll(p.re)) {
    const value = p.group ? m[p.group] : m[0]; if (!value || (p.check && !p.check(value))) continue;
    const a = m.index + (p.group ? m[0].indexOf(value) : 0), b = a + value.length;
    const idx = spans.map((s, i) => (s[1] > a && s[0] < b ? i : -1)).filter((i) => i >= 0);
    if (idx.length) add(p.type, idx[0], idx[idx.length - 1]);
  }

  // merge overlapping or touching word ranges, then give them times
  hits.sort((a, b) => a.i0 - b.i0);
  const merged = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.i0 <= last.i1 + 1) { last.i1 = Math.max(last.i1, h.i1); } else merged.push({ ...h });
  }
  return merged.map((h) => ({ ...h, from: Math.max(0, words[h.i0].s - pad[0]), to: words[h.i1].e + pad[1], phrase: words.slice(h.i0, h.i1 + 1).map((w) => w.w).join(' ').replace(/[.,!?;:]+$/, '') }));
}

// Segments have no word times; spread each segment's words evenly over its duration, which is good enough to find the secret and bleep around it.
function wordsFromSegments(segments) {
  const out = [];
  for (const s of segments || []) {
    const ws = String(s.text || '').split(/\s+/).filter(Boolean), step = (s.end - s.start) / Math.max(1, ws.length);
    ws.forEach((w, i) => out.push({ w, s: s.start + i * step, e: s.start + (i + 1) * step, seg: s }));
  }
  return out;
}

// transcript = { text, segments: [{start,end,text}], words?: [{w,s,e}] }. Returns the cleaned transcript and the time intervals to bleep.
function guardTranscript({ text = '', segments = [], words = null }) {
  const wordHits = words && words.length ? findSpokenSecrets(words) : [];
  const segWords = wordsFromSegments(segments), segHits = findSpokenSecrets(segWords);
  const intervals = mergeIntervals([...wordHits, ...segHits].map((h) => ({ from: h.from, to: h.to, type: h.type })));
  if (!intervals.length) return { text, segments, words, intervals: [], count: 0 };

  // captions: replace each segment's own hits in place; a word-pass hit the segment text did not show is covered by blanking the whole segment
  const newSegments = segments.map((s) => {
    const own = segHits.filter((h) => segWords[h.i0].seg === s);
    let t = s.text;
    for (const h of own.sort((a, b) => b.phrase.length - a.phrase.length)) t = t.split(h.phrase).join(BLEEP);
    // The two Whisper passes do not always hear the same words, and the caption pass only has interpolated times. So count instead of comparing times:
    // if the word pass found more secrets inside this caption than the caption text itself shows, the caption cannot be trusted and is blanked.
    const inside = wordHits.filter((wh) => (wh.from + wh.to) / 2 >= s.start && (wh.from + wh.to) / 2 <= s.end).length;
    const missed = inside > own.length;
    return { ...s, text: missed ? BLEEP : t };
  });
  const newWords = words ? words.map((w) => (intervals.some((iv) => (w.s + w.e) / 2 >= iv.from && (w.s + w.e) / 2 <= iv.to) ? { ...w, w: BLEEP } : w)) : words;
  const newText = newSegments.map((s) => s.text).join(' ');
  return { text: newText, segments: newSegments, words: newWords, intervals, count: intervals.length };
}

function mergeIntervals(list) {
  const sorted = list.map((x) => ({ ...x })).sort((a, b) => a.from - b.from), out = [];
  for (const iv of sorted) { const last = out[out.length - 1]; if (last && iv.from <= last.to + 0.15) { last.to = Math.max(last.to, iv.to); } else out.push(iv); }
  return out;
}

// The ffmpeg audio filter for a list of intervals: the original audio goes silent there and a quiet 1 kHz tone plays instead.
const gate = (intervals) => intervals.map((iv) => `between(t,${iv.from.toFixed(3)},${iv.to.toFixed(3)})`).join('+');
function bleepFilter(intervals, duration) {
  const g = gate(intervals);
  return `[0:a]volume=0:enable='${g}'[m];aevalsrc='0.2*sin(2*PI*1000*t)*(${g})':s=48000:d=${(duration + 1).toFixed(2)}[b];[m]aresample=48000[m2];[m2][b]amix=inputs=2:duration=first:normalize=0[a]`;
}

// Writes `out` = `video` with those intervals bleeped. The picture is copied, so this takes a fraction of a second per minute of video.
async function bleepAudio(video, out, intervals, duration) {
  if (!intervals.length) return false;
  await runFfmpeg(['-y', '-i', video, '-filter_complex', bleepFilter(intervals, duration), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', ...audioArgs(), '-movflags', '+faststart', out], { duration });
  return true;
}

module.exports = { findSpokenSecrets, guardTranscript, bleepFilter, bleepAudio, mergeIntervals, wordsFromSegments, BLEEP };
