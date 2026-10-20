// The Cloudflare Worker (cloud/worker.js) against the in-process fake Backblaze: pages, password gate, cookie-gated media, Range handling, headers.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { createFakeB2 } = require('./fake-b2');

let fake, worker, env;
const ID = crypto.randomBytes(16).toString('base64url');
const VIDEO = crypto.randomBytes(1000);
const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const H = 'https://links.example.workers.dev';

test.before(async () => {
  worker = await import(pathToFileURL(path.join(__dirname, '../../cloud/worker.js')).href);
  fake = await createFakeB2().start();
  env = { B2_KEY_ID: 'read-key-id', B2_APP_KEY: 'read-key-secret', B2_BUCKET: fake.cfg.bucket, COOKIE_KEY: 'cookie-secret-123', B2_AUTH_URL: fake.url, UNLOCK_DELAY_MS: '0' };
});
test.beforeEach(() => worker._reset());
test.after(async () => { await fake.stop(); });

const metaOf = (o = {}) => ({ v: 1, title: 'Demo <b>&"quotes"', mode: 'link', createdAt: Date.now(), expiresAt: Date.now() + 86400000, bytes: VIDEO.length, duration: 2, allowDownload: true, hasThumb: true, ...o });
function seed(id, meta, { video = VIDEO, thumb = THUMB } = {}) {
  fake.put(`p/${id}/video.mp4`, video, 'video/mp4'); if (thumb) fake.put(`p/${id}/thumb.jpg`, thumb, 'image/jpeg');
  fake.put(`p/${id}/meta.json`, JSON.stringify(meta), 'application/json');
}
const call = (p, { method = 'GET', headers = {}, body, e = env } = {}) => worker.default.fetch(new Request(H + p, { method, headers, body }), e);
const pwMeta = (pw, extra = {}) => {
  const salt = crypto.randomBytes(16), dk = crypto.pbkdf2Sync(pw.normalize('NFC'), salt, 1000, 32, 'sha256');
  return { dk: dk.toString('hex'), meta: metaOf({ mode: 'password', pw: { salt: salt.toString('hex'), iter: 1000, check: crypto.createHash('sha256').update(dk).digest('hex') }, ...extra }) };
};

test('healthz, the front page and robots', async () => {
  const h = await call('/healthz'); assert.equal(h.status, 200); assert.equal(await h.text(), 'ok');
  assert.equal((await call('/')).status, 200); assert.match(await (await call('/robots.txt')).text(), /Disallow: \//);
  assert.equal(fake.calls.length, 0, 'none of these touch the bucket');
});

test('a link-mode page: the title is escaped, the video points at this Worker, and sharing previews are on', async () => {
  seed(ID, metaOf());
  const r = await call(`/v/${ID}`), html = await r.text();
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/);
  assert.ok(html.includes('Demo &lt;b&gt;&amp;&quot;quotes&quot;'), 'title escaped'); assert.ok(!html.includes('<b>&"quotes"'));
  assert.ok(html.includes(`src="/m/${ID}/video.mp4"`)); assert.ok(html.includes(`poster="/m/${ID}/thumb.jpg"`));
  assert.ok(html.includes(`og:image" content="${H}/m/${ID}/thumb.jpg"`));
  assert.ok(html.includes('Download'));
});

test('every response carries the privacy headers, and the page has a nonce CSP with no outside sources', async () => {
  seed(ID, metaOf());
  for (const p of [`/v/${ID}`, `/v/${'x'.repeat(22)}`, '/healthz', `/m/${ID}/thumb.jpg`]) {
    const r = await call(p); await r.arrayBuffer();
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', p); assert.match(r.headers.get('x-robots-tag'), /noindex/, p);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p); assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
  }
  const csp = (await call(`/v/${ID}`)).headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'nonce-[A-Za-z0-9]+'/); assert.match(csp, /frame-ancestors 'none'/); assert.ok(!/https?:/.test(csp));
  assert.equal((await call(`/v/${ID}`)).headers.get('cache-control'), 'private, no-store');
});

test('unknown, malformed and expired links', async () => {
  const unknown = await call(`/v/${crypto.randomBytes(16).toString('base64url')}`); assert.equal(unknown.status, 404); assert.match(await unknown.text(), /not found/i);
  for (const p of ['/v/short', '/v/' + 'a'.repeat(40), '/v/../etc', '/m/nope/video.mp4', `/zzz`]) assert.equal((await call(p)).status, 404, p);
  const old = crypto.randomBytes(16).toString('base64url'); seed(old, metaOf({ expiresAt: Date.now() - 1000 }));
  const r = await call(`/v/${old}`); assert.equal(r.status, 410); assert.match(await r.text(), /expired/i);
  assert.equal((await call(`/m/${old}/video.mp4`)).status, 410);
});

