/**
 * src/ui/presentation.js
 * Presentation layer for The Unlisted: the procedural carriage stage, ticket
 * art swapping, tactile motion cues, ambient audio, and the audio/display
 * controls (mute, volume, pixelation, reduced motion).
 *
 * This module owns effects only. It reads controller snapshots, never mutates
 * gameplay state, and every timer/RAF/audio node it creates is disposable so a
 * run restart can never leak (Phase 6 audit requirement).
 */

import { mountStage } from "../visuals/stage.js";
import { createInspectorMotion } from "../visuals/inspectorMotion.js";
import { describeLayout } from "../visuals/scene.js";
import { FAN_BANDS, resolveFixtures } from "../visuals/fixtures.js";
import { projectFramePoint, sceneTransform } from "../visuals/layout.js";
import { createSoundEngine, SOUND_IDS } from "../audio/sound.js";
import { createMotionRail, createSwayController, getMotionProfile, cueForEvent } from "../visuals/motion.js";
import { cachedTicketFace, cachedTicketBack, emblemSvg, stampMarkDataUri } from "../visuals/tickets.js";
import { RUN_SCREENS } from "../core/run.js";
import { PHASES, SIDES } from "../core/engine.js";

const PREFS_KEY = "the_unlisted_presentation_v1";

/** Which stage mood belongs to which screen. */
function moodForScreen(screen) {
  switch (screen) {
    case RUN_SCREENS.TITLE:
    case RUN_SCREENS.LOCKER:
      return "cold";
    case RUN_SCREENS.STOP_RESULT:
    case RUN_SCREENS.RUN_OVER:
      return "cold";
    case RUN_SCREENS.DUEL:
    case RUN_SCREENS.TUTORIAL:
    case RUN_SCREENS.BRIEFING:
      return "warm";
    default:
      return "neutral";
  }
}

function readPrefs(storage) {
  const fallback = { pixelation: true, showHud: true };
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      pixelation: parsed.pixelation !== false,
      // HUD visibility is a look-at-the-room aid, so it defaults to on.
      showHud: parsed.showHud !== false,
    };
  } catch {
    return fallback;
  }
}

function writePrefs(storage, prefs) {
  if (!storage) return;
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage failures.
  }
}

/**
 * @param {object} opts
 * @param {Document} opts.doc
 * @param {object} opts.controller run controller
 * @param {object|null} opts.storage
 * @param {Function} [opts.audioContextFactory] injected in tests
 * @param {Function} [opts.raf]
 * @param {Function} [opts.caf]
 */
