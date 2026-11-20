/**
 * src/main.js
 * Browser entry point for The Unlisted (5-stop multi-deal run, Platform Locker
 * meta-progression, and interactive beginner tutorial).
 */

import { createRunController } from "./core/run.js";
import { mountAppView } from "./ui/appView.js";

const TUTORIAL_STORAGE_KEY = "the_unlisted_tutorial_seen_v1";

function getSafeStorage() {
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
}

function readTutorialSeen(storage) {
  if (!storage) return false;
  try {
    return storage.getItem(TUTORIAL_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveTutorialSeen(seen) {
  const storage = getSafeStorage();
  if (!storage) return;
  try {
    storage.setItem(TUTORIAL_STORAGE_KEY, seen ? "1" : "0");
  } catch {
    // Storage may be disabled in sandboxed/private mode; game still runs cleanly.
  }
}

function readInitialOptions(storage) {
  try {
    const params = new URLSearchParams(window.location.search);
    const seed = params.get("seed");
    const dev = params.get("dev");
    const autostart = params.get("start");
    const tutorial = params.get("tutorial");
    const locker = params.get("locker");
    const prefersReduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    return {
      seed: seed && seed.trim() ? seed.trim() : "LINE-1926",
      devTraceOpen: dev === "1" || dev === "true",
      autoStartRun: autostart === "1" || autostart === "true",
      autoStartTutorial: tutorial === "1" || tutorial === "true",
      autoOpenLocker: locker === "1" || locker === "true",
      reducedMotion: prefersReduced,
      tutorialCompleted: readTutorialSeen(storage),
    };
  } catch {
    return {
      seed: "LINE-1926",
      devTraceOpen: false,
      autoStartRun: false,
      autoStartTutorial: false,
      autoOpenLocker: false,
      reducedMotion: false,
      tutorialCompleted: false,
    };
  }
}

const storage = getSafeStorage();
const init = readInitialOptions(storage);
const controller = createRunController({
  initialSeed: init.seed,
  tutorialCompleted: init.tutorialCompleted,
  reducedMotion: init.reducedMotion,
  devTraceOpen: init.devTraceOpen,
  storage,
  onTutorialSeen: saveTutorialSeen,
});

mountAppView(controller, document);

if (init.autoStartTutorial) {
  controller.startTutorial({ seed: init.seed });
} else if (init.autoStartRun) {
  controller.startRun({ seed: init.seed, withTutorial: false });
} else if (init.autoOpenLocker) {
  controller.openLocker();
} else {
  controller.openTitle({ seed: init.seed });
}
