const $ = (id) => document.getElementById(id);
const TIPS = ['Take a breath. You have got this.', 'Talk to one person, not a crowd.', 'Close the tabs you do not need.', 'Say what you will show before you show it.', 'Mistakes are fine: Live Rewind can fix them.'];
KairosIcons.fill(document);
// This window is created hidden while the launcher is open (B26). It starts counting only when main sends countdown:begin.
let left = 3, over = false, timer = null;
function restartRing() { const a = $('arc'); a.style.animation = 'none'; void a.getBoundingClientRect(); a.style.animation = ''; }
function begin() {
  clearInterval(timer); left = 3; over = false; $('n').textContent = '3';
  $('tip').textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
  document.body.classList.remove('out'); document.body.classList.remove('go'); void document.body.offsetWidth; document.body.classList.add('go'); restartRing();
  requestAnimationFrame(() => requestAnimationFrame(() => spool.send('countdown:painted'))); // first frame with the countdown on it
  timer = setInterval(() => { left--; if (left <= 0) end('countdown:done'); else { $('n').textContent = left; restartRing(); } }, 1000);
}
// How the countdown ends decides what main does next: done/skip start recording, cancel undoes the start.
function end(channel) {
  if (over) return; over = true; clearInterval(timer);
  document.body.classList.add('out');
  setTimeout(() => spool.send(channel), 120); // let the fade finish before the window closes
}
spool.on('countdown:begin', begin);
$('cancel').onclick = () => end('countdown:cancel');
$('skip').onclick = () => end('countdown:skip');
// No keyboard handling: this window never takes focus (B28), so keys go to the app the user is in. Use the two buttons.
