// Public links. A finished, Guard-cleared recording becomes a link anyone can open: a small copy goes to a private Backblaze B2 bucket and a free
// Cloudflare Worker (cloud/worker.js) serves it. Nothing here runs by itself. Every publish starts from the owner's click on "Publish" in the Share
// dialog, and the recording pipeline (Stop -> composite -> Privacy Guard -> AI) never imports this file, so it makes no call to Backblaze or Cloudflare.
//
// The rule that matters most: a public link may be exactly as strict as the video's local privacy or stricter, never looser. eligibility() decides
// whether a video may get one, tooLoose() notices when a later privacy change has made an existing one too loose, and enforce() then takes it down.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../store');
const { effectivePrivacy } = require('../server/auth');
const share = require('../pipeline/share-copy');
const { runFfmpeg } = require('../pipeline/encode');
const { createB2, explain: explainB2 } = require('./b2');

const LIFETIME_MS = 30 * 86400000;     // a public link lasts 30 days, then it is deleted
const CAP_BYTES = 9e9;                 // Kairos stops at 9 GB of its own public copies; Backblaze's free tier is 10 GB
const SWEEP_MS = 3600000, RETRY_MS = 600000;
const PW_ITER = 200000, PW_MIN = 8, PW_MAX = 200;
const ENC = 0.4, UPLOAD = 0.58;        // share of the progress bar: encoding, uploading (the last 2% is "finishing")
const STRICT = { link: 0, password: 1, email: 2, private: 3 };
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const STATUS = { not_found: 404, bad_mode: 400, need_password: 400, confirm: 400, bad_config: 400, private: 403, email: 403, looser: 403, too_big: 413, not_video: 422 };

class PublishError extends Error {
  constructor(code, message, status) { super(message); this.name = 'PublishError'; this.code = code; this.status = status || STATUS[code] || 409; }
}

// Everything the outside world touches is replaced in tests.
const deps = {
  makeB2: (cfg) => createB2({ keyId: cfg.keyId, key: cfg.key, bucket: cfg.bucket, retries: cfg.retries }),
  encode: share.makeShareCopy,
  poster: share.makePoster,
  fetch: (...a) => fetch(...a),
  now: () => Date.now(),
  log: (...a) => console.warn('[publish]', ...a),
};

let current = null; // the one running job: { videoId, id, ctl, progress, stage, promise }

// ---- settings ---------------------------------------------------------------------------------------------------------------
function parseWorkerUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new PublishError('bad_config', 'The Worker address does not look like a web address. It should look like https://kairos-links.yourname.workers.dev'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) throw new PublishError('bad_config', 'The Worker address must start with https://');
  return u.origin;
}
// null when Public links are not set up; throws a PublishError when a setting is there but wrong.
function config() {
  const c = store.getSettings().integrations?.publish || {};
  const bucket = String(c.bucket || '').trim(), keyId = String(c.accessId || '').trim(), key = String(c.appKey || '').trim();
  if (!String(c.workerUrl || '').trim() || !bucket || !keyId || !key) return null;
  return { workerUrl: parseWorkerUrl(c.workerUrl), bucket, keyId, key };
}
const configured = () => { try { return !!config(); } catch { return false; } };

