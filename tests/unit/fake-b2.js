// An in-process stand-in for Backblaze B2's native API (v4), good enough to prove the client and the Worker without a Backblaze account.
// It is as picky as the real service where it matters (SHA-1 and Content-Length are checked, parts must reach the minimum size, tokens expire,
// bucket-restricted keys) and it reproduces the download quirk the Worker has to cope with: a range that covers the whole file is answered
// 200 with no Content-Range, and no Accept-Ranges header is sent.
const http = require('http');
const crypto = require('crypto');

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const send = (res, status, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'max-age=0, no-cache, no-store' }); res.end(b);
};
const fail = (res, status, code, message) => send(res, status, { status, code, message });
const readBody = (req) => new Promise((resolve, reject) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject); });

const WRITE = ['listBuckets', 'listFiles', 'readFiles', 'shareFiles', 'writeFiles', 'deleteFiles'];
const READ = ['listBuckets', 'listFiles', 'readFiles', 'shareFiles'];
const NEEDS = { b2_get_upload_url: 'writeFiles', b2_start_large_file: 'writeFiles', b2_get_upload_part_url: 'writeFiles', b2_finish_large_file: 'writeFiles', b2_cancel_large_file: 'writeFiles',
  b2_list_file_versions: 'listFiles', b2_delete_file_version: 'deleteFiles' };

