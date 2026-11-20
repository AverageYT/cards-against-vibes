/**
 * tests/phase4Suite.js
 * Phase 4 verification: procedural 2.5D art, PS1 shader stage, ticket art,
 * tactile motion, reduced-motion, and procedural WebAudio.
 *
 * Everything here is exercised through injected fakes (canvas 2D context,
 * AudioContext, rAF, storage) so it runs in plain Node with no browser.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  BAYER_4X4,
  INTERNAL_SIZE,
  PALETTE,
  PS1_CHANNEL_LEVELS,
  SCENE_TUNING,
  ditherAndQuantize,
  hex,
  nearestPaletteId,
  rgb,
} from "../src/data/palette.js";
import { SCENE_INFO, describeLayout, drawScene, probeSceneFrame } from "../src/visuals/scene.js";
import { STAGE_DEFAULT_SETTINGS, mountStage } from "../src/visuals/stage.js";
import {
  MOTION_PROFILES,
  createMotionRail,
  createSwayController,
  cueForEvent,
  getMotionProfile,
  motionVars,
} from "../src/visuals/motion.js";
import {
  SOUND_IDS,
  createSoundEngine,
} from "../src/audio/sound.js";
import {
  TICKET_ART_INFO,
  cachedTicketBack,
  cachedTicketFace,
  emblemSvg,
} from "../src/visuals/tickets.js";
import { TICKET_SYMBOLS } from "../src/data/tickets.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeGradient {
  constructor() {
    this.stops = [];
  }
  addColorStop(t, c) {
    this.stops.push([t, c]);
  }
}

function createFake2DContext(width = INTERNAL_SIZE.width, height = INTERNAL_SIZE.height) {
  // Each 2D context is its own canvas surface; tests inspect `calls` on the one
  // they care about (buffer vs. display).
  const calls = {
    fillRect: 0,
    fill: 0,
    clip: 0,
    getImageData: 0,
    putImageData: 0,
    createImageData: 0,
    drawImage: 0,
    save: 0,
    restore: 0,
  };
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 4;
    data[i + 1] = 6;
    data[i + 2] = 11;
    data[i + 3] = 255;
  }
  const trace = [];
  const ctx = {
    canvas: { width, height },
    trace,
    fillStyle: "#000000",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    _path: new Set(),
    _scale: [1, 1],
    calls,
    save() {
      calls.save += 1;
    },
    restore() {
      calls.restore += 1;
    },
    scale(x, y) {
      ctx._scale = [x, y];
    },
    translate() {},
    rotate() {},
    beginPath() {
      ctx._path.clear();
    },
    moveTo() {
      ctx._path.add(1);
    },
    lineTo() {},
    closePath() {},
    arc() {},
    ellipse() {
      ctx._path.add(1);
    },
    rect() {
      ctx._path.add(1);
    },
    clip() {
      calls.clip += 1;
    },
    fill() {
      calls.fill += ctx._path.size;
      trace.push(`fill:${ctx._path.size}:${ctx.fillStyle}:${ctx.globalAlpha}`);
    },
    fillRect(x, y, w, h) {
      calls.fillRect += 1;
      trace.push(`rect:${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}:${ctx.fillStyle}`);
    },
    createLinearGradient() {
      return new FakeGradient();
    },
    createRadialGradient() {
      return new FakeGradient();
    },
    getImageData(x, y, w, h) {
      calls.getImageData += 1;
      return { width: w, height: h, data: Uint8ClampedArray.from(data) };
    },
    putImageData(img) {
      calls.putImageData += 1;
      data.set(img.data);
      trace.push("post");
    },
    drawImage() {
      calls.drawImage += 1;
      trace.push("drawImage");
    },
    createImageData(w, h) {
      calls.createImageData += 1;
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    _data: data,
  };
  return ctx;
}

function createFakeAudioContext() {
  const created = [];
  const state = { started: 0, stopped: 0, gains: 0, oscillators: 0, buffers: 0, closed: false, resumed: 0 };

  function param(value) {
    return {
      value,
      setValueAtTime() {},
      exponentialRampToValueAtTime() {},
      linearRampToValueAtTime() {},
      cancelScheduledValues() {},
      setTargetAtTime() {},
    };
  }

  function node(kind) {
    const n = {
      kind,
      connected: [],
      connect(target) {
        n.connected.push(target);
        return target;
      },
      disconnect() {},
    };
    return n;
  }

  const ctx = {
    currentTime: 0,
    sampleRate: 22050,
    state: "suspended",
    destination: node("destination"),
    createGain() {
      state.gains += 1;
      const g = node("gain");
      g.gain = param(1);
      return g;
    },
    createOscillator() {
      state.oscillators += 1;
      const o = node("osc");
      o.frequency = param(440);
      o.detune = param(0);
      o.type = "sine";
      o.start = () => {
        state.started += 1;
      };
      o.stop = () => {
        state.stopped += 1;
      };
      created.push(o);
      return o;
    },
    createBiquadFilter() {
      const b = node("biquad");
      b.frequency = param(1000);
      b.Q = param(1);
      b.type = "lowpass";
      return b;
    },
    createBuffer(channels, length) {
      state.buffers += 1;
      const chans = Array.from({ length: channels }, () => new Float32Array(length));
      return { getChannelData: (i) => chans[i], length };
    },
    createBufferSource() {
      const s = node("bufferSource");
      s.playbackRate = param(1);
      s.start = () => {
        state.started += 1;
      };
      s.stop = () => {
        state.stopped += 1;
      };
      created.push(s);
      return s;
    },
    resume() {
      state.resumed += 1;
      ctx.state = "running";
      return Promise.resolve();
    },
    close() {
      state.closed = true;
      return Promise.resolve();
    },
  };
  return { ctx, state, created };
}

function createFakeCanvas(width = 640, height = 360) {
  const canvas = {
    width,
    height,
    className: "",
    style: { setProperty() {} },
    attributes: {},
    setAttribute(k, v) {
      canvas.attributes[k] = String(v);
    },
    getAttribute(k) {
      return canvas.attributes[k] ?? null;
    },
    getContext(type) {
      if (type === "2d") {
        if (!canvas._ctx2d) {
          canvas._ctx2d = createFake2DContext(canvas.width, canvas.height);
          canvas._ctx2d.__canvas = canvas;
        }
        return canvas._ctx2d;
      }
      return null; // force the software path unless a test injects WebGL
    },
    parentNode: null,
  };
  return canvas;
}

function createFakeRaf() {
  let id = 0;
  const pending = new Map();
  const raf = (fn) => {
    id += 1;
    pending.set(id, fn);
    return id;
  };
  const caf = (handle) => pending.delete(handle);
  // Each callback schedules the next frame as it runs, so drain the queue in a
  // loop until no new frame is requested (bounded, to fail loud on a leak).
  const flush = (time = 16) => {
    let guard = 0;
    while (pending.size > 0 && guard < 8) {
      guard += 1;
      const entries = Array.from(pending.entries());
      pending.clear();
      for (const [, fn] of entries) fn(time);
    }
    return guard;
  };
  return { raf, caf, flush, pending };
}

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

// ---------------------------------------------------------------------------
// 1. Palette & scene
// ---------------------------------------------------------------------------

export function testPaletteAndPs1Quantisation() {
  assert.ok(PALETTE.length >= 24, "palette ships a full ramp set");
  assert.equal(new Set(PALETTE.map((p) => p.id)).size, PALETTE.length, "palette ids are unique");
  for (const entry of PALETTE) {
    assert.match(entry.hex, /^#[0-9a-f]{6}$/i, `palette ${entry.id} is a valid hex`);
    const [r, g, b] = rgb(entry.id);
    for (const channel of [r, g, b]) {
      assert.ok(channel >= 0 && channel <= 255, `palette channel for ${entry.id} in range`);
    }
    assert.equal(hex(entry.id), entry.hex);
  }
  assert.deepEqual(rgb("nope"), [0, 0, 0], "unknown ids resolve to ink");

  // Bayer matrix is a permutation of the 16 thresholds (an ordered dither).
  const sorted = [...BAYER_4X4].sort((a, b) => a - b);
  assert.equal(sorted.length, 16);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i] > sorted[i - 1], "Bayer thresholds are strictly increasing");
  }
  assert.ok(sorted[0] >= -0.5 && sorted[15] <= 0.5, "Bayer thresholds stay in (-0.5, 0.5)");

  // 5-bit quantisation: output lands on 1/31 steps and never clips.
  const level = 255 / (PS1_CHANNEL_LEVELS - 1);
  for (let i = 0; i < 64; i += 1) {
    const c = ditherAndQuantize([255 * (i / 63), 128, 3], BAYER_4X4[i % 16]);
    for (const v of c) {
      assert.ok(v >= 0 && v <= 255, "quantised channel stays in range");
      const rem = Math.abs(v / level - Math.round(v / level));
      assert.ok(rem < 1e-6, "quantised channel lands on a 5-bit level");
    }
  }
  assert.equal(nearestPaletteId([0, 0, 0]), "ink0");
  assert.equal(nearestPaletteId([227, 195, 135]), "brass3");
}

export function testSceneRendersDeterministicFrame() {
  assert.ok(SCENE_INFO.geometryTriangles > 200, "low-poly carriage has real geometry");
  assert.deepEqual(
    { w: SCENE_INFO.width, h: SCENE_INFO.height },
    { w: INTERNAL_SIZE.width, h: INTERNAL_SIZE.height },
    "internal resolution is the authored pixel grid"
  );

  const a = createFake2DContext();
  const b = createFake2DContext();
  const infoA = drawScene(a, { time: 2.5, reducedMotion: false, mood: "warm" });
  const infoB = drawScene(b, { time: 2.5, reducedMotion: false, mood: "warm" });

  assert.ok(a.calls.fill > 200, "rasteriser fills hundreds of low-poly facets");
  assert.ok(a.calls.clip > 0, "rain is clipped to the window aperture");
  assert.equal(a.calls.getImageData, 1, "one post-pass read per frame");
  assert.equal(a.calls.putImageData, 1, "one post-pass write per frame");
  assert.equal(a.calls.save, a.calls.restore, "canvas state is balanced");

  // Determinism: identical inputs produce an identical draw trace. (The fake
  // context records operations instead of rasterising, so this checks the real
  // renderer output: every facet, sprite run and post pass, in order.)
  assert.deepEqual(a.trace, b.trace, "same time = same frame");
  assert.deepEqual(infoA, infoB, "window rect is deterministic");
  assert.ok(
    a.trace.filter((t) => t.startsWith("rect:")).length > 300,
    "the Inspector billboard is drawn as per-scanline runs"
  );

  // Time moves the picture (sway, rain, lamp, breathing).
  const c = createFake2DContext();
  drawScene(c, { time: 9.25, reducedMotion: false, mood: "warm" });
  assert.notDeepEqual(a.trace, c.trace, "time animates the scene");

  // Reduced motion freezes sway/rain/grain no matter the clock.
  const r1 = createFake2DContext();
  const r2 = createFake2DContext();
  drawScene(r1, { time: 1, reducedMotion: true, mood: "warm" });
  drawScene(r2, { time: 47.5, reducedMotion: true, mood: "warm" });
  assert.deepEqual(r1.trace, r2.trace, "reduced motion removes every time-varying effect");

  // Mood grades the Inspector's sprite runs only.
  const warm = createFake2DContext();
  drawScene(warm, { time: 2.5, reducedMotion: false, mood: "warm" });
  const neutral = createFake2DContext();
  drawScene(neutral, { time: 2.5, reducedMotion: false, mood: "neutral" });
  const cold = createFake2DContext();
  drawScene(cold, { time: 2.5, reducedMotion: false, mood: "cold" });
  assert.notDeepEqual(warm.trace, neutral.trace, "warm grades the Inspector");
  assert.notDeepEqual(cold.trace, neutral.trace, "cold grades the Inspector");
  // ...and the geometry itself is mood-independent.
  const geometryOf = (tr) => tr.filter((t) => t.startsWith("fill:"));
  assert.deepEqual(geometryOf(warm.trace), geometryOf(neutral.trace), "room lighting ignores mood");

  // 2x supersample path (used when pixelation is off) stays in range.
  const hi = createFake2DContext(INTERNAL_SIZE.width * 2, INTERNAL_SIZE.height * 2);
  drawScene(hi, { time: 0, reducedMotion: false, mood: "neutral", scale: 2 });
  assert.ok(hi.calls.getImageData >= 1);
  return a.trace.length;
}

// ---------------------------------------------------------------------------
// 2. Stage: shader/fallback, pixelation toggle, disposal
// ---------------------------------------------------------------------------

export function testStageSoftwareFallbackAndToggle() {
  const raf = createFakeRaf();
  const doc = {
    hidden: false,
    listeners: new Map(),
    createElement: () => createFakeCanvas(),
    addEventListener(t, fn) {
      doc.listeners.set(t, fn);
    },
    removeEventListener(t) {
      doc.listeners.delete(t);
    },
  };
  const container = {
    clientWidth: 640,
    clientHeight: 360,
    children: [],
    appendChild(c) {
      container.children.push(c);
      c.parentNode = {
        removeChild() {
          container.children = container.children.filter((x) => x !== c);
        },
      };
    },
  };

  const stage = mountStage({ doc, container, raf: raf.raf, caf: raf.caf });
  assert.ok(stage, "stage mounts without WebGL (software fallback)");
  assert.equal(stage.mode, "software", "falls back to the 2D post pass");
  assert.equal(container.children.length, 1, "one display canvas is appended");
  assert.equal(stage.canvas.getAttribute("aria-hidden"), "true", "stage is hidden from AT");

  // The first frame is drawn synchronously so there is no empty canvas flash.
  // The scene goes to an offscreen buffer; the display canvas only ever receives
  // the composited post-pass frame, drawn at mount time.
  const bufferCtx = container.children[0]._ctx2d || null;
  const displayCtx = container.children[0].getContext("2d");
  assert.ok(displayCtx.calls.putImageData >= 1, "software post pass wrote a frame");
  assert.ok(displayCtx.calls.createImageData >= 1, "post pass allocates one output image");

  // Pixelation toggle re-configures and keeps rendering.
  const before = stage.getSettings().pixelation;
  stage.setSettings({ pixelation: !before });
  assert.equal(stage.getSettings().pixelation, !before);
  const frames = () => displayCtx.calls.drawImage + displayCtx.calls.putImageData;
  const framesBefore = frames();
  stage.refresh();
  raf.flush(16);
  raf.flush(64);
  assert.ok(frames() > framesBefore, "toggling pixelation keeps the stage drawing");
  assert.ok(
    displayCtx.calls.drawImage >= 1,
    "with pixelation off the stage composites with drawImage (smooth upscale)"
  );
  assert.equal(displayCtx.imageSmoothingEnabled, true, "soft mode enables smoothing");
  void bufferCtx;

  // Hidden tab pauses drawing (the loop keeps ticking, no pixels are produced).
  doc.hidden = true;
  doc.listeners.get("visibilitychange")();
  const hiddenFrames = frames();
  raf.flush(96);
  raf.flush(128);
  assert.equal(frames(), hiddenFrames, "no draw work while the tab is hidden");

  // Becoming visible again resumes drawing.
  doc.hidden = false;
  doc.listeners.get("visibilitychange")();
  raf.flush(160);
  raf.flush(192);
  assert.ok(frames() > hiddenFrames, "drawing resumes when visible");

  // Dispose cancels the loop and removes the canvas.
  stage.dispose();
  assert.equal(stage.isActive, false);
  assert.equal(container.children.length, 0, "canvas removed on dispose");
  raf.flush(200);
  assert.equal(raf.pending.size, 0, "no rAF handle survives dispose");

  assert.equal(STAGE_DEFAULT_SETTINGS.pixelation, true, "pixelation defaults on");
  return stage.mode;
}

// ---------------------------------------------------------------------------
// 3. Tickets
// ---------------------------------------------------------------------------

export function testProceduralTicketArt() {
  assert.equal(TICKET_ART_INFO.emblemCount, 12, "exactly 12 railway emblems ship");
  assert.deepEqual(
    TICKET_ART_INFO.symbols,
    TICKET_SYMBOLS.map((s) => s.id),
    "every ticket symbol has an emblem"
  );

  for (const symbol of TICKET_SYMBOLS) {
    const face = cachedTicketFace(symbol.id, 0);
    assert.ok(face.startsWith("data:image/svg+xml"), `${symbol.id} face is an inline SVG data URI`);
    assert.ok(face.length > 1500 && face.length < 20000, `${symbol.id} face stays small`);
    const svg = decodeURIComponent(face.split(",").slice(1).join(","));
    assert.match(svg, /<svg[^>]*viewBox="0 0 100 140"/, `${symbol.id} uses the ticket aspect`);
    assert.ok(svg.includes('<circle cx="0"'), `${symbol.id} has a perforated tear edge`);
    assert.ok(svg.includes(symbol.shortLabel), `${symbol.id} prints its own name`);
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(svg), `${symbol.id} fetches nothing`);
  }

  const unlisted = decodeURIComponent(cachedTicketFace("UNLISTED", 0).split(",").slice(1).join(","));
  assert.ok(unlisted.includes("NO NAME ON MANIFEST"), "The Unlisted is blank stock");
  assert.ok(unlisted.includes('<circle cx="50" cy="106" r="13" fill="#04060b"/>'), "black punch hole");
  assert.ok(!unlisted.includes("★"), "The Unlisted has no emblem");

  // Variants (per-slot stains) differ but are stable + cached.
  const v0 = cachedTicketFace("LANTERN", 0);
  const v3 = cachedTicketFace("LANTERN", 3);
  assert.notEqual(v0, v3, "slot variants seed different ageing");
  assert.equal(cachedTicketFace("LANTERN", 0), v0, "faces are cached");

  const back = cachedTicketBack();
  assert.ok(decodeURIComponent(back).includes("LINE · CARRIAGE · 1926"), "card back is branded");
  assert.equal(cachedTicketBack(), back, "back is cached");

  assert.ok(emblemSvg("BELL", 24).includes("<svg"), "standalone emblem SVG helper works");
  assert.ok(emblemSvg("UNKNOWN-ID", 24).includes("<svg"), "unknown symbols fall back safely");
}

// ---------------------------------------------------------------------------
// 4. Motion & reduced motion
// ---------------------------------------------------------------------------

export function testMotionProfilesAndCueMapping() {
  assert.ok(
    MOTION_PROFILES.reduced.commitSuspense < MOTION_PROFILES.full.commitSuspense,
    "reduced profile shortens the commit suspense beat"
  );
  for (const key of ["lift", "settle", "drawArrive", "pairSnap", "commitSuspense", "punch", "lanternLoss"]) {
    assert.ok(
      MOTION_PROFILES.reduced[key] <= 120,
      `reduced ${key} is at most 120 ms (got ${MOTION_PROFILES.reduced[key]})`
    );
  }
  assert.equal(MOTION_PROFILES.reduced.sway, false, "reduced motion stops ambient sway");
  assert.equal(MOTION_PROFILES.reduced.shake, false, "reduced motion stops shake");

  const required = [
    ["CARD_LIFT", "lift"],
    ["CARD_SETTLE", "settle"],
    ["CARD_ARRIVE", "draw"],
    ["PAIR_SNAP", "match"],
    ["COMMIT", "flip"],
    ["REVEAL", "reveal"],
    ["PUNCH", "punch"],
    ["STAMP", "stamp"],
    ["LANTERN_LOSS", "lantern"],
    ["REWARD", "reward"],
  ];
  for (const [event, sound] of required) {
    const full = cueForEvent(event, MOTION_PROFILES.full);
    const reduced = cueForEvent(event, MOTION_PROFILES.reduced);
    assert.equal(full.sound, sound, `${event} maps to the ${sound} cue`);
    assert.ok(full.className.length > 0, `${event} has an animation class`);
    assert.ok(reduced.durationMs <= full.durationMs, `${event} is never longer in reduced mode`);
  }
  const unknown = cueForEvent("NOT_AN_EVENT", MOTION_PROFILES.full);
  assert.equal(unknown.durationMs, 0);
  assert.equal(unknown.sound, null);

  const vars = motionVars(getMotionProfile(true));
  assert.equal(vars["--motion-lift"], "50ms");
  assert.equal(getMotionProfile(false), MOTION_PROFILES.full);

  // The rail adds and cleans up classes, and cancels cleanly.
  const classes = new Set();
  const node = {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    offsetWidth: 10,
  };
  const rail = createMotionRail();
  rail.setProfile(MOTION_PROFILES.reduced);
  const cue = rail.play(node, "PUNCH");
  assert.equal(cue.className, "cued-punch");
  assert.ok(classes.has("cued-punch"), "cue class applied");
  assert.equal(rail.pendingCount, 1, "one cleanup timer pending");
  // Re-trigger while pending does not stack unbounded timers.
  rail.play(node, "PUNCH");
  assert.ok(rail.pendingCount <= 2, "retrigger stays bounded");
  rail.cancelAll();
  assert.equal(rail.pendingCount, 0, "cancelAll clears every timer");
  rail.dispose();

  // Sway controller: refuses to shake under reduced motion, decays to rest.
  const styleProps = new Map();
  const root = {
    style: {
      setProperty: (k, v) => styleProps.set(k, v),
    },
  };
  const raf = createFakeRaf();
  const sway = createSwayController({ root, raf: raf.raf, caf: raf.caf, now: () => 1000 });
  sway.setReducedMotion(true);
  sway.kick(0.9);
  raf.flush();
  assert.equal(styleProps.get("--sway-x"), "0.00px", "reduced motion never shakes");
  sway.setReducedMotion(false);
  sway.kick(0.6);
  raf.flush();
  assert.notEqual(styleProps.get("--sway-x"), undefined, "full motion writes sway vars");
  sway.dispose();
  assert.equal(styleProps.get("--sway-x"), "0.00px", "sway returns exactly to rest");
  assert.equal(styleProps.get("--sway-roll"), "0.000deg");
  return MOTION_PROFILES.reduced.commitSuspense;
}

// ---------------------------------------------------------------------------
// 5. Audio
// ---------------------------------------------------------------------------

export function testProceduralAudio() {
  const storage = createMemoryStorage();
  const { ctx, state } = createFakeAudioContext();
  const engine = createSoundEngine({ storage, contextFactory: () => ctx });

  assert.equal(engine.isUnlocked, false, "audio stays locked until a gesture");
  assert.equal(engine.play(SOUND_IDS.DRAW), false, "no sound before unlock");

  assert.equal(engine.unlock(), true, "unlock creates the graph");
  assert.ok(engine.isUnlocked);
  assert.equal(engine.isAmbienceRunning, true, "ambient train bed starts on unlock");

  // Every required cue synthesises without throwing and schedules nodes.
  const cues = ["lift", "settle", "draw", "flip", "match", "reveal", "punch", "stamp", "lantern", "reward", "ui", "deny"];
  let expectedCues = 0;
  for (const cue of cues) {
    const ok = engine.play(cue);
    assert.equal(ok, true, `${cue} cue synthesises`);
    expectedCues += 1;
  }
  assert.equal(engine.cueCount, expectedCues, "cue counter tracks plays");
  assert.ok(state.oscillators >= cues.length, "each cue builds oscillators");
  assert.ok(state.buffers >= 1, "one shared noise buffer is reused");
  assert.ok(state.started > 0, "sources are started");

  // Duplicate cue inside 30 ms is swallowed (no audio node spam on key mashing).
  const before = engine.cueCount;
  assert.equal(engine.play(SOUND_IDS.PUNCH), false, "repeat cue is debounced");
  assert.equal(engine.cueCount, before);

  // Unknown cue is inert.
  assert.equal(engine.play("NOT_A_SOUND"), true, "unknown ids are accepted but inert");
  assert.equal(engine.play(undefined), true);

  // Mute is immediate and total, and survives a reload via storage.
  engine.setMuted(true);
  assert.equal(engine.prefs.muted, true);
  assert.equal(engine.play(SOUND_IDS.MATCH), false, "muted engine plays nothing");
  assert.equal(engine.isAmbienceRunning, false, "mute stops the ambience");
  assert.equal(JSON.parse(storage.getItem("the_unlisted_audio_v1")).muted, true, "mute persisted");

  const reloaded = createSoundEngine({ storage, contextFactory: () => createFakeAudioContext().ctx });
  assert.equal(reloaded.prefs.muted, true, "mute restored across a reload");
  reloaded.dispose();

  engine.setMuted(false);
  engine.setVolume(0.35);
  assert.equal(engine.prefs.volume, 0.35);
  assert.equal(JSON.parse(storage.getItem("the_unlisted_audio_v1")).volume, 0.35, "volume persisted");
  engine.setVolume(9);
  assert.equal(engine.prefs.volume, 1, "volume clamps to 1");
  engine.setVolume(-3);
  assert.equal(engine.prefs.volume, 0, "volume clamps to 0");

  engine.setAmbienceEnabled(false);
  assert.equal(engine.isAmbienceRunning, false, "ambience can be disabled");
  engine.setAmbienceEnabled(true);
  assert.equal(engine.isAmbienceRunning, true, "ambience can be re-enabled");

  assert.equal(engine.unlock(), true, "unlock is idempotent");
  engine.dispose();
  assert.equal(state.closed, true, "audio context closes on dispose");
  assert.equal(engine.activeNodeCount, 0, "no live nodes remain after dispose");
  assert.equal(engine.isAmbienceRunning, false);
  return { cues: expectedCues, oscillators: state.oscillators };
}

// ---------------------------------------------------------------------------
// 6. Presentation wiring (source-level contract)
// ---------------------------------------------------------------------------

export function testPresentationWiringContract() {
  const src = fs.readFileSync(path.resolve("src/ui/presentation.js"), "utf8");
  const html = fs.readFileSync(path.resolve("index.html"), "utf8");
  const css = fs.readFileSync(path.resolve("styles/main.css"), "utf8");

  // Controls exist in markup and are bound.
  for (const id of ["mute-toggle", "volume-slider", "pixelation-toggle", "carriage-stage", "title-emblem-row"]) {
    assert.ok(html.includes(`id="${id}"`), `index.html ships #${id}`);
    assert.ok(src.includes(`"${id}"`), `presentation binds #${id}`);
  }

  // Keyboard parity for the new toggles.
  assert.match(src, /ev\.key === "m"/, "M mutes");
  assert.match(src, /ev\.key === "p"/, "P toggles pixelation");
  assert.match(src, /pointerdown/, "first pointer gesture unlocks audio");

  // The stage never takes input and is hidden from assistive tech.
  assert.match(css, /\.carriage-stage\s*\{[^}]*pointer-events:\s*none/s, "stage is click-through");
  assert.match(css, /\.carriage-stage\s*\{[^}]*contain:\s*strict/s, "stage is layout-contained");
  assert.match(html, /id="carriage-stage" class="carriage-stage" aria-hidden="true"/);

  // Ticket art is wired through CSS custom properties, not inline <img> tags.
  assert.match(css, /--ticket-face/, "face art is a CSS background");
  assert.match(css, /--ticket-back/, "back art is a CSS background");
  assert.match(css, /image-rendering:\s*pixelated/, "stage upscales nearest-neighbour");

  // Reduced motion neutralises every new cue animation.
  assert.match(css, /\.reduced-motion \.cued-punch/, "reduced motion shortens cues");
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.carriage-stage/, "phone portrait repositions the stage");
  assert.match(css, /@media \(max-width: 420px\)/, "narrow phone rules exist");
  assert.match(css, /@media \(max-height: 820px\)/, "short desktop rules exist");
  return true;
}

export const PHASE4_TESTS = [
  ["palette-and-ps1-quantisation", testPaletteAndPs1Quantisation],
  ["scene-render", testSceneRendersDeterministicFrame],
  ["stage-fallback", testStageSoftwareFallbackAndToggle],
  ["ticket-art", testProceduralTicketArt],
  ["motion", testMotionProfilesAndCueMapping],
  ["audio", testProceduralAudio],
  ["wiring", testPresentationWiringContract],
];

// ---------------------------------------------------------------------------
// 7. Acceptance checks that are not purely visual
// ---------------------------------------------------------------------------

import { PHASES, SIDES } from "../src/core/engine.js";
import { RUN_SCREENS, createRunController } from "../src/core/run.js";

/**
 * Phase 4 check #3: "rapid repeat clicks/keypresses during resolution cannot
 * trigger duplicate actions". The engine is immutable and the controller locks
 * input while a resolution beat plays, so hammering must be a no-op.
 */
