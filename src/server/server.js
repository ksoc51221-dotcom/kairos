// Local "cloud": library + watch pages, viewer API, privacy gate, analytics, captions, upload, settings.
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const store = require('../store');
const { isOwner, requireOwner, hashPw, checkPw, effectivePrivacy, access, unlockCookie, cookies } = require('./auth');
const { processVideo, rerunAI } = require('../agents/orchestrator');
const extras = require('./extras');

const pub = path.join(__dirname, 'public');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lanIp = () => Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

// What a viewer may see. The owner additionally gets the crew log, privacy settings, viewers and activity.
function viewModel(v, owner) {
  const p = effectivePrivacy(v);
  const m = {
    id: v.id, type: v.type, title: v.title, createdAt: v.createdAt, status: v.status, stage: v.stage, duration: v.duration, views: v.views,
    comments: v.comments, reactions: v.reactions, reactionEvents: (v.reactionEvents || []).slice(-300), tags: v.tags, summary: v.summary, chapters: v.chapters, tasks: v.tasks,
    segments: v.segments, words: undefined, guide: v.guide, cta: v.cta, overlays: v.overlays, captionStyle: v.captionStyle, background: v.background, autoZoom: v.autoZoom,
    redactionCount: (v.redactions || []).length, allowDownload: p.allowDownload, width: v.width, height: v.height, hasGif: fs.existsSync(path.join(store.videoDir(v.id), 'preview.gif')),
  };
  if (owner) Object.assign(m, {
    crew: v.crew, plan: v.plan, redactions: v.redactions, privacy: { mode: p.mode, expiresAt: p.expiresAt, allowDownload: v.privacy?.allowDownload !== false, hasPassword: !!v.privacy?.passwordHash },
    folder: v.folder, spaces: v.spaces, watchLater: v.watchLater, progress: v.progress, viewers: v.viewers, heat: v.heat, activity: (v.activity || []).slice(0, 60), words: v.words ? true : false,
    track: !!v.hasTrack, edits: v.edits, variables: v.variables,
  });
  return m;
}

