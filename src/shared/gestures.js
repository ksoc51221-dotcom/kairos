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
    breakMs: 450,      // a gap in the sign shorter than this is forgiven: 3 missed samples in a row at 7-8 a second (real hands flicker); a command can set its own
    cooldownMs: 1500,  // after a command fires, signs are ignored for this long
    releaseMs: 800,    // ...and the sign that fired must be let go (hand down, or another sign) this long before it can fire again
    minScore: 0.5,     // default confidence needed for a sample to count (a command can set its own)
    roundMs: 60,       // a hold counts as complete when a sample lands within this (at most half a recognition interval) short of holdMs: the nearest sample, not the next one
    hz: 8,             // recognitions per second asked for (the owner's log shows 6-7 in practice, see PLAN.md Phase 8)
    maxFrame: 320,     // the recognizer sees a frame at most this wide
    minDetect: 0.4,    // how sure the recognizer must be that there is a hand (detection, presence, tracking; its default is 0.5)
  };
  // The commands a hand can give. `control` is what main does with it: toggle-pause is the same message the ⌥⇧P shortcut sends (the recorder owns the
  // paused state, B9), stop is ⌥⇧S, zoom-in and zoom-out are handled in the bubble (the camera zoom, shared/zoom.js). The Exit zoom button also goes back.
  // `continuous` = the sign is not a one-off: it never fires. After holdMs of it the bubble starts doing the thing and keeps doing it for as long as the
  // sign is held (zoom: the picture goes in slowly, the longer the hold the deeper; zoom out: it comes back out, faster).
  // `twoHands` = the default sign needs both hands (an X of the two index fingers), so a single hand never matches it (only a sign the person taught can).
  // Optional per command (all in step): `breakMs` a gap forgiven (else CFG.breakMs); `maxGapMs` a longer gap that still does not end the hold, but the time
  // beyond breakMs does not count; `keepScore` the lower bar a sample must reach to CONTINUE a hold that minScore started (only matters when classify passes
  // such samples down); and the guards a one-way command needs: `fresh` the sign must have been gone for longer than a hold can bridge before a hold may
  // start (a fist that is already in view, or never left, is not a stop), `still` how far the hand may move (a fraction of the frame, over the last
  // STILL_MS) for a complete hold to fire, `duty` the share of the looks since the hold began that must show the sign (a bridged gap is forgiven, but a
  // few stray palm-like looks seconds apart are not a hold).
  // Numbers come from a real recording (Phase 8 follow-up): an open palm scores 0.53-0.78 (mean 0.66), a closed fist 0.71-0.88, so the palm bar is
  // low. A stop ends the recording, so it needs a clearer score and its guards, but only the same 1 s hold as pause (it was 2 s).
  const COMMANDS = {
    pause: { control: 'toggle-pause', holdMs: 1000, minScore: 0.5, maxGapMs: 900, duty: 0.5 },
    stop: { control: 'stop', holdMs: 1000, minScore: 0.6, fresh: true, still: 0.1 },
    zoom: { control: 'zoom-in', continuous: true, holdMs: 400, minScore: 0.5 },
    zoomout: { control: 'zoom-out', continuous: true, holdMs: 400, minScore: 0.5, twoHands: true },
  };
  // The sign each command answers to until the person teaches their own: the palm and the fist, read from the landmarks (MediaPipe's label only lifts the
  // palm, and is the fist's last resort when there are no landmarks), and a rule on the landmarks for crossed fingers and for the two-hand X.
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

  // ---------------- the default signs, read from the landmarks ----------------
  // MediaPipe's canned labels are not tilt-proof (a palm turned 30 degrees often comes back "None"), so the palm and the fist are read from the 21 world
  // landmarks, which do not change when the hand is turned, mirrored or nearer. Four numbers per finger (index to pinky, P = palm size) and two for the thumb:
  //   ext  tip to wrist / P: a finger that is out reads 1.5-2.0, a curled one 0.4-1.1
  //   str  tip to knuckle / the length of the finger's three bones: 1 = dead straight, a curled finger reads 0.3-0.6
  //   dip  how far the fingertip joint is folded, a fraction of a half turn (0 = straight)
  //   near the closest the thumb tip gets to the other fingers' middle and tip joints / P: tucked on a fist ~0.2, stuck out (thumb up, palm) over 0.5
  //   gap  index tip to middle tip / P
  const LONG = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]; // index, middle, ring, pinky: knuckle to tip
  const TUCK = [6, 7, 8, 10, 11, 12, 14, 15, 16, 18]; // the joints a thumb lying across a fist touches
  function shape(worldLandmarks) {
    if (!worldLandmarks || worldLandmarks.length < 21) return null;
    const p = pts(worldLandmarks), P = palmSize(p), ext = [], str = [], dip = [];
    for (const [a, b, c, d] of LONG) {
      ext.push(len(sub(p[d], p[0])) / P);
      str.push(len(sub(p[d], p[a])) / (len(sub(p[b], p[a])) + len(sub(p[c], p[b])) + len(sub(p[d], p[c]))));
      dip.push(bend(sub(p[c], p[b]), sub(p[d], p[c])));
    }
    const near = Math.min(...TUCK.map((i) => len(sub(p[4], p[i])) / P)), gap = len(sub(p[8], p[12])) / P;
    return P > 1e-6 && [...ext, ...str, ...dip, near, gap].every(Number.isFinite) ? { ext, str, dip, near, gap } : null; // a hand with no size or a NaN is no hand
  }
  // Every rule is a list of margins m = (value - limit) / width: 0 on the limit, 1 well inside, negative outside. The score is 0.5 + 0.5 * the WORST margin
  // (clamped to 0..1), so a hand scores 0.5 exactly when its worst finger is on a limit, 1 when all are well inside, and a single wrong finger sinks it.
  // The limits sit half way between the poses they must tell apart, measured on the owner's hands and on 3-D hands bent by hand (not fitted to the photos).
  const MARGIN = {
    up: [1.45, 1.55, 1.5, 1.25], upW: 0.18, strUp: 0.8, strUpW: 0.12, // a finger is OUT when its tip is this far from the wrist (the index is the shortest, the middle the longest) and it is this straight
    curl: 1.15, curlW: 0.3, strCu: 0.65, strCuW: 0.18, dipCu: 0.25, dipCuW: 0.1, tuck: 0.32, tuckW: 0.15, // a hand is a FIST when every tip is this close to the wrist, the fingers average this bent, and the thumb is tucked
    fold: 1.2, foldW: 0.3, gap: 0.48, gapW: 0.28, // ring and pinky are folded away (the looser limit: they may sit lower than in a fist); index and middle tips this close (together or crossed; a spread peace sign is 0.8+)
    fistMin: 0.7,     // a fist from the landmarks alone counts only from here (real fists score 0.74-0.98; a palm in warm light, or crossed fingers, were seen at 0.4-0.62)
    floor: 0.15,      // the label may lift a score only if the landmarks do not flatly contradict it (below this the hand is something else)
  };
  const marks = (m) => clamp(0.5 + 0.5 * m, 0, 1);
  const straight = (s, i) => Math.min((s.ext[i] - MARGIN.up[i]) / MARGIN.upW, (s.str[i] - MARGIN.strUp) / MARGIN.strUpW); // margin of finger i being straight out
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const palmOf = (s) => marks(Math.min(straight(s, 0), straight(s, 1), straight(s, 2), straight(s, 3))); // all four fingers out. (The thumb is free: a palm with the thumb in is still a palm.)
  const fistOf = (s) => marks(Math.min(...s.ext.map((e) => (MARGIN.curl - e) / MARGIN.curlW), (MARGIN.strCu - avg(s.str)) / MARGIN.strCuW, (avg(s.dip) - MARGIN.dipCu) / MARGIN.dipCuW, (MARGIN.tuck - s.near) / MARGIN.tuckW));
  const crossedOf = (s) => marks(Math.min(straight(s, 0), straight(s, 1), (MARGIN.fold - s.ext[2]) / MARGIN.foldW, (MARGIN.fold - s.ext[3]) / MARGIN.foldW, (MARGIN.gap - s.gap) / MARGIN.gapW));
  // palmScore / fistScore / crossedScore(worldLandmarks) -> 0..1 how much the landmarks alone look like an open palm / a closed fist / index and middle finger
  // up and together (or crossed) with ring and pinky folded. 0 for a hand that cannot be read. Measured to hold up in-plane tilts of 50 degrees, mirror, and a
  // hand a third of the frame; a thumb stuck out kills the fist, a spread peace sign (V) kills crossed. NOT validated on a live camera yet.
  const palmScore = (wl) => { const s = shape(wl); return s ? palmOf(s) : 0; };
  const fistScore = (wl) => { const s = shape(wl); return s ? fistOf(s) : 0; };
  const crossedScore = (wl) => { const s = shape(wl); return s ? crossedOf(s) : 0; };
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
  // The default palm and fist are read from the world landmarks first (palmOf / fistOf), so a tilted hand still counts; MediaPipe's label then only HELPS the palm:
  // when it says Open_Palm and the landmarks do not flatly contradict it (floor), the score is the better of the two. The fist is landmarks only: a stop ends the
  // recording, and the landmarks alone score 0.6 or more on 99 % of real fists, so the label has nothing to add but the risk of a thumb up or a half closed hand
  // being taken for one. It must also reach fistMin: stop ends the recording, and a warm-lit palm or crossed fingers have read 0.4-0.62. With no usable landmarks the
  // fist is not read at all.
  function defaultScore(id, hand, s) {
    const label = hand.label === DEFAULT_SIGN[id] ? hand.score || 0 : 0;
    if (!s) return id === 'stop' ? 0 : label; // (a stop never rests on the label alone)
    if (id !== 'pause') { const geo = fistOf(s); return geo >= MARGIN.fistMin ? geo : 0; }
    const geo = palmOf(s);
    return label && geo >= MARGIN.floor ? Math.max(geo, label) : geo;
  }
  function classify(hand, signs = {}) {
    if (!hand) return null;
    const wl = hand.wl && hand.wl.length >= 21 ? hand.wl : null, f = wl ? features(wl) : null, s = wl ? shape(wl) : null;
    let best = null;
    for (const id of Object.keys(COMMANDS)) {
      const own = signs && signs[id] && signs[id].ex;
      let score = 0;
      if (own) score = f ? matchScore(f, own) : 0;
      else if (COMMANDS[id].twoHands) score = 0; // the default needs both hands: crossXScore
      else if (id === 'zoom') score = s ? crossedOf(s) : 0;
      else score = defaultScore(id, hand, s);
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
  const STILL_MS = 700; // `still` is judged over this much of the end of the hold
  const initial = () => ({ label: null, since: 0, lastSeen: 0, lostAt: 0, cooldownUntil: 0, lock: null, freeSince: 0, at: null, trail: [], absent: {}, hits: 0, misses: 0 });
  const spec = (id) => COMMANDS[id] || {};
  const holdOf = (label, cfg) => spec(label).holdMs || cfg.holdMs;
  const breakOf = (label, cfg) => spec(label).breakMs || cfg.breakMs;
  const reachOf = (label, cfg) => Math.max(breakOf(label, cfg), spec(label).maxGapMs || 0); // a gap longer than this ends the hold
  const trailOf = (trail, t, at) => (at ? [...(trail || []).filter((p) => t - p.t <= STILL_MS), { t, x: at.x, y: at.y }] : trail || []);
  const moved = (trail) => { if (trail.length < 2) return 0; const xs = trail.map((p) => p.x), ys = trail.map((p) => p.y); return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)); };
  // `still`, asked when a hold is complete (no position in the samples = nothing to judge by = passed)
  const steady = (s, c) => !c.still || moved(s.trail) <= c.still;
  // `duty`, asked at the same time: looks that showed the sign / all looks since the hold began (hits + misses)
  const dutyOk = (s, c) => !c.duty || s.hits >= c.duty * (s.hits + s.misses);
  // `absent[id]` = since when the sign of a command with `fresh` has not been shown; missing = it is in view now, or it already was when the stream began
  function watch(s, t, label, shown) {
    let absent = s.absent || {};
    for (const id of Object.keys(COMMANDS)) {
      if (!COMMANDS[id].fresh) continue;
      const here = shown && label === id;
      if (here ? id in absent : !(id in absent)) { absent = { ...absent }; if (here) delete absent[id]; else absent[id] = t; }
    }
    return absent === s.absent ? s : { ...s, absent };
  }

  // step(state, { t, label, score, at }, cfg) -> { state, progress, fire, seen, at, held }
  //   t         ms, any monotonic clock
  //   label     the command being shown (a key of COMMANDS, from classify), or null / undefined when no sign was seen
  //   at        where the hand points, if the caller wants it back (the zoom sign picks the area with it); also what `still` judges the hand's movement by
  //   progress  0..1, how far the current hold is (drives the ring); 0 when nothing is held, during the cooldown, while a fired sign is locked, and for a
  //             continuous sign (zoom) once it has been held long enough to start; stays just under 1 while a complete hold waits for its guards
  //   fire      the command to run, or null (never for a continuous sign)
  //   seen      the command sign being held right now (drives the "hold to pause" hint), or null
  //   at        (out) the position at the latest good sample, with `seen` and `fire`
  //   held      ms the sign in `seen` has been held (0 without one); a continuous sign is under way once held >= its holdMs
  // The state is returned, never mutated: feed it back in with the next sample.
  // A hold survives a gap of up to breakMs, measured from the last good sample, or from the first bad one after it. A command with maxGapMs survives a
  // longer one too (the ring stops where it was), but the time beyond breakMs is not counted: the hold is that much later.
  function step(state, sample, cfg = CFG) {
    const r = stepCore(state, sample, cfg);
    return { ...r, held: r.seen ? Math.max(0, sample.t - r.state.since) : 0 };
  }
  function stepCore(state, sample, cfg) {
    const { t, label, score } = sample, c = label ? COMMANDS[label] : null;
    const r = hold(state, sample, cfg);
    return { ...r, state: watch(r.state, t, label, !!c && score >= (c.keepScore ?? c.minScore ?? cfg.minScore)) }; // (the sign counts as shown at its lower bar)
  }
  function hold(state, sample, cfg) {
    const { t, label, score, at = null } = sample, cmd = label ? COMMANDS[label] : null;
    const bar = cmd ? (cmd.minScore ?? cfg.minScore) : 1, keep = cmd ? (cmd.keepScore ?? bar) : 1;
    const shown = !!cmd && score >= keep; // the sign is up, if not clearly enough to start a hold
    let s = state;
    // a sign that just fired stays locked until it has been let go for releaseMs: a hand left up must not flip pause / resume every few seconds
    if (s.lock) {
      if (shown && label === s.lock) { if (s.freeSince) s = { ...s, freeSince: 0 }; }
      else if (!s.freeSince) s = { ...s, freeSince: t };
      else if (t - s.freeSince >= cfg.releaseMs) s = { ...s, lock: null, freeSince: 0 };
    }
    if (t < s.cooldownUntil || (shown && label === s.lock)) return { state: s.label ? { ...s, label: null, since: 0, lastSeen: 0, lostAt: 0 } : s, progress: 0, fire: null, seen: null, at: null };
    const base = s.lostAt || s.lastSeen;
    const alive = !!s.label && t - base <= reachOf(s.label, cfg); // is the hold still going at t?
    const same = alive && s.label === label;
    const good = shown && (same || score >= bar); // a hold that is going on needs only keepScore, a new one the full bar
    if (good) {
      if (same) {
        const since = s.since + Math.max(0, t - base - breakOf(label, cfg)), elapsed = t - since, left = holdOf(label, cfg) - elapsed;
        const n = { ...s, since, lastSeen: t, lostAt: 0, at, trail: trailOf(s.trail, t, at), hits: s.hits + 1 };
        if (left <= (cmd.continuous ? 0 : Math.min(cfg.roundMs || 0, (t - s.lastSeen) / 2))) {
          if (cmd.continuous) return { state: n, progress: 0, fire: null, seen: label, at }; // under way, and stays so while it is held
          if (steady(n, cmd) && dutyOk(n, cmd)) return { state: { ...initial(), absent: s.absent, cooldownUntil: t + cfg.cooldownMs, lock: label }, progress: 0, fire: label, seen: null, at };
          return { state: n, progress: 0.999, fire: null, seen: label, at }; // held long enough but the hand is still moving, or the sign flickers too much: the ring waits full
        }
        return { state: n, progress: Math.min(0.999, elapsed / holdOf(label, cfg)), fire: null, seen: label, at };
      }
      if (cmd.fresh && s.label !== label && !(label in (s.absent || {}) && t - s.absent[label] > breakOf(label, cfg))) return { state: s.label ? { ...s, label: null, since: 0, lastSeen: 0, lostAt: 0 } : s, progress: 0, fire: null, seen: null, at: null }; // a fist that never left: not a new sign
      return { state: { ...s, label, since: t, lastSeen: t, lostAt: 0, at, trail: trailOf([], t, at), hits: 1, misses: 0 }, progress: 0, fire: null, seen: label, at }; // a new sign, or the old one after a break: the clock restarts
    }
    // not a usable sample (no hand, low score, another sign)
    if (alive) {
      const lost = s.lostAt || t, p = (Math.min(t, lost + breakOf(s.label, cfg)) - s.since) / holdOf(s.label, cfg); // (the ring stops when the gap is longer than breakMs)
      const w = { ...s, misses: s.misses + 1 };
      return { state: s.lostAt ? w : { ...w, lostAt: t }, progress: COMMANDS[s.label].continuous && p >= 1 ? 0 : Math.min(0.999, p), fire: null, seen: s.label, at: s.at };
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

  return { CFG, COMMANDS, DEFAULT_SIGN, NAMES, TEACH, REF, RADIUS, initial, step, classify, pick, features, matchScore, crossedScore, palmScore, fistScore, crossXScore, tipPoint, teachStep, teachInitial, teach, conflict, handHeight, handInside, sketch, dist };
});
