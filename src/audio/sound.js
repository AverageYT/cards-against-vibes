/**
 * src/audio/sound.js
 * Procedural WebAudio for The Unlisted. Zero audio files, zero network.
 *
 * Design notes (audio-design skill):
 *   - Every effect is synthesised from oscillators + one shared noise buffer, so
 *     there is nothing to preload and no asset licensing.
 *   - Two buses: sfx (transient cues) and ambience (slow train bed + chords).
 *     The master gain multiplies both, so mute is instantaneous and total.
 *   - The context is created lazily on the first user gesture; browsers reject
 *     autoplay, and a game that beeps before the player acts is a bug.
 *   - Every scheduled node is tracked and stopped on dispose so a run restart
 *     leaves silence behind.
 */

const STORAGE_KEY = "the_unlisted_audio_v1";

export const SOUND_IDS = Object.freeze({
  LIFT: "lift",
  SETTLE: "settle",
  DRAW: "draw",
  FLIP: "flip",
  MATCH: "match",
  REVEAL: "reveal",
  PUNCH: "punch",
  STAMP: "stamp",
  LANTERN: "lantern",
  REWARD: "reward",
  UI: "ui",
  DENY: "deny",
  VICTORY: "victory",
  DEFEAT: "defeat",
});

const DEFAULTS = Object.freeze({ muted: false, volume: 0.7, ambience: true });

function readPrefs(storage) {
  if (!storage) return { ...DEFAULTS };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      muted: parsed.muted === true,
      volume: Number.isFinite(parsed.volume) ? Math.max(0, Math.min(1, parsed.volume)) : DEFAULTS.volume,
      ambience: parsed.ambience !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function writePrefs(storage, prefs) {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode / quota: the game keeps working silently.
  }
}

/**
 * @param {object} opts
 * @param {object|null} opts.storage  localStorage-like; remembered across reloads
 * @param {Function} opts.contextFactory returns an AudioContext (injected in tests)
 */
