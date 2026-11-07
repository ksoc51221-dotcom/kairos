// The library window's rules, with no Electron in them so unit tests can run them.
// classifyNavigation: only the local server's exact origin stays in the window, web and mail links go to the default apps, anything else goes nowhere.
const EXTERNAL = new Set(['http:', 'https:', 'mailto:']);

function classifyNavigation(url, origin) {
  let u;
  try { u = new URL(url); } catch { return 'block'; }
  if (u.origin === origin && !u.username && !u.password) return 'allow'; // blob: URLs report the origin of the page that made them
  return EXTERNAL.has(u.protocol) ? 'external' : 'block';
}

// Where the window opens: the saved place if enough of it is still on a connected display, otherwise the default size centred on `current`.
const VISIBLE_W = 200, VISIBLE_H = 60;
function fitBounds(saved, workAreas, current, size) {
  const { defaultWidth, defaultHeight, minWidth, minHeight } = size;
  const valid = saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite);
  const onScreen = valid && workAreas.some((a) => {
    const w = Math.min(saved.x + saved.width, a.x + a.width) - Math.max(saved.x, a.x);
    return w >= VISIBLE_W && saved.y >= a.y && saved.y <= a.y + a.height - VISIBLE_H; // the title bar must be reachable
  });
  if (onScreen) return { x: saved.x, y: saved.y, width: Math.max(minWidth, saved.width), height: Math.max(minHeight, saved.height) };
  const width = Math.min(defaultWidth, current.width), height = Math.min(defaultHeight, current.height);
  return { x: Math.round(current.x + (current.width - width) / 2), y: Math.round(current.y + (current.height - height) / 2), width, height };
}

module.exports = { classifyNavigation, fitBounds };
