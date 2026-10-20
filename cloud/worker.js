// Kairos public links: a free Cloudflare Worker that serves one shared recording per link from a PRIVATE Backblaze B2 bucket.
//
//   /v/<id>            the page (or the password gate, or "not found" / "expired")
//   /v/<id>/unlock     POST: the viewer's browser sends a derived key, the Worker checks it and sets a cookie
//   /m/<id>/video.mp4  the video, with Range support (phones need it)
//   /m/<id>/thumb.jpg  the poster
//   /healthz           "ok"
//
// What it knows: a read-only, bucket-limited Backblaze key (B2_KEY_ID + the secret B2_APP_KEY) and a random COOKIE_KEY. It never sees a password:
// the browser derives a key with PBKDF2 and the Worker only compares a SHA-256 of that key with the check value stored in meta.json.
// Bucket layout (written by Kairos, `meta.json` last): p/<id>/video.mp4, p/<id>/thumb.jpg, p/<id>/meta.json.

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const META_TTL = 20_000, AUTH_TTL = 20 * 3600_000, COOKIE_AGE = 12 * 3600;
const enc = new TextEncoder();

// Kept per isolate: the Cache API does not work on workers.dev, and a Map is plenty for a handful of links.
const metas = new Map();
let auth = null;
export function _reset() { metas.clear(); auth = null; }

class B2Fail extends Error { constructor(kind, status, detail) { super(detail || kind); this.kind = kind; this.status = status; } }

// ---- small helpers ----------------------------------------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const nonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/[^A-Za-z0-9]/g, '');
function same(a, b) { // constant-time string compare
  const x = enc.encode(String(a)), y = enc.encode(String(b)); let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
const gateCookie = (env, id, meta) => hmac(env.COOKIE_KEY, `gate|${id}|${meta.pw.check}`);
function cookieOf(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(/;\s*/)) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1); }
  return '';
}
const configured = (env) => !!(env.B2_KEY_ID && env.B2_APP_KEY && env.B2_BUCKET && env.COOKIE_KEY);

function secure(h, extra = {}) {
  const headers = new Headers(h);
  headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Referrer-Policy', 'no-referrer'); headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  headers.set('X-Frame-Options', 'DENY');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'private, no-store');
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return headers;
}

