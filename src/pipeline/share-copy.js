// The small copy that goes to the internet for a public link. It is made from the GUARDED video.mp4 (never original.mp4), so the blur and the
// bleeps are already in it. At most 1080p, 30 fps and about 5 Mbps: ~37 MB a minute, where a Source-quality recording is 220-245 MB a minute
// (2880x1800 at 35 Mbps) and cannot stream on a phone's mobile data.
const { runFfmpeg } = require('./encode');

const LIMITS = { width: 1920, height: 1080, fps: 30, crf: 23, maxrate: '5M', bufsize: '10M', audioKbps: 128 };
// What one second of share copy costs at the very most (video at maxrate + audio), for "will it fit" checks before anything is encoded.
const BYTES_PER_SECOND = 5e6 / 8 + LIMITS.audioKbps * 1000 / 8;
const estimateBytes = (seconds) => Math.ceil(Math.max(1, seconds || 0) * BYTES_PER_SECOND);

// Nothing is scaled up. The first scale keeps the picture's shape inside 1920x1080; the second only makes both sides even, which H.264 needs.
const filter = () => `scale=w='min(${LIMITS.width},iw)':h='min(${LIMITS.height},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=${LIMITS.fps},format=yuv420p`;

// Metadata and chapters are dropped, and `0:a:0?` makes the audio optional so a silent recording does not fail.
function shareArgs(input, out) {
  return ['-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1', '-vf', filter(),
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-level:v', '4.1', '-crf', String(LIMITS.crf), '-maxrate', LIMITS.maxrate, '-bufsize', LIMITS.bufsize,
    '-c:a', 'aac', '-b:a', `${LIMITS.audioKbps}k`, '-movflags', '+faststart', out];
}
// opts: { duration (seconds, for progress), onProgress(0..1), signal }
const makeShareCopy = (input, out, opts) => runFfmpeg(shareArgs(input, out), opts);

// The link-preview / poster picture is one frame of the share copy, so it can only show what the video shows.
const posterArgs = (input, out, at) => ['-y', '-ss', String(at), '-i', input, '-frames:v', '1', '-vf', "scale=w='min(1280,iw)':h=-2", '-q:v', '4', out];
const makePoster = (input, out, duration = 0) => runFfmpeg(posterArgs(input, out, duration > 3 ? 1 : 0));

module.exports = { LIMITS, BYTES_PER_SECOND, estimateBytes, shareArgs, makeShareCopy, posterArgs, makePoster };
