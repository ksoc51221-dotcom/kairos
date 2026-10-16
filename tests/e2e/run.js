#!/usr/bin/env node
// End-to-end acceptance runner. Starts the real app in self-test mode, records a short scripted scenario, measures the files with the
// bundled ffmpeg and prints PASS/FAIL per check with the measured numbers. Screen scenarios capture the real screen, so:
//   - frames are only ever read as numbers (pixels.js), never looked at
//   - the whole capture folder is deleted at the end (pass --keep to keep it)
//   node tests/e2e/run.js [acceptance|cam|all] [--keep]
// Run unattended with `caffeinate -d -i node tests/e2e/run.js ...`: if the display sleeps, capture stops and runs hang for minutes.
// Needs macOS Screen Recording permission for the app that launches it (the same one `npm start` uses).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { probe } = require('./probe');
const { sampleRegions, fractionMatching, lumaStd, near } = require('./pixels');
const { readTimeline, segmentInputs } = require(path.join(root, 'src/pipeline/segments'));
const { buildComposite } = require(path.join(root, 'src/pipeline/composite'));
const { runFfmpeg } = require(path.join(root, 'src/pipeline/encode'));
const { ensureMask } = require(path.join(root, 'src/pipeline/masks'));

const keep = process.argv.includes('--keep');
const which = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'all';

// Scenario "acceptance" is PLAN.md Phase 1: 10 s screen + cam, pause at 3 s, resume at 4 s, rewind to 2 s.
// The rewind (a pause + trim) is issued at 6 s. What survives: segment 0 trimmed to 2.0 s, segment 1 dropped, then a new segment from 6 s
// to the stop at 10 s: 2.0 + 4.0 = 6.0 s of recording.
const SCENARIOS = {
  acceptance: { config: { mode: 'screen-cam', seconds: 10, script: [[3000, 'pause'], [4000, 'resume'], [6000, 'rewind', 2]], patch: true, guards: true }, expected: 6.0, screen: true },
  // The same recording on whatever is on the screen right now (no noise patch): reported, not judged, because a mostly still desktop
  // legitimately produces fewer frames and far fewer bits than the acceptance numbers ask for.
  idle: { config: { mode: 'screen-cam', seconds: 5 }, expected: 5.0, screen: true, informational: true },
  cam: { config: { mode: 'cam', seconds: 3 }, expected: 3.0, screen: false },
  // Records one of the test's own windows as a window source (no screen content at all). Also covers: the default bottom-left bubble for window
  // recordings, the pen overlay being created lazily and logged (B20), the pause shortcut path toggle-pause (B9), and no cursor feed for windows.
  // 4 s with a 0.5 s pause (toggle-pause at 2.5 s and 3.0 s) is 3.5 s of recording.
  window: { config: { mode: 'screen-cam', seconds: 4, windowSource: 'patch', patch: true, script: [[1000, 'pen'], [1400, 'notes'], [1800, 'notes'], [2000, 'pen'], [2500, 'toggle-pause'], [3000, 'toggle-pause']] }, expected: 3.5, screen: true, window: true, informational: true },
  // Starts through the real launcher window (preferences seeded, quality chosen from the Quality panel, Start clicked): the launcher -> IPC -> session path.
  ui: { config: { ui: { quality: '1080p' }, seconds: 3 }, expected: 3.0, screen: true, ui: true, informational: true },
  // PLAN.md Phase 2: 24 s Screen + Cam through the whole pipeline (Privacy Guard and the AI crew are on). A window with a fake e-mail address and a fake API
  // key is on screen, next to the noise patch, so the published file must have both blurred. Stage timings come from the video record in db.json.
  pipeline: { config: { mode: 'screen-cam', seconds: 24, quality: '1080p', patch: true, secrets: true }, expected: 24.0, screen: true, pipeline: true, informational: true },
};

// B28: the frontmost app must be the same before and after a run (Iris never takes focus unless the user opens one of its windows).
// `lsappinfo` needs no Automation permission, unlike System Events.
const { execFileSync } = require('child_process');
const frontApp = () => { try { const asn = execFileSync('lsappinfo', ['front']).toString().trim(); return execFileSync('lsappinfo', ['info', '-only', 'name', asn]).toString().trim(); } catch { return null; } };

