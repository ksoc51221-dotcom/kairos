#!/usr/bin/env node
// Dev harness for the web UI: starts the REAL src/server on 127.0.0.1:$UI_PORT (default 4848) against a throw-away library, seeded with
// realistic videos in every state (ready, processing, checking, failed, screenshot, password / email / private / expired links, folders, spaces),
// so every page can be opened and screenshotted without Electron. Nothing leaves the machine and no AI model or queue is started (unless UI_QUEUE=1).
//
//   node scripts/dev-ui.js            (npm run dev:ui)      Ctrl-C stops it and deletes the temp library
//   UI_PORT=4900 node scripts/dev-ui.js                      another port (several harnesses can run side by side)
//   UI_KEEP=1 node scripts/dev-ui.js                         keep the temp library folder on exit
//   UI_QUEUE=1 node scripts/dev-ui.js                         also run the real job queue (ffmpeg, and the local model if Ollama is running), so Apply edits and
//                                                             Bleep speech really run instead of waiting for a queue that is not there
//   UI_FAKE_GH=1 node scripts/dev-ui.js                       pretend the gh tool is signed in and GitHub says "demo-user" (try the Share dialog's one-click setup);
//                                                             UI_FAKE_GH=nogh: no gh on this "Mac", any pasted token passes (one starting with "bad" fails). Never touches the real GitHub.
//
// Owner sign-in: the real one-time link (security.ownerLoginPath) lives 2 minutes and works once, so the harness adds three dev-only routes to its
// own copy of the app (never to src/server): GET /dev (index of every page), /dev/go/<key> (mints a fresh one-time code and redirects through the real
// /owner-login, so the sp_owner cookie is set exactly as in the app) and /dev/viewer/<key> (same page, seen as a viewer). /dev/urls.json lists them all.
if (process.env.UI_QUEUE) process.env.SPOOL_OCR = process.env.SPOOL_OCR || 'tesseract'; // the queue starts below: do not compile the Vision tool for a harness
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('../src/store');
const security = require('../src/server/security');
const auth = require('../src/server/auth');
const { startServer } = require('../src/server/server');
const { runFfmpeg } = require('../src/pipeline/encode');
const { detectSilences, silenceCuts, findFillers } = require('../src/pipeline/analyze');
const { buildActionPlan } = require('../src/agents/action-plan');
const { CREW } = require('../src/agents/orchestrator');

const PORT = Number(process.env.UI_PORT) || 4848, HOST = '127.0.0.1', KEEP = !!process.env.UI_KEEP;
const DAY = 86400000, HOUR = 3600000, GATE_PASSWORD = 'kairos-demo';
const r1 = (n) => Math.round(n * 10) / 10, r3 = (n) => Math.round(n * 1000) / 1000, r4 = (n) => Math.round(n * 10000) / 10000;
// the generated media is cached per version of this script, so a restart takes a second instead of ten
const CACHE = path.join(os.tmpdir(), 'kairos-devui-' + crypto.createHash('md5').update(fs.readFileSync(__filename)).digest('hex').slice(0, 8));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Seed media: a calm light "app window" drawn with ffmpeg (boxes + text), with a sine tone that is switched off for 3 s of every 20 s,
// so the silence detector has something real to find. No emoji, no external files.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const FONT = ['/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf'].find((f) => fs.existsSync(f));
const box = (x, y, w, h, c, en) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${c}:t=fill${en ? `:enable='${en}'` : ''}`;
const txt = (s, x, y, size, c, en) => (FONT ? `drawtext=fontfile=${FONT}:text='${s}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${c}${en ? `:enable='${en}'` : ''}` : '');
const ACCENT = '0x047857', INK = '0x0f172a', MUTE = '0x64748b', LINE = '0xcbd5e1';
const chain = (parts) => parts.filter(Boolean).join(',') + ',format=yuv420p';

