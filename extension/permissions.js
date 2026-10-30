// One-time (per browser profile) camera and microphone grant. It has to happen on a real extension tab: the offscreen recorder has no UI to prompt from.
// When it succeeds the service worker closes this tab, returns to the page the person was on and carries on starting the recording.
KairosIcons.fill();
const q = new URLSearchParams(location.search);
const need = (q.get('need') || 'camera,mic').split(',').filter(Boolean);
const mode = q.get('mode');
const $ = (id) => document.getElementById(id);
const say = (text, kind) => { const s = $('state'); s.hidden = !text; s.textContent = text || ''; s.className = 'state ' + (kind || ''); };

async function ask() {
  say('');
  const wants = need.length ? need : ['mic'];
  const problems = [];
  for (const n of wants) {                                     // one device at a time, so we can say which one is the problem
    try { (await navigator.mediaDevices.getUserMedia(n === 'camera' ? { video: true } : { audio: true })).getTracks().forEach((t) => t.stop()); }
    catch (e) { problems.push({ n, blocked: e.name === 'NotAllowedError', msg: e.message || e.name }); }
  }
  if (problems.length) {
    const blocked = problems.some((p) => p.blocked), label = (n) => (n === 'mic' ? 'microphone' : 'camera');
    say(blocked ? 'Access to your ' + problems.filter((p) => p.blocked).map((p) => label(p.n)).join(' and ') + ' is blocked. Click the camera icon at the right end of the address bar, choose Allow, then press Try again.'
      : 'Could not open your ' + problems.map((p) => label(p.n)).join(' and ') + ': ' + problems[0].msg, 'bad');
    $('again').textContent = 'Try again';
    $('settings').hidden = !blocked;
    $('nomic').hidden = !problems.some((p) => p.n === 'mic');    // a recording without a voice is better than no recording
    return;
  }
  $('title').textContent = 'All set';
  say('Kairos can use your ' + wants.map((n) => (n === 'mic' ? 'microphone' : 'camera')).join(' and ') + '.', 'good');
  $('again').hidden = true; $('settings').hidden = true; $('nomic').hidden = true;
  $('close').hidden = false;
  chrome.runtime.sendMessage({ t: 'permissionsGranted' });   // if a recording was waiting for this, the worker closes this tab and starts it
}
$('again').onclick = ask;
$('settings').onclick = () => chrome.tabs.create({ url: 'chrome://settings/content/' + (need.includes('camera') && !need.includes('mic') ? 'camera' : 'microphone') });
$('nomic').onclick = async () => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, mic: false } });
  chrome.runtime.sendMessage({ t: 'permissionsGranted' });
};
$('close').onclick = () => window.close();
$('title').textContent = need.includes('camera') ? 'Allow camera and microphone' : 'Allow microphone';
ask();
