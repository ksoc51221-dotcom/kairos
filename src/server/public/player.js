// Shared by the watch page and the embed page.
(() => {
  const $ = (i) => document.getElementById(i);
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const LANGS = ['Arabic', 'Bengali', 'Bulgarian', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'Estonian', 'Filipino', 'Finnish', 'French', 'German', 'Greek', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian', 'Italian', 'Japanese', 'Korean', 'Latvian', 'Lithuanian', 'Malay', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Romanian', 'Russian', 'Serbian', 'Slovak', 'Slovenian', 'Spanish', 'Swahili', 'Swedish', 'Tamil', 'Thai', 'Turkish', 'Ukrainian', 'Urdu', 'Vietnamese', 'Afrikaans', 'Catalan', 'Icelandic', 'Irish', 'Maltese', 'Welsh', 'Albanian', 'Armenian', 'Basque', 'Georgian'];
  const CAPTION_STYLES = { classic: 'background:rgba(11,11,12,.64);color:#F2F2EE;padding:6px 14px;border-radius:8px;font-weight:500;letter-spacing:-.01em', bold: 'color:#fff;font-weight:800;text-shadow:0 2px 0 #000,0 0 8px rgba(0,0,0,.8);font-size:1.25em;letter-spacing:.2px', yellow: 'color:#ffe14d;font-weight:800;text-shadow:0 2px 0 #000,0 0 6px #000;font-size:1.2em', minimal: 'color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.9);font-weight:500', mint: 'background:#22c08a;color:#06281d;padding:6px 14px;border-radius:99px;font-weight:700', blue: 'background:#3267d4;color:#fff;padding:6px 14px;border-radius:99px;font-weight:700', purple: 'background:#3267d4;color:#fff;padding:6px 14px;border-radius:99px;font-weight:700' }; // `purple` is the old name of `blue` ui-rules: allow (owner-chosen caption styles)
  const BACKGROUNDS = { none: '', blue: 'linear-gradient(135deg,#3267d4,#9bb8f2)', purple: 'linear-gradient(135deg,#3267d4,#9bb8f2)', mint: 'linear-gradient(135deg,#22c08a,#8ff0c9)', sunset: 'linear-gradient(135deg,#ff8a5c,#3267d4)', night: 'linear-gradient(135deg,#14161a,#2a3a6a)', aurora: 'linear-gradient(135deg,#3267d4,#22c08a)' }; // `purple` is the old name of `blue` ui-rules: allow (owner-chosen video backgrounds)

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
    const msg = { private: ['This video is private', 'Only the owner can watch it.'], expired: ['This link has expired', 'Ask the owner for a new one.'],
      nopassword: ['This video is locked', "The owner hasn't set a password for it yet. Ask them to open the Share dialog and choose one."],
      checking: ['Almost ready', 'The Privacy Guard is checking this video for sensitive information. It opens by itself when it is done.'],
      failed: ['This video is not available', 'Processing this recording did not finish. Ask the owner to record it again.'] }[g];
    if (g === 'checking') setTimeout(onOk, 3000);
    if (g === 'checking') { // the thumbnail is never sent to a viewer before the guard clears the video, so the frame here is a placeholder, not a blurred still
      root.innerHTML = `<div class="wait"><div class="wframe" aria-hidden="true"><i></i><i></i><i></i></div><div class="wcard" role="status"><h2>${msg[0]}</h2><p>${msg[1]}</p>
        <ol><li class="done">Recorded</li><li class="on"><span class="spin"></span>Privacy Guard is checking</li><li>Ready to watch</li></ol></div></div>`; return; }
    if (msg) { root.innerHTML = `<div class="gate"><h2>${msg[0]}</h2><p>${msg[1]}</p></div>`; return; }
    const pw = g === 'password', v = viewer();
    root.innerHTML = `<form class="gate"><h2>Protected video</h2><p>${pw ? 'Enter the password to watch.' : 'Enter your name and email to watch.'}</p>
      ${pw ? '<input id="gpw" type="password" placeholder="Password" autofocus>' : `<input id="gname" placeholder="Your name" value="${esc(v.name || '')}"><input id="gemail" type="email" placeholder="Email" value="${esc(v.email || '')}">`}
      <button class="btn pri">Watch</button><div class="err" id="gerr"></div></form>`;
    root.querySelector('form').onsubmit = async (ev) => {
      ev.preventDefault();
      try { if (!pw) setViewer({ name: $('gname').value.trim() || 'Guest', email: $('gemail').value.trim() }); await api(`/api/v/${id}/unlock`, { body: pw ? { password: $('gpw').value } : {} }); onOk(); }
      catch (er) { $('gerr').textContent = er.message; }
    };
  }

  // attaches overlays, captions, CTA, zoom, heartbeat and floating reactions to a <video>
  function attach({ stage, video, vm, embed, noStats, controls }) { // noStats: the editor's preview counts no views and sends no heartbeats
    const st = { vm, caps: null, capLang: null, track: null, sid: null };
    const wrap = $('zoomwrap'), ov = $('ov'), cap = $('cap'), cta = $('cta');
    const rect = () => wrap.getBoundingClientRect();
    if (vm.background && vm.background !== 'none') { stage.style.background = BACKGROUNDS[vm.background] || vm.background; stage.classList.add('bg'); }
    function renderOverlays(t) {
      const list = (st.vm.overlays || []).filter((o) => t >= o.start && t <= o.end);
      const key = JSON.stringify(list) + '|' + JSON.stringify(vars()) + '|' + JSON.stringify(st.vm.variables || {});
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
    // Caption looks. Base styles (Clean default, Bold, Minimal) are the viewer's choice (localStorage, CC menu); an owner-chosen look from the editor
    // (classic/bold/minimal map to the base styles; yellow/mint/blue keep their colours on top of Clean) applies until the viewer picks one.
    const CAP_KEY = 'kairos_cap_style', BASES = ['clean', 'bold', 'minimal'], OWNER_BASE = { classic: 'clean', bold: 'bold', minimal: 'minimal' }, OWNER_TINT = { yellow: 'yellow', mint: 'mint', blue: 'blue', purple: 'blue' };
    const pref = () => { if (!(controls || embed)) return null; try { const v = localStorage.getItem(CAP_KEY); return BASES.includes(v) ? v : null; } catch { return null; } }; // the editor preview always shows the owner's own choice
    const capLook = () => { const o = st.vm.captionStyle, p = pref(); return { base: p || OWNER_BASE[o] || (OWNER_TINT[o] ? 'clean' : 'clean'), tint: p ? '' : OWNER_TINT[o] || '' }; };
    if (embed) cap.classList.add('emb');
    window.addEventListener('resize', () => { cap.dataset.t = ''; }); // re-fit the pill to the new width
    const norm = (s) => (Array.isArray(s.words) && s.words.length && s.words.every((w) => isFinite(w.start ?? w.s)) ? s.words.map((w) => ({ t: String(w.text ?? w.word ?? w.w ?? ''), s: +(w.start ?? w.s), e: +(w.end ?? w.e ?? (w.start ?? w.s)) })) : null); // per-word timing only if the transcript carries it
    let capTok = 0, capWords = null, capCur = -2;
    function renderCaption(t) {
      if (!st.caps) { if (cap.dataset.t) { cap.innerHTML = ''; cap.dataset.t = ''; } return; }
      const s = st.caps.find((x) => t >= x.start && t <= Math.max(x.end, x.start + 1)); const txt = s ? s.text : '';
      const look = capLook(), lk = `${look.base}|${look.tint}|${txt}`;
      if (cap.dataset.t !== lk) {
        cap.dataset.t = lk; const tok = ++capTok; capCur = -2; capWords = s ? norm(s) : null;
        const old = cap.firstElementChild;
        if (old && !txt) { old.classList.add('out'); setTimeout(() => { if (tok === capTok) cap.innerHTML = ''; }, 160); return; }
        const inner = capWords ? capWords.map((w, i) => `<span class="w" data-i="${i}">${esc(w.t)}</span>`).join(' ') : esc(txt);
        cap.innerHTML = txt ? `<div class="cl"><span class="cp ${look.base}${look.tint ? ' o-' + look.tint : ''}">${inner}</span></div>` : '';
        const cp = cap.querySelector('.cp'); if (cp) { // text-wrap: balance evens the lines but leaves the box at full width: shrink the pill to the widest line
          const r = document.createRange(); r.selectNodeContents(cp); const rs = [...r.getClientRects()]; const cs = getComputedStyle(cp);
          const lines = {}; rs.forEach((x) => { const k = Math.round(x.top / 4), l = lines[k] || (lines[k] = [1e9, 0]); l[0] = Math.min(l[0], x.left); l[1] = Math.max(l[1], x.right); }); // nested spans give overlapping rects: take each line's left-to-right extent
          if (Object.keys(lines).length > 1) cp.style.width = Math.ceil(Math.max(...Object.values(lines).map((l) => l[1] - l[0])) + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 1) + 'px';
        }
      }
      if (capWords) { let i = -1; for (let k = 0; k < capWords.length; k++) if (t >= capWords[k].s) i = k; if (i !== capCur) { capCur = i; cap.querySelectorAll('.w').forEach((e) => e.classList.toggle('now', +e.dataset.i === i)); } }
    }
    // caption-style switch in the CC menu (watch page only), shown while captions are on
    if (controls) {
      const cc = $('cc'); if (cc) {
        const sel = document.createElement('select'); sel.className = cc.className; sel.id = 'ccs'; sel.setAttribute('aria-label', 'Caption style'); sel.hidden = true;
        sel.innerHTML = BASES.map((b) => `<option value="${b}">${b[0].toUpperCase() + b.slice(1)}</option>`).join(''); cc.after(sel); selectMenu(sel, { label: 'Caption style', icon: 'text' });
        sel.onchange = () => { try { localStorage.setItem(CAP_KEY, sel.value); } catch {} };
        const sync = () => { sel.hidden = !st.caps; sel.value = capLook().base; };
        setInterval(sync, 300);
      }
    }
    // ---- cursor effects, drawn at playback time from the recorded cursor feed (Phase 2). The OS cursor is already in the video; this adds the
    // highlight ring, click ripples and auto-zoom on top, so they cost nothing while recording and can be switched off per video. ----
    const fx = makeFx({ wrap, video, st });
    const pc = controls ? wireControls({ host: controls, stage, video, st }) : null; // custom controls (watch page); the embed keeps the native ones
    function tick() { const t = video.currentTime; renderOverlays(t); renderCaption(t); fx.frame(t); if (pc) pc.update(); requestAnimationFrame(tick); }
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
      if (!counted && !noStats) { counted = true; try { st.sid = (await api(`/api/v/${vm.id}/view`, { body: {} })).sid; } catch {} }
    });
    setInterval(() => { if (!noStats && !video.paused && st.sid) api(`/api/v/${vm.id}/heartbeat`, { body: { sid: st.sid, t: video.currentTime } }).catch(() => {}); }, 1000);
    // floating reactions: a small icon + label chip rises over the video. Unknown (legacy) keys are ignored.
    function floatReaction(kind) {
      const k = KINDS[kind]; if (!k) return;
      const e = document.createElement('div'); e.className = 'fl';
      e.style.cssText = `left:${10 + Math.random() * 70}%;display:flex;align-items:center;gap:6px;padding:4px 8px;background:var(--surface);color:var(--ink);border:1px solid var(--hair-strong);border-radius:4px;font:500 12px/16px var(--sans);white-space:nowrap`;
      e.innerHTML = `<span style="color:var(--ink);display:grid">${window.UI ? UI.i(k[0]) : ''}</span>${esc(k[1])}`; stage.appendChild(e); setTimeout(() => e.remove(), 1800);
    }
    let lastT = 0; video.addEventListener('timeupdate', () => { const t = video.currentTime; if (t > lastT && t - lastT < 1) (st.vm.reactionEvents || []).filter((r) => r.at > lastT && r.at <= t).forEach((r) => floatReaction(r.kind)); lastT = t; });
    video.addEventListener('seeked', () => { lastT = video.currentTime; });
    async function setCaptions(lang) {
      st.capLang = lang; if (!lang) { st.caps = null; cap.innerHTML = ''; return; }
      st.caps = await api(`/api/v/${vm.id}/captions.json?lang=${encodeURIComponent(lang)}`);
    }
    if (vm.type !== 'image') api(`/api/v/${vm.id}/track`).then((t) => { st.track = t; fx.setTrack(t); }).catch(() => {});
    return { setVM(v) { st.vm = v; ctaUpdate(); fx.invalidate(); if (pc) pc.marks(); }, floatReaction, setCaptions, get caps() { return st.caps; } };
  }


  // ---- ghost button + popover menu that fronts a hidden <select> (CC, speed, caption style). The select stays the source of truth, so every existing
  // `.value` / `onchange` keeps working; the menu is role=menu with menuitemradio rows (Enter/Space/ArrowDown opens, arrows/Home/End move, Esc closes and returns focus). ----
  function selectMenu(sel, { label, icon, short } = {}) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn sm ghost pc-menu'; btn.id = sel.id + 'Btn';
    btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-label', label || sel.getAttribute('aria-label') || '');
    sel.after(btn); sel.classList.add('sel-src'); sel.tabIndex = -1;
    const text = () => { const o = sel.selectedOptions[0]; const t = short ? short(sel.value, o) : (o ? o.textContent : ''); return (icon && window.UI ? UI.i(icon) : '') + (t ? `<span>${esc(t)}</span>` : ''); };
    let shown = null, menu = null;
    const paint = () => { const k = sel.value + '|' + sel.hidden; if (k === shown) return; shown = k; btn.innerHTML = text(); btn.hidden = sel.hidden; btn.title = (label || '') + (sel.selectedOptions[0] ? ': ' + sel.selectedOptions[0].textContent : ''); };
    // keep the button in step with programmatic changes (value set by the page, hidden toggled by the caption sync)
    setInterval(() => { if (!menu) paint(); }, 250); paint();
    new MutationObserver(() => { shown = null; paint(); }).observe(sel, { childList: true, subtree: true });
    const items = () => [...menu.querySelectorAll('[role=menuitemradio]')];
    function close(refocus) { if (!menu) return; menu.remove(); menu = null; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', away, true); window.removeEventListener('resize', close); if (refocus) btn.focus(); shown = null; paint(); }
    function away(e) { if (menu && !menu.contains(e.target) && !btn.contains(e.target)) close(false); }
    function pick(o) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); close(true); }
    function open(focusLast) {
      if (menu) return close(true);
      menu = document.createElement('div'); menu.className = 'pop pc-pop'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', label || '');
      const row = (o) => `<button type="button" role="menuitemradio" class="mi" tabindex="-1" aria-checked="${o.value === sel.value}" data-v="${esc(o.value)}"><span class="ck">${o.value === sel.value && window.UI ? UI.i('check') : ''}</span><span>${esc(o.textContent)}</span></button>`;
      menu.innerHTML = [...sel.children].map((c) => (c.tagName === 'OPTGROUP' ? `<div class="mh" role="presentation">${esc(c.label)}</div>${[...c.children].map(row).join('')}` : row(c))).join('');
      document.body.appendChild(menu);
      const r = btn.getBoundingClientRect(), mh = Math.min(menu.offsetHeight, 280), up = r.top > mh + 16 || r.top > innerHeight - r.bottom;
      menu.style.left = Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth)) + 'px';
      menu.style.top = (up ? Math.max(8, r.top - mh - 6) : r.bottom + 6) + 'px'; menu.style.maxHeight = '280px'; menu.style.transformOrigin = up ? 'bottom right' : 'top right';
      btn.setAttribute('aria-expanded', 'true');
      const list = items(), cur = list.find((x) => x.getAttribute('aria-checked') === 'true') || list[0];
      (focusLast ? list[list.length - 1] : cur).focus(); cur.scrollIntoView({ block: 'nearest' });
      menu.onclick = (e) => { const b = e.target.closest('[role=menuitemradio]'); if (b) pick({ value: b.dataset.v }); };
      menu.onkeydown = (e) => {
        const l = items(), i = l.indexOf(document.activeElement);
        const go = { ArrowDown: l[(i + 1) % l.length], ArrowUp: l[(i - 1 + l.length) % l.length], Home: l[0], End: l[l.length - 1] }[e.key];
        if (go) { e.preventDefault(); go.focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
        else if (e.key === 'Tab') close(false);
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (i >= 0) pick({ value: l[i].dataset.v }); }
      };
      document.addEventListener('pointerdown', away, true); window.addEventListener('resize', close);
    }
    btn.onclick = () => open(false);
    btn.onkeydown = (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); open(e.key === 'ArrowUp'); } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); open(false); } };
    return btn;
  }

  const KINDS = { good: ['check-circle', 'Looks good'], question: ['help-circle', 'Question'], issue: ['alert-triangle', 'Problem'], idea: ['lightbulb', 'Idea'], key: ['flag', 'Key moment'] };

  // ---- custom controls: scrubber (buffered + played + playhead + comment/marker ticks), play, time, volume, picture-in-picture, fullscreen of the whole frame ----
  // The markup lives in the page (data-pc attributes, plus its own CC and speed selects); this only wires it.
  function wireControls({ host, stage, video, st }) {
    const q = (n) => host.querySelector(`[data-pc="${n}"]`), ico = (n) => (window.UI ? UI.i(n) : '');
    const play = q('play'), scrub = q('scrub'), buf = scrub.querySelector('.buf'), fil = scrub.querySelector('.fil'), thumb = scrub.querySelector('.thumb'), marksEl = scrub.querySelector('.pc-marks');
    const time = q('time'), mute = q('mute'), vol = q('vol'), pip = q('pip'), fs = q('fs'), frame = host.parentElement;
    video.controls = false; video.removeAttribute('controls');
    const dur = () => (isFinite(video.duration) && video.duration > 0 ? video.duration : st.vm.duration || 0);
    const toggle = () => { if (video.paused || video.ended) { const p = video.play(); if (p && p.catch) p.catch(() => {}); } else video.pause(); };
    const toggleMute = () => { video.muted = !video.muted; if (!video.muted && video.volume === 0) video.volume = 0.5; };
    const fullscreen = () => { const el = document.fullscreenElement || document.webkitFullscreenElement; if (el) (document.exitFullscreen || document.webkitExitFullscreen).call(document); else { const f = frame.requestFullscreen || frame.webkitRequestFullscreen; if (f) f.call(frame); } };
    let last = '', marksKey = '';
    function update() {
      const d = dur(), t = video.currentTime || 0, p = d ? clamp(t / d, 0, 1) * 100 : 0; let b = 0;
      try { const r = video.buffered; if (r.length && d) b = clamp((r.end(r.length - 1) / d) * 100, 0, 100); } catch {}
      const key = `${t.toFixed(2)}|${b.toFixed(0)}|${d}|${video.paused}|${video.muted}|${video.volume}`; if (key === last) return; last = key;
      fil.style.width = p + '%'; thumb.style.left = p + '%'; buf.style.width = b + '%';
      time.innerHTML = `<b>${fmt(t)}</b> / ${fmt(d)}`;
      play.innerHTML = ico(video.paused ? 'play' : 'pause'); play.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
      const silent = video.muted || video.volume === 0; mute.innerHTML = ico(silent ? 'volume-off' : 'volume'); mute.setAttribute('aria-label', silent ? 'Unmute' : 'Mute'); vol.value = video.muted ? 0 : video.volume;
      scrub.setAttribute('aria-valuenow', Math.round(t)); scrub.setAttribute('aria-valuemax', Math.round(d)); scrub.setAttribute('aria-valuetext', `${fmt(t)} of ${fmt(d)}`);
      marks();
    }
    function marks() { // comment ticks (ink) and marker ticks (accent), drawn only when they change
      const d = dur(), cs = st.vm.comments || [], rs = (st.vm.reactionEvents || []).filter((r) => KINDS[r.kind]), key = `${d}|${cs.length}|${rs.length}`; if (key === marksKey) return; marksKey = key;
      marksEl.innerHTML = d ? [...cs.map((c) => [c.at, 'Comment', '']), ...rs.map((r) => [r.at, KINDS[r.kind][1], 'r'])].filter((x) => x[0] >= 0 && x[0] <= d).map((x) => `<i class="pc-mk ${x[2]}" style="left:${(x[0] / d) * 100}%" title="${esc(x[1])} at ${fmt(x[0])}"></i>`).join('') : '';
    }
    play.onclick = toggle; mute.onclick = toggleMute; fs.onclick = fullscreen;
    vol.oninput = () => { video.muted = false; video.volume = +vol.value; };
    if (pip) { if (document.pictureInPictureEnabled && video.requestPictureInPicture) pip.onclick = () => (document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture()).catch(() => {}); else pip.hidden = true; }
    video.addEventListener('click', toggle);
    ['loadedmetadata', 'durationchange'].forEach((e) => video.addEventListener(e, () => { last = ''; marksKey = ''; }));
    let drag = false; const seekTo = (e) => { const d = dur(), r = scrub.getBoundingClientRect(); if (d && r.width) video.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * d; };
    scrub.addEventListener('pointerdown', (e) => { drag = true; try { scrub.setPointerCapture(e.pointerId); } catch {} seekTo(e); });
    scrub.addEventListener('pointermove', (e) => { if (drag) seekTo(e); });
    ['pointerup', 'pointercancel'].forEach((e) => scrub.addEventListener(e, () => (drag = false)));
    const jump = (dt) => { const d = dur(); video.currentTime = clamp((video.currentTime || 0) + dt, 0, d || Infinity); };
    scrub.addEventListener('keydown', (e) => { const dt = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5 }[e.key]; if (dt) { e.preventDefault(); e.stopPropagation(); jump(dt); } });
    // keyboard shortcuts: space/k play, arrows ±5 s, j/l ±10 s, m mute, f fullscreen (never while typing, or while a dialog is open)
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !document.contains(video) || document.querySelector('.modal:not([hidden])')) return;
      const t = e.target; if (t.closest && t.closest('input,textarea,select,[contenteditable]')) return;
      if (e.key === ' ' && t.closest && t.closest('button,a,[role=slider]')) return;
      const act = { ' ': toggle, k: toggle, ArrowLeft: () => jump(-5), ArrowRight: () => jump(5), j: () => jump(-10), l: () => jump(10), m: toggleMute, f: fullscreen }[e.key]; if (act) { e.preventDefault(); act(); }
    });
    update();
    return { update, marks };
  }

  // ---- cursor highlight, click ripples and auto-zoom ----
  const lastIdx = (arr, t, hint = 0) => { // index of the last entry with arr[i][0] <= t, or -1. Sequential playback hits the hint; seeks fall back to a binary search (B19: no scan of the whole track per frame)
    if (!arr.length || arr[0][0] > t) return -1;
    if (hint < arr.length && arr[hint][0] <= t && (hint + 1 === arr.length || arr[hint + 1][0] > t)) return hint;
    if (hint + 1 < arr.length && arr[hint + 1][0] <= t && (hint + 2 === arr.length || arr[hint + 2][0] > t)) return hint + 1;
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid][0] <= t) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const ZOOM = 1.8, LEAD = 0.25, HOLD = 1.5, RIPPLE = 0.6;

  function makeFx({ wrap, video, st }) {
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2'; wrap.appendChild(canvas);
    const g = canvas.getContext('2d');
    let track = null, ci = 0, ki = 0, size = '', lastDraw = '', z = 1, vz = 0, cx = 0.5, cy = 0.5, vcx = 0, vcy = 0, lastT = -1, lastNow = performance.now();
    const setTrack = (t) => { track = t && (t.cursor?.length || t.clicks?.length) ? { ...t, clicks: (t.clicks || []).map((c) => [c.t, c.x, c.y, c.button]), cursor: t.cursor || [], hasFeed: !t.windowSource } : null; };
    const invalidate = () => { lastDraw = ''; };
    // recorded fractions of the display -> fractions of the video frame (a custom area crops the display)
    const toFrame = (x, y) => { const c = track.crop; return c ? [(x - c.x) / c.w, (y - c.y) / c.h] : [x, y]; };
    // where the picture sits inside the wrapper (object-fit: contain leaves bars when the aspect ratios differ)
    function content(W, H) {
      const vw = video.videoWidth || 16, vh = video.videoHeight || 9, k = Math.min(W / vw, H / vh), w = vw * k, h = vh * k;
      return { x: (W - w) / 2, y: (H - h) / 2, w, h };
    }
    function cursorAt(t) {
      const a = track.cursor; ci = Math.max(0, lastIdx(a, t, ci)); if (!a.length) return null;
      const p = a[ci], q = a[ci + 1];
      if (!q || q[0] === p[0] || t < p[0]) return toFrame(p[1], p[2]);
      const k = clamp((t - p[0]) / (q[0] - p[0]), 0, 1); // interpolate between the 60 Hz samples, so the ring is smooth at any display refresh rate
      return toFrame(p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k);
    }
    function frame(t) {
      const vm = st.vm, fxOn = vm.cursorFx !== false, zoomOn = !!vm.autoZoom;
      const W = wrap.clientWidth, H = wrap.clientHeight, now = performance.now(), dt = Math.min(0.05, (now - lastNow) / 1000); lastNow = now;
      const useful = track && track.hasFeed && (fxOn || zoomOn);
      if (!useful) { if (lastDraw !== 'off') { g.clearRect(0, 0, canvas.width, canvas.height); wrap.style.transform = ''; wrap.style.transition = ''; z = 1; lastDraw = 'off'; } return; }
      // zoom target: in while a click is near (a little before it, until 1.5 s after the last one), out otherwise
      ki = Math.max(0, lastIdx(track.clicks, t + LEAD, ki));
      const k = track.clicks[ki], active = zoomOn && k && k[0] <= t + LEAD && t - k[0] <= HOLD, cur = cursorAt(t);
      const tz = active ? ZOOM : 1;
      const jump = Math.abs(t - lastT) > 0.4; lastT = t;
      if (jump) { z = tz; vz = 0; if (cur) { cx = active ? cur[0] : 0.5; cy = active ? cur[1] : 0.5; } vcx = vcy = 0; }
      else { // critically damped spring: fast to arrive, no overshoot
        const kS = 140, d = 2 * Math.sqrt(kS), step = (cur0, v, target) => { const a = kS * (target - cur0) - d * v; v += a * dt; return [cur0 + v * dt, v]; };
        [z, vz] = step(z, vz, tz);
        if (active && cur) { [cx, vcx] = step(cx, vcx, cur[0]); [cy, vcy] = step(cy, vcy, cur[1]); } else { [cx, vcx] = step(cx, vcx, 0.5); [cy, vcy] = step(cy, vcy, 0.5); }
      }
      const settled = Math.abs(z - tz) < 0.002 && Math.abs(vz) < 0.01;
      const key = `${t.toFixed(3)}|${W}|${H}|${fxOn}|${zoomOn}|${z.toFixed(3)}|${cx.toFixed(3)}|${cy.toFixed(3)}`;
      if (video.paused && settled && key === lastDraw) return; // nothing moved: no work (B19)
      lastDraw = key;
      const sz = `${canvas.clientWidth}x${canvas.clientHeight}`;
      if (size !== sz) { const dpr = Math.min(2, devicePixelRatio || 1); canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0); size = sz; }
      // zoom: scale about the top-left corner, then slide so the focus point stays centred but the picture never leaves the frame
      if (zoomOn) {
        const c = content(W, H), fx0 = (c.x + cx * c.w) / W, fy0 = (c.y + cy * c.h) / H;
        const vx = clamp(fx0 - 0.5 / z, 0, 1 - 1 / z), vy = clamp(fy0 - 0.5 / z, 0, 1 - 1 / z);
        wrap.style.transition = 'none'; wrap.style.transformOrigin = '0 0'; wrap.style.transform = z > 1.001 ? `translate(${-vx * W * z}px,${-vy * H * z}px) scale(${z})` : '';
      } else { wrap.style.transform = ''; wrap.style.transition = ''; }
      g.clearRect(0, 0, W, H);
      if (!fxOn) return;
      const c = content(W, H), at = (p) => [c.x + p[0] * c.w, c.y + p[1] * c.h], r = Math.max(14, c.w * 0.022);
      if (cur && cur[0] >= -0.02 && cur[0] <= 1.02 && cur[1] >= -0.02 && cur[1] <= 1.02) {
        const [px, py] = at(cur); g.beginPath(); g.arc(px, py, r, 0, 7); g.fillStyle = 'rgba(255,214,10,.26)'; g.fill(); g.lineWidth = 2.5; g.strokeStyle = 'rgba(255,214,10,.95)'; g.stroke();
      }
      for (let i = ki; i >= 0 && i > ki - 6; i--) { // click ripples: an expanding, fading ring for 0.6 s after each click
        const kk = track.clicks[i], age = t - kk[0]; if (age < 0 || age > RIPPLE) continue;
        const [px, py] = at(toFrame(kk[1], kk[2])), p = age / RIPPLE;
        g.beginPath(); g.arc(px, py, r * (0.6 + p * 2.2), 0, 7); g.lineWidth = 3 * (1 - p) + 0.5; g.strokeStyle = `rgba(255,255,255,${(0.9 * (1 - p)).toFixed(3)})`; g.stroke();
      }
    }
    return { setTrack, invalidate, frame };
  }
  window.SP = { selectMenu, $, fmt, esc, api, viewer, setViewer, vars, fill, gateUI, attach, LANGS, CAPTION_STYLES, BACKGROUNDS };
})();
