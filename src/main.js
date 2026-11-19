/**
 * src/main.js
 * Browser entry point for The Unlisted.
 */

import { STARTING_MODES, TIER_MODES, createDuelController } from "./ui/duelController.js";
import { mountDuelView } from "./ui/duelView.js";

function readInitialOptionsFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const seed = params.get("seed");
    const pairs = params.get("pairs");
    const starter = params.get("starter");
    const tier = params.get("tier");
    const dev = params.get("dev");
    const prefersReduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    return {
      seed: seed && seed.trim() ? seed.trim() : "LINE-1926",
      pairCount: pairs ? Number.parseInt(pairs, 10) : 6,
      startingMode:
        starter && Object.values(STARTING_MODES).includes(starter)
          ? starter
          : STARTING_MODES.ALTERNATE,
      tierMode: tier || TIER_MODES.RAMP,
      devTraceOpen: dev === "1" || dev === "true",
      reducedMotion: prefersReduced,
    };
  } catch {
    return {
      seed: "LINE-1926",
      pairCount: 6,
      startingMode: STARTING_MODES.ALTERNATE,
      tierMode: TIER_MODES.RAMP,
      devTraceOpen: false,
      reducedMotion: false,
    };
  }
}

const init = readInitialOptionsFromUrl();
const controller = createDuelController({
  initialSeed: init.seed,
  initialPairCount: init.pairCount,
  initialStartingMode: init.startingMode,
  initialTierMode: init.tierMode,
  devTraceOpen: init.devTraceOpen,
  reducedMotion: init.reducedMotion,
});

mountDuelView(controller, document);
controller.startNewRun();
