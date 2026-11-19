/**
 * src/core/rng.js
 * Deterministic seeded PRNG and isolated stream derivation.
 *
 * Uses FNV-1a + SplitMix32 mixing for seed hashing and Mulberry32 for fast,
 * reproducible, platform-independent generation across browsers and Node.
 */

const RAILWAY_PREFIXES = Object.freeze([
  "LINE",
  "COACH",
  "BERTH",
  "NIGHT",
  "TRACK",
  "LAMP",
  "SIGNAL",
  "SLEEPER",
]);

/**
 * Normalize a user-supplied seed string. Trims whitespace and caps length.
 * If empty or omitted, returns a deterministic fallback or creates a fresh
 * readable railway code using Math.random (only used when user requests a
 * brand-new unseeded session).
 */
export function normalizeSeed(input, { allowRandom = false } = {}) {
  if (typeof input === "string") {
    const trimmed = input.trim().slice(0, 64);
    if (trimmed.length > 0) {
      return trimmed;
    }
  } else if (typeof input === "number" && Number.isFinite(input)) {
    return String(input);
  }

  if (allowRandom) {
    return generateReadableSeed();
  }
  return "LINE-0001";
}

/**
 * Generate a human-shareable seed like "BERTH-4821" for fresh runs.
 */
export function generateReadableSeed(entropyFn = Math.random) {
  const prefixIdx = Math.floor(entropyFn() * RAILWAY_PREFIXES.length) % RAILWAY_PREFIXES.length;
  const num = String(Math.floor(entropyFn() * 10000)).padStart(4, "0");
  return `${RAILWAY_PREFIXES[prefixIdx]}-${num}`;
}

/**
 * SplitMix32 single-step avalanche mixer (unsigned 32-bit).
 */
function mix32(z) {
  let x = (z + 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Hash an arbitrary string into a well-distributed unsigned 32-bit seed.
 */
export function hashSeed(seedString) {
  const str = String(seedString);
  let h = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const mixed = mix32(h ^ str.length);
  // Avoid exact zero state purely for tidy diagnostics (Mulberry32 handles 0 too).
  return mixed === 0 ? 0x6d2b79f5 : mixed;
}

/**
 * Derive an independent namespaced seed string from a root seed.
 * Uses a null-byte-like separator so ("ab", "c") !== ("a", "bc").
 */
export function deriveSeed(rootSeed, namespace) {
  const base = normalizeSeed(rootSeed);
  const ns = String(namespace);
  return `${base}::[${ns.length}]${ns}`;
}

/**
 * Create an isolated Mulberry32 PRNG instance from a seed string or uint32.
 */
export function createRng(seedInput, initialState = null) {
  const seedLabel = typeof seedInput === "string" ? normalizeSeed(seedInput) : String(seedInput >>> 0);
  let state =
    typeof initialState === "number" && Number.isInteger(initialState)
      ? initialState >>> 0
      : typeof seedInput === "number" && Number.isInteger(seedInput)
        ? mix32(seedInput >>> 0)
        : hashSeed(seedLabel);

  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function nextInt(maxExclusive) {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`nextInt expects positive integer, got ${maxExclusive}`);
    }
    if (maxExclusive === 1) {
      return 0;
    }
    return Math.floor(next() * maxExclusive);
  }

  function pick(items) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new RangeError("pick expects a non-empty array");
    }
    return items[nextInt(items.length)];
  }

  /**
   * Return a new shuffled shallow copy using Fisher-Yates.
   * Never mutates the input array.
   */
  function shuffle(items) {
    if (!Array.isArray(items)) {
      throw new TypeError("shuffle expects an array");
    }
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = nextInt(i + 1);
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }

  /**
   * Derive a completely independent child RNG keyed only to seedLabel + namespace
   * (independent of how many draws were already taken from this stream).
   */
  function fork(namespace) {
    return createRng(deriveSeed(seedLabel, namespace));
  }

  function getState() {
    return state >>> 0;
  }

  function clone() {
    return createRng(seedLabel, state);
  }

  return Object.freeze({
    seed: seedLabel,
    next,
    nextInt,
    pick,
    shuffle,
    fork,
    getState,
    clone,
  });
}

/**
 * Build the four isolated run-level / encounter-level PRNG stream constructors
 * mandated by RULES.md Section 3.
 */
export function createDuelStreams(rootSeed, encounterIndex = 0) {
  const base = normalizeSeed(rootSeed);
  const tag = `enc:${encounterIndex}`;
  return Object.freeze({
    rootSeed: base,
    shuffleSeed: deriveSeed(base, `${tag}:shuffle`),
    aiSeed: deriveSeed(base, `${tag}:ai`),
    visualSeed: deriveSeed(base, `${tag}:visual`),
    createShuffleRng: () => createRng(deriveSeed(base, `${tag}:shuffle`)),
    createAiRng: () => createRng(deriveSeed(base, `${tag}:ai`)),
    createVisualRng: () => createRng(deriveSeed(base, `${tag}:visual`)),
  });
}
