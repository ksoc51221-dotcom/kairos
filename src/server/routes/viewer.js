// What a viewer (or the owner watching) can do: watch pages with link previews, comments, reactions, captions, analytics, unlock.
const path = require('path');
const fs = require('fs');
const store = require('../../store');
const { isOwner, fromOwnerMachine, requireOwner, gated, checkPwAsync, effectivePrivacy, access, unlockCookie, GATE_STATUS } = require('../auth');
const security = require('../security');
const extras = require('../extras');
const { viewModel } = require('../viewmodel');
const { pub, page, esc, lanIp } = require('../util');

function mount(app, ctx) {
  const settings = () => store.getSettings();
  const limit = security.rateLimit({ skip: isOwner }); // B22
  const lock = security.lockout(); // R10

  // ---- pages with link previews (Open Graph / oEmbed) ----
  const origin = (req) => `${req.protocol}://${req.headers.host}`;
  const withMeta = (file) => (req, res) => {
    const v = store.get(req.params.id); const html = fs.readFileSync(path.join(pub, file), 'utf8');
    const ok = v && access(req, v) === 'ok';
    const o = origin(req), title = ok ? v.title : 'Iris video', desc = ok ? (v.summary || 'Watch this recording') : 'Protected video';
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
    res.json({ version: '1.0', type: 'video', provider_name: 'Iris', title: v.title, width: 640, height: 360, thumbnail_url: `${o}/media/${v.id}/thumb.jpg`,
      html: `<iframe src="${o}/embed/${v.id}" width="640" height="360" frameborder="0" allowfullscreen></iframe>` });
  });

  // ---- identity / branding ----
  // `csrf` is only handed to the owner's own pages; other origins cannot read this response (no CORS headers), so they never see it.
  app.get('/api/me', (req, res) => { const s = settings(), own = isOwner(req); res.json({ owner: own, name: own ? s.ownerName : null, brand: s.brand, lan: s.lan ? lanIp() : null, port: ctx.port, csrf: own ? security.TOKEN : undefined }); });
  app.get('/branding/logo.png', (_q, res) => { const f = path.join(store.brandingDir(), 'logo.png'); fs.existsSync(f) ? res.sendFile(f) : res.sendStatus(404); });
  // R1: the app opens this link for the owner (a one-time code, valid for 2 minutes). It sets the owner cookie; without it a loopback request is just a viewer.
  app.get('/owner-login', security.guardSameOrigin, (q, res) => {
    if (!fromOwnerMachine(q)) return res.sendStatus(403);
    if (!security.redeemLoginCode(q.query.code)) return res.status(403).type('html').send('<!doctype html><meta charset="utf-8"><title>Iris</title><body style="font:16px system-ui;padding:3rem"><h2>This sign-in link has expired</h2><p>Open Iris from the menu bar (Open library) to get a new one.</p>');
    res.setHeader('Set-Cookie', [security.ownerCookie(q.headers.host), 'sp_asviewer=0; Path=/; Max-Age=0']);
    res.redirect(security.safeNext(q.query.to));
  });
  // these two flip a cookie on a GET, so they get the same-origin check too
  app.get('/view-as/:mode', requireOwner, security.guardSameOrigin, (q, res) => { res.setHeader('Set-Cookie', `sp_asviewer=${q.params.mode === 'viewer' ? 1 : 0}; Path=/; SameSite=Lax`); res.redirect(q.query.to || '/'); });
  app.get('/stop-viewing-as', security.guardSameOrigin, (_q, res) => { res.setHeader('Set-Cookie', 'sp_asviewer=0; Path=/; Max-Age=0'); res.redirect('/'); });

  // ---- viewer API (everything here is gated by the link's privacy settings) ----
  app.get('/api/v/:id', gated, (q, res) => res.json(viewModel(q.video, q.owner)));
  app.post('/api/v/:id/unlock', limit, async (q, res) => {
    const v = store.get(q.params.id); if (!v) return res.sendStatus(404);
    const p = effectivePrivacy(v), key = `${v.id}|${q.socket.remoteAddress}`;
    if (p.mode === 'password') {
      const w = lock.wait(key); if (w) { res.setHeader('Retry-After', String(w)); return res.status(429).json({ error: `Too many wrong passwords. Try again in ${w} s.` }); }
      if (!(await checkPwAsync(q.body.password, p.passwordHash))) { lock.fail(key); store.log(v.id, 'Wrong password attempt', q.body.name || ''); return res.status(401).json({ error: 'Wrong password' }); }
      lock.ok(key);
    } else if (p.mode === 'email') {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q.body.email || '')) return res.status(400).json({ error: 'Enter a valid email' });
    } else return res.json({ ok: true });
    res.setHeader('Set-Cookie', unlockCookie(v));
    store.log(v.id, p.mode === 'email' ? `Unlocked with ${q.body.email}` : 'Unlocked with password', q.body.name || q.body.email || '');
    res.json({ ok: true });
  });
  const who = (q) => ({ name: String(q.body.name || (q.owner ? settings().ownerName : 'Guest')).slice(0, 40), email: String(q.body.email || '').slice(0, 80) });

  app.post('/api/v/:id/view', limit, gated, (q, res) => {
    const sid = store.newId(5), w = who(q);
    store.update(q.video.id, (v) => ({ views: v.views + 1, viewers: [...v.viewers, { sid, ...w, owner: q.owner, at: Date.now(), maxT: 0, watched: 0, last: Date.now() }].slice(-500) }));
    store.log(q.video.id, 'Viewed', w.name); res.json({ sid });
  });
  app.post('/api/v/:id/heartbeat', limit, gated, (q, res) => {
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
  app.post('/api/v/:id/comments', limit, gated, (q, res) => {
    const text = String(q.body.text || '').slice(0, 1000).trim(); if (!text) return res.sendStatus(400);
    const w = who(q), at = +q.body.at || 0;
    const c = { id: store.newId(4), author: w.name, text, at, createdAt: Date.now(), mentions: [...text.matchAll(/@(\w+)/g)].map((m) => m[1]) };
    const v = store.update(q.video.id, (x) => ({ comments: [...x.comments, c] }));
    if (!q.owner) store.notify({ type: 'comment', videoId: v.id, title: v.title, by: w.name, text, t: at, snippet: snippet(v, at) });
    c.mentions.forEach((m) => store.notify({ type: 'mention', videoId: v.id, title: v.title, by: w.name, to: m, text, t: at, snippet: snippet(v, at) }));
    store.log(v.id, 'Commented', w.name); res.json(viewModel(v, q.owner));
  });
  app.post('/api/v/:id/reactions', limit, gated, (q, res) => {
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
  // U3: one Server-Sent Events stream instead of polling. A watch page subscribes to its own video; the library subscribes to everything (owner only).
  // The payload only says *what* changed; the page refetches it. Bursts (progress updates) are coalesced to one event per 200 ms.
  app.get('/api/events', (q, res) => {
    const vid = q.query.video ? String(q.query.video) : null;
    if (vid) { const v = store.get(vid); if (!v) return res.sendStatus(404); const a = access(q, v); if (a !== 'ok') return res.sendStatus(GATE_STATUS[a] || 403); }
    else if (!isOwner(q)) return res.sendStatus(403);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders(); res.write('retry: 2000\n\n');
    let pending = null;
    const flush = () => { const ids = [...pending]; pending = null; res.write(`event: video\ndata: ${JSON.stringify({ ids })}\n\n`); };
    const onVideo = (id) => { if (vid && id !== vid) return; if (!pending) { pending = new Set(); setTimeout(flush, 200); } pending.add(id); };
    const onSettings = () => res.write('event: settings\ndata: {}\n\n');
    store.events.on('video', onVideo); if (!vid) store.events.on('settings', onSettings);
    const beat = setInterval(() => res.write(': ping\n\n'), 20000);
    q.on('close', () => { clearInterval(beat); store.events.off('video', onVideo); store.events.off('settings', onSettings); });
  });

  // Cursor + clicks for the player. Recordings made by the v2 recorder keep them in timeline.json; older ones have track.json.
  app.get('/api/v/:id/track', gated, (q, res) => {
    const dir = store.videoDir(q.video.id);
    const tl = path.join(dir, 'timeline.json'), old = path.join(dir, 'track.json');
    try {
      if (fs.existsSync(tl)) { const t = JSON.parse(fs.readFileSync(tl, 'utf8')); return res.json({ cursor: t.mode === 'cam' ? [] : t.cursor || [], clicks: t.mode === 'cam' ? [] : (t.clicks || []).map(([at, x, y, button]) => ({ t: at, x, y, button })), size: t.screen ? [t.screen.width, t.screen.height] : undefined, crop: t.crop || null, windowSource: t.bubbleSpace === 'frame' }); }
      if (fs.existsSync(old)) return res.type('json').send(fs.readFileSync(old));
    } catch (e) { return res.status(500).json({ error: e.message }); }
    res.json({ cursor: [], clicks: [] });
  });
}

module.exports = { mount };
