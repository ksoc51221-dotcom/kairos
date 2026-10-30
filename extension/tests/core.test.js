const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/core.js');

test('siteKey: host without www, only for http(s) pages', () => {
  assert.equal(C.siteKey('https://mail.google.com/mail/u/0/#inbox'), 'mail.google.com');
  assert.equal(C.siteKey('https://www.Example.com/x?y=1'), 'example.com');
  assert.equal(C.siteKey('http://localhost:3000/'), 'localhost');
  assert.equal(C.siteKey('chrome://extensions'), null);
  assert.equal(C.siteKey('file:///Users/me/a.html'), null);
  assert.equal(C.siteKey('not a url'), null);
  assert.equal(C.siteKey(undefined), null);
});

test('the three launcher buttons map to the three modes', () => {
  assert.deepEqual([C.MODES.both.screen, C.MODES.both.camera], [true, true]);
  assert.deepEqual([C.MODES.screen.screen, C.MODES.screen.camera], [true, false]);   // monitor button: the screen only
  assert.deepEqual([C.MODES.camera.screen, C.MODES.camera.camera], [false, true]);   // person button: the camera only
  assert.equal(C.isMode('toString'), false);                                          // prototype names are not modes
});

test('happy path: idle -> starting -> countdown -> recording -> paused -> recording -> saving -> idle', () => {
  let s = C.idle();
  s = C.transition(s, { type: 'start', mode: 'both', recId: 'r1', tabId: 7 }, 0);
  assert.equal(s.phase, 'starting');
  s = C.transition(s, { type: 'countdown', endsAt: 3000 }, 10);
  assert.equal(s.phase, 'countdown');
  s = C.transition(s, { type: 'begin' }, 3000);
  assert.equal(s.phase, 'recording');
  assert.equal(C.elapsedMs(s, 5000), 2000);
  s = C.transition(s, { type: 'pause' }, 5000);
  assert.equal(s.phase, 'paused');
  assert.equal(C.elapsedMs(s, 99999), 2000);                       // a paused clock stands still
  s = C.transition(s, { type: 'resume' }, 10000);
  assert.equal(C.elapsedMs(s, 11000), 3000);
  s = C.transition(s, { type: 'stop' }, 11000);
  assert.equal(s.phase, 'saving');
  assert.equal(s.accMs, 3000);
  s = C.transition(s, { type: 'saved', id: 'r1' }, 12000);
  assert.equal(s.phase, 'idle');
  assert.equal(s.lastSavedId, 'r1');
});

test('illegal moves are ignored (same object back)', () => {
  const idle = C.idle();
  for (const type of ['countdown', 'begin', 'pause', 'resume', 'stop', 'saved', 'cancel']) assert.equal(C.transition(idle, { type }, 1), idle, type);
  const rec = C.transition(C.transition(C.transition(idle, { type: 'start', mode: 'screen', recId: 'a' }, 0), { type: 'countdown', endsAt: 1 }, 0), { type: 'begin' }, 0);
  assert.equal(C.transition(rec, { type: 'start', mode: 'both', recId: 'b' }, 1), rec);   // cannot start a second recording
  assert.equal(C.transition(rec, { type: 'resume' }, 1), rec);
  assert.equal(C.transition(idle, { type: 'start', mode: 'nope', recId: 'x' }, 0), idle);
});

test('cancel and fail always return to idle; fail keeps the message', () => {
  let s = C.transition(C.idle(), { type: 'start', mode: 'camera', recId: 'a' }, 0);
  assert.equal(C.transition(s, { type: 'cancel' }, 1).phase, 'idle');
  const f = C.transition(s, { type: 'fail', message: 'no camera' }, 5);
  assert.equal(f.phase, 'idle');
  assert.deepEqual(f.error, { message: 'no camera', at: 5 });
  assert.equal(C.transition(f, { type: 'start', mode: 'screen', recId: 'b' }, 6).error, null);   // a new start clears the old error
});

test('showsRecordingUi: countdown, recording and paused only', () => {
  const mk = (phase) => ({ ...C.idle(), phase });
  assert.deepEqual(['idle', 'starting', 'countdown', 'recording', 'paused', 'saving'].map((p) => C.showsRecordingUi(mk(p))), [false, false, true, true, true, false]);
});

test('formatTime, formatBytes, safeFileName', () => {
  assert.equal(C.formatTime(0), '0:00');
  assert.equal(C.formatTime(65_900), '1:05');
  assert.equal(C.formatTime(3_725_000), '1:02:05');
  assert.equal(C.formatTime(-5), '0:00');
  assert.equal(C.formatBytes(0), '0 KB');
  assert.equal(C.formatBytes(12_345), '12 KB');
  assert.equal(C.formatBytes(4_200_000), '4.2 MB');
  assert.equal(C.formatBytes(150_000_000), '150 MB');
  assert.equal(C.safeFileName('a/b:c*?"<>|d'), 'a b c d');
  assert.equal(C.safeFileName('   '), 'Kairos recording');
});

test('pickMime prefers MP4, falls back to WebM, null when nothing works', () => {
  assert.equal(C.pickMime(() => true).ext, 'mp4');
  assert.equal(C.pickMime((t) => t.startsWith('video/webm;codecs=vp9')).mime, 'video/webm;codecs=vp9,opus');
  assert.equal(C.pickMime(() => false), null);
});

test('newId is unique and starts with the time in base 36 (the library recovers the date from it)', () => {
  const a = C.newId(), b = C.newId();
  assert.notEqual(a, b);
  assert.ok(Math.abs(parseInt(a.slice(1, 9), 36) - Date.now()) < 2000);
});

test('events from a cancelled setup flow cannot touch a newer recording', () => {
  let s = C.transition(C.idle(), { type: 'start', mode: 'screen', recId: 'old' }, 0);
  s = C.transition(s, { type: 'cancel', recId: 'old' }, 1);
  s = C.transition(s, { type: 'start', mode: 'camera', recId: 'new' }, 2);
  assert.equal(C.transition(s, { type: 'countdown', endsAt: 9, recId: 'old' }, 3), s);   // the old flow's countdown
  assert.equal(C.transition(s, { type: 'fail', message: 'late', recId: 'old' }, 3), s);  // its late failure
  assert.equal(C.transition(s, { type: 'cancel', recId: 'old' }, 3), s);
  assert.equal(C.transition(s, { type: 'countdown', endsAt: 9, recId: 'new' }, 3).phase, 'countdown');
});