test('a half-written upload (no meta.json yet) is "not found", never a broken page', async () => {
  const half = crypto.randomBytes(16).toString('base64url'); fake.put(`p/${half}/video.mp4`, VIDEO, 'video/mp4');
  assert.equal((await call(`/v/${half}`)).status, 404); assert.equal((await call(`/m/${half}/video.mp4`)).status, 404);
});

test('the video streams in ranges: partial, open-ended, suffix, whole-file (B2 answers 200, the Worker says 206), and impossible', async () => {
  seed(ID, metaOf());
  const get = async (range) => { const r = await call(`/m/${ID}/video.mp4`, { headers: range ? { Range: range } : {} }); return { r, body: Buffer.from(await r.arrayBuffer()) }; };
  let x = await get('bytes=0-99'); assert.equal(x.r.status, 206); assert.equal(x.r.headers.get('content-range'), 'bytes 0-99/1000'); assert.equal(x.r.headers.get('content-length'), '100'); assert.deepEqual(x.body, VIDEO.subarray(0, 100));
  assert.equal(x.r.headers.get('accept-ranges'), 'bytes'); assert.equal(x.r.headers.get('content-type'), 'video/mp4');
  x = await get('bytes=500-'); assert.equal(x.r.status, 206); assert.equal(x.r.headers.get('content-range'), 'bytes 500-999/1000'); assert.deepEqual(x.body, VIDEO.subarray(500));
  x = await get('bytes=-100'); assert.equal(x.r.status, 206); assert.equal(x.r.headers.get('content-range'), 'bytes 900-999/1000'); assert.deepEqual(x.body, VIDEO.subarray(900));
  x = await get('bytes=0-'); assert.equal(x.r.status, 206, 'whole-file range: B2 sends 200 without Content-Range'); assert.equal(x.r.headers.get('content-range'), 'bytes 0-999/1000'); assert.deepEqual(x.body, VIDEO);
  x = await get('bytes=0-99999'); assert.equal(x.r.status, 206); assert.equal(x.r.headers.get('content-range'), 'bytes 0-999/1000');
  x = await get('bytes=0-1'); assert.equal(x.r.status, 206); assert.equal(x.body.length, 2);
  x = await get('bytes=5000-6000'); assert.equal(x.r.status, 416); assert.equal(x.r.headers.get('content-range'), 'bytes */1000');
  x = await get('bytes=-0'); assert.equal(x.r.status, 416);
  x = await get(null); assert.equal(x.r.status, 200); assert.equal(x.r.headers.get('accept-ranges'), 'bytes'); assert.equal(x.r.headers.get('content-length'), '1000'); assert.deepEqual(x.body, VIDEO);
  x = await get('bytes=0-1,5-9'); assert.equal(x.r.status, 200, 'multi-range is not supported: the whole file is sent');
  const sent = fake.calls.filter((c) => c.api === 'download' && c.path.endsWith('video.mp4')).map((c) => c.range).filter(Boolean);
  assert.ok(sent.every((s) => /^bytes=\d+-\d+$/.test(s)), `explicit absolute ranges only: ${sent}`);
});

test('HEAD works for the page and the video', async () => {
  seed(ID, metaOf());
  const p = await call(`/v/${ID}`, { method: 'HEAD' }); assert.equal(p.status, 200); assert.equal((await p.text()), '');
  const v = await call(`/m/${ID}/video.mp4`, { method: 'HEAD' }); assert.equal(v.status, 200); assert.equal(v.headers.get('content-length'), '1000');
});

test('the thumbnail is served only when there is one', async () => {
  seed(ID, metaOf()); const t = await call(`/m/${ID}/thumb.jpg`); assert.equal(t.status, 200); assert.equal(t.headers.get('content-type'), 'image/jpeg'); assert.deepEqual(Buffer.from(await t.arrayBuffer()), THUMB);
  const n = crypto.randomBytes(16).toString('base64url'); seed(n, metaOf({ hasThumb: false }), { thumb: null });
  assert.equal((await call(`/m/${n}/thumb.jpg`)).status, 404); assert.ok(!(await (await call(`/v/${n}`)).text()).includes('poster='));
});

test('downloads: the link only exists, and works, when the owner allowed it', async () => {
  seed(ID, metaOf());
  const ok = await call(`/m/${ID}/video.mp4?download=1`); assert.equal(ok.status, 200); assert.match(ok.headers.get('content-disposition'), /^attachment; filename="Demo bquotes\.mp4"$/); await ok.arrayBuffer();
  const off = crypto.randomBytes(16).toString('base64url'); seed(off, metaOf({ allowDownload: false }));
  assert.ok(!(await (await call(`/v/${off}`)).text()).includes('Download'));
  const r = await call(`/m/${off}/video.mp4?download=1`); assert.equal(r.status, 403);
  assert.equal((await call(`/m/${off}/video.mp4`)).status, 200, 'the player itself still streams it');
});

