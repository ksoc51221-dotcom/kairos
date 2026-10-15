// B4: the job queue runs one job at a time, and a job a quit left half-done is retried, then given up on after two starts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../src/store');
const queue = require('../../src/agents/queue');

const fresh = () => { store.close(); store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-q-')), { log: () => {} }); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('jobs never overlap, and run in the order they were queued', async () => {
  fresh(); const log = []; let active = 0, maxActive = 0;
  queue.start(async (job) => { active++; maxActive = Math.max(maxActive, active); log.push(`start ${job.videoId}`); await wait(30); log.push(`end ${job.videoId}`); active--; });
  await Promise.all([queue.enqueue('a'), queue.enqueue('b'), queue.enqueue('c')]);
  assert.equal(maxActive, 1);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.equal(queue.pending(), 0);
});

test('a failing job rejects its caller, is recorded as failed, and does not stop the queue', async () => {
  fresh(); const ran = [];
  queue.start(async (job) => { ran.push(job.videoId); if (job.videoId === 'bad') throw new Error('boom'); });
  const bad = queue.enqueue('bad'), good = queue.enqueue('good');
  await assert.rejects(bad, /boom/); await good;
  assert.deepEqual(ran, ['bad', 'good']);
  assert.deepEqual(store.load().jobs.map((j) => [j.videoId, j.status]), [['bad', 'failed'], ['good', 'done']]);
});

test('queueing the same waiting job twice does not run it twice', async () => {
  fresh(); let runs = 0;
  queue.start(async (job) => { if (job.videoId === 'x') { runs++; await wait(20); } });
  const first = queue.enqueue('block'); await wait(5);
  await Promise.all([first, queue.enqueue('x'), queue.enqueue('x')]);
  await wait(30); assert.equal(runs, 1);
});

test('startup: a job left running is requeued once, then marked failed (with its video) on the second interrupted start', async () => {
  fresh();
  const v = store.create({ title: 'half done', status: 'processing' });
  store.mutate((db) => { db.jobs.push({ id: 'j1', videoId: v.id, kind: 'process', status: 'running', attempts: 1, queuedAt: 1 }); });
  const seen = []; const r1 = queue.start(async (job) => { seen.push(job.attempts); });
  assert.deepEqual(r1.requeued, [v.id]); await wait(30);
  assert.deepEqual(seen, [2], 'retried as attempt 2');
  assert.equal(store.get(v.id).status, 'processing', 'still its own job to finish');

  store.mutate((db) => { db.jobs = [{ id: 'j2', videoId: v.id, kind: 'process', status: 'running', attempts: 2, queuedAt: 1 }]; });
  const r2 = queue.start(async () => { throw new Error('must not run'); });
  assert.deepEqual(r2.failed, [v.id]);
  assert.equal(store.get(v.id).status, 'failed'); assert.match(store.get(v.id).stage, /interrupted twice/);
});

test('startup: an interrupted job on a video that is already watchable gives up quietly instead of marking it failed', async () => {
  fresh();
  const v = store.create({ title: 'ready', status: 'ready', stage: 'Writing the AI notes' });
  store.mutate((db) => { db.jobs.push({ id: 'j3', videoId: v.id, kind: 'process', status: 'running', attempts: 2, queuedAt: 1 }); });
  queue.start(async () => {});
  assert.equal(store.get(v.id).status, 'ready'); assert.equal(store.get(v.id).stage, 'done');
});
