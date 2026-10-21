// Library API: home feed, folders, spaces, notifications, workspace insights, Loomify upload, data export/delete, and the library pages.
const fs = require('fs');
const path = require('path');
const store = require('../../store');
const { requireOwner: own, previewingAsViewer, access } = require('../auth');
const { processVideo } = require('../../agents/orchestrator');
const extras = require('../extras');
const { viewModel, reactionCounts } = require('../viewmodel');
const { page } = require('../util');

// B14: while the owner previews as a viewer, "/" used to answer with a raw JSON 403 and they were stuck. Now it explains and offers the way back.
const PREVIEW_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Previewing as a viewer · Kairos</title>
<link rel="stylesheet" href="/static/app.css"></head><body><div class="gate"><h2>You're previewing as a viewer</h2><p>The library and settings are hidden while you look at Kairos the way a viewer does.</p>
<a class="btn pri" href="/stop-viewing-as">Back to owner view</a></div></body></html>`;

function mount(app, ctx = {}) {
  const ids = () => store.load();
  // "Record a video" in the library opens Kairos's launcher (an explicit click, so taking focus is expected). Only the desktop app wires this up.
  app.post('/api/launcher/open', own, (_q, res) => (ctx.openLauncher ? (ctx.openLauncher(), res.sendStatus(204)) : res.status(501).json({ error: 'Open Kairos from the menu bar to record.' })));

  // owner pages
  app.get(['/', '/settings'], (req, res, next) => (previewingAsViewer(req) ? res.type('html').send(PREVIEW_PAGE) : next()), own, page('library.html'));

  // feed + folders + spaces
  app.get('/api/feed', own, (_q, res) => res.json(extras.feed((v) => viewModel(v, true))));
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
    // R5: a viewer learns nothing about a video they cannot open: no title (written by the model from the transcript), length or view count.
    const vids = store.list().filter((v) => (v.spaces || []).includes(sp.id) && v.status === 'ready').map((v) => (access(q, v) === 'ok'
      ? { id: v.id, title: v.title, duration: v.duration, views: v.views, createdAt: v.createdAt, locked: false }
      : { id: v.id, title: 'Locked video', locked: true }));
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
    res.json({ videos: vids.length, views: views.length, comments: vids.reduce((a, v) => a + v.comments.length, 0), reactions: vids.reduce((a, v) => a + Object.values(reactionCounts(v.reactions)).reduce((x, y) => x + y, 0), 0),
      storage: extras.storageUsed(), byDay, people: Object.values(people).sort((a, b) => b.views - a.views).slice(0, 20),
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
module.exports = { mount };
