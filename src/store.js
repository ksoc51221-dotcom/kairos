// JSON-file store: one folder per video under the app data dir, plus a few collections in db.json.
//
// B1  Writes are atomic: tmp file + fsync + rename, and db.json.bak keeps the last good copy. If db.json exists but cannot be read
//     the store recovers from the backup or refuses to start. It never falls back to an empty db when a file exists, because the
//     next save would then wipe the whole library.
// B2  The db is loaded once and lives in memory. Writes are debounced (250 ms) and flushed on quit. `store.events` announces
//     changes (used by the SSE stream in Phase 2).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const SAVE_DELAY_MS = 250;
const events = new EventEmitter();
events.setMaxListeners(100);

let root = null, db = null, timer = null, dirty = false, fileGood = false, say = (...a) => console.warn(...a);

class StoreCorruptError extends Error {
  constructor(message, files) { super(message); this.name = 'StoreCorruptError'; this.files = files; }
}

const dbFile = () => path.join(root, 'db.json');
const bakFile = () => dbFile() + '.bak';

const VIDEO_DEFAULTS = () => ({ type: 'video', comments: [], reactions: {}, reactionEvents: [], folder: null, tags: [], spaces: [], watchLater: false, lastWatchedAt: 0, progress: 0,
  privacy: null, cta: null, overlays: [], viewers: [], heat: [], activity: [], crew: [], stage: '' });

function normalize(raw) {
  const d = { videos: {}, folders: {}, spaces: {}, notifications: [], activity: [], settings: {}, jobs: [], ...raw };
  for (const id of Object.keys(d.videos)) d.videos[id] = { ...VIDEO_DEFAULTS(), ...d.videos[id] }; // records from older versions get new fields
  return d;
}

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'not a JSON object' };
    return { ok: true, value: v };
  } catch (e) { return { ok: false, error: e.message }; }
}

function loadFromDisk() {
  const main = dbFile(), bak = bakFile(), hasMain = fs.existsSync(main), hasBak = fs.existsSync(bak);
  if (!hasMain && !hasBak) { fileGood = false; return normalize({}); } // first run: nothing exists, so nothing can be lost
  let mainError = null;
  if (hasMain) {
    const r = readJson(main);
    if (r.ok) { fileGood = true; return normalize(r.value); }
    mainError = r.error; say(`store: db.json is unreadable (${r.error})`);
  }
  if (hasBak) {
    const r = readJson(bak);
    if (r.ok) {
      say('store: RECOVERED the library from db.json.bak' + (hasMain ? ' (the unreadable db.json was kept as db.json.corrupt-*)' : ' (db.json was missing)'));
      if (hasMain) { try { fs.renameSync(main, `${main}.corrupt-${Date.now()}`); } catch {} }
      fileGood = false; // the next save must not overwrite the good backup with anything that is not known good
      dirty = true; timer = setTimeout(flush, SAVE_DELAY_MS); // write a fresh db.json from the recovered data
      return normalize(r.value);
    }
    say(`store: db.json.bak is unreadable too (${r.error})`);
  }
  throw new StoreCorruptError(`Spool cannot read its library file${mainError ? ` (${mainError})` : ''}. Nothing was changed. Copy db.json and db.json.bak out of ${root} before doing anything else.`, [main, bak].filter(fs.existsSync));
}

function init(dir, opts = {}) {
  flush(); // anything still pending belongs to the previous folder
  if (timer) { clearTimeout(timer); timer = null; }
  dirty = false; db = null; root = dir;
  if (opts.log) say = opts.log;
  fs.mkdirSync(path.join(root, 'videos'), { recursive: true });
  fs.mkdirSync(path.join(root, 'branding'), { recursive: true });
  try { fs.rmSync(dbFile() + '.tmp', { force: true }); } catch {} // a crash mid-write can leave this behind; it is never read
  db = loadFromDisk();
}

