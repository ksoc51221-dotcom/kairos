# Kairos for Chrome

Record your screen, your camera, or both, from any tab, without installing the Kairos Mac app. Works in Chrome, Edge, Brave and Arc (Chromium 116 or newer).

Recordings stay in your browser (IndexedDB). Nothing is uploaded. Download the ones you want to keep: they are MP4 when your browser can write MP4, WebM otherwise.

## Install (about 1 minute)

1. Run `npm run build:ext` in the repo root, or use the `extension/` folder as it is.
2. Open `chrome://extensions`, switch on **Developer mode**, press **Load unpacked** and choose the `extension/` folder (or unzip `dist/kairos-extension-<version>.zip` first).
3. Look at any website tab, new or already open. A round green **Kairos logo** button sits at the bottom left. No refresh needed: when Kairos is installed, reloaded or switched on, it adds the button to the tabs you already have open.
4. Updated the files? Press the circular arrow on the Kairos card in `chrome://extensions`. Open tabs get the new button by themselves.

## The launcher

Hover the logo button and three round buttons appear above it:

| Button | What it does |
|---|---|
| Red power | Turns Kairos off on this site (the host, without `www.`). An Undo appears for 7 seconds. Turn it back on later from the toolbar popup ("Show the Kairos button on …"). While it is off, Kairos adds nothing at all to that site |
| Person | Records the camera only (with your microphone) |
| Monitor | Records the screen only: Chrome asks which tab, window or screen |
| Kairos logo | Records the screen with a camera bubble |

While recording, a bar shows the time with pause, stop, discard and "hide controls". Drag it by the dotted grip. Shortcuts: **⌥⇧P** pause or resume, **⌥⇧S** stop (change them at `chrome://extensions/shortcuts`). Press **Esc** during the 3-2-1 countdown to cancel. Stopping Chrome's own "Stop sharing" bar also saves the recording. The toolbar icon opens the same three choices for pages where the green button cannot appear (the Chrome Web Store, `chrome://` pages, new-tab page: Chrome keeps every extension out of those). Opening the toolbar icon on a normal website that has no button yet adds it.

Recordings open in the **library** (toolbar popup, or the Library button): play, rename, download, delete.

## How it works

```
page (content script)      service worker (background.js)        offscreen document (offscreen.js)
 launcher, bar, bubble ──►  state machine in chrome.storage.session  ◄─► Chrome's screen picker (getDisplayMedia)
 reads state, never owns it  opens the library when a recording is saved     MediaRecorder: screen / camera / mic -> 1 s chunks -> IndexedDB
                                                                             finished video assembled from the chunks
```

- **State lives in `chrome.storage.session`.** The service worker can be stopped at any moment; every tab and page just renders the stored state. The state machine is pure code in [lib/core.js](lib/core.js) and unit tested.
- **The recorder is an offscreen document**, so recording survives tab changes and navigation.
- **The camera bubble is an iframe of the extension's own page**, so camera access is granted to Kairos once, not asked again on every website. It loads even on pages with a strict Content-Security-Policy (tested with `frame-src 'none'`).
- **Chunks are written every second.** If the browser crashes mid-recording, the library recovers what was written the next time it opens.
- Clicks that a web page scripts (`element.click()`) are ignored; only real clicks start a recording.

## Limits, honestly

- **The camera bubble is drawn in the web page**, so it appears in the video only while Chrome is the thing being recorded (a tab, a Chrome window, or the whole screen with Chrome in front). If you share another app's window, the bubble is not in the video. The Mac app records the camera as its own track and composites it, so use that for other apps.
- **The recording bar is also drawn in the page**, so it is in the video when you record the screen. Use "hide controls" and stop with ⌥⇧S, or from the toolbar popup.
- **System sound** is only captured when you tick "Share tab audio" in Chrome's picker (Chrome's rule). Your microphone is always captured when it is switched on in the popup.
- **No Privacy Guard, no AI notes, no public links, no editor.** Those need the local models in the Mac app. Next step: let the extension hand a recording to a running Kairos app.
- The red button hides Kairos on a site. It does not stop a screen recording from showing that site if you share the whole screen.
- Chromium only. Firefox and Safari do not have the offscreen or desktop-capture APIs this uses.

## Permissions (why each one)

| Permission | Why |
|---|---|
| Run on all `http(s)` pages (`host_permissions`, content script) | To show the launcher on whichever site you are on. It reads nothing from the page |
| `scripting` | To add the launcher to tabs that were already open when Kairos was installed, updated or switched on, instead of asking you to refresh each one |
| `offscreen` | A hidden recorder page that keeps recording while you browse |
| `storage`, `unlimitedStorage` | Settings, the per-site list, and recordings (video is large) |
| `activeTab` | The toolbar popup reads the current tab's address to offer the per-site switch |
| Camera, microphone | Asked once, on a normal tab, the first time you record |

## Development

```bash
npm test                 # unit tests, includes extension/tests/core.test.js
npm run test:ext:e2e     # drives a real Chromium with fake camera and mic; needs playwright-core
```

The end-to-end test loads the extension unpacked, clicks the launcher with a real mouse, records for a few seconds in every mode, and checks the saved file with ffmpeg. It cannot click Chrome's native screen picker, so the "screen" is an animated test pattern (the recorder draws it when the test sets `__testFakeScreen`). Setup: `npm i --no-save playwright-core && npx playwright-core install chromium`, or set `PLAYWRIGHT_CORE` to an existing install. Playwright's Chromium has no H.264, so the e2e covers the WebM path; Chrome itself writes MP4.

Colours and radii follow [src/shared/ui.css](../src/shared/ui.css). The in-page launcher keeps its own copy of the tokens in [content/styles.js](content/styles.js) (it lives in a shadow root), so change both together.
