/**
 * src/ai/learner.js
 * Positional habit learner and offer-scoped reveal memory for the Inspector.
 *
 * Uses strictly legal public observations:
 * - Player's unforced draw positions mapped into 5 normalized buckets
 *   (LEFT_EDGE, LEFT_MID, CENTER, RIGHT_MID, RIGHT_EDGE) so data remains
 *   comparable as hands shrink from 13 cards down to 2.
 * - Symmetric Dirichlet smoothing for sparse data and exponential decay so
 *   changed player habits naturally fade older tendencies.
 * - Strictly offer-scoped reveal memory (invalidated as soon as offerId changes).
 * - Full reset at the start of a new run.
 */

import { PHASES, SIDES } from "../core/engine.js";
import { BUCKET_LABELS, BUCKETS, LEARNER_TUNING } from "../data/aiTuning.js";

/**
 * Compute normalized position u in [0, 1] for a slot in a hand of size handSize.
 */
export function slotToNormalizedPos(slotIndex, handSize) {
  if (!Number.isInteger(handSize) || handSize <= 1) {
    return 0.5;
  }
  const clamped = Math.min(handSize - 1, Math.max(0, slotIndex));
  return clamped / (handSize - 1);
}

/**
 * Map (slotIndex, handSize) to one of the 5 symmetric normalized buckets
 * specified in RULES.md Section 10:
 *   LEFT_EDGE:  u < 0.20
 *   LEFT_MID:   0.20 <= u < 0.40
 *   CENTER:     0.40 <= u <= 0.60
 *   RIGHT_MID:  0.60 < u <= 0.80
 *   RIGHT_EDGE: u > 0.80
 */
export function slotToBucket(slotIndex, handSize) {
  const u = slotToNormalizedPos(slotIndex, handSize);
  if (u < 0.2) return "LEFT_EDGE";
  if (u < 0.4) return "LEFT_MID";
  if (u <= 0.6) return "CENTER";
  if (u <= 0.8) return "RIGHT_MID";
  return "RIGHT_EDGE";
}

function zeroBucketMap() {
  return {
    LEFT_EDGE: 0,
    LEFT_MID: 0,
    CENTER: 0,
    RIGHT_MID: 0,
    RIGHT_EDGE: 0,
  };
}

function zeroTransitionMatrix() {
  const mat = {};
  for (const from of BUCKETS) {
    mat[from] = zeroBucketMap();
  }
  return mat;
}

function computeSmoothedProbs(counts, alpha) {
  let total = 0;
  for (const b of BUCKETS) {
    total += counts[b] + alpha;
  }
  const probs = {};
  for (const b of BUCKETS) {
    probs[b] = total > 0 ? (counts[b] + alpha) / total : 1 / BUCKETS.length;
  }
  return probs;
}

function createFreshState() {
  return {
    // Run-persistent habit tracking (cleared on resetForNewRun)
    drawCounts: zeroBucketMap(),
    fastDrawCounts: zeroBucketMap(),
    transitionCounts: zeroTransitionMatrix(),
    lastDrawBucket: null,
    drawObservations: 0,

    hideCounts: zeroBucketMap(),
    hideObservations: 0,
    rightEdgeStayed: 0,
    rightEdgeMoved: 0,

    // Per-duel cursor & transient tracking (cleared on resetForNewDuel)
    processedHistoryLen: 0,
    lastDuelSignature: null,
    lastOfferedUnlistedSlot: null,
    lastOfferedHandSize: null,
    pendingOfferSwapTarget: null,
    // Tracks plausible slots where player's Unlisted sits across consecutive un-transferred turns
    plausibleUnlistedPrior: null, // { offerId, weights: number[] } | null

    // Strictly offer-scoped reveal cache (cleared whenever offerId changes or draw resolves)
    revealCache: {
      offerId: null,
      phase: null,
      entries: [], // [{ slotIndex, ticketId, symbolId, isUnlisted, isEmblem, source }]
    },

    // Developer-only decision trace log
    traceLog: [],
  };
}

