// The Backblaze client, proven against an in-process fake of the B2 API (tests/unit/fake-b2.js). No network, no account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createFakeB2, WRITE, READ } = require('./fake-b2');
const { createB2, B2Error, explain, sha1Buf } = require('../../src/publish/b2');

const ID = 'AbCdEfGhIjKlMnOpQrStUv', ID2 = 'ZyXwVuTsRqPoNmLkJiHgFe';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-b2-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function withFake(fn, opts) {
  const fake = await createFakeB2(opts).start();
  try { await fn(fake); } finally { await fake.stop(); }
}
const client = (fake, o = {}) => {
  const slept = [];
  const b2 = createB2({ keyId: 'write-key-id', key: 'write-key-secret', bucket: fake.cfg.bucket, authUrl: fake.url, sleep: async (ms) => { slept.push(ms); }, ...o });
  b2.slept = slept; return b2;
};
const rand = (n) => crypto.randomBytes(n);

test('authorize reads the v4 answer, finds the bucket and keeps the token', () => withFake(async (fake) => {
  const b2 = client(fake), a = await b2.authorize();
  assert.equal(a.bucketId, fake.cfg.bucketId); assert.equal(a.version, 'v4'); assert.ok(a.capabilities.includes('writeFiles'));
  await b2.authorize(); assert.equal(fake.count('b2_authorize_account'), 1, 'the token is reused');
}));

test('if v4 does not exist the older API is used for everything after', () => withFake(async (fake) => {
  const b2 = client(fake); await b2.putFile(`p/${ID}/meta.json`, rand(10), { contentType: 'application/json' });
  assert.ok(fake.calls.some((c) => c.api === 'b2_get_upload_url' && c.path === '/b2api/v3/b2_get_upload_url'));
}, { versions: ['v3'] }));

test('a wrong key is a plain "copy it again" message, not a stack trace', () => withFake(async (fake) => {
  const b2 = client(fake, { key: 'nope' });
  await assert.rejects(b2.authorize(), (e) => e.code === 'bad_key' && /Copy them again/.test(explain(e)));
}));

test('a key that can reach every bucket is refused (the stored key must be limited to one bucket)', () => withFake(async (fake) => {
  const b2 = client(fake, { keyId: 'master', key: 'master-secret' });
  await assert.rejects(b2.authorize(), (e) => e.code === 'key_not_restricted' && /limited to the one bucket/.test(e.message));
}, { keys: [{ keyId: 'master', key: 'master-secret', capabilities: WRITE, restricted: false }] }));

test('a key for a different bucket is refused and the message names the bucket it can use', () => withFake(async (fake) => {
  const b2 = client(fake, { bucket: 'someone-elses' });
  await assert.rejects(b2.authorize(), (e) => e.code === 'wrong_bucket' && e.message.includes(fake.cfg.bucket));
}));

test('check() passes for a Read and Write key and names what a weaker key cannot do', () => withFake(async (fake) => {
  const ok = await client(fake).check(); assert.equal(ok.bucket, fake.cfg.bucket);
  await assert.rejects(client(fake, { keyId: 'read-key-id', key: 'read-key-secret' }).check(), (e) => e.code === 'missing_capability' && /upload files/.test(e.message));
}));

test('check() notices a key without delete rights', () => withFake(async (fake) => {
  await assert.rejects(client(fake).check(), (e) => /delete files/.test(e.message) && !/upload/.test(e.message));
}, { keys: [{ keyId: 'write-key-id', key: 'write-key-secret', capabilities: WRITE.filter((c) => c !== 'deleteFiles'), restricted: true }] }));

test('a small Buffer goes up in one call and arrives byte for byte, with its type and progress', () => withFake(async (fake) => {
  const data = rand(700 * 1024), seen = [], b2 = client(fake);
  const r = await b2.putFile(`p/${ID}/video.mp4`, data, { contentType: 'video/mp4', onProgress: (d, t) => seen.push([d, t]) });
  assert.equal(r.size, data.length);
  assert.deepEqual(fake.read(`p/${ID}/video.mp4`), data);
  assert.equal(fake.list()[0].contentType, 'video/mp4'); assert.equal(fake.list()[0].sha1, sha1Buf(data));
  assert.deepEqual(fake.apiNames(), ['b2_authorize_account', 'b2_get_upload_url', 'b2_upload_file']);
  assert.deepEqual(seen.at(-1), [data.length, data.length]);
  assert.ok(seen.length > 2 && seen.every((s, i) => i === 0 || s[0] >= seen[i - 1][0]), 'progress only goes forward');
}));

test('a file on disk is streamed, not read into memory', () => withFake(async (fake) => {
  const f = path.join(tmp, 'small.bin'), data = rand(300 * 1024); fs.writeFileSync(f, data);
  await client(fake).putFile(`p/${ID}/video.mp4`, { file: f }, { contentType: 'video/mp4' });
  assert.deepEqual(fake.read(`p/${ID}/video.mp4`), data);
}));

