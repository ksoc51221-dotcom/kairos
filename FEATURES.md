# Feature checklist vs. Loom

Legend: ✅ built and tested · 🟡 built, partly tested or with a limit · ⏳ planned · ❌ not feasible locally (and why)

## Recording
| Feature | Status | Notes |
|---|---|---|
| Screen / Screen + Cam / Cam only | ✅ | Recorded as separate full-quality tracks, composited once on export (Phase 1) |
| Full screen, single window, custom area | ✅ / 🟡 | Window source records the window only; the bubble is placed in a corner |
| System audio | 🟡 | Uses Chromium loopback; macOS 13+ and Screen Recording permission |
| Noise suppression | ✅ | Browser noise suppression + echo cancellation + auto gain |
| Bubble shapes: circle, squircle, portrait, landscape | ✅ | |
| Camera filters (7), frames (6), edge snapping, S/M/L | ✅ | Live preview and published video (ffmpeg equivalents; close to, not identical to, the CSS preview). Edge snapping and sizes are in |
| Virtual backgrounds | ⏳ | Needs a segmentation model |
| Drawing tool, cursor highlight, click ripples | 🟡 | Pen works (a ~50–130 ms capture hiccup when switched on mid-recording). Cursor at 60 Hz and clicks are recorded; highlight, ripples and auto-zoom are drawn by the player, per-video toggles, not in downloads yet. Clicks need Input Monitoring |
| Do Not Disturb while recording | ❌ | macOS has no public API; needs a user-made Shortcut |
| Speaker notes + teleprompter + voice-to-text | ✅ | Dictation runs on local Whisper; notes are never in the recording |
| Live Rewind (pause, rewind, re-record) | ✅ | Segment based; tested with pause, resume and rewind in one run |
| Quality Source / 4K / 1440p / 1080p / 720p, hide menu bar | ✅ | Source is native resolution, scaled only at export; tested at Source, 1080p, 720p |
| Hide desktop icons | ❌ | Would change a system setting |
| Keyboard shortcuts | ✅ | ⌥⇧P pause, ⌥⇧S stop, ⌥⇧D draw, ⌥⇧A screenshot |
| Screenshots with annotations + own link | ✅ | Arrow, box, circle, pen, text, blur. Run through the Privacy Guard (OCR rules, black box) before anyone else can open them |
| Chrome extension, iOS, Android | ⏳ / ❌ | Extension planned; mobile apps are out of scope |
| Meeting recording via calendar | ⏳ | iCal feed planned |

## Pipeline and privacy (Phase 2)
| Feature | Status | Notes |
|---|---|---|
| Owner can watch ≤ 8 s after Stop | 🟡 | 7.6 s for a 24 s worst-case clip on an M2 (encoder-bound, thin margin) |
| Privacy Guard gates viewers (fail closed) | ✅ | Viewers get 423 until it clears; the owner is never blocked. 18.2 s after Stop in the test |
| Blur secrets and personal data | ✅ | Apple Vision OCR + rules (e-mail, keys, tokens, cards, SSN, phone, passwords). Model judgement only when Ollama has the model loaded |
| Unblurred original deleted | ✅ | Optional "Keep the unblurred original" (owner only) |
| Job queue that survives a quit | ✅ | One job at a time; resumes after the last finished stage |
| Speech model status and download | ✅ | Settings → AI; also a warning with a Download button in the launcher and the menu bar before you record (launcher and menu not yet seen in the running app) |
| Live updates without polling | ✅ | Server-Sent Events on the watch page and library |
| Rate limit on viewer writes | ✅ | 20 writes burst, 2/s |

## Recorder UI (Phase 7)
| Feature | Status | Notes |
|---|---|---|
| One dark-glass pill bar at the bottom centre: ✕, source (Full screen, Window, Custom area, Camera only), camera, mic with live level arc, privacy lock, More, Record for agent, blue Record | ✅ | Icons plus tooltips (300 ms), no summary lines. Every old option is ≤ 2 clicks away (`launcher-ui` unit test). Bar is ~548 px wide, wider than Loom's |
| More menu: Speaker notes, Backgrounds (filters, frames), Recording settings (countdown, quality, system audio, hide menu bar, cursor effects, shortcuts, screenshot, library) | ✅ | Exactly three rows |
| Camera bubble hover panel: size slider (continuous), style (filter, frame), shape (rounded square, circle, landscape, portrait), power (camera off); before and during recording | 🟡 | Layout checked against the reference in a stub page; real-window hover and slider drag are covered by the preview e2e only as far as noted in PLAN.md |
| Privacy lock on the bar (Public / Private), default from workspace default | ✅ | Sent as a per-video override only when it differs from the default |
| Record for agent: writes the Action Plan automatically and opens the AI Actions tab | 🟡 | Plan is written after processing, only once the Privacy Guard cleared the video |
| Bubble moves, resizes and shape changes ease in the published video (0.2 s glide; style/size changes cross-fade) | 🟡 | Unit-tested incl. a real ffmpeg run; cross-fade, not a true size morph; not watched in a real recording |
| Default bubble: landscape rounded rectangle, top-left, ~18% of a 1440 pt screen | ✅ | New installs only |
| Hermes logo (pinwheel on a white tile) as app and Dock icon; fades in and out for 2.2 s each time the app is opened | 🟡 | Splash never takes focus or clicks and is excluded from recordings; shown on a user launch and when the app is opened again, not at login. Not yet seen in the running app |
| Hide the dock while recording | ❌ | Only "hide the menu bar" exists; the dock is a system setting |

