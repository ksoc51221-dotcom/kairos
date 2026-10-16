# Spool security / privacy review: viewer gate + Privacy Guard

Scope: read-only. Read the 6 requested files, plus only the functions a finding depended on in `routes/media.js`, `routes/viewer.js`, `routes/editor.js` (thumbnail/gif), `routes/library.js` (`/api/space/:id`) and `agents/ocr.js` (`visionFrames`). Nothing was launched or executed; `npm test` was not run. CONFIRMED = I traced it in the code; PLAUSIBLE = depends on something I did not read or on timing.

## Status after Phase 4 (2026-10-16)

| # | Finding | Status | Where it is tested |
|---|---|---|---|
| 1 | Header-based owner check | **Fixed.** Owner also needs an HttpOnly per-launch cookie, handed out only by a one-time link the app opens. A raw TCP tunnel is a viewer. | `security-review.test.js` R1 (3 tests) |
| 2 | `failed` bypasses the gate | **Fixed.** Failed videos answer 410 to viewers; only `shareable === true` opens a video. | R2 |
| 3 | Thumbnail/GIF survive the blur | **Fixed.** Regenerated or deleted after a blur; refused while checking. | R3 |
| 4 | Guard clears a video when nothing was read | **Fixed** for missing frames, hashes and OCR results. *Not done:* "zero text lines is suspicious" (a blank screen or camera-only recording has none). | R4 |
| 5 | Spaces list titles | **Fixed**, and the password gate no longer returns the title. | R5 |
| 6 | Spoken secrets | **Fixed (rule-based).** Bleeped in the audio, removed from transcript, captions and word timings, before viewers get the video. A secret said with no cue can still slip through. | `speech-guard.test.js`, `tests/e2e/speech.js` |
| 7 | Gate defaults to allow | **Fixed.** Whitelisted modes, closed unless `shareable === true`, one-time migration. | R7 |
| 8 | Frame sampling | **(b) fixed** (numeric sort). **(a) not fixed:** a secret on screen for under 2 s on an otherwise static screen can fall between the sampled frames. | R8b |
| 9 | Detection weaker than the name | **Partly fixed:** solid fill instead of blur, AWS secret keys, "rules-only check" label. *Not done:* holding sharing until the model is warm, a user blocklist, names and addresses without the model. | R9 |
| 10 | Password brute force | **Fixed:** lockout and async scrypt. *Not done:* e-mail mode is still only a speed bump, and the UI does not say so yet. | R10 |
| 11 | Leftovers on disk | **Fixed** for `work/`, `video.blur.mp4`, `video.mute.mp4`. Raw tracks after a failed composite are kept on purpose (only copy). `keepOriginal` is the owner's choice. | R11 |

## Answers in one line each
- **Q1 (viewer sees things early / after expiry / without password):** video, download, captions, track, guide images and the event stream all go through `gated`/`access()` and are blocked while `shareable === false`, after expiry, and without the cookie, **except** findings 2, 3, 5, 6, 7.
- **Q2 (owner spoof):** Host header, `X-Forwarded-For`, IPv6 loopback and DNS rebinding are handled (decision uses the socket address; Host regex defeats rebinding). **One real bypass: finding 1 (raw TCP tunnels).**
- **Q3 (guard fails open):** a crash, a restart or a failed blur all fail **closed** (`failClosed`, checkpointed `pipe`). It fails **open** on silent empty OCR / zero frames (4), skipped frames (8), and rules-only runs (9).
- **Q4 (unblurred original on disk / served):** `video.mp4` is replaced by the blurred file, and `original.mp4` (only with `keepOriginal`) is not in the media whitelist, so it is never served. Leaks come from derived files made before the blur (3) and leftovers (11).

## Findings (ranked)

### 1. HIGH, CONFIRMED: owner check is header-based, so a raw TCP tunnel makes any visitor the owner
- **Where:** `auth.js` `fromOwnerMachine` (lines 11-16), used by `isOwner`.
- **Scenario:** the demo uses `ssh -R`, `ngrok tcp`, `socat`, or a default nginx/Caddy proxy on the same Mac. The socket address is `127.0.0.1`, no `X-Forwarded-For` / `cf-connecting-ip` is added, and the attacker sets `Host: localhost:4747` themselves. They are now the owner: `/api/me` hands out the CSRF token, `/api/videos` lists everything, and `DELETE /api/data` works.
- **Fix:** don't infer "owner" from request properties. Serve owner routes on a separate `127.0.0.1`-only listener (or require an HttpOnly owner cookie that only the Electron shell sets), and expose only viewer routes on the LAN/tunnel listener.

