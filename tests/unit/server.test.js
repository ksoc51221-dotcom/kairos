// Starts the real server on a free port and sends it hand-made requests (cross-site, wrong origin, no token, preview-as-viewer).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../src/store');
const { withOwner } = require('./owner');
const { startServer } = require('../../src/server/server');

let srv, port, video;

test.before(async () => {
  store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-srv-')), { log: () => {} });
  video = store.create({ title: 'Test', status: 'ready' });
  fs.writeFileSync(path.join(store.videoDir(video.id), 'timeline.json'), JSON.stringify({ screen: { width: 2880, height: 1800 }, cursor: [[0, 0.1, 0.2]], clicks: [[1.5, 0.5, 0.6, 1]] }));
  srv = startServer({ port: 0 }); port = await srv.ready;
});
test.after(async () => { await srv.close(); store.close(); });

function call(method, url, { headers = {}, body, host, noOwner } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: host || `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(noOwner ? headers : withOwner(headers, host || port)) } }, (res) => {
      let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, headers: res.headers, text: buf, json }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const token = async () => (await call('GET', '/api/me')).json.csrf;
const withToken = async (extra = {}) => ({ 'x-spool-csrf': await token(), ...extra });

test('the owner gets a per-launch token from /api/me; other hosts get none', async () => {
  const me = await call('GET', '/api/me');
  assert.equal(me.json.owner, true); assert.match(me.json.csrf, /^[0-9a-f]{48}$/);
  const other = await call('GET', '/api/me', { host: 'evil.example' });
  assert.equal(other.json.owner, false); assert.equal(other.json.csrf, undefined);
});

test('B5: an owner write without the token is refused', async () => {
  const r = await call('POST', '/api/folders', { body: { name: 'x' } });
  assert.equal(r.status, 403); assert.match(r.json.error, /CSRF/);
  const wrong = await call('POST', '/api/folders', { body: { name: 'x' }, headers: { 'x-spool-csrf': 'a'.repeat(48) } });
  assert.equal(wrong.status, 403);
});

test('B5: an owner write with the token works', async () => {
  const r = await call('POST', '/api/folders', { body: { name: 'Docs' }, headers: await withToken() });
  assert.equal(r.status, 200); assert.equal(r.json.name, 'Docs');
});

test('B5: cross-site writes are blocked even with a valid token', async () => {
  for (const h of [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://evil.example' }, { origin: 'null' }, { origin: 'http://localhost:9999' }]) {
    const r = await call('POST', '/api/folders', { body: { name: 'pwn' }, headers: await withToken(h) });
    assert.equal(r.status, 403, JSON.stringify(h)); assert.match(r.json.error, /cross-site/);
  }
  assert.ok(!store.load().folders || !Object.values(store.load().folders).some((f) => f.name === 'pwn'), 'nothing was created');
});

test('B5: simple cross-site POST to the rerun/notification routes (the original attack) is blocked', async () => {
  for (const url of [`/api/videos/${video.id}/rerun`, '/api/notifications/read']) {
    const r = await call('POST', url, { headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, body: {} });
    assert.equal(r.status, 403, url);
  }
  const d = await call('DELETE', `/api/videos/${video.id}`, { headers: { origin: 'https://evil.example' } });
  assert.equal(d.status, 403); assert.ok(store.get(video.id), 'the video is still there');
});

test('B5: same-origin requests pass (Fetch Metadata and Origin forms)', async () => {
  for (const h of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, { origin: `http://127.0.0.1:${port}` }]) {
    const r = await call('POST', '/api/folders', { body: { name: 'ok' }, headers: await withToken(h) });
    assert.equal(r.status, 200, JSON.stringify(h));
  }
});

test('B5: viewer routes only need the origin check, not the token', async () => {
  const ok = await call('POST', `/api/v/${video.id}/comments`, { body: { text: 'hi', at: 1 }, headers: { 'sec-fetch-site': 'same-origin' }, host: 'localhost:' + port });
  assert.equal(ok.status, 200);
  const bad = await call('POST', `/api/v/${video.id}/comments`, { body: { text: 'spam', at: 1 }, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(bad.status, 403);
});

test('B5: /view-as flips a cookie on GET, so it checks the origin too', async () => {
  const bad = await call('GET', '/view-as/viewer', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(bad.status, 403);
  const ok = await call('GET', '/view-as/viewer', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(ok.status, 302); assert.match(ok.headers['set-cookie'][0], /sp_asviewer=1/);
});

test('B14: while previewing as a viewer, "/" shows a way back instead of raw JSON', async () => {
  const r = await call('GET', '/', { headers: { cookie: 'sp_asviewer=1' } });
  assert.equal(r.status, 200); assert.match(r.headers['content-type'], /html/);
  assert.match(r.text, /previewing as a viewer/i); assert.match(r.text, /href="\/stop-viewing-as"/);
  const owner = await call('GET', '/'); assert.equal(owner.status, 200); assert.doesNotMatch(owner.text, /previewing as a viewer/i);
  const settings = await call('GET', '/settings', { headers: { cookie: 'sp_asviewer=1' } }); assert.match(settings.text, /previewing as a viewer/i);
  const api = await call('GET', '/api/videos', { headers: { cookie: 'sp_asviewer=1' } }); assert.equal(api.status, 403, 'the API stays closed');
});

test('B14: a real outside visitor still gets nothing from "/"', async () => {
  const r = await call('GET', '/', { host: 'evil.example', headers: { cookie: 'sp_asviewer=1' } });
  assert.equal(r.status, 403); assert.doesNotMatch(r.text, /previewing/i);
});

test('the player gets cursor and clicks from timeline.json in the old shape', async () => {
  const r = await call('GET', `/api/v/${video.id}/track`);
  assert.deepEqual(r.json.cursor, [[0, 0.1, 0.2]]);
  assert.deepEqual(r.json.clicks, [{ t: 1.5, x: 0.5, y: 0.6, button: 1 }]);
});

test('only the embed player may be framed by other sites', async () => {
  assert.equal((await call('GET', '/api/me')).headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal((await call('GET', `/embed/${video.id}`)).headers['x-frame-options'], undefined);
});
