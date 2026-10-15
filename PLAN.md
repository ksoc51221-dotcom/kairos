# Spool rebuild plan (Electron)

Written 2026-10-14. Deadline: **Thursday 2026-10-22**. Executor: Claude Sonnet, one phase per session.
Read this whole file before touching code. Work phases **in order**. Do not start a phase until the previous phase's acceptance checks pass.

---

## 0. Why we are re-planning (measured, not guessed)

The user's first real recording (24 s, Screen + Cam, 1080p) showed three problems. Root causes, from the file and logs:

| Symptom | Measured | Root cause |
|---|---|---|
| Very slow to load | Video withheld ~2 min. Transcriber + Privacy Guard ran 108 s in parallel before the video was published | (a) The video is only served after the Privacy Guard finishes, even to its owner. (b) Whisper runs on CPU via transformers.js. (c) Tesseract OCR in WASM is slow. (d) Two full software encodes (libx264) |
| Low quality | Output **1728×1080 at 588 kb/s** from a **2880×1800** screen | (a) Downscaled to "1080p" by default. (b) **Two lossy encodes**: MediaRecorder on a canvas, then libx264 CRF 21. (c) Canvas `drawImage` resampling blurs text |
| Cursor laggy, glitchy | Capture 30 fps. Compositor redraws with `setInterval` in a hidden window. Ring overlay moved with `setPosition` at 30 Hz | (a) A canvas frame clock that isn't synced to capture frames gives judder. (b) The highlight ring window trails the real cursor *and is captured in the video*. (c) 30 fps |

**Core mistake:** compositing screen and camera live on a canvas inside Electron. Every serious recorder (Loom desktop, Cap, Screen Studio) does it the other way: it **records separate tracks at full quality and composites once at export**, using the hardware encoder.

Verified on this machine: the bundled `ffmpeg-static` has `h264_videotoolbox`, `hevc_videotoolbox`, `overlay` and `alphamerge`. Hardware encoding is available.

---

## 1. Target architecture

```
Recording (Electron renderer, hidden)          Processing (main process, ffmpeg + agents)            Viewing (local web server)
┌─────────────────────────────┐   files     ┌─────────────────────────────────────────┐          ┌──────────────────────────┐
│ screen  MediaRecorder  ─────┼──► screen_N.webm (native res, 60 fps, H.264 25 Mbps)   │          │ owner: watch immediately │
│ camera  MediaRecorder  ─────┼──► cam_N.webm   (1080p/720p)                           │  publish │ viewers: after Privacy   │
│ audio (mic + system)  ──────┼──► in screen_N  │ 1. COMPOSITE (h264_videotoolbox) ──────┼────────► │ Guard approves           │
│ timeline.json  ─────────────┼──► bubble keyframes, cursor 60 Hz, clicks, segments,   │          │ player draws cursor FX,  │
└─────────────────────────────┘    crop, shape/filter/frame                            │          │ auto-zoom, overlays      │
                                             │ 2. Privacy Guard (OCR) → blur pass      │          └──────────────────────────┘
                                             │ 3. Transcriber → Planner → Insights → Guide │
                                             └─────────────────────────────────────────┘
```

Rules that follow from this:
1. **No canvas compositing during recording.** The screen track is recorded directly from `getDisplayMedia` with the OS-drawn cursor (smooth, native frame clock).
2. **Exactly one lossy encode before publishing:** the composite step, on the hardware encoder at a high bitrate. MediaRecorder intermediates use a very high bitrate (about visually lossless).
3. **The owner sees the video as soon as the composite finishes** (target ≤ 8 s for a 24 s clip). Viewers stay blocked until the Privacy Guard passes. This keeps it fail-closed for viewers only.
4. **Cursor effects, auto-zoom and overlays are rendered in the player at playback time** from `timeline.json`, so they cost nothing at record time. Burning them into a download happens later, as an export.
5. The live bubble, ring, controls, countdown and outline windows are **always `setContentProtection(true)`**, so they never appear in the screen track. The drawing overlay is the one exception: it must be captured, so it stays capturable.

---

## 2. Code structure (do this first, in Phase 1)

The current layout grew ad hoc: `main.js` is about 400 lines and mixes windows, IPC, session, screenshots and self-tests. Reorganise without changing behaviour:

```
src/
  main/
    index.js          app lifecycle, single-instance, tray, dock, startup
    log.js            log file + diagnostics (exists inline today)
    permissions.js    status, open-settings, relaunch
    windows.js        factory for every BrowserWindow (one function each)
    session.js        recording state machine: idle → preparing → countdown → recording ⇄ paused → stopping → saved
    shortcuts.js      global shortcuts, registered/unregistered by session state
    screenshot.js     capture → area pick → annotate → save
    ipc.js            every ipcMain.handle/on in one place, thin, calls into the modules above
    selftest.js       headless test runner (moved out of main.js)
  renderer/           launcher/ controls/ bubble/ countdown/ area/ draw/ ring/ notes/ annotate/ recorder/  (one folder per window, html + js + css)
  pipeline/
    segments.js       read/write recording manifests
    composite.js      builds the ffmpeg composite command (pure function → args array; unit-tested)
    encode.js         runs ffmpeg with progress, picks videotoolbox, falls back to libx264
    masks.js          generates shape masks (circle/squircle/portrait/landscape) and frame PNGs once per size
  agents/             (keep) transcribe, privacy, ocr, insights, guide, llm, orchestrator
  server/             (keep) split server.js routes into routes/{viewer,owner,media,library,settings}.js
  shared/
    constants.js      qualities, shapes, filters, frames, ports, file names (one source of truth for main + renderer + server)
tests/
  unit/*.test.js      node:test (no new dependency): composite args, store, auth, privacy regexes, timeline
  e2e/selftest.sh     runs SPOOL_SELFTEST scenarios and checks output with ffprobe
```

Use plain CommonJS and Node's built-in `node:test` and `assert`. Do not add a framework, bundler or TypeScript this week.

---

## 3. Phases

Each phase lists **tasks**, then **acceptance checks** to run before moving on. Rebuild the `.app` **at most once per phase**: every ad-hoc-signed rebuild resets the user's Screen Recording permission. Develop with `npm start` (permission granted to the launching app) and the self-test harness.

### Phase 1: Restructure + recording v2 (quality and cursor) · Oct 15
**Also in this phase:** bugs B1–B3, B5, B7–B10, B13, B14, B20, B21, B24 and UI items U1, U2, U4–U10 (§3b, §3c). Do B1 and B2 **first**: they protect the user's data while everything else changes.
This is the heaviest phase. Run it as two sessions: **1a** = restructure + B1/B2/B5/B7–B10/B13/B14/B24 (no behaviour change except the fixes). **1b** = recorder v2 + B3/B20/B21 + launcher and overlay UI. If 1b spills into Oct 16, take the time from Phase 3 (editor) rather than Phase 2.

**Tasks**
1. Move code into the structure in §2. Behaviour must be identical; run the existing self-tests after the move.
2. Recorder rewrite (`renderer/recorder`):
   - Screen: `getDisplayMedia({ video: { frameRate: 60, width: {ideal: native}, height: {ideal: native} }, audio: systemAudio })`. Set `track.contentHint = 'detail'`. Record it **directly** with MediaRecorder, preferring `video/mp4;codecs=avc1` and then `video/webm;codecs=h264`, at `videoBitsPerSecond` = 25 Mbps (≥1440p) or 16 Mbps (1080p).
   - Camera: a separate MediaRecorder, 1280×720 (or 1920×1080 when quality ≥ 1440p), 8 Mbps. Recorded unmirrored.
   - Audio: mic (+ system loopback) mixed into the **screen** recorder's stream.
   - Keep segment logic (pause = end segment, resume = new segment, Live Rewind = trim/drop segments) for **both** recorders in lockstep. A segment is the pair `screen_N` + `cam_N`.
   - `timeline.json`: segments `[ {n, dur} ]`, crop, display size + scale factor, bubble keyframes `[t, x, y, w, h, shape, filter, frame, visible]` (written on every move, resize, style change or cam toggle), cursor at **60 Hz** `[t, x, y]`, clicks `[t, x, y, button]`, drawing on/off.
   - Delete the canvas compositor, `fakeCam` canvas trick excepted (keep it for self-tests, behind `cfg.fakeCam`).
3. Quality presets: **Source (default)**, 4K, 1440p, 1080p, 720p. "Source" = native capture resolution, no scaling. Scaling only happens in the composite step.
4. Cursor: the ring window must be content-protected (presenter-only feedback) and move with 60 Hz polling. Better still, drop the ring window and render cursor highlight and click ripples in the player from `timeline.json` (Phase 2 task 5). The OS cursor in the screen track is the "real" cursor.
5. Windows-source recordings: no camera position on screen. Place the bubble bottom-left in the composite (keyframe default).

**Acceptance (self-test scenarios in `tests/e2e/selftest.sh`)**
- `screen-cam`, 10 s, fakeCam, pause at 3 s, resume at 4 s, rewind to 2 s. Then `ffprobe`:
  - screen intermediate: native resolution (e.g. 2880×1800), avg_frame_rate ≥ 55 fps, bitrate ≥ 12 Mbps
  - total recorded duration within ±0.15 s of expected
