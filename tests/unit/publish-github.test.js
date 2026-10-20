// Publish to GitHub: who may use it, the private-first upload order, cleanup after failures, removal (with and without delete permission), expiry,
// privacy enforcement. GitHub is the in-process fake; ffmpeg is stubbed (the encoder's own tests cover the real thing).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../src/store');
const publisher = require('../../src/publish/publisher');
const share = require('../../src/pipeline/share-copy');
const { createGitHub } = require('../../src/publish/github');
const { createFakeGitHub } = require('./fake-github');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-pubgh-'));
store.init(root, { log: () => {} });
publisher.deps.log = () => {};
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 7)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
let fake, encodeOpts;

test.beforeEach(() => {
  fake = createFakeGitHub(); encodeOpts = null;
  publisher.deps.encode = async (i, o, opts) => { encodeOpts = opts; fs.copyFileSync(i, o); };
  publisher.deps.poster = async (_i, o) => fs.writeFileSync(o, JPEG);
  publisher.deps.makeGitHub = (cfg) => createGitHub({ token: cfg.token, fetch: fake.fetch, sleep: async () => {}, pollMs: 0, retries: cfg.retries ?? 2 });
  publisher.deps.ghToken = () => '';
  store.setSettings({ integrations: { github: { token: fake.cfg.token } }, defaultPrivacy: 'link', linkExpiryDays: 0, disableDownloads: false });
});
test.afterEach(async () => {
  await publisher.idle(); publisher.stop();
  for (const v of store.list()) store.remove(v.id);
  store.mutate((d) => { d.publishQueue = []; });
});
test.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });

function mk(extra = {}) {
  const v = store.create({ title: 'Demo "one"', status: 'ready', shareable: true, guard: { model: true, speech: 'checked' }, duration: 2, ...extra });
  fs.writeFileSync(path.join(store.videoDir(v.id), 'video.mp4'), MP4);
  return v;
}
const settle = async () => { await publisher.idle(); await publisher.drainQueue(); }; // the job, then the deletions it queued
const gh = (id, opts = {}) => publisher.publish(id, { mode: 'link', host: 'github', ...opts });
async function live(extra) {
  const v = mk(extra); await gh(v.id); await publisher.idle();
  const p = store.get(v.id).publish; assert.equal(p.state, 'live', p.error); return { v, p };
}

// ---- who may use it ---------------------------------------------------------------------------------------------------------
test('every refusal happens before anything is sent to GitHub', async () => {
  const cases = [
    ['private', { privacy: { mode: 'private' } }, 'link'],
    ['email', { privacy: { mode: 'email' } }, 'link'],
    ['private', { privacy: { mode: 'nonsense' } }, 'link'],
    ['not_shareable', { shareable: false }, 'link'],
    ['not_ready', { status: 'processing' }, 'link'],
    ['not_ready', { status: 'failed' }, 'link'],
    ['no_guard', { guard: undefined }, 'link'],
    ['not_video', { type: 'image' }, 'link'],
    ['expired', { privacy: { mode: 'link', expiresAt: Date.now() - 1000 } }, 'link'],
    ['github_password', { privacy: { mode: 'password', passwordHash: 'aa:bb' } }, 'link'],   // a GitHub link cannot have a password
    ['github_downloads', { privacy: { mode: 'link', allowDownload: false } }, 'link'],        // anyone can save the file
    ['github_long', { duration: 200 }, 'link'],                                                // would not fit GitHub's file limit
    ['bad_mode', {}, 'password'],                                                              // no password option on GitHub
    ['bad_mode', {}, undefined],
  ];
  for (const [code, extra, mode] of cases) {
    const v = mk(extra);
    await assert.rejects(publisher.publish(v.id, { mode, host: 'github' }), (e) => e.name === 'PublishError' && e.code === code, `${code} ${JSON.stringify(extra)}`);
    assert.equal(store.get(v.id).publish, undefined);
  }
  assert.equal(fake.calls.length, 0);
});

