const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { extractAudio } = require('./media');

// The Whisper model (about 150 MB) is fetched from Hugging Face on first use and cached under <data>/models. Benchmarked in PLAN.md Phase 2:
// transformers.js with Xenova/whisper-base runs a 27 s clip in about 1.5 s on Apple silicon (0.06x realtime), so it stays the only engine.
const MODEL = 'Xenova/whisper-base';
const modelDir = (cacheDir) => path.join(cacheDir, ...MODEL.split('/'));
function modelStatus(cacheDir) {
  const dir = path.join(modelDir(cacheDir), 'onnx');
  let bytes = 0;
  try { for (const f of fs.readdirSync(dir)) bytes += fs.statSync(path.join(dir, f)).size; } catch {}
  return { model: MODEL, cached: bytes > 50e6, bytes };
}

// Agent 1 — Transcriber: local Whisper via transformers.js, in a child process.
async function transcribe(videoPath, workDir, cacheDir, onStatus = () => {}, existingAudio = null) {
  const audio = existingAudio || path.join(workDir, 'audio.f32');
  if (!existingAudio) await extractAudio(videoPath, audio);
  const worker = path.join(__dirname, 'whisper-worker.mjs');
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [worker, audio, cacheDir, MODEL], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: path.join(__dirname, '..', '..'),
    });
    let buf = '', result = null, errTail = '';
    p.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.status) onStatus(m.status);
          if (m.download != null) onStatus(`downloading model ${m.download}%`);
          if (m.done) result = m;
          if (m.error) errTail = m.error;
        } catch {}
      }
    });
    p.stderr.on('data', (d) => (errTail = String(d).slice(-400)));
    p.on('close', () => {
      if (!existingAudio) fs.rmSync(audio, { force: true });
      result ? resolve(result) : reject(new Error(errTail || 'transcription failed'));
    });
  });
}
// Same worker, but for a raw 16 kHz mono float32 file we already have (voice dictation).
function transcribeAudioFile(f32, cacheDir) { return transcribe(null, null, cacheDir, () => {}, f32); }
// Settings → AI → Download models. Resolves when the model is in the cache; onProgress gets 0..100.
function downloadModel(cacheDir, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'whisper-worker.mjs'), '--download', cacheDir, MODEL], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: path.join(__dirname, '..', '..') });
    let buf = '', ok = false, err = '';
    p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); if (m.download != null) onProgress(m.download); if (m.done) ok = true; if (m.error) err = m.error; } catch {} } });
    p.stderr.on('data', (d) => (err = String(d).slice(-300)));
    p.on('close', () => (ok ? resolve() : reject(new Error(err || 'download failed (are you online?)'))));
  });
}
module.exports = { transcribe, transcribeAudioFile, modelStatus, downloadModel, MODEL };
