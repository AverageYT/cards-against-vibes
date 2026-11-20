/**
 * src/visuals/motion.js
 * Tactile motion profiles + DOM animation helpers.
 *
 * Design intent (game-feel skill): every discrete gameplay event gets a small,
 * proportional bundle of feedback on 2-3 channels (transform, sound, CSS class)
 * and nothing ever moves for its own sake. Animation only writes transforms and
 * opacity — it never changes the simulation — and every effect returns exactly
 * to its rest value.
 *
 * Two profiles:
 *   full      — default. Lift/settle, 90 ms commit suspense, punch, sway.
 *   reduced   — durations cut to <= 60 ms, no sway, no shake, no parallax.
 *
 * A motion handle owns its own timers so a restart can cancel everything.
 */

/** Duration table in ms. Keep the full profile under ~0.4 s per beat. */
export const MOTION_PROFILES = Object.freeze({
  full: Object.freeze({
    lift: 120,
    settle: 150,
    drawArrive: 170,
    pairSnap: 190,
    commitSuspense: 460,
    punch: 260,
    lanternLoss: 420,
    rewardReveal: 220,
    stampPress: 200,
    sway: true,
    shake: true,
    parallax: true,
  }),
  reduced: Object.freeze({
    lift: 50,
    settle: 50,
    drawArrive: 60,
    pairSnap: 60,
    commitSuspense: 120,
    punch: 60,
    lanternLoss: 60,
    rewardReveal: 60,
    stampPress: 60,
    sway: false,
    shake: false,
    parallax: false,
  }),
});

export function getMotionProfile(reducedMotion) {
  return reducedMotion ? MOTION_PROFILES.reduced : MOTION_PROFILES.full;
}

/** Inline `transition-duration` values so CSS never needs to know about modes. */
export function motionVars(profile) {
  return {
    "--motion-lift": `${profile.lift}ms`,
    "--motion-settle": `${profile.settle}ms`,
    "--motion-snap": `${profile.pairSnap}ms`,
    "--motion-punch": `${profile.punch}ms`,
    "--motion-suspense": `${profile.commitSuspense}ms`,
    "--motion-reveal": `${profile.rewardReveal}ms`,
  };
}

/**
 * Resolve a gameplay event into a cue bundle. Pure, so tests can assert the
 * reduced profile really is shorter and that unknown events are inert.
 *
 * @returns {{className:string, durationMs:number, sound:string, shake:number}}
 */
export function cueForEvent(event, profile) {
  const p = profile || MOTION_PROFILES.full;
  switch (event) {
    case "CARD_LIFT":
      return { className: "cued-lift", durationMs: p.lift, sound: "lift", shake: 0 };
    case "CARD_SETTLE":
      return { className: "cued-settle", durationMs: p.settle, sound: "settle", shake: 0 };
    case "CARD_ARRIVE":
      return { className: "cued-arrive", durationMs: p.drawArrive, sound: "draw", shake: 0 };
    case "PAIR_SNAP":
      return { className: "cued-pair-snap", durationMs: p.pairSnap, sound: "match", shake: 0 };
    case "COMMIT":
      return { className: "cued-commit", durationMs: p.commitSuspense, sound: "flip", shake: 0 };
    case "REVEAL":
      return { className: "cued-reveal", durationMs: p.commitSuspense, sound: "reveal", shake: 0 };
    case "PUNCH":
      return { className: "cued-punch", durationMs: p.punch, sound: "punch", shake: 1 };
    case "STAMP":
      return { className: "cued-stamp", durationMs: p.stampPress, sound: "stamp", shake: 0 };
    case "LANTERN_LOSS":
      return { className: "cued-lantern-loss", durationMs: p.lanternLoss, sound: "lantern", shake: 2 };
    case "REWARD":
      return { className: "cued-reward", durationMs: p.rewardReveal, sound: "reward", shake: 0 };
    default:
      return { className: "", durationMs: 0, sound: null, shake: 0 };
  }
}