export function createSoundEngine({
  storage = null,
  contextFactory = null,
  now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
} = {}) {
  let ctx = null;
  let master = null;
  let sfxBus = null;
  let ambienceBus = null;
  let noiseBuffer = null;
  let ambience = null;
  let disposed = false;
  let unlocked = false;
  let prefs = readPrefs(storage);
  const activeNodes = new Set();
  let cueCount = 0;
  let lastPlayedAt = new Map();

  function getContextFactory() {
    if (contextFactory) return contextFactory;
    const Ctor =
      typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
    if (!Ctor) return null;
    return () => new Ctor();
  }

  /** Create the context + buses on first use. Returns null when unsupported. */
  function ensureContext() {
    if (disposed) return null;
    if (ctx) return ctx;
    const factory = getContextFactory();
    if (!factory) return null;
    try {
      ctx = factory();
    } catch {
      ctx = null;
      return null;
    }
    if (!ctx || typeof ctx.createGain !== "function") {
      ctx = null;
      return null;
    }
    master = ctx.createGain();
    master.gain.value = prefs.muted ? 0 : prefs.volume;
    master.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = 1;
    sfxBus.connect(master);
    ambienceBus = ctx.createGain();
    ambienceBus.gain.value = 0.5;
    ambienceBus.connect(master);
    noiseBuffer = makeNoiseBuffer(ctx);
    return ctx;
  }

  function makeNoiseBuffer(context) {
    const length = Math.floor(context.sampleRate * 1.4);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    // Deterministic-ish noise; no Math.random so it is reproducible per load.
    let seed = 0x2545f491;
    for (let i = 0; i < length; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 0xffffffff) * 2 - 1;
    }
    return buffer;
  }

  function track(node) {
    if (!node) return node;
    activeNodes.add(node);
    return node;
  }

  function env(node, t0, attack, hold, release, peak) {
    const g = node.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    g.setValueAtTime(Math.max(0.0002, peak), t0 + attack + hold);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
  }

  function tone({ type = "sine", freq = 440, to = null, dur = 0.18, gain = 0.2, attack = 0.005, hold = 0.02, detune = 0, filter = null }) {
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.001;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    if (detune) osc.detune.setValueAtTime(detune, t0);
    let tail = osc;
    if (filter && ctx.createBiquadFilter) {
      const bq = ctx.createBiquadFilter();
      bq.type = "lowpass";
      bq.frequency.value = filter;
      bq.Q.value = 0.9;
      tail.connect(bq);
      tail = bq;
    }
    tail.connect(g);
    g.connect(sfxBus);
    env(g, t0, attack, hold, dur, gain);
    osc.start(t0);
    osc.stop(t0 + attack + hold + dur + 0.05);
    track(osc);
    osc.onended = () => activeNodes.delete(osc);
  }

  function noise({ dur = 0.12, gain = 0.18, type = "bandpass", freq = 1400, q = 0.8, sweepTo = null }) {
    if (!ctx || !noiseBuffer) return;
    const t0 = ctx.currentTime + 0.001;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const bq = ctx.createBiquadFilter();
    bq.type = type;
    bq.frequency.setValueAtTime(freq, t0);
    if (sweepTo) bq.frequency.exponentialRampToValueAtTime(Math.max(60, sweepTo), t0 + dur);
    bq.Q.value = q;
    const g = ctx.createGain();
    src.connect(bq);
    bq.connect(g);
    g.connect(sfxBus);
    env(g, t0, 0.004, 0.01, dur, gain);
    src.start(t0);
    src.stop(t0 + dur + 0.08);
    track(src);
    src.onended = () => activeNodes.delete(src);
  }

  /**
   * Play one cue. Unknown ids are inert. Repeated identical cues inside 30 ms
   * are swallowed so a mashed key cannot stack a hundred oscillators.
   */
  function play(id) {
    if (disposed || prefs.muted) return false;
    // One-shot cues only fire after a user gesture has unlocked the context:
    // browsers block autoplay, and a game that beeps before input is a bug.
    if (!unlocked && !ambience) return false;
    const context = ensureContext();
    if (!context) return false;
    const t = now();
    const last = lastPlayedAt.get(id) ?? -1e9;
    if (t - last < 30) return false;
    lastPlayedAt.set(id, t);
    if (typeof context.resume === "function" && context.state === "suspended") {
      const res = context.resume();
      if (res && typeof res.catch === "function") res.catch(() => {});
    }
    cueCount += 1;

    switch (id) {
      case SOUND_IDS.LIFT:
        tone({ type: "sine", freq: 520, to: 690, dur: 0.07, gain: 0.09, filter: 3200 });
        break;
      case SOUND_IDS.SETTLE:
        tone({ type: "sine", freq: 300, to: 190, dur: 0.09, gain: 0.08 });
        noise({ dur: 0.05, gain: 0.05, freq: 2400, type: "highpass" });
        break;
      case SOUND_IDS.DRAW:
        noise({ dur: 0.16, gain: 0.16, freq: 900, sweepTo: 2600, q: 1.1 });
        tone({ type: "triangle", freq: 240, to: 320, dur: 0.1, gain: 0.05 });
        break;
      case SOUND_IDS.FLIP:
        noise({ dur: 0.1, gain: 0.13, freq: 1800, q: 1.4 });
        tone({ type: "sine", freq: 700, to: 420, dur: 0.1, gain: 0.06 });
        break;
      case SOUND_IDS.MATCH:
        // Paper snap + a warm two-note brass confirmation.
        noise({ dur: 0.07, gain: 0.2, freq: 3000, type: "bandpass", q: 1.6 });
        tone({ type: "triangle", freq: 523.25, dur: 0.16, gain: 0.12, filter: 4200 });
        tone({ type: "triangle", freq: 659.25, dur: 0.24, gain: 0.1, filter: 4200 });
        break;
      case SOUND_IDS.REVEAL:
        tone({ type: "sine", freq: 196, to: 147, dur: 0.42, gain: 0.14, filter: 900 });
        noise({ dur: 0.3, gain: 0.06, freq: 700, sweepTo: 300, q: 0.6 });
        break;
      case SOUND_IDS.PUNCH:
        // Heavy mechanical punch: thud + click + metal ring.
        tone({ type: "sine", freq: 120, to: 54, dur: 0.2, gain: 0.34 });
        noise({ dur: 0.06, gain: 0.26, freq: 2200, type: "highpass" });
        tone({ type: "square", freq: 1180, to: 940, dur: 0.12, gain: 0.045, filter: 3000 });
        break;
      case SOUND_IDS.STAMP:
        tone({ type: "sine", freq: 190, to: 96, dur: 0.13, gain: 0.2 });
        noise({ dur: 0.09, gain: 0.12, freq: 1200, q: 0.7 });
        break;
      case SOUND_IDS.LANTERN:
        // Glass rattle + a descending minor third: the light going out.
        noise({ dur: 0.12, gain: 0.13, freq: 2600, type: "highpass" });
        tone({ type: "sine", freq: 392, to: 293.66, dur: 0.5, gain: 0.16, filter: 2200 });
        tone({ type: "sine", freq: 293.66, to: 220, dur: 0.62, gain: 0.12, filter: 1600 });
        break;
      case SOUND_IDS.REWARD:
        tone({ type: "triangle", freq: 440, dur: 0.14, gain: 0.11, filter: 3800 });
        tone({ type: "triangle", freq: 587.33, dur: 0.2, gain: 0.1, filter: 3800 });
        tone({ type: "triangle", freq: 880, dur: 0.3, gain: 0.08, filter: 4600 });
        break;
      case SOUND_IDS.UI:
        tone({ type: "square", freq: 880, dur: 0.04, gain: 0.045, filter: 2600 });
        break;
      case SOUND_IDS.DENY:
        tone({ type: "square", freq: 150, to: 110, dur: 0.12, gain: 0.07, filter: 900 });
        break;
      case SOUND_IDS.VICTORY:
        [392, 493.88, 587.33, 783.99].forEach((f, i) => {
          setTimeoutSafe(() => tone({ type: "triangle", freq: f, dur: 0.5, gain: 0.12, filter: 4200 }), i * 150);
        });
        break;
      case SOUND_IDS.DEFEAT:
        [293.66, 246.94, 196, 146.83].forEach((f, i) => {
          setTimeoutSafe(() => tone({ type: "sine", freq: f, dur: 0.6, gain: 0.13, filter: 1400 }), i * 190);
        });
        break;
      default:
        break;
    }
    return true;
  }

  const pendingTimeouts = new Set();
  function setTimeoutSafe(fn, ms) {
    if (disposed) return;
    const id = setTimeout(() => {
      pendingTimeouts.delete(id);
      if (!disposed) fn();
    }, ms);
    pendingTimeouts.add(id);
  }

  /** Ambient train bed: low rumble + rail clatter + a slow minor drone. */
  function startAmbience() {
    if (disposed || !prefs.ambience) return false;
    const context = ensureContext();
    if (!context || ambience) return false;

    const rumbleSrc = context.createBufferSource();
    rumbleSrc.buffer = noiseBuffer;
    rumbleSrc.loop = true;
    const rumbleFilter = context.createBiquadFilter();
    rumbleFilter.type = "lowpass";
    rumbleFilter.frequency.value = 190;
    rumbleFilter.Q.value = 0.6;
    const rumbleGain = context.createGain();
    rumbleGain.gain.value = 0.16;

    // Slow amplitude wobble = the carriage rocking on its bogies.
    const wobble = context.createOscillator();
    wobble.type = "sine";
    wobble.frequency.value = 0.23;
    const wobbleDepth = context.createGain();
    wobbleDepth.gain.value = 0.05;
    wobble.connect(wobbleDepth);
    wobbleDepth.connect(rumbleGain.gain);

    rumbleSrc.connect(rumbleFilter);
    rumbleFilter.connect(rumbleGain);
    rumbleGain.connect(ambienceBus);

    // Rail clatter: filtered noise gated by a slow rhythm.
    const clatter = context.createBufferSource();
    clatter.buffer = noiseBuffer;
    clatter.loop = true;
    const clatterFilter = context.createBiquadFilter();
    clatterFilter.type = "bandpass";
    clatterFilter.frequency.value = 1100;
    clatterFilter.Q.value = 0.7;
    const clatterGain = context.createGain();
    clatterGain.gain.value = 0.0;
    clatter.connect(clatterFilter);
    clatterFilter.connect(clatterGain);
    clatterGain.connect(ambienceBus);

    // Slow chord: A minor with a suspended sixth, very quiet.
    const droneGain = context.createGain();
    droneGain.gain.value = 0.055;
    droneGain.connect(ambienceBus);
    const droneOsc = [];
    [110, 164.81, 220, 329.63].forEach((f, i) => {
      const o = context.createOscillator();
      o.type = i % 2 === 0 ? "sine" : "triangle";
      o.frequency.value = f;
      o.detune.value = (i - 1.5) * 6;
      const g = context.createGain();
      g.gain.value = i === 0 ? 0.5 : 0.24;
      o.connect(g);
      g.connect(droneGain);
      o.start();
      droneOsc.push(o);
      track(o);
    });

    rumbleSrc.start();
    wobble.start();
    clatter.start();
    track(rumbleSrc);
    track(wobble);
    track(clatter);

    // Schedule the clatter pattern from a single interval (cleared on stop).
    let beat = 0;
    const clatterTimer = setInterval(() => {
      if (disposed || !ctx) return;
      const t0 = ctx.currentTime;
      const phase = beat % 8;
      const level = phase === 0 || phase === 4 ? 0.1 : phase === 2 || phase === 6 ? 0.05 : 0.012;
      clatterGain.gain.cancelScheduledValues(t0);
      clatterGain.gain.setValueAtTime(level, t0);
      beat += 1;
    }, 620);

    ambience = {
      nodes: [rumbleSrc, wobble, clatter, ...droneOsc, rumbleFilter, clatterFilter, rumbleGain, clatterGain, droneGain],
      gains: { rumbleGain, clatterGain, droneGain },
      clatterTimer,
    };
    return true;
  }

  function stopAmbience() {
    if (!ambience) return;
    clearInterval(ambience.clatterTimer);
    for (const node of ambience.nodes) {
      try {
        if (typeof node.stop === "function") node.stop();
        if (typeof node.disconnect === "function") node.disconnect();
      } catch {
        // Already stopped.
      }
      activeNodes.delete(node);
    }
    ambience = null;
  }

  function applyVolume() {
    if (!master || !ctx) return;
    const target = prefs.muted ? 0 : prefs.volume;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(target, ctx.currentTime, 0.02);
  }

  return {
    get prefs() {
      return { ...prefs };
    },
    get isUnlocked() {
      return unlocked && Boolean(ctx);
    },
    get isAmbienceRunning() {
      return Boolean(ambience);
    },
    get activeNodeCount() {
      return activeNodes.size;
    },
    get cueCount() {
      return cueCount;
    },
    /** Call from a click/keydown handler: browsers require a user gesture. */
    unlock() {
      if (disposed) return false;
      const context = ensureContext();
      if (!context) return false;
      if (typeof context.resume === "function" && context.state !== "running") {
        const res = context.resume();
        if (res && typeof res.catch === "function") res.catch(() => {});
      }
      unlocked = true;
      if (prefs.ambience) startAmbience();
      return true;
    },
    play,
    setMuted(muted) {
      prefs = { ...prefs, muted: Boolean(muted) };
      writePrefs(storage, prefs);
      applyVolume();
      if (prefs.muted) stopAmbience();
      else if (prefs.ambience && unlocked) startAmbience();
      return prefs.muted;
    },
    setVolume(volume) {
      const v = Math.max(0, Math.min(1, Number(volume) || 0));
      prefs = { ...prefs, volume: v };
      writePrefs(storage, prefs);
      applyVolume();
      return prefs.volume;
    },
    setAmbienceEnabled(enabled) {
      prefs = { ...prefs, ambience: Boolean(enabled) };
      writePrefs(storage, prefs);
      if (prefs.ambience && unlocked && !prefs.muted) startAmbience();
      else stopAmbience();
      return prefs.ambience;
    },
    startAmbience,
    stopAmbience,
    dispose() {
      disposed = true;
      for (const id of pendingTimeouts) clearTimeout(id);
      pendingTimeouts.clear();
      stopAmbience();
      for (const node of activeNodes) {
        try {
          if (typeof node.stop === "function") node.stop();
          if (typeof node.disconnect === "function") node.disconnect();
        } catch {
          // Ignore double stops.
        }
      }
      activeNodes.clear();
      lastPlayedAt.clear();
      if (ctx && typeof ctx.close === "function") {
        try {
          ctx.close();
        } catch {
          // Already closed.
        }
      }
      ctx = null;
      master = null;
      sfxBus = null;
      ambienceBus = null;
    },
  };
}

export { STORAGE_KEY as AUDIO_STORAGE_KEY, DEFAULTS as AUDIO_DEFAULTS };
