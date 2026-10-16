// AI Actions (Phase 4): one-click documents made from a recording: SOP, PR description, bug report, issue body, follow-up message, meeting recap.
// Each action is its own small agent: a prompt, a JSON schema, a validator and a markdown renderer. They run through llm.js (local Ollama), read the
// transcript (already bleeped by the Privacy Guard), the Auto-Guide and the AI notes, and are cached per video until any of those change.
const crypto = require('crypto');
const llm = require('./llm');

const str = { type: 'string' };
const strs = { type: 'array', items: str };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', required, properties });

const ACTIONS = {
  sop: {
    label: 'SOP document', blurb: 'Standard operating procedure someone else can follow.',
    system: 'You turn a screen recording into a standard operating procedure (SOP). Be concrete and use only what the recording shows or says. Imperative steps, no filler, no emoji.',
    ask: 'Write the SOP: "title"; "purpose" (1-2 sentences); "prerequisites" (what must be in place first, may be empty); "steps" (3-12, each {"title": short imperative, "detail": one or two sentences}); "troubleshooting" (known pitfalls mentioned, may be empty).',
    schema: obj({ title: str, purpose: str, prerequisites: strs, steps: { type: 'array', items: obj({ title: str, detail: str }) }, troubleshooting: strs }),
    nonEmpty: ['title', 'purpose', 'steps'],
    render: (r) => `# ${r.title}\n\n**Purpose:** ${r.purpose}\n\n` + (r.prerequisites.length ? `## Before you start\n${r.prerequisites.map((x) => `- ${x}`).join('\n')}\n\n` : '') + `## Procedure\n${r.steps.map((s, i) => `${i + 1}. **${s.title}**: ${s.detail}`).join('\n')}\n` + (r.troubleshooting.length ? `\n## Troubleshooting\n${r.troubleshooting.map((x) => `- ${x}`).join('\n')}\n` : ''),
    title: (r) => r.title,
  },
  pr: {
    label: 'PR description', blurb: 'A pull-request description for the change shown.',
    system: 'You write pull-request descriptions from a screen recording of a developer explaining or demonstrating a change. Use only what was shown or said; never invent file names, test results or issue numbers.',
    ask: 'Write: "title" (max 72 characters, imperative); "summary" (2-4 sentences: what and why); "changes" (bullet points of what changed); "testing" (how it was verified, as said or shown; say "Not covered in the recording" if nothing); "risks" (risks or follow-ups mentioned, may be empty).',
    schema: obj({ title: str, summary: str, changes: strs, testing: strs, risks: strs }),
    nonEmpty: ['title', 'summary', 'changes'],
    render: (r) => `## ${r.title}\n\n${r.summary}\n\n### Changes\n${r.changes.map((x) => `- ${x}`).join('\n')}\n\n### Testing\n${(r.testing.length ? r.testing : ['Not covered in the recording']).map((x) => `- ${x}`).join('\n')}\n` + (r.risks.length ? `\n### Risks and follow-ups\n${r.risks.map((x) => `- ${x}`).join('\n')}\n` : ''),
    title: (r) => r.title,
  },
  bug: {
    label: 'Bug report', blurb: 'Steps to reproduce, expected and actual behaviour.',
    system: 'You write bug reports from a screen recording where someone reproduces and explains a problem. Use only what was shown or said. If a detail (version, OS) was not mentioned, write "Not stated".',
    ask: 'Write: "title" (max 80 characters); "severity" (one of low, medium, high, critical, judged from what was said); "environment" (app, version, OS, browser if mentioned, else "Not stated"); "steps" (steps to reproduce, in order); "expected"; "actual"; "notes" (anything else useful, may be empty string).',
    schema: obj({ title: str, severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, environment: str, steps: strs, expected: str, actual: str, notes: str }),
    nonEmpty: ['title', 'steps', 'expected', 'actual'],
    render: (r) => `# ${r.title}\n\n**Severity:** ${r.severity}  \n**Environment:** ${r.environment}\n\n## Steps to reproduce\n${r.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n## Expected\n${r.expected}\n\n## Actual\n${r.actual}\n` + (r.notes ? `\n## Notes\n${r.notes}\n` : ''),
    title: (r) => r.title,
  },
  issue: {
    label: 'Issue (Jira / Linear / GitHub)', blurb: 'A ticket body with acceptance criteria.',
    system: 'You write issue-tracker tickets from a screen recording. Concrete, scoped, testable. Use only what the recording says or shows.',
    ask: 'Write: "title" (max 80 characters); "type" (one of task, bug, story); "description" (2-5 sentences: context and what needs to happen); "acceptanceCriteria" (testable bullet points); "labels" (up to 4 short lowercase labels).',
    schema: obj({ title: str, type: { type: 'string', enum: ['task', 'bug', 'story'] }, description: str, acceptanceCriteria: strs, labels: strs }),
    nonEmpty: ['title', 'description', 'acceptanceCriteria'],
    render: (r) => `# ${r.title}\n\n_${r.type}_${r.labels.length ? ' · ' + r.labels.map((l) => `\`${l}\``).join(' ') : ''}\n\n${r.description}\n\n## Acceptance criteria\n${r.acceptanceCriteria.map((x) => `- [ ] ${x}`).join('\n')}\n`,
    title: (r) => r.title,
  },
  email: {
    label: 'Follow-up message', blurb: 'A short email or chat message to send afterwards.',
    system: 'You write short, friendly, professional follow-up messages after a recorded walkthrough or call. Plain text. Never invent facts, dates or promises that were not said.',
    ask: 'Write: "subject" (max 60 characters); "body" (3-8 short sentences or short paragraphs: thank, recap in one line, list next steps, close; no placeholders except [Name] for the greeting); "nextSteps" (the next steps as short bullets, may be empty).',
    schema: obj({ subject: str, body: str, nextSteps: strs }),
    nonEmpty: ['subject', 'body'],
    render: (r) => `**Subject:** ${r.subject}\n\n${r.body}\n` + (r.nextSteps.length ? `\n**Next steps**\n${r.nextSteps.map((x) => `- ${x}`).join('\n')}\n` : ''),
    title: (r) => r.subject,
  },
  recap: {
    label: 'Meeting recap', blurb: 'Decisions, action items with owners, open questions.',
    system: 'You write meeting recaps from a transcript. Faithful, short. Attribute an owner only when a name was actually said; otherwise leave the owner empty.',
    ask: 'Write: "title"; "summary" (2-4 sentences); "decisions" (what was decided); "actionItems" (each {"task", "owner"}; owner may be an empty string); "openQuestions" (unresolved questions, may be empty).',
    schema: obj({ title: str, summary: str, decisions: strs, actionItems: { type: 'array', items: obj({ task: str, owner: str }) }, openQuestions: strs }),
    nonEmpty: ['title', 'summary'],
    render: (r) => `# ${r.title}\n\n${r.summary}\n\n` + (r.decisions.length ? `## Decisions\n${r.decisions.map((x) => `- ${x}`).join('\n')}\n\n` : '') + (r.actionItems.length ? `## Action items\n${r.actionItems.map((a) => `- [ ] ${a.task}${a.owner ? ` (${a.owner})` : ''}`).join('\n')}\n\n` : '') + (r.openQuestions.length ? `## Open questions\n${r.openQuestions.map((x) => `- ${x}`).join('\n')}\n` : ''),
    title: (r) => r.title,
  },
};