test('downloads switched off for the whole workspace also close the GitHub route', async () => {
  store.setSettings({ disableDownloads: true });
  const v = mk(); await assert.rejects(gh(v.id), (e) => e.code === 'github_downloads'); assert.equal(fake.calls.length, 0);
});

test('with default privacy set to private, a video with no choice of its own is refused', async () => {
  store.setSettings({ defaultPrivacy: 'private' });
  const v = mk(); await assert.rejects(gh(v.id), (e) => e.code === 'private'); assert.equal(fake.calls.length, 0);
});

test('not set up: no token means no publish; "use my GitHub CLI login" works only when ticked and signed in', async () => {
  store.setSettings({ integrations: { github: {} } });
  const v = mk();
  await assert.rejects(gh(v.id), (e) => e.code === 'not_configured' && /Settings/.test(e.message));
  publisher.deps.ghToken = () => fake.cfg.token;
  await assert.rejects(gh(v.id), (e) => e.code === 'not_configured', 'the CLI login is not used unless the owner ticked the box');
  store.setSettings({ integrations: { github: { useGh: true } } });
  assert.equal(publisher.githubConfig().source, 'gh');
  publisher.deps.ghToken = () => '';
  assert.equal(publisher.githubConfig(), null, 'ticked but gh is not signed in');
  assert.equal(fake.calls.length, 0);
});

test('summary tells the UI what each route allows, without touching GitHub', () => {
  const v = mk({ duration: 200 }), s = publisher.summary(v);
  assert.equal(s.github.configured, true); assert.equal(s.github.can.ok, false); assert.equal(s.github.can.code, 'github_long');
  assert.equal(s.can.ok, true, 'the Backblaze route is judged on its own rules');
  const ok = publisher.summary(mk());
  assert.deepEqual(ok.github.can.modes, ['link']);
  assert.equal(fake.calls.length, 0);
});

// ---- publishing -------------------------------------------------------------------------------------------------------------
test('a publish makes a smaller copy, fills a PRIVATE repository, and only then makes it public and turns Pages on', async () => {
  const v = mk(), s = await gh(v.id);
  assert.equal(s.state, 'working'); assert.equal(s.host, 'github');
  await publisher.idle();
  const p = store.get(v.id).publish;
  assert.equal(p.state, 'live', p.error); assert.equal(p.host, 'github'); assert.equal(p.mode, 'link'); assert.equal(p.allowDownload, true);
  assert.match(p.repo, /^kairos-share-[0-9a-f]{20}$/);
  assert.equal(p.url, `https://octo.github.io/${p.repo}/`);
  assert.equal(encodeOpts.limits, share.GITHUB_LIMITS, 'GitHub gets the smaller copy');
  const r = fake.repos.get(p.repo);
  assert.equal(r.private, false);
  assert.deepEqual([...r.files.keys()].sort(), ['index.html', 'thumb.jpg', 'video.mp4']);
  assert.ok(r.files.get('video.mp4').equals(MP4));
  assert.match(r.files.get('index.html').toString(), /Demo &quot;one&quot;/);
  // the order that matters: files while private, THEN public, THEN Pages
  const ops = fake.calls.map((c) => `${c.method} ${c.url.replace(/^api\.github\.com\/repos\/octo\/[^/]+/, '')}`);
  const lastPut = ops.map((o, i) => (o.startsWith('PUT') ? i : -1)).filter((i) => i >= 0).pop();
  const patch = ops.findIndex((o) => o.startsWith('PATCH')), pages = ops.findIndex((o) => o === 'POST /pages');
  assert.ok(lastPut < patch && patch < pages, ops.join(' | '));
  assert.ok(Math.abs(p.expiresAt - (p.publishedAt + 30 * 86400000)) < 60000);
  // the page really opens for an anonymous viewer, and the Kairos summary shows the link
  assert.equal((await fake.fetch(p.url)).status, 200);
  const sum = publisher.summary(store.get(v.id));
  assert.equal(sum.url, p.url); assert.equal(sum.repoUrl, `https://github.com/octo/${p.repo}`);
});

