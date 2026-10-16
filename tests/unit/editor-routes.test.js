// The editor's HTTP surface, headless: owner-only access, draft edits are sanitised and saved, the page itself is served. No windows, no Whisper.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../src/store');
const { withOwner } = require('./owner');
const { startServer } = require('../../src/server/server');
const { runFfmpeg } = require('../../src/pipeline/encode');

let srv, port, v, other, csrf;
test.before(async () => {
  store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-edr-')), { log: () => {} });
  v = store.create({ title: 'Main', status: 'ready', shareable: true, duration: 6 });
  other = store.create({ title: 'Other', status: 'ready', shareable: true, duration: 3 });
  for (const [x, s] of [[v, 6], [other, 3]]) await runFfmpeg(['-y', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=15:duration=${s}`, '-f', 'lavfi', '-i', `sine=frequency=300:duration=${s}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(store.videoDir(x.id), 'video.mp4')]);
  srv = startServer({ port: 0, models: fs.mkdtempSync(path.join(os.tmpdir(), 'spool-m-')) }); port = await srv.ready;
  csrf = (await call('GET', '/api/me')).json.csrf;
});
test.after(async () => { await srv.close(); store.close(); });
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
  const page = await call('GET', `/edit/${v.id}`); assert.equal(page.status, 200); assert.match(page.text, /Edit · Iris/);
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