// ---- the rules --------------------------------------------------------------------------------------------------------------
// { ok:true, modes:[...public modes allowed], warnings:[...] } or { ok:false, code, message }
function eligibility(v) {
  const no = (code, message) => ({ ok: false, code, message });
  if (v.type && v.type !== 'video') return no('not_video', 'Public links are for videos for now, not screenshots.');
  if (v.status === 'failed') return no('not_ready', 'This recording failed to process, so it cannot be shared.');
  if (v.status !== 'ready') return no('not_ready', 'Wait until the recording has finished processing.');
  if (v.shareable !== true) return no('not_shareable', 'The Privacy Guard has not cleared this recording yet.');
  if (!v.guard) return no('no_guard', 'This recording has no Privacy Guard scan (it was made before the Guard existed, or with the Guard switched off), so it cannot get a public link. New recordings are scanned automatically.');
  const local = effectivePrivacy(v);
  if (local.mode === 'private') return no('private', 'This recording is Private, so it never gets a public link. Change its privacy first if you really want one.');
  if (local.mode === 'email') return no('email', '"Ask for email" cannot be checked on a public page yet. Choose "Anyone with the link" or "Password" first.');
  if (local.expiresAt && local.expiresAt <= deps.now()) return no('expired', 'This recording\'s link has expired. Set a new expiry first.');
  const warnings = [];
  if (v.guard.speech === 'off') warnings.push('The Guard\'s speech check was switched off for this recording, so anything said out loud was not checked.');
  if (v.guard.model === false) warnings.push('Only the Guard\'s rules ran on this recording (the local AI model was not loaded), so it can miss more.');
  return { ok: true, modes: local.mode === 'password' ? ['password'] : ['link', 'password'], warnings };
}

// Is the public record `p` looser than the video's local privacy `local`? (mode, expiry, downloads)
const tooLoose = (local, p) => STRICT[p.mode] < STRICT[local.mode] || !!(local.expiresAt && (!p.expiresAt || p.expiresAt > local.expiresAt)) || !!(p.allowDownload && !local.allowDownload);
function looseReason(local, p) {
  if (local.mode === 'private') return 'this video is now Private';
  if (local.mode === 'email') return 'this video now asks for an email, which a public page cannot check';
  if (STRICT[p.mode] < STRICT[local.mode]) return 'this video now needs a password, so its public link would be looser than that';
  if (local.expiresAt && (!p.expiresAt || p.expiresAt > local.expiresAt)) return 'the video\'s own expiry is now earlier than the public link\'s';
  if (p.allowDownload && !local.allowDownload) return 'downloads were switched off for this video';
  return 'the video\'s privacy settings changed';
}

function checkRules(v, { mode, password }) {
  const e = eligibility(v);
  if (!e.ok) throw new PublishError(e.code, e.message);
  if (!['link', 'password'].includes(mode)) throw new PublishError('bad_mode', 'Choose "Anyone with the link" or "Password".');
  if (!e.modes.includes(mode)) throw new PublishError('looser', 'This recording needs a password here on the Mac, so its public link needs one too.');
  if (mode === 'password') {
    const pw = String(password ?? '');
    if (pw.length < PW_MIN) throw new PublishError('need_password', `A public password needs at least ${PW_MIN} characters. Anyone on the internet can try to guess it, so make it long.`);
    if (pw.length > PW_MAX) throw new PublishError('need_password', `A public password can be at most ${PW_MAX} characters.`);
  }
}

// ---- small helpers ----------------------------------------------------------------------------------------------------------
const videoFile = (id) => path.join(store.videoDir(id), 'video.mp4');
function sig(id) { try { const s = fs.statSync(videoFile(id)); return `${Math.round(s.mtimeMs)}:${s.size}`; } catch { return null; } }
function derivePassword(pw) { // the browser derives the same key (PBKDF2-SHA256, NFC, UTF-8); only SHA-256 of it is stored
  const salt = crypto.randomBytes(16), dk = crypto.pbkdf2Sync(String(pw).normalize('NFC'), salt, PW_ITER, 32, 'sha256');
  return { salt: salt.toString('hex'), iter: PW_ITER, check: crypto.createHash('sha256').update(dk).digest('hex') };
}
function friendly(e) {
  if (e instanceof PublishError) return e.message;
  if (e && e.name === 'B2Error') return explainB2(e);
  if (/^ffmpeg/.test(e?.message || '')) return `Could not make the small copy for sharing. ${String(e.message).slice(0, 200)}`;
  return String(e?.message || e).slice(0, 300);
}
const setPublish = (videoId, patch) => { const v = store.get(videoId); if (v?.publish) store.update(videoId, { publish: { ...v.publish, ...patch } }); };

