// Agent — Insights: title, summary, chapters and action items from the transcript.
const llm = require('./llm');
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function insights({ segments, text, duration }) {
  const timeline = segments.map((s) => `[${s.start.toFixed(1)}s] ${s.text}`).join('\n').slice(0, 14000);
  const wantChapters = duration >= 60;
  const res = await llm.json({
    system: 'You write metadata for a screen recording, from its transcript. Be concrete and short. No hype, no emoji.',
    user: `Video length: ${mmss(duration)}.\nTranscript with timestamps:\n${timeline}\n\n` +
      `Return JSON with: "title" (max 8 words), "summary" (2-3 sentences, what the video shows and why), ` +
      `"chapters" (${wantChapters ? '3-8 items, each {"start": seconds copied from a timestamp above, "title": max 5 words}' : 'empty array, video is short'}), ` +
      `"tasks" (action items someone must do after watching; empty array if none).`,
    schema: { type: 'object', required: ['title', 'summary', 'chapters', 'tasks'], properties: {
      title: { type: 'string' }, summary: { type: 'string' }, tasks: { type: 'array', items: { type: 'string' } },
      chapters: { type: 'array', items: { type: 'object', required: ['start', 'title'], properties: { start: { type: 'number' }, title: { type: 'string' } } } } } },
  });
  const chapters = (res.chapters || []).filter((c) => c.start >= 0 && c.start < duration).sort((a, b) => a.start - b.start);
  if (chapters.length && chapters[0].start > 2) chapters.unshift({ start: 0, title: 'Intro' });
  return { title: String(res.title || '').slice(0, 90), summary: res.summary || '', chapters, tasks: (res.tasks || []).slice(0, 8) };
}
module.exports = { insights };