// ---- Backblaze --------------------------------------------------------------------------------------------------------------
async function authorize(env, fresh) {
  if (!fresh && auth && Date.now() - auth.at < AUTH_TTL) return auth;
  const base = (env.B2_AUTH_URL || 'https://api.backblazeb2.com').replace(/\/+$/, '');
  const basic = 'Basic ' + btoa(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`);
  let r = await fetch(`${base}/b2api/v4/b2_authorize_account`, { headers: { Authorization: basic } });
  if (r.status === 404) r = await fetch(`${base}/b2api/v3/b2_authorize_account`, { headers: { Authorization: basic } }); // only if v4 does not exist
  if (r.status === 401 || r.status === 403) { await r.arrayBuffer(); throw new B2Fail('b2_auth', 503, 'The read-only key was rejected'); }
  if (!r.ok) { await r.arrayBuffer(); throw new B2Fail('unavailable', 503, `authorize answered ${r.status}`); }
  const j = await r.json(), s = j.apiInfo?.storageApi || j; // v2-style flat answers are tolerated
  if (!j.authorizationToken || !s.downloadUrl) throw new B2Fail('unavailable', 503, 'unexpected authorize answer');
  auth = { token: j.authorizationToken, download: String(s.downloadUrl).replace(/\/+$/, ''), at: Date.now() };
  return auth;
}
// One authenticated GET (or HEAD) from the bucket. Re-authorizes once when the token went stale. Returns the raw Response (any status B2 gave).
async function b2Get(env, name, { range, method = 'GET' } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const a = await authorize(env, attempt > 0);
    const r = await fetch(`${a.download}/file/${encodeURIComponent(env.B2_BUCKET)}/${name.split('/').map(encodeURIComponent).join('/')}`, { method, headers: { Authorization: a.token, ...(range ? { Range: range } : {}) } });
    if (r.status !== 401) return r;
    let code = ''; try { code = (await r.json()).code; } catch { /* not json */ }
    if (attempt === 0 && /expired_auth_token|bad_auth_token/.test(code)) { auth = null; continue; }
    throw new B2Fail('b2_auth', 503, `B2 answered 401 ${code}`);
  }
  throw new B2Fail('b2_auth', 503, 'B2 rejected the token twice');
}
// Turns a non-OK B2 answer into the right failure. 404 returns normally to the caller (it means "no such file").
async function failFrom(r) {
  let j = {}; try { j = await r.json(); } catch { /* not json */ }
  const code = j.code || '', msg = j.message || '';
  if (r.status === 403 && /cap_exceeded/.test(code)) return new B2Fail('cap', 503, code);
  if (r.status === 403) return new B2Fail('b2_auth', 503, `403 ${code}`);
  if (r.status === 404 && /bucket/i.test(msg) && !/File with such name/i.test(msg)) return new B2Fail('b2_bucket', 503, msg);
  return new B2Fail('unavailable', 502, `B2 answered ${r.status} ${code}`);
}

async function loadMeta(env, id) {
  const hit = metas.get(id);
  if (hit && Date.now() - hit.at < META_TTL) return hit.meta;
  const r = await b2Get(env, `p/${id}/meta.json`);
  if (r.status === 404) {
    const f = await failFrom(r.clone()); await r.arrayBuffer();
    if (f.kind === 'b2_bucket') throw f;
    metas.delete(id); return null;
  }
  if (!r.ok) throw await failFrom(r);
  let meta; try { meta = await r.json(); } catch { throw new B2Fail('unavailable', 502, 'meta.json is not JSON'); }
  if (!meta || meta.v !== 1 || !['link', 'password'].includes(meta.mode) || (meta.mode === 'password' && !(meta.pw && meta.pw.salt && meta.pw.check && meta.pw.iter))) throw new B2Fail('unavailable', 502, 'meta.json is not valid');
  if (metas.size > 300) metas.delete(metas.keys().next().value);
  metas.set(id, { at: Date.now(), meta });
  return meta;
}

// ---- pages ------------------------------------------------------------------------------------------------------------------
const CSS = `:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#14171c;--mut:#5d6672;--card:#fff;--line:#dfe3e8;--ac:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--fg:#e8ebf0;--mut:#98a2b0;--card:#171b22;--line:#262c36;--ac:#6ea0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px}
main{width:100%;max-width:960px}h1{font-size:1.25rem;margin:0 0 12px;word-break:break-word}video{width:100%;max-height:78vh;background:#000;border-radius:12px;display:block}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;max-width:420px;margin:12vh auto 0}.card h1{margin-bottom:8px}.mut{color:var(--mut);font-size:.9rem}
input,button{font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);width:100%}button{background:var(--ac);color:#fff;border:0;margin-top:10px;cursor:pointer}button:disabled{opacity:.6}
a{color:var(--ac)}footer{margin-top:16px;display:flex;gap:16px;flex-wrap:wrap;justify-content:space-between}#err{color:#d33;min-height:1.4em;margin:8px 0 0}`;

function page({ title, body, script, ogs = '', status = 200, noindexOnly }) {
  const n = nonce();
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>${ogs}<style nonce="${n}">${CSS}</style></head><body>${body}${script ? `<script nonce="${n}">${script}</script>` : ''}</body></html>`;
  return { html, status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; media-src 'self'; img-src 'self' data:; style-src 'nonce-${n}'; script-src 'nonce-${n}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` } };
}
const send = (p, method, extra = {}) => new Response(method === 'HEAD' ? null : p.html, { status: p.status, headers: secure(p.headers, extra) });
const msgPage = (title, text, status) => page({ title, status, body: `<div class="card"><h1>${esc(title)}</h1><p class="mut">${esc(text)}</p></div>` });
const notFound = () => msgPage('Link not found', 'This link does not exist, or it was removed by the person who shared it.', 404);
const expired = () => msgPage('This link has expired', 'Links are deleted after a while. Ask the person who shared it for a new one.', 410);
const busy = () => msgPage('Temporarily unavailable', 'This video cannot be shown right now. Please try again later.', 503);

function watchPage(meta, id, origin, link) {
  const poster = meta.hasThumb ? ` poster="/m/${id}/thumb.jpg"` : '';
  const title = String(meta.title || 'Recording').slice(0, 200);
  const ogs = link ? `<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="Shared with Kairos">${meta.hasThumb ? `<meta property="og:image" content="${esc(origin)}/m/${id}/thumb.jpg"><meta name="twitter:card" content="summary_large_image">` : ''}` : '';
  const dl = meta.allowDownload ? `<a href="/m/${id}/video.mp4?download=1">Download</a>` : '';
  return page({ title, ogs, script: `var t=document.getElementById('exp');if(t){var d=new Date(Number(t.dateTime));if(!isNaN(d))t.textContent=d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'})}`,
    body: `<main><h1>${esc(title)}</h1><video controls playsinline preload="metadata" src="/m/${id}/video.mp4"${poster}></video><footer class="mut"><span>Shared with Kairos${meta.expiresAt ? ` · available until <time id="exp" datetime="${Number(meta.expiresAt)}"></time>` : ''}</span>${dl}</footer></main>` });
}
function gatePage(meta, id) {
  return page({ title: 'Password needed', script: `
var f=document.getElementById('f'),pw=document.getElementById('pw'),b=document.getElementById('b'),e=document.getElementById('err');
function bytes(h){var a=new Uint8Array(h.length/2);for(var i=0;i<a.length;i++)a[i]=parseInt(h.substr(i*2,2),16);return a}
f.addEventListener('submit',async function(ev){ev.preventDefault();b.disabled=true;e.textContent='Checking…';
try{var k=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw.value.normalize('NFC')),'PBKDF2',false,['deriveBits']);
var bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:bytes(f.dataset.salt),iterations:Number(f.dataset.iter)},k,256);
var dk=Array.from(new Uint8Array(bits)).map(function(x){return x.toString(16).padStart(2,'0')}).join('');
var r=await fetch(f.dataset.unlock,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({dk:dk})});
if(r.ok){location.reload();return}e.textContent=r.status===403?'That password is not right.':'Something went wrong. Try again.'}catch(x){e.textContent='This browser cannot check the password.'}
b.disabled=false});`,
    body: `<div class="card"><h1>Password needed</h1><p class="mut">The person who shared this video protected it with a password.</p><form id="f" data-salt="${esc(meta.pw.salt)}" data-iter="${Number(meta.pw.iter)}" data-unlock="/v/${id}/unlock"><input id="pw" type="password" autocomplete="current-password" aria-label="Password" required autofocus><button id="b" type="submit">Watch</button><p id="err" role="status"></p></form></div>` });
}

// ---- routes -----------------------------------------------------------------------------------------------------------------
function problem(e, method) {
  if (e instanceof B2Fail) {
    const header = ['b2_auth', 'b2_bucket'].includes(e.kind) ? { 'X-Kairos-Error': e.kind } : {};
    return send({ ...busy(), status: e.status || 503 }, method, header);
  }
  return send({ ...busy(), status: 500 }, method);
}
const parseId = (s) => (ID_RE.test(s) ? s : null);

async function showPage(request, env, id) {
  const meta = await loadMeta(env, id);
  if (!meta) return send(notFound(), request.method);
  if (meta.expiresAt && meta.expiresAt <= Date.now()) return send(expired(), request.method);
  const origin = new URL(request.url).origin;
  if (meta.mode === 'password') {
    const ok = same(cookieOf(request, `kp_${id}`), await gateCookie(env, id, meta));
    return send(ok ? watchPage(meta, id, origin, false) : gatePage(meta, id), request.method);
  }
  return send(watchPage(meta, id, origin, true), request.method);
}

async function unlock(request, env, id) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: secure({ Allow: 'POST' }) });
  const meta = await loadMeta(env, id);
  if (!meta) return send(notFound(), 'GET');
  if (meta.expiresAt && meta.expiresAt <= Date.now()) return send(expired(), 'GET');
  const json = (o, status, extra) => new Response(JSON.stringify(o), { status, headers: secure({ 'Content-Type': 'application/json' }, extra) });
  if (meta.mode !== 'password') return json({ ok: true }, 200);
  let dk = ''; try { dk = String((await request.json()).dk || ''); } catch { /* not json */ }
  const good = HEX64.test(dk) && same(hex(await crypto.subtle.digest('SHA-256', Uint8Array.from(dk.match(/../g).map((h) => parseInt(h, 16))))), meta.pw.check);
  if (!good) {
    const ms = env.UNLOCK_DELAY_MS !== undefined ? Number(env.UNLOCK_DELAY_MS) : 400 + Math.random() * 100; // slows guessing; there is no lockout
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    return json({ ok: false }, 403);
  }
  return json({ ok: true }, 200, { 'Set-Cookie': `kp_${id}=${await gateCookie(env, id, meta)}; Path=/; Max-Age=${COOKIE_AGE}; HttpOnly; Secure; SameSite=Lax` });
}