export function mountPresentation({
  doc,
  controller,
  storage = null,
  audioContextFactory = null,
  raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null,
  caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null,
} = {}) {
  if (!doc || !controller) return null;

  const prefs = readPrefs(storage);
  let currentScreen = RUN_SCREENS.TITLE;
  let muted = false;
  let volume = 0.7;
  let pixelation = prefs.pixelation !== false;
  let showHud = prefs.showHud !== false;
  let reducedMotion = false;
  let stage = null;
  let lastView = null;
  let lastSpotlight = null;
  let lastStatusStage = "IDLE";
  let lastScreen = null;
  let lastLanterns = null;
  let lastStopIndex = null;

  const listeners = [];
  function listen(target, event, handler, options) {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(event, handler, options);
    listeners.push(() => target.removeEventListener(event, handler, options));
  }

  // ---------------------------------------------------------------- audio
  const sound = createSoundEngine({
    storage,
    contextFactory: audioContextFactory || undefined,
  });

  // ---------------------------------------------------------------- motion
  const motion = createMotionRail({ doc });
  const sway = createSwayController({ root: doc.getElementById("app"), raf, caf });

  // Cosmetic poses use only public observer snapshots, never hidden hands.
  const inspectorMotion = createInspectorMotion();
  let posePhaseKey = null;
  let poseResolutionKey = null;
  let poseScope = null;

  // ---------------------------------------------------------------- stage
  const stageHost = doc.getElementById("carriage-stage");
  stage = mountStage({
    doc,
    container: stageHost,
    raf,
    caf,
    getDescriptor: (now) => ({
      scene: currentScreen,
      mood: moodForScreen(currentScreen),
      reducedMotion,
      framing: currentFraming(),
      inspectorPose: inspectorMotion.sample(now),
    }),
  });
  if (stage) stage.setSettings({ pixelation, dither: 1, scanlines: true, vignette: 0.5 });

  /**
   * Portrait viewports get the pulled-back camera. The threshold is on aspect
   * ratio, not width, so a short wide window keeps the desktop framing.
   */
  function currentFraming() {
    const w = (doc.defaultView && doc.defaultView.innerWidth) || 0;
    const h = (doc.defaultView && doc.defaultView.innerHeight) || 0;
    if (!w || !h) return "wide";
    return h / w > 1.15 ? "portrait" : "wide";
  }

  const dom = {
    app: doc.getElementById("app"),
    stageHost,
    muteToggle: doc.getElementById("mute-toggle"),
    muteGlyph: doc.getElementById("mute-glyph"),
    volumeSlider: doc.getElementById("volume-slider"),
    pixelationToggle: doc.getElementById("pixelation-toggle"),
    reducedMotionToggle: doc.getElementById("reduced-motion-toggle"),
    hudToggle: doc.getElementById("hud-toggle"),
    hudRestore: doc.getElementById("hud-restore"),
    titleEmblemRow: doc.getElementById("title-emblem-row"),
  };

  /**
   * Publish the scene's composition as CSS custom properties on the stage host.
   * `--scene-<anchor>-x/y/w/h` are percentages of the frame, so the HUD can place
   * a bell beside the drawn bell without duplicating any projection maths.
   */
  function publishSceneAnchors() {
    if (!dom.stageHost || !dom.stageHost.style || !dom.stageHost.style.setProperty) return;
    const framing = currentFraming();
    publishFixturePositions(framing);

    const layout = describeLayout({ framing });
    dom.stageHost.setAttribute("data-scene-anchors", String(layout.features.length));
    for (const f of layout.features) {
      const set = (k, v) => dom.stageHost.style.setProperty(`--scene-${f.name}-${k}`, v);
      set("x", `${((f.x / 320) * 100).toFixed(2)}%`);
      set("y", `${((f.y / 180) * 100).toFixed(2)}%`);
      set("w", `${((f.w / 320) * 100).toFixed(2)}%`);
      set("h", `${((f.h / 180) * 100).toFixed(2)}%`);
    }
    dom.stageHost.setAttribute("data-framing", framing);
  }

  /**
   * Place the physical HUD fixtures on the objects the renderer drew.
   *
   * The scene is letterboxed to 16:9 inside the stage, so a fixture expressed as
   * a percentage *of the viewport* drifts away from its furniture on any display
   * that is not exactly 16:9. These are therefore computed in pixels: take the
   * letterboxed scene rect, convert the fixture's frame percentage into a point
   * inside it, and publish the result as `--fx-<name>-left/top`.
   *
   * Emitted as `left`/`top` (centre of the fixture) rather than `x`/`y` so the
   * CSS can centre with a transform and nothing has to know the fixture's size.
   */
  function publishFixturePositions(framing) {
    const root = doc.documentElement;
    if (!root || !root.style || !root.style.setProperty) return;
    const view = doc.defaultView;
    if (!view) return;
    const vw = view.innerWidth || 0;
    const vh = view.innerHeight || 0;
    if (!vw || !vh) return;
    // Fixtures are placed in the SAME space the renderer draws in: the scene is
    // letterboxed with `contain`, so project through exactly that transform or a
    // fixture drifts off its furniture on any viewport that is not 16:9.
    // (Phones do not use these anchors; their layout is a flowing column.)
    const scene = sceneTransform(vw, vh);
    const place = (prefix, f) => {
      const p = projectFramePoint(scene, f.x, f.y);
      root.style.setProperty(`--fx-${prefix}-left`, `${p.left}px`);
      root.style.setProperty(`--fx-${prefix}-top`, `${p.top}px`);
    };
    for (const [name, f] of Object.entries(resolveFixtures(framing))) place(name, f);
    // The card fans sit on the rows the renderer draws them on.
    for (const [name, band] of Object.entries(FAN_BANDS)) {
      place(`fan-${name}`, { x: 50, y: band.y });
    }
    root.setAttribute("data-framing", framing);
  }

  // Anchors must survive a resize/rotation: recompute and republish.
  if (doc.defaultView && typeof doc.defaultView.addEventListener === "function") {
    const onResize = () => {
      publishSceneAnchors();
      if (stage && typeof stage.refresh === "function") stage.refresh();
    };
    doc.defaultView.addEventListener("resize", onResize);
    listeners.push(() => doc.defaultView.removeEventListener("resize", onResize));

  }

  publishSceneAnchors();

  // Reflect the saved HUD preference on first paint. No DOM write beyond the
  // class/attributes: the stored value already matches, so nothing is saved.
  applyHudVisibility(showHud, { persist: false });

  function setPressed(node, pressed) {
    if (!node) return;
    if (typeof node.setAttribute === "function") {
      node.setAttribute("aria-pressed", pressed ? "true" : "false");
    }
    if (node.classList) node.classList.toggle("is-on", Boolean(pressed));
  }

  function syncAudioControls() {
    const p = sound.prefs;
    muted = p.muted;
    volume = p.volume;
    setPressed(dom.muteToggle, !muted);
    if (dom.muteGlyph) dom.muteGlyph.textContent = muted ? "✕" : p.ambience ? "♪" : "♪";
    if (dom.muteToggle) {
      dom.muteToggle.title = muted ? "Unmute (M)" : "Mute all sound (M)";
      dom.muteToggle.setAttribute("aria-label", muted ? "Unmute all sound" : "Mute all sound");
    }
    if (dom.volumeSlider) {
      const pct = Math.round(p.volume * 100);
      if (dom.volumeSlider.value !== String(pct)) dom.volumeSlider.value = String(pct);
      dom.volumeSlider.setAttribute("aria-label", `Master volume ${pct} percent`);
    }
    setPressed(dom.pixelationToggle, pixelation);
    if (dom.pixelationToggle) {
      dom.pixelationToggle.setAttribute(
        "aria-label",
        pixelation ? "Pixelation on: turn off" : "Pixelation off: turn on"
      );
    }
  }

  /**
   * Show or hide the HUD so the carriage can be inspected on its own.
   *
   * This is a *view* switch only: the DOM stays mounted, keeps every live value
   * and keeps its focus order, so hiding the HUD cannot change game state, drop
   * a running animation, or strand keyboard focus on nothing. When hidden, the
   * HUD is made `inert`-like by also removing it from hit-testing, and a small
   * always-visible chip tells the player how to bring it back.
   */
  function applyHudVisibility(next, opts = {}) {
    showHud = Boolean(next);
    prefs.showHud = showHud;
    if (opts.persist !== false) writePrefs(storage, prefs);
    if (dom.app) dom.app.classList.toggle("is-hud-hidden", !showHud);
    if (dom.hudToggle) {
      setPressed(dom.hudToggle, !showHud);
      dom.hudToggle.setAttribute("aria-expanded", showHud ? "false" : "true");
    }
    if (dom.hudRestore) {
      if (typeof dom.hudRestore.setAttribute === "function") {
        dom.hudRestore.setAttribute("aria-hidden", showHud ? "true" : "false");
        dom.hudRestore.tabIndex = showHud ? -1 : 0;
      }
    }
  }

  /** The first real gesture unlocks WebAudio (browsers block autoplay). */
  function unlockAudio() {
    if (sound.isUnlocked) return;
    if (sound.unlock()) syncAudioControls();
  }

  listen(dom.muteToggle, "click", () => {
    unlockAudio();
    sound.setMuted(!sound.prefs.muted);
    if (!sound.prefs.muted) sound.play(SOUND_IDS.UI);
    syncAudioControls();
  });

  listen(dom.volumeSlider, "input", () => {
    unlockAudio();
    const value = Number(dom.volumeSlider.value) / 100;
    sound.setVolume(value);
    volume = sound.prefs.volume;
  });
  listen(dom.volumeSlider, "change", () => {
    sound.play(SOUND_IDS.UI);
    syncAudioControls();
  });

  listen(dom.pixelationToggle, "click", () => {
    pixelation = !pixelation;
    prefs.pixelation = pixelation;
    writePrefs(storage, prefs);
    if (stage) stage.setSettings({ pixelation });
    if (dom.app) dom.app.classList.toggle("is-pixelation-off", !pixelation);
    if (dom.stageHost) dom.stageHost.classList.toggle("is-soft", !pixelation);
    sound.play(SOUND_IDS.UI);
    syncAudioControls();
  });

  listen(dom.hudToggle, "click", () => {
    applyHudVisibility(!showHud);
  });

  listen(dom.hudRestore, "click", () => {
    applyHudVisibility(true);
    // Return focus to the control that toggles it rather than dumping the
    // keyboard user at the top of the document.
    if (dom.hudToggle && typeof dom.hudToggle.focus === "function") dom.hudToggle.focus();
  });

  listen(dom.reducedMotionToggle, "change", () => {
    // The controller owns the flag; we mirror it on the next render.
    controller.setReducedMotion(dom.reducedMotionToggle.checked);
  });

  // Keyboard shortcuts: M mute, P pixelation, H hide/show the HUD.
  listen(doc, "keydown", (ev) => {
    if (!ev || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const target = ev.target;
    const tag = target && target.tagName ? String(target.tagName).toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (ev.key === "m" || ev.key === "M") {
      unlockAudio();
      sound.setMuted(!sound.prefs.muted);
      syncAudioControls();
      if (!ev.defaultPrevented) ev.preventDefault();
    } else if (ev.key === "h" || ev.key === "H") {
      applyHudVisibility(!showHud);
      if (!ev.defaultPrevented) ev.preventDefault();
    } else if (ev.key === "p" || ev.key === "P") {
      pixelation = !pixelation;
      prefs.pixelation = pixelation;
      writePrefs(storage, prefs);
      if (stage) stage.setSettings({ pixelation });
      if (dom.app) dom.app.classList.toggle("is-pixelation-off", !pixelation);
      if (dom.stageHost) dom.stageHost.classList.toggle("is-soft", !pixelation);
      syncAudioControls();
      if (!ev.defaultPrevented) ev.preventDefault();
    }
  });

  // Any pointer press is a user gesture: unlock audio quietly.
  listen(doc, "pointerdown", unlockAudio, { passive: true });
  listen(doc, "keydown", unlockAudio);

  // ---------------------------------------------------------------- ticket art

  /** Depth-first collection of `.ticket-card` nodes (works with any DOM). */
  function collectTickets(root, out = []) {
    if (!root || typeof root !== "object") return out;
    const kids = root.children;
    if (kids && typeof kids.length === "number") {
      for (let i = 0; i < kids.length; i += 1) {
        const child = kids[i];
        if (child && child.classList && child.classList.contains("ticket-card")) out.push(child);
        collectTickets(child, out);
      }
    }
    return out;
  }

  /** Swap text glyphs for the procedural ticket faces (idempotent). */
  function decorateTickets() {
    const apply = (node, isFaceUp, meta) => {
      if (!node || !node.classList || !node.classList.contains("ticket-card")) return;
      const variant = Number(node.dataset?.slot ?? 0);
      if (node.classList.contains("is-face-up")) {
        const symbolId = meta?.isUnlisted ? "UNLISTED" : meta?.symbolId || meta?.id;
        // Keep the original glyph if metadata is missing; never represent an
        // unknown ordinary ticket as the punched Unlisted face.
        if (!symbolId) return;
        const key = symbolId;
        if (node.dataset.artKey !== `${key}-${variant}`) {
          node.dataset.artKey = `${key}-${variant}`;
          if (typeof node.style?.setProperty === "function") {
            node.style.setProperty("--ticket-face", `url("${cachedTicketFace(key, variant)}")`);
          }
        }
        const glyph = node.querySelector?.(".ticket-glyph");
        if (glyph && typeof glyph.remove === "function") glyph.remove();
      } else if (node.dataset.artKey !== `back-${variant}`) {
        node.dataset.artKey = `back-${variant}`;
        if (typeof node.style?.setProperty === "function") {
          node.style.setProperty("--ticket-back", `url("${cachedTicketBack()}")`);
        }
      }
    };

    const roots = ["player-fan", "inspector-fan", "spotlight-tray"];
    for (const id of roots) {
      const root = doc.getElementById(id);
      if (!root) continue;
      const cards = collectTickets(root);
      for (const card of cards) {
        const symbolId = card.dataset?.symbol || null;
        apply(card, card.classList.contains("is-face-up"), {
          isUnlisted: symbolId === "UNLISTED",
          symbolId: symbolId === "UNLISTED" ? null : symbolId,
        });
      }
    }
  }

  // ---------------------------------------------------------------- feedback

  function feedbackForResolution(view) {
    if (!view || !view.lastResolution) return;
    const res = view.lastResolution;
    const key = `${res.turnNumber}-${res.slotIndex}-${res.offerId ?? ""}`;
    if (key === lastSpotlight) return;
    lastSpotlight = key;
    const playerDrew = res.drawer === SIDES.PLAYER;
    const fan = doc.getElementById(playerDrew ? "player-fan" : "inspector-fan");
    const spotlight = doc.getElementById("spotlight-tray");
    if (res.drewUnlisted) {
      motion.play(spotlight, "PUNCH");
      sound.play(SOUND_IDS.PUNCH);
      sway.kick(0.22);
    } else {
      motion.play(spotlight, "PAIR_SNAP");
      motion.play(fan, "CARD_ARRIVE");
      sound.play(SOUND_IDS.MATCH);
    }
  }

  /**
   * Translate a controller snapshot into sound + motion. Idempotent: it keys
   * off changes in the snapshot, so re-rendering the same state is silent.
   */
  function react(snap) {
    if (!snap) return;
    currentScreen = snap.screen;
    reducedMotion = Boolean(snap.reducedMotion);
    motion.setProfile(getMotionProfile(reducedMotion));
    sway.setReducedMotion(reducedMotion);
    if (stage) stage.refresh();

    // Mirror the controller's reduced-motion flag into the checkbox.
    if (dom.reducedMotionToggle) {
      dom.reducedMotionToggle.checked = reducedMotion;
    }

    // Screen changes: one soft cue + reveal animation on the incoming panel.
    if (snap.screen !== lastScreen) {
      if (lastScreen !== null) {
        if (snap.screen === RUN_SCREENS.RUN_OVER) {
          const victory = snap.runOutcome === "VICTORY";
          sound.play(victory ? SOUND_IDS.VICTORY : SOUND_IDS.DEFEAT);
        } else if (snap.screen === RUN_SCREENS.REWARD || snap.screen === RUN_SCREENS.STARTER_DRAFT) {
          sound.play(SOUND_IDS.REWARD);
          motion.play(panelFor(snap.screen), "REWARD");
        } else if (snap.screen === RUN_SCREENS.DUEL) {
          sound.play(SOUND_IDS.FLIP);
        } else {
          sound.play(SOUND_IDS.UI);
        }
      }
      lastScreen = snap.screen;
      if (dom.app) dom.app.dataset.screen = snap.screen;
    }

    // Lantern loss.
    if (typeof snap.lanterns === "number" && lastLanterns !== null && snap.lanterns < lastLanterns) {
      sound.play(SOUND_IDS.LANTERN);
      motion.play(doc.getElementById("lantern-meter"), "LANTERN_LOSS");
      sway.kick(0.3);
    }
    if (typeof snap.lanterns === "number") lastLanterns = snap.lanterns;

    // New carriage: settle the table in.
    if (typeof snap.stopIndex === "number") {
      if (lastStopIndex !== null && snap.stopIndex !== lastStopIndex) {
        motion.play(doc.getElementById("table-screen"), "CARD_SETTLE");
      }
      lastStopIndex = snap.stopIndex;
    }

    // Commit suspense beat: the table dims while the draw resolves.
    if (snap.statusStage === "REVEAL_BEAT" && lastStatusStage !== "REVEAL_BEAT") {
      sound.play(SOUND_IDS.REVEAL);
      motion.play(doc.getElementById("spotlight-tray"), "REVEAL");
      if (dom.app) dom.app.classList.add("is-resolving");
      motion.wait(getMotionProfile(reducedMotion).commitSuspense, () => {
        if (dom.app) dom.app.classList.remove("is-resolving");
      });
    }
    lastStatusStage = snap.statusStage;

    // Only public phase/actor and publicly displayed resolution drive the pose.
    // A reaction wins when events coincide; the next public phase can retarget.
    inspectorMotion.setReducedMotion(reducedMotion);
    const inDuel = snap.screen === RUN_SCREENS.DUEL || snap.screen === RUN_SCREENS.TUTORIAL;
    const scope = `${snap.screen}|${snap.stopIndex ?? ''}|${snap.dealNumberInStop ?? ''}|${snap.encounterIndex ?? ''}`;
    if (!inDuel || scope !== poseScope) {
      inspectorMotion.reset();
      posePhaseKey = null;
      poseResolutionKey = null;
      poseScope = inDuel ? scope : null;
    }
    const v = inDuel ? snap.view : null;
    const res = v?.lastResolution;
    const resKey = res && snap.activeSpotlight ? `${res.turnNumber}|${res.offerId}|${res.drawer}` : null;
    const phasePose = v?.phase === PHASES.OFFER && v.offerer === SIDES.INSPECTOR ? 'offer'
      : v?.phase === PHASES.DRAW && v.drawer === SIDES.INSPECTOR ? 'draw' : null;
    const phaseKey = phasePose ? `${phasePose}|${v.turnNumber}|${v.offerId}` : null;
    if (resKey && resKey !== poseResolutionKey) {
      poseResolutionKey = resKey;
      posePhaseKey = phaseKey;
      inspectorMotion.trigger('react');
    } else if (phaseKey && phaseKey !== posePhaseKey) {
      posePhaseKey = phaseKey;
      inspectorMotion.trigger(phasePose);
    }

    // Draw / pair resolution cue.
    feedbackForResolution(snap.view);
    lastView = snap.view;

    decorateTickets();
  }

  function panelFor(screen) {
    if (screen === RUN_SCREENS.REWARD || screen === RUN_SCREENS.STARTER_DRAFT) return doc.getElementById("reward-screen");
    if (screen === RUN_SCREENS.RUN_OVER) return doc.getElementById("run-over-screen");
    if (screen === RUN_SCREENS.STOP_RESULT) return doc.getElementById("stop-result-screen");
    return null;
  }

  function playCue(event) {
    const cue = cueForEvent(event, getMotionProfile(reducedMotion));
    if (cue.sound) sound.play(cue.sound);
    if (cue.shake) sway.kick(cue.shake === 2 ? 0.3 : 0.18);
    return cue;
  }

  // ---------------------------------------------------------------- title art
  function renderTitleArt() {
    if (!dom.titleEmblemRow) return;
    if (dom.titleEmblemRow.dataset.rendered === "1") return;
    const ids = ["LANTERN", "WATCH", "KEY", "BELL"];
    const markup = ids.map((id) => emblemSvg(id, 28)).join("");
    if (typeof dom.titleEmblemRow.innerHTML === "string") {
      dom.titleEmblemRow.innerHTML = markup;
      dom.titleEmblemRow.dataset.rendered = "1";
    }
  }

  // ---------------------------------------------------------------- bootstrap
  syncAudioControls();
  renderTitleArt();
  if (dom.app) dom.app.classList.toggle("is-pixelation-off", !pixelation);
  if (dom.stageHost) dom.stageHost.classList.toggle("is-soft", !pixelation);

  const unsubscribe = controller.subscribe(react);

  return {
    react,
    playCue,
    get stageMode() {
      return stage ? stage.mode : "disabled";
    },
    get sound() {
      return sound;
    },
    get motion() {
      return motion;
    },
    setPixelation(on) {
      pixelation = Boolean(on);
      if (stage) stage.setSettings({ pixelation });
      if (dom.app) dom.app.classList.toggle("is-pixelation-off", !pixelation);
      syncAudioControls();
    },
    getPixelation() {
      return pixelation;
    },
    /**
     * Exposed for the QA harness and for anything that wants to reveal the
     * carriage. `persist: false` previews without overwriting the player's
     * saved preference.
     */
    setHudVisible(on, opts) {
      applyHudVisibility(Boolean(on), opts || {});
    },
    getHudVisible() {
      return showHud;
    },
    dispose() {
      unsubscribe();
      while (listeners.length > 0) {
        const off = listeners.pop();
        off();
      }
      motion.dispose();
      sway.dispose();
      if (stage) stage.dispose();
      sound.dispose();
    },
  };
}

export { moodForScreen, stampMarkDataUri };
