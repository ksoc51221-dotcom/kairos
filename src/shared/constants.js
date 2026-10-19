// One source of truth for qualities, bubble styles, ports and file names.
// Loaded two ways: require() in the main process and the server, <script src> in renderer windows (as window.SPOOL).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SPOOL = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PORT = 4747;

  // ---- camera bubble styles ----
  const SHAPES = ['circle', 'squircle', 'portrait', 'landscape'];
  const FILTER_KEYS = ['none', 'warm', 'cool', 'bw', 'vivid', 'soft', 'film'];
  const FRAME_KEYS = ['ring', 'none', 'purple', 'mint', 'gradient', 'glow'];
  const BUBBLE_SIZES = { S: 180, M: 260, L: 380 };
  // CSS versions (live preview in the bubble window). The ffmpeg equivalents arrive with the Phase 2 composite.
  const FILTER_CSS = {
    none: 'none', warm: 'sepia(.25) saturate(1.25) hue-rotate(-8deg)', cool: 'saturate(1.1) hue-rotate(12deg) brightness(1.02)',
    bw: 'grayscale(1) contrast(1.1)', vivid: 'saturate(1.6) contrast(1.1)', soft: 'blur(.7px) brightness(1.06) saturate(.95)', film: 'sepia(.4) contrast(.92) brightness(1.04)',
  };
  const FRAME_CSS = {
    none: 'none', ring: '3px solid #fff', purple: '3px solid #7b5cf0', mint: '3px solid #22c08a',
    gradient: '3px solid #7b5cf0;outline:2px solid #22c08a;outline-offset:-5px', glow: '3px solid #34e0a1;box-shadow:0 0 22px #34e0a1',
  };
  const FILTER_LABELS = { none: 'None', warm: 'Warm', cool: 'Cool', bw: 'Black & white', vivid: 'Vivid', soft: 'Soft', film: 'Film' };
  const SHAPE_LABELS = { circle: 'Circle', squircle: 'Squircle', portrait: 'Portrait', landscape: 'Landscape' };
  const FRAME_LABELS = { ring: 'White ring', none: 'None', purple: 'Purple', mint: 'Mint', gradient: 'Gradient', glow: 'Glow' };

  // Pen colours are content (what ends up in the video), not UI chrome, so they live here rather than in the skin.
  const PEN_COLORS = ['#ff5a7a', '#ffd23f', '#34e0a1', '#4ea8ff', '#ffffff', '#7b5cf0'];
  const ANNOTATE_COLORS = ['#ff3b5c', '#ffb020', '#22c08a', '#3b82f6', '#7b5cf0', '#111111', '#ffffff'];

  // Width x height of the bubble in screen points for a given size setting.
  function bubbleDims(shape, size) {
    switch (shape) {
      case 'portrait': return [Math.round(size * 0.78), Math.round(size * 1.2)];
      case 'landscape': return [Math.round(size * 2), Math.round(size * 1.125)]; // exactly 16:9, the camera's own shape: 520 x 293 at M, nothing cropped, the widest view of the room
      default: return [size, size]; // circle, squircle
    }
  }
  // Corner radius as a fraction of the shorter side (circle = 0.5)
  const cornerRadius = (shape) => (shape === 'circle' ? 0.5 : shape === 'squircle' ? 0.32 : 0.1);

  // ---- recording quality ----
  // "source" keeps the native capture size. Scaling only ever happens in the composite step, never while recording.
  const QUALITIES = [
    { key: 'source', label: 'Source (native)', height: null },
    { key: '4k', label: '4K', height: 2160 },
    { key: '1440p', label: '1440p', height: 1440 },
    { key: '1080p', label: '1080p', height: 1080 },
    { key: '720p', label: '720p', height: 720 },
  ];
  const DEFAULT_QUALITY = 'source';
  const qualityHeight = (key) => (QUALITIES.find((q) => q.key === key) || QUALITIES[0]).height;

  // MediaRecorder intermediates: very high bitrate so the single lossy encode at export is the only visible one.
  const screenBitrate = (nativeHeight) => (nativeHeight >= 1440 ? 25e6 : 16e6);
  const camSize = (nativeHeight) => (nativeHeight >= 1440 ? { width: 1920, height: 1080 } : { width: 1280, height: 720 });
  const CAM_BITRATE = 8e6;
  const AUDIO_BITRATE = 160e3;
  const SCREEN_FPS = 60;
  const CURSOR_HZ = 60;

  // MediaRecorder formats, best first. Segment files are written as screen_N.<ext> / cam_N.<ext>.
  const MIME_PREFERENCE = [
    { mime: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4' },
    { mime: 'video/mp4;codecs=avc1', ext: 'mp4' },
    { mime: 'video/webm;codecs=h264,opus', ext: 'webm' },
    { mime: 'video/webm;codecs=h264', ext: 'webm' },
    { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' },
  ];

  // ---- file names inside a video folder ----
  const FILES = {
    timeline: 'timeline.json', original: 'original.mp4', video: 'video.mp4', thumb: 'thumb.jpg', gif: 'preview.gif', image: 'image.png',
    screen: (n, ext) => `screen_${n}.${ext}`, cam: (n, ext) => `cam_${n}.${ext}`,
  };

  const LIBRARY_STATUS = { RECORDING: 'recording', PROCESSING: 'processing', READY: 'ready', FAILED: 'failed' };

  return {
    PORT, SHAPES, FILTER_KEYS, FRAME_KEYS, BUBBLE_SIZES, FILTER_CSS, FRAME_CSS, FILTER_LABELS, SHAPE_LABELS, FRAME_LABELS, PEN_COLORS, ANNOTATE_COLORS, bubbleDims, cornerRadius,
    QUALITIES, DEFAULT_QUALITY, qualityHeight, screenBitrate, camSize, CAM_BITRATE, AUDIO_BITRATE, SCREEN_FPS, CURSOR_HZ, MIME_PREFERENCE, FILES, LIBRARY_STATUS,
  };
});
