/**
 * tools/sceneLayout.js
 * Dev-only placement harness. Projects the scene's key points through the real
 * camera maths and reports where each one lands in the internal 320x180 frame
 * (and as a percentage of the frame), so composition can be checked numerically
 * before any detail is drawn.
 *
 * Also renders a flat "blocking" pass: every geometry group in a single flat
 * colour with no lighting, no rain, no dithering — the traditional grey-box —
 * so silhouettes and overlaps can be judged on their own.
 *
 * Usage: node tools/sceneLayout.js [outDir]
 * Not part of the shipped build and not imported by the game.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { INTERNAL_SIZE } from "../src/data/palette.js";
import { describeLayout, drawBlocking, drawFanOverlay, drawScene } from "../src/visuals/scene.js";
import { CAMERAS, TABLE } from "../src/visuals/layout.js";

const W = INTERNAL_SIZE.width;
const H = INTERNAL_SIZE.height;

// --------------------------------------------------------------------------
// Minimal RGBA canvas (same subset as tools/renderPreview.js)
// --------------------------------------------------------------------------

class Ctx {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
    this.fillStyle = "#000000";
    this.globalAlpha = 1;
    this._path = [];
    this._stack = [];
  }
  save() {
    this._stack.push({
      fillStyle: this.fillStyle,
      globalAlpha: this.globalAlpha,
    });
  }
  restore() {
    const s = this._stack.pop();
    if (!s) return;
    this.fillStyle = s.fillStyle;
    this.globalAlpha = s.globalAlpha;
  }
  beginPath() {
    this._path = [];
  }
  moveTo(x, y) {
    this._path.push([x, y]);
  }
  lineTo(x, y) {
    this._path.push([x, y]);
  }
  closePath() {}
  rect(x, y, w, h) {
    this._path.push([x, y], [x + w, y], [x + w, y + h], [x, y + h]);
  }
  ellipse(cx, cy, rx, ry) {
    this._path = [];
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2;
      this._path.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
    }
  }
  clip() {}
  fill() {
    const parsed = parseColor(this.fillStyle);
    if (!parsed) return;
    const [r, g, b, a] = parsed;
    const alpha = a * this.globalAlpha;
    if (this._path.length < 3) return;
    fillPolygonPx(this, this._path, r, g, b, alpha);
  }
  fillRect(x, y, w, h) {
    const parsed = parseColor(this.fillStyle);
    if (!parsed) return;
    const [r, g, b, a] = parsed;
    const alpha = a * this.globalAlpha;
    const x0 = Math.round(Math.min(x, x + w));
    const x1 = Math.round(Math.max(x, x + w));
    const y0 = Math.round(Math.min(y, y + h));
    const y1 = Math.round(Math.max(y, y + h));
    for (let py = y0; py < y1; py += 1) {
      if (py < 0 || py >= this.height) continue;
      for (let px = x0; px < x1; px += 1) {
        if (px < 0 || px >= this.width) continue;
        blend(this, px, py, r, g, b, alpha);
      }
    }
  }
  createLinearGradient() {
    return { addColorStop() {} };
  }
  createRadialGradient() {
    return { addColorStop() {} };
  }
  getImageData() {
    return { width: this.width, height: this.height, data: this.data };
  }
  putImageData() {}
  drawImage() {}
}

function parseColor(str) {
  // Gradient objects are real in the browser but cannot be sampled here. Skip
  // them rather than painting opaque black, so QA renders stay honest: a missing
  // soft gradient is obvious, a black box looks like a bug in the game.
  if (typeof str !== "string") return null;
  const m = str.trim().match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(",").map((s) => parseFloat(s.trim()));
    return [p[0] || 0, p[1] || 0, p[2] || 0, p.length > 3 ? p[3] : 1];
  }
  const h = str.trim().match(/^#([0-9a-f]{6})$/i);
  if (h) {
    const v = parseInt(h[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 1];
  }
  return [0, 0, 0, 1];
}

function blend(ctx, x, y, r, g, b, a) {
  const i = (y * ctx.width + x) * 4;
  const d = ctx.data;
  d[i] = d[i] + (r - d[i]) * a;
  d[i + 1] = d[i + 1] + (g - d[i + 1]) * a;
  d[i + 2] = d[i + 2] + (b - d[i + 2]) * a;
  d[i + 3] = Math.max(d[i + 3], Math.round(255 * a));
}

function fillPolygonPx(ctx, pts, r, g, b, a) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(ctx.height - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y += 1) {
    const xs = [];
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      if ((p[1] <= y && q[1] > y) || (q[1] <= y && p[1] > y)) {
        xs.push(p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]));
      }
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.round(xs[k]));
      const xb = Math.min(ctx.width - 1, Math.round(xs[k + 1]));
      for (let x = xa; x <= xb; x += 1) blend(ctx, x, y, r, g, b, a);
    }
  }
}

// --------------------------------------------------------------------------
// PNG writer
// --------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function writePng(file, w, h, rgba, scale = 1) {
  const ow = w * scale;
  const oh = h * scale;
  const raw = Buffer.alloc((ow * 4 + 1) * oh);
  let o = 0;
  for (let y = 0; y < oh; y += 1) {
    raw[o] = 0;
    o += 1;
    const sy = Math.floor(y / scale);
    for (let x = 0; x < ow; x += 1) {
      const sx = Math.floor(x / scale);
      const i = (sy * w + sx) * 4;
      raw[o] = rgba[i];
      raw[o + 1] = rgba[i + 1];
      raw[o + 2] = rgba[i + 2];
      raw[o + 3] = 255;
      o += 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ow, 0);
  ihdr.writeUInt32BE(oh, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ])
  );
}

// --------------------------------------------------------------------------
// Report
// --------------------------------------------------------------------------

const outDir = process.argv[2] || "tools/out";
fs.mkdirSync(outDir, { recursive: true });

const layout = describeLayout();
console.log(`Internal frame ${W}x${H}`);
console.log(`Camera pos ${layout.camera.pos} -> target ${layout.camera.target}, fov ${layout.camera.fov}\n`);
console.log("Feature            x     y     w     h    %x    %y");
for (const row of layout.features) {
  const pc = (v, d) => ((v / d) * 100).toFixed(0).padStart(4);
  console.log(
    `${row.name.padEnd(18)}${String(row.x).padStart(4)}  ${String(row.y).padStart(4)}  ` +
      `${String(row.w).padStart(4)}  ${String(row.h).padStart(4)}  ${pc(row.x + row.w / 2, W)}  ${pc(row.y + row.h / 2, H)}`
  );
}

console.log("\nChecks:");
for (const check of layout.checks) {
  console.log(`  ${check.pass ? "PASS" : "FAIL"}  ${check.label}${check.detail ? ` — ${check.detail}` : ""}`);
}

const ctx = new Ctx(W, H);
drawBlocking(ctx, { scale: 1 });
writePng(path.join(outDir, "blocking.png"), W, H, ctx.data, 4);
console.log(`\nWrote ${path.join(outDir, "blocking.png")}`);

// Portrait framing (390x844 viewport -> the phone camera). The internal frame is
// still 320x180; the stage crops it, so we only care that the table still spans.
const portrait = describeLayout({ framing: "portrait" });
console.log("\nPortrait framing checks:");
for (const c of portrait.checks) {
  console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
}
const ctx2 = new Ctx(W, H);
drawBlocking(ctx2, { scale: 1, framing: "portrait" });
writePng(path.join(outDir, "blocking-portrait.png"), W, H, ctx2.data, 4);
console.log(`Wrote ${path.join(outDir, "blocking-portrait.png")}`);

// "Both hands fully populated" check: render the lit scene, then overlay both
// card fans at real proportions. The QA question is whether the room (window,
// Inspector, bench, lamp) is still legible underneath.
const ctx3 = new Ctx(W, H);
drawScene(ctx3, { time: 4.7, reducedMotion: false, mood: "neutral", post: false });
const before = Buffer.from(ctx3.data);
drawFanOverlay(ctx3, { scale: 1 });
let changed = 0;
for (let i = 0; i < before.length; i += 4) {
  if (Math.abs(before[i] - ctx3.data[i]) > 8) changed += 1;
}
const coverage = (changed / (W * H)) * 100;
console.log(`\nFan overlay covers ${coverage.toFixed(1)}% of the frame with both hands full`);
const fanCheck = coverage < 26;
console.log(`  ${fanCheck ? "PASS" : "FAIL"}  Room stays visible with both hands fully populated`);
writePng(path.join(outDir, "both-hands-full.png"), W, H, ctx3.data, 4);

// Lit portrait render, so the phone camera is inspected by eye and not only by
// the numeric checks above.
const ctxP = new Ctx(W, H);
drawScene(ctxP, { time: 4.7, reducedMotion: false, mood: "neutral", framing: "portrait" });
writePng(path.join(outDir, "portrait-lit.png"), W, H, ctxP.data, 4);
console.log(`Wrote ${path.join(outDir, "portrait-lit.png")}`);
console.log(`Wrote ${path.join(outDir, "both-hands-full.png")}`);

if (!layout.checks.every((c) => c.pass) || !fanCheck) process.exitCode = 1;

export { CAMERAS, TABLE };
