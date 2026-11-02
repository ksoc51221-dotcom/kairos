// "Describe an edit", as a chat. The owner writes anything ("cut the silences and give me a better title", "what did I say about pricing?", "add music"), Kairos
// answers in a thread. What it can do comes back as REVIEWABLE cards (cuts, bleeps, a title / summary diff, chapters, a document to generate); what it cannot do
// comes back as an honest reply plus chips for the closest things that work. Sending is never blocked for what the message asks: only an empty box cannot be sent.
//
// The server (POST /api/videos/:id/chat, agents/edit-chat.js) never changes the video, the draft or the notes. Everything the owner ticks and applies goes through
// the endpoints that already existed: PUT edits (via saveDraft), POST redact/apply, PATCH the video, POST actions/:id. Every string from the server goes through esc().
//
//   EditPrompt.mount(host, { videoId, api, getDuration(), getDraft(), saveDraft(cuts) -> Promise, seek(t), icon(name), esc, fmt, toast,
//                            getVM?(), onSaved?(), onBleep?(), onVM?(vm), collapsible? })
//
// The thread lives per video in memory and in sessionStorage (in try/catch), so a redraw of the panel or a reload of the page keeps the conversation.
(() => {
  const MAX = 500, TURNS = 6, KEEP = 40;
  const EXAMPLES = [
    { icon: 'scissors', label: 'Cut', text: 'Cut the silences and filler words' },
    { icon: 'sparkle', label: 'Write', text: 'Write a better title and add chapters' },
    { icon: 'comment', label: 'Ask', text: 'What are the main points of this video?' },
    { icon: 'volume-off', label: 'Bleep', text: 'Bleep anything that sounds like a password' },
  ];
  const states = new Map();
  const stateOf = (id) => { if (!states.has(id)) states.set(id, { open: false, text: '', busy: false, thread: [], queue: [], seq: 0, run: 0, view: null, restored: false }); return states.get(id); };

  // ---------- pure helpers (also exported, so the tests can run them without a browser) ----------
  const esc0 = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const r1 = (x) => Math.round(x * 10) / 10;
  const ts = (t) => { t = Math.max(0, r1(+t || 0)); const w = Math.floor(t), f = Math.round((t - w) * 10); return `${Math.floor(w / 60)}:${String(w % 60).padStart(2, '0')}${f ? '.' + f : ''}`; };
  const mmss = (t) => { t = Math.max(0, Math.floor(+t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const near = (a, b) => Math.abs(a - b) < 0.05;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const unionLen = (list) => { const s = list.map((p) => [p.start, p.end]).sort((a, b) => a[0] - b[0]); let tot = 0, cs = null, ce = null; for (const [a, b] of s) { if (ce === null || a > ce) { if (ce !== null) tot += ce - cs; cs = a; ce = b; } else ce = Math.max(ce, b); } return ce === null ? 0 : tot + (ce - cs); };
  // The one rule about sending: a message with something in it can always be sent. No request is refused here; the assistant answers what it cannot do.
  const canSend = (text) => typeof text === 'string' && text.trim().length > 0;
  // [m:ss] in an (already escaped) reply becomes a button that seeks the player. Only digits reach the attribute, so nothing from the model can break out of it.
  const linkify = (escaped) => String(escaped).replace(/\[(\d{1,3}):([0-5]\d)\]/g, (_, a, b) => `<button type="button" class="ch-ts" data-act="seek" data-t="${+a * 60 + +b}" title="Play from ${+a}:${b}">${+a}:${b}</button>`);
  const isOpen = (c) => !c.cs || !c.cs.status || c.cs.status === 'open';
  const has = (set, i) => (set instanceof Set ? set.has(i) : Array.isArray(set) ? set.includes(i) : false);
  // the last turns, as the server wants them: what the owner said, and what the assistant said plus what it proposed
  function lastTurns(thread, n = TURNS) {
    return thread.filter((m) => !m.error && (m.role === 'user' || m.role === 'assistant')).map((m) => {
      if (m.role === 'user') return { role: 'user', text: m.text };
      const what = (m.cards || []).filter((c) => c.kind !== 'note').map((c) => ({ cuts: `${plural((c.proposals || []).length, 'cut')}`, bleeps: `${plural((c.proposals || []).length, 'bleep')}`, meta: [c.title && 'a title', c.summary && 'a summary'].filter(Boolean).join(' and '), chapters: 'chapters', doc: c.label }[c.kind] || '')).filter(Boolean);
      return { role: 'assistant', text: `${m.text}${what.length ? ` (Proposed: ${what.join(', ')}.)` : ''}`.slice(0, 400) };
    }).filter((m) => m.text).slice(-n);
  }

  function errOf(e) {
    const s = e && e.status, m = String((e && e.message) || '');
    if (s === 409) return m || 'This video is busy right now. Try again in a moment.';
    if (s === 400) return m || 'That message could not be sent. Check it and try again.';
    if (s === 429) return 'That was a lot of requests in a row. Wait a few seconds and try again.';
    if (!s) return 'Could not reach Kairos. Check that the app is still running, then try again.';
    return m || 'Something went wrong. Try again.';
  }

  // ---------- cards (pure: card + its UI state + env -> HTML) ----------
  // env: { E, I, dur, draftN, vm, primary }   primary = the one card whose Apply is the lime button (the newest open one)
  const callout = (env, tone, msg) => `<div class="callout ${tone === 'bad' ? 'bad' : tone === 'warn' ? 'warn' : ''}" role="${tone === 'bad' ? 'alert' : 'status'}">${env.I(tone === 'info' ? 'info' : 'alert-triangle')}<span>${env.E(msg)}</span></div>`;
  const doneRow = (env, label, msg) => `<section class="ch-card done"><header class="ch-ch"><span class="tag">${env.E(label)}</span></header><p class="ch-state">${env.E(msg)}</p></section>`;
  const actRow = (env, m, ci, { all = true, pri, label, disabled, saving, discard = true, extra = '' }) => `<div class="ch-act"><div>${all ? `<button type="button" class="btn ghost sm" data-act="all" data-m="${m}" data-c="${ci}">Select all</button><button type="button" class="btn ghost sm" data-act="none" data-m="${m}" data-c="${ci}">Select none</button>` : ''}${extra}</div>
    <div>${discard ? `<button type="button" class="btn ghost sm" data-act="discard" data-m="${m}" data-c="${ci}">Discard</button>` : ''}<button type="button" class="btn ${pri ? 'pri' : ''}" data-act="apply" data-m="${m}" data-c="${ci}" ${disabled || saving ? 'disabled' : ''}>${saving ? '<span class="ep-spin"></span>Working...' : env.E(label)}</button></div></div>`;
  const staleRow = (env, label) => doneRow(env, label, 'The video changed after this was proposed. Ask again to get fresh proposals.');

  function cardHTML(c, env, ids) {
    const { m, ci } = ids, E = env.E, cs = c.cs || {};
    if (c.kind === 'note') return `<div class="ch-note">${callout(env, c.tone, c.text)}</div>`;
    const key = `${m}-${ci}`, pri = env.primary === key;
    const label = { cuts: 'Cuts', bleeps: 'Bleep', meta: 'Title and summary', chapters: 'Chapters', doc: c.label || 'Document' }[c.kind] || 'Proposal';
    if (cs.status === 'applied') return doneRow(env, label, cs.msg || 'Applied.');
    if (cs.status === 'discarded') return doneRow(env, label, 'Discarded. Nothing changed.');
    if ((c.kind === 'cuts' || c.kind === 'bleeps') && c.dur && env.dur && Math.abs(c.dur - env.dur) > 0.05) return staleRow(env, label);
    const err = cs.err ? callout(env, 'bad', cs.err) : '';
    const notes = (c.notes && c.notes.length) ? `<ul class="ep-notes">${c.notes.map((n) => `<li>${callout(env, 'info', n)}</li>`).join('')}</ul>` : '';

    if (c.kind === 'cuts' || c.kind === 'bleeps') {
      const bleep = c.kind === 'bleeps', ps = c.proposals || [], sel = ps.filter((_, i) => has(cs.picked, i)), removed = unionLen(sel);
      const dur = env.dur || 0, vm = env.vm || {};
      const items = ps.map((p, i) => {
        const id = `${key}-${i}`, on = has(cs.picked, i);
        const badges = bleep ? (p.check ? '<span class="badge warn">Check this one</span>' : p.source === 'model' ? '<span class="badge">AI suggestion</span>' : '')
          : `${p.kind === 'silence' ? '<span class="badge">Silence</span>' : p.kind === 'filler' ? '<span class="badge">Filler</span>' : ''}${p.source === 'model' ? '<span class="badge">From the transcript</span>' : ''}`;
        return `<li class="ep-item ${on ? '' : 'off'}"><input type="checkbox" class="ep-ck" id="${id}" data-act="tick" data-m="${m}" data-c="${ci}" data-i="${i}" ${on ? 'checked' : ''}>
          <div class="ep-body"><span class="ep-top"><button type="button" class="tstamp ch-seek" data-act="seek" data-t="${Math.max(0, p.start - 1)}" title="Play from 1 second before this ${bleep ? 'part' : 'cut'}">${ts(p.start)} - ${ts(p.end)}</button>${badges}</span>
          <label for="${id}" class="ch-lab">${bleep && p.text ? `<span class="rp-quote">${E(p.text)}</span>` : ''}${p.reason ? `<span class="ep-why">${E(p.reason)}</span>` : (!bleep && p.label && !/^[\d:.\s]+(to|-|–)\s*[\d:.\s]+$/.test(p.label) ? `<span class="ep-why">${E(p.label)}</span>` : '')}</label></div></li>`;
      }).join('');
      const sum = bleep ? `<b>${plural(sel.length, 'part')}</b><span class="sl">/</span><span>${r1(removed)} s bleeped</span>`
        : `<b>${plural(sel.length, 'cut')}</b><span class="sl">/</span><span>${r1(removed)} s removed</span>${dur ? `<span class="sl">/</span><span>${mmss(dur)} &rarr; ${mmss(Math.max(0, dur - removed))}</span>` : ''}`;
      const warn = bleep ? `${vm.canUndo ? callout(env, 'warn', vm.undoKind === 'redact' ? 'Bleeping again makes your last bleep permanent: its unbleeped copy is deleted.' : 'You can undo one change at a time. Bleeping now makes your last edit permanent.') : ''}${callout(env, 'warn', 'Any public link is switched off while the sound is replaced, because that copy still has the old audio.')}` : '';
      const rewrite = bleep && vm.shareable ? `<label class="rp-opt"><input type="checkbox" data-act="rewrite" data-m="${m}" data-c="${ci}" ${cs.rewrite === false ? '' : 'checked'}><span><b>Rewrite the notes without those words</b><span class="ep-why">The summary, chapters and tasks are written again from the bleeped transcript.</span></span></label>` : '';
      const foot = bleep ? 'Nothing changes until you press Bleep. The picture and the length stay the same; only the sound is replaced by a short beep. The unbleeped copy is kept so you can undo.'
        : `Nothing changes in the video until you press Apply edits.${env.draftN ? ` Your draft already has ${plural(env.draftN, 'cut')}; these are added to them.` : ''}`;
      return `<section class="ch-card"><header class="ch-ch"><span class="tag">${label}</span><span class="meta">${plural(ps.length, bleep ? 'part' : 'cut')}</span></header>
        <div class="ep-sum" aria-live="polite">${sum}</div>${notes}<ul class="ep-list ch-list">${items}</ul>${warn}${rewrite}${err}
        ${actRow(env, m, ci, { pri, label: bleep ? `Bleep ${plural(sel.length, 'part')}` : `Add ${plural(sel.length, 'cut')} to the draft`, disabled: !sel.length, saving: cs.saving })}
        <p class="ep-foot">${E(foot)}</p></section>`;
    }

    if (c.kind === 'meta') {
      const rows = [['title', 'Title', c.title], ['summary', 'Summary', c.summary]].filter((r) => r[2]);
      const n = rows.filter((r) => has(cs.picked, r[0])).length;
      const body = rows.map(([k, name, d]) => `<li class="ep-item ${has(cs.picked, k) ? '' : 'off'}"><input type="checkbox" class="ep-ck" id="${key}-${k}" data-act="tick" data-m="${m}" data-c="${ci}" data-i="${k}" ${has(cs.picked, k) ? 'checked' : ''}>
        <div class="ep-body"><span class="ep-top"><span class="tag">${name}</span></span>
        ${d.current ? `<span class="ch-was" title="Now">${E(d.current)}</span>` : '<span class="ch-was none">Empty now</span>'}<label for="${key}-${k}" class="ch-new-t">${E(d.proposed)}</label></div></li>`).join('');
      return `<section class="ch-card"><header class="ch-ch"><span class="tag">${label}</span><span class="meta">${plural(rows.length, 'change')}</span></header>
        <ul class="ep-list ch-list">${body}</ul>${err}${actRow(env, m, ci, { all: false, pri, label: `Apply ${plural(n, 'change')}`, disabled: !n, saving: cs.saving })}
        <p class="ep-foot">The text is shown on the watch page. You can change it again at any time.</p></section>`;
    }

    if (c.kind === 'chapters') {
      const ps = c.proposed || [], cur = c.current || [];
      return `<section class="ch-card"><header class="ch-ch"><span class="tag">${label}</span><span class="meta">${plural(ps.length, 'chapter')}</span></header>${notes}
        <ul class="ep-list ch-list">${ps.map((p) => `<li class="ep-item"><div class="ep-body ch-chap"><button type="button" class="tstamp ch-seek" data-act="seek" data-t="${p.start}" title="Play from here">${ts(p.start)}</button><span class="ch-chap-t">${E(p.title)}</span></div></li>`).join('')}</ul>
        ${cur.length ? `<p class="ep-why">Replaces the ${plural(cur.length, 'chapter')} now on this video.</p>` : ''}${err}
        ${actRow(env, m, ci, { all: false, pri, label: 'Use these chapters', saving: cs.saving })}</section>`;
    }

    if (c.kind === 'doc') {
      const r = cs.result;
      if (r) return `<section class="ch-card"><header class="ch-ch"><span class="tag">${E(c.label)}</span><span class="meta">${r.cached ? 'Saved copy' : 'New'}</span></header>
        <pre class="ch-doc">${E(r.markdown)}</pre>${err}<div class="ch-act"><div></div><div><button type="button" class="btn sm" data-act="copy" data-m="${m}" data-c="${ci}">${env.I('copy')}<span>Copy</span></button></div></div></section>`;
      return `<section class="ch-card"><header class="ch-ch"><span class="tag">${E(c.label)}</span><span class="meta">${c.cached ? (c.cached.stale ? 'Saved copy, out of date' : 'Saved copy') : 'Not written yet'}</span></header>
        <p class="ep-why">${E(c.blurb || '')}</p>${err}
        <div class="ch-act"><div></div><div><button type="button" class="btn ${pri ? 'pri' : ''}" data-act="gen" data-m="${m}" data-c="${ci}" ${cs.saving ? 'disabled' : ''}>${cs.saving ? '<span class="ep-spin"></span>Writing...' : env.E(c.cached && !c.cached.stale ? 'Show it' : 'Generate')}</button></div></div></section>`;
    }
    return '';
  }

  function messageHTML(m, env, { last = false } = {}) {
    const E = env.E;
    if (m.role === 'user') return `<div class="ch-m user ${m.fresh ? 'ch-in' : ''}"><div class="ch-b">${E(m.text)}</div></div>`;
    if (m.error) return `<div class="ch-m bot err ${m.fresh ? 'ch-in' : ''}"><span class="ch-who">Kairos</span><div class="ch-b" role="alert">${E(m.error)}</div><div class="ch-chips"><button type="button" class="btn sm" data-act="retry" data-m="${m.id}">${env.I('undo')}<span>Retry</span></button></div></div>`;
    const cards = (m.cards || []).map((c, ci) => cardHTML(c, env, { m: m.id, ci })).join('');
    const chips = last && (m.chips || []).length ? `<div class="ch-chips" role="group" aria-label="Suggestions">${m.chips.map((c) => `<button type="button" class="ep-chip" data-act="chip" data-text="${E(c.text)}">${E(c.label)}</button>`).join('')}</div>` : '';
    return `<div class="ch-m bot ${m.fresh ? 'ch-in' : ''}"><span class="ch-who">Kairos</span>${m.text ? `<div class="ch-b">${linkify(E(m.text))}</div>` : ''}${cards}${chips}</div>`;
  }
  const typingHTML = () => '<div class="ch-m bot ch-in" role="status" aria-label="Kairos is thinking"><span class="ch-who">Kairos</span><span class="ch-typing"><i></i><i></i><i></i></span></div>';
  const emptyHTML = (env) => `<div class="ch-empty"><p class="tag">Ask for an edit, some text, or an answer</p><div class="ch-ex">${EXAMPLES.map((x) => `<button type="button" class="ep-chip ch-exb" data-act="chip" data-text="${env.E(x.text)}"><span class="meta">${env.E(x.label)}</span><span>${env.E(x.text)}</span></button>`).join('')}</div></div>`;

  // ---------- the component ----------
  const key = (id) => `kairos.chat.${id}`;
  function persist(id, st, dur) {
    try {
      const thread = st.thread.slice(-KEEP).map((m) => ({ ...m, fresh: false, cards: (m.cards || []).map((c) => ({ ...c, cs: c.cs ? { ...c.cs, picked: c.cs.picked ? [...c.cs.picked] : [], saving: false } : c.cs })) }));
      sessionStorage.setItem(key(id), JSON.stringify({ dur, seq: st.seq, thread }));
    } catch {}
  }
  function restore(id, st) {
    if (st.restored) return; st.restored = true;
    try {
      const j = JSON.parse(sessionStorage.getItem(key(id)) || 'null'); if (!j || !Array.isArray(j.thread)) return;
      st.seq = +j.seq || 0;
      st.thread = j.thread.filter((m) => m && (m.role === 'user' || m.role === 'assistant')).map((m) => ({ ...m, fresh: false, cards: (m.cards || []).map((c) => ({ ...c, cs: { ...(c.cs || {}), picked: new Set((c.cs && c.cs.picked) || []), saving: false } })) }));
      const last = st.thread[st.thread.length - 1];
      if (last && last.role === 'user') st.thread.push({ id: `m${++st.seq}`, role: 'assistant', text: '', error: 'That message was interrupted when the page reloaded.', retry: { text: last.text, hist: lastTurns(st.thread.slice(0, -1)) }, fresh: false });
    } catch {}
  }

  function mount(host, o) {
    const E = o.esc || esc0, I = o.icon || (() => ''), st = stateOf(o.videoId);
    restore(o.videoId, st);
    st.view = { paint, paintThread }; // the newest mount repaints when a late answer arrives
    const dur = () => o.getDuration() || 0;
    const envOf = () => {
      let primary = null; st.thread.forEach((m) => (m.cards || []).forEach((c, ci) => { if (c.kind !== 'note' && isOpen(c)) primary = `${m.id}-${ci}`; }));
      return { E, I, dur: dur(), draftN: (o.getDraft() || []).length, vm: o.getVM ? o.getVM() || {} : {}, primary };
    };
    const save = () => persist(o.videoId, st, dur());
    const find = (mid, ci) => { const m = st.thread.find((x) => x.id === mid); const c = m && m.cards && m.cards[+ci]; return c ? { m, c } : null; };

    function shell() {
      if (o.collapsible && !st.open) return `<div class="ep"><button type="button" class="btn ep-open" title="Say what to cut, write, bleep or answer in your own words. You review everything before it is applied.">${I('sparkle')}<span>Describe an edit</span>${st.thread.length ? `<span class="meta">${st.thread.filter((m) => m.role === 'user').length}</span>` : ''}</button></div>`;
      return `<div class="ep ch"><div class="ch-head"><span class="tag">Assistant</span><span class="ch-tools">${st.thread.length ? `<button type="button" class="btn ghost sm" data-act="clear" title="Start a new conversation about this video">New chat</button>` : ''}${o.collapsible ? `<button type="button" class="iconbtn" data-act="close" title="Close" aria-label="Close">${I('x')}</button>` : ''}</span></div>
        <div class="ch-thread" role="log" aria-label="Conversation" aria-live="polite"></div>
        <form class="ch-comp" autocomplete="off"><textarea class="field ch-ta" rows="1" maxlength="${MAX}" aria-label="Message" placeholder="Ask for an edit, a title, chapters, or a question">${E(st.text)}</textarea>
          <button type="submit" class="btn ch-send" aria-label="Send" title="Send (Enter)" ${canSend(st.text) ? '' : 'disabled'}>${I('send')}</button></form>
        <div class="ch-foot"><span class="meta nocase"><kbd>&crarr;</kbd> send <kbd>&#8679;&crarr;</kbd> new line</span><span class="meta ch-count" ${st.text.length > MAX - 80 ? '' : 'hidden'}>${st.text.length}/${MAX}</span></div></div>`;
    }
    function paint() {
      host.innerHTML = shell();
      const ta = host.querySelector('.ch-ta'); if (ta) { grow(ta); if (st.focus) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
      paintThread(true);
    }
    function grow(ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`; }
    function paintThread(toEnd) {
      const th = host.querySelector('.ch-thread'); if (!th) return;
      const env = envOf(), keep = th.scrollTop, atEnd = th.scrollHeight - th.scrollTop - th.clientHeight < 40;
      const last = st.thread.length - 1;
      th.innerHTML = (st.thread.length || st.busy || st.queue.length ? st.thread.map((m, i) => messageHTML(m, env, { last: i === last && !st.busy && !st.queue.length })).join('') + (st.busy || st.queue.length ? typingHTML() : '') : emptyHTML(env));
      st.thread.forEach((m) => (m.fresh = false));
      th.scrollTop = toEnd || atEnd ? th.scrollHeight : keep;
      const ct = host.querySelector('.ch-head .ch-tools'); // "New chat" appears with the first message
      if (ct && !!ct.querySelector('[data-act="clear"]') !== !!st.thread.length) paintHead();
    }
    function paintHead() { const h = host.querySelector('.ch-head'); if (!h) return; const n = document.createElement('div'); n.innerHTML = shell(); const nh = n.querySelector('.ch-head'); if (nh) h.innerHTML = nh.innerHTML; }
    function syncSend() {
      const ta = host.querySelector('.ch-ta'), b = host.querySelector('.ch-send'); if (!ta || !b) return;
      b.disabled = !canSend(ta.value);
      const c = host.querySelector('.ch-count'); if (c) { c.hidden = ta.value.length <= MAX - 80; c.textContent = `${ta.value.length}/${MAX}`; }
    }

    // ---------- sending ----------
    function push(m) { m.id = `m${++st.seq}`; m.fresh = true; st.thread.push(m); return m; }
    function send(text) {
      if (!canSend(text)) return;
      const t = text.trim().slice(0, MAX), hist = lastTurns(st.thread);
      push({ role: 'user', text: t }); st.text = ''; st.focus = true;
      st.queue.push({ text: t, hist });
      const ta = host.querySelector('.ch-ta'); if (ta) { ta.value = ''; grow(ta); }
      syncSend(); save(); paintThread(true); pump();
    }
    async function pump() {
      if (st.busy) return;
      const job = st.queue.shift(); if (!job) return;
      const run = st.run; st.busy = true; if (st.view) st.view.paintThread(true);
      let reply;
      try {
        const r = await o.api(`/api/videos/${o.videoId}/chat`, { body: { text: job.text, history: job.hist } });
        reply = replyOf(r);
      } catch (e) { reply = { role: 'assistant', text: '', error: errOf(e), retry: job }; }
      st.busy = false;
      if (run !== st.run) { if (st.queue.length) pump(); else if (st.view) st.view.paintThread(false); return; } // "New chat" was pressed while this was running
      push(reply); persist(o.videoId, st, dur()); if (st.view) st.view.paintThread(true);
      pump();
    }
    // keep only well-formed cards; anything else from the server is dropped
    function replyOf(r) {
      const d = dur(), cards = [];
      for (const c of Array.isArray(r && r.cards) ? r.cards : []) {
        if (!c || typeof c !== 'object') continue;
        if (c.kind === 'note') cards.push({ kind: 'note', tone: c.tone === 'warn' ? 'warn' : 'info', text: String(c.text ?? '') });
        else if (c.kind === 'cuts' || c.kind === 'bleeps') {
          const ps = (Array.isArray(c.proposals) ? c.proposals : []).map((p) => ({ start: +p.start, end: +p.end, kind: p.kind === 'silence' || p.kind === 'filler' ? p.kind : 'prompt', label: String(p.label ?? ''), reason: String(p.reason ?? ''), text: String(p.text ?? ''), source: p.source === 'model' ? 'model' : 'rule', check: p.check === true })).filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start);
          if (ps.length) cards.push({ kind: c.kind, proposals: ps, notes: strs(c.notes), dur: d, cs: { status: 'open', picked: new Set(ps.map((p, i) => (p.check ? -1 : i)).filter((i) => i >= 0)), rewrite: true } });
        } else if (c.kind === 'meta') {
          const f = (x) => (x && typeof x.proposed === 'string' && x.proposed ? { current: String(x.current ?? ''), proposed: x.proposed } : null);
          const title = f(c.title), summary = f(c.summary);
          if (title || summary) cards.push({ kind: 'meta', title, summary, cs: { status: 'open', picked: new Set([title && 'title', summary && 'summary'].filter(Boolean)) } });
        } else if (c.kind === 'chapters') {
          const ch = (a) => (Array.isArray(a) ? a : []).map((x) => ({ start: +x.start, title: String(x.title ?? '') })).filter((x) => Number.isFinite(x.start) && x.start >= 0 && x.title);
          const proposed = ch(c.proposed).filter((x) => !(d > 0 && x.start >= d)).sort((a, b) => a.start - b.start).filter((x, i, a) => !i || x.start !== a[i - 1].start); if (proposed.length) cards.push({ kind: 'chapters', proposed, current: ch(c.current), notes: strs(c.notes), cs: { status: 'open' } });
        } else if (c.kind === 'doc' && typeof c.id === 'string') cards.push({ kind: 'doc', id: c.id, label: String(c.label ?? c.id), blurb: String(c.blurb ?? ''), cached: c.cached && typeof c.cached === 'object' ? { at: +c.cached.at || 0, stale: !!c.cached.stale } : null, cs: { status: 'open' } });
      }
      const chips = (Array.isArray(r && r.suggestions) ? r.suggestions : []).filter((x) => x && typeof x.text === 'string' && typeof x.label === 'string' && x.text.length <= MAX).slice(0, 3).map((x) => ({ label: x.label, text: x.text }));
      return { role: 'assistant', text: String((r && r.reply) || ''), cards, chips };
    }
    const strs = (a) => (Array.isArray(a) ? a : []).map(String).slice(0, 6);

    // ---------- applying: only through the endpoints that already existed ----------
    const setBusy = (c, on, err) => { c.cs.saving = on; c.cs.err = err || null; };
    async function apply(m, c) {
      const cs = c.cs; if (cs.saving) return;
      const redraw = () => { save(); if (st.view) st.view.paintThread(false); };
      try {
        if (c.kind === 'cuts') {
          const sel = c.proposals.filter((_, i) => cs.picked.has(i)), have = o.getDraft() || [];
          const fresh = sel.filter((p) => !have.some((x) => near(+x.start, p.start) && near(+x.end, p.end))); // the same cut twice would only clutter the draft
          if (!fresh.length) { cs.status = 'applied'; cs.msg = 'Those cuts are already in the draft.'; return redraw(); }
          setBusy(c, true); redraw();
          await o.saveDraft([...have, ...fresh.map((p) => ({ start: p.start, end: p.end, kind: p.kind }))]);
          cs.status = 'applied'; cs.msg = `Added ${plural(fresh.length, 'cut')} to the draft. Nothing changes until you press Apply edits.`; setBusy(c, false);
          redraw(); if (o.onSaved) o.onSaved();
        } else if (c.kind === 'bleeps') {
          const sel = c.proposals.filter((_, i) => cs.picked.has(i)); if (!sel.length) return;
          setBusy(c, true); redraw();
          await o.api(`/api/videos/${o.videoId}/redact/apply`, { body: { ranges: sel.map((p) => ({ from: Math.round(p.start * 100) / 100, to: Math.round(p.end * 100) / 100 })), rewriteNotes: cs.rewrite !== false } });
          cs.status = 'applied'; cs.msg = `Bleeping ${plural(sel.length, 'part')}. The picture is not touched, so this is quick. You can undo it once.`; setBusy(c, false);
          st.thread.forEach((x) => (x.cards || []).forEach((k) => { if (k !== c && k.kind === 'bleeps' && isOpen(k)) k.cs.status = 'discarded'; })); // the sound under those proposals just changed
          redraw(); if (o.onBleep) o.onBleep({ stage: 'Bleeping speech', editError: null });
        } else if (c.kind === 'meta') {
          const body = {}; if (c.title && cs.picked.has('title')) body.title = c.title.proposed; if (c.summary && cs.picked.has('summary')) body.summary = c.summary.proposed;
          if (!Object.keys(body).length) return;
          setBusy(c, true); redraw();
          const nv = await o.api(`/api/videos/${o.videoId}`, { method: 'PATCH', body });
          cs.status = 'applied'; cs.msg = `Saved ${Object.keys(body).map((k) => (k === 'title' ? 'the title' : 'the summary')).join(' and ')}.`; setBusy(c, false);
          redraw(); if (o.onVM) o.onVM(nv);
        } else if (c.kind === 'chapters') {
          setBusy(c, true); redraw();
          const nv = await o.api(`/api/videos/${o.videoId}`, { method: 'PATCH', body: { chapters: c.proposed.map((x) => ({ start: x.start, title: x.title })) } });
          cs.status = 'applied'; cs.msg = `Saved ${plural(c.proposed.length, 'chapter')}.`; setBusy(c, false);
          redraw(); if (o.onVM) o.onVM(nv);
        } else if (c.kind === 'doc') {
          setBusy(c, true); redraw();
          const r = await o.api(`/api/videos/${o.videoId}/actions/${encodeURIComponent(c.id)}`, { body: {} });
          cs.result = { markdown: String((r && r.markdown) || '').slice(0, 20000), cached: !!(r && r.cached) }; setBusy(c, false); redraw();
        }
      } catch (e) { setBusy(c, false, errOf(e)); redraw(); }
    }

    // ---------- events ----------
    host.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]'); if (!b || !host.contains(b) || b.tagName === 'INPUT') return;
      const a = b.dataset.act, hit = () => find(b.dataset.m, b.dataset.c);
      if (a === 'chip') send(b.dataset.text || '');
      else if (a === 'seek') { const t = +b.dataset.t; if (Number.isFinite(t) && o.seek) o.seek(t); }
      else if (a === 'retry') { const i = st.thread.findIndex((x) => x.id === b.dataset.m); const m = st.thread[i]; if (m && m.retry) { st.thread.splice(i, 1); st.queue.push(m.retry); save(); paintThread(true); pump(); } }
      else if (a === 'clear') { // an answer still on its way is dropped when it arrives (run no longer matches)
        st.run++; Object.assign(st, { thread: [], queue: [], text: '' }); save(); paint(); }
      else if (a === 'close') { st.open = false; paint(); }
      else if (a === 'all' || a === 'none') { const h = hit(); if (h) { h.c.cs.picked = a === 'all' ? new Set(h.c.proposals.map((_, i) => i)) : new Set(); save(); paintThread(false); } }
      else if (a === 'discard') { const h = hit(); if (h) { h.c.cs.status = 'discarded'; save(); paintThread(false); } }
      else if (a === 'apply' || a === 'gen') { const h = hit(); if (h) apply(h.m, h.c); }
      else if (a === 'copy') { const h = hit(); if (h && h.c.cs.result) { try { navigator.clipboard.writeText(h.c.cs.result.markdown).then(() => o.toast('Copied.')).catch(() => o.toast('Could not copy. Select the text and copy it.')); } catch { o.toast('Could not copy. Select the text and copy it.'); } } }
    });
    host.addEventListener('change', (ev) => {
      const c = ev.target; if (!(c instanceof HTMLInputElement)) return;
      const a = c.dataset.act; if (!a) return;
      const h = find(c.dataset.m, c.dataset.c); if (!h) return;
      if (a === 'tick') { const i = h.c.kind === 'meta' ? c.dataset.i : +c.dataset.i; if (c.checked) h.c.cs.picked.add(i); else h.c.cs.picked.delete(i); }
      else if (a === 'rewrite') h.c.cs.rewrite = c.checked;
      save(); paintThread(false);
    });
    host.addEventListener('input', (ev) => {
      const ta = ev.target.closest && ev.target.closest('.ch-ta'); if (!ta) return;
      st.text = ta.value.slice(0, MAX); grow(ta); syncSend();
    });
    host.addEventListener('keydown', (ev) => {
      const ta = ev.target.closest && ev.target.closest('.ch-ta'); if (!ta) return;
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(ta.value); }
      else if (ev.key === 'Escape' && o.collapsible) { ev.stopPropagation(); st.open = false; paint(); }
    });
    host.addEventListener('submit', (ev) => { ev.preventDefault(); const ta = host.querySelector('.ch-ta'); if (ta) send(ta.value); });
    host.addEventListener('focusin', (ev) => { if (ev.target.closest && ev.target.closest('.ch-ta')) st.focus = true; });
    host.addEventListener('focusout', (ev) => { if (ev.target.closest && ev.target.closest('.ch-ta')) st.focus = false; });

    host.addEventListener('click', (ev) => { // the collapsed button of the editor's dock
      if (ev.target.closest('.ep-open')) { st.open = true; st.focus = true; paint(); }
    });
    paint();
    if (st.queue.length && !st.busy) pump();
    return { open() { st.open = true; paint(); }, state: st };
  }

  const api = { mount, canSend, linkify, cardHTML, messageHTML, emptyHTML, typingHTML, lastTurns, esc: esc0, errOf, EXAMPLES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.EditPrompt = api;
})();