// ---- removal queue: a copy that could not be deleted yet (offline) is retried at startup and every 10 minutes ----------------
const queue = () => store.load().publishQueue || [];
function queueDelete(prefix) {
  store.mutate((d) => { d.publishQueue = d.publishQueue || []; if (!d.publishQueue.some((q) => q.prefix === prefix)) d.publishQueue.push({ prefix, since: deps.now(), tries: 0 }); });
}
let draining = null;
function drainQueue({ retries = 2 } = {}) {
  if (draining) return draining;
  draining = (async () => {
    let cfg; try { cfg = config(); } catch { cfg = null; }
    if (!cfg || !queue().length) return;
    const b2 = deps.makeB2({ ...cfg, retries }), tried = new Set();
    for (let todo = queue(); todo.length; todo = queue().filter((q) => !tried.has(q.prefix))) { // items queued while this runs are picked up too
      for (const item of todo) {
        tried.add(item.prefix);
        try {
          await b2.deletePrefix(item.prefix);
          store.mutate((d) => { d.publishQueue = (d.publishQueue || []).filter((q) => q.prefix !== item.prefix); });
        } catch (e) {
          store.mutate((d) => { const q = (d.publishQueue || []).find((x) => x.prefix === item.prefix); if (q) { q.tries = (q.tries || 0) + 1; q.error = explainB2(e); } });
          if (e.code === 'network' || e.code === 'bad_key') return; // no point trying the rest while the connection or key is down
        }
      }
    }
  })().finally(() => { draining = null; });
  return draining;
}
const removeCopy = (id) => { if (ID_RE.test(id || '')) queueDelete(`p/${id}/`); };

// ---- what the UI sees -------------------------------------------------------------------------------------------------------
function summary(v) {
  const p = v.publish, e = eligibility(v);
  const out = { configured: configured(), can: e.ok ? { ok: true, modes: e.modes, warnings: e.warnings } : { ok: false, code: e.code, message: e.message }, state: 'none' };
  if (!p) return out;
  out.state = p.state; out.mode = p.mode; out.url = p.state === 'live' ? p.url : undefined; // a link that is not live yet is not shown
  out.expiresAt = p.expiresAt; out.publishedAt = p.publishedAt; out.bytes = p.bytes; out.allowDownload = p.allowDownload; out.error = p.error; out.notice = p.notice; out.reason = p.reason;
  if (p.state === 'working') {
    out.stage = current?.videoId === v.id ? current.stage : p.stage; out.progress = current?.videoId === v.id ? current.progress : 0;
    if (p.previous) out.previous = { url: p.previous.url, expiresAt: p.previous.expiresAt };
  }
  if (p.state === 'live') {
    const now = sig(v.id);
    if (p.sourceSig && now && p.sourceSig !== now) { out.stale = true; out.staleWhy = 'The video was edited after it was published.'; }
    else if (p.title != null && p.title !== v.title) { out.stale = true; out.staleWhy = 'The title changed after it was published.'; }
  }
  return out;
}
function usedBytes() {
  let n = 0;
  for (const v of store.list()) { const p = v.publish; if (!p) continue; if (p.state === 'live') n += p.bytes || 0; else if (p.state === 'working') n += share.estimateBytes(v.duration) + (p.previous?.bytes || 0); }
  return n;
}
function status() {
  const list = store.list().filter((v) => v.publish?.state === 'live');
  return { configured: configured(), used: usedBytes(), cap: CAP_BYTES, live: list.length, working: !!current, queued: queue().length, lifetimeDays: LIFETIME_MS / 86400000 };
}