// ---- validation: the model's JSON must match the schema before it is cached, shown or sent anywhere ----
function validate(schema, value, at = '$') {
  const fail = (m) => { throw new Error(`${at}: ${m}`); };
  if (schema.type === 'string') { if (typeof value !== 'string') fail('expected a string'); if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}`); return value.trim(); }
  if (schema.type === 'array') { if (!Array.isArray(value)) fail('expected a list'); return value.map((x, i) => validate(schema.items, x, `${at}[${i}]`)).filter((x) => (typeof x === 'string' ? x.length : true)); }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object');
    const out = {};
    for (const k of schema.required || []) if (!(k in value)) fail(`missing "${k}"`);
    for (const [k, sub] of Object.entries(schema.properties)) if (k in value) out[k] = validate(sub, value[k], `${at}.${k}`);
    return out;
  }
  return value;
}
function conform(id, raw) {
  const spec = ACTIONS[id], r = validate(spec.schema, raw);
  for (const k of spec.nonEmpty) if (Array.isArray(r[k]) ? !r[k].length : !r[k]) throw new Error(`"${k}" came back empty`);
  return r;
}

// What the model reads. The transcript was bleeped by the Privacy Guard before it was saved, so a spoken secret never reaches the prompt.
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function context(v) {
  const parts = [`Title: ${v.title}`, `Length: ${mmss(v.duration || 0)}`];
  if (v.summary) parts.push(`Summary: ${v.summary}`);
  if (v.chapters?.length) parts.push('Chapters:\n' + v.chapters.map((c) => `- ${mmss(c.start)} ${c.title}`).join('\n'));
  if (v.tasks?.length) parts.push('Action items noted earlier:\n' + v.tasks.map((t) => `- ${t}`).join('\n'));
  if (v.guide?.steps?.length) parts.push('Step-by-step guide drafted from the screen:\n' + v.guide.steps.map((s) => `${s.n}. [${mmss(s.at)}] ${s.title}: ${s.detail}`).join('\n'));
  parts.push('Transcript:\n' + (v.segments || []).map((s) => `[${mmss(s.start)}] ${s.text}`).join('\n').slice(0, 12000));
  return parts.join('\n\n');
}
const sourceKey = (v) => crypto.createHash('sha1').update(context(v)).digest('hex').slice(0, 16);

const inflight = new Map();
// Runs one action. Returns { id, label, at, key, result, markdown, title }. Throws with a readable message.
async function run(v, id) {
  const spec = ACTIONS[id]; if (!spec) throw Object.assign(new Error('unknown action'), { status: 404 });
  if (!(v.segments || []).length && !v.guide) throw Object.assign(new Error('This recording has no transcript yet. Run the AI notes first.'), { status: 409 });
  const k = `${v.id}:${id}`; if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    let lastErr = null;
    const timeoutMs = (await llm.loaded()) ? 120_000 : 300_000; // a cold qwen3:8b needs a while to load; measured: the first call after idle timed out at 120 s
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await llm.json({ system: spec.system, user: `${context(v)}\n\n${spec.ask}\nReturn only JSON.${lastErr ? `\nYour last answer was rejected: ${lastErr.message}. Fix that.` : ''}`, schema: spec.schema, temperature: 0.2, retries: 0, timeoutMs });
      try { const result = conform(id, raw); return { id, label: spec.label, at: Date.now(), key: sourceKey(v), result, markdown: spec.render(result), title: spec.title(result) }; }
      catch (e) { lastErr = e; }
    }
    throw new Error(`The model's answer did not match the ${spec.label} format twice: ${lastErr.message}`);
  })().finally(() => inflight.delete(k));
  inflight.set(k, p); return p;
}

const list = (v) => Object.entries(ACTIONS).map(([id, a]) => {
  const c = v.actions?.[id];
  return { id, label: a.label, blurb: a.blurb, cached: c ? { at: c.at, stale: c.key !== sourceKey(v) } : null };
});

module.exports = { ACTIONS, run, list, validate, conform, context, sourceKey };
