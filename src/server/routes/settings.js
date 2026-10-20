// Workspace settings. Secrets in integrations are write-only from the UI's point of view.
const store = require('../../store');
const { requireOwner: own } = require('../auth');
const extras = require('../extras');
const { lanIp } = require('../util');
const publisher = require('../../publish/publisher');

// B17: what the AI tools need and whether it is on disk. `dataDir` is set by the app (ctx.models); tests leave it unset.
let dl = { state: 'idle', percent: 0, error: '' };
function mount(app, ctx) {
  const settings = () => store.getSettings();
  app.get('/api/settings', own, (_q, res) => {
    const s = settings(), ints = {}; for (const [k, v] of Object.entries(s.integrations || {})) ints[k] = Object.fromEntries(Object.entries(v).map(([a, b]) => [a, /token|key|hook|secret/i.test(a) && b ? '••••' + String(b).slice(-4) : b]));
    const { secret, ...rest } = s; res.json({ ...rest, integrations: ints, lanIp: lanIp(), port: ctx.port, storage: extras.storageUsed() });
  });
  app.put('/api/settings', own, (q, res) => {
    const cur = settings(), b = q.body, patch = {};
    for (const k of ['ownerName', 'defaultPrivacy', 'linkExpiryDays', 'disableDownloads', 'retentionDays', 'privacyGuard', 'speechGuard', 'keepOriginal', 'model', 'follows']) if (k in b) patch[k] = b[k];
    if ('defaultPrivacy' in b && !['link', 'email', 'private'].includes(b.defaultPrivacy)) return res.status(400).json({ error: 'The default can be link, email or private. A password has to be set per video.' }); // B6
    const wu = b.integrations?.publish?.workerUrl;
    if (typeof wu === 'string' && wu.trim()) { try { publisher.parseWorkerUrl(wu); } catch (e) { return res.status(400).json({ error: e.message }); } }
    if (b.brand) patch.brand = { ...cur.brand, ...b.brand };
    if (b.integrations) { const m = { ...cur.integrations }; for (const [k, v] of Object.entries(b.integrations)) m[k] = { ...(m[k] || {}), ...Object.fromEntries(Object.entries(v).filter(([, x]) => !/^••••/.test(String(x)))) }; patch.integrations = m; }
    const lanChanged = 'lan' in b && !!b.lan !== !!cur.lan; if ('lan' in b) patch.lan = !!b.lan;
    store.setSettings(patch); if (patch.model) require('../../agents/llm').setModel(patch.model);
    res.json({ ok: true, lanIp: lanIp() });
    if (['defaultPrivacy', 'linkExpiryDays', 'disableDownloads'].some((k) => k in b)) publisher.enforceAll().catch(() => {});
    if (lanChanged) ctx.relisten();
  });

  app.get('/api/models', own, async (_q, res) => {
    const tr = require('../../agents/transcribe'), llm = require('../../agents/llm'), ocr = require('../../agents/ocr');
    const dir = ctx.models;
    res.json({
      speech: { ...(dir ? tr.modelStatus(dir) : { model: tr.MODEL, cached: false, bytes: 0 }), download: dl },
      ocr: { engine: process.platform === 'darwin' ? 'Apple Vision (compiled on first use, falls back to Tesseract)' : 'Tesseract' },
      ollama: await (async () => { const list = await llm.installed(); return { available: list.length > 0 || await llm.available(), model: llm.model, installed: list, missing: list.length > 0 && !list.includes(llm.model) }; })(),
    });
  });
  app.post('/api/models/download', own, (_q, res) => {
    if (!ctx.models) return res.status(400).json({ error: 'no model folder' });
    if (dl.state === 'running') return res.status(202).json(dl);
    dl = { state: 'running', percent: 0, error: '' };
    require('../../agents/transcribe').downloadModel(ctx.models, (p) => { dl.percent = p; store.events.emit('settings'); })
      .then(() => { dl = { state: 'done', percent: 100, error: '' }; }, (e) => { dl = { state: 'error', percent: 0, error: e.message }; })
      .finally(() => store.events.emit('settings'));
    res.status(202).json(dl);
  });
}

module.exports = { mount };

