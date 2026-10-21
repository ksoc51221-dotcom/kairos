// "Bleep speech": the owner says what to bleep in a sentence ("everything I said about my crush", "bleep after crush until I say school", "I missed my
// password around 1:23") or ticks sentences from the transcript. Kairos proposes REVIEWABLE parts and only the ones the owner ticks are bleeped. The describe
// route (POST /api/videos/:id/redact/describe) never changes anything; the bleep is a second, explicit step (POST .../redact/apply), so this component is the
// review step. It also shows the result of the last bleep, with Undo and "Delete the unbleeped copy".
//
//   RedactPrompt.mount(host, { videoId, api, getVM(), getDuration(), getTime(), seek(t), icon(name), esc, fmt, toast, onChange(vmOrPatch) })
//     -> { open(), addRange(from, to, text), state }
//
// onChange gets the new view model (after Undo or Delete) or a small patch ({ stage }) when a bleep was started; the page then redraws.
// The state lives per video outside the DOM, so the panel being redrawn (a status change, a new comment) does not lose the text or the proposals.
// Every string from the server goes through esc().
(() => {
  const MAX = 500, WIDER = 0.3, MAX_SHARE = 0.5, MIN_RANGE = 0.12, ROWS = 300; // MAX_SHARE and MIN_RANGE mirror the server's rules (it checks again)
  const EXAMPLES = ['Bleep everything after "crush" until I say "school"', 'Bleep everything I said about my crush', 'I missed my password around 1:23', 'Bleep every time I say "Daniel"'];
  const freshPick = () => ({ open: false, loading: false, list: null, approx: false, err: null, sel: new Set(), q: '' });
  const states = new Map();
  const stateOf = (id) => {
    if (!states.has(id)) states.set(id, { open: false, text: '', busy: false, res: null, err: null, applyErr: null, picked: new Set(), prev: '', saving: false, dur: 0, run: 0, seq: 0, sig: null,
      rewrite: true, confirmDel: false, pub: null, pubAt: 0, pick: freshPick(), paint: null, paintRes: null });
    return states.get(id);
  };

  const esc0 = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  // 0:12 or 0:12.4 (a bleep can start between two seconds)
  const ts = (t) => { t = Math.max(0, r1(+t || 0)); const w = Math.floor(t), f = Math.round((t - w) * 10); return `${Math.floor(w / 60)}:${String(w % 60).padStart(2, '0')}${f ? '.' + f : ''}`; };
  // total length of the union of some ranges (two overlapping parts are bleeped once)
  const unionLen = (list) => { const s = list.map((p) => [p.from, p.to]).sort((a, b) => a[0] - b[0]); let tot = 0, cs = null, ce = null; for (const [a, b] of s) { if (ce === null || a > ce) { if (ce !== null) tot += ce - cs; cs = a; ce = b; } else ce = Math.max(ce, b); } return ce === null ? 0 : tot + (ce - cs); };
  const overlap = (a, b) => Math.min(a.to, b.to) - Math.max(a.from, b.from);

  function errOf(e) {
    const s = e && e.status, m = String((e && e.message) || '');
    if (s === 409) return { tone: 'warn', msg: m || 'This video is busy right now. Try again in a moment.' };
    if (s === 400) return { tone: 'bad', msg: m || 'That could not be bleeped. Check the parts and try again.' };
    if (s === 429) return { tone: 'warn', msg: 'That was a lot of requests in a row. Wait a few seconds and try again.' };
    if (!s) return { tone: 'bad', msg: 'Could not reach Kairos. Check that the app is still running, then try again.' };
    return { tone: 'bad', msg: m || 'Something went wrong. Try again.' };
  }

  function mount(host, o) {
    const E = o.esc || esc0, I = o.icon || (() => ''), st = stateOf(o.videoId), vmNow = () => o.getVM() || {};
    const sigOf = (v) => `${v.redactResult ? v.redactResult.at : ''}|${v.undoKind || ''}|${(v.segments || []).length}`;
    // the video changed under the proposals (a bleep or an undo from somewhere else, an edit): what was proposed no longer fits it
    function sync() {
      if (st.sig !== null && (st.sig !== sigOf(vmNow()) || (st.res && Math.abs(st.dur - (o.getDuration() || 0)) > 0.05))) { st.res = null; st.err = null; st.applyErr = null; st.picked = new Set(); st.prev = ''; st.pick = freshPick(); st.confirmDel = false; }
      st.sig = sigOf(vmNow());
    }
    sync();
    st.paint = paint; st.paintRes = paintRes; // the newest mount repaints when a late answer arrives
    const props = () => (st.res ? st.res.list : []);
    const chosen = () => props().filter((p) => st.picked.has(p.key));
    const callout = (tone, msg) => `<div class="callout ${tone === 'bad' ? 'bad' : tone === 'warn' ? 'warn' : ''}" role="${tone === 'bad' ? 'alert' : 'status'}">${I(tone === 'info' ? 'info' : 'alert-triangle')}<span>${E(msg)}</span></div>`;
    const spin = (msg) => `<p class="meta nocase ep-status" role="status"><span class="ep-spin"></span>${E(msg)}</p>`;

    // keep only well-formed proposals; anything else from the server is dropped
    const clean = (res) => (Array.isArray(res?.proposals) ? res.proposals : []).map((p) => ({
      key: `p${++st.seq}`, from: +p.start, to: +p.end, text: String(p.text ?? ''), reason: String(p.reason ?? ''), source: p.source === 'model' ? 'model' : 'rule', check: p.check === true,
    })).filter((p) => Number.isFinite(p.from) && Number.isFinite(p.to) && p.to > p.from);
    // adds a part to the review (a sentence, a selection); false when it is already there
    function add(p) {
      if (!st.res || !st.res.understood) st.res = { understood: true, list: [], message: '', summary: '', notes: [], approx: false };
      const dur = o.getDuration() || Infinity, from = Math.max(0, r2(p.from)), to = Math.min(dur, r2(p.to));
      if (!(to - from >= MIN_RANGE)) return false;
      if (st.res.list.some((q) => overlap(q, { from, to }) >= 0.8 * Math.min(q.to - q.from, to - from))) return false;
      const item = { key: `p${++st.seq}`, from, to, text: String(p.text ?? ''), reason: String(p.reason ?? ''), source: p.source || 'pick' };
      st.res.list.push(item); st.res.list.sort((a, b) => a.from - b.from); st.picked.add(item.key); st.dur = o.getDuration() || 0; st.err = null;
      return true;
    }
    function loadPub() { // is there a public link that bleeping would switch off? Asked once in a while, never blocks anything
      if (Date.now() - st.pubAt < 20000) return; st.pubAt = Date.now();
      o.api(`/api/videos/${o.videoId}/publish`).then((p) => { st.pub = { state: String((p && p.state) || '') }; if (st.paintRes) st.paintRes(); }).catch(() => { st.pub = null; });
    }

    // ---------- the result of the last bleep, and Undo ----------
    function doneHTML(vm) {
      const r = vm.redactResult; if (vm.undoKind !== 'redact' || !r) return '';
      const pc = r.publicCopy, parts = +r.parts || 0;
      const link = !pc ? '' : pc.pending
        ? `The public link no longer works, but the uploaded copy is not deleted yet${pc.error ? ` (${E(pc.error)})` : ''}. Open Share to finish removing it.`
        : 'The public link was switched off, because that copy still had the old audio. Publish again to share the bleeped version.';
      return `<div class="card pad flat sunk rp-done" role="status">
        <div class="rp-done-h">${I('check-circle')}<b>${parts ? `${plural(parts, 'part')} of the audio ${parts === 1 ? 'was' : 'were'} bleeped.` : 'The audio was bleeped.'}</b></div>
        <ul class="rp-facts">
          <li>The picture and the length did not change. Those words are gone from the transcript, the captions and the notes.</li>
          ${link ? `<li>${link}</li>` : ''}
          <li>The unbleeped copy and the old transcript are still on this Mac so you can undo. Delete them when you are sure.</li>
          ${vm.hasOriginal ? '<li>Your kept original recording (Settings, Keep the unblurred original) still has the old audio. Bleeping does not touch it.</li>' : ''}
          <li>Copies you already downloaded or sent somewhere else are not changed.</li>
        </ul>
        ${st.confirmDel
    ? `${callout('warn', 'Delete the unbleeped video and the old transcript for good? You will not be able to undo this bleep.')}
          <div class="ep-act"><span></span><div><button type="button" class="btn ghost sm rp-del-no">Keep it</button><button type="button" class="btn danger pri sm rp-del-yes" ${st.saving ? 'disabled' : ''}>${st.saving ? '<span class="ep-spin"></span>Deleting...' : 'Delete for good'}</button></div></div>`
    : `<div class="ep-act"><div><button type="button" class="btn sm rp-undo" ${st.saving ? 'disabled' : ''}>${I('undo')}<span>Undo the bleep</span></button></div><div><button type="button" class="btn danger sm rp-del">${I('trash')}<span>Delete the unbleeped copy</span></button></div></div>`}
        ${st.applyErr ? callout(st.applyErr.tone, st.applyErr.msg) : ''}</div>`;
    }

    // ---------- the review ----------
    function itemHTML(p) {
      const k = E(p.key);
      return `<li class="ep-item ${st.picked.has(p.key) ? '' : 'off'} ${st.prev === p.key ? 'on' : ''}">
        <input type="checkbox" class="ep-ck rp-ck" id="rp-c-${k}" data-k="${k}" ${st.picked.has(p.key) ? 'checked' : ''}>
        <label class="ep-body" for="rp-c-${k}"><span class="ep-top"><span class="tstamp">${ts(p.from)} - ${ts(p.to)}</span>${p.check ? '<span class="badge warn">Check this one</span>' : p.source === 'model' ? '<span class="badge">AI suggestion</span>' : ''}</span>${p.text ? `<span class="rp-quote">${E(p.text)}</span>` : ''}${p.reason ? `<span class="ep-why">${E(p.reason)}</span>` : ''}</label>
        <span class="rp-tools"><button type="button" class="btn sm rp-prev" data-k="${k}" title="Play from 1 second before this part">${I('play')}<span>Preview</span></button><button type="button" class="btn ghost sm rp-wider" data-k="${k}" title="Bleep a little more on each side">Wider</button></span></li>`;
    }
    function resultHTML() {
      if (st.busy) return spin('Reading your request and the transcript...');
      if (st.err) return callout(st.err.tone, st.err.msg);
      const r = st.res; if (!r) return '';
      if (!r.understood || !r.list.length) return callout('info', r.message || 'I did not find anything to bleep for that. Try one of the examples above, or pick sentences.');
      const vm = vmNow(), dur = o.getDuration() || 0, sel = chosen(), secs = unionLen(sel), over = dur > 0 && secs > dur * MAX_SHARE;
      const pubLive = st.pub && (st.pub.state === 'live' || st.pub.state === 'working');
      return `${r.summary ? `<p class="ep-says">${E(r.summary)}</p>` : ''}
        <div class="ep-sum" aria-live="polite"><b>${plural(sel.length, 'part')}</b><span class="sl">/</span><span>${r1(secs)} s bleeped</span>${dur ? `<span class="sl">/</span><span>${Math.round((secs / dur) * 100)}% of the video</span>` : ''}</div>
        ${r.notes.length ? `<ul class="ep-notes">${r.notes.map((n) => `<li>${callout('info', n)}</li>`).join('')}</ul>` : ''}
        ${r.approx && !vm.words ? '<div class="ep-act"><span class="ep-why">The times are estimates until every word is timed.</span><button type="button" class="btn sm rp-words">Time every word</button></div>' : ''}
        <ul class="ep-list">${r.list.map(itemHTML).join('')}</ul>
        ${vm.shareable ? `<label class="rp-opt"><input type="checkbox" class="rp-rewrite" ${st.rewrite ? 'checked' : ''}><span><b>Rewrite the notes without those words</b><span class="ep-why">The summary, chapters and tasks are written again from the bleeped transcript. It takes a minute on this Mac. The words are removed from the current notes either way.</span></span></label>` : ''}
        ${over ? callout('bad', 'That is more than half of the video. Untick some parts, or cut the video instead.') : ''}
        ${pubLive ? callout('warn', 'This video has a public link. Bleeping switches it off, because that copy still has the old audio. You can publish again afterwards.') : ''}
        ${vm.canUndo ? callout('warn', vm.undoKind === 'redact' ? 'Bleeping again makes your last bleep permanent: its unbleeped copy is deleted.' : 'You can undo one change at a time. Bleeping now makes your last edit permanent.') : ''}
        ${vm.hasOriginal ? callout('info', 'A kept original recording of this video still has the old audio (Settings, Keep the unblurred original). Bleeping does not change it.') : ''}
        ${st.applyErr ? callout(st.applyErr.tone, st.applyErr.msg) : ''}
        <div class="ep-act"><div><button type="button" class="btn ghost sm rp-all">Select all</button><button type="button" class="btn ghost sm rp-none">Select none</button></div>
          <div><button type="button" class="btn ghost sm rp-discard">Discard</button><button type="button" class="btn pri rp-go" ${sel.length && !st.saving && !over ? '' : 'disabled'}>${st.saving ? '<span class="ep-spin"></span>Starting...' : `${I('volume-off')}<span>Bleep ${plural(sel.length, 'part')}</span>`}</button></div></div>
        <p class="ep-foot">Nothing changes until you press Bleep. The picture and the length stay the same; only the sound is replaced by a short beep. The unbleeped copy is kept so you can undo.${st.pub ? '' : ' If this video has a public link, it is switched off.'}</p>`;
    }

    // ---------- picking sentences from the transcript ----------
    function sentsHTML() {
      const pk = st.pick, q = pk.q.trim().toLowerCase(), all = pk.list.filter((s) => !q || s.text.toLowerCase().includes(q)), rows = all.slice(0, ROWS);
      if (!rows.length) return `<p class="ep-why">${q ? 'No sentence has that in it.' : 'Every sentence is already bleeped.'}</p>`;
      return `<ul class="ep-list rp-sents">${rows.map((s) => `<li class="ep-item ${pk.sel.has(s.id) ? 'on' : ''}">
          <input type="checkbox" class="ep-ck rp-sck" id="rp-s-${E(s.id)}" data-id="${E(s.id)}" ${pk.sel.has(s.id) ? 'checked' : ''}>
          <label class="ep-body" for="rp-s-${E(s.id)}"><span class="ep-top"><span class="tstamp">${ts(s.start)} - ${ts(s.end)}</span></span><span class="rp-quote">${E(s.text)}</span></label>
          <span class="rp-tools"><button type="button" class="btn sm rp-sprev" data-t="${s.start}" title="Play from just before this sentence">${I('play')}<span>Preview</span></button></span></li>`).join('')}</ul>
        ${all.length > ROWS ? `<p class="ep-why">Showing the first ${ROWS} of ${all.length}. Search to narrow it down.</p>` : ''}
        <div class="ep-act"><span class="meta nocase">${pk.sel.size} selected</span><button type="button" class="btn rp-sadd" ${pk.sel.size ? '' : 'disabled'}>Add ${plural(pk.sel.size, 'sentence')} to the review</button></div>`;
    }
    function pickHTML() {
      const pk = st.pick;
      const toggle = `<button type="button" class="btn ghost sm rp-pick-toggle" aria-expanded="${pk.open}">${I(pk.open ? 'up' : 'down')}<span>${pk.open ? 'Hide the sentences' : 'Or pick sentences from the transcript'}</span></button>`;
      if (!pk.open) return toggle;
      if (pk.loading) return `${toggle}${spin('Loading the transcript...')}`;
      if (pk.err) return `${toggle}${callout(pk.err.tone, pk.err.msg)}`;
      if (!pk.list || !pk.list.length) return `${toggle}${callout('info', 'This video has no transcript to pick from.')}`;
      return `${toggle}${pk.approx && !vmNow().words ? callout('info', 'This transcript has no word timing, so the times are estimates and a bleep may cover a little more than the sentence.') : ''}
        <input type="search" class="field sm rp-q" placeholder="Search the transcript" aria-label="Search the transcript" value="${E(pk.q)}" maxlength="80">
        <div class="rp-sbox">${sentsHTML()}</div>`;
    }

    // ---------- the panel ----------
    function composerHTML() {
      if (!st.open) return `<button type="button" class="btn ep-open rp-open">${I('volume-off')}<span>Bleep speech</span></button><p class="ep-hint">Hide a sentence, a topic or a moment in the sound. You review every bleep before it is made.</p>`;
      const len = st.text.length;
      return `<div class="card pad ep-card">
        <div class="ep-head"><span class="tag">Bleep speech</span><button type="button" class="iconbtn rp-close" title="Close" aria-label="Close">${I('x')}</button></div>
        <textarea class="field ep-ta rp-ta" rows="3" maxlength="${MAX}" aria-label="Describe what to bleep" placeholder="Say what to bleep. For example &quot;everything I said about my crush&quot;" ${st.busy ? 'readonly' : ''}>${E(st.text)}</textarea>
        <div class="ep-chips" role="group" aria-label="Examples">${EXAMPLES.map((x) => `<button type="button" class="ep-chip rp-chip" data-ex="${E(x)}">${E(x)}</button>`).join('')}</div>
        <div class="ep-bar"><span class="meta ep-count">${len}/${MAX}</span><button type="button" class="btn pri rp-find" ${st.busy || !st.text.trim() ? 'disabled' : ''}>${st.busy ? '<span class="ep-spin"></span>Finding...' : `${I('sparkle')}<span>Find what to bleep</span>`}</button></div>
        <div class="rp-pick">${pickHTML()}</div>
        <div class="ep-res rp-res" aria-live="polite">${resultHTML()}</div></div>`;
    }
    function paint() {
      const vm = vmNow(), stage = vm.stage || '', ta = host.querySelector('.rp-ta'), had = ta && document.activeElement === ta;
      let html;
      if (stage && stage !== 'done') { // a bleep, a rewrite of the notes, or any other job: the panel only tells the owner what is going on
        html = spin(/^Bleeping speech/.test(stage) ? 'Bleeping the audio. The picture is not touched, so this is quick.'
          : /^Re-running AI crew/.test(stage) ? 'The audio is bleeped. Writing the summary, chapters and tasks again from the bleeped transcript...' : 'This video is being processed. Bleeping opens when it is done.');
      } else html = `${/^Could not bleep/.test(vm.editError || '') ? callout('bad', vm.editError) : ''}${doneHTML(vm)}${composerHTML()}`;
      host.innerHTML = `<div class="ep rp">${html}</div>`;
      if (had) { const t = host.querySelector('.rp-ta'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
    }
    // after a tick box or a preview only the results change, so the text box keeps focus and its caret
    function paintRes() { const r = host.querySelector('.rp-res'); if (r) r.innerHTML = resultHTML(); else paint(); }
    function paintPick() { const p = host.querySelector('.rp-pick'); if (p) p.innerHTML = pickHTML(); else paint(); }
    function paintSents() { const b = host.querySelector('.rp-sbox'); if (b && st.pick.list) b.innerHTML = sentsHTML(); else paintPick(); }

    // ---------- doing things ----------
    async function find() {
      const text = st.text.trim(); if (!text || st.busy) return;
      const run = ++st.run; st.busy = true; st.err = null; st.applyErr = null; st.res = null; st.picked = new Set(); st.prev = ''; paint();
      try {
        const at = o.getTime ? +o.getTime() : NaN;
        const r = await o.api(`/api/videos/${o.videoId}/redact/describe`, { body: { text, ...(Number.isFinite(at) ? { at: r2(at) } : {}) } });
        if (run !== st.run) return;
        const list = clean(r);
        st.res = { understood: !!(r && r.understood) && list.length > 0, list, message: String((r && r.message) || ''), summary: String((r && r.understood && r.summary) || ''), notes: (Array.isArray(r?.notes) ? r.notes : []).map(String).slice(0, 6), approx: !!(r && r.approx) };
        st.picked = new Set(list.filter((p) => !p.check).map((p) => p.key)); st.dur = o.getDuration() || 0; loadPub(); // a part the model added that does not use the owner's words starts unticked
      } catch (e) { if (run !== st.run) return; st.err = errOf(e); }
      st.busy = false; if (st.paint) st.paint();
    }
    async function apply() {
      const sel = chosen(), dur = o.getDuration() || 0;
      if (!sel.length || st.saving || (dur > 0 && unionLen(sel) > dur * MAX_SHARE)) return;
      st.saving = true; st.applyErr = null; paintRes();
      try {
        await o.api(`/api/videos/${o.videoId}/redact/apply`, { body: { ranges: sel.map((p) => ({ from: r2(p.from), to: r2(p.to) })), rewriteNotes: !!st.rewrite } });
        Object.assign(st, { open: false, text: '', res: null, err: null, applyErr: null, picked: new Set(), prev: '', saving: false, confirmDel: false, pick: freshPick(), pubAt: 0 });
        o.toast('Bleeping the audio...');
        if (o.onChange) o.onChange({ stage: 'Bleeping speech', editError: null }); else if (st.paint) st.paint();
      } catch (e) { st.saving = false; st.applyErr = errOf(e); if (st.paintRes) st.paintRes(); }
    }
    async function undo() {
      if (st.saving) return; st.saving = true; st.applyErr = null; paint();
      try {
        const nv = await o.api(`/api/videos/${o.videoId}/edits/undo`, { method: 'POST', body: {} });
        Object.assign(st, { saving: false, confirmDel: false, res: null, picked: new Set(), pick: freshPick() });
        o.toast('Bleep undone. The old audio, transcript and notes are back.');
        if (o.onChange) o.onChange(nv); else paint();
      } catch (e) { st.saving = false; st.applyErr = errOf(e); o.toast(st.applyErr.msg); paint(); }
    }
    async function finalize() {
      if (st.saving) return; st.saving = true; st.applyErr = null; paint();
      const kept = !!vmNow().hasOriginal;
      try {
        const nv = await o.api(`/api/videos/${o.videoId}/redact/finalize`, { method: 'POST', body: {} });
        Object.assign(st, { saving: false, confirmDel: false });
        o.toast(kept ? 'Deleted. Your kept original recording still has the old audio.' : 'Deleted. The bleep is final.');
        if (o.onChange) o.onChange(nv); else paint();
      } catch (e) { st.saving = false; st.applyErr = errOf(e); o.toast(st.applyErr.msg); paint(); }
    }
    async function openPick() {
      const pk = st.pick; pk.open = !pk.open;
      if (pk.open && !pk.list && !pk.loading) {
        pk.loading = true; pk.err = null; paintPick();
        try {
          const r = await o.api(`/api/videos/${o.videoId}/redact/sentences`);
          pk.list = (Array.isArray(r?.sentences) ? r.sentences : []).map((s) => ({ id: String(s.id), start: +s.start, end: +s.end, text: String(s.text ?? '') })).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
          pk.approx = !!(r && r.approx);
        } catch (e) { pk.err = errOf(e); }
        pk.loading = false;
      }
      if (st.paint) st.paint();
    }
    function addSentences() {
      const pk = st.pick, want = (pk.list || []).filter((s) => pk.sel.has(s.id)); if (!want.length) return;
      let n = 0; for (const s of want) if (add({ from: s.start, to: s.end, text: s.text, reason: 'A sentence you picked.', source: 'pick' })) n++;
      pk.sel = new Set(); pk.open = false; loadPub(); paint();
      if (n < want.length) o.toast(n ? 'Some of those were already in the list.' : 'Those are already in the list.');
    }

    const act = {
      'rp-open': () => { st.open = true; paint(); host.querySelector('.rp-ta')?.focus(); },
      'rp-close': () => { st.open = false; paint(); },
      'rp-chip': (b) => { st.text = b.dataset.ex.slice(0, MAX); paint(); host.querySelector('.rp-ta')?.focus(); },
      'rp-find': find,
      'rp-all': () => { st.picked = new Set(props().map((p) => p.key)); paintRes(); },
      'rp-none': () => { st.picked = new Set(); paintRes(); },
      'rp-discard': () => { st.run++; Object.assign(st, { res: null, err: null, applyErr: null, picked: new Set(), prev: '', busy: false }); paint(); },
      'rp-go': apply,
      'rp-prev': (b) => { const p = props().find((x) => x.key === b.dataset.k); if (p) { st.prev = p.key; o.seek(Math.max(0, p.from - 1)); paintRes(); } }, // one second of lead-in, so you hear what is bleeped and what comes before it
      'rp-wider': (b) => { const p = props().find((x) => x.key === b.dataset.k), dur = o.getDuration() || Infinity; if (p) { p.from = Math.max(0, r2(p.from - WIDER)); p.to = Math.min(dur, r2(p.to + WIDER)); paintRes(); } },
      'rp-words': async (b) => { b.disabled = true; try { await o.api(`/api/videos/${o.videoId}/words`, { method: 'POST', body: {} }); o.toast('Timing every word. This takes a few seconds.'); } catch (e) { b.disabled = false; o.toast((e && e.message) || 'Could not start that.'); } },
      'rp-pick-toggle': openPick,
      'rp-sprev': (b) => { const t = +b.dataset.t; if (Number.isFinite(t)) o.seek(Math.max(0, t - 0.5)); },
      'rp-sadd': addSentences,
      'rp-undo': undo,
      'rp-del': () => { st.confirmDel = true; paint(); },
      'rp-del-no': () => { st.confirmDel = false; paint(); },
      'rp-del-yes': finalize,
    };
    host.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || !host.contains(b)) return;
      const k = Object.keys(act).find((c) => b.classList.contains(c)); if (k) act[k](b);
    });
    host.addEventListener('change', (e) => {
      const t = e.target;
      if (t.closest('.rp-ck')) { if (t.checked) st.picked.add(t.dataset.k); else st.picked.delete(t.dataset.k); paintRes(); }
      else if (t.closest('.rp-sck')) { if (t.checked) st.pick.sel.add(t.dataset.id); else st.pick.sel.delete(t.dataset.id); paintSents(); }
      else if (t.closest('.rp-rewrite')) st.rewrite = t.checked;
    });
    host.addEventListener('input', (e) => {
      const ta = e.target.closest('.rp-ta'), q = e.target.closest('.rp-q');
      if (ta) {
        st.text = ta.value.slice(0, MAX);
        const f = host.querySelector('.rp-find'); if (f) f.disabled = st.busy || !st.text.trim();
        const c = host.querySelector('.ep-count'); if (c) c.textContent = `${st.text.length}/${MAX}`;
      } else if (q) { st.pick.q = q.value.slice(0, 80); paintSents(); }
    });
    host.addEventListener('keydown', (e) => {
      if (!e.target.closest('.rp-ta')) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); find(); }
      else if (e.key === 'Escape' && !st.busy) { e.stopPropagation(); st.open = false; paint(); }
    });
    paint();
    return {
      state: st,
      open() { st.open = true; paint(); },
      refresh() { sync(); paint(); }, // for pages that keep one mount for a long time: call it when the view model changed
      // a stretch picked somewhere else (the editor's selection): it joins the review, ticked
      addRange(from, to, text) {
        const stage = vmNow().stage; if (stage && stage !== 'done') { o.toast('Wait for the video to finish processing first.'); return false; }
        if (!add({ from, to, text: text || '', reason: 'The part you selected.', source: 'pick' })) { o.toast('Select a little more than that, or it is already in the list.'); return false; }
        st.open = true; if (st.paint) st.paint(); loadPub(); return true;
      },
    };
  }

  window.RedactPrompt = { mount };
})();