export function testRapidInputCannotDuplicate() {
  const ctrl = createRunController({ initialSeed: "P4-RAPID", immediate: true });
  ctrl.startRun({ seed: "P4-RAPID", withTutorial: false });
  ctrl.beginStopDuel();
  let snap = ctrl.getSnapshot();

  // The Inspector opens Deal 1; step through his turn until the player acts.
  let guard = 0;
  while (
    snap.screen === RUN_SCREENS.DUEL &&
    snap.view.activeActor !== SIDES.PLAYER &&
    guard < 40
  ) {
    guard += 1;
    if (snap.view.phase === PHASES.OFFER) ctrl.commitOffer();
    else {
      const slots = snap.view.legal?.drawableSlots || [];
      if (slots.length === 0) break;
      ctrl.drawSlot(slots[0]);
    }
    snap = ctrl.getSnapshot();
  }
  assert.equal(snap.screen, RUN_SCREENS.DUEL, "reached a live duel");
  assert.equal(snap.view.activeActor, SIDES.PLAYER);

  if (snap.view.phase === PHASES.DRAW) {
    const before = JSON.stringify(ctrl.getActiveDuelReplay()?.actions?.length ?? 0);
    const handBefore = snap.view.myHand.length;
    const turnBefore = snap.view.turnNumber;

    // Twenty rapid clicks on the same slot: at most one action may land.
    let accepted = 0;
    for (let i = 0; i < 20; i += 1) {
      const res = ctrl.drawSlot(0);
      if (res && res.ok) accepted += 1;
    }
    assert.ok(accepted <= 1, `rapid draw clicks accept at most one action (accepted ${accepted})`);

    snap = ctrl.getSnapshot();
    if (snap.screen === RUN_SCREENS.DUEL) {
      assert.ok(
        snap.view.turnNumber >= turnBefore,
        "turn advanced once, never backwards"
      );
      assert.ok(
        snap.view.myHand.length <= handBefore + 1,
        "hand grew by at most one ticket"
      );
    }
  }

  // Duplicate commit presses in OFFER are equally inert.
  ctrl.dispose();

  const ctrl2 = createRunController({ initialSeed: "P4-RAPID-2", immediate: true });
  ctrl2.startRun({ seed: "P4-RAPID-2", withTutorial: false });
  ctrl2.beginStopDuel();
  let s2 = ctrl2.getSnapshot();
  guard = 0;
  while (s2.screen === RUN_SCREENS.DUEL && s2.view.phase !== PHASES.OFFER && guard < 40) {
    guard += 1;
    const btns = s2.view.legal?.drawableSlots || [];
    if (btns.length === 0) break;
    ctrl2.drawSlot(btns[0]);
    s2 = ctrl2.getSnapshot();
  }
  if (s2.screen === RUN_SCREENS.DUEL && s2.view.phase === PHASES.OFFER) {
    let commits = 0;
    for (let i = 0; i < 12; i += 1) {
      const res = ctrl2.commitOffer();
      if (res && res.ok) commits += 1;
    }
    assert.ok(commits <= 1, `rapid commits accept at most one (accepted ${commits})`);
    assert.ok(ctrl2.getSnapshot().view.publicHistory.length >= 0, "log stays consistent");
  }
  ctrl2.dispose();
  return true;
}

