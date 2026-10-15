// Owner-only API for the library: edit, delete, re-run the AI crew, export viewers, upload a logo.
const fs = require('fs');
const path = require('path');
const express = require('express');
const store = require('../../store');
const { requireOwner: own, hashPw } = require('../auth');
const { rerunAI } = require('../../agents/orchestrator');
const { viewModel } = require('../viewmodel');

function mount(app) {
  app.put('/api/branding/logo', own, express.raw({ type: '*/*', limit: '4mb' }), (q, res) => {
    fs.writeFileSync(path.join(store.brandingDir(), 'logo.png'), q.body); store.setSettings({ brand: { ...store.getSettings().brand, logo: true } }); res.json({ ok: true });
  });
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
    for (const k of ['captionStyle', 'background', 'autoZoom', 'cursorFx', 'variables']) if (k in b) patch[k] = b[k];
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
}

module.exports = { mount };
