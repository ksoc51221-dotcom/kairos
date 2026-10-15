// Library features: feed, folders, spaces, notifications, insights, Loomify upload, translation, retention.
const fs = require('fs');
const path = require('path');
const store = require('../store');
const llm = require('../agents/llm');
const { access } = require('./auth');

const dirSize = (d) => { let n = 0; try { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); n += f.isDirectory() ? dirSize(p) : fs.statSync(p).size; } } catch {} return n; };
const storageUsed = () => dirSize(path.join(store.videoDir('').replace(/\/$/, '')));

const words = (v) => new Set(`${v.title} ${(v.tags || []).join(' ')} ${v.summary || ''}`.toLowerCase().match(/[a-z]{4,}/g) || []);
const jaccard = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / Math.max(1, a.size + b.size - i); };

function feed(model) {
  const all = store.list().filter((v) => v.status === 'ready'), s = store.getSettings(), week = Date.now() - 7 * 86400000;
  const card = model;
  const score = (v) => v.viewers.filter((x) => x.at > week && !x.owner).length * 2 + Object.values(v.reactions).reduce((a, b) => a + b, 0) + v.comments.length * 3;
  const recent = all.filter((v) => v.lastWatchedAt).sort((a, b) => b.lastWatchedAt - a.lastWatchedAt).slice(0, 8);
  const seeds = recent.slice(0, 3).map(words);
  const rec = seeds.length ? all.filter((v) => !recent.slice(0, 3).includes(v)).map((v) => [v, Math.max(...seeds.map((w) => jaccard(words(v), w)))]).filter(([, j]) => j > 0.03).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v]) => v) : [];
  return {
    trending: all.filter((v) => score(v) > 0).sort((a, b) => score(b) - score(a)).slice(0, 8).map(card),
    recommended: rec.map(card), recent: recent.map(card),
    unfinished: all.filter((v) => v.progress > 3 && v.duration > 5 && v.progress < v.duration * 0.9).slice(0, 8).map(card),
    watchLater: all.filter((v) => v.watchLater).map(card),
    following: s.follows?.length ? all.filter((v) => (v.tags || []).some((t) => s.follows.includes(t))).slice(0, 12).map(card) : [],
    latest: all.slice(0, 8).map(card),
  };
}

