// REVIEW.md findings R1–R9 and R11: each fix has a test that fails without it.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('../../src/store');
const auth = require('../../src/server/auth');
const security = require('../../src/server/security');
const privacy = require('../../src/agents/privacy');
const ocr = require('../../src/agents/ocr');
const { startServer } = require('../../src/server/server');
const orchestrator = require('../../src/agents/orchestrator');
const { withOwner } = require('./owner');

let srv, port, dir;
const mk = (fields, files = {}) => { const v = store.create({ status: 'ready', title: 'T', ...fields }); for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(store.videoDir(v.id), f), c); return v; };
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-sec-'));
  store.init(dir, { log: () => {} });
  srv = startServer({ port: 0, models: dir }); port = await srv.ready;
});
test.after(async () => { await srv.close(); store.close(); });

function call(method, url, { headers = {}, body, owner = true } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(owner ? withOwner(headers, port) : headers) } }, (res) => {
      let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, headers: res.headers, text: buf, json }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const viewer = { 'x-forwarded-for': '203.0.113.9' };

// ---- R1 ----
test('R1: loopback plus a Host header is not enough to be the owner; the owner cookie is', async () => {
  const bare = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:4747' } };
  assert.equal(auth.isOwner(bare), false, 'a raw TCP tunnel looks exactly like this');
  assert.equal(auth.isOwner({ ...bare, headers: { ...bare.headers, cookie: 'sp_owner=guess' } }), false);
  assert.equal(auth.isOwner({ ...bare, headers: { ...bare.headers, cookie: withOwner({}, 'localhost:4747').cookie } }), true);
  assert.equal(auth.isOwner({ ...bare, headers: { ...bare.headers, cookie: withOwner({}, 'localhost:4747').cookie, 'x-forwarded-for': '1.2.3.4' } }), false, 'cookie plus proxy header: still no');
  assert.equal(auth.isOwner({ socket: { remoteAddress: '192.168.1.5' }, headers: { host: 'localhost:4747', cookie: withOwner({}, 'localhost:4747').cookie } }), false, 'the cookie from another machine: still no');
  const noCookie = await call('GET', '/api/videos', { owner: false });
  assert.equal(noCookie.status, 403, 'the library list is closed without the cookie, even from loopback with a localhost Host');
  assert.equal((await call('GET', '/api/videos')).status, 200);
  const me = await call('GET', '/api/me', { owner: false }); assert.equal(me.json.owner, false); assert.equal(me.json.csrf, undefined, 'no CSRF token for a tunnel visitor');
});
test('R1: the one-time login link sets the cookie once, then is dead; its redirect cannot leave the site', async () => {
  const link = security.ownerLoginPath('/v/abc');
  const ok = await call('GET', link, { owner: false });
  assert.equal(ok.status, 302); assert.equal(ok.headers.location, '/v/abc');
  const set = ok.headers['set-cookie'].join(';'); assert.match(set, /sp_owner_\d+=[0-9a-f]{48}/); assert.match(set, /HttpOnly/);
  const again = await call('GET', link, { owner: false }); assert.equal(again.status, 403, 'second use fails');
  assert.equal((await call('GET', '/owner-login?code=nope', { owner: false })).status, 403);
  for (const to of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:1']) assert.equal(security.safeNext(to), '/', to);
  const tunnel = await call('GET', security.ownerLoginPath('/'), { owner: false, headers: { 'x-forwarded-for': '1.2.3.4' } });
  assert.equal(tunnel.status, 403, 'a proxied request cannot even use a valid code');
  assert.equal((await call('GET', security.ownerLoginPath('/'), { owner: false, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'nor can another website');
});
test('finding 6: the owner cookie is named after the port, so another localhost server cannot stand in for it', () => {
  const at = (port, cookie) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: `localhost:${port}`, cookie } });
  const mine = withOwner({ Host: 'localhost:4747' }).cookie;
  assert.match(mine, /^sp_owner_4747=/);
  assert.equal(auth.isOwner(at(4747, mine)), true);
  assert.equal(auth.isOwner(at(3000, mine)), false, 'the 4747 cookie does not open another port of this app');
  assert.equal(auth.isOwner(at(4747, mine.replace('sp_owner_4747', 'sp_owner'))), false, 'the old, unscoped name no longer counts');
});
test('R1: login codes expire', () => {
  const c = security.newLoginCode(1000); assert.equal(security.redeemLoginCode(c, 1000 + 121_000), false);
  const d = security.newLoginCode(1000); assert.equal(security.redeemLoginCode(d, 1000 + 60_000), true);
});

// ---- R2 ----
test('R2: a failed video is never served to a viewer, even with a half-written video.mp4 on disk', async () => {
  const v = mk({ status: 'failed', shareable: false }, { 'video.mp4': 'unblurred partial' });
  for (const u of [`/media/${v.id}/video.mp4`, `/media/${v.id}/download`, `/media/${v.id}/thumb.jpg`, `/api/v/${v.id}`, `/api/v/${v.id}/captions.vtt`]) assert.equal((await call('GET', u, { headers: viewer })).status, 410, u);
  assert.equal((await call('GET', `/api/v/${v.id}`, { headers: viewer })).json.gate, 'failed');
  assert.equal((await call('GET', `/media/${v.id}/video.mp4`)).status, 200, 'the owner can still look');
  const failedAndShareable = mk({ status: 'failed', shareable: true }, { 'video.mp4': 'x' });
  assert.equal((await call('GET', `/media/${failedAndShareable.id}/video.mp4`, { headers: viewer })).status, 410, 'shareable alone does not open a failed video');
});

// ---- R3 ----
test('R3: thumbnail and GIF cannot be made while the guard is checking, and a blur removes the ones already made', async () => {
  const v = mk({ shareable: false, duration: 10 }, { 'video.mp4': 'x', 'thumb-custom.jpg': 'secret frame', 'preview.gif': 'secret gif' });
  for (const [m, u] of [['POST', 'thumbnail'], ['POST', 'gif']]) assert.equal((await call(m, `/api/videos/${v.id}/${u}`, { body: { at: 1 }, headers: { 'x-spool-csrf': security.TOKEN } })).status, 409, u);
  const put = await new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port, method: 'PUT', path: `/api/videos/${v.id}/thumbnail`, headers: { Host: `127.0.0.1:${port}`, ...withOwner({ 'x-spool-csrf': security.TOKEN, 'content-type': 'image/png' }, port) } }, (res) => { res.resume(); resolve(res.statusCode); }); r.end(Buffer.from('png')); });
  assert.equal(put, 409);
  store.update(v.id, { thumbAt: null, gifAt: 2 });
  await orchestrator.dropDerivedPictures(v.id, store.videoDir(v.id), path.join(store.videoDir(v.id), 'video.mp4'));
  assert.ok(!fs.existsSync(path.join(store.videoDir(v.id), 'thumb-custom.jpg'))); assert.ok(!fs.existsSync(path.join(store.videoDir(v.id), 'preview.gif')));
  assert.equal(store.get(v.id).gifAt, null);
});

