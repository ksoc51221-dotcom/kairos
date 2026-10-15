// Workspace settings. Secrets in integrations are write-only from the UI's point of view.
const store = require('../../store');
const { requireOwner: own } = require('../auth');
const extras = require('../extras');
const { lanIp } = require('../util');

function mount(app, ctx) {
  const settings = () => store.getSettings();
  app.get('/api/settings', own, (_q, res) => {
    const s = settings(), ints = {}; for (const [k, v] of Object.entries(s.integrations || {})) ints[k] = Object.fromEntries(Object.entries(v).map(([a, b]) => [a, /token|key|hook|secret/i.test(a) && b ? '••••' + String(b).slice(-4) : b]));
    const { secret, ...rest } = s; res.json({ ...rest, integrations: ints, lanIp: lanIp(), port: ctx.port, storage: extras.storageUsed() });
  });
  app.put('/api/settings', own, (q, res) => {
    const cur = settings(), b = q.body, patch = {};
    for (const k of ['ownerName', 'defaultPrivacy', 'linkExpiryDays', 'disableDownloads', 'retentionDays', 'privacyGuard', 'model', 'follows']) if (k in b) patch[k] = b[k];
    if (b.brand) patch.brand = { ...cur.brand, ...b.brand };
    if (b.integrations) { const m = { ...cur.integrations }; for (const [k, v] of Object.entries(b.integrations)) m[k] = { ...(m[k] || {}), ...Object.fromEntries(Object.entries(v).filter(([, x]) => !/^••••/.test(String(x)))) }; patch.integrations = m; }
    const lanChanged = 'lan' in b && !!b.lan !== !!cur.lan; if ('lan' in b) patch.lan = !!b.lan;
    store.setSettings(patch); if (patch.model) require('../../agents/llm').setModel(patch.model);
    res.json({ ok: true, lanIp: lanIp() });
    if (lanChanged) ctx.relisten();
  });
}

module.exports = { mount };
