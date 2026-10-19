const C = window.SPOOL, I = window.HermesIcons, $ = (id) => document.getElementById(id);
const cam = $('cam'), ring = $('ring'), v = $('v'), panel = $('panel'), MIN = C.BUBBLE_MIN, MAX = C.BUBBLE_MAX;
I.fill(document);
let st = { w: 260, h: 260, size: 260, shape: 'circle', filter: 'none', frame: 'ring' };
function apply(s) {
  st = { ...st, ...s };
  const r = Math.round(C.cornerRadius(st.shape) * Math.min(st.w, st.h)) + 'px';
  for (const el of [cam, ring]) Object.assign(el.style, { width: st.w + 'px', height: st.h + 'px', borderRadius: r });
  v.style.filter = C.FILTER_CSS[st.filter] || 'none';
  ring.style.cssText += ';border:' + (C.FRAME_CSS[st.frame] || 'none');
  panel.style.top = (10 + st.h + 10) + 'px'; // under the camera
  $('bFilter').textContent = C.FILTER_LABELS[st.filter]; $('bFrame').textContent = C.FRAME_LABELS[st.frame];
  if (!sizing) { $('size').value = st.size; fill(st.size); } // while the slider is being dragged it is the source of truth, not the echo from main
  document.querySelectorAll('#shapes button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.shape));
}
apply({});
spool.on('bubble:style', apply);
// B27: this window outlives the launcher's preview and becomes the recording's bubble, so it opens the camera once and keeps it.
// A second bubble:init with the same camera does nothing; with another camera it swaps the stream.
let camKey = null;
spool.on('bubble:init', async ({ camId, fake }) => {
  const key = fake ? 'fake' : camId || 'default';
  if (key === camKey) return; camKey = key;
  v.srcObject?.getTracks().forEach((t) => t.stop()); v.srcObject = null;
  if (fake) { cam.style.background = 'linear-gradient(135deg, var(--key), var(--raised))'; return; } // self-test: no real camera, so no permission prompt
  try { v.srcObject = await navigator.mediaDevices.getUserMedia({ video: { deviceId: camId ? { exact: camId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); } catch (e) { console.error(e); camKey = null; }
});
// the size slider is continuous (MIN..MAX); each move is sent as it happens, so the bubble follows the thumb
const fill = (n) => $('size').style.setProperty('--p', ((n - MIN) / (MAX - MIN)) * 100 + '%');
let sizing = false;
$('size').onpointerdown = () => { sizing = true; };
addEventListener('pointerup', () => { sizing = false; });
$('size').oninput = (e) => { const n = +e.target.value; fill(n); if (n !== st.size) { st.size = n; spool.send('bubble:action', 'size', n); } };
document.querySelectorAll('#shapes button').forEach((b) => (b.onclick = () => spool.send('bubble:action', 'shape', b.dataset.v)));
$('power').onclick = () => spool.send('bubble:action', 'power');
$('styl').onclick = () => { $('main').hidden = true; $('style').hidden = false; };
$('back').onclick = () => { $('style').hidden = true; $('main').hidden = false; };
document.querySelectorAll('#style [data-a]').forEach((b) => (b.onclick = () => spool.send('bubble:action', b.dataset.a, b.dataset.v)));
spool.on('bubble:hover', (on) => document.body.classList.toggle('hover', !!on)); // main watches the cursor: the camera is a drag region, which gets no :hover