// ---- R4 ----
test('R4: the guard fails closed when frames are missing', () => {
  assert.throws(() => privacy.assertCoverage({ jpgs: 0, hashFrames: 0, duration: 24 }), /whole video was not checked/);
  assert.throws(() => privacy.assertCoverage({ jpgs: 10, hashFrames: 48, duration: 24 }), /sample frames/);
  assert.throws(() => privacy.assertCoverage({ jpgs: 48, hashFrames: 10, duration: 24 }), /hashes/);
  assert.equal(privacy.assertCoverage({ jpgs: 46, hashFrames: 47, duration: 24 }), 46, 'two frames of slack');
  assert.equal(privacy.assertCoverage({ jpgs: 0, hashFrames: 0, duration: 0 }), 0, 'an empty recording has nothing to read');
  assert.doesNotThrow(() => privacy.assertCoverage({ jpgs: 1, hashFrames: 1, duration: 0.8 }));
  assert.throws(() => privacy.assertCoverage({ jpgs: 0, hashFrames: 0, duration: 0.8 }));
});
test('R4: a Vision result that is missing or garbled is an error, not "no text"', async () => {
  const bin = (script) => { const f = path.join(dir, `fake-${Math.random().toString(36).slice(2)}`); fs.writeFileSync(f, `#!/bin/sh\n${script}\n`, { mode: 0o755 }); return f; };
  const frames = [1, 2, 3, 4].map((n) => ({ file: `/x/f000${n}.jpg`, t: n, width: 10, height: 10 })); // 2 workers x 2 frames: both frames of a chunk go to one process
  const good = bin(`for f in "$@"; do echo "{\\"file\\":\\"$f\\",\\"lines\\":[]}"; done`);
  const r = await ocr.visionFrames(good, frames, () => {}); assert.equal(r.length, 4); assert.deepEqual(r[0].lines, []);
  await assert.rejects(ocr.visionFrames(bin(`echo "{\\"file\\":\\"$1\\",\\"lines\\":[]}"`), frames, () => {}), /no result for f000[34]/, 'exit 0 but a frame skipped');
  await assert.rejects(ocr.visionFrames(bin(`echo "not json"; echo "{\\"file\\":\\"$1\\",\\"lines\\":[]}"`), frames.slice(0, 1), () => {}), /did not parse/, 'garbled line');
  await assert.rejects(ocr.visionFrames(bin('exit 3'), frames, () => {}), /vision-ocr 3/);
});

