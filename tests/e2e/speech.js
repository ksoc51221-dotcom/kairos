// R6 end to end, without Electron (no windows, no focus): a synthetic "upload" with a spoken password and PIN goes through the real pipeline
// (transcode -> Privacy Guard scan -> real Whisper -> speech guard -> bleep -> shareable), with the real models from the app's data folder.
// usage: node tests/e2e/speech.js          (needs macOS `say`; downloads nothing)
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const root = path.join(__dirname, '..', '..');
const store = require(path.join(root, 'src/store')), orchestrator = require(path.join(root, 'src/agents/orchestrator')), { ffmpeg } = require(path.join(root, 'src/pipeline/encode'));
const transcribe = require(path.join(root, 'src/agents/transcribe'));
const realData = process.env.SPOOL_REAL_DATA || path.join(os.homedir(), 'Library', 'Application Support', 'Spool');
const results = []; const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };
const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`${cmd} ${r.stderr.slice(-300)}`); return r; };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-speech-'));
  const lib = path.join(tmp, 'library'); store.init(lib, { log: () => {} });
  const SENTENCE = 'Hi team. To log in to the staging server, the password is correct horse battery staple. And the pin is four two one nine seven. Then click the deploy button.';
  run('say', ['-v', 'Samantha', '-o', path.join(tmp, 's.aiff'), SENTENCE]);
  const v = store.create({ title: 'Spoken secrets', source: 'upload', stage: 'Uploading' });
  const dir = store.videoDir(v.id), up = path.join(dir, 'upload.mp4');
  run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=s=1280x720:d=1', '-i', path.join(tmp, 's.aiff'), '-filter_complex', '[0:v]loop=loop=-1:size=1:start=0,fps=30[v]', '-map', '[v]', '-map', '1:a', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', up]);
  fs.writeFileSync(path.join(dir, 'segments.json'), JSON.stringify({ upload: 'upload.mp4' }));
  const settings = store.getSettings(); console.log(`privacyGuard ${settings.privacyGuard}, speechGuard ${settings.speechGuard}`);
  orchestrator.init(realData, { log: (...a) => /pipeline|privacy|bleep/.test(a.join(' ')) && console.log('  log:', ...a) });
  const t0 = Date.now(); await orchestrator.processVideo(v.id);
  const wait = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
  const cleared = await wait(() => store.get(v.id).shareable === true || /Privacy Guard (could|failed)/.test(store.get(v.id).stage || ''), 240000);
  const sinceStart = Date.now() - t0, r = store.get(v.id);
  await wait(() => r.pipe === 'done' || store.get(v.id).pipe === 'done', 120000);
  const f = store.get(v.id); console.log('timings', JSON.stringify(f.timings), 'stage', f.stage);
  console.log('transcript:', f.transcript);
  check('the video was cleared for viewers', cleared && f.shareable === true, `after ${(sinceStart / 1000).toFixed(1)} s`);
  check('the transcript has no spoken password or PIN', !/battery|staple|correct horse|four two one|421/i.test(f.transcript || '') && /\[bleep\]/.test(f.transcript || ''), (f.transcript || '').slice(0, 140));
  check('captions and word timings are clean too', !/battery|staple/i.test(JSON.stringify(f.segments)) && !/battery|staple/i.test(JSON.stringify(f.words || [])));
  check('the pipeline recorded the bleeps', (f.speechRedactions || []).length >= 1, JSON.stringify(f.speechRedactions));
  // the published audio, transcribed again: the secret must not be audible any more
  const again = await transcribe.transcribe(path.join(dir, 'video.mp4'), tmp, path.join(realData, 'models'), () => {}, null, {});
  console.log('re-transcribed published audio:', again.text);
  check('Whisper cannot hear the password or PIN in the published video', !/battery|staple|four two one|421/i.test(again.text), again.text.slice(0, 140));
  check('the rest of the speech survives', /deploy|staging|team/i.test(again.text));
  check('no leftovers in the video folder', !fs.existsSync(path.join(dir, 'work')) && !fs.existsSync(path.join(dir, 'video.blur.mp4')) && !fs.existsSync(path.join(dir, 'video.mute.mp4')));
  store.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length}/${results.length} passed`); process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
