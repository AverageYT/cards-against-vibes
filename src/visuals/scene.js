/**
 * src/visuals/scene.js
 * Procedural 2.5D midnight carriage renderer.
 *
 * Zero external assets: the environment is low-poly flat-shaded geometry
 * rasterised with a painter's algorithm into a 320x180 internal buffer, the
 * Inspector is a procedurally composed 2D pixel-art billboard, and the whole
 * frame goes through a PS1-style post pass (5-bit channel quantisation,
 * ordered Bayer dithering, scanlines, vignette).
 *
 * Design notes (docs/art-direction.md):
 *   - Value first: dark ink frame, one amber lamp pool, one cold window.
 *   - One light direction per object; facets are intentional (PS1 vertex-lit).
 *   - The sprite is authored on the true pixel grid (1 unit = 1 internal px),
 *     never scaled down, so silhouettes stay crisp.
 *   - Everything is a pure function of (time, seed, state): no allocation in
 *     the hot loop and no hidden global state, so renders are reproducible.
 */

import {
  BAYER_4X4,
  INTERNAL_SIZE,
  PS1_CHANNEL_LEVELS,
  SCENE_TUNING,
  mix,
  rgb,
  scale,
} from "../data/palette.js";
import {
  CAMERAS,
  COMPARTMENT,
  ROWS,
  TABLE,
  halfWidthAt,
  zAt,
} from "./layout.js";

const NEAR_Z = 0.06;
const UP_Y = 1;

// ---------------------------------------------------------------------------
// Vector helpers (plain arrays to avoid per-frame object churn)
// ---------------------------------------------------------------------------

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function norm(a) {
  const len = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

function makeCamera(pos, target, fovDegrees, width, height, horizon = 0.46) {
  const forward = norm(sub(target, pos));
  const right = norm(cross(forward, [0, UP_Y, 0]));
  const up = cross(right, forward);
  const focal = height / 2 / Math.tan((fovDegrees * Math.PI) / 360);
  return { pos, forward, right, up, focal, width, height, cx: width / 2, cy: height * horizon };
}

/**
 * World -> view space. View space is camera-aligned with +z into the screen,
 * which makes the near-plane clip a single z test.
 */
function toView(cam, p) {
  const d = sub(p, cam.pos);
  return [dot(d, cam.right), dot(d, cam.up), dot(d, cam.forward)];
}

function projectView(cam, v) {
  const invZ = 1 / v[2];
  return [cam.cx + v[0] * cam.focal * invZ, cam.cy - v[1] * cam.focal * invZ];
}

// ---------------------------------------------------------------------------
// Geometry construction (built once, reused every frame)
// ---------------------------------------------------------------------------

/** A quad -> two triangles, as four world-space corners. */
function pushQuad(out, a, b, c, d, mat) {
  out.push({ v: [a, b, c], mat });
  out.push({ v: [a, c, d], mat });
}

/** Axis-aligned box; only the outward faces are emitted. */
function pushBox(out, min, max, mat, { skip = {} } = {}) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  if (!skip.front) pushQuad(out, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], mat);
  if (!skip.back) pushQuad(out, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], mat);
  if (!skip.left) pushQuad(out, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], mat);
  if (!skip.right) pushQuad(out, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], mat);
  if (!skip.top) pushQuad(out, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], mat);
  if (!skip.bottom) pushQuad(out, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], mat);
}

/** Subdivided horizontal surface so lamp falloff bands across facets. */
function pushGrid(out, x0, x1, z0, z1, y, cols, rows, mat, wobble = 0) {
  for (let r = 0; r < rows; r += 1) {
    const za = z0 + ((z1 - z0) * r) / rows;
    const zb = z0 + ((z1 - z0) * (r + 1)) / rows;
    for (let c = 0; c < cols; c += 1) {
      const xa = x0 + ((x1 - x0) * c) / cols;
      const xb = x0 + ((x1 - x0) * (c + 1)) / cols;
      // Scratched planks: a tiny per-facet height wobble reads as uneven wood.
      const ha = y + ((c * 7 + r * 13) % 3) * wobble;
      const hb = y + ((c * 11 + r * 5) % 3) * wobble;
      pushQuad(
        out,
        [xa, ha, zb],
        [xb, hb, zb],
        [xb, hb, za],
        [xa, ha, za],
        mat
      );
    }
  }
}

