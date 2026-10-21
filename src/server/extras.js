// Library helpers: feed ranking, translation, storage size, retention sweep. The HTTP routes live in routes/library.js.
const fs = require('fs');
const path = require('path');
const store = require('../store');
const llm = require('../agents/llm');
const { reactionCounts } = require('./viewmodel');

const dirSize = (d) => { let n = 0; try { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); n += f.isDirectory() ? dirSize(p) : fs.statSync(p).size; } } catch {} return n; };
const storageUsed = () => dirSize(path.join(store.videoDir('').replace(/\/$/, '')));

const words = (v) => new Set(`${v.title} ${(v.tags || []).join(' ')} ${v.summary || ''}`.toLowerCase().match(/[a-z]{4,}/g) || []);
const jaccard = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / Math.max(1, a.size + b.size - i); };

function feed(model) {
  const all = store.list().filter((v) => v.status === 'ready'), s = store.getSettings(), week = Date.now() - 7 * 86400000;
  const card = model;
  const score = (v) => v.viewers.filter((x) => x.at > week && !x.owner).length * 2 + Object.values(reactionCounts(v.reactions)).reduce((a, b) => a + b, 0) + v.comments.length * 3;
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

// B18: two viewers asking for the same language at once share one model run.
const inflight = new Map();
function translateSegments(v, lang) {
  const key = `${v.id}:${lang.replace(/[^\w-]/g, '').toLowerCase()}`;
  if (!inflight.has(key)) inflight.set(key, translateOnce(v, lang).finally(() => inflight.delete(key)));
  return inflight.get(key);
}
async function translateOnce(v, lang) {
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

function startMaintenance() {
  const sweep = () => { const days = store.getSettings().retentionDays; if (!days) return; const cut = Date.now() - days * 86400000; store.list().forEach((v) => { if (v.createdAt < cut) { store.remove(v.id); store.log(null, `Retention policy deleted "${v.title}"`, 'system'); } }); };
  sweep(); setInterval(sweep, 3600000).unref();
}
module.exports = { feed, translateSegments, inflightCount: () => inflight.size, storageUsed, startMaintenance };
