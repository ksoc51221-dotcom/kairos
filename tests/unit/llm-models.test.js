// The model picker in Settings: which Ollama models are installed, and what happens when Ollama is not running.
const test = require('node:test'), assert = require('node:assert/strict'), http = require('http');

test('installed() lists the pulled models, sorted; [] when Ollama is down', async () => {
  const srv = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:3b' }] })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_URL = `http://127.0.0.1:${srv.address().port}`;
  delete require.cache[require.resolve('../../src/agents/llm')];
  const llm = require('../../src/agents/llm');
  assert.deepEqual(await llm.installed(), ['llama3.2:3b', 'qwen3:8b']);
  await new Promise((r) => srv.close(r));
  assert.deepEqual(await llm.installed(), [], 'nothing listening: empty, not an error');
  delete process.env.OLLAMA_URL; delete require.cache[require.resolve('../../src/agents/llm')];
});
