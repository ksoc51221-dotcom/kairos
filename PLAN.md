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
3. **The owner sees the video as soon as the composite finishes** (target ≤ 8 s for a 24 s clip). Viewers stay blocked until the Privacy Guard passes, on the screen **and on the speech** (Phase 4). This keeps it fail-closed for viewers only.
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

**Interim composite bridge (closed in Phase 2: camera filters and frames are now in the published video; cursor highlight, ripples and zoom are rendered by the player).** `pipeline/composite.js` is a pure function from `timeline.json` plus segment files to one ffmpeg command: concat, crop, lanczos downscale (never upscale), 60 fps, shape-masked camera bubble following the recorded keyframes, one hardware encode. Not yet baked in: camera filters and frames, cursor highlight and click ripples, zoom, speed. Those are recorded in the timeline and visible live, but **absent from the published video until Phase 2**.

**UI (§3d) status.** Done to the Loom reference: launcher and control bar (tokens sampled from `design/loom-ref/`, living only in `shared/ui.css`). **No reference exists** for the camera bubble, countdown, speaker notes, area picker or annotator, so they were moved onto the tokens and keep their old layout and functions. Send references before Phase 2 if you want them restyled. Deliberate deviations from Loom: a one-line summary under the launcher rows; the launcher's Effects/Quality/Notes/More replace Loom's Blur/Public slots; control-bar tooltips are native `title` tooltips.

**Behaviour changes to know about**
- The Dock icon is hidden while any recording overlay is up (B25), and returns afterwards.
- Source quality is the default and big: published 35.9 Mb/s on busy content (about 270 MB/min), 10.5 Mb/s on a quiet desktop (about 80 MB/min). This bears on decision 2 in section 5.
- **Do not rebuild `Spool.app`** until Phase 5: an ad-hoc-signed rebuild resets Screen Recording permission. Phase 1 did not rebuild it. Run the new code with `npm start`.

### Phase 2: Fast pipeline (composite, publish, AI in the background) · Oct 16 — ✅ done 2026-10-15 (results below the tasks)
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

#### Phase 2 results (executed 2026-10-15, Apple M2 8-core, 1440×900 @2x; Ollama qwen3:8b, resident)
Status: **all checks pass** (`SPOOL_E2E_RING=0.12,0.45 node tests/e2e/run.js all`: 77/77 = Phase 1 scenarios 59 + `pipeline` 18; `npm test`: 97/97). One run, numbers below; the range over my last runs is shown where it moved.

| Acceptance check | Target | Measured |
|---|---|---|
| Stop → owner can press play (24 s Screen+Cam, 1080p, noise patch = worst-case content) | ≤ 8 s | **7.6 s** (7.4–7.6 over 5 runs): composite 7.5 s + thumbnail 0.1 s. **Thin margin**, see caveat 1 |
| Privacy Guard clears the video for viewers (since Stop) | ≤ 20 s | **18.2 s** (16.9–19.2): OCR+rules 3.9 s, blur pass 6.7 s, model judgement running alongside the blur |
| AI notes finished (since Stop) | ≤ 60 s | **26.3 s** total: transcribe 2.6 s, Planner/Insights/Guide 5.4 s |
| Published file | ≥ 8 Mb/s at 1080p, 60 fps, one encode generation | 1728×1080, 12.3 Mb/s, 60.0 fps, AAC (the blur pass is the only second generation, and only when something was found) |
| Source quality published | native, 60 fps | 2880×1800, 60.0 fps, 35.6 Mb/s |
| Fake e-mail + fake API key on screen | both blurred | both found by the rules; luma std of the two regions 102→6 and 103→6 (blurred flat) |
| Unblurred copy | not kept (B16) | `original.mp4`, `video.blur.mp4` and `work/` all gone |
| Viewer request before the guard passes | 423, never the file | 423 for page data, video, thumbnail, download, track and event stream (unit tests); the owner always gets 200 |
| Privacy Guard OCR | ≤ 10 s | **1.5–3.9 s** for 12–25 frames read of 48 sampled (Apple Vision) |
| Speech | ≤ 0.25× realtime | **0.07×** (27 s clip in 1.9 s) with the existing model |
| Phase 1 checks (rerun) | | all pass: pacing std 1.39 and 1.57 ms, 57.3–57.5 fps, 48 Mb/s raw, cursor feed 60.1 Hz |

**Benchmarks (speech, 27.2 s `say` clip, Apple M2, warm cache)**

| Model | Load | Transcribe | × realtime |
|---|---|---|---|
| `Xenova/whisper-base` fp32 (kept) | 0.6–0.7 s | 1.4–1.9 s | 0.05–0.07 |
| `onnx-community/whisper-base` q8 | 0.4 s | 1.6–1.7 s | 0.06 |
| `onnx-community/whisper-tiny.en` q8 | 0.3 s | 1.0–1.1 s | 0.04 |

The old 108 s was not Whisper. It was OCR in WASM, two software encodes and everything fighting for the CPU. **No change to the speech engine**: whisper.cpp / `smart-whisper` was not needed and is not added. Word timestamps for Phase 3 are a flag on the same pipeline.

Encoder benchmark (24 s of 1728×1080, same content): `h264_videotoolbox` 6.5 s (about 220 fps, linear in length, the same with 1–4 parallel encodes, so it is one hardware engine), `libx264 ultrafast` 2.4 s but 93 MB instead of 35 MB, `veryfast crf20` 4.2 s / 32 MB. I kept VideoToolbox as §3 says.

