// Owner-only API for public links (Backblaze + Cloudflare Worker, or a public GitHub repository served by Pages). Every route is owner-only; writes also need the CSRF token (requireOwner).
// Nothing here runs unless the owner clicks Publish: the pipeline never imports the publisher.
const store = require('../../store');
const { requireOwner: own } = require('../auth');
const publisher = require('../../publish/publisher');

const fail = (res, e) => {
  if (e && e.name === 'PublishError') return res.status(e.status || 409).json({ error: e.message, code: e.code });
  res.status(500).json({ error: String(e && e.message || e).slice(0, 300), code: 'unexpected' });
};

function mount(app) {
  const video = (q, res) => { const v = store.get(q.params.id); if (!v) { res.sendStatus(404); return null; } return v; };

  app.get('/api/publish/status', own, (_q, res) => res.json(publisher.status()));
  app.post('/api/publish/test', own, async (q, res) => { try { res.json(q.body?.host === 'github' ? await publisher.testGitHub() : await publisher.testConnection()); } catch (e) { fail(res, e); } });
  app.post('/api/publish/remove-all', own, async (q, res) => {
    if (q.body?.confirm !== 'REMOVE') return res.status(400).json({ error: 'Type REMOVE to confirm', code: 'confirm' });
    try { res.json(await publisher.removeAll()); } catch (e) { fail(res, e); }
  });

  app.get('/api/videos/:id/publish', own, (q, res) => { const v = video(q, res); if (v) res.json(publisher.summary(v)); });
  app.post('/api/videos/:id/publish', own, async (q, res) => {
    const v = video(q, res); if (!v) return;
    if (q.body?.confirm !== true) return res.status(400).json({ error: 'Confirm that you want this video on the public internet', code: 'confirm' });
    try { res.status(202).json(await publisher.publish(v.id, { mode: q.body.mode, password: q.body.password, host: q.body.host === 'github' ? 'github' : 'b2' })); } catch (e) { fail(res, e); }
  });
  app.delete('/api/videos/:id/publish', own, async (q, res) => {
    const v = video(q, res); if (!v) return;
    try { res.json(await publisher.unpublish(v.id)); } catch (e) { fail(res, e); }
  });
}

module.exports = { mount };