const results = [];
const f = (x, d = 2) => (x == null || Number.isNaN(x) ? 'n/a' : (+x).toFixed(d));
function check(name, ok, detail = '') { results.push({ name, ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); }

function runApp(scenario, dataDir) {
  return new Promise((resolve, reject) => {
    const electron = require('electron'); // from Node this is the path of the Electron binary
    const env = { ...process.env, SPOOL_DATA: dataDir, SPOOL_PORT: '4799', ...(scenario.pipeline ? {} : { SPOOL_SKIP_AI: '1' }), SPOOL_SELFTEST: JSON.stringify(scenario.config) };
    const p = spawn(electron, ['.'], { cwd: root, env });
    let buf = '', result = null, tail = ''; const logLines = [];
    const onData = (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); tail = (tail + line + '\n').slice(-3000); if (/ (pipeline|privacy) /.test(line)) { logLines.push(line.replace(/^\S+ /, '')); } if (line.startsWith('SELFTEST_RESULT ')) result = JSON.parse(line.slice(16)); } };
    p.stdout.on('data', onData); p.stderr.on('data', (d) => { tail = (tail + d).slice(-3000); });
    const killer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('app did not finish in time\n' + tail)); }, (scenario.config.seconds + (scenario.pipeline ? 330 : 150)) * 1000);
    p.on('close', () => { clearTimeout(killer); if (result) result.logLines = logLines; result ? resolve(result) : reject(new Error('no SELFTEST_RESULT line from the app\n' + tail)); });
  });
}

const sum = (a) => a.reduce((x, y) => x + y, 0);

