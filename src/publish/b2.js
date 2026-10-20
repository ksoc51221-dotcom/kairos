// Backblaze B2 client (native API, v4): only what public links need - upload a file (in parts when it is big), delete everything under a prefix, and
// check that a key can do both. It is written from Backblaze's documentation and proven against tests/unit/fake-b2.js; the first contact with the real
// service is the owner's "Test" click in Settings -> Public links.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const { Readable } = require('stream');

const MiB = 1024 * 1024, SLICE = 256 * 1024;
// Everything this app puts in the bucket lives under p/<id>/ and nothing else is ever written or deleted, so a bucket that also holds other files stays safe.
const NAME_RE = /^p\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9._-]{1,64}$/;
const PREFIX_RE = /^p\/([A-Za-z0-9_-]{22}\/)?$/;

class B2Error extends Error {
  constructor(message, { status = 0, code = '', retryable = false, cause } = {}) {
    super(message); this.name = 'B2Error'; this.status = status; this.code = code; this.retryable = retryable; if (cause) this.cause = cause;
  }
}
const cancelled = () => new B2Error('cancelled', { code: 'cancelled' });
const transient = (status) => status === 408 || status === 429 || status >= 500;
const netError = (e) => (e instanceof B2Error ? e : new B2Error(`${e.code ? `${e.code}: ` : ''}${e.message}`, { code: 'network', retryable: true, cause: e }));
const jsonOf = (res) => { try { return JSON.parse(res.body.toString('utf8')); } catch { return null; } };
function toError(res) {
  const j = jsonOf(res) || {};
  const e = new B2Error(j.message || `HTTP ${res.status}`, { status: res.status, code: j.code || '', retryable: transient(res.status) });
  const wait = Number(res.headers['retry-after']); if (wait > 0) e.retryAfter = wait;
  return e;
}
function* slices(buf) { for (let o = 0; o < buf.length; o += SLICE) yield buf.subarray(o, o + SLICE); }

const sha1Buf = (b) => crypto.createHash('sha1').update(b).digest('hex');
function sha1File(file, start = 0, length = null) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1'), range = length == null ? {} : { start, end: start + length - 1 };
    fs.createReadStream(file, { ...range, highWaterMark: MiB }).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

// One HTTP call. body: undefined | Buffer | { file, start, length } (a slice of a file, streamed). Resolves { status, headers, body }; never throws for an HTTP status.
// The body goes out in 256 KB slices so onProgress(bytesSoFar) means something, and an AbortSignal tears the connection down.
function request(urlStr, { method = 'GET', headers = {}, body, signal, onProgress, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const u = new URL(urlStr), lib = u.protocol === 'https:' ? https : http, h = { ...headers };
    let source = null, done = false, req;
    if (body != null) {
      h['Content-Length'] = String(body.length);
      source = Buffer.isBuffer(body) ? Readable.from(slices(body)) : fs.createReadStream(body.file, { start: body.start, end: body.start + body.length - 1, highWaterMark: SLICE });
    }
    const finish = (fn, v) => {
      if (done) return; done = true;
      signal?.removeEventListener('abort', onAbort);
      if (source && !source.readableEnded) { source.destroy(); req.destroy(); } // answered before the whole body went out: that connection is not reusable
      fn(v);
    };
    const onAbort = () => { req.destroy(); finish(reject, cancelled()); };
    req = lib.request(u, { method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (e) => finish(reject, netError(e)));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); finish(reject, new B2Error('timed out waiting for Backblaze', { code: 'network', retryable: true })); });
    req.on('error', (e) => finish(reject, netError(e)));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (source) {
      let sent = 0;
      source.on('data', (c) => { sent += c.length; onProgress?.(sent); });
      source.on('error', (e) => { req.destroy(); finish(reject, new B2Error(`could not read the file to upload: ${e.message}`, { code: 'read' })); });
      source.pipe(req);
    } else req.end();
  });
}

// A short, plain-language reason for the owner (Settings and the Share dialog show this).
function explain(e) {
  if (!e) return 'Something went wrong.';
  if (e.code === 'cancelled') return 'Cancelled.';
  if (e.code === 'network') return 'Could not reach Backblaze. Check the internet connection and try again.';
  if (['bad_key', 'key_not_restricted', 'wrong_bucket', 'missing_capability', 'bad_name', 'bad_prefix', 'config', 'read'].includes(e.code)) return e.message;
  if (/cap_exceeded$/.test(e.code)) return "Backblaze's free limit for today is used up (" + e.code.replace(/_/g, ' ') + '). It resets every day, or remove old public copies in Settings.';
  if (e.code === 'unauthorized' || e.status === 401 && !/token/.test(e.code)) return `Backblaze says this key may not do that (${e.message}). The write key must be "Read and Write" and limited to the bucket.`;
  if (/auth_token/.test(e.code)) return 'Backblaze stopped accepting the key. Try again; if it keeps happening, make a new key.';
  if (e.code === 'bad_bucket_id' || e.code === 'no_such_bucket') return 'Backblaze does not know that bucket. Check the bucket name in Settings.';
  if (e.status >= 500) return `Backblaze had a problem (HTTP ${e.status}). Try again in a minute.`;
  return `Backblaze said: ${e.message}${e.status ? ` (HTTP ${e.status})` : ''}`;
}