function buildCarriageGeometry() {
  const bg = [];
  const { halfWidth: hw, ceiling, backWallZ: bz } = COMPARTMENT;
  const { farZ, nearZ, farHalfWidth, nearHalfWidth, top, thickness } = TABLE;

  // =====================================================================
  // LAYER 1 - BACKGROUND (walls, ceiling, rack, window, far bench)
  // =====================================================================

  // --- Back wall: panelled wood, seam bands, skirting -------------------
  pushQuad(bg, [-hw, 0, bz], [hw, 0, bz], [hw, ceiling, bz], [-hw, ceiling, bz], "wood0");
  // Raised panel bands read as moulding under a raking lamp.
  pushBox(bg, [-hw, 0.52, bz - 0.045], [hw, 0.56, bz - 0.005], "wood1");
  pushBox(bg, [-hw, 1.46, bz - 0.045], [hw, 1.5, bz - 0.005], "wood1");
  // Skirting board.
  pushBox(bg, [-hw, 0, bz - 0.06], [hw, 0.12, bz - 0.005], "wood1");

  // --- Side walls: they crop the shot and frame the table --------------
  pushQuad(bg, [-hw, 0, bz], [-hw, 0, nearZ - 0.5], [-hw, ceiling, nearZ - 0.5], [-hw, ceiling, bz], "ink1");
  pushQuad(bg, [hw, 0, nearZ - 0.5], [hw, 0, bz], [hw, ceiling, bz], [hw, ceiling, nearZ - 0.5], "ink1");
  // Ceiling with a soft cove: two quads so the lamp pool lands unevenly.
  pushQuad(bg, [-hw, ceiling, bz], [hw, ceiling, bz], [hw, ceiling, 0.4], [-hw, ceiling, 0.4], "ink0");
  pushQuad(bg, [-hw, ceiling, 0.4], [hw, ceiling, 0.4], [hw, ceiling, nearZ - 0.5], [-hw, ceiling, nearZ - 0.5], "ink0");
  // Ceiling cove trim where wall meets ceiling.
  pushBox(bg, [-hw, ceiling - 0.045, bz - 0.08], [hw, ceiling, bz], "wood1");

  // --- Luggage rack: two brass rails + brass netting uprights ----------
  const rackY = ceiling - 0.14;
  const rackZ0 = 1.62;
  const rackZ1 = bz - 0.06;
  pushBox(bg, [-hw + 0.04, rackY, rackZ0], [-hw + 0.075, rackY + 0.028, rackZ1], "brass1");
  pushBox(bg, [hw - 0.075, rackY, rackZ0], [hw - 0.04, rackY + 0.028, rackZ1], "brass1");
  // Front lip so the rack has thickness from below.
  pushBox(bg, [-hw + 0.04, rackY - 0.03, rackZ0], [hw - 0.04, rackY, rackZ0 + 0.05], "brass0");
  for (const rx of [-0.72, -0.24, 0.24, 0.72]) {
    pushBox(bg, [rx - 0.012, rackY, rackZ0 + 0.02], [rx + 0.012, ceiling - 0.05, rackZ0 + 0.05], "brass0");
  }

  // --- Window: brass frame, glazing bars, cold night beyond ------------
  // Deliberately offset left of the Inspector so the cold light rims him.
  const wx0 = COMPARTMENT.window.x0;
  const wx1 = COMPARTMENT.window.x1;
  const wy0 = COMPARTMENT.window.y0;
  const wy1 = COMPARTMENT.window.y1;
  const wFrameZ = bz - 0.1;
  pushQuad(bg, [wx0, wy0, wFrameZ], [wx1, wy0, wFrameZ], [wx1, wy1, wFrameZ], [wx0, wy1, wFrameZ], "rain0");
  // Frame: four brass bars with a deeper sill.
  pushBox(bg, [wx0 - 0.055, wy0 - 0.07, wFrameZ - 0.01], [wx1 + 0.055, wy0, wFrameZ + 0.02], "brass1");
  pushBox(bg, [wx0 - 0.055, wy1, wFrameZ - 0.01], [wx1 + 0.055, wy1 + 0.05, wFrameZ + 0.02], "brass1");
  pushBox(bg, [wx0 - 0.055, wy0, wFrameZ - 0.01], [wx0, wy1, wFrameZ + 0.02], "brass1");
  pushBox(bg, [wx1, wy0, wFrameZ - 0.01], [wx1 + 0.055, wy1, wFrameZ + 0.02], "brass0");
  // Glazing bars.
  pushBox(bg, [wx0, (wy0 + wy1) / 2, wFrameZ - 0.005], [wx1, (wy0 + wy1) / 2 + 0.035, wFrameZ + 0.01], "brass0");
  const wmid = (wx0 + wx1) / 2;
  pushBox(bg, [wmid - 0.014, wy0, wFrameZ - 0.005], [wmid + 0.014, wy1, wFrameZ + 0.01], "brass0");

  // --- Far bench (the Inspector's seat), buttoned upholstery -----------
  // Seated on it, his shoulders must clear the table's far lip.
  const benchZ0 = farZ + 0.12;
  const benchZ1 = bz - 0.12;
  const seatY = 0.46;
  pushBox(bg, [-hw + 0.06, 0, benchZ0], [hw - 0.06, seatY, benchZ1], "velvet1");
  pushBox(bg, [-hw + 0.06, seatY - 0.05, benchZ0], [hw - 0.06, seatY, benchZ1], "velvet2");
  // Backrest, divided into buttoned panels.
  pushQuad(bg, [-hw + 0.06, seatY, benchZ1], [hw - 0.06, seatY, benchZ1], [hw - 0.06, seatY + 0.72, benchZ1], [-hw + 0.06, seatY + 0.72, benchZ1], "velvet1");
  for (let i = 0; i < 5; i += 1) {
    const x0 = -hw + 0.08 + i * ((2 * hw - 0.16) / 5);
    const x1 = x0 + (2 * hw - 0.16) / 5 - 0.02;
    pushBox(bg, [x0, seatY + 0.08, benchZ1 - 0.02], [x1, seatY + 0.62, benchZ1 - 0.005], "velvet2");
  }
  // Brass grab rail along the top of the backrest.
  pushBox(bg, [-hw + 0.06, seatY + 0.72, benchZ1 - 0.05], [hw - 0.06, seatY + 0.76, benchZ1], "brass1");

  // =====================================================================
  // LAYER 2 - TABLE (its own layer: it must occlude the Inspector's cloak)
  // =====================================================================
  const table = [];

  // Top surface, subdivided so the lamp pool bands across facets.
  const cols = 14;
  const rowsN = 12;
  for (let r = 0; r < rowsN; r += 1) {
    const t0 = r / rowsN;
    const t1 = (r + 1) / rowsN;
    const z0 = farZ + (nearZ - farZ) * t0;
    const z1 = farZ + (nearZ - farZ) * t1;
    const hw0 = farHalfWidth + (nearHalfWidth - farHalfWidth) * t0;
    const hw1 = farHalfWidth + (nearHalfWidth - farHalfWidth) * t1;
    for (let c = 0; c < cols; c += 1) {
      const u0 = c / cols;
      const u1 = (c + 1) / cols;
      const ax = -hw0 + 2 * hw0 * u0;
      const bx = -hw0 + 2 * hw0 * u1;
      const cx2 = -hw1 + 2 * hw1 * u1;
      const dx2 = -hw1 + 2 * hw1 * u0;
      // Plank unevenness: a fraction of a millimetre reads as scratched varnish.
      const wob = ((c * 7 + r * 13) % 4) * 0.0009;
      pushQuad(
        table,
        [ax, top + wob, z0],
        [bx, top + wob, z0],
        [cx2, top + wob, z1],
        [dx2, top + wob, z1],
        "wood3"
      );
    }
  }

  // Varnish wear: a darker trodden band where hands and tickets go.
  for (let r = 2; r < rowsN - 1; r += 1) {
    const t0 = r / rowsN;
    const t1 = (r + 1) / rowsN;
    const z0 = farZ + (nearZ - farZ) * t0;
    const z1 = farZ + (nearZ - farZ) * t1;
    const hw0 = (farHalfWidth + (nearHalfWidth - farHalfWidth) * t0) * 0.52;
    const hw1 = (farHalfWidth + (nearHalfWidth - farHalfWidth) * t1) * 0.52;
    pushQuad(
      table,
      [-hw0, top + 0.0016, z0],
      [hw0, top + 0.0016, z0],
      [hw1, top + 0.0016, z1],
      [-hw1, top + 0.0016, z1],
      "wood2"
    );
  }

  // Near rail: a raised brass-banded lip at the passenger's edge.
  pushQuad(table, [-nearHalfWidth, top, nearZ], [nearHalfWidth, top, nearZ], [nearHalfWidth, top - thickness, nearZ], [-nearHalfWidth, top - thickness, nearZ], "wood1");
  pushBox(table, [-nearHalfWidth, top - 0.02, nearZ - 0.018], [nearHalfWidth, top + 0.014, nearZ], "brass1");
  // Far lip: lower brass trim.
  pushQuad(table, [-farHalfWidth, top, farZ], [farHalfWidth, top, farZ], [farHalfWidth, top - thickness, farZ], [-farHalfWidth, top - thickness, farZ], "wood1");
  pushBox(table, [-farHalfWidth, top, farZ - 0.03], [farHalfWidth, top + 0.012, farZ], "brass0");
  // Side aprons (so the table has an edge, not a paper-thin sheet).
  pushQuad(table, [-nearHalfWidth, top, nearZ], [-farHalfWidth, top, farZ], [-farHalfWidth, top - thickness, farZ], [-nearHalfWidth, top - thickness, nearZ], "wood1");
  pushQuad(table, [farHalfWidth, top, farZ], [nearHalfWidth, top, nearZ], [nearHalfWidth, top - thickness, nearZ], [farHalfWidth, top - thickness, farZ], "wood1");

  return { background: bg, table };
}

const COMPARTMENT_GEO = buildCarriageGeometry();
const CARRIAGE = COMPARTMENT_GEO.background;
const TABLE_GEO = COMPARTMENT_GEO.table;


/**
 * Foreground + fixtures.
 *
 * Three distinct groups, because they occlude differently:
 *   - `lamp`: overhead brass lamp (swings, rebuilt each frame)
 *   - `straps`: hanging leather straps by the window
 *   - `seat`: the passenger's own seat back, closest to camera
 *   - `fixtures`: the physical HUD furniture sitting ON the table (bell, slip
 *     holder, manifest ledger, stamp wells). Drawn after the table so they can
 *     never be occluded by it.
 */
