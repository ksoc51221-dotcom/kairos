// Kairos in the page: the floating launcher, the recording bar, the countdown, the camera bubble and toasts.
//   red power  -> turn Kairos off on this site (undo in the toast, or from the toolbar popup)
//   person     -> record the camera only
//   monitor    -> record the screen only
//   pill       -> record the screen with a camera bubble
// Everything is drawn in one shadow root. The recording state is not kept here: the service worker writes it to chrome.storage.session and every tab just renders it.
(() => {
  // One copy per tab. A copy injected later (after an install, update or re-enable, or by the popup) replaces whatever an earlier copy left behind,
  // including the dead button that an extension reload leaves in a tab.
  try { if (self.__kairos) self.__kairos.destroy(); } catch { /* an orphaned copy cannot always be reached */ }
  document.querySelectorAll('kairos-recorder').forEach((n) => n.remove());
  const C = self.KairosCore, I = self.KairosIcons;
  const site = C.siteKey(location.href);
  if (!site) return;

  let state = C.idle(), disabled = false, dead = false;
  let host = null, root = null, el = {};
  let tick = null, toastTimer = null, lastErrorAt = 0, collapsed = false;
  let pos = { x: 24, y: 24, bx: 28, by: 112 };

  const alive = () => { try { return !dead && !!(chrome.runtime && chrome.runtime.id); } catch { return false; } };
  const send = (msg) => { try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch { return Promise.resolve(null); } };
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

  // ---- mount / unmount ----
  function mount() {
    if (host) return;
    host = document.createElement('kairos-recorder');
    host.style.cssText = 'all: initial;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${self.__kairosCss}</style>
<div class="root">
  <div class="dock" data-dock>
    <span class="grip" data-grip title="Drag to move"></span>
    <div class="launcher" data-launcher>
      <div class="stack">
        <button class="orb off" data-act="disable" aria-label="Turn off Kairos on this site">${I.svg('power')}<span class="tip">Turn off on this site</span></button>
        <button class="orb" data-act="camera" aria-label="Record camera only">${I.svg('person')}<span class="tip">Camera only</span></button>
        <button class="orb" data-act="screen" aria-label="Record screen only">${I.svg('monitor')}<span class="tip">Screen only</span></button>
      </div>
      <button class="pill" data-act="both" aria-label="Record screen and camera with Kairos" title="Record with Kairos (v${chrome.runtime.getManifest().version})">${I.svg('kairos')}</button>
    </div>
    <div class="bar" data-bar hidden>
      <span class="dot"></span><span class="time" data-time>0:00</span>
      <button class="tool" data-act="pause" aria-label="Pause" title="Pause (Alt+Shift+P)">${I.svg('pause')}</button>
      <button class="tool" data-act="resume" aria-label="Resume" title="Resume (Alt+Shift+P)" hidden>${I.svg('play')}</button>
      <button class="tool stop" data-act="stop" aria-label="Stop and save" title="Stop (Alt+Shift+S)">${I.svg('stop')}</button>
      <button class="tool" data-act="cancel" aria-label="Discard recording" title="Discard">${I.svg('trash')}</button>
      <button class="tool" data-act="collapse" aria-label="Hide controls" title="Hide controls (stop with Alt+Shift+S)">${I.svg('eye-off')}</button>
      <button class="expand" data-act="expand" aria-label="Show recording controls"></button>
    </div>
  </div>
  <div class="countdown" data-countdown hidden><div class="n" data-n>3</div><div class="hint">Press Esc to cancel</div></div>
  <div class="bubble" data-bubble hidden></div>
  <div class="toast" data-toast hidden><span data-toast-text></span><button data-toast-act></button></div>
</div>`;
    for (const k of ['dock', 'grip', 'launcher', 'bar', 'time', 'countdown', 'n', 'bubble', 'toast']) el[k] = root.querySelector(`[data-${k}]`);
    el.toastText = root.querySelector('[data-toast-text]'); el.toastAct = root.querySelector('[data-toast-act]');
    el.pause = root.querySelector('[data-act="pause"]'); el.resume = root.querySelector('[data-act="resume"]');
    root.addEventListener('click', onClick);
    drag(el.grip, ['x', 'y']);
    drag(el.bubble, ['bx', 'by']);
    applyPos();
    (document.documentElement || document.body).appendChild(host);
  }
  function unmount() {
    clearInterval(tick); tick = null; clearTimeout(toastTimer);
    if (host) host.remove();
    host = root = null; el = {};
  }

  // ---- state -> screen ----
  // What each part should show for the current state and site setting.
  function want() {
    const p = state.phase, m = state.mode && C.MODES[state.mode];
    const live = !disabled && (p === 'recording' || p === 'paused' || p === 'saving');
    const launcher = !disabled && (p === 'idle' || p === 'starting');
    const bubble = !disabled && C.showsRecordingUi(state) && !!(m && m.camera);
    const countdown = !disabled && p === 'countdown';
    return { p, live, launcher, bubble, countdown, any: launcher || live || bubble || countdown };
  }
  function render() {
    if (!alive()) return teardown();
    const toastOn = el.toast && !el.toast.hidden;
    if (!want().any && !toastOn) { unmount(); return; }
    mount();
    paint();
  }
  // Apply the wanted state to the mounted DOM. Safe to call right after mount(), so a toast on its own never drags the launcher in with it.
  function paint() {
    const w = want(), p = w.p;
    el.launcher.hidden = !w.launcher;
    el.launcher.classList.toggle('busy', p === 'starting');
    el.grip.hidden = !(w.launcher || w.live);
    el.dock.hidden = !(w.launcher || w.live);
    el.bar.hidden = !w.live;
    el.bar.classList.toggle('paused', p === 'paused');
    el.bar.classList.toggle('saving', p === 'saving');
    el.bar.classList.toggle('collapsed', collapsed && p !== 'saving');
    el.pause.hidden = p === 'paused'; el.resume.hidden = p !== 'paused';
    el.countdown.hidden = !w.countdown;
    setBubble(w.bubble, state.mode);
    clearInterval(tick); tick = null;
    if (w.live) { updateTime(); if (p === 'recording') tick = setInterval(updateTime, 250); }
    if (w.countdown) { updateCountdown(); tick = setInterval(updateCountdown, 100); }
    if (p === 'idle' || p === 'starting') collapsed = false;
    if (!disabled && p === 'idle' && state.error && state.error.at !== lastErrorAt && Date.now() - state.error.at < 15000) {
      lastErrorAt = state.error.at;
      if (document.visibilityState === 'visible') toast(state.error.message, { error: true, ms: 9000 });
    }
  }
  function updateTime() {
    const t = el.bar && el.bar.classList.contains('saving') ? 'Saving...' : C.formatTime(C.elapsedMs(state, Date.now()));
    if (el.time) el.time.textContent = t;
  }
  function updateCountdown() {
    if (!el.n) return;
    el.n.textContent = String(Math.max(1, Math.ceil((state.countdownEndsAt - Date.now()) / 1000)));
  }
  function setBubble(on, mode) {
    if (!el.bubble) return;
    el.bubble.hidden = !on;
    if (!on) { el.bubble.replaceChildren(); return; }
    el.bubble.style.setProperty('--s', (mode === 'camera' ? 260 : 180) + 'px');
    if (!el.bubble.firstChild) {
      const f = document.createElement('iframe');
      f.src = chrome.runtime.getURL('bubble.html');
      f.allow = 'camera'; f.setAttribute('aria-label', 'Your camera');
      el.bubble.appendChild(f);
    }
  }

  // ---- actions ----
  function onClick(e) {
    if (!e.isTrusted) return;                                   // a page script must not be able to start a recording
    const b = e.target.closest && e.target.closest('[data-act]');
    if (!b) return;
    if (!alive()) { toast('Kairos was reloaded. Refresh this page to use it.', { ms: 6000 }); return; }   // a button left behind by an extension reload
    const act = b.dataset.act;
    if (act === 'both' || act === 'screen' || act === 'camera') send({ t: 'start', mode: act });
    else if (act === 'disable') disableSite();
    else if (act === 'pause' || act === 'resume' || act === 'stop' || act === 'cancel') send({ t: act });
    else if (act === 'collapse') { collapsed = true; render(); }
    else if (act === 'expand') { collapsed = false; render(); }
  }

  async function setSiteDisabled(off) {
    const { disabledSites = [] } = await chrome.storage.local.get('disabledSites');
    const next = off ? [...new Set([...disabledSites, site])] : disabledSites.filter((s) => s !== site);
    await chrome.storage.local.set({ disabledSites: next });
  }
  async function disableSite() {
    await setSiteDisabled(true);
    disabled = true; render();                                   // storage.onChanged also lands here; render is idempotent
    mount(); toast(`Kairos is off on ${site}`, { action: 'Undo', ms: 7000, onAction: async () => { await setSiteDisabled(false); disabled = false; hideToast(); render(); } });
  }

  function toast(text, o = {}) {
    mount(); paint();
    el.toast.hidden = false; el.toast.classList.toggle('error', !!o.error);
    el.toastText.textContent = text;
    el.toastAct.hidden = !o.action; el.toastAct.textContent = o.action || '';
    el.toastAct.onclick = o.onAction ? (e) => { if (e.isTrusted) o.onAction(); } : null;
    clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, o.ms || 5000);
  }
  function hideToast() { if (el.toast) el.toast.hidden = true; clearTimeout(toastTimer); if (alive()) render(); }

  // ---- dragging (the dock by its grip, the bubble anywhere on it) ----
  function drag(handle, [kx, ky]) {
    handle.addEventListener('pointerdown', (e) => {
      if (!e.isTrusted || e.button !== 0) return;
      e.preventDefault(); handle.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY, ox = pos[kx], oy = pos[ky];
      const target = handle === el.grip ? el.dock : handle;
      const move = (ev) => {
        const w = target.offsetWidth, h = target.offsetHeight;
        pos[kx] = clamp(ox + (ev.clientX - sx), 8, innerWidth - w - 8);
        pos[ky] = clamp(oy - (ev.clientY - sy), 8, innerHeight - h - 8);
        applyPos();
      };
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); savePos(); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
    });
  }
  function applyPos() {
    if (!host) return;
    const w = innerWidth, h = innerHeight;
    host.style.setProperty('--x', clamp(pos.x, 8, w - 80) + 'px'); host.style.setProperty('--y', clamp(pos.y, 8, h - 80) + 'px');
    host.style.setProperty('--bx', clamp(pos.bx, 8, w - 100) + 'px'); host.style.setProperty('--by', clamp(pos.by, 8, h - 100) + 'px');
    // custom properties set on the host inherit into the shadow tree
  }
  function savePos() { try { chrome.storage.local.set({ kairosPos: pos }); } catch {} }

  // ---- wiring ----
  function teardown() { unmount(); window.removeEventListener('resize', applyPos); }
  async function readState() {
    for (let i = 0; i < 3; i++) {
      try { return (await chrome.storage.session.get('rec')).rec || C.idle(); }
      catch { await send({ t: 'wake' }); await new Promise((r) => setTimeout(r, 250)); }   // the worker sets the access level when it starts
    }
    return C.idle();
  }
  async function init() {
    try {
      const st = await chrome.storage.local.get(['disabledSites', 'kairosPos']);
      disabled = (st.disabledSites || []).includes(site);
      if (st.kairosPos) pos = { ...pos, ...st.kairosPos };
      state = await readState();
      chrome.storage.onChanged.addListener((ch, area) => {
        if (!alive()) return;
        if (area === 'session' && ch.rec) { state = ch.rec.newValue || C.idle(); render(); }
        if (area === 'local' && ch.disabledSites) { const off = (ch.disabledSites.newValue || []).includes(site); if (off !== disabled) { disabled = off; render(); } }
      });
      window.addEventListener('keydown', (e) => { if (alive() && e.key === 'Escape' && e.isTrusted && state.phase === 'countdown') send({ t: 'cancel' }); }, true);
      window.addEventListener('resize', applyPos);
      render();
    } catch { /* the extension was reloaded under this tab: stay quiet */ }
  }
  // The service worker and the popup ask this before injecting a copy into a tab, so a tab that already has a working button is left alone.
  try { chrome.runtime.onMessage.addListener((m, _sender, reply) => { if (m && m.t === 'ping' && alive()) reply({ ok: true }); }); } catch { /* the context is already gone */ }
  self.__kairos = { destroy() { dead = true; teardown(); } };
  init();
})();