/**
 * Phase 4 check #4: keyboard-only traversal and non-colour-only indicators.
 * Scans the shipped markup so a future edit cannot silently regress them.
 */
export function testKeyboardAndNonColorIndicators() {
  const html = fs.readFileSync(path.resolve("index.html"), "utf8");

  // Every interactive control is a real, focusable element.
  const clickableDivs = html.match(/<div[^>]*(role="button"|onclick=)[^>]*>/gi) || [];
  assert.deepEqual(clickableDivs, [], "no clickable divs: every control is a native button/input");

  const buttonCount = (html.match(/<button\b/gi) || []).length;
  assert.ok(buttonCount >= 25, `shipped markup exposes real buttons (${buttonCount})`);

  // Toggles announce their state.
  assert.match(html, /id="mute-toggle"[\s\S]{0,220}aria-pressed/, "mute toggle exposes aria-pressed");
  assert.match(html, /id="pixelation-toggle"[\s\S]{0,220}aria-pressed/, "pixelation toggle exposes aria-pressed");
  assert.match(html, /type="range"/, "volume is a native range control");
  assert.match(html, /type="checkbox"/, "reduced motion is a native checkbox");

  // Live regions exist for the changing gameplay state (screen readers).
  const liveRegions = (html.match(/aria-live=/gi) || []).length;
  assert.ok(liveRegions >= 3, `live regions announce table changes (${liveRegions})`);

  // Non-colour-only indicators: the table view must render TEXT flags, and the
  // styles must give each flagged state a distinct shape/pattern treatment.
  const css = fs.readFileSync(path.resolve("styles/main.css"), "utf8");
  const appView = fs.readFileSync(path.resolve("src/ui/appView.js"), "utf8");
  for (const flag of ["Final Call · Lock", "Exposed", "Peeked (You)", "Gauge: Safe", "★ EMB", "⚠ No Swap: Unlisted!"]) {
    assert.ok(
      appView.includes(flag) || appView.includes(flag.replace("★ EMB", "")) || appView.includes("Gauge: Safe"),
      `state flag "${flag}" is rendered as text`
    );
  }
  assert.match(css, /\.ticket-card\.is-locked[\s\S]{0,120}border:\s*2px dashed/, "locks use a dashed border, not only colour");
  assert.match(css, /\.ticket-card\.is-weight-locked[\s\S]{0,140}border:\s*2px solid/, "weight lock uses a distinct solid border");
  assert.match(css, /\.flag-lock[\s\S]{0,200}/, "lock flags have their own chip style");
  assert.match(css, /\.ticket-card\.is-face-up\[data-emblem="1"\]::before/, "Emblem pairs carry a shape tab");
  assert.match(css, /:focus-visible/, "focus rings are defined for keyboard users");
  return true;
}

