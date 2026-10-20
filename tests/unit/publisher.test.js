// Public links: the privacy contract, the upload order, cleanup after failures, removal hooks, expiry. Backblaze is an in-process fake; ffmpeg is real
// for the happy path and stubbed elsewhere to keep this fast. Nothing here touches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../src/store');
const publisher = require('../../src/publish/publisher');
const { createB2 } = require('../../src/publish/b2');
const { runFfmpeg } = require('../../src/pipeline/encode');
const share = require('../../src/pipeline/share-copy');
const { createFakeB2 } = require('./fake-b2');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-pub-'));
store.init(root, { log: () => {} });
publisher.deps.log = () => {};
const WORKER = 'https://links.example.workers.dev';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
let fake, tinyMp4;

const stubs = () => { publisher.deps.encode = async (inp, out) => fs.copyFileSync(inp, out); publisher.deps.poster = async (inp, out) => fs.writeFileSync(out, JPEG); };
test.before(async () => {
  tinyMp4 = path.join(root, 'tiny.mp4');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', tinyMp4]);
});
test.beforeEach(async () => {
  fake = await createFakeB2().start(); stubs();
  publisher.deps.makeB2 = (cfg) => createB2({ keyId: cfg.keyId, key: cfg.key, bucket: cfg.bucket, authUrl: fake.url, sleep: async () => {}, retries: cfg.retries ?? 2 });
  store.setSettings({ integrations: { publish: { workerUrl: WORKER, bucket: fake.cfg.bucket, accessId: 'write-key-id', appKey: 'write-key-secret' } }, defaultPrivacy: 'link', linkExpiryDays: 0, disableDownloads: false });
});
test.afterEach(async () => {
  await publisher.idle(); publisher.stop();
  for (const v of store.list()) store.remove(v.id);
  store.mutate((d) => { d.publishQueue = []; });
  await fake.stop();
});
test.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });

function mk(extra = {}) {
  const v = store.create({ title: 'Demo', status: 'ready', shareable: true, guard: { model: true, speech: 'checked' }, duration: 2, ...extra });
  fs.copyFileSync(tinyMp4, path.join(store.videoDir(v.id), 'video.mp4'));
  return v;
}
async function live(extra, opts = { mode: 'link' }) {
  const v = mk(extra); await publisher.publish(v.id, opts); await publisher.idle();
  const p = store.get(v.id).publish; assert.equal(p.state, 'live', p.error); return { v, p };
}
const names = () => fake.list().map((f) => f.name);

// ---- the privacy contract ---------------------------------------------------------------------------------------------------
test('every refusal happens before anything is sent to Backblaze', async () => {
  const cases = [
    ['private', { privacy: { mode: 'private' } }, 'link'],
    ['email', { privacy: { mode: 'email' } }, 'link'],
    ['private', { privacy: { mode: 'nonsense' } }, 'link'],            // an unknown local mode counts as private
    ['not_shareable', { shareable: false }, 'link'],
    ['not_shareable', { shareable: undefined }, 'link'],
    ['not_ready', { status: 'processing' }, 'link'],
    ['not_ready', { status: 'failed' }, 'link'],
    ['no_guard', { guard: undefined }, 'link'],                          // migrated "cleared" without a scan, or the Guard was off
    ['not_video', { type: 'image' }, 'link'],
    ['expired', { privacy: { mode: 'link', expiresAt: Date.now() - 1000 } }, 'link'],
    ['looser', { privacy: { mode: 'password', passwordHash: 'aa:bb' } }, 'link'],
    ['need_password', {}, 'password', 'short'],
    ['need_password', {}, 'password', undefined],
    ['bad_mode', {}, 'sneaky'],
    ['bad_mode', {}, undefined],
  ];
  for (const [code, extra, mode, password] of cases) {
    const v = mk(extra);
    await assert.rejects(publisher.publish(v.id, { mode, password }), (e) => e.name === 'PublishError' && e.code === code, `${code} ${JSON.stringify(extra)}`);
    assert.equal(store.get(v.id).publish, undefined, 'no publish record was created');
  }
  assert.equal(fake.calls.length, 0);
});

test('the refusal message for an unscanned recording does not promise a fix that does not exist', () => {
  const e = publisher.eligibility({ status: 'ready', shareable: true, privacy: null });
  assert.equal(e.code, 'no_guard'); assert.match(e.message, /Guard/); assert.doesNotMatch(e.message, /Re-run/);
});

