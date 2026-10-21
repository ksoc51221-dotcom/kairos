// Phase 3 editor, the pure part. An edit is a list (non-destructive) stored in the video record:
//   cuts:    [{ start, end, kind }]                       ranges removed from the current video, in seconds of the current video
//   inserts: [{ at, videoId, duration, start?, end? }]    another library video spliced in at `at` (or at the end)
// "Apply" turns the list into clips, renders them in one ffmpeg run, and remaps everything that is keyed by time (words, segments, chapters,
// overlays, comments, the cursor feed) through the same clips, so nothing drifts. Nothing here touches the disk or runs a process.
const { videoArgs, audioArgs } = require('./encode');

const MIN = 0.02; // shorter than a frame at 60 fps: ignored, it cannot be seen or heard

const round = (x) => Math.round(x * 1000) / 1000;

// Clamp, sort and merge overlapping or touching cuts. Returns [{ start, end }].
function mergeCuts(cuts, duration) {
  const a = (cuts || []).map((c) => ({ start: Math.max(0, +c.start), end: Math.min(duration, +c.end) })).filter((c) => c.end - c.start >= MIN).sort((x, y) => x.start - y.start);
  const out = [];
  for (const c of a) { const l = out[out.length - 1]; if (l && c.start <= l.end + 1e-6) l.end = Math.max(l.end, c.end); else out.push({ ...c }); }
  return out;
}

// What is left once the cuts are gone: [{ start, end }]
function keptRanges(cuts, duration) {
  const kept = []; let at = 0;
  for (const c of mergeCuts(cuts, duration)) { if (c.start - at >= MIN) kept.push({ start: at, end: c.start }); at = c.end; }
  if (duration - at >= MIN) kept.push({ start: at, end: duration });
  return kept;
}

// Clips in playing order: { src: 'base', start, end } for the video itself, { src: <videoId>, start, end } for an inserted one.
// An insert whose `at` falls inside a cut goes where the cut began; one at or past the end is appended.
function buildClips({ cuts, inserts = [], duration }) {
  const kept = keptRanges(cuts, duration);
  if (!kept.length && !inserts.length) throw new Error('Nothing would be left of this video');
  const merged = mergeCuts(cuts, duration);
  const place = (at) => { const c = merged.find((m) => at > m.start && at < m.end); return c ? c.start : Math.min(Math.max(0, +at || 0), duration); };
  const ins = inserts.map((x) => ({ ...x, pos: place(x.at), s: x.start || 0, e: x.end || x.duration })).filter((x) => x.e - x.s >= MIN).sort((p, q) => p.pos - q.pos);
  const clips = []; let next = 0;
  const flush = (upTo) => { while (next < ins.length && ins[next].pos <= upTo + 1e-9) { const x = ins[next++]; clips.push({ src: x.videoId, start: x.s, end: x.e, insert: true }); } };
  for (const r of kept) {
    let a = r.start;
    for (let i = next; i < ins.length; i++) { const p = ins[i].pos; if (p > a + 1e-9 && p < r.end - 1e-9) { flush(a); clips.push({ src: 'base', start: a, end: p }); a = p; } }
    flush(a); clips.push({ src: 'base', start: a, end: r.end });
  }
  flush(Infinity);
  return clips;
}

const total = (clips) => clips.reduce((s, c) => s + (c.end - c.start), 0);

// Where each piece of the original video lands in the new one. mapRange keeps only what survives; mapPoint snaps a time that was cut out to
// the first thing after it (a comment on a removed sentence moves to where that sentence used to be).
function timeMap(clips) {
  const pieces = []; let at = 0;
  for (const c of clips) { if (c.src === 'base') pieces.push({ from: c.start, to: c.end, at }); at += c.end - c.start; }
  const mapPoint = (t) => {
    for (const p of pieces) { if (t < p.from) return p.at; if (t <= p.to) return p.at + (t - p.from); }
    return at;
  };
  const mapRange = (s, e) => {
    let start = null, end = null;
    for (const p of pieces) {
      const a = Math.max(s, p.from), b = Math.min(e, p.to);
      if (b <= a && !(s === e && s >= p.from && s <= p.to)) continue;
      if (start === null) start = p.at + (a - p.from);
      end = p.at + (b - p.from);
    }
    return start === null ? null : { start: round(start), end: round(end) };
  };
  return { mapPoint: (t) => round(mapPoint(t)), mapRange, total: at, pieces };
}