**What was built**
- **Composite** (`pipeline/composite.js`, `filters.js`, `masks.js`): camera filters (all 7, ffmpeg chains; documented where they differ from the CSS preview), frame rings (all 6, drawn from the same signed-distance maths as the shape mask), runs split on size/shape/filter/frame. The same filter graph also writes the Privacy Guard's frames (2 fps JPEGs at ≤ 2048 px plus a 9×8 gray stream for the hash), so scanning needs no second decode. Snapshot tests of the full ffmpeg arguments for 4 timelines (`UPDATE_SNAPSHOTS=1 npm test` regenerates).
- **Order** (`agents/orchestrator.js`): composite → thumbnail → `ready` → Privacy Guard → blur if needed → `shareable` → Transcriber → Planner → Insights → Guide. Each finished stage is checkpointed (`pipe`), so a quit resumes after the last one. Stage durations go to `spool.log` (`pipeline <id> <stage> <s>`) and to `timings` in the video record, shown in the owner's AI Crew tab data.
- **B4 queue** (`agents/queue.js`): one job at a time, persisted in `db.jobs`, requeued once after an interrupted start and marked failed after two. Tests cover overlap, failure, and both restart cases.
- **Privacy Guard**: frames picked by a 64-bit difference hash (duplicate = ≤ 2 bits different, but a frame is read at least every 2 s so a small change cannot hide); Apple Vision OCR through `agents/native/vision-ocr.swift` (compiled once into `<data>/models/bin`, about 10 s, falls back to tesseract.js without Xcode's command line tools or off macOS); rules gate publishing; the model judgement runs while the first blur pass encodes, so a clean video waits for max(blur, model) and a video the model flags beyond the rules gets a second blur pass (not exercised by the e2e: the model found nothing extra on the fixture).
- **Server**: B6, B11, B12, B16, B17, B18, B22 (below), SSE `/api/events`, `/api/models`, per-video `cursorFx` / `autoZoom`.
- **Player** (`server/public/player.js`): cursor highlight, click ripples and auto-zoom from `timeline.json` (spring, 1.8×, starts 0.25 s before a click, eases out 1.5 s after the last one), B19 binary search with a sequential hint, skip while paused and unchanged, confetti on one canvas.
- **UI**: U3 (event stream on watch page and library, morph updates), U11, U12, U14, U15, U16, U17, U18, U19.

**Bugs closed:** B4 (queue), B6 (blocked viewers get "owner hasn't set a password", `password` removed from the workspace default and rejected by the API), B11 (`closeAllConnections` before `close`; a test switches LAN with an event stream open), B12 (120 s timeout, one retry; tested against a server that never answers), B15 (one ffmpeg run for sampling), B16 (unblurred file deleted unless **Keep the unblurred original** is on), B17 (Settings → AI shows model status and a Download button; the Transcriber says "waiting for the speech model" instead of failing), B18 (shared in-flight translation), B19, B22 (20-write burst, 2/s refill, owner exempt).

**Caveats (read these)**
1. **7.6 s vs the 8 s target is the hardware, not slack in the code.** The encode is the cost (about 220 fps on this M2 for noisy content; a quiet screen encodes faster). A longer or busier clip, or an M1 base chip, will miss 8 s. The noise patch in the test is deliberately worst-case. If it matters, the lever is `libx264 ultrafast` for the *owner preview* only (2.4 s, 2.6× bigger file) and VideoToolbox for the final file. Not done.
2. **The model judgement only runs when the model is already in memory.** Cold, qwen3:8b takes 5–20 s to load, which would eat the guard's budget; the guard then runs on its rules alone (e-mail, keys, tokens, cards, SSN, phone, passwords, long secrets) and asks Ollama to load the model for next time. Warm, one judgement call took 4.3–6.1 s here (4.9 s in the final run) and found nothing beyond the rules. So the model's extra catch (names, addresses) is best-effort; the rules are the floor. A recording made right after launch is checked by rules only. Loading the model during a recording cost frames (measured: pacing std 2.7 ms and a 245 ms gap), so it is warmed only when idle (45 s after launch, and 2 s after each job), never while recording.
3. **Dedupe trades a little sensitivity for speed.** 48 frames sampled, 12–25 read. A change smaller than about 3 bits of the 64-bit hash that lasts under 2 s can be missed. Reading every frame would add 2–3 s.
4. **Cursor highlight, ripples and zoom exist only in the player**, not in the downloaded file or the embed's download. Burning them in is an export task (Phase 3).
5. **Camera filters are close to, not identical to, the CSS preview** (hue rotation in YUV vs RGB, additive vs multiplicative brightness). I checked that every filter and frame renders and that the frame art looks right (circle ring, gradient, glow); I did not compare filtered video against the live preview side by side.
6. **The ring-guard acceptance check depends on what else is on your screen.** At the default spot, your Margin app's windows (layer 25) sit on top of the guard, and the check fails for that reason. Use `SPOOL_E2E_RING=0.12,0.45` to move it. I confirmed the cause by listing windows at that spot, not by looking at pixels. A first run during heavy system load (load average 14) also failed the pacing checks; reruns on a calm machine pass.
7. **Verified in the browser pane against a fixture server** (real server, synthetic video, recorded-style cursor feed): cursor ring and ripple drawn, zoom to 1.8× after a click and back out, per-video toggles, owner banner "Privacy Guard is checking…", viewer 423, keyed library updates over the event stream (only the changed card was replaced), lazy images and the progress ring. **Not exercised in a browser:** upload progress, the share-modal focus trap and Esc, tab underline slide, optimistic reactions, confetti. They are syntax-checked and follow the specs, but treat them as untested. The zoom spring was checked numerically (no overshoot, 98 % in 0.53 s) because the background pane throttles animation frames.
8. **Windows and Linux paths** (libx264 fallback, tesseract) are unit-tested as arguments only, not run.

**Not done in this phase**
- §3d screens 3 and 4 (watch page and library in Loom's look). `design/loom-ref/` holds only the recorder-menu screenshot; per §3d, I did not style them without references. **Send screenshots of the Loom watch page (with comments/transcript panel and share modal) and library** and I will do them. The Phase 2 UI work above is behaviour, not skin.
- Burning cursor effects into exports; the `libx264` owner-preview idea in caveat 1.
- U13 and B23 stay in Phase 3.

### Phase 3: Editor · Oct 17
**Also in this phase:** B23, U13 (custom player controls + hover thumbnails).
**Do first (§3d screens 3–5, references arrived after Phase 2 finished):** `design/loom-ref/` now holds the watch page (`16.22.00`), the watch page with the control bar and camera bubble live while recording (`16.22.37`), the library (`16.23.07`) and personal settings (`16.24.22`). Restyle the watch page, library, settings, control bar and bubble to match them. Note that Loom's current accent is **blue**, not purple: re-sample the tokens. Map the watch page's right panel tabs (Edit · Activity · Generate · Transcript · Settings) onto Spool's: the AI crew goes under **Generate**, and the editor's clean-up toggles (silence, filler words, captions) go under **Edit**, the way Loom shows them. Also now in the folder: `share-modal.webp` (Share title, Social and Embed links top right, "Add names, emails, or Space" field, General access row with Public dropdown, footer with Copy link · Share video at 0:00 · Set password · Share) and `countdown-and-control-bar.webp` (blue countdown circle with a cancel ✕ on its left and a skip ⏭ on its right, a tip line under it; full control bar: stop, timer, pause, restart, delete, rewind, more).
**User-reported issues (2026-10-15, from testing the Phase 2 build):**
- **B26 Countdown appeared late, by a varying amount.** Cause: `session.start` created the countdown only after `__prepare` resolved (camera and mic wake-up plus the 400 ms warm-up). **Fixed by Opus on 2026-10-15, not yet verified in the app:** the countdown now starts at once and the streams open while it counts (`await countdown` after `__prepare`). Verify: click Start → countdown visible in < 150 ms (U7), the recording still starts with no gap, cancel during the countdown leaves no stray windows or files.
- **B27 Camera preview before recording, as in Loom.** While the launcher is open in Screen + Cam or Cam mode, show the camera bubble at its saved position so the user sees themselves before pressing Start. Keep this same window when recording starts (do not close and recreate it: that also removes one window creation from the start path). Hide it when the launcher closes without recording, when the mode switches to Screen only, or when the camera is turned off.
- Match the countdown to the reference: cancel ✕ (aborts, deletes the empty record) and skip ⏭ (starts now).

Page `server/public/editor.html` (owner-only). Non-destructive: edits are a list in the video record. "Apply" renders a new `video.mp4` with videotoolbox and keeps `video.prev.mp4` for one-level undo.
1. Timeline with waveform (decode the audio once to a peaks JSON), zoom up to 50×, playhead, trim handles, split, delete range.
2. Edit by transcript: Whisper **word** timestamps (`return_timestamps: 'word'`). Select words → delete → this creates cut ranges.
3. Clean up: filler words (um, uh, like-as-filler, you know) from word timestamps; silences > 0.8 s via `silencedetect`; "Rambles" = the LLM proposes repeated or tangent sentence ranges. Each shows as a reviewable list of proposed cuts before applying.
4. Stitch/insert: append or insert another library video or a new recording at the playhead.
5. Overlays (text, arrow, box, blur box) with start/end, and variables `{{name}}` (already rendered by the player, so only the editor UI is missing). Caption style, background, CTA, custom thumbnail (frame picker or upload), GIF preview (3 s, `palettegen`).
**Acceptance:** cutting 3 transcript words from a test clip removes exactly those ±50 ms; the filler pass finds the "um"s in a `say`-generated test clip; undo restores the previous file.

#### Phase 3 results (executed 2026-10-15, Apple M2, 1440×900 @2x; one batched Electron run at the end, announced to the user first)
**Done**
- **Restyle to `design/loom-ref/` (blue):** watch page (Edit · Activity · Generate · Transcript · Settings; the clean-up toggles are under Edit, the AI crew under Generate), library with sidebar, personal settings, share modal, spaces, embed, countdown, control bar record button. Tokens re-sampled from the screenshots (accent `#3267d4`). Checked with headless Chrome screenshots (light and dark), not by eye in the app.
- **B27:** the camera bubble is shown while the launcher is open, at the saved position, and reused when recording starts (same window id before and during: checked). It closes when the camera is turned off, when the launcher closes, or in Screen-only mode, and comes back with the launcher.
- **Countdown:** ✕ cancel (stops the streams, deletes the empty record and folder, launcher returns, camera preview returns; 8/8 checks) and ⏭ skip (recording goes live; checked).
- **B28:** focus stealing fixed (see §3b). Spool was never frontmost in any e2e scenario.
- **Editor (`/edit/:id`, owner only):** timeline with waveform (100 peaks/s), zoom 1–50× (checked at 50×), playhead, trim handles, split markers, drag-select, delete range, restore; edit by transcript (word timestamps, click to seek, drag to select, delete); Clean up (silences > 0.8 s keeping a 0.3 s breath, filler words, LLM "rambles"), each a reviewable list that only adds to the draft; Insert (library video at playhead or at the end, "Record a new clip" opens the launcher); Overlays (text, arrow, box, blur) with start/end, drag/resize on the picture and `{{name}}` fallbacks; Style (caption style, background, **CTA text + link**, thumbnail from a frame or an uploaded picture, 3 s GIF). Draft autosaves; Apply renders once and keeps one level of undo; every time-keyed field (segments, words, chapters, overlays, comments, reactions, guide steps, cursor/clicks) is remapped.

**Measured**
| Acceptance | Result |
|---|---|
| Cut 3 transcript words ("show you the") removes exactly those ±50 ms | asked for 0.500 s, removed 0.480 s (headless, real ffmpeg + real Whisper on a `say` clip); in the editor UI the 3 selected words produce the single cut 3.000–4.400 s |
| Filler pass finds the "um"s in a `say` clip | found `um@1.40, uh@4.42, um@7.64`; after cutting, Whisper hears no fillers |
| Undo restores the previous file | yes, file and all remapped fields (unit test) |
| B26 countdown painted < 150 ms after the click (Screen only) | **not reliable.** 8 runs: 7 at 90–112 ms, 1 at 151 ms (80 ms of IPC before `start()` ran). An earlier batch of 7 under heavier machine load: 3 at 405–419 ms. Median ≈ 100 ms; the tail is not under control |
| Privacy Guard ≤ 20 s since Stop | 15.6 s when run alone (blur pass 6.6 s). It read 24.9 s once inside the full run (blur pass 13.2 s) while the machine was busy |
| e2e (`node tests/e2e/run.js all`) | 82/83 (the one miss is the Privacy Guard timing above); the pipeline scenario alone: 19/19 |
| Unit tests | 119/119 |

**Not done / caveats**
- **B26 is not met reliably** (see the table). `beginCountdown` records where the time goes (`metrics.cd`: prepared, loaded, bounds, load-wait, show). In the good runs the window shows 80–90 ms after `start()` is entered, of which ~25 ms is awaiting an already-resolved promise because the main process is busy, and 45 ms is the permission check that runs before the countdown. Next step: begin the countdown before `ensure()` and the setup, and cancel it if permissions fail.
- **U13** (custom player controls + hover thumbnails) and **B23** (AudioWorklet dictation) were not in this session's task list and are **not done**.
- Cursor highlight, ripples and zoom still exist only in the player; they are not burned into a downloaded file.
- The editor preview skips the cut ranges while playing, but the rendered file is only made on Apply. The editor was exercised in headless Chrome with a synthetic clip, not with a long real recording. Apply from the page (button → queue → SSE progress) was not exercised end to end; the render itself is covered by the unit tests.
- After Stop, `shell.openExternal` still opens the watch page in the browser, which brings the browser forward (a product choice, unchanged).
- The Electron windows (launcher, bubble toolbar) were only checked as far as their tokens already match the reference.

### Phase 4: AI actions + MCP · Oct 18 — ✅ done 2026-10-16 (results below the acceptance line)
**Do first: security fixes from `REVIEW.md`** (a read-only review done 2026-10-16. Opus re-checked findings 1, 2 and 4 in the code, and all three are real). Fix them in this order, each with a unit test:
- **R2** `auth.access`: `status === 'failed'` must not skip the gate. Non-owners get a blocked state, and media is never served while `shareable !== true`.
- **R4** `privacy.scan` / `ocr.visionFrames`: fail closed when frames are missing, OCR results are missing or a frame doesn't parse. A missing result is an error, not `[]`.
- **R3** After a blur, delete or regenerate `thumb-custom.jpg` and `preview.gif` from the blurred file. Reject thumbnail and GIF requests while `shareable !== true`.
- **R7** Whitelist privacy modes (anything unknown counts as `private`). Run a one-time migration that marks old videos `shareable: true`, then gate on `shareable !== true`.
- **R1** The owner check must not rely on headers alone. Electron sets an HttpOnly `sp_owner` cookie with a random per-launch secret, and owner routes need it **and** loopback.
- **R8b** Sort scan frames numerically. **R9** Replace `boxblur` with a solid `drawbox` fill, add a visible "rules-only check" label when the model wasn't loaded, and add the 40-character AWS-secret pattern.
- **R5** Spaces and the password gate must not reveal titles of locked videos.
- **R6 is a feature, not just a fix:** **"Privacy Guard listens too."** Run the secret rules on the transcript **before** `shareable`, and mute the audio and hide the caption text for those words. This means transcribing before the gate. Measure the effect on the 20 s "viewers can watch" figure and report it. Demo line: "Loom would publish your password if you said it out loud. Spool bleeps it."
- R10 and R11 only if time allows.
Then update the Q&A lines at the bottom of `REVIEW.md` so they are true.

1. "AI Actions" tab: one-click outputs from transcript + guide + screen text: SOP doc, PR description, bug report, Jira/Linear issue body, follow-up email/message, meeting recap. Each is an agent with its own prompt and JSON schema, run through `agents/llm.js`, cached per video.
2. Send to: Slack (incoming webhook), GitHub issue, Linear issue (GraphQL), Jira issue (REST v3). Tokens stay local; every send needs an explicit click and shows a preview first.
3. **Spool MCP server** (`mcp/server.js`, stdio, `@modelcontextprotocol/sdk`): tools `list_videos`, `search_videos`, `get_transcript`, `get_guide`, `get_action_plan`. README shows `claude mcp add spool -- node mcp/server.js`. This is the strongest "agentic structure" demo.
4. Record for agents: build an "Action Plan" (voice + clicks + window titles + guide screenshots) as a markdown prompt to paste into Claude or Cursor.
**Acceptance:** Claude Code can list and read a Spool transcript over MCP. Each action produces valid JSON for 3 different test videos.

#### Phase 4 results (executed 2026-10-16, Apple M2, one batched Electron run at the end)
Status: **all acceptance checks pass.** `npm test`: **154/154** (was 119). `node tests/e2e/run.js pipeline`: **19/19**. `node tests/e2e/speech.js` (headless, real Whisper and `say` audio, no windows): **7/7**, run 5 times. Real local model (qwen3:8b), 6 actions × 3 videos: **18/18 valid** (17/18 on the first pass: the first call after idle timed out at 120 s while the model loaded; fixed by a 300 s allowance when the model is cold, then that action passed in 17 s).

**Security fixes, in the order of `REVIEW.md` (each has a unit test in `tests/unit/security-review.test.js` that fails without it)**
| Finding | What changed | Check |
|---|---|---|
| R2 | `access()` returns `failed` (HTTP 410) for a failed video, and anything but `shareable === true` is `checking`. | Viewer gets 410 for video, download, thumbnail, page data and captions of a failed video that has a `video.mp4` on disk, even with `shareable: true`. |
| R4 | Frame coverage is checked (`assertCoverage`: at least `floor(duration × 2) − 2` frames and hashes). A skipped, missing or garbled Vision result is an error (falls back to Tesseract, then fails closed). | Fake OCR helper that exits 0 but skips a frame, prints junk, or exits 3: all reject. |
| R3 | After a blur the custom thumbnail is regenerated from the blurred file at `thumbAt` (an uploaded picture and the GIF are deleted). Thumbnail, upload and GIF requests answer 409 while the video is not cleared. | Both paths tested. |
| R7 | Privacy modes are whitelisted (anything else is `private`), a missing `createdAt` counts as expired, and the gate is closed unless `shareable === true`. A one-time migration (`db.migrations.shareable`) marks old finished videos cleared; unfinished and failed ones stay closed. | Modes `team`, `unlisted`, `public`, `LINK`; the migration runs once and never overrides an explicit `false`. |
| R1 | Owner = loopback + localhost Host **+ HttpOnly `sp_owner` cookie** (random secret, new on every launch). The app opens the owner's browser through a one-time sign-in link (`/owner-login?code=…`, valid 2 min, single use, same-origin only, the redirect cannot leave the site). `shell.openExternal` calls use it; the clipboard link for viewers does not. | Loopback + `Host: localhost` without the cookie is a viewer (what a raw TCP tunnel looks like). |
| R8b | Sample frames sort numerically. | `f9999` before `f10000`. |
| R9 | Hidden text gets a solid black `drawbox`, not a blur. AWS 40-character secret keys (with `/` and `+`) are a rule. The owner sees "Rules-only check" when the model was not loaded. | Filter graph test; the pipeline run shows the blurred regions at luma std 0. |
| R5 | A space shows `Locked video` with no length or views for anything a viewer cannot open; the password gate no longer returns the title. | Private, checking and password videos in one space. |
| R6 | **Privacy Guard listens too** (below). | Real speech through the real pipeline. |
| R10 | Wrong-password lockout per video and address (5 free tries, then 30 s doubling to 15 min, HTTP 429) and async scrypt. | |
| R11 | `work/`, `video.blur.mp4` and `video.mute.mp4` are removed after every job, finished or thrown. | |

**R6, "Privacy Guard listens too" (`agents/speech-guard.js`)**: Whisper now runs **next to** the screen scan, and viewers get the video only when both have finished. The transcript goes through the same secret rules as the screen plus spoken phrasing ("the password is …", "my pin is …", "api key is …", a run of 9+ spoken digits). Hits are bleeped in `video.mp4` (the picture is copied, only the audio is re-encoded: 0.2 s for a 10 s clip) and replaced by `[bleep]` in the transcript, the word timings and the captions, before anything is saved. If the speech check cannot run on a video that has audio (model missing offline, Whisper failed), viewers stay blocked and the owner is told why. **Measured (24 s Screen + Cam, 1080p, the Phase 2 clip): Stop → viewers can watch 16.9 s** (scan 3.0 s, blur pass 6.8 s; Phase 2 measured 18.2 s, Phase 3 15.6 s alone and 24.9 s on a busy machine), because Whisper's 2.6 s hides inside the blur pass. That clip has only a test tone, so Whisper had nothing to transcribe; with real speech (`tests/e2e/speech.js`, a 10 s `say` clip with a spoken password and PIN) the video was cleared **3.6–5.5 s** after the job started, the transcript read "the password is [bleep], and the pin is [bleep], then click the Deploy button", and Whisper re-transcribing the published audio no longer heard either secret.

**Features**
- **AI Actions tab** (owner only): SOP, PR description, bug report, issue body, follow-up message, meeting recap (`agents/actions.js`). Each has its own prompt and JSON schema; answers are validated (types, enums, required, non-empty) before they are cached, with one retry that tells the model what was wrong. Cached per video, marked stale when the transcript changes. Only runs on videos the Privacy Guard has cleared.
- **Send to** Slack (webhook), GitHub issue, Linear (GraphQL) and Jira (REST v3, Atlassian Document Format) (`agents/integrations.js`). Tokens stay in settings and are write-only in the UI. The Send button first opens a preview of the exact request with credentials hidden (a Slack webhook shows only its host); the server only sends a request that was previewed in the last 10 minutes, once, for that video. Tested against a real local endpoint, and against canned GitHub/Linear/Jira responses (links, GraphQL errors, HTTP errors).
- **MCP server** (`mcp/server.js`, `@modelcontextprotocol/sdk` 1.32): `list_videos`, `search_videos`, `get_transcript`, `get_guide`, `get_action_plan`, read-only from `db.json`, so it works with Spool closed. Only cleared videos are readable, and search never matches the others. The test starts it over real stdio with the SDK client. The bundled copy inside `Spool.app` answers `tools/list`. `claude mcp add spool -- node mcp/server.js` (see `mcp/README.md`).
- **Record for agents / Action Plan**: markdown brief (what was said, what was asked, steps with timestamps, click positions per step as a screen region and percentages, screenshot file paths, transcript), from the AI Actions tab (copy or download), `GET /api/videos/:id/action-plan`, and the MCP tool.
- Gate fix found on the way: the viewer page only handled 401/403, so a viewer who opened a link while the Privacy Guard was checking got no "Almost ready" message. It now handles any gate answer, including the new 410.

**Not done / caveats (read these)**
1. **Window titles are not in the Action Plan.** The recorder does not capture them, and reading them needs the macOS Accessibility permission. Click positions, voice and screenshots are in.
2. **The speech guard is rule-based.** It catches phrasing like "password is …", token-like words, e-mail addresses, long digit runs. It does not catch a secret said without a cue ("hunter2" on its own), and Whisper may transcribe a spoken key in a form the rules do not match. It over-blanks a caption when the two Whisper passes disagree. Test audio is `say` (clean speech), not a real microphone.
3. **R8a not done** (a short-lived secret on an otherwise static screen can fall between sampled frames; `maxGap` is still 2 s). Lowering it to 1 s would add about 3 s of OCR to the 17 s budget. **R4's "zero lines across a whole video is suspicious" not done**: a blank desktop or a camera-only recording legitimately has no text. **R9's "hold sharing until the model is warm" and a "named by user" blocklist not done** (the owner now sees the rules-only label). **R10's "describe e-mail mode honestly in the UI" not done.**
4. **R11:** raw tracks are kept when the composite fails, on purpose: they are the only copy of the recording. A partial `video.mp4` is deleted.
5. **R1 consequence:** a bookmark to `http://localhost:4747` or a tab from before the last launch is a viewer until you use **Open library** from the menu bar; it now shows a page saying so instead of JSON. The sign-in lasts until Spool quits.
6. **Spool.app was built before the last two edits** (the sign-in explanation page in `auth.js` and its test); I did not rebuild a second time. Until the next build, a stale tab on the packaged app shows `{"error":"owner only"}` instead of the explanation. `npm start` has it.
7. **Spool.app was rebuilt once (947 MB), so Screen Recording permission has been reset: re-grant it on the first launch.** It is not launched or tested after the build: the bundled MCP server was started over stdio (it lists its five tools) and `codesign --verify` passes. The bundle includes `design/` (the Loom reference screenshots), `tests/`, `PLAN.md` and `REVIEW.md`: exclude them in Phase 5 (`--ignore`), as the repository must not ship Loom screenshots.
8. Not exercised in a browser: the AI Actions tab was checked in the browser pane against a fixture server with a stubbed model (generate, preview modal, credential hidden); Send itself and the copy buttons were not clicked there. Sending to real Slack, GitHub, Linear or Jira was **not** done (no tokens, and nothing leaves the machine in tests).
9. One new dependency, as allowed: `@modelcontextprotocol/sdk` (its `zod` comes with it).

### Phase 5: Ship · Oct 19–20 — 🟡 done 2026-10-16 except the GitHub repo and release (you said not yet) and two open test items (results below the tasks)
1. Package size: exclude non-darwin `onnxruntime-node` binaries and unused dependencies from the packager (`--ignore`). Target < 400 MB. **Also exclude `design/` (Loom reference screenshots), `tests/`, `PLAN.md`, `REVIEW.md`** (the Phase 4 build is 947 MB and contains them). Rebuild picks up the owner sign-in explanation page that the Phase 4 build lacks.
2. Stable signing. **Ask the user first**: creating a self-signed "Spool Dev" code-signing certificate in the login keychain makes Screen Recording permission survive rebuilds. Without it, permission resets on every build.
3. README: one-paragraph pitch, GIF, install (`npm install && npm start`, or download the `.app` zip from Releases), first-run permissions, Mermaid architecture diagram (§1) and agent-crew diagram, feature table (from `FEATURES.md`), limits, privacy model.
4. GitHub Release with a zipped `Spool.app` (ad-hoc signed: document "right-click → Open").

#### Phase 5 results (executed 2026-10-16)
**First, the PHASE4-CHECK findings you asked for** (unit tests: **161/161**, was 154)
| Finding | What changed | Test |
|---|---|---|
| 1 screenshots skipped the guard | A screenshot is saved closed (`shareable: false`), then read with the same OCR and rules as a recording, covered with a solid black box, and only then opened (`orchestrator.stillJob`, `privacy.scanStill`, queued like other jobs). The thumbnail is regenerated from the covered picture. If the screen reader fails it stays closed. Guard off in settings = opens at once, as for videos. Rules only (no model pass). | 4 unit tests with real ffmpeg pixels; and once by hand with the real Apple Vision on a generated PNG: `password: hunter22` was found and covered |
| 2 no speech model = stuck video | `main/readiness.js`: checked at launch and each time the launcher opens. The launcher shows "The speech model is not downloaded (150 MB). Recordings you make now stay 'only you can watch' until it is." with a **Download** button and progress; the menu bar shows "⚠ Download the speech model". Ollama missing is a second, softer line. Nothing downloads without a click. | 2 unit tests. **The launcher banner and the tray item were not looked at in the running app** (no launches) |
| 3 speech claim | REVIEW.md Q&A, FEATURES.md and the README now say what the rules catch: a cue phrase, token-like words, runs of 9+ digits. | text |
| 6 owner cookie | Named per port (`sp_owner_4747`). **This stops a dev server on another port from colliding with it, not from receiving it:** browsers send `localhost` cookies to every port. It is still HttpOnly and new on every launch. | unit test |
| 7 MCP ignores link privacy | Said in `mcp/README.md`. | text |

**Packaging** (`scripts/build-mac.js`, `npm run build:mac`, `npm run build:mac:dry`)
- Left out: `design/`, `tests/`, `scripts/`, `PLAN.md`, `REVIEW.md`, `PHASE4-CHECK.md`, `FEATURES.md`, `README.md`, the lock file, dotfiles, `onnxruntime-node` for linux, win32 and darwin-x64, `onnxruntime-web`, `uiohook-napi` prebuilds for other systems, the unused Tesseract language data, `*.map`, `*.d.ts`, other packages' tests and docs. `electron` moved to `devDependencies`, which drops its own dependencies from the package.
- **Size: 947 MB → 537 MB (Spool.app). The < 400 MB target is not met and cannot be:** Electron itself is about 290 MB, the Node speech engine 85 MB, ffmpeg 44 MB. The zip for a release will be much smaller than the folder.
- I tried also dropping the non-LSTM Tesseract cores and **it broke the OCR fallback** (it loads `tesseract-core-relaxedsimd` even in LSTM-only mode); caught by running Tesseract from a staged copy of the trimmed tree (`--stage`), rule removed.
- Checked inside the trimmed tree and the built app with plain Node (no windows): Whisper transcribes (the built app's own Electron-as-Node, 0.7 s for a short clip), Tesseract reads a test image, `uiohook-napi` loads, the MCP server lists its five tools. `codesign --verify --deep --strict` passes. No `design/`, `tests/`, notes or non-darwin binaries inside.
- The icon warning from the packager is only about the `.icon` format; the bundled `electron.icns` is byte-identical to `assets/icon.icns`.

**Signing:** you chose to create the certificate. "Spool Dev" (self-signed, code signing, 10 years, trusted for code signing for your user only) is in the login keychain; the throwaway key files were deleted. The app is signed with it. macOS asked for your login password once so `codesign` could use the key. **Because the identity is new, Screen Recording permission resets once on the first launch of this build; later rebuilds keep it.** If you ever see the keychain dialog again, "Always Allow".

**Batched verification** (you were warned; run once, then stopped at your request)
| Check | Result |
|---|---|
| `tests/e2e/speech.js` ×2 | 7/7 both times. It printed "cleared after 28.9 s / 33.9 s", **which was a measurement bug in the test, not the product (see the follow-up below)**. The bleep itself worked: transcript reads "the password is [bleep], and the pin is [bleep]" and Whisper cannot hear them in the published audio |
| `tests/e2e/actions.js` (new; real qwen3:8b, 6 actions × 3 videos) | **18/18 valid**, 7.8–21 s each, 220 s total |
| `node tests/e2e/run.js all` | **76/83**. Phase 1–3 scenarios all pass except the focus check (below). Failures: |
| · B28 "Spool never frontmost" ×4 | **Resolved in the follow-up below.** (Original reading: confounded.) An **older Spool.app of yours (started 16:03, still running) is frontmost** in several runs ("before Spool, after Spool"), so the check sees it. In the `ui` scenario "Electron" also appears frontmost; I could not tell whether that is the launcher focusing itself as before or a regression, because the other instance was running. Needs a rerun with Spool.app quit |
| · Privacy Guard ≤ 20 s | **Not reproduced, see the follow-up (8 runs: 15.1–18.5 s).** This run: 26.1 s (scan 3.6 s, blur pass 15.4 s, the model judgement ran). Earlier runs: 15.6–18.2 s. Likely load, **not shown to be** |
| · Fake key found and blurred | **Handled in the follow-up below; the miss did not reproduce.** In that run: This run the rules did not match the fake key (`sk-live-…`) in the OCR text; the model found something typed "password", and the key area was only partly covered (luma std 93 → 54, previously 102 → 6). I changed nothing in OCR or the rules, so this looks like OCR output varying between runs, which would mean the rules are weaker than the earlier runs suggested. **A rerun to check was cancelled** when you asked me to make the windows go away |
Captures from the cancelled run were deleted. Nothing was published anywhere.

**Not done**
- **GitHub repo and release:** not created, as you answered. `dist/Spool-darwin-arm64/Spool.app` is built; the zip is not made yet.
- **README GIF:** there is no recording of Spool to make one from; Phase 6's demo recording can supply it. The README is written without a broken image.
- No LICENSE file (package.json says MIT; I did not want to invent a copyright holder).
- The launcher banner and tray warning, and the new screenshot path in the real app, were not exercised in a running window.

#### Phase 5 follow-up (2026-10-16 evening): the three open items, measured with no other Spool running
Before starting I checked that no Spool.app or dev Electron was running. All screen runs used `caffeinate -d -i` (a temporary assertion, no setting changed). **A first attempt of 5 pipeline runs produced nothing: four runs hung for about 15 minutes each (the app never started recording, or its pipeline never finished) while nobody was at the Mac.** The most likely cause is the display sleeping, which stops screen capture; I did not prove it. After that, unattended screen runs need `caffeinate`.

**1. Fake-key miss.** The rules now run on three views of every OCR line (as read; dashes unified and spaces next to `-` / `_` removed; and additionally folded O/Q→0, l/I/|→1), and every hit is mapped back to the original characters, so the word boxes and the "mask this value everywhere" step still work (`privacy.regexFindings`, `normalise`). The folded view skips the e-mail, password and generic long-secret rules, so ordinary long words do not become "secrets". 3 unit tests (sk-key with long dashes, spaces around dashes, I/l/O look-alikes, card and phone look-alikes, and text that must not match).
- **Result: 5/5 dedicated pipeline runs found both the e-mail and the key and covered both completely** (luma std 102→0 and 103→0 in every run; the check now demands a std under 15, not just "halved"). Three more in the full runs: 8/8.
- **What this does and does not show:** in all 5 runs I traced, Apple Vision read the key line identically and correctly (`Denlov key: sk-live-9f8e7d6c5b4a3210abcd`, 12 of 12 sampled frames), so the old rules would have passed these runs too. **The earlier miss did not reproduce, so I cannot show that the normalisation fixed it.** It is covered by unit tests on OCR variants I made up, not by an observed real miss. Treat the original cause as unknown.

**2. B28 focus.** With nothing else of Spool open, two scenarios failed for real reasons (the earlier `cam`/`idle` failures were the old Spool.app):
- `window`: Spool was frontmost for the whole recording (4.7 s). Cause: switching the pen on called `w.focus()` on the drawing overlay, and opening the teleprompter called `show()`; each activates the app, and macOS gives focus back to nobody when they go. **Fixed:** the pen no longer takes focus (drawing is mouse input), the teleprompter opens with `showInactive()` (the launcher's "edit" notes still take focus, the user is about to type), and both windows accept the first click. Spool frontmost: 4700 ms → 0 ms.
- `ui`: the launcher the test opens holds focus for 400 ms and then hands it back to the previous app. That is by design (a launcher you open with ⌥⇧R should take keys), so the check for that scenario now allows at most 1 s and says so, instead of "never".
- The 6 scenarios: B28 passes in all. **Not tested by hand:** drawing with the pen, the Esc key inside the pen overlay (it needs focus, so Esc only works after your first stroke), and typing into the teleprompter after opening it mid-recording. Only the focus behaviour was measured.

**3. Timings, no other Spool running (Apple M2, host app open; 24 s Screen + Cam, 1080p, worst-case noise patch)**
| Run | Stop → owner | Stop → viewers | AI notes done | Privacy scan | Blur | Whisper |
|---|---|---|---|---|---|---|
| dedicated 1 | 7.1 s | 15.3 s | 20.7 s | 1.6 s | 6.7 s | 8.3 s |
| dedicated 2 | 7.1 | 15.4 | 20.6 | 1.7 | 6.7 | 8.3 |
| dedicated 3 | 7.1 | 15.3 | 20.3 | 1.5 | 6.7 | 8.2 |
| dedicated 4 | 7.1 | 15.2 | 20.5 | 1.5 | 6.7 | 8.1 |
| dedicated 5 | 7.1 | 15.1 | 20.1 | 1.5 | 6.6 | 8.1 |
| inside full run A | 7.3 | 16.7 | 22.2 | 2.5 | 6.9 | 9.4 |
| inside full run B | 7.0 | 16.2 | 21.7 | 2.4 | 6.7 | 9.2 |
| inside full run C (last) | 7.2 | 18.5 | 24.4 | 4.5 | 6.7 | 11.2 |

Stop → owner: **7.0–7.3 s (target 8 s, thin margin as before)**. Stop → viewers: **15.1–18.5 s (target 20 s)**, 15.1–15.4 s when run on its own, longer inside the full suite. The 26.1 s seen once earlier did **not** reproduce in 8 runs. Whisper runs next to the blur pass here, so it only costs time once it takes longer than the blur (the last run: 11.2 s against 6.7 s).

**Speech clear time (`tests/e2e/speech.js`, 10 s `say` clip with a spoken password and PIN, run 3 times alone): viewers can watch 4.6 s, 3.7 s and 4.3 s after the job started** (scan 0.5–0.7 s, Whisper 3.4–4.3 s, bleep 0.2 s). The "28.9 s, 33.9 s, and 41.6–48.8 s" printed earlier were **the whole job including the AI notes** (`processVideo()` resolves when the job ends): the test now prints the pipeline's own `shareable` time and the whole-job time separately. That also means the "3.6–5.5 s" in the Phase 4 section was right.

**Final full e2e after all changes: 83/83.** Unit tests 164/164.
**Not done:** `Spool.app` was **not** rebuilt, so the packaged app does not have these fixes yet (a rebuild keeps Screen Recording permission now that it is signed with "Spool Dev"). No GitHub repo or release.

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
| B28 | `windows.releaseOverlay`, countdown, startup | **Spool steals focus in normal use** (reported 2026-10-15: "keeps switching my tab"). `app.dock.show()` after every recording turns the process back into a foreground app, which activates it and switches Space; the countdown did `show(); focus()`; the launcher showed itself when the system started the app at login. | Dock icon is no longer re-shown after the last overlay (menu-bar app: tray and ⌥⇧R open the launcher). Countdown uses `showInactive` + `acceptFirstMouse` (✕ and ⏭ work on the first click; Space/Esc are gone because the window never has focus). No launcher at login (`wasOpenedAtLogin`). **Acceptance:** Spool is never the frontmost app during a run (`tests/e2e/run.js` polls `lsappinfo` every 100 ms; a before/after comparison alone gave a false failure when the user switched apps mid-run). **Open:** after Stop, `shell.openExternal` still opens the watch page in the browser, which does bring the browser forward; that is a product choice, not changed. | 3 ✅ (verified 2026-10-15: 7 e2e scenarios, Spool never frontmost) |

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
- **Do not launch the app (`electron .`, `npm start`, e2e, self-tests) while developing.** Every launch shows windows and takes focus, which pulls the user out of what they are doing. Batch all e2e and self-test runs into ONE run at the end of the phase, and tell the user right before it starts (how long, and that Spool will take over the screen). Unit tests (`npm test`) open no windows and are fine any time.
- Do not rebuild `Spool.app` more than once per phase. Tell the user when a rebuild will reset permissions.
- Do not add dependencies without a reason written here. Allowed new ones: `@modelcontextprotocol/sdk`, and possibly `smart-whisper` (Phase 2 benchmark).
- Keep `npm start` working on a clean clone at every commit.
- Commit at the end of each phase (initialise git in Phase 1 if needed) with a message listing the acceptance results.

## 5. Decisions the user still owns
1. Signing certificate (Phase 5.2): yes/no.
2. Whether "Source" quality (large files, about 150 MB/min) or 1440p should be the default.
3. Cut-list order if time runs short.

---

## Phase 7: Loom-clean recorder UI · from 2026-10-19
The user tested Kairos against Loom's recorder and found Kairos cluttered. Goal: **the recorder looks and feels like Loom's: one clean bar plus the camera bubble.** References: `design/loom-ref/launcher-bar-bubble-preview.webp`, `launcher-record-for-agent.png`, `launcher-privacy-toggle.png`, `launcher-more-menu.png`, plus `countdown-and-control-bar.webp`. Name stays **Kairos**. No Loom logo: the Record button carries Kairos's own mark.

**1. The launcher becomes one horizontal pill bar** at the bottom centre of the screen: dark glass, rounded ends, about 64 px tall. Remove the old panel. Left to right:
- ✕ close
- Source segmented control: **Full screen** (laptop icon), **Window**, **Custom area** (dashed square), **Camera only** (portrait icon). Picking Window or Area opens the existing picker.
- Camera toggle (video icon). A small menu chooses the device.
- Mic toggle with a live level arc under the icon, as in the reference. A small menu chooses the device.
- **Privacy lock toggle**: closed or open lock, with the tooltip "This video is Public" or "This video is Private". It sets the new video's privacy (link vs private) and defaults to the workspace default.
- **"…" More menu** with exactly three rows, each with an icon, title, subtitle and chevron:
  - **Speaker notes** (keep notes nearby while you record)
  - **Backgrounds** (camera filters and frames; real virtual backgrounds only if they already exist)
  - **Recording settings** (countdown on/off, hide dock and menu bar, quality, system audio, cursor effects, shortcuts)
- **Record for agent** (cursor-with-sparkle icon, tooltip "Record for agent"). Starts a recording that produces the Phase 4 **Action Plan** automatically when it finishes.
- **Record**: a blue pill button.
Tooltips are small and dark, and appear after 300 ms. Every option the old launcher had must still be reachable in at most 2 clicks.

**2. Camera bubble before and during recording** (builds on B27):
- A live preview at the saved position whenever the camera is on and the bar is open.
- On hover, a control panel appears under it:
  - a size slider with 3 snap stops (S/M/L)
  - a settings icon that opens filters and frames
  - a shape segmented control: rounded square, circle, landscape rectangle, portrait rectangle
  - a power icon that turns the camera off
- Shapes and size animate (U10). Choices persist.

**3. Clean-up rules:**
- No summary lines, no labels where an icon plus tooltip suffices.
- One accent: Loom blue, as already sampled.
- 120 ms hover transitions.
- Keep B28: the bar takes focus only because the user opened it, and it hands focus back when it closes.

**Acceptance:**
- A side-by-side screenshot of the bar, the More menu and the bubble panel against each reference at the same scale, with the differences listed and fixed.
- `npm test` passes.
- ONE batched e2e run at the end, after warning the user, with `caffeinate`.
- Rebuild once, then install: `ditto dist/Kairos-darwin-arm64/Kairos.app /Applications/Kairos.app`, after quitting Kairos. The user runs the installed copy.
- Commit, and update FEATURES.md.

**4. During recording (from the user's Loom recording, 2026-10-19; frames sampled at 2, 8, 15, 25, 45, 75 and 105 s):**
- **The bubble stays usable mid-recording.** The user dragged it between corners, made it smaller, and switched it from a landscape rounded rectangle to a circle. Every change shows in the published video **at the moment it happened, with a smooth transition**, not a jump. Kairos already records bubble keyframes. Make sure the hover panel (size, shape, camera off) also works **while recording**, and that the composite eases between keyframes (about 200 ms) instead of cutting.
- **The bubble floats over every app and browser tab** as the user switches between them (Teams, PowerPoint, Desmos), including full-screen ones (B25).
- **Loom's control bar never appears in the video.** Only the bubble and the real cursor do. Kairos already passes this check; keep it passing.
- The default bubble in that recording is a **landscape rounded rectangle**, about 18% of the screen width, in the top-left corner. Use the same default for a new install.

### Phase 7 results · 2026-10-19
**Built:** one 60 px dark-glass pill bar (✕, source ×4, camera + device menu, mic + level arc + device menu, privacy lock, More, Record for agent, blue Record with the Kairos mark); More menu with exactly three rows; bubble hover panel (size slider with S/M/L snap, style, four shapes, power); Record for agent writes the Action Plan after processing and opens the AI Actions tab; B28 untouched. Side-by-side comparison with differences listed: `design/phase7-compare/compare.html`.

**Verified:** `npm test` 170/170 (5 new in `tests/unit/launcher-ui.test.js`). One batched e2e under `caffeinate`: `test:e2e` 83/83 (Stop to owner 6.9 s, guard cleared 18.1 s, AI 28.1 s, 57 fps raw, 60 fps published), preview scenario 15/15 (shape change keeps the camera on, power icon closes the preview, same bubble window reused for the recording), cancel scenario 8/8 (countdown painted 132.7 ms after the click, under the 150 ms limit). Rebuilt once, installed to /Applications/Kairos.app.

**Not verified / known gaps:**
- Hover on the non-focusable bubble and dragging the size slider in the real window were not driven by a human or by synthetic input; only the structure and the programmatic `bubbleAction` paths are tested.
- Custom area (`area:pick` then `launcher:open`) ran in no e2e scenario.
- The bar is about 548 px wide, wider than Loom's.
- Shape and size now live only in the bubble panel; Library and Screenshot shortcuts moved into Recording settings.
- "Hide the dock" is not implemented (only the menu bar can be hidden).

**Item 4 (during recording), added after the first commit:**
- The composite now eases bubble moves: each move glides over 0.2 s (smoothstep, or until the next keyframe if sooner). A size, shape, filter or frame change that follows straight on from the previous one cross-fades over 0.2 s (old bubble lingers, new one fades in). It is a cross-fade, not a true size morph. After a hidden gap (camera off) there is no fade.
- The hover panel already worked mid-recording by design: its actions go through `bubbleAction`, which pushes a keyframe on every change and uses `toggleTool('cam')` for power. Not driven in a real recording; no e2e covers it.
- New default: landscape rounded rectangle (size 200 = 260 pt wide, 18% of a 1440 pt display), top-left. It applies to new installs only: a saved shape or position wins.
- Unchanged and still passing in e2e: the control bar and countdown are content-protected, so they never appear in the video. The bubble floats on every app (B25) unchanged.
- Tests: 171/171 unit (composite snapshot regenerated, 2 new tests, one real-ffmpeg run covers the fade graph). No second e2e was run; the rebuilt app is installed but its mid-recording bubble changes are unverified in the real app.


### Rename and scorecard pass · 2026-10-20
- The app was renamed Spool → Iris → Hermes → **Kairos** (2026-10-20). Kairos everywhere user-facing and in code names (`KairosIcons`, `/Applications/Kairos.app`, MCP server name `kairos`). Unchanged on purpose: the bundle id `app.hermes.recorder` (so macOS keeps the Screen Recording, Camera and Microphone permissions), the library folder (`~/Library/Application Support/spool`, now pinned in code), `SPOOL_*` variables and the repo folder name. The tray said "Quit spool" because `app.name` came from package.json; `app.setName('Kairos')` fixes it. Renderer errors now go to `spool.log` (`renderer:<window>`).
- From the Margin judge scorecard (62/100): README rewritten around the problem, users, screenshot, 5-minute setup, models-and-safety table; `npm run doctor`; Settings > AI model picker listing installed Ollama models with a missing-model warning; `PITCH.md` (90 s demo script with a 12 s hook, 3-minute pitch, Q&A defense). Tests 172/172. No e2e run.
- Still open from the scorecard: a real screenshot or GIF from the running app (the README image is the stub render), a demo video, and the GitHub repo and release (waiting for the user's go-ahead).

---

## Phase 8: Hand-gesture commands, MVP only · 2026-10-20 (half a day, hard stop) — ✅ built and installed 2026-10-20 (results and demo note at the end of this section)
**Goal: a minimal working demo, not a full feature.** While recording with the camera on, two held hand signs control Kairos. Features freeze after this phase; Phase 6 (demo, business plan, repo) comes next.

**Scope (nothing more):**
- **✋ Open palm held 1 s → pause/resume. 👍 Thumb up held 1 s → stop** (then the normal pipeline and agents run).
- Engine: MediaPipe Gesture Recognizer (`@mediapipe/tasks-vision`, its canned `Open_Palm` and `Thumb_Up` labels). This is the one new dependency allowed. Ship the `.task` model file and the WASM files **inside the app** (`assets/models/`), so it works offline. No CDN at runtime.
- Run it in the **bubble window** on the camera preview it already has: about 8 recognitions per second, on a small frame (≤ 320 px), and only while a recording is live and the toggle is on.
- **Hold-to-confirm:**
  - The same label must be held at score ≥ 0.6 for 1 s. Breaking the hold for over 200 ms resets the timer.
  - A 2 s cooldown after a command fires.
  - A thin ring fills around the bubble while you hold, then a small toast says "Paused ✋" or "Stopping 👍".
  - Put this logic in a pure function in `shared/gestures.js` with unit tests: hold, break, cooldown, low score.
- A toggle **"Hand gestures (beta)"** in More → Recording settings, **off by default**.
- Commands go through the existing session controls (`rec:control` pause, resume, stop) and the existing shortcut path. No new recording logic.

**Must not break:**
- Frame pacing. Run the `screen-cam` acceptance scenario once with gestures on. The pts-delta std must stay < 4 ms and fps ≥ 55; otherwise drop to 5 recognitions per second, and if it still fails, cut the feature.
- B28: gestures never take focus.

**Out of scope:** more gestures, custom gestures, using gestures outside a recording, and pointing to zoom.

**Done when:**
- unit tests pass
- one batched e2e run (warn the user first, use caffeinate) shows the pacing numbers with gestures on
- rebuild once, quit Kairos, install to `/Applications/Kairos.app`, commit
- a short "how to demo it" note goes in PLAN.md, so the user can rehearse: hold a palm to pause, thumbs up to stop

### Phase 8 results · 2026-10-20

> Changed the same day after the owner tried the installed build: stop is now a **closed fist** (not a thumbs up), the toggle is **on by default**, and the thresholds moved. The text below is the record of the first build and its measured run; the current behaviour and the demo note are in "Phase 8 follow-up" at the end of this section.

**What was built (nothing beyond the scope above):**
- `src/shared/gestures.js`: the pure `step()` function (hold 1 s, score ≥ 0.6, a gap over 200 ms restarts, 2 s cooldown) and the label → control map. 11 unit tests in `tests/unit/gestures.test.js`: hold, break (forgiven and not), low score, cooldown, switching sign, purity.
- The bubble window (`bubble.js`) loads MediaPipe's Gesture Recognizer from `assets/models/` (`gesture_recognizer.task` 8.4 MB, `wasm/vision_wasm_internal.{js,wasm}` 13.8 MB; `vision_bundle.mjs` from the one new dependency `@mediapipe/tasks-vision` 1.1.1). No network at runtime. It reads the model while the countdown runs, then recognizes 8 times a second on a frame ≤ 320 px, only after capture has begun, only with the toggle on and the camera not switched off.
- A thin ring fills around the bubble while a sign is held; a pill on the camera's lower edge says "Paused ✋", "Resumed ✋" or "Stopping 👍". Both live inside the bubble window (content-protected, never focused).
- `session.gesture()` turns a confirmed sign into `toggle-pause` (the ⌥⇧P message) or `stop` (the ⌥⇧S message). No new recording logic.
- Launcher: More → Recording settings → **Hand gestures (beta)**, off by default, saved with the other preferences.
- The packager leaves out the unused MediaPipe WASM variants and maps (the app reads its WASM from `assets/models/`).

**Measured (one batched run, `caffeinate`, Apple M2, 1440×900 @2x, fake camera, noise patch on screen; `acceptance` = gestures off, `gestures` = on, back to back):**

| | gestures off | gestures on | Limit |
|---|---|---|---|
| Frame rate (both segments) | 57.5 / 57.5 fps | 57.5 / 57.7 fps | ≥ 55 |
| pts-delta std (both segments) | 1.15 / 1.83 ms | 1.62 / 1.48 ms | < 4 ms |
| Bitrate | 31.2 / 30.3 Mb/s | 35.2 / 36.6 Mb/s | ≥ 12 |
| Published video | 60.0 fps | 60.0 fps | ≥ 55 |
| Focus (B28) | Kairos never frontmost | Kairos never frontmost | never |

- Pacing was not hurt, so **8 recognitions a second stays** (no need for the 5 per second fallback). In the bubble: 73 recognitions in the 10 s run, 24.9 ms average each (96 ms slowest, the first frame), model ready in 177 ms. One CPU core at about 20% in the bubble process, nothing in the recorder.
- 56 of 58 checks passed. Both failures are the same check, **"capture works: the noise patch is in the track"**, and it fails identically in the gestures-off baseline of the same run, so it is not caused by this phase. Cause (read from the code, not re-run): since the landscape bubble became 16:9 and larger, the green guard window under the bubble covers most of the noise patch (`selftest.js` puts the patch at 40,60; the bubble now spans about 20–540 × 44–337). The pacing numbers above are real but on a lighter screen than the worst case the test was designed for. Fix, one line, not done because it needs another screen run: move `patchRect.x` right of the bubble (about `wa.x + 560`).
- Unit tests: 184/184.

**Not verified by me:** recognition of a real hand. The e2e camera is fake, so the 2 signs were injected as the command the bubble sends after a confirmed hold (`session.gesture`); the model runs on every frame but never sees a hand. The hold logic is unit-tested and the model is MediaPipe's own canned `Open_Palm` / `Thumb_Up`, but the first real-hand check is yours: see the demo note.

*(The first build's demo note is replaced by the one in the follow-up below: it described the thumbs-up stop and the off-by-default toggle.)*

### Phase 8 follow-up · 2026-10-20 (the owner tried the installed build)

**What the owner reported:** (1) the palm does not pause and the signs do not work, (2) it feels buggy, (3) stop should be "thumb inside the palm, then close it", which is a closed fist. Number 3 is an owner override of the original "two canned signs" scope: the thumbs up is no longer a command.

**What was wrong** (from `spool.log`, the saved prefs, and a 51 s recording of the owner's own hand: 410 recognitions at 8 a second):
- **The feature was off in that test.** No `gestures` line and no inference line in the log, and the saved prefs had no `gestures` key. It was off by default and the only hint was a tooltip, so nothing on screen told the owner it was off. This alone explains "nothing happens".
- **The palm bar was too high for this hand.** An open palm scored 0.53–0.78 (mean 0.66) against a bar of 0.6, so about a third of the palm frames did not count. For comparison a thumb up averaged 0.75 and a closed fist 0.82 (lowest 0.71).
- **Flicker restarted the hold.** The old rule forgave a gap of 200 ms, which is one missed frame at 8 a second; real hands drop more than that, so the ring kept filling and resetting. That is the "bugging".
- **A palm held after it fired would flip pause and resume every ~3 s.**
- **No feedback.** Nothing showed that the feature was armed, nor what the camera saw.
- **The camera sometimes fails to open in the bubble.** The installed first build logged `[object DOMException]` at 19:41:46Z, `[object OverconstrainedError]` at 21:09:31Z and `[object DOMException]` at 21:10:37Z (the old code printed the error without its name or message). This Mac lists two cameras: the FaceTime HD Camera that is saved in the prefs, and an iPhone ("ksoc Camera", Continuity Camera). OverconstrainedError means the saved camera was not in the system's list at that moment. The cause is not confirmed. With no picture the signs have nothing to look at, and the old pill would not have said so. Now the bubble tries three times, 700 ms apart, on NotReadable, Abort, Overconstrained and NotFound, logs the name and message of each failure, and the start pill says "No camera picture · signs can’t see you" when the video is not live. It does not fall back to another camera on purpose: the recording uses the saved one, and a different picture in the preview would hide the problem.

**What changed:**

| | First build | Now |
|---|---|---|
| Toggle | off by default | **on by default**; More → Recording settings → "Hand signs (beta)" turns it off |
| Pause / resume | ✋ 1 s, score ≥ 0.6 | ✋ 1 s, score ≥ 0.5 |
| Stop | 👍 1 s | **✊ closed fist, thumb tucked in, 1.5 s, score ≥ 0.6** (thumbs up does nothing now) |
| Gap forgiven | 200 ms | 450 ms (3 missed frames in a row) |
| After a command | 2 s cooldown | 1.5 s cooldown, **and** the sign must be let go for 0.8 s before it can fire again |
| On screen | white ring, result toast | blue ring for pause, red ring for stop; a live "✋ Hold to pause" / "✊ Hold to stop" pill; "Gestures on · ✋ pause · ✊ stop" for 4 s when capture starts, or "Gestures unavailable" if the model did not load |
| Log | one inference line | + `gestures` flag in `record:start`, and a `gestures` line per recording with how often the recognizer saw each sign or no hand |

`src/shared/gestures.js` stays one pure `step()` function; each command now carries its own hold time and score bar.

**Verified without a camera or a screen run:**
- 13 unit tests (hold, per-sign score bars, flicker, switching signs, cooldown, the release lock, purity), plus a replay of the owner's own recording as a fixture, `tests/unit/fixtures/gesture-recording.json` (labels and scores only, no images). Full suite 187/187.
- A headless probe of the launcher: toggle → saved prefs → `record:start` carries `gestures`.
- The real bubble page replayed in real time on the owner's recorded frames: the commands fired at the expected moments and the ring, the hint and the pill showed up as designed. Run again after the camera change, with and without a picture: with it the pill says "Gestures on · ✋ pause · ✊ stop" and the palm fires; without it the pill says "No camera picture · signs can’t see you" and the recognizer keeps running.
- A unit test of the camera retry (`tests/unit/bubble-script.test.js`): three tries on a missing or busy camera, always the camera that was asked for, the error named in the log, no retry on a permission refusal.

**Not verified:** the installed app with a live camera and a real hand (that is the owner's next try), and frame pacing for this build (the recognition loop is unchanged, 8 a second on a ≤ 320 px frame; a new screen run was not done). Whether the retry cures the camera errors above: it cannot be tested without causing one, so the next `camera failed` line in `spool.log` is the evidence.

**Tradeoffs:**
- **A closed fist is the most common resting hand shape.** Resting a fist in view for 1.5 s while recording ends the recording. Mitigations: 1.5 s hold, score ≥ 0.6, and the ring turns red with "Hold to stop" from the first frame, so opening the hand cancels it. If it still happens: require an open hand just before the fist (an open → close motion), or only count a hand that is large enough in the frame.
- The owner's own fist in the test recording lasted about 1.25 s, which is just short of 1.5 s. Hold it for two seconds.
- A hand left up after a command does nothing more until it has been down for 0.8 s. That is on purpose.
- On by default means the model runs on every recording with the camera on: about 16–20% of one core in the bubble process (nothing in the recorder). The earlier gestures-on run held 57.7 fps and a pts std of about 1.5 ms.

**How to demo it (rehearse this once before the video):**
1. Camera on (Screen + Cam, or Camera only). Hand signs are on by default. Good light, hand about an arm's length from the camera, facing it.
2. Press Record. When capture starts, a pill under the camera says "Gestures on · ✋ pause · ✊ stop" for 4 s. If it says "Gestures unavailable", the model did not load; if it says "No camera picture", the camera did not open. Either way look in `spool.log` (`camera failed` or `gesture recognizer failed`), then turn the camera off and on in the launcher or pick it again in the camera list.
3. Hold **✋ an open palm**, fingers spread, for 1 second. A blue ring fills around the bubble, the pill says "✋ Hold to pause", then "Paused ✋". Lower the hand for a second, then hold the palm again to resume ("Resumed ✋"). A hand that just stays up does not toggle again.
4. To end it, tuck the thumb into the palm and close the hand, **✊ a closed fist**, and hold it for 1.5 seconds (two is safer). The ring is red and the pill says "✊ Hold to stop", then "Stopping ✊", and the normal pipeline and agents run. Opening the hand before the ring is full cancels it.
5. If the ring never starts: the hand is too small or too dark in the frame, or the camera is off. After a recording, `spool.log` has a `gestures` line saying how often the recognizer saw a palm, a fist, another sign, or no hand. Say it out loud on the video: "it runs on the camera preview only while I record, nothing leaves the Mac."
6. Features are frozen after this phase. Next is Phase 6 (demo, business plan, repo).

---

## Phase 8: Public links · 2026-10-20

**Why.** `http://localhost:4747/v/<id>` only opens on the owner's Mac. Judges, businesses and friends need a link that works on another network, with the Mac asleep.

**Decided with the owner (2026-10-20):** link works always; no fees and no card; some viewers need a password; only the video copy and its title leave the Mac, only on click; free `workers.dev` address; copies deleted after 30 days. GitHub (a friend's suggestion) was rejected: free Pages needs a public repo, has no passwords, cannot delete history, caps files at 100 MB.

**Design.** Publish click → ffmpeg share copy from the **guarded** `video.mp4`, never `original.mp4` (≤1080p, 30 fps, ~5 Mbps, +faststart, ~37 MB/min) → upload to a **private** Backblaze B2 bucket under `p/<id>/` (`video.mp4`, `thumb.jpg`, then `meta.json` last = "go live") → a free Cloudflare Worker (`cloud/worker.js`) serves page, password gate, expiry and Range streaming with a read-only, bucket-limited key. `id` = 16 random bytes (22 chars), new on every publish. No new dependencies. Code: `src/publish/{b2,publisher}.js`, `src/pipeline/share-copy.js`, `src/server/routes/publish.js`, `cloud/`. The pipeline and the recorder never import the publisher (a unit test enforces it), so Stop makes no network call.

**Privacy contract (all unit-tested).** Never published: Private, Ask-for-email, not Guard-cleared, no Guard record (older recordings, or Guard off), failed, not a video, expired local link. A video that needs a password here is published only with a password. Public expiry = min(30 days, local expiry); downloads follow the local setting. Tightening the local privacy, expiry or downloads, changing the workspace default, or deleting the video removes the public copy (persisted retry queue if offline). A republish keeps the old link live until the new one is ready.

**Verified.** 153 new unit tests (340 in total, all green): fake Backblaze v4 (reproduces its whole-file-range 200 quirk, part sizes, SHA-1, failures), the real Worker code (pages, escaping, password flow incl. Node PBKDF2 ≡ WebCrypto, cookie-gated media, Range, caps, tokens), the publisher (refusals, order, cleanup, enforcement, recovery, expiry), HTTP routes (owner-only, CSRF, masking), and `scripts/public-check.js`. Driven in a real browser through `scripts/dev-public.js` (fake Backblaze + real Worker): publish from the Share dialog, play and seek on the public page, republish with an accented password (the old link returned 404 afterwards), private video refused, Settings Test with seven green ticks.

**Not verified.** Real Backblaze and Cloudflare (first contact is the owner's **Save and test**; expect one fix round), a phone on mobile data, Safari/iOS playback, and the installed app. Backblaze's free daily transaction allowance (2,500) is the limit most likely to be hit; the $0 caps turn it into a "temporarily unavailable" page, not a charge.

**Tradeoffs.** Backblaze holds an unencrypted copy for up to 30 days. A password has no lockout (each wrong try costs 0.5 s). "Downloads off" only hides the button. Old recordings without a Guard scan cannot be published until a re-scan exists (follow-up: "Re-run AI crew" does not re-scan videos already marked cleared).

**Follow-ups.** Re-scan for old recordings; per-recipient links with a "someone opened it" ping; a custom domain (free student `.me`); a recipient-visible expiry reminder.

