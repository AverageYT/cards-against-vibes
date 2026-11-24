/** Cosmetic Inspector pose keyframes. Values are internal 320×180 pixels. */
export const INSPECTOR_KEYFRAMES = Object.freeze({
  offer: Object.freeze([{ at: 0, y: 0, sleeve: 0 }, { at: 100, y: -1.6, sleeve: 0.5 }, { at: 240, y: 0, sleeve: 0 }]),
  draw: Object.freeze([{ at: 0, y: 0, sleeve: 0 }, { at: 120, y: 1.25, sleeve: 1 }, { at: 260, y: 0, sleeve: 0 }]),
  react: Object.freeze([{ at: 0, y: 0, sleeve: 0 }, { at: 105, y: -2.25, sleeve: 0.35 }, { at: 220, y: 0.4, sleeve: 0 }, { at: 290, y: 0, sleeve: 0 }]),
});

/** CSS cubic-bezier(0.42, 0, 0.58, 1), solved for x (time). */
export function inspectorEase(x) {
  const t = Math.max(0, Math.min(1, x));
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i += 1) {
    const u = (lo + hi) / 2;
    const bx = 3 * (1-u) ** 2 * u * 0.42 + 3 * (1-u) * u ** 2 * 0.58 + u ** 3;
    if (bx < t) lo = u; else hi = u;
  }
  const u = (lo + hi) / 2;
  return 3 * (1-u) * u * u + u ** 3;
}

/** Interruption-safe, timer-free transform player; never controls gameplay. */
export function createInspectorMotion({ now = () => performance.now() } = {}) {
  let active = null;
  let reduced = false;
  const idle = () => ({ y: 0, sleeve: 0, pose: 'idle' });
  function sample(at = now()) {
    if (!active || reduced) return idle();
    const keys = INSPECTOR_KEYFRAMES[active.pose];
    const elapsed = Math.max(0, at - active.start);
    if (elapsed >= keys[keys.length - 1].at) { active = null; return idle(); }
    let i = 1;
    while (i < keys.length - 1 && elapsed > keys[i].at) i += 1;
    const a = i === 1 ? { ...keys[0], ...active.from } : keys[i - 1];
    const z = keys[i];
    const eased = inspectorEase((elapsed - a.at) / (z.at - a.at));
    return { y: a.y + (z.y - a.y) * eased, sleeve: a.sleeve + (z.sleeve - a.sleeve) * eased, pose: active.pose };
  }
  return {
    sample,
    trigger(pose, at = now()) {
      if (reduced || !INSPECTOR_KEYFRAMES[pose]) return false;
      const current = sample(at);
      active = { pose, start: at, from: { y: current.y, sleeve: current.sleeve } };
      return true;
    },
    setReducedMotion(value) { reduced = Boolean(value); if (reduced) active = null; },
    reset() { active = null; },
  };
}
