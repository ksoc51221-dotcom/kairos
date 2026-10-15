const $ = (id) => document.getElementById(id);
const st = { mode: 'screen-cam', area: 'screen', sourceId: null, displayId: null, crop: null, size: 200, shape: 'circle' };
const KEYS = ['cam', 'mic', 'filter', 'frame', 'quality'], CHECKS = ['sysAudio', 'hideMenu', 'cursorFx', 'clickFx', 'pg'];

function pick(group, attr, cb) {
  group.querySelectorAll('button').forEach((b) => b.onclick = () => {
    group.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); cb(b.dataset[attr]);
  });
}
function setPick(group, attr, val) { group.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset[attr] === String(val))); }
function refreshUI() {
  $('areaSec').hidden = st.mode === 'cam'; $('camSec').hidden = st.mode === 'screen';
  $('bubbleOpts').hidden = st.mode === 'cam';
  $('bsize').hidden = st.mode !== 'screen-cam'; $('shape').hidden = st.mode !== 'screen-cam';
}
function save() {
  const prefs = { mode: st.mode, size: st.size, shape: st.shape };
  KEYS.forEach((k) => (prefs[k] = $(k).value)); CHECKS.forEach((k) => (prefs[k] = $(k).checked));
  spool.invoke('settings:set', { prefs, privacyGuard: $('pg').checked });
}
pick($('modes'), 'm', (m) => { st.mode = m; refreshUI(); save(); checkPerm(); });
pick($('bsize'), 'v', (s) => { st.size = +s; save(); });
pick($('shape'), 'v', (s) => { st.shape = s; save(); });

async function showScreens(srcs) {
  const screens = srcs.filter((s) => s.isScreen);
  $('screens').hidden = screens.length < 2 || st.area !== 'screen';
  $('screens').innerHTML = '';
  screens.forEach((s, i) => { const b = document.createElement('button'); b.textContent = s.name || `Display ${i + 1}`; b.className = i === 0 ? 'on' : '';
    b.onclick = () => { $('screens').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); st.sourceId = s.id; };
    $('screens').appendChild(b); if (i === 0) st.sourceId = s.id; });
}
pick($('area'), 'a', async (a) => {
  st.area = a; st.crop = null; $('windows').hidden = a !== 'window'; $('customInfo').hidden = a !== 'custom'; st.sourceId = null;
  const srcs = await spool.invoke('sources:list');
  if (a === 'screen') showScreens(srcs); else $('screens').hidden = true;
  if (a === 'window') {
    $('windows').innerHTML = '';
    srcs.filter((s) => !s.isScreen).forEach((s) => {
      const d = document.createElement('div'); d.innerHTML = `<img src="${s.thumb}"><span>${s.name}</span>`;
      d.onclick = () => { document.querySelectorAll('#windows div').forEach((x) => x.classList.remove('on')); d.classList.add('on'); st.sourceId = s.id; };
      $('windows').appendChild(d);
    });
  }
  if (a === 'custom') {
    $('customInfo').textContent = 'Click Start, then drag the area you want.'; 
  }
});

async function loadDevices() {
  try { (await navigator.mediaDevices.getUserMedia({ audio: true, video: true })).getTracks().forEach((t) => t.stop()); } catch {}
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (el, kind, none) => {
    const prev = el.value;
    el.innerHTML = devs.filter((d) => d.kind === kind).map((d) => `<option value="${d.deviceId}">${d.label || kind}</option>`).join('');
    if (none) el.innerHTML += '<option value="">No microphone</option>';
    if (prev && [...el.options].some((o) => o.value === prev)) el.value = prev;
  };
  fill($('cam'), 'videoinput'); fill($('mic'), 'audioinput', true);
}

async function checkPerm() {
  const p = await spool.invoke('perm:status'), bad = p.screen !== 'granted';
  $('perm').hidden = !bad; $('start').disabled = bad && st.mode !== 'cam'; $('start').style.opacity = $('start').disabled ? .5 : 1;
  if (bad) $('permtxt').innerHTML = `macOS needs your OK first. Click <b>Open Settings</b>, switch on <b>${p.host || 'Spool'}</b> under Screen &amp; System Audio Recording, then click <b>Restart Spool</b>.`;
}
$('permopen').onclick = () => spool.invoke('perm:open', 'screen'); $('permre').onclick = () => spool.invoke('app:relaunch');
$('x').onclick = () => spool.send('launcher:close'); addEventListener('keydown', (e) => { if (e.key === 'Escape') spool.send('launcher:close'); });
$('lib').onclick = () => spool.invoke('library:open');
$('shot').onclick = () => spool.invoke('screenshot:start');
$('notes').onclick = () => spool.invoke('notes:open');
[...KEYS.map($), ...CHECKS.map($)].forEach((el) => el.addEventListener('change', save));

$('start').onclick = async () => {
  let sourceId = st.sourceId, crop = null, displayId = null;
  const srcs = st.mode !== 'cam' ? await spool.invoke('sources:list') : [];
  if (st.mode !== 'cam') {
    if (st.area === 'window' && !sourceId) { $('start').textContent = 'Pick a window first'; setTimeout(() => $('start').textContent = 'Start Recording', 1500); return; }
    if (!sourceId) sourceId = (srcs.find((s) => s.isScreen) || srcs[0]).id;
    if (st.area === 'custom') {
      const r = await spool.invoke('area:pick', { sourceId });
      if (!r) return; crop = r.crop; sourceId = r.sourceId;
    }
  }
  spool.invoke('record:start', {
    mode: st.mode, sourceId, crop, camId: $('cam').value, micId: $('mic').value, micOn: $('mic').value !== '',
    windowSource: st.area === 'window', quality: $('quality').value, systemAudio: $('sysAudio').checked, hideMenuBar: $('hideMenu').checked,
    cursorFx: $('cursorFx').checked, clickFx: $('clickFx').checked,
    bubble: { size: st.size, shape: st.shape, filter: $('filter').value, frame: $('frame').value },
  });
};

(async () => {
  const c = await spool.invoke('settings:get'); const p = c.prefs || {};
  if (p.mode) { st.mode = p.mode; setPick($('modes'), 'm', p.mode); }
  if (p.size) { st.size = p.size; setPick($('bsize'), 'v', p.size); }
  if (p.shape) { st.shape = p.shape; setPick($('shape'), 'v', p.shape); }
  CHECKS.forEach((k) => { if (p[k] !== undefined) $(k).checked = p[k]; }); $('pg').checked = c.privacyGuard;
  refreshUI(); await loadDevices();
  KEYS.forEach((k) => { if (p[k] && [...$(k).options].some((o) => o.value === p[k])) $(k).value = p[k]; });
  showScreens(await spool.invoke('sources:list'));
})();
window.addEventListener('focus', () => { loadDevices(); checkPerm(); }); checkPerm();
