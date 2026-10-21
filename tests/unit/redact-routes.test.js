// "Bleep speech" over HTTP, headless: owner only, validated, describe never writes, apply runs the real job queue (real ffmpeg), the editor payload says what
// Undo will do, and "Delete the unbleeped copy" leaves nothing in the library file. A fake Ollama stands in for the model; no windows, no Whisper.
process.env.SPOOL_OCR = 'tesseract'; // the queue starts below; do not compile the Vision tool
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OLLAMA_PORT = 44000 + Math.floor(Math.random() * 2000);
const fake = { mode: 'down', answer: null, chatCalls: [] };
const ollama = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') { if (fake.mode === 'down') { res.statusCode = 503; return res.end('{}'); } return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] })); }
    if (req.url === '/api/chat') { fake.chatCalls.push(JSON.parse(body)); return res.end(JSON.stringify({ message: { content: JSON.stringify(fake.answer) } })); }
    res.statusCode = 404; res.end('{}');
  });
});
ollama.listen(OLLAMA_PORT, '127.0.0.1');
process.env.OLLAMA_URL = `http://127.0.0.1:${OLLAMA_PORT}`;

const store = require('../../src/store');
const { withOwner } = require('./owner');
const { startServer } = require('../../src/server/server');
const { viewModel } = require('../../src/server/viewmodel');
const orchestrator = require('../../src/agents/orchestrator');
const { runFfmpeg } = require('../../src/pipeline/encode');

const SECRET = 'hunter2';
const WORDS = [['Hello', 0.3, 0.7], ['everyone', 0.8, 1.3], ['my', 1.4, 1.6], ['password', 1.7, 2.3], ['is', 2.4, 2.6], [SECRET, 2.7, 3.4], ['and', 3.6, 3.8], ['the', 3.9, 4.1], ['server', 4.2, 4.7],
  ['is', 4.8, 5.0], ['called', 5.1, 5.5], ['Atlas', 5.6, 6.1], ['thanks', 6.3, 6.8]].map(([w, s, e]) => ({ w, s, e }));
const SEGMENTS = [{ start: 0.2, end: 3.5, text: `Hello everyone my password is ${SECRET}` }, { start: 3.5, end: 6.9, text: 'and the server is called Atlas thanks' }];
const RANGE = [{ from: 2.65, to: 3.45 }];
const talking = () => ({ words: WORDS.map((w) => ({ ...w })), segments: SEGMENTS.map((s) => ({ ...s })), transcript: SEGMENTS.map((s) => s.text).join(' '), summary: `They share the password ${SECRET}.`, speechRedactions: [] });

let srv, port, csrf, root;
const mkVideo = async (extra = {}, audio = true) => {
  const v = store.create({ title: 'Talk', status: 'ready', shareable: true, duration: 7, stage: 'done', ...extra });
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=7', ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=300:duration=7', '-c:a', 'aac', '-shortest'] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(store.videoDir(v.id), 'video.mp4')]);
  return v;
};
test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-rr-'));
  store.init(root, { log: () => {} });
  orchestrator.init(root, { log: () => {} });
  srv = startServer({ port: 0, models: fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-rm-')) }); port = await srv.ready;
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
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 40)); } return false; };
const describe = (id, text, extra = {}) => call('POST', `/api/videos/${id}/redact/describe`, { body: { text, ...extra } });
const apply = (id, body) => call('POST', `/api/videos/${id}/redact/apply`, { body });
const snapshot = (id) => JSON.stringify(store.get(id));
const viewer = { 'x-forwarded-for': '203.0.113.9' };

