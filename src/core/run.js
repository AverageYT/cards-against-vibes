/**
 * src/core/run.js
 * Complete 5-stop roguelike run state machine & session controller for The Unlisted.
 *
 * Manages:
 * - Screens: TITLE, LOCKER, TUTORIAL, STARTER_DRAFT, BRIEFING, DUEL, STOP_RESULT,
 *   REWARD, RUN_OVER
 * - Multi-deal carriages (First to 2 Deals on Carriages I–IV; First to 3 Deals on
 *   Final Inspection) with strictly alternating first actor across every deal
 * - Elevated Inspector AI (Tiers 3->5) wielding legal Inspector Stamps with visible
 *   public tradeoffs (swap forfeits, edge exposures) that skilled players can punish
 * - Platform Locker meta-progression: Punched Stubs earned every run (win or lose)
 *   to unlock Keepsakes — anchored by the Keystone Special Item (The Perforation
 *   Gauge: Gauge Safe 1–2/deal, Inspector Stamp jamming, and Departure Stamp draft),
 *   plus Thumb-Worn Tallow (Check Edge 1/deal), Smuggler's Carbon (Reward Reroll),
 *   Double-Wick Storm Lamp (Emergency Match + 2-win Lantern heal), and more
 * - 3 Lantern charges, 3 Stamp slots (pick/replace/reroll/skip), 4 Carriage Conditions
 *   with live expiry, skippable/replayable interactive tutorial, repeatable seeds,
 *   double-draw locking, developer trace, and zero-leak timer disposal
 */

import {
  ACTION_TYPES,
  PHASES,
  SIDES,
  applyAction,
  createDuel,
  exportReplay,
  getActiveActor,
  getStartingOfferer,
} from "./engine.js";
import { createObserverView } from "./observer.js";
import { createRng, deriveSeed, normalizeSeed } from "./rng.js";
import { createMetaStore } from "./meta.js";
import { getTicketMeta } from "../data/tickets.js";
import {
  CARRIAGES,
  INITIAL_LANTERNS,
  MAX_LANTERNS,
  TOTAL_STOPS,
  getCarriageDef,
  resolveInspectorLoadout,
} from "../data/carriages.js";
import {
  MAX_STAMP_SLOTS,
  REWARD_CHOICE_COUNT,
  STAMP_LIST,
  getStampDef,
} from "../data/stamps.js";
import {
  CLEAR_LINE_CONDITION,
  CONDITION_LIST,
  getConditionDef,
} from "../data/conditions.js";
import { computeKeepsakeBonuses, getKeepsakeDef } from "../data/keepsakes.js";
import { getTierConfig } from "../data/aiTuning.js";
import { createInspectorAgent } from "../ai/inspector.js";
import { createTutorialSession } from "./tutorial.js";

export const RUN_SCREENS = Object.freeze({
  TITLE: "TITLE",
  LOCKER: "LOCKER",
  TUTORIAL: "TUTORIAL",
  STARTER_DRAFT: "STARTER_DRAFT",
  BRIEFING: "BRIEFING",
  DUEL: "DUEL",
  STOP_RESULT: "STOP_RESULT",
  REWARD: "REWARD",
  RUN_OVER: "RUN_OVER",
});

export const RUN_OUTCOMES = Object.freeze({
  VICTORY: "VICTORY",
  DEFEAT: "DEFEAT",
});

const DEFAULT_TIMINGS = Object.freeze({
  inspectorOfferMs: 320,
  inspectorDrawMs: 460,
  inspectorStampMs: 260,
  endgameExtraPauseMs: 140,
  revealHoldMs: 600,
});

const REDUCED_TIMINGS = Object.freeze({
  inspectorOfferMs: 100,
  inspectorDrawMs: 130,
  inspectorStampMs: 80,
  endgameExtraPauseMs: 0,
  revealHoldMs: 170,
});

const IMMEDIATE_TIMINGS = Object.freeze({
  inspectorOfferMs: 0,
  inspectorDrawMs: 0,
  inspectorStampMs: 0,
  endgameExtraPauseMs: 0,
  revealHoldMs: 0,
});

/**
 * Deterministically assign distinct Carriage Conditions to Stops 2..5 from runSeed.
 */
export function buildConditionSchedule(runSeed) {
  const condRng = createRng(deriveSeed(runSeed, "run:conditions"));
  const pool = condRng.shuffle(CONDITION_LIST.map((c) => c.id));
  let cursor = 0;

  return CARRIAGES.map((car) => {
    if (!car.hasCondition) return null;
    const id = pool[cursor % pool.length];
    cursor += 1;
    return id;
  });
}

/**
 * Deterministically roll up to 3 distinct unowned Stamps for a reward or departure tray.
 */
export function rollStampRewardOffer(
  runSeed,
  stopTag,
  equippedStamps = [],
  rerollIndex = 0,
  excludeIds = []
) {
  const ownedSet = new Set(equippedStamps.filter(Boolean));
  const excludeSet = new Set(excludeIds.filter(Boolean));
  const allEligible = STAMP_LIST.map((s) => s.id).filter((id) => !ownedSet.has(id));
  if (allEligible.length === 0) return [];

  const tag =
    rerollIndex > 0
      ? `run:reward:stop:${stopTag}:reroll:${rerollIndex}`
      : `run:reward:stop:${stopTag}`;
  const rewardRng = createRng(deriveSeed(runSeed, tag));

  // Prefer fresh Stamps not shown on the previous roll when rerolling, filling remaining slots if needed.
  if (rerollIndex > 0 && excludeSet.size > 0) {
    const fresh = rewardRng.shuffle(allEligible.filter((id) => !excludeSet.has(id)));
    const fallback = rewardRng.shuffle(allEligible.filter((id) => excludeSet.has(id)));
    return [...fresh, ...fallback].slice(0, Math.min(REWARD_CHOICE_COUNT, allEligible.length));
  }

  const shuffled = rewardRng.shuffle(allEligible);
  return shuffled.slice(0, Math.min(REWARD_CHOICE_COUNT, shuffled.length));
}

function describeInspectorStampPlay(action, state) {
  const def = getStampDef(action.stampId);
  const name = def ? def.name : action.stampId;
  if (action.stampId === "INSPECTION_WINDOW") {
    return `The Inspector slides open his ${name} and peeks at Slot #${
      (action.targetSlot ?? 0) + 1
    } of your fan! (Tradeoff: his next Offer cannot swap.)`;
  }
  if (action.stampId === "MANIFEST_LOUPE") {
    return `The Inspector sweeps two adjacent slots with his ${name}! (Tradeoff: his next Offer exposes his leftmost ticket.)`;
  }
  if (action.stampId === "BRASS_WEIGHT") {
    return `The Inspector sets a ${name} on his Slot #${
      (action.targetSlot ?? 0) + 1
    } — locked this turn! (Tradeoff: his next Offer exposes his rightmost ticket.)`;
  }
  if (action.stampId === "NIGHT_TRANSFER") {
    return `The Inspector stamps ${name} to regain a private swap on this Offer.`;
  }
  return state.lastStampFeedback?.message || `The Inspector used ${name}.`;
}

