// Phase 2 server behaviour: the Privacy Guard gate (423), B6 password message, B11 LAN switch with an open event stream, B12 LLM timeout,
// B17 model status, B18 shared translation, B22 rate limit, and the Server-Sent Events stream behind U3.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// a "model server" that accepts connections and never answers, for the timeout test (must be set before llm.js is loaded)
const HANG_PORT = 41000 + Math.floor(Math.random() * 2000);
const hang = http.createServer(() => {}); hang.listen(HANG_PORT, '127.0.0.1');
process.env.OLLAMA_URL = `http://127.0.0.1:${HANG_PORT}`;

const store = require('../../src/store');
const { withOwner } = require('./owner');
const llm = require('../../src/agents/llm');
const { startServer } = require('../../src/server/server');
const security = require('../../src/server/security');

let srv, port, ready, checking, nopw;
const base = () => ({ host: '127.0.0.1', port });
test.before(async () => {
  store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-p2-')), { log: () => {} });
  ready = store.create({ title: 'Cleared', status: 'ready', shareable: true });
  checking = store.create({ title: 'Being checked', status: 'ready', shareable: false });
  nopw = store.create({ title: 'No password', status: 'ready', shareable: true, privacy: { mode: 'password' } });
  for (const v of [ready, checking, nopw]) fs.writeFileSync(path.join(store.videoDir(v.id), 'video.mp4'), 'not really a video');
  srv = startServer({ port: 0, models: fs.mkdtempSync(path.join(os.tmpdir(), 'spool-models-')) }); port = await srv.ready;
});
test.after(async () => { await srv.close(); hang.close(); hang.closeAllConnections?.(); store.close(); });

