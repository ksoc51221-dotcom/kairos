// The editor's pure core: cuts -> clips -> time map -> ffmpeg arguments, the proposals, and what the server accepts.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/pipeline/edits');
const A = require('../../src/pipeline/analyze');
const { toCuts } = require('../../src/agents/rambles');

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('cuts are clamped, sorted and merged; slivers under a frame are dropped', () => {
  assert.deepEqual(E.mergeCuts([{ start: 5, end: 6 }, { start: 1, end: 2 }, { start: 1.5, end: 3 }, { start: 3, end: 3.5 }, { start: 9, end: 9.01 }, { start: -2, end: 0.5 }, { start: 9.5, end: 40 }], 10),
    [{ start: 0, end: 0.5 }, { start: 1, end: 3.5 }, { start: 5, end: 6 }, { start: 9.5, end: 10 }]);
  assert.deepEqual(E.keptRanges([{ start: 1, end: 2 }, { start: 4, end: 10 }], 10), [{ start: 0, end: 1 }, { start: 2, end: 4 }]);
  assert.deepEqual(E.keptRanges([], 10), [{ start: 0, end: 10 }]);
  assert.deepEqual(E.keptRanges([{ start: 0, end: 10 }], 10), []);
});

test('clips: the base video minus the cuts, in order; cutting everything is refused', () => {
  const c = E.buildClips({ cuts: [{ start: 2, end: 3 }, { start: 6, end: 7 }], duration: 10 });
  assert.deepEqual(c.map((x) => [x.src, x.start, x.end]), [['base', 0, 2], ['base', 3, 6], ['base', 7, 10]]);
  near(E.total(c), 8);
  assert.throws(() => E.buildClips({ cuts: [{ start: 0, end: 10 }], duration: 10 }), /Nothing would be left/);
});

test('inserts: spliced inside a kept range, at its start, inside a cut (goes where the cut began) and at the end', () => {
  const ins = (at, videoId = 'x') => ({ at, videoId, duration: 4 });
  const at = (inserts, cuts = []) => E.buildClips({ cuts, inserts, duration: 10 }).map((c) => `${c.src}:${c.start}-${c.end}`);
  assert.deepEqual(at([ins(5)]), ['base:0-5', 'x:0-4', 'base:5-10']);
  assert.deepEqual(at([ins(0)]), ['x:0-4', 'base:0-10']);
  assert.deepEqual(at([ins(99)]), ['base:0-10', 'x:0-4'], 'past the end appends');
  assert.deepEqual(at([ins(4)], [{ start: 3, end: 6 }]), ['base:0-3', 'x:0-4', 'base:6-10'], 'inside a cut: where the cut began');
  assert.deepEqual(at([ins(8, 'b'), ins(2, 'a')]), ['base:0-2', 'a:0-4', 'base:2-8', 'b:0-4', 'base:8-10'], 'sorted by position');
});

test('time map: ranges that survive move up by what was cut before them; cut ranges vanish; points snap forward', () => {
  const clips = E.buildClips({ cuts: [{ start: 2, end: 3 }, { start: 6, end: 8 }], duration: 10 });
  const m = E.timeMap(clips);
  assert.deepEqual(m.mapRange(0, 1), { start: 0, end: 1 });
  assert.deepEqual(m.mapRange(3.5, 5), { start: 2.5, end: 4 });
  assert.deepEqual(m.mapRange(8, 9), { start: 5, end: 6 });
  assert.equal(m.mapRange(2.2, 2.8), null, 'entirely inside a cut');
  assert.deepEqual(m.mapRange(1.5, 3.5), { start: 1.5, end: 2.5 }, 'straddling a cut keeps the surviving parts joined');
  near(m.mapPoint(2.5), 2); near(m.mapPoint(7), 5); near(m.mapPoint(9.5), 6.5);
  near(m.total, 7);
});