// ---- publish ----------------------------------------------------------------------------------------------------------------
async function publish(videoId, { mode, password } = {}) {
  const cfg = config();
  if (!cfg) throw new PublishError('not_configured', 'Public links are not set up yet. Open Settings -> Public links.');
  const v = store.get(videoId);
  if (!v) throw new PublishError('not_found', 'No such video.');
  checkRules(v, { mode, password });
  if (current) throw new PublishError('busy', 'Another public link is being made. Wait for it to finish.');
  if (!fs.existsSync(videoFile(videoId))) throw new PublishError('no_file', 'The video file is missing on this Mac.');
  const need = share.estimateBytes(v.duration);
  if (usedBytes() + need > CAP_BYTES) throw new PublishError('too_big', `Public copies already use ${(usedBytes() / 1e9).toFixed(1)} GB of the ${CAP_BYTES / 1e9} GB Kairos allows itself (Backblaze's free tier is 10 GB). Remove an old public link first.`);

  const local = effectivePrivacy(v), now = deps.now(), id = crypto.randomBytes(16).toString('base64url');
  const pw = mode === 'password' ? derivePassword(password) : null;
  const previous = v.publish?.state === 'live' ? { ...v.publish, previous: undefined, notice: undefined } : null; // stays live until the new one is ready
  const rec = { id, url: `${cfg.workerUrl}/v/${id}`, state: 'working', stage: 'encoding', mode, createdAt: now, expiresAt: Math.min(now + LIFETIME_MS, local.expiresAt || Infinity),
    allowDownload: local.allowDownload, title: v.title, previous };
  store.update(videoId, { publish: rec });
  store.log(videoId, `Public link: making a ${mode === 'password' ? 'password-protected ' : ''}copy to publish`, 'owner');
  const ctl = new AbortController();
  const job = current = { videoId, id, ctl, progress: 0, stage: 'encoding' };
  job.promise = run(job, rec, cfg, pw).catch((e) => deps.log('job crashed', e)).finally(() => { if (current === job) current = null; });
  return summary(store.get(videoId));
}