test('the link is not shown while the page is still being built', async () => {
  fake.cfg.buildPolls = 50;
  const v = mk(); await gh(v.id);
  const sum = publisher.summary(store.get(v.id));
  assert.equal(sum.state, 'working'); assert.equal(sum.url, undefined);
  await publisher.idle();
});

test('a GitHub copy does not count against the Backblaze 9 GB budget', async () => {
  await live();
  assert.equal(publisher.usedBytes(), 0);
  const st = publisher.status();
  assert.equal(st.live, 0); assert.equal(st.github.live, 1); assert.equal(st.github.configured, true);
});

test('republishing keeps the old link live until the new one is ready, then deletes the old repository', async () => {
  const { v, p } = await live();
  await gh(v.id);
  assert.equal(store.get(v.id).publish.state, 'working');
  assert.equal(publisher.summary(store.get(v.id)).previous.url, p.url);
  assert.equal(fake.repos.has(p.repo), true, 'old one still there while the new one is built');
  await settle();
  const q = store.get(v.id).publish;
  assert.equal(q.state, 'live'); assert.notEqual(q.repo, p.repo);
  assert.equal(fake.repos.has(p.repo), false); assert.equal(fake.repos.has(q.repo), true);
  assert.equal(publisher.queue().length, 0);
});

// ---- failures: nothing public is left behind --------------------------------------------------------------------------------
test('a failure while uploading deletes the half-made repository; it was never public', async () => {
  fake.inject(/PUT .*\/contents\/index\.html$/, { status: 500, body: { message: 'boom' } });
  const v = mk(); await gh(v.id); await settle();
  const p = store.get(v.id).publish;
  assert.equal(p.state, 'failed'); assert.equal(p.host, 'github'); assert.match(p.error, /boom/);
  assert.equal(fake.repos.size, 0); assert.equal(publisher.queue().length, 0);
  assert.equal(fake.calls.some((c) => c.method === 'PATCH'), false, 'never made public');
});

test('a failed Pages build deletes the repository too, even though it had been made public', async () => {
  fake.cfg.pagesError = 'Page build failed.';
  const v = mk(); await gh(v.id); await settle();
  assert.equal(store.get(v.id).publish.state, 'failed'); assert.match(store.get(v.id).publish.error, /Page build failed/);
  assert.equal(fake.repos.size, 0);
});

test('a privacy change while publishing stops it before the repository is ever made public', async () => {
  const v = mk();
  publisher.deps.poster = async (_i, o) => { fs.writeFileSync(o, JPEG); store.update(v.id, { privacy: { mode: 'private' } }); };
  await gh(v.id); await publisher.idle();
  assert.equal(store.get(v.id).publish.state, 'failed'); assert.match(store.get(v.id).publish.error, /privacy settings changed/);
  assert.equal(fake.publicRepos().length, 0); assert.equal(fake.calls.some((c) => c.method === 'PATCH'), false);
});

test('cancelling during the encode leaves nothing on GitHub and no record', async () => {
  publisher.deps.encode = (i, o, opts) => new Promise((_res, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('cancelled'), { code: 'cancelled' }))));
  const v = mk(); await gh(v.id);
  await publisher.unpublish(v.id);
  assert.equal(store.get(v.id).publish, null); assert.equal(fake.calls.length, 0);
});

test('a bad token fails calmly and the message says what to do', async () => {
  store.setSettings({ integrations: { github: { token: 'wrong' } } });
  const v = mk(); await gh(v.id); await publisher.idle();
  const p = store.get(v.id).publish;
  assert.equal(p.state, 'failed'); assert.match(p.error, /did not accept the token/); assert.equal(fake.repos.size, 0);
});

// ---- removal ----------------------------------------------------------------------------------------------------------------
test('Unpublish deletes the repository', async () => {
  const { v, p } = await live();
  const r = await publisher.unpublish(v.id);
  assert.equal(r.removal, 'done'); assert.equal(fake.repos.has(p.repo), false); assert.equal(store.get(v.id).publish, null);
});

