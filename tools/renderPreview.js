/**
 * tools/renderPreview.js
 * Dev-only harness: renders the procedural carriage to PNG so the art can be
 * inspected outside a browser. Not part of the shipped static build and not
 * imported by the game.
 *
 * Usage: node tools/renderPreview.js [outDir] [times...]
 *
 * Contains a minimal 2D canvas implemented on Uint8ClampedArray covering the
 * subset scene.js uses (fillRect, path fill, gradients, clip, getImageData).
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { drawScene, SCENE_INFO } from "../src/visuals/scene.js";

// --------------------------------------------------------------------------
// Tiny canvas
// --------------------------------------------------------------------------

function parseColor(str) {
  if (typeof str !== "string") return [0, 0, 0, 1];
  const m = str.trim().match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts.length > 3 ? parts[3] : 1];
  }
  const h = str.trim().match(/^#([0-9a-f]{6})$/i);
  if (h) {
    const v = parseInt(h[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 1];
  }
  return [0, 0, 0, 1];
}

class Ctx {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
    this.fillStyle = "#000000";
    this.globalAlpha = 1;
    this._clip = null;
    this._stack = [];
    this._path = [];
    this._grad = null;
  }

  save() {
    this._stack.push({
      fillStyle: this.fillStyle,
      globalAlpha: this.globalAlpha,
      clip: this._clip,
    });
  }

  restore() {
    const s = this._stack.pop();
    if (!s) return;
    this.fillStyle = s.fillStyle;
    this.globalAlpha = s.globalAlpha;
    this._clip = s.clip;
  }

  beginPath() {
    this._path = [];
    this._grad = null;
  }

  moveTo(x, y) {
    this._path.push([[x, y]]);
  }

  lineTo(x, y) {
    if (this._path.length === 0) this._path.push([]);
    this._path[this._path.length - 1].push([x, y]);
  }

  closePath() {}

  rect(x, y, w, h) {
    this._path = [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]];
  }

  ellipse(cx, cy, rx, ry, rot, a0, a1) {
    const pts = [];
    const steps = 24;
    for (let i = 0; i <= steps; i += 1) {
      const a = a0 + ((a1 - a0) * i) / steps;
      pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
    }
    this._path = [pts];
  }

  clip() {
    this._clip = this._path.flat().slice();
  }

  createLinearGradient(x0, y0, x1, y1) {
    return { type: "linear", x0, y0, x1, y1, stops: [], addColorStop(t, c) { this.stops.push([t, c]); } };
  }

  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    return { type: "radial", x0, y0, r0, x1, y1, r1, stops: [], addColorStop(t, c) { this.stops.push([t, c]); } };
  }

  _resolveStyle(x, y) {
    const style = this.fillStyle;
    if (!style || typeof style === "string") return parseColor(style);
    if (style.type === "linear") {
      const dx = style.x1 - style.x0;
      const dy = style.y1 - style.y0;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - style.x0) * dx + (y - style.y0) * dy) / len2));
      return gradColor(style, t);
    }
    const dx = x - style.x1;
    const dy = y - style.y1;
    const d = Math.hypot(dx, dy);
    const t = Math.max(0, Math.min(1, (d - style.r0) / ((style.r1 - style.r0) || 1)));
    return gradColor(style, t);
  }

  fillRect(x, y, w, h) {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const x1 = Math.round(x + w);
    const y1 = Math.round(y + h);
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) this._blend(px, py);
    }
  }

  fill() {
    const polys = this._path;
    if (!polys.length) return;
    let minY = Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const poly of polys) {
      for (const [x, y] of poly) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.height - 1, Math.ceil(maxY));
    const x0 = Math.max(0, Math.floor(minX));
    const x1 = Math.min(this.width - 1, Math.ceil(maxX));
    for (let py = y0; py <= y1; py += 1) {
      const cy = py + 0.5;
      const xs = [];
      for (const poly of polys) {
        for (let i = 0; i < poly.length; i += 1) {
          const a = poly[i];
          const b = poly[(i + 1) % poly.length];
          if ((a[1] <= cy && b[1] > cy) || (b[1] <= cy && a[1] > cy)) {
            xs.push(a[0] + ((cy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
          }
        }
      }
      if (!xs.length) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const sx = Math.max(x0, Math.ceil(xs[k] - 0.5));
        const ex = Math.min(x1, Math.floor(xs[k + 1] - 0.5));
        for (let px = sx; px <= ex; px += 1) this._blend(px, py);
      }
    }
  }

  _blend(px, py) {
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    if (this._clip && !pointInPoly(px + 0.5, py + 0.5, this._clip)) return;
    const [r, g, b, a] = this._resolveStyle(px + 0.5, py + 0.5);
    const alpha = a * this.globalAlpha;
    if (alpha <= 0) return;
    const i = (py * this.width + px) * 4;
    const d = this.data;
    d[i] = d[i] * (1 - alpha) + r * alpha;
    d[i + 1] = d[i + 1] * (1 - alpha) + g * alpha;
    d[i + 2] = d[i + 2] * (1 - alpha) + b * alpha;
    d[i + 3] = 255;
  }

  getImageData(x, y, w, h) {
    return { width: w, height: h, data: Uint8ClampedArray.from(this.data) };
  }

  putImageData(img) {
    this.data.set(img.data);
  }
}

function gradColor(style, t) {
  const stops = style.stops.length ? style.stops : [[0, "rgba(0,0,0,0)"]];
  let prev = stops[0];
  for (let i = 1; i < stops.length; i += 1) {
    if (t <= stops[i][0]) {
      const span = stops[i][0] - prev[0] || 1;
      const k = (t - prev[0]) / span;
      const a = parseColor(prev[1]);
      const b = parseColor(stops[i][1]);
      return [
        a[0] + (b[0] - a[0]) * k,
        a[1] + (b[1] - a[1]) * k,
        a[2] + (b[2] - a[2]) * k,
        a[3] + (b[3] - a[3]) * k,
      ];
    }
    prev = stops[i];
  }
  return parseColor(stops[stops.length - 1][1]);
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// --------------------------------------------------------------------------
// PNG writer
// --------------------------------------------------------------------------

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function writePng(file, w, h, rgba, scale = 1) {
  const outW = w * scale;
  const outH = h * scale;
  const raw = Buffer.alloc((outW * 4 + 1) * outH);
  let o = 0;
  for (let y = 0; y < outH; y += 1) {
    raw[o] = 0;
    o += 1;
    const sy = Math.floor(y / scale);
    for (let x = 0; x < outW; x += 1) {
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
  ihdr.writeUInt32BE(outW, 0);
  ihdr.writeUInt32BE(outH, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

// --------------------------------------------------------------------------

const outDir = process.argv[2] || "tools/out";
const times = process.argv.slice(3).map(Number).filter((n) => Number.isFinite(n));
const renderTimes = times.length ? times : [0, 2.4, 5.1];
fs.mkdirSync(outDir, { recursive: true });

const { width, height } = SCENE_INFO;
console.log(`Scene ${width}x${height}, ${SCENE_INFO.geometryTriangles} triangles`);

for (const t of renderTimes) {
  const ctx = new Ctx(width, height);
  const started = Date.now();
  const info = drawScene(ctx, { time: t, reducedMotion: false, mood: "neutral" });
  const ms = Date.now() - started;
  const file = path.join(outDir, `scene-t${t}.png`);
  writePng(file, width, height, ctx.data, 4);
  console.log(`  ${file}  (${ms} ms)  window=${JSON.stringify(info.window)}`);
}

// Reduced-motion + cold-mood variant.
{
  const ctx = new Ctx(width, height);
  drawScene(ctx, { time: 3, reducedMotion: true, mood: "cold" });
  writePng(path.join(outDir, "scene-reduced-cold.png"), width, height, ctx.data, 4);
  console.log(`  ${path.join(outDir, "scene-reduced-cold.png")}`);
}
