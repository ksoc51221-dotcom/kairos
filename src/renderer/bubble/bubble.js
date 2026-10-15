const C = window.SPOOL, I = window.SpoolIcons;
const cam = document.getElementById('cam'), ring = document.getElementById('ring'), v = document.getElementById('v');
let st = { w: 200, h: 200, shape: 'circle', filter: 'none', frame: 'ring' };
function apply(s) {
  st = { ...st, ...s };
  const r = Math.round(C.cornerRadius(st.shape) * Math.min(st.w, st.h)) + 'px';
  for (const el of [cam, ring]) Object.assign(el.style, { width: st.w + 'px', height: st.h + 'px', borderRadius: r });
  v.style.filter = C.FILTER_CSS[st.filter] || 'none';
  ring.style.cssText += ';border:' + (C.FRAME_CSS[st.frame] || 'none');
  document.getElementById('bShape').innerHTML = I.svg(st.shape);
  document.getElementById('bFilter').textContent = C.FILTER_LABELS[st.filter];
  document.getElementById('bFrame').textContent = C.FRAME_LABELS[st.frame];
}
apply({});
spool.on('bubble:style', apply);
spool.on('bubble:init', async ({ camId, fake }) => {
  if (fake) { cam.style.background = 'linear-gradient(135deg, var(--key), var(--raised))'; return; } // self-test: no real camera, so no permission prompt
  try { v.srcObject = await navigator.mediaDevices.getUserMedia({ video: { deviceId: camId ? { exact: camId } : undefined, width: 640, height: 640 }, audio: false }); } catch (e) { console.error(e); }
});
document.querySelectorAll('#tools button').forEach((b) => (b.onclick = () => spool.send('bubble:action', b.dataset.a, b.dataset.v)));
