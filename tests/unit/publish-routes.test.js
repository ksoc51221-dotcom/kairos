// Public links over HTTP: owner-only, CSRF, refusal statuses, secrets masked, the privacy / removal hooks. Backblaze is the in-process fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../src/store');
const publisher = require('../../src/publish/publisher');
const { createB2 } = require('../../src/publish/b2');
const { withOwner } = require('./owner');
const { startServer } = require('../../src/server/server');
const { createFakeB2 } = require('./fake-b2');

const WORKER = 'https://links.example.workers.dev';
let srv, port, csrf, fake, v;
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(32)]);

test.before(async () => {
  store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-pubr-')), { log: () => {} });
  publisher.deps.log = () => {};
  publisher.deps.encode = async (i, o) => fs.copyFileSync(i, o);
  publisher.deps.poster = async (_i, o) => fs.writeFileSync(o, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fake = await createFakeB2().start();
  publisher.deps.makeB2 = (c) => createB2({ keyId: c.keyId, key: c.key, bucket: c.bucket, authUrl: fake.url, sleep: async () => {}, retries: 1 });
  srv = startServer({ port: 0 }); port = await srv.ready;
  csrf = (await call('GET', '/api/me')).json.csrf;
});
test.after(async () => { await publisher.idle(); publisher.stop(); await srv.close(); await fake.stop(); store.close(); });
const call = (method, url, { headers = {}, body, noCsrf } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: `127.0.0.1:${port}`, ...(csrf && !noCsrf && method !== 'GET' ? { 'x-spool-csrf': csrf } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...withOwner(headers, port) } }, (res) => {
    let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, text: buf, json }); });
  });
  req.on('error', reject); if (data) req.write(data); req.end();
});
const mk = (extra = {}) => { const x = store.create({ title: 'Demo', status: 'ready', shareable: true, guard: { model: true, speech: 'checked' }, duration: 2, ...extra }); fs.writeFileSync(path.join(store.videoDir(x.id), 'video.mp4'), MP4); return x; };
const names = () => fake.list().map((f) => f.name);
const outsider = { 'x-forwarded-for': '203.0.113.9' };
const setup = (extra = {}) => call('PUT', '/api/settings', { body: { integrations: { publish: { workerUrl: WORKER, bucket: fake.cfg.bucket, accessId: 'write-key-id', appKey: 'write-key-secret', ...extra } } } });

test('nothing is possible for someone who is not the owner, or without the CSRF token', async () => {
  v = mk();
  for (const [m, u] of [['GET', '/api/publish/status'], ['POST', '/api/publish/test'], ['POST', '/api/publish/remove-all'], ['GET', `/api/videos/${v.id}/publish`], ['POST', `/api/videos/${v.id}/publish`], ['DELETE', `/api/videos/${v.id}/publish`]])
    assert.equal((await call(m, u, { headers: outsider, body: m === 'GET' ? undefined : { mode: 'link', confirm: true } })).status, 403, `${m} ${u}`);
  assert.equal((await call('POST', `/api/videos/${v.id}/publish`, { noCsrf: true, body: { mode: 'link', confirm: true } })).status, 403);
  assert.equal(fake.calls.length, 0);
});

test('not set up: status says so, publish is refused', async () => {
  assert.equal((await call('GET', '/api/publish/status')).json.configured, false);
  const r = await call('POST', `/api/videos/${v.id}/publish`, { body: { mode: 'link', confirm: true } });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'not_configured');
});

test('settings: the Worker address is checked, the write key is masked and survives a save of the masked value', async () => {
  const bad = await call('PUT', '/api/settings', { body: { integrations: { publish: { workerUrl: 'http://evil.example' } } } });
  assert.equal(bad.status, 400); assert.match(bad.json.error, /https/);
  assert.equal((await setup()).status, 200);
  const s = (await call('GET', '/api/settings')).json.integrations.publish;
  assert.equal(s.workerUrl, WORKER); assert.equal(s.accessId, 'write-key-id'); assert.match(s.appKey, /^••••/); assert.ok(!JSON.stringify(s).includes('write-key-secret'));
  await call('PUT', '/api/settings', { body: { integrations: { publish: { appKey: s.appKey, bucket: fake.cfg.bucket } } } });
  assert.equal(store.getSettings().integrations.publish.appKey, 'write-key-secret', 'the masked value never overwrites the real key');
  assert.equal((await call('GET', '/api/publish/status')).json.configured, true);
});

test('publish needs the explicit confirmation, and refusals come back with a code and the right status', async () => {
  assert.equal((await call('POST', `/api/videos/${v.id}/publish`, { body: { mode: 'link' } })).json.code, 'confirm');
  const priv = mk({ privacy: { mode: 'private' } }), unscanned = mk({ guard: undefined }), big = mk();
  let r = await call('POST', `/api/videos/${priv.id}/publish`, { body: { mode: 'link', confirm: true } });
  assert.deepEqual([r.status, r.json.code], [403, 'private']);
  r = await call('POST', `/api/videos/${unscanned.id}/publish`, { body: { mode: 'link', confirm: true } });
  assert.deepEqual([r.status, r.json.code], [409, 'no_guard']);
  r = await call('POST', `/api/videos/${big.id}/publish`, { body: { mode: 'password', password: 'short', confirm: true } });
  assert.deepEqual([r.status, r.json.code], [400, 'need_password']);
  assert.equal((await call('POST', '/api/videos/nope/publish', { body: { mode: 'link', confirm: true } })).status, 404);
  assert.equal(fake.uploads.length, 0);
});