test('every bleep endpoint is owner only', async () => {
  const v = await mkVideo(talking()), before = snapshot(v.id);
  for (const [m, u, body] of [['GET', `/api/videos/${v.id}/redact/sentences`], ['POST', `/api/videos/${v.id}/redact/describe`, { text: 'bleep my password' }], ['POST', `/api/videos/${v.id}/redact/apply`, { ranges: RANGE }], ['POST', `/api/videos/${v.id}/redact/finalize`, {}]]) {
    assert.equal((await call(m, u, { headers: viewer, body })).status, 403, `${m} ${u}`);
  }
  const saved = csrf; csrf = undefined; try { assert.equal((await apply(v.id, { ranges: RANGE })).status, 403, 'no CSRF token'); } finally { csrf = saved; }
  assert.equal((await call('GET', '/api/videos/nope/redact/sentences')).status, 404); assert.equal((await describe('nope', 'bleep my password')).status, 404); assert.equal((await apply('nope', { ranges: RANGE })).status, 404);
  assert.equal(snapshot(v.id), before, 'nothing changed');
});
test('sentences: the transcript as numbered sentences for the picker', async () => {
  const v = await mkVideo(talking());
  const r = await call('GET', `/api/videos/${v.id}/redact/sentences`);
  assert.equal(r.status, 200); assert.equal(r.json.approx, false);
  assert.deepEqual(r.json.sentences.map((s) => [s.id, s.text]), [[1, `Hello everyone my password is ${SECRET} and the server is called Atlas thanks`]]); // no pause long enough to split it
  const w = await mkVideo({ ...talking(), words: null }); assert.equal((await call('GET', `/api/videos/${w.id}/redact/sentences`)).json.approx, true);
  const none = await mkVideo({}); assert.deepEqual((await call('GET', `/api/videos/${none.id}/redact/sentences`)).json.sentences, []);
});
test('describe: validated, 409 while processing, and it never writes', async () => {
  const v = await mkVideo(talking());
  for (const body of [undefined, '', '   ', 7, ['x'], null, 'x'.repeat(501)]) assert.equal((await call('POST', `/api/videos/${v.id}/redact/describe`, { body: body === undefined ? {} : { text: body } })).status, 400, JSON.stringify(body)?.slice(0, 20));
  assert.equal((await call('POST', `/api/videos/${v.id}/redact/describe`, { body: null })).status, 400);
  for (const patch of [{ stage: 'Transcribing 40%' }, { stage: 'Bleeping speech' }, { stage: 'Applying edits 10%' }, { status: 'processing', stage: '' }, { stage: 'Timing every word 30%' }]) {
    const prev = { stage: store.get(v.id).stage, status: store.get(v.id).status }; store.update(v.id, patch);
    try { assert.equal((await describe(v.id, 'bleep my password')).status, 409, JSON.stringify(patch)); } finally { store.update(v.id, prev); }
  }
  const before = snapshot(v.id);
  const r = await describe(v.id, 'you missed my password around 0:03');
  assert.equal(r.status, 200); assert.equal(r.json.understood, true); assert.deepEqual(r.json.proposals.map((p) => p.text), [SECRET]);
  assert.ok(r.json.proposals[0].start >= 2.6 && r.json.proposals[0].end <= 3.5, `${r.json.proposals[0].start}-${r.json.proposals[0].end}`);
  assert.equal(snapshot(v.id), before, 'the video record is untouched');
  const here = await describe(v.id, 'I said my password here', { at: 3.1 }); assert.deepEqual(here.json.proposals.map((p) => p.text), [SECRET]);
  const junk = await describe(v.id, 'bleep my password', { at: 'soon' }); assert.equal(junk.status, 200, 'a playhead that is not a number is ignored');
  const no = await describe(v.id, 'what is the weather'); assert.equal(no.status, 200); assert.equal(no.json.understood, false); assert.ok(no.json.message);
});
test('describe: a topic uses the local model, falls back to the words when it is down, and the model never sees anything it was not sent', async () => {
  const v = await mkVideo(talking());
  Object.assign(fake, { mode: 'ok', answer: { isRequest: true, matches: [{ first: 1, last: 1, words: 'the server is called Atlas', reason: 'Names a server.' }] }, chatCalls: [] });
  const r = (await describe(v.id, 'bleep everything I said about the server')).json;
  assert.equal(r.usedModel, true); assert.deepEqual(r.proposals.map((p) => p.text), ['the server is called Atlas']); assert.equal(fake.chatCalls.length, 1);
  assert.match(JSON.stringify(fake.chatCalls[0]), /UNTRUSTED DATA/);
  fake.mode = 'down';
  store.update(v.id, { words: WORDS.map((w) => (w.w === SECRET ? { ...w, w: `${SECRET}.` } : { ...w })) }); // a full stop makes two sentences, so one of them can be offered
  const d = (await describe(v.id, 'bleep everything I said about the server')).json;
  assert.equal(d.understood, true, d.message); assert.equal(d.usedModel, false); assert.deepEqual(d.proposals.map((p) => p.text), ['and the server is called Atlas thanks']);
  assert.ok(d.notes.some((n) => /Ollama/.test(n)), 'it says why it only matched words');
});
test('apply: validated before anything is touched', async () => {
  const v = await mkVideo(talking()), before = snapshot(v.id), file = path.join(store.videoDir(v.id), 'video.mp4'), size = fs.statSync(file).size;
  for (const body of [{}, { ranges: [] }, { ranges: 'x' }, { ranges: [{ from: 'a', to: 'b' }] }, { ranges: [{ from: 90, to: 99 }] }, { ranges: [{ from: 1, to: 1.05 }] }, { ranges: [{ from: 0, to: 6 }] }, { ranges: Array.from({ length: 201 }, (_, i) => ({ from: i * 0.01, to: i * 0.01 + 0.2 })) }]) {
    const r = await apply(v.id, body); assert.equal(r.status, 400, JSON.stringify(body).slice(0, 50)); assert.ok(r.json.error);
  }
  assert.equal((await call('POST', `/api/videos/${v.id}/redact/apply`, { body: null })).status, 400);
  const mute = await mkVideo(talking(), false); const r = await apply(mute.id, { ranges: RANGE }); assert.equal(r.status, 400); assert.match(r.json.error, /no audio/);
  store.update(v.id, { stage: 'Transcribing 10%' }); assert.equal((await apply(v.id, { ranges: RANGE })).status, 409); store.update(v.id, { stage: 'Timing every word 3%' }); assert.equal((await apply(v.id, { ranges: RANGE })).status, 409, 'a file being read for word timing is not swapped under it'); store.update(v.id, { stage: 'done' });
  assert.equal(snapshot(v.id), before, 'a refused request changes nothing'); assert.equal(fs.statSync(file).size, size);
});
test('apply, undo, apply again, delete the unbleeped copy: the whole life of a bleep, through the real queue', async () => {
  const v = await mkVideo(talking());
  const r = await apply(v.id, { ranges: RANGE, rewriteNotes: false });
  assert.equal(r.status, 202); assert.deepEqual([r.json.parts, r.json.seconds], [1, 0.8]);
  assert.ok(await waitFor(() => store.get(v.id).editPrev?.kind === 'redact' && store.get(v.id).stage === 'done'), `stage: ${store.get(v.id).stage}, error: ${store.get(v.id).editError}`);

  const ed = (await call('GET', `/api/videos/${v.id}/editor`)).json;
  assert.equal(ed.canUndo, true); assert.equal(ed.undoKind, 'redact'); assert.equal(ed.redactResult.parts, 1); assert.equal(ed.speechRedactions, 1);
  assert.equal(ed.transcript, undefined, 'the editor payload does not carry the raw transcript twice'); assert.doesNotMatch(JSON.stringify(ed.segments), new RegExp(SECRET));
  const asViewer = viewModel(store.get(v.id), false); assert.equal(asViewer.undoKind, undefined); assert.equal(asViewer.redactResult, undefined); assert.doesNotMatch(JSON.stringify(asViewer), new RegExp(SECRET));
  assert.equal((await apply(v.id, { ranges: [{ from: 0.1, to: 0.9 }] })).status, 202, 'a second bleep is allowed and replaces the undo'); // and the first one's words are gone for good
  assert.ok(await waitFor(() => store.get(v.id).speechRedactions.length === 2 && store.get(v.id).stage === 'done'));
  assert.doesNotMatch(JSON.stringify(store.get(v.id)), new RegExp(SECRET), 'not even in the undo copy');

  const u = await call('POST', `/api/videos/${v.id}/edits/undo`); assert.equal(u.status, 200); assert.equal(u.json.undoKind, null);
  assert.equal(store.get(v.id).speechRedactions.length, 1, 'back to after the first bleep');

  const fin = await call('POST', `/api/videos/${v.id}/redact/finalize`, { body: {} });
  assert.equal(fin.status, 404, 'there is no unbleeped copy: the first one went when the second bleep replaced it');
  const w = await mkVideo(talking());
  await apply(w.id, { ranges: RANGE, rewriteNotes: false }); assert.ok(await waitFor(() => store.get(w.id).editPrev?.kind === 'redact' && store.get(w.id).stage === 'done'));
  assert.equal((await call('POST', `/api/videos/${w.id}/redact/finalize`, { body: {} })).status, 200);
  assert.equal(store.get(w.id).editPrev, null); assert.ok(!fs.existsSync(path.join(store.videoDir(w.id), 'video.prev.mp4')));
  assert.equal((await call('POST', `/api/videos/${w.id}/edits/undo`)).status, 404, 'no way back');
  for (const f of ['db.json', 'db.json.bak']) { const all = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')).videos; assert.doesNotMatch(JSON.stringify(Array.isArray(all) ? all.find((x) => x.id === w.id) : all[w.id]), new RegExp(SECRET), f); }
});
test('apply with "rewrite the notes" queues the AI crew behind it, and the notes never carry the word in between', async () => {
  const v = await mkVideo(talking());
  const r = await apply(v.id, { ranges: RANGE });
  assert.equal(r.status, 202);
  assert.ok(await waitFor(() => store.get(v.id).editPrev?.kind === 'redact'));
  assert.doesNotMatch(JSON.stringify({ ...store.get(v.id), editPrev: undefined }), new RegExp(SECRET), 'scrubbed at once, before any rewrite');
  assert.ok(await waitFor(() => store.get(v.id).stage === 'done' && store.load().jobs.some((j) => j.videoId === v.id && j.kind === 'ai' && (j.status === 'done' || j.status === 'failed'))), `stage: ${store.get(v.id).stage}`);
  assert.ok(store.load().jobs.some((j) => j.videoId === v.id && j.kind === 'ai'), 'the rewrite ran');
  assert.doesNotMatch(JSON.stringify({ ...store.get(v.id), editPrev: undefined }), new RegExp(SECRET), 'and the rewrite did not bring it back');
});