function call(method, url, { headers = {}, body, host, p, noOwner } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: p || port, method, path: url, headers: { Host: host || `127.0.0.1:${p || port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(noOwner ? headers : withOwner(headers, host || p || port)) } }, (res) => {
      let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, headers: res.headers, text: buf, json }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const asViewer = { 'x-forwarded-for': '203.0.113.9' }; // "came through a proxy": the owner check refuses these, so they are treated as a viewer
const token = async (p) => (await call('GET', '/api/me', { p })).json.csrf;

test('the Privacy Guard gate: a viewer gets 423 for the page data, the video, the thumbnail and the download while the guard is still checking', async () => {
  for (const u of [`/api/v/${checking.id}`, `/media/${checking.id}/video.mp4`, `/media/${checking.id}/thumb.jpg`, `/media/${checking.id}/download`, `/api/v/${checking.id}/track`]) {
    const r = await call('GET', u, { headers: asViewer }); assert.equal(r.status, 423, u);
  }
  assert.equal((await call('GET', `/api/v/${checking.id}`, { headers: asViewer })).json.gate, 'checking');
  assert.equal((await call('GET', `/api/v/${ready.id}`, { headers: asViewer })).status, 200, 'a cleared video is open');
});

test('the owner is never blocked: the video is served while the guard is still checking', async () => {
  const v = await call('GET', `/media/${checking.id}/video.mp4`); assert.equal(v.status, 200);
  const m = await call('GET', `/api/v/${checking.id}`); assert.equal(m.status, 200); assert.equal(m.json.shareable, false, 'the owner page can say "Privacy Guard is checking"');
  assert.equal((await call('GET', `/api/v/${ready.id}`)).json.shareable, true);
});

test('R7: a record with no shareable flag is closed (423), and the link preview of a checked video leaks nothing', async () => {
  const old = store.create({ title: 'Old one', status: 'ready' }); fs.writeFileSync(path.join(store.videoDir(old.id), 'video.mp4'), 'x');
  assert.equal((await call('GET', `/media/${old.id}/video.mp4`, { headers: asViewer })).status, 423);
  const page = await call('GET', `/v/${checking.id}`, { headers: asViewer });
  assert.doesNotMatch(page.text, /Being checked/); assert.doesNotMatch(page.text, /og:video/);
});

test('B6: a video set to "password" with no password says so, to viewers only', async () => {
  const r = await call('GET', `/api/v/${nopw.id}`, { headers: asViewer }); assert.equal(r.status, 403); assert.equal(r.json.gate, 'nopassword');
  assert.equal((await call('GET', `/api/v/${nopw.id}`)).status, 200, 'the owner can still open it to fix it');
});

test('B6: "password" is not accepted as the workspace default', async () => {
  const t = await token();
  const bad = await call('PUT', '/api/settings', { headers: { 'x-spool-csrf': t }, body: { defaultPrivacy: 'password' } }); assert.equal(bad.status, 400);
  assert.equal((await call('PUT', '/api/settings', { headers: { 'x-spool-csrf': t }, body: { defaultPrivacy: 'email' } })).status, 200);
  await call('PUT', '/api/settings', { headers: { 'x-spool-csrf': t }, body: { defaultPrivacy: 'link' } });
});

test('B22: a viewer address is limited to a burst of 20 writes; the owner is not', async () => {
  const hits = []; for (let i = 0; i < 26; i++) hits.push((await call('POST', `/api/v/${ready.id}/reactions`, { headers: asViewer, body: { kind: 'good', at: 1 } })).status);
  assert.equal(hits.filter((s) => s === 200).length, 20); assert.equal(hits.filter((s) => s === 429).length, 6);
  const t = await token(); const owner = []; for (let i = 0; i < 26; i++) owner.push((await call('POST', `/api/v/${ready.id}/reactions`, { headers: { 'x-spool-csrf': t }, body: { kind: 'good', at: 1 } })).status);
  assert.ok(owner.every((s) => s === 200));
});

test('B22: the limiter refills over time (fake clock)', () => {
  let now = 0; const lim = security.rateLimit({ burst: 3, perSec: 1, now: () => now }); const req = { socket: { remoteAddress: 'a' } };
  const hit = () => { let out = 'ok'; lim(req, { setHeader() {}, status() { return { json() { out = 429; } }; } }, () => {}); return out; };
  assert.deepEqual([hit(), hit(), hit(), hit()], ['ok', 'ok', 'ok', 429]);
  now = 2000; assert.deepEqual([hit(), hit(), hit()], ['ok', 'ok', 429], 'two seconds later, two more writes are allowed');
});

// These come after B22 on purpose: viewer writes share one limiter bucket per address, and B22 needs it full. Most use the owner (who is not limited); the one
// that needs a real viewer waits for the bucket to refill first.
const ownerReact = async (id, body) => call('POST', `/api/v/${id}/reactions`, { headers: { 'x-spool-csrf': await token() }, body });

test('reactions: typed markers only; unknown kinds, emoji and prototype keys are refused and change nothing', async () => {
  const r = store.create({ title: 'Reacts', status: 'ready', shareable: true, duration: 10 });
  for (const body of [{ emoji: '\u{1F44D}' }, { kind: '\u{1F44D}' }, { kind: '__proto__' }, { kind: 'constructor' }, { kind: 'toString' }, { kind: 'GOOD' }, { kind: ['good'] }, { kind: 7 }, {}]) {
    const res = await ownerReact(r.id, body);
    assert.equal(res.status, 400, JSON.stringify(body)); assert.match(res.json.error, /good, question, issue, idea, key/);
  }
  const after = store.get(r.id); assert.deepEqual(after.reactions, {}); assert.deepEqual(after.reactionEvents, []);
});

test('reactions: counts and timeline events; the time is clamped to the video; the owner is not notified of their own', async () => {
  const r = store.create({ title: 'Reacts 2', status: 'ready', shareable: true, duration: 10 });
  const n0 = (await call('GET', '/api/notifications')).json.length;
  const a = await ownerReact(r.id, { kind: 'question', at: 3.14159, name: 'Sam' }); assert.equal(a.status, 200);
  await ownerReact(r.id, { kind: 'question', at: -5 }); await ownerReact(r.id, { kind: 'idea', at: 99 }); await ownerReact(r.id, { kind: 'key' });
  const m = (await call('GET', `/api/v/${r.id}`, { headers: asViewer })).json;
  assert.deepEqual(m.reactions, { question: 2, idea: 1, key: 1 });
  assert.deepEqual(m.reactionEvents.map((e) => [e.kind, e.at]), [['question', 3.142], ['question', 0], ['idea', 10], ['key', 0]]);
  assert.equal(m.reactionEvents[0].by, undefined, 'a viewer sees when and what, never who');
  const mo = (await call('GET', `/api/v/${r.id}`)).json;
  assert.equal(mo.reactionEvents[0].by, 'Sam', 'the owner sees who');
  assert.equal(a.json.reactions.question, 1, 'the reply is the updated view model');
  assert.equal((await call('GET', '/api/notifications')).json.length, n0, 'the owner reacting to their own video makes no notification');
});

test('reactions: a viewer\'s notification names the kind in words, with no emoji, and an unknown kind from a viewer is refused', async () => {
  const r = store.create({ title: 'Reacts 3', status: 'ready', shareable: true, duration: 120 });
  await wait(1300); // refill the viewer bucket after B22
  assert.equal((await call('POST', `/api/v/${r.id}/reactions`, { headers: asViewer, body: { emoji: '\u{1F44D}' } })).status, 400);
  const ok = await call('POST', `/api/v/${r.id}/reactions`, { headers: asViewer, body: { kind: 'issue', at: 65, name: 'Pat' } }); assert.equal(ok.status, 200);
  const n = (await call('GET', '/api/notifications')).json.find((x) => x.videoId === r.id && x.type === 'reaction');
  assert.ok(n, 'a notification exists'); assert.equal(n.by, 'Pat'); assert.equal(n.t, 65);
  assert.match(n.text, /^marked this as Problem at 1:05$/);
  assert.doesNotMatch(JSON.stringify(n), /\p{Extended_Pictographic}/u);
});

test('reactions: old emoji reactions in a recording are hidden from viewers and the owner, and never counted', async () => {
  const r = store.create({ title: 'Legacy', status: 'ready', shareable: true, duration: 10 });
  store.update(r.id, { reactions: { '\u{1F44D}': 4, good: 2, bogus: 9 }, reactionEvents: [{ emoji: '\u{1F44D}', at: 1 }, { kind: 'good', at: 2, by: 'A' }, { kind: 'bogus', at: 3 }, null] });
  for (const headers of [asViewer, {}]) {
    const m = (await call('GET', `/api/v/${r.id}`, { headers })).json;
    assert.deepEqual(m.reactions, { good: 2 }); assert.deepEqual(m.reactionEvents.map((e) => [e.kind, e.at]), [['good', 2]]);
    assert.doesNotMatch(JSON.stringify(m), /\p{Extended_Pictographic}/u);
  }
  assert.equal((await ownerReact(r.id, { kind: 'good', at: 4 })).json.reactions.good, 3);
  assert.equal(store.get(r.id).reactions['\u{1F44D}'], 4, 'the old data stays in the file; it is just not shown');
});

function events(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: url, headers: { Host: `127.0.0.1:${port}`, ...withOwner(headers, port) } }, (res) => {
      const out = { status: res.statusCode, chunks: [], req, res };
      res.setEncoding('utf8'); res.on('data', (d) => out.chunks.push(d)); resolve(out);
    }); req.on('error', reject);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('U3: the event stream announces a change to the video it watches, coalesces bursts, and ignores other videos', async () => {
  const s = await events(`/api/events?video=${ready.id}`); assert.equal(s.status, 200);
  for (let i = 0; i < 5; i++) store.update(ready.id, { stage: `step ${i}` });
  store.update(checking.id, { stage: 'other video' });
  await wait(450);
  const text = s.chunks.join(''), data = [...text.matchAll(/event: video\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]));
  assert.equal(data.length, 1, 'five quick updates are one event'); assert.deepEqual(data[0].ids, [ready.id]);
  s.req.destroy();
});

test('U3: the event stream respects the gate (423 while checking for viewers) and the library stream is owner-only', async () => {
  const g = await events(`/api/events?video=${checking.id}`, asViewer); assert.equal(g.status, 423); g.req.destroy();
  const lib = await events('/api/events', asViewer); assert.equal(lib.status, 403); lib.req.destroy();
  const own = await events('/api/events'); assert.equal(own.status, 200);
  store.update(ready.id, { stage: 'x' }); await wait(450); assert.match(own.chunks.join(''), /event: video/); own.req.destroy();
});

test('B11: switching "People on my network" completes even with an event stream open (it used to wait for keep-alive connections forever)', async () => {
  const s = await events('/api/events'); const t = await token();
  const r = await call('PUT', '/api/settings', { headers: { 'x-spool-csrf': t }, body: { lan: true } }); assert.equal(r.status, 200);
  await wait(900);
  const p2 = srv.server.address().port; assert.ok(p2 > 0);
  const me = await call('GET', '/api/me', { p: p2, headers: { Host: `127.0.0.1:${p2}` } }); assert.equal(me.status, 200, 'the new listener answers');
  s.req.destroy(); port = p2;
  const t2 = await token(); await call('PUT', '/api/settings', { headers: { 'x-spool-csrf': t2 }, body: { lan: false } });
  await wait(900); port = srv.server.address().port; assert.equal((await call('GET', '/api/me')).status, 200);
});

test('B17: model status reports what is on disk, and the speech model is not there in an empty folder', async () => {
  const m = await call('GET', '/api/models'); assert.equal(m.status, 200);
  assert.equal(m.json.speech.cached, false); assert.equal(m.json.speech.model, 'Xenova/whisper-base'); assert.equal(m.json.speech.download.state, 'idle');
  assert.equal(typeof m.json.ollama.available, 'boolean');
});

test('B12: a model that never answers fails after the timeout (once retried) instead of hanging the agent', async () => {
  const t0 = Date.now();
  await assert.rejects(llm.json({ system: 's', user: 'u', timeoutMs: 150, retries: 1 }), /did not answer within/);
  const took = Date.now() - t0; assert.ok(took >= 280 && took < 2500, `two attempts of 150 ms, took ${took} ms`);
  const t1 = Date.now(); await assert.rejects(llm.json({ system: 's', user: 'u', timeoutMs: 150, retries: 0 })); assert.ok(Date.now() - t1 < 600, 'retries: 0 means a single try');
});

test('B18: two requests for the same translation share one run', async () => {
  const extras = require('../../src/server/extras');
  const v = store.create({ title: 'Talk', status: 'ready', segments: [{ start: 0, end: 1, text: 'hello' }] });
  const a = extras.translateSegments(v, 'French'), b = extras.translateSegments(v, 'french');
  assert.equal(extras.inflightCount(), 1, 'one shared promise, case-insensitive');
  assert.strictEqual(a, b);
  await a.catch(() => {}); await wait(5); assert.equal(extras.inflightCount(), 0, 'cleared when done');
});