function buildForegroundGeometry(lamp) {
  const out = [];
  const { ceiling, halfWidth: hw, nearSeatZ } = COMPARTMENT;
  const rad = (lamp.angle * Math.PI) / 180;
  const topX = -0.6;
  const topY = ceiling;
  const shadeTop = 1.36;
  const sx = topX + Math.sin(rad) * 0.2;
  const sz = 0.74;

  // Cord from the ceiling rose to the shade.
  pushBox(out, [sx - 0.008, shadeTop, sz - 0.008], [sx + 0.008, topY, sz + 0.008], "ink0");
  pushBox(out, [topX - 0.035, topY - 0.035, sz - 0.035], [topX + 0.035, topY, sz + 0.035], "brass0");

  // Brass shade: an inverted frustum, dark inside, lit outside.
  const rTop = 0.045;
  const rBot = 0.14;
  const yTop = shadeTop + 0.095;
  pushQuad(out, [sx - rBot, shadeTop, sz + rBot], [sx + rBot, shadeTop, sz + rBot], [sx + rTop, yTop, sz + rTop], [sx - rTop, yTop, sz + rTop], "brass2");
  pushQuad(out, [sx + rBot, shadeTop, sz + rBot], [sx + rBot, shadeTop, sz - rBot], [sx + rTop, yTop, sz - rTop], [sx + rTop, yTop, sz + rTop], "brass1");
  pushQuad(out, [sx - rBot, shadeTop, sz - rBot], [sx + rBot, shadeTop, sz - rBot], [sx + rTop, yTop, sz - rTop], [sx - rTop, yTop, sz - rTop], "brass1");
  pushQuad(out, [sx + rBot, shadeTop, sz - rBot], [sx - rBot, shadeTop, sz - rBot], [sx - rTop, yTop, sz - rTop], [sx + rTop, yTop, sz - rTop], "brass0");
  // Shade rim.
  pushBox(out, [sx - rBot - 0.014, shadeTop - 0.014, sz - rBot - 0.014], [sx + rBot + 0.014, shadeTop, sz + rBot + 0.014], "brass3");
  // A six-arm spider over the shade so the lamp reads at phone size.
  for (let i = 0; i < 3; i += 1) {
    const a = (i / 3) * Math.PI;
    const dx = Math.cos(a) * (rBot + 0.035);
    const dz = Math.sin(a) * (rBot + 0.035);
    pushBox(out, [sx - Math.abs(dx) - 0.009, shadeTop + 0.012, sz + dz - 0.009], [sx + Math.abs(dx) + 0.009, shadeTop + 0.028, sz + dz + 0.009], "brass0");
  }
  // The bulb itself (emissive, drawn late so it blooms).
  pushQuad(out, [sx - 0.046, shadeTop - 0.082, sz + 0.046], [sx + 0.046, shadeTop - 0.082, sz + 0.046], [sx + 0.046, shadeTop - 0.014, sz + 0.046], [sx - 0.046, shadeTop - 0.014, sz + 0.046], "amber2");
  pushQuad(out, [sx + 0.046, shadeTop - 0.082, sz + 0.046], [sx + 0.046, shadeTop - 0.082, sz - 0.046], [sx + 0.046, shadeTop - 0.014, sz - 0.046], [sx + 0.046, shadeTop - 0.014, sz + 0.046], "amber1");
  pushQuad(out, [sx + 0.046, shadeTop - 0.082, sz - 0.046], [sx - 0.046, shadeTop - 0.082, sz - 0.046], [sx - 0.046, shadeTop - 0.014, sz - 0.046], [sx + 0.046, shadeTop - 0.014, sz - 0.046], "amber0");

  // Hanging leather straps by each window, with brass buckles.
  for (const strapX of [-0.98, 0.98]) {
    pushBox(out, [strapX - 0.032, 1.22, 1.4], [strapX + 0.032, ceiling - 0.02, 1.45], "wood0");
    pushBox(out, [strapX - 0.04, 1.22, 1.38], [strapX + 0.04, 1.27, 1.47], "brass1");
  }

  // The passenger's own seat back: the nearest thing to camera. It is what
  // makes the shot read as "seated", and it crops the table's near corners.
  pushBox(out, [-hw - 0.2, -0.4, nearSeatZ - 0.12], [hw + 0.2, 0.5, nearSeatZ + 0.1], "velvet1");
  pushBox(out, [-hw - 0.2, 0.5, nearSeatZ - 0.14], [hw + 0.2, 0.545, nearSeatZ + 0.12], "velvet2");
  pushBox(out, [-hw - 0.2, 0.545, nearSeatZ - 0.12], [hw + 0.2, 0.575, nearSeatZ + 0.1], "brass0");
  // Buttoned tufting on the near seat back.
  for (let i = -3; i <= 3; i += 1) {
    pushBox(out, [i * 0.32 - 0.016, 0.18, nearSeatZ + 0.1], [i * 0.32 + 0.016, 0.212, nearSeatZ + 0.128], "velvet0");
  }

  return out;
}

/**
 * The physical HUD furniture on the table. Derived entirely from `ROWS` in
 * layout.js so the DOM controls anchored to the same rows land exactly on them.
 */
function buildFixtureGeometry() {
  const out = [];
  const { top } = TABLE;

  // --- Bell fixture (Unlisted streak / Final Call) ----------------------
  const bellZ = zAt(ROWS.bell.t);
  const bellX = ROWS.bell.x;
  pushBox(out, [bellX - 0.075, top, bellZ - 0.055], [bellX + 0.075, top + 0.018, bellZ + 0.055], "brass1");
  // Bell dome + handle.
  pushBox(out, [bellX - 0.036, top + 0.018, bellZ - 0.03], [bellX + 0.036, top + 0.05, bellZ + 0.03], "brass2");
  pushBox(out, [bellX - 0.026, top + 0.05, bellZ - 0.022], [bellX + 0.026, top + 0.072, bellZ + 0.022], "brass3");
  pushBox(out, [bellX - 0.008, top + 0.072, bellZ - 0.008], [bellX + 0.008, top + 0.086, bellZ + 0.008], "brass1");
  // Three filing notches cut into the base's front edge (the streak reading).
  for (let i = 0; i < 3; i += 1) {
    const nx = bellX - 0.048 + i * 0.048;
    pushBox(out, [nx - 0.008, top + 0.002, bellZ + 0.055], [nx + 0.008, top + 0.014, bellZ + 0.058], "ink0");
  }

  // --- Paper slip in a spring-clip holder (turn + action prompt) -------
  const slipZ = zAt(ROWS.slip.t);
  const slipX = ROWS.slip.x;
  pushBox(out, [slipX - 0.135, top, slipZ - 0.05], [slipX + 0.135, top + 0.006, slipZ + 0.05], "wood1");
  // The slip itself: a slightly raised cream card, tilted toward the player.
  pushQuad(
    out,
    [slipX - 0.12, top + 0.006, slipZ + 0.045],
    [slipX + 0.12, top + 0.006, slipZ + 0.045],
    [slipX + 0.105, top + 0.02, slipZ - 0.04],
    [slipX - 0.105, top + 0.02, slipZ - 0.04],
    "paper0"
  );
  // Clip.
  pushBox(out, [slipX - 0.03, top + 0.02, slipZ - 0.03], [slipX + 0.03, top + 0.03, slipZ - 0.005], "brass1");

  // --- Manifest ledger at the table corner -----------------------------
  const manZ = zAt(ROWS.manifest.t);
  const manX = ROWS.manifest.x;
  pushBox(out, [manX - 0.115, top, manZ - 0.06], [manX + 0.115, top + 0.01, manZ + 0.06], "wood1");
  pushQuad(
    out,
    [manX - 0.105, top + 0.01, manZ + 0.055],
    [manX + 0.105, top + 0.01, manZ + 0.055],
    [manX + 0.115, top + 0.022, manZ - 0.05],
    [manX - 0.095, top + 0.022, manZ - 0.05],
    "paper1"
  );
  // Loose pages peeking out.
  pushBox(out, [manX - 0.09, top + 0.011, manZ - 0.075], [manX + 0.1, top + 0.016, manZ - 0.05], "paper0");

  // --- Stamp wells cut into the near rail ------------------------------
  const wellZ = zAt(ROWS.wells.t);
  for (let i = 0; i < 3; i += 1) {
    const wx = -0.42 + i * 0.42;
    // Recessed well: dark inner box with a brass lip.
    pushBox(out, [wx - 0.16, top - 0.02, wellZ - 0.075], [wx + 0.16, top + 0.004, wellZ + 0.075], "ink1");
    pushBox(out, [wx - 0.17, top - 0.006, wellZ + 0.07], [wx + 0.17, top + 0.008, wellZ + 0.085], "brass0");
  }

  return out;
}

const FIXTURES = buildFixtureGeometry();

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------

function lampPosition(time, reducedMotion) {
  const t = reducedMotion ? 0 : time * ((Math.PI * 2) / SCENE_TUNING.lampPeriodSeconds);
  const swing = reducedMotion ? 0 : Math.sin(t) * SCENE_TUNING.lampSwingDegrees;
  const swing2 = reducedMotion ? 0 : Math.cos(t * 0.61) * SCENE_TUNING.lampSwingDegrees * 0.45;
  const rad = (swing * Math.PI) / 180;
  return {
    bulb: [0.26 + Math.sin(rad) * 0.42, 1.66, 0.86 + Math.sin((swing2 * Math.PI) / 180) * 0.2],
    angle: swing,
  };
}

/**
 * Flat shade one facet. One light direction per object: the lamp is a point
 * light with radial falloff, the window is a cold fill from behind-left, and
 * everything else sits under a small ambient.
 */
function shadeFace(baseColor, normal, centroid, lamp, out) {
  const toLamp = sub(lamp.bulb, centroid);
  const dist = Math.hypot(toLamp[0], toLamp[1], toLamp[2]) || 1;
  const lampDir = [toLamp[0] / dist, toLamp[1] / dist, toLamp[2] / dist];
  const lampDot = Math.max(0, dot(normal, lampDir));
  const falloff = 1 / (1 + dist * dist * SCENE_TUNING.lampFalloff);
  const lampTerm = lampDot * falloff * SCENE_TUNING.lampIntensity;

  // Cold window fill: direction from the glass into the room.
  const windowDot = Math.max(0, dot(normal, norm([0.55, 0.18, -1])));
  const windowTerm = windowDot * SCENE_TUNING.windowFill;

  const ambient = SCENE_TUNING.ambient;
  const lit = ambient + lampTerm + windowTerm;

  out[0] = baseColor[0] * lit + 10 * ambient;
  out[1] = baseColor[1] * lit + 13 * ambient;
  out[2] = baseColor[2] * lit + 22 * ambient;
  return out;
}

