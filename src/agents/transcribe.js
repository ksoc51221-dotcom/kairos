const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { extractAudio } = require('./media');

// Agent 1 — Transcriber: local Whisper via transformers.js, in a child process.
async function transcribe(videoPath, workDir, cacheDir, onStatus = () => {}, existingAudio = null) {
  const audio = existingAudio || path.join(workDir, 'audio.f32');
  if (!existingAudio) await extractAudio(videoPath, audio);
  const worker = path.join(__dirname, 'whisper-worker.mjs');
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [worker, audio, cacheDir], {
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
module.exports = { transcribe, transcribeAudioFile };
