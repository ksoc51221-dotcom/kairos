// CSS for the in-page launcher, recording bar, countdown, camera bubble and toast. It lives in a shadow root, so the page's own CSS cannot restyle it
// and ours cannot leak out. Tokens are the Instrument set from lib/kairos.css, always dark: this floats over arbitrary sites.
// Near-black pill, hairline rim, ink icons. Record/stop/destructive = alert red. Hover = lime ring. Fonts: Geist Mono is registered on the page by
// content.js (a @font-face cannot live in a shadow root); until it loads, or if the page's CSP refuses it, the system mono is used.
self.__kairosCss = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; }
.root {
  --sans: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --ease: cubic-bezier(.22, 1, .36, 1);
  --canvas: #0B0B0C; --surface: #131315; --raised: #1B1B1E; --selected: #242428;
  --hair: rgba(255, 255, 255, .08); --hair-strong: rgba(255, 255, 255, .16);
  --ink: #F2F2EE; --ink-2: #A3A3A8; --ink-3: #838389;
  --accent: #C6FF3D; --alert: #FF5A4E;
  --pop: 0 12px 32px rgba(0, 0, 0, .4);
  font-family: var(--sans); color: var(--ink); -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; border: 0; background: none; padding: 0; cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[hidden] { display: none !important; }
svg.i { width: 20px; height: 20px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
svg.i .f { fill: currentColor; stroke: none; }

/* ---- the dock: launcher while idle, control bar while recording. Same spot, draggable by its grip. ---- */
.dock { position: fixed; left: var(--x, 24px); bottom: var(--y, 24px); z-index: 2; }
.grip { position: absolute; left: -14px; top: 50%; width: 10px; height: 26px; margin-top: -13px; cursor: grab; opacity: 0; transition: opacity 140ms var(--ease);
  background: radial-gradient(circle, #838389 1.2px, transparent 1.5px) 0 0 / 5px 6px; touch-action: none; }
.dock:hover .grip, .grip:active { opacity: .9; }
.grip:active { cursor: grabbing; }

.launcher { position: relative; }
.stack { position: absolute; left: 8px; bottom: 100%; padding-bottom: 12px; display: flex; flex-direction: column; gap: 10px;
  opacity: 0; transform: translateY(8px); pointer-events: none; transition: opacity 140ms var(--ease), transform 220ms var(--ease); }
.launcher:hover .stack, .launcher:focus-within .stack { opacity: 1; transform: none; pointer-events: auto; }
.orb { position: relative; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; color: var(--ink); background: var(--canvas);
  box-shadow: 0 0 0 1px var(--hair-strong), var(--pop); transition: box-shadow 140ms var(--ease), transform 140ms var(--ease); }
.orb:hover { box-shadow: 0 0 0 2px var(--accent), var(--pop); transform: scale(1.05); }
.orb.off { color: var(--alert); }
.tip { position: absolute; left: calc(100% + 10px); top: 50%; transform: translateY(-50%); white-space: nowrap; padding: 6px 9px; border-radius: 6px;
  background: var(--canvas); color: var(--ink); font: 500 10.5px/14px var(--mono); letter-spacing: .1em; text-transform: uppercase; box-shadow: 0 0 0 1px var(--hair-strong); opacity: 0; pointer-events: none; transition: opacity 140ms var(--ease); }
.orb:hover .tip, .orb:focus-visible .tip { opacity: 1; }
.pill { position: relative; display: grid; place-items: center; width: 60px; height: 60px; border-radius: 50%; background: var(--canvas); color: var(--ink);
  box-shadow: 0 0 0 1px var(--hair-strong), var(--pop); transition: box-shadow 140ms var(--ease), transform 140ms var(--ease); }
.pill svg.i { width: 34px; height: 34px; }
.pill::after { content: ""; position: absolute; top: 9px; right: 9px; width: 7px; height: 7px; border-radius: 50%; background: var(--alert); }
.pill:hover { box-shadow: 0 0 0 2px var(--accent), var(--pop); }
.pill:active { transform: scale(.97); }
.launcher.busy .pill, .launcher.busy .orb { opacity: .55; pointer-events: none; }

.bar { display: flex; align-items: center; gap: 4px; height: 52px; padding: 0 8px 0 18px; border-radius: 26px; background: var(--canvas); box-shadow: 0 0 0 1px var(--hair-strong), var(--pop); animation: pop 220ms var(--ease) both; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--alert); animation: blink 1.2s ease-in-out infinite; }
.bar.paused .dot { background: var(--ink-3); animation: none; }
.time { min-width: 50px; margin: 0 8px 0 10px; font: 500 14px/1 var(--mono); color: var(--ink); font-variant-numeric: tabular-nums; }
.tool { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; color: var(--ink); transition: background 140ms var(--ease), box-shadow 140ms var(--ease); }
.tool:hover { background: var(--selected); }
.tool.stop { background: var(--alert); color: var(--canvas); }
.tool.stop:hover { background: var(--alert); box-shadow: 0 0 0 2px var(--accent); }
.bar.saving .tool, .bar.saving .dot { display: none; }
.bar.collapsed { padding: 0; width: 22px; height: 22px; justify-content: center; opacity: .55; animation: none; }
.bar.collapsed > :not(.dot):not(.expand) { display: none; }
.bar.collapsed .expand { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 50%; }
.bar:not(.collapsed) .expand { display: none; }
@keyframes blink { 50% { opacity: .25; } }
@keyframes pop { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: none; } }

/* ---- countdown ---- */
.countdown { position: fixed; inset: 0; z-index: 1; display: grid; place-items: center; background: rgba(0, 0, 0, .55); }
.countdown .n { width: 168px; height: 168px; display: grid; place-items: center; border-radius: 50%; background: var(--canvas); box-shadow: 0 0 0 1px var(--hair-strong), var(--pop);
  font: 500 84px/1 var(--mono); color: var(--ink); font-variant-numeric: tabular-nums; animation: beat 1s var(--ease) infinite; }
.countdown .hint { position: absolute; bottom: 14%; font: 500 10.5px/14px var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-2); }
@keyframes beat { 0% { transform: scale(.92); opacity: .5; } 25% { transform: scale(1); opacity: 1; } }

/* ---- camera bubble ---- */
.bubble { position: fixed; left: var(--bx, 28px); bottom: var(--by, 112px); z-index: 1; width: var(--s, 180px); height: var(--s, 180px); border-radius: 50%; overflow: hidden; background: var(--canvas);
  box-shadow: 0 0 0 2px var(--ink), var(--pop); cursor: grab; touch-action: none; }
.bubble:active { cursor: grabbing; }
.bubble iframe { width: 100%; height: 100%; border: 0; pointer-events: none; background: var(--canvas); color-scheme: dark; }

/* ---- toast ---- */
.toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 3; display: flex; align-items: center; gap: 14px; max-width: min(560px, calc(100vw - 32px));
  padding: 10px 10px 10px 16px; border-radius: 8px; background: var(--canvas); box-shadow: 0 0 0 1px var(--hair-strong), var(--pop); font: 400 13px/18px var(--sans); color: var(--ink); animation: toast-in 220ms var(--ease) both; }
.toast.error { box-shadow: 0 0 0 1px var(--alert), var(--pop); }
.toast button { padding: 7px 10px; border-radius: 6px; box-shadow: 0 0 0 1px var(--hair-strong); font: 500 10.5px/14px var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink); transition: background 140ms var(--ease); }
.toast button:hover { background: var(--selected); }
@keyframes toast-in { from { opacity: 0; transform: translateX(-50%) scale(.96); } to { opacity: 1; transform: translateX(-50%); } }

@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 120ms !important; animation-iteration-count: 1 !important; transition-duration: 120ms !important; } }
`;