// ---- R5 ----
test('R5: a space and the password gate reveal nothing about videos a viewer cannot open', async () => {
  const sp = await call('POST', '/api/spaces', { body: { name: 'S' }, headers: { 'x-spool-csrf': security.TOKEN } });
  const open = mk({ title: 'Public demo', shareable: true, spaces: [sp.json.id] });
  const priv = mk({ title: 'Rotating the production DB password', shareable: true, privacy: { mode: 'private' }, spaces: [sp.json.id], views: 7 });
  const checking = mk({ title: 'Still being checked', shareable: false, spaces: [sp.json.id] });
  const pw = mk({ title: 'Quarterly numbers', shareable: true, privacy: { mode: 'password', passwordHash: auth.hashPw('x') } });
  const asViewer = (await call('GET', `/api/space/${sp.json.id}`, { headers: viewer })).json.videos;
  assert.equal(asViewer.find((v) => v.id === open.id).title, 'Public demo');
  for (const v of [priv, checking]) { const row = asViewer.find((x) => x.id === v.id); assert.equal(row.locked, true); assert.equal(row.title, 'Locked video'); assert.equal(row.views, undefined); assert.equal(row.duration, undefined); }
  assert.doesNotMatch(JSON.stringify(asViewer), /production DB|Still being checked/);
  const asOwner = (await call('GET', `/api/space/${sp.json.id}`)).json.videos; assert.equal(asOwner.find((v) => v.id === priv.id).title, 'Rotating the production DB password');
  const gate = await call('GET', `/api/v/${pw.id}`, { headers: viewer }); assert.equal(gate.json.gate, 'password'); assert.equal(gate.json.title, undefined);
});

