// Bleep speech, the part that touches disk (the interpreter that proposes the ranges is redact-intent.js). One ffmpeg run: the picture is copied, only the
// audio is re-encoded, so it takes a fraction of a second per minute of video. Then everything that could still hold the words is dealt with:
//   - the transcript, the word timings and the captions say [bleep] where the audio now does (translated captions are dropped, they are rebuilt on demand);
//   - the AI notes (summary, chapters, tasks, guide, title) have the bleeped words scrubbed at once, and can be rewritten from the bleeped transcript;
//   - a public copy is taken down, because it still has the old audio;
//   - the old video and transcript are kept as the one-level undo (the same slot as an edit) until the owner deletes them.
// Pure functions are exported so the rules can be tested without a video.
const fs = require('fs');
const path = require('path');
const store = require('../store');
const { probe } = require('./media');
const { hasAudioStream } = require('../pipeline/encode');
const { bleepAudio, mergeIntervals, BLEEP } = require('./speech-guard');

const norm = (w) => String(w ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const edge = (w) => String(w ?? '').trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
// Words too common to scrub out of the AI notes (they would turn every sentence into [bleep]); the bleeped audio and transcript do not depend on this.
const COMMON = new Set(('that with have this from they been were will would there their what about which when your said them then than into just like some could other more also only over such very here because going want know think ' +
  'right well really actually look make take come need thing things something anything everything someone anyone people person video recording screen click okay yeah sure first second third next last after before again still ' +
  'where while these those should shall might must does done doing being having each every many much most both either neither maybe perhaps quite rather around through between during without within upon under against ' +
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million').split(/\s+/));
// A word worth scrubbing from the notes: a longer word that is not everyday English, anything with digits or symbols in it (a password, an address).
const distinctive = (raw) => { const n = norm(raw); return (n.length >= 4 && !COMMON.has(n)) || (/\d/.test(raw) && n.length >= 3) || (/[@_/\\-]/.test(raw) && n.length >= 4); };
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const collapse = (t) => t.replace(/\[bleep\](?:[\s,;.]*\[bleep\])+/g, BLEEP);

// Replaces every bleeped word in a string, an array or a plain object (depth-limited) with [bleep]. Returns a function; with nothing to scrub it is the identity.
function scrubber(tokens) {
  const list = [...tokens].filter(Boolean).sort((a, b) => b.length - a.length).map(esc);
  if (!list.length) return (x) => x;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.join('|')})(?:'s|s|es)?(?![\\p{L}\\p{N}])`, 'giu');
  const walk = (v, d) => {
    if (typeof v === 'string') return collapse(v.replace(re, BLEEP));
    if (d > 6) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, d + 1));
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k], d + 1); return o; }
    return v;
  };
  return (x) => walk(x, 0);
}

// Same word, allowing a plural or possessive ("Marta" / "Marta's"); short words must match exactly.
const eq = (a, b) => !!a && !!b && (a === b || (a.length >= 4 && b.length >= 4 && (a + 's' === b || b + 's' === a || a + 'es' === b || b + 'es' === a)));

