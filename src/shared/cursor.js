// Pure helpers for the 60 Hz cursor feed: no Electron, no clock of their own, so they are unit-tested.
// Loaded with require() in the main process (as window.HermesCursor it would work in a renderer too).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HermesCursor = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Decides which samples reach timeline.json.
  //   moving   every tick is kept (that is the 60 Hz feed)
  //   still    one sample every keepaliveMs, so the player always has a recent point to interpolate from
  //   a move that starts after a still spell first emits the last still sample, so playback does not glide before the move begins
  // push(at, x, y) returns the samples to store, as [at, x, y] rows: none, one, or two.
  function makeFilter({ keepaliveMs = 200 } = {}) {
    let last = null, held = null, storedAt = -Infinity;
    return function push(at, x, y) {
      const out = [];
      if (!last || x !== last[0] || y !== last[1]) {
        if (held) { out.push(held); held = null; }
        out.push([at, x, y]); storedAt = at;
      } else if (at - storedAt >= keepaliveMs) { out.push([at, x, y]); storedAt = at; held = null; }
      else held = [at, x, y];
      last = [x, y];
      return out;
    };
  }

  // A drift-corrected timer: tick n aims at t0 + n × period, so one late tick does not push every later tick back.
  // `st` is { t0, n } (mutated). Returns the delay in ms until the next tick. When far behind (a stalled process) it skips ahead
  // to the next slot instead of firing a burst of catch-up ticks.
  function nextDelay(st, now, period) {
    st.n++;
    let wait = st.t0 + st.n * period - now;
    if (wait < -2 * period) { st.n = Math.ceil((now - st.t0) / period); wait = st.t0 + st.n * period - now; }
    return Math.max(0, wait);
  }

  return { makeFilter, nextDelay };
});