test('without delete permission the link is turned off in Kairos, the repository is queued, and the owner is told where to delete it', async () => {
  const { v, p } = await live();
  fake.cfg.scopes = ['repo'];
  const r = await publisher.unpublish(v.id);
  assert.equal(r.removal, 'queued'); assert.match(r.removalError, new RegExp(`github\\.com/octo/${p.repo}`)); assert.match(r.removalError, /delete_repo/);
  assert.equal(store.get(v.id).publish, null, 'no link in Kairos any more');
  assert.equal(fake.repos.has(p.repo), true, 'GitHub still has it');
  assert.equal(publisher.status().github.queued, 1); assert.equal(publisher.status().github.errors[0].repo, p.repo);
  fake.cfg.scopes = ['repo', 'delete_repo']; // the owner adds the permission
  await publisher.drainQueue();
  assert.equal(fake.repos.has(p.repo), false); assert.equal(publisher.queue().length, 0);
});

test('offline: the deletion waits in the queue and is retried', async () => {
  const { v, p } = await live();
  fake.inject(/./, { networkError: true });
  const r = await publisher.unpublish(v.id);
  assert.equal(r.removal, 'queued'); assert.equal(fake.repos.has(p.repo), true);
  fake.clearInjections(); await publisher.drainQueue();
  assert.equal(fake.repos.has(p.repo), false);
});

test('a repository that belongs to another GitHub account is never deleted by guesswork', async () => {
  store.mutate((d) => { d.publishQueue = [{ repo: 'kairos-share-x', owner: 'someone-else', host: 'github', since: 1, tries: 0 }]; });
  fake.repos.set('kairos-share-x', { name: 'kairos-share-x', private: false, files: new Map(), pages: null });
  await publisher.drainQueue();
  assert.equal(fake.repos.has('kairos-share-x'), true);
  assert.match(publisher.queue()[0].error, /someone-else/);
});

test('deleting the video, the 30-day expiry and "remove all" each delete the repository', async () => {
  publisher.start(); // the removal hook is installed by start()
  const a = await live(), b = await live(), c = await live();
  store.remove(a.v.id); await settle();
  assert.equal(fake.repos.has(a.p.repo), false, 'video deleted');
  store.update(b.v.id, { publish: { ...store.get(b.v.id).publish, expiresAt: Date.now() - 1000 } });
  await publisher.sweep();
  assert.equal(fake.repos.has(b.p.repo), false, 'expired'); assert.equal(store.get(b.v.id).publish.state, 'expired');
  await publisher.removeAll();
  assert.equal(fake.repos.has(c.p.repo), false, 'remove all'); assert.equal(store.get(c.v.id).publish, null);
  assert.equal(fake.repos.size, 0);
});

test('tightening privacy, switching on a password, or switching off downloads takes the GitHub link down', async () => {
  for (const [extra, why] of [[{ privacy: { mode: 'private' } }, /Private/], [{ privacy: { mode: 'password', passwordHash: 'aa:bb' } }, /password/], [{ privacy: { mode: 'link', allowDownload: false } }, /downloads/]]) {
    const { v, p } = await live();
    store.update(v.id, extra); await publisher.enforce(v.id);
    const rec = store.get(v.id).publish;
    assert.equal(rec.state, 'removed'); assert.match(rec.reason, why); assert.equal(fake.repos.has(p.repo), false);
  }
});

test('a Backblaze route and a GitHub route can replace one another without leaving the old copy behind', async () => {
  const { v, p } = await live();
  const old = { ...p, host: undefined, repo: undefined, id: 'A'.repeat(22), url: 'https://x.example/v/' + 'A'.repeat(22), owner: undefined, repoCreated: undefined };
  store.update(v.id, { publish: old });                         // pretend the video was last published through Backblaze
  await gh(v.id); await publisher.idle();
  assert.equal(store.get(v.id).publish.host, 'github');
  assert.deepEqual(publisher.queue().map((q) => q.prefix), [`p/${'A'.repeat(22)}/`], 'the old Backblaze copy is queued for deletion (no Backblaze is set up in this test, so it waits)');
});
