const $ = (id) => document.getElementById(id);
let left = 3, over = false;
function finish() {
  if (over) return; over = true; clearInterval(timer);
  document.body.classList.add('out');
  setTimeout(() => spool.send('countdown:done'), 120); // let the fade finish before the window closes
}
function restartRing() { const a = $('arc'); a.style.animation = 'none'; void a.getBoundingClientRect(); a.style.animation = ''; }
const timer = setInterval(() => { left--; if (left <= 0) finish(); else { $('n').textContent = left; restartRing(); } }, 1000);
document.addEventListener('click', finish);
addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); finish(); } });