test('a big Buffer is split into parts with their own SHA-1, then finished', () => withFake(async (fake) => {
  const data = rand(20000), seen = [], b2 = client(fake, { partSize: 6000 });
  const r = await b2.putFile(`p/${ID}/video.mp4`, data, { contentType: 'video/mp4', onProgress: (d, t) => seen.push(d) });
  assert.equal(r.parts, 4);
  assert.deepEqual(fake.apiNames().filter((a) => a !== 'b2_authorize_account'),
    ['b2_start_large_file', ...Array(4).fill(['b2_get_upload_part_url', 'b2_upload_part']).flat(), 'b2_finish_large_file']);
  assert.deepEqual(fake.read(`p/${ID}/video.mp4`), data);
  assert.equal(seen.at(-1), 20000); assert.ok(seen.every((d, i) => i === 0 || d >= seen[i - 1]));
}, { minPart: 5000 }));

test('a big file on disk goes up in parts too, and a part size under the minimum is raised to it', () => withFake(async (fake) => {
  const f = path.join(tmp, 'big.bin'), data = rand(12000); fs.writeFileSync(f, data);
  const r = await client(fake, { partSize: 100 }).putFile(`p/${ID}/video.mp4`, { file: f }, { contentType: 'video/mp4' });
  assert.equal(r.parts, 3, '5000 + 5000 + 2000');
  assert.deepEqual(fake.read(`p/${ID}/video.mp4`), data);
}, { minPart: 5000 }));

test('names outside p/<id>/ are refused before any request is made', () => withFake(async (fake) => {
  const b2 = client(fake);
  for (const name of ['x/y.mp4', 'p/short/video.mp4', `p/${ID}/`, `p/${ID}/a/b.mp4`, `../p/${ID}/video.mp4`, 'meta.json']) {
    await assert.rejects(b2.putFile(name, rand(5)), (e) => e.code === 'bad_name', name);
  }
  assert.equal(fake.calls.length, 0);
}));

test('a 503 is retried with a growing pause and a fresh upload URL each time', () => withFake(async (fake) => {
  fake.inject('b2_upload_file', { status: 503, code: 'service_unavailable' }, 2);
  const b2 = client(fake); await b2.putFile(`p/${ID}/meta.json`, rand(50), { contentType: 'application/json' });
  assert.equal(fake.count('b2_get_upload_url'), 3); assert.deepEqual(b2.slept, [500, 1000]); assert.equal(fake.list().length, 1);
}));

test('a cut connection is retried', () => withFake(async (fake) => {
  fake.inject('b2_upload_file', { drop: true });
  await client(fake).putFile(`p/${ID}/meta.json`, rand(50), { contentType: 'application/json' });
  assert.equal(fake.count('b2_upload_file'), 2); assert.equal(fake.list().length, 1);
}));

test('a stale upload token just means "get another upload URL"', () => withFake(async (fake) => {
  fake.inject('b2_upload_file', { status: 401, code: 'expired_auth_token', message: 'expired' });
  await client(fake).putFile(`p/${ID}/meta.json`, rand(50), { contentType: 'application/json' });
  assert.equal(fake.count('b2_get_upload_url'), 2); assert.equal(fake.list().length, 1);
}));

test('a rejected upload (400) is not repeated', () => withFake(async (fake) => {
  fake.inject('b2_upload_file', { status: 400, code: 'bad_request', message: 'nope' });
  await assert.rejects(client(fake).putFile(`p/${ID}/meta.json`, rand(50)), (e) => e.status === 400 && e.message === 'nope');
  assert.equal(fake.count('b2_upload_file'), 1);
}));

test('it gives up after the retries are used and says why', () => withFake(async (fake) => {
  fake.inject('b2_upload_file', { status: 503 }, 20);
  await assert.rejects(client(fake, { retries: 2 }).putFile(`p/${ID}/meta.json`, rand(50)), (e) => e.status === 503 && /problem/.test(explain(e)));
  assert.equal(fake.count('b2_upload_file'), 3); assert.equal(fake.list().length, 0);
}));

test('an expired account token is replaced once, silently', () => withFake(async (fake) => {
  const b2 = client(fake); await b2.authorize(); fake.expireTokens('account');
  await b2.putFile(`p/${ID}/meta.json`, rand(50), { contentType: 'application/json' });
  assert.equal(fake.count('b2_authorize_account'), 2); assert.equal(fake.list().length, 1);
}));

test('a key without write rights fails fast and is not mistaken for an expired token', () => withFake(async (fake) => {
  const b2 = client(fake, { keyId: 'read-key-id', key: 'read-key-secret' });
  await assert.rejects(b2.putFile(`p/${ID}/meta.json`, rand(5)), (e) => e.code === 'unauthorized' && /Read and Write/.test(explain(e)));
  assert.equal(fake.count('b2_authorize_account'), 1);
}));

test("Backblaze's free daily limit is not retried and is explained", () => withFake(async (fake) => {
  fake.inject('b2_upload_file', { status: 403, code: 'storage_cap_exceeded', message: 'Cannot upload' });
  await assert.rejects(client(fake).putFile(`p/${ID}/meta.json`, rand(5)), (e) => e.code === 'storage_cap_exceeded' && /free limit/.test(explain(e)));
  assert.equal(fake.count('b2_upload_file'), 1);
}));

