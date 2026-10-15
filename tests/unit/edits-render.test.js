// The editor against the real ffmpeg binary (and, when the speech model is cached and macOS `say` exists, the real Whisper): small synthetic clips,
// measured, never your screen. Opens no windows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('../../src/pipeline/edits');
const A = require('../../src/pipeline/analyze');
const { runFfmpeg, ffmpeg, hasAudioStream } = require('../../src/pipeline/encode');
const { probe } = require('../../src/agents/media');
const transcribe = require('../../src/agents/transcribe');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-edit-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const f = (n) => path.join(dir, n);
const dur = async (file) => (await probe(file)).duration;
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what || ''} ${a.toFixed(3)} vs ${b.toFixed(3)} (tolerance ${tol})`);

async function clip(name, seconds, { audio = true, size = '640x360' } = {}) {
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${seconds}`, ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'aac'] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f(name)]);
  return f(name);
}
async function render({ video, cuts = [], inserts = [], sources = {}, out }) {
  const d = await dur(video), clips = E.buildClips({ cuts, inserts, duration: d });
  const plan = E.buildEditCommand({ video, hasAudio: hasAudioStream(video), size: { w: 640, h: 360 }, clips, sources, out, hw: false });
  await runFfmpeg(plan.args, { duration: plan.total });
  return { plan, clips };
}

test('three cuts remove exactly their length (±50 ms), video and audio stay together', async () => {
  const src = await clip('a.mp4', 8), cuts = [{ start: 1, end: 1.5 }, { start: 3, end: 3.4 }, { start: 5, end: 5.25 }];
  await render({ video: src, cuts, out: f('a-cut.mp4') });
  const removed = 0.5 + 0.4 + 0.25;
  near(await dur(f('a-cut.mp4')), 8 - removed, 0.05, 'duration after cutting');
  assert.ok(hasAudioStream(f('a-cut.mp4')));
});

test('an insert adds its whole length, and a silent clip does not break the audio track', async () => {
  const base = await clip('b.mp4', 6), other = await clip('b2.mp4', 2, { audio: false, size: '320x240' });
  await render({ video: base, inserts: [{ at: 3, videoId: 'o', duration: 2 }], sources: { o: { file: other, hasAudio: false } }, out: f('b-ins.mp4') });
  near(await dur(f('b-ins.mp4')), 8, 0.06, 'duration with the insert');
  assert.ok(hasAudioStream(f('b-ins.mp4')), 'the silent insert is padded, so the joined audio survives');
  const m = spawnSync(ffmpeg, ['-hide_banner', '-i', f('b-ins.mp4')], { encoding: 'utf8' }).stderr;
  assert.match(m, /Video: h264.*640x360/, 'the 320x240 insert is fitted to the base size');
});

test('silence detection finds the gap and the cut leaves a short pause; the waveform shows it', async () => {
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=2', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=2', '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', f('gap.wav')]);
  const s = await A.detectSilences(f('gap.wav'), 6);
  assert.equal(s.length, 1); near(s[0].start, 2, 0.1, 'silence start'); near(s[0].end, 4, 0.1, 'silence end');
  const cuts = A.silenceCuts(s, { minDur: 0.8, keep: 0.3 });
  assert.equal(cuts.length, 1); near(cuts[0].end - cuts[0].start, 1.7, 0.15, 'cut length: the silence minus a 0.3 s pause');
  const w = await A.waveform(f('gap.wav'), 6);
  assert.ok(Math.abs(w.peaks.length - 600) <= 2, `${w.peaks.length} peaks for 6 s`);
  assert.ok(w.peaks.slice(10, 190).every((p) => p > 40), 'tone is loud'); assert.ok(w.peaks.slice(215, 385).every((p) => p < 10), 'silence is flat');
});