// ffmpeg arguments: every clip trimmed (decoded, so cuts are frame accurate), fitted to the base size and 60 fps, then concatenated.
// `sources` maps an inserted videoId to { file, hasAudio }. The base video is input 0.
function buildEditCommand({ video, hasAudio, size, clips, sources = {}, out, hw }) {
  const files = [video], idx = { base: 0 };
  for (const c of clips) if (c.src !== 'base' && idx[c.src] === undefined) { idx[c.src] = files.length; files.push(sources[c.src].file); }
  const audioOf = (src) => (src === 'base' ? hasAudio : !!sources[src]?.hasAudio);
  const anyAudio = clips.some((c) => audioOf(c.src));
  const f = []; const f6 = (x) => round(x);
  clips.forEach((c, i) => {
    const k = idx[c.src], d = f6(c.end - c.start);
    f.push(`[${k}:v]trim=start=${f6(c.start)}:end=${f6(c.end)},setpts=PTS-STARTPTS,scale=${size.w}:${size.h}:force_original_aspect_ratio=decrease,pad=${size.w}:${size.h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=60,format=yuv420p[v${i}]`);
    if (anyAudio) f.push(audioOf(c.src)
      ? `[${k}:a]atrim=start=${f6(c.start)}:end=${f6(c.end)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${d},asetpts=PTS-STARTPTS[a${i}]`);
  });
  f.push(clips.map((_, i) => `[v${i}]${anyAudio ? `[a${i}]` : ''}`).join('') + `concat=n=${clips.length}:v=1:a=${anyAudio ? 1 : 0}[v]${anyAudio ? '[a]' : ''}`);
  const args = ['-y', ...files.flatMap((x) => ['-i', x]), '-filter_complex', f.join(';'), '-map', '[v]', ...(anyAudio ? ['-map', '[a]'] : []),
    ...videoArgs(size.h, hw), ...(anyAudio ? audioArgs() : []), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
  return { args, total: total(clips) };
}

// Everything in a video record that is keyed by time, remapped through `clips`. Returns the patch to store plus the spans of inserted videos
// whose transcripts the caller may want to merge in ({ src, from, to, at }).
function remapRecord(v, clips) {
  const m = timeMap(clips), r = (o, s, e) => { const x = m.mapRange(o[s], o[e]); return x && { ...o, [s]: x.start, [e]: x.end }; };
  const patch = {
    duration: round(total(clips)), heat: [],
    segments: (v.segments || []).map((s) => r(s, 'start', 'end')).filter(Boolean),
    words: v.words ? v.words.map((w) => r(w, 's', 'e')).filter(Boolean) : v.words,
    chapters: (v.chapters || []).map((c) => ({ ...c, start: m.mapPoint(c.start) })),
    overlays: (v.overlays || []).map((o) => r(o, 'start', 'end')).filter(Boolean),
    comments: (v.comments || []).map((c) => ({ ...c, at: m.mapPoint(c.at) })),
    reactionEvents: (v.reactionEvents || []).map((e) => ({ ...e, at: m.mapPoint(e.at) })),
  };
  if (v.guide?.steps) patch.guide = { ...v.guide, steps: v.guide.steps.map((s) => ({ ...s, at: m.mapPoint(s.at) })) };
  let at = 0; const spans = [];
  for (const c of clips) { if (c.src !== 'base') spans.push({ src: c.src, from: c.start, to: c.end, at: round(at) }); at += c.end - c.start; }
  return { patch, spans, map: m };
}

// The recorded cursor feed and clicks are in recording time, which is video time: remap them the same way (an inserted clip has none).
function remapTimeline(tl, clips) {
  const m = timeMap(clips), inside = (t) => m.pieces.some((p) => t >= p.from && t <= p.to);
  const pt = (row) => (inside(row[0]) ? [round(m.mapPoint(row[0])), ...row.slice(1)] : null);
  return { ...tl, duration: round(total(clips)), cursor: (tl.cursor || []).map(pt).filter(Boolean), clicks: (tl.clicks || []).map(pt).filter(Boolean) };
}

// Adds the transcript of an inserted video, shifted to where it now plays.
function mergeInserted(patch, spans, loaded) {
  const segs = [...patch.segments], words = patch.words ? [...patch.words] : null;
  for (const sp of spans) {
    const src = loaded[sp.src]; if (!src) continue;
    const sh = (t) => round(t - sp.from + sp.at);
    for (const s of src.segments || []) if (s.end > sp.from && s.start < sp.to) segs.push({ ...s, start: sh(Math.max(s.start, sp.from)), end: sh(Math.min(s.end, sp.to)) });
    if (words) for (const w of src.words || []) if (w.e > sp.from && w.s < sp.to) words.push({ ...w, s: sh(Math.max(w.s, sp.from)), e: sh(Math.min(w.e, sp.to)) });
  }
  segs.sort((a, b) => a.start - b.start); if (words) words.sort((a, b) => a.s - b.s);
  return { ...patch, segments: segs, ...(words ? { words } : {}) };
}

// Words the user selected (by index, in a transcript list) -> cut ranges. Neighbouring selected words become one range.
function cutsFromWords(words, picked, kind = 'transcript') {
  const idx = [...new Set(picked)].filter((i) => words[i]).sort((a, b) => a - b), out = [];
  for (const i of idx) { const w = words[i], l = out[out.length - 1]; if (l && l.last === i - 1) { l.end = w.e; l.last = i; } else out.push({ start: w.s, end: w.e, last: i, kind }); }
  return out.map(({ start, end, kind: k }) => ({ start: round(start), end: round(end), kind: k }));
}

// The edit list as the editor sends it -> what is allowed to be stored. `lookup(videoId)` returns { duration, ready } for a library video or null.
const KINDS = new Set(['manual', 'transcript', 'filler', 'silence', 'ramble', 'split', 'prompt']); // 'prompt' = a part found from a described edit ("remove the first 10 seconds")
function sanitizeEdits(body, { id, duration, lookup }) {
  const num = (x) => (Number.isFinite(+x) ? +x : null), cuts = [], inserts = [];
  for (const c of (Array.isArray(body?.cuts) ? body.cuts : []).slice(0, 600)) {
    const s = num(c.start), e = num(c.end); if (s === null || e === null) continue;
    const start = round(Math.max(0, Math.min(s, e))), end = round(Math.min(duration || Infinity, Math.max(s, e)));
    if (end - start >= MIN) cuts.push({ start, end, kind: KINDS.has(c.kind) ? c.kind : 'manual' });
  }
  for (const x of (Array.isArray(body?.inserts) ? body.inserts : []).slice(0, 12)) {
    if (!x || typeof x.videoId !== 'string' || x.videoId === id) continue;
    const o = lookup(x.videoId); if (!o || !o.ready) continue;
    const at = num(x.at), s = Math.max(0, num(x.start) ?? 0), e = Math.min(o.duration, num(x.end) ?? o.duration);
    if (at === null || e - s < MIN) continue;
    inserts.push({ videoId: x.videoId, at: round(Math.min(Math.max(0, at), duration || at)), start: round(s), end: round(e), duration: round(o.duration) });
  }
  return { cuts, inserts };
}

module.exports = { MIN, sanitizeEdits, mergeCuts, keptRanges, buildClips, total, timeMap, buildEditCommand, remapRecord, remapTimeline, mergeInserted, cutsFromWords };
