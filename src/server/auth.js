// Who is asking? "Owner" = this machine (loopback, not proxied, not "view as viewer"); everyone else is a viewer
// and only ever sees what the link's privacy settings allow.
const crypto = require('crypto');
const store = require('../store');

const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const LOOP = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isOwner(req) {
  if (!LOOP.has(req.socket.remoteAddress)) return false;
  if (req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']) return false; // reverse proxy / tunnel
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return false;
  if (cookies(req).sp_asviewer === '1') return false;
  return true;
}
const requireOwner = (req, res, next) => (isOwner(req) ? next() : res.status(403).json({ error: 'owner only' }));

function secret() {
  const s = store.load().settings;
  if (s.secret) return s.secret;
  const v = crypto.randomBytes(24).toString('hex'); store.setSettings({ secret: v }); return v;
}
const hashPw = (pw) => { const salt = crypto.randomBytes(8).toString('hex'); return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`; };
const checkPw = (pw, h) => { if (!h) return false; const [salt, hex] = h.split(':'); const t = crypto.scryptSync(String(pw), salt, 32); const b = Buffer.from(hex, 'hex'); return b.length === t.length && crypto.timingSafeEqual(b, t); };
const token = (v) => crypto.createHmac('sha256', secret()).update(v.id + (v.privacy?.passwordHash || 'x') + (v.privacy?.mode || '')).digest('hex').slice(0, 32);

const effectivePrivacy = (v) => {
  const s = store.getSettings(), p = v.privacy || {};
  const mode = p.mode || s.defaultPrivacy || 'link';
  let expiresAt = p.expiresAt || 0;
  if (!expiresAt && s.linkExpiryDays > 0) expiresAt = v.createdAt + s.linkExpiryDays * 86400000;
  return { mode, expiresAt, allowDownload: p.allowDownload !== false && !s.disableDownloads, passwordHash: p.passwordHash };
};

// 'ok' or the reason a viewer is blocked: 'private' | 'expired' | 'password' | 'email'
function access(req, v) {
  if (isOwner(req)) return 'ok';
  const p = effectivePrivacy(v);
  if (p.mode === 'private') return 'private';
  if (p.expiresAt && Date.now() > p.expiresAt) return 'expired';
  if (p.mode === 'password' || p.mode === 'email') return cookies(req)['sp_' + v.id] === token(v) ? 'ok' : p.mode;
  return 'ok';
}
const unlockCookie = (v) => `sp_${v.id}=${token(v)}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`;

module.exports = { isOwner, requireOwner, cookies, hashPw, checkPw, effectivePrivacy, access, unlockCookie };