- Frame pacing: `ffprobe -show_frames` on the screen intermediate gives a pts-delta standard deviation < 4 ms (no judder).
- No ring, bubble or controls visible in any screen-track frame (check one frame visually, then delete it: it contains the user's screen).
- Unit tests pass (`node --test tests/unit`).

#### Phase 1 results (executed 2026-10-15, display 1440×900 @2x, so native = 2880×1800)
Status: **all checks pass** (`node tests/e2e/run.js all`: 59/59 = acceptance 27, idle 8, cam 6, window 11, ui 7; unit tests 70/70). Numbers are from one run; the range over the last runs is shown where it moved.

| Acceptance check | Target | Measured |
|---|---|---|
| Screen intermediate size | native | 2880×1800 (every segment) |
| Avg fps, screen track | ≥ 55 | 58.0 and 57.6 (runs ranged 57.3–58.0) |
| Bitrate, screen track | ≥ 12 Mb/s | 49.1 and 48.6 Mb/s (noise patch on screen; see caveat 1) |
| Frame pacing, pts-delta std | < 4 ms | 0.64 ms and 1.43 ms (range since the warm-up fix 0.61–1.48) |
| Duration, 10 s script (3 + 1 + 2 s kept, rewind at 6 s) | 6.0 ± 0.15 s | timeline 5.974 s, raw media 5.973 s, published 5.980 s |
| Overlays absent from screen track | none | controls, bubble and ring guard windows 99.7–99.9 % flat green, with the overlay confirmed on screen over each guard |
| Published video at Source | native, 60 fps | 2880×1800, 60.0 fps, 35.9 Mb/s, AAC |
| 1080p / 720p re-composite | even width, same length | 1728×1080 (2.0 s to composite, 12.5 Mb/s), 1152×720 (1.3 s, 12.5 Mb/s) |
| Bubble composited where it was live | skin colour | mean rgb 244,203,158 vs skin 242,201,160 |
| Cursor feed | ~60 Hz | 60 Hz over 601 ticks, worst gap 35.9 ms, 2 late (18.8 ms and 0 late in the run before) |
| Streamed chunks (B3) | on disk as recorded | 13 chunks, 54.9 MB |
| `cam` (camera only), 3 s | | 1920×1080, 3.007 s timeline, 3.000 s published, 60 fps, AAC |
| `idle` (real desktop, no test content), 5 s | informational | raw track 57.0 fps; **2.1 Mb/s in one run, 30 Mb/s in this one** (depends on what is on your screen); published 60 fps, 10.5 and 29.2 Mb/s |
| `window` (one window source), 4 s | | native 960×540, bubble bottom-left, no cursor feed, 3.506 s against 3.5 s |
| `ui` (started through the launcher, 1080p preset, mic off) | | mode screen, 1728×1080, 60 fps, 3.07 s |

**How I read the checks (decisions, so you can overrule them)**
- "No ring, bubble or controls in any frame" is checked **numerically**, not by looking: flat-green guard windows are placed exactly under the three overlays, and the track must show green there. Looking would have put your screen in front of me.
- "Rewind to 2 s" = a rewind issued at 6 s of the script; the kept length is 2.0 + 4.0 = 6.0 s.
- `ffprobe` is not available (ffmpeg-static only), so `tests/e2e/probe.js` reads frame timestamps through ffmpeg instead.
- On Node 24, `node --test tests/unit` no longer expands a directory. Use `npm test` or `node tests/unit/index.js`.

**Caveats (read these)**
1. **The ≥ 12 Mb/s check only holds for demanding content.** The hardware encoder spends bits where the picture changes. With a noisy patch on screen it writes 48 Mb/s (it overshoots the 25 Mbps target); on a quiet desktop the raw track was **2.1 Mb/s** in one run (30 Mb/s in another, with more happening on screen). That is not a defect, but "12 Mb/s" is therefore a statement about the encoder settings, not about every recording. The published file is re-encoded at 12/20/35 Mb/s targets by height.
2. **Variable frame rate in raw tracks.** A static screen produces fewer frames (57 fps average, max gap 51 ms when idle). The composite step re-times to a constant 60 fps, so the published file is 60.0 fps.
3. **Raw tracks are deleted after a successful composite** (privacy and disk) unless `SPOOL_KEEP_RAW` is set. Tests set it.
4. **Mid-recording pen/notes use still costs a short capture hiccup.** In the `window` scenario, turning the pen on and the notes window on/off produces one gap of about 50–130 ms in the screen track and the cursor feed, varying run to run (it was about 325 ms before). I removed the largest part: macOS `setBounds(..., animate)` blocks the whole main process for its duration, so all window resizing is now a timer-driven ease (`windows.easeBounds`). The rest is not attributed. The acceptance run (no pen use) is unaffected. Open item for Phase 2.
5. **B20 is "created hidden before capture, shown on first pen use"**, not lazy creation. Lazy creation froze capture by about 330 ms when measured.
6. **Probe findings that shaped the code:** a fresh MediaRecorder's first 2–3 frames arrive late, so each recording does a 400 ms throwaway warm-up (this took pacing std from up to 4.5 ms to under 1.5 ms); creating or showing a window mid-capture stalls it, so every overlay is created and painted before `__begin`; `track.getSettings()` is wrong for window capture (reported 7680×4320), so the real size is measured from a frame; Chromium lists only layer-0 windows as capture sources.
7. **Colour:** the Loom reference PNGs carry a Display P3 profile (`cICP`), so sampled colours are stored as `color(display-p3 …)` in `shared/ui.css`. Writing the same numbers as sRGB hex washed the red button out (174,66,41 instead of 188,56,28).

**Interim composite bridge (until Phase 2).** `pipeline/composite.js` is a pure function from `timeline.json` plus segment files to one ffmpeg command: concat, crop, lanczos downscale (never upscale), 60 fps, shape-masked camera bubble following the recorded keyframes, one hardware encode. Not yet baked in: camera filters and frames, cursor highlight and click ripples, zoom, speed. Those are recorded in the timeline and visible live, but **absent from the published video until Phase 2**.

**UI (§3d) status.** Done to the Loom reference: launcher and control bar (tokens sampled from `design/loom-ref/`, living only in `shared/ui.css`). **No reference exists** for the camera bubble, countdown, speaker notes, area picker or annotator, so they were moved onto the tokens and keep their old layout and functions. Send references before Phase 2 if you want them restyled. Deliberate deviations from Loom: a one-line summary under the launcher rows; the launcher's Effects/Quality/Notes/More replace Loom's Blur/Public slots; control-bar tooltips are native `title` tooltips.

**Behaviour changes to know about**
- The Dock icon is hidden while any recording overlay is up (B25), and returns afterwards.
- Source quality is the default and big: published 35.9 Mb/s on busy content (about 270 MB/min), 10.5 Mb/s on a quiet desktop (about 80 MB/min). This bears on decision 2 in section 5.
- **Do not rebuild `Spool.app`** until Phase 5: an ad-hoc-signed rebuild resets Screen Recording permission. Phase 1 did not rebuild it. Run the new code with `npm start`.

### Phase 2: Fast pipeline (composite, publish, AI in the background) · Oct 16
**Also in this phase:** bugs B4, B6, B11, B12, B15–B19, B22 and UI items U3, U11, U12, U14–U19.

**Tasks**
1. `pipeline/composite.js` — a pure function `(timeline, files, quality) → ffmpeg args`:
   - per segment: trim each input with `-t dur`, then `concat` the screen segments and the cam segments separately
   - crop (custom area) and scale (quality preset) on the screen stream
   - camera: scale to the bubble size, apply the filter (map our 7 filters to `eq`/`colorchannelmixer`/`hue` equivalents and document any that differ), `alphamerge` with the shape mask PNG from `masks.js`, overlay the frame/ring PNG
   - bubble position: piecewise-constant overlay x/y from keyframes using `enable='between(t,a,b)'` (one overlay per keyframe span; cap at 60 spans, merge tiny moves)
   - encoder: `h264_videotoolbox -b:v {12M@1080p, 20M@1440p, 35M@4K} -profile:v high -allow_sw 1`, AAC 160k, `+faststart`. Fall back to `libx264 -preset veryfast -crf 18` when videotoolbox is unavailable (Windows/Linux)
   - unit tests snapshot the args for 4 representative timelines
2. Orchestrator order: **composite → thumbnail → status `ready` (owner can watch) → Privacy Guard → (blur pass if needed) → `shareable: true` → Transcriber → Planner → Insights → Guide.**
   - The viewer API checks `shareable` (fail closed). The owner's watch page shows a "Privacy Guard is checking… viewers can watch when it's done" banner.
   - The blur pass reuses the composite output and re-encodes with videotoolbox. It only runs when something was found.
3. Transcription speed. Benchmark first and write the results into this file:
   - Option A: transformers.js with `onnx-community/whisper-base` at `dtype: 'q8'` (or `whisper-tiny.en` for English), run in the worker
   - Option B: whisper.cpp with Metal (`smart-whisper`, or a prebuilt binary downloaded once into userData). Needs no Python
   - Target: ≤ 0.25× realtime on Apple silicon (24 s clip → ≤ 6 s). Keep the transformers.js path as the cross-platform fallback.
4. OCR speed:
   - macOS: a tiny Swift CLI using the Vision framework (`VNRecognizeTextRequest`, accurate mode), compiled at build time with `xcrun swiftc` (skip if Xcode CLT is missing), returning JSON lines with normalised boxes. Fall back to tesseract.js.
   - Dedupe frames with a 64-bit difference hash before OCR (most screen-recording frames are near-identical).
   - Target: Privacy Guard ≤ 10 s for a 24 s clip.
5. Player effects from `timeline.json` (in `server/public/player.js`): cursor highlight, click ripples, auto-zoom (smooth spring toward the click, 1.0→1.8×, ease out after 1.5 s idle). Toggled per video in the editor.

**Acceptance**
- 24 s Screen + Cam: Stop → owner can press play in **≤ 8 s**. Privacy Guard done ≤ 20 s. AI notes ≤ 60 s. Measure and log each stage duration in `spool.log`.
- Output is 1 encode generation: ≥ 8 Mbps at 1080p, native resolution when "Source", 60 fps.
- A viewer request (cookie `sp_asviewer=1`) to a video whose Privacy Guard hasn't finished gets 423/"checking", never the file.
- Test video with a fake API key and email (see `agents` tests): both blurred in the published file.

### Phase 3: Editor · Oct 17
**Also in this phase:** B23, U13 (custom player controls + hover thumbnails).

Page `server/public/editor.html` (owner-only). Non-destructive: edits are a list in the video record. "Apply" renders a new `video.mp4` with videotoolbox and keeps `video.prev.mp4` for one-level undo.
1. Timeline with waveform (decode the audio once to a peaks JSON), zoom up to 50×, playhead, trim handles, split, delete range.
2. Edit by transcript: Whisper **word** timestamps (`return_timestamps: 'word'`). Select words → delete → this creates cut ranges.
3. Clean up: filler words (um, uh, like-as-filler, you know) from word timestamps; silences > 0.8 s via `silencedetect`; "Rambles" = the LLM proposes repeated or tangent sentence ranges. Each shows as a reviewable list of proposed cuts before applying.
4. Stitch/insert: append or insert another library video or a new recording at the playhead.
5. Overlays (text, arrow, box, blur box) with start/end, and variables `{{name}}` (already rendered by the player, so only the editor UI is missing). Caption style, background, CTA, custom thumbnail (frame picker or upload), GIF preview (3 s, `palettegen`).
**Acceptance:** cutting 3 transcript words from a test clip removes exactly those ±50 ms; the filler pass finds the "um"s in a `say`-generated test clip; undo restores the previous file.

### Phase 4: AI actions + MCP · Oct 18
1. "AI Actions" tab: one-click outputs from transcript + guide + screen text: SOP doc, PR description, bug report, Jira/Linear issue body, follow-up email/message, meeting recap. Each is an agent with its own prompt and JSON schema, run through `agents/llm.js`, cached per video.
2. Send to: Slack (incoming webhook), GitHub issue, Linear issue (GraphQL), Jira issue (REST v3). Tokens stay local; every send needs an explicit click and shows a preview first.
3. **Spool MCP server** (`mcp/server.js`, stdio, `@modelcontextprotocol/sdk`): tools `list_videos`, `search_videos`, `get_transcript`, `get_guide`, `get_action_plan`. README shows `claude mcp add spool -- node mcp/server.js`. This is the strongest "agentic structure" demo.
4. Record for agents: build an "Action Plan" (voice + clicks + window titles + guide screenshots) as a markdown prompt to paste into Claude or Cursor.
**Acceptance:** Claude Code can list and read a Spool transcript over MCP. Each action produces valid JSON for 3 different test videos.

### Phase 5: Ship · Oct 19–20
1. Package size: exclude non-darwin `onnxruntime-node` binaries and unused dependencies from the packager (`--ignore`). Target < 400 MB.
2. Stable signing. **Ask the user first**: creating a self-signed "Spool Dev" code-signing certificate in the login keychain makes Screen Recording permission survive rebuilds. Without it, permission resets on every build.
3. README: one-paragraph pitch, GIF, install (`npm install && npm start`, or download the `.app` zip from Releases), first-run permissions, Mermaid architecture diagram (§1) and agent-crew diagram, feature table (from `FEATURES.md`), limits, privacy model.
4. GitHub Release with a zipped `Spool.app` (ad-hoc signed: document "right-click → Open").

### Phase 6: Demo · Oct 21 (buffer Oct 22)
Business plan one-pager, 3-minute demo script, a recorded demo (made with Spool itself), Q&A cheat sheet.

### Cut list (in this order, if behind)
Chrome extension → SDK → Jira → virtual backgrounds → meeting/calendar recording → GIF thumbnails. **Never cut:** Phases 1–2 quality and speed, the Privacy Guard, the MCP server, the README.

---

## 3b. Bug audit (2026-10-14, every item confirmed in the code)

Fix each bug in the phase shown. Each fix gets a unit test or a self-test where possible. Names refer to functions, not line numbers, because Phase 1 moves the files.

### Critical: data loss, crashes, security
| ID | Where | Bug | Fix | Phase |
|---|---|---|---|---|
| B1 | `store.js` `load()`/`save()` | `save` is a plain `writeFileSync`. A crash mid-write leaves invalid JSON, `load()` swallows the parse error and returns an **empty db**, and the next `mutate()` saves it, **wiping the whole library**. | Atomic write (tmp file + `fs.renameSync`), keep `db.json.bak` of the last good copy, and if parse fails load the backup and log loudly. **Never** fall back to empty when a file exists. | 1 |
| B2 | `store.js` | Every `get`/`update` re-reads and re-parses the whole db. Viewer heartbeats (1/s) rewrite the file every second. Gets slower with library size and wears the disk. | In-memory db, loaded once. Writes debounced (250 ms) and flushed on quit. Expose `store.events` (EventEmitter) for change notifications (used by SSE, U3). | 1 |
| B3 | `recorder.js` `stop()` → `rec:finish` | The whole recording is held in RAM as Blobs, then copied over IPC as ArrayBuffers. At 25 Mbps a 10-minute video is about 1.9 GB, so the renderer crashes and the recording is lost. | Stream every `dataavailable` chunk to main (`rec:chunk`, appended to `screen_N.webm` / `cam_N.webm` on disk). Stop only sends the manifest. | 1 |
| B4 | `orchestrator.js` | No job queue. Two recordings back to back run two Whisper + OCR + ffmpeg pipelines at once and thrash the CPU. If the app quits mid-processing, the video stays "Processing…" forever. | A single-concurrency job queue persisted in the db (`jobs`). On startup, resume or re-queue jobs left `processing`, and mark them `failed` after 2 attempts. | 2 |
| B5 | `server.js` owner routes | Owner means "loopback + localhost Host". **Any website open in the user's browser** can send simple cross-site POSTs to `http://localhost:4747` (e.g. `/api/videos/:id/rerun`, `/api/notifications/read`). DELETE/PUT are saved only by CORS preflight. | Middleware on every mutating route: require `Sec-Fetch-Site: same-origin`/`none` or an `Origin` equal to the server origin, otherwise 403. Add a per-launch CSRF token header for owner fetches. | 1 |
| B6 | `auth.js` `effectivePrivacy` | If the workspace default is "Password" and the video has no password hash, the gate asks for a password **nothing can satisfy**, so the video becomes unwatchable. | When mode is password and there's no hash: block viewers with a clear "owner hasn't set a password" message, and make the Share dialog demand one. Remove "Password" from the default-privacy options. | 2 |

### High: broken behaviour the user will hit
| ID | Where | Bug | Fix | Phase |
|---|---|---|---|---|
| B7 | `main.js` `ensurePermissions` | **Cam-only mode is blocked** when Screen Recording isn't granted, even though it doesn't need the screen. | Check screen permission only when `mode !== 'cam'`. | 1 |
| B8 | `launcher.js` focus handler | `loadDevices()` calls `getUserMedia({audio, video})` **every time the launcher gets focus**, so the camera light flashes and it takes about 300 ms each time. | Call `getUserMedia` once, only if device labels are empty. Re-enumerate on `navigator.mediaDevices.ondevicechange`. | 1 |
| B9 | `main.js` `registerShortcuts` | ⌥⇧P keeps its own `paused` flag. After pausing from the control bar, the shortcut needs two presses. | Shortcuts send `toggle-pause`. The recorder owns the state. | 1 |
| B10 | `watch.html` (image items) | For screenshots, `#v` is replaced by an `<img>`, so **commenting or reacting on a screenshot throws** (`$('v')` is null). | `const now = () => $('v')?.currentTime || 0`, used everywhere. | 1 |
| B11 | `server.js` `listen()` | Toggling "People on my network" calls `server.close(go)`, which waits for keep-alive connections from any open watch page. The LAN switch **may never apply**. | `server.closeAllConnections()` before `close`. Or listen on both sockets and close the LAN one. | 2 |
| B12 | `llm.js` `json()` | No timeout on the Ollama chat request. If Ollama stalls, that agent and everything after it hangs forever. | `AbortSignal.timeout(120_000)` and one retry. The orchestrator marks the agent as an error. | 2 |
| B13 | `watch.html` header | The **Edit** button links to `editor.html`, which doesn't exist yet (404). The **AI Actions** tab is a placeholder. Both look broken in a demo. | Hide both until Phases 3 and 4 ship them. | 1 |
| B14 | Library while "previewing as viewer" | The `sp_asviewer` cookie makes `/` return a raw JSON 403, and the owner is stuck. | `/` redirects to a small page: "You're previewing as a viewer: [Back to owner view]". | 1 |

### Medium: performance, privacy, robustness
| ID | Where | Bug | Fix | Phase |
|---|---|---|---|---|
| B15 | `privacy.js` `scan` | One ffmpeg spawn and seek **per sampled frame**. | One ffmpeg run with `select='gt(scene,0.03)+not(mod(n,90))'` writing all frames, plus dHash dedupe. | 2 |
| B16 | `orchestrator.js` | When something is blurred, the **unblurred `original.mp4` stays on disk forever**. | Delete it after publishing, unless the user ticks "Keep original (owner only)". Retention policy also covers it. | 2 |
| B17 | `transcribe.js` worker | First use silently downloads about 150 MB from Hugging Face. Offline, it fails. | Settings → AI shows the model status and a "Download models" button with progress. Pipeline marks the Transcriber "waiting for model" instead of erroring. | 2 |
| B18 | `extras.js` `translateSegments` | Two viewers requesting the same language at once run the LLM twice. | Cache the in-flight promise per (video, lang). | 2 |
| B19 | `player.js` `zoomAt` | Linear scan of the whole cursor track **every animation frame**: 36k entries at 60 Hz × 10 min. | Binary search plus the last index. Skip work while paused and unchanged. | 2 |
| B20 | `main.js` `startRecording` | The full-screen drawing overlay is created for every recording even when the pen is never used. That's an extra full-screen transparent window composited the whole time. | Create it lazily on first pen use. | 1 |
| B21 | `main.js` cursor ring | Moved with `setPosition` at 30 Hz, so it trails the cursor and is captured into the video (the user's "laggy cursor"). | Covered by Phase 1 task 4. | 1 |
| B22 | `server.js` viewer POSTs | No rate limit on comments, reactions and heartbeats from LAN viewers. | Simple per-IP token bucket (20 writes per 10 s). | 2 |
| B23 | `notes/index.html` | Dictation uses the deprecated `ScriptProcessorNode`. | AudioWorklet (tiny inline module). | 3 |
| B24 | All windows | Self-test code ships inside `main.js`. | Move to `main/selftest.js`, loaded only when `SPOOL_SELFTEST` is set. | 1 |
| B25 | Overlays and the Dock | Found in Phase 1: a regular (Dock) app cannot show windows over another app's full-screen Space. | The app runs as an accessory (Dock icon hidden) while any overlay is up, via `holdOverlay`/`releaseOverlay` plus `skipTransformProcessType`. Verified by the guard windows in the acceptance run. | 1 ✅ |

---

## 3c. UI smoothness spec

The goal: nothing flickers, nothing jumps, every interaction answers within 100 ms, and every animation runs at 60 fps (transform/opacity only). Apply it in the phases shown. Treat each line as an acceptance check.

### Global
- **U1 Motion tokens** in `shared/ui.css`, imported by every window: `--ease: cubic-bezier(.2,.8,.2,1)`, durations 120 ms (hover), 180 ms (popover/modal), 240 ms (panel). Everything respects `@media (prefers-reduced-motion: reduce)` by turning off transforms. *(Phase 1)*
- **U2 One design system**: the launcher, control bar, bubble toolbar, notes and annotator share colour, radius, shadow and focus-ring tokens. The launcher gets a dark mode (it's the only window still light-only). **The token values follow the Loom skin in §3d, not the old green/purple theme.** *(Phase 1)*
- **U3 No polling re-renders.** Replace the watch page's 3 s poll and the library's 5 s poll with **Server-Sent Events** (`GET /api/events?video=:id`), driven by `store.events` (B2). Re-render only the part that changed. Today every poll rebuilds the tabs, reactions and the whole grid, which causes flicker and lost hover and scroll position. *(Phase 2)*

### Launcher
- **U4** Opens with a 160 ms fade + 8 px slide. Remembers its last position. Esc closes it. ⌥⇧R toggles it.
- **U5** The device lists never cause layout jumps: reserve their height and show the last-used device name immediately from settings, before enumeration finishes.
- **U6** Cut the height: Mode → Area → Camera → Mic → **Start** are always visible. Shape, filter, frame, quality and toggles live in a collapsible "Options" row whose summary line ("Circle · Warm · 1440p · system audio") shows the current choices.
- **U7** Start shows "Preparing…" with a spinner while streams open, then the countdown. Target: under 150 ms from click to visible feedback.
*(Phase 1)*

### Recording overlays
- **U8** Countdown: 3-2-1 with a ring that drains each second, and a click or Space skips it. Fade the whole overlay out over 120 ms at the end.
- **U9** Control bar: draggable, remembers its position, and the hover tooltips show shortcuts. The timer uses `font-variant-numeric: tabular-nums` (no jitter). Rewind and colour panels expand with a height transition instead of popping, and resizing the window is animated (`setBounds(..., true)`).
- **U10** Bubble: resizing and shape changes animate (CSS on the preview, animated `setBounds`). Snapping eases in over about 120 ms. The toolbar appears on hover after an 80 ms delay so it doesn't flash while dragging.
- **U11** Cursor highlight follows the OS cursor at display refresh with zero lag in the **recording**, because the player renders it from the track (Phase 2 task 5). The live presenter ring (content-protected) is optional and off by default.
*(Phases 1–2)*

### Watch page
- **U12** Instant shell: header, title, poster and skeletons render before the API call returns (the poster comes from `thumb.jpg` immediately).
- **U13** Custom player controls in the brand style: scrubber with chapter ticks, reaction markers and a hover thumbnail (sprite sheet generated at publish, 10×10 grid), keyboard J/K/L, ←/→ ±5 s, F, M, C (captions), 1–9 = 10–90 %. Native controls stay as a fallback.
- **U14** Tabs switch with a sliding underline and keep their scroll position. The comments list appends new items with a 150 ms fade instead of re-rendering everything.
- **U15** Reactions: optimistic update (count bumps instantly, and the server reconciles). Super reactions burst with confetti particles on a canvas, not 9 DOM nodes.
- **U16** The share modal scales in from 96 % over 180 ms, traps focus, and Esc closes it. Copy buttons briefly change to "Copied ✓".
*(Phase 2, U13 in Phase 3)*

### Library
- **U17** Thumbnails are `<img loading="lazy" decoding="async">` with a fixed aspect-ratio box (no layout shift) and a fade-in when loaded. The GIF preview starts after a 250 ms hover.
- **U18** Diffed grid updates (keyed by id). Processing cards show a live progress ring from SSE.
- **U19** Drag-and-drop upload shows a progress bar (XHR upload progress), and a new card appears immediately in a "Uploading" state.
*(Phase 2)*

### How to verify smoothness
- Chrome DevTools Performance: record a 10 s interaction on the watch page and the library. No long tasks over 50 ms, and no layout shifts (CLS = 0).
- Electron windows: `--enable-gpu-rasterization` stays on. Check the control bar and bubble with the FPS meter (`webContents.openDevTools` → Rendering → Frame rendering stats) during a recording.

---

## 3d. Loom-fidelity UI (decided by the user, 2026-10-15)

**Direction:** Phases 1–3 build a Loom clone first. Copy Loom's layout, screen flow, wording, spacing, component behaviour and colours as closely as possible. This **replaces** the green/purple theme. Spool's own AI features come after parity.

**Copy freely:** layout, information architecture, button labels and microcopy, spacing, radii, shadows, colour values, animation timing and keyboard shortcuts.

**Never copy (trademark and copyright; the repo is public and graded):**
- the Loom name and logo, Loom's app icon, and Loom's illustrations or empty-state art
- Loom's licensed font. Use Inter or the system font instead.
- Loom screenshots in the repo or README

Keep the name **Spool** and its own logo. For icons, use inline SVGs drawn in the same style, such as copies of MIT-licensed Lucide icons. Lucide is not a dependency.

**References:** `design/loom-ref/` holds screenshots from the user's Loom account. Add `design/loom-ref/` to `.gitignore`. Sample every colour from these screenshots, never guess hex values. If a screen has no reference, ask the user for one before styling it.

**Skin tokens:** put every colour, font, radius and shadow in `shared/ui.css` under `:root[data-skin="loom"]`, which is the default. A later `data-skin="spool"` can bring back a brand look by swapping one block. Nothing outside that file may hard-code a colour.

**Screens, in order, each with a side-by-side check against the reference at the same window size.** Write the visible differences in a list, then fix them.
1. Recorder menu (the launcher): mode tabs, source picker, camera and mic dropdowns, toggles, Start button. *(Phase 1)*
2. Control bar, camera bubble, countdown. *(Phase 1)*
3. Watch page: header, player, title row, reactions bar, the transcript and comments side panel, share modal. *(Phase 2)*
4. Library: left nav (Home, My Library, Spaces, Watch Later, History, Settings…), video grid cards, folder view. *(Phase 2)*
5. Editor and Settings. *(Phase 3)*

**Own AI features during Phases 1–3:**
- Privacy Guard, Auto-Guide, Insights and Planner stay in the code and keep running in the background. They never block publishing.
- No new UI for them until Phase 4.
- Where they already have UI, put it where Loom puts its own AI features (summary, chapters, AI title) so it looks native to the clone.

---

## 4. Working rules for the executor
- Start each session by reading `PLAN.md` and `FEATURES.md`, and update both at the end (status + measured numbers).
- Self-tests capture the user's real screen. Keep runs short, only inspect frames you need, and **delete test captures right after**.
- Never change macOS system or security settings, and never toggle permissions. Ask the user.
- Do not rebuild `Spool.app` more than once per phase. Tell the user when a rebuild will reset permissions.
- Do not add dependencies without a reason written here. Allowed new ones: `@modelcontextprotocol/sdk`, and possibly `smart-whisper` (Phase 2 benchmark).
- Keep `npm start` working on a clean clone at every commit.
- Commit at the end of each phase (initialise git in Phase 1 if needed) with a message listing the acceptance results.

## 5. Decisions the user still owns
1. Signing certificate (Phase 5.2): yes/no.
2. Whether "Source" quality (large files, about 150 MB/min) or 1440p should be the default.
3. Cut-list order if time runs short.
