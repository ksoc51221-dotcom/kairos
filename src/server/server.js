// Local "cloud": library + watch pages, viewer API, privacy gate, analytics, captions, upload, settings.
// This file only wires things together; the routes live in routes/{viewer,owner,media,library,settings}.js.
const express = require('express');
const store = require('../store');
const security = require('./security');
const extras = require('./extras');
const { pub } = require('./util');
const { processVideo } = require('../agents/orchestrator');
const publisher = require('../publish/publisher');
require('../agents/redact-job').deps.unpublish = (id, o) => publisher.unpublish(id, o); // Bleep speech takes a public link down; agents/ may not import the publisher itself

const routes = ['viewer', 'library', 'media', 'owner', 'settings', 'editor', 'actions', 'publish'].map((n) => require(`./routes/${n}`));

// port 0 picks a free port (tests). `ready` resolves once the server is listening, with the port it got.
function startServer({ port, host, models, openLauncher } = {}) {
  const app = express();
  let server, current = port;
  app.use(express.json({ limit: '4mb' }));
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!req.path.startsWith('/embed/')) res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // only the embed player may be framed by other sites
    next();
  });
  app.use(security.guardWrites); // B5: cross-site writes never reach a route
  app.use('/static', express.static(pub));

  const ctx = { models, openLauncher, get port() { return current; }, relisten: () => setTimeout(listen, 150) };
  routes.forEach((r) => r.mount(app, ctx));

  let resolveReady; const ready = new Promise((r) => { resolveReady = r; });
  function listen() {
    const bind = host || (store.getSettings().lan ? '0.0.0.0' : '127.0.0.1');
    const go = () => { server = app.listen(port, bind, () => { current = server.address().port; resolveReady(current); }); server.on('error', (e) => console.error('server', e.message)); };
    if (server) { server.closeAllConnections?.(); server.close(go); } else go(); // B11: close() waits for keep-alive and event-stream connections, so the switch to/from LAN could hang forever
  }
  listen();
  extras.startMaintenance();
  publisher.start(); // expiry sweep + retry of copies that could not be removed; does nothing until public links are set up
  return { app, ready, get server() { return server; }, close: () => new Promise((r) => { if (!server) return r(); server.closeAllConnections?.(); server.close(() => r()); }) };
}

module.exports = { startServer, processVideo };