test('undo: cuts are remapped on apply and the snapshot restores every time-keyed field', () => {
  const store = require('../../src/store'); store.init(f('lib'), {});
  const v = store.create({ title: 'u', status: 'ready', duration: 8, segments: [{ start: 1, end: 2, text: 'a' }, { start: 6, end: 7, text: 'b' }], words: [{ w: 'b', s: 6, e: 7 }], comments: [{ at: 6, text: 'x' }] });
  const vdir = store.videoDir(v.id); fs.mkdirSync(vdir, { recursive: true });
  fs.writeFileSync(path.join(vdir, 'video.mp4'), 'new'); fs.writeFileSync(path.join(vdir, 'video.prev.mp4'), 'old');
  const { TIME_KEYED, undoEdits } = require('../../src/agents/edit-job');
  const snapshot = {}; for (const k of TIME_KEYED) snapshot[k] = v[k];
  store.update(v.id, { duration: 5, segments: [], words: [], comments: [{ at: 3, text: 'x' }], editPrev: { ...snapshot, edits: {}, at: 1 } });
  assert.equal(undoEdits(v.id), true);
  const u = store.get(v.id);
  assert.equal(fs.readFileSync(path.join(vdir, 'video.mp4'), 'utf8'), 'old');
  assert.deepEqual([u.duration, u.segments.length, u.words.length, u.comments[0].at, u.editPrev], [8, 2, 1, 6, null]);
  assert.equal(undoEdits(v.id), false, 'one level only');
  store.close();
});

// ---- the acceptance numbers with real speech (skipped without the cached model or `say`) ----
const models = path.join(os.homedir(), 'Library', 'Application Support', 'spool', 'models');
const haveSpeech = process.platform === 'darwin' && fs.existsSync('/usr/bin/say') && transcribe.modelStatus(models).cached;
test('speech: word timestamps, the filler pass finds the "um"s, cutting 3 words removes those ±50 ms, cutting the fillers removes them', { skip: !haveSpeech && 'needs macOS say and the cached Whisper model', timeout: 120000 }, async () => {
  const text = 'Hello everyone. Um, today I want to show you the new dashboard. Uh, first you open the settings page, and then, um, you click on billing.';
  spawnSync('/usr/bin/say', ['-v', 'Samantha', '-o', f('speech.aiff'), text]);
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=12', '-i', f('speech.aiff'), '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f('speech.mp4')]);
  const work = f('work'); fs.mkdirSync(work, { recursive: true });
  const r = await transcribe.transcribe(f('speech.mp4'), work, models, () => {}, null, { words: true });
  assert.ok(r.words && r.words.length > 20, `${r.words?.length} words`);
  assert.ok(r.words.every((w) => w.e >= w.s && w.s >= 0), 'timestamps are ordered');

  const fillers = A.findFillers(r.words);
  const heard = fillers.map((x) => x.text.toLowerCase());
  assert.ok(heard.filter((t) => t === 'um').length >= 2, `found: ${heard.join(', ')}`);
  console.log('    fillers found:', fillers.map((x) => `${x.text}@${x.start}`).join(', '));

  // 3 consecutive words out of the middle: "show you the"
  const i = r.words.findIndex((w) => /^show$/i.test(w.w)); assert.ok(i > 0);
  const cut = E.cutsFromWords(r.words, [i, i + 1, i + 2]); assert.equal(cut.length, 1);
  const before = await dur(f('speech.mp4')), want = cut[0].end - cut[0].start;
  await render({ video: f('speech.mp4'), cuts: cut, out: f('speech-3.mp4') });
  near(before - (await dur(f('speech-3.mp4'))), want, 0.05, `removed ${want.toFixed(3)} s of`);
  console.log(`    3 words "${r.words.slice(i, i + 3).map((w) => w.w).join(' ')}" cut: asked for ${want.toFixed(3)} s, removed ${(before - (await dur(f('speech-3.mp4')))).toFixed(3)} s`);

  // all fillers out, then listen again: no um or uh left
  await render({ video: f('speech.mp4'), cuts: fillers.map((x) => ({ start: x.start, end: x.end })), out: f('speech-clean.mp4') });
  const again = await transcribe.transcribe(f('speech-clean.mp4'), work, models, () => {}, null, { words: true });
  const left = A.findFillers(again.words).map((x) => x.text);
  assert.deepEqual(left, [], `still heard: ${again.text}`);
  console.log('    after the filler pass Whisper hears:', again.text);
});
