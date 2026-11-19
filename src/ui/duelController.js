/**
 * src/ui/duelController.js
 * Playable duel session controller bridging the pure rules engine, the
 * ObserverView boundary, the strategic Inspector AI (Tiers 1–5), and UI views.
 *
 * Responsibilities:
 * - Enforces UI input locking during draw-reveal beats and Inspector pauses.
 * - Tracks and cancels all scheduled timers on restart / new run / dispose.
 * - Keeps shuffle and AI random streams strictly isolated.
 * - Preserves Inspector learning across consecutive encounters in the same run,
 *   resets learning completely on a new run, and snapshots memory at duel start
 *   so replaying a duel is 100% deterministic.
 * - Exposes an optional developer-only decision trace (off by default).
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
} from "../core/engine.js";
import { createObserverView } from "../core/observer.js";
import { createDuelStreams, normalizeSeed } from "../core/rng.js";
import { DEFAULT_PAIRS, MAX_PAIRS, MIN_PAIRS, getTicketMeta } from "../data/tickets.js";
import { MAX_AI_TIER, MIN_AI_TIER, getTierConfig } from "../data/aiTuning.js";
import { createInspectorAgent } from "../ai/inspector.js";

export const STARTING_MODES = Object.freeze({
  ALTERNATE: "ALTERNATE",
  PLAYER_DRAWS_FIRST: "PLAYER_DRAWS_FIRST",
  PLAYER_OFFERS_FIRST: "PLAYER_OFFERS_FIRST",
});

export const TIER_MODES = Object.freeze({
  RAMP: "RAMP", // Escalates Tier 1 -> 2 -> 3 -> 4 -> 5 across consecutive encounters
  TIER_1: "1",
  TIER_2: "2",
  TIER_3: "3",
  TIER_4: "4",
  TIER_5: "5",
});

const DEFAULT_TIMINGS = Object.freeze({
  inspectorOfferMs: 340,
  inspectorDrawMs: 500,
  endgameExtraPauseMs: 150,
  revealHoldMs: 680,
});

const REDUCED_TIMINGS = Object.freeze({
  inspectorOfferMs: 110,
  inspectorDrawMs: 140,
  endgameExtraPauseMs: 0,
  revealHoldMs: 200,
});

const IMMEDIATE_TIMINGS = Object.freeze({
  inspectorOfferMs: 0,
  inspectorDrawMs: 0,
  endgameExtraPauseMs: 0,
  revealHoldMs: 0,
});

export function createDuelController({
  initialSeed = "LINE-1926",
  initialPairCount = DEFAULT_PAIRS,
  initialStartingMode = STARTING_MODES.ALTERNATE,
  initialTierMode = TIER_MODES.RAMP,
  reducedMotion = false,
  devTraceOpen = false,
  immediate = false,
  opponentFn = null, // Optional custom bot override for scripted tests
  scheduler = null,
} = {}) {
  const scheduleImpl = scheduler?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelImpl = scheduler?.clearTimeout ?? ((id) => clearTimeout(id));

  const pendingTimers = new Set();
  const subscribers = new Set();
  const inspectorAgent = createInspectorAgent({ tier: 1 });

  let sessionGeneration = 0;
  let disposed = false;

  let rootSeed = normalizeSeed(initialSeed);
  let pairCount = clampPairs(initialPairCount);
  let startingMode = initialStartingMode;
  let tierMode = normalizeTierMode(initialTierMode);
  let encounterIndex = 0;
  let isReducedMotion = Boolean(reducedMotion);
  let isDevTraceOpen = Boolean(devTraceOpen);
  let isImmediate = Boolean(immediate);

  let aiRng = null;
  let duelStartMemorySnap = null;
  let duelState = null;
  let selectedSwapSlot = null;
  let lastSwappedSlots = [];
  let newlyDrawnUnlistedSlot = null;
  let pendingDrawSlot = null;
  let inputLocked = false;
  let statusStage = "IDLE"; // "IDLE" | "INSPECTOR_THINKING" | "REVEAL_BEAT"
  let activeSpotlight = null;
  let lastNotice = null;

  function clampPairs(n) {
    const parsed = Number.parseInt(n, 10);
    if (!Number.isInteger(parsed)) return DEFAULT_PAIRS;
    return Math.min(MAX_PAIRS, Math.max(MIN_PAIRS, parsed));
  }

  function normalizeTierMode(mode) {
    const str = String(mode ?? TIER_MODES.RAMP).toUpperCase();
    if (str === TIER_MODES.RAMP) return TIER_MODES.RAMP;
    const n = Number.parseInt(str, 10);
    if (Number.isInteger(n) && n >= MIN_AI_TIER && n <= MAX_AI_TIER) {
      return String(n);
    }
    return TIER_MODES.RAMP;
  }

  function resolveActiveTier(mode, encIdx) {
    if (mode === TIER_MODES.RAMP) {
      return Math.min(MAX_AI_TIER, MIN_AI_TIER + encIdx);
    }
    return Math.min(MAX_AI_TIER, Math.max(MIN_AI_TIER, Number.parseInt(mode, 10) || 1));
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

  function scheduleStep(fn, delayMs) {
    if (disposed) return;
    const expectedGen = sessionGeneration;
    if (delayMs <= 0 && isImmediate) {
      fn();
      return;
    }
    const id = scheduleImpl(() => {
      pendingTimers.delete(id);
      if (disposed || sessionGeneration !== expectedGen) {
        return;
      }
      fn();
    }, Math.max(0, delayMs));
    pendingTimers.add(id);
  }

  function resolveStartingOfferer(mode, encIdx) {
    if (mode === STARTING_MODES.PLAYER_DRAWS_FIRST) {
      return SIDES.INSPECTOR;
    }
    if (mode === STARTING_MODES.PLAYER_OFFERS_FIRST) {
      return SIDES.PLAYER;
    }
    return getStartingOfferer(encIdx, SIDES.PLAYER);
  }

  function buildSpotlightFromResolution(res) {
    if (!res) return null;
    const drawerLabel = res.drawer === SIDES.PLAYER ? "You" : "The Inspector";
    const offererLabel = res.offerer === SIDES.PLAYER ? "your fan" : "the Inspector's fan";
    const slotHuman = res.slotIndex + 1;

    if (res.drewUnlisted) {
      const meta = getTicketMeta("UNLISTED");
      return {
        kind: "UNLISTED",
        drawer: res.drawer,
        offerer: res.offerer,
        slotIndex: res.slotIndex,
        offererHandSizeBefore: res.offererHandSizeBefore,
        ticketMeta: meta,
        streak: res.unlistedStreakAfter,
        headline:
          res.drawer === SIDES.PLAYER
            ? "You drew The Unlisted."
            : "The Inspector took The Unlisted.",
        detail: `${drawerLabel} pulled slot #${slotHuman} of ${res.offererHandSizeBefore} from ${offererLabel} — blank stock, one black punch. No pair discarded.`,
      };
    }

    const meta = getTicketMeta(res.matchedSymbolId);
    return {
      kind: "PAIR",
      drawer: res.drawer,
      offerer: res.offerer,
      slotIndex: res.slotIndex,
      offererHandSizeBefore: res.offererHandSizeBefore,
      ticketMeta: meta,
      wasFinalCall: res.wasFinalCall,
      headline: `Matched pair: ${meta.name}`,
      detail: `${drawerLabel} drew slot #${slotHuman} of ${res.offererHandSizeBefore} from ${offererLabel} and paired both ${meta.name} tickets.`,
    };
  }

  function emit() {
    if (disposed) return;
    const snapshot = getSnapshot();
    for (const fn of subscribers) {
      fn(snapshot);
    }
  }

  function advanceFlowAfterStateChange(hadDrawResolution = false) {
    if (!duelState) return;

    // Allow Inspector to legally observe resolved public draw events right away
    // so the live habit readout & memory stay current across turns and duel endings.
    if (hadDrawResolution && !opponentFn) {
      inspectorAgent.observe(createObserverView(duelState, SIDES.INSPECTOR));
    }

    const timings = getTimings();

    if (hadDrawResolution && duelState.lastResolution) {
      const playerView = createObserverView(duelState, SIDES.PLAYER);
      activeSpotlight = buildSpotlightFromResolution(playerView.lastResolution);
      lastSwappedSlots = [];

      if (
        playerView.lastResolution.drewUnlisted &&
        playerView.lastResolution.drawer === SIDES.PLAYER &&
        playerView.phase === PHASES.OFFER &&
        playerView.offerer === SIDES.PLAYER
      ) {
        newlyDrawnUnlistedSlot = playerView.myHandCount - 1;
      } else {
        newlyDrawnUnlistedSlot = null;
      }

      if (timings.revealHoldMs > 0) {
        inputLocked = true;
        statusStage = "REVEAL_BEAT";
        emit();
        scheduleStep(() => {
          pendingDrawSlot = null;
          if (duelState.phase === PHASES.OVER) {
            inputLocked = false;
            statusStage = "IDLE";
            emit();
            return;
          }
          maybeScheduleInspector();
        }, timings.revealHoldMs);
        return;
      }
      pendingDrawSlot = null;
    }

    if (duelState.phase === PHASES.OVER) {
      inputLocked = false;
      statusStage = "IDLE";
      emit();
      return;
    }

    maybeScheduleInspector();
  }

  function maybeScheduleInspector() {
    if (!duelState || duelState.phase === PHASES.OVER) {
      inputLocked = false;
      statusStage = "IDLE";
      emit();
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

    // Subtle tabletop tension pause on Tiers 3–5 when fans shrink to <= 3 cards.
    const offeredCount = duelState.hands[duelState.offerer].length;
    if (inspectorAgent.getTier() >= 3 && offeredCount <= 3 && duelState.phase === PHASES.DRAW) {
      delay += timings.endgameExtraPauseMs;
    }

    scheduleStep(() => {
      executeInspectorStep();
    }, delay);
  }

  function executeInspectorStep() {
    if (!duelState || duelState.phase === PHASES.OVER) {
      inputLocked = false;
      statusStage = "IDLE";
      emit();
      return;
    }

    // Strict legal boundary: Inspector receives ONLY ObserverView + separate aiRng.
    const inspectorView = createObserverView(duelState, SIDES.INSPECTOR);
    if (!inspectorView.legal.isMyTurn) {
      inputLocked = false;
      statusStage = "IDLE";
      emit();
      return;
    }

    const chosen = opponentFn
      ? opponentFn(inspectorView, aiRng)
      : inspectorAgent.act(inspectorView, aiRng);

    if (!chosen) {
      inputLocked = false;
      statusStage = "IDLE";
      emit();
      return;
    }

    const wasDraw = chosen.type === ACTION_TYPES.DRAW;
    const res = applyAction(duelState, chosen);
    if (!res.ok) {
      if (inspectorView.phase === PHASES.OFFER && inspectorView.legal.canCommit) {
        const fb = applyAction(duelState, {
          type: ACTION_TYPES.COMMIT_OFFER,
          actor: SIDES.INSPECTOR,
          seq: inspectorView.legal.nextSeq,
        });
        if (fb.ok) duelState = fb.state;
      } else if (
        inspectorView.phase === PHASES.DRAW &&
        inspectorView.legal.legalDrawSlots.length > 0
      ) {
        const fb = applyAction(duelState, {
          type: ACTION_TYPES.DRAW,
          actor: SIDES.INSPECTOR,
          slotIndex: inspectorView.legal.legalDrawSlots[0],
          seq: inspectorView.legal.nextSeq,
        });
        if (fb.ok) duelState = fb.state;
      }
      advanceFlowAfterStateChange(wasDraw);
      return;
    }

    duelState = res.state;

    if (chosen.type === ACTION_TYPES.SWAP) {
      const commitDelay = isImmediate ? 0 : isReducedMotion ? 50 : 130;
      scheduleStep(() => {
        executeInspectorStep();
      }, commitDelay);
      return;
    }

    if (chosen.type === ACTION_TYPES.COMMIT_OFFER) {
      lastNotice = "The Inspector squares his tickets and offers the fan.";
    }

    advanceFlowAfterStateChange(wasDraw);
  }

  /**
   * Start a duel. By default (`resetRunMemory: true` when starting at encounter 0),
   * resets all learned Inspector habits. When advancing within a run (`nextEncounter`),
   * keeps run-level learned habits while clearing offer-scoped reveals.
   */
  function startDuel(options = {}) {
    if (disposed) return { ok: false, reason: "DISPOSED" };

    clearAllTimers();
    sessionGeneration += 1;

    if (options.seed !== undefined) {
      rootSeed = normalizeSeed(options.seed, { allowRandom: Boolean(options.allowRandomSeed) });
    } else if (options.allowRandomSeed) {
      rootSeed = normalizeSeed("", { allowRandom: true });
    }

    if (options.pairCount !== undefined) {
      pairCount = clampPairs(options.pairCount);
    }
    if (options.startingMode !== undefined) {
      startingMode = options.startingMode;
    }
    if (options.tierMode !== undefined) {
      tierMode = normalizeTierMode(options.tierMode);
    }
    if (options.encounterIndex !== undefined && Number.isInteger(options.encounterIndex)) {
      encounterIndex = Math.max(0, options.encounterIndex);
    }

    const shouldResetRun =
      options.resetRunMemory !== undefined ? Boolean(options.resetRunMemory) : encounterIndex === 0;

    if (options.restoreMemorySnap) {
      inspectorAgent.getMemory().restore(options.restoreMemorySnap);
      inspectorAgent.resetForNewDuel();
      duelStartMemorySnap = inspectorAgent.getMemory().snapshot();
    } else if (shouldResetRun) {
      inspectorAgent.resetForNewRun();
      duelStartMemorySnap = inspectorAgent.getMemory().snapshot();
    } else {
      inspectorAgent.resetForNewDuel();
      duelStartMemorySnap = inspectorAgent.getMemory().snapshot();
    }

    const activeTier = resolveActiveTier(tierMode, encounterIndex);
    inspectorAgent.setTier(activeTier);

    const streams = createDuelStreams(rootSeed, encounterIndex);
    aiRng = streams.createAiRng();

    const startingOfferer = resolveStartingOfferer(startingMode, encounterIndex);

    duelState = createDuel({
      encounterSeed: streams.shuffleSeed,
      pairCount,
      encounterIndex,
      startingOfferer,
      condition: options.condition ?? null,
    });

    selectedSwapSlot = null;
    lastSwappedSlots = [];
    newlyDrawnUnlistedSlot = null;
    pendingDrawSlot = null;
    inputLocked = false;
    statusStage = "IDLE";
    activeSpotlight = null;

    const dealPairs = duelState.initialDealPairCount;
    if (dealPairs > 0) {
      const names = duelState.discardPairs
        .filter((p) => p.source === "DEAL")
        .map((p) => getTicketMeta(p.symbolId)?.shortLabel || p.symbolId)
        .join(", ");
      const livePairs = pairCount - dealPairs;
      lastNotice = `Dealt ${pairCount * 2 + 1} tickets — cleared ${dealPairs} opening ${
        dealPairs === 1 ? "pair" : "pairs"
      } (${names}). ${livePairs} ${livePairs === 1 ? "pair" : "pairs"} + The Unlisted remain.`;
    } else {
      lastNotice = `Dealt ${pairCount * 2 + 1} tickets — no opening pairs cleared. All ${pairCount} pairs + The Unlisted remain.`;
    }

    advanceFlowAfterStateChange(false);
    return { ok: true, snapshot: getSnapshot() };
  }

  /**
   * Start a brand-new run, resetting encounter index to 0 and wiping all learned AI habits.
   */
  function startNewRun(options = {}) {
    return startDuel({
      ...options,
      encounterIndex: 0,
      resetRunMemory: true,
    });
  }

  /**
   * Advance to the next carriage duel in the current run: alternates starter,
   * ramps tier (if in RAMP mode), and preserves learned Inspector habits.
   */
  function nextEncounter() {
    return startDuel({
      encounterIndex: encounterIndex + 1,
      resetRunMemory: false,
    });
  }

  /**
   * Replay current duel cleanly from its exact pre-duel memory & seed state.
   */
  function restartDuel() {
    if (encounterIndex === 0 || !duelStartMemorySnap) {
      return startNewRun();
    }
    return startDuel({
      encounterIndex,
      restoreMemorySnap: duelStartMemorySnap,
    });
  }

  function selectOfferSlot(slotIndex) {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    if (inputLocked) return { ok: false, reason: "INPUT_LOCKED" };
    if (!duelState || duelState.phase !== PHASES.OFFER || duelState.offerer !== SIDES.PLAYER) {
      return { ok: false, reason: "WRONG_PHASE_OR_ACTOR" };
    }

    const view = createObserverView(duelState, SIDES.PLAYER);
    if (!view.legal.canSwap) {
      return { ok: false, reason: "NO_SWAPS_REMAINING" };
    }
    if (!view.legal.legalSwapSlots.includes(slotIndex)) {
      return { ok: false, reason: "SLOT_NOT_SWAPPABLE" };
    }

    if (selectedSwapSlot === null) {
      selectedSwapSlot = slotIndex;
      lastNotice = `Selected slot #${slotIndex + 1}. Choose a second slot to swap privately, or offer as-is.`;
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

    if (!res.ok) {
      return res;
    }

    duelState = res.state;
    selectedSwapSlot = null;
    lastSwappedSlots = [indexA, indexB];
    newlyDrawnUnlistedSlot = null;
    lastNotice = `Privately swapped slots #${indexA + 1} and #${indexB + 1}. Press Commit Fan so the Inspector draws.`;
    emit();
    return { ok: true, swapped: [indexA, indexB] };
  }

  function commitOffer() {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    if (inputLocked) return { ok: false, reason: "INPUT_LOCKED" };
    if (!duelState) return { ok: false, reason: "NO_DUEL" };

    const res = applyAction(duelState, {
      type: ACTION_TYPES.COMMIT_OFFER,
      actor: SIDES.PLAYER,
      seq: duelState.nextSeq,
    });

    if (!res.ok) {
      return res;
    }

    duelState = res.state;
    selectedSwapSlot = null;
    lastSwappedSlots = [];
    newlyDrawnUnlistedSlot = null;
    lastNotice = "You commit your fan across the table.";
    advanceFlowAfterStateChange(false);
    return { ok: true };
  }

  function drawSlot(slotIndex) {
    if (disposed) return { ok: false, reason: "DISPOSED" };
    if (inputLocked) return { ok: false, reason: "INPUT_LOCKED" };
    if (!duelState) return { ok: false, reason: "NO_DUEL" };

    const res = applyAction(duelState, {
      type: ACTION_TYPES.DRAW,
      actor: SIDES.PLAYER,
      slotIndex,
      seq: duelState.nextSeq,
    });

    if (!res.ok) {
      return res;
    }

    inputLocked = true;
    pendingDrawSlot = slotIndex;
    selectedSwapSlot = null;
    duelState = res.state;
    lastNotice = null;
    advanceFlowAfterStateChange(true);
    return { ok: true };
  }

  function setReducedMotion(flag) {
    isReducedMotion = Boolean(flag);
    emit();
  }

  function setDevTraceOpen(flag) {
    isDevTraceOpen = Boolean(flag);
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

    // Redact the exact offered slot number while a live Inspector offer is still awaiting the
    // player's draw so inspecting the dev panel mid-turn logs factors without spoiling slot index.
    const liveInspectorOfferId =
      view && view.phase === PHASES.DRAW && view.offerer === SIDES.INSPECTOR
        ? view.offerId
        : null;

    const entries = mem
      .getTraceLog()
      .slice(-18)
      .reverse()
      .map((entry) => {
        if (liveInspectorOfferId !== null && entry.offerId === liveInspectorOfferId && entry.role === "OFFERER") {
          return {
            ...entry,
            candidates: entry.candidates.map((c) => ({
              bucket: c.bucket,
              prob: c.prob,
              note: c.note,
            })),
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

  function getSnapshot() {
    const view = duelState ? createObserverView(duelState, SIDES.PLAYER) : null;
    const tierInfo = inspectorAgent.getTierInfo();
    const pattern = inspectorAgent.getMemory().getDetectedPattern();

    // Subtle public-only demeanor hint: only shown at Tier 3+ when supported by observed player habits.
    const inspectorTell =
      tierInfo.tier >= 3 && pattern.detected
        ? `Watching your tendency toward the ${pattern.label}`
        : null;

    return {
      rootSeed,
      pairCount,
      startingMode,
      tierMode,
      activeTier: tierInfo.tier,
      activeTierName: tierInfo.name,
      inspectorTell,
      encounterIndex,
      reducedMotion: isReducedMotion,
      devTraceOpen: isDevTraceOpen,
      devTrace: isDevTraceOpen ? buildSanitizedDevTrace(view) : null,
      duelStartMemorySnap: duelStartMemorySnap ? true : false,
      inputLocked,
      statusStage,
      selectedSwapSlot,
      lastSwappedSlots: lastSwappedSlots.slice(),
      newlyDrawnUnlistedSlot,
      pendingDrawSlot,
      activeSpotlight,
      lastNotice,
      view,
      pendingTimerCount: pendingTimers.size,
    };
  }

  function getInspectorMemorySnapshot() {
    return inspectorAgent.getMemory().snapshot();
  }

  function getReplayBundle() {
    return duelState ? exportReplay(duelState) : null;
  }

  function subscribe(listener) {
    subscribers.add(listener);
    if (duelState) {
      listener(getSnapshot());
    }
    return () => {
      subscribers.delete(listener);
    };
  }

  function dispose() {
    disposed = true;
    sessionGeneration += 1;
    clearAllTimers();
    subscribers.clear();
  }

  return Object.freeze({
    startDuel,
    startNewRun,
    restartDuel,
    nextEncounter,
    selectOfferSlot,
    commitOffer,
    drawSlot,
    setReducedMotion,
    setDevTraceOpen,
    toggleDevTrace,
    getSnapshot,
    getInspectorMemorySnapshot,
    getReplayBundle,
    subscribe,
    dispose,
  });
}
