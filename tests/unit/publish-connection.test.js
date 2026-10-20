// The Settings "Test" button end to end: the publisher uploads a real 1-second clip to the fake Backblaze, then checks the real Worker code
// (served over HTTP on 127.0.0.1) can read and stream it. Failures must come back as plain-language steps.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../src/store');
const publisher = require('../../src/publish/publisher');
const { createB2 } = require('../../src/publish/b2');
const { createFakeB2 } = require('./fake-b2');
const { startWorkerHost } = require('./worker-host');

let fake, host, env;
test.before(async () => {
  store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-conn-')), { log: () => {} });
  publisher.deps.log = () => {};
  fake = await createFakeB2().start();
  env = { B2_KEY_ID: 'read-key-id', B2_APP_KEY: 'read-key-secret', B2_BUCKET: fake.cfg.bucket, COOKIE_KEY: 'c'.repeat(32), B2_AUTH_URL: fake.url, UNLOCK_DELAY_MS: '0' };
  host = await startWorkerHost(env);
  publisher.deps.makeB2 = (c) => createB2({ keyId: c.keyId, key: c.key, bucket: c.bucket, authUrl: fake.url, sleep: async () => {}, retries: 1 });
});
test.beforeEach(() => { host.worker._reset(); setup(); });
test.after(async () => { publisher.stop(); await host.stop(); await fake.stop(); store.close(); });
const setup = (o = {}) => store.setSettings({ integrations: { publish: { workerUrl: host.url, bucket: fake.cfg.bucket, accessId: 'write-key-id', appKey: 'write-key-secret', ...o } } });
const failed = (r) => r.steps.find((s) => !s.ok);

test('everything right: all steps pass and the bucket is left clean', async () => {
  const r = await publisher.testConnection();
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.deepEqual(r.steps.map((s) => s.name), ['Backblaze key', 'Upload', 'Worker address', 'Worker reads the bucket', 'Video streaming', 'Unknown links', 'Cleanup']);
  assert.deepEqual(fake.list(), []); assert.equal(fake.versionCount(), 0);
});

test('not filled in yet', async () => {
  setup({ appKey: '' }); const n = fake.calls.length, r = await publisher.testConnection();
  assert.equal(r.ok, false); assert.equal(r.steps[0].name, 'Settings'); assert.equal(fake.calls.length, n, 'no request was sent');
});

test('a wrong Backblaze key is explained before anything else is tried', async () => {
  setup({ appKey: 'nope' }); const r = await publisher.testConnection();
  assert.equal(failed(r).name, 'Backblaze key'); assert.match(failed(r).detail, /\w/); assert.equal(r.steps.length, 1);
});

test('an unrestricted key is refused: it must be limited to one bucket', async () => {
  fake.keys.push({ keyId: 'master', key: 'master-secret', capabilities: fake.keys[0].capabilities, restricted: false, namePrefix: null });
  setup({ accessId: 'master', appKey: 'master-secret' }); const r = await publisher.testConnection();
  assert.equal(failed(r).name, 'Backblaze key'); assert.match(failed(r).detail, /one bucket|only one bucket|limited/i);
  fake.keys.pop();
});

test('a Worker address that nobody answers on', async () => {
  setup({ workerUrl: 'http://127.0.0.1:9' }); const r = await publisher.testConnection();
  assert.equal(failed(r).name, 'Worker address'); assert.match(failed(r).detail, /Could not reach/); assert.deepEqual(fake.list(), [], 'the test clip was still cleaned up');
});

test('an address that answers but is not the Kairos Worker', async () => {
  setup({ workerUrl: fake.url }); const r = await publisher.testConnection();
  assert.equal(failed(r).name, 'Worker address'); assert.match(failed(r).detail, /does not look like the Kairos Worker/);
});

test('a Worker with the wrong read key says which setting to fix', async () => {
  host.worker._reset(); const bad = env.B2_APP_KEY; env.B2_APP_KEY = 'wrong';
  try { const r = await publisher.testConnection(); assert.equal(failed(r).name, 'Worker reads the bucket'); assert.match(failed(r).detail, /B2_APP_KEY/); }
  finally { env.B2_APP_KEY = bad; }
});

test('a Worker pointed at the wrong bucket', async () => {
  const bad = env.B2_BUCKET; env.B2_BUCKET = 'other-bucket';
  try { const r = await publisher.testConnection(); assert.equal(failed(r).name, 'Worker reads the bucket'); assert.match(failed(r).detail, /B2_BUCKET/); }
  finally { env.B2_BUCKET = bad; }
});

test('a Worker missing its secrets', async () => {
  const bad = env.COOKIE_KEY; env.COOKIE_KEY = '';
  try { const r = await publisher.testConnection(); assert.equal(failed(r).name, 'Worker reads the bucket'); assert.match(failed(r).detail, /COOKIE_KEY/); }
  finally { env.COOKIE_KEY = bad; }
});

test('if the clean-up cannot finish, it is queued rather than forgotten', async () => {
  fake.inject('b2_list_file_versions', { drop: true }, 2);
  const r = await publisher.testConnection();
  assert.equal(failed(r).name, 'Cleanup'); assert.equal(publisher.queue().length, 1);
  await publisher.drainQueue(); assert.deepEqual(fake.list(), []);
});
