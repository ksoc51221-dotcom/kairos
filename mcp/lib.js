// Read-only access to the Spool library for the MCP server. It reads db.json from disk, so it works whether or not the Spool app is running, and it
// never writes. Content (transcript, guide, plan) is only returned for videos the Privacy Guard has cleared: the same rule viewers live by.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildActionPlan } = require('../src/agents/action-plan');

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Where the app keeps its library. SPOOL_DATA overrides (the same variable the app honours); otherwise the platform default for an app named Spool.
function dataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.SPOOL_DATA) return env.SPOOL_DATA;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Spool');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Spool');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Spool');
}
const libraryDir = (dir = dataDir()) => path.join(dir, 'library');

function readDb(lib = libraryDir()) {
  for (const f of ['db.json', 'db.json.bak']) {
    try { const j = JSON.parse(fs.readFileSync(path.join(lib, f), 'utf8')); if (j && typeof j.videos === 'object') return j; } catch {}
  }
  throw new Error(`No Spool library found at ${lib}. Open the Spool app once and record something, or set SPOOL_DATA.`);
}

const cleared = (v) => v.shareable === true && v.status === 'ready';
const row = (v) => ({ id: v.id, title: v.title, created: new Date(v.createdAt).toISOString(), duration: Math.round(v.duration || 0), type: v.type || 'video', status: v.status, cleared: cleared(v),
  tags: v.tags || [], summary: cleared(v) ? v.summary || '' : undefined, hasTranscript: !!(v.segments || []).length, hasGuide: !!v.guide });

function listVideos(lib, { limit = 20 } = {}) {
  return Object.values(readDb(lib).videos).sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(1, Math.min(200, limit))).map(row);
}

function need(lib, id) {
  const v = readDb(lib).videos[id]; if (!v) throw new Error(`No video with id ${id}. Use list_videos to see ids.`);
  if (!cleared(v)) throw new Error(v.shareable === true ? `Video ${id} is not ready yet (status: ${v.status}).` : `Video ${id} has not been cleared by the Privacy Guard, so its content is not available. Open it in Spool and wait for the check to finish.`);
  return v;
}

function searchVideos(lib, query, { limit = 10 } = {}) {
  const q = String(query || '').toLowerCase().trim(); if (!q) throw new Error('query is empty');
  const out = [];
  for (const v of Object.values(readDb(lib).videos).sort((a, b) => b.createdAt - a.createdAt)) {
    if (!cleared(v)) continue;
    const hits = (v.segments || []).filter((s) => s.text.toLowerCase().includes(q)).slice(0, 3).map((s) => ({ at: mmss(s.start), text: s.text }));
    const meta = [v.title, v.summary, ...(v.tags || [])].some((x) => String(x || '').toLowerCase().includes(q));
    if (hits.length || meta) out.push({ ...row(v), matches: hits });
    if (out.length >= limit) break;
  }
  return out;
}

function transcript(lib, id) {
  const v = need(lib, id);
  if (!(v.segments || []).length) throw new Error(`Video ${id} has no transcript (no speech, or the speech model was missing).`);
  return `# ${v.title}\n\n` + v.segments.map((s) => `[${mmss(s.start)}] ${s.text}`).join('\n') + '\n';
}

function guideMarkdown(lib, id, dir = libraryDir()) {
  const v = need(lib, id), g = v.guide; if (!g) throw new Error(`Video ${id} has no guide (the Planner decided it did not need one, or Ollama was not running).`);
  const vdir = path.join(dir, 'videos', id);
  return `# ${g.title}\n\n${g.intro}\n\n` + g.steps.map((s) => `## ${s.n}. ${s.title} (${mmss(s.at)})\n${s.detail}\n${s.image && fs.existsSync(path.join(vdir, 'guide', s.image)) ? `\nScreenshot: ${path.join(vdir, 'guide', s.image)}\n` : ''}`).join('\n') + `\n${g.closing}\n`;
}

function actionPlan(lib, id, dir = libraryDir()) {
  const v = need(lib, id), vdir = path.join(dir, 'videos', id); let timeline = null;
  try { timeline = JSON.parse(fs.readFileSync(path.join(vdir, 'timeline.json'), 'utf8')); } catch {}
  return buildActionPlan(v, { dir: vdir, timeline });
}

module.exports = { dataDir, libraryDir, readDb, listVideos, searchVideos, transcript, guideMarkdown, actionPlan, cleared };