test('with the default privacy set to private, a video with no choice of its own is refused too', async () => {
  store.setSettings({ defaultPrivacy: 'private' });
  const v = mk(); await assert.rejects(publisher.publish(v.id, { mode: 'link' }), (e) => e.code === 'private'); assert.equal(fake.calls.length, 0);
});

test('not set up, unknown video, missing file', async () => {
  const v = mk(); fs.rmSync(path.join(store.videoDir(v.id), 'video.mp4'));
  await assert.rejects(publisher.publish(v.id, { mode: 'link' }), (e) => e.code === 'no_file');
  await assert.rejects(publisher.publish('nope', { mode: 'link' }), (e) => e.code === 'not_found' && e.status === 404);
  store.setSettings({ integrations: { publish: { workerUrl: WORKER, bucket: '', accessId: 'a', appKey: '' } } });
  await assert.rejects(publisher.publish(v.id, { mode: 'link' }), (e) => e.code === 'not_configured');
  store.setSettings({ integrations: { publish: { workerUrl: 'http://evil.example', bucket: 'b', accessId: 'a', appKey: 'k' } } });
  await assert.rejects(publisher.publish(v.id, { mode: 'link' }), (e) => e.code === 'bad_config' && /https/.test(e.message));
  assert.equal(fake.calls.length, 0);
});

test('the pipeline and the recorder never import the publisher: Stop makes no call to Backblaze or Cloudflare', () => {
  const dirs = ['agents', 'pipeline', 'main'].map((d) => path.join(__dirname, '../../src', d));
  const files = dirs.flatMap((d) => fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => path.join(d, f)) : []).concat(path.join(__dirname, '../../src/store.js'));
  assert.ok(files.length > 10);
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /require\([^)]*publish\//, path.basename(f));
});

// ---- publishing -------------------------------------------------------------------------------------------------------------
test('a link-mode publish makes the real small copy and uploads video, thumb, then meta last', async () => {
  publisher.deps.encode = share.makeShareCopy; publisher.deps.poster = share.makePoster; // real ffmpeg this time
  const v = mk(), s = await publisher.publish(v.id, { mode: 'link' });
  assert.equal(s.state, 'working'); assert.equal(s.url, undefined, 'a link that is not live yet is not shown');
  await publisher.idle();
  const p = store.get(v.id).publish;
  assert.equal(p.state, 'live'); assert.match(p.id, /^[A-Za-z0-9_-]{22}$/); assert.equal(p.url, `${WORKER}/v/${p.id}`);
  assert.deepEqual(fake.uploads, [`p/${p.id}/video.mp4`, `p/${p.id}/thumb.jpg`, `p/${p.id}/meta.json`]);
  const meta = JSON.parse(fake.read(`p/${p.id}/meta.json`)), video = fake.read(`p/${p.id}/video.mp4`);
  assert.equal(video.subarray(4, 8).toString(), 'ftyp'); assert.equal(fake.read(`p/${p.id}/thumb.jpg`)[0], 0xff);
  assert.deepEqual({ v: meta.v, title: meta.title, mode: meta.mode, bytes: meta.bytes, duration: meta.duration, allowDownload: meta.allowDownload, hasThumb: meta.hasThumb, pw: meta.pw },
    { v: 1, title: 'Demo', mode: 'link', bytes: video.length, duration: 2, allowDownload: true, hasThumb: true, pw: undefined });
  assert.ok(Math.abs(meta.expiresAt - (Date.now() + 30 * 86400000)) < 10000, 'thirty days');
  assert.equal(p.expiresAt, meta.expiresAt);
  assert.ok(store.get(v.id).activity.some((a) => /Public link is live/.test(a.event)));
});

test('the copy is made from the guarded video.mp4, never from original.mp4', async () => {
  const v = mk(); fs.writeFileSync(path.join(store.videoDir(v.id), 'original.mp4'), 'UNBLURRED SECRET');
  const seen = []; publisher.deps.encode = async (inp, out) => { seen.push(inp); fs.copyFileSync(inp, out); };
  await publisher.publish(v.id, { mode: 'link' }); await publisher.idle();
  assert.deepEqual(seen.map((f) => path.basename(f)), ['video.mp4']);
  for (const f of fake.list()) assert.ok(!fake.read(f.name).includes('UNBLURRED SECRET'));
});