// segments: [{start,end,text}], words: [{w,s,e}] or null, intervals: [{from,to}]. A word counts as bleeped when most of it is under the bleep.
// The word pass has exact times; a caption has none, so each caption word is lined up with the word pass and decided by that word's time. A caption word
// that cannot be lined up is decided by its estimated place in the caption, or because it is the same word as one that was bleeped nearby. Where the
// two disagree the bias is to bleep too much: a caption that loses a neighbouring word is better than one that keeps the secret.
function redactTranscript({ segments, words, intervals }) {
  const tokens = new Set(); // what was bleeped, as written (lower-cased, punctuation trimmed): used to scrub the notes
  const under = (s, e) => intervals.some((x) => Math.min(e, x.to) - Math.max(s, x.from) >= 0.4 * Math.max(0.05, e - s));
  const hits = []; // the bleeped words of the word pass: { s, e, t }
  const newWords = Array.isArray(words) ? words.map((w) => {
    if (!w || w.w === BLEEP || !under(+w.s, +w.e)) return w;
    const t = norm(w.w); if (t) hits.push({ s: +w.s, e: +w.e, t });
    if (distinctive(edge(w.w))) tokens.add(edge(w.w));
    return { ...w, w: BLEEP };
  }) : words;
  const compounds = new Set(); // "hunter" + "2" in the word pass is "hunter2" in the captions
  for (let i = 0; i < hits.length; i++) { let c = hits[i].t; for (let k = i + 1; k < Math.min(hits.length, i + 3) && hits[k].s - hits[k - 1].e <= 0.6; k++) { c += hits[k].t; compounds.add(c); } }
  const segs = Array.isArray(segments) ? segments : [];
  const touches = (seg) => intervals.some((x) => seg.end > x.from - 0.5 && seg.start < x.to + 0.5);
  const near = (h, seg) => h.e > seg.start - 0.5 && h.s < seg.end + 0.5;
  const newSegments = segs.map((seg) => {
    if (!touches(seg)) return seg;
    const raw = String(seg.text || '').split(/\s+/).filter(Boolean), n = raw.length, step = (seg.end - seg.start) / Math.max(1, n);
    const inside = Array.isArray(words) ? words.filter((w) => w && +w.e > seg.start - 0.05 && +w.s < seg.end + 0.05) : [];
    const aligned = new Array(n).fill(null);
    if (inside.length === n) inside.forEach((w, i) => { aligned[i] = w; }); // the usual case: both passes heard the same words
    else { let j = 0; raw.forEach((cw, i) => { for (let k = j; k < Math.min(inside.length, j + 4); k++) if (eq(norm(inside[k].w), norm(cw))) { aligned[i] = inside[k]; j = k + 1; break; } }); }
    const mark = raw.map((cw, i) => {
      const t = norm(cw), a = aligned[i];
      if (cw === BLEEP) return true;
      if (a) return a.w === BLEEP || under(+a.s, +a.e) || (distinctive(edge(cw)) && (tokens.has(edge(cw)) || hits.some((h) => near(h, seg) && eq(h.t, t))));
      return under(seg.start + i * step, seg.start + (i + 1) * step) || compounds.has(t) || hits.some((h) => near(h, seg) && eq(h.t, t));
    });
    for (let i = 0; i < n; i++) for (let len = 2; len <= 3 && i + len <= n; len++) { // "hunter 2" in the caption where the word pass heard "hunter2"
      const c = raw.slice(i, i + len).map(norm).join('');
      if (c && hits.some((h) => near(h, seg) && h.t === c)) for (let k = i; k < i + len; k++) mark[k] = true;
    }
    const out = [];
    raw.forEach((cw, i) => {
      if (!mark[i]) { out.push(cw); return; }
      if (cw !== BLEEP) { const e = edge(cw); if (distinctive(e)) tokens.add(e); }
      if (out[out.length - 1] !== BLEEP) out.push(BLEEP);
    });
    return { ...seg, text: out.join(' ') };
  });
  return { segments: newSegments, words: newWords, transcript: newSegments.map((s) => s.text).join(' '), tokens };
}

// Rebuilds the notes and the time-keyed record for a finished bleep. Pure (no disk, no store): { patch, snapshot }.
function redactRecord(v, intervals) {
  const R = redactTranscript({ segments: v.segments, words: v.words, intervals });
  const scrub = scrubber(R.tokens);
  const patch = {
    transcript: R.transcript, segments: R.segments, ...(R.words ? { words: R.words } : {}),
    speechRedactions: [...(v.speechRedactions || []), ...intervals.map((iv) => ({ from: +iv.from.toFixed(2), to: +iv.to.toFixed(2), type: 'requested' }))],
  };
  for (const k of ['summary', 'chapters', 'tasks', 'guide', 'plan', 'title', 'crew']) if (v[k] !== undefined && v[k] !== null) patch[k] = scrub(v[k]);
  const snapshot = {}; for (const k of Object.keys(patch)) snapshot[k] = v[k]; // exactly what Undo must put back
  return { patch, snapshot, scrubbed: R.tokens.size };
}

// A public copy still has the old audio, so it is taken down (a publish that is still uploading is stopped first, which can bring back an older link, so
// it is checked again). The owner publishes again when they are happy with the result. Returns what the owner should be told.
// Nothing under agents/ may import the publisher (a test enforces it, so that Stop can never reach a cloud service): src/server/server.js, which already
// loads it, hands over its unpublish here before any job can run. Without it a live link would survive the bleep, so the job stops before touching anything.
const deps = { unpublish: null };
async function takeDownPublicCopy(id) {
  const live = (x) => x && (x.state === 'live' || x.state === 'working');
  if (!live(store.get(id)?.publish)) return null;
  if (!deps.unpublish) throw new Error('the public link could not be taken down, so nothing was bleeped. Try again.');
  let last = null;
  for (let i = 0; i < 3 && live(store.get(id)?.publish); i++) last = await deps.unpublish(id, { reason: 'The audio was bleeped. Publish again to share the new version.' });
  const stillThere = last && last.removal === 'queued';
  return { removed: true, ...(stillThere ? { pending: true, error: last.removalError ? String(last.removalError).slice(0, 160) : undefined } : {}) };
}