function screenSrc({ dur, heading, phases, extra = [] }) {
  const p = [`color=c=0xf1f5f9:s=1280x720:r=30:d=${dur}`,
    box(0, 0, 1280, 56, '0xffffff'), box(0, 56, 1280, 1, LINE), box(24, 20, 16, 16, ACCENT), txt(heading, 56, 18, 22, INK),
    box(300, 100, 680, 520, LINE), box(301, 101, 678, 518, '0xffffff'),
    ...[180, 252, 324].flatMap((y) => [box(340, y, 600, 44, LINE), box(341, y + 1, 598, 42, '0xf8fafc')]),
    txt('Card number', 356, 194, 18, '0x94a3b8'), txt('Expiry', 356, 266, 18, '0x94a3b8'), txt('Security code', 356, 338, 18, '0x94a3b8'),
    box(340, 410, 200, 48, ACCENT), txt('Pay now', 408, 422, 22, '0xffffff'),
    ...extra, txt('%{eif\\:t\\:d}s', 24, 690, 18, MUTE)];
  for (const [a, b, label, sub] of phases) { const en = `between(t,${a},${b})`; p.push(txt(label, 340, 120, 30, INK, en), txt(sub, 340, 480, 18, MUTE, en)); }
  return chain(p);
}
const settingsStill = () => chain(['color=c=0xf1f5f9:s=1280x720:r=1:d=1',
  box(0, 0, 1280, 56, '0xffffff'), box(0, 56, 1280, 1, LINE), box(24, 20, 16, 16, ACCENT), txt('Workspace settings', 56, 18, 22, INK),
  box(0, 57, 240, 663, '0xffffff'), box(240, 57, 1, 663, '0xe2e8f0'), box(16, 80, 208, 36, '0xecfdf5'), txt('General', 32, 90, 18, ACCENT), txt('Members', 32, 138, 18, MUTE), txt('Billing', 32, 186, 18, MUTE),
  txt('General', 280, 90, 30, INK), box(280, 150, 720, 360, LINE), box(281, 151, 718, 358, '0xffffff'),
  txt('Workspace name', 304, 176, 18, MUTE), box(304, 204, 360, 40, LINE), box(305, 205, 358, 38, '0xf8fafc'), txt('Acme Shop', 316, 214, 20, INK),
  txt('Billing contact', 304, 280, 18, MUTE), box(304, 308, 360, 40, LINE), box(305, 309, 358, 38, '0xf8fafc'), box(316, 318, 220, 20, '0x94a3b8'), // blurred by the Privacy Guard
  txt('Send weekly summary', 304, 392, 18, INK), box(880, 388, 56, 28, ACCENT), box(912, 392, 20, 20, '0xffffff')]);

const CLIPS = {
  main: { dur: 75, heading: 'Acme Shop - Checkout (staging)', phases: [[0, 17, 'Cart', 'Standard plan, 1 x 49.00 USD, total 49.00 USD'], [17, 33, 'Payment', 'Test card entered, Pay now is enabled'], [33, 60, 'Processing payment', 'POST /api/checkout returned 409 Conflict, nothing shown to the user'], [60, 75, 'Proposed fix', 'Disable Pay now after the first click and show a retry message']],
    extra: [box(340, 520, 600, 56, '0xfef2f2', 'between(t,33,60)'), box(340, 520, 4, 56, '0xdc2626', 'between(t,33,60)'), txt('Network response 409 Conflict - request already processed', 360, 536, 20, '0xb91c1c', 'between(t,33,60)')] },
  roadmap: { dur: 42, heading: 'Roadmap review - Q3', phases: [[0, 14, 'Now', 'Checkout fixes and invoice export'], [14, 28, 'Next', 'Team workspaces and roles'], [28, 42, 'Later', 'Usage based pricing, still under discussion']] },
  api: { dur: 42, heading: 'API reference - rate limits', phases: [[0, 14, 'Limits', '600 requests per minute per token'], [14, 28, 'Headers', 'X-RateLimit-Remaining and Retry-After'], [28, 42, 'Back off', 'Wait for Retry-After, then retry once']] },
  onboarding: { dur: 24, heading: 'Onboarding - first run', phases: [[0, 8, 'Welcome', 'Pick a workspace name'], [8, 16, 'Invite', 'Add two teammates'], [16, 24, 'Done', 'Your first project is ready']] },
  pricing: { dur: 30, heading: 'Pricing experiment - Q3', phases: [[0, 10, 'Variant A', '49 dollar plan, 3.1 percent conversion'], [10, 20, 'Variant B', '59 dollar plan, 2.8 percent conversion'], [20, 30, 'Decision', 'Keep 49 dollars, test annual billing next']] },
  darkmode: { dur: 12, heading: 'Dark mode - QA pass', phases: [[0, 6, 'Billing page', 'Low contrast on the plan label'], [6, 12, 'Invoice table', 'Row borders disappear']] },
};
const mp4Args = (src, dur, out) => ['-y', '-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=44100:duration=${dur}`,
  '-af', "volume=0.5,volume='lt(mod(t,20),17)':eval=frame", '-t', String(dur), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out];