test('a poster is a frame of the share copy, or the custom thumbnail only if it is newer than the video', async () => {
  const posters = []; publisher.deps.poster = async (inp, out) => { posters.push(path.basename(inp)); fs.writeFileSync(out, JPEG); };
  const a = mk(); await publisher.publish(a.id, { mode: 'link' }); await publisher.idle();
  assert.deepEqual(posters, ['video.mp4'], 'generated from the share copy, not from thumb.jpg (which is cut before the Guard blurs)');
  const b = mk(), custom = path.join(store.videoDir(b.id), 'thumb-custom.jpg'), mine = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  fs.writeFileSync(custom, mine); fs.utimesSync(custom, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  await publisher.publish(b.id, { mode: 'link' }); await publisher.idle();
  assert.deepEqual(fake.read(`p/${store.get(b.id).publish.id}/thumb.jpg`), mine);
  const c = mk(), stale = path.join(store.videoDir(c.id), 'thumb-custom.jpg'); fs.writeFileSync(stale, mine); fs.utimesSync(stale, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  await publisher.publish(c.id, { mode: 'link' }); await publisher.idle();
  assert.deepEqual(fake.read(`p/${store.get(c.id).publish.id}/thumb.jpg`), JPEG, 'an older custom thumbnail may predate a blur: not used');
});

test('password mode stores only a derived check value, never the password', async () => {
  const pw = 'correct horse battery';
  const { v, p } = await live({}, { mode: 'password', password: pw });
  const meta = JSON.parse(fake.read(`p/${p.id}/meta.json`));
  assert.equal(meta.mode, 'password'); assert.match(meta.pw.salt, /^[0-9a-f]{32}$/); assert.equal(meta.pw.iter, 200000);
  const dk = crypto.pbkdf2Sync(pw.normalize('NFC'), Buffer.from(meta.pw.salt, 'hex'), 200000, 32, 'sha256');
  assert.equal(meta.pw.check, crypto.createHash('sha256').update(dk).digest('hex'));
  assert.ok(!JSON.stringify(store.get(v.id)).includes('correct horse'), 'not in the library file');
  for (const f of fake.list()) assert.ok(!fake.read(f.name).includes('correct horse'), `not in ${f.name}`);
  assert.ok(!JSON.stringify(publisher.summary(store.get(v.id))).match(/salt|check|correct horse/), 'not in what the UI gets');
});

test('a video that needs a password here can only be published with a password', async () => {
  const mkPw = () => mk({ privacy: { mode: 'password', passwordHash: 'aa:bb' } });
  const a = mkPw(); await assert.rejects(publisher.publish(a.id, { mode: 'link' }), (e) => e.code === 'looser');
  const b = mkPw(); await publisher.publish(b.id, { mode: 'password', password: 'twelve chars!' }); await publisher.idle();
  assert.equal(store.get(b.id).publish.state, 'live');
});

test("the video's own expiry and download setting are copied, never loosened", async () => {
  const soon = Date.now() + 2 * 86400000;
  const { p } = await live({ privacy: { mode: 'link', expiresAt: soon, allowDownload: false } });
  const meta = JSON.parse(fake.read(`p/${p.id}/meta.json`));
  assert.equal(meta.expiresAt, soon); assert.equal(meta.allowDownload, false);
  store.setSettings({ disableDownloads: true });
  const { p: q } = await live(); assert.equal(JSON.parse(fake.read(`p/${q.id}/meta.json`)).allowDownload, false, 'the workspace setting wins');
});

test('the link is new on every publish and unguessable', async () => {
  const ids = new Set();
  for (let i = 0; i < 3; i++) { const { p } = await live(); ids.add(p.id); }
  assert.equal(ids.size, 3);
});

test('progress and stage are reported while it runs', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  publisher.deps.encode = async (inp, out, o) => { o.onProgress(0.5); await gate; fs.copyFileSync(inp, out); };
  const v = mk(); await publisher.publish(v.id, { mode: 'link' });
  const s = publisher.summary(store.get(v.id));
  assert.equal(s.state, 'working'); assert.equal(s.stage, 'encoding'); assert.ok(Math.abs(s.progress - 0.2) < 1e-9);
  release(); await publisher.idle(); assert.equal(publisher.summary(store.get(v.id)).state, 'live');
});

test('only one publish runs at a time', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  publisher.deps.encode = async (inp, out) => { await gate; fs.copyFileSync(inp, out); };
  const a = mk(), b = mk(); await publisher.publish(a.id, { mode: 'link' });
  await assert.rejects(publisher.publish(b.id, { mode: 'link' }), (e) => e.code === 'busy');
  release(); await publisher.idle();
});

