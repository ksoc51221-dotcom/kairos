const C = window.SPOOL, I = window.KairosIcons, $ = (id) => document.getElementById(id);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const PAD = 8; // transparent margin around the bar inside its window
let paused = false, total = 0, pen = false, penColor = C.PEN_COLORS[0], rewindOpen = false, hasCam = true;

I.fill(document);
const setIcon = (id, name) => { $(id).innerHTML = I.svg(name); };

// ---- layout: the window is as tall as the bar, and widens only while a panel is open (animated by the main process) ----
function layout() {
  const showRew = rewindOpen && paused, showPen = !showRew && pen, panel = showRew || showPen;
  $('rew').hidden = !showRew; $('colors').hidden = !showPen;
  const anchor = showRew ? $('rewind') : $('pen'), bar = $('bar').getBoundingClientRect();
  $('panel').hidden = false;
  $('panel').style.top = Math.max(PAD, Math.min(anchor.getBoundingClientRect().top - 6, bar.bottom - $('panel').offsetHeight)) + 'px';
  $('panel').classList.toggle('show', panel);
  spool.send('controls:layout', { height: Math.ceil(bar.height) + PAD * 2, panel });
}
new ResizeObserver(layout).observe($('bar'));

$('swatches').innerHTML = C.PEN_COLORS.map((c) => `<span class="sw${c === penColor ? ' on' : ''}" style="background:${c}" data-c="${c}"></span>`).join('');
$('swatches').querySelectorAll('.sw').forEach((s) => (s.onclick = () => {
  penColor = s.dataset.c; $('swatches').querySelectorAll('.sw').forEach((x) => x.classList.toggle('on', x === s)); spool.send('tool', 'pen-color', penColor);
}));

// ---- state from the main process / recorder ----
spool.on('rec:tick', (t) => { $('time').textContent = fmt(t); });
spool.on('rec:paused', (p, t) => {
  paused = p; total = t; $('bar').className = p ? 'paused' : 'rec';
  setIcon('pause', p ? 'play' : 'pause'); $('pause').classList.toggle('is-paused', p); $('pause').title = p ? 'Resume  ⌥⇧P' : 'Pause  ⌥⇧P';
  $('rewind').hidden = !p; if (!p) rewindOpen = false;
  layout();
});
spool.on('tool:state', (s) => {
  pen = s.pen; hasCam = s.hasCam;
  $('pen').classList.toggle('on', s.pen); $('cursor').classList.toggle('on', s.cursor); $('notes').classList.toggle('on', s.notes);
  $('cam').hidden = !s.hasCam; $('cam').classList.toggle('off', !s.cam); setIcon('cam', s.cam ? 'video' : 'video-off');
  layout();
});
spool.on('rec:mic', (on) => { $('mic').classList.toggle('off', !on); setIcon('mic', on ? 'mic' : 'mic-off'); $('mic').title = on ? 'Mute microphone' : 'Unmute microphone'; });

// ---- buttons ----
$('pause').onclick = () => spool.send('rec:control', 'toggle-pause');
$('restart').onclick = () => spool.send('rec:control', 'restart');
$('del').onclick = () => spool.send('rec:control', 'delete');
$('stop').onclick = () => spool.send('rec:control', 'stop');
$('mic').onclick = () => spool.send('rec:control', 'mic');
for (const t of ['pen', 'cursor', 'notes', 'cam']) $(t).onclick = () => spool.send('tool', t);
$('rewind').onclick = () => {
  rewindOpen = !rewindOpen;
  if (rewindOpen) { $('slider').max = total; $('slider').value = Math.max(0, total - 5); $('rt').textContent = fmt($('slider').value); $('rmax').textContent = 'of ' + fmt(total); }
  layout();
};
$('slider').oninput = () => { $('rt').textContent = fmt($('slider').value); };
$('gorew').onclick = () => { rewindOpen = false; spool.send('rec:control', 'rewind', +$('slider').value); };
