// Public links. A finished, Guard-cleared recording becomes a link anyone can open: a small copy goes to a private Backblaze B2 bucket and a free
// Cloudflare Worker (cloud/worker.js) serves it. Nothing here runs by itself. Every publish starts from the owner's click on "Publish" in the Share
// dialog, and the recording pipeline (Stop -> composite -> Privacy Guard -> AI) never imports this file, so it makes no call to Backblaze or Cloudflare.
//
// A second route, "Publish to GitHub", puts a smaller copy in its own public GitHub repository served by GitHub Pages (no Cloudflare, no Backblaze). It cannot
// have a password and cannot be deleted for certain, so it is only offered for "anyone with the link" videos with downloads on, and the dialog says so.
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
const { createGitHub, explain: explainGh, pageHtml } = require('./github');
const { execFileSync } = require('child_process');

const LIFETIME_MS = 30 * 86400000;     // a public link lasts 30 days, then it is deleted
const CAP_BYTES = 9e9;                 // Kairos stops at 9 GB of its own public copies; Backblaze's free tier is 10 GB
const SWEEP_MS = 3600000, RETRY_MS = 600000;
const PW_ITER = 200000, PW_MIN = 8, PW_MAX = 200;
const ENC = 0.4, UPLOAD = 0.58;        // share of the progress bar: encoding, uploading (the last 2% is "finishing")
const STRICT = { link: 0, password: 1, email: 2, private: 3 };
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const STATUS = { not_found: 404, bad_mode: 400, need_password: 400, confirm: 400, bad_config: 400, private: 403, email: 403, looser: 403, too_big: 413, not_video: 422, github_password: 403, github_downloads: 403, github_long: 413 };

class PublishError extends Error {
  constructor(code, message, status) { super(message); this.name = 'PublishError'; this.code = code; this.status = status || STATUS[code] || 409; }
}