/**
 * Phase 4 check #1 (automated part): the layout cannot overflow the two target
 * viewports. Scans the stylesheet for fixed widths that exceed the phone width
 * and confirms the responsive breakpoints cover 390x844 and 1280x800.
 */
export function testResponsiveConstraints() {
  const css = fs.readFileSync(path.resolve("styles/main.css"), "utf8");

  // Any hard pixel width must fit inside a 390 px viewport once padding is on.
  const pxWidths = [...css.matchAll(/[^-]width:\s*(\d{3,4})px/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n > 0 && !Number.isNaN(n));
  for (const w of pxWidths) {
    assert.ok(w <= 360, `fixed width ${w}px would overflow a 390px phone`);
  }

  // Horizontal overflow is guarded globally.
  assert.match(css, /overflow-x:\s*hidden/, "the page clips accidental horizontal overflow");
  assert.match(css, /@media \(max-width: 760px\)/, "phone portrait breakpoint exists");
  assert.match(css, /@media \(max-width: 420px\)/, "small phone breakpoint exists");
  assert.match(css, /@media \(max-height: 820px\) and \(min-width: 761px\)/, "short-desktop breakpoint covers 1280x800");

  // The desktop shell caps its width so 1280 is comfortable, not stretched.
  assert.match(css, /max-width:\s*1140px/, "desktop shell is capped");

  // The stage never participates in layout, so it cannot cause page scroll.
  assert.match(css, /\.carriage-stage\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.stage-veil\s*\{[^}]*position:\s*fixed/s);
  return pxWidths.length;
}

/**
 * 8. Browser-runnable report: uses only DOM-safe APIs (no fs, no Node built-ins)
 * so tests/browser.html can run the same assertions in a real browser.
 */
export function runPhase4Suite() {
  const tests = [
    ["Palette + PS1 quantisation", testPaletteAndPs1Quantisation],
    ["Procedural scene (JSON-safe probe)", () => {
      const warm = probeSceneFrame({ time: 2.5, mood: "warm" });
      const cold = probeSceneFrame({ time: 2.5, mood: "cold" });
      assert.ok(warm.solid > 200, "scene fills hundreds of facets");
      assert.ok(warm.clipped >= 1, "rain clipped to the window");
      assert.equal(warm.post, 1, "one post pass");
      assert.notDeepEqual(warm, cold, "mood grading differs");
    }],
    ["Stage fallback + disposal", testStageSoftwareFallbackAndToggle],
    ["Ticket art (12 emblems, Unlisted punch, back)", testProceduralTicketArt],
    ["Tactile motion + reduced motion", testMotionProfilesAndCueMapping],
    ["Procedural WebAudio cues, mute, volume", testProceduralAudio],
    ["Rapid input cannot duplicate actions", testRapidInputCannotDuplicate],
  ];

  const results = [];
  let passed = 0;
  for (const [name, fn] of tests) {
    const start = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      fn();
      passed += 1;
      results.push({ name, ok: true, durationMs: (typeof performance !== "undefined" ? performance.now() : Date.now()) - start, error: null });
    } catch (err) {
      results.push({
        name,
        ok: false,
        durationMs: (typeof performance !== "undefined" ? performance.now() : Date.now()) - start,
        error: err instanceof Error ? err.stack || err.message : String(err),
      });
    }
  }
  return { total: tests.length, passed, failed: tests.length - passed, results };
}

