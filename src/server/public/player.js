// Shared by the watch page and the embed page.
(() => {
  const $ = (i) => document.getElementById(i);
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const LANGS = ['Arabic', 'Bengali', 'Bulgarian', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'Estonian', 'Filipino', 'Finnish', 'French', 'German', 'Greek', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Korean', 'Latvian', 'Lithuanian', 'Malay', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Romanian', 'Russian', 'Serbian', 'Slovak', 'Slovenian', 'Spanish', 'Swahili', 'Swedish', 'Tamil', 'Thai', 'Turkish', 'Ukrainian', 'Urdu', 'Vietnamese', 'Afrikaans', 'Catalan', 'Icelandic', 'Irish', 'Maltese', 'Welsh', 'Albanian', 'Armenian', 'Basque', 'Georgian'];
  const CAPTION_STYLES = { classic: 'background:rgba(0,0,0,.72);color:#fff;padding:6px 14px;border-radius:8px;font-weight:500', bold: 'color:#fff;font-weight:800;text-shadow:0 2px 0 #000,0 0 8px rgba(0,0,0,.8);font-size:1.25em;letter-spacing:.2px', yellow: 'color:#ffe14d;font-weight:800;text-shadow:0 2px 0 #000,0 0 6px #000;font-size:1.2em', minimal: 'color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.9);font-weight:500', mint: 'background:#22c08a;color:#06281d;padding:6px 14px;border-radius:99px;font-weight:700', purple: 'background:#7b5cf0;color:#fff;padding:6px 14px;border-radius:99px;font-weight:700' };
  const BACKGROUNDS = { none: '', purple: 'linear-gradient(135deg,#7b5cf0,#b39dff)', mint: 'linear-gradient(135deg,#22c08a,#8ff0c9)', sunset: 'linear-gradient(135deg,#ff8a5c,#7b5cf0)', night: 'linear-gradient(135deg,#150f27,#3a2a7a)', aurora: 'linear-gradient(135deg,#7b5cf0,#22c08a)' };

  const viewer = () => { try { return JSON.parse(localStorage.getItem('spool_viewer') || '{}'); } catch { return {}; } };
  const setViewer = (v) => { try { localStorage.setItem('spool_viewer', JSON.stringify(v)); } catch {} };
  async function api(path, opts = {}) {
    const r = await fetch(path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify({ ...viewer(), ...opts.body }) : undefined });
    let data = null; try { data = await r.json(); } catch {}
    if (!r.ok) { const e = new Error((data && (data.error || data.gate)) || r.statusText); e.status = r.status; e.data = data; throw e; }
    return data;
  }
  const vars = () => { const o = {}; new URLSearchParams(location.search).forEach((v, k) => (o[k] = v)); return o; };
  const fill = (t, vm) => String(t || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars()[k] ?? (vm.variables || {})[k] ?? '');

  // gate screen for password / email / private / expired
  function gateUI(root, id, e, onOk) {
    const g = e.data?.gate;
    const msg = { private: ['This video is private', 'Only the owner can watch it.'], expired: ['This link has expired', 'Ask the owner for a new one.'] }[g];
    if (msg) { root.innerHTML = `<div class="gate"><h2>${msg[0]}</h2><p>${msg[1]}</p></div>`; return; }
    const pw = g === 'password', v = viewer();
    root.innerHTML = `<form class="gate"><h2>${esc(e.data.title || 'Protected video')}</h2><p>${pw ? 'Enter the password to watch.' : 'Enter your name and email to watch.'}</p>
      ${pw ? '<input id="gpw" type="password" placeholder="Password" autofocus>' : `<input id="gname" placeholder="Your name" value="${esc(v.name || '')}"><input id="gemail" type="email" placeholder="Email" value="${esc(v.email || '')}">`}
      <button class="btn pri">Watch</button><div class="err" id="gerr"></div></form>`;
    root.querySelector('form').onsubmit = async (ev) => {
      ev.preventDefault();
      try { if (!pw) setViewer({ name: $('gname').value.trim() || 'Guest', email: $('gemail').value.trim() }); await api(`/api/v/${id}/unlock`, { body: pw ? { password: $('gpw').value } : {} }); onOk(); }
      catch (er) { $('gerr').textContent = er.message; }
    };
  }

  // attaches overlays, captions, CTA, zoom, heartbeat and floating reactions to a <video>
  function attach({ stage, video, vm, embed }) {
    const st = { vm, caps: null, capLang: null, track: null, sid: null };
    const wrap = $('zoomwrap'), ov = $('ov'), cap = $('cap'), cta = $('cta');
    const rect = () => wrap.getBoundingClientRect();
    if (vm.background && vm.background !== 'none') { stage.style.background = BACKGROUNDS[vm.background] || vm.background; stage.classList.add('bg'); }
    function renderOverlays(t) {
      const list = (st.vm.overlays || []).filter((o) => t >= o.start && t <= o.end);
      const key = list.map((o) => o.id).join(',') + '|' + JSON.stringify(vars());
      if (ov.dataset.k !== key) {
        ov.dataset.k = key;
        ov.innerHTML = list.map((o) => {
          const base = `left:${o.x * 100}%;top:${o.y * 100}%;width:${o.w * 100}%;height:${o.h * 100}%`;
          if (o.type === 'blur') return `<div class="o oblur" style="${base}"></div>`;
          if (o.type === 'box') return `<div class="o obox" style="${base};border-color:${esc(o.color || '#ff3b5c')};${o.fill ? `background:${esc(o.color)}33` : ''}"></div>`;
          if (o.type === 'arrow') return `<svg class="o" style="${base}" viewBox="0 0 100 100" preserveAspectRatio="none"><defs><marker id="ah${o.id}" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${esc(o.color || '#ff3b5c')}"/></marker></defs><line x1="${o.flipX ? 100 : 0}" y1="${o.flipY ? 100 : 0}" x2="${o.flipX ? 0 : 100}" y2="${o.flipY ? 0 : 100}" stroke="${esc(o.color || '#ff3b5c')}" stroke-width="3" vector-effect="non-scaling-stroke" marker-end="url(#ah${o.id})"/></svg>`;
          return `<div class="o otext" style="${base};color:${esc(o.color || '#fff')};font-size:${(o.size || 4) * (rect().width / 100)}px;${o.bg ? `background:${esc(o.bg)};` : ''}">${esc(fill(o.text, st.vm))}</div>`;
        }).join('');
      }
    }
    function renderCaption(t) {
      if (!st.caps) { cap.innerHTML = ''; return; }
      const s = st.caps.find((x) => t >= x.start && t <= Math.max(x.end, x.start + 1)); const txt = s ? s.text : '';
      if (cap.dataset.t !== txt) { cap.dataset.t = txt; cap.innerHTML = txt ? `<span style="${CAPTION_STYLES[st.vm.captionStyle] || CAPTION_STYLES.classic}">${esc(txt)}</span>` : ''; }
    }
    function zoomAt(t) {
      if (!st.vm.autoZoom || !st.track) { wrap.style.transform = ''; return; }
      // follow the cursor: zoom in while it is active near a click, ease back out otherwise
      const c = st.track.cursor || [], k = st.track.clicks || [];
      const recentClick = k.find((x) => x.x !== undefined && t >= x.t - 0.2 && t <= x.t + 2.2);
      let p = null; for (let i = 0; i < c.length; i++) { if (c[i][0] >= t) { p = c[i]; break; } } p = p || c[c.length - 1];
      if (recentClick && p) { const zx = Math.min(Math.max(p[1], .2), .8), zy = Math.min(Math.max(p[2], .2), .8); wrap.style.transformOrigin = `${zx * 100}% ${zy * 100}%`; wrap.style.transform = 'scale(1.6)'; }
      else wrap.style.transform = '';
    }
    function tick() { const t = video.currentTime; renderOverlays(t); renderCaption(t); zoomAt(t); requestAnimationFrame(tick); }
    requestAnimationFrame(tick);
    // CTA button: visible in the last 8 seconds, on pause and at the end
    function ctaUpdate() {
      const c = st.vm.cta; if (!c || !c.url) { cta.hidden = true; return; }
      cta.textContent = fill(c.text, st.vm); cta.href = /^https?:\/\//.test(c.url) ? fill(c.url, st.vm) : '#'; cta.target = '_blank'; cta.rel = 'noopener';
      cta.hidden = !(video.paused || video.ended || video.duration - video.currentTime < 8);
    }
    ['pause', 'play', 'timeupdate', 'ended'].forEach((e) => video.addEventListener(e, ctaUpdate));
    // analytics: one view per page load, heartbeat each second while playing
    let counted = false;
    video.addEventListener('play', async () => {
      if (!counted) { counted = true; try { st.sid = (await api(`/api/v/${vm.id}/view`, { body: {} })).sid; } catch {} }
    });
    setInterval(() => { if (!video.paused && st.sid) api(`/api/v/${vm.id}/heartbeat`, { body: { sid: st.sid, t: video.currentTime } }).catch(() => {}); }, 1000);
    // floating reactions
    function floatReaction(emoji, big) {
      const e = document.createElement('div'); e.className = 'fl' + (big ? ' big' : ''); e.textContent = emoji; e.style.left = 10 + Math.random() * 80 + '%'; stage.appendChild(e); setTimeout(() => e.remove(), big ? 2600 : 1800);
      if (big) for (let i = 0; i < 8; i++) setTimeout(() => { const x = document.createElement('div'); x.className = 'fl'; x.textContent = emoji; x.style.left = Math.random() * 90 + '%'; stage.appendChild(x); setTimeout(() => x.remove(), 1800); }, i * 90);
    }
    let lastT = 0; video.addEventListener('timeupdate', () => { const t = video.currentTime; if (t > lastT && t - lastT < 1) (st.vm.reactionEvents || []).filter((r) => r.at > lastT && r.at <= t).forEach((r) => floatReaction(r.emoji, r.super)); lastT = t; });
    video.addEventListener('seeked', () => { lastT = video.currentTime; });
    async function setCaptions(lang) {
      st.capLang = lang; if (!lang) { st.caps = null; cap.innerHTML = ''; return; }
      st.caps = await api(`/api/v/${vm.id}/captions.json?lang=${encodeURIComponent(lang)}`);
    }
    if (vm.autoZoom) api(`/api/v/${vm.id}/track`).then((t) => (st.track = t)).catch(() => {});
    return { setVM(v) { st.vm = v; ctaUpdate(); }, floatReaction, setCaptions, get caps() { return st.caps; } };
  }
  window.SP = { $, fmt, esc, api, viewer, setViewer, vars, fill, gateUI, attach, LANGS, CAPTION_STYLES, BACKGROUNDS };
})();
