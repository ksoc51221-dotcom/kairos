const $ = (i) => document.getElementById(i);
let mode = 'edit', playing = false, speed = 2, y = 0, size = 30;
window.IrisIcons.fill(document);

spool.on('notes:mode', (o) => {
  mode = o.mode; $('ta').value = o.text || '';
  const prompt = mode === 'prompt';
  $('ta').classList.toggle('hide', prompt); $('prompt').classList.toggle('hide', !prompt); $('foot').classList.toggle('hide', !prompt);
  $('dict').classList.toggle('hide', prompt); $('save').classList.toggle('hide', prompt); $('title').textContent = prompt ? 'Teleprompter' : 'Speaker notes';
  if (prompt) { $('scroll').textContent = o.text || '(no notes)'; y = 0; $('scroll').style.transform = 'translateY(0)'; }
});
$('save').onclick = () => { spool.send('notes:save', $('ta').value); };
$('close').onclick = () => spool.send(mode === 'prompt' ? 'tool' : 'notes:close', 'notes');
$('play').onclick = () => { playing = !playing; $('play').textContent = playing ? 'Pause' : 'Scroll'; if (playing) tick(); };
function tick() { if (!playing) return; y += speed * 0.35; $('scroll').style.transform = `translateY(${-y}px)`; requestAnimationFrame(tick); }
$('slow').onclick = () => { speed = Math.max(1, speed - 1); $('spd').textContent = 'speed ' + speed; };
$('fast').onclick = () => { speed = Math.min(10, speed + 1); $('spd').textContent = 'speed ' + speed; };
$('smaller').onclick = () => { size = Math.max(18, size - 3); $('scroll').style.fontSize = size + 'px'; };
$('bigger').onclick = () => { size = Math.min(60, size + 3); $('scroll').style.fontSize = size + 'px'; };

// dictation: capture 16 kHz mono PCM, ship to main for local Whisper
let ctx, proc, src, stream, chunks = [], recording = false;
$('dict').onclick = async () => {
  if (!recording) {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true }); ctx = new AudioContext({ sampleRate: 16000 }); src = ctx.createMediaStreamSource(stream);
    proc = ctx.createScriptProcessor(4096, 1, 1); chunks = []; proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(proc); proc.connect(ctx.destination); recording = true; $('dict').textContent = 'Stop'; $('dict').classList.add('rec');
  } else {
    recording = false; proc.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); ctx.close();
    $('dict').textContent = 'Transcribing…'; $('dict').classList.remove('rec');
    const n = chunks.reduce((a, c) => a + c.length, 0), all = new Float32Array(n); let o = 0; chunks.forEach((c) => { all.set(c, o); o += c.length; });
    const text = await spool.invoke('notes:dictate', all.buffer);
    if (text) $('ta').value += ($('ta').value && !$('ta').value.endsWith('\n') ? '\n' : '') + text;
    $('dict').textContent = 'Dictate';
  }
};
