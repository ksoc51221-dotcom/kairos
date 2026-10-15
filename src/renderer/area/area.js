const c = document.getElementById('c'), x = c.getContext('2d'), bg = document.getElementById('bg'), size = document.getElementById('size');
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), SCRIM = css('--scrim'), LINE = css('--outline');
c.width = innerWidth; c.height = innerHeight; let mode = 'record', a = null, b = null, drag = false;
spool.on('area:init', (o) => { mode = o.mode; if (o.image) { bg.src = o.image; bg.hidden = false; } draw(); document.getElementById('hint').textContent = (mode === 'screenshot' ? 'Drag to capture a screenshot' : 'Drag to choose the area to record') + ' · Esc to cancel'; });
function rect() { return a && b ? { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) } : null; }
function draw() {
  x.clearRect(0, 0, c.width, c.height); x.fillStyle = SCRIM; x.fillRect(0, 0, c.width, c.height);
  const r = rect(); if (!r) return; x.clearRect(r.x, r.y, r.w, r.h);
  x.strokeStyle = LINE; x.lineWidth = 2; x.setLineDash([8, 5]); x.strokeRect(r.x, r.y, r.w, r.h);
  size.style.display = 'block'; size.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`; size.style.left = r.x + 'px'; size.style.top = Math.max(0, r.y - 24) + 'px';
}
c.onmousedown = (e) => { drag = true; a = { x: e.clientX, y: e.clientY }; b = a; };
c.onmousemove = (e) => { if (drag) { b = { x: e.clientX, y: e.clientY }; draw(); } };
c.onmouseup = () => { drag = false; const r = rect(); if (r && r.w > 60 && r.h > 40) spool.send('area:done', { x: r.x / innerWidth, y: r.y / innerHeight, w: r.w / innerWidth, h: r.h / innerHeight }); else { a = b = null; draw(); } };
addEventListener('keydown', (e) => { if (e.key === 'Escape') spool.send('area:cancel'); });
draw();
