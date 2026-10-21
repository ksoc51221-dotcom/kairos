// "Describe an edit": the owner types what to cut ("remove the first 10 seconds"), Kairos proposes REVIEWABLE cuts, and only the ones the owner ticks are
// added to the edit draft. The server route (POST /api/videos/:id/edits/describe) never changes the video or the draft; this component is the review step.
//
//   EditPrompt.mount(host, { videoId, api, getDuration(), getDraft(), saveDraft(cuts) -> Promise, seek(t), icon(name), esc, fmt, toast, onSaved() })
//
// saveDraft receives the WHOLE new cut list (the cuts already in the draft + the accepted proposals). Every string from the server goes through esc().
// The state lives per video outside the DOM, so the panel being redrawn (a status change, a new comment) does not lose the text or the results.
(() => {
  const MAX = 500;
  const EXAMPLES = ['Cut the first 10 seconds', 'Remove the silences', 'Remove filler words', 'Cut the part where I talk about pricing'];
  const states = new Map();
  const stateOf = (id) => { if (!states.has(id)) states.set(id, { open: false, text: '', busy: false, res: null, err: null, picked: new Set(), prev: -1, saving: false, dur: 0, paint: null, run: 0 }); return states.get(id); };

  const esc0 = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt0 = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const r1 = (x) => Math.round(x * 10) / 10;
  // 0:12 or 0:12.4 (a cut can start between two seconds)
  const ts = (t) => { t = Math.max(0, r1(+t || 0)); const w = Math.floor(t), f = Math.round((t - w) * 10); return `${Math.floor(w / 60)}:${String(w % 60).padStart(2, '0')}${f ? '.' + f : ''}`; };
  const near = (a, b) => Math.abs(a - b) < 0.05;
  // total length of the union of some ranges (two overlapping cuts remove the shared part once)
  const unionLen = (list) => { const s = list.map((p) => [p.start, p.end]).sort((a, b) => a[0] - b[0]); let tot = 0, cs = null, ce = null; for (const [a, b] of s) { if (ce === null || a > ce) { if (ce !== null) tot += ce - cs; cs = a; ce = b; } else ce = Math.max(ce, b); } return ce === null ? 0 : tot + (ce - cs); };
  const isTimeLabel = (l) => /^[\d:.\s]+(to|-|–)\s*[\d:.\s]+$/.test(l);

  // keep only well-formed proposals; anything else from the server is dropped
  const clean = (res) => (Array.isArray(res?.proposals) ? res.proposals : []).map((p) => ({
    start: +p.start, end: +p.end, kind: p.kind === 'silence' || p.kind === 'filler' ? p.kind : 'prompt', label: String(p.label ?? ''), reason: String(p.reason ?? ''), source: p.source === 'model' ? 'model' : 'rule',
  })).filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start);

  function errOf(e) {
    const s = e && e.status, m = String((e && e.message) || '');
    if (s === 409) return { tone: 'warn', msg: m || 'This video is busy right now. Try again in a moment.' };
    if (s === 400) return { tone: 'bad', msg: m || 'Describe the change in 1 to 500 characters.' };
    if (s === 502) return { tone: 'warn', msg: m || 'The local model is not available. Time-based cuts such as "remove the first 10 seconds" still work without it.' };
    if (s === 429) return { tone: 'warn', msg: 'That was a lot of requests in a row. Wait a few seconds and try again.' };
    if (!s) return { tone: 'bad', msg: 'Could not reach Kairos. Check that the app is still running, then try again.' };
    return { tone: 'bad', msg: m || 'Something went wrong. Try again.' };
  }

  function mount(host, o) {
    const E = o.esc || esc0, F = o.fmt || fmt0, I = o.icon || (() => ''), st = stateOf(o.videoId);
    if (st.res && Math.abs(st.dur - (o.getDuration() || 0)) > 0.05) { st.res = null; st.err = null; st.picked = new Set(); st.prev = -1; } // the video changed under the proposals
    st.paint = paint; // the newest mount repaints when a late answer arrives
    const props = () => (st.res ? st.res.list : []);
    const chosen = () => props().filter((_, i) => st.picked.has(i));
    const callout = (tone, msg) => `<div class="callout ${tone === 'bad' ? 'bad' : tone === 'warn' ? 'warn' : ''}" role="${tone === 'bad' ? 'alert' : 'status'}">${I(tone === 'bad' ? 'alert-triangle' : tone === 'warn' ? 'alert-triangle' : 'info')}<span>${E(msg)}</span></div>`;

    function resultHTML() {
      if (st.busy) return `<p class="meta ep-status" role="status"><span class="ep-spin"></span>Reading your request and the video...</p>`;
      if (st.err) return callout(st.err.tone, st.err.msg);
      const r = st.res; if (!r) return '';
      if (!r.understood || !r.list.length) return callout('info', r.message || 'I did not find anything to cut for that. Try one of the examples above.');
      const ps = r.list, sel = chosen(), removed = unionLen(sel), dur = o.getDuration() || 0, left = Math.max(0, dur - removed);
      const draftN = (o.getDraft() || []).length;
      return `${r.summary ? `<p class="ep-says">${E(r.summary)}</p>` : ''}
        <div class="ep-sum" aria-live="polite"><b>${sel.length} ${sel.length === 1 ? 'cut' : 'cuts'}</b><span class="sl">/</span><span>${r1(removed)} s removed</span>${dur ? `<span class="sl">/</span><span>${F(Math.round(dur))} &rarr; ${F(Math.round(left))}</span>` : ''}</div>
        ${r.notes.length ? `<ul class="ep-notes">${r.notes.map((n) => `<li>${callout('info', n)}</li>`).join('')}</ul>` : ''}
        <ul class="ep-list">${ps.map((p, i) => `<li class="ep-item ${st.picked.has(i) ? '' : 'off'} ${st.prev === i ? 'on' : ''}">
          <input type="checkbox" class="ep-ck" id="ep-c${i}" data-i="${i}" ${st.picked.has(i) ? 'checked' : ''}>
          <label class="ep-body" for="ep-c${i}"><span class="ep-top"><span class="tstamp">${ts(p.start)} - ${ts(p.end)}</span>${p.label && !isTimeLabel(p.label) ? `<span class="ep-name">${E(p.label)}</span>` : ''}${p.kind === 'silence' ? '<span class="badge">Silence</span>' : p.kind === 'filler' ? '<span class="badge">Filler</span>' : ''}${p.source === 'model' ? '<span class="badge">From the transcript</span>' : ''}</span>${p.reason ? `<span class="ep-why">${E(p.reason)}</span>` : ''}</label>
          <button type="button" class="btn sm ep-prev" data-i="${i}" title="Play from 1 second before this cut">${I('play')}<span>Preview</span></button></li>`).join('')}</ul>
        <div class="ep-act"><div><button type="button" class="btn ghost sm ep-all">Select all</button><button type="button" class="btn ghost sm ep-none">Select none</button></div>
          <div><button type="button" class="btn ghost sm ep-discard">Discard</button><button type="button" class="btn pri ep-add" ${sel.length && !st.saving ? '' : 'disabled'}>${st.saving ? '<span class="ep-spin"></span>Adding...' : `Add ${sel.length} ${sel.length === 1 ? 'cut' : 'cuts'} to the draft`}</button></div></div>
        <p class="ep-foot">Nothing changes in the video until you press Apply edits.${draftN ? ` Your draft already has ${draftN} ${draftN === 1 ? 'cut' : 'cuts'}; these are added to them.` : ''}</p>`;
    }

    function paint() {
      const had = host.querySelector('.ep-ta') && document.activeElement === host.querySelector('.ep-ta');
      if (!st.open) {
        host.innerHTML = `<div class="ep"><button type="button" class="btn pri ep-open">${I('scissors')}<span>Describe an edit</span></button><p class="ep-hint">Say what to cut in your own words. You review every cut before it is added.</p></div>`;
      } else {
        const len = st.text.length;
        host.innerHTML = `<div class="ep"><div class="card pad ep-card">
          <div class="ep-head"><span class="tag">Describe an edit</span><button type="button" class="iconbtn ep-close" title="Close" aria-label="Close">${I('x')}</button></div>
          <textarea class="field ep-ta" rows="3" maxlength="${MAX}" aria-label="Describe the edit" placeholder="Describe a cut. For example &quot;remove the first 10 seconds&quot;" ${st.busy ? 'readonly' : ''}>${E(st.text)}</textarea>
          <div class="ep-chips" role="group" aria-label="Examples">${EXAMPLES.map((x) => `<button type="button" class="ep-chip" data-ex="${E(x)}">${E(x)}</button>`).join('')}</div>
          <div class="ep-bar"><span class="meta ep-count">${len}/${MAX}</span><button type="button" class="btn pri ep-find" ${st.busy || !st.text.trim() ? 'disabled' : ''}>${st.busy ? '<span class="ep-spin"></span>Finding cuts...' : `${I('sparkle')}<span>Find cuts</span>`}</button></div>
          <div class="ep-res" aria-live="polite">${resultHTML()}</div></div></div>`;
        if (had) { const ta = host.querySelector('.ep-ta'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      }
    }
    // after a tick box or a preview only the results change, so the text box keeps focus and its caret
    function paintRes() { const r = host.querySelector('.ep-res'); if (r) r.innerHTML = resultHTML(); else paint(); }

    async function find() {
      const text = st.text.trim(); if (!text || st.busy) return;
      const run = ++st.run; st.busy = true; st.err = null; st.res = null; st.prev = -1; paint();
      try {
        const r = await o.api(`/api/videos/${o.videoId}/edits/describe`, { body: { text } });
        if (run !== st.run) return;
        const list = clean(r);
        st.res = { understood: !!(r && r.understood) && list.length > 0, list, message: String((r && r.message) || ''), summary: String((r && r.understood && r.summary) || ''), notes: (Array.isArray(r?.notes) ? r.notes : []).map(String).slice(0, 6) };
        st.picked = new Set(list.map((_, i) => i)); st.dur = o.getDuration() || 0;
      } catch (e) { if (run !== st.run) return; st.err = errOf(e); }
      st.busy = false; if (st.paint) st.paint();
    }

    async function add() {
      const sel = chosen(), have = o.getDraft() || [];
      const fresh = sel.filter((p) => !have.some((c) => near(+c.start, p.start) && near(+c.end, p.end))); // the same cut twice would only clutter the draft
      if (!fresh.length) { o.toast('Those cuts are already in the draft.'); return; }
      st.saving = true; paintRes();
      try {
        await o.saveDraft([...have, ...fresh.map((p) => ({ start: p.start, end: p.end, kind: p.kind }))]);
        Object.assign(st, { open: false, text: '', res: null, err: null, picked: new Set(), prev: -1, saving: false });
        o.toast(`${fresh.length} ${fresh.length === 1 ? 'cut' : 'cuts'} added to the draft. Nothing changes until you apply them.`);
        if (st.paint) st.paint(); if (o.onSaved) o.onSaved();
      } catch (e) { st.saving = false; o.toast((e && e.message) || 'Could not save the cuts. Try again.'); if (st.paint) st.paint(); }
    }

    host.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || !host.contains(b)) return;
      if (b.classList.contains('ep-open')) { st.open = true; paint(); host.querySelector('.ep-ta')?.focus(); }
      else if (b.classList.contains('ep-close')) { st.open = false; paint(); }
      else if (b.classList.contains('ep-chip')) { st.text = b.dataset.ex.slice(0, MAX); paint(); const ta = host.querySelector('.ep-ta'); ta?.focus(); }
      else if (b.classList.contains('ep-find')) find();
      else if (b.classList.contains('ep-all')) { st.picked = new Set(props().map((_, i) => i)); paintRes(); }
      else if (b.classList.contains('ep-none')) { st.picked = new Set(); paintRes(); }
      else if (b.classList.contains('ep-discard')) { st.run++; Object.assign(st, { res: null, err: null, picked: new Set(), prev: -1, busy: false }); paint(); }
      else if (b.classList.contains('ep-add')) add();
      else if (b.classList.contains('ep-prev')) { const i = +b.dataset.i, p = props()[i]; if (p) { st.prev = i; o.seek(Math.max(0, p.start - 1)); paintRes(); } } // one second of lead-in, so you hear what is cut and what comes before it
    });
    host.addEventListener('change', (e) => {
      const c = e.target.closest('.ep-ck'); if (!c) return;
      const i = +c.dataset.i; if (c.checked) st.picked.add(i); else st.picked.delete(i); paintRes();
    });
    host.addEventListener('input', (e) => {
      const ta = e.target.closest('.ep-ta'); if (!ta) return;
      st.text = ta.value.slice(0, MAX);
      const f = host.querySelector('.ep-find'); if (f) f.disabled = st.busy || !st.text.trim();
      const c = host.querySelector('.ep-count'); if (c) c.textContent = `${st.text.length}/${MAX}`;
    });
    host.addEventListener('keydown', (e) => {
      if (!e.target.closest('.ep-ta')) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); find(); }
      else if (e.key === 'Escape' && !st.busy) { e.stopPropagation(); st.open = false; paint(); }
    });
    paint();
    return { open() { st.open = true; paint(); }, state: st };
  }

  window.EditPrompt = { mount };
})();