function cloneState(s) {
  const trans = {};
  for (const b of BUCKETS) {
    trans[b] = { ...s.transitionCounts[b] };
  }
  return {
    drawCounts: { ...s.drawCounts },
    fastDrawCounts: { ...s.fastDrawCounts },
    transitionCounts: trans,
    lastDrawBucket: s.lastDrawBucket,
    drawObservations: s.drawObservations,
    hideCounts: { ...s.hideCounts },
    hideObservations: s.hideObservations,
    rightEdgeStayed: s.rightEdgeStayed,
    rightEdgeMoved: s.rightEdgeMoved,
    processedHistoryLen: s.processedHistoryLen,
    lastDuelSignature: s.lastDuelSignature,
    lastOfferedUnlistedSlot: s.lastOfferedUnlistedSlot,
    lastOfferedHandSize: s.lastOfferedHandSize,
    pendingOfferSwapTarget: s.pendingOfferSwapTarget,
    plausibleUnlistedPrior: s.plausibleUnlistedPrior
      ? {
          offerId: s.plausibleUnlistedPrior.offerId,
          weights: s.plausibleUnlistedPrior.weights.slice(),
        }
      : null,
    revealCache: {
      offerId: s.revealCache.offerId,
      phase: s.revealCache.phase,
      entries: s.revealCache.entries.map((e) => ({ ...e })),
    },
    traceLog: s.traceLog.map((t) => JSON.parse(JSON.stringify(t))),
  };
}

/**
 * Create an Inspector learning & legal-memory instance.
 */
