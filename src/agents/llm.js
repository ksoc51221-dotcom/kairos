// Thin client for a local Ollama server. All agent "brains" go through here.
const URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
let MODEL = process.env.SPOOL_MODEL || 'qwen3:8b';

async function available() {
  try { const r = await fetch(`${URL}/api/tags`, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
}
const setModel = (m) => { MODEL = m; };
// The models Ollama has pulled, so Settings can offer a choice and warn when the chosen one is missing. [] when Ollama is not running.
async function installed() {
  try { const r = await fetch(`${URL}/api/tags`, { signal: AbortSignal.timeout(2000) }); if (!r.ok) return []; const j = await r.json(); return (j.models || []).map((m) => m.name || m.model).filter(Boolean).sort(); } catch { return []; }
}

// Is the model already in memory? A cold qwen3:8b takes 5-20 s to load, which would eat the Privacy Guard's whole time budget for nothing.
async function loaded() {
  try { const r = await fetch(`${URL}/api/ps`, { signal: AbortSignal.timeout(1500) }); if (!r.ok) return false; const j = await r.json(); return (j.models || []).some((m) => m.name === MODEL || m.model === MODEL); } catch { return false; }
}
// Fire and forget: loads the model into memory and keeps it there for two hours, so it is warm by the time a recording has been processed.
async function warm() {
  try { if (await loaded() || !(await available())) return false; await fetch(`${URL}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, prompt: '', keep_alive: '2h' }), signal: AbortSignal.timeout(120_000) }); return true; } catch { return false; }
}

// B12: every request has a timeout, so a stalled Ollama cannot hang an agent (and everything queued behind it).
// Returns parsed JSON. Retries once, with a stricter reminder when the model returned junk, or plainly after a timeout. `retries: 0` = one try.
const TIMEOUT_MS = 120_000;
async function json({ system, user, schema, temperature = 0.2, timeoutMs = TIMEOUT_MS, retries = 1 }) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let r;
    try {
      r = await fetch(`${URL}/api/chat`, {
        signal: AbortSignal.timeout(timeoutMs),
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL, stream: false, think: false, format: schema || 'json',
          options: { temperature, num_ctx: 8192 },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user + (lastErr && lastErr.kind === 'junk' ? '\n\nReturn ONLY valid JSON.' : '') }],
        }),
      });
    } catch (e) { lastErr = Object.assign(new Error(e.name === 'TimeoutError' ? `ollama did not answer within ${Math.round(timeoutMs / 1000)} s` : `ollama: ${e.message}`), { kind: 'net' }); continue; }
    if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
    try { const data = await r.json(); return JSON.parse(data.message.content); } catch { lastErr = Object.assign(new Error('model did not return valid JSON'), { kind: 'junk' }); }
  }
  throw lastErr || new Error('model did not return valid JSON');
}
module.exports = { available, installed, loaded, warm, json, setModel, get model() { return MODEL; } };
