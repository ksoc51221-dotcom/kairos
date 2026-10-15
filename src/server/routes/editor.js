// Owner-only API for the editor (Phase 3): the waveform, word timings, proposals (silence, filler words, rambles), the edit list, Apply and Undo,
// and the thumbnail and GIF preview. Nothing here is reachable by a viewer.
const fs = require('fs');
const path = require('path');
const express = require('express');
const store = require('../../store');
const { requireOwner: own } = require('../auth');
const { page } = require('../util');
const { viewModel } = require('../viewmodel');
const orchestrator = require('../../agents/orchestrator');
const editJob = require('../../agents/edit-job');
const { waveform, detectSilences, silenceCuts, findFillers } = require('../../pipeline/analyze');
const { sanitizeEdits } = require('../../pipeline/edits');
const { proposeRambles } = require('../../agents/rambles');
const { runFfmpeg } = require('../../pipeline/encode');
const { frameAt } = require('../../agents/media');

const cache = new Map(); // `${id}:${kind}` -> { key, value }: proposals are recomputed when the video file changes
const mtime = (id) => { try { return fs.statSync(path.join(store.videoDir(id), 'video.mp4')).mtimeMs; } catch { return 0; } };
async function cached(id, kind, make) {
  const key = mtime(id), c = cache.get(`${id}:${kind}`);
  if (c && c.key === key) return c.value;
  const value = await make(); cache.set(`${id}:${kind}`, { key, value }); return value;
}
const busy = (v) => !v || v.status !== 'ready' || (v.stage && v.stage !== 'done' && !/^Timing every word/.test(v.stage));

function mount(app, ctx) {
  const video = (q, res) => { const v = store.get(q.params.id); if (!v || v.type === 'image') { res.sendStatus(404); return null; } return v; };
  app.get('/edit/:id', own, page('editor.html'));

  // everything the editor needs in one request
  app.get('/api/videos/:id/editor', own, (q, res) => {
    const v = video(q, res); if (!v) return;
    res.json({ ...viewModel(v, true), words: v.words || null, wordsError: v.wordsError || null, canUndo: !!v.editPrev && fs.existsSync(path.join(store.videoDir(v.id), 'video.prev.mp4')), busy: busy(v),
      library: store.list().filter((o) => o.id !== v.id && o.type !== 'image' && o.status === 'ready' && o.shareable !== false).map((o) => ({ id: o.id, title: o.title, duration: o.duration })) });
  });
  app.get('/api/videos/:id/peaks', own, async (q, res) => {
    const v = video(q, res); if (!v) return;
    try { res.json(await cached(v.id, 'peaks', () => waveform(path.join(store.videoDir(v.id), 'video.mp4'), v.duration))); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/videos/:id/words', own, (q, res) => {
    const v = video(q, res); if (!v) return;
    if (v.words) return res.json({ ok: true, ready: true });
    res.sendStatus(202); orchestrator.timeWords(v.id).catch(() => {});
  });

  // proposals: reviewable lists, applied only when the owner accepts them
  app.post('/api/videos/:id/analyze', own, async (q, res) => {
    const v = video(q, res); if (!v) return;
    try {
      const file = path.join(store.videoDir(v.id), 'video.mp4');
      const silence = await cached(v.id, 'silence', async () => silenceCuts(await detectSilences(file, v.duration)));
      const filler = v.words ? findFillers(v.words) : null;
      res.json({ silence, filler, silenceSeconds: +silence.reduce((a, c) => a + c.end - c.start, 0).toFixed(1), fillerCount: filler ? filler.length : null, wordsReady: !!v.words });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/videos/:id/rambles', own, async (q, res) => {
    const v = video(q, res); if (!v) return;
    try { res.json({ rambles: await cached(v.id, 'rambles', () => proposeRambles({ segments: v.segments || [], duration: v.duration })) }); } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // the edit list (a draft until Apply)
  app.put('/api/videos/:id/edits', own, (q, res) => {
    const v = video(q, res); if (!v) return;
    const e = sanitizeEdits(q.body, { id: v.id, duration: v.duration, lookup: (id) => { const o = store.get(id); return o && o.type !== 'image' && o.status === 'ready' && o.shareable !== false ? { duration: o.duration, ready: true } : null; } });
    res.json(viewModel(store.update(v.id, { edits: { ...(v.edits || {}), ...e } }), true));
  });
  app.post('/api/videos/:id/edits/apply', own, (q, res) => {
    const v = video(q, res); if (!v) return;
    if (busy(v)) return res.status(409).json({ error: 'This video is still being processed. Try again in a moment.' });
    const e = v.edits || {}; if (!(e.cuts || []).length && !(e.inserts || []).length) return res.status(400).json({ error: 'Nothing to apply' });
    store.update(v.id, { stage: 'Applying edits 0%' }); res.sendStatus(202);
    orchestrator.applyEdits(v.id).catch((err) => store.update(v.id, { stage: 'done', editError: String(err.message || err).slice(0, 200) }));
  });
  app.post('/api/videos/:id/edits/undo', own, (q, res) => {
    const v = video(q, res); if (!v) return;
    if (busy(v)) return res.status(409).json({ error: 'Wait for the current job to finish' });
    if (!editJob.undoEdits(v.id)) return res.status(404).json({ error: 'Nothing to undo' });
    cache.clear(); res.json(viewModel(store.get(v.id), true));
  });

  // thumbnail (a frame, or an uploaded picture) and the 3 s GIF preview
  app.post('/api/videos/:id/thumbnail', own, async (q, res) => {
    const v = video(q, res); if (!v) return;
    const at = Math.min(Math.max(0, +q.body.at || 0), Math.max(0, v.duration - 0.1));
    try { await frameAt(path.join(store.videoDir(v.id), 'video.mp4'), at, path.join(store.videoDir(v.id), 'thumb-custom.jpg'), 480); store.update(v.id, { thumbAt: at }); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/videos/:id/thumbnail', own, express.raw({ type: 'image/*', limit: '8mb' }), async (q, res) => {
    const v = video(q, res); if (!v) return;
    if (!Buffer.isBuffer(q.body) || !q.body.length) return res.status(400).json({ error: 'Send an image' });
    const dir = store.videoDir(v.id), tmp = path.join(dir, 'thumb-upload.bin');
    try { fs.writeFileSync(tmp, q.body); await runFfmpeg(['-y', '-i', tmp, '-vf', 'scale=480:-2', '-frames:v', '1', '-q:v', '3', path.join(dir, 'thumb-custom.jpg')]); res.json({ ok: true }); }
    catch { res.status(400).json({ error: 'That file is not a picture ffmpeg can read' }); } finally { fs.rmSync(tmp, { force: true }); }
  });
  app.delete('/api/videos/:id/thumbnail', own, (q, res) => { const v = video(q, res); if (!v) return; fs.rmSync(path.join(store.videoDir(v.id), 'thumb-custom.jpg'), { force: true }); store.update(v.id, { thumbAt: null }); res.sendStatus(204); });
  app.post('/api/videos/:id/gif', own, async (q, res) => {
    const v = video(q, res); if (!v) return;
    const at = Math.min(Math.max(0, +q.body.at || 0), Math.max(0, v.duration - 3)), dir = store.videoDir(v.id);
    try {
      await runFfmpeg(['-y', '-ss', String(at), '-t', '3', '-i', path.join(dir, 'video.mp4'), '-vf', 'fps=12,scale=480:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', '-loop', '0', path.join(dir, 'preview.gif')]);
      store.update(v.id, { gifAt: at }); res.json({ ok: true, at });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { mount };
