/**
 * src/visuals/stage.js
 * Presentation stage for the procedural 2.5D carriage.
 *
 * Responsibilities:
 *   1. Own the render clock (single requestAnimationFrame loop, paused when the
 *      tab is hidden or the scene is off-screen).
 *   2. Draw the carriage into a low-resolution buffer (320x180 by default).
 *   3. Push that buffer to the screen through the PS1 post pass:
 *        - WebGL path: nearest texture sampling + ordered Bayer dithering +
 *          5-bit palette quantisation + scanlines + vignette, in one fragment
 *          shader.
 *        - Software path (no WebGL): integer nearest upscale onto a 2D canvas
 *          plus the same maths per pixel, at a reduced step to stay cheap.
 *   4. Honour the live Pixelation toggle, reduced-motion, and full disposal.
 *
 * The stage never touches gameplay state; it only reads a render descriptor.
 */

import { INTERNAL_SIZE, PS1_CHANNEL_LEVELS } from "../data/palette.js";
import { drawScene } from "./scene.js";
import { sceneTransform } from "./layout.js";

/** Deep ink used behind letterboxed bars; matches the scene's own shadow. */
const LETTERBOX_COLOR = "#04060b";

const VERTEX_SHADER = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  // WebGL texture V runs bottom-up while the 2D buffer's row 0 is the top row,
  // so V has to be flipped or the whole scene is drawn upside down. The Canvas2D
  // fallback draws the buffer top-down, and this keeps both paths identical.
  vUv = vec2(aPos.x * 0.5 + 0.5, 1.0 - (aPos.y * 0.5 + 0.5));
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uScene;
uniform vec2 uSceneSize;
uniform vec2 uOutSize;
uniform float uDither;
uniform float uLevels;
uniform float uScanline;
uniform float uVignette;
uniform float uTime;
varying vec2 vUv;

float bayer4(vec2 p) {
  vec2 c = mod(floor(p), 4.0);
  float i = c.x + c.y * 4.0;
  float m[16];
  m[0] = 0.0;  m[1] = 8.0;  m[2] = 2.0;  m[3] = 10.0;
  m[4] = 12.0; m[5] = 4.0;  m[6] = 14.0; m[7] = 6.0;
  m[8] = 3.0;  m[9] = 11.0; m[10]= 1.0;  m[11]= 9.0;
  m[12]= 15.0; m[13]= 7.0;  m[14]= 13.0; m[15]= 5.0;
  int idx = int(i);
  for (int k = 0; k < 16; k++) {
    if (k == idx) return m[k] / 16.0 - 0.46875;
  }
  return 0.0;
}