// The queued job. The request ({ranges, rewriteNotes}) is on the video record, written by the route.
async function applyRedaction(job) {
  const id = job.videoId, v0 = store.get(id); if (!v0) return null;
  const req = v0.redactRequest;
  if (!req || !Array.isArray(req.ranges) || !req.ranges.length) { store.update(id, { stage: 'done', redactRequest: null }); return null; }
  const dir = store.videoDir(id), video = path.join(dir, 'video.mp4'), out = path.join(dir, 'video.redact.mp4');
  try {
    if (!fs.existsSync(video)) throw new Error('this video has no file to bleep');
    if (!hasAudioStream(video)) throw new Error('this video has no audio to bleep');
    const meta = await probe(video), duration = meta.duration || v0.duration;
    const intervals = mergeIntervals(req.ranges.map((r) => ({ from: Math.max(0, +r.from), to: Math.min(duration, +r.to), type: 'requested' })).filter((r) => r.to > r.from));
    if (!intervals.length) throw new Error('there is nothing to bleep in those ranges');

    store.update(id, { stage: 'Bleeping speech' });
    await bleepAudio(video, out, intervals, duration);
    const after = await probe(out);
    if (!(after.duration > 0) || Math.abs(after.duration - duration) > 0.6) throw new Error('the bleeped file came out a different length, so nothing was changed');

    // Only now, with a good bleeped file on disk, does the public link come down (so a failed bleep never takes a link down for nothing).
    const publicCopy = await takeDownPublicCopy(id);

    // The swap and the record are one synchronous stretch. The old file stays as the undo; the older undo and its timeline copy are replaced.
    const prev = path.join(dir, 'video.prev.mp4'); fs.rmSync(prev, { force: true });
    fs.rmSync(path.join(dir, 'timeline.prev.json'), { force: true });
    fs.renameSync(video, prev); fs.renameSync(out, video);
    for (const f of fs.readdirSync(dir)) if (/^captions_[\w-]+\.json$/.test(f)) fs.rmSync(path.join(dir, f), { force: true }); // translated captions of the old words
    fs.rmSync(path.join(dir, 'action-plan.md'), { force: true }); // quotes the old transcript; the queue writes a new one when this video is for an agent

    const v = store.get(id) || v0, { patch, snapshot } = redactRecord(v, intervals);
    // The notes are rewritten from the bleeped transcript by a second job (the orchestrator queues it); the stage says so, so nothing else starts in between.
    // A video the Privacy Guard has not cleared is not rewritten: that re-run would transcribe the whole video again.
    const rewrite = req.rewriteNotes !== false && v.shareable === true;
    store.update(id, {
      ...patch, redactRequest: null, editError: null, stage: rewrite ? 'Re-running AI crew' : 'done',
      editPrev: { ...snapshot, kind: 'redact', count: intervals.length, edits: v.edits, at: Date.now(), hadTimeline: false },
      redactResult: { at: Date.now(), parts: intervals.length, ...(publicCopy ? { publicCopy } : {}) }, // what to tell the owner; never the words
    });
    store.log(id, `Speech bleeped: ${intervals.length} ${intervals.length === 1 ? 'part' : 'parts'}`, 'owner');
    store.save(); store.save(); // each write refreshes db.json.bak, so the second one leaves no old transcript in the backup
    return { parts: intervals.length, rewrite };
  } catch (e) {
    fs.rmSync(out, { force: true });
    store.update(id, { stage: 'done', redactRequest: null, editError: `Could not bleep the speech: ${String(e.message || e).slice(0, 160)}` });
    throw e;
  }
}

// "Delete the unbleeped copy": the old file, its timeline and the old transcript in the undo slot go; Undo is no longer possible.
function finalizeRedaction(id) {
  const v = store.get(id); if (!v || !v.editPrev || v.editPrev.kind !== 'redact') return false;
  const dir = store.videoDir(id);
  for (const f of ['video.prev.mp4', 'timeline.prev.json']) fs.rmSync(path.join(dir, f), { force: true });
  store.update(id, { editPrev: null });
  store.log(id, 'Unbleeped copy deleted', 'owner');
  store.save(); store.save();
  return true;
}

module.exports = { applyRedaction, finalizeRedaction, takeDownPublicCopy, redactTranscript, redactRecord, scrubber, distinctive, COMMON, deps };