function startServer({ port }) {
  const app = express();
  let server;
  app.use(express.json({ limit: '4mb' }));
  app.disable('x-powered-by');
  app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });

  const settings = () => store.getSettings();
  const page = (file) => (_q, res) => res.sendFile(path.join(pub, file));
  app.use('/static', express.static(pub));
  app.get('/', requireOwner, page('library.html'));
  app.get('/settings', requireOwner, page('library.html'));

  // ---- pages with link previews (Open Graph / oEmbed) ----
  const origin = (req) => `${req.protocol}://${req.headers.host}`;
  const withMeta = (file) => (req, res) => {
    const v = store.get(req.params.id); let html = fs.readFileSync(path.join(pub, file), 'utf8');
    const ok = v && access(req, v) === 'ok';
    const o = origin(req), title = ok ? v.title : 'Spool video', desc = ok ? (v.summary || 'Watch this recording') : 'Protected video';
    const meta = `<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="video.other">` +
      (ok ? `<meta property="og:image" content="${o}/media/${v.id}/thumb.jpg"><meta name="twitter:card" content="player"><meta property="og:video" content="${o}/media/${v.id}/video.mp4">` +
        `<link rel="alternate" type="application/json+oembed" href="${o}/oembed?url=${encodeURIComponent(`${o}/v/${v.id}`)}">` : '');
    res.type('html').send(html.replace('<!--OG-->', meta));
  };
  app.get('/v/:id', withMeta('watch.html'));
  app.get('/embed/:id', withMeta('embed.html'));
  app.get('/space/:id', page('space.html'));
  app.get('/oembed', (req, res) => {
    const id = /\/v\/(\w+)/.exec(req.query.url || '')?.[1]; const v = id && store.get(id);
    if (!v || access(req, v) !== 'ok') return res.sendStatus(404);
    const o = origin(req);
    res.json({ version: '1.0', type: 'video', provider_name: 'Spool', title: v.title, width: 640, height: 360, thumbnail_url: `${o}/media/${v.id}/thumb.jpg`,
      html: `<iframe src="${o}/embed/${v.id}" width="640" height="360" frameborder="0" allowfullscreen></iframe>` });
  });

  // ---- identity / branding ----
  app.get('/api/me', (req, res) => { const s = settings(); res.json({ owner: isOwner(req), name: isOwner(req) ? s.ownerName : null, brand: s.brand, lan: s.lan ? lanIp() : null, port }); });
  app.get('/branding/logo.png', (_q, res) => { const f = path.join(store.brandingDir(), 'logo.png'); fs.existsSync(f) ? res.sendFile(f) : res.sendStatus(404); });
  app.put('/api/branding/logo', requireOwner, express.raw({ type: '*/*', limit: '4mb' }), (q, res) => {
    fs.writeFileSync(path.join(store.brandingDir(), 'logo.png'), q.body); store.setSettings({ brand: { ...settings().brand, logo: true } }); res.json({ ok: true });
  });
  app.get('/view-as/:mode', requireOwner, (q, res) => { res.setHeader('Set-Cookie', `sp_asviewer=${q.params.mode === 'viewer' ? 1 : 0}; Path=/; SameSite=Lax`); res.redirect(q.query.to || '/'); });
  app.get('/stop-viewing-as', (_q, res) => { res.setHeader('Set-Cookie', 'sp_asviewer=0; Path=/; Max-Age=0'); res.redirect('/'); });

  // ---- viewer API (everything here is gated by the link's privacy settings) ----
  const gated = (req, res, next) => {
    const v = store.get(req.params.id); if (!v) return res.status(404).json({ error: 'not found' });
    const a = access(req, v);
    if (a !== 'ok') return res.status(a === 'private' || a === 'expired' ? 403 : 401).json({ gate: a, title: a === 'password' || a === 'email' ? v.title : undefined });
    req.video = v; req.owner = isOwner(req); next();
  };
  app.get('/api/v/:id', gated, (q, res) => res.json(viewModel(q.video, q.owner)));
  app.post('/api/v/:id/unlock', (q, res) => {
    const v = store.get(q.params.id); if (!v) return res.sendStatus(404);
    const p = effectivePrivacy(v);
    if (p.mode === 'password') {
      if (!checkPw(q.body.password, p.passwordHash)) { store.log(v.id, 'Wrong password attempt', q.body.name || ''); return res.status(401).json({ error: 'Wrong password' }); }
    } else if (p.mode === 'email') {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q.body.email || '')) return res.status(400).json({ error: 'Enter a valid email' });
    } else return res.json({ ok: true });
    res.setHeader('Set-Cookie', unlockCookie(v));
    store.log(v.id, p.mode === 'email' ? `Unlocked with ${q.body.email}` : 'Unlocked with password', q.body.name || q.body.email || '');
    res.json({ ok: true });
  });
  const who = (q) => ({ name: String(q.body.name || (q.owner ? settings().ownerName : 'Guest')).slice(0, 40), email: String(q.body.email || '').slice(0, 80) });

  app.post('/api/v/:id/view', gated, (q, res) => {
    const sid = store.newId(5), w = who(q);
    store.update(q.video.id, (v) => ({ views: v.views + 1, viewers: [...v.viewers, { sid, ...w, owner: q.owner, at: Date.now(), maxT: 0, watched: 0, last: Date.now() }].slice(-500) }));
    store.log(q.video.id, 'Viewed', w.name); res.json({ sid });
  });
  app.post('/api/v/:id/heartbeat', gated, (q, res) => {
    const { sid, t } = q.body; const now = Date.now();
    store.update(q.video.id, (v) => {
      const viewers = v.viewers.map((x) => (x.sid === sid ? { ...x, maxT: Math.max(x.maxT, +t || 0), watched: x.watched + Math.min(3, (now - x.last) / 1000), last: now } : x));
      const heat = v.heat.slice(); const i = Math.floor(+t || 0); if (i >= 0 && i < Math.ceil(v.duration || 1) + 1) { while (heat.length <= i) heat.push(0); heat[i]++; }
      const patch = { viewers, heat };
      if (q.owner) { patch.progress = +t || 0; patch.lastWatchedAt = now; }
      return patch;
    });
    res.sendStatus(204);
  });
  const snippet = (v, at) => (v.segments || []).find((s) => s.start <= at && s.end >= at - 0.5)?.text || (v.segments || []).reduce((b, s) => (Math.abs(s.start - at) < Math.abs((b?.start ?? 1e9) - at) ? s : b), null)?.text || '';
  app.post('/api/v/:id/comments', gated, (q, res) => {
    const text = String(q.body.text || '').slice(0, 1000).trim(); if (!text) return res.sendStatus(400);
    const w = who(q), at = +q.body.at || 0;
    const c = { id: store.newId(4), author: w.name, text, at, createdAt: Date.now(), mentions: [...text.matchAll(/@(\w+)/g)].map((m) => m[1]) };
    const v = store.update(q.video.id, (x) => ({ comments: [...x.comments, c] }));
    if (!q.owner) store.notify({ type: 'comment', videoId: v.id, title: v.title, by: w.name, text, t: at, snippet: snippet(v, at) });
    c.mentions.forEach((m) => store.notify({ type: 'mention', videoId: v.id, title: v.title, by: w.name, to: m, text, t: at, snippet: snippet(v, at) }));
    store.log(v.id, 'Commented', w.name); res.json(viewModel(v, q.owner));
  });
  app.post('/api/v/:id/reactions', gated, (q, res) => {
    const e = String(q.body.emoji || '').slice(0, 8), sup = !!q.body.super, w = who(q);
    const v = store.update(q.video.id, (x) => ({ reactions: { ...x.reactions, [e]: (x.reactions[e] || 0) + (sup ? 3 : 1) }, reactionEvents: [...x.reactionEvents, { emoji: e, at: +q.body.at || 0, by: w.name, super: sup }].slice(-500) }));
    if (!q.owner) store.notify({ type: 'reaction', videoId: v.id, title: v.title, by: w.name, text: `${sup ? 'super-reacted' : 'reacted'} ${e}`, t: +q.body.at || 0, snippet: snippet(v, +q.body.at || 0) });
    res.json(viewModel(v, q.owner));
  });

  // ---- captions: original, or translated on demand with the local model ----
  app.get('/api/v/:id/captions.vtt', gated, async (q, res) => {
    const v = q.video, lang = String(q.query.lang || '').slice(0, 30); let segs = v.segments || [];
    try { if (lang && lang !== 'original') segs = await extras.translateSegments(v, lang); } catch (e) { return res.status(502).send('Translation failed: ' + e.message); }
    const t = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = (s % 60).toFixed(3).padStart(6, '0'); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${x}`; };
    res.type('text/vtt').send('WEBVTT\n\n' + segs.map((s, i) => `${i + 1}\n${t(s.start)} --> ${t(Math.max(s.end, s.start + 1))}\n${s.text}\n`).join('\n'));
  });

  app.get('/api/v/:id/captions.json', gated, async (q, res) => {
    const lang = String(q.query.lang || '').slice(0, 30);
    try { res.json(lang && lang !== 'original' ? await extras.translateSegments(q.video, lang) : q.video.segments || []); } catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.get('/api/v/:id/track', gated, (q, res) => {
    const f = path.join(store.videoDir(q.video.id), 'track.json'); fs.existsSync(f) ? res.type('json').send(fs.readFileSync(f)) : res.json({ cursor: [], clicks: [] });
  });

  // ---- media ----
  const mediaFile = (v, name) => {
    const d = store.videoDir(v.id);
    if (name === 'thumb.jpg') return fs.existsSync(path.join(d, 'thumb-custom.jpg')) ? 'thumb-custom.jpg' : 'thumb.jpg';
    return { 'video.mp4': 'video.mp4', 'preview.gif': 'preview.gif', 'image.png': 'image.png' }[name];
  };
  app.get('/media/:id/download', gated, (q, res) => {
    const v = q.video, d = store.videoDir(v.id);
    if (!q.owner && !effectivePrivacy(v).allowDownload) return res.status(403).send('Downloads are disabled for this video');
    const f = v.type === 'image' ? 'image.png' : 'video.mp4';
    store.log(v.id, 'Downloaded', q.owner ? 'owner' : 'viewer');
    res.download(path.join(d, f), `${(v.title || 'recording').replace(/[^\w -]/g, '')}${v.type === 'image' ? '.png' : '.mp4'}`);
  });
  app.get('/media/:id/guide/:file', gated, (q, res) => {
    if (!/^step\d+\.jpg$/.test(q.params.file)) return res.sendStatus(404);
    res.sendFile(path.join(store.videoDir(q.video.id), 'guide', q.params.file), (err) => { if (err && !res.headersSent) res.sendStatus(404); });
  });
  app.get('/media/:id/:file', (q, res) => {
    const v = store.get(q.params.id); if (!v) return res.sendStatus(404);
    if (access(q, v) !== 'ok') return res.sendStatus(403); // viewers need the unlock cookie, thumbnails included
    const f = mediaFile(v, q.params.file); if (!f) return res.sendStatus(404);
    res.sendFile(path.join(store.videoDir(v.id), f), (err) => { if (err && !res.headersSent) res.sendStatus(404); }); // sendFile handles HTTP ranges
  });

  // ---- owner API ----
  const own = requireOwner;
  app.get('/api/videos', own, (_q, res) => res.json(store.list().map((v) => ({ ...viewModel(v, true), transcript: v.transcript ? v.transcript.slice(0, 4000) : '' }))));
  app.patch('/api/videos/:id', own, (q, res) => {
    const v = store.get(q.params.id); if (!v) return res.sendStatus(404);
    const b = q.body, patch = {};
    if (typeof b.title === 'string') { patch.title = b.title.slice(0, 200); patch.titleAuto = false; }
    if ('folder' in b) patch.folder = b.folder || null;
    if (Array.isArray(b.tags)) patch.tags = b.tags.map((t) => String(t).trim().toLowerCase().slice(0, 30)).filter(Boolean).slice(0, 12);
    if (Array.isArray(b.spaces)) patch.spaces = b.spaces.map(String);
    if ('watchLater' in b) patch.watchLater = !!b.watchLater;
    if ('cta' in b) patch.cta = b.cta && b.cta.url ? { text: String(b.cta.text || 'Learn more').slice(0, 40), url: String(b.cta.url).slice(0, 500) } : null;
    if (Array.isArray(b.overlays)) patch.overlays = b.overlays.slice(0, 80);
    for (const k of ['captionStyle', 'background', 'autoZoom', 'variables']) if (k in b) patch[k] = b[k];
    if (b.privacy) {
      const p = { ...(v.privacy || {}) }; const x = b.privacy;
      if (x.mode) p.mode = ['link', 'password', 'email', 'private'].includes(x.mode) ? x.mode : 'link';
      if (x.password) p.passwordHash = hashPw(String(x.password));
      if ('expiresAt' in x) p.expiresAt = +x.expiresAt || 0;
      if ('allowDownload' in x) p.allowDownload = !!x.allowDownload;
      if (p.mode === 'password' && !p.passwordHash) return res.status(400).json({ error: 'Set a password first' });
      patch.privacy = p; store.log(v.id, `Privacy changed to ${p.mode}`, 'owner');
    }
    res.json(viewModel(store.update(v.id, patch), true));
  });
  app.delete('/api/videos/:id', own, (q, res) => { store.remove(q.params.id); res.sendStatus(204); });
  app.post('/api/videos/:id/rerun', own, (q, res) => {
    const v = store.get(q.params.id);
    if (!v || !fs.existsSync(path.join(store.videoDir(v.id), 'video.mp4'))) return res.sendStatus(404);
    res.sendStatus(202); rerunAI(v.id);
  });
  app.get('/api/videos/:id/viewers.csv', own, (q, res) => {
    const v = store.get(q.params.id); if (!v) return res.sendStatus(404);
    const rows = [['name', 'email', 'when', 'watched_seconds', 'furthest_point_seconds', 'percent_of_video'], ...v.viewers.map((x) => [x.name, x.email, new Date(x.at).toISOString(), x.watched.toFixed(0), x.maxT.toFixed(0), v.duration ? Math.min(100, Math.round((x.maxT / v.duration) * 100)) : 0])];
    res.type('text/csv').attachment(`${v.title.replace(/[^\w -]/g, '')}-viewers.csv`).send(rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'));
  });

  // settings (secrets in integrations are write-only from the UI's point of view)
  app.get('/api/settings', own, (_q, res) => {
    const s = settings(), ints = {}; for (const [k, v] of Object.entries(s.integrations || {})) ints[k] = Object.fromEntries(Object.entries(v).map(([a, b]) => [a, /token|key|hook|secret/i.test(a) && b ? '••••' + String(b).slice(-4) : b]));
    const { secret, ...rest } = s; res.json({ ...rest, integrations: ints, lanIp: lanIp(), port, storage: extras.storageUsed() });
  });
  app.put('/api/settings', own, (q, res) => {
    const cur = settings(), b = q.body, patch = {};
    for (const k of ['ownerName', 'defaultPrivacy', 'linkExpiryDays', 'disableDownloads', 'retentionDays', 'privacyGuard', 'model', 'follows']) if (k in b) patch[k] = b[k];
    if (b.brand) patch.brand = { ...cur.brand, ...b.brand };
    if (b.integrations) { const m = { ...cur.integrations }; for (const [k, v] of Object.entries(b.integrations)) m[k] = { ...(m[k] || {}), ...Object.fromEntries(Object.entries(v).filter(([, x]) => !/^••••/.test(String(x)))) }; patch.integrations = m; }
    const lanChanged = 'lan' in b && !!b.lan !== !!cur.lan; if ('lan' in b) patch.lan = !!b.lan;
    store.setSettings(patch); if (patch.model) require('../agents/llm').setModel(patch.model);
    res.json({ ok: true, lanIp: lanIp() });
    if (lanChanged) setTimeout(listen, 150);
  });

  extras.mount(app, { own, gated, viewModel, processVideo, lanIp, port });

  function listen() {
    const host = settings().lan ? '0.0.0.0' : '127.0.0.1';
    const go = () => { server = app.listen(port, host); server.on('error', (e) => console.error('server', e.message)); };
    if (server) server.close(go); else go();
  }
  listen();
  extras.startMaintenance();
  return { app };
}

module.exports = { startServer, processVideo };
