// R6: "Privacy Guard listens too": spoken secrets are found in the transcript, bleeped in the audio, and replaced in the transcript and captions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sg = require('../../src/agents/speech-guard');
const { ffmpeg } = require('../../src/pipeline/encode');

// "Word pass" input from a sentence: 0.4 s per word.
const words = (sentence, t0 = 0) => sentence.split(' ').map((w, i) => ({ w, s: +(t0 + i * 0.4).toFixed(2), e: +(t0 + i * 0.4 + 0.35).toFixed(2) }));
const phrases = (ws) => sg.findSpokenSecrets(ws).map((h) => h.phrase);

test('spoken passwords, keys and PINs are found', () => {
  assert.deepEqual(phrases(words('okay the password is hunter2 and then click login')), ['hunter2']);
  assert.deepEqual(phrases(words('my api key is sk-live-abc12345 please')), ['sk-live-abc12345']);
  assert.deepEqual(phrases(words('the pin is 4 2 1 9.')), ['4 2 1 9']);
  assert.deepEqual(phrases(words('password colon correct horse battery staple')), [], 'no "is" and no digit: not guessed');
  assert.deepEqual(phrases(words('the passcode is correct horse battery staple')), ['correct horse battery'], 'at most three words after "is"');
  assert.deepEqual(phrases(words('my token is abc123, thanks')), ['abc123'], 'stops at the comma');
});
test('talking ABOUT passwords is left alone', () => {
  assert.deepEqual(phrases(words('click the password reset page and change the password later')), []);
  assert.deepEqual(phrases(words('we use a secret manager for tokens in production')), []);
});
test('long digit runs (card, SSN, phone) are found, short numbers are not', () => {
  assert.deepEqual(phrases(words('the card is four one one one one one one one one one one one one one one one')).length, 1);
  assert.deepEqual(phrases(words('call five five five one two three four five six seven')), ['five five five one two three four five six seven']);
  assert.deepEqual(phrases(words('we shipped 12 builds in 2024 for 300 customers')), []);
});
test('the on-screen patterns also apply to speech (e-mail, JWT, AWS key)', () => {
  assert.deepEqual(phrases(words('send it to jane.doe@example.com tomorrow')), ['jane.doe@example.com']);
  assert.ok(phrases(words('AKIAIOSFODNN7EXAMPLE is the key')).includes('AKIAIOSFODNN7EXAMPLE'));
});
test('hits carry padded times and neighbouring hits merge', () => {
  const ws = words('the password is hunter2 and the pin is 1234');
  const h = sg.findSpokenSecrets(ws);
  assert.equal(h.length, 2); assert.ok(h[0].from < ws[3].s && h[0].to > ws[3].e);
  assert.equal(sg.mergeIntervals([{ from: 1, to: 2 }, { from: 2.1, to: 3 }, { from: 5, to: 6 }]).length, 2);
});

test('guardTranscript: words, captions and text lose the secret; nothing else changes', () => {
  const sentence = 'so the password is hunter2 and then we log in';
  const ws = words(sentence), segs = [{ start: 0, end: 3.6, text: sentence }];
  const g = sg.guardTranscript({ text: sentence, segments: segs, words: ws });
  assert.equal(g.count, 1);
  assert.doesNotMatch(JSON.stringify(g), /hunter2/);
  assert.match(g.segments[0].text, /^so the password is \[bleep\]/);
  assert.equal(g.words.filter((w) => w.w === sg.BLEEP).length, 1);
  assert.equal(g.words.length, ws.length, 'timings keep their count');
  assert.ok(g.intervals[0].from < 1.6 && g.intervals[0].to > 1.95, JSON.stringify(g.intervals));
  const clean = sg.guardTranscript({ text: 'hello there', segments: [{ start: 0, end: 1, text: 'hello there' }], words: words('hello there') });
  assert.equal(clean.count, 0); assert.equal(clean.text, 'hello there');
});
test('guardTranscript: a secret only the caption pass heard is still removed, and a word-pass-only hit blanks that caption', () => {
  const g1 = sg.guardTranscript({ text: 'the password is Hunter 2', segments: [{ start: 0, end: 2, text: 'the password is Hunter 2' }], words: words('the pass word is hunter') });
  assert.doesNotMatch(JSON.stringify(g1.segments), /Hunter/);
  const g2 = sg.guardTranscript({ text: 'the code reads differently here', segments: [{ start: 0, end: 2, text: 'something else entirely' }], words: words('the password is hunter2') });
  assert.equal(g2.segments[0].text, sg.BLEEP, 'segment text did not show the phrase, so the whole caption goes');
});

test('the bleep filter really silences the original audio and plays a tone (real ffmpeg)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-bleep-')), src = path.join(d, 'in.mp4'), out = path.join(d, 'out.mp4');
  const r1 = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:d=6', '-f', 'lavfi', '-i', 'sine=f=300:d=6', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  assert.equal(r1.status, 0);
  return sg.bleepAudio(src, out, [{ from: 2, to: 3 }], 6).then(() => {
    const level = (ss, t) => /mean_volume: (-?[\d.]+|-inf)/.exec(spawnSync(ffmpeg, ['-ss', String(ss), '-t', String(t), '-i', out, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr)[1];
    assert.ok(+level(0.2, 1.5) > -30, 'untouched audio is still there');
    const inside = spawnSync(ffmpeg, ['-ss', '2.1', '-t', '0.8', '-i', out, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const peak = +/max_volume: (-?[\d.]+)/.exec(inside)[1];
    assert.ok(peak > -25 && peak < -8, `a quiet bleep plays inside the interval (peak ${peak} dB)`);
    // the 300 Hz original must be gone inside the interval: its energy there is the 1 kHz tone only
    const band = (ss, filter) => +/max_volume: (-?[\d.]+)/.exec(spawnSync(ffmpeg, ['-ss', String(ss), '-t', '0.8', '-i', out, '-af', `${filter},volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr)[1];
    assert.ok(band(2.1, 'highpass=f=700') > -25, 'the 1 kHz bleep is there');
    const lowOutside = band(0.5, 'lowpass=f=400,lowpass=f=400'), lowInside = band(2.1, 'lowpass=f=400,lowpass=f=400');
    assert.ok(lowOutside - lowInside > 6, `the 300 Hz original is gone inside (${lowOutside} dB outside, ${lowInside} dB inside)`);
    assert.ok(/Video/.test(spawnSync(ffmpeg, ['-i', out], { encoding: 'utf8' }).stderr), 'the picture is still there');
    fs.rmSync(d, { recursive: true, force: true });
  });
});

test('misheard triggers still count: "past word", "pass word", one-letter typos, "pin code"', () => {
  const said = (s) => sg.findSpokenSecrets(words(s)).map((h) => h.phrase || words(s).slice(h.i0, h.i1 + 1).map((x) => x.w).join(' '));
  assert.deepEqual(said('Yeah, no, past word is test 123.'), ['test 123']); // the real miss, 2026-10-16
  assert.deepEqual(said('the pass word is blue horse'), ['blue horse']);
  assert.deepEqual(said('the passward is hunter2.'), ['hunter2']);
  assert.deepEqual(said('my pin code is 4 2 1 9'), ['4 2 1 9']);
  for (const s of ['I forgot my password reset link', 'we passed word of it to the team', 'the passport is in the drawer']) assert.deepEqual(said(s), [], s);
});
