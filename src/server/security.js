// B5: protection against other websites poking the local server.
// "Owner" means the request came from this machine, so any web page open in the user's browser could send a simple cross-site POST to
// http://localhost:4747 and be treated as the owner. Two layers stop that:
//   1. every write must come from our own origin (Fetch Metadata, or an Origin header equal to the server's own host),
//   2. owner-only writes must also carry the per-launch token, which only our own pages can read (/api/me answers cross-origin readers with nothing).
const crypto = require('crypto');

const TOKEN = crypto.randomBytes(24).toString('hex'); // new on every launch
const HEADER = 'x-spool-csrf';

// R1: proof that a loopback request comes from the owner and not from something tunnelling raw TCP to this port. The cookie value is a random
// per-launch secret. Only a one-time login link, created by the app itself and opened in the owner's browser, can set it.
// The cookie name carries the port (`sp_owner_4747`): browsers share cookies between every port of `localhost`, so without it a dev server on :3000
// could overwrite our cookie (or ours its own). The name does not stop a browser from sending the value to that other server; it is HttpOnly
// and changes on every launch, which is what limits the exposure.
const OWNER_COOKIE = 'sp_owner';
const portOf = (host) => (/:(\d+)$/.exec(String(host || '')) || [])[1] || '80';
const ownerCookieName = (host) => `${OWNER_COOKIE}_${portOf(host)}`;
const OWNER_SECRET = crypto.randomBytes(24).toString('hex');
function ownerCookieOk(value) {
  if (typeof value !== 'string' || value.length !== OWNER_SECRET.length) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(OWNER_SECRET));
}
const ownerCookie = (host) => `${ownerCookieName(host)}=${OWNER_SECRET}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;
const codes = new Map(); // one-time login codes -> expiry
const CODE_TTL_MS = 120_000;
function newLoginCode(now = Date.now()) {
  for (const [c, t] of codes) if (t < now) codes.delete(c);
  const code = crypto.randomBytes(18).toString('hex'); codes.set(code, now + CODE_TTL_MS); return code;
}
function redeemLoginCode(code, now = Date.now()) {
  const t = codes.get(String(code)); codes.delete(String(code));
  return t !== undefined && t >= now;
}
// Where the app sends the owner: /owner-login redeems the code (once), sets the cookie and redirects to `to`.
const ownerLoginPath = (to = '/') => `/owner-login?code=${newLoginCode()}&to=${encodeURIComponent(to)}`;
const safeNext = (to) => (typeof to === 'string' && /^\/(?![/\\])/.test(to) ? to : '/');
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

// R10: wrong-password lockout per video and address. After 5 misses the address waits 30 s, doubling each further miss up to 15 min, so a guess loop
// costs hours instead of the ~7,000 tries an hour the plain rate limit allowed. The unlock route also uses the async scrypt, so a guess never blocks the server.
function lockout({ now = Date.now, free = 5, base = 30_000, max = 900_000 } = {}) {
  const m = new Map();
  return {
    wait(key) { const e = m.get(key); return e && e.until > now() ? Math.ceil((e.until - now()) / 1000) : 0; },
    fail(key) { const e = m.get(key) || { n: 0, until: 0 }; e.n++; if (e.n >= free) e.until = now() + Math.min(max, base * 2 ** (e.n - free)); m.set(key, e); },
    ok(key) { m.delete(key); },
  };
}

module.exports = { lockout, OWNER_COOKIE, ownerCookieName, ownerCookieOk, ownerCookie, newLoginCode, redeemLoginCode, ownerLoginPath, safeNext, rateLimit, TOKEN, HEADER, SAFE, sameOrigin, tokenOk, guardWrites, guardSameOrigin };