void main() {
  // Nearest sampling keeps every authored pixel on the grid.
  vec2 texel = floor(vUv * uSceneSize) + 0.5;
  vec3 c = texture2D(uScene, texel / uSceneSize).rgb;

  // Ordered dithering then channel quantisation (PS1 15-bit colour).
  float step = 1.0 / (uLevels - 1.0);
  float threshold = bayer4(gl_FragCoord.xy) * uDither;
  c = floor((c + threshold * step) / step + 0.5) * step;

  // Scanlines every other output row.
  float scan = 1.0 - uScanline * mod(floor(gl_FragCoord.y), 2.0);
  c *= scan;

  // Vignette toward the ink frame.
  vec2 n = vec2(vUv.x, 1.0 - vUv.y) * 2.0 - 1.0;
  float vig = 1.0 - min(1.0, n.x * n.x * 0.72 + n.y * n.y * 0.5) * uVignette;
  c *= vig;

  // Very slight cool grade so the night reads blue against the amber lamp.
  c = mix(c, c * vec3(0.94, 0.98, 1.06), 0.5);

  gl_FragColor = vec4(c, 1.0);
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** Try to build the WebGL post pipeline. Returns null when unavailable. */
function createGlPipeline(canvas) {
  let gl = null;
  try {
    gl = canvas.getContext("webgl", { antialias: false, alpha: false, premultipliedAlpha: false });
  } catch {
    gl = null;
  }
  if (!gl) return null;

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const uniforms = {
    scene: gl.getUniformLocation(program, "uScene"),
    sceneSize: gl.getUniformLocation(program, "uSceneSize"),
    outSize: gl.getUniformLocation(program, "uOutSize"),
    dither: gl.getUniformLocation(program, "uDither"),
    levels: gl.getUniformLocation(program, "uLevels"),
    scanline: gl.getUniformLocation(program, "uScanline"),
    vignette: gl.getUniformLocation(program, "uVignette"),
    time: gl.getUniformLocation(program, "uTime"),
  };

  return {
    kind: "webgl",
    draw({ buffer, bufferWidth, bufferHeight, width, height, fit, settings, time }) {
      // Clear the whole framebuffer to the ink tone, then draw the scene into a
      // centred 16:9 sub-viewport so a phone viewport letterboxes instead of
      // stretching. GL's origin is bottom-left, so the Y offset flips.
      gl.viewport(0, 0, width, height);
      gl.clearColor(0.016, 0.024, 0.043, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const rect = fit || { width, height, offsetX: 0, offsetY: 0 };
      gl.viewport(rect.offsetX, height - rect.offsetY - rect.height, rect.width, rect.height);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
      gl.uniform1i(uniforms.scene, 0);
      gl.uniform2f(uniforms.sceneSize, bufferWidth, bufferHeight);
      gl.uniform2f(uniforms.outSize, rect.width, rect.height);
      gl.uniform1f(uniforms.dither, settings.dither);
      gl.uniform1f(uniforms.levels, PS1_CHANNEL_LEVELS);
      gl.uniform1f(uniforms.scanline, settings.scanlines ? 0.07 : 0);
      gl.uniform1f(uniforms.vignette, settings.vignette);
      gl.uniform1f(uniforms.time, time);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      gl.useProgram(null);
      gl.deleteProgram(program);
      gl.deleteBuffer(buffer);
      gl.deleteTexture(texture);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    },
  };
}

/** Software fallback: nearest upscale + the same dither/quantise maths. */
function renderSoftware(ctx, buffer, bufferWidth, bufferHeight, dest, settings) {
  const src = buffer.getContext("2d").getImageData(0, 0, bufferWidth, bufferHeight);
  const width = Math.max(1, dest.width | 0);
  const height = Math.max(1, dest.height | 0);
  const img = ctx.createImageData(width, height);
  const s = src.data;
  const d = img.data;
  const levels = PS1_CHANNEL_LEVELS;
  const step = 255 / (levels - 1);
  const dither = settings.dither;
  const vignette = settings.vignette;
  const scanline = settings.scanlines ? 0.07 : 0;
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  // Nearest sampling from the 320x180 buffer straight onto the destination, so
  // this path is correct for any viewport shape without knowing about offsets.
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(bufferHeight - 1, ((y / height) * bufferHeight) | 0);
    const ny = (y / height) * 2 - 1;
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(bufferWidth - 1, ((x / width) * bufferWidth) | 0);
      const si = (sy * bufferWidth + sx) * 4;
      const di = (y * width + x) * 4;
      const bayer = BAYER[(y % 4) * 4 + (x % 4)] / 16 - 0.46875;
      const nx = (x / width) * 2 - 1;
      const vig = 1 - Math.min(1, nx * nx * 0.72 + ny * ny * 0.5) * vignette;
      const scan = (y & 1) === 1 ? 1 - scanline : 1;
      for (let k = 0; k < 3; k += 1) {
        let c = s[si + k] / 255 + bayer * dither * step / 255;
        c = Math.round(c * (levels - 1)) / (levels - 1);
        d[di + k] = Math.max(0, Math.min(255, c * 255 * vig * scan));
      }
      d[di + 3] = 255;
    }
  }
  // putImageData ignores transforms, so the destination offset is applied here.
  ctx.putImageData(img, dest.x | 0, dest.y | 0);
}

const DEFAULT_SETTINGS = Object.freeze({
  pixelation: true,
  dither: 1,
  scanlines: true,
  vignette: 0.5,
});

/**
 * Mount the carriage stage.
 *
 * @param {object} opts
 * @param {Document} opts.doc
 * @param {HTMLElement} opts.container   positioned wrapper (CSS owns size)
 * @param {() => object} [opts.getDescriptor] -> { scene: "title"|"table"|..., mood, reducedMotion }
 * @returns {{setSettings, refresh, dispose, isActive, mode, canvas}|null}
 */