/**
 * A disposable animation queue bound to one element set.
 * Rail: pending timers are tracked so restart/world teardown cancels them all.
 */
export function createMotionRail({
  doc = typeof document !== "undefined" ? document : null,
  setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutImpl = (id) => clearTimeout(id),
} = {}) {
  const timers = new Set();
  let profile = MOTION_PROFILES.full;
  let disposed = false;

  function later(fn, ms) {
    if (disposed) return null;
    const id = setTimeoutImpl(() => {
      timers.delete(id);
      if (!disposed) fn();
    }, Math.max(0, ms));
    timers.add(id);
    return id;
  }

  /**
   * Play a cue on one or more elements: add the class, force a reflow-safe
   * re-trigger, then remove it after the profile duration.
   */
  function play(elements, event, { onDone = null } = {}) {
    const cue = cueForEvent(event, profile);
    const list = (Array.isArray(elements) ? elements : [elements]).filter(Boolean);
    if (!cue.className || list.length === 0) {
      if (onDone) later(onDone, 0);
      return cue;
    }
    for (const node of list) {
      if (!node || !node.classList) continue;
      node.classList.remove(cue.className);
      // Reading a layout value restarts the CSS animation reliably.
      void (node.offsetWidth || 0);
      node.classList.add(cue.className);
    }
    later(() => {
      for (const node of list) {
        if (node && node.classList) node.classList.remove(cue.className);
      }
      if (onDone) onDone();
    }, cue.durationMs);
    return cue;
  }

  function wait(ms, fn) {
    return later(fn, ms);
  }

  function setProfile(next) {
    profile = next || MOTION_PROFILES.full;
    return profile;
  }

  function cancelAll() {
    for (const id of timers) clearTimeoutImpl(id);
    timers.clear();
  }

  return {
    get profile() {
      return profile;
    },
    get pendingCount() {
      return timers.size;
    },
    play,
    wait,
    setProfile,
    cancelAll,
    dispose() {
      disposed = true;
      cancelAll();
    },
  };
}

/**
 * Screen-shake helper that writes only a CSS variable on the stage root.
 * Decaying trauma^2, summed sines (never per-frame random), and it always
 * returns to exactly 0 so the layout can never drift.
 */
export function createSwayController({
  root,
  reducedMotion = false,
  raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null,
  caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null,
  now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
} = {}) {
  if (!root || !raf) return { setReducedMotion() {}, kick() {}, dispose() {} };
  let trauma = 0;
  let running = false;
  let frameId = null;
  let reduced = reducedMotion;
  let last = now();

  function apply(x, y, roll) {
    if (root.style && typeof root.style.setProperty === "function") {
      root.style.setProperty("--sway-x", `${x.toFixed(2)}px`);
      root.style.setProperty("--sway-y", `${y.toFixed(2)}px`);
      root.style.setProperty("--sway-roll", `${roll.toFixed(3)}deg`);
    }
  }

  function tick() {
    if (!running) return;
    const t = now();
    const dt = Math.min(64, t - last) / 1000;
    last = t;
    if (trauma > 0) {
      trauma = Math.max(0, trauma - dt * 1.6);
      const shake = trauma * trauma;
      const s = t * 0.03;
      apply(Math.sin(s * 1.7) * 5 * shake, Math.sin(s * 2.3) * 3 * shake, Math.sin(s * 1.1) * 0.2 * shake);
      if (trauma === 0) apply(0, 0, 0);
    }
    frameId = raf(tick);
  }

  function ensureRunning() {
    if (running) return;
    running = true;
    last = now();
    frameId = raf(tick);
  }

  return {
    setReducedMotion(next) {
      reduced = Boolean(next);
      if (reduced) {
        trauma = 0;
        apply(0, 0, 0);
      }
    },
    kick(amount = 0.18) {
      if (reduced) return;
      trauma = Math.min(1, trauma + amount);
      ensureRunning();
    },
    dispose() {
      running = false;
      if (frameId !== null && caf) caf(frameId);
      frameId = null;
      apply(0, 0, 0);
    },
  };
}