export function createRunController({
  initialSeed = "LINE-1926",
  tutorialCompleted = null,
  reducedMotion = false,
  devTraceOpen = false,
  immediate = false,
  opponentOverride = null,
  dealsToWinOverride = null,
  metaStore = null,
  storage = null,
  scheduler = null,
  onTutorialSeen = null,
} = {}) {
  const scheduleImpl = scheduler?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelImpl = scheduler?.clearTimeout ?? ((id) => clearTimeout(id));
  const meta = metaStore || createMetaStore({ storage });

  if (tutorialCompleted === true && !meta.getSnapshot().tutorialSeen) {
    meta.setTutorialSeen(true);
  }

  const pendingTimers = new Set();
  const subscribers = new Set();
  const inspectorAgent = createInspectorAgent({ tier: 3 });
  const tutorial = createTutorialSession();

  let disposed = false;
  let generation = 0;

  // Persistent UI preferences
  let isReducedMotion = Boolean(reducedMotion);
  let isDevTraceOpen = Boolean(devTraceOpen);
  let isImmediate = Boolean(immediate);
  let lockerReturnScreen = RUN_SCREENS.TITLE;
  let lockerNotice = null;

  // Run state
  let screen = RUN_SCREENS.TITLE;
  let runSeed = normalizeSeed(initialSeed);
  let runBonuses = meta.getBonuses();
  let conditionSchedule = buildConditionSchedule(runSeed);
  let lanterns = INITIAL_LANTERNS;
  let maxLanterns = MAX_LANTERNS;
  let emergencyMatchesLeft = 0;
  let consecutiveCarriageWins = 0;
  let equippedStamps = [];
  let starterGiftStampId = null;
  let stopIndex = 0; // 0..4
  let dealWins = 0;
  let dealLosses = 0;
  let dealNumberInStop = 1;
  let encounterCounter = 0; // strictly increments after every deal for starter alternation
  let rematchCount = 0;
  let stopHistory = [];
  let lastStopSummary = null;
  let rewardChoices = [];
  let rewardRerollsLeft = 0;
  let rewardRerollCount = 0;
  let pendingReplaceStampId = null;
  let runOutcome = null;
  let lastRunPayout = null;

  // Run telemetry for Punched Stub rewards
  let runStats = {
    playerPairsMatched: 0,
    playerEmblemPairsMatched: 0,
    dealsWon: 0,
    dealsPlayed: 0,
    carriagesWon: 0,
  };

  // Active deal state
  let duelState = null;
  let currentInspectorLoadout = { activeIds: [], jammedIds: [] };
  let aiRng = null;
  let selectedSwapSlot = null;
  let lastSwappedSlots = [];
  let newlyDrawnUnlistedSlot = null;
  let targetingStampId = null;
  let targetingEdgeCheck = false;
  let inputLocked = false;
  let statusStage = "IDLE";
  let activeSpotlight = null;
  let lastNotice = null;

  function getDealsRequiredForStop(carriage) {
    if (Number.isInteger(dealsToWinOverride) && dealsToWinOverride >= 1) {
      return dealsToWinOverride;
    }
    return carriage.dealsToWin || 2;
  }

  function getTimings() {
    if (isImmediate) return IMMEDIATE_TIMINGS;
    return isReducedMotion ? REDUCED_TIMINGS : DEFAULT_TIMINGS;
  }

  function clearAllTimers() {
    for (const id of pendingTimers) {
      cancelImpl(id);
    }
    pendingTimers.clear();
  }

  function bumpGenerationAndClearTimers() {
    clearAllTimers();
    generation += 1;
    inputLocked = false;
    statusStage = "IDLE";
  }

  function scheduleStep(fn, delayMs) {
    if (disposed) return;
    const expectedGen = generation;
    if (delayMs <= 0 && isImmediate) {
      fn();
      return;
    }
    const id = scheduleImpl(() => {
      pendingTimers.delete(id);
      if (disposed || generation !== expectedGen) return;
      fn();
    }, Math.max(0, delayMs));
    pendingTimers.add(id);
  }

  function emit() {
    if (disposed) return;
    const snap = getSnapshot();
    for (const listener of subscribers) {
      listener(snap);
    }
  }

  function markTutorialSeen() {
    meta.setTutorialSeen(true);
    if (typeof onTutorialSeen === "function") {
      try {
        onTutorialSeen(true);
      } catch {
        // Ignore storage errors.
      }
    }
  }

  function syncRunStateFromDuel(state) {
    lanterns = state.lanterns.PLAYER;
    if (state.consumedStamps.PLAYER.length > 0) {
      const consumedSet = new Set(state.consumedStamps.PLAYER);
      equippedStamps = equippedStamps.filter((id) => !consumedSet.has(id));
    }
  }

  function buildSpotlight(res) {
    if (!res) return null;
    const drawerLabel = res.drawer === SIDES.PLAYER ? "You" : "The Inspector";
    const offererLabel = res.offerer === SIDES.PLAYER ? "your fan" : "the Inspector's fan";
    const slotHuman = res.slotIndex + 1;
    const triggerSuffix =
      Array.isArray(res.stampTriggerNotes) && res.stampTriggerNotes.length > 0
        ? ` ${res.stampTriggerNotes.join(" ")}`
        : "";

    if (res.drewUnlisted) {
      return {
        kind: "UNLISTED",
        drawer: res.drawer,
        ticketMeta: getTicketMeta("UNLISTED"),
        headline:
          res.drawer === SIDES.PLAYER
            ? "You drew The Unlisted."
            : "The Inspector took The Unlisted.",
        detail: `${drawerLabel} pulled slot #${slotHuman} of ${res.offererHandSizeBefore} from ${offererLabel} — blank stock, one black punch.`,
      };
    }

    const meta = getTicketMeta(res.matchedSymbolId);
    return {
      kind: "PAIR",
      drawer: res.drawer,
      ticketMeta: meta,
      headline: `Matched pair: ${meta.name}${meta.isEmblem ? " ★" : ""}`,
      detail: `${drawerLabel} drew slot #${slotHuman} of ${res.offererHandSizeBefore} from ${offererLabel} and cleared both ${meta.name} tickets.${triggerSuffix}`,
    };
  }

  // -------------------------
  // Title & Platform Locker
  // -------------------------

  function openTitle(options = {}) {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    bumpGenerationAndClearTimers();
    if (options.seed !== undefined) {
      runSeed = normalizeSeed(options.seed, { allowRandom: Boolean(options.allowRandomSeed) });
    }
    duelState = null;
    targetingStampId = null;
    targetingEdgeCheck = false;
    selectedSwapSlot = null;
    pendingReplaceStampId = null;
    lockerNotice = null;
    screen = RUN_SCREENS.TITLE;
    emit();
    return { ok: true, snapshot: getSnapshot() };
  }

  function openLocker() {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    if (screen === RUN_SCREENS.RUN_OVER || screen === RUN_SCREENS.TITLE) {
      lockerReturnScreen = screen;
    } else {
      bumpGenerationAndClearTimers();
      lockerReturnScreen = RUN_SCREENS.TITLE;
    }
    lockerNotice = null;
    screen = RUN_SCREENS.LOCKER;
    emit();
    return { ok: true, snapshot: getSnapshot() };
  }

  function closeLocker() {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    lockerNotice = null;
    screen =
      lockerReturnScreen === RUN_SCREENS.RUN_OVER && runOutcome
        ? RUN_SCREENS.RUN_OVER
        : RUN_SCREENS.TITLE;
    emit();
    return { ok: true, snapshot: getSnapshot() };
  }

  function buyKeepsake(keepsakeId) {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    const res = meta.unlock(keepsakeId);
    if (!res.ok) {
      lockerNotice = res.message || "Cannot unlock that Keepsake yet.";
      emit();
      return res;
    }
    lockerNotice = res.keepsake.isKeystone
      ? `★ Unlocked ${res.keepsake.name}! Gauge Safe, Inspector Stamp Jamming, and Departure Stamp Draft are now active for every run.`
      : `Unlocked ${res.keepsake.name} — active on your next run!`;
    emit();
    return res;
  }

  function toggleKeepsake(keepsakeId) {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    const res = meta.toggleActive(keepsakeId);
    if (!res.ok) return res;
    const def = getKeepsakeDef(keepsakeId);
    lockerNotice = `${def ? def.name : keepsakeId} ${
      res.active ? "equipped for runs." : "stowed in locker (inactive)."
    }`;
    emit();
    return res;
  }

  function resetLockerProgress() {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    meta.resetProgress();
    lockerNotice = "Platform Locker reset to Empty Pockets (0 Stubs, 0 Keepsakes).";
    emit();
    return { ok: true, snapshot: getSnapshot() };
  }

  function setSeed(seedInput, { allowRandom = false } = {}) {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    runSeed = normalizeSeed(seedInput, { allowRandom });
    emit();
    return { ok: true, runSeed };
  }

  // -------------------------
  // Run Start, Tutorial & Departure Draft
  // -------------------------

  function resetStopMatchCounters() {
    dealWins = 0;
    dealLosses = 0;
    dealNumberInStop = 1;
  }

  function startRun(options = {}) {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    bumpGenerationAndClearTimers();

    if (options.seed !== undefined) {
      runSeed = normalizeSeed(options.seed, { allowRandom: Boolean(options.allowRandomSeed) });
    } else if (options.allowRandomSeed) {
      runSeed = normalizeSeed("", { allowRandom: true });
    }

    // Snapshot active Keepsake bonuses for this run (or explicit override in tests).
    runBonuses = Array.isArray(options.activeKeepsakes)
      ? computeKeepsakeBonuses(options.activeKeepsakes)
      : meta.getBonuses();

    // Complete run & AI learner reset (RULES.md Section 10).
    inspectorAgent.resetForNewRun();
    conditionSchedule = buildConditionSchedule(runSeed);
    lanterns = INITIAL_LANTERNS;
    maxLanterns = MAX_LANTERNS;
    emergencyMatchesLeft = runBonuses.emergencyMatchesPerRun;
    consecutiveCarriageWins = 0;
    starterGiftStampId = null;
    stopIndex = 0;
    resetStopMatchCounters();
    encounterCounter = 0;
    rematchCount = 0;
    stopHistory = [];
    lastStopSummary = null;
    rewardChoices = [];
    rewardRerollsLeft = 0;
    rewardRerollCount = 0;
    pendingReplaceStampId = null;
    runOutcome = null;
    lastRunPayout = null;
    runStats = {
      playerPairsMatched: 0,
      playerEmblemPairsMatched: 0,
      dealsWon: 0,
      dealsPlayed: 0,
      carriagesWon: 0,
    };

    duelState = null;
    selectedSwapSlot = null;
    lastSwappedSlots = [];
    newlyDrawnUnlistedSlot = null;
    targetingStampId = null;
    targetingEdgeCheck = false;
    activeSpotlight = null;
    lastNotice = null;
    lockerNotice = null;

    if (options.withTutorial) {
      equippedStamps = [];
      tutorial.reset();
      screen = RUN_SCREENS.TUTORIAL;
      emit();
      return { ok: true, snapshot: getSnapshot() };
    }

    // Apply starting Stamps (explicit override, Perforation Gauge 3-choice Draft, or Weathered Case gift).
    if (Array.isArray(options.startingStamps)) {
      equippedStamps = options.startingStamps.slice(0, MAX_STAMP_SLOTS);
      screen = RUN_SCREENS.BRIEFING;
      emit();
      return { ok: true, snapshot: getSnapshot() };
    }

    equippedStamps = [];
    if (runBonuses.starterStampMode === "DRAFT_3" && !options.skipStarterDraft) {
      rewardChoices = rollStampRewardOffer(runSeed, "starter", [], 0);
      rewardRerollsLeft = runBonuses.rewardRerollsPerTray;
      rewardRerollCount = 0;
      screen = RUN_SCREENS.STARTER_DRAFT;
      emit();
      return { ok: true, snapshot: getSnapshot() };
    }

    if (runBonuses.starterStampMode === "RANDOM_1") {
      const starterPool = rollStampRewardOffer(runSeed, "starter-random", [], 0);
      if (starterPool.length > 0) {
        equippedStamps = [starterPool[0]];
        starterGiftStampId = starterPool[0];
      }
    }

    screen = RUN_SCREENS.BRIEFING;
    emit();
    return { ok: true, snapshot: getSnapshot() };
  }

  function chooseStarterStamp(stampId) {
    if (disposed || screen !== RUN_SCREENS.STARTER_DRAFT) {
      return { ok: false, reason: "WRONG_SCREEN" };
    }
    if (!rewardChoices.includes(stampId)) {
      return { ok: false, reason: "STAMP_NOT_OFFERED" };
    }
    equippedStamps = [stampId];
    starterGiftStampId = stampId;
    rewardChoices = [];
    rewardRerollsLeft = 0;
    screen = RUN_SCREENS.BRIEFING;
    emit();
    return { ok: true, snapshot: getSnapshot() };
  }

  function skipStarterDraft() {
    if (disposed || screen !== RUN_SCREENS.STARTER_DRAFT) {
      return { ok: false, reason: "WRONG_SCREEN" };
    }
    rewardChoices = [];
    rewardRerollsLeft = 0;
    screen = RUN_SCREENS.BRIEFING;
    emit();
    return { ok: true, snapshot: getSnapshot() };
  }

  function startTutorial(options = {}) {
    if (options.seed !== undefined) {
      runSeed = normalizeSeed(options.seed);
    }
    return startRun({ seed: runSeed, withTutorial: true });
  }

  function skipTutorial() {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    markTutorialSeen();
    return startRun({ seed: runSeed, withTutorial: false });
  }

  function completeTutorialAndStartRun() {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    markTutorialSeen();
    return startRun({ seed: runSeed, withTutorial: false });
  }

  function tutorialAcknowledge() {
    if (disposed || screen !== RUN_SCREENS.TUTORIAL) {
      return { ok: false, reason: "NOT_IN_TUTORIAL" };
    }
    if (tutorial.getSnapshot().isComplete) {
      return completeTutorialAndStartRun();
    }
    const res = tutorial.acknowledge();
    emit();
    return res;
  }

  function restartRun() {
    return startRun({ seed: runSeed, withTutorial: false });
  }

  function startFreshRandomRun() {
    return startRun({ allowRandomSeed: true, withTutorial: false });
  }

  // -------------------------
  // Stop Briefing -> Deal Start
  // -------------------------

  function getCurrentEncounterSeeds() {
    const tag = `stop:${stopIndex}:deal:${dealNumberInStop}:enc:${encounterCounter}:rem:${rematchCount}`;
    return {
      shuffleSeed: deriveSeed(runSeed, `${tag}:shuffle`),
      aiSeed: deriveSeed(runSeed, `${tag}:ai`),
    };
  }

  function launchCurrentDeal() {
    bumpGenerationAndClearTimers();

    const carriage = getCarriageDef(stopIndex);
    const dealsRequired = getDealsRequiredForStop(carriage);
    const conditionId = conditionSchedule[stopIndex];
    const startingOfferer = getStartingOfferer(encounterCounter);
    const seeds = getCurrentEncounterSeeds();
    currentInspectorLoadout = resolveInspectorLoadout(
      carriage,
      runBonuses.inspectorStampJams
    );

    // Keep learned player habits across deals & carriages; reset only per-deal cache.
    inspectorAgent.resetForNewDuel();
    inspectorAgent.setTier(carriage.aiTier);
    aiRng = createRng(seeds.aiSeed);

    duelState = createDuel({
      encounterSeed: seeds.shuffleSeed,
      pairCount: carriage.pairCount,
      encounterIndex: encounterCounter,
      startingOfferer,
      conditionId,
      playerStamps: equippedStamps,
      inspectorStamps: opponentOverride ? [] : currentInspectorLoadout.activeIds,
      playerLanterns: lanterns,
      maxLanterns,
      playerEdgeChecks: runBonuses.edgeChecksPerDeal,
      playerGaugeCharges: runBonuses.gaugeChargesPerDeal,
    });

    selectedSwapSlot = null;
    lastSwappedSlots = [];
    newlyDrawnUnlistedSlot = null;
    targetingStampId = null;
    targetingEdgeCheck = false;
    activeSpotlight = null;
    screen = RUN_SCREENS.DUEL;

    const dealPrefix =
      dealsRequired > 1 ? `Deal ${dealNumberInStop} (${dealWins}–${dealLosses}) · ` : "";
    const dealtPairs = duelState.initialDealPairCount;
    if (dealtPairs > 0) {
      const live = carriage.pairCount - dealtPairs;
      lastNotice = `${dealPrefix}Cleared ${dealtPairs} opening ${
        dealtPairs === 1 ? "pair" : "pairs"
      } — ${live} live ${live === 1 ? "pair" : "pairs"} + The Unlisted in play.`;
    } else {
      lastNotice = `${dealPrefix}All ${carriage.pairCount} pairs + The Unlisted remain in play.`;
    }

    advanceDuelFlow(false);
  }

  function beginStopDuel() {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    if (screen !== RUN_SCREENS.BRIEFING) {
      return { ok: false, reason: "WRONG_SCREEN" };
    }
    launchCurrentDeal();
    return { ok: true, snapshot: getSnapshot() };
  }

  // -------------------------
  // Deal & Carriage Resolution
  // -------------------------

  function finalizeRun(outcome) {
    runOutcome = outcome;
    const victory = outcome === RUN_OUTCOMES.VICTORY;
    const stopReached = victory ? TOTAL_STOPS : stopIndex + 1;
    const recorded = meta.recordCompletedRun({
      playerPairsMatched: runStats.playerPairsMatched,
      playerEmblemPairsMatched: runStats.playerEmblemPairsMatched,
      dealsWon: runStats.dealsWon,
      carriagesWon: runStats.carriagesWon,
      stopReached,
      victory,
    });
    lastRunPayout = recorded.payout;
    screen = RUN_SCREENS.RUN_OVER;
    emit();
  }

  function resolveCompletedDuel() {
    if (!duelState || duelState.phase !== PHASES.OVER) return;

    syncRunStateFromDuel(duelState);
    const carriage = getCarriageDef(stopIndex);
    const dealsRequired = getDealsRequiredForStop(carriage);
    const wonDeal = duelState.winner === SIDES.PLAYER;

    // Tally player pair matches for Punched Stubs.
    let dealPlayerPairs = 0;
    let dealPlayerEmblems = 0;
    for (const p of duelState.discardPairs) {
      if (p.source === "DRAW" && p.owner === SIDES.PLAYER) {
        dealPlayerPairs += 1;
        if (p.isEmblem) dealPlayerEmblems += 1;
      }
    }
    runStats.playerPairsMatched += dealPlayerPairs;
    runStats.playerEmblemPairsMatched += dealPlayerEmblems;
    runStats.dealsPlayed += 1;
    if (wonDeal) runStats.dealsWon += 1;

    // Advance encounter counter after every deal so first actor strictly alternates.
    encounterCounter += 1;
    inputLocked = false;
    statusStage = "IDLE";
    targetingStampId = null;
    targetingEdgeCheck = false;
    selectedSwapSlot = null;

    if (wonDeal) {
      dealWins += 1;
    } else if (dealLosses + 1 >= dealsRequired && emergencyMatchesLeft > 0) {
      // Double-Wick Storm Lamp: Emergency Match automatically blocks your first carriage-losing final deal!
      emergencyMatchesLeft -= 1;
      dealNumberInStop += 1;
      lastStopSummary = {
        kind: "DEAL_CONTINUE",
        won: false,
        emergencyMatchSaved: true,
        carriage,
        dealJustPlayed: dealNumberInStop - 1,
        dealWins,
        dealLosses,
        dealsRequired,
        lanternsBefore: lanterns,
        lanternsAfter: lanterns,
        lanternLost: false,
        lanternHealed: false,
        isRematchNext: false,
        hasReward: false,
        turns: duelState.turnNumber,
      };
      screen = RUN_SCREENS.STOP_RESULT;
      emit();
      return;
    } else {
      dealLosses += 1;
    }

    // Check if more deals remain inside this carriage match.
    const carriageWon = dealWins >= dealsRequired;
    const carriageLost = dealLosses >= dealsRequired;

    if (!carriageWon && !carriageLost) {
      const playedDealNum = dealNumberInStop;
      dealNumberInStop += 1;
      lastStopSummary = {
        kind: "DEAL_CONTINUE",
        won: wonDeal,
        emergencyMatchSaved: false,
        carriage,
        dealJustPlayed: playedDealNum,
        dealWins,
        dealLosses,
        dealsRequired,
        lanternsBefore: lanterns,
        lanternsAfter: lanterns,
        lanternLost: false,
        lanternHealed: false,
        isRematchNext: false,
        hasReward: false,
        turns: duelState.turnNumber,
      };
      screen = RUN_SCREENS.STOP_RESULT;
      emit();
      return;
    }

    // The full carriage match has concluded!
    const lanternsBefore = lanterns;
    const finalDealWins = dealWins;
    const finalDealLosses = dealLosses;

    stopHistory = [
      ...stopHistory,
      {
        stopIndex,
        stopNumber: carriage.stopNumber,
        code: carriage.code,
        name: carriage.name,
        isFinalInspection: carriage.isFinalInspection,
        rematchAttempt: rematchCount,
        won: carriageWon,
        dealScore: `${finalDealWins}–${finalDealLosses}`,
        turns: duelState.turnNumber,
        playedPairs: duelState.playedPairsDiscarded,
        dealPairs: duelState.initialDealPairCount,
      },
    ];

    if (carriageWon) {
      runStats.carriagesWon += 1;
      consecutiveCarriageWins += 1;

      let lanternHealed = false;
      if (
        runBonuses.winStreakLanternHeal > 0 &&
        consecutiveCarriageWins > 0 &&
        consecutiveCarriageWins % runBonuses.winStreakLanternHeal === 0 &&
        lanterns < maxLanterns
      ) {
        lanterns = Math.min(maxLanterns, lanterns + 1);
        lanternHealed = true;
      }

      if (carriage.isFinalInspection) {
        lastStopSummary = {
          kind: "CARRIAGE_OVER",
          won: true,
          emergencyMatchSaved: false,
          carriage,
          dealWins: finalDealWins,
          dealLosses: finalDealLosses,
          dealsRequired,
          lanternsBefore,
          lanternsAfter: lanterns,
          lanternLost: false,
          lanternHealed,
          isRematchNext: false,
          hasReward: false,
          turns: duelState.turnNumber,
        };
        finalizeRun(RUN_OUTCOMES.VICTORY);
        return;
      }

      rewardRerollCount = 0;
      rewardRerollsLeft = runBonuses.rewardRerollsPerTray;
      rewardChoices = rollStampRewardOffer(runSeed, stopIndex, equippedStamps, 0);
      pendingReplaceStampId = null;
      lastStopSummary = {
        kind: "CARRIAGE_OVER",
        won: true,
        emergencyMatchSaved: false,
        carriage,
        dealWins: finalDealWins,
        dealLosses: finalDealLosses,
        dealsRequired,
        lanternsBefore,
        lanternsAfter: lanterns,
        lanternLost: false,
        lanternHealed,
        isRematchNext: false,
        hasReward: rewardChoices.length > 0,
        turns: duelState.turnNumber,
      };
      screen = RUN_SCREENS.STOP_RESULT;
      emit();
      return;
    }

    // Lost the carriage match: reset win streak, deduct 1 Lantern, receive NO reward.
    consecutiveCarriageWins = 0;
    lanterns = Math.max(0, lanterns - 1);

    if (lanterns === 0) {
      lastStopSummary = {
        kind: "CARRIAGE_OVER",
        won: false,
        emergencyMatchSaved: false,
        carriage,
        dealWins: finalDealWins,
        dealLosses: finalDealLosses,
        dealsRequired,
        lanternsBefore,
        lanternsAfter: 0,
        lanternLost: true,
        lanternHealed: false,
        isRematchNext: false,
        hasReward: false,
        turns: duelState.turnNumber,
      };
      finalizeRun(RUN_OUTCOMES.DEFEAT);
      return;
    }

    const isRematchNext = Boolean(carriage.isFinalInspection);
    if (isRematchNext) {
      rematchCount += 1;
    }

    rewardChoices = [];
    rewardRerollsLeft = 0;
    pendingReplaceStampId = null;
    lastStopSummary = {
      kind: "CARRIAGE_OVER",
      won: false,
      emergencyMatchSaved: false,
      carriage,
      dealWins: finalDealWins,
      dealLosses: finalDealLosses,
      dealsRequired,
      lanternsBefore,
      lanternsAfter: lanterns,
      lanternLost: true,
      lanternHealed: false,
      isRematchNext,
      hasReward: false,
      turns: duelState.turnNumber,
    };
    screen = RUN_SCREENS.STOP_RESULT;
    emit();
  }

  function continueAfterStop() {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    if (screen !== RUN_SCREENS.STOP_RESULT || !lastStopSummary) {
      return { ok: false, reason: "WRONG_SCREEN" };
    }

    // Mid-carriage deal transition: deal next hand immediately with refreshed Stamps/Tools!
    if (lastStopSummary.kind === "DEAL_CONTINUE") {
      launchCurrentDeal();
      return { ok: true, snapshot: getSnapshot() };
    }

    // Completed carriage with reward choices -> open Reward Tray.
    if (lastStopSummary.won && lastStopSummary.hasReward && rewardChoices.length > 0) {
      screen = RUN_SCREENS.REWARD;
      pendingReplaceStampId = null;
      emit();
      return { ok: true, snapshot: getSnapshot() };
    }

    // Early loss or Final Inspection rematch -> advance/keep stop and enter Briefing.
    if (!lastStopSummary.isRematchNext) {
      stopIndex = Math.min(TOTAL_STOPS - 1, stopIndex + 1);
    }
    resetStopMatchCounters();
    starterGiftStampId = null;
    duelState = null;
    activeSpotlight = null;
    screen = RUN_SCREENS.BRIEFING;
    emit();
    return { ok: true, snapshot: getSnapshot() };
  }

  function rerollRewardChoices() {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    if (screen !== RUN_SCREENS.REWARD && screen !== RUN_SCREENS.STARTER_DRAFT) {
      return { ok: false, reason: "WRONG_SCREEN" };
    }
    if (rewardRerollsLeft <= 0) {
      return { ok: false, reason: "NO_REROLLS_LEFT" };
    }
    const prev = rewardChoices.slice();
    rewardRerollCount += 1;
    rewardRerollsLeft -= 1;
    pendingReplaceStampId = null;
    const tag = screen === RUN_SCREENS.STARTER_DRAFT ? "starter" : stopIndex;
    rewardChoices = rollStampRewardOffer(
      runSeed,
      tag,
      equippedStamps,
      rewardRerollCount,
      prev
    );
    emit();
    return { ok: true, choices: rewardChoices.slice() };
  }

  function chooseRewardStamp(stampId, replaceSlotIndex = null) {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    if (screen === RUN_SCREENS.STARTER_DRAFT) {
      return chooseStarterStamp(stampId);
    }
    if (screen !== RUN_SCREENS.REWARD) {
      return { ok: false, reason: "WRONG_SCREEN" };
    }
    if (!rewardChoices.includes(stampId)) {
      return { ok: false, reason: "STAMP_NOT_OFFERED" };
    }
    if (equippedStamps.includes(stampId)) {
      return { ok: false, reason: "STAMP_ALREADY_OWNED" };
    }

    if (equippedStamps.length < MAX_STAMP_SLOTS) {
      equippedStamps = [...equippedStamps, stampId];
      return finishRewardAndAdvance();
    }

    if (replaceSlotIndex === null || replaceSlotIndex === undefined) {
      pendingReplaceStampId = stampId;
      emit();
      return { ok: true, needsReplaceSlot: true, pendingReplaceStampId };
    }

    if (
      !Number.isInteger(replaceSlotIndex) ||
      replaceSlotIndex < 0 ||
      replaceSlotIndex >= MAX_STAMP_SLOTS
    ) {
      return { ok: false, reason: "INVALID_REPLACE_SLOT" };
    }

    const updated = equippedStamps.slice();
    updated[replaceSlotIndex] = stampId;
    equippedStamps = updated;
    return finishRewardAndAdvance();
  }

  function cancelRewardReplacement() {
    if (disposed || screen !== RUN_SCREENS.REWARD) {
      return { ok: false, reason: "WRONG_SCREEN" };
    }
    pendingReplaceStampId = null;
    emit();
    return { ok: true };
  }

  function skipReward() {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    if (screen === RUN_SCREENS.STARTER_DRAFT) {
      return skipStarterDraft();
    }
    if (screen !== RUN_SCREENS.REWARD) {
      return { ok: false, reason: "WRONG_SCREEN" };
    }
    return finishRewardAndAdvance();
  }

  function finishRewardAndAdvance() {
    rewardChoices = [];
    rewardRerollsLeft = 0;
    pendingReplaceStampId = null;
    starterGiftStampId = null;
    stopIndex = Math.min(TOTAL_STOPS - 1, stopIndex + 1);
    resetStopMatchCounters();
    duelState = null;
    activeSpotlight = null;
    screen = RUN_SCREENS.BRIEFING;
    emit();
    return { ok: true, snapshot: getSnapshot() };
  }

  // -------------------------
  // Live Deal Flow, Inspector AI & Player Actions
  // -------------------------

  function advanceDuelFlow(hadDrawResolution = false) {
    if (!duelState || screen !== RUN_SCREENS.DUEL) return;

    syncRunStateFromDuel(duelState);
    if (hadDrawResolution && !opponentOverride) {
      inspectorAgent.observe(createObserverView(duelState, SIDES.INSPECTOR));
    }

    const timings = getTimings();

    if (hadDrawResolution && duelState.lastResolution) {
      const pView = createObserverView(duelState, SIDES.PLAYER);
      activeSpotlight = buildSpotlight(pView.lastResolution);
      lastSwappedSlots = [];
      targetingStampId = null;
      targetingEdgeCheck = false;

      if (
        pView.lastResolution.drewUnlisted &&
        pView.lastResolution.drawer === SIDES.PLAYER &&
        pView.phase === PHASES.OFFER &&
        pView.offerer === SIDES.PLAYER
      ) {
        newlyDrawnUnlistedSlot = pView.myHandCount - 1;
      } else {
        newlyDrawnUnlistedSlot = null;
      }

      if (timings.revealHoldMs > 0) {
        inputLocked = true;
        statusStage = "REVEAL_BEAT";
        emit();
        scheduleStep(() => {
          if (!duelState || screen !== RUN_SCREENS.DUEL) return;
          if (duelState.phase === PHASES.OVER) {
            resolveCompletedDuel();
            return;
          }
          maybeScheduleInspector();
        }, timings.revealHoldMs);
        return;
      }
    }

    if (duelState.phase === PHASES.OVER) {
      resolveCompletedDuel();
      return;
    }

    maybeScheduleInspector();
  }

  function maybeScheduleInspector() {
    if (!duelState || screen !== RUN_SCREENS.DUEL) return;
    if (duelState.phase === PHASES.OVER) {
      resolveCompletedDuel();
      return;
    }

    const active = getActiveActor(duelState);
    if (active !== SIDES.INSPECTOR) {
      inputLocked = false;
      statusStage = "IDLE";
      emit();
      return;
    }

    inputLocked = true;
    statusStage = "INSPECTOR_THINKING";
    emit();

    const timings = getTimings();
    let delay =
      duelState.phase === PHASES.OFFER ? timings.inspectorOfferMs : timings.inspectorDrawMs;
    const offeredCount = duelState.hands[duelState.offerer].length;
    if (inspectorAgent.getTier() >= 3 && offeredCount <= 3 && duelState.phase === PHASES.DRAW) {
      delay += timings.endgameExtraPauseMs;
    }

    scheduleStep(() => {
      executeInspectorStep();
    }, delay);
  }

  function executeInspectorStep() {
    if (!duelState || screen !== RUN_SCREENS.DUEL || duelState.phase === PHASES.OVER) {
      return;
    }

    const inspView = createObserverView(duelState, SIDES.INSPECTOR);
    if (!inspView.legal.isMyTurn) {
      inputLocked = false;
      statusStage = "IDLE";
      emit();
      return;
    }

    const action = opponentOverride
      ? opponentOverride(inspView, aiRng)
      : inspectorAgent.act(inspView, aiRng);

    if (!action) {
      inputLocked = false;
      statusStage = "IDLE";
      emit();
      return;
    }

    const wasDraw = action.type === ACTION_TYPES.DRAW;
    const res = applyAction(duelState, action);
    if (!res.ok) {
      if (inspView.phase === PHASES.OFFER && inspView.legal.canCommit) {
        const fb = applyAction(duelState, {
          type: ACTION_TYPES.COMMIT_OFFER,
          actor: SIDES.INSPECTOR,
          seq: inspView.legal.nextSeq,
        });
        if (fb.ok) duelState = fb.state;
      } else if (inspView.phase === PHASES.DRAW && inspView.legal.legalDrawSlots.length > 0) {
        const fb = applyAction(duelState, {
          type: ACTION_TYPES.DRAW,
          actor: SIDES.INSPECTOR,
          slotIndex: inspView.legal.legalDrawSlots[0],
          seq: inspView.legal.nextSeq,
        });
        if (fb.ok) duelState = fb.state;
      }
      advanceDuelFlow(wasDraw);
      return;
    }

    duelState = res.state;

    if (action.type === ACTION_TYPES.USE_STAMP) {
      lastNotice = describeInspectorStampPlay(action, duelState);
      const timings = getTimings();
      if (timings.inspectorStampMs > 0) {
        emit();
      }
      scheduleStep(() => {
        executeInspectorStep();
      }, timings.inspectorStampMs);
      return;
    }

    if (action.type === ACTION_TYPES.SWAP) {
      const commitDelay = isImmediate ? 0 : isReducedMotion ? 45 : 120;
      scheduleStep(() => {
        executeInspectorStep();
      }, commitDelay);
      return;
    }

    if (action.type === ACTION_TYPES.COMMIT_OFFER) {
      // Preserve Brass Weight warning if he weighted a card on this very offer!
      const weightedThisOffer = duelState.lockedSlots.some(
        (l) => l.reason === "BRASS_WEIGHT"
      );
      if (!weightedThisOffer) {
        lastNotice = "The Inspector squares his tickets and commits the fan.";
      }
    }

    advanceDuelFlow(wasDraw);
  }

  /**
   * Activate The Perforation Gauge (Keystone Special Item): immediately flags 1 safe slot.
   */
  function activateGauge() {
    if (disposed || screen !== RUN_SCREENS.DUEL || !duelState) {
      return { ok: false, reason: "WRONG_SCREEN" };
    }
    if (inputLocked) return { ok: false, reason: "INPUT_LOCKED" };

    const res = applyAction(duelState, {
      type: ACTION_TYPES.USE_GAUGE,
      actor: SIDES.PLAYER,
      seq: duelState.nextSeq,
    });
    if (!res.ok) return res;

    duelState = res.state;
    targetingStampId = null;
    targetingEdgeCheck = false;
    lastNotice = duelState.lastStampFeedback?.message || "Perforation Gauge marked a safe slot!";
    emit();
    return { ok: true };
  }

  /**
   * Activate Check Edge (Thumb-Worn Tallow): toggles slot targeting (or checks explicit slot).
   */
  function activateCheckEdge(explicitSlot = null) {
    if (disposed || screen !== RUN_SCREENS.DUEL || !duelState) {
      return { ok: false, reason: "WRONG_SCREEN" };
    }
    if (inputLocked) return { ok: false, reason: "INPUT_LOCKED" };

    if (targetingEdgeCheck && explicitSlot === null) {
      targetingEdgeCheck = false;
      lastNotice = "Check Edge canceled.";
      emit();
      return { ok: true, canceled: true };
    }

    const view = createObserverView(duelState, SIDES.PLAYER);
    if (!view.legal.canCheckEdge) {
      return { ok: false, reason: "TOOL_UNAVAILABLE" };
    }

    if (explicitSlot === null) {
      targetingEdgeCheck = true;
      targetingStampId = null;
      selectedSwapSlot = null;
      lastNotice =
        "Check Edge: click a glowing face-down slot to test if it is ★ Emblem Stock (100% safe) or Plain/Blank.";
      emit();
      return { ok: true, targeting: true, validTargets: view.legal.edgeCheckTargets.slice() };
    }

    const res = applyAction(duelState, {
      type: ACTION_TYPES.CHECK_EDGE,
      actor: SIDES.PLAYER,
      slotIndex: explicitSlot,
      seq: duelState.nextSeq,
    });
    if (!res.ok) return res;

    duelState = res.state;
    targetingEdgeCheck = false;
    targetingStampId = null;
    lastNotice = duelState.lastStampFeedback?.message || "Checked ticket edge.";
    emit();
    return { ok: true };
  }

  function activateStamp(stampId, explicitTargetSlot = null) {
    if (disposed) return { ok: false, reason: "DISPOSED" };

    if (screen === RUN_SCREENS.TUTORIAL) {
      const res = tutorial.handleActivateStamp(stampId);
      emit();
      return res;
    }

    if (screen !== RUN_SCREENS.DUEL || !duelState) {
      return { ok: false, reason: "WRONG_SCREEN" };
    }
    if (inputLocked) return { ok: false, reason: "INPUT_LOCKED" };

    if (targetingStampId === stampId && explicitTargetSlot === null) {
      targetingStampId = null;
      lastNotice = "Stamp selection canceled.";
      emit();
      return { ok: true, canceled: true };
    }

    const view = createObserverView(duelState, SIDES.PLAYER);
    const status = view.legal.stampStatuses.find((s) => s.id === stampId);
    if (!status || !status.canUse) {
      return {
        ok: false,
        reason: "STAMP_UNAVAILABLE",
        message: status ? status.statusText : "Stamp not equipped.",
      };
    }

    targetingEdgeCheck = false;

    if (status.needsTarget && explicitTargetSlot === null) {
      targetingStampId = stampId;
      selectedSwapSlot = null;
      if (status.targetType === "OPPONENT_SLOT") {
        lastNotice = `${status.name}: click a glowing face-down Inspector ticket to peek at it (or press Esc to cancel).`;
      } else if (status.targetType === "OPPONENT_ADJACENT") {
        lastNotice = `${status.name}: click a glowing Inspector slot to check it + its right neighbor for The Unlisted.`;
      } else if (status.targetType === "OWN_ORDINARY_SLOT") {
        lastNotice = `${status.name}: click one of your glowing normal tickets to lock it against being drawn this turn.`;
      }
      emit();
      return { ok: true, targeting: true, stampId, validTargets: status.validTargets };
    }

    const action = {
      type: ACTION_TYPES.USE_STAMP,
      actor: SIDES.PLAYER,
      stampId,
      seq: duelState.nextSeq,
    };
    if (status.needsTarget) {
      action.targetSlot = explicitTargetSlot;
    }

    const res = applyAction(duelState, action);
    if (!res.ok) return res;

    duelState = res.state;
    targetingStampId = null;
    selectedSwapSlot = null;
    syncRunStateFromDuel(duelState);
    lastNotice = duelState.lastStampFeedback?.message || `Used ${status.name}.`;
    emit();
    return { ok: true, stampId };
  }

  function cancelStampTargeting() {
    if (screen === RUN_SCREENS.TUTORIAL) {
      const tutSnap = tutorial.getSnapshot();
      if (tutSnap.targetingStampId) {
        tutorial.handleActivateStamp(tutSnap.targetingStampId);
        emit();
      }
      return { ok: true };
    }
    if (targetingStampId !== null || targetingEdgeCheck) {
      targetingStampId = null;
      targetingEdgeCheck = false;
      lastNotice = "Targeting canceled.";
      emit();
    }
    return { ok: true };
  }

  function selectOfferSlot(slotIndex) {
    if (disposed) return { ok: false, reason: "DISPOSED" };

    if (screen === RUN_SCREENS.TUTORIAL) {
      const res = tutorial.handleSelectOfferSlot(slotIndex);
      emit();
      return res;
    }

    if (screen !== RUN_SCREENS.DUEL || !duelState) {
      return { ok: false, reason: "WRONG_SCREEN" };
    }
    if (inputLocked) return { ok: false, reason: "INPUT_LOCKED" };

    if (targetingStampId !== null) {
      const def = getStampDef(targetingStampId);
      if (def && def.targetType === "OWN_ORDINARY_SLOT") {
        return activateStamp(targetingStampId, slotIndex);
      }
      targetingStampId = null;
    }
    targetingEdgeCheck = false;

    if (duelState.phase !== PHASES.OFFER || duelState.offerer !== SIDES.PLAYER) {
      return { ok: false, reason: "WRONG_PHASE_OR_ACTOR" };
    }

    const view = createObserverView(duelState, SIDES.PLAYER);
    if (!view.legal.canSwap) return { ok: false, reason: "NO_SWAPS_REMAINING" };
    if (!view.legal.legalSwapSlots.includes(slotIndex)) {
      return { ok: false, reason: "SLOT_NOT_SWAPPABLE" };
    }

    if (selectedSwapSlot === null) {
      selectedSwapSlot = slotIndex;
      lastNotice = `Selected slot #${slotIndex + 1}. Click another unlocked ticket to swap privately.`;
      emit();
      return { ok: true, staged: true, selectedSwapSlot };
    }

    if (selectedSwapSlot === slotIndex) {
      selectedSwapSlot = null;
      lastNotice = "Swap selection cleared.";
      emit();
      return { ok: true, staged: false, selectedSwapSlot: null };
    }

    const indexA = selectedSwapSlot;
    const indexB = slotIndex;
    const res = applyAction(duelState, {
      type: ACTION_TYPES.SWAP,
      actor: SIDES.PLAYER,
      indexA,
      indexB,
      seq: view.legal.nextSeq,
    });
    if (!res.ok) return res;

    duelState = res.state;
    selectedSwapSlot = null;
    lastSwappedSlots = [indexA, indexB];
    newlyDrawnUnlistedSlot = null;
    const rem = duelState.swapsRemaining;
    lastNotice =
      rem > 0
        ? `Privately swapped #${indexA + 1} and #${indexB + 1}. (${rem} more swap left, or press Commit Fan.)`
        : `Privately swapped #${indexA + 1} and #${indexB + 1}. Press Commit Fan so the Inspector draws.`;
    emit();
    return { ok: true, swapped: [indexA, indexB] };
  }

  function commitOffer() {
    if (disposed) return { ok: false, reason: "DISPOSED" };

    if (screen === RUN_SCREENS.TUTORIAL) {
      const res = tutorial.handleCommitOffer();
      emit();
      return res;
    }

    if (screen !== RUN_SCREENS.DUEL || !duelState) {
      return { ok: false, reason: "WRONG_SCREEN" };
    }
    if (inputLocked) return { ok: false, reason: "INPUT_LOCKED" };

    const res = applyAction(duelState, {
      type: ACTION_TYPES.COMMIT_OFFER,
      actor: SIDES.PLAYER,
      seq: duelState.nextSeq,
    });
    if (!res.ok) return res;

    duelState = res.state;
    selectedSwapSlot = null;
    targetingStampId = null;
    targetingEdgeCheck = false;
    lastSwappedSlots = [];
    newlyDrawnUnlistedSlot = null;
    lastNotice = "You commit your fan across the table.";
    advanceDuelFlow(false);
    return { ok: true };
  }

  function drawSlot(slotIndex) {
    if (disposed) return { ok: false, reason: "DISPOSED" };

    if (screen === RUN_SCREENS.TUTORIAL) {
      const res = tutorial.handleDrawSlot(slotIndex);
      emit();
      return res;
    }

    if (screen !== RUN_SCREENS.DUEL || !duelState) {
      return { ok: false, reason: "WRONG_SCREEN" };
    }
    if (inputLocked) return { ok: false, reason: "INPUT_LOCKED" };

    if (targetingEdgeCheck) {
      return activateCheckEdge(slotIndex);
    }

    if (targetingStampId !== null) {
      const def = getStampDef(targetingStampId);
      if (
        def &&
        (def.targetType === "OPPONENT_SLOT" || def.targetType === "OPPONENT_ADJACENT")
      ) {
        return activateStamp(targetingStampId, slotIndex);
      }
      targetingStampId = null;
    }

    const res = applyAction(duelState, {
      type: ACTION_TYPES.DRAW,
      actor: SIDES.PLAYER,
      slotIndex,
      seq: duelState.nextSeq,
    });
    if (!res.ok) return res;

    inputLocked = true;
    selectedSwapSlot = null;
    targetingStampId = null;
    targetingEdgeCheck = false;
    duelState = res.state;
    lastNotice = null;
    advanceDuelFlow(true);
    return { ok: true };
  }

  // -------------------------
  // Settings, Dev Trace & Snapshots
  // -------------------------

  function setReducedMotion(flag) {
    isReducedMotion = Boolean(flag);
    emit();
  }

  function toggleDevTrace() {
    isDevTraceOpen = !isDevTraceOpen;
    emit();
    return isDevTraceOpen;
  }

  function buildSanitizedDevTrace(view) {
    const mem = inspectorAgent.getMemory();
    const tierCfg = getTierConfig(inspectorAgent.getTier());
    const bucketProbs = mem.getDrawBucketProbs({
      fastBlend: tierCfg.fastRecencyBlend,
      transitionBlend: tierCfg.transitionBlend,
    });
    const pattern = mem.getDetectedPattern();

    const liveOfferId =
      view && view.phase === PHASES.DRAW && view.offerer === SIDES.INSPECTOR
        ? view.offerId
        : null;

    const entries = mem
      .getTraceLog()
      .slice(-16)
      .reverse()
      .map((entry) => {
        if (liveOfferId !== null && entry.offerId === liveOfferId && entry.role === "OFFERER") {
          return {
            ...entry,
            reason: String(entry.reason || "").replace(/slot #\d+/gi, "slot #[live]"),
            candidates: Array.isArray(entry.candidates)
              ? entry.candidates.map((c) => ({
                  bucket: c.bucket,
                  prob: c.prob,
                  note: c.note,
                }))
              : [],
          };
        }
        return entry;
      });

    return {
      tier: tierCfg.tier,
      tierName: tierCfg.name,
      tierSummary: tierCfg.summary,
      observations: pattern.observations,
      bucketProbs,
      pattern,
      entries,
    };
  }

  function buildBriefingSnapshot() {
    const carriage = getCarriageDef(stopIndex);
    const dealsRequired = getDealsRequiredForStop(carriage);
    const condId = conditionSchedule[stopIndex];
    const condition = condId ? getConditionDef(condId) : CLEAR_LINE_CONDITION;
    const startingOfferer = getStartingOfferer(encounterCounter);
    const tierCfg = getTierConfig(carriage.aiTier);
    const inspLoadout = opponentOverride
      ? { activeIds: [], jammedIds: [] }
      : resolveInspectorLoadout(carriage, runBonuses.inspectorStampJams);

    return {
      carriage,
      dealsRequired,
      condition,
      startingOfferer,
      playerDrawsFirst: startingOfferer === SIDES.INSPECTOR,
      rematchCount,
      tier: tierCfg.tier,
      tierName: tierCfg.name,
      tierSummary: tierCfg.summary,
      inspectorActiveStamps: inspLoadout.activeIds.map((id) => getStampDef(id)),
      inspectorJammedStamps: inspLoadout.jammedIds.map((id) => getStampDef(id)),
      starterGiftStamp: starterGiftStampId ? getStampDef(starterGiftStampId) : null,
    };
  }

  function getSnapshot() {
    const carriage = getCarriageDef(stopIndex);
    const dealsRequired = getDealsRequiredForStop(carriage);
    const metaSnap = meta.getSnapshot();
    const isTutorial = screen === RUN_SCREENS.TUTORIAL;
    const tutSnap = isTutorial ? tutorial.getSnapshot() : null;
    const view = isTutorial
      ? tutSnap.view
      : duelState
        ? createObserverView(duelState, SIDES.PLAYER)
        : null;

    const tierInfo = isTutorial ? getTierConfig(1) : getTierConfig(carriage.aiTier);
    const pattern = inspectorAgent.getMemory().getDetectedPattern();
    const inspectorTell =
      !isTutorial && tierInfo.tier >= 3 && pattern.detected
        ? `Reading your habit: ${pattern.label}`
        : null;

    const activeTargetingStampId = isTutorial ? tutSnap.targetingStampId : targetingStampId;
    let activeStampTargeting = null;
    if (!isTutorial && targetingEdgeCheck && view) {
      activeStampTargeting = {
        stampId: "CHECK_EDGE",
        name: "Check Edge",
        targetType: "EDGE_CHECK",
        validTargets: view.legal.edgeCheckTargets.slice(),
        loupePairs: [],
      };
    } else if (activeTargetingStampId && view) {
      const st = view.legal.stampStatuses.find((s) => s.id === activeTargetingStampId);
      if (st) {
        activeStampTargeting = {
          stampId: st.id,
          name: st.name,
          targetType: st.targetType,
          validTargets: st.validTargets.slice(),
          loupePairs: st.loupePairs.map((p) => p.slice()),
        };
      }
    }

    const isRewardLike =
      screen === RUN_SCREENS.REWARD || screen === RUN_SCREENS.STARTER_DRAFT;

    return {
      screen,
      runSeed,
      hasCompletedTutorial: metaSnap.tutorialSeen,
      meta: metaSnap,
      lockerNotice,
      lockerReturnScreen,
      runBonuses,
      emergencyMatchesLeft,
      consecutiveCarriageWins,
      reducedMotion: isReducedMotion,
      devTraceOpen: isDevTraceOpen,
      devTrace: isDevTraceOpen ? buildSanitizedDevTrace(view) : null,

      // Run & Carriage match progression
      stopIndex,
      stopNumber: carriage.stopNumber,
      totalStops: TOTAL_STOPS,
      carriage,
      carriages: CARRIAGES,
      dealWins,
      dealLosses,
      dealNumberInStop,
      dealsRequired,
      conditionSchedule: conditionSchedule.slice(),
      lanterns: isTutorial ? 3 : lanterns,
      maxLanterns,
      equippedStamps: isTutorial
        ? view.myStamps.map((s) => getStampDef(s.id))
        : equippedStamps.map((id) => getStampDef(id)),
      inspectorJammedStamps: isTutorial
        ? []
        : currentInspectorLoadout.jammedIds.map((id) => getStampDef(id)),
      maxStampSlots: MAX_STAMP_SLOTS,
      encounterCounter,
      rematchCount,
      stopHistory: stopHistory.slice(),
      runStats: { ...runStats },

      // Screen-specific payloads
      briefing: screen === RUN_SCREENS.BRIEFING ? buildBriefingSnapshot() : null,
      tutorial: tutSnap ? tutSnap.step : null,
      lastStopSummary,
      reward: isRewardLike
        ? {
            isStarterDraft: screen === RUN_SCREENS.STARTER_DRAFT,
            choices: rewardChoices.map((id) => getStampDef(id)),
            slotsFull: equippedStamps.length >= MAX_STAMP_SLOTS,
            rerollsLeft: rewardRerollsLeft,
            pendingReplaceStamp: pendingReplaceStampId
              ? getStampDef(pendingReplaceStampId)
              : null,
          }
        : null,
      runOutcome,
      lastRunPayout,

      // Active table state (DUEL or TUTORIAL)
      activeTier: tierInfo.tier,
      activeTierName: tierInfo.name,
      inspectorTell,
      inputLocked: isTutorial ? false : inputLocked,
      statusStage: isTutorial ? "IDLE" : statusStage,
      selectedSwapSlot: isTutorial ? tutSnap.selectedSwapSlot : selectedSwapSlot,
      lastSwappedSlots: isTutorial ? tutSnap.lastSwappedSlots : lastSwappedSlots.slice(),
      newlyDrawnUnlistedSlot: isTutorial
        ? tutSnap.newlyDrawnUnlistedSlot
        : newlyDrawnUnlistedSlot,
      activeStampTargeting,
      activeSpotlight: isTutorial
        ? tutSnap.view.lastResolution
          ? buildSpotlight(tutSnap.view.lastResolution)
          : null
        : activeSpotlight,
      lastNotice: isTutorial ? tutSnap.view.myStampFeedback : lastNotice,
      view,
      pendingTimerCount: pendingTimers.size,
    };
  }

  function getActiveDuelReplay() {
    return duelState ? exportReplay(duelState) : null;
  }

  // Dialogue may consume only this aggregate of legally observed player draws.
  function getInspectorHabitSummary() {
    const mem = inspectorAgent.getMemory();
    return { totalObservations: mem.getDetectedPattern().observations, drawBucketProbs: mem.getDrawBucketProbs() };
  }

  function getInspectorMemorySnapshot() {
    const mem = inspectorAgent.getMemory();
    return {
      totalObservations: mem.getDetectedPattern().observations,
      drawBucketProbs: mem.getDrawBucketProbs(),
      raw: mem.snapshot(),
    };
  }

  function subscribe(listener) {
    subscribers.add(listener);
    listener(getSnapshot());
    return () => {
      subscribers.delete(listener);
    };
  }

  function dispose() {
    disposed = true;
    bumpGenerationAndClearTimers();
    subscribers.clear();
  }

  return Object.freeze({
    openTitle,
    openLocker,
    closeLocker,
    buyKeepsake,
    toggleKeepsake,
    resetLockerProgress,
    setSeed,
    startRun,
    chooseStarterStamp,
    skipStarterDraft,
    startTutorial,
    tutorialAcknowledge,
    skipTutorial,
    completeTutorialAndStartRun,
    restartRun,
    startFreshRandomRun,
    beginStopDuel,
    continueAfterStop,
    rerollRewardChoices,
    chooseRewardStamp,
    cancelRewardReplacement,
    skipReward,
    activateGauge,
    activateCheckEdge,
    activateStamp,
    cancelStampTargeting,
    selectOfferSlot,
    commitOffer,
    drawSlot,
    setReducedMotion,
    toggleDevTrace,
    getSnapshot,
    getActiveDuelReplay,
    getInspectorMemorySnapshot,
    getInspectorHabitSummary,
    getMetaStore: () => meta,
    subscribe,
    dispose,
  });
}