export function createInspectorMemory(customTuning = {}, initialSnapshot = null) {
  const tuning = { ...LEARNER_TUNING, ...customTuning };
  let state = initialSnapshot ? cloneState(initialSnapshot) : createFreshState();

  /**
   * Record one player draw observation. Skips forced 1-option draws (Decision D7).
   */
  function recordPlayerDraw(slotIndex, handSize, legalDrawCount = handSize) {
    if (!Number.isInteger(handSize) || handSize < 2 || legalDrawCount < 2) {
      return null;
    }
    const bucket = slotToBucket(slotIndex, handSize);

    for (const b of BUCKETS) {
      state.drawCounts[b] *= tuning.drawDecay;
      state.fastDrawCounts[b] *= tuning.fastDrawDecay;
    }
    state.drawCounts[bucket] += 1;
    state.fastDrawCounts[bucket] += 1;

    if (state.lastDrawBucket !== null) {
      const prev = state.lastDrawBucket;
      for (const b of BUCKETS) {
        state.transitionCounts[prev][b] *= tuning.transitionDecay;
      }
      state.transitionCounts[prev][bucket] += 1;
    }

    state.lastDrawBucket = bucket;
    state.drawObservations += 1;
    return bucket;
  }

  /**
   * Record the public result of an Inspector draw from the player's offered fan.
   * Only records when the player actually held The Unlisted (handSize >= 2 and unforced).
   */
  function recordInspectorDrawOutcome({
    slotIndex,
    handSize,
    legalDrawCount = handSize,
    drewUnlisted,
    opponentJustDrewUnlisted = false,
    opponentSwapForfeited = false,
  }) {
    if (!Number.isInteger(handSize) || handSize < 2 || legalDrawCount < 2) {
      return;
    }
    const bucket = slotToBucket(slotIndex, handSize);

    for (const b of BUCKETS) {
      state.hideCounts[b] *= tuning.hideDecay;
    }
    if (drewUnlisted) {
      state.hideCounts[bucket] += tuning.hideHitWeight;
    } else {
      state.hideCounts[bucket] = Math.max(0, state.hideCounts[bucket] - tuning.hideMissWeight);
    }
    state.hideObservations += 1;

    // If the player had just received The Unlisted and WAS free to swap, track right-edge retention.
    if (opponentJustDrewUnlisted && !opponentSwapForfeited) {
      const rightIdx = handSize - 1;
      if (slotIndex === rightIdx) {
        state.rightEdgeStayed *= tuning.rightEdgeDecay;
        state.rightEdgeMoved *= tuning.rightEdgeDecay;
        if (drewUnlisted) {
          state.rightEdgeStayed += 1;
        } else {
          state.rightEdgeMoved += 1;
        }
      } else if (drewUnlisted) {
        // Found Unlisted elsewhere -> player actively swapped it off the right edge!
        state.rightEdgeStayed *= tuning.rightEdgeDecay;
        state.rightEdgeMoved = state.rightEdgeMoved * tuning.rightEdgeDecay + 1;
      }
    }
  }

  /**
   * Refresh offer-scoped reveal cache strictly from the current ObserverView.
   * Any reveals from an earlier offerId or outside an active offer are immediately dropped.
   */
  function updateRevealCache(view) {
    if (
      !view ||
      view.phase === PHASES.OVER ||
      view.offerer !== view.opponentSide ||
      !Number.isInteger(view.offerId)
    ) {
      state.revealCache = { offerId: null, phase: null, entries: [] };
      return;
    }

    const entries = [];
    for (const slot of view.opponentSlots) {
      if (slot.revealedTicket) {
        entries.push({
          slotIndex: slot.slotIndex,
          ticketId: slot.revealedTicket.ticketId,
          symbolId: slot.revealedTicket.symbolId,
          isUnlisted: Boolean(slot.revealedTicket.isUnlisted),
          isEmblem: Boolean(slot.revealedTicket.isEmblem),
          locked: Boolean(slot.locked),
          source: slot.revealSource || "PUBLIC",
        });
      }
    }

    state.revealCache = {
      offerId: view.offerId,
      phase: view.phase,
      entries,
    };
  }

  /**
   * Synchronize memory with a legal ObserverView (for INSPECTOR or viewerSide).
   * Ingests only newly appended publicHistory events since the last sync, and
   * updates/expires the offer-scoped reveal cache.
   */
  function syncFromView(view) {
    if (!view || !Array.isArray(view.publicHistory)) return;

    const mySide = view.viewerSide || SIDES.INSPECTOR;
    const oppSide = view.opponentSide || SIDES.PLAYER;

    // Detect if a brand-new duel started while retaining run-level habit memory.
    const dealEv = view.publicHistory[0];
    const duelSig = dealEv
      ? `${dealEv.pairCount}:${dealEv.startingOfferer}:${JSON.stringify(dealEv.dealtCounts)}`
      : null;

    if (
      view.publicHistory.length < state.processedHistoryLen ||
      (state.processedHistoryLen > 0 &&
        view.turnNumber <= 1 &&
        view.publicHistory.filter((e) => e.type === "TICKET_DRAWN").length === 0 &&
        duelSig !== state.lastDuelSignature)
    ) {
      resetForNewDuel();
    }
    state.lastDuelSignature = duelSig;

    // Process new events from publicHistory.
    const history = view.publicHistory;
    for (let i = state.processedHistoryLen; i < history.length; i += 1) {
      const ev = history[i];
      if (ev.type === "TICKET_DRAWN") {
        // Any resolved draw immediately invalidates prior offer reveals.
        state.revealCache = { offerId: null, phase: null, entries: [] };
        state.pendingOfferSwapTarget = null;

        if (ev.drawer === oppSide && ev.offerer === mySide) {
          recordPlayerDraw(ev.slotIndex, ev.offererHandSizeBefore, ev.legalDrawCountBefore);
        } else if (ev.drawer === mySide && ev.offerer === oppSide) {
          // Determine from strictly public prior history whether opponent had just drawn Unlisted
          // and whether their offer swap was forfeited.
          const context = extractOfferPublicContext(history, i, oppSide);
          if (context.opponentHeldUnlisted) {
            recordInspectorDrawOutcome({
              slotIndex: ev.slotIndex,
              handSize: ev.offererHandSizeBefore,
              legalDrawCountBefore: ev.legalDrawCountBefore,
              legalDrawCount: ev.legalDrawCountBefore,
              drewUnlisted: ev.drewUnlisted,
              opponentJustDrewUnlisted: context.opponentJustDrewUnlisted,
              opponentSwapForfeited: context.opponentSwapForfeited,
            });
          }
        }
      }
    }

    state.processedHistoryLen = history.length;
    updateRevealCache(view);
  }

  /**
   * Compute smoothed 5-bucket probability distribution for player draws.
   */
  function getDrawBucketProbs({ fastBlend = 0, transitionBlend = 0 } = {}) {
    const base = computeSmoothedProbs(state.drawCounts, tuning.drawSmoothingAlpha);
    let combined = { ...base };

    if (fastBlend > 0 && state.drawObservations > 0) {
      const fast = computeSmoothedProbs(state.fastDrawCounts, tuning.fastDrawAlpha);
      const w = Math.min(1, Math.max(0, fastBlend));
      for (const b of BUCKETS) {
        combined[b] = (1 - w) * combined[b] + w * fast[b];
      }
    }

    if (transitionBlend > 0 && state.lastDrawBucket !== null) {
      const row = state.transitionCounts[state.lastDrawBucket];
      let rowMass = 0;
      for (const b of BUCKETS) rowMass += row[b];
      if (rowMass >= 0.85) {
        const transProbs = computeSmoothedProbs(row, tuning.transitionAlpha);
        const confidence = Math.min(1, (rowMass - 0.85 + 0.45) / 1.8);
        const w = Math.min(0.88, Math.max(0, transitionBlend * confidence));
        for (const b of BUCKETS) {
          combined[b] = (1 - w) * combined[b] + w * transProbs[b];
        }
      }
    }

    // Normalize cleanly against tiny float drift.
    let sum = 0;
    for (const b of BUCKETS) sum += combined[b];
    for (const b of BUCKETS) combined[b] /= sum;
    return combined;
  }

  /**
   * Compute smoothed 5-bucket estimate of where the player tends to hide The Unlisted.
   */
  function getHideBucketProbs() {
    return computeSmoothedProbs(state.hideCounts, tuning.hideSmoothingAlpha);
  }

  /**
   * Posterior probability that the player leaves a freshly drawn Unlisted at slot N - 1.
   */
  function getRightEdgeStayProb() {
    const num = state.rightEdgeStayed + tuning.rightEdgeStayPriorAlpha;
    const den = num + state.rightEdgeMoved + tuning.rightEdgeMovePriorBeta;
    return num / den;
  }

  /**
   * Return reveals valid ONLY for the requested offerId (and optional phase).
   */
  function getValidReveals(offerId) {
    if (state.revealCache.offerId !== offerId || offerId === null) {
      return [];
    }
    return state.revealCache.entries.map((e) => ({ ...e }));
  }

  /**
   * Manually register a legal reveal for a specific offerId (automatically dropped
   * whenever offerId changes). Useful for Stamp/Condition integrations and tests.
   */
  function rememberReveal(offerId, revealEntry) {
    if (!Number.isInteger(offerId)) return;
    if (state.revealCache.offerId !== offerId) {
      state.revealCache = { offerId, phase: PHASES.DRAW, entries: [] };
    }
    const idx = state.revealCache.entries.findIndex(
      (e) => e.slotIndex === revealEntry.slotIndex
    );
    const clean = {
      slotIndex: revealEntry.slotIndex,
      ticketId: revealEntry.ticketId,
      symbolId: revealEntry.symbolId,
      isUnlisted: Boolean(revealEntry.isUnlisted),
      isEmblem: Boolean(revealEntry.isEmblem),
      locked: Boolean(revealEntry.locked),
      source: revealEntry.source || "REVEAL",
    };
    if (idx >= 0) {
      state.revealCache.entries[idx] = clean;
    } else {
      state.revealCache.entries.push(clean);
    }
  }

  /**
   * Expire reveals whenever an offer resolves or becomes invalid.
   */
  function invalidateReveals() {
    state.revealCache = { offerId: null, phase: null, entries: [] };
  }

  /**
   * Return an honest, evidence-backed player tendency summary (for dev trace and
   * Phase 5 flavor dialogue). Returns { detected: false } on sparse or flat data.
   */
  function getDetectedPattern() {
    const probs = getDrawBucketProbs();
    let topBucket = BUCKETS[0];
    let topProb = probs[topBucket];
    for (const b of BUCKETS) {
      if (probs[b] > topProb) {
        topProb = probs[b];
        topBucket = b;
      }
    }

    const detected =
      state.drawObservations >= tuning.patternMinObservations &&
      topProb >= tuning.patternMinProbability;

    return {
      detected,
      bucket: detected ? topBucket : null,
      label: detected ? BUCKET_LABELS[topBucket] : null,
      topBucket,
      topLabel: BUCKET_LABELS[topBucket],
      probability: topProb,
      observations: state.drawObservations,
    };
  }

  function getLastOfferedUnlisted() {
    return {
      slotIndex: state.lastOfferedUnlistedSlot,
      handSize: state.lastOfferedHandSize,
    };
  }

  function setLastOfferedUnlisted(slotIndex, handSize) {
    state.lastOfferedUnlistedSlot = slotIndex;
    state.lastOfferedHandSize = handSize;
  }

  function getPendingOfferSwapTarget() {
    return state.pendingOfferSwapTarget;
  }

  function setPendingOfferSwapTarget(target) {
    state.pendingOfferSwapTarget = target;
  }

  function recordTrace(entry) {
    state.traceLog.push(entry);
    if (state.traceLog.length > tuning.maxTraceEntries) {
      state.traceLog.shift();
    }
  }

  function getTraceLog() {
    return state.traceLog.slice();
  }

  function clearTraceLog() {
    state.traceLog = [];
  }

  /**
   * Reset per-duel transient markers & offer reveals while preserving run-level habit learning.
   */
  function resetForNewDuel() {
    state.processedHistoryLen = 0;
    state.lastDuelSignature = null;
    state.lastOfferedUnlistedSlot = null;
    state.lastOfferedHandSize = null;
    state.pendingOfferSwapTarget = null;
    state.plausibleUnlistedPrior = null;
    state.revealCache = { offerId: null, phase: null, entries: [] };
  }

  /**
   * Completely wipe all learned behavior, reveal memory, and traces for a fresh run.
   */
  function resetForNewRun() {
    state = createFreshState();
  }

  function snapshot() {
    return cloneState(state);
  }

  function restore(snap) {
    if (snap && typeof snap === "object") {
      state = cloneState(snap);
    }
  }

  function clone() {
    return createInspectorMemory(tuning, state);
  }

  return Object.freeze({
    tuning,
    syncFromView,
    recordPlayerDraw,
    recordInspectorDrawOutcome,
    getDrawBucketProbs,
    getHideBucketProbs,
    getRightEdgeStayProb,
    getValidReveals,
    rememberReveal,
    invalidateReveals,
    getDetectedPattern,
    getLastOfferedUnlisted,
    setLastOfferedUnlisted,
    getPendingOfferSwapTarget,
    setPendingOfferSwapTarget,
    recordTrace,
    getTraceLog,
    clearTraceLog,
    resetForNewDuel,
    resetForNewRun,
    snapshot,
    restore,
    clone,
  });
}

