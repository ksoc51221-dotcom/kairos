// Publish to GitHub over HTTP: owner-only, the token is masked, refusal statuses, the test button, publish and removal. GitHub is the in-process fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../src/store');
const publisher = require('../../src/publish/publisher');
const { createGitHub } = require('../../src/publish/github');
const { withOwner } = require('./owner');
const { startServer } = require('../../src/server/server');
const { createFakeGitHub } = require('./fake-github');

let srv, port, csrf, fake;
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(32)]);

test.before(async () => {
  store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-pubghr-')), { log: () => {} });
  publisher.deps.log = () => {};
  publisher.deps.encode = async (i, o) => fs.copyFileSync(i, o);
  publisher.deps.poster = async (_i, o) => fs.writeFileSync(o, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fake = createFakeGitHub();
  publisher.deps.makeGitHub = (c) => createGitHub({ token: c.token, fetch: fake.fetch, sleep: async () => {}, pollMs: 0, retries: 1 });
  publisher.deps.ghToken = () => '';
  srv = startServer({ port: 0 }); port = await srv.ready;
  csrf = (await call('GET', '/api/me')).json.csrf;
});
test.after(async () => { await publisher.idle(); publisher.stop(); await srv.close(); store.close(); });
const call = (method, url, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: `127.0.0.1:${port}`, ...(csrf && method !== 'GET' ? { 'x-spool-csrf': csrf } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...withOwner(headers, port) } }, (res) => {
    let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, json }); });
  });
  req.on('error', reject); if (data) req.write(data); req.end();
});
const mk = (extra = {}) => { const x = store.create({ title: 'Demo', status: 'ready', shareable: true, guard: { model: true, speech: 'checked' }, duration: 2, ...extra }); fs.writeFileSync(path.join(store.videoDir(x.id), 'video.mp4'), MP4); return x; };
const outsider = { 'x-forwarded-for': '203.0.113.9' };

test('the token is saved on this Mac, masked when read back, and a masked value never overwrites it', async () => {
  assert.equal((await call('PUT', '/api/settings', { body: { integrations: { github: { token: fake.cfg.token, useGh: false } } } })).status, 200);
  const g = (await call('GET', '/api/settings')).json.integrations.github;
  assert.match(g.token, /^••••/); assert.ok(!JSON.stringify(g).includes(fake.cfg.token));
  await call('PUT', '/api/settings', { body: { integrations: { github: { token: g.token, useGh: true } } } }); // the form sends back what it was shown
  assert.equal(publisher.githubConfig().token, fake.cfg.token);
  assert.equal(store.getSettings().integrations.github.useGh, true);
  await call('PUT', '/api/settings', { body: { integrations: { github: { useGh: false } } } });
});

test('the GitHub test and publishing are owner-only', async () => {
  const v = mk();
  assert.equal((await call('POST', '/api/publish/test', { headers: outsider, body: { host: 'github' } })).status, 403);
  assert.equal((await call('POST', `/api/videos/${v.id}/publish`, { headers: outsider, body: { host: 'github', mode: 'link', confirm: true } })).status, 403);
  assert.equal(fake.calls.length, 0);
});

test('the test button reports sign-in and permissions, and creates nothing', async () => {
  const r = (await call('POST', '/api/publish/test', { body: { host: 'github' } })).json;
  assert.equal(r.ok, true); assert.deepEqual(r.steps.map((s) => s.name), ['Token', 'Sign-in', 'Can create repositories', 'Can delete repositories']);
  assert.match(r.steps[1].detail, /octo/);
  assert.equal(fake.repos.size, 0);
  fake.cfg.scopes = ['repo'];
  const w = (await call('POST', '/api/publish/test', { body: { host: 'github' } })).json;
  assert.equal(w.ok, false); assert.match(w.steps[3].detail, /delete_repo/);
  fake.cfg.scopes = ['repo', 'delete_repo'];
});

test('publishing needs the confirmation; refusals use clear statuses; success is 202 and then live; DELETE removes the repository', async () => {
  const v = mk();
  assert.equal((await call('POST', `/api/videos/${v.id}/publish`, { body: { host: 'github', mode: 'link' } })).status, 400);
  const pwd = mk({ privacy: { mode: 'password', passwordHash: 'aa:bb' } });
  const r1 = await call('POST', `/api/videos/${pwd.id}/publish`, { body: { host: 'github', mode: 'link', confirm: true } });
  assert.equal(r1.status, 403); assert.equal(r1.json.code, 'github_password');
  const r2 = await call('POST', `/api/videos/${v.id}/publish`, { body: { host: 'github', mode: 'password', password: 'longenough1', confirm: true } });
  assert.equal(r2.status, 400); assert.equal(r2.json.code, 'bad_mode');
  assert.equal(fake.repos.size, 0);

  const ok = await call('POST', `/api/videos/${v.id}/publish`, { body: { host: 'github', mode: 'link', confirm: true } });
  assert.equal(ok.status, 202); assert.equal(ok.json.host, 'github');
  await publisher.idle();
  const s = (await call('GET', `/api/videos/${v.id}/publish`)).json;
  assert.equal(s.state, 'live'); assert.match(s.url, /^https:\/\/octo\.github\.io\/kairos-share-/); assert.ok(s.repoUrl);
  assert.equal(fake.publicRepos().length, 1);
  const d = (await call('DELETE', `/api/videos/${v.id}/publish`)).json;
  assert.equal(d.removal, 'done'); assert.equal(fake.repos.size, 0);
});

test('an unknown "host" falls back to the Backblaze route, which is not set up here', async () => {
  const v = mk();
  const r = await call('POST', `/api/videos/${v.id}/publish`, { body: { host: 'dropbox', mode: 'link', confirm: true } });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'not_configured'); assert.equal(fake.repos.size, 0);
});

test('the status endpoint counts GitHub links separately and lists repositories that could not be deleted', async () => {
  const st = (await call('GET', '/api/publish/status')).json;
  assert.equal(st.github.configured, true); assert.equal(st.github.live, 0); assert.deepEqual(st.github.errors, []);
});