async function ensure(name, make) { // atomic: write to a temp name, rename into the cache
  const f = path.join(CACHE, name); if (fs.existsSync(f)) return f;
  const tmp = path.join(CACHE, `${process.pid}-${name}`); await make(tmp); fs.renameSync(tmp, f); return f;
}
const frame = (mp4, at, width) => (out) => runFfmpeg(['-y', '-ss', String(at), '-i', mp4, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', out]);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Transcript, word timings, cursor feed
// ---------------------------------------------------------------------------------------------------------------------------------------------
// Speech never overlaps the silences at 17-20 s, 37-40 s and 57-60 s.
const SEGMENTS = [
  [0.8, 5.6, 'Hi, this is a quick walkthrough of the checkout bug we saw on staging last night.'],
  [5.9, 11.4, 'So, um, I am going to add the standard plan to the cart and head to the payment step.'],
  [11.8, 16.6, 'Notice the total shows forty nine dollars, which is correct at this point.'],
  [20.4, 26.2, 'Now I will enter the test card, which is [bleep] and, uh, click Pay now.'],
  [26.5, 31.8, 'The button spins for a couple of seconds and then nothing happens, no error, no redirect.'],
  [32.2, 36.8, 'If I open the network tab, you can see the request returns a four oh nine.'],
  [40.3, 46.0, 'That conflict comes from the idempotency key, which is reused when you double click, you know, the Pay button.'],
  [46.4, 51.5, 'So the first request succeeds, the second one is rejected, and the interface swallows that error.'],
  [52.0, 56.6, 'What we want is, um, to show the confirmation page as soon as the first request lands.'],
  [60.4, 65.2, 'I would suggest disabling the button after the first click and showing the four oh nine as a retry message.'],
  [65.6, 70.4, 'I have attached the failing request as a HAR file in the ticket, it is the one named checkout dash one.'],
  [70.8, 74.4, 'That is it. Thanks for watching, and let me know if you have questions.'],
].map(([start, end, text]) => ({ start, end, text }));
// Whisper-style word timings [{ w, s, e }], spread over each segment by word length.
function wordsOf(segments) {
  const out = [];
  for (const s of segments) {
    const toks = s.text.split(/\s+/), wt = toks.map((t) => t.length + 2), sum = wt.reduce((a, b) => a + b, 0), span = s.end - s.start; let t = s.start;
    toks.forEach((w, i) => { const d = (span * wt[i]) / sum; out.push({ w, s: r3(t + d * 0.05), e: r3(t + d * 0.9) }); t += d; });
  }
  return out;
}
const evenSegments = (dur, lines) => lines.map((text, i) => { const slot = (dur - 1) / lines.length, start = 0.6 + i * slot; return { start: r1(start), end: r1(start + slot - 0.8), text }; });
const KEYS = [[0, .5, .5], [7, .74, .52], [12, .72, .28], [21, .5, .31], [23, .5, .4], [24.5, .45, .64], [43, .45, .64], [50, .3, .8], [62, .45, .64], [75, .5, .5]];
function timeline() {
  const cursor = [], at = (t) => { let i = KEYS.findIndex((k) => k[0] > t); if (i < 0) i = KEYS.length - 1; if (i === 0) i = 1; const a = KEYS[i - 1], b = KEYS[i], u = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))), e = u * u * (3 - 2 * u); return [a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e]; };
  for (let t = 0; t <= 75; t += 0.05) { const [x, y] = at(t); cursor.push([r3(t), r4(x), r4(y)]); }
  const clicks = [[7.2, .74, .52], [12.4, .72, .28], [21.4, .5, .31], [22.6, .5, .4], [24.6, .45, .64], [43.8, .45, .64], [44.1, .45, .64], [62.4, .45, .64]].map(([t, x, y]) => [t, x, y, 0]);
  return { version: 2, mode: 'screen', screen: { width: 1280, height: 720 }, segments: [], bubble: [], cursor, clicks, drawing: [], zoom: [] };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------------------------------------------------------------------------
const pages = []; // { key, label, group, path }
const addPage = (key, label, group, p) => pages.push({ key, label, group, path: p });
const crewOf = (state) => CREW.map((c, i) => {
  const llm = ['planner', 'insights', 'writer', 'critic'].includes(c.id), ms = [9400, 15200, 600, 7100, 11800, 4300][i];
  if (state === 'done') return { ...c, status: 'done', detail: { transcriber: '12 segments', privacy: '3 sensitive items blurred, 1 spoken secret bleeped', planner: 'bug-report', insights: 'title, summary, 6 chapters, 3 actions', writer: '6 steps', critic: 'no problems found' }[c.id], ms };
  if (state === 'skipped') return llm ? { ...c, status: 'skipped', detail: 'Ollama is not running' } : { ...c, status: 'done', detail: c.id === 'privacy' ? 'nothing sensitive found' : '3 segments', ms };
  if (state === 'running') return { ...c, status: i === 0 ? 'running' : 'queued', detail: i === 0 ? 'Transcribing speech 42%' : '' };
  if (state === 'privacy') return { ...c, status: i === 0 ? 'done' : i === 1 ? 'running' : 'queued', detail: i === 1 ? 'Reading the screen, frame 120 of 450' : i === 0 ? '9 segments' : '', ...(i === 0 ? { ms: 8800 } : {}) };
  return { ...c, status: i === 0 ? 'error' : 'queued', detail: i === 0 ? 'The speech model could not be loaded' : '' }; // 'failed'
});
const viewer = (name, email, daysAgo, frac, dur, owner = false) => ({ sid: store.newId(5), name, email, owner, at: Date.now() - daysAgo * DAY, maxT: r1(dur * frac), watched: Math.round(dur * frac * 0.9), last: Date.now() - daysAgo * DAY + 60000 });
const some = (dur, n) => ['Priya Nair', 'Marcus Webb', 'Dana Kowalski', 'Tomas Reyes'].slice(0, n).map((nm, i) => viewer(nm, nm.toLowerCase().replace(/ /g, '.') + '@example.com', 0.5 + i * 1.7, [0.95, 0.6, 1, 0.3][i], dur));
const heatOf = (dur, peak) => Array.from({ length: Math.ceil(dur) + 1 }, (_, i) => Math.max(0, Math.round(9 * Math.exp(-i / (dur * 0.8)) + (peak ? 7 * Math.exp(-(((i - peak) / 4) ** 2)) : 0))));
const activity = (id, rows) => store.mutate((d) => {
  const list = rows.map(([ago, event, who]) => ({ at: Date.now() - ago, event, who }));
  d.videos[id].activity = list; d.activity = [...list.map((r) => ({ ...r, videoId: id })), ...d.activity].sort((a, b) => b.at - a.at).slice(0, 500);
});