// ---- persistence ----
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!dirty || !db || !root) return;
  try {
    const file = dbFile(), tmp = file + '.tmp', text = JSON.stringify(db, null, 2);
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fileGood && fs.existsSync(file)) { try { fs.copyFileSync(file, bakFile()); } catch (e) { say('store: could not refresh db.json.bak:', e.message); } }
    fs.renameSync(tmp, file); // atomic: readers see the old file or the new one, never half of one
    fileGood = true; dirty = false;
  } catch (e) {
    say('store: save failed, will retry:', e.message);
    timer = setTimeout(flush, 2000);
  }
}
function markDirty() { dirty = true; if (!timer) timer = setTimeout(flush, SAVE_DELAY_MS); }
function close() { flush(); if (timer) { clearTimeout(timer); timer = null; } db = null; root = null; dirty = false; }
process.on('exit', () => { try { flush(); } catch {} });

// ---- access ----
const load = () => { if (!db) throw new Error('store is not initialised'); return db; };
const save = () => { markDirty(); flush(); }; // kept for callers that want an immediate write
// run fn(db) then persist (debounced). The one place collections get changed.
function mutate(fn) { const r = fn(load()); markDirty(); events.emit('change'); return r; }

const videoDir = (id) => path.join(root, 'videos', id);
const brandingDir = () => path.join(root, 'branding');
const newId = (n = 8) => crypto.randomBytes(n).toString('hex');

function create(fields) {
  const v = mutate((d) => {
    const id = newId();
    fs.mkdirSync(videoDir(id), { recursive: true });
    d.videos[id] = { ...VIDEO_DEFAULTS(), id, title: 'Untitled recording', createdAt: Date.now(), status: 'processing', views: 0, duration: 0, ...fields };
    return d.videos[id];
  });
  events.emit('video', v.id);
  return v;
}
const get = (id) => load().videos[id] || null;
const list = () => Object.values(load().videos).sort((a, b) => b.createdAt - a.createdAt);
function update(id, patch) {
  const v = mutate((d) => { if (!d.videos[id]) return null; Object.assign(d.videos[id], typeof patch === 'function' ? patch(d.videos[id]) : patch); return d.videos[id]; });
  if (v) events.emit('video', id);
  return v;
}
function remove(id) { mutate((d) => { delete d.videos[id]; }); fs.rmSync(videoDir(id), { recursive: true, force: true }); events.emit('video', id); }

const DEFAULT_SETTINGS = {
  privacyGuard: true, ownerName: 'You', defaultPrivacy: 'link', linkExpiryDays: 0, lan: false, disableDownloads: false, retentionDays: 0,
  brand: { name: 'Spool', accent: '#3267d4', logo: false, hideBranding: false }, follows: [], integrations: {}, model: 'qwen3:8b', keepOriginal: false,
};
const getSettings = () => { const s = load().settings || {}; return { ...DEFAULT_SETTINGS, ...s, brand: { ...DEFAULT_SETTINGS.brand, ...(s.brand || {}) } }; };
const setSettings = (patch) => { const s = mutate((d) => { d.settings = { ...d.settings, ...patch }; return d.settings; }); events.emit('settings'); return s; };

function notify(n) { mutate((d) => { d.notifications.unshift({ id: newId(4), at: Date.now(), read: false, ...n }); d.notifications = d.notifications.slice(0, 300); }); }
function log(videoId, event, who = '') {
  mutate((d) => {
    const e = { at: Date.now(), event, who };
    if (videoId && d.videos[videoId]) d.videos[videoId].activity = [e, ...(d.videos[videoId].activity || [])].slice(0, 200);
    d.activity = [{ ...e, videoId }, ...d.activity].slice(0, 500);
  });
}

module.exports = { init, close, flush, load, save, mutate, create, get, list, update, remove, videoDir, brandingDir, newId, getSettings, setSettings, notify, log, events, StoreCorruptError, SAVE_DELAY_MS };
