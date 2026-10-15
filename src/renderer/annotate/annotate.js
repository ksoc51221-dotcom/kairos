const C = window.SPOOL, $ = (i) => document.getElementById(i), c = $('c'), x = c.getContext('2d');
const SHADOW = getComputedStyle(document.documentElement).getPropertyValue('--stroke-shadow').trim();
const COLORS = C.ANNOTATE_COLORS; let color = COLORS[0], tool = 'arrow', ops = [], cur = null, img = new Image();
$('colors').innerHTML = COLORS.map((k, i) => `<span class="sw${i ? '' : ' on'}" data-c="${k}" style="background:${k}"></span>`).join('');
document.querySelectorAll('.sw').forEach((s) => (s.onclick = () => { color = s.dataset.c; document.querySelectorAll('.sw').forEach((z) => z.classList.toggle('on', z === s)); }));
document.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => { tool = b.dataset.tool; document.querySelectorAll('[data-tool]').forEach((z) => z.classList.toggle('on', z === b)); }));
spool.on('annotate:init', (o) => { img.onload = () => { c.width = img.naturalWidth; c.height = img.naturalHeight; render(); }; img.src = o.image; });
const lw = () => Math.max(3, c.width / 300);
function arrow(a, b, col) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x), h = lw() * 5; x.strokeStyle = x.fillStyle = col; x.lineWidth = lw() * 1.2; x.lineCap = 'round';
  x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x - Math.cos(ang) * h * 0.6, b.y - Math.sin(ang) * h * 0.6); x.stroke();
  x.beginPath(); x.moveTo(b.x, b.y); x.lineTo(b.x - h * Math.cos(ang - 0.45), b.y - h * Math.sin(ang - 0.45)); x.lineTo(b.x - h * Math.cos(ang + 0.45), b.y - h * Math.sin(ang + 0.45)); x.closePath(); x.fill();
}
function pixelate(r) {
  const w = Math.max(1, Math.abs(r.b.x - r.a.x)), h = Math.max(1, Math.abs(r.b.y - r.a.y)), px = Math.min(r.a.x, r.b.x), py = Math.min(r.a.y, r.b.y), f = 14;
  const t = document.createElement('canvas'); t.width = Math.max(1, w / f); t.height = Math.max(1, h / f); const tc = t.getContext('2d');
  tc.drawImage(img, px, py, w, h, 0, 0, t.width, t.height); x.imageSmoothingEnabled = false; x.drawImage(t, 0, 0, t.width, t.height, px, py, w, h); x.imageSmoothingEnabled = true;
}
function drawOp(o) {
  x.lineWidth = lw(); x.strokeStyle = o.color; x.lineJoin = 'round';
  if (o.tool === 'arrow') arrow(o.a, o.b, o.color);
  else if (o.tool === 'rect') x.strokeRect(o.a.x, o.a.y, o.b.x - o.a.x, o.b.y - o.a.y);
  else if (o.tool === 'ellipse') { x.beginPath(); x.ellipse((o.a.x + o.b.x) / 2, (o.a.y + o.b.y) / 2, Math.abs(o.b.x - o.a.x) / 2, Math.abs(o.b.y - o.a.y) / 2, 0, 0, 7); x.stroke(); }
  else if (o.tool === 'pen') { x.beginPath(); o.pts.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))); x.stroke(); }
  else if (o.tool === 'text') { x.font = `700 ${Math.round(c.width / 38)}px -apple-system,sans-serif`; x.fillStyle = o.color; x.textBaseline = 'top'; x.shadowColor = SHADOW; x.shadowBlur = 3; x.fillText(o.text, o.a.x, o.a.y); x.shadowBlur = 0; }
  else if (o.tool === 'blur') pixelate(o);
}
function render() { x.drawImage(img, 0, 0); ops.forEach(drawOp); if (cur) drawOp(cur); }
const pos = (e) => { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) * c.width / r.width, y: (e.clientY - r.top) * c.height / r.height }; };
c.onmousedown = (e) => {
  const p = pos(e);
  if (tool === 'text') { const t = $('txt'); t.style.display = 'block'; t.style.left = e.clientX + 'px'; t.style.top = e.clientY + 'px'; t.style.color = color; t.textContent = ''; t.focus(); t.dataset.x = p.x; t.dataset.y = p.y; t.dataset.c = color; return; }
  cur = { tool, color, a: p, b: p, pts: [p] };
};
c.onmousemove = (e) => { if (!cur) return; const p = pos(e); cur.b = p; cur.pts.push(p); render(); };
c.onmouseup = () => { if (cur) { ops.push(cur); cur = null; render(); } };
function commitText() { const t = $('txt'); if (t.style.display === 'block' && t.textContent.trim()) { ops.push({ tool: 'text', color: t.dataset.c, a: { x: +t.dataset.x, y: +t.dataset.y }, text: t.textContent }); render(); } t.style.display = 'none'; }
$('txt').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commitText(); } };
$('txt').onblur = commitText;
$('undo').onclick = () => { ops.pop(); render(); };
addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'z') { ops.pop(); render(); } if (e.key === 'Escape') spool.send('annotate:cancel'); });
const out = () => { commitText(); return c.toDataURL('image/png'); };
$('save').onclick = () => spool.send('annotate:save', out());
$('copy').onclick = () => { spool.send('annotate:copy', out()); $('copy').textContent = 'Copied ✓'; setTimeout(() => ($('copy').textContent = 'Copy'), 1200); };
$('cancel').onclick = () => spool.send('annotate:cancel');
