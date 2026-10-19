// What a viewer may see of a video. The owner additionally gets the crew log, privacy settings, viewers and activity.
const fs = require('fs');
const path = require('path');
const store = require('../store');
const { effectivePrivacy } = require('./auth');

function viewModel(v, owner) {
  const p = effectivePrivacy(v);
  const m = {
    id: v.id, by: store.getSettings().ownerName, mode: v.mode, source: v.source, type: v.type, title: v.title, createdAt: v.createdAt, status: v.status, stage: v.stage, duration: v.duration, views: v.views,
    comments: v.comments, reactions: v.reactions, reactionEvents: (v.reactionEvents || []).slice(-300), tags: v.tags, summary: v.summary, chapters: v.chapters, tasks: v.tasks,
    segments: v.segments, words: undefined, guide: v.guide, cta: v.cta, overlays: v.overlays, captionStyle: v.captionStyle, background: v.background, autoZoom: !!v.autoZoom, cursorFx: v.cursorFx !== false, captionsDefault: !!v.captionsDefault,
    redactionCount: (v.redactions || []).length, allowDownload: p.allowDownload, width: v.width, height: v.height, hasGif: fs.existsSync(path.join(store.videoDir(v.id), 'preview.gif')),
  };
  if (owner) Object.assign(m, {
    crew: v.crew, plan: v.plan, redactions: v.redactions, privacy: { mode: p.mode, expiresAt: p.expiresAt, allowDownload: v.privacy?.allowDownload !== false, hasPassword: !!v.privacy?.passwordHash },
    folder: v.folder, spaces: v.spaces, watchLater: v.watchLater, progress: v.progress, viewers: v.viewers, heat: v.heat, activity: (v.activity || []).slice(0, 60), words: v.words ? true : false,
    track: !!v.hasTrack, forAgent: !!v.forAgent, edits: v.edits, canUndo: !!v.editPrev, editError: v.editError, wordsError: v.wordsError, variables: v.variables, shareable: v.shareable === true, guard: v.guard, speechRedactions: (v.speechRedactions || []).length, timings: v.timings, pipe: v.pipe,
  });
  return m;
}

module.exports = { viewModel };
