/**
 * src/visuals/layout.js
 * The one place the compartment's composition is defined.
 *
 * Both the procedural renderer (`scene.js`) and the DOM HUD (`ui/presentation.js`)
 * read these numbers, so the card fans, the bell, the slip holder and the stamp
 * wells can never drift away from the furniture they are supposed to sit on.
 *
 * Everything here is expressed in the internal 320x180 frame first (the frame the
 * art is authored in) and exported as percentages second, because the HUD lays
 * out in CSS percentages over the same box.
 *
 * Two camera framings are provided:
 *   - `wide`    desktop / landscape. The table runs from the far bench to the
 *               near rail; we see the whole compartment.
 *   - `portrait` phones. The camera pulls back and widens vertically so the table
 *               still spans the frame when the viewport is tall and narrow; the
 *               side walls crop out instead of the table cropping off.
 *
 * Art Phase 2 requirement: "the Inspector occupies the upper center, the table
 * widens toward the foreground, and the two card fans sit at its far and near
 * edges". The row table below is the contract that enforces that.
 */

import { INTERNAL_SIZE } from "../data/palette.js";

const W = INTERNAL_SIZE.width;
const H = INTERNAL_SIZE.height;

/** Camera framings. `fov` is vertical-ish; projectView uses it on height. */
export const CAMERAS = Object.freeze({
  /**
   * Chosen by numeric search (tools/sceneLayout.js) against the rule that the
   * table must widen by >3x from the far edge to the near edge, the far edge
   * must sit in the middle third, the near edge on the bottom fifth, and both
   * near corners must stay inside the frame.
   */
  wide: Object.freeze({
    pos: Object.freeze([0, 1.7, -1.3]),
    target: Object.freeze([0, 1.7 - Math.tan(0.35) * 3.0, 1.7]),
    fovDegrees: 56,
  }),
  /**
   * Phones. The camera sits lower and nearer than the desktop rig so the side
   * walls stay inside the frustum (a pulled-back camera put the cabin walls
   * outside the frame and left a flat void), while the table still fills the
   * lower half. Chosen with the same numeric scan as `wide`.
   */
  portrait: Object.freeze({
    pos: Object.freeze([0, 1.65, -1.2]),
    target: Object.freeze([0, 1.65 - Math.tan(0.38) * 3.2, 2.0]),
    fovDegrees: 68,
  }),
});

/**
 * The compartment, in metres. +z runs away from the passenger, +x is right,
 * +y is up, and the tabletop is the plane y = TABLE.top.
 */
export const COMPARTMENT = Object.freeze({
  // Side walls at |x| = halfWidth. Narrowed from the old 1.35 m so the cabin
  // reads as a train compartment rather than a hall.
  halfWidth: 1.16,
  /**
   * Window, offset to the passenger's left of the Inspector. Its cold light is
   * the rim light on his hood/shoulder, so it must not sit directly behind him.
   */
  window: Object.freeze({ x0: -1.06, x1: -0.24, y0: 0.98, y1: 1.78 }),
  ceiling: 2.06,
  backWallZ: 2.3,
  // The passenger's own seat back, closest to camera.
  nearSeatZ: -0.32,
});

export const TABLE = Object.freeze({
  /**
   * Far edge (the Inspector's side) and near edge (the passenger's side).
   * The ratio between these two is the whole composition: the near edge is
   * ~2.7x the far edge, which is what makes the table read as coming toward you.
   */
  farZ: 1.06,
  nearZ: -0.12,
  farHalfWidth: 0.62,
  nearHalfWidth: 1.40,
  top: 0.585,
  thickness: 0.075,
});

/**
 * Where the interactive rows live on the table. `t` is the normalised depth
 * along the table from the far edge (0) to the near edge (1); `halfWidth(t)`
 * interpolates the table width at that depth. The HUD receives the resulting
 * screen rectangles so every physical affordance and its DOM control share a
 * box by construction.
 */
