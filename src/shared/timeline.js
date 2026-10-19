// The recording timeline: what the composite step and the player need to rebuild the video from separate tracks.
// Pure data logic with no clocks of its own (callers pass timestamps in ms), so it is unit-tested without Electron.
// Loaded two ways: require() in Node tests/pipeline, <script src> in the recorder window (as window.HermesTimeline).
//
// "t" everywhere is seconds on the *recorded* timeline: pauses do not count, and a Live Rewind removes what came after.
// timeline.json shape (version 2):
//   segments [{ n, t0, dur, screen?, cam? }]            one pair of files per pause/resume segment
//   bubble   [[t, x, y, w, h, shape, filter, frame, visible]]   camera bubble keyframes, x/y/w/h as fractions
//   cursor   [[t, x, y]]  at ~60 Hz, x/y as fractions of the captured display
//   clicks   [[t, x, y, button]]
//   drawing  [[t, on]]    pen overlay switched on (1) or off (0)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HermesTimeline = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const r4 = (n) => Math.round(n * 10000) / 10000;
  const sameStyle = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  class Timeline {
    constructor(meta = {}) { this.meta = { version: 2, ...meta }; this.reset(); }

    reset() {
      this.segments = []; this.cur = null; this.base = 0; this.nextN = 0;
      this.bubble = []; this.cursor = []; this.clicks = []; this.drawing = [];
    }

    get recording() { return !!this.cur; }
    get segmentNumber() { return this.cur ? this.cur.n : null; }
    // total recorded seconds so far, as of nowMs
    duration(nowMs) { return this.t(nowMs); }
    t(nowMs) { return this.cur ? this.base + Math.max(0, (nowMs - this.cur.startMs) / 1000) : this.base; }

    // ---- segments ----
    start(nowMs) {
      if (this.cur) return this.cur.n;
      const n = this.nextN++;
      this.cur = { n, t0: this.base, startMs: nowMs };
      return n;
    }
    stop(nowMs) {
      if (!this.cur) return null;
      const dur = Math.max(0, (nowMs - this.cur.startMs) / 1000);
      const seg = { n: this.cur.n, t0: r3(this.cur.t0), dur: r3(dur) };
      this.segments.push(seg); this.base += dur; this.cur = null;
      return seg;
    }

    // ---- events: ignored unless a segment is running and the event happened after it started ----
    addCursor(atMs, x, y) {
      if (!this.cur || atMs < this.cur.startMs) return false;
      this.cursor.push([r3(this.t(atMs)), r4(x), r4(y)]); return true;
    }
    addClick(atMs, x, y, button) {
      if (!this.cur || atMs < this.cur.startMs) return false;
      this.clicks.push([r3(this.t(atMs)), r4(x), r4(y), button | 0]); return true;
    }
    addDrawing(atMs, on) {
      const t = this.cur ? this.t(atMs) : this.base;
      this.drawing.push([r3(t), on ? 1 : 0]); return true;
    }
    // Bubble keyframe, written on every move, resize, style change or camera toggle. Duplicates are skipped.
    setBubble(atMs, b) {
      const t = this.cur ? this.t(atMs) : this.base;
      const row = [r3(t), r4(b.x), r4(b.y), r4(b.w), r4(b.h), b.shape, b.filter, b.frame, b.visible === false ? 0 : 1];
      const last = this.bubble[this.bubble.length - 1];
      if (last && sameStyle(last.slice(1), row.slice(1))) return false;
      if (last && last[0] === row[0]) this.bubble[this.bubble.length - 1] = row; else this.bubble.push(row);
      return true;
    }

    // Live Rewind: keep only the first `t` seconds, then recording continues from there. Call while paused.
    // Returns the numbers of segments that no longer contribute (their files can be deleted).
    rewind(t) {
      if (this.cur) throw new Error('rewind needs the recording to be paused');
      t = Math.max(0, Math.min(t, this.base));
      const kept = [], dropped = [];
      for (const s of this.segments) (s.t0 < t - 0.05 ? kept : dropped).push(s);
      const last = kept[kept.length - 1];
      if (last) last.dur = r3(Math.min(last.dur, t - last.t0));
      this.segments = kept; this.base = t;
      this.cursor = this.cursor.filter((p) => p[0] <= t);
      this.clicks = this.clicks.filter((c) => c[0] <= t);
      this.drawing = this.drawing.filter((d) => d[0] <= t);
      this.bubble = this.bubble.filter((k) => k[0] <= t);
      return dropped.map((s) => s.n);
    }

    totalDuration() { return r3(this.segments.reduce((a, s) => a + s.dur, 0)); }

    // Serialisable form. `files` maps segment number -> { screen, cam } file names.
    toJSON(files = {}) {
      return {
        ...this.meta,
        duration: this.totalDuration(),
        segments: this.segments.map((s) => ({ ...s, ...(files[s.n] || {}) })),
        bubble: this.bubble, cursor: this.cursor, clicks: this.clicks, drawing: this.drawing,
      };
    }
  }

  return { Timeline };
});