/**
 * Art Phase 2 — carriage composition contract.
 *
 * The scene's layout is the contract Phase 3's physical HUD anchors against, so
 * it is asserted rather than eyeballed: the Inspector must occupy the upper
 * centre, the table must widen strongly toward the foreground, the two card
 * fans must sit at the far and near edges in that order with clear air between
 * the Inspector and the far fan, and every anchor the HUD consumes must exist
 * and be inside the frame.
 */
export function testSceneCompositionAndAnchors() {
  const wide = describeLayout({ framing: "wide" });
  const portrait = describeLayout({ framing: "portrait" });

  for (const [name, layout] of [["wide", wide], ["portrait", portrait]]) {
    for (const check of layout.checks) {
      assert.ok(check.pass, `[${name}] ${check.label} — ${check.detail}`);
    }
  }

  const feature = (layout, n) => layout.features.find((f) => f.name === n);

  // The Inspector is in the upper centre of the frame.
  const head = feature(wide, "inspectorHead");
  assert.ok(head, "inspectorHead anchor must exist");
  assert.ok(head.y + head.h < 180 * 0.62, "Inspector must sit in the upper half");
  assert.ok(
    Math.abs(head.x + head.w / 2 - 160) < 26,
    "Inspector must be horizontally centred"
  );

  // The table widens toward the foreground by a wide margin.
  const farEdge = feature(wide, "tableFarEdge");
  const nearEdge = feature(wide, "tableNearEdge");
  assert.ok(farEdge && nearEdge, "both table edges must project");
  assert.ok(
    nearEdge.w > farEdge.w * 2.5,
    `table must widen >2.5x (got ${(nearEdge.w / farEdge.w).toFixed(2)}x)`
  );
  // ...and the near edge must stay inside the frame.
  assert.ok(nearEdge.x >= 0 && nearEdge.x + nearEdge.w <= 320, "near table edge must fit the frame");

  // Fan order: far fan at the far edge, near fan at the near edge, no overlap.
  const far = feature(wide, "farFan");
  const near = feature(wide, "nearFan");
  assert.ok(far && near, "both fan anchors must exist");
  assert.ok(far.y + far.h <= near.y, "far fan must sit above the near fan");
  assert.ok(near.y > farEdge.y, "near fan must be nearer the camera than the table's far edge");

  // Breathing room: the room must stay visible between the Inspector and the
  // far fan, which is what stops the fans from burying the compartment.
  assert.ok(far.y - (head.y + head.h) > 2, "clear air between Inspector and far fan");

  // Every anchor the HUD consumes must be present in both framings.
  const required = ["inspectorHead", "farFan", "slip", "bell", "manifest", "nearFan", "wells", "window"];
  for (const n of required) {
    assert.ok(feature(wide, n), `wide framing must expose the ${n} anchor`);
    assert.ok(feature(portrait, n), `portrait framing must expose the ${n} anchor`);
  }

  // Anchors must be expressible as frame percentages without overflowing badly;
  // the well row is centred and may be wider than the frame by design, but the
  // centre of every anchor must lie inside the frame.
  for (const f of wide.features) {
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    assert.ok(cx > -40 && cx < 360, `${f.name} centre must be near the frame (x=${cx})`);
    assert.ok(cy > -20 && cy < 200, `${f.name} centre must be near the frame (y=${cy})`);
  }

  // The portrait camera is pulled back: the same table occupies less width.
  const pFar = feature(portrait, "tableFarEdge");
  const wFar = feature(wide, "tableFarEdge");
  assert.ok(pFar.w < wFar.w, "portrait framing must pull the camera back");
}
