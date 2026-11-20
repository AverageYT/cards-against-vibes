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

function makeCamera(pos, target, fovDegrees, width, height) {
  const forward = norm(sub(target, pos));
  const right = norm(cross(forward, [0, UP_Y, 0]));
  const up = cross(right, forward);
  const focal = height / 2 / Math.tan((fovDegrees * Math.PI) / 360);
  return { pos, forward, right, up, focal, width, height, cx: width / 2, cy: height * 0.46 };
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
  const back = [];

  // --- Back wall (dark panelled wood) with brass horizontal rail ------------
  pushGrid(back, -1.35, 1.35, 2.19, 2.2, 0, 1, 1, "wood0"); // placeholder-safe
  pushQuad(back, [-1.35, 0, 2.2], [1.35, 0, 2.2], [1.35, 2.15, 2.2], [-1.35, 2.15, 2.2], "wood0");
  // Wall panelling seams (two raised bands).
  pushBox(back, [-1.35, 0.72, 2.14], [1.35, 0.76, 2.2], "wood1");
  pushBox(back, [-1.35, 1.62, 2.14], [1.35, 1.66, 2.2], "wood1");
  // Luggage rack rails above the window.
  pushBox(back, [-1.3, 1.92, 2.05], [1.3, 1.955, 2.1], "brass1");
  pushBox(back, [-1.3, 1.995, 2.02], [1.3, 2.03, 2.06], "brass0");

  // --- Side walls (very dark, they only frame the shot) -------------------
  pushQuad(back, [-1.35, 0, 2.2], [-1.35, 0, -0.2], [-1.35, 2.15, -0.2], [-1.35, 2.15, 2.2], "ink1");
  pushQuad(back, [1.35, 0, -0.2], [1.35, 0, 2.2], [1.35, 2.15, 2.2], [1.35, 2.15, -0.2], "ink1");
  // Ceiling.
  pushQuad(back, [-1.35, 2.15, 2.2], [1.35, 2.15, 2.2], [1.35, 2.15, -0.2], [-1.35, 2.15, -0.2], "ink0");

  // --- Window: recessed brass frame + cold glass -------------------------
  const wx0 = -1.02;
  const wx1 = -0.06;
  const wy0 = 0.92;
  const wy1 = 1.78;
  // Frame.
  pushBox(back, [wx0 - 0.05, wy0 - 0.05, 2.12], [wx1 + 0.05, wy0, 2.2], "brass1");
  pushBox(back, [wx0 - 0.05, wy1, 2.12], [wx1 + 0.05, wy1 + 0.05, 2.2], "brass1");
  pushBox(back, [wx0 - 0.05, wy0, 2.12], [wx0, wy1, 2.2], "brass1");
  pushBox(back, [wx1, wy0, 2.12], [wx1 + 0.05, wy1, 2.2], "brass0");
  // Glazing bars.
  pushBox(back, [wx0, 1.32, 2.16], [wx1, 1.36, 2.19], "brass0");
  pushBox(back, [(wx0 + wx1) / 2 - 0.02, wy0, 2.16], [(wx0 + wx1) / 2 + 0.02, wy1, 2.19], "brass0");

  // --- Opposite bench (Inspector's seat) ---------------------------------
  pushBox(back, [-1.2, 0.0, 1.72], [1.2, 0.44, 2.08], "wood1");
  pushBox(back, [-1.2, 0.44, 1.74], [1.2, 0.5, 2.04], "wood2");
  pushBox(back, [-1.2, 0.5, 1.74], [1.2, 1.28, 1.78], "wood2"); // backrest
  // Bench brass grab rail.
  pushBox(back, [-1.2, 1.3, 1.71], [1.2, 1.34, 1.75], "brass1");

  // --- Fold-down table: apron, brass brackets, scratched top -------------
  const tx = 0.66;
  const tz0 = 0.02;
  const tz1 = 1.12;
  const ty = 0.585;
  // Apron (front face of the folded leaf).
  pushBox(back, [-tx, ty - 0.085, tz0], [tx, ty, tz0 + 0.03], "wood1");
  // Brass hinges.
  pushBox(back, [-0.42, ty - 0.09, tz0 - 0.005], [-0.3, ty, tz0 + 0.02], "brass1");
  pushBox(back, [0.3, ty - 0.09, tz0 - 0.005], [0.42, ty, tz0 + 0.02], "brass1");
  // The scratched tabletop itself, as a lit facet grid.
  pushGrid(back, -tx, tx, tz0 + 0.02, tz1, ty, 9, 10, "wood3", 0.0016);
  // Darker varnished wear band down the middle of the table.
  pushGrid(back, -0.12, 0.14, tz0 + 0.3, tz1 - 0.08, ty + 0.002, 3, 6, "wood2", 0.001);
  // Raised brass edge trim along the far lip.
  pushBox(back, [-tx, ty, tz1 - 0.03], [tx, ty + 0.012, tz1], "brass1");

  return back;
}

