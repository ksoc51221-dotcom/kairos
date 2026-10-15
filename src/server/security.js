// B5: protection against other websites poking the local server.
// "Owner" means the request came from this machine, so any web page open in the user's browser could send a simple cross-site POST to
// http://localhost:4747 and be treated as the owner. Two layers stop that:
//   1. every write must come from our own origin (Fetch Metadata, or an Origin header equal to the server's own host),
//   2. owner-only writes must also carry the per-launch token, which only our own pages can read (/api/me answers cross-origin readers with nothing).
const crypto = require('crypto');

const TOKEN = crypto.randomBytes(24).toString('hex'); // new on every launch
const HEADER = 'x-spool-csrf';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

// True when the request plausibly came from one of our own pages, from the address bar, or from a client that is not a browser.
// "same-site" is NOT accepted: another localhost port (a dev server) counts as same-site but is a different origin.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (origin !== undefined) { try { return new URL(origin).host === req.headers.host; } catch { return false; } } // "null" origins fail here too
  return true; // no browser headers at all: curl, tests, other tools. CSRF needs a browser.
}

function tokenOk(req) {
  const t = req.headers[HEADER];
  if (typeof t !== 'string' || t.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}

// App-wide: runs before any route. Reads and same-origin writes pass; cross-site writes get 403.
function guardWrites(req, res, next) {
  if (SAFE.has(req.method) || sameOrigin(req)) return next();
  res.status(403).json({ error: 'cross-site request blocked' });
}
// For GET routes that change state (the "view as viewer" cookie): same check, applied to navigations.
function guardSameOrigin(req, res, next) {
  if (sameOrigin(req)) return next();
  res.status(403).send('cross-site request blocked');
}

// B22: viewers on the LAN can write comments, reactions and heartbeats. A token bucket per address (20 writes, refilled at 2 a second, so a
// viewer's once-a-second heartbeat never runs dry) stops one machine from flooding the library. `skip(req)` exempts the owner.
function rateLimit({ burst = 20, perSec = 2, skip = () => false, now = Date.now } = {}) {
  const buckets = new Map();
  setInterval(() => { const t = now(); for (const [k, b] of buckets) if (t - b.at > 60000) buckets.delete(k); }, 60000).unref();
  return (req, res, next) => {
    if (skip(req)) return next();
    const key = req.socket.remoteAddress || '?', t = now(), b = buckets.get(key) || { tokens: burst, at: t };
    b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * perSec); b.at = t;
    if (b.tokens < 1) { buckets.set(key, b); res.setHeader('Retry-After', '5'); return res.status(429).json({ error: 'Too many requests, slow down' }); }
    b.tokens -= 1; buckets.set(key, b); next();
  };
}

module.exports = { rateLimit, TOKEN, HEADER, SAFE, sameOrigin, tokenOk, guardWrites, guardSameOrigin };