async function translateSegments(v, lang) {
  const safe = lang.replace(/[^\w-]/g, '').toLowerCase(); const cache = path.join(store.videoDir(v.id), `captions_${safe}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  if (!(await llm.available())) throw new Error('Ollama is not running');
  const segs = v.segments || [], out = [];
  for (let i = 0; i < segs.length; i += 20) {
    const chunk = segs.slice(i, i + 20);
    const r = await llm.json({ system: `Translate subtitle lines into ${lang}. Keep meaning, tone and length. Return the same number of lines in the same order.`,
      user: JSON.stringify(chunk.map((s) => s.text)) + '\nReturn JSON {"lines": [...]}.', schema: { type: 'object', required: ['lines'], properties: { lines: { type: 'array', items: { type: 'string' } } } } });
    chunk.forEach((s, j) => out.push({ ...s, text: (r.lines && r.lines.length === chunk.length ? r.lines[j] : s.text) || s.text }));
  }
  fs.writeFileSync(cache, JSON.stringify(out)); return out;
}

function mount(app, { own, gated, viewModel, processVideo, lanIp }) {
  const ids = () => store.load();
  const express = require('express');

  // feed + folders + spaces
  app.get('/api/feed', own, (_q, res) => res.json(feed((v) => viewModel(v, true))));
  app.get('/api/folders', own, (_q, res) => res.json(Object.values(ids().folders)));
  app.post('/api/folders', own, (q, res) => { const f = { id: store.newId(4), name: String(q.body.name || 'New folder').slice(0, 60) }; store.mutate((db) => { db.folders[f.id] = f; }); res.json(f); });
  app.patch('/api/folders/:id', own, (q, res) => { store.mutate((db) => { if (db.folders[q.params.id]) db.folders[q.params.id].name = String(q.body.name).slice(0, 60); }); res.sendStatus(204); });
  app.delete('/api/folders/:id', own, (q, res) => { store.mutate((db) => { delete db.folders[q.params.id]; Object.values(db.videos).forEach((v) => { if (v.folder === q.params.id) v.folder = null; }); }); res.sendStatus(204); });
  app.get('/api/spaces', own, (_q, res) => res.json(Object.values(ids().spaces)));
  app.post('/api/spaces', own, (q, res) => { const s = { id: store.newId(4), name: String(q.body.name || 'New space').slice(0, 60), createdAt: Date.now() }; store.mutate((db) => { db.spaces[s.id] = s; }); res.json(s); });
  app.delete('/api/spaces/:id', own, (q, res) => { store.mutate((db) => { delete db.spaces[q.params.id]; Object.values(db.videos).forEach((v) => { v.spaces = (v.spaces || []).filter((x) => x !== q.params.id); }); }); res.sendStatus(204); });
  // a space is a shareable page listing the videos a viewer is allowed to open
  app.get('/api/space/:id', (q, res) => {
    const sp = ids().spaces[q.params.id]; if (!sp) return res.sendStatus(404);
    const vids = store.list().filter((v) => (v.spaces || []).includes(sp.id) && v.status === 'ready').map((v) => ({ id: v.id, title: v.title, duration: v.duration, views: v.views, createdAt: v.createdAt, locked: access(q, v) !== 'ok' }));
    res.json({ id: sp.id, name: sp.name, videos: vids });
  });

  // notifications
  app.get('/api/notifications', own, (_q, res) => res.json(ids().notifications));
  app.post('/api/notifications/read', own, (_q, res) => { store.mutate((db) => db.notifications.forEach((n) => (n.read = true))); res.sendStatus(204); });

  // library-level (admin) insights
  app.get('/api/insights', own, (_q, res) => {
    const vids = store.list(), day = 86400000, now = Date.now();
    const views = vids.flatMap((v) => v.viewers.filter((x) => !x.owner).map((x) => ({ ...x, vid: v.id })));
    const byDay = Array.from({ length: 14 }, (_, i) => { const d0 = new Date(now - (13 - i) * day); d0.setHours(0, 0, 0, 0); return { day: d0.toISOString().slice(5, 10), n: views.filter((x) => x.at >= d0.getTime() && x.at < d0.getTime() + day).length }; });
    const people = {}; views.forEach((x) => { const k = x.email || x.name; (people[k] = people[k] || { name: x.name, email: x.email, views: 0, watched: 0 }); people[k].views++; people[k].watched += x.watched; });
    res.json({ videos: vids.length, views: views.length, comments: vids.reduce((a, v) => a + v.comments.length, 0), reactions: vids.reduce((a, v) => a + Object.values(v.reactions).reduce((x, y) => x + y, 0), 0),
      storage: storageUsed(), byDay, people: Object.values(people).sort((a, b) => b.views - a.views).slice(0, 20),
      top: vids.map((v) => ({ id: v.id, title: v.title, views: v.viewers.filter((x) => !x.owner).length })).sort((a, b) => b.views - a.views).slice(0, 8),
      blurred: vids.reduce((a, v) => a + (v.redactions || []).length, 0), activity: ids().activity.slice(0, 40).map((a) => ({ ...a, title: store.get(a.videoId)?.title })) });
  });

  // Loomify: upload any video file (streamed straight to disk)
  app.put('/api/upload', own, (q, res) => {
    const len = +q.headers['content-length'] || 0; if (len > 4 * 1024 ** 3) return res.status(413).json({ error: 'Max 4 GB' });
    const name = String(q.query.name || 'upload.mp4').replace(/[^\w. -]/g, '_'), ext = (path.extname(name) || '.mp4').toLowerCase();
    if (!/^\.(mp4|mov|avi|webm|mkv|m4v|wmv|flv|mpg|mpeg|3gp)$/.test(ext)) return res.status(400).json({ error: 'Unsupported file type' });
    const v = store.create({ title: path.basename(name, ext).slice(0, 120), titleAuto: false, source: 'upload', stage: 'Uploading' });
    const file = path.join(store.videoDir(v.id), `upload${ext}`), out = fs.createWriteStream(file);
    q.pipe(out);
    out.on('finish', () => { fs.writeFileSync(path.join(store.videoDir(v.id), 'segments.json'), JSON.stringify({ upload: path.basename(file) })); processVideo(v.id); res.json({ id: v.id }); });
    q.on('aborted', () => { out.destroy(); store.remove(v.id); });
  });

  // data controls
  app.get('/api/export.json', own, (_q, res) => res.attachment('spool-library.json').json(store.list().map(({ viewers, heat, ...v }) => v)));
  app.delete('/api/data', own, (q, res) => { if (q.body?.confirm !== 'DELETE') return res.status(400).json({ error: 'confirm' }); store.list().forEach((v) => store.remove(v.id)); res.json({ ok: true }); });
}

function startMaintenance() {
  const sweep = () => { const days = store.getSettings().retentionDays; if (!days) return; const cut = Date.now() - days * 86400000; store.list().forEach((v) => { if (v.createdAt < cut) { store.remove(v.id); store.log(null, `Retention policy deleted "${v.title}"`, 'system'); } }); };
  sweep(); setInterval(sweep, 3600000).unref();
}
module.exports = { mount, translateSegments, storageUsed, startMaintenance };