function parseRange(h, size) { // -> null (no/unsupported range: send everything) | 'bad' | [start, end]
  const m = /^bytes=(\d*)-(\d*)$/.exec((h || '').trim()); if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { const n = Number(m[2]); if (n === 0) return 'bad'; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2])); }
  return start >= size || start > end ? 'bad' : [start, end];
}

async function media(request, env, id, file) {
  const method = request.method;
  const meta = await loadMeta(env, id);
  if (!meta) return send(notFound(), method);
  if (meta.expiresAt && meta.expiresAt <= Date.now()) return send(expired(), method);
  if (meta.mode === 'password' && !same(cookieOf(request, `kp_${id}`), await gateCookie(env, id, meta))) return new Response(method === 'HEAD' ? null : 'Password needed', { status: 401, headers: secure({ 'Content-Type': 'text/plain; charset=utf-8' }) });
  const isVideo = file === 'video.mp4';
  if (!isVideo && !meta.hasThumb) return send(notFound(), method);
  const url = new URL(request.url), wantsDownload = url.searchParams.get('download') === '1';
  if (wantsDownload && !meta.allowDownload) return new Response('Downloads are switched off for this video', { status: 403, headers: secure({ 'Content-Type': 'text/plain; charset=utf-8' }) });
  const type = isVideo ? 'video/mp4' : 'image/jpeg';
  const size = Number(meta.bytes) || 0;
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=60' };
  if (isVideo && wantsDownload) base['Content-Disposition'] = `attachment; filename="${String(meta.title || 'recording').replace(/[^\w .-]/g, '').slice(0, 80).trim() || 'recording'}.mp4"`;

  let range = null, rangeHeader = null;
  if (isVideo && size > 0) {
    range = parseRange(request.headers.get('range'), size);
    if (range === 'bad') return new Response(null, { status: 416, headers: secure({ 'Content-Range': `bytes */${size}` }) });
    if (range) rangeHeader = `bytes=${range[0]}-${range[1]}`; // always explicit: B2 answers 200 without Content-Range for ranges that cover the whole file
  }
  const r = await b2Get(env, `p/${id}/${file}`, { range: rangeHeader, method: method === 'HEAD' ? 'HEAD' : 'GET' });
  if (r.status === 404) { await r.arrayBuffer(); return send(notFound(), method); }
  if (r.status === 416) { await r.arrayBuffer(); return new Response(null, { status: 416, headers: secure({ 'Content-Range': `bytes */${size}` }) }); }
  if (!r.ok) throw await failFrom(r);
  if (range) return new Response(r.body, { status: 206, headers: secure({ ...base, 'Content-Range': `bytes ${range[0]}-${range[1]}/${size}`, 'Content-Length': String(range[1] - range[0] + 1) }) });
  const len = r.headers.get('content-length');
  return new Response(r.body, { status: 200, headers: secure({ ...base, ...(len ? { 'Content-Length': len } : {}) }) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), method = request.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return new Response('Method not allowed', { status: 405, headers: secure({ Allow: 'GET, HEAD, POST' }) });
    const path = url.pathname;
    if (path === '/healthz') return new Response(method === 'HEAD' ? null : 'ok', { headers: secure({ 'Content-Type': 'text/plain; charset=utf-8' }) });
    if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: secure({ 'Content-Type': 'text/plain; charset=utf-8' }) });
    if (path === '/') return send(msgPage('Kairos links', 'Private video links shared with Kairos.', 200), method);
    const m = /^\/(v|m)\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path);
    const id = m && parseId(m[2]);
    if (!m || !id) return send(notFound(), method);
    if (!configured(env)) return send({ ...msgPage('Not set up', 'This Kairos link server is missing its settings.', 500) }, method, { 'X-Kairos-Error': 'config' });
    try {
      if (m[1] === 'v' && !m[3]) return method === 'POST' ? send(notFound(), 'GET') : await showPage(request, env, id);
      if (m[1] === 'v' && m[3] === 'unlock') return await unlock(request, env, id);
      if (m[1] === 'm' && (m[3] === 'video.mp4' || m[3] === 'thumb.jpg') && method !== 'POST') return await media(request, env, id, m[3]);
      return send(notFound(), method === 'POST' ? 'GET' : method);
    } catch (e) { return problem(e, method === 'POST' ? 'GET' : method); }
  },
};
