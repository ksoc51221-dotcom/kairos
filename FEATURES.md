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
| Camera filters (7), frames (6), edge snapping, S/M/L | 🟡 | Live preview works; filters and frames are not in the published video until Phase 2. Edge snapping and sizes are in |
| Virtual backgrounds | ⏳ | Needs a segmentation model |
| Drawing tool, cursor highlight, click ripples | 🟡 | Pen works (a ~120 ms capture hiccup when switched on mid-recording). Cursor at 60 Hz and clicks are recorded; highlight and ripples are rendered in Phase 2. Clicks need Input Monitoring |
| Do Not Disturb while recording | ❌ | macOS has no public API; needs a user-made Shortcut |
| Speaker notes + teleprompter + voice-to-text | ✅ | Dictation runs on local Whisper; notes are never in the recording |
| Live Rewind (pause, rewind, re-record) | ✅ | Segment based; tested with pause, resume and rewind in one run |
| Quality Source / 4K / 1440p / 1080p / 720p, hide menu bar | ✅ | Source is native resolution, scaled only at export; tested at Source, 1080p, 720p |
| Hide desktop icons | ❌ | Would change a system setting |
| Keyboard shortcuts | ✅ | ⌥⇧P pause, ⌥⇧S stop, ⌥⇧D draw, ⌥⇧A screenshot |
| Screenshots with annotations + own link | ✅ | Arrow, box, circle, pen, text, blur |
| Chrome extension, iOS, Android | ⏳ / ❌ | Extension planned; mobile apps are out of scope |
| Meeting recording via calendar | ⏳ | iCal feed planned |

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

## Editing, AI, integrations
Tracked in the next batches: trim/stitch/insert, edit by transcript, filler/silence/ramble removal, overlays + variables, captions style, backgrounds, thumbnails/GIF, auto-zoom, AI voice, AI workflows (SOP, PR, issue, email), meeting notes, Confluence export, MCP server, Record-for-agents action plan, Slack/GitHub/Linear/Jira, SDK, bug-report mode.
