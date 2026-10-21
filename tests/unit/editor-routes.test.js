// The editor's HTTP surface, headless: owner-only access, draft edits are sanitised and saved, the page itself is served. No windows, no Whisper.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A stand-in for Ollama on a private port (must be set before llm.js is loaded), so the describe route never depends on what runs on this machine.
const OLLAMA_PORT = 42000 + Math.floor(Math.random() * 2000);
const fake = { mode: 'down', answer: null, chatCalls: [], delay: 0 };
const ollama = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') { if (fake.mode === 'down') { res.statusCode = 503; return res.end('{}'); } return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] })); }
    if (req.url === '/api/chat') { fake.chatCalls.push(JSON.parse(body)); return setTimeout(() => res.end(JSON.stringify({ message: { content: fake.mode === 'junk' ? 'not json at all' : JSON.stringify(fake.answer) } })), fake.delay); }
    res.statusCode = 404; res.end('{}');
  });
});
ollama.listen(OLLAMA_PORT, '127.0.0.1');
process.env.OLLAMA_URL = `http://127.0.0.1:${OLLAMA_PORT}`;

const store = require('../../src/store');
const { withOwner } = require('./owner');
const { startServer } = require('../../src/server/server');
const { runFfmpeg } = require('../../src/pipeline/encode');

let srv, port, v, other, quiet, csrf;
test.before(async () => {
  store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-edr-')), { log: () => {} });
  v = store.create({ title: 'Main', status: 'ready', shareable: true, duration: 6 });
  other = store.create({ title: 'Other', status: 'ready', shareable: true, duration: 3 });
  quiet = store.create({ title: 'Quiet', status: 'ready', shareable: false, duration: 6 }); // 2 s of tone, then 4 s of silence; not shareable, so it stays out of the insert library
  for (const [x, s] of [[v, 6], [other, 3]]) await runFfmpeg(['-y', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=15:duration=${s}`, '-f', 'lavfi', '-i', `sine=frequency=300:duration=${s}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(store.videoDir(x.id), 'video.mp4')]);
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=6', '-f', 'lavfi', '-i', 'aevalsrc=if(lt(t\\,2)\\,sin(2*PI*300*t)\\,0):d=6:s=44100', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(store.videoDir(quiet.id), 'video.mp4')]);
  srv = startServer({ port: 0, models: fs.mkdtempSync(path.join(os.tmpdir(), 'spool-m-')) }); port = await srv.ready;
  csrf = (await call('GET', '/api/me')).json.csrf;
});
test.after(async () => { await srv.close(); ollama.close(); ollama.closeAllConnections?.(); store.close(); });
const call = (method, url, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: `127.0.0.1:${port}`, ...(csrf && method !== 'GET' ? { 'x-spool-csrf': csrf } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...withOwner(headers, port) } }, (res) => {
    let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, text: buf, json }); });
  });
  req.on('error', reject); if (data) req.write(data); req.end();
});

test('the editor page and its data are owner-only', async () => {
  const viewer = { 'x-forwarded-for': '203.0.113.9' };
  for (const u of [`/edit/${v.id}`, `/api/videos/${v.id}/editor`, `/api/videos/${v.id}/peaks`]) assert.equal((await call('GET', u, { headers: viewer })).status, 403, u);
  const page = await call('GET', `/edit/${v.id}`); assert.equal(page.status, 200); assert.match(page.text, /Edit · Kairos/);
  assert.equal((await call('PUT', `/api/videos/${v.id}/edits`, { headers: viewer, body: { cuts: [] } })).status, 403);
});
test('the editor payload lists the other videos but not itself', async () => {
  const r = (await call('GET', `/api/videos/${v.id}/editor`)).json;
  assert.equal(r.duration, 6); assert.deepEqual(r.library.map((o) => o.id), [other.id]); assert.equal(r.canUndo, false);
});
test('draft edits are clamped and kept; junk is dropped', async () => {
  const r = await call('PUT', `/api/videos/${v.id}/edits`, { body: { cuts: [{ start: 4, end: 99 }, { start: 1, end: 2, kind: 'manual' }, { start: 3, end: 3.001 }, { start: 'x', end: 2 }], inserts: [{ videoId: other.id, at: 2, start: 0, end: 3 }, { videoId: 'nope', at: 1, start: 0, end: 1 }] } });
  assert.equal(r.status, 200);
  const e = (await call('GET', `/api/videos/${v.id}/editor`)).json.edits;
  assert.deepEqual(e.cuts.map((c) => [c.start, c.end]).sort((a, b) => a[0] - b[0]), [[1, 2], [4, 6]]);
  assert.deepEqual(e.inserts.map((x) => x.videoId), [other.id]);
});
test('peaks come back as a waveform at 100 per second', async () => {
  const r = (await call('GET', `/api/videos/${v.id}/peaks`)).json;
  assert.equal(r.rate, 100); assert.ok(Math.abs(r.peaks.length - 600) <= 5, `${r.peaks.length} peaks`); assert.ok(Math.max(...r.peaks) > 20);
});

