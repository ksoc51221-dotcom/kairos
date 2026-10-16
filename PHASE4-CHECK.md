# Phase 4 check (commit 6024885)

**Verdict: ready for Phase 5: YES, with conditions.** No HIGH scenario from REVIEW.md survives in the code, `npm test` is 154/154, and the MCP server works over stdio. Three things must be settled before the demo: screenshots skip the Privacy Guard (finding 1), a recording made with no speech model is stuck "only you can watch" (finding 2), and several acceptance claims are unverified by me (finding 5).

How I checked: read-only. Read the Phase 4 section of PLAN.md, REVIEW.md, and the current code in `auth.js`, `security.js`, `orchestrator.js`, `speech-guard.js`, `editor.js`, `store.js`, `mcp/*`. I ran `npm test` and the MCP server over stdio. I did not launch Electron or run any e2e test (rule), so e2e numbers and timings are unconfirmed.

## 1. R1–R11 status

| # | Status | Where (file:function) | Test |
|---|---|---|---|
| R1 owner check | **FIXED** | `auth.js` `ownerMachine` = `fromOwnerMachine` + `hasOwnerCookie`; `security.js` `ownerCookieOk`, `newLoginCode`/`redeemLoginCode`; `viewer.js` `/owner-login` | `security-review.test.js` R1 ×4 |
| R2 failed bypasses gate | **FIXED** | `auth.js` `access` (`failed` → 410 before anything else; `shareable !== true` → checking); `media.js` and `/api/events` both call `access` | R2 |
| R3 thumb/GIF survive blur | **FIXED** | `editor.js` `guarded` (409 while not `shareable === true`); `orchestrator.js` `dropDerivedPictures` (regenerates thumb, deletes uploaded pic and GIF) | R3 |
| R4 empty OCR clears video | **FIXED** (zero-lines heuristic deliberately not done) | `privacy.js` `assertCoverage`; `ocr.js` missing/garbled Vision result now throws | R4 ×2 |
| R5 titles leak | **FIXED** | `auth.js` `gated` returns `{gate}` only; space list shows "Locked video" | R5 |
| R6 spoken secrets | **FIXED, rule-based** | `speech-guard.js` `guardTranscript`/`bleepAudio`; `orchestrator.js` step 2 | `speech-guard.test.js` (9, incl. real ffmpeg bleep). `tests/e2e/speech.js` not run by me |
| R7 default-allow | **FIXED** | `auth.js` `MODES`, `effectivePrivacy`; `store.js` one-time migration | R7 ×2 |
| R8 sampling | **PARTIAL** | (b) numeric sort fixed, `privacy.js` `sortFrames`. (a) `maxGap` still 2 s: not fixed | R8b |
| R9 weak detection | **PARTIAL** | solid `drawbox`, AWS 40-char rule, "rules-only" label done. Hold-until-model-warm, user blocklist, names/addresses not done | R9 |
| R10 brute force | **PARTIAL** | per-video+address lockout (429) and async scrypt done. E-mail mode wording in UI not done | R10 ×2 |
| R11 leftovers | **FIXED** | `orchestrator.js` `cleanLeftovers` in `finally` (work/, `video.blur.mp4`, `video.mute.mp4`). Raw tracks after a failed composite and `original.mp4` stay on purpose | R11 |

### Re-test of the four HIGH scenarios (by reasoning over the new code)
- **Raw TCP tunnel = owner:** now a viewer. The attacker has loopback and can fake `Host`, but not the per-launch `sp_owner` cookie. The only way to get it is `/owner-login?code=…`, and codes are created only by `ownerLoginPath`, which is called only from `src/main/config.js`. No HTTP route returns one (grep). **Closed.**
- **`failed` status skips the gate:** `access` returns `failed` (410) before the `shareable` check, so partial `video.mp4` is never served; media route and SSE use the same function. **Closed.**
- **Pre-blur custom thumbnail / GIF:** creation returns 409 until `shareable === true`, and after a blur they are regenerated from the blurred file or deleted. **Closed.**
- **Guard clears with nothing read:** `assertCoverage` needs `floor(duration×2)−2` frames and hashes; a missing or garbled OCR result throws and the guard fails closed. **Closed** (tests use a fake OCR helper that exits 0 but skips a frame).

## 2. `npm test`
**154 pass, 0 fail, 0 skipped** (16 s). Matches the claimed 154/154.

## 3. MCP server (`node mcp/server.js`, raw JSON-RPC over stdio)
Works. `initialize` → `spool 0.1.0`, protocol 2025-03-26. `tools/list` → `list_videos, search_videos, get_transcript, get_guide, get_action_plan` (all five). `list_videos` returned 8 videos, all cleared. `get_transcript` on one real id returned 703 chars, no error. `search_videos` and `get_action_plan` also returned content. A path-traversal id (`../../etc`) returns an error ("No video with id"). No window opened. Stderr only: "ready, reading …/Spool/library".

## 4. Claims in "Phase 4 results"

**Confirmed:** 154/154 tests; the five MCP tools and stdio behaviour; the R-table items in section 1; all "Not done" items match the code (R8a, R4 zero-lines, R9 hold/blocklist, R10 UI wording); screenshots/R11 caveats; `@modelcontextprotocol/sdk` is the only new dependency (package.json +1 line); `dist/` has the bundled `mcp/` folder (`server.js`, `lib.js`, `README.md`).

