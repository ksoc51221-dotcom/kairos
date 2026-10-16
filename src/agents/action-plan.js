// "Record for agents" (Phase 4): turns a recording into a markdown brief to paste into Claude Code, Cursor or any coding agent: what was said, the
// steps that were shown (with screenshot files the agent can open), where the clicks landed, and the full timestamped transcript.
// The transcript has already been through the Privacy Guard (spoken secrets bleeped), and the screenshots are cut from the blurred video.
const fs = require('fs');
const path = require('path');

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const pct = (n) => `${Math.round(n * 100)}%`;

// Clicks closest to each guide step, so "click at 62%,40%" sits under the step it belongs to. Returns [{ t, x, y, button }]
function clicksOf(timeline) { return (timeline?.clicks || []).map(([t, x, y, button]) => ({ t, x, y, button })); }
function region(x, y) { return `${y < 0.33 ? 'top' : y > 0.66 ? 'bottom' : 'middle'}-${x < 0.33 ? 'left' : x > 0.66 ? 'right' : 'centre'}`; }

// v: the video record. dir: its folder (for absolute screenshot paths). timeline: parsed timeline.json or null.
function buildActionPlan(v, { dir = null, timeline = null, maxClicks = 60 } = {}) {
  const out = [];
  out.push(`# Task from a screen recording: ${v.title}`);
  out.push(`Recorded ${new Date(v.createdAt).toISOString().slice(0, 16).replace('T', ' ')} · ${mmss(v.duration || 0)}${v.mode ? ` · ${v.mode === 'cam' ? 'camera only' : 'screen' + (v.mode === 'screen-cam' ? ' + camera' : '')}` : ''}. The person recorded this to show you something to do. Read the whole brief before you start.`);
  if (v.summary) out.push(`## What it is about\n${v.summary}`);
  if (v.tasks?.length) out.push(`## What you are asked to do\n${v.tasks.map((t) => `- ${t}`).join('\n')}`);

  const clicks = clicksOf(timeline), steps = v.guide?.steps || [];
  if (steps.length) {
    out.push('## What was shown, step by step\n' + steps.map((s, i) => {
      const next = steps[i + 1]?.at ?? Infinity, mine = clicks.filter((c) => c.t >= s.at - 0.5 && c.t < next).slice(0, 4);
      const img = s.image && dir ? path.join(dir, 'guide', s.image) : null;
      return `${s.n}. **${s.title}** (${mmss(s.at)}): ${s.detail}` + (mine.length ? `\n   - clicks here: ${mine.map((c) => `${mmss(c.t)} ${region(c.x, c.y)} (${pct(c.x)}, ${pct(c.y)})`).join('; ')}` : '') + (img && fs.existsSync(img) ? `\n   - screenshot: \`${img}\`` : '');
    }).join('\n'));
  }
  if (clicks.length && !steps.length) {
    out.push('## Clicks\n' + clicks.slice(0, maxClicks).map((c) => `- ${mmss(c.t)}: ${region(c.x, c.y)} of the screen (${pct(c.x)}, ${pct(c.y)})`).join('\n'));
  }
  if (v.chapters?.length) out.push('## Chapters\n' + v.chapters.map((c) => `- ${mmss(c.start)} ${c.title}`).join('\n'));
  if (v.segments?.length) out.push('## Transcript (what the person said)\n' + v.segments.map((s) => `[${mmss(s.start)}] ${s.text}`).join('\n'));

  out.push(`## How to work from this
- Treat the spoken words as the requirements and the screenshots as the current state of the screen.
- Anything shown as \`[bleep]\` was a spoken secret that the Privacy Guard removed. Do not ask for it; use the project's own secret handling.
- Window titles and on-screen text were not recorded in this brief. If something on screen matters and is not described above, ask before guessing.
- Click positions are fractions of the recorded screen, measured from the top left.`);
  return out.join('\n\n') + '\n';
}

module.exports = { buildActionPlan, clicksOf, region };
