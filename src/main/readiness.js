// Finding 2 (PHASE4-CHECK): without the speech model the Privacy Guard cannot listen, so a new recording stays "only you can watch". That is the
// safe outcome but a bad surprise on stage. So the app checks its models at launch and every time the launcher opens, and says so before you record.
// Ollama is checked too: without it the title, summary and guide are skipped (the video itself is fine).
const transcribe = require('../agents/transcribe');
const llm = require('../agents/llm');

const MODEL_MB = 150;
let models = null, speech = { cached: true }, ollama = true, download = { state: 'idle', percent: 0, error: '' };
const listeners = new Set();
const emit = () => { for (const fn of listeners) fn(get()); };

function init(dir) { models = dir; }
const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
function get() {
  return { speechMissing: !speech.cached, mb: MODEL_MB, ollamaMissing: !ollama, download: { ...download },
    // the one-line text the launcher and the menu bar show; null when everything is in place
    warning: !speech.cached ? `The speech model is not downloaded (${MODEL_MB} MB). Recordings you make now stay “only you can watch” until it is.`
      : !ollama ? 'Ollama is not running, so titles, summaries and guides will be skipped.' : null };
}
async function refresh() {
  if (models) speech = transcribe.modelStatus(models);
  ollama = await llm.available().catch(() => false);
  emit(); return get();
}
// Starts the download (once); progress is in get().download. Resolves when it has finished or failed.
function startDownload() {
  if (!models || download.state === 'running') return Promise.resolve(get());
  download = { state: 'running', percent: 0, error: '' }; emit();
  return transcribe.downloadModel(models, (p) => { download.percent = p; emit(); })
    .then(() => { download = { state: 'done', percent: 100, error: '' }; }, (e) => { download = { state: 'error', percent: 0, error: e.message }; })
    .then(refresh);
}
module.exports = { init, refresh, get, startDownload, onChange, MODEL_MB };