test('with an insert, later times shift by its length and the inserted span is reported', () => {
  const clips = E.buildClips({ cuts: [], inserts: [{ at: 4, videoId: 'x', duration: 3 }], duration: 10 });
  const v = { segments: [{ start: 1, end: 2, text: 'a' }, { start: 5, end: 6, text: 'b' }], words: [{ w: 'b', s: 5, e: 6 }], comments: [{ at: 5 }], overlays: [{ id: 'o', start: 4, end: 8 }], chapters: [{ start: 0, title: 't' }, { start: 6, title: 'u' }], reactionEvents: [{ at: 9 }] };
  const { patch, spans } = E.remapRecord(v, clips);
  assert.deepEqual(patch.segments.map((s) => [s.start, s.end]), [[1, 2], [8, 9]]);
  assert.deepEqual(patch.words, [{ w: 'b', s: 8, e: 9 }]);
  assert.equal(patch.comments[0].at, 8); assert.equal(patch.chapters[1].start, 9); assert.equal(patch.reactionEvents[0].at, 12);
  assert.deepEqual(patch.overlays.map((o) => [o.start, o.end]), [[4, 4], [7, 11]].slice(1), 'the overlay now starts after the insert and keeps its length');
  assert.equal(patch.duration, 13);
  assert.deepEqual(spans, [{ src: 'x', from: 0, to: 3, at: 4 }]);
  const merged = E.mergeInserted(patch, spans, { x: { segments: [{ start: 0, end: 3, text: 'inserted' }], words: [{ w: 'hi', s: 1, e: 2 }] } });
  assert.deepEqual(merged.segments.map((s) => s.text), ['a', 'inserted', 'b']);
  assert.deepEqual(merged.segments[1], { start: 4, end: 7, text: 'inserted' });
  assert.deepEqual(merged.words.map((w) => [w.w, w.s]), [['hi', 5], ['b', 8]]);
});

test('the recorded cursor feed is remapped; samples inside a cut are dropped, an inserted clip has none', () => {
  const tl = { duration: 10, cursor: [[1, 0.1, 0.1], [2.5, 0.2, 0.2], [5, 0.3, 0.3]], clicks: [[2.6, 0.2, 0.2, 1], [5, 0.3, 0.3, 1]] };
  const out = E.remapTimeline(tl, E.buildClips({ cuts: [{ start: 2, end: 3 }], duration: 10 }));
  assert.deepEqual(out.cursor, [[1, 0.1, 0.1], [4, 0.3, 0.3]]);
  assert.deepEqual(out.clicks, [[4, 0.3, 0.3, 1]]);
  assert.equal(out.duration, 9);
});

test('ffmpeg arguments: trim every clip, fit to the base size at 60 fps, concat; audio only when something has audio', () => {
  const clips = E.buildClips({ cuts: [{ start: 2, end: 3 }], inserts: [{ at: 10, videoId: 'x', duration: 2 }], duration: 10 });
  const r = E.buildEditCommand({ video: '/v/video.mp4', hasAudio: true, size: { w: 1920, h: 1080 }, clips, sources: { x: { file: '/o/video.mp4', hasAudio: false } }, out: '/v/o.mp4', hw: false });
  const g = r.args[r.args.indexOf('-filter_complex') + 1];
  assert.deepEqual(r.args.filter((a, i) => r.args[i - 1] === '-i'), ['/v/video.mp4', '/o/video.mp4']);
  assert.match(g, /\[0:v\]trim=start=0:end=2,setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:\(ow-iw\)\/2:\(oh-ih\)\/2,setsar=1,fps=60,format=yuv420p\[v0\]/);
  assert.match(g, /\[0:a\]atrim=start=3:end=10,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo\[a1\]/);
  assert.match(g, /anullsrc=r=48000:cl=stereo,atrim=duration=2,asetpts=PTS-STARTPTS\[a2\]/, 'an inserted clip without sound is padded with silence');
  assert.match(g, /\[v0\]\[a0\]\[v1\]\[a1\]\[v2\]\[a2\]concat=n=3:v=1:a=1\[v\]\[a\]/);
  assert.ok(r.args.includes('libx264') && r.args.includes('+faststart'));
  near(r.total, 11);
  const silent = E.buildEditCommand({ video: '/v.mp4', hasAudio: false, size: { w: 640, h: 360 }, clips: E.buildClips({ cuts: [], duration: 5 }), out: '/o.mp4', hw: false });
  assert.ok(!silent.args.includes('-c:a') && !silent.args.join(' ').includes('atrim'));
});

test('words selected in the transcript become cuts; neighbours join', () => {
  const w = [{ w: 'a', s: 0, e: 0.4 }, { w: 'b', s: 0.5, e: 0.9 }, { w: 'c', s: 1, e: 1.4 }, { w: 'd', s: 1.5, e: 1.9 }, { w: 'e', s: 2, e: 2.4 }];
  assert.deepEqual(E.cutsFromWords(w, [3, 1, 2, 4]), [{ start: 0.5, end: 2.4, kind: 'transcript' }]);
  assert.deepEqual(E.cutsFromWords(w, [0, 2]), [{ start: 0, end: 0.4, kind: 'transcript' }, { start: 1, end: 1.4, kind: 'transcript' }]);
  assert.deepEqual(E.cutsFromWords(w, [9]), []);
});

