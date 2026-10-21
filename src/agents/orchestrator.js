// Orchestrator: runs the crew in order, isolates failures, and writes live status into the video record
// so the watch page can show what every agent is doing.
const fs = require('fs');
const path = require('path');
const store = require('../store');
const llm = require('./llm');
const { probe, frameAt } = require('./media');
const { readManifest, segmentInputs, timelinePath } = require('../pipeline/segments');
const { buildComposite } = require('../pipeline/composite');
const { runFfmpeg, transcodeUpload, hasAudioStream } = require('../pipeline/encode');
const { ensureMask, ensureFrame } = require('../pipeline/masks');
const transcribeModel = require('./transcribe');
const { transcribe } = transcribeModel;
const queue = require('./queue');
const ocr = require('./ocr');
const privacy = require('./privacy');
const { insights } = require('./insights');
const { makeGuide, plan } = require('./guide');
const editJob = require('./edit-job');
const speechGuard = require('./speech-guard');

let dataDir, say = (...a) => console.log(...a), busy = () => false;
// Loading a 5 GB model competes with screen capture for memory and the GPU (measured: it costs frames), so the model is only warmed when no
// recording is running: shortly after the app starts, and again after each finished job. Until it is resident the Privacy Guard runs on its
// rules alone (see privacy.js) and asks for the model to be loaded for next time.
const WARM_DELAY_MS = 45_000;
function warmWhenIdle(delay = WARM_DELAY_MS) { const t = setTimeout(() => { if (busy()) warmWhenIdle(30_000); else llm.warm(); }, delay); t.unref?.(); }
// Called once at startup, after the store is open: resumes jobs a quit left behind, and compiles the Vision OCR tool in the background.
function init(dir, { log, isBusy } = {}) {
  dataDir = dir; if (log) say = log; if (isBusy) busy = isBusy;
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  ocr.ensureVision(path.join(dir, 'models'));
  warmWhenIdle();
  const r = queue.start(processJobs, { log: say });
  if (r.requeued.length || r.failed.length) say('jobs: resumed', r.requeued, 'gave up on', r.failed);
  return r;
}
// B4: one job at a time. `process` = the whole pipeline for a new video; `ai` = re-run the notes (and the Privacy Guard if the video was never cleared).
// `edit` and `words` are the editor's jobs (Phase 3): apply an edit list, and time every word of a video that has none.
async function processJobs(job) {
  const run = { ai: rerunJob, process: processJob, still: stillJob, edit: (j) => editJob.applyEdits(j, { dataDir }), words: (j) => editJob.wordsJob(j, { dataDir }) }[job.kind] || processJob;
  try { return await run(job); } finally { if (!['edit', 'words', 'still'].includes(job.kind)) { cleanLeftovers(job.videoId); writeAgentPlan(job.videoId); } warmWhenIdle(2000); }
}
// "Record for agent": once the guard has cleared the video, the Action Plan brief is written next to it as action-plan.md (the same text the MCP server
// and the watch page's "Copy action plan" hand out), so a coding agent can be pointed at one file.
function writeAgentPlan(id) {
  const v = store.get(id); if (!v || !v.forAgent || v.shareable !== true) return;
  try {
    const dir = store.videoDir(id); let timeline = null;
    try { timeline = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8')); } catch {}
    fs.writeFileSync(path.join(dir, 'action-plan.md'), require('./action-plan').buildActionPlan(v, { dir, timeline }));
  } catch (e) { console.error('action plan', e); }
}
// R11: sample frames (the user's screen), half-written blur and bleep files must not outlive the job, whether it finished or threw.
function cleanLeftovers(id) {
  if (!id || !store.get(id)) return;
  const dir = store.videoDir(id);
  for (const f of ['work', 'video.blur.mp4', 'video.mute.mp4']) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
}
const processVideo = (id) => queue.enqueue(id, 'process');
const rerunAI = (id) => queue.enqueue(id, 'ai');
const guardStill = (id) => queue.enqueue(id, 'still');
const applyEdits = (id) => queue.enqueue(id, 'edit');
const timeWords = (id) => queue.enqueue(id, 'words');

const CREW = [
  { id: 'transcriber', name: 'Transcriber', role: 'Local Whisper turns speech into a timestamped transcript' },
  { id: 'privacy', name: 'Privacy Guard', role: 'Reads the screen (OCR), finds secrets and personal data, blurs them' },
  { id: 'planner', name: 'Planner', role: 'Decides what document this recording should become' },
  { id: 'insights', name: 'Insights', role: 'Writes the title, summary, chapters and action items' },
  { id: 'writer', name: 'Guide Writer', role: 'Drafts a step-by-step guide with screenshots' },
  { id: 'critic', name: 'Guide Critic', role: 'Fact-checks the draft against the video and sends it back if needed' },
];

function makeLog(id) {
  const t0 = {};
  return (agent, status, detail = '') => {
    const v = store.get(id); if (!v) return;
    const crew = v.crew.map((c) => (c.id === agent ? { ...c, status, detail } : c));
    if (status === 'running' && !t0[agent]) t0[agent] = Date.now();
    const c = crew.find((x) => x.id === agent);
    if (['done', 'skipped', 'error'].includes(status) && t0[agent]) c.ms = Date.now() - t0[agent];
    store.update(id, { crew });
  };
}

async function guarded(log, agent, fn) {
  log(agent, 'running');
  try { const r = await fn((d) => log(agent, 'running', d)); return r; }
  catch (e) { console.error(`[${agent}]`, e); log(agent, 'error', String(e.message || e).slice(0, 160)); return null; }
}

// Turns what the recorder left in the video folder into video.mp4: timeline.json + screen_N/cam_N tracks (composited here, once), or an uploaded
// file (Loomify). Raw tracks are deleted afterwards because they hold the screen before the Privacy Guard has seen it; if the encode fails
// they stay on disk so nothing is lost. For recordings the same ffmpeg run also writes the Privacy Guard's sample frames into `scanDir`.
async function encodeRecording(id, dir, out, scanDir) {
  const m = readManifest(dir);
  if (!m) throw new Error('this video has no recording data');
  let last = 0;
  const onProgress = (p) => { const now = Date.now(); if (now - last > 500) { last = now; store.update(id, { stage: `Encoding video ${Math.round(p * 100)}%` }); } };
  if (m.kind === 'upload') { await transcodeUpload(m.file, out, { onProgress: null }); fs.rmSync(m.file, { force: true }); return null; }
  const tl = m.timeline, inputs = segmentInputs(dir, tl);
  if (!inputs.length) throw new Error('the recording is empty');
  if (tl.audio) for (const s of inputs) if (!s.screen && s.audio && !hasAudioStream(s.audio)) s.audio = null; // a backup file with no sound in it (cut short): silence instead of a failed export
  if (tl.audio && tl.camAudio) for (const s of inputs) if (!s.screen && s.cam) s.camSound = hasAudioStream(s.cam); // a stand-in's voice comes from the camera file: if that has none, the stretch is silent instead of the export failing
  const masks = path.join(dir, 'masks');
  if (scanDir) { fs.rmSync(scanDir, { recursive: true, force: true }); fs.mkdirSync(scanDir, { recursive: true }); }
  const plan = buildComposite(tl, inputs, { out, scanDir, maskPath: (shape, w, h) => ensureMask(masks, shape, w, h), framePath: (f, shape, w, h) => ensureFrame(masks, f, shape, w, h) });
  if (Object.values(plan.fills).some(Boolean)) say('composite', id, 'segments with no screen or camera recording kept, filled with', JSON.stringify(plan.fills)); // a recorder wrote nothing for these (see segmentInputs)
  await runFfmpeg(plan.args, { duration: plan.total, onProgress });
  fs.rmSync(masks, { recursive: true, force: true });
  if (!process.env.SPOOL_KEEP_RAW) for (const s of tl.segments || []) for (const f of [s.screen, s.cam, s.still, s.audio]) if (f) fs.rmSync(path.join(dir, f), { force: true });
  return plan;
}

// ---- the pipeline ----------------------------------------------------------------------------------------------------------------
// composite → thumbnail → status `ready` (the owner can watch) → Privacy Guard → blur pass (only if something was found) → `shareable`
//   → Transcriber → Planner → Insights → Guide.
// Viewers are blocked until `shareable` is true (fail closed); the owner is never blocked. Each finished stage is checkpointed in `pipe`, so a job
// that was interrupted by a quit resumes after the last finished stage instead of starting over.
const ORDER = ['queued', 'composited', 'shared', 'transcribed', 'done'];
const reached = (v, stage) => ORDER.indexOf(v.pipe || 'queued') >= ORDER.indexOf(stage);
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

async function processJob(job) {
  const id = job.videoId;
  if (!store.get(id)) return;
  const dir = store.videoDir(id), log = makeLog(id), set = (patch) => store.update(id, patch);
  const settings = store.getSettings(), t0 = job.queuedAt || Date.now();
  const timings = { ...(store.get(id).timings || {}) };
  const mark = (name, since) => { timings[name] = Date.now() - since; set({ timings: { ...timings } }); say(`pipeline ${id} ${name} ${secs(timings[name])}`); };
  const video = path.join(dir, 'video.mp4'), work = path.join(dir, 'work'), scanDir = path.join(work, 'scan');
  const models = path.join(dataDir, 'models');
  let v = store.get(id);

  // --- 1. composite → video.mp4, thumbnail, `ready` ------------------------------------------------------------------------------
  let meta = { duration: v.duration, width: v.width, height: v.height };
  if (!reached(v, 'composited')) {
    set({ hasTrack: fs.existsSync(path.join(dir, 'track.json')) || fs.existsSync(timelinePath(dir)), crew: CREW.map((c) => ({ ...c, status: 'queued', detail: '' })), stage: 'Encoding video', shareable: false, timings: {} });
    fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
    const t1 = Date.now(); let plan;
    try { plan = await encodeRecording(id, dir, video, settings.privacyGuard && !process.env.SPOOL_SKIP_AI ? scanDir : null); }
    catch (e) { say('composite failed', id, e); fs.rmSync(video, { force: true }); fs.rmSync(work, { recursive: true, force: true }); set({ status: 'failed', stage: 'Encoding failed' }); return; } // the raw tracks stay: they are the only copy
    mark('composite', t1);
    const t2 = Date.now();
    meta = plan ? { duration: plan.total, width: plan.size.w, height: plan.size.h } : await probe(video);
    await frameAt(video, Math.min(1, Math.max(0, meta.duration - 0.5)), path.join(dir, 'thumb.jpg'), 480).catch(() => {});
    mark('thumbnail', t2);
    const skip = !!process.env.SPOOL_SKIP_AI;
    set({ status: 'ready', duration: meta.duration || store.get(id).duration, width: meta.width, height: meta.height, pipe: 'composited', shareable: skip || !settings.privacyGuard,
      stage: skip ? 'done' : settings.privacyGuard ? 'Privacy Guard is checking' : 'Reading speech' });
    mark('readyForOwner', t0); // Stop → the owner can press play
    if (skip) { set({ pipe: 'done' }); fs.rmSync(work, { recursive: true, force: true }); return; }
    v = store.get(id);
  }

  // --- 2. Privacy Guard: the screen (OCR → blur) and the speech (transcript rules → bleep) → shareable ---------------------------
  // R6: Whisper runs next to the screen scan, because the guard listens too. Viewers get the video when BOTH have finished and cleaned it.
  let scan = null, redactions = v.redactions || [], tr = null, speech0 = null;
  const listen = settings.privacyGuard && settings.speechGuard !== false;
  const needSpeech = !reached(v, 'transcribed');
  const transcribeNow = async () => {
    if (!hasAudioStream(video)) { log('transcriber', 'skipped', 'no audio in this recording'); return { reason: 'no-audio' }; }
    if (!transcribeModel.modelStatus(models).cached && !(await online())) { log('transcriber', 'skipped', 'waiting for the speech model: connect once, or use Settings → AI → Download models'); return { reason: 'no-model' }; } // B17
    const t5 = Date.now(), r = await guarded(log, 'transcriber', (d) => transcribe(video, work, models, d, null, { words: true }));
    return r ? { tr: r, ms: Date.now() - t5 } : { reason: 'failed' };
  };
  if (!reached(v, 'shared')) {
    if (!settings.privacyGuard) { log('privacy', 'skipped', 'turned off in settings'); set({ shareable: true, pipe: 'shared' }); }
    else {
      const t3 = Date.now();
      fs.mkdirSync(work, { recursive: true });
      const speech = listen && needSpeech ? transcribeNow() : null; speech0 = speech;
      scan = await guarded(log, 'privacy', (d) => privacy.scan({ video, scanDir, workDir: work, duration: meta.duration, width: meta.width, height: meta.height, cachePath: models, onStatus: d, log: say }));
      const failClosed = (why = 'Privacy Guard failed: only you can watch this video') => { scan = null; set({ pipe: 'shared', shareable: false, stage: why }); }; // viewers stay blocked, the owner can watch
      if (!scan) failClosed();
      else {
        mark('privacyScan', t3);
        // The rules have run. Start blurring what they found right away, and let the model judge the rest while the encoder works: the guard
        // clears the video when both are done, never before. If the model adds findings, blur once more from the same unblurred file.
        const t4 = Date.now(), blur = path.join(dir, 'video.blur.mp4');
        const blurNow = (label) => guarded(log, 'privacy', async (d) => { d(`${label} ${scan.report.length} item(s)`); return scan.redact(blur, { onProgress: (p) => d(`blurring ${Math.round(p * 100)}%`) }); });
        const first = scan.report.length ? blurNow('blurring') : Promise.resolve(false);
        const refined = await guarded(log, 'privacy', () => scan.refine().catch(() => ({ changed: false })));
        let blurred = await first;
        if (blurred === null) failClosed();
        else if (refined && refined.changed) blurred = await blurNow('blurring again, the model found more:');
        if (scan && blurred === null) failClosed();
        if (scan) {
          redactions = scan.report;
          say(`privacy ${id}`, JSON.stringify(scan.stats));
          if (blurred) {
            // B16: the unblurred file is replaced, unless the owner chose to keep it (owner only, never served)
            if (settings.keepOriginal) fs.copyFileSync(video, path.join(dir, 'original.mp4'));
            fs.renameSync(blur, video);
            await frameAt(video, Math.min(1, Math.max(0, meta.duration - 0.5)), path.join(dir, 'thumb.jpg'), 480).catch(() => {});
            await dropDerivedPictures(id, dir, video); // R3
            mark('privacyBlur', t4);
          }
          // the speech half: the transcript must exist before the video opens
          let open = true, heard = '';
          if (speech) {
            const sp = await speech;
            if (sp.tr) {
              const g = speechGuard.guardTranscript(sp.tr);
              if (g.count) {
                try {
                  const t7 = Date.now(), out = path.join(dir, 'video.mute.mp4');
                  if (settings.keepOriginal && !fs.existsSync(path.join(dir, 'original.mp4'))) fs.copyFileSync(video, path.join(dir, 'original.mp4'));
                  await speechGuard.bleepAudio(video, out, g.intervals, meta.duration); fs.renameSync(out, video); mark('speechBleep', t7);
                } catch (e) { say('bleep failed', id, e); open = false; heard = 'could not bleep a spoken secret'; }
              }
              if (open) {
                tr = { text: g.text, segments: g.segments, ...(g.words ? { words: g.words } : {}) };
                set({ transcript: tr.text, segments: tr.segments, ...(tr.words ? { words: tr.words } : {}), speechRedactions: g.intervals.map((iv) => ({ from: +iv.from.toFixed(2), to: +iv.to.toFixed(2), type: iv.type })) });
                log('transcriber', 'done', `${tr.segments.length} segments${g.count ? `, ${g.count} spoken secret${g.count > 1 ? 's' : ''} bleeped` : ''}`); mark('transcribe', t3);
                heard = g.count ? `${g.count} spoken secret${g.count > 1 ? 's' : ''} bleeped` : 'nothing sensitive said';
              }
            } else if (sp.reason === 'no-audio') heard = 'no audio';
            else { open = false; heard = sp.reason === 'no-model' ? 'could not listen: the speech model is missing' : 'could not listen: transcription failed'; }
          } else if (!listen) heard = 'speech not checked (turned off in settings)';
          const rulesOnly = !scan.modelRan;
          log('privacy', 'done', `${blurred ? `${redactions.length} sensitive item${redactions.length > 1 ? 's' : ''} blurred` : 'nothing sensitive found'}${rulesOnly ? ' · rules-only check, the local model was not loaded' : ''}${heard ? ` · ${heard}` : ''}`);
          set({ redactions, guard: { model: scan.modelRan, speech: !listen ? 'off' : open ? (heard.startsWith('no audio') ? 'no-audio' : 'checked') : 'failed' }, pipe: speech && open ? 'transcribed' : 'shared',
            ...(open ? { shareable: true, stage: 'Writing the AI notes' } : { shareable: false, stage: `Privacy Guard ${heard}: only you can watch this video` }) });
          if (open) mark('shareable', t0);
          else if (speech) set({ pipe: 'transcribed' }); // do not retry on every restart; "Re-run AI crew" starts the guard again
        }
      }
    }
    if (speech0) await speech0.catch(() => {}); // never leave Whisper running into the next stage
    fs.rmSync(scanDir, { recursive: true, force: true }); // sample frames are the user's screen: gone as soon as they have been read
    v = store.get(id);
  }

  // --- 3. Transcriber (only when the guard is off, was skipped, or listening is turned off; otherwise it ran above) ------------------
  if (!tr) tr = v.transcript !== undefined && reached(v, 'transcribed') ? { text: v.transcript, segments: v.segments || [] } : null;
  if (!reached(v, 'transcribed')) {
    const t5 = Date.now();
    fs.mkdirSync(work, { recursive: true });
    const r = await transcribeNow();
    tr = r.tr || null;
    if (tr) { set({ transcript: tr.text, segments: tr.segments, ...(tr.words ? { words: tr.words } : {}) }); log('transcriber', 'done', `${tr.segments.length} segments`); mark('transcribe', t5); }
    set({ pipe: 'transcribed', stage: 'Writing the AI notes' });
  }

  // --- 4. Planner → Insights → Guide ---------------------------------------------------------------------------------------------
  const t6 = Date.now();
  await runAgents(id, { segments: tr?.segments || [], text: tr?.text || '', scan, meta, finalVideo: video, work });
  mark('ai', t6); mark('total', t0);
  set({ pipe: 'done' });
  fs.rmSync(work, { recursive: true, force: true });
}

// R3: a custom thumbnail or preview GIF the owner made while the guard was still running was cut from the unblurred file. After a blur they are
// regenerated from the blurred one (thumbnail at the chosen time) or deleted (an uploaded picture, the GIF); the owner can make a GIF again.
async function dropDerivedPictures(id, dir, video) {
  const v = store.get(id) || {}, custom = path.join(dir, 'thumb-custom.jpg');
  fs.rmSync(path.join(dir, 'preview.gif'), { force: true });
  fs.rmSync(custom, { force: true });
  if (typeof v.thumbAt === 'number') await frameAt(video, v.thumbAt, custom, 480).catch(() => fs.rmSync(custom, { force: true }));
  store.update(id, { gifAt: null, ...(fs.existsSync(custom) ? {} : { thumbAt: null }) });
}

// Finding 1: a screenshot is saved closed (`shareable: false`) and opened here, after the same secret rules as a recording's frames have run and
// blurred what they found. If the screen reader fails, the image stays closed to viewers and the owner is told.
async function stillJob(job, { read } = {}) {
  const id = job.videoId, v = store.get(id);
  if (!v || v.shareable === true) return;
  const dir = store.videoDir(id), file = path.join(dir, 'image.png'), settings = store.getSettings(), set = (patch) => store.update(id, patch);
  if (!settings.privacyGuard) return set({ shareable: true, stage: 'done' });
  try {
    const out = path.join(dir, 'image.guard.png'), t0 = Date.now();
    const r = await privacy.scanStill({ file, out, width: v.width, height: v.height, cachePath: dataDir && path.join(dataDir, 'models'), read });
    if (r.blurred) {
      if (settings.keepOriginal) fs.copyFileSync(file, path.join(dir, 'original.png'));
      fs.renameSync(out, file);
      await runFfmpeg(['-y', '-i', file, '-vf', 'scale=480:-2', '-q:v', '4', path.join(dir, 'thumb.jpg')]);
    }
    say(`pipeline ${id} stillGuard ${secs(Date.now() - t0)} ${r.report.length} hit(s)`);
    set({ redactions: r.report, guard: { model: false, speech: 'no-audio' }, shareable: true, stage: 'done' });
  } catch (e) {
    say('still guard failed', id, e);
    fs.rmSync(path.join(dir, 'image.guard.png'), { force: true });
    set({ shareable: false, stage: 'Privacy Guard could not read this screenshot: only you can see it' });
  }
}

const online = () => fetch('https://huggingface.co', { method: 'HEAD', signal: AbortSignal.timeout(3000) }).then(() => true, () => false);

// Planner → Insights → Guide Writer ⇄ Critic. Needs Ollama; skips cleanly without it.
async function runAgents(id, { segments, text, scan, meta, finalVideo, work }) {
  const dir = store.videoDir(id);
  const log = makeLog(id);
  const set = (patch) => store.update(id, patch);
  const ollama = await llm.available();
  const LLM_AGENTS = ['planner', 'insights', 'writer', 'critic'];
  const skipAll = (why) => { LLM_AGENTS.forEach((a) => log(a, 'skipped', why)); set({ stage: 'done' }); };
  if (!ollama) return skipAll('Ollama is not running');
  if (!text.trim() && !scan) return skipAll('no speech and no screen text');
  LLM_AGENTS.forEach((a) => log(a, 'queued'));
  const decision = await guarded(log, 'planner', () => plan({ segments, text, duration: meta.duration, hasScreenText: !!scan?.masked?.some((f) => f.lines.length) }));
  if (decision) { log('planner', 'done', `${decision.kind}${decision.writeGuide ? '' : ' (no guide)'} — ${decision.reason}`); set({ plan: decision }); }

  if (text.trim()) {
    const ins = await guarded(log, 'insights', () => insights({ segments, text, duration: meta.duration }));
    if (ins) {
      const patch = { summary: ins.summary, chapters: ins.chapters, tasks: ins.tasks };
      if (store.get(id).titleAuto && ins.title) patch.title = ins.title; // never overwrite a title the user typed
      set(patch); log('insights', 'done', `${ins.chapters.length} chapters, ${ins.tasks.length} tasks`);
    }
  } else log('insights', 'skipped', 'no speech');

  if (decision?.writeGuide !== false && (text.trim() || scan)) {
    const guide = await guarded(log, 'writer', (d) => makeGuide({
      kind: decision?.kind || 'how-to', segments, screen: scan?.masked || [], duration: meta.duration, video: finalVideo,
      outDir: path.join(dir, 'guide'), onEvent: (who, msg) => log(who, 'running', msg),
    }));
    if (guide) {
      set({ guide });
      log('writer', 'done', `${guide.steps.length} steps${guide.revisions ? ', revised once' : ''}`);
      log('critic', 'done', guide.criticOk ? 'approved' : `flagged: ${guide.criticIssues.join('; ').slice(0, 120)}`);
    } else log('critic', 'skipped', 'no draft to review');
  } else { log('writer', 'skipped', decision?.reason || 'not enough content'); log('critic', 'skipped', 'no draft'); }

  if (work) fs.rmSync(work, { recursive: true, force: true });
  set({ stage: 'done' });
}


// Re-run the LLM agents from the stored transcript (no OCR context, so the guide uses speech only). A video the Privacy Guard never cleared
// goes back through it first.
async function rerunJob(job) {
  const id = job.videoId, v = store.get(id); if (!v) return;
  const dir = store.videoDir(id);
  if (v.shareable !== true && fs.existsSync(path.join(dir, 'video.mp4'))) { store.update(id, { pipe: 'composited' }); return processJob(job); }
  store.update(id, { stage: 'Re-running AI crew', crew: v.crew.map((c) => (['planner', 'insights', 'writer', 'critic'].includes(c.id) ? { ...c, status: 'queued', detail: '' } : c)) });
  await runAgents(id, { segments: v.segments || [], text: v.transcript || '', scan: null, meta: { duration: v.duration }, finalVideo: path.join(dir, 'video.mp4'), work: null });
}

module.exports = { guardStill, stillJob, dropDerivedPictures, cleanLeftovers, init, processVideo, rerunAI, applyEdits, timeWords, CREW, ORDER };