// Everything the outside world touches is replaced in tests.
const deps = {
  makeB2: (cfg) => createB2({ keyId: cfg.keyId, key: cfg.key, bucket: cfg.bucket, retries: cfg.retries }),
  encode: share.makeShareCopy,
  poster: share.makePoster,
  fetch: (...a) => fetch(...a),
  makeGitHub: (cfg) => createGitHub({ token: cfg.token, retries: cfg.retries }),
  ghToken: () => ghCliToken(),
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

// GitHub: a token pasted in Settings, or (only if the owner ticked "Use my GitHub CLI login") the token of the `gh` tool already signed in on this Mac.
let ghCache = null;
function ghCliToken() {
  if (ghCache && Date.now() - ghCache.at < 300000) return ghCache.t;
  let t = '';
  for (const bin of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']) {
    if (!fs.existsSync(bin)) continue;
    try { t = execFileSync(bin, ['auth', 'token'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { t = ''; }
    if (t) break;
  }
  ghCache = { t, at: Date.now() };
  return t;
}
function githubConfig() {
  const c = store.getSettings().integrations?.github || {};
  const typed = String(c.token || '').trim();
  if (typed) return { token: typed, source: 'token' };
  if (c.useGh === true || c.useGh === 'true') { const t = deps.ghToken(); if (t) return { token: t, source: 'gh' }; }
  return null;
}
const githubConfigured = () => { try { return !!githubConfig(); } catch { return false; } };

// ---- the rules --------------------------------------------------------------------------------------------------------------
// { ok:true, modes:[...public modes allowed], warnings:[...] } or { ok:false, code, message }
function eligibility(v, host = 'b2') {
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
  if (host === 'github') {
    if (local.mode === 'password') return no('github_password', 'This recording needs a password here, but a GitHub link cannot have one, so anyone could watch it. Use the Backblaze option, or first change its privacy to "Anyone with the link" if you are happy with that.');
    if (!local.allowDownload) return no('github_downloads', 'Downloads are switched off for this recording, but anyone can save a video from a GitHub link. Switch downloads on first, or use the Backblaze option.');
    if (share.estimateBytes(v.duration, share.GITHUB_LIMITS) > share.GITHUB_MAX_BYTES) return no('github_long', `This recording is too long for GitHub (about ${Math.floor(share.GITHUB_MAX_BYTES / share.bytesPerSecond(share.GITHUB_LIMITS) / 60)} minutes at most). Trim it first, or use the Backblaze option.`);
  }
  const warnings = [];
  if (v.guard.speech === 'off') warnings.push('The Guard\'s speech check was switched off for this recording, so anything said out loud was not checked.');
  if (v.guard.model === false) warnings.push('Only the Guard\'s rules ran on this recording (the local AI model was not loaded), so it can miss more.');
  return { ok: true, modes: host === 'github' ? ['link'] : local.mode === 'password' ? ['password'] : ['link', 'password'], warnings };
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

function checkRules(v, { mode, password }, host = 'b2') {
  const e = eligibility(v, host);
  if (!e.ok) throw new PublishError(e.code, e.message);
  if (host === 'github' && mode !== 'link') throw new PublishError('bad_mode', 'A GitHub link cannot have a password. It is always "Anyone with the link".');
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
  if (e && e.name === 'GitHubError') return explainGh(e);
  if (/^ffmpeg/.test(e?.message || '')) return `Could not make the small copy for sharing. ${String(e.message).slice(0, 200)}`;
  return String(e?.message || e).slice(0, 300);
}
const setPublish = (videoId, patch) => { const v = store.get(videoId); if (v?.publish) store.update(videoId, { publish: { ...v.publish, ...patch } }); };

// ---- removal queue: a copy that could not be deleted yet (offline) is retried at startup and every 10 minutes ----------------
// An item is { prefix } for a Backblaze copy or { repo, owner } for a GitHub repository.
const queue = () => store.load().publishQueue || [];
const qkey = (q) => (q.repo ? `gh:${q.owner || ''}/${q.repo}` : q.prefix);
const recKey = (p) => (p.host === 'github' ? `gh:${p.owner || ''}/${p.repo}` : `p/${p.id}/`);
function queueDelete(target) {
  const item = typeof target === 'string' ? { prefix: target } : { repo: target.repo, owner: target.owner, host: 'github' };
  store.mutate((d) => { d.publishQueue = d.publishQueue || []; if (!d.publishQueue.some((q) => qkey(q) === qkey(item))) d.publishQueue.push({ ...item, since: deps.now(), tries: 0 }); });
}
let draining = null;
function drainQueue({ retries = 2 } = {}) {
  if (draining) return draining;
  draining = (async () => {
    let cfg, gcfg; try { cfg = config(); } catch { cfg = null; } try { gcfg = githubConfig(); } catch { gcfg = null; }
    if (!queue().length) return;
    const b2 = cfg ? deps.makeB2({ ...cfg, retries }) : null, gh = gcfg ? deps.makeGitHub({ ...gcfg, retries }) : null, tried = new Set(), down = new Set();
    let ghLogin = null;
    for (let todo = queue(); todo.length; todo = queue().filter((q) => !tried.has(qkey(q)))) { // items queued while this runs are picked up too
      for (const item of todo) {
        const key = qkey(item), host = item.repo ? 'github' : 'b2', client = host === 'github' ? gh : b2;
        tried.add(key);
        if (!client || down.has(host)) continue;
        const note = (error) => store.mutate((d) => { const q = (d.publishQueue || []).find((x) => qkey(x) === key); if (q) { q.tries = (q.tries || 0) + 1; q.error = error; } });
        try {
          if (host === 'github') {
            ghLogin = ghLogin || (await client.user()).login;
            if (item.owner && item.owner !== ghLogin) { note(`This repository belongs to ${item.owner}, but Kairos is signed in to GitHub as ${ghLogin}. Delete https://github.com/${item.owner}/${item.repo} yourself.`); continue; }
            await client.deleteRepo(item.repo);
          } else await client.deletePrefix(item.prefix);
          store.mutate((d) => { d.publishQueue = (d.publishQueue || []).filter((q) => qkey(q) !== key); });
        } catch (e) {
          note(host === 'github' ? explainGh(e) : explainB2(e));
          if (e.code === 'network') return; // no point trying the rest while the connection is down
          if (e.code === 'bad_key' || e.code === 'bad_token') down.add(host); // nor while that service's key is rejected
        }
      }
    }
  })().finally(() => { draining = null; });
  return draining;
}
// p is a publish record. A GitHub repository is only queued once it was really created (repoCreated).
function removeCopy(p) {
  if (!p) return;
  if (p.host === 'github') { if (p.repo && p.repoCreated) queueDelete({ repo: p.repo, owner: p.owner }); return; }
  if (ID_RE.test(p.id || '')) queueDelete(`p/${p.id}/`);
}

// ---- what the UI sees -------------------------------------------------------------------------------------------------------
function summary(v) {
  const p = v.publish, e = eligibility(v);
  const out = { configured: configured(), can: e.ok ? { ok: true, modes: e.modes, warnings: e.warnings } : { ok: false, code: e.code, message: e.message }, state: 'none' };
  const g = eligibility(v, 'github');
  out.github = { configured: githubConfigured(), can: g.ok ? { ok: true, modes: g.modes, warnings: g.warnings } : { ok: false, code: g.code, message: g.message } };
  if (!p) return out;
  out.host = p.host === 'github' ? 'github' : 'b2';
  out.state = p.state; out.mode = p.mode; out.url = p.state === 'live' ? p.url : undefined; // a link that is not live yet is not shown
  out.repoUrl = p.host === 'github' && p.owner && p.repo ? `https://github.com/${p.owner}/${p.repo}` : undefined;
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
  for (const v of store.list()) { // Backblaze only: GitHub copies do not count against the Backblaze free tier
    const p = v.publish; if (!p) continue;
    if (p.state === 'live') { if (p.host !== 'github') n += p.bytes || 0; }
    else if (p.state === 'working') n += (p.host === 'github' ? 0 : share.estimateBytes(v.duration)) + (p.previous && p.previous.host !== 'github' ? p.previous.bytes || 0 : 0);
  }
  return n;
}
function status() {
  const list = store.list().filter((v) => v.publish?.state === 'live'), gl = list.filter((v) => v.publish.host === 'github').length;
  return { configured: configured(), used: usedBytes(), cap: CAP_BYTES, live: list.length - gl, working: !!current, queued: queue().filter((q) => !q.repo).length, lifetimeDays: LIFETIME_MS / 86400000,
    github: { configured: githubConfigured(), live: gl, queued: queue().filter((q) => q.repo).length, errors: queue().filter((q) => q.repo && q.error).map((q) => ({ repo: q.repo, owner: q.owner, error: q.error })) } };
}

// ---- publish ----------------------------------------------------------------------------------------------------------------
async function publish(videoId, { mode, password, host = 'b2' } = {}) {
  if (!['b2', 'github'].includes(host)) throw new PublishError('bad_mode', 'Unknown place to publish.');
  const gh = host === 'github', cfg = gh ? githubConfig() : config();
  if (!cfg) throw new PublishError('not_configured', gh ? 'Publish to GitHub is not set up yet. Open Settings -> Publish to GitHub.' : 'Public links are not set up yet. Open Settings -> Public links.');
  const v = store.get(videoId);
  if (!v) throw new PublishError('not_found', 'No such video.');
  checkRules(v, { mode, password }, host);
  if (current) throw new PublishError('busy', 'Another public link is being made. Wait for it to finish.');
  if (!fs.existsSync(videoFile(videoId))) throw new PublishError('no_file', 'The video file is missing on this Mac.');
  const need = share.estimateBytes(v.duration);
  if (!gh && usedBytes() + need > CAP_BYTES) throw new PublishError('too_big', `Public copies already use ${(usedBytes() / 1e9).toFixed(1)} GB of the ${CAP_BYTES / 1e9} GB Kairos allows itself (Backblaze's free tier is 10 GB). Remove an old public link first.`);

  const local = effectivePrivacy(v), now = deps.now(), id = (gh ? crypto.randomBytes(10).toString('hex') : crypto.randomBytes(16).toString('base64url'));
  const pw = mode === 'password' ? derivePassword(password) : null;
  const previous = v.publish?.state === 'live' ? { ...v.publish, previous: undefined, notice: undefined } : null; // stays live until the new one is ready
  const rec = { id, ...(gh ? { host: 'github', repo: `kairos-share-${id}` } : {}), url: gh ? null : `${cfg.workerUrl}/v/${id}`, state: 'working', stage: 'encoding', mode, createdAt: now, expiresAt: Math.min(now + LIFETIME_MS, local.expiresAt || Infinity),
    allowDownload: gh ? true : local.allowDownload, title: v.title, previous }; // a GitHub video file can always be saved by anyone, so it is recorded as downloadable
  store.update(videoId, { publish: rec });
  store.log(videoId, gh ? 'Publish to GitHub: making a copy to publish' : `Public link: making a ${mode === 'password' ? 'password-protected ' : ''}copy to publish`, 'owner');
  const ctl = new AbortController();
  const job = current = { videoId, id, ctl, progress: 0, stage: 'encoding' };
  job.promise = (gh ? runGithub : run)(job, rec, cfg, pw).catch((e) => deps.log('job crashed', e)).finally(() => { if (current === job) current = null; });
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
    if (!store.get(videoId)) { removeCopy(rec); drainQueue().catch(() => {}); return; }
    store.update(videoId, { publish: live });
    store.log(videoId, `Public link is live (${rec.mode === 'password' ? 'password' : 'anyone with the link'}), expires ${new Date(live.expiresAt).toLocaleDateString()}`, 'owner');
    if (rec.previous) { removeCopy(rec.previous); drainQueue().catch(() => {}); } // the old link stops working once the new one is up
  } catch (e) {
    const cancelled = e.code === 'cancelled' || e.message === 'cancelled';
    if (!cancelled) deps.log('publish failed', videoId, e.message);
    removeCopy(rec); // whatever reached the bucket goes, now or at the next retry
    const cur = store.get(videoId), msg = friendly(e);
    if (cur && cur.publish?.id === id) {
      store.update(videoId, { publish: rec.previous ? { ...rec.previous, notice: cancelled ? undefined : `Republishing failed, so the link above is still the old one. ${msg}` } : cancelled ? null : { state: 'failed', error: msg, mode: rec.mode } });
      store.log(videoId, cancelled ? 'Public link: cancelled' : `Public link failed: ${msg}`, 'owner');
    }
    drainQueue().catch(() => {});
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// The GitHub route. The repository is created PRIVATE and filled in; only when everything is there is it made public and Pages switched on, and that is the
// moment the link goes live (the same job meta.json does for Backblaze). The privacy re-check happens just before that.
async function runGithub(job, rec, cfg) {
  const { videoId, id, ctl } = job, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-share-'));
  const stage = (name) => { job.stage = name; setPublish(videoId, { stage: name }); };
  const opts = { signal: ctl.signal };
  try {
    const src = videoFile(videoId), v0 = store.get(videoId), sourceSig = sig(videoId);
    const copy = path.join(tmp, 'video.mp4'), poster = path.join(tmp, 'thumb.jpg');
    await deps.encode(src, copy, { duration: v0.duration, signal: ctl.signal, limits: share.GITHUB_LIMITS, onProgress: (p) => { job.progress = ENC * p; } });
    const size = fs.statSync(copy).size, custom = path.join(store.videoDir(videoId), 'thumb-custom.jpg');
    if (size > share.GITHUB_MAX_BYTES) throw new PublishError('github_long', `The small copy came out at ${(size / 1e6).toFixed(0)} MB, over GitHub's ${share.GITHUB_MAX_BYTES / 1e6} MB limit. Trim the recording first, or use the Backblaze option.`);
    if (fs.existsSync(custom) && fs.statSync(custom).mtimeMs >= fs.statSync(src).mtimeMs) fs.copyFileSync(custom, poster);
    else await deps.poster(copy, poster, v0.duration);
    const thumb = fs.readFileSync(poster);

    stage('uploading');
    const g = deps.makeGitHub(cfg);
    await g.createRepo(rec.repo, 'Shared with Kairos', opts);
    rec.repoCreated = true; rec.owner = g.login; job.owner = g.login;
    setPublish(videoId, { repoCreated: true, owner: g.login });
    const base = `https://${g.login}.github.io/${rec.repo}/`;
    await g.putFile(rec.repo, 'video.mp4', fs.readFileSync(copy), 'Add video', opts);
    job.progress = ENC + UPLOAD * 0.9;
    await g.putFile(rec.repo, 'thumb.jpg', thumb, 'Add poster', opts);
    await g.putFile(rec.repo, 'index.html', Buffer.from(pageHtml({ title: v0.title, base })), 'Add page', opts);

    stage('finishing');
    job.progress = ENC + UPLOAD;
    const now = store.get(videoId);
    if (!now) throw new PublishError('changed', 'The video was deleted while it was being published.');
    if (!eligibility(now, 'github').ok || tooLoose(effectivePrivacy(now), rec)) throw new PublishError('changed', 'The privacy settings changed while publishing, so nothing was published.');
    await g.makePublic(rec.repo, opts);          // from here on the files can be opened by anyone
    await g.enablePages(rec.repo, opts);
    const url = await g.waitForPages(rec.repo, opts);

    const live = { id, host: 'github', repo: rec.repo, owner: g.login, repoCreated: true, url, state: 'live', mode: 'link', publishedAt: deps.now(), expiresAt: rec.expiresAt, bytes: size + thumb.length, allowDownload: true, title: now.title, sourceSig };
    job.progress = 1;
    if (!store.get(videoId)) { removeCopy(rec); drainQueue().catch(() => {}); return; }
    store.update(videoId, { publish: live });
    store.log(videoId, `GitHub link is live (anyone with the link), expires ${new Date(live.expiresAt).toLocaleDateString()}`, 'owner');
    if (rec.previous) { removeCopy(rec.previous); drainQueue().catch(() => {}); }
  } catch (e) {
    const cancelled = e.code === 'cancelled' || e.message === 'cancelled';
    if (!cancelled) deps.log('github publish failed', videoId, e.message);
    removeCopy(rec); // only queued if the repository was really created
    const cur = store.get(videoId), msg = friendly(e);
    if (cur && cur.publish?.id === id) {
      store.update(videoId, { publish: rec.previous ? { ...rec.previous, notice: cancelled ? undefined : `Republishing failed, so the link above is still the old one. ${msg}` } : cancelled ? null : { state: 'failed', error: msg, mode: rec.mode, host: 'github' } });
      store.log(videoId, cancelled ? 'Publish to GitHub: cancelled' : `Publish to GitHub failed: ${msg}`, 'owner');
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
    if (p.id && p.state === 'live') removeCopy(p);
    store.update(videoId, { publish: reason ? { state: 'removed', reason, removedAt: deps.now() } : null });
    store.log(videoId, reason ? `Public link removed: ${reason}` : 'Public link removed', reason ? 'system' : 'owner');
    await drainQueue({ retries: 1 }).catch(() => {});
  }
  const item = p?.id ? queue().find((q) => qkey(q) === recKey(p)) : null;
  return { ...summary(store.get(videoId)), removal: item ? 'queued' : 'done', ...(item?.error ? { removalError: item.error } : {}) };
}

// After a privacy change: a public copy that is now looser than the video's local privacy is taken down (or the running job is stopped).
async function enforce(videoId) {
  const v = store.get(videoId), p = v?.publish;
  if (!p) return;
  const local = effectivePrivacy(v);
  if (p.state === 'working') {
    if (current?.videoId !== videoId || !(tooLoose(local, p) || !eligibility(v, p.host === 'github' ? 'github' : 'b2').ok)) return;
    current.ctl.abort(); await current.promise;
    store.log(videoId, `Public link: publishing was stopped because ${looseReason(local, p)}`, 'system');
    return enforce(videoId); // an older live link that was kept while republishing may be too loose as well
  }
  if (p.state === 'live' && tooLoose(local, p)) await unpublish(videoId, { reason: looseReason(local, p) });
}
const enforceAll = () => Promise.all(store.list().filter((v) => v.publish).map((v) => enforce(v.id)));

// ---- removal of everything --------------------------------------------------------------------------------------------------
async function removeAll() {
  if (!config() && !githubConfig()) throw new PublishError('not_configured', 'Public links are not set up yet.');
  if (current) { current.ctl.abort(); await current.promise; }
  for (const v of store.list()) if (v.publish) {
    removeCopy(v.publish); removeCopy(v.publish.previous); // GitHub repositories, one by one
    store.update(v.id, { publish: null }); store.log(v.id, 'Public link removed (remove all)', 'owner');
  }
  if (config()) queueDelete('p/');
  await drainQueue({ retries: 2 });
  return { queued: queue().length > 0 };
}

// ---- background upkeep ------------------------------------------------------------------------------------------------------
async function sweep() {
  const now = deps.now();
  for (const v of store.list()) {
    const p = v.publish;
    if (p?.state === 'live' && p.expiresAt && now > p.expiresAt) {
      removeCopy(p);
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
      removeCopy(p);
      store.update(v.id, { publish: p.previous ? { ...p.previous, notice: 'Republishing was interrupted when Kairos closed, so the link above is still the old one.' } : { state: 'failed', error: 'Interrupted when Kairos closed. Press Publish to try again.', mode: p.mode } });
    }
  }
}
function onRemoved(rec) { // store.remove() lands here for every way a video can disappear: Delete, retention sweep, delete-all, a cancelled recording
  const p = rec.publish; if (!p) return;
  if (current?.videoId === rec.id) current.ctl.abort();
  removeCopy(p); removeCopy(p.previous);
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

// "Test" for GitHub: the token works, who it belongs to, and what it is allowed to do. It creates nothing.
async function testGitHub() {
  const steps = [], step = (name, ok, detail) => { steps.push({ name, ok, detail }); return ok; };
  const cfg = githubConfig();
  if (!cfg) { step('Token', false, 'Paste a GitHub token, or tick "Use my GitHub CLI login" (needs the gh tool signed in on this Mac).'); return { ok: false, steps }; }
  step('Token', true, cfg.source === 'gh' ? 'Using the token of the GitHub CLI (gh) on this Mac.' : 'A token is saved on this Mac.');
  try {
    const c = await deps.makeGitHub({ ...cfg, retries: 1 }).check();
    step('Sign-in', true, `Signed in as ${c.login}.`);
    if (c.canCreate === false) step('Can create repositories', false, 'This token cannot create repositories. Use a classic token with the "repo" permission.');
    else step('Can create repositories', true, c.canCreate ? 'Yes.' : 'GitHub does not say for this kind of token. The first publish will tell.');
    if (c.canDelete === false) step('Can delete repositories', false, 'No. Links will work, but Kairos cannot delete the repository after 30 days or when you unpublish: you would delete it yourself on GitHub. Add the "delete_repo" permission to fix that.');
    else step('Can delete repositories', true, c.canDelete ? 'Yes, so Kairos can remove a link for you.' : 'GitHub does not say for this kind of token.');
  } catch (e) { step('Sign-in', false, friendly(e)); }
  return { ok: steps.every((s) => s.ok), steps };
}

module.exports = { PublishError, deps, parseWorkerUrl, config, configured, githubConfig, githubConfigured, testGitHub, eligibility, tooLoose, publish, unpublish, enforce, enforceAll, removeAll, summary, status, usedBytes, testConnection, start, stop, sweep, recover,
  drainQueue, queue, idle, LIFETIME_MS, CAP_BYTES };