### 2. HIGH, CONFIRMED (gate) / PLAUSIBLE (content): `status === 'failed'` bypasses the Privacy Guard gate
- **Where:** `auth.js` `access` line 50 (`v.shareable === false && v.status !== 'failed'`), served by `media.js` `/media/:id/:file` and `/download`.
- **Scenario:** composite fails or the job is interrupted twice (`queue.start`) → `status:'failed'`, `shareable:false`, but ffmpeg already wrote a partial **unblurred** `video.mp4`. A viewer with the link passes the gate and can fetch or download it (partial MP4s are often recoverable).
- **Fix:** return a dedicated `'failed'` gate state (e.g. 410) for non-owners instead of `ok`; never serve media when `shareable === false`.

### 3. HIGH, CONFIRMED: owner-made thumbnail/GIF taken before the blur survive it and are shown to viewers
- **Where:** `editor.js` `POST /thumbnail` (line 83) and `POST /gif` (line 96) cut from `video.mp4` with no `shareable` check; `media.js` `mediaFile` prefers `thumb-custom.jpg` / serves `preview.gif`; `orchestrator.js` line 165 only regenerates `thumb.jpg`.
- **Scenario:** the owner can already press play while the guard runs ("ready"). They pick a thumbnail frame or make a GIF showing an API key. The video later gets blurred and `shareable` flips true, but `thumb-custom.jpg` / `preview.gif` still contain the unblurred frame and are served to every viewer.
- **Fix:** in `processJob`, after the blur, delete `thumb-custom.jpg` and `preview.gif` (or regenerate from the blurred file at `thumbAt`/`gifAt`); also reject thumbnail/gif requests while `shareable === false`.

### 4. HIGH, CONFIRMED: Guard clears a video when nothing was actually read
- **Where:** `privacy.js` `scan` lines 116-119 (`count = Math.min(jpgs.length, …)`; 0 frames → empty report), `ocr.js` `visionFrames` lines 65/69 (`m.get(f.file) || []`) and `runVision` line 49 (`catch {}` on bad JSON).
- **Scenario:** frame extraction yields 0 or too few JPEGs, or the Vision helper exits 0 but skips/garbles a file. Result is `lines: []`, so "nothing sensitive found" and `shareable:true`, with the secret unblurred.
- **Fix:** fail closed unless `count >= floor(duration*SCAN_FPS) - 2` and every frame produced an OCR result (missing file = error, not `[]`); treat "0 lines across a whole video longer than a few seconds" as suspicious.

### 5. MEDIUM, CONFIRMED: Spaces list titles of private / checking / expired videos to anyone
- **Where:** `library.js` `GET /api/space/:id` line 36 (no gate; `locked` is only a flag).
- **Scenario:** a viewer opens `/space/:id` and sees `title`, `duration`, `views` of every video in it, including `private` ones and ones the Guard hasn't cleared. Titles are LLM-written from the transcript (e.g. "Rotating the production DB password"). The password gate also returns `title` (`auth.js` line 66) before any password.
- **Fix:** for non-owners return only `id` + a generic "Locked video" label when `access() !== 'ok'`; drop `title` from the gate response.

### 6. MEDIUM, CONFIRMED: spoken secrets are never redacted (audio, transcript, captions, AI notes)
- **Where:** `privacy.js` `redact` (`-c:a copy`, line 194); `orchestrator.js` Transcriber/Insights run **after** `shareable:true`; transcript is served by `/api/v/:id`, `captions.vtt`, `captions.json`.
- **Scenario:** the user says "the password is hunter2" while the screen is clean. Blur finds nothing; audio, captions and summary carry it to every viewer.
- **Fix:** run the same secret regexes on the transcript and mute/bleep (`volume=0` for that interval) before `shareable`, or at minimum warn "Guard only checks the screen, not speech".

### 7. MEDIUM, CONFIRMED (code) / PLAUSIBLE (reachability): gate defaults to "allow"
- **Where:** `auth.js` `access` line 56 (`return 'ok'` for any unrecognised mode), line 50 (`shareable === undefined` is open), `effectivePrivacy` line 41 (`createdAt` undefined → `NaN` → never expires).
- **Scenario:** a garbage/legacy `privacy.mode` or `defaultPrivacy` (e.g. `'team'`, `'unlisted'`) opens the video to everyone; a record created without `shareable` (image items, migrated data, any new creation path) skips the Guard entirely.
- **Fix:** whitelist modes (`link|password|email|private`) and treat anything else as `private`; use `v.shareable !== true` as "checking" after a one-time migration marking old videos true; validate `createdAt`.

