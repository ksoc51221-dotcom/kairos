// The GitHub client against the in-process fake: sign-in and permissions, private-first repositories, retries, Pages, deleting, the viewer's page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitHub, GitHubError, explain, pageHtml } = require('../../src/publish/github');
const { createFakeGitHub } = require('./fake-github');

const client = (fake, o = {}) => createGitHub({ token: fake.cfg.token, fetch: fake.fetch, sleep: async () => {}, pollMs: 0, ...o });

test('check reports who you are and what the token may do', async () => {
  const c = await client(createFakeGitHub()).check();
  assert.deepEqual(c, { login: 'octo', scopes: ['repo', 'delete_repo'], canCreate: true, canDelete: true });
  const limited = await client(createFakeGitHub({ scopes: ['repo'] })).check();
  assert.equal(limited.canDelete, false);
  const fine = await client(createFakeGitHub({ scopes: null })).check(); // fine-grained tokens do not report scopes
  assert.equal(fine.scopes, null); assert.equal(fine.canCreate, null); assert.equal(fine.canDelete, null);
});

test('a wrong or expired token is explained, not shown as a raw error', async () => {
  const fake = createFakeGitHub();
  await assert.rejects(client(fake, { token: 'nope' }).check(), (e) => e.code === 'bad_token' && /did not accept the token/.test(explain(e)));
  assert.throws(() => createGitHub({ token: '' }), (e) => e.code === 'bad_token');
});

test('a repository starts private, can be taken, and a token without "repo" cannot make one', async () => {
  const fake = createFakeGitHub(), g = client(fake);
  await g.createRepo('kairos-share-aaaa', 'Shared with Kairos');
  assert.equal(fake.repos.get('kairos-share-aaaa').private, true, 'private until makePublic');
  await assert.rejects(g.createRepo('kairos-share-aaaa', 'x'), (e) => e.code === 'invalid');
  const weak = createFakeGitHub({ scopes: ['gist'] });
  await assert.rejects(client(weak).createRepo('r', 'x'), (e) => e.code === 'no_create' && /repo/.test(explain(e)));
});

test('writing a file to a repository that has only just been created retries the 404', async () => {
  const fake = createFakeGitHub({ appearAfter: 2 }), g = client(fake);
  await g.createRepo('r1', 'x');
  await g.putFile('r1', 'video.mp4', Buffer.from('hello'), 'Add video');
  assert.equal(fake.repos.get('r1').files.get('video.mp4').toString(), 'hello');
  assert.equal(fake.calls.filter((c) => c.method === 'PUT').length, 3);
});

test('Pages needs a public repository; waitForPages polls until the build is done and the address answers', async () => {
  const fake = createFakeGitHub({ buildPolls: 3 }), g = client(fake);
  await g.createRepo('r2', 'x');
  await g.putFile('r2', 'index.html', Buffer.from('<h1>hi</h1>'), 'Add page');
  await assert.rejects(g.enablePages('r2'), (e) => e.code === 'invalid'); // still private
  await g.makePublic('r2'); await g.enablePages('r2'); await g.enablePages('r2'); // enabling twice is fine
  const url = await g.waitForPages('r2');
  assert.equal(url, 'https://octo.github.io/r2/');
  assert.equal((await (await fake.fetch(url)).text()), '<h1>hi</h1>');
  assert.ok(fake.calls.filter((c) => c.url.endsWith('/pages/builds/latest')).length >= 3);
});

test('a failed Pages build and one that never finishes both say what to do', async () => {
  const bad = createFakeGitHub({ pagesError: 'Page build failed.' }), g = client(bad);
  await g.createRepo('r3', 'x'); await g.makePublic('r3'); await g.enablePages('r3');
  await assert.rejects(g.waitForPages('r3'), (e) => e.code === 'pages_failed' && /Page build failed/.test(e.message));
  const slow = createFakeGitHub({ buildPolls: 999 }), s = client(slow, { pollMax: 4 });
  await s.createRepo('r4', 'x'); await s.makePublic('r4'); await s.enablePages('r4');
  await assert.rejects(s.waitForPages('r4'), (e) => e.code === 'pages_failed' && /still building/.test(e.message));
});

test('deleting: a repository that is already gone counts as deleted; a token without delete_repo gets the manual link', async () => {
  const fake = createFakeGitHub(), g = client(fake);
  await g.createRepo('r5', 'x');
  await g.deleteRepo('r5'); assert.equal(fake.repos.has('r5'), false);
  await g.deleteRepo('r5'); // 404 is fine
  const weak = createFakeGitHub({ scopes: ['repo'] }), w = client(weak);
  await w.createRepo('r6', 'x');
  await assert.rejects(w.deleteRepo('r6'), (e) => e.code === 'no_delete' && /github\.com\/octo\/r6/.test(explain(e)) && /delete_repo/.test(explain(e)));
  assert.equal(weak.repos.has('r6'), true);
});

test('network errors and rate limits are retried a few times, then reported plainly', async () => {
  const fake = createFakeGitHub();
  fake.inject(/GET \/user$/, { networkError: true, times: 2 });
  assert.equal((await client(fake).user()).login, 'octo'); // third try works
  const down = createFakeGitHub(); down.inject(/GET \/user$/, { networkError: true });
  await assert.rejects(client(down, { retries: 2 }).user(), (e) => e.code === 'network' && /internet/.test(explain(e)));
  const limited = createFakeGitHub(); limited.inject(/GET \/user$/, { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' }, times: 1 });
  assert.equal((await client(limited).user()).login, 'octo');
  const stuck = createFakeGitHub(); stuck.inject(/GET \/user$/, { status: 429, body: { message: 'slow down' } });
  await assert.rejects(client(stuck, { retries: 1 }).user(), (e) => e.code === 'rate_limit');
});

test('an AbortSignal stops a request with "cancelled"', async () => {
  const ctl = new AbortController(); ctl.abort();
  await assert.rejects(client(createFakeGitHub()).user({ signal: ctl.signal }), (e) => e instanceof GitHubError && e.code === 'cancelled');
});

test('the viewer page shows the title safely and loads nothing from anywhere else', () => {
  const html = pageHtml({ title: '<script>alert(1)</script> & "quotes"', base: 'https://octo.github.io/r/' });
  assert.doesNotMatch(html, /<script>alert/); assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot;/);
  assert.match(html, /<video src="video\.mp4" poster="thumb\.jpg" controls playsinline/);
  assert.match(html, /noindex/);
  assert.doesNotMatch(html, /https?:\/\/(?!octo\.github\.io)/, 'no third-party addresses');
});