/**
 * Derive strictly public context for an offer at history index upToIdx.
 */
export function extractOfferPublicContext(publicHistory, upToIdx, offererSide) {
  let turnStartEv = null;
  let prevDrawEv = null;
  let nightTransferUsed = false;

  for (let j = upToIdx - 1; j >= 0; j -= 1) {
    const e = publicHistory[j];
    if (
      !turnStartEv &&
      e.type === "STAMP_USED" &&
      e.actor === offererSide &&
      e.grantedSwap
    ) {
      nightTransferUsed = true;
    } else if (!turnStartEv && e.type === "TURN_STARTED" && e.offerer === offererSide) {
      turnStartEv = e;
    } else if (e.type === "TICKET_DRAWN") {
      prevDrawEv = e;
      break;
    }
  }

  const opponentHeldUnlisted = turnStartEv
    ? turnStartEv.offererCount > turnStartEv.drawerCount
    : false;
  const opponentJustDrewUnlisted = Boolean(
    prevDrawEv && prevDrawEv.drawer === offererSide && prevDrawEv.drewUnlisted
  );
  const opponentSwapForfeited = Boolean(
    turnStartEv && turnStartEv.offererSwapForfeited && !nightTransferUsed
  );

  return {
    opponentHeldUnlisted,
    opponentJustDrewUnlisted,
    opponentSwapForfeited,
  };
}
