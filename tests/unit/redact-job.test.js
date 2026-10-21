// "Bleep speech", the part that touches disk: the captions, word timings and notes lose the bleeped words, the audio is really bleeped (real ffmpeg), the old
// file is the one undo, a public link is taken down, and "Delete the unbleeped copy" really leaves nothing behind (not even in the library file's backup).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('../../src/store');
const publisher = require('../../src/publish/publisher');
const { createB2 } = require('../../src/publish/b2');
const { createFakeB2 } = require('./fake-b2');
const { ffmpeg, runFfmpeg } = require('../../src/pipeline/encode');
const { probe } = require('../../src/agents/media');
const job = require('../../src/agents/redact-job');
const { undoEdits } = require('../../src/agents/edit-job');
const { BLEEP } = require('../../src/agents/speech-guard');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-redact-'));
const SECRET = 'hunter2';
// 0.3 s to 6.8 s; "hunter2" is spoken from 2.7 s to 3.4 s
const WORDS = [['Hello', 0.3, 0.7], ['everyone', 0.8, 1.3], ['my', 1.4, 1.6], ['password', 1.7, 2.3], ['is', 2.4, 2.6], [SECRET, 2.7, 3.4], ['and', 3.6, 3.8], ['the', 3.9, 4.1], ['server', 4.2, 4.7],
  ['is', 4.8, 5.0], ['called', 5.1, 5.5], ['Atlas', 5.6, 6.1], ['thanks', 6.3, 6.8]].map(([w, s, e]) => ({ w, s, e }));
const SEGMENTS = [{ start: 0.2, end: 3.5, text: `Hello everyone my password is ${SECRET}` }, { start: 3.5, end: 6.9, text: 'and the server is called Atlas thanks' }];
const RANGE = [{ from: 2.65, to: 3.45 }];
const dump = (v) => JSON.stringify({ ...v, editPrev: undefined });