**Could not confirm (not run, per the rules):** e2e pipeline 19/19; `speech.js` 7/7 "run 5 times"; real-model 18/18 valid actions (and the 17/18 first pass, 300 s cold allowance); timings (Stop → owner 7.1 s, Stop → viewers 16.9 s, AI notes 24.0 s, bleep 0.2 s per 10 s clip); "blurred regions at luma std 0"; `codesign --verify` and the packaged app answering `tools/list`; the 947 MB figure (`dist/` is 966 MB now); the browser-pane check of the AI Actions tab; Send to Slack/GitHub/Linear/Jira against the canned endpoints (the unit tests pass, but I did not read them).

## 5. Is "Privacy Guard listens too" real end to end?
**Yes, in the code path, with limits.**
- `orchestrator.js` starts `transcribeNow()` (Whisper with word timings) right after the scan starts; screen scan, blur and speech run side by side.
- The transcript is written to the store only after `guardTranscript` runs, never before. `transcript`, `segments` (captions) and `words` are saved already redacted; spoken hits become `[bleep]`.
- Audio: `bleepAudio` silences the intervals and plays a tone (picture copied). The unit test uses real ffmpeg and measures the volume.
- `shareable: true` is set only after `await speech` and a successful bleep. Transcription failure, missing speech model, or a bleep failure → `open = false` → `shareable:false`, fail closed. No audio track → opens.
- AI notes, guide and captions are produced from the redacted transcript (`runAgents` uses `tr`).
- Limits: rule-based (needs a cue like "password is", token-like words, long digit runs); `settings.speechGuard === false` skips it and leaves the transcript unredacted while still `shareable`; `keepOriginal` keeps an un-bleeped `original.mp4` (owner only, not served).

## 6. Findings (ranked)

1. **MEDIUM, screenshots skip the Privacy Guard entirely.** `src/main/screenshot.js:56` creates image items with `shareable: true`, comment "no Privacy Guard pass for stills yet". A screenshot of a terminal with a key is served to anyone with the link. R7's "closed unless shareable" does not apply. *Fix:* run OCR + solid fill on the PNG before `shareable`, or default image links to private until the guard has run.
2. **MEDIUM, no speech model = nothing becomes shareable.** `orchestrator.js` `transcribeNow` returns `no-model` offline → `open=false` → "only you can watch". Secure, but a hackathon demo on bad Wi-Fi with a fresh install shows a stuck video. *Fix:* check the speech model at launch (Settings → AI status), and tell the user before they record.
3. **MEDIUM, the speech claim is a bit stronger than the code.** Q&A sentence 3 says spoken passwords, keys, PINs and cards "are bleeped". True when said with a cue or as digits; "hunter2" alone slips through, and Whisper may spell a key in a form the rules miss. *Fix:* in the demo and in REVIEW.md say "bleeps secrets said with phrases like 'password is…' and long number runs".
4. **MEDIUM (accepted residual), screen sampling still has a 2 s gap (R8a).** A secret on an otherwise static screen for under 2 s can be missed; the model-warm hold and the "zero text lines" check are also not done. Documented honestly in the table, so it is a known limit, not a surprise.
5. **LOW-MEDIUM, acceptance claims I could not verify** (list in section 4). The e2e numbers, timings and model results are the author's; re-run them in one batch when the user is away from the keyboard.
6. **LOW, `sp_owner` cookie is host-scoped, not port-scoped.** Another web server on `localhost` (e.g. a dev server on :3000) receives the cookie in the browser's requests. It cannot be read by page JS (HttpOnly) and changes every launch, so exposure is small. *Fix:* include the port in the cookie name.
7. **LOW, MCP ignores link privacy.** `mcp/lib.js` `cleared` = `shareable === true && status === 'ready'`; a `private` or password video is still readable by any local MCP client. Reasonable (it is the owner's machine), but say so in `mcp/README.md`.
8. **LOW, e-mail mode is still only a speed bump**, and the UI doesn't say so (R10 leftover).
9. **LOW, Spool.app is stale and large.** Built before the last two edits (sign-in explanation page), 947–966 MB with `design/`, `tests/`, `PLAN.md`, `REVIEW.md` inside; Screen Recording permission was reset by the rebuild.
10. **INFO, R1 side effect.** Old tabs and bookmarks become a viewer until "Open library" is used; the explanation page covers it on `npm start` only.

## Next steps (ordered)
1. Close finding 1: add a stills pass (OCR + `drawbox`) or default screenshots to private; one unit test.
2. Phase 5 packaging: `--ignore` for `design/`, `tests/`, `PLAN.md`, `REVIEW.md`, non-darwin `onnxruntime-node`; rebuild once so the sign-in page ships; re-grant Screen Recording.
3. One batched verification run of the e2e pipeline, `speech.js` and the real-model action test while the user is away, and record the real numbers in PLAN.md.
4. Add a launch-time model check (speech + Ollama) with a visible status, so finding 2 never surprises the user on stage.
5. Tighten wording: REVIEW.md Q&A sentence 3 (speech cues) and `mcp/README.md` (ignores link privacy); then decide on R8a (`maxGap` 1 s costs about 3 s of OCR).