async function run(job, rec, cfg, pw) {
  const { videoId, id, ctl } = job, prefix = `p/${id}/`, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-share-'));
  const stage = (name) => { job.stage = name; setPublish(videoId, { stage: name }); };
  try {
    const src = videoFile(videoId), v0 = store.get(videoId), sourceSig = sig(videoId); // taken before encoding: an edit made meanwhile shows up as "out of date"
    const copy = path.join(tmp, 'video.mp4'), poster = path.join(tmp, 'thumb.jpg');
    await deps.encode(src, copy, { duration: v0.duration, signal: ctl.signal, onProgress: (p) => { job.progress = ENC * p; } });
    const size = fs.statSync(copy).size, custom = path.join(store.videoDir(videoId), 'thumb-custom.jpg');
    // The poster is a frame of the share copy, or the owner's custom thumbnail if it was made after the last change to the video: either way it can only show what the video shows.
    if (fs.existsSync(custom) && fs.statSync(custom).mtimeMs >= fs.statSync(src).mtimeMs) fs.copyFileSync(custom, poster);
    else await deps.poster(copy, poster, v0.duration);
    const thumb = fs.readFileSync(poster);

    stage('uploading');
    const b2 = deps.makeB2(cfg);
    await b2.putFile(`${prefix}video.mp4`, { file: copy }, { contentType: 'video/mp4', signal: ctl.signal, onProgress: (d, t) => { job.progress = ENC + UPLOAD * (d / t); } });
    await b2.putFile(`${prefix}thumb.jpg`, thumb, { contentType: 'image/jpeg', signal: ctl.signal });

    stage('finishing');
    job.progress = ENC + UPLOAD;
    const now = store.get(videoId);
    if (!now) throw new PublishError('changed', 'The video was deleted while it was being published.');
    if (!eligibility(now).ok || tooLoose(effectivePrivacy(now), rec)) throw new PublishError('changed', 'The privacy settings changed while publishing, so nothing was published.');
    const meta = { v: 1, title: String(now.title || 'Recording').slice(0, 200), mode: rec.mode, createdAt: rec.createdAt, expiresAt: rec.expiresAt, bytes: size, duration: now.duration || 0,
      allowDownload: rec.allowDownload, hasThumb: true, ...(pw ? { pw } : {}) };
    const metaBuf = Buffer.from(JSON.stringify(meta));
    await b2.putFile(`${prefix}meta.json`, metaBuf, { contentType: 'application/json', signal: ctl.signal }); // last: until it exists the link shows "not found"

    const live = { id, url: rec.url, state: 'live', mode: rec.mode, publishedAt: deps.now(), expiresAt: rec.expiresAt, bytes: size + thumb.length + metaBuf.length, allowDownload: rec.allowDownload, title: now.title, sourceSig };
    job.progress = 1;
    if (!store.get(videoId)) { removeCopy(id); drainQueue().catch(() => {}); return; }
    store.update(videoId, { publish: live });
    store.log(videoId, `Public link is live (${rec.mode === 'password' ? 'password' : 'anyone with the link'}), expires ${new Date(live.expiresAt).toLocaleDateString()}`, 'owner');
    if (rec.previous) { removeCopy(rec.previous.id); drainQueue().catch(() => {}); } // the old link stops working once the new one is up
  } catch (e) {
    const cancelled = e.code === 'cancelled' || e.message === 'cancelled';
    if (!cancelled) deps.log('publish failed', videoId, e.message);
    removeCopy(id); // whatever reached the bucket goes, now or at the next retry
    const cur = store.get(videoId), msg = friendly(e);
    if (cur && cur.publish?.id === id) {
      store.update(videoId, { publish: rec.previous ? { ...rec.previous, notice: cancelled ? undefined : `Republishing failed, so the link above is still the old one. ${msg}` } : cancelled ? null : { state: 'failed', error: msg, mode: rec.mode } });
      store.log(videoId, cancelled ? 'Public link: cancelled' : `Public link failed: ${msg}`, 'owner');
    }
    drainQueue().catch(() => {});
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// "Unpublish" on a live link deletes it; on a running job it cancels the job (the job then restores the previous link, if any).
async function unpublish(videoId, { reason } = {}) {
  const v = store.get(videoId);
  if (!v) throw new PublishError('not_found', 'No such video.');
  if (current && current.videoId === videoId) { current.ctl.abort(); await current.promise; return { ...summary(store.get(videoId) || v), removal: 'done' }; }
  const p = v.publish;
  if (p) {
    if (p.id && p.state === 'live') removeCopy(p.id);
    store.update(videoId, { publish: reason ? { state: 'removed', reason, removedAt: deps.now() } : null });
    store.log(videoId, reason ? `Public link removed: ${reason}` : 'Public link removed', reason ? 'system' : 'owner');
    await drainQueue({ retries: 1 }).catch(() => {});
  }
  const left = p?.id ? queue().some((q) => q.prefix === `p/${p.id}/`) : false;
  return { ...summary(store.get(videoId)), removal: left ? 'queued' : 'done' };
}

// After a privacy change: a public copy that is now looser than the video's local privacy is taken down (or the running job is stopped).
async function enforce(videoId) {
  const v = store.get(videoId), p = v?.publish;
  if (!p) return;
  const local = effectivePrivacy(v);
  if (p.state === 'working') {
    if (current?.videoId !== videoId || !(tooLoose(local, p) || !eligibility(v).ok)) return;
    current.ctl.abort(); await current.promise;
    store.log(videoId, `Public link: publishing was stopped because ${looseReason(local, p)}`, 'system');
    return enforce(videoId); // an older live link that was kept while republishing may be too loose as well
  }
  if (p.state === 'live' && tooLoose(local, p)) await unpublish(videoId, { reason: looseReason(local, p) });
}
const enforceAll = () => Promise.all(store.list().filter((v) => v.publish).map((v) => enforce(v.id)));

// ---- removal of everything --------------------------------------------------------------------------------------------------
async function removeAll() {
  if (!config()) throw new PublishError('not_configured', 'Public links are not set up yet.');
  if (current) { current.ctl.abort(); await current.promise; }
  for (const v of store.list()) if (v.publish) { store.update(v.id, { publish: null }); store.log(v.id, 'Public link removed (remove all)', 'owner'); }
  queueDelete('p/');
  await drainQueue({ retries: 2 });
  return { queued: queue().some((q) => q.prefix === 'p/') };
}

// ---- background upkeep ------------------------------------------------------------------------------------------------------
async function sweep() {
  const now = deps.now();
  for (const v of store.list()) {
    const p = v.publish;
    if (p?.state === 'live' && p.expiresAt && now > p.expiresAt) {
      removeCopy(p.id);
      store.update(v.id, { publish: { state: 'expired', mode: p.mode, publishedAt: p.publishedAt, expiresAt: p.expiresAt } });
      store.log(v.id, 'Public link expired and was removed', 'system');
    }
  }
  await enforceAll();
  await drainQueue();
}
function recover() { // a job that was running when Kairos quit left a half-made copy and a record that says "working"
  for (const v of store.list()) {
    const p = v.publish;
    if (p?.state === 'working' && current?.videoId !== v.id) {
      removeCopy(p.id);
      store.update(v.id, { publish: p.previous ? { ...p.previous, notice: 'Republishing was interrupted when Kairos closed, so the link above is still the old one.' } : { state: 'failed', error: 'Interrupted when Kairos closed. Press Publish to try again.', mode: p.mode } });
    }
  }
}
function onRemoved(rec) { // store.remove() lands here for every way a video can disappear: Delete, retention sweep, delete-all, a cancelled recording
  const p = rec.publish; if (!p) return;
  if (current?.videoId === rec.id) current.ctl.abort();
  removeCopy(p.id); removeCopy(p.previous?.id);
  drainQueue().catch(() => {});
}
let started = false, timers = [];
function start() {
  if (started) return; started = true;
  store.events.on('removed', onRemoved);
  recover();
  sweep().catch((e) => deps.log('sweep failed', e.message));
  timers = [setInterval(() => sweep().catch((e) => deps.log('sweep failed', e.message)), SWEEP_MS), setInterval(() => drainQueue().catch(() => {}), RETRY_MS)];
  timers.forEach((t) => t.unref());
}
function stop() { store.events.off('removed', onRemoved); timers.forEach(clearInterval); timers = []; started = false; }
const idle = () => (current ? current.promise : Promise.resolve());

// ---- "Test" button ----------------------------------------------------------------------------------------------------------
// Uploads a one-second clip, opens it through the Worker the way a viewer would, then deletes it. Returns { ok, steps: [{ name, ok, detail }] }.
async function testConnection() {
  const steps = [], step = (name, ok, detail) => { steps.push({ name, ok, detail }); return ok; };
  let cfg;
  try { cfg = config(); } catch (e) { step('Settings', false, e.message); return { ok: false, steps }; }
  if (!cfg) { step('Settings', false, 'Fill in the Worker address, bucket name, key ID and key first.'); return { ok: false, steps }; }
  const b2 = deps.makeB2({ ...cfg, retries: 1 }), id = crypto.randomBytes(16).toString('base64url'), prefix = `p/${id}/`, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-test-'));
  let touched = false;
  const get = async (url, headers = {}) => deps.fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const hint = (r) => ({ b2_auth: "The Worker's read-only Backblaze key was rejected. Check B2_KEY_ID in wrangler.toml and the B2_APP_KEY secret, then deploy again.",
    config: 'The Worker is missing settings. It needs B2_KEY_ID and B2_BUCKET (wrangler.toml) and the secrets B2_APP_KEY and COOKIE_KEY.', b2_bucket: 'The Worker could not find the bucket. Check B2_BUCKET in wrangler.toml.' })[r.headers.get('x-kairos-error')] || '';
  try {
    try { const c = await b2.check(); step('Backblaze key', true, `Accepted. It can use the bucket "${c.bucket}".`); } catch (e) { step('Backblaze key', false, explainB2(e)); return { ok: false, steps }; }
    const copy = path.join(tmp, 'video.mp4'), poster = path.join(tmp, 'thumb.jpg');
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=15:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', copy]);
    await deps.poster(copy, poster, 1);
    const size = fs.statSync(copy).size, meta = { v: 1, title: 'Kairos connection test', mode: 'link', createdAt: deps.now(), expiresAt: deps.now() + 600000, bytes: size, duration: 1, allowDownload: false, hasThumb: true };
    touched = true;
    try {
      await b2.putFile(`${prefix}video.mp4`, { file: copy }, { contentType: 'video/mp4' });
      await b2.putFile(`${prefix}thumb.jpg`, fs.readFileSync(poster), { contentType: 'image/jpeg' });
      await b2.putFile(`${prefix}meta.json`, Buffer.from(JSON.stringify(meta)), { contentType: 'application/json' });
      step('Upload', true, `A ${(size / 1024).toFixed(0)} KB test clip reached the bucket.`);
    } catch (e) { step('Upload', false, explainB2(e)); return { ok: false, steps }; }

    const base = cfg.workerUrl;
    let r;
    try { r = await get(`${base}/healthz`); } catch (e) { step('Worker address', false, `Could not reach ${base} (${e.cause?.code || e.message}). Check the address, and that the Worker is deployed.`); return { ok: false, steps }; }
    if (!(r.status === 200 && (await r.text()).trim() === 'ok')) { step('Worker address', false, `${base} answered (HTTP ${r.status}) but it does not look like the Kairos Worker. Check the address, and deploy cloud/worker.js.`); return { ok: false, steps }; }
    step('Worker address', true, 'The Worker answers.');
    r = await get(`${base}/v/${id}`);
    const page = r.status === 200 ? await r.text() : '';
    if (!(r.status === 200 && page.includes('Kairos connection test'))) { step('Worker reads the bucket', false, hint(r) || `The test page did not open (HTTP ${r.status}).`); return { ok: false, steps }; }
    step('Worker reads the bucket', true, 'The Worker found the test clip in the bucket.');
    r = await get(`${base}/m/${id}/video.mp4`, { Range: 'bytes=0-99' });
    const cr = r.headers.get('content-range');
    await r.arrayBuffer();
    r = await get(`${base}/m/${id}/video.mp4`, { Range: 'bytes=0-' });
    const whole = r.status, wholeCr = r.headers.get('content-range'); await r.arrayBuffer();
    if (cr === `bytes 0-99/${size}` && whole === 206 && wholeCr === `bytes 0-${size - 1}/${size}`) step('Video streaming', true, 'The video streams in pieces, which phones need.');
    else step('Video streaming', false, `The video did not stream the way phones need (Content-Range "${cr}", whole-file request answered ${whole}).`);
    r = await get(`${base}/v/${crypto.randomBytes(16).toString('base64url')}`); await r.arrayBuffer();
    step('Unknown links', r.status === 404, r.status === 404 ? 'A made-up link shows "not found".' : `A made-up link answered HTTP ${r.status}, not 404.`);
  } catch (e) {
    step('Test', false, friendly(e));
  } finally {
    if (touched) { try { await b2.deletePrefix(prefix); step('Cleanup', true, 'The test files were deleted.'); } catch (e) { queueDelete(prefix); step('Cleanup', false, `The test files could not be deleted yet (${explainB2(e)}). Kairos will retry.`); } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { ok: steps.every((s) => s.ok), steps };
}

module.exports = { PublishError, deps, parseWorkerUrl, config, configured, eligibility, tooLoose, publish, unpublish, enforce, enforceAll, removeAll, summary, status, usedBytes, testConnection, start, stop, sweep, recover,
  drainQueue, queue, idle, LIFETIME_MS, CAP_BYTES };
