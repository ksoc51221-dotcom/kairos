// Runs in its own process (ELECTRON_RUN_AS_NODE) so transcription never blocks the app.
// usage: node whisper-worker.mjs <audio.f32> <cacheDir> [model]
import fs from 'node:fs';
import { pipeline, env } from '@huggingface/transformers';

const [, , audioPath, cacheDir, model = 'Xenova/whisper-base', dtype = '', device = ''] = process.argv;
env.cacheDir = cacheDir;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

try {
  if (audioPath === '--download') { // fetch the model into the cache and stop (Settings → AI → Download models)
    const opts = { progress_callback: (p) => { if (p.status === 'progress') send({ download: Math.round(p.progress) }); } };
    if (dtype) opts.dtype = dtype;
    await pipeline('automatic-speech-recognition', model, opts);
    send({ done: true, text: '', segments: [] });
    process.exit(0);
  }
  const raw = fs.readFileSync(audioPath);
  const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  if (audio.length < 16000 * 0.5) { send({ done: true, text: '', segments: [] }); process.exit(0); }
  send({ status: 'loading model' });
  const t0 = Date.now();
  const opts = { progress_callback: (p) => { if (p.status === 'progress') send({ download: Math.round(p.progress) }); } };
  if (dtype) opts.dtype = dtype;
  if (device) opts.device = device;
  const asr = await pipeline('automatic-speech-recognition', model, opts);
  const loadMs = Date.now() - t0;
  send({ status: 'transcribing' });
  const out = await asr(audio, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
  const segments = (out.chunks || []).map((c) => ({
    start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? c.timestamp[0] ?? 0, text: c.text.trim(),
  })).filter((s) => s.text);
  // Phase 3 (edit by transcript): a second pass with per-word timestamps, in the same process so the model is loaded once. SPOOL_WORDS=1 turns it on.
  let words;
  if (process.env.SPOOL_WORDS) {
    send({ status: 'timing every word' });
    const w = await asr(audio, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 });
    words = (w.chunks || []).map((c) => ({ w: c.text.trim(), s: +(c.timestamp[0] ?? 0).toFixed(3), e: +(c.timestamp[1] ?? c.timestamp[0] ?? 0).toFixed(3) })).filter((x) => x.w);
  }
  send({ done: true, text: out.text.trim(), segments, words, loadMs, asrMs: Date.now() - t0 - loadMs });
  process.exit(0);
} catch (e) {
  send({ error: String(e && e.stack || e) });
  process.exit(1);
}
