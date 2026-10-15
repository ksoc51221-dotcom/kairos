// Agents — Guide Writer + Guide Critic. Writer drafts a step-by-step doc; Critic checks it against the
// transcript and screen text; Writer revises once if the Critic finds gaps. Screenshots come from the
// already-redacted video, so secrets can never leak into the guide.
const fs = require('fs');
const path = require('path');
const llm = require('./llm');
const { frameAt } = require('./media');

const KINDS = {
  'how-to': { label: 'How-to guide', steps: 'Numbered steps someone can follow to repeat what was shown.', closing: 'One short "result / tips" paragraph.' },
  'bug-report': { label: 'Bug report', steps: 'Steps to reproduce, in order.', closing: 'Two lines: "Expected: ..." and "Actual: ...".' },
  'meeting-notes': { label: 'Meeting notes', steps: 'Key points discussed, in order.', closing: 'Decisions and next actions as one short paragraph.' },
  explainer: { label: 'Explainer', steps: 'The main ideas in the order they were presented.', closing: 'One-sentence takeaway.' },
};
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Merge transcript + on-screen text into one timeline the model can read.
function buildContext({ segments, screen }) {
  const seen = new Set(); const rows = [];
  for (const f of screen) {
    const fresh = f.lines.filter((l) => l.length > 3 && !seen.has(l)).slice(0, 5);
    fresh.forEach((l) => seen.add(l));
    if (fresh.length) rows.push({ t: f.t, text: `(screen) ${fresh.join(' | ')}` });
  }
  segments.forEach((s) => rows.push({ t: s.start, text: `(says) ${s.text}` }));
  rows.sort((a, b) => a.t - b.t);
  return rows.map((r) => `[${r.t.toFixed(1)}s] ${r.text}`).join('\n').slice(0, 12000);
}

const SCHEMA = { type: 'object', required: ['title', 'intro', 'steps', 'closing'], properties: {
  title: { type: 'string' }, intro: { type: 'string' }, closing: { type: 'string' },
  steps: { type: 'array', items: { type: 'object', required: ['title', 'detail', 'at'], properties: {
    title: { type: 'string' }, detail: { type: 'string' }, at: { type: 'number' } } } } } };

async function write(kind, context, issues) {
  const k = KINDS[kind] || KINDS['how-to'];
  return llm.json({
    system: `You turn a screen recording into a ${k.label}. You only know what is in the timeline: what the presenter says and text visible on screen. ` +
      'Never invent buttons, menus or values that are not in the timeline. Never output text that looks like a secret; write [hidden] instead. ' +
      `Each step needs "at": the timestamp in seconds (copied from the timeline) where that step is visible.`,
    user: `Timeline:\n${context}\n\nWrite: "title"; "intro" (1-2 sentences); "steps" (${k.steps} 3-10 steps, each with a short imperative "title" and a one-sentence "detail"); "closing" (${k.closing}).` +
      (issues?.length ? `\n\nYour previous draft was rejected. Fix these problems:\n- ${issues.join('\n- ')}` : ''),
    schema: SCHEMA, temperature: 0.3,
  });
}

async function critique(kind, context, draft) {
  const res = await llm.json({
    system: 'You are an editor checking a draft guide against its source timeline. Both "(says)" lines and "(screen)" lines are valid evidence. ' +
      'Report a problem ONLY if it is blocking: (a) a step states a fact, button or value that appears in neither the speech nor the screen text, ' +
      '(b) an important action from the timeline is completely missing, or (c) the draft contains something that looks like a password, key or token. ' +
      'Ordering quirks, wording, merging or splitting steps, and style are NOT problems. Most good drafts have zero problems.',
    user: `Timeline:\n${context}\n\nDraft:\n${JSON.stringify(draft)}\n\nReturn JSON {"problems": [{"step": number or 0, "problem": short sentence}]}. Use an empty array if the draft is fine.`,
    schema: { type: 'object', required: ['problems'], properties: { problems: { type: 'array', items: { type: 'object', required: ['step', 'problem'], properties: { step: { type: 'integer' }, problem: { type: 'string' } } } } } },
  });
  const issues = (res.problems || []).map((p) => (p.step ? `Step ${p.step}: ${p.problem}` : p.problem)).slice(0, 5);
  return { ok: issues.length === 0, issues };
}

async function makeGuide({ kind, segments, screen, duration, video, outDir, onEvent = () => {} }) {
  const context = buildContext({ segments, screen });
  const times = [...segments.map((s) => s.start), ...screen.map((f) => f.t)];
  onEvent('writer', 'drafting');
  let draft = await write(kind, context);
  let revisions = 0, verdict = { ok: true, issues: [] };
  try {
    onEvent('critic', 'reviewing draft');
    verdict = await critique(kind, context, draft);
    if (!verdict.ok && verdict.issues.length) {
      onEvent('writer', `revising (${verdict.issues.length} issue${verdict.issues.length > 1 ? 's' : ''})`);
      draft = await write(kind, context, verdict.issues); revisions = 1;
      onEvent('critic', 'checking revision');
      verdict = await critique(kind, context, draft);
    }
  } catch (e) { onEvent('critic', `skipped: ${e.message}`); }

  fs.mkdirSync(outDir, { recursive: true });
  const steps = [];
  for (let i = 0; i < (draft.steps || []).length && i < 12; i++) {
    const s = draft.steps[i];
    let at = Math.min(Math.max(+s.at || 0, 0), Math.max(0, duration - 0.5));
    if (times.length) at = times.reduce((b, t) => (Math.abs(t - at) < Math.abs(b - at) ? t : b), times[0]);
    const img = `step${i + 1}.jpg`;
    await frameAt(video, Math.min(at + 0.3, Math.max(0, duration - 0.3)), path.join(outDir, img), 960);
    steps.push({ n: i + 1, title: s.title, detail: s.detail, at: +at.toFixed(1), image: fs.existsSync(path.join(outDir, img)) ? img : null });
  }
  return { kind, label: (KINDS[kind] || KINDS['how-to']).label, title: draft.title, intro: draft.intro, steps, closing: draft.closing,
    revisions, criticOk: verdict.ok, criticIssues: verdict.issues || [] };
}

// Planner picks the document type + whether a guide is worth writing at all.
async function plan({ segments, text, duration, hasScreenText }) {
  const words = text.split(/\s+/).filter(Boolean).length;
  const res = await llm.json({
    system: 'You are the Planner of an AI crew attached to a screen recorder. Decide what document the recording should become.',
    user: `Length ${mmss(duration)}, ${words} spoken words, screen text found: ${hasScreenText}.\nTranscript start:\n${text.slice(0, 1500)}\n\n` +
      'Return JSON {"kind": one of "how-to","bug-report","meeting-notes","explainer", "writeGuide": boolean, "reason": one short sentence}. ' +
      'Set writeGuide=false when there is almost no speech and no screen text, or the recording is too short to contain steps.',
    schema: { type: 'object', required: ['kind', 'writeGuide', 'reason'], properties: { kind: { type: 'string', enum: Object.keys(KINDS) }, writeGuide: { type: 'boolean' }, reason: { type: 'string' } } },
  });
  return { kind: KINDS[res.kind] ? res.kind : 'how-to', writeGuide: !!res.writeGuide, reason: res.reason || '' };
}
module.exports = { makeGuide, plan, KINDS };