// ---- R7 ----
test('R7: unknown privacy modes close the link; a missing creation date expires it', () => {
  const viewerReq = { socket: { remoteAddress: '192.168.1.9' }, headers: { host: '192.168.1.2:4747' } };
  for (const bad of ['team', 'unlisted', 'public', '', 'LINK']) { const v = mk({ shareable: true, privacy: { mode: bad || undefined } }); store.setSettings({ defaultPrivacy: bad || 'link' }); if (bad) assert.equal(auth.access(viewerReq, v), 'private', bad); }
  store.setSettings({ defaultPrivacy: 'team' }); assert.equal(auth.access(viewerReq, mk({ shareable: true })), 'private', 'garbage workspace default'); store.setSettings({ defaultPrivacy: 'link' });
  assert.equal(auth.access(viewerReq, mk({ shareable: true, privacy: { mode: 'link' } })), 'ok');
  store.setSettings({ linkExpiryDays: 3 });
  const v = mk({ shareable: true }); store.update(v.id, { createdAt: undefined }); assert.equal(auth.access(viewerReq, store.get(v.id)), 'expired');
  store.setSettings({ linkExpiryDays: 0 });
  assert.equal(auth.access(viewerReq, mk({ privacy: { mode: 'link' } })), 'checking', 'no shareable flag: closed');
  assert.equal(auth.access(viewerReq, mk({ shareable: 'true', privacy: { mode: 'link' } })), 'checking', 'only the boolean true opens it');
});
test('R7: the one-time migration marks old finished videos shareable and leaves the rest closed', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-mig-'));
  store.close();
  const old = (status, extra = {}) => ({ id: status, title: status, createdAt: 1, status, ...extra });
  fs.writeFileSync(path.join(d, 'db.json'), JSON.stringify({ videos: { a: old('ready', { id: 'a' }), b: old('failed', { id: 'b' }), c: old('processing', { id: 'c' }), d: old('ready', { id: 'd', shareable: false }) } }));
  store.init(d, { log: () => {} });
  assert.equal(store.get('a').shareable, true); assert.equal(store.get('b').shareable, undefined); assert.equal(store.get('c').shareable, undefined); assert.equal(store.get('d').shareable, false, 'never overrides an explicit false');
  store.close(); store.init(d, { log: () => {} });
  store.update('c', { status: 'ready' }); store.flush(); store.close(); store.init(d, { log: () => {} });
  assert.equal(store.get('c').shareable, undefined, 'runs once only');
  store.close(); store.init(dir, { log: () => {} });
});

// ---- R8b ----
test('R8b: sample frames sort by number, so f9999 comes before f10000', () => {
  assert.deepEqual(privacy.sortFrames(['f10000.jpg', 'f9999.jpg', 'f0002.jpg', 'hash.raw', 'f0001.jpg', 'f100000.jpg']), ['f0001.jpg', 'f0002.jpg', 'f9999.jpg', 'f10000.jpg', 'f100000.jpg']);
});

// ---- R9 ----
test('R9: hidden text gets a solid fill, not a blur; AWS secret keys are caught', () => {
  const g = privacy.blurGraph([{ box: { x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.25 }, from: 1, to: 3 }, { box: { x0: 0.5, y0: 0.5, x1: 0.6, y1: 0.55 }, from: 2, to: 4 }], 1920, 1080);
  assert.match(g.graph, /drawbox=.*color=black@1:t=fill/); assert.doesNotMatch(g.graph, /boxblur/); assert.equal(g.last, 'v1'); assert.match(g.graph, /enable='between\(t,1\.00,3\.00\)'/);
  const aws = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  assert.equal(aws.length, 40);
  const line = { text: `aws_secret_access_key ${aws}`, words: [{ text: 'aws_secret_access_key', x0: 0, y0: 0, x1: .3, y1: .1 }, { text: aws, x0: .3, y0: 0, x1: .9, y1: .1 }] };
  assert.ok(privacy.regexFindings(line).some((f) => f.value === aws), 'the 40-character key with / is found');
  const prose = { text: 'src/components/forms/InputField/index.tsx', words: [{ text: 'src/components/forms/InputField/index.tsx', x0: 0, y0: 0, x1: 1, y1: 1 }] };
  assert.equal(privacy.regexFindings(prose).length, 0, 'a path without digits is not a secret');
});