// ---------------------------------------------------------------------------
// Triangle rasteriser (painter's algorithm, flat fill, no z-buffer)
// ---------------------------------------------------------------------------

function clipNear(poly) {
  const out = [];
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const aIn = a[2] >= NEAR_Z;
    const bIn = b[2] >= NEAR_Z;
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = (NEAR_Z - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR_Z]);
    }
  }
  return out;
}

function fillPolygon(ctx, pts, r, g, b) {
  if (pts.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
  ctx.fill();
}

/** Ordered-dither a flat colour by 5-bit channel, keyed to screen position. */
function ditherColor(c, px, py) {
  const level = Math.floor(py) * 7 + Math.floor(px) * 13;
  const threshold = BAYER_4X4[level % 16];
  const step = 255 / (PS1_CHANNEL_LEVELS - 1);
  return [
    Math.max(0, Math.min(255, Math.round((c[0] + threshold * step) / step) * step)),
    Math.max(0, Math.min(255, Math.round((c[1] + threshold * step) / step) * step)),
    Math.max(0, Math.min(255, Math.round((c[2] + threshold * step) / step) * step)),
  ];
}

function drawGeometry(ctx, cam, tris, lamp, swayX, swayY) {
  // Pre-compute view space + centroid, clip, project, sort far -> near.
  const prepared = [];
  for (let i = 0; i < tris.length; i += 1) {
    const tri = tris[i];
    const v0 = toView(cam, tri.v[0]);
    const v1 = toView(cam, tri.v[1]);
    const v2 = toView(cam, tri.v[2]);
    if (v0[2] < NEAR_Z && v1[2] < NEAR_Z && v2[2] < NEAR_Z) continue;
    const poly = clipNear([v0, v1, v2]);
    if (poly.length < 3) continue;
    let depth = 0;
    for (const p of poly) depth += p[2];
    depth /= poly.length;
    prepared.push({ poly, depth, mat: tri.mat, tri });
  }
  prepared.sort((a, b) => b.depth - a.depth);

  for (const item of prepared) {
    const { tri, poly, depth } = item;
    // Facet normal in world space.
    const n = norm(cross(sub(tri.v[1], tri.v[0]), sub(tri.v[2], tri.v[0])));
    const centroid = [
      (tri.v[0][0] + tri.v[1][0] + tri.v[2][0]) / 3,
      (tri.v[0][1] + tri.v[1][1] + tri.v[2][1]) / 3,
      (tri.v[0][2] + tri.v[1][2] + tri.v[2][2]) / 3,
    ];
    // Face the camera: flip normals that point away (single-sided quads).
    const viewDir = sub(centroid, cam.pos);
    const facing = dot(n, viewDir) > 0 ? -1 : 1;

    const lit = shadeFace(rgb(tri.mat), [
      n[0] * facing,
      n[1] * facing,
      n[2] * facing,
    ], centroid, lamp, [0, 0, 0]);

    // Depth fog toward the night colour.
    const fogT = Math.max(
      0,
      Math.min(1, (depth - SCENE_TUNING.fogNear) / (SCENE_TUNING.fogFar - SCENE_TUNING.fogNear))
    );
    const fogged = mix(lit, rgb("night2"), fogT * 0.75);

    const projected = poly.map((p) => {
      const s = projectView(cam, p);
      return [s[0] + swayX, s[1] + swayY];
    });
    const sx = projected[0][0];
    const sy = projected[0][1];
    const [r, g, b] = ditherColor(fogged, sx, sy);
    fillPolygon(ctx, projected, r, g, b);
  }
}

// ---------------------------------------------------------------------------
// Inspector: procedural 2D pixel-art billboard
// ---------------------------------------------------------------------------

const SPRITE_KEYS = {
  k: "coat0",
  c: "coat1",
  C: "coat2",
  h: "coat3",
  H: "coat4",
  f: "skin0",
  F: "skin1",
  G: "skin2",
  b: "brass2",
  B: "brass3",
  r: "seal1",
  e: "ink0",
};

const SPRITE_WIDTH = 72;
const SPRITE_HEIGHT = 56;
const SPRITE_CX = SPRITE_WIDTH / 2;

/**
 * Procedural pixel-art Inspector model.
 *
 * Built from primitives rather than hand-aligned ASCII so the silhouette is
 * exactly symmetric and the pixel grid is never violated:
 *   - hood: two concentric ellipses (outer felt, inner shadowed opening)
 *   - shoulders: a widened quadratic curve, wider than the hood (readability)
 *   - coat: a tapering trapezoid with a lighting ramp left -> right
 *   - face: brow-shadowed skin with two dark eye slits
 *
 * Everything is authored at 1 unit = 1 internal pixel (skill §5 consistency).
 */
function buildInspectorGrid() {
  const grid = Array.from({ length: SPRITE_HEIGHT }, () => new Array(SPRITE_WIDTH).fill(null));
  const put = (x, y, key) => {
    if (y < 0 || y >= SPRITE_HEIGHT || x < 0 || x >= SPRITE_WIDTH) return;
    grid[y][x] = key;
  };

  // --- Hood + coat silhouette -------------------------------------------
  // Head centre sits above the shoulder line; body widens then tapers.
  const headCy = 17;
  const headCx = SPRITE_CX;
  const hoodRx = 14;
  const hoodRy = 14.6;

  for (let y = 0; y < SPRITE_HEIGHT; y += 1) {
    // Coat half-width: shoulders flare out at y=30, then close toward the hem.
    let halfW;
    if (y < 26) halfW = hoodRx - 1;
    else if (y < 33) {
      const t = (y - 26) / 7;
      halfW = 11 + (25.5 - 11) * t * t;
    } else {
      const t = Math.min(1, (y - 33) / 23);
      halfW = 25.5 - 13.5 * t * t;
    }

    // Inside the hood band only the hood is drawn; the coat starts below it.
    for (let x = Math.floor(headCx - halfW); x <= Math.ceil(headCx + halfW); x += 1) {
      const dx = (x + 0.5 - headCx) / halfW;
      if (Math.abs(dx) > 1) continue;
      const depth = Math.sqrt(Math.max(0, 1 - dx * dx)); // 1 centre, 0 edge
      let key;
      if (y < 26) {
        const hoodDist =
          ((x + 0.5 - headCx) / hoodRx) ** 2 + ((y + 0.5 - headCy) / hoodRy) ** 2;
        if (hoodDist <= 1) {
          // Hood felt with a left-lit rim.
          if (hoodDist > 0.82) key = dx < -0.35 ? "H" : dx > 0.35 ? "C" : "h";
          else key = dx < -0.2 ? "C" : "c";
        } else if (y > 24) {
          key = "C";
        } else {
          continue;
        }
      } else {
        // Coat lighting ramp: lit from the upper-left, ink shadow to the right.
        key = depth > 0.72 ? (dx < -0.45 ? "h" : dx > 0.45 ? "c" : "C") : dx < -0.5 ? "C" : "c";
        if (y > 47) key = dx < -0.2 ? "C" : "c";
      }
      put(x, y, key);
    }
  }

  // --- Hood opening & face ----------------------------------------------
  const faceRx = 8.4;
  const faceRy = 9.6;
  const faceCy = 21.5;
  for (let y = 0; y < SPRITE_HEIGHT; y += 1) {
    for (let x = 0; x < SPRITE_WIDTH; x += 1) {
      const fx = (x + 0.5 - headCx) / faceRx;
      const fy = (y + 0.5 - faceCy) / faceRy;
      const d = fx * fx + fy * fy;
      if (d > 1) continue;
      if (d > 0.7) {
        put(x, y, "k"); // deep hood shadow at the opening rim
      } else if (y < faceCy - 0.5) {
        put(x, y, "f"); // brow shadow under the hood brim
      } else if (y < faceCy + 2) {
        put(x, y, fx < -0.4 ? "F" : "f");
      } else {
        put(x, y, "f");
      }
    }
  }

  // Brim shadow across the eyes: a single dark band, then the eye slits.
  for (let x = Math.floor(headCx - 10); x < headCx + 10; x += 1) {
    for (const yy of [18, 19, 20]) if (grid[yy] && (grid[yy][x] === "f" || grid[yy][x] === "F")) put(x, yy, "k");
  }
  // One-pixel eye slits set deep beneath the brim.
  for (const ex of [-3, 3]) {
    put(headCx + ex, 21, "e");
    put(headCx + ex + 1, 21, "e");
  }
  // One cheekbone catch light on the lamp side only.
  put(headCx - 4, 24, "F");
  put(headCx - 5, 24, "F");

  // --- Raised collar + under-hood shadow ---------------------------------
  for (let x = Math.floor(headCx - 11); x < headCx + 11; x += 1) {
    for (let y = 26; y < 30; y += 1) {
      if (grid[y] && grid[y][x]) put(x, y, y === 26 ? "k" : x < headCx ? "h" : "C");
    }
  }

  // --- Collar, buttons, chain ------------------------------------------
  for (let x = Math.floor(headCx - 7); x < headCx + 7; x += 1) {
    if (grid[29] && grid[29][x]) put(x, 29, x < headCx ? "h" : "C");
  }
  for (let i = 0; i < 5; i += 1) put(headCx + (i % 2 === 0 ? 0 : 1), 33 + i * 4, "b");
  put(headCx - 5, 31, "B");
  put(headCx + 5, 31, "b");
  // Watch chain: a shallow brass arc across the coat front.
  for (let i = 0; i < 7; i += 1) {
    const cx = headCx - 8 + i * 2;
    const cy = 36 + Math.round(Math.sin((i / 6) * Math.PI) * 2);
    if (grid[cy] && grid[cy][cx] === "c") put(cx, cy, "B");
  }

  // --- Left hand resting on the table edge ------------------------------
  const handY = 48;
  const handX = headCx + 12;
  for (let y = handY - 1; y <= handY + 1; y += 1) {
    for (let x = handX; x < handX + 5; x += 1) put(x, y, y === handY - 1 ? "F" : "f");
  }

  return grid;
}

const SPRITE_GRID = buildInspectorGrid();

/**
 * Compose one animation frame as horizontal runs (one fillRect per run).
 * Secondary action: 1px breathing, a 1px head tilt, and a hand lift.
 */
function composeInspectorFrame({ breathing, headTilt, handLift }) {
  const runs = [];
  const bodyShiftY = breathing ? 1 : 0;

  for (let y = 0; y < SPRITE_GRID.length; y += 1) {
    const isHead = y < 27;
    const isHand = y >= 46;
    const dx = isHead || isHand ? headTilt : 0;
    const dy = isHand ? handLift + bodyShiftY : isHead ? 0 : bodyShiftY;
    const row = SPRITE_GRID[y];
    let runStart = -1;
    let runKey = null;
    for (let x = 0; x <= row.length; x += 1) {
      const key = x < row.length ? row[x] : null;
      if (key !== runKey) {
        if (runKey) runs.push({ x: runStart + dx, y: y + dy, w: x - runStart, key: runKey });
        runKey = key;
        runStart = x;
      }
    }
  }
  return runs;
}

const FRAME_CACHE = new Map();
function getInspectorFrame(breathing, headTilt, handLift) {
  const key = `${breathing}|${headTilt}|${handLift}`;
  let frame = FRAME_CACHE.get(key);
  if (!frame) {
    frame = { runs: composeInspectorFrame({ breathing, headTilt, handLift }) };
    FRAME_CACHE.set(key, frame);
  }
  return frame;
}

/**
 * Draw the Inspector across the table. He is anchored to the far side of the
 * table and scaled by hand (not by the 3D projection) so his pixel grid stays
 * perfectly aligned to the internal resolution.
 */
function drawInspector(ctx, cam, { time, reducedMotion, mood }) {
  const anchorWorld = [0, 0.80, 1.66];
  const v = toView(cam, anchorWorld);
  if (v[2] < NEAR_Z) return null;
  const base = projectView(cam, v);

  // Secondary action: 1px breathing (~0.25 Hz), occasional head tilt, hand lift.
  const t = reducedMotion ? 0 : time;
  const breathing = Math.sin(t * 1.55) > 0.35;
  const tiltWave = Math.sin(t * 0.43);
  const headTilt = reducedMotion ? 0 : tiltWave > 0.55 ? 1 : tiltWave < -0.55 ? -1 : 0;
  const handLift = reducedMotion ? 0 : Math.sin(t * 0.91) > 0.7 ? -1 : 0;
  const frame = getInspectorFrame(breathing, headTilt, handLift);

  const originX = Math.round(base[0] - SPRITE_WIDTH / 2);
  // +14 pushes his hem below the table's far lip, so the table occludes it.
  const originY = Math.round(base[1] - SPRITE_HEIGHT + 14);

  // Contact shadow under the coat so he sits in the space instead of floating.
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = "rgb(4,6,11)";
  ctx.beginPath();
  ctx.ellipse(base[0] + 2, originY + SPRITE_HEIGHT - 3, 30, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Rim light pass: the window is the light source, so the silhouette's
  // left-facing edge and the top of each run catch a thin cold highlight. This
  // is what keeps a near-black coat readable against a near-black bench.
  const rimPixels = new Set();
  const rowFirstRun = new Map();
  for (const run of frame.runs) {
    if (!rowFirstRun.has(run.y)) rowFirstRun.set(run.y, run);
    else {
      const prev = rowFirstRun.get(run.y);
      if (run.x < prev.x) rowFirstRun.set(run.y, run);
    }
  }
  for (const [y, run] of rowFirstRun) {
    // Only the upper hood catches the glass. Below that the coat is in the
    // bench shadow, and rimming the whole edge looked like a neon outline.
    if (y < 3 || y > 20) continue;
    rimPixels.add(`${run.x},${y}`);
  }

  for (const run of frame.runs) {
    const paletteId = SPRITE_KEYS[run.key];
    if (!paletteId) continue;
    let c = rgb(paletteId);
    // He is one cold figure; the lamp only warms him slightly from upper-left.
    if (mood === "cold") c = mix(c, rgb("rain1"), 0.26);
    else if (mood === "warm") c = mix(c, rgb("amber0"), 0.16);
    const [r, g, b] = ditherColor(c, originX + run.x, originY + run.y);
    ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    ctx.fillRect(originX + run.x, originY + run.y, run.w, 1);
  }

  // Second pass: paint the rim highlight on the silhouette edge. Deliberately
  // below the glass' own value so it reads as reflected light, not an outline.
  ctx.fillStyle = "rgb(74,100,126)";
  for (const key of rimPixels) {
    const [rx, ry] = key.split(",").map(Number);
    ctx.fillRect(originX + rx, originY + ry, 1, 1);
  }

  return { x: originX, y: originY, width: SPRITE_WIDTH, height: SPRITE_HEIGHT };
}

/** Faint window-glass reflection of the Inspector, mirrored across the table. */
function drawInspectorReflection(ctx, cam, sprite, windowRect) {
  if (!sprite || !windowRect) return;
  // Mirrored in the glass: only the head/shoulder band, and only inside the
  // window, so it never reads as a second character.
  const glassY = windowRect.y + Math.round(windowRect.h * 0.52);
  const glassX0 = windowRect.x + Math.round(windowRect.w * 0.56);
  const maxW = Math.round(windowRect.w * 0.38);
  ctx.save();
  ctx.beginPath();
  ctx.rect(windowRect.x + 1, windowRect.y + 1, windowRect.w - 2, windowRect.h - 2);
  ctx.clip();
  for (let y = 0; y < 14; y += 1) {
    const w = Math.round(maxW - y * 1.1);
    if (w <= 0) break;
    ctx.globalAlpha = 0.1 - y * 0.005;
    ctx.fillStyle = "rgb(168,198,220)";
    // The head silhouette: wider at the shoulders, narrowing at the hood.
    const inset = Math.round(y * 0.35);
    ctx.fillRect(glassX0 + inset, glassY + y, Math.max(1, w - inset), 1);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Atmosphere: light cone, rain, dust motes
// ---------------------------------------------------------------------------

function drawLightCone(ctx, lamp) {
  // The lamp's pool on the table. Drawn as a stack of horizontal bands whose
  // width and opacity both fall off, so there is no straight polygon edge for
  // the eye to catch — the light simply thins into the dark.
  const cx = Number.isFinite(lamp.x) ? lamp.x : 160;
  const topY = Math.round(lamp.topY || 60);
  const bottomY = Math.round(lamp.bottomY || 158);
  const sway = lamp.swingPx || 0;
  ctx.save();
  const bands = 26;
  for (let i = 0; i < bands; i += 1) {
    const t = i / (bands - 1);
    const y = topY + (bottomY - topY) * t;
    // Widens downward but stays inside the table.
    const halfW = 14 + 66 * t * t;
    // Fades out toward both ends of the cone.
    const fade = Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 1.4;
    const alpha = 0.085 * fade;
    if (alpha <= 0.002) continue;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "rgb(240,191,124)";
    const py = Math.round(y);
    ctx.fillRect(Math.round(cx - halfW + sway), py, Math.round(halfW * 2), 1);
  }
  ctx.restore();
}

/** Rain on the glass: streaks fall, droplets cling and slide. */
function drawRain(ctx, time, reducedMotion, windowRect) {
  const t = reducedMotion ? 0 : time;
  const { x, y, w, h } = windowRect;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  // Wet glass wash, cooler at the top.
  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, "rgb(29,42,68)");
  grad.addColorStop(0.55, "rgb(43,61,85)");
  grad.addColorStop(1, "rgb(19,28,48)");
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);

  // Distant platform lamps blurred behind the rain.
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = "rgb(122,156,184)";
  for (let i = 0; i < 3; i += 1) {
    const lx = x + 10 + i * 14 + Math.sin(t * 0.1 + i) * 0.6;
    const ly = y + 22 + (i % 2) * 7;
    ctx.fillRect(lx | 0, ly | 0, 2, 1);
  }
  ctx.globalAlpha = 1;

  // Slanted rain streaks scrolling down-right.
  const streakCount = 26;
  for (let i = 0; i < streakCount; i += 1) {
    const seedX = (i * 37) % w;
    const speed = 22 + ((i * 13) % 17);
    const progress = ((t * speed + i * 19) % (h + 22)) - 11;
    const sx = x + seedX + progress * 0.16;
    const sy = y + progress;
    const len = 3 + (i % 4);
    ctx.globalAlpha = 0.18 + ((i * 7) % 11) / 55;
    ctx.fillStyle = "rgb(168,198,220)";
    for (let k = 0; k < len; k += 1) {
      ctx.fillRect(Math.round(sx + k * 0.16), Math.round(sy + k), 1, 1);
    }
  }

  // Clinging droplets that occasionally slide.
  for (let i = 0; i < 9; i += 1) {
    const dx = x + ((i * 53) % (w - 3)) + 1;
    const drift = Math.sin(t * 0.6 + i) * 1.2;
    const dy = y + 8 + ((i * 29) % (h - 14));
    ctx.globalAlpha = 0.34;
    ctx.fillStyle = "rgb(200,220,236)";
    ctx.fillRect(Math.round(dx + drift), Math.round(dy), 1, 2);
    ctx.globalAlpha = 0.16;
    ctx.fillRect(Math.round(dx + drift), Math.round(dy + 2), 1, 1);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawDustMotes(ctx, time, reducedMotion) {
  if (reducedMotion) return;
  ctx.save();
  for (let i = 0; i < 12; i += 1) {
    const phase = time * (0.12 + (i % 5) * 0.03) + i;
    const x = 96 + Math.sin(phase * 1.7 + i) * 54 + (i % 3) * 9;
    const y = 62 + ((phase * 9 + i * 13) % 70);
    ctx.globalAlpha = 0.1 + ((i * 3) % 7) / 90;
    ctx.fillStyle = "rgb(255,231,184)";
    ctx.fillRect(x | 0, y | 0, 1, 1);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Post pass: PS1 pixel-art, dithering, banding, scanlines, vignette
// ---------------------------------------------------------------------------

function applyPostPass(ctx, width, height, options, time) {
  const {
    ditherStrength = 1,
    scanlines = true,
    vignette = SCENE_TUNING.vignetteStrength,
    grain = SCENE_TUNING.grainStrength,
    reduceMotion = false,
  } = options || {};

  const frame = ctx.getImageData(0, 0, width, height);
  const data = frame.data;
  const step = 255 / (PS1_CHANNEL_LEVELS - 1);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const i = rowOffset + x * 4;
      const threshold = BAYER_4X4[(y % 4) * 4 + (x % 4)] * ditherStrength;

      // 1. Ordered dithering + 5-bit quantisation (PS1 colour banding).
      let r = data[i] + threshold * step;
      let g = data[i + 1] + threshold * step;
      let b = data[i + 2] + threshold * step;
      r = Math.round(r / step) * step;
      g = Math.round(g / step) * step;
      b = Math.round(b / step) * step;

      // 2. Vignette toward deep ink.
      const nx = (x / width - 0.5) * 2;
      const ny = (y / height - 0.5) * 2;
      const vig = 1 - Math.min(1, (nx * nx * 0.72 + ny * ny * 0.5)) * vignette;
      r *= vig;
      g *= vig;
      b *= vig;

      // 3. Scanlines every other row.
      if (scanlines && (y & 1) === 1) {
        r *= 0.93;
        g *= 0.93;
        b *= 0.93;
      }

      // 4. Static film grain (deterministic per pixel; no Math.random).
      if (grain > 0 && !reduceMotion) {
        const n = (((x * 73856093) ^ (y * 19349663) ^ (Math.floor(time * 8) * 83492791)) & 15) - 7.5;
        const jitter = (n / 7.5) * grain;
        r += jitter;
        g += jitter;
        b += jitter;
      }

      data[i] = r < 0 ? 0 : r > 255 ? 255 : r;
      data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
  }
  ctx.putImageData(frame, 0, 0);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render one frame of the carriage.
 *
 * @param {CanvasRenderingContext2D} ctx  internal-resolution 2D context
 * @param {object} opts
 * @param {number} opts.time              seconds since mount (sway/rain clock)
 * @param {boolean} opts.reducedMotion    stops sway, dust, grain
 * @param {string} opts.mood              "warm" mid-duel, "cold" on results
 * @param {number} opts.lampSwingPx       pixel offset for lamp glow overlays
 * @returns {{window: {x:number,y:number,w:number,h:number}}}
 */
export function drawScene(ctx, opts = {}) {
  const scaleK = Math.max(1, Math.round(opts.scale || 1));
  const width = INTERNAL_SIZE.width * scaleK;
  const height = INTERNAL_SIZE.height * scaleK;
  const time = Number.isFinite(opts.time) ? opts.time : 0;
  const reducedMotion = Boolean(opts.reducedMotion);
  const mood = opts.mood || "neutral";
  const framing = CAMERAS[opts.framing] || CAMERAS.wide;

  ctx.save();
  if (scaleK !== 1) ctx.scale(scaleK, scaleK);

  // Base ink fill so clipped corners never show page colour.
  ctx.fillStyle = "#04060b";
  ctx.fillRect(0, 0, INTERNAL_SIZE.width, INTERNAL_SIZE.height);

  const cam = makeCamera(
    framing.pos,
    framing.target,
    framing.fovDegrees,
    INTERNAL_SIZE.width,
    INTERNAL_SIZE.height,
    framing === CAMERAS.portrait ? 0.42 : 0.43
  );

  // Subtle carriage sway: the whole world drifts under the camera.
  const swayPhase = reducedMotion ? 0 : (time * Math.PI * 2) / SCENE_TUNING.swayPeriodSeconds;
  const swayX = reducedMotion ? 0 : Math.sin(swayPhase) * SCENE_TUNING.swayAmount * width;
  const swayY = reducedMotion
    ? 0
    : Math.cos(swayPhase * 0.73) * SCENE_TUNING.swayAmount * height * SCENE_TUNING.headSwayScale;

  const lamp = lampPosition(time, reducedMotion);

  // Window rectangle in screen space (rain clip + reflection + HUD anchor).
  const wv0 = toView(cam, [COMPARTMENT.window.x0, COMPARTMENT.window.y0, COMPARTMENT.backWallZ - 0.1]);
  const wv1 = toView(cam, [COMPARTMENT.window.x1, COMPARTMENT.window.y1, COMPARTMENT.backWallZ - 0.1]);
  const wa = projectView(cam, wv0);
  const wb = projectView(cam, wv1);
  const windowRect = {
    x: Math.round(Math.min(wa[0], wb[0]) + swayX),
    y: Math.round(Math.min(wa[1], wb[1]) + swayY),
    w: Math.round(Math.abs(wb[0] - wa[0])),
    h: Math.round(Math.abs(wb[1] - wa[1])),
  };

  // ---- LAYER 1: background (walls, rack, window, far bench) -----------
  drawGeometry(ctx, cam, CARRIAGE, lamp, swayX, swayY);

  // ---- LAYER 2: rain behind the glazing bars + cold glow --------------
  drawRain(ctx, time, reducedMotion, {
    x: windowRect.x + 1,
    y: windowRect.y + 1,
    w: Math.max(1, windowRect.w - 2),
    h: Math.max(1, windowRect.h - 2),
  });
  ctx.save();
  ctx.globalAlpha = 0.22;
  const glow = ctx.createRadialGradient(
    windowRect.x + windowRect.w * 0.5,
    windowRect.y + windowRect.h * 0.5,
    2,
    windowRect.x + windowRect.w * 0.5,
    windowRect.y + windowRect.h * 0.5,
    windowRect.w * 1.05
  );
  glow.addColorStop(0, "rgb(168,198,220)");
  glow.addColorStop(1, "rgba(29,42,68,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(windowRect.x - 34, windowRect.y - 30, windowRect.w + 68, windowRect.h + 60);
  ctx.restore();

  // ---- LAYER 3: Inspector (cloak runs below the table line; the table
  //      is drawn after him, so his lower body is occluded by it) --------
  const sprite = drawInspector(ctx, cam, { time, reducedMotion, mood });
  drawInspectorReflection(ctx, cam, sprite, windowRect);

  // ---- LAYER 4: the table, which occludes the cloak -------------------
  drawGeometry(ctx, cam, TABLE_GEO, lamp, swayX, swayY);

  // Contact shadow where the Inspector's coat meets the table's far lip. Without
  // it he reads as a cut-out floating above the wood.
  if (sprite) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "rgb(6,8,12)";
    const sx0 = Math.max(0, sprite.x + 10);
    const sw = Math.min(INTERNAL_SIZE.width - sx0, SPRITE_WIDTH - 20);
    const sy = sprite.y + SPRITE_HEIGHT - 9;
    for (let i = 0; i < 5; i += 1) {
      ctx.globalAlpha = 0.42 - i * 0.075;
      ctx.fillRect(sx0 - i, Math.round(sy + i), sw + i * 2, 1);
    }
    ctx.restore();
  }

  // ---- LAYER 5: fixtures sitting on the table -------------------------
  drawGeometry(ctx, cam, FIXTURES, lamp, swayX, swayY);

  // ---- LAYER 6: lamp bloom, light cone, dust --------------------------
  const lampScreen = (() => {
    const lv = toView(cam, lamp.bulb);
    return lv[2] < NEAR_Z ? null : projectView(cam, lv);
  })();
  if (lampScreen) {
    ctx.save();
    const halo = ctx.createRadialGradient(lampScreen[0], lampScreen[1] - 6, 1, lampScreen[0], lampScreen[1] - 6, 52);
    halo.addColorStop(0, "rgba(255,231,184,0.5)");
    halo.addColorStop(0.35, "rgba(240,191,124,0.14)");
    halo.addColorStop(1, "rgba(240,191,124,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(lampScreen[0] - 54, lampScreen[1] - 60, 108, 108);
    ctx.restore();
  }
  drawLightCone(ctx, { x: lampScreen ? lampScreen[0] : 160, swingPx: Math.round(lamp.angle * 1.6) });
  drawDustMotes(ctx, time, reducedMotion);

  // ---- LAYER 7: foreground (lamp body, straps, passenger's seat) ------
  drawGeometry(ctx, cam, buildForegroundGeometry(lamp), lamp, swayX, swayY);

  ctx.restore();

  // ---- LAYER 8: PS1 post pass ----------------------------------------
  if (opts.post !== false) {
    applyPostPass(
      ctx,
      width,
      height,
      {
        ditherStrength: opts.ditherStrength ?? SCENE_TUNING.ditherStrength,
        scanlines: opts.scanlines !== false,
        vignette: opts.vignette ?? SCENE_TUNING.vignetteStrength,
        grain: opts.grain ?? SCENE_TUNING.grainStrength,
        reduceMotion: reducedMotion,
      },
      time
    );
  }

  return { window: windowRect };
}

/**
 * Layout probe: projects the composition's key rows through the real camera
 * and returns their internal-frame rectangles plus a set of pass/fail checks.
 * Used by `tools/sceneLayout.js` and by the test suite, so the composition is
 * assertable rather than eyeballed.
 */
export function describeLayout(opts = {}) {
  const framing = CAMERAS[opts.framing] || CAMERAS.wide;
  const cam = makeCamera(
    framing.pos,
    framing.target,
    framing.fovDegrees,
    INTERNAL_SIZE.width,
    INTERNAL_SIZE.height,
    framing === CAMERAS.portrait ? 0.42 : 0.43
  );
  const P = (p) => {
    const v = toView(cam, p);
    return v[2] < NEAR_Z ? null : projectView(cam, v);
  };
  const rectOf = (points) => {
    const pts = points.map(P).filter(Boolean);
    if (!pts.length) return null;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x = Math.round(Math.min(...xs));
    const y = Math.round(Math.min(...ys));
    return {
      x,
      y,
      w: Math.round(Math.max(...xs) - x),
      h: Math.round(Math.max(...ys) - y),
    };
  };
  const rowRect = (t, halfWidthScale, depth = 0.06) =>
    rectOf([
      [-halfWidthAt(t) * halfWidthScale, TABLE.top, zAt(t) - depth],
      [halfWidthAt(t) * halfWidthScale, TABLE.top, zAt(t) - depth],
      [-halfWidthAt(t) * halfWidthScale, TABLE.top, zAt(t) + depth],
      [halfWidthAt(t) * halfWidthScale, TABLE.top, zAt(t) + depth],
    ]);

  const headAnchor = P([0, 1.28, 1.86]);
  const features = [];
  const push = (name, r) => {
    if (r) features.push({ name, ...r });
  };
  push("inspectorHead", headAnchor ? { x: Math.round(headAnchor[0]) - 26, y: Math.round(headAnchor[1]) - 40, w: 52, h: 46 } : null);
  push("farFan", rowRect(ROWS.farFan.t, 0.42));
  push("slip", rowRect(ROWS.slip.t, 0.14));
  push("bell", rowRect(ROWS.bell.t, 0.1));
  push("manifest", rowRect(ROWS.manifest.t, 0.16));
  push("nearFan", rowRect(ROWS.nearFan.t, 0.8));
  push("wells", rowRect(ROWS.wells.t, 0.85));
  push(
    "window",
    rectOf([
      [COMPARTMENT.window.x0, COMPARTMENT.window.y0, 2.2],
      [COMPARTMENT.window.x1, COMPARTMENT.window.y0, 2.2],
      [COMPARTMENT.window.x0, COMPARTMENT.window.y1, 2.2],
      [COMPARTMENT.window.x1, COMPARTMENT.window.y1, 2.2],
    ])
  );
  push(
    "tableNearEdge",
    rectOf([
      [-TABLE.nearHalfWidth, TABLE.top, TABLE.nearZ],
      [TABLE.nearHalfWidth, TABLE.top, TABLE.nearZ],
    ])
  );
  push(
    "tableFarEdge",
    rectOf([
      [-TABLE.farHalfWidth, TABLE.top, TABLE.farZ],
      [TABLE.farHalfWidth, TABLE.top, TABLE.farZ],
    ])
  );

  const get = (name) => features.find((f) => f.name === name);
  const head = get("inspectorHead");
  const far = get("farFan");
  const near = get("nearFan");
  const nearEdge = get("tableNearEdge");
  const farEdge = get("tableFarEdge");

  const checks = [];
  const check = (label, pass, detail) => checks.push({ label, pass: Boolean(pass), detail });

  // Upper centre: the Inspector's head straddles the vertical midline and sits
  // in the top half of the frame.
  check(
    "Inspector occupies the upper centre",
    head && Math.abs(head.x + head.w / 2 - INTERNAL_SIZE.width / 2) < 26 && head.y + head.h < INTERNAL_SIZE.height * 0.62,
    head ? `centre x=${Math.round(head.x + head.w / 2)}, bottom y=${head.y + head.h}` : "not projected"
  );

  // The table widens toward the foreground by a clear margin.
  const farW = farEdge ? farEdge.w : 0;
  const nearW = nearEdge ? nearEdge.w : 0;
  check(
    "Table widens toward the foreground",
    nearW > farW * 1.9,
    `far ${farW}px -> near ${nearW}px (${(nearW / Math.max(1, farW)).toFixed(2)}x)`
  );

  // The two fans sit at the far and near edges, in that order, and neither is
  // pushed off the frame.
  check(
    "Far fan is above the near fan",
    far && near && far.y + far.h <= near.y,
    far && near ? `far bottom ${far.y + far.h} < near top ${near.y}` : "not projected"
  );
  check(
    "Both fans are fully inside the frame",
    far && near && far.y >= 0 && near.y + near.h <= INTERNAL_SIZE.height && far.w <= INTERNAL_SIZE.width && near.w <= INTERNAL_SIZE.width,
    far && near ? `far ${far.y}..${far.y + far.h}, near ${near.y}..${near.y + near.h}` : "not projected"
  );
  // Far fan must clear the Inspector's chin so the room reads through it.
  check(
    "Room stays visible between Inspector and far fan",
    head && far && far.y - (head.y + head.h) > 2,
    head && far ? `gap ${far.y - (head.y + head.h)}px` : "not projected"
  );

  return {
    camera: { pos: framing.pos, target: framing.target, fov: framing.fovDegrees },
    features,
    checks,
  };
}

/**
 * Blocking pass: flat silhouettes, no lighting/dither/rain. Every group in one
 * recognisable flat colour so placement and overlap can be judged in isolation.
 * Dev-only (tools/sceneLayout.js); never used by the game.
 */
export function drawBlocking(ctx, opts = {}) {
  const scaleK = Math.max(1, Math.round(opts.scale || 1));
  if (scaleK !== 1) ctx.scale(scaleK, scaleK);
  const framing = CAMERAS[opts.framing] || CAMERAS.wide;
  const cam = makeCamera(
    framing.pos,
    framing.target,
    framing.fovDegrees,
    INTERNAL_SIZE.width,
    INTERNAL_SIZE.height,
    framing === CAMERAS.portrait ? 0.42 : 0.43
  );
  const paint = (tris, color) => {
    for (const tri of tris) {
      const vs = tri.v.map((p) => toView(cam, p));
      if (vs.every((v) => v[2] < NEAR_Z)) continue;
      const poly = clipNear(vs);
      if (poly.length < 3) continue;
      fillPolygon(ctx, poly.map((p) => projectView(cam, p)), color[0], color[1], color[2]);
    }
  };
  ctx.fillStyle = "#101418";
  ctx.fillRect(0, 0, INTERNAL_SIZE.width, INTERNAL_SIZE.height);
  paint(CARRIAGE, [52, 74, 96]);      // background = blue
  const sprite = drawInspectorBlocking(ctx, cam);
  paint(TABLE_GEO, [168, 122, 60]);   // table = amber
  paint(FIXTURES, [96, 200, 140]);    // fixtures = green
  paint(buildForegroundGeometry(lampPosition(0, true)), [200, 76, 76]); // foreground = red
  return sprite;
}

/**
 * Overlay the two card fans at real ticket proportions (dev/QA only).
 * Used to prove the compartment stays visible when both hands are full.
 */
export function drawFanOverlay(ctx, opts = {}) {
  const scaleK = Math.max(1, Math.round(opts.scale || 1));
  if (scaleK !== 1) ctx.scale(scaleK, scaleK);
  const framing = CAMERAS[opts.framing] || CAMERAS.wide;
  const cam = makeCamera(
    framing.pos,
    framing.target,
    framing.fovDegrees,
    INTERNAL_SIZE.width,
    INTERNAL_SIZE.height,
    framing === CAMERAS.portrait ? 0.42 : 0.43
  );
  const project = (x, y, z) => {
    const v = toView(cam, [x, y, z]);
    return v[2] < NEAR_Z ? null : projectView(cam, v);
  };
  const paintFan = (row, count, liftStart, scale) => {
    const t = row.t;
    const z = zAt(t);
    const halfW = halfWidthAt(t) * 0.46;
    // Card size in world units, then projected per corner: a fixed pixel size
    // would be wrong for both fans at once under this perspective.
    const cardW = 0.115 * scale;
    const cardH = 0.155 * scale;
    for (let i = 0; i < count; i += 1) {
      const u = count === 1 ? 0 : (i / (count - 1)) * 2 - 1;
      const x = u * halfW;
      const lift = i === liftStart ? 0.02 : 0;
      // Card standing on the table, leaning back very slightly.
      const corners = [
        project(x - cardW, TABLE.top + 0.001, z - 0.055),
        project(x + cardW, TABLE.top + 0.001, z - 0.055),
        project(x + cardW, TABLE.top + cardH + lift, z - 0.075),
        project(x - cardW, TABLE.top + cardH + lift, z - 0.075),
      ];
      if (corners.some((c) => !c)) continue;
      ctx.fillStyle = i === liftStart ? "rgb(233,220,192)" : "rgb(198,186,160)";
      ctx.beginPath();
      ctx.moveTo(corners[0][0], corners[0][1]);
      for (let k = 1; k < corners.length; k += 1) ctx.lineTo(corners[k][0], corners[k][1]);
      ctx.closePath();
      // The dev Ctx supports polygon fill; fall back to a bounding rect.
      if (typeof ctx.fill === "function") {
        ctx.fill();
      } else {
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        ctx.fillRect(Math.round(Math.min(...xs)), Math.round(Math.min(...ys)),
          Math.max(2, Math.round(Math.max(...xs) - Math.min(...xs))),
          Math.max(2, Math.round(Math.max(...ys) - Math.min(...ys))));
      }
    }
  };
  paintFan(ROWS.farFan, 4, 1, 1);
  paintFan(ROWS.nearFan, 5, 2, 1);
}

/** Flat silhouette of the Inspector for the blocking pass. */
function drawInspectorBlocking(ctx, cam) {
  const v = toView(cam, [0, 0.72, 1.72]);
  if (v[2] < NEAR_Z) return null;
  const base = projectView(cam, v);
  const frame = getInspectorFrame(false, 0, 0);
  const originX = Math.round(base[0] - SPRITE_WIDTH / 2);
  const originY = Math.round(base[1] - SPRITE_HEIGHT + 14);
  ctx.fillStyle = "rgb(232,232,232)";
  for (const run of frame.runs) ctx.fillRect(originX + run.x, originY + run.y, run.w, 1);
  return { x: originX, y: originY };
}

export const SCENE_INFO = Object.freeze({
  width: INTERNAL_SIZE.width,
  height: INTERNAL_SIZE.height,
  // Total across every draw layer, not just the background: the table, the
  // table fixtures and the foreground are all part of the low-poly budget.
  geometryTriangles: CARRIAGE.length + TABLE_GEO.length + FIXTURES.length,
  layerTriangles: {
    background: CARRIAGE.length,
    table: TABLE_GEO.length,
    fixtures: FIXTURES.length,
  },
  paletteRoles: ["ink", "night", "glass", "wood", "brass", "amber", "coat", "skin", "seal", "paper"],
});

/**
 * Lightweight, JSON-safe frame probe for the in-browser test runner: renders
 * one frame into a throwaway context stand-in and reports what was drawn
 * without requiring a DOM canvas or Node APIs.
 */
export function probeSceneFrame({ time = 0, reducedMotion = false, mood = "neutral" } = {}) {
  const calls = { solid: 0, lines: 0, clipped: 0, post: 0 };
  const data = new Uint8ClampedArray(INTERNAL_SIZE.width * INTERNAL_SIZE.height * 4);
  let pathPoints = 0;
  const ctx = {
    fillStyle: "",
    globalAlpha: 1,
    save() {},
    restore() {},
    scale() {},
    beginPath() {
      pathPoints = 0;
    },
    moveTo() {
      pathPoints += 1;
    },
    lineTo() {},
    closePath() {},
    ellipse() {
      pathPoints += 1;
    },
    rect() {
      pathPoints += 1;
    },
    clip() {
      calls.clipped += 1;
    },
    fill() {
      calls.solid += pathPoints > 0 ? 1 : 0;
    },
    fillRect(x, y, w, h) {
      if (h <= 2) calls.lines += 1;
      else calls.solid += 1;
    },
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: Uint8ClampedArray.from(data) }),
    putImageData: () => {
      calls.post += 1;
    },
    drawImage() {},
  };
  const info = drawScene(ctx, { time, reducedMotion, mood });
  return { ...calls, window: info.window, frames: 1 };
}

export { SPRITE_WIDTH, SPRITE_HEIGHT };