test('a part that fails for good cancels the large file so nothing is left behind', () => withFake(async (fake) => {
  fake.inject('b2_upload_part', { status: 400, code: 'bad_request', message: 'boom' }, 1, 1); // part 1 fine, part 2 refused
  await assert.rejects(client(fake, { partSize: 6000 }).putFile(`p/${ID}/video.mp4`, rand(20000)), (e) => e.status === 400);
  assert.equal(fake.count('b2_cancel_large_file'), 1); assert.deepEqual(fake.pending(), []); assert.deepEqual(fake.list(), []);
}, { minPart: 5000 }));

test('cancelling stops a single upload and leaves nothing', () => withFake(async (fake) => {
  const ctl = new AbortController();
  await assert.rejects(client(fake).putFile(`p/${ID}/video.mp4`, rand(900 * 1024), { signal: ctl.signal, onProgress: (d) => { if (d > 1000) ctl.abort(); } }), (e) => e.code === 'cancelled');
  assert.deepEqual(fake.list(), []);
}));

test('cancelling between parts cancels the large file', () => withFake(async (fake) => {
  const ctl = new AbortController();
  await assert.rejects(client(fake, { partSize: 6000 }).putFile(`p/${ID}/video.mp4`, rand(20000), { signal: ctl.signal, onProgress: (d) => { if (d >= 6000) ctl.abort(); } }), (e) => e.code === 'cancelled');
  assert.deepEqual(fake.pending(), []); assert.deepEqual(fake.list(), []);
}, { minPart: 5000 }));

test('deletePrefix removes every version, pending large files too, across pages, and nothing outside the prefix', () => withFake(async (fake) => {
  fake.put(`p/${ID}/video.mp4`, 'v'); fake.put(`p/${ID}/thumb.jpg`, 't'); fake.put(`p/${ID}/meta.json`, 'old'); fake.put(`p/${ID}/meta.json`, 'new');
  fake.put(`p/${ID2}/meta.json`, 'other'); fake.put('keep/me.txt', 'k');
  const b2 = client(fake); await b2.authorize();
  await b2.call('b2_start_large_file', { bucketId: b2.bucketId, fileName: `p/${ID}/video2.mp4`, contentType: 'video/mp4' });
  assert.equal(await b2.deletePrefix(`p/${ID}/`), 5);
  assert.equal(fake.versionCount(`p/${ID}/`), 0); assert.deepEqual(fake.pending(), []);
  assert.ok(fake.read(`p/${ID2}/meta.json`) && fake.read('keep/me.txt'));
  assert.ok(fake.count('b2_list_file_versions') >= 3, 'the listing was read page by page');
}, { listPage: 2 }));

test('deletePrefix("p/") clears every public copy but leaves other files in the bucket', () => withFake(async (fake) => {
  fake.put(`p/${ID}/meta.json`, 'a'); fake.put(`p/${ID2}/meta.json`, 'b'); fake.put('keep/me.txt', 'k');
  assert.equal(await client(fake).deletePrefix('p/'), 2); assert.deepEqual(fake.list().map((f) => f.name), ['keep/me.txt']);
}));

test('deletePrefix refuses anything but p/ and p/<id>/ before touching the network', () => withFake(async (fake) => {
  const b2 = client(fake);
  for (const prefix of ['', 'p', 'x/', 'p/short/', `p/${ID}`, `p/${ID}/video.mp4`, '/', '*']) await assert.rejects(b2.deletePrefix(prefix), (e) => e.code === 'bad_prefix', prefix);
  assert.equal(fake.calls.length, 0);
}));

test('a version that is already gone does not stop a delete', () => withFake(async (fake) => {
  fake.put(`p/${ID}/meta.json`, 'a'); fake.put(`p/${ID}/video.mp4`, 'b');
  fake.inject('b2_delete_file_version', { status: 400, code: 'file_not_present', message: 'gone' });
  assert.equal(await client(fake).deletePrefix(`p/${ID}/`), 2);
  assert.equal(fake.versionCount(`p/${ID}/`), 1, 'the other one was really deleted');
}));

test('explain() gives a sentence for each kind of failure', () => {
  assert.match(explain(new B2Error('x', { code: 'network', retryable: true })), /internet/);
  assert.match(explain(new B2Error('x', { status: 503 })), /Try again/);
  assert.match(explain(new B2Error('no', { status: 401, code: 'unauthorized' })), /Read and Write/);
  assert.match(explain(new B2Error('x', { status: 401, code: 'bad_auth_token' })), /stopped accepting/);
  assert.match(explain(new B2Error('x', { status: 400, code: 'bad_bucket_id' })), /bucket name/);
  assert.match(explain(new B2Error('weird', { status: 418 })), /Backblaze said: weird/);
  assert.equal(explain(new B2Error('cancelled', { code: 'cancelled' })), 'Cancelled.');
});

test('a missing setting is caught when the client is made', () => {
  assert.throws(() => createB2({ keyId: 'a', key: 'b' }), (e) => e.code === 'config');
});
