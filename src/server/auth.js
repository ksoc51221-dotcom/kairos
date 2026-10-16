// Who is asking? "Owner" = this machine (loopback, not proxied, not "view as viewer"); everyone else is a viewer
// and only ever sees what the link's privacy settings allow.
const crypto = require('crypto');
const store = require('../store');
const security = require('./security');

const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const LOOP = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MODES = ['link', 'password', 'email', 'private']; // R7: the only privacy modes there are. Anything else counts as 'private'.

// The request really comes from the owner's own machine (loopback, not through a proxy or tunnel, localhost host name)
function fromOwnerMachine(req) {
  if (!LOOP.has(req.socket.remoteAddress)) return false;
  if (req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']) return false; // reverse proxy / tunnel
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return false;
  return true;
}
// R1: loopback plus a Host header can be faked by anything that tunnels raw TCP to this port (ssh -R, ngrok tcp, socat, a default nginx on this Mac), so
// "owner" also needs the HttpOnly `sp_owner` cookie. Its value is a random per-launch secret that only a one-time login link (opened by the app
// itself, see security.ownerLoginUrl) hands out. A tunnel visitor never sees that link.
const hasOwnerCookie = (req) => security.ownerCookieOk(cookies(req)[security.OWNER_COOKIE]);
const ownerMachine = (req) => fromOwnerMachine(req) && hasOwnerCookie(req);
// B14: the owner switched on "preview as a viewer"
const previewingAsViewer = (req) => ownerMachine(req) && cookies(req).sp_asviewer === '1';
const isOwner = (req) => ownerMachine(req) && cookies(req).sp_asviewer !== '1';

// Owner-only route. Writes also need the per-launch token (B5), which only our own pages can read.
const SIGNIN_PAGE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spool</title><body style="font:16px/1.5 system-ui;max-width:34rem;margin:12vh auto;padding:0 1.2rem"><h2>Open Spool to sign in</h2><p>This page is for the owner. Choose <b>Open library</b> from the Spool icon in the menu bar: it signs this browser in for as long as Spool keeps running.</p><p style="color:#666">Why: so that nothing else that can reach this port, such as a tunnel or another program, can pass for you.</p>';
const requireOwner = (req, res, next) => {
  if (!isOwner(req)) {
    // a bookmark or an old tab (the sign-in is per launch): explain, instead of showing JSON
    if (req.method === 'GET' && fromOwnerMachine(req) && !hasOwnerCookie(req) && /text\/html/.test(req.headers.accept || '')) return res.status(403).type('html').send(SIGNIN_PAGE);
    return res.status(403).json({ error: 'owner only' });
  }
  if (!security.SAFE.has(req.method) && !security.tokenOk(req)) return res.status(403).json({ error: 'missing or wrong CSRF token' });
  next();
};

function secret() {
  const s = store.load().settings;
  if (s.secret) return s.secret;
  const v = crypto.randomBytes(24).toString('hex'); store.setSettings({ secret: v }); return v;
}
const hashPw = (pw) => { const salt = crypto.randomBytes(8).toString('hex'); return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`; };
const checkPw = (pw, h) => { if (!h) return false; const [salt, hex] = h.split(':'); const t = crypto.scryptSync(String(pw), salt, 32); const b = Buffer.from(hex, 'hex'); return b.length === t.length && crypto.timingSafeEqual(b, t); };
const checkPwAsync = (pw, h) => new Promise((resolve) => {
  if (!h) return resolve(false);
  const [salt, hex] = h.split(':'); if (!salt || !hex) return resolve(false);
  crypto.scrypt(String(pw), salt, 32, (err, t) => { const b = Buffer.from(hex, 'hex'); resolve(!err && b.length === t.length && crypto.timingSafeEqual(b, t)); });
});
const token = (v) => crypto.createHmac('sha256', secret()).update(v.id + (v.privacy?.passwordHash || 'x') + (v.privacy?.mode || '')).digest('hex').slice(0, 32);

const effectivePrivacy = (v) => {
  const s = store.getSettings(), p = v.privacy || {};
  const asked = p.mode || s.defaultPrivacy || 'link';
  const mode = MODES.includes(asked) ? asked : 'private'; // R7: a garbage or legacy mode must close the link, not open it
  let expiresAt = p.expiresAt || 0;
  if (!expiresAt && s.linkExpiryDays > 0) expiresAt = Number.isFinite(v.createdAt) ? v.createdAt + s.linkExpiryDays * 86400000 : 1; // no valid creation date: treat as expired
  return { mode, expiresAt, allowDownload: p.allowDownload !== false && !s.disableDownloads, passwordHash: p.passwordHash };
};

// 'ok' or the reason a viewer is blocked: 'failed' | 'checking' | 'private' | 'expired' | 'nopassword' | 'password' | 'email'
// 'checking' is the Privacy Guard gate: until it has cleared a recording (`shareable === true`), only the owner can watch it. Closed by default (R7):
// a record without the flag is not shareable. Videos from before the gate existed get the flag from a one-time migration in the store.
// 'failed' (R2): a recording whose processing failed may have a half-written, unblurred video.mp4 on disk, so it is never served to a viewer.
function access(req, v) {
  if (isOwner(req)) return 'ok';
  if (v.status === 'failed') return 'failed';
  if (v.shareable !== true) return 'checking';
  const p = effectivePrivacy(v);
  if (p.mode === 'private') return 'private';
  if (p.mode === 'password' && !p.passwordHash) return 'nopassword'; // B6: nothing could ever satisfy the gate, so say so instead of asking for a password
  if (p.expiresAt && Date.now() > p.expiresAt) return 'expired';
  if (p.mode === 'password' || p.mode === 'email') return cookies(req)['sp_' + v.id] === token(v) ? 'ok' : p.mode;
  return p.mode === 'link' ? 'ok' : 'private';
}
const unlockCookie = (v) => `sp_${v.id}=${token(v)}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`;

const GATE_STATUS = { checking: 423, private: 403, expired: 403, nopassword: 403, failed: 410 };

// Middleware for /api/v/:id/... and /media/:id/...: loads the video and applies the link's privacy settings.
const gated = (req, res, next) => {
  const v = store.get(req.params.id); if (!v) return res.status(404).json({ error: 'not found' });
  const a = access(req, v);
  if (a !== 'ok') return res.status(GATE_STATUS[a] || 401).json({ gate: a }); // R5: no title (LLM-written from the transcript) before the viewer is through the gate
  req.video = v; req.owner = isOwner(req); next();
};

module.exports = { MODES, GATE_STATUS, isOwner, fromOwnerMachine, previewingAsViewer, requireOwner, gated, cookies, hashPw, checkPw, checkPwAsync, effectivePrivacy, access, unlockCookie };
