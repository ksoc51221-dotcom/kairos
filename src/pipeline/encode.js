// Runs ffmpeg with progress, and picks the encoder for the one lossy encode before publishing:
// VideoToolbox (hardware) where available, libx264 otherwise.
const { spawn, spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

let hw = null;
function hasVideoToolbox() {
  if (hw === null) {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    hw = process.platform === 'darwin' && /h264_videotoolbox/.test(r.stdout || '');
  }
  return hw;
}
const bitrateFor = (height) => (height <= 1080 ? '12M' : height <= 1440 ? '20M' : '35M');

function videoArgs(height, useHw = hasVideoToolbox()) {
  return useHw
    ? ['-c:v', 'h264_videotoolbox', '-b:v', bitrateFor(height), '-profile:v', 'high', '-allow_sw', '1']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'];
}
const audioArgs = () => ['-c:a', 'aac', '-b:a', '160k'];

// Resolves { stderr } on success. onProgress(0..1) fires as ffmpeg reports output time (needs `duration` in seconds).
// `signal` (an AbortSignal) kills ffmpeg and rejects with "cancelled".
function runFfmpeg(args, { duration = 0, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'));
    const p = spawn(ffmpeg, ['-hide_banner', '-nostats', '-progress', 'pipe:1', ...args]);
    const stop = () => p.kill('SIGKILL'); signal?.addEventListener('abort', stop, { once: true });
    let err = '', buf = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && duration && onProgress) onProgress(Math.min(1, +m[1] / 1e6 / duration));
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) return reject(new Error('cancelled'));
      code === 0 ? resolve({ stderr: err }) : reject(new Error(`ffmpeg ${code}: ${err.slice(-500)}`));
    });
  });
}

// ffmpeg exits 1 for "-i file" with no output, so the stream list is read from stderr and the exit code is ignored.
function hasAudioStream(file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  return /Stream #\d+:\d+.*: Audio:/.test(r.stderr || '');
}

// Loomify: any video file dropped into the library becomes an mp4 with even dimensions, with audio if it has any.
// Uploads are already compressed once, so this stays a quality-based software encode rather than a fixed-bitrate hardware one.
function transcodeUpload(file, out, opts) {
  const audio = hasAudioStream(file);
  return runFfmpeg(['-y', '-i', file, '-map', '0:v:0', ...(audio ? ['-map', '0:a:0', ...audioArgs()] : []), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], opts);
}

module.exports = { ffmpeg, hasVideoToolbox, videoArgs, audioArgs, bitrateFor, runFfmpeg, hasAudioStream, transcodeUpload };