export function mountStage({
  doc,
  container,
  getDescriptor = () => ({ scene: "table", mood: "neutral", reducedMotion: false }),
  raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null,
  caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null,
} = {}) {
  if (!doc || !container || typeof container.appendChild !== "function") return null;

  const canCanvas = (() => {
    try {
      const probe = doc.createElement("canvas");
      return probe && typeof probe.getContext === "function";
    } catch {
      return false;
    }
  })();
  if (!canCanvas) return null;

  // Visible canvas (either the WebGL surface or the software target).
  const display = doc.createElement("canvas");
  display.className = "stage-display";
  display.setAttribute("aria-hidden", "true");
  container.appendChild(display);

  // Offscreen buffer the scene is drawn into.
  const buffer = doc.createElement("canvas");
  buffer.width = INTERNAL_SIZE.width;
  buffer.height = INTERNAL_SIZE.height;
  const bufferCtx = typeof buffer.getContext === "function" ? buffer.getContext("2d") : null;

  // Prefer the WebGL post pass; fall back to a 2D software shader. `getContext`
  // returns null when a context type is unsupported, so ask and check.
  let displayCtx = null;
  let gl = null;
  try {
    gl = createGlPipeline(display);
  } catch {
    gl = null;
  }
  if (!gl && typeof display.getContext === "function") {
    try {
      displayCtx = display.getContext("2d");
    } catch {
      displayCtx = null;
    }
  }
  const pipeline = gl || (displayCtx ? { kind: "software" } : null);

  if (!bufferCtx || !pipeline) return null;

  let settings = { ...DEFAULT_SETTINGS };
  let disposed = false;
  let frameId = null;
  let clockStart = 0;
  let elapsed = 0;
  let lastDrawAt = -Infinity;
  let visible = true;
  let size = { width: INTERNAL_SIZE.width, height: INTERNAL_SIZE.height };

  function resize() {
    const dpr = 1; // The art is intentionally low-res; the CSS upscales it.
    const width = Math.max(120, Math.round((container.clientWidth || 640) * dpr));
    const height = Math.max(90, Math.round((container.clientHeight || 360) * dpr));
    if (display.width !== width || display.height !== height) {
      display.width = width;
      display.height = height;
    }
    size = { width, height };
  }

  function render(now) {
    if (disposed) return;
    if (!visible) {
      frameId = raf ? raf(render) : null;
      return;
    }
    if (clockStart === 0) clockStart = now;
    elapsed = (now - clockStart) / 1000;

    // Throttle to ~30fps: the look is a filmic low-rate image, and it keeps
    // phones cool. Reduced motion drops it further.
    const descriptor = getDescriptor() || {};
    const reduced = Boolean(descriptor.reducedMotion);
    const minInterval = reduced ? 120 : 33;
    if (now - lastDrawAt >= minInterval) {
      lastDrawAt = now;
      const scale = settings.pixelation ? 1 : 2;
      const bw = INTERNAL_SIZE.width * scale;
      const bh = INTERNAL_SIZE.height * scale;
      if (buffer.width !== bw || buffer.height !== bh) {
        buffer.width = bw;
        buffer.height = bh;
      }
      drawScene(bufferCtx, {
        time: reduced ? 0 : elapsed,
        reducedMotion: reduced,
        mood: descriptor.mood || "neutral",
        framing: descriptor.framing || "wide",
        ditherStrength: 0, // the stage shader owns dithering
        scanlines: false,
        vignette: 0,
        grain: 0,
        scale,
      });
      if (resizeNeeded()) resize();
      // The scene is authored 16:9; both render paths letterbox to that ratio so
      // a tall phone viewport shows the carriage rather than a squashed one.
      // The same projection places the DOM fixtures (see presentation.js).
      const fit = sceneTransform(size.width, size.height);
      if (pipeline.kind === "webgl") {
        pipeline.draw({
          buffer,
          bufferWidth: bw,
          bufferHeight: bh,
          width: size.width,
          height: size.height,
          fit,
          settings: { ...settings, scanlines: settings.scanlines && settings.pixelation },
          time: elapsed,
        });
      } else if (displayCtx) {
        // Letterbox: the scene is authored 16:9, so a tall phone viewport must
        // not stretch it. Cover the frame with the scene's own ink tone and
        // draw the true aspect ratio centred, matching the background so the
        // bars read as shadow rather than as a border.
        if (fit.offsetX > 0 || fit.offsetY > 0) {
          displayCtx.fillStyle = LETTERBOX_COLOR;
          displayCtx.fillRect(0, 0, size.width, size.height);
        }
        const dest = { x: fit.offsetX, y: fit.offsetY, width: fit.width, height: fit.height };
        if (settings.pixelation) {
          renderSoftware(displayCtx, buffer, bw, bh, dest, {
            dither: settings.dither,
            scanlines: settings.scanlines,
            vignette: settings.vignette,
          });
        } else {
          displayCtx.imageSmoothingEnabled = true;
          displayCtx.drawImage(buffer, dest.x, dest.y, dest.width, dest.height);
        }
      }
    }
    frameId = raf ? raf(render) : null;
  }

  let lastSize = { w: 0, h: 0 };
  function resizeNeeded() {
    const w = container.clientWidth || 0;
    const h = container.clientHeight || 0;
    if (w !== lastSize.w || h !== lastSize.h) {
      lastSize = { w, h };
      return true;
    }
    return false;
  }

  function onVisibility() {
    if (!doc) return;
    visible = doc.hidden !== true;
  }

  if (doc && typeof doc.addEventListener === "function") {
    doc.addEventListener("visibilitychange", onVisibility);
  }

  resize();
  // Draw one frame synchronously so the first paint is never an empty canvas.
  render(0);

  return {
    get mode() {
      return pipeline.kind;
    },
    get isActive() {
      return !disposed;
    },
    canvas: display,
    setSettings(next = {}) {
      settings = { ...settings, ...next };
      lastDrawAt = -Infinity;
      return { ...settings };
    },
    getSettings() {
      return { ...settings };
    },
    refresh() {
      lastDrawAt = -Infinity;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frameId !== null && caf) caf(frameId);
      frameId = null;
      if (doc && typeof doc.removeEventListener === "function") {
        doc.removeEventListener("visibilitychange", onVisibility);
      }
      if (pipeline.kind === "webgl" && typeof pipeline.dispose === "function") pipeline.dispose();
      if (display.parentNode && typeof display.parentNode.removeChild === "function") {
        display.parentNode.removeChild(display);
      }
    },
  };
}

export { DEFAULT_SETTINGS as STAGE_DEFAULT_SETTINGS };
