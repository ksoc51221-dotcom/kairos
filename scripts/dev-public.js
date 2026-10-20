#!/usr/bin/env node
// Dev harness for public links: a fake Backblaze, the real Worker code, and a throw-away Kairos server with a few seeded videos, all on 127.0.0.1.
// Nothing real is touched. Usage: node scripts/dev-public.js   (prints the owner login URL and the Worker address; Ctrl-C to stop)
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/store');
const security = require('../src/server/security');
const { startServer } = require('../src/server/server');
const publisher = require('../src/publish/publisher');
const { runFfmpeg } = require('../src/pipeline/encode');
const { createFakeB2 } = require('../tests/unit/fake-b2');
const { startWorkerHost } = require('../tests/unit/worker-host');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-devpub-'));
  store.init(dir, { log: () => {} });
  const fake = await createFakeB2().start();
  const env = { B2_KEY_ID: 'read-key-id', B2_APP_KEY: 'read-key-secret', B2_BUCKET: fake.cfg.bucket, COOKIE_KEY: 'dev-cookie-key-dev-cookie-key', B2_AUTH_URL: fake.url, UNLOCK_DELAY_MS: '300' };
  const host = await startWorkerHost(env);
  publisher.deps.makeB2 = (c) => require('../src/publish/b2').createB2({ keyId: c.keyId, key: c.key, bucket: c.bucket, authUrl: fake.url, sleep: async () => {}, retries: 2 });
  store.setSettings({ integrations: { publish: { workerUrl: host.url, bucket: fake.cfg.bucket, accessId: 'write-key-id', appKey: 'write-key-secret' } } });

  const mp4 = path.join(dir, 'seed.mp4');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4]);
  const mk = (title, extra = {}) => { const v = store.create({ title, status: 'ready', shareable: true, guard: { model: true, speech: 'checked' }, duration: 8, width: 1280, height: 720, ...extra }); fs.copyFileSync(mp4, path.join(store.videoDir(v.id), 'video.mp4')); return v; };
  const ok = mk('Demo walkthrough'), priv = mk('Salary spreadsheet (private)', { privacy: { mode: 'private' } }), old = mk('Old recording, never scanned', { guard: undefined });
  const srv = startServer({ port: 0 }); const port = await srv.ready;
  const login = (to) => `http://127.0.0.1:${port}${security.ownerLoginPath(to)}`;
  console.log(`\nKairos (owner):    ${login(`/v/${ok.id}`)}\n  private video:   ${login(`/v/${priv.id}`)}\n  unscanned video: ${login(`/v/${old.id}`)}\n  settings:        ${login('/settings')}\nWorker (public):   ${host.url}\nFake Backblaze:    ${fake.url}\n\nCtrl-C to stop. Data is in ${dir}`);
  process.on('SIGINT', async () => { publisher.stop(); await srv.close(); await host.stop(); await fake.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); });
})().catch((e) => { console.error(e); process.exit(1); });
