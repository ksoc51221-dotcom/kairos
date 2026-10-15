// Thin client for a local Ollama server. All agent "brains" go through here.
const URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
let MODEL = process.env.SPOOL_MODEL || 'qwen3:8b';

async function available() {
  try { const r = await fetch(`${URL}/api/tags`, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
}
const setModel = (m) => { MODEL = m; };

// Returns parsed JSON. Retries once with a stricter reminder if the model returns junk.
async function json({ system, user, schema, temperature = 0.2 }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${URL}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, stream: false, think: false, format: schema || 'json',
        options: { temperature, num_ctx: 8192 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user + (attempt ? '\n\nReturn ONLY valid JSON.' : '') }],
      }),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    try { return JSON.parse(data.message.content); } catch { /* retry */ }
  }
  throw new Error('model did not return valid JSON');
}
module.exports = { available, json, setModel, get model() { return MODEL; } };