test('password mode: the gate shows nothing about the video, and neither the video nor the poster is served without the cookie', async () => {
  const { meta } = pwMeta('hunter2 hunter2'); const id = crypto.randomBytes(16).toString('base64url'); seed(id, meta);
  const r = await call(`/v/${id}`), html = await r.text();
  assert.equal(r.status, 200); assert.match(html, /Password needed/); assert.ok(!html.includes('Demo'), 'no title'); assert.ok(!html.includes('og:image')); assert.ok(!html.includes('video.mp4'));
  assert.ok(html.includes(`data-salt="${meta.pw.salt}"`) && html.includes('data-iter="1000"'));
  for (const f of ['video.mp4', 'thumb.jpg']) assert.equal((await call(`/m/${id}/${f}`)).status, 401, f);
  assert.equal((await call(`/m/${id}/video.mp4`, { headers: { Cookie: `kp_${id}=${'0'.repeat(64)}` } })).status, 401);
});

test('password mode: the right derived key unlocks; the cookie then opens page and media; a wrong key does not', async () => {
  const { meta, dk } = pwMeta('hunter2 hunter2'); const id = crypto.randomBytes(16).toString('base64url'); seed(id, meta);
  const post = (b, h = {}) => call(`/v/${id}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: typeof b === 'string' ? b : JSON.stringify(b) });
  for (const bad of [{ dk: '0'.repeat(64) }, { dk: 'zz' }, { dk: dk.toUpperCase() }, {}, 'not json']) { const r = await post(bad); assert.equal(r.status, 403, JSON.stringify(bad)); assert.equal(r.headers.get('set-cookie'), null); }
  const ok = await post({ dk }); assert.equal(ok.status, 200);
  const sc = ok.headers.get('set-cookie'); assert.match(sc, new RegExp(`^kp_${id}=[0-9a-f]{64}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$`));
  const cookie = sc.split(';')[0];
  const page = await (await call(`/v/${id}`, { headers: { Cookie: cookie } })).text();
  assert.ok(page.includes('Demo'), 'title after unlock'); assert.ok(page.includes(`/m/${id}/video.mp4`)); assert.ok(!page.includes('og:image'), 'no preview tags for a protected video');
  const v = await call(`/m/${id}/video.mp4`, { headers: { Cookie: cookie, Range: 'bytes=0-9' } }); assert.equal(v.status, 206); await v.arrayBuffer();
  assert.equal((await call(`/m/${id}/thumb.jpg`, { headers: { Cookie: cookie } })).status, 200);
  // a cookie from another link never works here
  const other = crypto.randomBytes(16).toString('base64url'); seed(other, meta);
  assert.equal((await call(`/m/${other}/video.mp4`, { headers: { Cookie: `kp_${other}=${cookie.split('=')[1]}` } })).status, 401);
});

test('changing the password invalidates old cookies', async () => {
  const a = pwMeta('first password!'), id = crypto.randomBytes(16).toString('base64url'); seed(id, a.meta);
  const r = await call(`/v/${id}/unlock`, { method: 'POST', body: JSON.stringify({ dk: a.dk }) }); const cookie = r.headers.get('set-cookie').split(';')[0];
  const b = pwMeta('second password!'); fake.put(`p/${id}/meta.json`, JSON.stringify(b.meta)); worker._reset();
  assert.equal((await call(`/m/${id}/video.mp4`, { headers: { Cookie: cookie } })).status, 401);
});

test('the browser-side key derivation matches what Kairos stores (PBKDF2-SHA256, NFC password, hex salt)', async () => {
  const pw = 'Pässwörd-ключ-密码 123'.normalize('NFD'); // typed decomposed, stored composed
  const salt = crypto.randomBytes(16), iter = 5000;
  const node = crypto.pbkdf2Sync(pw.normalize('NFC'), salt, iter, 32, 'sha256');
  const key = await crypto.webcrypto.subtle.importKey('raw', new TextEncoder().encode(pw.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const web = Buffer.from(await crypto.webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
  assert.deepEqual(web, node);
  // and the gate page the Worker sends contains that same recipe
  const { meta } = pwMeta('x'); const id = crypto.randomBytes(16).toString('base64url'); seed(id, meta);
  const html = await (await call(`/v/${id}`)).text(); assert.match(html, /normalize\('NFC'\)/); assert.match(html, /name:'PBKDF2',hash:'SHA-256'/); assert.match(html, /bytes\(f\.dataset\.salt\)/);
});

test('unlock on a link-mode video is harmless, and GET on unlock is refused', async () => {
  seed(ID, metaOf()); assert.equal((await call(`/v/${ID}/unlock`, { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await call(`/v/${ID}/unlock`)).status, 405);
});

test('a bad or missing set-up is explained to the Test button through a header', async () => {
  seed(ID, metaOf());
  let r = await call(`/v/${ID}`, { e: { ...env, B2_APP_KEY: 'wrong' } }); assert.equal(r.status, 503); assert.equal(r.headers.get('x-kairos-error'), 'b2_auth');
  r = await call(`/v/${ID}`, { e: { ...env, COOKIE_KEY: '' } }); assert.equal(r.status, 500); assert.equal(r.headers.get('x-kairos-error'), 'config');
  r = await call(`/v/${ID}`, { e: { ...env, B2_BUCKET: 'no-such-bucket' } }); assert.equal(r.status, 503); assert.equal(r.headers.get('x-kairos-error'), 'b2_bucket');
  assert.equal((await call('/healthz', { e: {} })).status, 200, 'the address check works even before the secrets are set');
});

test('when Backblaze says a daily limit is reached, the viewer sees a calm page, not an error dump', async () => {
  seed(ID, metaOf()); worker._reset(); fake.setDownloadCap(true);
  try { const r = await call(`/v/${ID}`), t = await r.text(); assert.equal(r.status, 503); assert.match(t, /Temporarily unavailable/); assert.ok(!/cap|b2|backblaze/i.test(t.match(/<div class="card">.*<\/div>/)[0])); }
  finally { fake.setDownloadCap(false); }
});

test('an expired Backblaze token is renewed once, silently', async () => {
  seed(ID, metaOf()); await (await call(`/v/${ID}`)).text(); // loads and caches meta + the token
  const before = fake.count('b2_authorize_account');
  fake.expireTokens('account');
  const r = await call(`/m/${ID}/video.mp4`, { headers: { Range: 'bytes=0-9' } }); assert.equal(r.status, 206); await r.arrayBuffer();
  assert.equal(fake.count('b2_authorize_account') - before, 1);
});

test('meta is cached briefly, so playback does not spend a Backblaze request per Range', async () => {
  seed(ID, metaOf()); const before = fake.calls.filter((c) => c.path.endsWith('meta.json')).length;
  for (let i = 0; i < 5; i++) { const r = await call(`/m/${ID}/video.mp4`, { headers: { Range: `bytes=${i}-${i + 9}` } }); await r.arrayBuffer(); }
  assert.equal(fake.calls.filter((c) => c.path.endsWith('meta.json')).length - before, 1);
});

test('a corrupt meta.json never produces a page', async () => {
  const id = crypto.randomBytes(16).toString('base64url'); fake.put(`p/${id}/meta.json`, '{"v":1,"mode":"password"}'); fake.put(`p/${id}/video.mp4`, VIDEO);
  const r = await call(`/v/${id}`); assert.equal(r.status, 502); await r.text();
  fake.put(`p/${id}/meta.json`, 'not json'); worker._reset(); assert.equal((await call(`/v/${id}`)).status, 502);
});

test('scripts/public-check.js passes against a real link, with and without a password, and fails against nonsense', async () => {
  const { execFile } = require('child_process'), { startWorkerHost } = require('./worker-host');
  const host = await startWorkerHost(env), run = (...a) => new Promise((res) => execFile(process.execPath, [path.join(__dirname, '../../scripts/public-check.js'), ...a], (err, out) => res({ code: err ? err.code : 0, out })));
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), crypto.randomBytes(992)]), mm = (o) => metaOf({ bytes: mp4.length, ...o });
  try {
    const a = crypto.randomBytes(16).toString('base64url'); seed(a, mm(), { video: mp4 });
    let r = await run(`${host.url}/v/${a}`); assert.equal(r.code, 0, r.out); assert.match(r.out, /All checks passed/);
    const { meta } = pwMeta('check me out 1', { bytes: mp4.length }), b = crypto.randomBytes(16).toString('base64url'); seed(b, meta, { video: mp4 });
    r = await run(`${host.url}/v/${b}`); assert.equal(r.code, 1); assert.match(r.out, /--password/);
    r = await run(`${host.url}/v/${b}`, '--password', 'check me out 1'); assert.equal(r.code, 0, r.out);
    r = await run(`${host.url}/v/${b}`, '--password', 'nope nope nope'); assert.equal(r.code, 1);
    r = await run(`${host.url}/v/${crypto.randomBytes(16).toString('base64url')}`); assert.equal(r.code, 1, 'a link that does not exist fails');
  } finally { await host.stop(); }
});