test('publish returns 202 and the view model of every owner list carries the summary, without secrets', async () => {
  const r = await call('POST', `/api/videos/${v.id}/publish`, { body: { mode: 'password', password: 'twelve chars!', confirm: true } });
  assert.equal(r.status, 202); assert.equal(r.json.state, 'working'); assert.equal(r.json.url, undefined);
  await publisher.idle();
  const s = (await call('GET', `/api/videos/${v.id}/publish`)).json;
  assert.equal(s.state, 'live'); assert.match(s.url, new RegExp(`^${WORKER}/v/[A-Za-z0-9_-]{22}$`)); assert.equal(s.mode, 'password');
  const listed = (await call('GET', '/api/videos')).json.find((x) => x.id === v.id);
  assert.equal(listed.publish.url, s.url);
  assert.ok(!JSON.stringify(listed).match(/twelve chars|"salt"|"check"/));
  // a viewer (not the owner) never gets the publish block or the public link
  const viewer = (await call('GET', `/api/videos/${v.id}`, { headers: outsider })).text;
  assert.ok(!viewer.includes(s.url));
});

test('changing the video to Private through the normal route takes the public copy down', async () => {
  assert.equal(names().length, 3);
  const r = await call('PATCH', `/api/videos/${v.id}`, { body: { privacy: { mode: 'private' } } });
  assert.equal(r.status, 200);
  await publisher.idle(); await publisher.drainQueue();
  assert.equal(publisher.summary(store.get(v.id)).state, 'removed'); assert.deepEqual(names(), []);
});

test('the workspace default turning private takes down links on videos with no choice of their own', async () => {
  const w = mk(); await call('POST', `/api/videos/${w.id}/publish`, { body: { mode: 'link', confirm: true } }); await publisher.idle();
  assert.equal(store.get(w.id).publish.state, 'live');
  await call('PUT', '/api/settings', { body: { defaultPrivacy: 'private' } });
  for (let i = 0; i < 50 && store.get(w.id).publish?.state === 'live'; i++) await new Promise((r) => setTimeout(r, 20));
  await publisher.drainQueue();
  assert.equal(store.get(w.id).publish.state, 'removed'); assert.deepEqual(names(), []);
  await call('PUT', '/api/settings', { body: { defaultPrivacy: 'link' } });
});

test('DELETE unpublishes; deleting the video removes the copy through the same queue', async () => {
  const a = mk(); await call('POST', `/api/videos/${a.id}/publish`, { body: { mode: 'link', confirm: true } }); await publisher.idle();
  const d = await call('DELETE', `/api/videos/${a.id}/publish`); assert.equal(d.status, 200); assert.equal(d.json.state, 'none'); assert.deepEqual(names(), []);
  const b = mk(); await call('POST', `/api/videos/${b.id}/publish`, { body: { mode: 'link', confirm: true } }); await publisher.idle();
  assert.equal(names().length, 3);
  assert.equal((await call('DELETE', `/api/videos/${b.id}`)).status, 204);
  await publisher.drainQueue(); assert.deepEqual(names(), []);
});

test('remove-all asks for the word REMOVE', async () => {
  const a = mk(); await call('POST', `/api/videos/${a.id}/publish`, { body: { mode: 'link', confirm: true } }); await publisher.idle();
  assert.equal((await call('POST', '/api/publish/remove-all', { body: {} })).status, 400); assert.equal(names().length, 3);
  const r = await call('POST', '/api/publish/remove-all', { body: { confirm: 'REMOVE' } });
  assert.equal(r.status, 200); assert.deepEqual(names(), []); assert.equal(store.get(a.id).publish, null);
});

test('status reports the storage meter', async () => {
  const s = (await call('GET', '/api/publish/status')).json;
  assert.equal(s.cap, 9e9); assert.equal(s.live, 0); assert.equal(s.lifetimeDays, 30);
});

test('a viewer of the local link never learns that a public link exists', async () => {
  const w = mk(); await call('POST', `/api/videos/${w.id}/publish`, { body: { mode: 'link', confirm: true } }); await publisher.idle();
  const url = store.get(w.id).publish.url;
  const viewer = await call('GET', `/api/v/${w.id}`, { headers: outsider });
  assert.equal(viewer.status, 200); assert.equal(viewer.json.publish, undefined); assert.ok(!viewer.text.includes(url) && !viewer.text.includes(WORKER));
  const page = await call('GET', `/v/${w.id}`, { headers: outsider }); assert.ok(!page.text.includes(WORKER));
  assert.equal((await call('GET', `/api/videos/${w.id}/publish`, { headers: outsider })).status, 403);
});
