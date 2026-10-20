#!/usr/bin/env node
// Checks a real public link from the outside: the page opens, the video streams in ranges (phones need that), a made-up link is "not found",
// and the privacy headers are there. Usage: node scripts/public-check.js <link> [--password <pw>]
const crypto = require('crypto');

const args = process.argv.slice(2), link = args.find((a) => /^https?:\/\//.test(a)), pi = args.indexOf('--password'), password = pi >= 0 ? args[pi + 1] : null;
if (!link) { console.error('Usage: node scripts/public-check.js <link> [--password <pw>]'); process.exit(2); }
const u = new URL(link), origin = u.origin, id = u.pathname.split('/')[2];
let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; return c; };

(async () => {
  let r = await fetch(link, { redirect: 'manual' }); let html = await r.text(); let cookie = '';
  ok(r.status === 200, `page opens (HTTP ${r.status})`);
  for (const [h, want] of [['referrer-policy', 'no-referrer'], ['x-content-type-options', 'nosniff'], ['x-frame-options', 'DENY']]) ok(r.headers.get(h) === want, `header ${h}: ${r.headers.get(h)}`);
  ok(/noindex/.test(r.headers.get('x-robots-tag') || ''), `header x-robots-tag: ${r.headers.get('x-robots-tag')}`);
  if (/Password needed/.test(html)) {
    if (!password) { ok(false, 'the link needs a password: run again with --password <pw>'); return; }
    const salt = /data-salt="([0-9a-f]+)"/.exec(html)?.[1], iter = Number(/data-iter="(\d+)"/.exec(html)?.[1]);
    const dk = crypto.pbkdf2Sync(password.normalize('NFC'), Buffer.from(salt, 'hex'), iter, 32, 'sha256').toString('hex');
    const bad1 = await fetch(`${origin}/v/${id}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dk: '0'.repeat(64) }) }); await bad1.text();
    ok(bad1.status === 403, `a wrong password is refused (HTTP ${bad1.status})`);
    const v0 = await fetch(`${origin}/m/${id}/video.mp4`); await v0.arrayBuffer(); ok(v0.status === 401, `the video is not served without the password (HTTP ${v0.status})`);
    const un = await fetch(`${origin}/v/${id}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dk }) }); await un.text();
    if (!ok(un.status === 200, `the password unlocks it (HTTP ${un.status})`)) return;
    cookie = (un.headers.get('set-cookie') || '').split(';')[0];
    r = await fetch(link, { headers: { cookie } }); html = await r.text();
  }
  ok(/<video[^>]+src="\/m\//.test(html), 'the page has a video player');
  const hdr = cookie ? { cookie } : {};
  const a = await fetch(`${origin}/m/${id}/video.mp4`, { headers: { ...hdr, Range: 'bytes=0-99' } }); const ab = Buffer.from(await a.arrayBuffer());
  ok(a.status === 206 && /^bytes 0-99\/\d+$/.test(a.headers.get('content-range') || '') && ab.length === 100, `video streams in pieces (HTTP ${a.status}, ${a.headers.get('content-range')})`);
  ok(ab.subarray(4, 8).toString() === 'ftyp', 'it is an MP4 file');
  const total = Number((a.headers.get('content-range') || '').split('/')[1]);
  const t = await fetch(`${origin}/m/${id}/video.mp4`, { headers: { ...hdr, Range: `bytes=${Math.max(0, total - 50)}-` } }); const tb = await t.arrayBuffer();
  ok(t.status === 206 && tb.byteLength === Math.min(50, total), `the end of the video is reachable (HTTP ${t.status})`);
  const n = await fetch(`${origin}/v/${crypto.randomBytes(16).toString('base64url')}`); await n.text();
  ok(n.status === 404, `a made-up link says "not found" (HTTP ${n.status})`);
})().catch((e) => { ok(false, `could not reach ${origin}: ${e.cause?.code || e.message}`); }).finally(() => { console.log(bad ? `\n${bad} check(s) failed.` : '\nAll checks passed.'); process.exit(bad ? 1 : 0); });
