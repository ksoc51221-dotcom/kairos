// "Describe an edit", chat edition: one message in, an honest reply and REVIEWABLE proposals out.
//
// Routing: ONE model call (llm.json, so the local Ollama path is the only path) classifies the owner's message into a short list of actions. Each action
// maps to a capability that already exists:
//   cut / silences / fillers -> edit-intent.interpretEdit      (cut proposals; rules first, the model only for "the part about X")
//   bleep                    -> redact-intent.interpretRedact  (bleep proposals; speech-guard rules apply on apply)
//   title / summary          -> a metadata draft               (the same prompt style as agents/insights.js; applied with PATCH /api/videos/:id)
//   chapters                 -> a metadata draft               (same)
//   ai_action                -> agents/actions.js ACTIONS      (a card with a Generate button; generating goes through POST /api/videos/:id/actions/:id)
//   question                 -> an answer from the transcript with [m:ss] timestamps the page turns into seek buttons
//   unsupported              -> an honest "not yet" plus up to 3 chips for the closest things that do work
// Nothing here changes a video, its draft or its notes. The page shows every result as a card; only what the owner ticks and applies is sent to the
// existing endpoints. The model's JSON is validated and clamped (unknown action -> unsupported, ids checked against the real list, numbers clamped to
// the video), and every string that leaves this file is plain text: the page escapes it, and spoken-secret phrasing is bleeped out of model text.
const { interpretEdit, EditIntentError } = require('./edit-intent');
const { interpretRedact } = require('./redact-intent');
const { guardTranscript } = require('./speech-guard');

const MAX_TEXT = 500;
const MAX_TURNS = 6; // last turns of the thread the page sends along
const MAX_TURN_CHARS = 400;
const MAX_ACTIONS = 5;
const MAX_CUTS = 150;
const TRANSCRIPT_CHARS = 9000; // qwen3:8b runs with an 8k-token window
const MIN_CHAPTER_VIDEO = 30; // seconds; a shorter video does not need chapters

const TYPES = ['cut', 'silences', 'fillers', 'bleep', 'title', 'summary', 'chapters', 'ai_action', 'question', 'unsupported'];
const ALIAS = {
  trim: 'cut', remove: 'cut', delete: 'cut', cut_part: 'cut', cuts: 'cut', silence: 'silences', remove_silences: 'silences', filler: 'fillers', filler_words: 'fillers',
  redact: 'bleep', mute: 'bleep', censor: 'bleep', bleeps: 'bleep', description: 'summary', rewrite_title: 'title', chapter: 'chapters', ask: 'question', answer: 'question',
  qa: 'question', doc: 'ai_action', document: 'ai_action', action: 'ai_action',
};

// What a chip may say. The model picks keys from this list; the text is ours, so a suggestion can never promise something that does not exist.
const CHIPS = {
  silences: { label: 'Remove the silences', text: 'Remove the silences', model: false },
  fillers: { label: 'Remove filler words', text: 'Remove filler words', model: false },
  trim_start: { label: 'Cut the first 10 seconds', text: 'Cut the first 10 seconds', model: false },
  topic_cut: { label: 'Cut a part by topic', text: 'Cut the part where I talk about pricing', model: true },
  bleep: { label: 'Bleep a password', text: 'Bleep anything that sounds like a password', model: false },
  title: { label: 'Write a better title', text: 'Write a better title', model: true },
  summary: { label: 'Write a summary', text: 'Write a new summary of this video', model: true },
  chapters: { label: 'Add chapters', text: 'Add chapters', model: true },
  question: { label: 'Ask about the video', text: 'What are the main points of this video?', model: true },
  sop: { label: 'Write an SOP document', text: 'Write an SOP document from this video', model: true },
  bug: { label: 'Write a bug report', text: 'Write a bug report from this video', model: true },
  email: { label: 'Write a follow-up email', text: 'Write a follow-up email', model: true },
};
const DEFAULT_CHIPS = ['silences', 'chapters', 'question'];
const OFFLINE_CHIPS = ['silences', 'fillers', 'trim_start'];
const chipOf = (k) => ({ key: k, label: CHIPS[k].label, text: CHIPS[k].text });
const chips = (keys, { modelUp = true } = {}) => {
  const ok = [...new Set((Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && CHIPS[k] && (modelUp || !CHIPS[k].model)))].slice(0, 3);
  return ok.map(chipOf);
};