### 8. MEDIUM, CONFIRMED (logic) / PLAUSIBLE (exploit): frame sampling can skip a short-lived secret, and ordering breaks after ~83 min
- **Where:** `privacy.js` `pickFrames` (`maxSame = 2` differing bits of a 9×8 hash; `maxGap = 2` s) and `scan` line 116 (`.sort()` on `f%04d.jpg`).
- **Scenario (a):** a one-line token flashing for <2 s on an otherwise static screen changes ≤2 hash bits, so those frames are never OCRed. **(b):** past 9999 frames (83 min at 2 fps) `f10000.jpg` sorts before `f9999.jpg`, so frame indexes no longer match `hash.raw` and blur intervals land at the wrong times.
- **Fix:** (a) lower `maxGap` to ~0.5-1 s or add a cheap local-change check (diff per tile, not whole-frame hash); (b) sort numerically (`parseInt`) or use `%06d`.

### 9. MEDIUM, CONFIRMED: detection is weaker than "Privacy Guard" suggests; degraded runs are silent
- **Where:** `privacy.js` `PATTERNS`, `llmFindings` (model not loaded → rules only, logged only), `redact` (`boxblur`), `ocr.js` `extractLines` (`confidence > 35`).
- **Scenario:** right after launch the model isn't warm (45 s delay, never warmed while recording), so the first recordings are rules-only and still become `shareable` without telling the user. No rule for names/addresses; AWS secret keys containing `/` or `+` don't match `secret`; low-confidence OCR words are dropped; a box blur on large text can be partly reversible.
- **Fix:** show "rules-only check" on the video (and optionally hold sharing until the model is warm); replace `boxblur` with a solid `drawbox` fill; add `[A-Za-z0-9/+=]{40}` and a "named by user" blocklist.

### 10. LOW-MEDIUM, CONFIRMED: password gate is brute-forceable and blocks the event loop
- **Where:** `viewer.js` `POST /unlock` (`limit` = 2 requests/s per IP, line 13), `auth.js` `checkPw` (`scryptSync`); email mode accepts any `x@y.z`.
- **Scenario:** a LAN viewer tries ~7,000 passwords/hour per IP with no lockout; each guess is a synchronous scrypt that stalls the whole server (and the recorder's local API) for tens of ms. "Email" mode is a speed bump, not authentication.
- **Fix:** per-video attempt counter with exponential lockout, async `crypto.scrypt`, and describe email mode honestly in the UI.

### 11. LOW, CONFIRMED: sensitive leftovers stay on disk after failures
- **Where:** `orchestrator.js` `encodeRecording` (raw `screen_N`/`cam_N` kept on composite failure; `SPOOL_KEEP_RAW`), `processJob` (`video.blur.mp4` kept on `failClosed`; `work/scan/*.jpg` kept if the job throws outside `guarded`), `keepOriginal` → `original.mp4`.
- **Scenario:** none are served (media whitelist is only `video.mp4`, `preview.gif`, `image.png`, thumbs), but they are unblurred or half-blurred copies of the screen that sit on disk until the video is deleted.
- **Fix:** wrap `processJob` in `try/finally` that removes `work/` and `video.blur.mp4`, and delete raw tracks after the final state (success or terminal failure), not only on success.

## Q&A defence: "How do you know viewers can't see secrets?"
(These are true as of Phase 4; the limits in the last answer are real.)
1. "Every viewer request (video, thumbnail, download, captions, live updates, spaces) goes through one `access()` function. It says blocked unless the Privacy Guard has cleared the video, and a failed or interrupted check, a crash or a restart all leave it blocked, so a failure means 'only you can watch', never 'everyone can'. 'Only you' is proven by a sign-in cookie the app hands out, not by a header someone could fake."
2. "Detection is a floor of deterministic OCR rules plus an optional local model. What it finds is covered with a solid black box and the blurred file replaces the original, so the unblurred recording isn't kept or served unless I turn on `keepOriginal`. Thumbnails and GIFs made before the blur are regenerated or deleted."
3. "The guard listens too: spoken passwords, keys, PINs and card numbers are bleeped in the audio and removed from the transcript and captions before anyone can watch. Loom would publish your password if you said it out loud; Spool bleeps it. It costs no measurable time, because speech recognition runs while the blur pass encodes (16.9 s from Stop to viewers on a 24 s clip)."
4. "I'm honest about the limits: it reads the screen twice a second, so a secret that flashes by for under two seconds on an otherwise static screen can be missed; the speech check is rule-based, so a secret said with no cue like 'password' can slip through; and without the local model loaded it runs on its rules alone, and says so on the video. For sensitive demos I keep the link on password or private and read the Guard's report."
