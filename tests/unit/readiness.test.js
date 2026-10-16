// Finding 2 (PHASE4-CHECK): the app says so, before recording, when the speech model is missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readiness = require('../../src/main/readiness');
const transcribe = require('../../src/agents/transcribe');

test('finding 2: an empty model folder is reported as a missing speech model, with a message the launcher shows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-ready-'));
  readiness.init(dir);
  const seen = []; const off = readiness.onChange((r) => seen.push(r.speechMissing));
  const r = await readiness.refresh();
  assert.equal(r.speechMissing, true); assert.match(r.warning, /speech model is not downloaded \(150 MB\).*only you can watch/);
  assert.deepEqual(seen, [true], 'listeners (the menu bar) are told');
  off();
});
test('finding 2: with the model on disk the speech warning goes away', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-ready-'));
  const onnx = path.join(dir, ...transcribe.MODEL.split('/'), 'onnx'); fs.mkdirSync(onnx, { recursive: true });
  fs.writeFileSync(path.join(onnx, 'model.onnx'), ''); fs.truncateSync(path.join(onnx, 'model.onnx'), 60e6);
  readiness.init(dir);
  const r = await readiness.refresh();
  assert.equal(r.speechMissing, false); assert.doesNotMatch(r.warning || '', /speech model/);
});