// ---- R11 ----
test('R11: leftovers (sample frames, half-written blur/bleep) are removed after a job', () => {
  const v = mk({}, { 'video.mp4': 'x', 'video.blur.mp4': 'half', 'video.mute.mp4': 'half' });
  fs.mkdirSync(path.join(store.videoDir(v.id), 'work', 'scan'), { recursive: true }); fs.writeFileSync(path.join(store.videoDir(v.id), 'work', 'scan', 'f0001.jpg'), 'screen');
  orchestrator.cleanLeftovers(v.id);
  assert.deepEqual(fs.readdirSync(store.videoDir(v.id)).filter((f) => ['work', 'video.blur.mp4', 'video.mute.mp4'].includes(f)), []);
  assert.ok(fs.existsSync(path.join(store.videoDir(v.id), 'video.mp4')));
});

// ---- R10 ----
test('R10: wrong passwords lock the address out with a growing wait, and a right one clears it', () => {
  let t = 0; const l = security.lockout({ now: () => t });
  for (let i = 0; i < 4; i++) l.fail('a'); assert.equal(l.wait('a'), 0, 'five free tries');
  l.fail('a'); assert.equal(l.wait('a'), 30); t += 31_000; assert.equal(l.wait('a'), 0);
  l.fail('a'); assert.equal(l.wait('a'), 60, 'doubles'); t += 61_000; for (let i = 0; i < 12; i++) l.fail('a'); assert.equal(l.wait('a'), 900, 'capped at 15 minutes');
  assert.equal(l.wait('b'), 0, 'other addresses are not affected'); l.ok('a'); assert.equal(l.wait('a'), 0);
});
test('R10: the unlock route answers 429 after repeated wrong passwords, and the async check agrees with the sync one', async () => {
  const hash = auth.hashPw('right'); assert.equal(await auth.checkPwAsync('right', hash), true); assert.equal(await auth.checkPwAsync('wrong', hash), false); assert.equal(await auth.checkPwAsync('x', undefined), false); assert.equal(await auth.checkPwAsync('x', 'garbage'), false);
  const v = mk({ shareable: true, privacy: { mode: 'password', passwordHash: hash } });
  const codes = []; for (let i = 0; i < 7; i++) codes.push((await call('POST', `/api/v/${v.id}/unlock`, { body: { password: 'nope' }, headers: { 'x-forwarded-for': '198.51.100.7', 'x-spool-csrf': security.TOKEN } })).status);
  assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]); assert.deepEqual(codes.slice(5), [429, 429], codes.join());
});

test('R1: a bookmark or old tab on this machine gets an explanation, not JSON; scripts still get JSON', async () => {
  const page = await call('GET', '/', { owner: false, headers: { accept: 'text/html,application/xhtml+xml' } });
  assert.equal(page.status, 403); assert.match(page.text, /Open library/); assert.match(page.headers['content-type'], /html/);
  const api = await call('GET', '/api/videos', { owner: false, headers: { accept: 'application/json' } }); assert.equal(api.json.error, 'owner only');
  const tunnel = await call('GET', '/', { owner: false, headers: { accept: 'text/html', 'x-forwarded-for': '1.2.3.4' } }); assert.equal(tunnel.json?.error, 'owner only', 'a proxied visitor learns nothing about how to sign in');
});

