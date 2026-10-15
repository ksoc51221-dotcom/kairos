// Video files, thumbnails and step screenshots. Viewers need the unlock cookie for everything here, thumbnails included.
const path = require('path');
const store = require('../../store');
const { gated, effectivePrivacy, access, GATE_STATUS } = require('../auth');

function mount(app) {
  const mediaFile = (v, name) => {
    const d = store.videoDir(v.id);
    if (name === 'thumb.jpg') return require('fs').existsSync(path.join(d, 'thumb-custom.jpg')) ? 'thumb-custom.jpg' : 'thumb.jpg';
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
    const a = access(q, v);
    if (a !== 'ok') return res.sendStatus(GATE_STATUS[a] || 403); // viewers need the unlock cookie, thumbnails included; 423 = the Privacy Guard has not cleared this video yet
    const f = mediaFile(v, q.params.file); if (!f) return res.sendStatus(404);
    res.sendFile(path.join(store.videoDir(v.id), f), (err) => { if (err && !res.headersSent) res.sendStatus(404); }); // sendFile handles HTTP ranges
  });
}

module.exports = { mount };
