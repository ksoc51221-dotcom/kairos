// Recordings live in IndexedDB on this device only. The offscreen recorder, the library page and the service worker share it (same origin).
//   recordings: one finished video per row {id, title, mode, createdAt, durationMs, size, mime, ext, blob, thumb}
//   chunks:     1-second pieces written while recording, so a crash or a closed browser loses seconds, not the whole video
(function (root) {
  const NAME = 'kairos-extension', VERSION = 1;
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['recId', 'seq'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbp = null; reject(req.error); };
  }));
  const wrap = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const done = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  const store = async (name, mode = 'readonly') => { const db = await open(); const tx = db.transaction(name, mode); return { tx, os: tx.objectStore(name) }; };

  async function putRecording(rec) { const { tx, os } = await store('recordings', 'readwrite'); os.put(rec); return done(tx); }
  async function getRecording(id) { const { os } = await store('recordings'); return wrap(os.get(id)); }
  async function listRecordings() { const { os } = await store('recordings'); const all = await wrap(os.getAll()); return all.sort((a, b) => b.createdAt - a.createdAt); }
  async function deleteRecording(id) { const { tx, os } = await store('recordings', 'readwrite'); os.delete(id); return done(tx); }

  async function putChunk(recId, seq, blob, meta) { const { tx, os } = await store('chunks', 'readwrite'); os.put({ recId, seq, blob, meta: meta || null }); return done(tx); }
  async function getChunks(recId) {
    const { os } = await store('chunks');
    return wrap(os.getAll(IDBKeyRange.bound([recId, 0], [recId, Number.MAX_SAFE_INTEGER])));
  }
  async function deleteChunks(recId) {
    const { tx, os } = await store('chunks', 'readwrite');
    os.delete(IDBKeyRange.bound([recId, 0], [recId, Number.MAX_SAFE_INTEGER]));
    return done(tx);
  }
  // recording ids that have chunks but no finished video: the browser or the recorder died mid-recording
  async function orphanedRecordingIds() {
    const { os } = await store('chunks');
    const keys = await wrap(os.getAllKeys());
    return [...new Set(keys.map((k) => k[0]))];
  }

  root.KairosDB = { putRecording, getRecording, listRecordings, deleteRecording, putChunk, getChunks, deleteChunks, orphanedRecordingIds };
})(typeof self !== 'undefined' ? self : this);