export const ROWS = Object.freeze({
  // Inspector's fan: just in front of the far edge, on his side of the bell.
  farFan: Object.freeze({ t: 0.2, cards: 4 }),
  // Instrument row: slip holder left of centre, bell at centre, manifest right.
  slip: Object.freeze({ t: 0.445, x: -0.62 }),
  bell: Object.freeze({ t: 0.43, x: 0.0 }),
  manifest: Object.freeze({ t: 0.45, x: 0.66 }),
  // Passenger's fan: the near third, where the hands actually are.
  nearFan: Object.freeze({ t: 0.735, cards: 5 }),
  // Stamp wells + tool rack are cut into the near rail itself.
  wells: Object.freeze({ t: 0.93 }),
});

/** Table half-width at depth t (0 = far edge, 1 = near edge). */
export function halfWidthAt(t) {
  return TABLE.farHalfWidth + (TABLE.nearHalfWidth - TABLE.farHalfWidth) * t;
}

/** World-space z at depth t. */
export function zAt(t) {
  return TABLE.farZ + (TABLE.nearZ - TABLE.farZ) * t;
}

/**
 * Screen-space rectangle of the table band between two depths, plus the
 * x extents. Pure maths — shared by scene.js and the HUD layout.
 */
export function tableBand(cam, t0, t1, halfWidthScale = 1) {
  const z0 = zAt(t0);
  const z1 = zAt(t1);
  const w0 = halfWidthAt(t0) * halfWidthScale;
  const w1 = halfWidthAt(t1) * halfWidthScale;
  return {
    far: { z: z0, halfWidth: w0 },
    near: { z: z1, halfWidth: w1 },
    y: TABLE.top,
  };
}

/** Percentage helpers for the DOM layer. */
export function pctX(px) {
  return `${((px / W) * 100).toFixed(2)}%`;
}
export function pctY(py) {
  return `${((py / H) * 100).toFixed(2)}%`;
}

/**
 * The scene anchors the HUD positions itself against. Filled in by
 * `describeLayout()` (which has the camera maths) and consumed by
 * `ui/presentation.js`; kept as a plain object so it serialises into tests.
 */
export const SCENE_ANCHORS = Object.freeze({
  /** Names must stay stable: the HUD and the tests both read them. */
  names: Object.freeze([
    "inspectorHead",
    "farFan",
    "slip",
    "bell",
    "manifest",
    "nearFan",
    "wells",
    "window",
    "lanternRail",
    "routeStrip",
  ]),
});

export { W as FRAME_WIDTH, H as FRAME_HEIGHT };

/** Fit the full 320×180 scene into the available stage without cropping. */
export function sceneTransform(viewportWidth, viewportHeight) {
  const fw = INTERNAL_SIZE.width;
  const fh = INTERNAL_SIZE.height;
  const sx = viewportWidth / fw;
  const sy = viewportHeight / fh;
  // `cover` was tried on phones and abandoned: the frame is 16:9 while a phone
  // viewport is ~9:19.5, so covering crops to a 26%-wide keyhole of the
  // compartment. The phone instead uses `contain` for the picture (a short band
  // that acts as the room's "window") and stacks the fixtures over it.
  const scale = Math.min(sx, sy);
  return {
    scale,
    width: Math.round(fw * scale),
    height: Math.round(fh * scale),
    offsetX: Math.round((viewportWidth - fw * scale) / 2),
    offsetY: Math.round((viewportHeight - fh * scale) / 2),
  };
}

/** Project a point given in frame percentages into viewport pixels. */
export function projectFramePoint(transform, xPct, yPct) {
  return {
    left: Math.round(transform.offsetX + (xPct / 100) * INTERNAL_SIZE.width * transform.scale),
    top: Math.round(transform.offsetY + (yPct / 100) * INTERNAL_SIZE.height * transform.scale),
  };
}