const CARRIAGE = buildCarriageGeometry();

/**
 * Overhead brass lamp + hanging leather straps + the passenger's own seat
 * back in the foreground. Rebuilt each frame because the lamp swings.
 */
function buildForegroundGeometry(lamp) {
  const out = [];
  const [lx, ly, lz] = lamp.bulb;
  const rad = (lamp.angle * Math.PI) / 180;
  const topX = 0.0;
  const topY = 2.15;
  const shadeTop = 1.8;
  const sx = topX + Math.sin(rad) * 0.3;
  const sz = 0.86;
  void ly;

  // Cord from the ceiling rose to the shade.
  pushBox(out, [sx - 0.008, shadeTop, sz - 0.008], [sx + 0.008, topY, sz + 0.008], "ink0");
  pushBox(out, [topX - 0.03, topY - 0.03, sz - 0.03], [topX + 0.03, topY, sz + 0.03], "brass0");

  // Brass shade: an inverted frustum, dark inside, lit outside.
  const rTop = 0.045;
  const rBot = 0.15;
  const yTop = shadeTop + 0.085;
  pushQuad(out, [sx - rBot, shadeTop, sz + rBot], [sx + rBot, shadeTop, sz + rBot], [sx + rTop, yTop, sz + rTop], [sx - rTop, yTop, sz + rTop], "brass2");
  pushQuad(out, [sx + rBot, shadeTop, sz + rBot], [sx + rBot, shadeTop, sz - rBot], [sx + rTop, yTop, sz - rTop], [sx + rTop, yTop, sz + rTop], "brass1");
  pushQuad(out, [sx - rBot, shadeTop, sz - rBot], [sx + rBot, shadeTop, sz - rBot], [sx + rTop, yTop, sz - rTop], [sx - rTop, yTop, sz - rTop], "brass1");
  pushQuad(out, [sx + rBot, shadeTop, sz - rBot], [sx - rBot, shadeTop, sz - rBot], [sx - rTop, yTop, sz - rTop], [sx + rTop, yTop, sz - rTop], "brass0");
  // Shade rim.
  pushBox(out, [sx - rBot - 0.012, shadeTop - 0.012, sz - rBot - 0.012], [sx + rBot + 0.012, shadeTop, sz + rBot + 0.012], "brass3");
  // A six-arm spider over the shade so the lamp reads at phone size.
  for (let i = 0; i < 3; i += 1) {
    const a = (i / 3) * Math.PI;
    const dx = Math.cos(a) * (rBot + 0.03);
    const dz = Math.sin(a) * (rBot + 0.03);
    pushBox(out, [sx - Math.abs(dx) - 0.008, shadeTop + 0.01, sz + dz - 0.008], [sx + Math.abs(dx) + 0.008, shadeTop + 0.024, sz + dz + 0.008], "brass0");
  }
  // The bulb itself (emissive, drawn late so it blooms).
  pushQuad(out, [sx - 0.042, shadeTop - 0.075, sz + 0.042], [sx + 0.042, shadeTop - 0.075, sz + 0.042], [sx + 0.042, shadeTop - 0.012, sz + 0.042], [sx - 0.042, shadeTop - 0.012, sz + 0.042], "amber2");
  pushQuad(out, [sx + 0.042, shadeTop - 0.075, sz + 0.042], [sx + 0.042, shadeTop - 0.075, sz - 0.042], [sx + 0.042, shadeTop - 0.012, sz - 0.042], [sx + 0.042, shadeTop - 0.012, sz + 0.042], "amber1");
  pushQuad(out, [sx + 0.042, shadeTop - 0.075, sz - 0.042], [sx - 0.042, shadeTop - 0.075, sz - 0.042], [sx - 0.042, shadeTop - 0.012, sz - 0.042], [sx + 0.042, shadeTop - 0.012, sz - 0.042], "amber0");

  // Hanging leather straps by each window, with brass buckles.
  for (const strapX of [-0.86, 0.86]) {
    pushBox(out, [strapX - 0.034, 1.3, 1.44], [strapX + 0.034, 2.14, 1.49], "wood0");
    pushBox(out, [strapX - 0.042, 1.3, 1.42], [strapX + 0.042, 1.35, 1.5], "brass1");
  }

  // Foreground seat back: the passenger's own bench, framing the bottom edge.
  pushBox(out, [-1.5, -0.3, -0.42], [1.5, 0.34, -0.26], "wood0");
  pushBox(out, [-1.5, 0.34, -0.44], [1.5, 0.385, -0.24], "wood1");
  pushBox(out, [-1.5, 0.385, -0.42], [1.5, 0.42, -0.22], "brass0");

  return out;
}

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
  const anchorWorld = [0.06, 0.5, 1.52];
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
  const originY = Math.round(base[1] - SPRITE_HEIGHT + 16);

  // Contact shadow under the coat so he sits in the space instead of floating.
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = "rgb(4,6,11)";
  ctx.beginPath();
  ctx.ellipse(base[0] + 2, originY + SPRITE_HEIGHT - 3, 30, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  for (const run of frame.runs) {
    const paletteId = SPRITE_KEYS[run.key];
    if (!paletteId) continue;
    let c = rgb(paletteId);
    // He is one warm figure lit from the lamp above-left of the table.
    if (mood === "cold") c = mix(c, rgb("rain1"), 0.2);
    else if (mood === "warm") c = mix(c, rgb("amber0"), 0.14);
    const [r, g, b] = ditherColor(c, originX + run.x, originY + run.y);
    ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    ctx.fillRect(originX + run.x, originY + run.y, run.w, 1);
  }

  return { x: originX, y: originY, width: SPRITE_WIDTH, height: SPRITE_HEIGHT };
}