function createFakeB2(opts = {}) {
  const cfg = { bucket: 'kairos-test', bucketId: 'bkt_0123456789abcdef', minPart: 5000, versions: ['v4'], listPage: 1000, ...opts };
  const keys = opts.keys || [
    { keyId: 'write-key-id', key: 'write-key-secret', capabilities: WRITE, restricted: true, namePrefix: null },
    { keyId: 'read-key-id', key: 'read-key-secret', capabilities: READ, restricted: true, namePrefix: null },
  ];
  const versions = new Map(); // fileId -> { fileId, fileName, action, contentType, size, sha1, data, seq }
  const large = new Map();    // fileId -> { fileId, fileName, contentType, parts: Map(number -> { data, sha1 }), seq }
  const tokens = new Map();   // account token -> { key, expired }
  const targets = new Map();  // upload token -> { kind, fileId?, key }
  const injections = new Map(); // api -> [spec, ...]
  const calls = [], uploads = [];
  let seq = 0, base = '', capped = false;

  const latest = (name) => { let best = null; for (const v of versions.values()) if (v.fileName === name && (!best || v.seq > best.seq)) best = v; return best && best.action === 'upload' ? best : null; };
  const info = (v) => ({ accountId: 'acct123', action: v.action, bucketId: cfg.bucketId, contentLength: v.size, contentSha1: v.sha1 || 'none', contentType: v.contentType, fileId: v.fileId, fileInfo: {}, fileName: v.fileName, uploadTimestamp: 1700000000000 + v.seq });
  const store = (name, data, contentType, shaOverride) => {
    const v = { fileId: `4_z${String(++seq).padStart(6, '0')}`, fileName: name, action: 'upload', contentType, size: data.length, sha1: shaOverride || sha1(data), data, seq };
    versions.set(v.fileId, v); uploads.push(name); return v;
  };
  const can = (key, cap) => key.capabilities.includes(cap);
  const nameOk = (key, name) => !key.namePrefix || name.startsWith(key.namePrefix);

  const account = (req, res) => {
    const t = tokens.get(req.headers.authorization);
    if (!t) { fail(res, 401, 'bad_auth_token', 'Invalid authorization token'); return null; }
    if (t.expired) { fail(res, 401, 'expired_auth_token', 'Authorization token has expired'); return null; }
    return t;
  };

  const handlers = {
    b2_get_upload_url(t, b, res) {
      const n = ++seq, token = `up-${n}`; targets.set(token, { kind: 'file', key: t.key });
      send(res, 200, { bucketId: cfg.bucketId, uploadUrl: `${base}/upload/${n}`, authorizationToken: token });
    },
    b2_start_large_file(t, b, res) {
      if (!b.fileName || !b.contentType) return fail(res, 400, 'bad_request', 'fileName and contentType are required');
      if (!nameOk(t.key, b.fileName)) return fail(res, 401, 'unauthorized', 'file name outside the key prefix');
      const id = `4_zlarge${String(++seq).padStart(5, '0')}`;
      large.set(id, { fileId: id, fileName: b.fileName, contentType: b.contentType, parts: new Map(), seq });
      send(res, 200, { fileId: id, fileName: b.fileName, bucketId: cfg.bucketId, action: 'start', contentType: b.contentType, uploadTimestamp: 1700000000000 + seq });
    },
    b2_get_upload_part_url(t, b, res) {
      if (!large.has(b.fileId)) return fail(res, 400, 'bad_request', 'no such large file');
      const n = ++seq, token = `part-${n}`; targets.set(token, { kind: 'part', fileId: b.fileId, key: t.key });
      send(res, 200, { fileId: b.fileId, uploadUrl: `${base}/uploadpart/${n}`, authorizationToken: token });
    },
    b2_finish_large_file(t, b, res) {
      const lf = large.get(b.fileId);
      if (!lf) return fail(res, 400, 'bad_request', 'no such large file');
      const nums = [...lf.parts.keys()].sort((x, y) => x - y), shas = b.partSha1Array || [];
      if (nums.length < 2) return fail(res, 400, 'bad_request', 'Large files must have at least 2 parts');
      if (nums.some((n, i) => n !== i + 1)) return fail(res, 400, 'bad_request', 'parts are not contiguous');
      if (shas.length !== nums.length) return fail(res, 400, 'bad_request', 'partSha1Array has the wrong length');
      for (const [i, n] of nums.entries()) {
        const p = lf.parts.get(n);
        if (p.sha1 !== shas[i]) return fail(res, 400, 'bad_request', `Part ${n} has the wrong SHA-1`);
        if (i < nums.length - 1 && p.data.length < cfg.minPart) return fail(res, 400, 'bad_request', `Part ${n} is smaller than the minimum part size`);
      }
      const data = Buffer.concat(nums.map((n) => lf.parts.get(n).data));
      large.delete(b.fileId);
      const v = { fileId: lf.fileId, fileName: lf.fileName, action: 'upload', contentType: lf.contentType, size: data.length, sha1: 'none', data, seq: ++seq };
      versions.set(v.fileId, v); uploads.push(v.fileName);
      send(res, 200, info(v));
    },
    b2_cancel_large_file(t, b, res) {
      const lf = large.get(b.fileId);
      if (!lf) return fail(res, 400, 'bad_request', 'no such unfinished large file');
      large.delete(b.fileId); send(res, 200, { fileId: lf.fileId, fileName: lf.fileName, bucketId: cfg.bucketId });
    },
    b2_list_file_versions(t, b, res) {
      if (b.bucketId !== cfg.bucketId) return fail(res, 400, 'bad_bucket_id', 'Bucket not found');
      const all = [
        ...[...versions.values()].map(info),
        ...[...large.values()].map((l) => ({ ...info({ ...l, action: 'start', size: 0, sha1: 'none' }) })),
      ].filter((f) => f.fileName.startsWith(b.prefix || '')).sort((x, y) => (x.fileName < y.fileName ? -1 : x.fileName > y.fileName ? 1 : x.fileId < y.fileId ? -1 : 1));
      let i = 0;
      if (b.startFileName) i = all.findIndex((f) => f.fileName > b.startFileName || (f.fileName === b.startFileName && f.fileId >= (b.startFileId || '')));
      if (i < 0) i = all.length;
      const take = Math.min(b.maxFileCount || 100, cfg.listPage), files = all.slice(i, i + take), next = all[i + take];
      send(res, 200, { files, nextFileName: next ? next.fileName : null, nextFileId: next ? next.fileId : null });
    },
    b2_delete_file_version(t, b, res) {
      const v = versions.get(b.fileId);
      if (!v || v.fileName !== b.fileName) return fail(res, 400, 'file_not_present', `File not present: ${b.fileName} ${b.fileId}`);
      versions.delete(b.fileId); send(res, 200, { fileId: b.fileId, fileName: b.fileName });
    },
  };

  function uploadFile(req, res, body, pathname) {
    const n = /\/upload\/(\d+)$/.exec(pathname)[1], target = targets.get(req.headers.authorization);
    if (!target || target.kind !== 'file' || req.headers.authorization !== `up-${n}`) return fail(res, 401, 'bad_auth_token', 'Invalid upload authorization token');
    if (!can(target.key, 'writeFiles')) return fail(res, 401, 'unauthorized', 'not allowed to write files');
    if (req.headers['transfer-encoding'] || req.headers['content-length'] === undefined) return fail(res, 400, 'bad_request', 'Content-Length is required (no chunked uploads)');
    if (Number(req.headers['content-length']) !== body.length) return fail(res, 400, 'bad_request', 'Content-Length does not match the data received');
    const name = decodeURIComponent(req.headers['x-bz-file-name'] || ''), type = req.headers['content-type'];
    if (!name || !type) return fail(res, 400, 'bad_request', 'X-Bz-File-Name and Content-Type are required');
    if (!nameOk(target.key, name)) return fail(res, 401, 'unauthorized', 'file name outside the key prefix');
    if (req.headers['x-bz-content-sha1'] !== sha1(body)) return fail(res, 400, 'bad_request', 'Sha1 did not match data received');
    send(res, 200, info(store(name, body, type)));
  }
  function uploadPart(req, res, body, pathname) {
    const n = /\/uploadpart\/(\d+)$/.exec(pathname)[1], target = targets.get(req.headers.authorization);
    if (!target || target.kind !== 'part' || req.headers.authorization !== `part-${n}`) return fail(res, 401, 'bad_auth_token', 'Invalid upload authorization token');
    const lf = large.get(target.fileId), num = Number(req.headers['x-bz-part-number']);
    if (!lf) return fail(res, 400, 'bad_request', 'large file is not in progress');
    if (!(num >= 1 && num <= 10000)) return fail(res, 400, 'bad_request', 'bad part number');
    if (Number(req.headers['content-length']) !== body.length || req.headers['transfer-encoding']) return fail(res, 400, 'bad_request', 'Content-Length does not match the data received');
    if (req.headers['x-bz-content-sha1'] !== sha1(body)) return fail(res, 400, 'bad_request', 'Sha1 did not match data received');
    lf.parts.set(num, { data: body, sha1: sha1(body) });
    send(res, 200, { fileId: lf.fileId, partNumber: num, contentLength: body.length, contentSha1: sha1(body) });
  }

  function download(req, res, bucket, name) {
    const t = account(req, res); if (!t) return;
    if (!can(t.key, 'readFiles')) return fail(res, 401, 'unauthorized', 'not allowed to read files');
    if (bucket !== cfg.bucket) return fail(res, 404, 'not_found', 'bucket does not exist');
    if (capped) return fail(res, 403, 'download_cap_exceeded', 'Cannot download data, download bandwidth cap exceeded');
    const f = latest(name);
    if (!f) return fail(res, 404, 'not_found', `File with such name does not exist. File name in request: ${name}`);
    const size = f.size; let start = 0, end = size - 1, partial = false;
    const rm = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (rm && (rm[1] !== '' || rm[2] !== '')) {
      if (rm[1] === '') start = Math.max(0, size - Number(rm[2]));
      else { start = Number(rm[1]); if (rm[2] !== '') end = Math.min(size - 1, Number(rm[2])); }
      if (start >= size || start > end) return fail(res, 416, 'range_not_satisfiable', 'The range is not satisfiable');
      partial = !(start === 0 && end === size - 1); // B2: a range covering the whole file is a plain 200 without Content-Range
    }
    const headers = { 'Content-Type': f.contentType, 'Content-Length': end - start + 1, 'X-Bz-File-Id': f.fileId, 'X-Bz-File-Name': encodeURIComponent(f.fileName).replace(/%2F/g, '/'), 'X-Bz-Content-Sha1': f.sha1, 'X-Bz-Upload-Timestamp': String(1700000000000 + f.seq) };
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(partial ? 206 : 200, headers);
    res.end(req.method === 'HEAD' ? undefined : f.data.subarray(start, end + 1));
  }

  const server = http.createServer(async (req, res) => {
    let body;
    try { body = await readBody(req); } catch { return; }
    const url = new URL(req.url, 'http://fake'), p = url.pathname;
    const m = /^\/b2api\/(v\d+)\/(b2_\w+)$/.exec(p), dl = /^\/file\/([^/]+)\/(.+)$/.exec(p);
    const api = m ? m[2] : /^\/upload\/\d+$/.test(p) ? 'b2_upload_file' : /^\/uploadpart\/\d+$/.test(p) ? 'b2_upload_part' : dl ? 'download' : 'unknown';
    calls.push({ api, method: req.method, path: p, range: req.headers.range, bytes: body.length });
    const queue = injections.get(api);
    if (queue?.length) {
      if (queue[0].skip > 0) queue[0].skip--; // "fail the 2nd call, not the 1st"
      else {
        const spec = queue.shift();
        if (spec.drop) return req.socket.destroy();
        return fail(res, spec.status, spec.code || 'service_unavailable', spec.message || spec.code || 'injected failure');
      }
    }
    try {
      if (m && !cfg.versions.includes(m[1])) return fail(res, 404, 'not_found', 'no such API version');
      if (api === 'b2_authorize_account') {
        const am = /^Basic (.+)$/.exec(req.headers.authorization || '');
        const [id, secret] = am ? Buffer.from(am[1], 'base64').toString().split(/:(.*)/s) : [];
        const k = keys.find((x) => x.keyId === id && x.key === secret);
        if (!k) return fail(res, 401, 'unauthorized', 'Invalid credentials');
        const token = `acct-${++seq}-${crypto.randomBytes(5).toString('hex')}`; tokens.set(token, { key: k, expired: false });
        return send(res, 200, { accountId: 'acct123', authorizationToken: token, applicationKeyExpirationTimestamp: null, apiInfo: { storageApi: {
          apiUrl: base, downloadUrl: base, s3ApiUrl: base, recommendedPartSize: cfg.minPart * 4, absoluteMinimumPartSize: cfg.minPart,
          allowed: { buckets: k.restricted ? [{ id: cfg.bucketId, name: cfg.bucket }] : null, capabilities: k.capabilities, namePrefix: k.namePrefix || null },
        } } });
      }
      if (api === 'b2_upload_file') return uploadFile(req, res, body, p);
      if (api === 'b2_upload_part') return uploadPart(req, res, body, p);
      if (dl && (req.method === 'GET' || req.method === 'HEAD')) return download(req, res, dl[1], decodeURIComponent(dl[2]));
      if (m && handlers[api]) {
        const t = account(req, res); if (!t) return;
        if (!can(t.key, NEEDS[api])) return fail(res, 401, 'unauthorized', `not allowed: missing capability ${NEEDS[api]}`);
        let b; try { b = JSON.parse(body.toString('utf8') || '{}'); } catch { return fail(res, 400, 'bad_request', 'body is not JSON'); }
        calls[calls.length - 1].body = b;
        if (b.bucketId && b.bucketId !== cfg.bucketId) return fail(res, 400, 'bad_bucket_id', 'Bucket not found');
        return handlers[api](t, b, res);
      }
      fail(res, 404, 'not_found', `no route for ${req.method} ${p}`);
    } catch (e) { fail(res, 500, 'internal_error', e.message); }
  });

  return {
    cfg, keys, calls, uploads,
    get url() { return base; },
    start() { return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(this); })); },
    stop() { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); },
    apiNames: () => calls.map((c) => c.api),
    count: (api) => calls.filter((c) => c.api === api).length,
    // live files (newest version of each name) and unfinished large files
    list: (prefix = '') => [...new Set([...versions.values()].map((v) => v.fileName))].filter((n) => n.startsWith(prefix) && latest(n))
      .sort().map((n) => { const v = latest(n); return { name: n, size: v.size, contentType: v.contentType, sha1: v.sha1, id: v.fileId }; }),
    versionCount: (prefix = '') => [...versions.values()].filter((v) => v.fileName.startsWith(prefix)).length,
    pending: () => [...large.values()].map((l) => l.fileName),
    read: (name) => latest(name)?.data || null,
    put: (name, data, contentType = 'application/octet-stream') => store(name, Buffer.isBuffer(data) ? data : Buffer.from(data), contentType),
    // failure injection: `times` calls to `api` get this answer ({ status, code, message } or { drop: true } to cut the connection), after `skip` normal ones
    inject(api, spec, times = 1, skip = 0) { if (!injections.has(api)) injections.set(api, []); for (let i = 0; i < times; i++) injections.get(api).push({ ...spec, skip: i === 0 ? skip : 0 }); },
    expireTokens(what = 'account') { if (what === 'account') for (const t of tokens.values()) t.expired = true; else targets.clear(); },
    setDownloadCap(on) { capped = !!on; },
  };
}

module.exports = { createFakeB2, WRITE, READ };
