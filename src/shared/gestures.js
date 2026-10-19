// Hand-gesture commands (Phase 8). The recognizer (MediaPipe, in the bubble window) only reports "label + score" a few times a second;
// this file decides when a sign has been HELD long enough to count. Pure on purpose: no timers, no DOM, time comes in with each sample.
// Loaded two ways like constants.js: require() in tests and the main process, <script src> in the bubble window (window.KairosGestures).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KairosGestures = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CFG = {
    holdMs: 1000,      // default hold: the same sign must be held this long (a command can set its own)
    breakMs: 450,      // a gap in the sign shorter than this is forgiven: 3 missed samples in a row at 8 a second (real hands flicker)
    cooldownMs: 1500,  // after a command fires, signs are ignored for this long
    releaseMs: 800,    // ...and the sign that fired must be let go (hand down, or another sign) this long before it can fire again
    minScore: 0.5,     // default confidence needed for a sample to count (a command can set its own)
    hz: 8,             // recognitions per second (5 if frame pacing suffers, see PLAN.md Phase 8)
    maxFrame: 320,     // the recognizer sees a frame at most this wide
  };
  // MediaPipe's canned labels -> what they do. toggle-pause is the same message the ⌥⇧P shortcut sends: the recorder owns the paused state (B9).
  // Numbers come from a real recording (Phase 8 follow-up): an open palm scores 0.53-0.78 (mean 0.66), a closed fist 0.71-0.88, so the palm
  // bar is low; the fist stops the recording, so it needs a clearer score and a longer hold.
  const COMMANDS = {
    Open_Palm: { control: 'toggle-pause', holdMs: 1000, minScore: 0.5 },
    Closed_Fist: { control: 'stop', holdMs: 1500, minScore: 0.6 },
  };

  const initial = () => ({ label: null, since: 0, lastSeen: 0, lostAt: 0, cooldownUntil: 0, lock: null, freeSince: 0 });
  const holdOf = (label, cfg) => (COMMANDS[label] && COMMANDS[label].holdMs) || cfg.holdMs;

  // step(state, { t, label, score }, cfg) -> { state, progress, fire, seen }
  //   t         ms, any monotonic clock
  //   label     recognizer label, or null / undefined when no hand was seen
  //   progress  0..1, how far the current hold is (drives the ring); 0 when nothing is held, during the cooldown, and while a fired sign is locked
  //   fire      the label to run as a command, or null
  //   seen      the command sign being held right now (drives the "hold to pause" hint), or null
  // The state is returned, never mutated: feed it back in with the next sample.
  // A hold survives a gap of up to breakMs, measured from the last good sample, or from the first bad one after it.
  function step(state, sample, cfg = CFG) {
    const { t, label, score } = sample, cmd = label ? COMMANDS[label] : null;
    const good = !!cmd && score >= (cmd.minScore ?? cfg.minScore);
    let s = state;
    // a sign that just fired stays locked until it has been let go for releaseMs: a hand left up must not flip pause / resume every few seconds
    if (s.lock) {
      if (good && label === s.lock) { if (s.freeSince) s = { ...s, freeSince: 0 }; }
      else if (!s.freeSince) s = { ...s, freeSince: t };
      else if (t - s.freeSince >= cfg.releaseMs) s = { ...s, lock: null, freeSince: 0 };
    }
    if (t < s.cooldownUntil || (good && label === s.lock)) return { state: s.label ? { ...s, label: null, since: 0, lastSeen: 0, lostAt: 0 } : s, progress: 0, fire: null, seen: null };
    const alive = !!s.label && t - (s.lostAt || s.lastSeen) <= cfg.breakMs; // is the hold still going at t?
    if (good) {
      if (alive && s.label === label) {
        const progress = (t - s.since) / holdOf(label, cfg);
        if (progress >= 1) return { state: { ...initial(), cooldownUntil: t + cfg.cooldownMs, lock: label }, progress: 0, fire: label, seen: null };
        return { state: { ...s, lastSeen: t, lostAt: 0 }, progress, fire: null, seen: label };
      }
      return { state: { ...s, label, since: t, lastSeen: t, lostAt: 0 }, progress: 0, fire: null, seen: label }; // a new sign, or the old one after a break: the clock restarts
    }
    // not a usable sample (no hand, low score, another sign)
    if (alive) return { state: s.lostAt ? s : { ...s, lostAt: t }, progress: Math.min(0.999, (t - s.since) / holdOf(s.label, cfg)), fire: null, seen: s.label };
    return { state: { ...s, label: null, since: 0, lastSeen: 0, lostAt: 0 }, progress: 0, fire: null, seen: null };
  }

  return { CFG, COMMANDS, initial, step };
});
