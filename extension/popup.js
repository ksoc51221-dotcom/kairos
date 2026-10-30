// The toolbar popup: the same three recording choices as the in-page launcher (for pages where it cannot appear), the microphone switch,
// the per-site switch that undoes the red power button, and pause/stop while a recording runs.
const C = self.KairosCore;
KairosIcons.fill();
const $ = (id) => document.getElementById(id);
let tab = null, site = null, state = C.idle(), timer = null;

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  site = tab && tab.url ? C.siteKey(tab.url) : null;
  const { settings = {}, disabledSites = [] } = await chrome.storage.local.get(['settings', 'disabledSites']);
  $('mic').checked = settings.mic !== false;
  $('mic').onchange = async () => { const cur = (await chrome.storage.local.get('settings')).settings || {}; await chrome.storage.local.set({ settings: { ...cur, mic: $('mic').checked } }); };

  $('siteRow').hidden = !site; $('siteNote').hidden = !!site;
  if (site) {
    chrome.runtime.sendMessage({ t: 'ensureLauncher', tabId: tab.id }).catch(() => {});   // opening the popup also repairs a tab that has no button yet
    $('site').checked = !disabledSites.includes(site);
    $('siteLabel').textContent = 'Show the Kairos button on ' + site;
    $('site').onchange = async () => {
      const cur = (await chrome.storage.local.get('disabledSites')).disabledSites || [];
      await chrome.storage.local.set({ disabledSites: $('site').checked ? cur.filter((s) => s !== site) : [...new Set([...cur, site])] });
    };
  }
  document.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = async () => { await chrome.runtime.sendMessage({ t: 'start', mode: b.dataset.mode, tabId: tab && tab.id }).catch(() => {}); window.close(); }; });
  $('library').onclick = () => { chrome.runtime.sendMessage({ t: 'openLibrary' }); window.close(); };
  $('pause').onclick = () => chrome.runtime.sendMessage({ t: 'pause' });
  $('resume').onclick = () => chrome.runtime.sendMessage({ t: 'resume' });
  $('stop').onclick = async () => { await chrome.runtime.sendMessage({ t: 'stop' }); window.close(); };

  state = (await chrome.storage.session.get('rec')).rec || C.idle();
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'session' && ch.rec) { state = ch.rec.newValue || C.idle(); paint(); } });
  paint();
}
function paint() {
  const live = state.phase !== 'idle' && state.phase !== 'starting';
  $('idle').hidden = live; $('live').hidden = !live;
  $('live').classList.toggle('paused', state.phase === 'paused');
  $('pause').hidden = state.phase === 'paused'; $('resume').hidden = state.phase !== 'paused';
  $('phase').textContent = { countdown: 'Starting...', recording: 'Recording', paused: 'Paused', saving: 'Saving...' }[state.phase] || '';
  clearInterval(timer);
  const tickTime = () => { $('time').textContent = C.formatTime(C.elapsedMs(state, Date.now())); };
  tickTime();
  if (state.phase === 'recording') timer = setInterval(tickTime, 250);
}
init();
