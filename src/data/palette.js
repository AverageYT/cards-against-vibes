/**
 * src/data/palette.js
 * Locked art-direction palette + renderer constants for The Unlisted.
 *
 * Art direction follows `docs/art-direction.md`:
 *   - Nostalgic/retro reference frame (PS1-era midnight railway), limited palette.
 *   - Low-poly 3D environment + 2D pixel-art Inspector under one post pass.
 *   - Value structure: dark ink frame -> amber lamp pool -> cold wet glass.
 *   - Every colour has a semantic role, so ticket/UI art and 3D geometry agree.
 *
 * Edit surface: this file is the single source of truth for scene colour. UI
 * tokens live in `styles/main.css` and intentionally mirror these roles.
 */

/** Internal render resolution (true pixel-art grid, 16:9). */
export const INTERNAL_SIZE = Object.freeze({ width: 320, height: 180 });

/** Ordered Bayer 4x4 threshold matrix, normalised to (-0.5, 0.5). */
export const BAYER_4X4 = Object.freeze([
  -0.46875, 0.03125, -0.34375, 0.15625,
  0.28125, -0.21875, 0.40625, -0.09375,
  -0.28125, 0.21875, -0.15625, 0.34375,
  0.46875, -0.03125, 0.09375, -0.40625,
]);

/** 16-bit-ish PS1 channel depth (5 bits per channel = 32 levels). */
export const PS1_CHANNEL_LEVELS = 32;

/**
 * Named palette. `role` groups the ramp so scene geometry and DOM art stay in
 * one colour family (skill rule: same object = same colour family).
 */
export const PALETTE = Object.freeze([
  // Ink / night — the frame, deep shadow, vignette.
  { id: "ink0", hex: "#04060b", ramp: "night" },
  { id: "ink1", hex: "#0a1020", ramp: "night" },
  { id: "night2", hex: "#131c30", ramp: "night" },
  { id: "night3", hex: "#1d2a44", ramp: "night" },
  // Cold rain / wet glass.
  { id: "rain0", hex: "#2b3d55", ramp: "glass" },
  { id: "rain1", hex: "#496684", ramp: "glass" },
  { id: "rain2", hex: "#7a9cb8", ramp: "glass" },
  { id: "rain3", hex: "#a8c6dc", ramp: "glass" },
  // Varnished wood, scratched.
  { id: "wood0", hex: "#1a1310", ramp: "wood" },
  { id: "wood1", hex: "#2c2017", ramp: "wood" },
  { id: "wood2", hex: "#42301f", ramp: "wood" },
  { id: "wood3", hex: "#5b4128", ramp: "wood" },
  { id: "wood4", hex: "#7a5a37", ramp: "wood" },
  // Brass trim.
  { id: "brass0", hex: "#453519", ramp: "brass" },
  { id: "brass1", hex: "#78602e", ramp: "brass" },
  { id: "brass2", hex: "#b0925a", ramp: "brass" },
  { id: "brass3", hex: "#e3c387", ramp: "brass" },
  // Lamp / amber light.
  { id: "amber0", hex: "#c08a4a", ramp: "amber" },
  { id: "amber1", hex: "#f0bf7c", ramp: "amber" },
  { id: "amber2", hex: "#ffe7b8", ramp: "amber" },
  // Rain-dark coat & hood.
  { id: "coat0", hex: "#080a0e", ramp: "coat" },
  { id: "coat1", hex: "#131820", ramp: "coat" },
  { id: "coat2", hex: "#222b36", ramp: "coat" },
  { id: "coat3", hex: "#37424f", ramp: "coat" },
  { id: "coat4", hex: "#55636f", ramp: "coat" },
  // Face / hands (warm, low-saturation).
  { id: "skin0", hex: "#6f523f", ramp: "skin" },
  { id: "skin1", hex: "#a9835f", ramp: "skin" },
  { id: "skin2", hex: "#d3b08b", ramp: "skin" },
  // Wax seal red (only accents: condition, seal emblem).
  { id: "seal0", hex: "#742d27", ramp: "seal" },
  { id: "seal1", hex: "#ad4a3b", ramp: "seal" },
  // Ticket stock creams.
  { id: "paper0", hex: "#c9bda3", ramp: "paper" },
  { id: "paper1", hex: "#e6dcc6", ramp: "paper" },
  { id: "unlisted0", hex: "#b2b7b4", ramp: "paper" },
]);

const HEX_TO_RGB = new Map(
  PALETTE.map((entry) => {
    const hex = entry.hex.slice(1);
    return [
      entry.id,
      [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ],
    ];
  })
);

/** `rgb("brass3")` -> [227, 195, 135]. Returns black for unknown ids. */
export function rgb(id) {
  const found = HEX_TO_RGB.get(id);
  return found ? [found[0], found[1], found[2]] : [0, 0, 0];
}

/** `hex("brass3")` -> "#e3c387". Unknown ids return the ink colour. */
export function hex(id) {
  const entry = PALETTE.find((p) => p.id === id);
  return entry ? entry.hex : "#04060b";
}

/** Linear RGB mix used by the software shader. */
export function mix(a, b, t) {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
}

export function scale(c, k) {
  return [c[0] * k, c[1] * k, c[2] * k];
}

export function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Ordered-dither a linear colour into 5-bit PS1 channels. */
export function ditherAndQuantize(c, threshold, levels = PS1_CHANNEL_LEVELS) {
  const step = 255 / (levels - 1);
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    const dithered = c[i] + threshold * step;
    out[i] = clamp255(Math.round(dithered / step) * step);
  }
  return out;
}

/** Nearest palette entry for band-limiting the final image. */
export function nearestPaletteId(c) {
  let best = "ink0";
  let bestDist = Infinity;
  for (const [id, p] of HEX_TO_RGB) {
    const dr = c[0] - p[0];
    const dg = c[1] - p[1];
    const db = c[2] - p[2];
    const dist = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
    if (dist < bestDist) {
      bestDist = dist;
      best = id;
    }
  }
  return best;
}

/** Scene tuning constants. Kept here so the whole look is editable in one file. */
export const SCENE_TUNING = Object.freeze({
  fovDegrees: 62,
  camera: Object.freeze({ pos: Object.freeze([0, 1.22, -1.36]), target: Object.freeze([0, 0.98, 1.6]) }),
  swayPeriodSeconds: 9.5,
  swayAmount: 0.006,
  headSwayScale: 1.4,
  lampPeriodSeconds: 4.7,
  lampSwingDegrees: 2.6,
  fogNear: 2.1,
  fogFar: 4.6,
  ambient: 0.2,
  windowFill: 0.3,
  lampIntensity: 1.35,
  lampFalloff: 0.34,
  pixelateStrength: 1,
  ditherStrength: 1,
  scanlineStrength: 0.035,
  vignetteStrength: 0.56,
  grainStrength: 3.5,
});