// createB2({ keyId, key, bucket }) - the app key must be limited to one bucket. `authUrl`, `sleep` and `partSize` exist for tests.
function createB2({ keyId, key, bucket, authUrl = 'https://api.backblazeb2.com', partSize = 50 * MiB, retries = 4, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 120000 } = {}) {
  if (!keyId || !key || !bucket) throw new B2Error('The Backblaze key ID, key and bucket name are all needed.', { code: 'config' });
  let auth = null;
  const backoff = (n, e) => Math.max((e?.retryAfter || 0) * 1000, Math.min(8000, 500 * 2 ** n));

  // A call that is safe to repeat: network errors, 408, 429 and 5xx are retried with a growing pause.
  async function raw(url, opts = {}) {
    let last;
    for (let n = 0; n <= retries; n++) {
      if (n) await sleep(backoff(n - 1, last));
      if (opts.signal?.aborted) throw cancelled();
      try {
        const res = await request(url, { timeoutMs, ...opts });
        if (!transient(res.status)) return res;
        last = toError(res);
      } catch (e) { if (!e.retryable) throw e; last = e; }
    }
    throw last;
  }

  async function authorize(force = false) {
    if (auth && !force) return auth;
    const basic = Buffer.from(`${keyId}:${key}`).toString('base64');
    let res, version;
    for (version of ['v4', 'v3']) { // v4 is current; an older answer is only used if v4 does not exist
      res = await raw(`${authUrl}/b2api/${version}/b2_authorize_account`, { headers: { Authorization: `Basic ${basic}` } });
      if (res.status !== 404) break;
    }
    if (res.status === 401 || res.status === 403) throw new B2Error('Backblaze did not accept the key ID and key. Copy them again from Backblaze (the key is shown only once).', { status: res.status, code: 'bad_key' });
    if (res.status !== 200) throw toError(res);
    const j = jsonOf(res) || {}, s = j.apiInfo?.storageApi || j, allowed = s.allowed || j.allowed || {};
    const buckets = allowed.buckets || (allowed.bucketId ? [{ id: allowed.bucketId, name: allowed.bucketName }] : []);
    if (!buckets.length) throw new B2Error('This key can reach every bucket in the account. Make a key limited to the one bucket (Backblaze -> App Keys -> Add a New Application Key -> "Allow access to Bucket(s)").', { code: 'key_not_restricted' });
    const b = buckets.find((x) => x.name === bucket);
    if (!b) throw new B2Error(`This key is not allowed to use a bucket called "${bucket}". It can use: ${buckets.map((x) => x.name).join(', ')}.`, { code: 'wrong_bucket' });
    auth = { token: j.authorizationToken, apiUrl: s.apiUrl, downloadUrl: s.downloadUrl, bucketId: b.id, version, capabilities: allowed.capabilities || [], namePrefix: allowed.namePrefix || null, minPart: s.absoluteMinimumPartSize || 5e6 };
    return auth;
  }

  // An API call. A token that expired (they last a day) is replaced once, silently.
  async function call(name, body, { signal } = {}) {
    for (let again = 0; ; again++) {
      const a = await authorize();
      const res = await raw(`${a.apiUrl}/b2api/${a.version}/${name}`, { method: 'POST', headers: { Authorization: a.token, 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify(body)), signal });
      if (res.status === 200) return jsonOf(res);
      const e = toError(res);
      if (res.status === 401 && /expired_auth_token|bad_auth_token/.test(e.code) && again === 0) { auth = null; continue; }
      throw e;
    }
  }

  // One upload POST. Every attempt asks for a fresh upload URL, which is what Backblaze asks clients to do after any failure.
  async function upload({ urlCall, urlBody, headers, body, signal, onProgress }) {
    let last;
    for (let n = 0; n <= retries; n++) {
      if (n) await sleep(backoff(n - 1, last));
      if (signal?.aborted) throw cancelled();
      const target = await call(urlCall, urlBody, { signal });
      let res;
      try { res = await request(target.uploadUrl, { method: 'POST', headers: { ...headers, Authorization: target.authorizationToken }, body, signal, onProgress, timeoutMs }); }
      catch (e) { if (!e.retryable) throw e; last = e; continue; }
      if (res.status === 200) return jsonOf(res);
      const e = toError(res);
      if (/auth_token/.test(e.code)) e.retryable = true; // this upload URL's token went stale; a new URL fixes it
      if (!e.retryable) throw e;
      last = e;
    }
    throw last;
  }

  async function putLarge(name, source, size, part, a, { contentType, signal, onProgress }) {
    const isBuf = Buffer.isBuffer(source);
    const started = await call('b2_start_large_file', { bucketId: a.bucketId, fileName: name, contentType }, { signal });
    try {
      const count = Math.ceil(size / part), shas = []; let before = 0;
      for (let i = 0; i < count; i++) {
        const start = i * part, length = Math.min(part, size - start);
        const body = isBuf ? source.subarray(start, start + length) : { file: source.file, start, length };
        const sha = isBuf ? sha1Buf(body) : await sha1File(source.file, start, length);
        shas.push(sha);
        await upload({ urlCall: 'b2_get_upload_part_url', urlBody: { fileId: started.fileId }, headers: { 'X-Bz-Part-Number': String(i + 1), 'X-Bz-Content-Sha1': sha }, body, signal,
          onProgress: onProgress && ((sent) => onProgress(before + sent, size)) });
        before += length; onProgress?.(before, size);
      }
      await call('b2_finish_large_file', { fileId: started.fileId, partSha1Array: shas }, { signal });
      return { fileId: started.fileId, size, parts: count };
    } catch (e) {
      try { await call('b2_cancel_large_file', { fileId: started.fileId }); } catch {} // an unfinished large file would sit there and count as storage
      throw e;
    }
  }

  // source: a Buffer, or { file: '/path' }. onProgress(sentBytes, totalBytes). Resolves { fileId, size, parts? }.
  async function putFile(name, source, { contentType = 'application/octet-stream', signal, onProgress } = {}) {
    if (!NAME_RE.test(name)) throw new B2Error(`Refusing to write "${name}": public copies only go under p/<id>/.`, { code: 'bad_name' });
    const a = await authorize(), isBuf = Buffer.isBuffer(source), size = isBuf ? source.length : fs.statSync(source.file).size;
    const part = Math.max(partSize, a.minPart);
    if (size > part) return putLarge(name, source, size, part, a, { contentType, signal, onProgress });
    const sha = isBuf ? sha1Buf(source) : await sha1File(source.file);
    const r = await upload({ urlCall: 'b2_get_upload_url', urlBody: { bucketId: a.bucketId }, signal, onProgress: onProgress && ((sent) => onProgress(sent, size)),
      headers: { 'X-Bz-File-Name': encodeURIComponent(name).replace(/%2F/g, '/'), 'Content-Type': contentType, 'X-Bz-Content-Sha1': sha },
      body: isBuf ? source : { file: source.file, start: 0, length: size } });
    onProgress?.(size, size);
    return { fileId: r.fileId, size };
  }

  // Removes every version of every file whose name starts with `prefix` (and cancels unfinished large files). Only "p/" and "p/<id>/" are accepted.
  async function deletePrefix(prefix, { signal } = {}) {
    if (!PREFIX_RE.test(prefix)) throw new B2Error(`Refusing to delete "${prefix}": only p/ and p/<id>/ may be removed.`, { code: 'bad_prefix' });
    const a = await authorize(), found = []; let startFileName = null, startFileId = null;
    do {
      const q = { bucketId: a.bucketId, prefix, maxFileCount: 1000 };
      if (startFileName) { q.startFileName = startFileName; if (startFileId) q.startFileId = startFileId; }
      const r = await call('b2_list_file_versions', q, { signal });
      found.push(...(r.files || []).filter((f) => f.fileName.startsWith(prefix)));
      startFileName = r.nextFileName || null; startFileId = r.nextFileId || null;
    } while (startFileName);
    let n = 0;
    for (const f of found) {
      if (signal?.aborted) throw cancelled();
      try {
        if (f.action === 'start') await call('b2_cancel_large_file', { fileId: f.fileId });
        else if (f.action !== 'folder') await call('b2_delete_file_version', { fileName: f.fileName, fileId: f.fileId });
      } catch (e) { if (e.code !== 'file_not_present' && e.code !== 'bad_request' && e.status !== 404) throw e; } // already gone is fine: a retry may find it half-deleted
      n++;
    }
    return n;
  }

  // Throws a plain-language B2Error if the key is wrong, not limited to the bucket, or cannot write / list / delete there.
  async function check() {
    const a = await authorize(true);
    const missing = ['writeFiles', 'listFiles', 'deleteFiles'].filter((c) => !a.capabilities.includes(c));
    if (missing.length) throw new B2Error(`This key cannot ${missing.map((c) => ({ writeFiles: 'upload files', listFiles: 'list files', deleteFiles: 'delete files' }[c])).join(', ')}. Make the key "Read and Write" and limited to the bucket.`, { code: 'missing_capability' });
    if (a.namePrefix && !(a.namePrefix.startsWith('p/') || 'p/'.startsWith(a.namePrefix))) throw new B2Error(`This key is limited to files starting with "${a.namePrefix}", but public copies are stored under "p/". Make a key without a file-name limit.`, { code: 'missing_capability' });
    return { bucket, bucketId: a.bucketId, capabilities: a.capabilities };
  }

  return { authorize, check, putFile, deletePrefix, call, get bucketId() { return auth?.bucketId; } };
}

module.exports = { createB2, B2Error, explain, request, sha1Buf, sha1File, NAME_RE, PREFIX_RE };
