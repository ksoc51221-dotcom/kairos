// Orchestrator: runs the crew in order, isolates failures, and writes live status into the video record
// so the watch page can show what every agent is doing.
const fs = require('fs');
const path = require('path');
const store = require('../store');
const llm = require('./llm');
const { probe, frameAt } = require('./media');
const { readManifest, segmentInputs, timelinePath } = require('../pipeline/segments');
const { buildComposite } = require('../pipeline/composite');
const { runFfmpeg, transcodeUpload } = require('../pipeline/encode');
const { ensureMask } = require('../pipeline/masks');
const { transcribe } = require('./transcribe');
const privacy = require('./privacy');
const { insights } = require('./insights');
const { makeGuide, plan } = require('./guide');

let dataDir;
const init = (dir) => { dataDir = dir; fs.mkdirSync(path.join(dir, 'models'), { recursive: true }); };

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

// Turns what the recorder left in the video folder into one mp4: timeline.json + screen_N/cam_N tracks (composited here, once),
// or an uploaded file (Loomify). Raw tracks are deleted afterwards because they hold the screen before the Privacy Guard has seen it;
// if the encode fails they stay on disk so nothing is lost.
async function encodeRecording(id, dir, out) {
  const m = readManifest(dir);
  if (!m) throw new Error('this video has no recording data');
  let last = 0;
  const onProgress = (p) => { const now = Date.now(); if (now - last > 500) { last = now; store.update(id, { stage: `Encoding video ${Math.round(p * 100)}%` }); } };
  if (m.kind === 'upload') { await transcodeUpload(m.file, out, { onProgress: null }); fs.rmSync(m.file, { force: true }); return; }
  const tl = m.timeline, inputs = segmentInputs(dir, tl);
  if (!inputs.length) throw new Error('the recording is empty');
  const masks = path.join(dir, 'masks');
  const plan = buildComposite(tl, inputs, { out, maskPath: (shape, w, h) => ensureMask(masks, shape, w, h) });
  await runFfmpeg(plan.args, { duration: plan.total, onProgress });
  fs.rmSync(masks, { recursive: true, force: true });
  if (!process.env.SPOOL_KEEP_RAW) for (const s of tl.segments || []) for (const f of [s.screen, s.cam]) if (f) fs.rmSync(path.join(dir, f), { force: true });
}

async function processVideo(id) {
  const dir = store.videoDir(id);
  const log = makeLog(id);
  const set = (patch) => store.update(id, patch);
  const settings = store.getSettings();
  set({ hasTrack: fs.existsSync(path.join(dir, 'track.json')) || fs.existsSync(timelinePath(dir)), crew: CREW.map((c) => ({ ...c, status: 'queued', detail: '' })), stage: 'Encoding video' });

  // --- 1. encode capture segments → one mp4 ---------------------------------------
  const original = path.join(dir, 'original.mp4');
  try { await encodeRecording(id, dir, original); } catch (e) { console.error(e); set({ status: 'failed', stage: 'Encoding failed' }); return; }
  const meta = await probe(original);
  if (process.env.SPOOL_SKIP_AI) { fs.copyFileSync(original, path.join(dir, 'video.mp4')); await frameAt(original, 1, path.join(dir, 'thumb.jpg'), 480).catch(() => {}); set({ status: 'ready', stage: 'done', duration: meta.duration, width: meta.width, height: meta.height }); return; }
  set({ duration: meta.duration || store.get(id).duration, width: meta.width, height: meta.height, stage: 'Reading speech and screen' });

  // --- 2. Transcriber ∥ Privacy Guard ------------------------------------------------
  const work = path.join(dir, 'work'); fs.mkdirSync(work, { recursive: true });
  const models = path.join(dataDir, 'models');
  const [tr, scan] = await Promise.all([
    guarded(log, 'transcriber', (d) => transcribe(original, work, models, d)),
    settings.privacyGuard
      ? guarded(log, 'privacy', (d) => privacy.scan({ video: original, workDir: work, ...meta, cachePath: models, onStatus: d, log: console.log }))
      : (log('privacy', 'skipped', 'turned off in settings'), null),
  ]);
  if (tr) {
    set({ transcript: tr.text, segments: tr.segments }); // spoken secrets are not redacted (see README limits)
    log('transcriber', 'done', `${tr.segments.length} segments`);
  }

  // --- 3. Privacy Guard: apply blur, then publish the video -------------------------
  const finalVideo = path.join(dir, 'video.mp4');
  let redactions = [];
  if (settings.privacyGuard && !scan) { set({ status: 'failed', stage: 'Privacy Guard failed, video withheld' }); return; } // fail closed
  if (scan) {
    redactions = scan.report;
    const did = await guarded(log, 'privacy', async (d) => { d(`blurring ${redactions.length} item(s)`); return scan.redact(finalVideo); });
    if (did === null) { set({ status: 'failed', stage: 'Privacy Guard failed, video withheld' }); return; } // fail closed
    if (did) log('privacy', 'done', `${redactions.length} sensitive item${redactions.length > 1 ? 's' : ''} blurred`);
    else log('privacy', 'done', 'nothing sensitive found');
  }
  if (!fs.existsSync(finalVideo)) fs.copyFileSync(original, finalVideo);
  if (redactions.length === 0) fs.rmSync(original, { force: true }); // with redactions the unblurred original stays on disk but is never served
  await frameAt(finalVideo, Math.min(1, Math.max(0, meta.duration - 0.5)), path.join(dir, 'thumb.jpg'), 480).catch(() => {});
  set({ status: 'ready', redactions, stage: 'Writing the AI notes' });

  await runAgents(id, { segments: tr?.segments || [], text: tr?.text || '', scan, meta, finalVideo, work });
  fs.rmSync(work, { recursive: true, force: true });
}

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


// Re-run the LLM agents from the stored transcript (no OCR context, so guide uses speech only).
async function rerunAI(id) {
  const v = store.get(id); if (!v) return;
  const dir = store.videoDir(id);
  store.update(id, { stage: 'Re-running AI crew', crew: v.crew.map((c) => (['planner', 'insights', 'writer', 'critic'].includes(c.id) ? { ...c, status: 'queued', detail: '' } : c)) });
  await runAgents(id, { segments: v.segments || [], text: v.transcript || '', scan: null, meta: { duration: v.duration }, finalVideo: path.join(dir, 'video.mp4'), work: null });
}

module.exports = { init, processVideo, rerunAI, CREW };
