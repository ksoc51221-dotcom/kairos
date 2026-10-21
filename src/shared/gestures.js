// Hand-sign commands (Phase 8, extended in the follow-up). The recognizer (MediaPipe, in the bubble window) reports a canned label + score and 21 landmarks a
// few times a second. This file turns that into "which command is this hand asking for" (classify), decides when a sign has been HELD long enough to count
// (step), and holds what is needed to teach Kairos a person's own sign (features, teachStep, conflict, sketch). Pure on purpose: no timers, no DOM,
// time comes in with each sample.
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
  // The commands a hand can give. `control` is what main does with it: toggle-pause is the same message the ⌥⇧P shortcut sends (the recorder owns the
  // paused state, B9), stop is ⌥⇧S, zoom-in and zoom-out are handled in the bubble (the camera zoom, shared/zoom.js). The Exit zoom button also goes back.
  // `continuous` = the sign is not a one-off: it never fires. After holdMs of it the bubble starts doing the thing and keeps doing it for as long as the
  // sign is held (zoom: the picture goes in slowly, the longer the hold the deeper; zoom out: it comes back out, faster).
  // `twoHands` = the default sign needs both hands (an X of the two index fingers), so a single hand never matches it (only a sign the person taught can).
  // Numbers come from a real recording (Phase 8 follow-up): an open palm scores 0.53-0.78 (mean 0.66), a closed fist 0.71-0.88, so the palm bar is
  // low. A stop ends the recording, so it needs a clearer score and the longest hold (2 s).
  const COMMANDS = {
    pause: { control: 'toggle-pause', holdMs: 1000, minScore: 0.5 },
    stop: { control: 'stop', holdMs: 2000, minScore: 0.6 },
    zoom: { control: 'zoom-in', continuous: true, holdMs: 400, minScore: 0.5 },
    zoomout: { control: 'zoom-out', continuous: true, holdMs: 400, minScore: 0.5, twoHands: true },
  };
  // The sign each command answers to until the person teaches their own: MediaPipe's canned labels for palm and fist, and a rule on the landmarks
  // for crossed fingers and for the two-hand X (MediaPipe has no label for either).
  const DEFAULT_SIGN = { pause: 'Open_Palm', stop: 'Closed_Fist', zoom: 'crossed', zoomout: 'cross-x' };
  const NAMES = { pause: 'Pause', stop: 'Stop', zoom: 'Zoom in', zoomout: 'Zoom out' };

  // ---------------- the shape of a hand ----------------
  // 32 numbers that describe a hand pose and do not change when the hand is turned, mirrored or is nearer to the camera: the bend of every finger joint
  // (as a fraction of a half turn), how far each tip is from the wrist, and how far the tips (and thumb) are from each other, all in palm sizes.
  // They come from the world landmarks (metres, 3-D), so a hand tilted towards the camera reads the same as a flat one.
  const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]; // thumb, index, middle, ring, pinky: base to tip
  const TIPS = [4, 8, 12, 16, 20];
  const pts = (list) => list.map((p) => (Array.isArray(p) ? p : [p.x, p.y, p.z || 0]));
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const bend = (a, b) => Math.acos(clamp(dot(a, b) / (len(a) * len(b) || 1), -1, 1)) / Math.PI; // 0 = straight on, 1 = folded back
  const palmSize = (p) => (len(sub(p[5], p[0])) + len(sub(p[9], p[0])) + len(sub(p[13], p[0])) + len(sub(p[17], p[0]))) / 4 || 1e-6;
  const r3 = (n) => Math.round(n * 1000) / 1000;

  function features(worldLandmarks) {
    const p = pts(worldLandmarks), P = palmSize(p), f = [];
    for (const [a, b, c, d] of FINGERS) f.push(bend(sub(p[a], p[0]), sub(p[b], p[a])), bend(sub(p[b], p[a]), sub(p[c], p[b])), bend(sub(p[c], p[b]), sub(p[d], p[c])));
    for (const fi of FINGERS) f.push(len(sub(p[fi[3]], p[0])) / P);
    for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) f.push(len(sub(p[TIPS[i]], p[TIPS[j]])) / P);
    f.push(len(sub(p[4], p[5])) / P, len(sub(p[4], p[9])) / P);
    return f;
  }
  const dist = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) / a.length); // root-mean-square difference
  const mean = (list) => list[0].map((_, i) => list.reduce((s, v) => s + v[i], 0) / list.length);
  // A taught sign is matched inside this radius of its template(s). Measured on a real hand: an open palm held for 30 s drifts up to 0.17 from the pose it
  // started in (fingers relax and spread), the same pose re-formed a few seconds later is 0.03 away, a fist and a thumb up are 0.15 apart. The score is
  // 1 on a template, 0.5 at the radius, 0 beyond twice the radius, so a command's minScore works for taught signs as it does for MediaPipe's own.
  const RADIUS = 0.18;
  const matchScore = (f, templates, r = RADIUS) => Math.max(...templates.map((t) => clamp(1 - dist(f, t) / (2 * r), 0, 1)));

  // Index and middle finger up and together (or crossed), ring and pinky curled. Measured on a real hand: a finger that is up has its tip more than 1.5 palm
  // sizes from the wrist, a curled one under 1.25. `rho` compares how far apart the two tips are with how far apart their knuckles are: 1 = parallel, 0 =
  // touching, below 0 = crossed over. A spread peace sign has rho above 1 and does not count. NOT validated on a live camera yet: MediaPipe may
  // read crossed fingers as two fingers side by side, which this accepts too.
  function crossedScore(worldLandmarks) {
    const p = pts(worldLandmarks), P = palmSize(p), ext = (tip) => len(sub(p[tip], p[0])) / P;
    const B = sub(p[5], p[9]), rho = dot(sub(p[8], p[12]), B) / (dot(B, B) || 1e-9);
    const m = Math.min((ext(8) - 1.5) / 0.3, (ext(12) - 1.5) / 0.3, (1.3 - ext(16)) / 0.3, (1.3 - ext(20)) / 0.3, (0.6 - rho) / 0.4); // 0 on every limit, 1 well inside
    return clamp(0.5 + 0.5 * m, 0, 1);
  }
  // where the hand points: between the index and middle fingertips, as fractions of the raw (unmirrored) camera frame
  const tipPoint = (lm) => { const a = pts(lm); return { x: (a[8][0] + a[12][0]) / 2, y: (a[8][1] + a[12][1]) / 2 }; };

  // The zoom-out sign: both hands show the index finger out and the other three curled, and the two index fingers cross, an X. Measured on a real pair of
  // hands (one in front of the other, the tips crossing, eight recognitions in a row): the index tips are 1.7-1.8 palm sizes from the wrist, the other
  // fingers 0.6-1.05; in the picture the fingers cross at 60-130% of their length (MediaPipe often puts one fingertip right on the other finger) at about a
  // right angle. A two-finger peace sign in each hand (the middle finger is out too) and two palms are nothing like it. `ar` = frame width / height, so the
  // angle in the picture is true. Score 0.5 on every limit, 1 well inside, like crossedScore. Needs the image landmarks (to see the cross) and the world
  // landmarks (to see which fingers are out) of both hands.
  const pointing = (wl) => { const p = pts(wl), P = palmSize(p), ext = (tip) => len(sub(p[tip], p[0])) / P; return Math.min((ext(8) - 1.5) / 0.3, (1.35 - ext(12)) / 0.3, (1.35 - ext(16)) / 0.3, (1.35 - ext(20)) / 0.3); };
  function crossX(a, b, ar) {
    const A = pts(a.lm), B = pts(b.lm), d1 = [(A[8][0] - A[5][0]) * ar, A[8][1] - A[5][1]], d2 = [(B[8][0] - B[5][0]) * ar, B[8][1] - B[5][1]];
    const den = d1[0] * d2[1] - d1[1] * d2[0], l1 = Math.hypot(d1[0], d1[1]), l2 = Math.hypot(d2[0], d2[1]);
    if (l1 < 1e-6 || l2 < 1e-6 || Math.abs(den) < 1e-9) return 0; // a finger with no length, or two that point the same way: they never cross
    const w = [(B[5][0] - A[5][0]) * ar, B[5][1] - A[5][1]];
    const u = (w[0] * d2[1] - w[1] * d2[0]) / den, v = (w[0] * d1[1] - w[1] * d1[0]) / den; // where along each index finger (knuckle 0 .. tip 1) the two lines meet
    const inside = (x) => Math.min((x - 0.1) / 0.2, (1.4 - x) / 0.2), turn = (Math.abs(den) / (l1 * l2) - 0.4) / 0.2; // meets on both fingers (a little past the tip is fine); at least ~25 degrees apart
    return clamp(0.5 + 0.5 * Math.min(pointing(a.wl), pointing(b.wl), inside(u), inside(v), turn), 0, 1);
  }
  // crossXScore(hands, ar) -> the best X score of any two of the hands (each { lm, wl }), 0 when fewer than two hands have both kinds of landmarks
  function crossXScore(hands, ar = 16 / 9) {
    const hs = (hands || []).filter((h) => h && h.lm && h.lm.length >= 21 && h.wl && h.wl.length >= 21);
    let best = 0;
    for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) best = Math.max(best, crossX(hs[i], hs[j], ar));
    return best;
  }

  // classify(hand, signs) -> { id, score, at } | null
  //   hand   { label, score, lm, wl }: one recognizer result. label/score = MediaPipe's own top gesture, lm = 21 image landmarks (x, y as fractions of
  //          the raw frame), wl = 21 world landmarks. Any of them may be missing.
  //   signs  { pause?: { ex }, stop?: { ex }, zoom?: { ex } }: the person's own signs (ex = their templates, each the 32 numbers). A command without
  //          one answers to its default sign.
  // Returns the command this hand is asking for with a 0..1 score, or null. When two commands qualify the better score wins.
  function classify(hand, signs = {}) {
    if (!hand) return null;
    const f = hand.wl && hand.wl.length >= 21 ? features(hand.wl) : null;
    let best = null;
    for (const id of Object.keys(COMMANDS)) {
      const own = signs && signs[id] && signs[id].ex;
      let score = 0;
      if (own) score = f ? matchScore(f, own) : 0;
      else if (COMMANDS[id].twoHands) score = 0; // the default needs both hands: crossXScore
      else if (id === 'zoom') score = f ? crossedScore(hand.wl) : 0;
      else score = hand.label === DEFAULT_SIGN[id] ? hand.score || 0 : 0;
      if (score >= COMMANDS[id].minScore && (!best || score > best.score)) best = { id, score };
    }
    if (best && hand.lm && hand.lm.length >= 21) best.at = tipPoint(hand.lm);
    return best;
  }
  // pick(hands, signs, prefer) -> { hand, c }: with two hands in view, the one that asks for a command (the better score wins; `prefer` = the command already being
  // held always wins, so the hold does not jump between hands), else the first hand with c = null
  function pick(hands, signs = {}, prefer = null) {
    let best = null;
    for (const h of hands || []) {
      const c = classify(h, signs), rank = c ? c.score + (c.id === prefer ? 1 : 0) : -1;
      if (c && (!best || rank > best.rank)) best = { hand: h, c, rank };
    }
    return best ? { hand: best.hand, c: best.c } : { hand: (hands && hands[0]) || null, c: null };
  }

  // ---------------- holding a sign ----------------
  const initial = () => ({ label: null, since: 0, lastSeen: 0, lostAt: 0, cooldownUntil: 0, lock: null, freeSince: 0, at: null });
  const holdOf = (label, cfg) => (COMMANDS[label] && COMMANDS[label].holdMs) || cfg.holdMs;

  // step(state, { t, label, score, at }, cfg) -> { state, progress, fire, seen, at, held }
  //   t         ms, any monotonic clock
  //   label     the command being shown (a key of COMMANDS, from classify), or null / undefined when no sign was seen
  //   at        where the hand points, if the caller wants it back (the zoom sign picks the area with it)
  //   progress  0..1, how far the current hold is (drives the ring); 0 when nothing is held, during the cooldown, while a fired sign is locked, and for a
  //             continuous sign (zoom) once it has been held long enough to start
  //   fire      the command to run, or null (never for a continuous sign)
  //   seen      the command sign being held right now (drives the "hold to pause" hint), or null
  //   at        (out) the position at the latest good sample, with `seen` and `fire`
  //   held      ms the sign in `seen` has been held (0 without one); a continuous sign is under way once held >= its holdMs
  // The state is returned, never mutated: feed it back in with the next sample.
  // A hold survives a gap of up to breakMs, measured from the last good sample, or from the first bad one after it.
  function step(state, sample, cfg = CFG) {
    const r = stepCore(state, sample, cfg);
    return { ...r, held: r.seen ? Math.max(0, sample.t - r.state.since) : 0 };
  }
  function stepCore(state, sample, cfg) {
    const { t, label, score, at = null } = sample, cmd = label ? COMMANDS[label] : null;
    const good = !!cmd && score >= (cmd.minScore ?? cfg.minScore);
    let s = state;
    // a sign that just fired stays locked until it has been let go for releaseMs: a hand left up must not flip pause / resume every few seconds
    if (s.lock) {
      if (good && label === s.lock) { if (s.freeSince) s = { ...s, freeSince: 0 }; }
      else if (!s.freeSince) s = { ...s, freeSince: t };
      else if (t - s.freeSince >= cfg.releaseMs) s = { ...s, lock: null, freeSince: 0 };
    }
    if (t < s.cooldownUntil || (good && label === s.lock)) return { state: s.label ? { ...s, label: null, since: 0, lastSeen: 0, lostAt: 0 } : s, progress: 0, fire: null, seen: null, at: null };
    const alive = !!s.label && t - (s.lostAt || s.lastSeen) <= cfg.breakMs; // is the hold still going at t?
    if (good) {
      if (alive && s.label === label) {
        const progress = (t - s.since) / holdOf(label, cfg);
        if (progress >= 1) {
          if (cmd.continuous) return { state: { ...s, lastSeen: t, lostAt: 0, at }, progress: 0, fire: null, seen: label, at }; // under way, and stays so while it is held
          return { state: { ...initial(), cooldownUntil: t + cfg.cooldownMs, lock: label }, progress: 0, fire: label, seen: null, at };
        }
        return { state: { ...s, lastSeen: t, lostAt: 0, at }, progress, fire: null, seen: label, at };
      }
      return { state: { ...s, label, since: t, lastSeen: t, lostAt: 0, at }, progress: 0, fire: null, seen: label, at }; // a new sign, or the old one after a break: the clock restarts
    }
    // not a usable sample (no hand, low score, another sign)
    if (alive) {
      const p = (t - s.since) / holdOf(s.label, cfg);
      return { state: s.lostAt ? s : { ...s, lostAt: t }, progress: COMMANDS[s.label].continuous && p >= 1 ? 0 : Math.min(0.999, p), fire: null, seen: s.label, at: s.at };
    }
    return { state: { ...s, label: null, since: 0, lastSeen: 0, lostAt: 0, at: null }, progress: 0, fire: null, seen: null, at: null };
  }

  // ---------------- teaching a sign ----------------
  // The person shows the sign to the camera and holds it still, lowers the hand, and shows it again. Only the numbers of the two poses are kept, never the
  // picture. The second take is a check (a sign that cannot be made twice the same would not work later either) and a second template.
  const TEACH = {
    frames: 8,        // this many recognitions in a row (one second) must agree...
    steady: 0.08,     // ...each within this distance of their average (a steady hand wobbles 0.01-0.05)
    same: 0.15,       // the two takes must be this close (the same pose re-formed measured 0.03-0.14)
    apart: 0.2,       // between takes the hand must go away (or change this much) for awayFrames recognitions
    awayFrames: 3,
    conflict: 0.25,   // a new sign closer than this to another command's sign is refused (a thumb up is 0.15 from a fist)
    timeoutMs: 40000, // give up after this long without two matching takes
    minHand: 0.15,    // the hand must be at least this tall in the frame (as a fraction), or its landmarks are too coarse to trust
  };
  // Reference poses measured on a real hand (palm and closed fist): what the DEFAULT pause and stop signs look like, for the conflict check.
  const REF = {
    pause: [0.053, 0.059, 0.102, 0.099, 0.044, 0.217, 0.052, 0.123, 0.053, 0.035, 0.089, 0.029, 0.094, 0.085, 0.113, 1.39, 1.828, 2.009, 1.868, 1.558, 0.981, 1.305, 1.359, 1.389, 0.344, 0.471, 0.764, 0.283, 0.706, 0.44, 0.611, 0.854],
    stop: [0.084, 0.164, 0.117, 0.324, 0.504, 0.224, 0.324, 0.487, 0.362, 0.402, 0.447, 0.309, 0.36, 0.372, 0.41, 1.374, 0.87, 0.766, 0.702, 0.779, 0.522, 0.662, 0.827, 0.919, 0.228, 0.405, 0.554, 0.191, 0.345, 0.173, 0.483, 0.674],
  };

  // teachStep(buf, f) -> { buf, progress, done }
  //   f      this recognition's 32 numbers, or null when no hand was seen
  // Feed one per recognition. The capture is done (done = the averaged 32 numbers) when the last TEACH.frames agree; a hand that moves restarts it.
  function teachStep(buf, f) {
    if (!f) return { buf: [], progress: 0, done: null };
    let next = [...buf, f].slice(-TEACH.frames);
    const m = mean(next);
    if (Math.max(...next.map((x) => dist(x, m))) > TEACH.steady) next = [f]; // it moved: start again from this one
    if (next.length < TEACH.frames) return { buf: next, progress: next.length / TEACH.frames, done: null };
    return { buf: [], progress: 1, done: mean(next).map(r3) };
  }
  // The whole teach flow as a state machine: first take -> hand away -> second take -> done.
  //   teach(state, { t, f }) -> { state, progress, prompt, done, fail }
  //   prompt  what to tell the person: show | hold | lower | again | different (the takes did not match, starting over) | done | timeout
  //   done    [take 1, take 2] when finished, else null;  fail  'timeout' when it gave up, else null
  const teachInitial = (t) => ({ phase: 'first', buf: [], first: null, away: 0, t0: t });
  function teach(state, { t, f }) {
    if (t - state.t0 > TEACH.timeoutMs) return { state, progress: 0, prompt: 'timeout', done: null, fail: 'timeout' };
    if (state.phase === 'away') {
      const away = !f || dist(f, state.first) > TEACH.apart ? state.away + 1 : 0;
      if (away >= TEACH.awayFrames) return { state: { ...state, phase: 'second', buf: [], away: 0 }, progress: 0, prompt: 'again', done: null, fail: null };
      return { state: { ...state, away }, progress: 0, prompt: 'lower', done: null, fail: null };
    }
    const r = teachStep(state.buf, f), asking = state.phase === 'first' ? 'show' : 'again';
    if (!r.done) return { state: { ...state, buf: r.buf }, progress: r.progress, prompt: f ? 'hold' : asking, done: null, fail: null };
    if (state.phase === 'first') return { state: { ...state, phase: 'away', buf: [], first: r.done, away: 0 }, progress: 1, prompt: 'lower', done: null, fail: null };
    if (dist(r.done, state.first) > TEACH.same) return { state: teachInitial(state.t0), progress: 0, prompt: 'different', done: null, fail: null };
    return { state, progress: 1, prompt: 'done', done: [state.first, r.done], fail: null };
  }
  // conflict(id, wl, signs) -> the other command whose sign this hand pose could be mistaken for, or null
  function conflict(id, worldLandmarks, signs = {}) {
    const f = features(worldLandmarks);
    for (const other of Object.keys(COMMANDS)) {
      if (other === id) continue;
      const own = signs && signs[other] && signs[other].ex;
      if (own) { if (own.some((t) => dist(f, t) < TEACH.conflict)) return other; }
      else if (other === 'zoom') { if (crossedScore(worldLandmarks) >= COMMANDS.zoom.minScore) return other; }
      else if (REF[other] && dist(f, REF[other]) < TEACH.conflict) return other; // (the two-hand X has no single-hand pose to clash with)
    }
    return null;
  }
  // How tall the hand is in the frame, 0..1 (image landmarks).
  const handHeight = (lm) => { const ys = pts(lm).map((p) => p[1]); return Math.max(...ys) - Math.min(...ys); };
  // The hand fully inside the frame (with a small margin): a hand cut off by the edge has landmarks that are guesses.
  const handInside = (lm, margin = 0.02) => pts(lm).every((p) => p[0] >= margin && p[0] <= 1 - margin && p[1] >= margin && p[1] <= 1 - margin);

  // A small drawing of a hand for the settings panel: 21 points [x, y], the wrist at (0, 0) and the middle knuckle straight above it at (0, -1),
  // as seen in the mirrored preview. Only the pose, no picture of the person.
  function sketch(worldLandmarks) {
    const p = pts(worldLandmarks), o = p[0], v = [p[9][0] - o[0], p[9][1] - o[1]], L = Math.hypot(v[0], v[1]) || 1;
    const th = Math.atan2(v[0], -v[1]), c = Math.cos(-th), s = Math.sin(-th); // turn the hand so the middle knuckle points up
    return p.map((q) => { const x = q[0] - o[0], y = q[1] - o[1]; return [-Math.round(((x * c - y * s) / L) * 100) / 100 || 0, Math.round(((x * s + y * c) / L) * 100) / 100 || 0]; });
  }

  return { CFG, COMMANDS, DEFAULT_SIGN, NAMES, TEACH, REF, RADIUS, initial, step, classify, pick, features, matchScore, crossedScore, crossXScore, tipPoint, teachStep, teachInitial, teach, conflict, handHeight, handInside, sketch, dist };
});
