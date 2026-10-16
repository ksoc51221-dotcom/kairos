// Owner-only API for AI Actions (Phase 4): run an action, read the cached results, preview and send one to Slack / GitHub / Linear / Jira, and the
// Action Plan brief for coding agents.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../../store');
const { requireOwner: own } = require('../auth');
const actions = require('../../agents/actions');
const integrations = require('../../agents/integrations');
const { buildActionPlan } = require('../../agents/action-plan');
const llm = require('../../agents/llm');

const previews = new Map(); // token -> { videoId, target, req, expires }: a send only runs a request that was previewed first, once
const PREVIEW_TTL_MS = 10 * 60 * 1000;

function mount(app) {
  const video = (q, res) => { const v = store.get(q.params.id); if (!v || v.type === 'image') { res.sendStatus(404); return null; } return v; };
  // Only text made from a video the Privacy Guard cleared may leave the machine
  const cleared = (v, res) => { if (v.shareable === true) return true; res.status(409).json({ error: 'The Privacy Guard has not cleared this video yet. Wait for it before generating or sending anything.' }); return false; };

  app.get('/api/videos/:id/actions', own, (q, res) => {
    const v = video(q, res); if (!v) return;
    res.json({ actions: actions.list(v), targets: Object.entries(integrations.TARGETS).map(([id, t]) => ({ id, label: t.label, ready: !integrations.missing(id, store.getSettings().integrations?.[id]).length, needs: t.doc })), ready: v.shareable === true && !!((v.segments || []).length || v.guide) });
  });
  app.get('/api/videos/:id/actions/:action', own, (q, res) => {
    const v = video(q, res); if (!v) return;
    const c = v.actions?.[q.params.action]; if (!c) return res.sendStatus(404);
    res.json({ ...c, stale: c.key !== actions.sourceKey(v) });
  });
  app.post('/api/videos/:id/actions/:action', own, async (q, res) => {
    const v = video(q, res); if (!v || !actions.ACTIONS[q.params.action]) return v && res.sendStatus(404);
    if (!cleared(v, res)) return;
    const have = v.actions?.[q.params.action];
    if (have && have.key === actions.sourceKey(v) && !q.body?.force) return res.json({ ...have, stale: false, cached: true });
    if (!(await llm.available())) return res.status(503).json({ error: 'Ollama is not running. Start it to use AI Actions.' });
    try {
      const r = await actions.run(v, q.params.action);
      store.update(v.id, (x) => ({ actions: { ...(x.actions || {}), [r.id]: r } }));
      store.log(v.id, `Generated ${r.label}`, 'owner');
      res.json({ ...r, stale: false });
    } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });

  // Send to: step 1 builds and shows the exact request (credentials hidden); step 2 sends that request once.
  app.post('/api/videos/:id/send/preview', own, (q, res) => {
    const v = video(q, res); if (!v || !cleared(v, res)) return;
    const { target, action } = q.body || {}, c = v.actions?.[action];
    if (!integrations.TARGETS[target]) return res.status(400).json({ error: 'Pick Slack, GitHub, Linear or Jira' });
    if (!c) return res.status(409).json({ error: 'Generate this action first.' });
    try {
      const req = integrations.buildRequest(target, store.getSettings().integrations?.[target], { title: c.title, markdown: c.markdown, type: c.result?.type || (action === 'bug' ? 'bug' : 'task'), labels: c.result?.labels });
      for (const [t, p] of previews) if (p.expires < Date.now()) previews.delete(t);
      const token = crypto.randomBytes(16).toString('hex'); previews.set(token, { videoId: v.id, target, req, expires: Date.now() + PREVIEW_TTL_MS });
      res.json({ token, target, label: integrations.TARGETS[target].label, ...integrations.preview(req) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  app.post('/api/videos/:id/send', own, async (q, res) => {
    const v = video(q, res); if (!v || !cleared(v, res)) return;
    const p = previews.get(String(q.body?.token)); previews.delete(String(q.body?.token));
    if (!p || p.videoId !== v.id || p.expires < Date.now()) return res.status(409).json({ error: 'Preview it again first: nothing is sent without a fresh preview.' });
    try {
      const r = await integrations.send(p.req, { fetchImpl: (...a) => fetch(...a) });
      store.log(v.id, `Sent to ${integrations.TARGETS[p.target].label}`, 'owner');
      res.json(r);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // The brief for coding agents
  app.get('/api/videos/:id/action-plan', own, (q, res) => {
    const v = video(q, res); if (!v) return;
    if (v.shareable !== true) return res.status(409).json({ error: 'The Privacy Guard has not cleared this video yet.' });
    const dir = store.videoDir(v.id); let timeline = null;
    try { timeline = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8')); } catch {}
    const md = buildActionPlan(v, { dir, timeline });
    q.query.download ? res.attachment(`${(v.title || 'recording').replace(/[^\w -]/g, '')}-plan.md`).type('text/markdown').send(md) : res.type('text/markdown').send(md);
  });
}

module.exports = { mount, previews };