test('9 GB of public copies is the most Kairos will hold', async () => {
  const big = mk(); store.update(big.id, { publish: { state: 'live', id: crypto.randomBytes(16).toString('base64url'), mode: 'link', bytes: 9e9 - 100, expiresAt: Date.now() + 1e9 } });
  const v = mk(); await assert.rejects(publisher.publish(v.id, { mode: 'link' }), (e) => e.code === 'too_big' && e.status === 413 && /GB/.test(e.message));
  assert.equal(fake.calls.length, 0);
});

// ---- failures leave nothing behind ------------------------------------------------------------------------------------------
test('an upload that fails half way is cleaned out of the bucket and never goes live', async () => {
  fake.inject('b2_upload_file', { status: 400, code: 'bad_request', message: 'boom' }, 1, 1); // the video goes up, the thumbnail is refused
  const v = mk(); await publisher.publish(v.id, { mode: 'link' }); await publisher.idle(); await publisher.drainQueue();
  const p = store.get(v.id).publish;
  assert.equal(p.state, 'failed'); assert.match(p.error, /boom/);
  assert.deepEqual(names(), [], 'the half-uploaded video is gone'); assert.ok(!fake.uploads.some((n) => n.endsWith('meta.json')), 'meta.json (go live) was never written');
  assert.equal(publisher.queue().length, 0);
});

test('when the clean-up cannot run either, it is queued and retried until it works', async () => {
  fake.inject('b2_upload_file', { status: 400, code: 'bad_request', message: 'boom' }, 1, 1);
  fake.inject('b2_list_file_versions', { drop: true }, 3); // offline for the first clean-up attempt
  const v = mk(); await publisher.publish(v.id, { mode: 'link' }); await publisher.idle(); await publisher.drainQueue();
  assert.equal(publisher.queue().length, 1); assert.equal(publisher.queue()[0].tries, 1); assert.equal(names().length, 1);
  await publisher.drainQueue();
  assert.equal(publisher.queue().length, 0); assert.deepEqual(names(), []);
});

test('a failed encode is explained and uploads nothing', async () => {
  publisher.deps.encode = async () => { throw new Error('ffmpeg 1: Invalid data found'); };
  const v = mk(); await publisher.publish(v.id, { mode: 'link' }); await publisher.idle();
  assert.match(store.get(v.id).publish.error, /small copy/); assert.equal(fake.uploads.length, 0);
});

test('cancelling a running publish stops it and removes everything', async () => {
  publisher.deps.encode = (inp, out, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('cancelled'))));
  const v = mk(); await publisher.publish(v.id, { mode: 'link' });
  const r = await publisher.unpublish(v.id);
  assert.equal(r.state, 'none'); assert.equal(store.get(v.id).publish, null); assert.equal(fake.uploads.length, 0);
});

test('privacy turned to Private while the upload runs: nothing goes live', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  publisher.deps.encode = async (inp, out) => { await gate; fs.copyFileSync(inp, out); };
  const v = mk(); await publisher.publish(v.id, { mode: 'link' });
  store.update(v.id, { privacy: { mode: 'private' } });
  const stopped = publisher.enforce(v.id); release(); await stopped; await publisher.idle(); await publisher.drainQueue();
  assert.equal(store.get(v.id).publish, null); assert.deepEqual(names(), []); assert.ok(!fake.uploads.some((n) => n.endsWith('meta.json')));
});

// ---- republish and unpublish --------------------------------------------------------------------------------------------------
test('republishing keeps the old link until the new one is ready, then removes the old copy', async () => {
  const { v, p: first } = await live();
  let release; const gate = new Promise((r) => { release = r; });
  publisher.deps.encode = async (inp, out) => { await gate; fs.copyFileSync(inp, out); };
  const s = await publisher.publish(v.id, { mode: 'link' });
  assert.equal(s.state, 'working'); assert.equal(s.previous.url, first.url);
  assert.equal(names().length, 3, 'the old copy still serves');
  release(); await publisher.idle(); await publisher.drainQueue();
  const second = store.get(v.id).publish;
  assert.notEqual(second.id, first.id); assert.deepEqual(names(), [`p/${second.id}/meta.json`, `p/${second.id}/thumb.jpg`, `p/${second.id}/video.mp4`].sort());
});

