const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../src/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spool-store-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log: () => {} };
const readDb = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));

test.afterEach(() => store.close());

test('fresh folder starts empty and videos can be created, read, updated and removed', () => {
  const dir = tmp(); store.init(dir, quiet);
  assert.deepEqual(store.list(), []);
  const v = store.create({ title: 'A' });
  assert.ok(fs.existsSync(store.videoDir(v.id)), 'video folder exists');
  assert.equal(store.get(v.id).title, 'A');
  store.update(v.id, { title: 'B' }); assert.equal(store.get(v.id).title, 'B');
  store.update(v.id, (x) => ({ views: x.views + 1 })); assert.equal(store.get(v.id).views, 1);
  assert.equal(store.update('nope', { title: 'x' }), null);
  store.remove(v.id); assert.equal(store.get(v.id), null); assert.ok(!fs.existsSync(store.videoDir(v.id)));
});

test('B2: reads come from memory and writes are debounced, then flushed', async () => {
  const dir = tmp(); store.init(dir, quiet);
  const v = store.create({ title: 'A' });
  assert.ok(!fs.existsSync(path.join(dir, 'db.json')), 'nothing written synchronously');
  await wait(store.SAVE_DELAY_MS + 150);
  assert.equal(readDb(dir).videos[v.id].title, 'A', 'written after the debounce window');
  store.update(v.id, { title: 'B' }); store.flush();
  assert.equal(readDb(dir).videos[v.id].title, 'B', 'flush() writes immediately');
});

test('B2: 100 mutations in a burst cost one disk write', async () => {
  const dir = tmp(); store.init(dir, quiet);
  const v = store.create({ title: 'A' }); store.flush();
  let renames = 0; const real = fs.renameSync; fs.renameSync = (...a) => { renames++; return real(...a); };
  try {
    for (let i = 0; i < 100; i++) store.update(v.id, { views: i });
    await wait(store.SAVE_DELAY_MS + 150);
  } finally { fs.renameSync = real; }
  assert.equal(renames, 1);
  assert.equal(readDb(dir).videos[v.id].views, 99);
});

test('B1: a save leaves no temp file and the file parses', () => {
  const dir = tmp(); store.init(dir, quiet); store.create({ title: 'A' }); store.flush();
  assert.ok(!fs.existsSync(path.join(dir, 'db.json.tmp')));
  assert.doesNotThrow(() => readDb(dir));
});

test('B1: db.json.bak holds the previous good copy', () => {
  const dir = tmp(); store.init(dir, quiet);
  const a = store.create({ title: 'A' }); store.flush();
  store.create({ title: 'B' }); store.flush();
  const bak = JSON.parse(fs.readFileSync(path.join(dir, 'db.json.bak'), 'utf8'));
  assert.deepEqual(Object.keys(bak.videos), [a.id], 'backup is one save behind');
  assert.equal(Object.keys(readDb(dir).videos).length, 2);
});

test('B1: a corrupt db.json recovers from the backup instead of becoming an empty library', async () => {
  const dir = tmp(); store.init(dir, quiet);
  const a = store.create({ title: 'A' }); store.flush();
  const b = store.create({ title: 'B' }); store.flush(); // db.json has A+B, .bak has A
  store.close();
  fs.writeFileSync(path.join(dir, 'db.json'), '{"videos":{"x":'); // torn write
  let said = ''; store.init(dir, { log: (...m) => { said += m.join(' ') + '\n'; } });
  assert.match(said, /RECOVERED/);
  assert.ok(store.get(a.id), 'the library is not empty after recovery');
  assert.equal(store.get(b.id), null, 'recovery returns the last good copy (one save behind)');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('db.json.corrupt-')), 'the unreadable file is kept for inspection');
  await wait(store.SAVE_DELAY_MS + 150); // the fresh db.json gets written
  assert.ok(readDb(dir).videos[a.id]);
  const bak = JSON.parse(fs.readFileSync(path.join(dir, 'db.json.bak'), 'utf8'));
  assert.ok(bak.videos[a.id], 'the good backup was not overwritten by the recovery');
});

test('B1: a missing db.json with a good backup recovers too', () => {
  const dir = tmp(); store.init(dir, quiet);
  const a = store.create({ title: 'A' }); store.flush(); store.create({ title: 'B' }); store.flush(); store.close();
  fs.rmSync(path.join(dir, 'db.json'));
  store.init(dir, quiet); assert.ok(store.get(a.id));
});

test('B1: a corrupt db.json and no backup refuses to start and changes nothing', () => {
  const dir = tmp(); fs.mkdirSync(dir, { recursive: true });
  const junk = '{"videos": {"a": {"title"';
  fs.writeFileSync(path.join(dir, 'db.json'), junk);
  assert.throws(() => store.init(dir, quiet), (e) => e instanceof store.StoreCorruptError && e.files.length === 1);
  assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), junk, 'file untouched');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('db.json')), ['db.json'], 'no stray files either');
});

test('B1: corrupt db.json AND corrupt backup refuses to start', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'db.json'), 'garbage'); fs.writeFileSync(path.join(dir, 'db.json.bak'), '[1,2]');
  assert.throws(() => store.init(dir, quiet), store.StoreCorruptError);
});

test('B1: valid JSON that is not an object counts as corrupt', () => {
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'db.json'), '[]');
  assert.throws(() => store.init(dir, quiet), store.StoreCorruptError);
});

test('B1: a temp file left by a crash mid-write is ignored and cleaned up', () => {
  const dir = tmp(); store.init(dir, quiet); const a = store.create({ title: 'A' }); store.flush(); store.close();
  fs.writeFileSync(path.join(dir, 'db.json.tmp'), '{"videos":{');
  store.init(dir, quiet);
  assert.ok(store.get(a.id)); assert.ok(!fs.existsSync(path.join(dir, 'db.json.tmp')));
});

test('events: video, settings and change notifications fire', () => {
  const dir = tmp(); store.init(dir, quiet);
  const seen = []; const on = (n) => store.events.on(n, (x) => seen.push([n, x]));
  on('video'); on('settings'); on('change');
  const v = store.create({ title: 'A' }); store.update(v.id, { title: 'B' }); store.setSettings({ ownerName: 'Kien' });
  assert.ok(seen.some(([n, x]) => n === 'video' && x === v.id));
  assert.ok(seen.some(([n]) => n === 'settings'));
  assert.ok(seen.filter(([n]) => n === 'change').length >= 3);
  store.events.removeAllListeners();
});

test('records from older versions get the new fields', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ videos: { old1: { id: 'old1', title: 'Old', createdAt: 1, status: 'ready' } } }));
  store.init(dir, quiet);
  const v = store.get('old1');
  assert.deepEqual([v.comments, v.tags, v.overlays], [[], [], []]);
  assert.equal(v.type, 'video'); assert.deepEqual(store.load().folders, {});
});

test('settings merge defaults and notifications cap at 300', () => {
  const dir = tmp(); store.init(dir, quiet);
  assert.equal(store.getSettings().privacyGuard, true);
  store.setSettings({ brand: { name: 'X' } }); assert.equal(store.getSettings().brand.accent, '#047857');
  for (let i = 0; i < 320; i++) store.notify({ type: 'comment', n: i });
  assert.equal(store.load().notifications.length, 300); assert.equal(store.load().notifications[0].n, 319);
});
