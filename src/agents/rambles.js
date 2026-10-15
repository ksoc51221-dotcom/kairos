// Editor "Rambles": the local model proposes sentence ranges that repeat what was already said, or wander off the point. Only a proposal: the
// user reviews each range before it becomes a cut. Needs Ollama; without it the editor simply shows no ramble proposals.
const llm = require('./llm');

const SCHEMA = { type: 'object', properties: { ranges: { type: 'array', items: { type: 'object', properties: { from: { type: 'integer' }, to: { type: 'integer' }, reason: { type: 'string' } }, required: ['from', 'to', 'reason'] } } }, required: ['ranges'] };
const MAX_SHARE = 0.25; // never propose more than a quarter of the video: a model that wants to cut half of it is wrong

// Pure: model answer + the segments it was shown -> cuts. Out-of-range, reversed and overlapping answers are dropped, then the total is capped.
function toCuts(answer, segments, duration) {
  const ranges = (answer && Array.isArray(answer.ranges) ? answer.ranges : []).map((r) => ({ from: +r.from, to: +r.to, reason: String(r.reason || '').slice(0, 120) }))
    .filter((r) => Number.isInteger(r.from) && Number.isInteger(r.to) && r.from >= 0 && r.to >= r.from && r.to < segments.length).sort((a, b) => a.from - b.from);
  const out = []; let last = -1, spent = 0;
  for (const r of ranges) {
    if (r.from <= last) continue;
    const start = segments[r.from].start, end = segments[r.to].end;
    if (spent + (end - start) > duration * MAX_SHARE) continue;
    out.push({ start, end, kind: 'ramble', reason: r.reason }); spent += end - start; last = r.to;
  }
  return out;
}

async function proposeRambles({ segments, duration }) {
  if (!segments?.length || segments.length < 4 || !(await llm.available())) return [];
  const list = segments.map((s, i) => `[${i}] ${s.text}`).join('\n').slice(0, 12000);
  const answer = await llm.json({
    system: 'You edit screen-recording transcripts. Find sentence ranges that can be cut without losing information: a sentence that repeats one already said, a false start that is restated right after, or a tangent that has nothing to do with the rest. Be conservative: when unsure, leave it. Answer with JSON {"ranges":[{"from":<first sentence number>,"to":<last sentence number>,"reason":"<six words>"}]}. An empty list is a good answer.',
    user: list, schema: SCHEMA, temperature: 0.1, retries: 0,
  });
  return toCuts(answer, segments, duration);
}

module.exports = { proposeRambles, toCuts };