test('a failed republish keeps the old link live and says so', async () => {
  const { v, p: first } = await live();
  fake.inject('b2_upload_file', { status: 400, code: 'bad_request', message: 'boom' });
  await publisher.publish(v.id, { mode: 'link' }); await publisher.idle(); await publisher.drainQueue();
  const p = store.get(v.id).publish;
  assert.equal(p.state, 'live'); assert.equal(p.id, first.id); assert.match(p.notice, /Republishing failed/);
  assert.equal(names().length, 3, 'only the old copy is left');
});

test('unpublish deletes the copy and forgets the link', async () => {
  const { v } = await live();
  const r = await publisher.unpublish(v.id);
  assert.equal(r.state, 'none'); assert.equal(r.removal, 'done'); assert.deepEqual(names(), []); assert.equal(fake.versionCount(), 0);
  assert.ok(store.get(v.id).activity.some((a) => /Public link removed/.test(a.event)));
});

test('unpublish while offline says it is queued, and finishes later', async () => {
  const { v } = await live();
  fake.inject('b2_list_file_versions', { drop: true }, 2); // retries: 1 for a click -> two attempts
  const r = await publisher.unpublish(v.id);
  assert.equal(r.state, 'none'); assert.equal(r.removal, 'queued'); assert.equal(names().length, 3);
  await publisher.drainQueue(); assert.deepEqual(names(), []); assert.equal(publisher.queue().length, 0);
});

// ---- privacy changes after publishing ---------------------------------------------------------------------------------------
test('making a published video Private, or "Ask for email", takes the public copy down', async () => {
  for (const mode of ['private', 'email']) {
    const { v } = await live();
    store.update(v.id, { privacy: { mode } }); await publisher.enforce(v.id);
    const p = store.get(v.id).publish;
    assert.equal(p.state, 'removed', mode); assert.match(p.reason, mode === 'private' ? /Private/ : /email/);
    await publisher.drainQueue(); assert.deepEqual(names(), [], mode);
  }
});

test('a password added here after publishing as "anyone with the link" takes the public link down', async () => {
  const { v } = await live();
  store.update(v.id, { privacy: { mode: 'password', passwordHash: 'aa:bb' } }); await publisher.enforce(v.id);
  assert.equal(store.get(v.id).publish.state, 'removed'); assert.match(store.get(v.id).publish.reason, /password/);
});

test('a stricter public link than the local setting stays', async () => {
  const { v } = await live({}, { mode: 'password', password: 'twelve chars!' });
  store.update(v.id, { privacy: { mode: 'link' } }); await publisher.enforce(v.id);
  assert.equal(store.get(v.id).publish.state, 'live');
});

test('an earlier local expiry or switching downloads off takes it down; a later expiry does not', async () => {
  const a = await live(); store.update(a.v.id, { privacy: { mode: 'link', expiresAt: Date.now() + 40 * 86400000 } }); await publisher.enforce(a.v.id);
  assert.equal(store.get(a.v.id).publish.state, 'live', 'a local expiry after the public one changes nothing');
  store.update(a.v.id, { privacy: { mode: 'link', expiresAt: Date.now() + 86400000 } }); await publisher.enforce(a.v.id);
  assert.equal(store.get(a.v.id).publish.state, 'removed'); assert.match(store.get(a.v.id).publish.reason, /expiry/);
  const b = await live(); store.update(b.v.id, { privacy: { mode: 'link', allowDownload: false } }); await publisher.enforce(b.v.id);
  assert.equal(store.get(b.v.id).publish.state, 'removed'); assert.match(store.get(b.v.id).publish.reason, /downloads/);
});

test('changing the workspace default to private takes down links on videos that had no choice of their own', async () => {
  const { v } = await live();
  store.setSettings({ defaultPrivacy: 'private' }); await publisher.enforceAll();
  assert.equal(store.get(v.id).publish.state, 'removed');
});

// ---- deletion, expiry, restart ----------------------------------------------------------------------------------------------
test('deleting a video removes its public copy, whichever way the video goes', async () => {
  publisher.start();
  const { v, p } = await live();
  store.remove(v.id); await publisher.drainQueue();
  assert.deepEqual(names(), []); assert.equal(publisher.queue().length, 0, p.id);
});

test('a copy that cannot be removed while the Mac is offline is removed later', async () => {
  publisher.start();
  const { v } = await live();
  fake.inject('b2_list_file_versions', { drop: true }, 3);
  store.remove(v.id); await publisher.drainQueue();
  assert.equal(publisher.queue().length, 1); assert.equal(names().length, 3);
  await publisher.drainQueue(); assert.deepEqual(names(), []);
});

