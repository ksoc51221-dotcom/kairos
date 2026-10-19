// Hand-gesture commands (Phase 8). The recognizer (MediaPipe, in the bubble window) only reports "label + score" a few times a second;
// this file decides when a sign has been HELD long enough to count. Pure on purpose: no timers, no DOM, time comes in with each sample.
// Loaded two ways like constants.js: require() in tests and the main process, <script src> in the bubble window (window.KairosGestures).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KairosGestures = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CFG = {
    holdMs: 1000,      // the same sign must be held this long
    breakMs: 200,      // ...and a gap longer than this restarts the hold
    cooldownMs: 2000,  // after a command fires, signs are ignored for this long
    minScore: 0.6,     // recognizer confidence needed for a sample to count
    hz: 8,             // recognitions per second (5 if frame pacing suffers, see PLAN.md Phase 8)
    maxFrame: 320,     // the recognizer sees a frame at most this wide
  };
  // MediaPipe's canned labels -> what they do. toggle-pause is the same message the ⌥⇧P shortcut sends: the recorder owns the paused state (B9).
  const COMMANDS = { Open_Palm: { control: 'toggle-pause' }, Thumb_Up: { control: 'stop' } };

  const initial = () => ({ label: null, since: 0, lastSeen: 0, lostAt: 0, cooldownUntil: 0 });

  // step(state, { t, label, score }, cfg) -> { state, progress, fire }
  //   t         ms, any monotonic clock
  //   label     recognizer label, or null / 'None' when no hand was seen
  //   progress  0..1, how far the current hold is (drives the ring); 0 when nothing is held or during the cooldown
  //   fire      the label to run as a command, or null
  // The state is returned, never mutated: feed it back in with the next sample.
  // A hold survives a gap of up to breakMs, measured from the last good sample, or from the first bad one after it: at 8 samples a second one
  // missed detection is forgiven (125 ms) and two in a row are not (250 ms).
  function step(state, sample, cfg = CFG) {
    const { t, label, score } = sample, s = state;
    if (t < s.cooldownUntil) return { state: s, progress: 0, fire: null }; // a command just ran: hold to repeat starts only after the cooldown
    const good = !!label && !!COMMANDS[label] && score >= cfg.minScore;
    const alive = !!s.label && t - (s.lostAt || s.lastSeen) <= cfg.breakMs; // is the hold still going at t?
    if (good) {
      if (alive && s.label === label) {
        const progress = (t - s.since) / cfg.holdMs;
        if (progress >= 1) return { state: { ...initial(), cooldownUntil: t + cfg.cooldownMs }, progress: 0, fire: label };
        return { state: { ...s, lastSeen: t, lostAt: 0 }, progress, fire: null };
      }
      return { state: { ...s, label, since: t, lastSeen: t, lostAt: 0 }, progress: 0, fire: null }; // a new sign, or the old one after a break: the clock restarts
    }
    // not a usable sample (no hand, low score, another sign)
    if (alive) return { state: s.lostAt ? s : { ...s, lostAt: t }, progress: Math.min(0.999, (t - s.since) / cfg.holdMs), fire: null };
    return { state: { ...s, label: null, since: 0, lastSeen: 0, lostAt: 0 }, progress: 0, fire: null };
  }

  return { CFG, COMMANDS, initial, step };
});
