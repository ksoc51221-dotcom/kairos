// Test helper: serves cloud/worker.js over plain HTTP on 127.0.0.1, the way Cloudflare would, so the publisher's "Test" step can talk to it.
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

async function startWorkerHost(env) {
  const worker = (await import(pathToFileURL(path.join(__dirname, '../../cloud/worker.js')).href));
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const r = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      const out = await worker.default.fetch(r, env);
      const headers = {}; out.headers.forEach((v, k) => { headers[k] = v; });
      const cookies = out.headers.getSetCookie?.() || []; if (cookies.length) headers['set-cookie'] = cookies;
      res.writeHead(out.status, headers);
      if (out.body && req.method !== 'HEAD') { for await (const chunk of out.body) res.write(chunk); }
      res.end();
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, worker, stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
module.exports = { startWorkerHost };
