// JSON-file store: one folder per video under the app data dir, plus a few collections in db.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let root;
function init(dir) {
  root = dir;
  fs.mkdirSync(path.join(root, 'videos'), { recursive: true });
  fs.mkdirSync(path.join(root, 'branding'), { recursive: true });
}
const dbFile = () => path.join(root, 'db.json');
const VIDEO_DEFAULTS = () => ({ type: 'video', comments: [], reactions: {}, reactionEvents: [], folder: null, tags: [], spaces: [], watchLater: false, lastWatchedAt: 0, progress: 0,
  privacy: null, cta: null, overlays: [], viewers: [], heat: [], activity: [], crew: [], stage: '' });
function load() {
  let db; try { db = JSON.parse(fs.readFileSync(dbFile(), 'utf8')); } catch { db = {}; }
  db = { videos: {}, folders: {}, spaces: {}, notifications: [], activity: [], settings: {}, ...db };
  for (const id of Object.keys(db.videos)) db.videos[id] = { ...VIDEO_DEFAULTS(), ...db.videos[id] }; // records from older versions get new fields
  return db;
}
function save(db) { fs.writeFileSync(dbFile(), JSON.stringify(db, null, 2)); }
// run fn(db) then persist — the one place collections get changed
function mutate(fn) { const db = load(); const r = fn(db); save(db); return r; }

const videoDir = (id) => path.join(root, 'videos', id);
const brandingDir = () => path.join(root, 'branding');
const newId = (n = 8) => crypto.randomBytes(n).toString('hex');

function create(fields) {
  return mutate((db) => {
    const id = newId();
    fs.mkdirSync(videoDir(id), { recursive: true });
    db.videos[id] = {
      id, type: 'video', title: 'Untitled recording', createdAt: Date.now(), status: 'processing', views: 0, duration: 0,
      comments: [], reactions: {}, reactionEvents: [], folder: null, tags: [], spaces: [], watchLater: false, lastWatchedAt: 0, progress: 0,
      privacy: null, cta: null, overlays: [], viewers: [], heat: [], activity: [], crew: [], stage: '', ...fields,
    };
    return db.videos[id];
  });
}
const get = (id) => load().videos[id] || null;
const list = () => Object.values(load().videos).sort((a, b) => b.createdAt - a.createdAt);
function update(id, patch) {
  return mutate((db) => { if (!db.videos[id]) return null; Object.assign(db.videos[id], typeof patch === 'function' ? patch(db.videos[id]) : patch); return db.videos[id]; });
}
function remove(id) { mutate((db) => { delete db.videos[id]; }); fs.rmSync(videoDir(id), { recursive: true, force: true }); }

const DEFAULT_SETTINGS = {
  privacyGuard: true, ownerName: 'You', defaultPrivacy: 'link', linkExpiryDays: 0, lan: false, disableDownloads: false, retentionDays: 0,
  brand: { name: 'Spool', accent: '#7b5cf0', logo: false, hideBranding: false }, follows: [], integrations: {}, model: 'qwen3:8b',
};
const getSettings = () => { const s = load().settings || {}; return { ...DEFAULT_SETTINGS, ...s, brand: { ...DEFAULT_SETTINGS.brand, ...(s.brand || {}) } }; };
const setSettings = (patch) => mutate((db) => { db.settings = { ...db.settings, ...patch }; return db.settings; });

function notify(n) { mutate((db) => { db.notifications.unshift({ id: newId(4), at: Date.now(), read: false, ...n }); db.notifications = db.notifications.slice(0, 300); }); }
function log(videoId, event, who = '') {
  mutate((db) => {
    const e = { at: Date.now(), event, who };
    if (videoId && db.videos[videoId]) db.videos[videoId].activity = [e, ...(db.videos[videoId].activity || [])].slice(0, 200);
    db.activity = [{ ...e, videoId }, ...db.activity].slice(0, 500);
  });
}

module.exports = { init, load, save, mutate, create, get, list, update, remove, videoDir, brandingDir, newId, getSettings, setSettings, notify, log };