test('what the server accepts: numbers only, ordered, inside the video, inserts only of other ready videos', () => {
  const lookup = (id) => (id === 'ok' ? { duration: 5, ready: true } : null);
  const r = E.sanitizeEdits({ cuts: [{ start: 3, end: 1, kind: 'filler' }, { start: 'x', end: 2 }, { start: 8, end: 99, kind: 'nonsense' }, { start: 4, end: 4.001 }],
    inserts: [{ videoId: 'ok', at: 2 }, { videoId: 'self', at: 1 }, { videoId: 'missing', at: 1 }, { videoId: 'ok', at: 'soon' }] }, { id: 'self', duration: 10, lookup });
  assert.deepEqual(r.cuts, [{ start: 1, end: 3, kind: 'filler' }, { start: 8, end: 10, kind: 'manual' }]);
  assert.deepEqual(r.inserts, [{ videoId: 'ok', at: 2, start: 0, end: 5, duration: 5 }]);
  assert.deepEqual(E.sanitizeEdits(null, { id: 'a', duration: 1, lookup }), { cuts: [], inserts: [] });
});

// ---- proposals ----
test('silence: ffmpeg output parsed, long ones become cuts that leave a short pause, short ones are left alone', () => {
  const out = `[silencedetect @ 0x1] silence_start: 1.2\n[silencedetect @ 0x1] silence_end: 3.4 | silence_duration: 2.2\n[silencedetect @ 0x1] silence_start: 5\n[silencedetect @ 0x1] silence_end: 5.9 | silence_duration: 0.9\n[silencedetect @ 0x1] silence_start: 8`;
  const s = A.parseSilences(out, 10);
  assert.deepEqual(s, [{ start: 1.2, end: 3.4 }, { start: 5, end: 5.9 }, { start: 8, end: 10 }], 'a silence that runs to the end is closed at the duration');
  assert.deepEqual(A.silenceCuts(s, { minDur: 1, keep: 0.3 }), [{ start: 1.35, end: 3.25, kind: 'silence' }, { start: 8.15, end: 9.85, kind: 'silence' }]);
});

test('filler words: um, uh and friends; "you know," as a tic; "like" only when set apart', () => {
  const W = (s) => s.split(' ').map((w, i) => ({ w, s: i * 0.5, e: i * 0.5 + 0.45 })); // 50 ms between words: no pauses
  const f = (s, o) => A.findFillers(W(s), o).map((x) => x.text);
  assert.deepEqual(f('Hello everyone, um, today I want to show uh, you'), ['um', 'uh']);
  assert.deepEqual(f('and you know, it is simple'), ['you know']);
  assert.deepEqual(f('do you know the answer'), [], '"you know" without the pause is a real clause');
  assert.deepEqual(f('I like it and it looks like a plan'), []);
  assert.deepEqual(f('it is, like, really good'), ['like']);
  const gap = [{ w: 'it', s: 0, e: 0.4 }, { w: 'like', s: 1.2, e: 1.5 }, { w: 'works', s: 1.55, e: 2 }];
  assert.deepEqual(A.findFillers(gap).map((x) => x.text), ['like'], 'a pause before it');
  assert.deepEqual(A.findFillers([{ w: 'Um,', s: 3.1, e: 3.4 }])[0], { start: 3.1, end: 3.4, text: 'Um', kind: 'filler', i: 0 });
});

test('waveform peaks: one value per 10 ms, 0..127, quiet speech stays visible', () => {
  const pcm = new Float32Array(8000); for (let i = 0; i < 800; i++) pcm[i] = 0.5; for (let i = 800; i < 1600; i++) pcm[i] = 0.01;
  const p = A.computePeaks(pcm);
  assert.equal(p.length, 100);
  assert.equal(p[0], Math.round(Math.sqrt(0.5) * 127)); assert.equal(p[10], Math.round(Math.sqrt(0.01) * 127)); assert.equal(p[50], 0);
  assert.ok(p.every((x) => x >= 0 && x <= 127));
});

test('rambles: the model answer is validated against the segments and capped at a quarter of the video', () => {
  const segs = Array.from({ length: 10 }, (_, i) => ({ start: i * 10, end: i * 10 + 9, text: `s${i}` }));
  const c = toCuts({ ranges: [{ from: 2, to: 3, reason: 'repeats' }, { from: 3, to: 4, reason: 'overlaps the last one' }, { from: 8, to: 99, reason: 'out of range' }, { from: 7, to: 5, reason: 'reversed' }, { from: 6, to: 6, reason: 'tangent' }] }, segs, 120);
  assert.deepEqual(c.map((x) => [x.start, x.end, x.kind]), [[20, 39, 'ramble'], [60, 69, 'ramble']]);
  assert.deepEqual(toCuts({ ranges: [{ from: 0, to: 9, reason: 'everything' }] }, segs, 100), [], 'more than 25% is not believed');
  assert.deepEqual(toCuts('junk', segs, 100), []);
});