test.before(() => store.init(root, { log: () => {} }));
test.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function makeVideo(extra = {}, { seconds = 7, audio = true } = {}) {
  const v = store.create({ title: `Sharing ${SECRET}`, status: 'ready', shareable: true, duration: seconds, stage: 'done', ...extra });
  const file = path.join(store.videoDir(v.id), 'video.mp4');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=15:duration=${seconds}`, ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=300:duration=${seconds}`, '-c:a', 'aac', '-shortest'] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  return { v, file, dir: store.videoDir(v.id) };
}
const talking = () => ({
  words: WORDS.map((w) => ({ ...w })), segments: SEGMENTS.map((s) => ({ ...s })), transcript: SEGMENTS.map((s) => s.text).join(' '),
  summary: `The speaker shares the password ${SECRET} for the Atlas server.`,
  chapters: [{ start: 0, title: 'Intro' }, { start: 2, title: `The ${SECRET} password` }],
  tasks: [`Rotate ${SECRET} today`, 'Tell the team'],
  guide: { steps: [{ title: `Log in with ${SECRET}`, text: 'Open the panel.' }] },
  plan: { kind: 'how-to', reason: `Explains the ${SECRET} login` },
  crew: [{ id: 'planner', name: 'Planner', status: 'done', detail: `how-to: ${SECRET} login` }],
  speechRedactions: [], edits: { cuts: [{ start: 5, end: 5.5 }], inserts: [] },
});
const low = (file, ss) => +/max_volume: (-?[\d.]+)/.exec(spawnSync(ffmpeg, ['-ss', String(ss), '-t', '0.6', '-i', file, '-af', 'lowpass=f=400,lowpass=f=400,volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr)[1];
const request = (id, ranges = RANGE, extra = {}) => store.update(id, { stage: 'Bleeping speech', redactRequest: { ranges, rewriteNotes: false, ...extra } });

// ---- the rules, without a video ---------------------------------------------------------------------------------------------------------------
test('captions: the bleeped word goes, its neighbours stay, and the word timings keep their places', () => {
  const R = job.redactTranscript({ segments: SEGMENTS, words: WORDS, intervals: RANGE });
  assert.equal(R.segments[0].text, `Hello everyone my password is ${BLEEP}`);
  assert.equal(R.segments[1].text, SEGMENTS[1].text, 'a caption the bleep does not reach is left as it was');
  assert.equal(R.words.length, WORDS.length); assert.equal(R.words[5].w, BLEEP); assert.equal(R.words[5].s, 2.7); assert.equal(R.words[4].w, 'is');
  assert.ok(R.transcript.endsWith('thanks') && !R.transcript.includes(SECRET)); assert.deepEqual([...R.tokens], [SECRET]);
});
test('captions: the two passes may spell or split a word differently and the secret still goes', () => {
  const apart = job.redactTranscript({ segments: [{ start: 0.2, end: 3.5, text: 'Hello everyone my password is hunter 2' }], words: WORDS, intervals: RANGE });
  assert.ok(!/hunter|\b2\b/.test(apart.segments[0].text), apart.segments[0].text);
  const joined = job.redactTranscript({ segments: [{ start: 0.2, end: 3.5, text: 'Hello everyone my password is hunter2.' }], words: WORDS.map((w) => (w.w === SECRET ? { ...w, w: 'hunter' } : w)).flatMap((w) => (w.w === 'hunter' ? [w, { w: '2', s: 3.3, e: 3.4 }] : [w])), intervals: RANGE });
  assert.ok(!/hunter/.test(joined.segments[0].text), joined.segments[0].text);
  const lopsided = job.redactTranscript({ segments: [{ start: 0, end: 3.5, text: 'Right so hello everyone and my password is Hunter2 yes' }], words: WORDS, intervals: RANGE }); // counts differ: lined up by spelling
  assert.ok(!/hunter2/i.test(lopsided.segments[0].text) && /password is/.test(lopsided.segments[0].text), lopsided.segments[0].text);
});
test('captions with no word timings are decided by where the words sit in the caption', () => {
  const R = job.redactTranscript({ segments: [{ start: 0, end: 4, text: 'one two three four five six seven eight' }], words: null, intervals: [{ from: 1.9, to: 2.6 }] });
  assert.equal(R.words, null); assert.equal(R.segments[0].text, `one two three four ${BLEEP} six seven eight`); // 0.5 s a word: "five" is 2.0-2.5
});
test('consecutive bleeps in a caption become one', () => {
  const R = job.redactTranscript({ segments: [{ start: 0, end: 3, text: 'say alpha beta gamma now' }], words: [{ w: 'say', s: 0, e: 0.5 }, { w: 'alpha', s: 0.6, e: 1.1 }, { w: 'beta', s: 1.2, e: 1.7 }, { w: 'gamma', s: 1.8, e: 2.3 }, { w: 'now', s: 2.4, e: 2.9 }], intervals: [{ from: 0.55, to: 2.35 }] });
  assert.equal(R.segments[0].text, `say ${BLEEP} now`); assert.deepEqual([...R.tokens].sort(), ['alpha', 'beta', 'gamma']);
});
test('the scrubber replaces whole words only, in every shape of data, and does nothing without tokens', () => {
  const s = job.scrubber(new Set(['hunter2', 'marta']));
  assert.equal(s("Marta's password is hunter2, not hunter22."), `${BLEEP} password is ${BLEEP}, not hunter22.`);
  assert.deepEqual(s({ a: ['x hunter2 y', { b: 'MARTA' }], n: 3, f: null }), { a: [`x ${BLEEP} y`, { b: BLEEP }], n: 3, f: null });
  assert.equal(s('Marta and hunter2'), BLEEP.concat(' and ', BLEEP)); assert.equal(job.scrubber(new Set())('hunter2'), 'hunter2');
  assert.ok(job.distinctive('hunter2') && job.distinctive('dan@example.com') && job.distinctive('Marta'));
  assert.ok(!job.distinctive('the') && !job.distinctive('with') && !job.distinctive('Bob'), 'everyday words are never scrubbed out of the notes');
});
test('redactRecord: the notes lose the words, the undo copy holds exactly what changed', () => {
  const v = { ...talking(), id: 'x' };
  const { patch, snapshot } = job.redactRecord(v, RANGE);
  assert.doesNotMatch(dump(patch), new RegExp(SECRET));
  assert.equal(patch.summary, `The speaker shares the password ${BLEEP} for the Atlas server.`); assert.equal(patch.tasks[0], `Rotate ${BLEEP} today`);
  assert.equal(patch.chapters[1].title, `The ${BLEEP} password`); assert.equal(patch.guide.steps[0].title, `Log in with ${BLEEP}`); assert.equal(patch.plan.reason, `Explains the ${BLEEP} login`);
  assert.deepEqual(patch.speechRedactions, [{ from: 2.65, to: 3.45, type: 'requested' }]);
  assert.deepEqual(Object.keys(snapshot).sort(), Object.keys(patch).sort()); assert.equal(snapshot.summary, v.summary); assert.deepEqual(snapshot.speechRedactions, []);
});

// ---- a real video ------------------------------------------------------------------------------------------------------------------------------------
test('apply: the audio is bleeped for real, the length is unchanged, and the old file is kept as the undo', async () => {
  const { v, file, dir } = await makeVideo({ ...talking(), forAgent: true });
  fs.writeFileSync(path.join(dir, 'captions_fr.json'), JSON.stringify({ segments: [{ text: `Mon mot de passe est ${SECRET}` }] }));
  fs.writeFileSync(path.join(dir, 'action-plan.md'), `Transcript: ${SECRET}`);
  const before = (await probe(file)).duration; assert.ok(low(file, 2.8) > -40, 'the original is audible there');
  request(v.id);
  const r = await job.applyRedaction({ videoId: v.id });
  assert.deepEqual(r, { parts: 1, rewrite: false });
  assert.ok(Math.abs((await probe(file)).duration - before) < 0.1, 'same length');
  assert.ok(low(file, 0.5) - low(file, 2.8) > 6, `the original sound is gone inside (${low(file, 0.5)} dB outside, ${low(file, 2.8)} dB inside)`);
  assert.ok(/Video/.test(spawnSync(ffmpeg, ['-i', file], { encoding: 'utf8' }).stderr), 'the picture is still there');
  const prev = path.join(dir, 'video.prev.mp4'); assert.ok(fs.existsSync(prev)); assert.ok(low(prev, 2.8) > -40, 'the undo copy is the unbleeped file');

  const after = store.get(v.id);
  assert.equal(after.stage, 'done'); assert.equal(after.redactRequest, null); assert.equal(after.editError, null);
  assert.equal(after.transcript, `Hello everyone my password is ${BLEEP} and the server is called Atlas thanks`);
  assert.doesNotMatch(dump(after), new RegExp(SECRET), 'nothing but the undo copy still has the word');
  assert.equal(after.speechRedactions.length, 1); assert.equal(after.speechRedactions[0].type, 'requested');
  assert.deepEqual(after.edits.cuts, [{ start: 5, end: 5.5 }], 'a bleep does not move anything in time, so the cuts being drafted stay');
  assert.equal(after.editPrev.kind, 'redact'); assert.equal(after.editPrev.count, 1); assert.match(after.editPrev.transcript, new RegExp(SECRET));
  assert.deepEqual(after.redactResult.parts, 1); assert.equal(after.redactResult.publicCopy, undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'captions_fr.json')), 'translated captions of the old words are gone');
  assert.ok(!fs.existsSync(path.join(dir, 'action-plan.md')), 'so is the plan that quoted the old transcript');
  assert.ok(after.activity.some((a) => /Speech bleeped: 1 part$/.test(a.event)), 'the log says what happened, not what was said');
  assert.ok(!after.activity.some((a) => a.event.includes(SECRET)));
});

test('apply asks for a rewrite of the notes only when the video is cleared, and says so in the stage', async () => {
  const { v } = await makeVideo(talking(), { seconds: 7 });
  request(v.id, RANGE, { rewriteNotes: true });
  assert.deepEqual(await job.applyRedaction({ videoId: v.id }), { parts: 1, rewrite: true });
  assert.equal(store.get(v.id).stage, 'Re-running AI crew', 'nothing else can start between the bleep and the rewrite');
  const { v: held } = await makeVideo({ ...talking(), shareable: false });
  request(held.id, RANGE, { rewriteNotes: true });
  assert.deepEqual(await job.applyRedaction({ videoId: held.id }), { parts: 1, rewrite: false }, 'a video the guard has not cleared would be transcribed all over again');
  assert.equal(store.get(held.id).stage, 'done');
});

test('undo puts the file, the words and the notes back, and keeps the cuts that are being drafted', async () => {
  const { v, file, dir } = await makeVideo(talking());
  request(v.id); await job.applyRedaction({ videoId: v.id });
  assert.equal(undoEdits(v.id), true);
  const back = store.get(v.id);
  assert.ok(low(file, 2.8) > -40, 'the original sound is back'); assert.ok(!fs.existsSync(path.join(dir, 'video.prev.mp4')));
  assert.match(back.transcript, new RegExp(SECRET)); assert.match(back.summary, new RegExp(SECRET)); assert.deepEqual(back.speechRedactions, []);
  assert.equal(back.editPrev, null); assert.equal(back.redactResult, null); assert.equal(back.kind, undefined, 'the undo slot\'s own fields do not leak into the video');
  assert.deepEqual(back.edits.cuts, [{ start: 5, end: 5.5 }]);
  assert.equal(undoEdits(v.id), false, 'one level only');
});

test('"Delete the unbleeped copy": the old file, the old words and the backup of the library file hold nothing', async () => {
  const { v, dir } = await makeVideo(talking());
  request(v.id); await job.applyRedaction({ videoId: v.id });
  assert.ok(fs.readFileSync(path.join(root, 'db.json'), 'utf8').includes(SECRET), 'before: the undo copy of the words is in the library file');
  assert.equal(job.finalizeRedaction(v.id), true);
  assert.ok(!fs.existsSync(path.join(dir, 'video.prev.mp4'))); assert.equal(store.get(v.id).editPrev, null); assert.equal(undoEdits(v.id), false);
  for (const f of ['db.json', 'db.json.bak']) { const text = fs.readFileSync(path.join(root, f), 'utf8'); const all = JSON.parse(text).videos, mine = Array.isArray(all) ? all.find((x) => x.id === v.id) : all[v.id]; assert.ok(mine, f); assert.doesNotMatch(JSON.stringify(mine), new RegExp(SECRET), f); }
  assert.equal(job.finalizeRedaction(v.id), false, 'nothing left to delete');
  const { v: edited } = await makeVideo(talking()); store.update(edited.id, { editPrev: { kind: undefined, at: 1 } });
  assert.equal(job.finalizeRedaction(edited.id), false, 'an edit\'s undo is not touched by this');
});

test('a second bleep replaces the first undo, so the first one\'s words are gone from every copy', async () => {
  const { v, file, dir } = await makeVideo(talking());
  request(v.id); await job.applyRedaction({ videoId: v.id });
  request(v.id, [{ from: 5.55, to: 6.2 }]); await job.applyRedaction({ videoId: v.id });
  const after = store.get(v.id);
  assert.equal(after.transcript, `Hello everyone my password is ${BLEEP} and the server is called ${BLEEP} thanks`); assert.equal(after.speechRedactions.length, 2);
  assert.ok(low(file, 0.5) - low(file, 2.8) > 6, 'the first bleep is still in the audio');
  assert.doesNotMatch(JSON.stringify(after), new RegExp(SECRET), 'not even the undo copy has the first bleep\'s words');
  assert.match(after.editPrev.transcript, /Atlas/, 'the undo copy is the video as it was before the second bleep');
  const prev = path.join(dir, 'video.prev.mp4'); assert.ok(low(prev, 0.5) - low(prev, 2.8) > 6 && low(prev, 5.7) > -40, 'and its file is the once-bleeped one');
});

test('nothing is changed when it cannot work: no audio, no file, nothing in range', async () => {
  const { v: mute, file: f1, dir: d1 } = await makeVideo(talking(), { audio: false });
  const size = fs.statSync(f1).size; request(mute.id);
  await assert.rejects(job.applyRedaction({ videoId: mute.id }), /no audio/);
  assert.equal(fs.statSync(f1).size, size); assert.ok(!fs.existsSync(path.join(d1, 'video.prev.mp4')));
  assert.match(store.get(mute.id).editError, /no audio to bleep/); assert.equal(store.get(mute.id).stage, 'done'); assert.equal(store.get(mute.id).redactRequest, null);
  assert.match(store.get(mute.id).transcript, new RegExp(SECRET), 'the transcript is untouched');

  const { v: gone, file: f2 } = await makeVideo(talking()); fs.rmSync(f2); request(gone.id);
  await assert.rejects(job.applyRedaction({ videoId: gone.id }), /no file/);

  const { v: off, dir: d3 } = await makeVideo(talking()); request(off.id, [{ from: 50, to: 60 }]);
  await assert.rejects(job.applyRedaction({ videoId: off.id }), /nothing to bleep/);
  assert.ok(!fs.existsSync(path.join(d3, 'video.redact.mp4')), 'no half-written file is left behind');

  const { v: idle } = await makeVideo(talking()); store.update(idle.id, { stage: 'Bleeping speech' });
  assert.equal(await job.applyRedaction({ videoId: idle.id }), null, 'a job with no request does nothing'); assert.equal(store.get(idle.id).stage, 'done');
  assert.equal(await job.applyRedaction({ videoId: 'nope' }), null);
});

test('a live public link and no way to take it down: the job stops before it changes anything (fail closed)', async () => {
  const wired = job.deps.unpublish; job.deps.unpublish = null;
  try {
    const { v, file, dir } = await makeVideo(talking()), before = fs.readFileSync(file);
    store.update(v.id, { publish: { state: 'live', id: 'x', url: 'https://links.example.workers.dev/v/x' } });
    request(v.id);
    await assert.rejects(job.applyRedaction({ videoId: v.id }), /could not be taken down/);
    const after = store.get(v.id);
    assert.ok(before.equals(fs.readFileSync(file)), 'the video is exactly as it was'); assert.ok(!fs.existsSync(path.join(dir, 'video.redact.mp4')), 'no half-written file is left behind');
    assert.equal(after.publish.state, 'live'); assert.equal(after.editPrev ?? null, null); assert.ok(after.segments[0].text.includes(SECRET), 'nothing was changed, so nothing was half-done');
    assert.match(after.editError, /could not be taken down/);
  } finally { job.deps.unpublish = wired; }
});

test('the server wires the publisher into the job (agents/ may not import it, so this is the only place)', () => {
  require('../../src/server/server');
  assert.equal(typeof job.deps.unpublish, 'function');
});

test('a public link is taken down before the swap, and only once the bleeped file is good', async () => {
  require('../../src/server/server'); // the wiring under test is the real one, not a stub
  const fake = await createFakeB2().start();
  publisher.deps.log = () => {}; publisher.deps.encode = async (inp, out) => fs.copyFileSync(inp, out); publisher.deps.poster = async (inp, out) => fs.writeFileSync(out, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]));
  publisher.deps.makeB2 = (cfg) => createB2({ keyId: cfg.keyId, key: cfg.key, bucket: cfg.bucket, authUrl: fake.url, sleep: async () => {}, retries: cfg.retries ?? 2 });
  store.setSettings({ integrations: { publish: { workerUrl: 'https://links.example.workers.dev', bucket: fake.cfg.bucket, accessId: 'write-key-id', appKey: 'write-key-secret' } }, defaultPrivacy: 'link', linkExpiryDays: 0, disableDownloads: false });
  try {
    const { v } = await makeVideo({ ...talking(), guard: { model: true, speech: 'checked' } }, { seconds: 7 });
    await publisher.publish(v.id, { mode: 'link' }); await publisher.idle();
    assert.equal(store.get(v.id).publish.state, 'live'); assert.equal(fake.list().length, 3);
    store.update(v.id, { stage: 'done' });
    const out = fs.readdirSync(store.videoDir(v.id)); assert.ok(out.includes('video.mp4'));

    // a bleep that fails leaves the link alone
    request(v.id, [{ from: 50, to: 60 }]); await assert.rejects(job.applyRedaction({ videoId: v.id }));
    assert.equal(store.get(v.id).publish.state, 'live'); assert.equal(fake.list().length, 3, 'nothing was taken down for a bleep that did not happen');

    request(v.id); await job.applyRedaction({ videoId: v.id });
    const p = store.get(v.id).publish;
    assert.equal(p.state, 'removed'); assert.match(p.reason, /audio was bleeped/); assert.deepEqual(fake.list(), [], 'the copy on the internet is gone');
    assert.equal(store.get(v.id).redactResult.publicCopy.removed, true); assert.equal(store.get(v.id).redactResult.publicCopy.pending, undefined);
  } finally { await publisher.idle(); publisher.stop(); await fake.stop(); }
});