test('deleting a video while it is being published stops the job and leaves nothing', async () => {
  publisher.start();
  let release; const gate = new Promise((r) => { release = r; });
  publisher.deps.encode = async (inp, out, { signal }) => { await Promise.race([gate, new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('cancelled'))))]); fs.copyFileSync(inp, out); };
  const v = mk(); await publisher.publish(v.id, { mode: 'link' });
  store.remove(v.id); await publisher.idle(); await publisher.drainQueue(); release();
  assert.deepEqual(names(), []); assert.equal(fake.uploads.length, 0);
});

test('after 30 days the copy is deleted and the link is marked expired', async () => {
  const { v, p } = await live();
  store.update(v.id, { publish: { ...p, expiresAt: Date.now() - 1000 } });
  await publisher.sweep();
  const q = store.get(v.id).publish;
  assert.equal(q.state, 'expired'); assert.equal(q.url, undefined); assert.deepEqual(names(), []);
  assert.equal(publisher.summary(store.get(v.id)).url, undefined);
});

test('a publish that was running when Kairos quit is marked failed and its half copy removed', async () => {
  const v = mk(), id = crypto.randomBytes(16).toString('base64url');
  fake.put(`p/${id}/video.mp4`, 'half');
  store.update(v.id, { publish: { state: 'working', id, mode: 'link', stage: 'uploading' } });
  publisher.start(); await publisher.drainQueue();
  assert.equal(store.get(v.id).publish.state, 'failed'); assert.match(store.get(v.id).publish.error, /Interrupted/); assert.deepEqual(names(), []);
});

test('an interrupted republish brings the old link back', async () => {
  const { v, p: first } = await live();
  const id = crypto.randomBytes(16).toString('base64url');
  store.update(v.id, { publish: { state: 'working', id, mode: 'link', previous: first } });
  publisher.start(); await publisher.drainQueue();
  const p = store.get(v.id).publish; assert.equal(p.state, 'live'); assert.equal(p.id, first.id); assert.match(p.notice, /interrupted/);
});

test('remove-all clears every public copy and forgets every link, but not other files', async () => {
  fake.put('keep/me.txt', 'x');
  const a = await live(), b = await live();
  const r = await publisher.removeAll();
  assert.equal(r.queued, false); assert.deepEqual(names(), ['keep/me.txt']);
  assert.equal(store.get(a.v.id).publish, null); assert.equal(store.get(b.v.id).publish, null);
});

// ---- what the UI sees -------------------------------------------------------------------------------------------------------
test('summary: says why a video cannot be published, and what a live link looks like', async () => {
  const priv = mk({ privacy: { mode: 'private' } });
  assert.deepEqual(publisher.summary(store.get(priv.id)).can.code, 'private'); assert.equal(publisher.summary(store.get(priv.id)).state, 'none');
  const ok = mk(); const s = publisher.summary(store.get(ok.id));
  assert.equal(s.configured, true); assert.deepEqual(s.can.modes, ['link', 'password']);
  const { v, p } = await live();
  const t = publisher.summary(store.get(v.id));
  assert.equal(t.state, 'live'); assert.equal(t.url, p.url); assert.equal(t.mode, 'link'); assert.equal(t.stale, undefined);
});

test('summary: warns when the Guard did not run in full', () => {
  const v = mk({ guard: { model: false, speech: 'off' } }), w = publisher.summary(store.get(v.id)).can.warnings;
  assert.equal(w.length, 2); assert.match(w.join(' '), /speech check was switched off/); assert.match(w.join(' '), /rules ran/);
});

test('summary: a published video that was edited or renamed is "out of date"', async () => {
  const { v } = await live();
  store.update(v.id, { title: 'A new title' });
  assert.match(publisher.summary(store.get(v.id)).staleWhy, /title/);
  store.update(v.id, { title: 'Demo' }); assert.equal(publisher.summary(store.get(v.id)).stale, undefined);
  fs.appendFileSync(path.join(store.videoDir(v.id), 'video.mp4'), Buffer.alloc(8));
  assert.match(publisher.summary(store.get(v.id)).staleWhy, /edited/);
});

test('status reports the storage meter', async () => {
  await live();
  const s = publisher.status(); assert.equal(s.live, 1); assert.equal(s.cap, 9e9); assert.ok(s.used > 1000); assert.equal(s.configured, true); assert.equal(s.lifetimeDays, 30);
});