async function acceptance(name, scenario, dataDir) {
  console.log(`\n== ${name}: ${JSON.stringify(scenario.config)}`);
  let held = 0; // polls (100 ms each) during which Iris itself was the frontmost app
  const frontBefore = frontApp(), seen = new Set(), poll = setInterval(() => { const a = frontApp(); if (a) { seen.add(a); if (/spool|electron/i.test(a)) held++; } }, 100); // every app that was frontmost during the run
  if (scenario.pipeline) { // reuse the models the real app already downloaded and the compiled Vision tool, instead of fetching 150 MB into a throwaway folder
    const real = path.join(os.homedir(), 'Library', 'Application Support', 'spool', 'models');
    fs.mkdirSync(dataDir, { recursive: true }); if (fs.existsSync(real)) fs.symlinkSync(real, path.join(dataDir, 'models'));
  }
  const r = await runApp(scenario, dataDir);
  clearInterval(poll); const frontAfter = frontApp();
  // The pass condition is that Iris itself never became the frontmost app. (Comparing before/after alone also fails when the user, or another
  // session, switches apps while the run is going: that is not Iris taking focus.)
  const mine = [...seen].filter((n) => /spool|electron/i.test(n));
  if (frontBefore && frontAfter) check(scenario.ui ? 'B28: Iris held focus only for the launcher the test opens (at most 1 s)' : 'B28: Iris never became the frontmost app during the run', scenario.ui ? held <= 10 : mine.length === 0, `spool frontmost ${held * 100} ms; frontmost during the run: ${[...seen].map((n) => n.replace(/^"LSDisplayName"=/, '')).join(', ') || 'n/a'}; before ${frontBefore}, after ${frontAfter}`);
  const dir = r.dir, tl = r.timeline, scale = r.display.scaleFactor, expected = scenario.expected;
  console.log(`  display ${r.display.width}x${r.display.height} @${scale}x  mime ${tl.mime}  audio ${tl.audio}  segments ${tl.segments.map((s) => `#${s.n}:${f(s.dur)}s`).join(' ')}`);

  // ---- raw tracks ----
  const kept = tl.segments.filter((s) => s.dur >= 0.5 && (scenario.screen ? s.screen : s.cam));
  const info = {};
  for (const s of kept) info[s.n] = probe(path.join(dir, scenario.screen ? s.screen : s.cam));
  const main = kept.reduce((a, b) => (b.dur > a.dur ? b : a), kept[0]), m = info[main.n];
  if (scenario.screen) {
    const nw = Math.round(r.display.width * scale), nh = Math.round(r.display.height * scale);
    console.log(`  main segment #${main.n} (${f(main.dur)} s): ${m.video.codec} ${m.video.width}x${m.video.height}  ${m.frames} frames  ${f(m.avgFps, 1)} fps  ${f(m.bitrateMbps, 1)} Mb/s  gaps mean ${f(m.ptsDeltaMs.mean)} std ${f(m.ptsDeltaMs.std)} max ${f(m.ptsDeltaMs.max)} p99 ${f(m.ptsDeltaMs.p99)} ms`);
    for (const s of kept) if (s.n !== main.n) { const i = info[s.n]; console.log(`  segment #${s.n} (${f(s.dur)} s): ${i.video.width}x${i.video.height}  ${f(i.avgFps, 1)} fps  ${f(i.bitrateMbps, 1)} Mb/s  gap std ${f(i.ptsDeltaMs.std)} ms`); }
    if (scenario.window) { const pw = Math.round(r.patch.w * scale), ph = Math.round(r.patch.h * scale);
      check('window recording captures just that window, at its native pixel size', Math.abs(m.video.width - pw) <= 8 && Math.abs(m.video.height - ph) <= 8 && m.video.width < nw, `${m.video.width}x${m.video.height} vs window ${pw}x${ph}, display ${nw}x${nh}`); }
    else check('screen intermediate is native resolution', m.video.width === nw && m.video.height === nh, `${m.video.width}x${m.video.height} vs ${nw}x${nh}`);
    if (scenario.informational) console.log(`  INFO  on the live desktop: ${f(m.avgFps, 1)} fps, ${f(m.bitrateMbps, 2)} Mb/s, gap std ${f(m.ptsDeltaMs.std)} ms, max gap ${f(m.ptsDeltaMs.max)} ms`);
    else {
      for (const s of kept) { const i = info[s.n]; // judged on every kept segment, not just the best one
        check(`segment #${s.n}: avg frame rate >= 55 fps`, i.avgFps >= 55, `${f(i.avgFps, 1)} fps`);
        check(`segment #${s.n}: bitrate >= 12 Mb/s (noise patch on screen = worst-case content)`, i.bitrateMbps >= 12, `${f(i.bitrateMbps, 1)} Mb/s`);
        check(`segment #${s.n}: frame pacing, pts-delta std < 4 ms`, i.ptsDeltaMs.std < 4, `std ${f(i.ptsDeltaMs.std)} ms, mean ${f(i.ptsDeltaMs.mean)} ms, max ${f(i.ptsDeltaMs.max)} ms`); }
    }
    if (!scenario.config.ui) check('screen file carries audio', !!m.audio, m.audio ? `${m.audio.codec} ${m.audio.rate} Hz` : 'no audio stream');
    if (!scenario.window) check('timeline records the native size', tl.screen.width === nw && tl.screen.height === nh, `${tl.screen.width}x${tl.screen.height}`);
  } else {
    console.log(`  camera segment #${main.n}: ${m.video.codec} ${m.video.width}x${m.video.height}  ${f(m.avgFps, 1)} fps  ${f(m.bitrateMbps, 1)} Mb/s`);
    check('camera-only track has video and audio', !!m.video && !!m.audio, `${m.video.width}x${m.video.height}`);
  }

  // ---- durations ----
  const trimmed = sum(kept.map((s) => Math.min(s.dur, info[s.n].videoSeconds || s.dur)));
  const vid = probe(path.join(dir, 'video.mp4'));
  const outSec = vid.containerDuration ?? vid.videoSeconds;
  check(`timeline duration within 0.15 s of expected ${f(expected, 1)} s`, Math.abs(tl.duration - expected) <= 0.15, `${f(tl.duration, 3)} s`);
  check('sum of raw segment media (trimmed to their length) within 0.15 s of expected', Math.abs(trimmed - expected) <= 0.15, `${f(trimmed, 3)} s`);
  check('published video duration within 0.15 s of expected', Math.abs(outSec - expected) <= 0.15, `${f(outSec, 3)} s`);

  // ---- overlays must not be in the screen track ----
  if (scenario.screen && r.guards.length) {
    const times = [1.0, 1.6].filter((t) => t < main.dur - 0.2);
    const isGreen = (rr, g, b) => rr < 70 && g > 190 && b < 70;
    for (const g of r.guards) {
      const o = r.overlays && r.overlays[g.name], inside = o && o.bounds.x <= g.rect.x + 1 && o.bounds.y <= g.rect.y + 1 && o.bounds.x + o.bounds.w >= g.rect.x + g.rect.w - 1 && o.bounds.y + o.bounds.h >= g.rect.y + g.rect.h - 1;
      check(`${g.name} overlay was on screen over its guard at the end of capture (so the guard test is not vacuous)`, !!o && o.visible && inside, o ? `visible ${o.visible}, window ${Math.round(o.bounds.w)}x${Math.round(o.bounds.h)} at ${Math.round(o.bounds.x)},${Math.round(o.bounds.y)}` : 'window missing');
      const inset = 6, rect = { x: Math.round(g.rect.x * scale) + inset, y: Math.round(g.rect.y * scale) + inset, w: Math.round(g.rect.w * scale) - 2 * inset, h: Math.round(g.rect.h * scale) - 2 * inset };
      const fr = times.map((t) => fractionMatching(path.join(dir, main.screen), t, rect, isGreen));
      const mean = sampleRegions(path.join(dir, main.screen), times[0], [rect])[0];
      check(`${g.name} is not in the screen track (flat guard window visible instead)`, fr.every((x) => x != null && x >= 0.99), `${fr.map((x) => f(x * 100, 1) + '%').join(' / ')} green, mean rgb ${mean ? `${mean.r},${mean.g},${mean.b}` : 'n/a'}`);
    }
    if (r.patch) {
      const p = { x: Math.round(r.patch.x * scale) + 8, y: Math.round(r.patch.y * scale) + 8, w: Math.round(r.patch.w * scale) - 16, h: Math.round(r.patch.h * scale) - 16 };
      const c = sampleRegions(path.join(dir, main.screen), times[0], [p])[0];
      check('capture works: the noise patch is in the track (not green, not black)', !!c && !isGreen(c.r, c.g, c.b) && c.r + c.g + c.b > 150, c ? `mean rgb ${c.r},${c.g},${c.b}` : 'unreadable');
    }
  }

  // ---- composite ----
  const wantW = scenario.screen ? Math.round(r.display.width * scale) : null;
  console.log(`  published video: ${vid.video.codec} ${vid.video.width}x${vid.video.height}  ${f(vid.avgFps, 1)} fps  ${f(vid.bitrateMbps, 1)} Mb/s${vid.audio ? '  + ' + vid.audio.codec : ''}`);
  if (scenario.ui) {
    check('launcher start: Screen mode, 1080p preset, no audio (mic off)', tl.mode === 'screen' && tl.quality === '1080p' && tl.audio === false, `mode ${tl.mode}, quality ${tl.quality}, audio ${tl.audio}`);
    check('launcher start: published video is 1080 high and 60 fps', vid.video.height === 1080 && vid.avgFps >= 55, `${vid.video.width}x${vid.video.height} @ ${f(vid.avgFps, 1)} fps, ${f(vid.bitrateMbps, 1)} Mb/s`);
  } else if (scenario.window) {
    const b0 = tl.bubble[0] || [];
    check('window recording: bubble space is the frame, default keyframe bottom-left', tl.bubbleSpace === 'frame' && Math.abs(b0[1] - 0.02) < 0.001 && b0[2] > 0.6 && b0[2] < 0.75, `space ${tl.bubbleSpace}, keyframe ${JSON.stringify(b0)}`);
    check('window recording: no cursor feed (nothing to map it to)', tl.cursorSamples === 0, `${tl.cursorSamples} samples`);
    check('pen: created lazily, logged as on then off (B20)', tl.drawing.length === 2 && tl.drawing[0][1] === 1 && tl.drawing[1][1] === 0, JSON.stringify(tl.drawing));
    check('toggle-pause shortcut path: two segments, 0.5 s left out (B9)', tl.segments.length === 2, `${tl.segments.length} segments, durations ${tl.segments.map((x) => f(x.dur)).join(' + ')} s`);
    const H = vid.video.height, W_ = vid.video.width, rg = { x: Math.round(W_ * 0.02 + 0.28 * H * 0.5 - 6), y: Math.round(H * 0.69 + 0.28 * H * 0.34), w: 12, h: 12 };
    const c = sampleRegions(path.join(dir, 'video.mp4'), 0.8, [rg])[0];
    check('window recording: camera bubble composited bottom-left', near(c, [242, 201, 160], 45), c ? `mean rgb ${c.r},${c.g},${c.b} vs skin 242,201,160` : 'unreadable');
  } else if (scenario.screen) {
    if (!scenario.pipeline) check('published video keeps the native size at Source quality', vid.video.width === wantW, `${vid.video.width}x${vid.video.height}`);
    check('published video is 60 fps', vid.avgFps >= 55, `${f(vid.avgFps, 1)} fps`);
    const bub = r.guards.find((g) => g.name === 'bubble');
    if (bub) { // the fake camera's forehead is skin-coloured: it must be where the live bubble was
      const rg = { x: Math.round((bub.rect.x + bub.rect.w * 0.5 - 6) * scale), y: Math.round((bub.rect.y + bub.rect.h * 0.34) * scale), w: 12, h: 12 };
      const c = sampleRegions(path.join(dir, 'video.mp4'), 1.0, [rg])[0];
      check('camera bubble is composited where the live bubble was', near(c, [242, 201, 160], 40), c ? `mean rgb ${c.r},${c.g},${c.b} vs skin 242,201,160` : 'unreadable');
    }
  }
  if (!scenario.config.ui) check('published video has audio', !!vid.audio);

  // ---- re-composite the same real tracks at the quality presets (no new screen capture) ----
  if (scenario.screen && !scenario.window && !scenario.ui && !scenario.informational) {
    const manifest = readTimeline(dir), inputs = segmentInputs(dir, manifest);
    for (const q of ['1080p', '720p']) {
      const out = path.join(dir, `preset_${q}.mp4`);
      const plan = buildComposite(manifest, inputs, { out, quality: q, maskPath: (s, w, h) => ensureMask(path.join(dir, 'masks'), s, w, h) });
      const t0 = Date.now(); await runFfmpeg(plan.args, { duration: plan.total }); const took = (Date.now() - t0) / 1000;
      const p = probe(out), want = +q.replace('p', '');
      check(`${q} preset: height ${want}, even width, ${f(plan.total, 1)} s long`, p.video.height === want && p.video.width % 2 === 0 && Math.abs((p.containerDuration ?? p.videoSeconds) - plan.total) <= 0.15, `${p.video.width}x${p.video.height}, ${f(p.bitrateMbps, 1)} Mb/s, composite took ${f(took, 1)} s`);
    }
  }

  // ---- the whole pipeline (Phase 2) ----
  if (scenario.pipeline) {
    const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'library', 'db.json'), 'utf8')), v = db.videos[r.id], T = v.timings || {};
    console.log(`  stage timings (since Stop): ${Object.entries(T).map(([k, x]) => `${k} ${f(x / 1000, 1)}s`).join(', ')}`);
    for (const l of r.logLines) if (/^privacy /.test(l)) console.log('  ' + l);
    check('Stop -> owner can press play within 8 s', T.readyForOwner <= 8000, `${f(T.readyForOwner / 1000, 1)} s (composite ${f(T.composite / 1000, 1)} s, thumbnail ${f(T.thumbnail / 1000, 1)} s)`);
    check('Privacy Guard cleared the video within 20 s of Stop', T.shareable <= 20000, `${f(T.shareable / 1000, 1)} s (scan ${f(T.privacyScan / 1000, 1)} s${T.privacyBlur ? `, blur pass ${f(T.privacyBlur / 1000, 1)} s` : ''})`);
    check('AI notes finished within 60 s of Stop', T.total <= 60000, `${f(T.total / 1000, 1)} s total, transcribe ${f((T.transcribe || 0) / 1000, 1)} s, agents ${f((T.ai || 0) / 1000, 1)} s`);
    check('video is cleared for viewers (shareable) and finished', v.shareable === true && v.pipe === 'done' && v.status === 'ready', `shareable ${v.shareable}, pipe ${v.pipe}, status ${v.status}`);
    const types = (v.redactions || []).map((x) => x.type);
    check('Privacy Guard found the fake e-mail address and the fake API key', types.includes('email') && types.includes('api key'), `found: ${types.join(', ') || 'nothing'}`);
    check('published video: 1080 high, >= 8 Mb/s, 60 fps, one encode generation', vid.video.height === 1080 && vid.bitrateMbps >= 8 && vid.avgFps >= 55, `${vid.video.width}x${vid.video.height}, ${f(vid.bitrateMbps, 1)} Mb/s, ${f(vid.avgFps, 1)} fps`);
    const sc = r.display.scaleFactor, k = vid.video.height / (r.display.height * sc); // published pixels per display point
    for (const sec of r.secrets) {
      const rg = { x: Math.max(0, Math.round(sec.rect.x * sc * k)), y: Math.max(0, Math.round(sec.rect.y * sc * k)), w: Math.max(8, Math.round(sec.rect.w * sc * k)), h: Math.max(8, Math.round(sec.rect.h * sc * k)) };
      const raw = lumaStd(path.join(dir, main.screen), 6, { x: Math.round(sec.rect.x * sc), y: Math.round(sec.rect.y * sc), w: Math.round(sec.rect.w * sc), h: Math.round(sec.rect.h * sc) });
      const out = lumaStd(path.join(dir, 'video.mp4'), 6, rg);
      check(`the ${sec.name} text is blurred in the published file (luma std ${f(raw, 0)} raw, ${f(out, 0)} published)`, raw != null && out != null && raw > 40 && out < raw * 0.5 && out < 15, `raw ${f(raw, 1)} -> published ${f(out, 1)}; fully covered means a luma std under 15 (a solid fill measures about 6, half-covered text 50+)`);
    }
    check('sample frames and working files are gone', !fs.existsSync(path.join(dir, 'work')) && !fs.existsSync(path.join(dir, 'video.blur.mp4')) && !fs.existsSync(path.join(dir, 'original.mp4')), 'work/, video.blur.mp4, original.mp4 absent');
    check('no unblurred copy kept (B16)', !fs.existsSync(path.join(dir, 'original.mp4')));
  }

  // ---- timeline ----
  const st = tl.stats.cursor;
  if (scenario.screen) {
    if (scenario.informational) console.log(`  INFO  cursor feed: ${st ? `${st.hz} Hz, worst gap ${st.maxGapMs} ms, ${st.lateTicks} late ticks` : 'no stats'}, ${tl.cursorSamples} samples stored`);
    else check('cursor sampled at ~60 Hz', st && st.hz >= 55, st ? `${st.hz} Hz over ${st.ticks} ticks, worst gap ${st.maxGapMs} ms, ${st.lateTicks} late` : 'no stats');
    if (!scenario.informational) check('timeline has a bubble keyframe and cursor samples', tl.bubbleKeyframes >= 1 && tl.cursorSamples >= 1, `${tl.bubbleKeyframes} keyframes, ${tl.cursorSamples} cursor samples, ${tl.clicks} clicks`);
  }
  console.log(`  chunks streamed to disk: ${tl.stats.chunks} (${f((tl.stats.bytes || 0) / 1e6, 1)} MB)`);
}

(async () => {
  const names = which === 'all' ? Object.keys(SCENARIOS) : [which];
  const base = fs.mkdtempSync(path.join(process.env.SPOOL_E2E_DIR || os.tmpdir(), 'spool-e2e-'));
  let crashed = null;
  try {
    for (const name of names) {
      if (!SCENARIOS[name]) throw new Error(`unknown scenario ${name} (try: ${Object.keys(SCENARIOS).join(', ')}, all)`);
      await acceptance(name, SCENARIOS[name], path.join(base, name));
    }
  } catch (e) { crashed = e; console.error('\nE2E ERROR:', e.stack || e.message); }
  finally {
    if (keep) console.log(`\ncaptures kept in ${base}`); else { fs.rmSync(base, { recursive: true, force: true }); console.log('\ncaptures deleted'); }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${crashed ? ' (run crashed)' : ''}`);
  process.exit(failed.length || crashed ? 1 : 0);
})();