async function seed(log) {
  fs.mkdirSync(CACHE, { recursive: true });
  const media = {}; // clip name -> { dur, mp4 }
  log('Generating seed media (cached in ' + CACHE + ')...');
  await Promise.all(Object.entries(CLIPS).map(async ([name, c]) => { media[name] = { dur: c.dur, mp4: await ensure(`${name}.mp4`, (out) => runFfmpeg(mp4Args(screenSrc(c), c.dur, out))) }; }));
  const thumb = (clip, at) => ensure(`${clip}-${at}.jpg`, frame(media[clip].mp4, at, 480));
  const png = await ensure('settings.png', (out) => runFfmpeg(['-y', '-f', 'lavfi', '-i', settingsStill(), '-frames:v', '1', out]));
  const pngThumb = await ensure('settings-thumb.jpg', (out) => runFfmpeg(['-y', '-i', png, '-vf', 'scale=480:-2', '-q:v', '4', out]));
  const gif = (clip, at) => ensure(`${clip}-${at}.gif`, (out) => runFfmpeg(['-y', '-ss', String(at), '-t', '3', '-i', media[clip].mp4, '-vf', 'fps=8,scale=320:-2:flags=lanczos', '-loop', '0', out]));

  const owner = 'Alex Rivera', now = Date.now();
  store.setSettings({ ownerName: owner, follows: ['onboarding'] });
  const mkFolder = (name) => { const f = { id: store.newId(4), name }; store.mutate((d) => { d.folders[f.id] = f; }); return f; };
  const mkSpace = (name, ago) => { const s = { id: store.newId(4), name, createdAt: now - ago * DAY }; store.mutate((d) => { d.spaces[s.id] = s; }); return s; };
  const fBugs = mkFolder('Bug reports'), fProduct = mkFolder('Product demos'), fOnboard = mkFolder('Onboarding');
  const sEng = mkSpace('Engineering', 30), sDesign = mkSpace('Design review', 21);

  // one ready video; every file it needs is copied from the cache
  async function ready(key, label, clip, thumbAt, fields = {}) {
    const c = media[clip];
    const v = store.create({ status: 'ready', stage: 'done', pipe: 'done', shareable: true, guard: { model: true, speech: 'checked' }, mode: 'screen', duration: c.dur, width: 1280, height: 720, crew: crewOf('done'), createdAt: now - 2 * DAY, ...fields });
    fs.copyFileSync(c.mp4, path.join(store.videoDir(v.id), 'video.mp4')); fs.copyFileSync(await thumb(clip, thumbAt), path.join(store.videoDir(v.id), 'thumb.jpg'));
    addPage(key, label, 'Watch pages', `/v/${v.id}`); return v;
  }

  // (1) the main video: everything the watch page can show
  const words = wordsOf(SEGMENTS), bleep = words.find((w) => w.w === '[bleep]');
  const steps = [[1, 'Add the Standard plan to the cart', 'Click Add to cart on the Standard plan card, then open the cart.', 6], [2, 'Enter the test card', 'Fill in the card number, expiry and security code on the payment step.', 21],
    [3, 'Click Pay now', 'The button shows a spinner and stays disabled-looking, but nothing else changes.', 24.5], [4, 'Check the network response', 'The network tab shows POST /api/checkout returning 409 Conflict.', 33],
    [5, 'Double click Pay now', 'A second click re-sends the same idempotency key, so the second request is rejected.', 44], [6, 'Disable the button after the first click', 'Disable Pay now once pressed and show a retry message if the API answers 409.', 62]];
  const guideDir = (id) => path.join(store.videoDir(id), 'guide');
  const main = await ready('checkout', 'Checkout bug walkthrough (ready, shareable, owner view)', 'main', 34, {
    title: 'Checkout bug walkthrough', createdAt: now - 1.2 * DAY - 3 * HOUR, source: 'recording', hasTrack: true, forAgent: true, folder: fBugs.id, tags: ['bug', 'checkout', 'staging'], spaces: [sEng.id], views: 14, progress: 31, lastWatchedAt: now - 5 * HOUR,
    summary: 'Alex reproduces a checkout failure on staging: pressing Pay now twice sends the same idempotency key, the second request returns 409 Conflict and the interface shows nothing. The proposed fix is to disable the button after the first click and surface the 409 as a retry message.',
    transcript: SEGMENTS.map((s) => s.text).join(' '), segments: SEGMENTS, words,
    chapters: [[0, 'Intro'], [5.9, 'Add the plan to the cart'], [20.4, 'Reproduce the failure'], [32.2, 'Network tab shows 409'], [40.3, 'Root cause'], [60.4, 'Suggested fix']].map(([start, title]) => ({ start, title })),
    tasks: ['Disable the Pay now button after the first click', 'Show a retry message when the API answers 409', 'Log the 409 so support can find it', 'Attach the HAR file to the ticket'],
    plan: { kind: 'bug-report', writeGuide: true, reason: 'The presenter reproduces a failure step by step' },
    guide: { kind: 'bug-report', label: 'Bug report', title: 'Checkout fails after a double click on Pay now', intro: 'On staging, pressing Pay now twice leaves the customer on the payment step with no error, because the second request is rejected with 409 Conflict.',
      steps: steps.map(([n, title, detail, at]) => ({ n, title, detail, at, image: `step${n}.jpg` })), closing: 'Expected: the confirmation page appears after the first request succeeds. Actual: the spinner stops and the page stays on the payment step.' },
    redactions: [{ type: 'api key', by: 'rule', from: 22.4, to: 31 }, { type: 'email', by: 'model', from: 8.1, to: 14.2 }, { type: 'token', by: 'rule', from: 44, to: 52.5 }],
    speechRedactions: [{ from: r3(bleep.s - 0.05), to: r3(bleep.e + 0.1), type: 'card number' }],
    timings: { composite: 5200, thumbnail: 310, transcribe: 9100, privacy: 14800, insights: 6400 },
    reactions: { good: 5, question: 2, issue: 3, idea: 1, key: 2, [String.fromCodePoint(0x2764, 0xFE0F)]: 2, [String.fromCodePoint(0x1F525)]: 1 }, // the last two are legacy emoji keys: the UI must ignore them
    reactionEvents: [['good', 12, 'Marcus Webb'], ['issue', 24.5, 'Priya Nair'], [String.fromCodePoint(0x2764, 0xFE0F), 30, 'Dana Kowalski'], ['question', 41, 'Priya Nair'], ['key', 51, 'Marcus Webb', true], [String.fromCodePoint(0x1F525), 55, 'Tomas Reyes'], ['idea', 62, 'Priya Nair'], ['good', 70, 'Dana Kowalski'], ['issue', 33, 'Tomas Reyes']]
      .map(([emoji, at, by, sup]) => ({ emoji, at, by, super: !!sup })),
    comments: [['Priya Nair', 'Nice catch. Is the idempotency key generated on the client or by the checkout service?', 41.2, 1.1 * DAY], ['Alex Rivera', '@priya it is generated client side when the form mounts, so a double click reuses it.', 44, 1.05 * DAY], ['Marcus Webb', 'Can we also log the 409 so support can see it? That would have saved us an hour last night.', 63.5, 0.9 * DAY]]
      .map(([author, text, at, ago]) => ({ id: store.newId(4), author, text, at, createdAt: now - ago, mentions: [...text.matchAll(/@(\w+)/g)].map((m) => m[1]) })),
    viewers: [viewer('Priya Nair', 'priya.nair@example.com', 1.2, 0.96, 75), viewer('Marcus Webb', 'marcus.webb@example.com', 1.1, 0.64, 75), viewer('Dana Kowalski', 'dana.kowalski@example.com', 2.4, 1, 75), viewer('Guest', '', 3, 0.31, 75),
      viewer('Tomas Reyes', 'tomas.reyes@example.com', 4.2, 0.88, 75), viewer('Priya Nair', 'priya.nair@example.com', 5.1, 0.45, 75), viewer(owner, '', 0.25, 1, 75, true)],
    heat: heatOf(75, 30), crew: crewOf('done'),
  });
  const mdir = store.videoDir(main.id), tl = timeline();
  fs.writeFileSync(path.join(mdir, 'timeline.json'), JSON.stringify(tl));
  fs.mkdirSync(guideDir(main.id), { recursive: true });
  for (const [n, , , at] of steps) fs.copyFileSync(await ensure(`main-step-${at}.jpg`, frame(media.main.mp4, at, 640)), path.join(guideDir(main.id), `step${n}.jpg`));
  fs.copyFileSync(await gif('main', 20), path.join(mdir, 'preview.gif'));
  fs.writeFileSync(path.join(mdir, 'action-plan.md'), buildActionPlan(store.get(main.id), { dir: mdir, timeline: tl }));
  addPage('checkout-editor', 'Editor for the checkout video', 'Owner pages', `/edit/${main.id}`);
  addPage('checkout-embed', 'Embed player for the checkout video', 'Watch pages', `/embed/${main.id}`);
  activity(main.id, [[0.25 * DAY, 'Viewed', owner], [0.9 * DAY, 'Commented', 'Marcus Webb'], [1.05 * DAY, 'Commented', owner], [1.1 * DAY, 'Commented', 'Priya Nair'], [1.1 * DAY, 'Viewed', 'Marcus Webb'], [1.2 * DAY, 'Viewed', 'Priya Nair'], [1.2 * DAY + HOUR, 'Generated Bug report', 'owner']]);
  store.notify({ type: 'comment', videoId: main.id, title: main.title, by: 'Marcus Webb', text: 'Can we also log the 409 so support can see it?', t: 63.5, snippet: SEGMENTS[9].text });
  store.notify({ type: 'comment', videoId: main.id, title: main.title, by: 'Priya Nair', text: 'Nice catch. Is the idempotency key generated on the client or by the checkout service?', t: 41.2, snippet: SEGMENTS[6].text });
  store.notify({ type: 'reaction', videoId: main.id, title: main.title, by: 'Priya Nair', text: 'reacted issue', t: 24.5, snippet: SEGMENTS[3].text });
  store.mutate((d) => d.notifications.forEach((n, i) => { n.at = now - (i * 7 + 2) * HOUR; n.read = i === 2; }));

  // (6) more ready videos for the grid, folders, spaces, search, "continue watching" and "watch later"
  const roadmapSil = silenceCuts(await detectSilences(media.roadmap.mp4, media.roadmap.dur)).map((c) => ({ ...c, kind: 'silence' }));
  const roadmap = await ready('roadmap', 'Quarterly roadmap review (draft edits, silence cuts ready to apply)', 'roadmap', 6, { title: 'Quarterly roadmap review', createdAt: now - 3 * DAY, mode: 'screen-cam', folder: fProduct.id, tags: ['roadmap', 'planning'], spaces: [sDesign.id], watchLater: true, views: 31,
    summary: 'A walkthrough of the Q3 roadmap: checkout fixes ship first, team workspaces follow in August, and usage based pricing is still under discussion.', segments: evenSegments(42, ['This is where the Q3 roadmap stands today.', 'Team workspaces are next, with roles and a basic audit log.', 'Usage based pricing is still a discussion, nothing is decided.']),
    edits: { cuts: roadmapSil, inserts: [] }, viewers: some(42, 3), heat: heatOf(42, 0), crew: crewOf('done') });
  fs.copyFileSync(await gif('roadmap', 14), path.join(store.videoDir(roadmap.id), 'preview.gif'));
  addPage('roadmap-editor', 'Editor with a draft edit list', 'Owner pages', `/edit/${roadmap.id}`);
  await ready('onboarding', 'Onboarding tour (unfinished, to continue watching)', 'onboarding', 4, { title: 'Onboarding tour, first run', createdAt: now - 1 * DAY, mode: 'screen-cam', folder: fOnboard.id, tags: ['onboarding', 'design'], spaces: [sDesign.id, sEng.id], progress: 9, lastWatchedAt: now - 2 * HOUR, views: 6,
    summary: 'First-run tour of the new onboarding flow: naming a workspace, inviting two teammates and landing in an empty project with a checklist.', segments: evenSegments(24, ['Welcome. First you pick a name for the workspace.', 'Next you can invite two teammates by email.', 'And that is the whole flow, you land in a project.']), viewers: some(24, 2), heat: heatOf(24, 0) });
  await ready('api', 'API rate limit explainer (upload, AI notes skipped)', 'api', 20, { title: 'API rate limit explainer', createdAt: now - 6 * DAY, source: 'upload', tags: ['api', 'docs'], spaces: [sEng.id], views: 12, crew: crewOf('skipped'),
    summary: 'Explains how the public API rate limits work, what the 429 headers mean and how clients should back off.', segments: evenSegments(42, ['The public API allows six hundred requests a minute per token.', 'When you go over, the response is a 429 with a Retry-After header.', 'Wait for that many seconds and retry once, do not loop.']), viewers: some(42, 2), heat: heatOf(42, 0) });
  await ready('darkmode', 'Dark mode QA pass (newest, short)', 'darkmode', 2, { title: 'Dark mode QA pass', createdAt: now - 4 * HOUR, folder: fBugs.id, tags: ['qa', 'ui'], views: 2, lastWatchedAt: now - 3 * HOUR,
    summary: 'Quick QA pass over the dark theme. Two contrast issues on the billing page and one on the invoice table.', segments: evenSegments(12, ['Billing page first, the plan label is hard to read.', 'And the invoice table loses its row borders.']), viewers: some(12, 1), heat: heatOf(12, 0) });

  // (5) privacy gates: password, email, private, expired. Open them as a viewer to see the gate page.
  await ready('password', `Password-protected link (password: ${GATE_PASSWORD})`, 'pricing', 4, { title: 'Q3 pricing experiment results', createdAt: now - 5 * DAY, tags: ['pricing'], privacy: { mode: 'password', passwordHash: auth.hashPw(GATE_PASSWORD) }, views: 3,
    summary: 'Results of the Q3 pricing experiment, comparing conversion for the 49 dollar and 59 dollar plans.', segments: evenSegments(30, ['Variant A converts at three point one percent.', 'Variant B is lower at two point eight.', 'We keep forty nine and test annual billing next.']) });
  await ready('email', 'Email-gated link', 'onboarding', 20, { title: 'Customer interview, March', createdAt: now - 8 * DAY, tags: ['research'], privacy: { mode: 'email' }, views: 5, summary: 'Notes from a customer interview about how they invite teammates.' });
  await ready('private', 'Private link (viewers are blocked)', 'darkmode', 9, { title: 'Internal security notes', createdAt: now - 9 * DAY, privacy: { mode: 'private' }, summary: 'Internal notes, not for sharing.' });
  await ready('expired', 'Expired link', 'api', 4, { title: 'Launch checklist walkthrough', createdAt: now - 12 * DAY, privacy: { mode: 'link', expiresAt: now - 3 * DAY }, tags: ['launch'], summary: 'Step by step launch checklist for the March release.' });

  // (2) still processing, plus a ready one that the Privacy Guard is still checking, (3) failed, (4) screenshot
  const proc = store.create({ title: 'Untitled recording', status: 'processing', stage: 'Transcribing speech 42%', crew: crewOf('running'), createdAt: now - 6 * 60000, mode: 'screen', source: 'recording', duration: 0 });
  addPage('processing', 'Still processing (owner and viewer)', 'Watch pages', `/v/${proc.id}`);
  await ready('checking', 'Ready, Privacy Guard still checking (viewers see a wait page)', 'onboarding', 12, { title: 'Support macro setup', createdAt: now - 20 * 60000, shareable: false, stage: 'Privacy Guard: reading the screen', pipe: 'composited', guard: undefined, crew: crewOf('privacy'), tags: ['support'] });
  const bad = store.create({ title: 'Recording from 9:41 AM', status: 'failed', stage: 'Could not read the recording: ffmpeg exited with code 1', crew: crewOf('failed'), createdAt: now - 26 * HOUR, mode: 'screen', duration: 0 });
  addPage('failed', 'Failed recording', 'Watch pages', `/v/${bad.id}`);
  const shot = store.create({ type: 'image', title: 'Settings page screenshot', status: 'ready', stage: 'done', shareable: true, guard: { model: false, speech: 'no-audio' }, redactions: [{ type: 'email', by: 'rule' }], width: 1280, height: 720, createdAt: now - 7 * HOUR, tags: ['settings'], views: 1 });
  fs.copyFileSync(png, path.join(store.videoDir(shot.id), 'image.png')); fs.copyFileSync(pngThumb, path.join(store.videoDir(shot.id), 'thumb.jpg'));
  addPage('screenshot', 'Screenshot (type image)', 'Watch pages', `/v/${shot.id}`);

  // self-checks: the harness must prove that the editor has real silence and filler words to work with
  const silences = silenceCuts(await detectSilences(media.main.mp4, media.main.dur)), fillers = findFillers(words);
  if (silences.length < 3) throw new Error(`seed audio: expected at least 3 silences, silencedetect found ${silences.length}`);
  if (fillers.length < 3) throw new Error(`seed words: expected at least 3 filler words, found ${fillers.length}`);
  log(`Seed check: ${silences.length} silences (${silences.map((s) => `${s.start}-${s.end}s`).join(', ')}), ${fillers.length} filler words (${fillers.map((f) => f.text).join(', ')})`);
  return { sEng, sDesign, silences: silences.length, fillers: fillers.length };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
let dir = null;
const cleanup = () => { try { store.close(); } catch {} if (dir && !KEEP) fs.rmSync(dir, { recursive: true, force: true }); else if (dir) console.log(`library kept in ${dir}`); };
// checked up front: src/server's listen() cannot report EADDRINUSE (Express 5 hands the error to the listening callback, which then throws)
const portFree = (port) => new Promise((resolve) => { const t = require('net').createServer().once('error', () => resolve(false)).once('listening', () => t.close(() => resolve(true))).listen(port, HOST); });
(async () => {
  const log = (...a) => console.log(...a);
  if (!(await portFree(PORT))) throw new Error(`port ${PORT} is already in use: set UI_PORT to another port (UI_PORT=4900 npm run dev:ui)`);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-devui-lib-'));
  store.init(dir, { log: () => {} });
  if (process.env.UI_FAKE_GH) { // the publisher is a singleton: faking its two doors here is enough, nothing else knows
    const publisher = require('../src/publish/publisher');
    publisher.deps.ghToken = () => (process.env.UI_FAKE_GH === 'nogh' ? '' : 'gho_harness_fake_token');
    publisher.deps.makeGitHub = (cfg) => ({ check: async () => { if (/^bad/i.test(cfg.token)) throw new Error('GitHub did not accept that token. Make a new one and paste it again.'); return { login: 'demo-user', canCreate: true, canDelete: false }; } }); // a token that starts with "bad" fails, to see the error
  }
  const { sEng, sDesign } = await seed(log);
  if (process.env.UI_QUEUE) require('../src/agents/orchestrator').init(dir, { log: () => {} });
  addPage('library', 'Library (home)', 'Owner pages', '/'); addPage('settings', 'Settings', 'Owner pages', '/settings');
  addPage('space-engineering', 'Space: Engineering (public page)', 'Space pages', `/space/${sEng.id}`); addPage('space-design', 'Space: Design review (public page)', 'Space pages', `/space/${sDesign.id}`);

  const srv = startServer({ port: PORT, host: HOST });
  const port = await srv.ready;
  const base = `http://${HOST}:${port}`, byKey = new Map(pages.map((p) => [p.key, p]));

  // dev-only routes, added to this process's copy of the app
  const app = srv.app, loop = (q, res) => (auth.fromOwnerMachine(q) ? true : (res.sendStatus(403), false));
  const manifest = () => ({ base, password: GATE_PASSWORD, pages: pages.map((p) => ({ ...p, owner: `${base}/dev/go/${p.key}`, viewer: `${base}/dev/viewer/${p.key}`, direct: `${base}${p.path}` })) });
  app.get('/dev/urls.json', (q, res) => { if (loop(q, res)) res.json(manifest()); });
  app.get('/dev/go', (q, res) => { if (loop(q, res)) res.redirect(security.ownerLoginPath(security.safeNext(String(q.query.to || '/')))); });
  app.get('/dev/go/:key', (q, res) => { if (!loop(q, res)) return; const p = byKey.get(q.params.key); if (!p) return res.status(404).send('unknown key, see /dev'); res.redirect(security.ownerLoginPath(p.path)); });
  app.get('/dev/viewer/:key', (q, res) => { if (!loop(q, res)) return; const p = byKey.get(q.params.key); if (!p) return res.status(404).send('unknown key, see /dev'); res.setHeader('Set-Cookie', 'sp_asviewer=1; Path=/; SameSite=Lax'); res.redirect(p.path); });
  app.get('/dev', (q, res) => {
    if (!loop(q, res)) return;
    const groups = [...new Set(pages.map((p) => p.group))];
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Kairos dev harness</title><body style="font:14px/1.5 system-ui;max-width:56rem;margin:2rem auto;padding:0 1rem;color:#0f172a"><h2>Kairos web-UI harness</h2><p>Owner links sign this browser in (fresh one-time code each click). Viewer links show the same page as someone with the link. Password for the password link: <code>${GATE_PASSWORD}</code>. <a href="/dev/go?to=/">Reset to owner</a></p>` +
      groups.map((g) => `<h3>${g}</h3><ul>${pages.filter((p) => p.group === g).map((p) => `<li><a href="/dev/go/${p.key}">${p.label}</a> &nbsp; <a href="/dev/viewer/${p.key}">as viewer</a> &nbsp; <code>${p.path}</code></li>`).join('')}</ul>`).join(''));
  });

  const w = Math.max(...pages.map((p) => p.key.length)) + 2, u = (k) => `${base}/dev/go/${k}`.padEnd(base.length + 28);
  log(`\nKairos web-UI harness, listening on ${base}  (library: ${dir})\n`);
  log(`One-time owner sign-in (valid 2 minutes, single use):\n  ${base}${security.ownerLoginPath('/')}\n`);
  log(`Reusable links: every click mints a fresh one-time code and signs in as the owner through the real /owner-login.\n  Same page as a viewer: ${base}/dev/viewer/<key>      Index: ${base}/dev      JSON: ${base}/dev/urls.json      Back to owner: ${base}/dev/go?to=/`);
  for (const g of ['Owner pages', 'Watch pages', 'Space pages']) {
    log(`\n${g}`);
    for (const p of pages.filter((x) => x.group === g)) log(`  ${p.key.padEnd(w)}${u(p.key)}${p.label}`);
  }
  log(`\nPassword for the password link: ${GATE_PASSWORD}. The checkout video opens on the Action Plan tab (forAgent); the roadmap video opens on the Edit tab.\nCtrl-C to stop.`);

  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; try { await srv.close(); cleanup(); } finally { process.exit(0); } };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
})().catch((e) => { console.error(e.message || e); cleanup(); process.exit(1); });