## Library, sharing, privacy
| Feature | Status |
|---|---|
| Library, search (title, transcript, tags, people), folders, tags, spaces | ✅ |
| Watch later, recently watched, unfinished, Home feed (trending, recommended, following) | ✅ |
| Loomify: upload any video up to 4 GB | ✅ |
| Link, email, embed (iframe + oEmbed + Open Graph) | ✅ |
| Comments, @mentions, emoji + super reactions, notifications with transcript snippet | ✅ |
| Captions + translation to 50+ languages (local model) | ✅ |
| Analytics: who watched, engagement heatmap, CSV export, admin insights | ✅ |
| Password, ask-for-email, private, link expiry, download control, default privacy, activity log | ✅ |
| Branding: logo, colour, hide branding | ✅ |
| Retention policy, disable downloads, data export/delete | ✅ |
| Share over LAN (owner/viewer separation) | ✅ |
| SSO/SCIM, SOC 2, ISO 27001, hosted regions | ❌ (local-first; stated honestly in Settings) |

## Editing (Phase 3)
| Feature | Status | Notes |
|---|---|---|
| Timeline with waveform, zoom to 50×, trim, split, delete range | ✅ | Non-destructive draft; Apply renders once, one level of undo. Checked in headless Chrome and with real ffmpeg |
| Edit by transcript | ✅ | Word timestamps from Whisper; 3 words cut = their length within ±50 ms (measured 0.480 of 0.500 s) |
| Remove filler words, silences > 0.8 s, rambles | ✅ / 🟡 | Reviewable proposals. Fillers and silences measured; the rambles list needs the local model and was not run here |
| Stitch / insert another video or a new recording | 🟡 | Insert and render are tested; "record a new clip" opens the launcher and the clip appears in the list when processed |
| Overlays: text, arrow, box, blur, with start/end and `{{name}}` | ✅ | Placed by dragging on the picture |
| Caption style, background, CTA button, custom thumbnail, 3 s GIF | ✅ | CTA shown in the last 8 s and when paused |
| Undo after Apply | ✅ | Restores the file and all time-keyed data |
| Burn cursor effects / zoom into the file | ⏳ | Player only |
| Custom player controls + hover thumbnails (U13) | ⏳ | Not started |

## Privacy hardening (Phase 4, from the security review)
| Feature | Status | Notes |
|---|---|---|
| Privacy Guard listens too: secrets said with a cue ("the password is…", "my pin is…", "API key is…"), token-like words and runs of 9+ digits are bleeped and removed from transcript and captions | ✅ | Rule-based; a secret said without a cue ("hunter2" on its own) can slip through. Costs no measurable time (16.9 s Stop → viewers, was 15.6–18.2 s) |
| Owner = this machine **and** a per-launch sign-in cookie | ✅ | A raw TCP tunnel to the port is just a viewer. Open the library from the menu bar to sign in |
| Failed or unfinished videos are never served to viewers; unknown privacy modes close the link | ✅ | One-time migration marks old finished videos cleared |
| Thumbnails and GIFs made before a blur are regenerated or deleted | ✅ | Blocked while the guard is still checking |
| Guard fails closed on missing frames or OCR results; solid black fill instead of a blur; AWS secret keys | ✅ | "Rules-only check" shown when the model was not loaded |
| Spaces and the password gate show no titles of locked videos; wrong-password lockout | ✅ | |
| Frames a short-lived secret can fall between (2 s sampling gap); window titles | ⏳ | Documented limits |

## AI Actions, integrations, agents (Phase 4)
| Feature | Status | Notes |
|---|---|---|
| AI Actions: SOP, PR description, bug report, issue, follow-up message, meeting recap | ✅ | Local model, validated JSON, cached per video, 18/18 valid on 3 videos |
| Send to Slack, GitHub, Linear, Jira with a preview first | 🟡 | Request building, preview and sending tested against local endpoints and canned responses; not sent to the real services |
| Hermes MCP server (list, search, transcript, guide, action plan) | ✅ | Tested over stdio with the SDK client; read-only; cleared videos only |
| Record for agents: Action Plan brief (voice, steps, clicks, screenshots) | 🟡 | No window titles (not recorded) |

## Packaging (Phase 5)
| Feature | Status | Notes |
|---|---|---|
| Signed Hermes.app without design/, tests, notes or other platforms' binaries | ✅ | 537 MB (was 947 MB); target 400 MB not reachable (Electron is 290 MB). Signed with a local 'Spool Dev' certificate |
| README with Mermaid diagrams | ✅ | No GIF yet |
| GitHub repo and Release | ⏳ | Waiting for your go-ahead |

## Editing, AI, integrations, later
Tracked in the next batches: auto-zoom export, AI voice, meeting notes, Confluence export, SDK.
