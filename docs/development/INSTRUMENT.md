# Kairos → "Instrument" (audit + spec)

Source of truth: `margin/design-refs/REDESIGN-3-INSTRUMENT.md`. Web translation reused from `margin-site/hero.css`.
Before-shots: 130 PNGs (every web page owner + viewer, extension pages, Electron overlays; desktop + phone; dark + light).

## 1. Audit — what looks dated / cluttered / inconsistent

1. **Three palettes, none of them Margin's.** Web = light slate + emerald (`app.css`), overlays = dark slate glass (`shared/ui.css`),
   extension = a third dark slate copy (`extension/lib/kairos.css`) plus a fourth inside the in-page launcher's shadow root (`content/styles.js`).
   Slate-blue blacks (#0f172a) read "Tailwind template", not instrument.
2. **Light-only web UI.** `prefers-color-scheme: dark` does nothing; dark and light shots of every web page are identical.
3. **Green everywhere.** Privacy Guard banner is a full-width emerald slab; primary buttons, active tab, selected nav, tiles behind every
   AI-action icon, the toggle, the volume slider, progress bars and the logo square are all emerald: 8–12 accent hits per screen.
4. **Wordy.** Every AI action row has a helper sentence; "Everything here is computed on this computer"; extension library has three
   paragraphs + a promo card; popup modes have subtitles; welcome has a 3-item essay. Kien found exactly this overwhelming in Margin.
5. **Cards and shadows.** Stats are 5 boxed cards, AI actions sit in a bordered card, library sidebar workspace is a card, reactions are
   bordered buttons with icons + counts. Structure should be hairlines.
6. **Type.** Geist/JetBrains Mono are only *named*, never shipped, so everything falls back to SF Pro/SF Mono. Mono labels exist
   (good bones) but are inconsistent in size/tracking; counts are not always mono.
7. **Icons.** Already inline SVG (good), but stroke 2 (heavy next to Margin's 1.5) and sit in coloured tiles. Brand mark is a green
   pinwheel on an emerald square; splash is a big green pinwheel on a white rounded square.
8. **No motion language.** Hover colour changes only; no load stagger, no count roll, tabs indicator exists but jumps, modals appear
   without pop-in.
9. **Library is thumbnail cards only**, big hero card for "newest" — cinematic but busy; no compact list.
10. **Phone widths** mostly survive, but the watch page stacks a very long side panel under the player and the stat cards wrap 2-up.

## 2. Spec — mapping Kairos to Instrument

**One token file per runtime, same values.** `src/shared/instrument.css` (canonical) imported by web (`app.css`), overlays (`ui.css`)
and copied into `extension/lib/kairos.css` + the launcher shadow-root string (extension can't import outside its folder).
Old variable names stay as aliases pointing at the new ones so nothing breaks mid-migration, then get removed.

| token | dark (primary) | light (inversion) |
|---|---|---|
| `--canvas` | #0B0B0C | #F6F6F3 |
| `--surface` | #131315 | #FFFFFF |
| `--raised` | #1B1B1E | #EDEDE9 |
| `--selected` | #242428 | #E3E3DE |
| `--hair` / `--hair-strong` | white .08 / .16 | black .09 / .18 |
| `--ink` / `--ink-2` / `--ink-3` | #F2F2EE / #A3A3A8 / #838389 | #0B0B0C / #52525A / #6A6A71 |
| `--accent` (fills, marks) | #C6FF3D | #C6FF3D (fills only) |
| `--accent-text` (thin marks, links, 2px bars) | #C6FF3D | #4A6B00 |
| `--on-accent` | #0B0B0C | #0B0B0C |
| `--alert` (record dot, destructive, failed) | #FF5A4E | #C8321F |

- Web pages follow the system theme (dark primary). Electron overlays are always dark (they float over arbitrary screens) at
  `--canvas` @ .92 with a hairline rim. No low-alpha lime washes over black (reads olive).
- **Accent budget ≤3 per screen:** the focus ring, the selection/now bar (2px), one primary button. Everything else is ink.
  Record = alert red, never lime.
- **Type:** ship Geist + Geist Mono WOFF2 (+ `OFL.txt`) in `src/shared/fonts/` (overlays + server serves `/fonts/`) and
  `extension/fonts/`. Prose Geist 13/18 UI, 14/22 body, 18 semibold titles, 28 semibold page titles. Labels Geist Mono 10.5–11
  UPPERCASE +0.1em. Every number, duration, time, count, size is Geist Mono tabular, zero-padded where it is a count (`03 BLURRED`).
- **Shape:** radius 4 chips/kbd, 6 buttons/inputs, 8 panels/popovers/thumbs. No shadows except floating popovers/modals
  (one soft black shadow). Cards become hairline-divided rows and sections.
- **Icons:** one monochrome inline-SVG set at 24 grid, stroke 1.5, round caps, `currentColor`. No icon tiles. Brand mark = the
  pinwheel in ink (no square), next to a mono `KAIROS` wordmark with a 2px lime bar like Margin's.
- **Lists:** library = titles-only rows: monochrome type glyph · title · mono duration · mono relative time; selected row = `--selected`
  + 2px lime bar at the left; hover shows a mono `↵`. No helper sentences under titles anywhere (AI actions, popup modes,
  settings, welcome).
- **Privacy Guard banner** → one hairline row: shield glyph · `PRIVACY GUARD · CLEARED` · `03 BLURRED · 01 BLEEPED` mono.
- **Stats strip** → one mono line of `KEY 1280×720` pairs separated by hairlines, numbers roll in.
- **Reactions** → small rectangles (radius 4), glyph + mono count, ink only.
- **Empty states:** one animated glyph + one mono line (`NO RECORDINGS · 00`), nothing else.
- **Gesture feedback** (bubble hold ring, zoom reticle, launcher): ring track = ink @ .3, progress = lime, "fired" = full lime ring +
  one scale beat; stop gesture = alert red. Recording dot stays alert red.

**Motion** (all off under `prefers-reduced-motion`, which falls back to a 120 ms opacity fade):
load stagger fade-rise 6px / 30 ms (max 8 steps) · numeric roll on counts · sliding 2px selection bar (nav + tabs) ·
row hover 120 ms bg fade + `↵` hint · detail/side panel 12px slide from right + blur 8→0 · dialogs/settings/popovers pop-in
(scale .96→1 + fade, 180 ms) in front of a dim scrim · input focus = lime 1px underline sweeping from left · search field widens on `/`.
Nothing loops except a live recording dot and a "processing" glyph.

## 3. Surfaces (all restyled, behaviour untouched)
Web (`src/server/public`): library (home, folders, spaces, insights), settings, watch (owner + viewer + all gate states: password,
email, private, expired, processing, checking, failed, screenshot), editor, embed, space, share modal, edit/redact prompts.
Extension: popup, library + player view + welcome, permissions, in-page launcher + bubble. Electron overlays: launcher, controls,
countdown, area, annotate, draw, notes, ring, bubble (gesture ring), splash, outline.
Out of scope: gesture logic, server routes, the app icon.

## 4. Decisions (Kien, 2026-11-01)
1. Library: titles-only rows by default + a `ROWS / GRID` toggle that keeps thumbnails.
2. Owner brand colour: KEPT, but applied ONLY on viewer-facing share pages (watch as viewer, gates, embed, space). Lime everywhere else.
   Logo upload stays.
3. Theme: follow the system, dark first.
4. Extension copy: one line each, no subtitles; detail moves into tooltips (`title=`).

Foundation: `src/server/public/instrument.css` (tokens, fonts, motion primitives) + fonts in `src/server/public/fonts`, `extension/fonts`.