// ---- "Describe an edit": owner only, validated, never writes ----
const describe = (id, text, o = {}) => call('POST', `/api/videos/${id}/edits/describe`, { body: text === undefined ? {} : { text }, ...o });
const snapshot = (id) => JSON.stringify(store.get(id));

test('describe: owner only; a viewer, a missing token and an unknown video get nothing', async () => {
  const viewer = { 'x-forwarded-for': '203.0.113.9' }, before = snapshot(v.id);
  assert.equal((await describe(v.id, 'remove the first 2 seconds', { headers: viewer })).status, 403);
  assert.equal((await describe('nope', 'remove the first 2 seconds')).status, 404);
  const saved = csrf; csrf = undefined; try { assert.equal((await describe(v.id, 'remove the first 2 seconds')).status, 403, 'no CSRF token'); } finally { csrf = saved; }
  assert.equal(snapshot(v.id), before);
});
test('describe: the text must be 1 to 500 characters of text', async () => {
  for (const body of [undefined, '', '   ', 7, ['cut'], { a: 1 }, null, 'x'.repeat(501)]) {
    const r = await describe(v.id, body); assert.equal(r.status, 400, JSON.stringify(body)?.slice(0, 30)); assert.ok(r.json.error);
  }
  assert.equal((await call('POST', `/api/videos/${v.id}/edits/describe`, { body: null })).status, 400, 'no body at all');
  assert.equal((await describe(v.id, 'x'.repeat(500))).status, 200, '500 is fine');
});
test('describe: a video that is still being processed is a 409', async () => {
  for (const patch of [{ stage: 'Transcribing 40%' }, { stage: 'Applying edits 10%' }, { status: 'processing', stage: '' }]) {
    const prev = { stage: store.get(v.id).stage, status: store.get(v.id).status };
    store.update(v.id, patch);
    try { const r = await describe(v.id, 'remove the first 2 seconds'); assert.equal(r.status, 409, JSON.stringify(patch)); assert.ok(r.json.error); } finally { store.update(v.id, prev); }
  }
  store.update(v.id, { stage: 'Timing every word 30%' });
  try { assert.equal((await describe(v.id, 'remove the first 2 seconds')).status, 200, 'word timing in the background does not block it'); } finally { store.update(v.id, { stage: '' }); }
});
test('describe: a time-based request returns reviewable proposals and writes nothing', async () => {
  await call('PUT', `/api/videos/${v.id}/edits`, { body: { cuts: [{ start: 5, end: 6, kind: 'manual' }], inserts: [] } });
  const before = snapshot(v.id);
  const r = await describe(v.id, 'remove the first 2 seconds and 0:04 to 0:05');
  assert.equal(r.status, 200);
  assert.equal(r.json.understood, true); assert.equal(r.json.usedModel, false);
  assert.deepEqual(r.json.proposals.map((p) => [p.start, p.end, p.kind, p.source, p.label]), [[0, 2, 'prompt', 'rule', '0:00 to 0:02'], [4, 5, 'prompt', 'rule', '0:04 to 0:05']]);
  assert.equal(r.json.removedSeconds, 3); assert.equal(r.json.resultDuration, 3);
  assert.equal(snapshot(v.id), before, 'the video record is untouched');
  assert.deepEqual((await call('GET', `/api/videos/${v.id}/editor`)).json.edits.cuts.map((c) => [c.start, c.end]), [[5, 6]], 'and so is the draft');
  assert.equal(fake.chatCalls.length, 0, 'no model needed');
});
test('describe: accepted proposals are saved through the existing edits endpoint, and keep their kind', async () => {
  const draft = (await call('GET', `/api/videos/${v.id}/editor`)).json.edits;
  const p = (await describe(v.id, 'remove the first 2 seconds')).json.proposals;
  const put = await call('PUT', `/api/videos/${v.id}/edits`, { body: { cuts: [...draft.cuts, ...p.map((x) => ({ start: x.start, end: x.end, kind: x.kind }))], inserts: draft.inserts } });
  assert.equal(put.status, 200);
  const cuts = (await call('GET', `/api/videos/${v.id}/editor`)).json.edits.cuts;
  assert.deepEqual(cuts.map((c) => [c.start, c.end, c.kind]).sort((a, b) => a[0] - b[0]), [[0, 2, 'prompt'], [5, 6, 'manual']]);
  await call('PUT', `/api/videos/${v.id}/edits`, { body: { cuts: [], inserts: [] } });
});
test('describe: something that is not an edit is a normal 200 with understood:false and examples', async () => {
  const r = await describe(v.id, 'write me a summary of this video');
  assert.equal(r.status, 200); assert.equal(r.json.understood, false); assert.deepEqual(r.json.proposals, []); assert.match(r.json.message, /remove the first 10 seconds/);
  const r2 = await describe(v.id, 'cut the last 99 seconds'); assert.equal(r2.json.understood, false); assert.match(r2.json.message, /almost nothing/);
});
test('describe: silences come from the real detector on the real file', async () => {
  const before = snapshot(quiet.id);
  const r = (await describe(quiet.id, 'remove silences')).json;
  assert.equal(r.understood, true, r.message); assert.equal(r.proposals.length, 1);
  const s = r.proposals[0]; assert.equal(s.kind, 'silence'); assert.ok(s.start >= 2 && s.start < 2.6 && s.end > 5.4 && s.end <= 6, `${s.start}-${s.end}`);
  assert.equal(snapshot(quiet.id), before);
  const none = (await describe(v.id, 'remove silences')).json; assert.equal(none.understood, false); assert.match(none.message, /No long silences/);
});
test('describe: filler words come from the word timings; without them the answer says to wait', async () => {
  const w = (await describe(v.id, 'remove filler words')).json; assert.equal(w.understood, false); assert.match(w.message, /Word timings are not ready/);
  store.update(v.id, { words: [{ w: 'so', s: 0.2, e: 0.4 }, { w: 'um', s: 1, e: 1.3 }, { w: 'yes', s: 2, e: 2.5 }] });
  try { const r = (await describe(v.id, 'remove the ums')).json; assert.equal(r.understood, true); assert.deepEqual(r.proposals.map((p) => [p.start, p.end, p.kind]), [[1, 1.3, 'filler']]); }
  finally { store.update(v.id, { words: null }); }
});
test('describe: a content request goes to the local model, with the transcript as data, and the answer is validated', async () => {
  store.update(v.id, { segments: [{ start: 0, end: 2, text: 'Hello and welcome.' }, { start: 2, end: 4, text: 'Our pricing is ten dollars.' }, { start: 4, end: 6, text: 'Thanks for watching.' }] });
  Object.assign(fake, { mode: 'ok', answer: { isEditRequest: true, ranges: [{ start: 2, end: 4, reason: 'This part is about pricing.' }, { start: 50, end: 90, reason: 'past the end' }] }, chatCalls: [] });
  try {
    const before = snapshot(v.id);
    const r = await describe(v.id, 'cut the part where I talk about pricing');
    assert.equal(r.status, 200); assert.equal(r.json.understood, true); assert.equal(r.json.usedModel, true);
    assert.deepEqual(r.json.proposals.map((p) => [p.start, p.end, p.kind, p.source]), [[2, 4, 'prompt', 'model']]);
    assert.equal(fake.chatCalls.length, 1); const msg = fake.chatCalls[0].messages; assert.match(msg[0].content, /UNTRUSTED/); assert.match(msg[1].content, /Our pricing is ten dollars/);
    assert.equal(snapshot(v.id), before);
  } finally { Object.assign(fake, { mode: 'down', chatCalls: [] }); }
});
test('describe: the model being down or answering junk is a 502 that says time-based cuts still work; time-based requests are unaffected', async () => {
  store.update(v.id, { segments: [{ start: 0, end: 6, text: 'Hello there.' }] });
  for (const mode of ['down', 'junk']) {
    fake.mode = mode;
    const r = await describe(v.id, 'remove the intro'); assert.equal(r.status, 502, mode); assert.match(r.json.error, /time-based/i);
    const t = await describe(v.id, 'remove the first 2 seconds'); assert.equal(t.status, 200, mode); assert.equal(t.json.understood, true);
  }
  fake.mode = 'down';
  store.update(v.id, { segments: [] });
  const none = await describe(v.id, 'remove the intro'); assert.equal(none.status, 200); assert.equal(none.json.understood, false); assert.match(none.json.message, /no transcript/);
});
test('describe: a second request for the same video while one is running is a 409', async () => {
  store.update(v.id, { segments: [{ start: 0, end: 6, text: 'Hello there.' }] });
  Object.assign(fake, { mode: 'ok', answer: { isEditRequest: true, ranges: [] }, delay: 400 });
  try {
    const [a, b] = await Promise.all([describe(v.id, 'remove the intro'), (async () => { await new Promise((r) => setTimeout(r, 100)); return describe(v.id, 'remove the outro'); })()]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  } finally { Object.assign(fake, { mode: 'down', delay: 0 }); store.update(v.id, { segments: [] }); }
});
