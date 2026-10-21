// A screenshot of what is being recorded, used when a segment's screen recorder wrote nothing. A screen that does not change delivers no frames to a
// fresh MediaRecorder, so a pause/resume while nothing moves on screen can leave a segment with a camera track and no screen track; the export holds this
// picture for that stretch instead of cutting it (see segmentInputs / buildComposite). Pure apart from the capturer and the file it writes, so it is tested with a fake.
const fs = require('fs');

const BIG = { width: 3840, height: 2160 }; // the largest picture asked of a window (a thumbnail is never bigger than the window)

function pick(sources, sourceId, displayId) {
  return sources.find((s) => s.id === sourceId) || (displayId != null && sources.find((s) => String(s.display_id) === String(displayId))) || null;
}

// → the file written, or null. Never throws: a missing screenshot only means the stretch is black instead of the screen.
async function grabStill({ desktopCapturer, sourceId, display, windowSource, file, timeoutMs = 4000 }) {
  try {
    const box = display.size || display.bounds, k = display.scaleFactor || 1;
    const size = windowSource ? BIG : { width: Math.max(2, Math.round(box.width * k)), height: Math.max(2, Math.round(box.height * k)) };
    let timer;
    const srcs = await Promise.race([
      desktopCapturer.getSources({ types: [windowSource ? 'window' : 'screen'], thumbnailSize: size }),
      new Promise((_, no) => { timer = setTimeout(() => no(new Error('timed out')), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    const src = pick(srcs || [], sourceId, windowSource ? null : display.id);
    if (!src || !src.thumbnail || src.thumbnail.isEmpty()) return null;
    const png = src.thumbnail.toPNG();
    if (!png || !png.length) return null;
    fs.writeFileSync(file, png);
    return file;
  } catch { return null; }
}

module.exports = { grabStill, pick };
