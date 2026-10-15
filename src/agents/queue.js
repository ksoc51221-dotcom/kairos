// B4: a single-concurrency job queue that survives a restart.
// Two recordings back to back used to run two Whisper + OCR + ffmpeg pipelines at once. Now jobs wait their turn, and every job lives in
// db.jobs until it finishes, so a quit in the middle does not leave a video on "Processing…" forever:
//   on startup, a job that was `running` is retried; after MAX_ATTEMPTS starts it is marked failed (and so is its video, if it was not yet watchable).
const store = require('../store');

const MAX_ATTEMPTS = 2;
let runner = null, running = false, say = (...a) => console.log(...a);
const waiters = new Map(); // job id → [{resolve, reject}] for callers that await the result (tests, self-tests)

const jobs = () => store.load().jobs;
const find = (id) => jobs().find((j) => j.id === id);
const patch = (id, p) => store.mutate((db) => { const j = db.jobs.find((x) => x.id === id); if (j) Object.assign(j, p); });

function enqueue(videoId, kind = 'process') {
  const existing = jobs().find((j) => j.videoId === videoId && j.kind === kind && j.status === 'queued');
  const id = existing ? existing.id : store.newId(5);
  if (!existing) store.mutate((db) => { db.jobs.push({ id, videoId, kind, status: 'queued', attempts: 0, queuedAt: Date.now() }); });
  const p = new Promise((resolve, reject) => { (waiters.get(id) || waiters.set(id, []).get(id)).push({ resolve, reject }); });
  setImmediate(pump);
  return p;
}

async function pump() {
  if (running || !runner) return;
  const job = jobs().find((j) => j.status === 'queued');
  if (!job) return;
  running = true;
  patch(job.id, { status: 'running', attempts: job.attempts + 1, startedAt: Date.now() });
  let err = null;
  try { await runner({ ...find(job.id) }); } catch (e) { err = e; say('job failed', job.kind, job.videoId, e); }
  patch(job.id, { status: err ? 'failed' : 'done', endedAt: Date.now(), error: err ? String(err.message || err).slice(0, 300) : undefined });
  trim();
  for (const w of waiters.get(job.id) || []) err ? w.reject(err) : w.resolve();
  waiters.delete(job.id);
  running = false;
  setImmediate(pump);
}
// finished jobs are history; keep the last few for the log
const trim = () => store.mutate((db) => { const done = db.jobs.filter((j) => j.status === 'done' || j.status === 'failed'); if (done.length > 30) db.jobs = db.jobs.filter((j) => !done.slice(0, done.length - 30).includes(j)); });

// Called once at startup with the function that does the work. Returns what it did, for the log.
function start(run, { log } = {}) {
  runner = run; if (log) say = log;
  const report = { requeued: [], failed: [] };
  store.mutate((db) => {
    for (const j of db.jobs) {
      if (j.status !== 'running') continue;
      if (j.attempts >= MAX_ATTEMPTS) { j.status = 'failed'; j.error = 'interrupted twice'; report.failed.push(j.videoId); } else { j.status = 'queued'; report.requeued.push(j.videoId); }
    }
  });
  for (const id of report.failed) {
    const v = store.get(id);
    if (v && v.status === 'processing') store.update(id, { status: 'failed', stage: 'Processing was interrupted twice' });
    else if (v) store.update(id, { stage: 'done' });
  }
  setImmediate(pump);
  return report;
}

const pending = () => jobs().filter((j) => j.status === 'queued' || j.status === 'running').length;
module.exports = { enqueue, start, pending, MAX_ATTEMPTS };
