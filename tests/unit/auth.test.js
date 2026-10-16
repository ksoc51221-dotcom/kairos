const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../src/store');
const auth = require('../../src/server/auth');
const security = require('../../src/server/security');

test.before(() => store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-auth-')), { log: () => {} }));
test.after(() => store.close());

const { withOwner, cookie } = require('./owner');
const req = (o = {}) => ({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET', ...o, headers: withOwner({ host: 'localhost:4747', ...(o.headers || {}) }) });
const bare = (o = {}) => ({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET', ...o, headers: { host: 'localhost:4747', ...(o.headers || {}) } }); // no owner cookie
const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, send(b) { r.body = b; return r; } }; return r; };

test('owner = this machine, not proxied, localhost host name, not previewing', () => {
  assert.equal(auth.isOwner(req()), true);
  assert.equal(auth.isOwner(req({ socket: { remoteAddress: '192.168.1.20' } })), false, 'LAN visitor');
  assert.equal(auth.isOwner(req({ headers: { 'x-forwarded-for': '1.2.3.4' } })), false, 'reverse proxy');
  assert.equal(auth.isOwner(req({ headers: { 'cf-connecting-ip': '1.2.3.4' } })), false, 'tunnel');
  assert.equal(auth.isOwner(req({ headers: { host: 'evil.example' } })), false, 'DNS rebinding host');
  assert.equal(auth.isOwner(req({ headers: { host: '127.0.0.1:4747' } })), true);
  assert.equal(auth.isOwner(req({ headers: { cookie: 'sp_asviewer=1' } })), false, 'previewing as a viewer');
});

test('B14: previewingAsViewer is true only for the owner machine with the cookie', () => {
  assert.equal(auth.previewingAsViewer(req({ headers: { cookie: 'sp_asviewer=1' } })), true);
  assert.equal(auth.previewingAsViewer(req()), false);
  assert.equal(auth.previewingAsViewer(req({ headers: { host: 'evil.example', cookie: 'sp_asviewer=1' } })), false);
});

test('requireOwner: reads need to be the owner; writes also need the token', () => {
  let called = 0; const next = () => { called++; };
  auth.requireOwner(req(), res(), next); assert.equal(called, 1, 'GET passes');
  const r1 = res(); auth.requireOwner(req({ method: 'POST' }), r1, next); assert.equal(r1.code, 403); assert.equal(called, 1, 'POST without token blocked');
  auth.requireOwner(req({ method: 'POST', headers: { [security.HEADER]: security.TOKEN } }), res(), next); assert.equal(called, 2, 'POST with token passes');
  const r2 = res(); auth.requireOwner(req({ socket: { remoteAddress: '10.0.0.5' } }), r2, next); assert.equal(r2.code, 403);
});

test('sameOrigin: the Fetch Metadata and Origin rules', () => {
  const s = (headers) => security.sameOrigin({ headers: { host: 'localhost:4747', ...headers } });
  assert.equal(s({}), true, 'no browser headers (curl)');
  assert.equal(s({ 'sec-fetch-site': 'same-origin' }), true);
  assert.equal(s({ 'sec-fetch-site': 'none' }), true);
  assert.equal(s({ 'sec-fetch-site': 'same-site' }), false, 'another localhost port is same-site but a different origin');
  assert.equal(s({ 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(s({ origin: 'http://localhost:4747' }), true);
  assert.equal(s({ origin: 'http://localhost:3000' }), false);
  assert.equal(s({ origin: 'null' }), false);
  assert.equal(s({ origin: 'not a url' }), false);
});

test('tokens: wrong length and wrong value are refused', () => {
  assert.equal(security.tokenOk({ headers: {} }), false);
  assert.equal(security.tokenOk({ headers: { [security.HEADER]: 'short' } }), false);
  assert.equal(security.tokenOk({ headers: { [security.HEADER]: 'x'.repeat(security.TOKEN.length) } }), false);
  assert.equal(security.tokenOk({ headers: { [security.HEADER]: security.TOKEN } }), true);
});

test('effectivePrivacy: workspace defaults apply, expiry derives from the workspace setting', () => {
  const v = store.create({ title: 'P' });
  assert.equal(auth.effectivePrivacy(v).mode, 'link');
  store.setSettings({ defaultPrivacy: 'email', linkExpiryDays: 2, disableDownloads: true });
  const p = auth.effectivePrivacy(v);
  assert.equal(p.mode, 'email'); assert.equal(p.allowDownload, false); assert.equal(p.expiresAt, v.createdAt + 2 * 86400000);
  store.setSettings({ defaultPrivacy: 'link', linkExpiryDays: 0, disableDownloads: false });
});

test('access gates: private, expired, password, email', () => {
  const viewer = (cookie) => req({ socket: { remoteAddress: '192.168.1.9' }, headers: { host: '192.168.1.2:4747', cookie } });
  const mk = (privacy) => store.create({ title: 'G', privacy, shareable: true });
  assert.equal(auth.access(viewer(), mk({ mode: 'link' })), 'ok');
  assert.equal(auth.access(viewer(), mk({ mode: 'private' })), 'private');
  assert.equal(auth.access(viewer(), mk({ mode: 'link', expiresAt: Date.now() - 1000 })), 'expired');
  const pw = mk({ mode: 'password', passwordHash: auth.hashPw('s3cret') });
  assert.equal(auth.access(viewer(), pw), 'password');
  assert.equal(auth.access(viewer(`sp_${pw.id}=${encodeURIComponent(auth.unlockCookie(pw).split('=')[1].split(';')[0])}`), pw), 'ok', 'the unlock cookie opens it');
  assert.equal(auth.access(viewer(`sp_${pw.id}=wrong`), pw), 'password');
  assert.equal(auth.access(viewer(), mk({ mode: 'email' })), 'email');
  assert.equal(auth.access(req(), mk({ mode: 'private' })), 'ok', 'the owner always gets in');
});

test('passwords hash with scrypt and verify, and a missing hash never verifies', () => {
  const h = auth.hashPw('hunter2');
  assert.match(h, /^[0-9a-f]{16}:[0-9a-f]{64}$/);
  assert.equal(auth.checkPw('hunter2', h), true); assert.equal(auth.checkPw('hunter3', h), false);
  assert.equal(auth.checkPw('anything', undefined), false);
  assert.notEqual(auth.hashPw('hunter2'), h, 'salted');
});
