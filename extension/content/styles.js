// CSS for the in-page launcher, recording bar, countdown, camera bubble and toast. It lives in a shadow root, so the page's own CSS cannot restyle it
// and ours cannot leak out. The tokens below are the Kairos palette (see src/shared/ui.css): emerald accent, red for record and "turn off".
self.__kairosCss = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; }
.root {
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --ease: cubic-bezier(.2, .8, .2, 1);
  --accent: #047857; --accent-hover: #0a8a67; --accent-lt: #34d399;
  --rec: #dc2626; --rec-hover: #ef4444;
  --surface: #0f172a; --raised: #1e293b; --line: #475569; --ink: #cbd5e1; --ink-strong: #f8fafc;
  font-family: var(--font); color: var(--ink-strong); -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; border: 0; background: none; padding: 0; cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent-lt); outline-offset: 2px; }
[hidden] { display: none !important; }
svg.i { width: 22px; height: 22px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
svg.i .f { fill: currentColor; stroke: none; }

/* ---- the dock: launcher while idle, control bar while recording. Same spot, draggable by its grip. ---- */
.dock { position: fixed; left: var(--x, 24px); bottom: var(--y, 24px); z-index: 2; }
.grip { position: absolute; left: -14px; top: 50%; width: 10px; height: 26px; margin-top: -13px; cursor: grab; opacity: .0; transition: opacity 120ms var(--ease);
  background: radial-gradient(circle, #64748b 1.3px, transparent 1.6px) 0 0 / 5px 6px; touch-action: none; }
.dock:hover .grip, .grip:active { opacity: .9; }
.grip:active { cursor: grabbing; }

.launcher { position: relative; }
.stack { position: absolute; left: 12px; bottom: 100%; padding-bottom: 12px; display: flex; flex-direction: column; gap: 12px;
  opacity: 0; transform: translateY(8px); pointer-events: none; transition: opacity 140ms var(--ease), transform 140ms var(--ease); }
.launcher:hover .stack, .launcher:focus-within .stack { opacity: 1; transform: none; pointer-events: auto; }
.orb { position: relative; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; color: #fff; background: var(--accent);
  box-shadow: 0 4px 14px rgba(2, 6, 23, .35); transition: background 120ms var(--ease), transform 120ms var(--ease); }
.orb:hover { background: var(--accent-hover); transform: scale(1.06); }
.orb.off { background: var(--rec); }
.orb.off:hover { background: var(--rec-hover); }
.tip { position: absolute; left: calc(100% + 10px); top: 50%; transform: translateY(-50%); white-space: nowrap; padding: 7px 11px; border-radius: 6px;
  background: var(--surface); color: var(--ink-strong); font: 600 12.5px/1 var(--font); box-shadow: 0 0 0 1px var(--line); opacity: 0; pointer-events: none; transition: opacity 120ms var(--ease); }
.orb:hover .tip, .orb:focus-visible .tip { opacity: 1; }
.pill { display: grid; place-items: center; width: 60px; height: 60px; border-radius: 50%; background: var(--accent); color: #fff;
  box-shadow: 0 6px 20px rgba(2, 6, 23, .4); transition: background 120ms var(--ease), transform 120ms var(--ease); }
.pill svg.i { width: 36px; height: 36px; }
.pill:hover { background: var(--accent-hover); }
.pill:active { transform: scale(.98); }
.launcher.busy .pill, .launcher.busy .orb { opacity: .55; pointer-events: none; }

.bar { display: flex; align-items: center; gap: 6px; height: 52px; padding: 0 8px 0 18px; border-radius: 28px; background: var(--surface); box-shadow: 0 6px 20px rgba(2, 6, 23, .45), 0 0 0 1px var(--line); }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--rec); animation: pulse 1.2s ease-in-out infinite; }
.bar.paused .dot { background: #f59e0b; animation: none; }
.time { min-width: 52px; margin: 0 8px 0 10px; font: 600 15px/1 var(--mono); color: var(--ink-strong); font-variant-numeric: tabular-nums; }
.tool { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 50%; color: var(--ink-strong); transition: background 120ms var(--ease); }
.tool:hover { background: var(--raised); }
.tool.stop { background: var(--rec); color: #fff; }
.tool.stop:hover { background: var(--rec-hover); }
.bar.saving .tool, .bar.saving .dot { display: none; }
.bar.collapsed { padding: 0; width: 22px; height: 22px; justify-content: center; opacity: .55; }
.bar.collapsed > :not(.dot):not(.expand) { display: none; }
.bar.collapsed .expand { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 50%; }
.bar:not(.collapsed) .expand { display: none; }
@keyframes pulse { 50% { opacity: .35; } }

/* ---- countdown ---- */
.countdown { position: fixed; inset: 0; z-index: 1; display: grid; place-items: center; background: rgba(2, 6, 23, .55); }
.countdown .n { width: 168px; height: 168px; display: grid; place-items: center; border-radius: 50%; background: var(--surface); box-shadow: 0 0 0 1px var(--line), 0 12px 40px rgba(2, 6, 23, .5);
  font: 700 84px/1 var(--font); color: var(--ink-strong); animation: pop 1s var(--ease) infinite; }
.countdown .hint { position: absolute; bottom: 14%; font: 500 13px/1 var(--font); color: var(--ink); }
@keyframes pop { 0% { transform: scale(.88); opacity: .5; } 25% { transform: scale(1); opacity: 1; } }

/* ---- camera bubble ---- */
.bubble { position: fixed; left: var(--bx, 28px); bottom: var(--by, 112px); z-index: 1; width: var(--s, 180px); height: var(--s, 180px); border-radius: 50%; overflow: hidden; background: #0f172a;
  box-shadow: 0 0 0 3px #fff, 0 10px 30px rgba(2, 6, 23, .45); cursor: grab; touch-action: none; }
.bubble:active { cursor: grabbing; }
.bubble iframe { width: 100%; height: 100%; border: 0; pointer-events: none; background: #0f172a; color-scheme: dark; }

/* ---- toast ---- */
.toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 3; display: flex; align-items: center; gap: 14px; max-width: min(560px, calc(100vw - 32px));
  padding: 12px 14px 12px 18px; border-radius: 10px; background: var(--surface); box-shadow: 0 8px 28px rgba(2, 6, 23, .5), 0 0 0 1px var(--line); font: 500 14px/1.35 var(--font); color: var(--ink-strong); }
.toast.error { box-shadow: 0 8px 28px rgba(2, 6, 23, .5), 0 0 0 1px #b91c1c; }
.toast button { padding: 8px 12px; border-radius: 6px; background: var(--raised); font: 700 13px/1 var(--font); color: var(--accent-lt); }
.toast button:hover { background: #29364b; }

@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;