// ---- finding 1 (PHASE4-CHECK): screenshots go through the Privacy Guard ----
const { ffmpeg } = require('../../src/agents/media');
const whitePng = (f, w = 400, h = 200) => spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=white:s=${w}x${h}`, '-frames:v', '1', f]);
// mean grey level (0 black .. 255 white) of a region of a PNG
const mean = (f, x, y, w, h) => { const r = spawnSync(ffmpeg, ['-v', 'error', '-i', f, '-vf', `crop=${w}:${h}:${x}:${y},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 }); return r.stdout.reduce((a, b) => a + b, 0) / r.stdout.length; };
const fakeRead = (lines) => async (frames) => frames.map((f) => ({ t: f.t, width: f.width, height: f.height, lines }));
const keyLine = { text: 'token: sk-abcdefgh12345678', words: [{ text: 'token:', x0: 0.1, y0: 0.4, x1: 0.2, y1: 0.5 }, { text: 'sk-abcdefgh12345678', x0: 0.25, y0: 0.4, x1: 0.8, y1: 0.5 }] };
const still = (extra = {}) => { const v = mk({ type: 'image', shareable: false, width: 400, height: 200, ...extra }); whitePng(path.join(store.videoDir(v.id), 'image.png')); fs.writeFileSync(path.join(store.videoDir(v.id), 'thumb.jpg'), 'old thumb'); return v; };

test('finding 1: a screenshot with a key on it is blurred, then cleared for viewers', async () => {
  const v = still(), f = path.join(store.videoDir(v.id), 'image.png');
  assert.equal(auth.access({ socket: { remoteAddress: '192.168.1.9' }, headers: { host: 'x:4747' } }, store.get(v.id)), 'checking', 'closed before the guard has run');
  await orchestrator.stillJob({ videoId: v.id }, { read: fakeRead([keyLine]) });
  const after = store.get(v.id);
  assert.equal(after.shareable, true); assert.equal(after.redactions.length, 1); assert.equal(after.redactions[0].type, 'api key');
  assert.ok(mean(f, 120, 80, 180, 20) < 5, 'the key is covered by a solid fill');
  assert.ok(mean(f, 10, 150, 100, 30) > 250, 'the rest of the picture is untouched');
  assert.notEqual(fs.readFileSync(path.join(store.videoDir(v.id), 'thumb.jpg'), 'utf8'), 'old thumb', 'the thumbnail is regenerated from the covered picture');
  assert.equal(fs.existsSync(path.join(store.videoDir(v.id), 'original.png')), false, 'the unblurred picture is not kept');
});
test('finding 1: a clean screenshot is cleared untouched; keepOriginal keeps the unblurred copy', async () => {
  const v = still(); await orchestrator.stillJob({ videoId: v.id }, { read: fakeRead([{ text: 'File Edit View', words: [{ text: 'File', x0: 0, y0: 0, x1: 0.1, y1: 0.1 }] }]) });
  assert.equal(store.get(v.id).shareable, true); assert.deepEqual(store.get(v.id).redactions, []);
  store.setSettings({ keepOriginal: true });
  const k = still(); await orchestrator.stillJob({ videoId: k.id }, { read: fakeRead([keyLine]) });
  store.setSettings({ keepOriginal: false });
  assert.ok(mean(path.join(store.videoDir(k.id), 'original.png'), 120, 80, 180, 20) > 250, 'owner-only copy is the unblurred picture');
});
test('finding 1: if the screen reader fails, the screenshot stays closed', async () => {
  const v = still();
  await orchestrator.stillJob({ videoId: v.id }, { read: async () => { throw new Error('vision-ocr 3'); } });
  assert.equal(store.get(v.id).shareable, false); assert.match(store.get(v.id).stage, /could not read/);
  await orchestrator.stillJob({ videoId: v.id }, { read: async () => [] }); // a result that does not cover the picture
  assert.equal(store.get(v.id).shareable, false);
  const asViewer = await call('GET', `/media/${v.id}/image.png`, { headers: viewer }); assert.equal(asViewer.status, 423);
  assert.equal((await call('GET', `/media/${v.id}/image.png`)).status, 200, 'the owner still sees it');
});
test('finding 1: with the Privacy Guard turned off, a screenshot opens at once (same as a recording)', async () => {
  store.setSettings({ privacyGuard: false }); const v = still();
  await orchestrator.stillJob({ videoId: v.id }, { read: async () => { throw new Error('must not run'); } });
  store.setSettings({ privacyGuard: true }); assert.equal(store.get(v.id).shareable, true);
});