class ChatError extends Error {
  constructor(message, status = 502) { super(message); this.name = 'ChatError'; this.status = status; }
}

const mmss = (s) => { s = Math.max(0, Math.floor(+s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const r1 = (x) => Math.round(x * 10) / 10;
const oneLine = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
// A spoken-secret phrase in model text ("the password is hunter2") is bleeped with the same rules as the transcript. Defence in depth: the transcript the
// model reads was already bleeped by the Privacy Guard, so this only catches a model that makes one up or a transcript that is not cleared yet.
function scrub(s) {
  const t = String(s ?? '');
  if (!t) return '';
  try { return guardTranscript({ text: t, segments: [{ start: 0, end: 1, text: t }] }).text; } catch { return t; }
}
const clean = (s, n) => scrub(oneLine(s, n));

function sanitizeHistory(h) {
  if (!Array.isArray(h)) return [];
  return h.filter((m) => m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    .map((m) => ({ role: m.role, text: oneLine(m.text, MAX_TURN_CHARS) })).filter((m) => m.text).slice(-MAX_TURNS);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 1. the router: one model call
// ---------------------------------------------------------------------------------------------------------------------------------------------
const ROUTER_SYSTEM = `You are the router of a chat assistant that edits ONE screen recording. Decide which of these actions the user's newest message asks for. Answer with JSON only.

Actions (type):
- cut: remove a part by time or by topic ("cut the first 10 seconds", "remove 0:45 to 1:10", "cut the part about pricing"). request = that cut instruction, complete on its own.
- silences: remove silent pauses.
- fillers: remove filler words (um, uh, you know).
- bleep: hide spoken words with a beep (passwords, names, a topic, a moment). request = what to bleep, complete on its own.
- title: write a better title.
- summary: write a new summary or description.
- chapters: write chapters.
- ai_action: write a document from the video. id is one of: sop (SOP document), pr (PR description), bug (bug report), issue (ticket), email (follow-up message), recap (meeting recap).
- question: the user asks something about what is in the video. request = the question, complete on its own.
- unsupported: anything else (background music, zoom, speed, filters, translation, uploads, colors...). what = a short phrase for what they asked.

Rules: list every action the message asks for, in the order asked, at most 5. Use the earlier conversation to resolve words like "it" or "that part" into a complete request. A greeting, thanks or "what can you do" has no actions: put one or two friendly sentences in reply and promise nothing beyond the list above. Never invent an action. If something is unsupported, suggest (up to 3 keys) the nearest things that DO work, chosen only from: silences, fillers, trim_start, topic_cut, bleep, title, summary, chapters, question, sop, bug, email.`;
const ROUTER_SCHEMA = {
  type: 'object', required: ['actions'],
  properties: {
    reply: { type: 'string' },
    actions: { type: 'array', items: { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: TYPES }, request: { type: 'string' }, id: { type: 'string' }, what: { type: 'string' } } } },
    suggest: { type: 'array', items: { type: 'string' } },
  },
};

function routerPrompt({ text, history, video }) {
  const segs = (video.segments || []).length;
  const head = `Video: "${oneLine(video.title, 80)}", ${mmss(video.duration)} long. Transcript: ${segs ? 'yes' : 'no'}. Summary: ${video.summary ? 'yes' : 'no'}. Chapters: ${(video.chapters || []).length}.`;
  const convo = history.length ? `\nConversation so far:\n${history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n')}\n` : '';
  return `${head}${convo}\nNewest message from the user:\n${text}`;
}

// The model's JSON -> a plan the rest of this file can trust. Never throws. `valid` is false when the shape was not usable at all.
function normalizePlan(raw, { text = '', actionIds = [] } = {}) {
  const plan = { actions: [], reply: '', suggest: [], valid: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return plan;
  const list = Array.isArray(raw.actions) ? raw.actions : [];
  plan.valid = Array.isArray(raw.actions);
  const seen = new Set();
  for (const a of list) {
    if (plan.actions.length >= MAX_ACTIONS) break;
    const o = a && typeof a === 'object' ? a : { type: typeof a === 'string' ? a : '' };
    let t = String(o.type ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
    t = ALIAS[t] || t;
    if (!TYPES.includes(t)) t = 'unsupported';
    const request = oneLine(o.request, 300) || (t === 'cut' || t === 'bleep' || t === 'question' ? oneLine(text, MAX_TEXT) : '');
    let act;
    if (t === 'ai_action') {
      const id = String(o.id ?? '').toLowerCase().trim();
      act = actionIds.includes(id) ? { type: 'ai_action', id } : { type: 'unsupported', what: oneLine(o.what || o.request || id || 'that document', 80) };
    } else if (t === 'unsupported') act = { type: 'unsupported', what: oneLine(o.what || o.request || o.type, 80) };
    else if (t === 'cut' || t === 'bleep' || t === 'question') act = { type: t, request };
    else act = { type: t };
    const key = `${act.type}:${act.request || act.id || act.what || ''}`.toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    plan.actions.push(act);
  }
  plan.reply = oneLine(raw.reply, 600);
  plan.suggest = (Array.isArray(raw.suggest) ? raw.suggest : []).filter((k) => typeof k === 'string' && CHIPS[k]).slice(0, 3);
  return plan;
}

// No model (or the model's answer was unreadable): plain-English rules for the things that work without one.
function heuristicPlan(text) {
  const t = String(text || '').toLowerCase(), actions = [];
  if (/\b(bleep|beep|redact|censor|mute)\b/.test(t)) actions.push({ type: 'bleep', request: oneLine(text, MAX_TEXT) });
  if (/\bsilen|\bdead air|\bpauses?\b/.test(t)) actions.push({ type: 'silences' });
  if (/\bfillers?\b|\bums?\b|\buhs?\b|\bfumbl/.test(t)) actions.push({ type: 'fillers' });
  if (!actions.length && /\b(cut|trim|remove|delete|drop|skip|chop)\b/.test(t) && /\d|\b(first|last|start|end|beginning|intro|outro)\b/.test(t)) actions.push({ type: 'cut', request: oneLine(text, MAX_TEXT) });
  return { actions, reply: '', suggest: [], valid: true, heuristic: true };
}

async function route({ text, history, video, llm, actionIds }) {
  const loaded = typeof llm.loaded === 'function' ? await llm.loaded().catch(() => false) : true;
  let raw;
  try {
    raw = await llm.json({ system: ROUTER_SYSTEM, user: routerPrompt({ text, history, video }), schema: ROUTER_SCHEMA, temperature: 0, timeoutMs: loaded ? 60_000 : 180_000, retries: 1 });
  } catch (e) {
    if (e && e.kind === 'junk') return { ...heuristicPlan(text), junk: true }; // the model answered, but not in a usable shape
    throw new ChatError(e && e.kind === 'net' ? 'The local model did not answer in time. Check that Ollama is running, then retry.' : 'The local model could not be reached. Check that Ollama is running, then retry.');
  }
  const plan = normalizePlan(raw, { text, actionIds });
  if (!plan.valid) return { ...heuristicPlan(text), junk: true };
  return plan;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 2. the executors: each returns cards (and may push notes)
// ---------------------------------------------------------------------------------------------------------------------------------------------
const note = (text, tone = 'info') => ({ kind: 'note', tone, text: oneLine(text, 400) });
const strs = (a, n = 6) => (Array.isArray(a) ? a : []).map((x) => oneLine(x, 240)).filter(Boolean).slice(0, n);

function cutProposals(res) {
  return (Array.isArray(res && res.proposals) ? res.proposals : []).map((p) => ({
    start: r1(+p.start), end: r1(+p.end), kind: p.kind === 'silence' || p.kind === 'filler' ? p.kind : 'prompt',
    label: oneLine(p.label, 80), reason: oneLine(p.reason, 200), source: p.source === 'model' ? 'model' : 'rule',
  })).filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start);
}
const near = (a, b) => Math.abs(a - b) < 0.05;
// Cuts must fit the video: clamp to [0, duration], drop any that start at/after the end or end up empty, merge overlaps (the earlier cut keeps its label).
function cleanCuts(list, duration) {
  const out = [];
  const fit = (Array.isArray(list) ? list : []).map((p) => ({ ...p, start: r1(Math.max(0, +p.start)), end: r1(duration > 0 ? Math.min(+p.end, duration) : +p.end) }))
    .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start && !(duration > 0 && p.start >= duration))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (const p of fit) { const last = out[out.length - 1]; if (last && p.start <= last.end) last.end = Math.max(last.end, p.end); else out.push(p); }
  return out;
}

async function runCuts(actions, ctx) {
  const cards = [], proposals = [], notes = new Set(); let tried = 0, firstErr = null;
  if (ctx.busy) return { cards: [note('This video is still being processed. Try again in a moment.', 'warn')] };
  for (const a of actions) {
    const text = a.type === 'silences' ? 'remove the silences' : a.type === 'fillers' ? 'remove filler words' : a.request;
    tried++;
    try {
      const res = await ctx.deps.interpretEdit({ text, duration: ctx.video.duration, segments: ctx.video.segments || [], words: ctx.video.words || null, silence: ctx.silence, deps: { llm: ctx.llm } });
      if (res && res.understood) {
        for (const p of cutProposals(res)) if (!proposals.some((q) => near(q.start, p.start) && near(q.end, p.end))) proposals.push(p);
        strs(res.notes).forEach((n) => notes.add(n));
      } else cards.push(note((res && res.message) || 'I did not find anything to cut for that.'));
    } catch (e) {
      if (!firstErr) firstErr = e instanceof EditIntentError ? new ChatError(e.message) : e;
      cards.push(note(e instanceof EditIntentError ? e.message : 'Could not work out that cut. Try again.', 'warn'));
    }
  }
  const fitted = cleanCuts(proposals, ctx.video.duration);
  if (fitted.length) {
    const list = fitted.slice(0, MAX_CUTS), removed = list.reduce((s, p) => s + p.end - p.start, 0);
    cards.unshift({ kind: 'cuts', summary: `${list.length} ${list.length === 1 ? 'cut' : 'cuts'}, ${r1(removed)} s if you keep them all.`, proposals: list, notes: [...notes].slice(0, 6) });
  }
  return { cards, failed: !proposals.length && tried > 0 && firstErr ? firstErr : null };
}

async function runBleeps(actions, ctx) {
  if (ctx.redactBusy) return { cards: [note('This video is still being processed. Try again in a moment.', 'warn')] };
  const list = [], notes = new Set(), cards = []; let firstErr = null, tried = 0;
  for (const a of actions) {
    tried++;
    try {
      const res = await ctx.deps.interpretRedact({ text: a.request, duration: ctx.video.duration, segments: ctx.video.segments || [], words: ctx.video.words || null, deps: { llm: ctx.llm } });
      if (res && res.understood) {
        for (const p of Array.isArray(res.proposals) ? res.proposals : []) {
          const s = r1(+p.start), e = r1(+p.end); if (!(Number.isFinite(s) && Number.isFinite(e) && e > s)) continue;
          if (list.some((q) => Math.min(q.end, e) - Math.max(q.start, s) > 0.5 * Math.min(q.end - q.start, e - s))) continue;
          list.push({ start: s, end: e, text: oneLine(p.text, 300), reason: oneLine(p.reason, 200), source: p.source === 'model' ? 'model' : 'rule', check: p.check === true });
        }
        strs(res.notes).forEach((n) => notes.add(n));
      } else cards.push(note((res && res.message) || 'I did not find anything to bleep for that.'));
    } catch (e) { if (!firstErr) firstErr = e; cards.push(note('Could not work out what to bleep. Try again.', 'warn')); }
  }
  if (list.length) {
    list.sort((a, b) => a.start - b.start);
    const secs = list.reduce((s, p) => s + p.end - p.start, 0), flagged = list.filter((p) => p.check).length;
    cards.unshift({ kind: 'bleeps', summary: `${list.length} ${list.length === 1 ? 'part' : 'parts'}, ${r1(secs)} s${flagged ? `, ${flagged} left unticked to check` : ''}. The picture and the length stay the same.`, proposals: list.slice(0, 60), notes: [...notes].slice(0, 6) });
  }
  return { cards, failed: !list.length && tried > 0 && firstErr ? firstErr : null };
}

const transcriptLines = (segments, cap = TRANSCRIPT_CHARS) => {
  const lines = (segments || []).filter((s) => s && typeof s.text === 'string' && Number.isFinite(+s.start)).map((s) => `[${mmss(s.start)}] ${oneLine(s.text, 400)}`);
  let used = 0, n = 0; for (const l of lines) { if (used + l.length + 1 > cap) break; used += l.length + 1; n++; }
  return { text: lines.slice(0, n).join('\n'), truncated: n < lines.length, covered: n ? (segments[n - 1].end ?? segments[n - 1].start) : 0 };
};

// ---- title, summary, chapters ----
function cleanChapters(list, duration) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    const start = +(c && c.start), title = clean(c && c.title, 50).replace(/^["'\s]+|["'\s]+$/g, '');
    if (!Number.isFinite(start) || start < 0 || (duration > 0 && start >= duration) || !title) continue;
    out.push({ start: r1(start), title });
  }
  out.sort((a, b) => a.start - b.start);
  const spaced = out.filter((c, i) => i === 0 || c.start - out[i - 1].start >= 5).slice(0, 12);
  if (spaced.length && spaced[0].start > 2) spaced.unshift({ start: 0, title: 'Intro' });
  return spaced;
}
async function runMeta(wanted, ctx, request) {
  const v = ctx.video;
  if (v.shareable !== true) return { cards: [note('The Privacy Guard has not finished checking this video, so I will not write titles, summaries or chapters from it yet. Try again when it is cleared.', 'warn')] };
  if (!(v.segments || []).length) return { cards: [note('This video has no transcript yet, so I have nothing to write from. Run the AI notes first.', 'warn')] };
  const parts = [...wanted];
  const cards = [];
  if (parts.includes('chapters') && v.duration < MIN_CHAPTER_VIDEO) { cards.push(note(`This video is ${mmss(v.duration)} long, which is too short for chapters.`)); parts.splice(parts.indexOf('chapters'), 1); }
  if (!parts.length) return { cards };
  const tr = transcriptLines(v.segments), props = {}, req = [];
  if (parts.includes('title')) { props.title = { type: 'string' }; req.push('"title" (max 8 words, concrete, no clickbait)'); }
  if (parts.includes('summary')) { props.summary = { type: 'string' }; req.push('"summary" (2-3 sentences: what the video shows and why)'); }
  if (parts.includes('chapters')) { props.chapters = { type: 'array', items: { type: 'object', required: ['start', 'title'], properties: { start: { type: 'number' }, title: { type: 'string' } } } }; req.push('"chapters" (3-8 items, each {"start": seconds copied from a timestamp above, "title": max 5 words})'); }
  let res;
  try {
    res = await ctx.llm.json({
      system: 'You write metadata for a screen recording from its transcript. Be concrete and short. No hype, no emoji. Follow the owner\'s request about style when it has one. Never repeat a password, key or personal number.',
      user: `Video length: ${mmss(v.duration)}.\nCurrent title: ${oneLine(v.title, 100)}\n${v.summary ? `Current summary: ${oneLine(v.summary, 400)}\n` : ''}Transcript with timestamps:\n${tr.text}\n\nThe owner said: ${oneLine(request, 300) || 'write it fresh'}\n\nReturn JSON with: ${req.join(', ')}.`,
      schema: { type: 'object', required: Object.keys(props), properties: props }, temperature: 0.3, timeoutMs: 120_000, retries: 1,
    });
  } catch (e) { throw new ChatError('The local model did not finish writing that. Check that Ollama is running, then retry.'); }
  if (!res || typeof res !== 'object') throw new ChatError('The model\'s answer could not be read. Retry, or rephrase.');
  const meta = {};
  if (parts.includes('title')) { const t = clean(res.title, 90).replace(/^["'\s]+|["'\s]+$/g, ''); if (t && t !== v.title) meta.title = { current: oneLine(v.title, 200), proposed: t }; }
  if (parts.includes('summary')) { const s = clean(res.summary, 600); if (s && s !== v.summary) meta.summary = { current: oneLine(v.summary, 600), proposed: s }; }
  if (meta.title || meta.summary) cards.push({ kind: 'meta', title: meta.title || null, summary: meta.summary || null });
  else if (parts.includes('title') || parts.includes('summary')) cards.push(note('The model came back with the same text you already have. Say what to change about it (shorter, friendlier, more specific) and I will try again.'));
  if (parts.includes('chapters')) {
    const proposed = cleanChapters(res.chapters, v.duration);
    if (proposed.length >= 2) cards.push({ kind: 'chapters', current: (v.chapters || []).filter((c) => c && Number.isFinite(+c.start)).slice(0, 12).map((c) => ({ start: r1(+c.start), title: oneLine(c.title, 50) })), proposed, notes: tr.truncated ? [`The transcript is long, so only the first ${mmss(tr.covered)} was read.`] : [] });
    else cards.push(note('The model did not find enough distinct sections for chapters. Try again, or ask for fewer.'));
  }
  return { cards };
}

// ---- documents (AI Actions) ----
function runDocs(acts, ctx) {
  const v = ctx.video, cards = [];
  for (const a of acts) {
    const spec = ctx.actions.ACTIONS[a.id];
    if (!spec) continue;
    if (v.shareable !== true) { cards.push(note(`I can write a ${spec.label} once the Privacy Guard has finished checking this video.`, 'warn')); continue; }
    if (!(v.segments || []).length && !v.guide) { cards.push(note(`A ${spec.label} needs a transcript, and this video has none yet. Run the AI notes first.`, 'warn')); continue; }
    const c = v.actions && v.actions[a.id];
    if (!c && !ctx.modelUp) { cards.push(note(`A ${spec.label} needs the local model, which is not running. Start Ollama and ask again.`, 'warn')); continue; }
    cards.push({ kind: 'doc', id: a.id, label: spec.label, blurb: spec.blurb, cached: c ? { at: +c.at || 0, stale: c.key !== ctx.actions.sourceKey(v) } : null });
  }
  return cards;
}

// ---- questions ----
// [m:ss] tokens in an answer are kept only when they point inside the video; the page turns the survivors into seek buttons.
function cleanAnswer(text, duration) {
  let t = scrub(String(text ?? '').replace(/\r/g, '').replace(/\*\*|__|^#+\s*/gm, '').trim()).slice(0, 1400);
  t = t.replace(/\[(\d{1,3}):([0-5]\d)(?:\s*[-–]\s*\d{1,3}:[0-5]\d)?\]/g, (m, a, b) => ((+a * 60 + +b) <= duration + 1 ? `[${+a}:${b}]` : ''));
  return t.replace(/[ \t]{2,}/g, ' ').trim();
}
async function runQuestion(a, ctx, history) {
  const v = ctx.video;
  if (!(v.segments || []).length) return { none: true, text: 'This video has no transcript yet, so I cannot answer questions about what was said. Run the AI notes first.' };
  const tr = transcriptLines(v.segments);
  let res;
  const prior = history.slice(-4).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
  try {
    res = await ctx.llm.json({
      system: 'You answer questions about ONE video using only its transcript. Each transcript line starts with a timestamp like [1:05]. When you refer to a moment, write its timestamp in square brackets exactly as in the transcript, for example [1:05]. If the transcript does not say, say that plainly; never guess. 1 to 5 plain sentences, no markdown.',
      user: `Video: "${oneLine(v.title, 100)}", ${mmss(v.duration)} long.\nTranscript:\n${tr.text}\n${prior ? `\nEarlier in the chat:\n${prior}\n` : ''}\nQuestion: ${a.request}\n\nReturn JSON: {"answer": "..."}.`,
      schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, temperature: 0.2, timeoutMs: 120_000, retries: 1,
    });
  } catch (e) { throw new ChatError('The local model did not finish answering that. Check that Ollama is running, then retry.'); }
  const text = cleanAnswer(res && res.answer, v.duration);
  if (!text) throw new ChatError('The model came back with an empty answer. Retry, or rephrase the question.');
  return { text: tr.truncated ? `${text}\n\nI only read the first ${mmss(tr.covered)} of the transcript.` : text };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 3. one message
// ---------------------------------------------------------------------------------------------------------------------------------------------
// video: { id, title, duration, segments, words, summary, chapters, shareable, guide, actions }
// env: { busy, redactBusy, silence() }    deps (all optional, for tests): { llm, interpretEdit, interpretRedact, actions }
async function chat({ text, history, video, env = {}, deps = {} } = {}) {
  const msg = oneLine(text, MAX_TEXT);
  if (!msg) throw new ChatError('Write a message first.', 400);
  if (!(+video.duration > 0)) throw new ChatError('The length of this video is not known yet. Try again in a moment.', 409);
  const llm = deps.llm || require('./llm');
  const actionsMod = deps.actions || require('./actions');
  const hist = sanitizeHistory(history);
  const modelUp = await llm.available().catch(() => false);
  const ctx = { video, llm, modelUp, actions: actionsMod, busy: !!env.busy, redactBusy: !!(env.redactBusy ?? env.busy), silence: env.silence, deps: { interpretEdit: deps.interpretEdit || interpretEdit, interpretRedact: deps.interpretRedact || interpretRedact } };

  const plan = modelUp ? await route({ text: msg, history: hist, video, llm, actionIds: Object.keys(actionsMod.ACTIONS) }) : heuristicPlan(msg);
  const acts = plan.actions;
  const cards = [], say = [], hard = [], soft = []; // hard: a part that threw (needs a note); soft: cuts / bleeps, which already left their own note
  let sug = [...plan.suggest], answered = 0;

  const unsupported = acts.filter((a) => a.type === 'unsupported');
  const cutActs = acts.filter((a) => a.type === 'cut' || a.type === 'silences' || a.type === 'fillers');
  const bleepActs = acts.filter((a) => a.type === 'bleep');
  const metaParts = ['title', 'summary', 'chapters'].filter((t) => acts.some((a) => a.type === t));
  const docActs = acts.filter((a) => a.type === 'ai_action');
  const questions = acts.filter((a) => a.type === 'question');

  // run in the order the owner asked: cards come out in that order
  const order = []; for (const a of acts) { const g = a.type === 'silences' || a.type === 'fillers' ? 'cut' : ['title', 'summary', 'chapters'].includes(a.type) ? 'meta' : a.type; if (g !== 'unsupported' && !order.includes(g)) order.push(g); }
  for (const g of order) {
    try {
      if (g === 'cut') { const r = await runCuts(cutActs, ctx); cards.push(...r.cards); if (r.failed) soft.push(r.failed); }
      else if (g === 'bleep') { const r = await runBleeps(bleepActs, ctx); cards.push(...r.cards); if (r.failed) soft.push(r.failed); }
      else if (g === 'meta') { if (!modelUp) cards.push(note('Titles, summaries and chapters need the local model, which is not running. Start Ollama and ask again.', 'warn')); else cards.push(...(await runMeta(metaParts, ctx, msg)).cards); }
      else if (g === 'ai_action') cards.push(...runDocs(docActs, ctx));
      else if (g === 'question') {
        for (const q of questions) {
          if (!modelUp) { say.push('Questions about the video need the local model, which is not running. Start Ollama and ask again.'); continue; }
          { const a = await runQuestion(q, ctx, hist); say.push(a.text); if (!a.none) answered++; }
        }
      }
    } catch (e) { hard.push(e); }
  }
  // nothing came out of the request because the model failed: an error the page shows with a Retry button. A part that fails next to one that worked becomes a note.
  const proposals = cards.filter((c) => c.kind !== 'note' && c.kind !== 'doc').length, docs = cards.filter((c) => c.kind === 'doc').length;
  const helped = proposals > 0 || docs > 0 || answered > 0;
  const failure = hard[0] || soft[0];
  if (failure && !helped) throw failure instanceof ChatError ? failure : new ChatError('Something went wrong while working on that. Try again.', 500);
  for (const e of hard) cards.push(note(e instanceof ChatError ? e.message : 'One part of that did not work. Try again.', 'warn'));

  for (const u of unsupported) say.push(`I can't ${u.what || 'do that'} yet.`);
  if (unsupported.length && !sug.length) sug = DEFAULT_CHIPS;
  if (proposals) say.push(proposals === 1 ? 'Here is what I found. Nothing changes until you tick it and apply it.' : `Here are ${proposals} proposals. Nothing changes until you tick them and apply them.`);
  if (docs) say.push(docs === 1 ? 'Press Generate to write it. It stays on this computer.' : 'Press Generate on the ones you want. They stay on this computer.');
  if (!acts.length && plan.reply) say.unshift(clean(plan.reply, 600));
  if (!modelUp && !acts.length) say.unshift('The local model (Ollama) is not running, so I can only do time-based cuts, silences, filler words and bleeping right now. Start Ollama for titles, chapters, summaries, documents and questions.');
  else if (!modelUp && acts.length) say.unshift('The local model (Ollama) is not running, so I used simple rules only.');
  if (plan.junk) say.unshift('The model\'s answer could not be read, so I used simple rules only.');

  let reply = say.map((s) => String(s).trim()).filter(Boolean).join('\n\n');
  if (!reply && !cards.length) reply = acts.length ? 'I could not do anything with that.' : 'I am not sure what you want me to do with that.';
  // never a dead end: if nothing useful came back, offer what does work
  if (!helped && !sug.length) sug = modelUp ? DEFAULT_CHIPS : OFFLINE_CHIPS;
  return { reply, cards, suggestions: chips(sug, { modelUp }), modelUp, plan: acts.map((a) => a.type) };
}

module.exports = {
  chat, route, normalizePlan, heuristicPlan, routerPrompt, sanitizeHistory, cleanAnswer, cleanChapters, cleanCuts, scrub, chips,
  CHIPS, TYPES, ChatError, MAX_TEXT, MAX_TURNS, ROUTER_SCHEMA, ROUTER_SYSTEM,
};