/** Faint window-glass reflection of the Inspector, mirrored across the table. */
function drawInspectorReflection(ctx, cam, sprite) {
  if (!sprite) return;
  const glassY = 78;
  const glassX0 = 266;
  const glassX1 = 300;
  ctx.save();
  ctx.globalAlpha = 0.1;
  ctx.fillStyle = "rgb(168,198,220)";
  for (let y = 0; y < 14; y += 1) {
    const srcY = sprite.y + 6 + y;
    const w = Math.round(16 - y * 0.9);
    if (w <= 0) break;
    ctx.fillRect(glassX0 + 2 + Math.abs(Math.sin(y)), glassY + y, w, 1);
  }
  ctx.globalAlpha = 0.06;
  ctx.fillRect(glassX0, glassY, glassX1 - glassX0, 16);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Atmosphere: light cone, rain, dust motes
// ---------------------------------------------------------------------------

function drawLightCone(ctx, lamp) {
  const shade = [
    [0.26, 1.62, 0.86],
    [0.26, 1.62, 0.86],
  ];
  void shade;
  // A soft trapezoid under the lampshade, brightest near the bulb.
  const topY = 66;
  const bottomY = 128;
  const grad = ctx.createLinearGradient(0, topY, 0, bottomY);
  grad.addColorStop(0, "rgba(255,231,184,0.16)");
  grad.addColorStop(0.55, "rgba(240,191,124,0.07)");
  grad.addColorStop(1, "rgba(240,191,124,0)");
  ctx.save();
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(154 + lamp.swingPx, topY);
  ctx.lineTo(166 + lamp.swingPx, topY);
  ctx.lineTo(238 + lamp.swingPx, bottomY);
  ctx.lineTo(84 + lamp.swingPx, bottomY);
  ctx.closePath();
  ctx.fill();
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
  const scale = Math.max(1, Math.round(opts.scale || 1));
  const width = INTERNAL_SIZE.width * scale;
  const height = INTERNAL_SIZE.height * scale;
  const time = Number.isFinite(opts.time) ? opts.time : 0;
  const reducedMotion = Boolean(opts.reducedMotion);
  const mood = opts.mood || "neutral";

  ctx.save();
  if (scale !== 1) ctx.scale(scale, scale);

  // Base ink fill so clipped corners never show page colour.
  ctx.fillStyle = "#04060b";
  ctx.fillRect(0, 0, width, height);

  const baseCam = makeCamera(
    SCENE_TUNING.camera.pos,
    SCENE_TUNING.camera.target,
    SCENE_TUNING.fovDegrees,
    width,
    height
  );

  // Subtle carriage sway: the whole world drifts under the camera.
  const swayPhase = reducedMotion ? 0 : (time * Math.PI * 2) / SCENE_TUNING.swayPeriodSeconds;
  const swayX = reducedMotion ? 0 : Math.sin(swayPhase) * SCENE_TUNING.swayAmount * width;
  const swayY = reducedMotion
    ? 0
    : Math.cos(swayPhase * 0.73) * SCENE_TUNING.swayAmount * height * SCENE_TUNING.headSwayScale;

  const lamp = lampPosition(time, reducedMotion);
  const cam = baseCam;

  // Window rectangle in screen space (for the rain overlay clip + reflection).
  const wv = [
    toView(cam, [-1.02, 0.92, 2.16]),
    toView(cam, [-0.06, 1.78, 2.16]),
  ];
  const wa = projectView(cam, wv[0]);
  const wb = projectView(cam, wv[1]);
  const windowRect = {
    x: Math.round(Math.min(wa[0], wb[0]) + swayX),
    y: Math.round(Math.min(wa[1], wb[1]) + swayY),
    w: Math.round(Math.abs(wb[0] - wa[0])),
    h: Math.round(Math.abs(wb[1] - wa[1])),
  };

  // 1. Environment (painter's algorithm, far to near).
  drawGeometry(ctx, cam, CARRIAGE, lamp, swayX, swayY);
  drawGeometry(ctx, cam, buildForegroundGeometry(lamp), lamp, swayX, swayY);

  // 2. Rain behind the glazing bars.
  drawRain(ctx, time, reducedMotion, {
    x: windowRect.x + 1,
    y: windowRect.y + 1,
    w: Math.max(1, windowRect.w - 2),
    h: Math.max(1, windowRect.h - 2),
  });

  // 3. Cold window glow bleeding onto the frame.
  ctx.save();
  ctx.globalAlpha = 0.2;
  const glow = ctx.createRadialGradient(
    windowRect.x + windowRect.w * 0.5,
    windowRect.y + windowRect.h * 0.5,
    2,
    windowRect.x + windowRect.w * 0.5,
    windowRect.y + windowRect.h * 0.5,
    windowRect.w * 0.85
  );
  glow.addColorStop(0, "rgb(168,198,220)");
  glow.addColorStop(1, "rgba(29,42,68,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(windowRect.x - 26, windowRect.y - 22, windowRect.w + 52, windowRect.h + 44);
  ctx.restore();

  // 4. Inspector billboard + his faint glass reflection.
  const sprite = drawInspector(ctx, cam, { time, reducedMotion, mood });
  drawInspectorReflection(ctx, cam, sprite);

  // 5. Lamp glow halo + cone over the table.
  const lampScreen = (() => {
    const lv = toView(cam, lamp.bulb);
    return lv[2] < NEAR_Z ? null : projectView(cam, lv);
  })();
  if (lampScreen) {
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    const halo = ctx.createRadialGradient(lampScreen[0], lampScreen[1] - 6, 1, lampScreen[0], lampScreen[1] - 6, 46);
    halo.addColorStop(0, "rgba(255,231,184,0.5)");
    halo.addColorStop(0.35, "rgba(240,191,124,0.14)");
    halo.addColorStop(1, "rgba(240,191,124,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(lampScreen[0] - 48, lampScreen[1] - 54, 96, 96);
    ctx.restore();
  }
  drawLightCone(ctx, { swingPx: Math.round(lamp.angle * 1.6) });
  drawDustMotes(ctx, time, reducedMotion);

  ctx.restore();

  // 6. Post pass: pixelate/dither/band/scanline/vignette.
  applyPostPass(ctx, width, height, {
    ditherStrength: opts.ditherStrength ?? SCENE_TUNING.ditherStrength,
    scanlines: opts.scanlines !== false,
    vignette: opts.vignette ?? SCENE_TUNING.vignetteStrength,
    grain: opts.grain ?? SCENE_TUNING.grainStrength,
    reduceMotion: reducedMotion,
  }, time);

  return { window: windowRect };
}

export const SCENE_INFO = Object.freeze({
  width: INTERNAL_SIZE.width,
  height: INTERNAL_SIZE.height,
  geometryTriangles: CARRIAGE.length,
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
