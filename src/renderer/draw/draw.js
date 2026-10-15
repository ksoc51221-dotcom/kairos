const C = window.SPOOL, c = document.getElementById('c'), x = c.getContext('2d'); c.width = innerWidth; c.height = innerHeight;
let strokes = [], cur = null, color = C.PEN_COLORS[0], on = false; const FADE = 5000;
const SHADOW = getComputedStyle(document.documentElement).getPropertyValue('--stroke-shadow').trim();
spool.on('draw:mode', (m) => { on = m; document.body.className = m ? 'on' : ''; if (m) window.focus(); });
spool.on('draw:color', (cc) => { color = cc; });
c.onmousedown = (e) => { if (!on) return; cur = { color, pts: [[e.clientX, e.clientY]], t: performance.now(), done: null }; strokes.push(cur); };
c.onmousemove = (e) => { if (cur) { cur.pts.push([e.clientX, e.clientY]); cur.t = performance.now(); } };
c.onmouseup = () => { if (cur) { cur.done = performance.now(); cur = null; } };
addEventListener('keydown', (e) => { if (e.key === 'Escape') spool.send('tool', 'pen'); if (e.key === 'Backspace') strokes = []; });
(function loop() {
  x.clearRect(0, 0, c.width, c.height); const now = performance.now();
  strokes = strokes.filter((s) => !s.done || now - s.done < FADE);
  for (const s of strokes) {
    const alpha = s.done ? Math.max(0, 1 - Math.max(0, now - s.done - 2500) / (FADE - 2500)) : 1;
    x.globalAlpha = alpha; x.strokeStyle = s.color; x.lineWidth = 5; x.lineCap = x.lineJoin = 'round'; x.shadowColor = SHADOW; x.shadowBlur = 4;
    x.beginPath(); s.pts.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]))); x.stroke();
  }
  x.globalAlpha = 1; requestAnimationFrame(loop);
})();
