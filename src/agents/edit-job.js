// Phase 3 editor, the part that touches disk: apply an edit list (one ffmpeg run, one lossy encode), undo it, and time every word of an existing video.
// The queue runs these one at a time with everything else (B4), so an edit never competes with a recording's pipeline for the encoder.
const fs = require('fs');
const path = require('path');
const store = require('../store');
const { probe, frameAt } = require('./media');
const { runFfmpeg, hasAudioStream } = require('../pipeline/encode');
const { buildClips, buildEditCommand, remapRecord, remapTimeline, mergeInserted } = require('../pipeline/edits');
const { readTimeline, writeTimeline, timelinePath } = require('../pipeline/segments');
const transcribeModel = require('./transcribe');

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const TIME_KEYED = ['duration', 'segments', 'words', 'chapters', 'overlays', 'comments', 'reactionEvents', 'heat', 'guide', 'width', 'height', 'transcript'];

// edit list -> new video.mp4. The previous file and the previous time-keyed fields are kept for one level of undo (video.prev.mp4, `editPrev`).
async function applyEdits(job, { dataDir } = {}) {
  const id = job.videoId, v = store.get(id); if (!v) return;
  const dir = store.videoDir(id), video = path.join(dir, 'video.mp4'), out = path.join(dir, 'video.edit.mp4');
  const edits = v.edits || {};
  if (!fs.existsSync(video)) throw new Error('this video has no file to edit');
  const meta = await probe(video), duration = meta.duration || v.duration;
  const inserts = (edits.inserts || []).map((x) => { const o = store.get(x.videoId); return o ? { ...x, duration: x.duration || o.duration } : null; }).filter(Boolean);
  const clips = buildClips({ cuts: edits.cuts || [], inserts, duration });
  const sources = {}; for (const x of inserts) { const f = path.join(store.videoDir(x.videoId), 'video.mp4'); sources[x.videoId] = { file: f, hasAudio: hasAudioStream(f) }; }
  const plan = buildEditCommand({ video, hasAudio: hasAudioStream(video), size: { w: even(meta.width), h: even(meta.height) }, clips, sources, out });
  let last = 0;
  store.update(id, { stage: 'Applying edits 0%' });
  try {
    await runFfmpeg(plan.args, { duration: plan.total, onProgress: (p) => { const now = Date.now(); if (now - last > 500) { last = now; store.update(id, { stage: `Applying edits ${Math.round(p * 100)}%` }); } } });
  } catch (e) { fs.rmSync(out, { force: true }); store.update(id, { stage: 'done' }); throw e; }

  // the new file is in place only once it exists in full; the old one stays as the undo
  const prev = path.join(dir, 'video.prev.mp4'); fs.rmSync(prev, { force: true });
  fs.renameSync(video, prev); fs.renameSync(out, video);
  const tlFile = timelinePath(dir), tlPrev = path.join(dir, 'timeline.prev.json'); fs.rmSync(tlPrev, { force: true });
  if (fs.existsSync(tlFile)) { try { const tl = readTimeline(dir); fs.copyFileSync(tlFile, tlPrev); writeTimeline(dir, remapTimeline(tl, clips)); } catch {} }

  const { patch, spans } = remapRecord(v, clips);
  const loaded = {}; for (const sp of spans) { const o = store.get(sp.src); if (o) loaded[sp.src] = { segments: o.segments, words: o.words }; }
  const merged = mergeInserted(patch, spans, loaded);
  const snapshot = {}; for (const k of TIME_KEYED) snapshot[k] = v[k];
  store.update(id, {
    ...merged, transcript: merged.segments.map((s) => s.text).join(' '), width: even(meta.width), height: even(meta.height),
    editPrev: { ...snapshot, edits, at: Date.now(), hadTimeline: fs.existsSync(tlPrev) },
    edits: { cuts: [], inserts: [], appliedAt: Date.now(), applied: (edits.applied || 0) + 1 }, stage: 'done', status: 'ready',
  });
  store.log(id, `Edits applied: ${(edits.cuts || []).length} cut${(edits.cuts || []).length === 1 ? '' : 's'}, ${inserts.length} insert${inserts.length === 1 ? '' : 's'}`, 'owner');
  if (!fs.existsSync(path.join(dir, 'thumb-custom.jpg'))) await frameAt(video, Math.min(1, Math.max(0, plan.total - 0.5)), path.join(dir, 'thumb.jpg'), 480).catch(() => {});
  return { total: plan.total, clips: clips.length };
}

// One level of undo: the file and the time-keyed fields go back to what they were before the last Apply.
function undoEdits(id) {
  const v = store.get(id); if (!v || !v.editPrev) return false;
  const dir = store.videoDir(id), video = path.join(dir, 'video.mp4'), prev = path.join(dir, 'video.prev.mp4');
  if (!fs.existsSync(prev)) return false;
  fs.rmSync(video, { force: true }); fs.renameSync(prev, video);
  const tlPrev = path.join(dir, 'timeline.prev.json'); if (fs.existsSync(tlPrev)) fs.renameSync(tlPrev, timelinePath(dir));
  // `kind` and `count` describe a bleep (src/agents/redact-job.js), which shares this undo slot. A bleep does not move anything in time, so the cuts the owner
  // is drafting stay as they are; an edit's undo clears them because they were written for the video that is going away.
  const { at, hadTimeline, edits, kind, count, ...fields } = v.editPrev;
  store.update(id, { ...fields, ...(kind === 'redact' ? {} : { edits: { cuts: [], inserts: [], undone: Date.now() } }), editPrev: null, redactResult: null, stage: 'done' });
  store.log(id, kind === 'redact' ? 'Bleep undone' : 'Edits undone', 'owner');
  return true;
}

// Word-level timestamps for a video that was transcribed before they existed (or whose words were lost). Segments are kept as they are.
async function wordsJob(job, { dataDir, onStatus = () => {} } = {}) {
  const id = job.videoId, v = store.get(id); if (!v) return;
  const dir = store.videoDir(id), video = path.join(dir, 'video.mp4'), work = path.join(dir, 'work-words');
  if (!fs.existsSync(video) || !hasAudioStream(video)) { store.update(id, { wordsError: 'no audio to transcribe' }); return; }
  fs.mkdirSync(work, { recursive: true });
  try {
    store.update(id, { stage: 'Timing every word', wordsError: null });
    const r = await transcribeModel.transcribe(video, work, path.join(dataDir, 'models'), (s) => store.update(id, { stage: `Timing every word: ${s}` }), null, { words: true });
    store.update(id, { words: r.words || [], ...(v.segments?.length ? {} : { segments: r.segments, transcript: r.text }), stage: 'done' });
  } catch (e) { store.update(id, { stage: 'done', wordsError: String(e.message || e).slice(0, 160) }); throw e; }
  finally { fs.rmSync(work, { recursive: true, force: true }); }
}

module.exports = { applyEdits, undoEdits, wordsJob, TIME_KEYED };
