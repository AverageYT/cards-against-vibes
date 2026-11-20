/**
 * src/core/engine.js
 * Pure deterministic rules engine for The Unlisted.
 *
 * Serves both PLAYER and INSPECTOR identically. Enforces core ticket rules,
 * Final Call (with small-hand deadlock waiver), all 8 Stamps (with tradeoffs
 * and Emblem-pair triggers), and all 4 Carriage Conditions (with live expiry).
 * Never mutates input state, never reads wall-clock time or Math.random, and
 * never touches DOM or WebAudio.
 */

import { createRng, deriveSeed, normalizeSeed } from "./rng.js";
import {
  DEFAULT_PAIRS,
  MAX_PAIRS,
  MIN_PAIRS,
  UNLISTED_ID,
  UNLISTED_SYMBOL,
  buildDeck,
} from "../data/tickets.js";
import {
  MAX_STAMP_SLOTS,
  STAMP_IDS,
  createDuelStampState,
  getStampDef,
} from "../data/stamps.js";
import {
  CONDITION_IDS,
  createDuelConditionState,
} from "../data/conditions.js";
import { INITIAL_LANTERNS, MAX_LANTERNS } from "../data/carriages.js";

export const SIDES = Object.freeze({
  PLAYER: "PLAYER",
  INSPECTOR: "INSPECTOR",
});

export const PHASES = Object.freeze({
  OFFER: "OFFER_PHASE",
  DRAW: "DRAW_PHASE",
  OVER: "DUEL_OVER",
});

export const ACTION_TYPES = Object.freeze({
  SWAP: "SWAP",
  COMMIT_OFFER: "COMMIT_OFFER",
  DRAW: "DRAW",
  USE_STAMP: "USE_STAMP",
  CHECK_EDGE: "CHECK_EDGE",
  USE_GAUGE: "USE_GAUGE",
});

export const REJECT_REASONS = Object.freeze({
  INVALID_ACTION_OBJECT: "INVALID_ACTION_OBJECT",
  DUEL_ALREADY_OVER: "DUEL_ALREADY_OVER",
  DUPLICATE_OR_STALE_SEQ: "DUPLICATE_OR_STALE_SEQ",
  UNKNOWN_ACTION_TYPE: "UNKNOWN_ACTION_TYPE",
  WRONG_ACTOR: "WRONG_ACTOR",
  WRONG_PHASE: "WRONG_PHASE",
  NO_SWAPS_REMAINING: "NO_SWAPS_REMAINING",
  INVALID_SLOT_INDEX: "INVALID_SLOT_INDEX",
  SAME_SLOT_SWAP: "SAME_SLOT_SWAP",
  SLOT_LOCKED: "SLOT_LOCKED",
  STAMP_UNAVAILABLE: "STAMP_UNAVAILABLE",
  INVALID_STAMP_TARGET: "INVALID_STAMP_TARGET",
  TOOL_UNAVAILABLE: "TOOL_UNAVAILABLE",
});

export const DEFAULT_FINAL_CALL_THRESHOLD = 3;

export function isValidSide(side) {
  return side === SIDES.PLAYER || side === SIDES.INSPECTOR;
}

export function otherSide(side) {
  if (side === SIDES.PLAYER) return SIDES.INSPECTOR;
  if (side === SIDES.INSPECTOR) return SIDES.PLAYER;
  throw new RangeError(`Invalid side: ${side}`);
}

/**
 * Alternate who gets the first draw across encounters (Decision D1).
 * Encounter 0 (Stop 1): INSPECTOR offers, PLAYER draws first.
 * Encounter 1 (Stop 2): PLAYER offers, INSPECTOR draws first.
 */
export function getStartingOfferer(encounterIndex = 0, firstEncounterDrawer = SIDES.PLAYER) {
  if (!Number.isInteger(encounterIndex) || encounterIndex < 0) {
    throw new RangeError(`encounterIndex must be a non-negative integer, got ${encounterIndex}`);
  }
  if (!isValidSide(firstEncounterDrawer)) {
    throw new RangeError(`Invalid firstEncounterDrawer: ${firstEncounterDrawer}`);
  }
  const initialOfferer = otherSide(firstEncounterDrawer);
  return encounterIndex % 2 === 0 ? initialOfferer : firstEncounterDrawer;
}

/**
 * Scan a single hand left-to-right and discard any matching ordinary pairs.
 * Preserves relative slot order of surviving tickets. Never pairs UNLISTED-0.
 */
export function purgePairsFromHand(hand) {
  const firstSeenBySymbol = new Map();
  const removedIndices = new Set();
  const pairs = [];

  for (let i = 0; i < hand.length; i += 1) {
    const ticket = hand[i];
    if (ticket.isUnlisted || ticket.symbolId === UNLISTED_SYMBOL) {
      continue;
    }
    if (firstSeenBySymbol.has(ticket.symbolId)) {
      const firstIdx = firstSeenBySymbol.get(ticket.symbolId);
      const firstTicket = hand[firstIdx];
      firstSeenBySymbol.delete(ticket.symbolId);
      removedIndices.add(firstIdx);
      removedIndices.add(i);
      pairs.push([firstTicket, ticket]);
    } else {
      firstSeenBySymbol.set(ticket.symbolId, i);
    }
  }

  const remaining = [];
  for (let i = 0; i < hand.length; i += 1) {
    if (!removedIndices.has(i)) {
      remaining.push(hand[i]);
    }
  }

  return { remaining, pairs };
}

/**
 * Evaluate Final Call on the incoming offerer's hand (RULES.md Section 6 & Decision D3).
 *
 * If locking UNLISTED-0 leaves >= 1 drawable slot, marks & pins UNLISTED-0.
 * If locking it would leave 0 drawable slots, waives Final Call and resets the
 * streak so the duel can never deadlock.
 */
export function evaluateFinalCall(
  offererHand,
  {
    unlistedStreak,
    threshold = DEFAULT_FINAL_CALL_THRESHOLD,
    existingLockedIndices = [],
  }
) {
  if (!Array.isArray(offererHand) || unlistedStreak < threshold) {
    return {
      triggered: false,
      waived: false,
      finalCall: null,
      lockedSlot: null,
      waiveReason: null,
    };
  }

  const unlistedIndex = offererHand.findIndex((t) => t.isUnlisted);
  if (unlistedIndex === -1) {
    return {
      triggered: false,
      waived: true,
      finalCall: null,
      lockedSlot: null,
      waiveReason: "OFFERER_LACKS_UNLISTED",
    };
  }

  const lockedSet = new Set(existingLockedIndices);
  let remainingDrawable = 0;
  for (let i = 0; i < offererHand.length; i += 1) {
    if (i !== unlistedIndex && !lockedSet.has(i)) {
      remainingDrawable += 1;
    }
  }

  if (remainingDrawable < 1) {
    return {
      triggered: false,
      waived: true,
      finalCall: null,
      lockedSlot: null,
      waiveReason: "INSUFFICIENT_DRAWABLE_SLOTS",
    };
  }

  const finalCall = {
    active: true,
    slotIndex: unlistedIndex,
    ticketId: offererHand[unlistedIndex].ticketId,
    streakAtTrigger: unlistedStreak,
  };
  const lockedSlot = {
    slotIndex: unlistedIndex,
    reason: "FINAL_CALL",
    ticketId: offererHand[unlistedIndex].ticketId,
    public: true,
  };

  return {
    triggered: true,
    waived: false,
    finalCall,
    lockedSlot,
    waiveReason: null,
  };
}

function resolveShuffledDeck(baseDeck, encounterSeed, customDeckOrder) {
  if (customDeckOrder == null) {
    const shuffleRng = createRng(encounterSeed);
    return shuffleRng.shuffle(baseDeck);
  }

  if (!Array.isArray(customDeckOrder) || customDeckOrder.length !== baseDeck.length) {
    throw new RangeError(
      `customDeckOrder must list all ${baseDeck.length} ticketIds exactly once`
    );
  }

  const byId = new Map(baseDeck.map((t) => [t.ticketId, t]));
  const seen = new Set();
  const ordered = [];
  for (const id of customDeckOrder) {
    const ticket = byId.get(id);
    if (!ticket || seen.has(id)) {
      throw new RangeError(`customDeckOrder contains invalid or duplicate ticketId: ${id}`);
    }
    seen.add(id);
    ordered.push(ticket);
  }
  return ordered;
}

function normalizeConditionId(rawConfig) {
  if (typeof rawConfig.conditionId === "string" && rawConfig.conditionId.length > 0) {
    return rawConfig.conditionId;
  }
  if (rawConfig.condition && typeof rawConfig.condition.id === "string") {
    return rawConfig.condition.id;
  }
  return null;
}

function normalizeInitialStampIds(list) {
  if (!Array.isArray(list)) return [];
  const unique = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw) continue;
    const id = typeof raw === "string" ? raw : raw.id;
    if (!id || seen.has(id)) continue;
    if (!getStampDef(id)) {
      throw new RangeError(`Unknown Stamp ID in duel setup: ${id}`);
    }
    seen.add(id);
    unique.push(id);
    if (unique.length >= MAX_STAMP_SLOTS) break;
  }
  return unique;
}

function isSealedManifestBlocking(condition, turnNumber) {
  return Boolean(
    condition &&
      !condition.expired &&
      condition.id === CONDITION_IDS.SEALED_MANIFEST &&
      turnNumber <= condition.activeThroughTurn
  );
}

function isLateScheduleBlocking(condition) {
  return Boolean(
    condition && !condition.expired && condition.id === CONDITION_IDS.LATE_SCHEDULE
  );
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return value;
}

function cloneMutableState(state) {
  return {
    config: {
      ...state.config,
      playerStamps: state.config.playerStamps.slice(),
      inspectorStamps: state.config.inspectorStamps.slice(),
      customDeckOrder: state.config.customDeckOrder
        ? state.config.customDeckOrder.slice()
        : null,
    },
    initialTicketIds: state.initialTicketIds.slice(),
    phase: state.phase,
    turnNumber: state.turnNumber,
    offerId: state.offerId,
    nextSeq: state.nextSeq,
    offerer: state.offerer,
    drawer: state.drawer,
    hands: {
      PLAYER: state.hands.PLAYER.slice(),
      INSPECTOR: state.hands.INSPECTOR.slice(),
    },
    discardPile: state.discardPile.slice(),
    discardPairs: state.discardPairs.slice(),
    initialDealPairCount: state.initialDealPairCount,
    initialRemainingPairs: state.initialRemainingPairs,
    playedPairsDiscarded: state.playedPairsDiscarded,
    swapsRemaining: state.swapsRemaining,
    swapsUsedThisOffer: state.swapsUsedThisOffer,
    forfeitNextSwap: { ...state.forfeitNextSwap },
    pendingPublicExposure: {
      PLAYER: { ...state.pendingPublicExposure.PLAYER },
      INSPECTOR: { ...state.pendingPublicExposure.INSPECTOR },
    },
    lastStopPunchArmed: state.lastStopPunchArmed,
    unlistedStreak: state.unlistedStreak,
    finalCallThreshold: state.finalCallThreshold,
    finalCall: state.finalCall ? { ...state.finalCall } : null,
    lockedSlots: state.lockedSlots.map((s) => ({ ...s })),
    publicReveals: state.publicReveals.map((r) => ({ ...r })),
    privateReveals: {
      PLAYER: state.privateReveals.PLAYER.map((r) => ({ ...r })),
      INSPECTOR: state.privateReveals.INSPECTOR.map((r) => ({ ...r })),
    },
    privateLoupeClues: {
      PLAYER: state.privateLoupeClues.PLAYER.map((c) => ({ ...c })),
      INSPECTOR: state.privateLoupeClues.INSPECTOR.map((c) => ({ ...c })),
    },
    privateEdgeClues: {
      PLAYER: state.privateEdgeClues.PLAYER.map((c) => ({ ...c })),
      INSPECTOR: state.privateEdgeClues.INSPECTOR.map((c) => ({ ...c })),
    },
    privateGaugeSafeSlots: {
      PLAYER: state.privateGaugeSafeSlots.PLAYER.map((c) => ({ ...c })),
      INSPECTOR: state.privateGaugeSafeSlots.INSPECTOR.map((c) => ({ ...c })),
    },
    edgeChecksRemaining: { ...state.edgeChecksRemaining },
    gaugeChargesRemaining: { ...state.gaugeChargesRemaining },
    condition: state.condition ? { ...state.condition } : null,
    stamps: {
      PLAYER: state.stamps.PLAYER.map((s) => ({ ...s })),
      INSPECTOR: state.stamps.INSPECTOR.map((s) => ({ ...s })),
    },
    consumedStamps: {
      PLAYER: state.consumedStamps.PLAYER.slice(),
      INSPECTOR: state.consumedStamps.INSPECTOR.slice(),
    },
    lanterns: { ...state.lanterns },
    maxLanterns: state.maxLanterns,
    winner: state.winner,
    loser: state.loser,
    endReason: state.endReason,
    lastResolution: state.lastResolution,
    lastStampFeedback: state.lastStampFeedback,
    actionLog: state.actionLog.slice(),
    eventLog: state.eventLog.slice(),
  };
}

/**
 * Initialize a new duel from seed, pair count, optional Carriage Condition, and Stamps.
 */
export function createDuel(rawConfig = {}) {
  const encounterSeed = normalizeSeed(rawConfig.encounterSeed);
  const allowSmallTutorialDeck = Boolean(rawConfig.allowSmallTutorialDeck);
  const minPairs = allowSmallTutorialDeck ? 2 : MIN_PAIRS;
  const pairCount = rawConfig.pairCount ?? DEFAULT_PAIRS;
  if (!Number.isInteger(pairCount) || pairCount < minPairs || pairCount > MAX_PAIRS) {
    throw new RangeError(
      `pairCount must be an integer between ${minPairs} and ${MAX_PAIRS}; got ${pairCount}`
    );
  }

  const encounterIndex = rawConfig.encounterIndex ?? 0;
  let startingOfferer;
  if (rawConfig.startingOfferer !== undefined) {
    if (!isValidSide(rawConfig.startingOfferer)) {
      throw new RangeError(`Invalid startingOfferer: ${rawConfig.startingOfferer}`);
    }
    startingOfferer = rawConfig.startingOfferer;
  } else {
    startingOfferer = getStartingOfferer(encounterIndex);
  }
  const startingDrawer = otherSide(startingOfferer);

  const conditionId = normalizeConditionId(rawConfig);
  const playerStampIds = normalizeInitialStampIds(rawConfig.playerStamps);
  const inspectorStampIds = normalizeInitialStampIds(rawConfig.inspectorStamps);

  const maxLanterns =
    Number.isInteger(rawConfig.maxLanterns) && rawConfig.maxLanterns >= 1
      ? rawConfig.maxLanterns
      : MAX_LANTERNS;
  const playerLanterns =
    Number.isInteger(rawConfig.playerLanterns) && rawConfig.playerLanterns >= 1
      ? Math.min(maxLanterns, rawConfig.playerLanterns)
      : Math.min(maxLanterns, INITIAL_LANTERNS);
  const playerEdgeChecks =
    Number.isInteger(rawConfig.playerEdgeChecks) && rawConfig.playerEdgeChecks > 0
      ? rawConfig.playerEdgeChecks
      : 0;
  const playerGaugeCharges =
    Number.isInteger(rawConfig.playerGaugeCharges) && rawConfig.playerGaugeCharges > 0
      ? rawConfig.playerGaugeCharges
      : 0;

  const baseDeck = buildDeck(pairCount, { minPairs });
  const initialTicketIds = baseDeck.map((t) => t.ticketId);
  const shuffledDeck = resolveShuffledDeck(
    baseDeck,
    encounterSeed,
    rawConfig.customDeckOrder ?? null
  );

  // Deal entire deck alternately starting with startingOfferer (RULES.md Section 4).
  const rawHands = { PLAYER: [], INSPECTOR: [] };
  for (let i = 0; i < shuffledDeck.length; i += 1) {
    const recipient = i % 2 === 0 ? startingOfferer : startingDrawer;
    rawHands[recipient].push(shuffledDeck[i]);
  }

  // Automatically discard matching pairs from both hands after dealing (Decision D5: never fires Stamps).
  const discardPile = [];
  const discardPairs = [];
  const hands = { PLAYER: [], INSPECTOR: [] };
  const eventLog = [];

  eventLog.push({
    type: "DUEL_DEALT",
    pairCount,
    totalTickets: shuffledDeck.length,
    startingOfferer,
    startingDrawer,
    conditionId: conditionId || null,
    dealtCounts: {
      PLAYER: rawHands.PLAYER.length,
      INSPECTOR: rawHands.INSPECTOR.length,
    },
  });

  for (const side of [startingOfferer, startingDrawer]) {
    const purged = purgePairsFromHand(rawHands[side]);
    hands[side] = purged.remaining;
    for (const [cardA, cardB] of purged.pairs) {
      discardPile.push(cardA, cardB);
      const pairRecord = {
        pairNumber: discardPairs.length + 1,
        owner: side,
        source: "DEAL",
        turnNumber: 0,
        symbolId: cardA.symbolId,
        isEmblem: cardA.isEmblem,
        ticketIds: [cardA.ticketId, cardB.ticketId],
        tickets: [cardA, cardB],
      };
      discardPairs.push(pairRecord);
      eventLog.push({
        type: "INITIAL_PAIR_DISCARDED",
        owner: side,
        symbolId: cardA.symbolId,
        ticketIds: [cardA.ticketId, cardB.ticketId],
      });
    }
  }

  const initialDealPairCount = discardPairs.length;
  const initialRemainingPairs = pairCount - initialDealPairCount;
  const totalRemaining = hands.PLAYER.length + hands.INSPECTOR.length;

  const condition = createDuelConditionState(conditionId, initialRemainingPairs);
  // Honor legacy activeThroughTurn override if supplied in synthetic tests.
  if (
    condition &&
    rawConfig.condition &&
    Number.isInteger(rawConfig.condition.activeThroughTurn)
  ) {
    condition.activeThroughTurn = rawConfig.condition.activeThroughTurn;
  }

  const defaultThreshold =
    condition && condition.finalCallThreshold
      ? condition.finalCallThreshold
      : DEFAULT_FINAL_CALL_THRESHOLD;
  const finalCallThreshold = rawConfig.finalCallThreshold ?? defaultThreshold;
  if (!Number.isInteger(finalCallThreshold) || finalCallThreshold < 1) {
    throw new RangeError(
      `finalCallThreshold must be a positive integer; got ${finalCallThreshold}`
    );
  }

  const config = {
    encounterSeed,
    pairCount,
    encounterIndex,
    startingOfferer,
    finalCallThreshold,
    allowSmallTutorialDeck,
    conditionId: condition ? condition.id : null,
    playerStamps: playerStampIds,
    inspectorStamps: inspectorStampIds,
    playerLanterns,
    maxLanterns,
    playerEdgeChecks,
    playerGaugeCharges,
    customDeckOrder: rawConfig.customDeckOrder ? rawConfig.customDeckOrder.slice() : null,
  };

  let phase = PHASES.OFFER;
  let turnNumber = 1;
  let offerId = 1;
  let swapsRemaining = 1;
  let winner = null;
  let loser = null;
  let endReason = null;

  // Immediate post-deal end check (Decision D2): only UNLISTED-0 survived the deal.
  if (totalRemaining === 1) {
    const holder = hands.PLAYER.length === 1 ? SIDES.PLAYER : SIDES.INSPECTOR;
    phase = PHASES.OVER;
    turnNumber = 0;
    offerId = 0;
    swapsRemaining = 0;
    loser = holder;
    winner = otherSide(holder);
    endReason = "DEAL_ALL_PAIRED";
    eventLog.push({
      type: "DUEL_ENDED",
      turnNumber: 0,
      winner,
      loser,
      endReason,
    });
  } else {
    const blockedBySealed = isSealedManifestBlocking(condition, 1);
    swapsRemaining = blockedBySealed ? 0 : 1;
    eventLog.push({
      type: "TURN_STARTED",
      turnNumber: 1,
      offerId: 1,
      offerer: startingOfferer,
      drawer: startingDrawer,
      offererCount: hands[startingOfferer].length,
      drawerCount: hands[startingDrawer].length,
      finalCallSlot: null,
      offererSwapForfeited: blockedBySealed,
    });
  }

  const state = {
    config,
    initialTicketIds,
    phase,
    turnNumber,
    offerId,
    nextSeq: 0,
    offerer: startingOfferer,
    drawer: startingDrawer,
    hands,
    discardPile,
    discardPairs,
    initialDealPairCount,
    initialRemainingPairs,
    playedPairsDiscarded: 0,
    swapsRemaining,
    swapsUsedThisOffer: 0,
    forfeitNextSwap: { PLAYER: false, INSPECTOR: false },
    pendingPublicExposure: {
      PLAYER: { left: false, right: false, nextOfferRight: false },
      INSPECTOR: { left: false, right: false, nextOfferRight: false },
    },
    lastStopPunchArmed: false,
    unlistedStreak: 0,
    finalCallThreshold,
    finalCall: null,
    lockedSlots: [],
    publicReveals: [],
    privateReveals: { PLAYER: [], INSPECTOR: [] },
    privateLoupeClues: { PLAYER: [], INSPECTOR: [] },
    privateEdgeClues: { PLAYER: [], INSPECTOR: [] },
    privateGaugeSafeSlots: { PLAYER: [], INSPECTOR: [] },
    edgeChecksRemaining: { PLAYER: playerEdgeChecks, INSPECTOR: 0 },
    gaugeChargesRemaining: { PLAYER: playerGaugeCharges, INSPECTOR: 0 },
    condition,
    stamps: {
      PLAYER: playerStampIds.map((id) => createDuelStampState(id)),
      INSPECTOR: inspectorStampIds.map((id) => createDuelStampState(id)),
    },
    consumedStamps: { PLAYER: [], INSPECTOR: [] },
    lanterns: { PLAYER: playerLanterns, INSPECTOR: maxLanterns },
    maxLanterns,
    winner,
    loser,
    endReason,
    lastResolution: null,
    lastStampFeedback: null,
    actionLog: [],
    eventLog,
  };

  return deepFreeze(state);
}

export function getActiveActor(state) {
  if (state.phase === PHASES.OFFER) return state.offerer;
  if (state.phase === PHASES.DRAW) return state.drawer;
  return null;
}

export function isSlotLocked(state, slotIndex) {
  return state.lockedSlots.some((lock) => lock.slotIndex === slotIndex);
}

export function getSlotLock(state, slotIndex) {
  return state.lockedSlots.find((lock) => lock.slotIndex === slotIndex) || null;
}

export function getUnlockedSlots(state) {
  const hand = state.hands[state.offerer];
  const slots = [];
  for (let i = 0; i < hand.length; i += 1) {
    if (!isSlotLocked(state, i)) {
      slots.push(i);
    }
  }
  return slots;
}

function isSlotAlreadyVisibleTo(state, viewerSide, ownerSide, slotIndex) {
  if (state.publicReveals.some((r) => r.owner === ownerSide && r.slotIndex === slotIndex)) {
    return true;
  }
  const priv = state.privateReveals[viewerSide] || [];
  if (priv.some((r) => r.owner === ownerSide && r.slotIndex === slotIndex)) {
    return true;
  }
  const lock = ownerSide === state.offerer ? getSlotLock(state, slotIndex) : null;
  if (lock && lock.reason === "FINAL_CALL") {
    return true;
  }
  return false;
}

/**
 * Compute adjacent unlocked slot pairs [(slotA, slotB), ...] for Manifest Loupe.
 */
export function getLoupeAdjacentPairs(unlockedSlots) {
  const pairs = [];
  if (!Array.isArray(unlockedSlots) || unlockedSlots.length < 3) {
    return pairs;
  }
  for (let k = 0; k < unlockedSlots.length - 1; k += 1) {
    pairs.push([unlockedSlots[k], unlockedSlots[k + 1]]);
  }
  return pairs;
}

/**
 * Evaluate exact usability, valid targets, and human-readable status for a single
 * equipped Stamp held by `actor` at the current duel state.
 */
export function getStampUsability(state, actor, stampState) {
  const def = getStampDef(stampState.id);
  const activeActor = getActiveActor(state);
  const base = {
    id: def.id,
    name: def.name,
    phase: def.phase,
    targetType: def.targetType,
    needsTarget: def.targetType !== "NONE",
    spent: Boolean(stampState.spent),
    tokenReady: Boolean(stampState.tokenReady),
    canUse: false,
    statusText: "",
    validTargets: [],
    loupePairs: [],
  };

  if (def.phase === "PASSIVE") {
    base.statusText = stampState.spent
      ? "Used this stop"
      : "Passive (Lantern★ / Watch★)";
    return base;
  }

  if (stampState.spent) {
    base.statusText = "Used this stop";
    return base;
  }

  if (state.phase === PHASES.OVER) {
    base.statusText = "Stop ended";
    return base;
  }

  if (isLateScheduleBlocking(state.condition)) {
    const left = Math.max(
      1,
      (state.condition.requiredPlayedPairs || 3) - state.playedPairsDiscarded
    );
    base.statusText = `Late Schedule (${left} ${left === 1 ? "pair" : "pairs"} left)`;
    return base;
  }

  const isMyTurn = actor === activeActor;
  const inOffer = state.phase === PHASES.OFFER;
  const inDraw = state.phase === PHASES.DRAW;
  const unlocked = getUnlockedSlots(state);

  if (def.id === STAMP_IDS.SPARE_WICK) {
    if (state.lanterns[actor] >= state.maxLanterns) {
      base.statusText = "Lanterns full (3/3)";
      return base;
    }
    if (!isMyTurn) {
      base.statusText = "Wait for your turn";
      return base;
    }
    base.canUse = true;
    base.statusText =
      state.lanterns[actor] <= 1 ? "LAST LANTERN · Burn +1" : "Burn for +1 Lantern";
    return base;
  }

  if (def.id === STAMP_IDS.INSPECTION_WINDOW) {
    if (!isMyTurn || !inDraw) {
      base.statusText = "Ready (use on your Draw)";
      return base;
    }
    if (unlocked.length < 2) {
      base.statusText = "Only 1 open card";
      return base;
    }
    const faceDownUnlocked = unlocked.filter(
      (idx) => !isSlotAlreadyVisibleTo(state, actor, state.offerer, idx)
    );
    if (faceDownUnlocked.length === 0) {
      base.statusText = "All slots already visible";
      return base;
    }
    base.canUse = true;
    base.validTargets = faceDownUnlocked;
    base.statusText = "Ready · Peek 1 slot";
    return base;
  }

  if (def.id === STAMP_IDS.NIGHT_TRANSFER) {
    if (state.hands[actor].length < 3) {
      base.statusText = "Needs 3+ tickets";
      return base;
    }
    if (!isMyTurn || !inOffer) {
      base.statusText = "Ready (use on your Offer)";
      return base;
    }
    if (isSealedManifestBlocking(state.condition, state.turnNumber)) {
      base.statusText = "Blocked by Sealed Manifest";
      return base;
    }
    if (unlocked.length < 2) {
      base.statusText = "Needs 2+ unlocked slots";
      return base;
    }
    base.canUse = true;
    base.statusText = "Ready · +1 Swap";
    return base;
  }

  if (def.id === STAMP_IDS.MANIFEST_LOUPE) {
    if (!isMyTurn || !inDraw) {
      base.statusText = "Ready (use on your Draw)";
      return base;
    }
    if (unlocked.length < 3) {
      base.statusText = "Needs 3+ open Inspector cards";
      return base;
    }
    const pairs = getLoupeAdjacentPairs(unlocked);
    base.canUse = pairs.length > 0;
    base.loupePairs = pairs;
    base.validTargets = pairs.map((p) => p[0]);
    base.statusText = "Ready · Check 2 slots";
    return base;
  }

  if (def.id === STAMP_IDS.BRASS_WEIGHT) {
    if (state.hands[actor].length < 3) {
      base.statusText = "Needs 3+ tickets";
      return base;
    }
    if (!isMyTurn || !inOffer) {
      base.statusText = "Ready (use on your Offer)";
      return base;
    }
    if (unlocked.length < 3) {
      base.statusText = "Needs 3+ unlocked tickets";
      return base;
    }
    const ownHand = state.hands[actor];
    const ordinaryUnlocked = unlocked.filter((idx) => !ownHand[idx].isUnlisted);
    if (ordinaryUnlocked.length === 0) {
      base.statusText = "No normal ticket to lock";
      return base;
    }
    base.canUse = true;
    base.validTargets = ordinaryUnlocked;
    base.statusText = "Ready · Lock 1 ticket";
    return base;
  }

  if (def.id === STAMP_IDS.BELL_CORD) {
    if (!stampState.tokenReady) {
      base.statusText = "Match Key★ or Bell★ first";
      return base;
    }
    if (!isMyTurn || !inDraw) {
      base.statusText = "Charged! (use on your Draw)";
      return base;
    }
    if (unlocked.length < 3) {
      base.statusText = "Needs 3+ open Inspector cards";
      return base;
    }
    base.canUse = true;
    base.statusText = "Charged! · Ring for Emblem★";
    return base;
  }

  if (def.id === STAMP_IDS.LAST_STOP_PUNCH) {
    if (!isMyTurn || !inDraw) {
      base.statusText = "Ready (use on your Draw)";
      return base;
    }
    if (state.unlistedStreak < 1) {
      base.statusText = "Needs Streak 1+";
      return base;
    }
    if (unlocked.length < 3) {
      base.statusText = "Needs 3+ open Inspector cards";
      return base;
    }
    base.canUse = true;
    base.statusText = "Ready · +1 Streak";
    return base;
  }

  return base;
}

/**
 * Evaluate usability of Keepsake tools (Check Edge + The Perforation Gauge) for `actor`.
 */
export function getToolUsability(state, actor) {
  const activeActor = getActiveActor(state);
  const edgeLeft = actor ? state.edgeChecksRemaining[actor] || 0 : 0;
  const gaugeLeft = actor ? state.gaugeChargesRemaining[actor] || 0 : 0;
  const isMyDraw =
    state.phase === PHASES.DRAW && actor !== null && actor === activeActor;

  const unlocked = state.phase === PHASES.DRAW ? getUnlockedSlots(state) : [];

  // Check Edge (Thumb-Worn Tallow): 1/deal in DRAW on 3+ unlocked slots.
  const checkedSet = new Set(
    (actor ? state.privateEdgeClues[actor] || [] : []).map((c) => c.slotIndex)
  );
  const gaugeSafeSet = new Set(
    (actor ? state.privateGaugeSafeSlots[actor] || [] : []).map((c) => c.slotIndex)
  );
  const edgeTargets =
    isMyDraw && edgeLeft > 0 && unlocked.length >= 3
      ? unlocked.filter(
          (idx) =>
            !checkedSet.has(idx) &&
            !gaugeSafeSet.has(idx) &&
            !isSlotAlreadyVisibleTo(state, actor, state.offerer, idx)
        )
      : [];

  // Perforation Gauge (Keystone): marks 1 unknown guaranteed-safe slot on 3+ fan holding Unlisted.
  const offerHand = state.hands[state.offerer] || [];
  const offererHasUnlisted = offerHand.some((t) => t.isUnlisted);
  const confirmedEmblemSet = new Set(
    (actor ? state.privateEdgeClues[actor] || [] : [])
      .filter((c) => c.isEmblem)
      .map((c) => c.slotIndex)
  );
  const unknownSafeSlots =
    isMyDraw && gaugeLeft > 0 && unlocked.length >= 3 && offererHasUnlisted
      ? unlocked.filter(
          (idx) =>
            !offerHand[idx].isUnlisted &&
            !gaugeSafeSet.has(idx) &&
            !confirmedEmblemSet.has(idx) &&
            !isSlotAlreadyVisibleTo(state, actor, state.offerer, idx)
        )
      : [];

  return {
    edgeChecksRemaining: edgeLeft,
    canCheckEdge: edgeTargets.length > 0,
    edgeCheckTargets: edgeTargets,
    gaugeChargesRemaining: gaugeLeft,
    canUseGauge: unknownSafeSlots.length > 0,
    _unknownSafeSlots: unknownSafeSlots,
  };
}

/**
 * Summarize all legal actions (including Stamp & Keepsake tool usability) for `actor`.
 */
export function getLegalActions(state, actor = getActiveActor(state)) {
  const activeActor = getActiveActor(state);
  const stampList = actor && state.stamps[actor] ? state.stamps[actor] : [];
  const stampStatuses = stampList.map((st, idx) => ({
    stampSlot: idx,
    ...getStampUsability(state, actor, st),
  }));
  const usableStampIds = stampStatuses.filter((s) => s.canUse).map((s) => s.id);
  const tools = getToolUsability(state, actor);
  const toolSummary = {
    edgeChecksRemaining: tools.edgeChecksRemaining,
    canCheckEdge: tools.canCheckEdge,
    edgeCheckTargets: tools.edgeCheckTargets,
    gaugeChargesRemaining: tools.gaugeChargesRemaining,
    canUseGauge: tools.canUseGauge,
  };

  if (state.phase === PHASES.OVER || !actor || actor !== activeActor) {
    return {
      actor,
      isMyTurn: false,
      phase: state.phase,
      nextSeq: state.nextSeq,
      canSwap: false,
      swapsRemaining: 0,
      legalSwapSlots: [],
      canCommit: false,
      canDraw: false,
      legalDrawSlots: [],
      usableStampIds: [],
      stampStatuses,
      ...toolSummary,
    };
  }

  const unlocked = getUnlockedSlots(state);

  if (state.phase === PHASES.OFFER) {
    const canSwap = state.swapsRemaining > 0 && unlocked.length >= 2;
    return {
      actor,
      isMyTurn: true,
      phase: state.phase,
      nextSeq: state.nextSeq,
      canSwap,
      swapsRemaining: state.swapsRemaining,
      legalSwapSlots: canSwap ? unlocked : [],
      canCommit: true,
      canDraw: false,
      legalDrawSlots: [],
      usableStampIds,
      stampStatuses,
      ...toolSummary,
    };
  }

  return {
    actor,
    isMyTurn: true,
    phase: state.phase,
    nextSeq: state.nextSeq,
    canSwap: false,
    swapsRemaining: 0,
    legalSwapSlots: [],
    canCommit: false,
    canDraw: unlocked.length > 0,
    legalDrawSlots: unlocked,
    usableStampIds,
    stampStatuses,
    ...toolSummary,
  };
}

function reject(reason, message) {
  return { ok: false, reason, message };
}

/**
 * Pure action validator. Never mutates state.
 */
export function validateAction(state, action) {
  if (!action || typeof action !== "object") {
    return reject(REJECT_REASONS.INVALID_ACTION_OBJECT, "Action must be an object.");
  }

  if (state.phase === PHASES.OVER) {
    return reject(REJECT_REASONS.DUEL_ALREADY_OVER, "The duel has already ended.");
  }

  if (action.seq !== undefined) {
    if (!Number.isInteger(action.seq) || action.seq !== state.nextSeq) {
      return reject(
        REJECT_REASONS.DUPLICATE_OR_STALE_SEQ,
        `Expected action seq ${state.nextSeq}, received ${action.seq}.`
      );
    }
  }

  const { type, actor } = action;
  if (
    type !== ACTION_TYPES.SWAP &&
    type !== ACTION_TYPES.COMMIT_OFFER &&
    type !== ACTION_TYPES.DRAW &&
    type !== ACTION_TYPES.USE_STAMP &&
    type !== ACTION_TYPES.CHECK_EDGE &&
    type !== ACTION_TYPES.USE_GAUGE
  ) {
    return reject(REJECT_REASONS.UNKNOWN_ACTION_TYPE, `Unknown action type: ${String(type)}.`);
  }

  const expectedActor = getActiveActor(state);
  if (!isValidSide(actor) || actor !== expectedActor) {
    return reject(
      REJECT_REASONS.WRONG_ACTOR,
      `Expected actor ${expectedActor}, received ${String(actor)}.`
    );
  }

  const offererHandLen = state.hands[state.offerer].length;

  if (type === ACTION_TYPES.SWAP) {
    if (state.phase !== PHASES.OFFER) {
      return reject(REJECT_REASONS.WRONG_PHASE, "SWAP is only allowed during OFFER_PHASE.");
    }
    if (state.swapsRemaining <= 0) {
      return reject(REJECT_REASONS.NO_SWAPS_REMAINING, "No swaps remaining for this offer.");
    }
    const { indexA, indexB } = action;
    if (
      !Number.isInteger(indexA) ||
      !Number.isInteger(indexB) ||
      indexA < 0 ||
      indexB < 0 ||
      indexA >= offererHandLen ||
      indexB >= offererHandLen
    ) {
      return reject(
        REJECT_REASONS.INVALID_SLOT_INDEX,
        `Swap indices (${indexA}, ${indexB}) out of bounds for hand of size ${offererHandLen}.`
      );
    }
    if (indexA === indexB) {
      return reject(REJECT_REASONS.SAME_SLOT_SWAP, "Swap requires two distinct slot indices.");
    }
    if (isSlotLocked(state, indexA) || isSlotLocked(state, indexB)) {
      return reject(REJECT_REASONS.SLOT_LOCKED, "Cannot swap a locked slot.");
    }
    return { ok: true };
  }

  if (type === ACTION_TYPES.COMMIT_OFFER) {
    if (state.phase !== PHASES.OFFER) {
      return reject(
        REJECT_REASONS.WRONG_PHASE,
        "COMMIT_OFFER is only allowed during OFFER_PHASE."
      );
    }
    return { ok: true };
  }

  if (type === ACTION_TYPES.DRAW) {
    if (state.phase !== PHASES.DRAW) {
      return reject(REJECT_REASONS.WRONG_PHASE, "DRAW is only allowed during DRAW_PHASE.");
    }
    const { slotIndex } = action;
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= offererHandLen) {
      return reject(
        REJECT_REASONS.INVALID_SLOT_INDEX,
        `Draw slotIndex ${slotIndex} out of bounds for hand of size ${offererHandLen}.`
      );
    }
    if (isSlotLocked(state, slotIndex)) {
      return reject(REJECT_REASONS.SLOT_LOCKED, `Slot ${slotIndex} is locked and cannot be drawn.`);
    }
    return { ok: true };
  }

  if (type === ACTION_TYPES.CHECK_EDGE) {
    if (state.phase !== PHASES.DRAW) {
      return reject(REJECT_REASONS.WRONG_PHASE, "CHECK_EDGE is only allowed during DRAW_PHASE.");
    }
    const tools = getToolUsability(state, actor);
    if (!tools.canCheckEdge) {
      return reject(
        REJECT_REASONS.TOOL_UNAVAILABLE,
        "Check Edge is unavailable right now (needs a remaining charge and 3+ open slots)."
      );
    }
    if (!Number.isInteger(action.slotIndex) || !tools.edgeCheckTargets.includes(action.slotIndex)) {
      return reject(
        REJECT_REASONS.INVALID_SLOT_INDEX,
        `Invalid slotIndex ${String(action.slotIndex)} for Check Edge.`
      );
    }
    return { ok: true };
  }

  if (type === ACTION_TYPES.USE_GAUGE) {
    if (state.phase !== PHASES.DRAW) {
      return reject(REJECT_REASONS.WRONG_PHASE, "USE_GAUGE is only allowed during DRAW_PHASE.");
    }
    const tools = getToolUsability(state, actor);
    if (!tools.canUseGauge) {
      return reject(
        REJECT_REASONS.TOOL_UNAVAILABLE,
        "Perforation Gauge requires a remaining charge and 3+ open slots containing The Unlisted."
      );
    }
    return { ok: true };
  }

  // ACTION_TYPES.USE_STAMP
  const { stampId, targetSlot } = action;
  if (typeof stampId !== "string" || !stampId) {
    return reject(REJECT_REASONS.STAMP_UNAVAILABLE, "Missing stampId.");
  }
  const held = state.stamps[actor].find((s) => s.id === stampId);
  if (!held) {
    return reject(REJECT_REASONS.STAMP_UNAVAILABLE, `Stamp ${stampId} is not equipped.`);
  }

  const usability = getStampUsability(state, actor, held);
  if (!usability.canUse) {
    return reject(
      REJECT_REASONS.STAMP_UNAVAILABLE,
      `Stamp ${usability.name} cannot be used right now (${usability.statusText}).`
    );
  }

  if (usability.needsTarget) {
    if (!Number.isInteger(targetSlot) || !usability.validTargets.includes(targetSlot)) {
      return reject(
        REJECT_REASONS.INVALID_STAMP_TARGET,
        `Invalid targetSlot ${String(targetSlot)} for Stamp ${usability.name}.`
      );
    }
  }

  return { ok: true };
}

function normalizeRecordedAction(action, seq) {
  if (action.type === ACTION_TYPES.SWAP) {
    return {
      seq,
      type: ACTION_TYPES.SWAP,
      actor: action.actor,
      indexA: action.indexA,
      indexB: action.indexB,
    };
  }
  if (action.type === ACTION_TYPES.COMMIT_OFFER) {
    return {
      seq,
      type: ACTION_TYPES.COMMIT_OFFER,
      actor: action.actor,
    };
  }
  if (action.type === ACTION_TYPES.DRAW) {
    return {
      seq,
      type: ACTION_TYPES.DRAW,
      actor: action.actor,
      slotIndex: action.slotIndex,
    };
  }
  if (action.type === ACTION_TYPES.CHECK_EDGE) {
    return {
      seq,
      type: ACTION_TYPES.CHECK_EDGE,
      actor: action.actor,
      slotIndex: action.slotIndex,
    };
  }
  if (action.type === ACTION_TYPES.USE_GAUGE) {
    return {
      seq,
      type: ACTION_TYPES.USE_GAUGE,
      actor: action.actor,
    };
  }
  // USE_STAMP
  const rec = {
    seq,
    type: ACTION_TYPES.USE_STAMP,
    actor: action.actor,
    stampId: action.stampId,
  };
  if (Number.isInteger(action.targetSlot)) {
    rec.targetSlot = action.targetSlot;
  }
  return rec;
}

function addPublicRevealDeduped(next, owner, slotIndex, source) {
  const hand = next.hands[owner];
  if (slotIndex < 0 || slotIndex >= hand.length) return false;
  // Decision D8: overlapping public exposures on the same slot reveal that slot only once.
  if (next.publicReveals.some((r) => r.owner === owner && r.slotIndex === slotIndex)) {
    return false;
  }
  if (next.lockedSlots.some((l) => l.slotIndex === slotIndex && l.reason === "FINAL_CALL")) {
    return false;
  }
  next.publicReveals.push({
    owner,
    slotIndex,
    ticket: hand[slotIndex],
    source,
    offerId: next.offerId,
  });
  return true;
}

function resolveStampAction(state, next, action, events) {
  const { actor, stampId, targetSlot } = action;
  const stampIdx = next.stamps[actor].findIndex((s) => s.id === stampId);
  const stamp = next.stamps[actor][stampIdx];
  const unlocked = getUnlockedSlots(state);

  if (stampId === STAMP_IDS.INSPECTION_WINDOW) {
    const peeked = next.hands[next.offerer][targetSlot];
    next.privateReveals[actor].push({
      owner: next.offerer,
      slotIndex: targetSlot,
      ticket: peeked,
      source: STAMP_IDS.INSPECTION_WINDOW,
      offerId: next.offerId,
    });
    stamp.spent = true;
    next.forfeitNextSwap[actor] = true;

    const pubEv = {
      type: "STAMP_USED",
      turnNumber: next.turnNumber,
      offerId: next.offerId,
      actor,
      stampId,
      forfeitsNextSwap: true,
    };
    const privEv = {
      type: "PRIVATE_REVEAL",
      privateTo: actor,
      turnNumber: next.turnNumber,
      offerId: next.offerId,
      slotIndex: targetSlot,
      symbolId: peeked.symbolId,
      isUnlisted: peeked.isUnlisted,
    };
    events.push(pubEv, privEv);
    next.eventLog.push(pubEv, privEv);
    next.lastStampFeedback = {
      actor,
      stampId,
      message: `Inspection Window: Slot #${targetSlot + 1} is ${peeked.name}. (Your next Offer cannot swap.)`,
    };
    return;
  }

  if (stampId === STAMP_IDS.NIGHT_TRANSFER) {
    next.swapsRemaining += 1;
    stamp.spent = true;
    const ev = {
      type: "STAMP_USED",
      turnNumber: next.turnNumber,
      offerId: next.offerId,
      actor,
      stampId,
      grantedSwap: true,
    };
    events.push(ev);
    next.eventLog.push(ev);
    next.lastStampFeedback = {
      actor,
      stampId,
      message: `Night Transfer stamped: ${next.swapsRemaining} private ${
        next.swapsRemaining === 1 ? "swap" : "swaps"
      } available on this Offer.`,
    };
    return;
  }

  if (stampId === STAMP_IDS.SPARE_WICK) {
    next.lanterns[actor] = Math.min(next.maxLanterns, next.lanterns[actor] + 1);
    next.stamps[actor].splice(stampIdx, 1);
    next.consumedStamps[actor].push(stampId);
    const ev = {
      type: "STAMP_USED",
      turnNumber: next.turnNumber,
      offerId: next.offerId,
      actor,
      stampId,
      consumed: true,
      lanternsAfter: next.lanterns[actor],
    };
    events.push(ev);
    next.eventLog.push(ev);
    next.lastStampFeedback = {
      actor,
      stampId,
      message: `Spare Wick burned: restored +1 Lantern (${next.lanterns[actor]}/${next.maxLanterns}). Stamp discarded.`,
    };
    return;
  }

  if (stampId === STAMP_IDS.MANIFEST_LOUPE) {
    const pairs = getLoupeAdjacentPairs(unlocked);
    const chosenPair = pairs.find((p) => p[0] === targetSlot);
    const [slotA, slotB] = chosenPair;
    const hand = next.hands[next.offerer];
    const hasUnlisted = Boolean(hand[slotA].isUnlisted || hand[slotB].isUnlisted);

    next.privateLoupeClues[actor].push({
      offerId: next.offerId,
      slotA,
      slotB,
      hasUnlisted,
    });
    stamp.spent = true;
    next.pendingPublicExposure[actor].left = true;

    const pubEv = {
      type: "STAMP_USED",
      turnNumber: next.turnNumber,
      offerId: next.offerId,
      actor,
      stampId,
      queuesLeftExposure: true,
    };
    const privEv = {
      type: "PRIVATE_LOUPE",
      privateTo: actor,
      turnNumber: next.turnNumber,
      offerId: next.offerId,
      slotA,
      slotB,
      hasUnlisted,
    };
    events.push(pubEv, privEv);
    next.eventLog.push(pubEv, privEv);
    next.lastStampFeedback = {
      actor,
      stampId,
      message: hasUnlisted
        ? `Manifest Loupe: YES — The Unlisted hides in Slot #${slotA + 1} or #${slotB + 1}! (Other slots are safe. Next Offer exposes your leftmost ticket.)`
        : `Manifest Loupe: NO — Slots #${slotA + 1} and #${slotB + 1} are BOTH safe pairs! (Next Offer exposes your leftmost ticket.)`,
    };
    return;
  }

  if (stampId === STAMP_IDS.BRASS_WEIGHT) {
    const lockedCard = next.hands[actor][targetSlot];
    next.lockedSlots.push({
      slotIndex: targetSlot,
      reason: "BRASS_WEIGHT",
      ticketId: lockedCard.ticketId,
      public: true,
    });
    stamp.spent = true;
    // Brass Weight is played during OFFER_PHASE, so queue right-edge exposure for the
    // actor's NEXT Offer turn (promoted after this offer commits), matching RULES.md §8.2.
    next.pendingPublicExposure[actor].nextOfferRight = true;

    const ev = {
      type: "STAMP_USED",
      turnNumber: next.turnNumber,
      offerId: next.offerId,
      actor,
      stampId,
      lockedSlot: targetSlot,
      queuesRightExposure: true,
    };
    events.push(ev);
    next.eventLog.push(ev);
    next.lastStampFeedback = {
      actor,
      stampId,
      message: `Brass Weight set on Slot #${targetSlot + 1} (${lockedCard.shortLabel}) — cannot be drawn this turn. (Next Offer exposes your rightmost ticket.)`,
    };
    return;
  }

  if (stampId === STAMP_IDS.BELL_CORD) {
    const offerHand = next.hands[next.offerer];
    const emblemCandidates = unlocked.filter(
      (idx) =>
        offerHand[idx].isEmblem &&
        !next.publicReveals.some((r) => r.owner === next.offerer && r.slotIndex === idx)
    );

    let revealedSlot = null;
    let revealedName = null;
    if (emblemCandidates.length > 0) {
      // Deterministic choice derived from encounter seed + action seq for exact replayability.
      const bellRng = createRng(
        deriveSeed(next.config.encounterSeed, `bell:${next.nextSeq - 1}`)
      );
      revealedSlot = bellRng.pick(emblemCandidates);
      addPublicRevealDeduped(next, next.offerer, revealedSlot, STAMP_IDS.BELL_CORD);
      revealedName = offerHand[revealedSlot].name;
    }

    stamp.spent = true;
    stamp.tokenReady = false;
    next.forfeitNextSwap[actor] = true;

    const ev = {
      type: "STAMP_USED",
      turnNumber: next.turnNumber,
      offerId: next.offerId,
      actor,
      stampId,
      revealedSlot,
      foundEmblem: revealedSlot !== null,
      forfeitsNextSwap: true,
    };
    events.push(ev);
    next.eventLog.push(ev);
    next.lastStampFeedback = {
      actor,
      stampId,
      message:
        revealedSlot !== null
          ? `Bell Cord rang: revealed ${revealedName}★ at Slot #${revealedSlot + 1}! (Your next Offer cannot swap.)`
          : "Bell Cord rang: no hidden Emblem★ tickets remain in the offered fan. (Your next Offer cannot swap.)",
    };
    return;
  }

  if (stampId === STAMP_IDS.LAST_STOP_PUNCH) {
    next.unlistedStreak += 1;
    next.lastStopPunchArmed = true;
    stamp.spent = true;

    const ev = {
      type: "STAMP_USED",
      turnNumber: next.turnNumber,
      offerId: next.offerId,
      actor,
      stampId,
      unlistedStreakAfter: next.unlistedStreak,
    };
    events.push(ev);
    next.eventLog.push(ev);
    next.lastStampFeedback = {
      actor,
      stampId,
      message: `Last-Stop Punch: Streak raised to ${next.unlistedStreak}/${next.finalCallThreshold}. (Drawing a normal pair will expose your leftmost ticket next Offer.)`,
    };
  }
}

/**
 * Resolve passive Stamp triggers when `drawer` discards an Emblem pair during play.
 */
function resolvePairStampTriggers(next, drawer, matchedPair, events) {
  const heldStamps = next.stamps[drawer];
  if (!heldStamps || heldStamps.length === 0) return [];

  const triggeredNotes = [];
  const sym = matchedPair.symbolId;

  // 1. Carbon Copy: LANTERN or WATCH refills 1 spent Inspection Stamp (1/stop).
  if (sym === "LANTERN" || sym === "WATCH") {
    const carbon = heldStamps.find((s) => s.id === STAMP_IDS.CARBON_COPY && !s.spent);
    if (carbon) {
      const spentInsp = heldStamps.find((s) => {
        const def = getStampDef(s.id);
        return def && def.isInspection && s.spent;
      });
      if (spentInsp) {
        spentInsp.spent = false;
        carbon.spent = true;
        const refreshedDef = getStampDef(spentInsp.id);
        const ev = {
          type: "STAMP_TRIGGERED",
          turnNumber: next.turnNumber,
          offerId: next.offerId,
          actor: drawer,
          stampId: STAMP_IDS.CARBON_COPY,
          triggerSymbolId: sym,
          refreshedStampId: spentInsp.id,
        };
        events.push(ev);
        next.eventLog.push(ev);
        triggeredNotes.push(`Carbon Copy refilled ${refreshedDef.name}!`);
      }
    }
  }

  // 2. Bell Cord: KEY or BELL charges its Signal Token (1/stop).
  if (sym === "KEY" || sym === "BELL") {
    const cord = heldStamps.find(
      (s) => s.id === STAMP_IDS.BELL_CORD && !s.spent && !s.tokenReady
    );
    if (cord) {
      cord.tokenReady = true;
      const ev = {
        type: "STAMP_TRIGGERED",
        turnNumber: next.turnNumber,
        offerId: next.offerId,
        actor: drawer,
        stampId: STAMP_IDS.BELL_CORD,
        triggerSymbolId: sym,
        grantedToken: true,
      };
      events.push(ev);
      next.eventLog.push(ev);
      triggeredNotes.push("Bell Cord charged and ready to ring!");
    }
  }

  return triggeredNotes;
}

/**
 * Apply one validated action and return a brand-new frozen duel state plus new events.
 */
export function applyAction(state, action) {
  const check = validateAction(state, action);
  if (!check.ok) {
    return {
      ok: false,
      state,
      reason: check.reason,
      message: check.message,
      events: [],
    };
  }

  const next = cloneMutableState(state);
  const events = [];
  const recorded = normalizeRecordedAction(action, state.nextSeq);
  next.actionLog.push(recorded);
  next.nextSeq = state.nextSeq + 1;

  if (action.type === ACTION_TYPES.USE_STAMP) {
    resolveStampAction(state, next, action, events);
    return { ok: true, state: deepFreeze(next), events: deepFreeze(events) };
  }

  if (action.type === ACTION_TYPES.CHECK_EDGE) {
    const { actor, slotIndex } = action;
    const card = next.hands[next.offerer][slotIndex];
    const isEmblem = Boolean(card.isEmblem);
    next.edgeChecksRemaining[actor] = Math.max(0, next.edgeChecksRemaining[actor] - 1);
    next.privateEdgeClues[actor].push({
      offerId: next.offerId,
      slotIndex,
      isEmblem,
    });
    const pubEv = {
      type: "EDGE_CHECKED",
      turnNumber: next.turnNumber,
      offerId: next.offerId,
      actor,
      slotIndex,
    };
    const privEv = {
      type: "PRIVATE_EDGE_CLUE",
      privateTo: actor,
      turnNumber: next.turnNumber,
      offerId: next.offerId,
      slotIndex,
      isEmblem,
    };
    events.push(pubEv, privEv);
    next.eventLog.push(pubEv, privEv);
    next.lastStampFeedback = {
      actor,
      stampId: "CHECK_EDGE",
      message: isEmblem
        ? `Check Edge: Slot #${slotIndex + 1} has a raised ★ EMBLEM border — 100% safe pair!`
        : `Check Edge: Slot #${slotIndex + 1} is Plain/Blank stock (either an ordinary ticket or The Unlisted).`,
    };
    return { ok: true, state: deepFreeze(next), events: deepFreeze(events) };
  }

  if (action.type === ACTION_TYPES.USE_GAUGE) {
    const { actor } = action;
    const tools = getToolUsability(state, actor);
    const gaugeRng = createRng(
      deriveSeed(next.config.encounterSeed, `gauge:${next.nextSeq - 1}`)
    );
    const safeSlot = gaugeRng.pick(tools._unknownSafeSlots);
    const card = next.hands[next.offerer][safeSlot];
    const isEmblem = Boolean(card.isEmblem);
    next.gaugeChargesRemaining[actor] = Math.max(0, next.gaugeChargesRemaining[actor] - 1);
    next.privateGaugeSafeSlots[actor].push({
      offerId: next.offerId,
      slotIndex: safeSlot,
      isEmblem,
    });
    const pubEv = {
      type: "GAUGE_USED",
      turnNumber: next.turnNumber,
      offerId: next.offerId,
      actor,
    };
    const privEv = {
      type: "PRIVATE_GAUGE_SAFE",
      privateTo: actor,
      turnNumber: next.turnNumber,
      offerId: next.offerId,
      slotIndex: safeSlot,
      isEmblem,
    };
    events.push(pubEv, privEv);
    next.eventLog.push(pubEv, privEv);
    next.lastStampFeedback = {
      actor,
      stampId: "PERFORATION_GAUGE",
      message: isEmblem
        ? `Perforation Gauge: Slot #${safeSlot + 1} is GUARANTEED SAFE (★ Emblem stock — unpunched)!`
        : `Perforation Gauge: Slot #${safeSlot + 1} is GUARANTEED SAFE (solid unpunched ticket)!`,
    };
    return { ok: true, state: deepFreeze(next), events: deepFreeze(events) };
  }

  if (action.type === ACTION_TYPES.SWAP) {
    const hand = next.hands[next.offerer];
    const tmp = hand[action.indexA];
    hand[action.indexA] = hand[action.indexB];
    hand[action.indexB] = tmp;
    next.swapsRemaining -= 1;
    next.swapsUsedThisOffer += 1;
    next.lastStampFeedback = null;

    const ev = {
      type: "SWAP_PERFORMED",
      privateTo: next.offerer,
      turnNumber: next.turnNumber,
      offerId: next.offerId,
      actor: next.offerer,
      indexA: action.indexA,
      indexB: action.indexB,
    };
    events.push(ev);
    next.eventLog.push(ev);
    return { ok: true, state: deepFreeze(next), events: deepFreeze(events) };
  }

  if (action.type === ACTION_TYPES.COMMIT_OFFER) {
    next.phase = PHASES.DRAW;
    next.lastStampFeedback = null;

    const unlockedNow = getUnlockedSlots(next);
    const exposedSlots = [];

    // 1. Drafty Window condition exposure (Turns 1–4, fans of 3+).
    if (
      next.condition &&
      !next.condition.expired &&
      next.condition.id === CONDITION_IDS.DRAFTY_WINDOW &&
      next.hands[next.offerer].length >= 3 &&
      unlockedNow.length > 0
    ) {
      if (addPublicRevealDeduped(next, next.offerer, unlockedNow[0], CONDITION_IDS.DRAFTY_WINDOW)) {
        exposedSlots.push(unlockedNow[0]);
      }
    }

    // 2. Pending public exposures from Stamp tradeoffs (Manifest Loupe, Brass Weight, Last-Stop Punch).
    const pendingExp = next.pendingPublicExposure[next.offerer];
    // Promote any Brass Weight exposure earned during THIS offer so it triggers on the NEXT offer.
    next.pendingPublicExposure[next.offerer] = {
      left: false,
      right: Boolean(pendingExp.nextOfferRight),
      nextOfferRight: false,
    };

    if (pendingExp.left && unlockedNow.length > 0) {
      if (addPublicRevealDeduped(next, next.offerer, unlockedNow[0], "STAMP_EXPOSURE_LEFT")) {
        exposedSlots.push(unlockedNow[0]);
      }
    }
    if (pendingExp.right && unlockedNow.length > 0) {
      const rightSlot = unlockedNow[unlockedNow.length - 1];
      if (addPublicRevealDeduped(next, next.offerer, rightSlot, "STAMP_EXPOSURE_RIGHT")) {
        exposedSlots.push(rightSlot);
      }
    }

    const ev = {
      type: "OFFER_COMMITTED",
      turnNumber: next.turnNumber,
      offerId: next.offerId,
      offerer: next.offerer,
      drawer: next.drawer,
      fanSize: next.hands[next.offerer].length,
      finalCallSlot: next.finalCall ? next.finalCall.slotIndex : null,
      publicRevealSlot: exposedSlots.length > 0 ? exposedSlots[0] : null,
      publicRevealSlots: exposedSlots,
    };
    events.push(ev);
    next.eventLog.push(ev);
    return { ok: true, state: deepFreeze(next), events: deepFreeze(events) };
  }

  // ACTION_TYPES.DRAW
  const offerer = next.offerer;
  const drawer = next.drawer;
  const offererHand = next.hands[offerer];
  const drawerHand = next.hands[drawer];
  const offererHandSizeBefore = offererHand.length;
  const legalDrawCountBefore = getUnlockedSlots(state).length;
  const wasFinalCall = Boolean(state.finalCall && state.finalCall.active);
  const punchWasArmed = Boolean(state.lastStopPunchArmed);
  next.lastStopPunchArmed = false;
  next.lastStampFeedback = null;

  // 1. Transfer chosen ticket to right end of drawer's hand (Decision D4).
  const [drawnTicket] = offererHand.splice(action.slotIndex, 1);
  drawerHand.push(drawnTicket);
  const arrivalIndex = drawerHand.length - 1;

  let matchedPair = null;
  let stampTriggerNotes = [];

  // 2. Resolve Unlisted transfer vs. matching pair discard + pair Stamp effects.
  if (drawnTicket.isUnlisted) {
    next.unlistedStreak += 1;
  } else {
    const twinIdx = drawerHand.findIndex(
      (t) =>
        !t.isUnlisted &&
        t.symbolId === drawnTicket.symbolId &&
        t.ticketId !== drawnTicket.ticketId
    );
    if (twinIdx !== -1) {
      const twinTicket = drawerHand[twinIdx];
      next.hands[drawer] = drawerHand.filter(
        (t) => t.ticketId !== twinTicket.ticketId && t.ticketId !== drawnTicket.ticketId
      );
      next.discardPile.push(twinTicket, drawnTicket);
      matchedPair = {
        pairNumber: next.discardPairs.length + 1,
        owner: drawer,
        source: "DRAW",
        turnNumber: next.turnNumber,
        symbolId: drawnTicket.symbolId,
        isEmblem: drawnTicket.isEmblem,
        ticketIds: [twinTicket.ticketId, drawnTicket.ticketId],
        tickets: [twinTicket, drawnTicket],
      };
      next.discardPairs.push(matchedPair);
      next.playedPairsDiscarded += 1;
      next.unlistedStreak = 0;

      // Last-Stop Punch tradeoff: matching a normal pair queues left-slot exposure on next offer.
      if (punchWasArmed) {
        next.pendingPublicExposure[drawer].left = true;
      }
    } else if (wasFinalCall) {
      next.unlistedStreak = 0;
    }
  }

  if (wasFinalCall && !drawnTicket.isUnlisted) {
    next.unlistedStreak = 0;
  }

  const drawEv = {
    type: "TICKET_DRAWN",
    turnNumber: next.turnNumber,
    offerId: next.offerId,
    offerer,
    drawer,
    slotIndex: action.slotIndex,
    offererHandSizeBefore,
    legalDrawCountBefore,
    drewUnlisted: drawnTicket.isUnlisted,
    matchedSymbolId: matchedPair ? matchedPair.symbolId : null,
    wasFinalCall,
    unlistedStreakAfter: next.unlistedStreak,
    arrivalIndex: drawnTicket.isUnlisted ? arrivalIndex : null,
  };
  events.push(drawEv);
  next.eventLog.push(drawEv);

  if (matchedPair) {
    const pairEv = {
      type: "PAIR_DISCARDED",
      turnNumber: next.turnNumber,
      offerId: next.offerId,
      owner: drawer,
      symbolId: matchedPair.symbolId,
      isEmblem: matchedPair.isEmblem,
      ticketIds: matchedPair.ticketIds.slice(),
    };
    events.push(pairEv);
    next.eventLog.push(pairEv);

    stampTriggerNotes = resolvePairStampTriggers(next, drawer, matchedPair, events);

    // Check pair-based Late Schedule condition expiration immediately.
    if (
      next.condition &&
      !next.condition.expired &&
      next.condition.id === CONDITION_IDS.LATE_SCHEDULE &&
      next.playedPairsDiscarded >= next.condition.requiredPlayedPairs
    ) {
      next.condition = { ...next.condition, expired: true };
      const expEv = {
        type: "CONDITION_EXPIRED",
        turnNumber: next.turnNumber,
        conditionId: next.condition.id,
      };
      events.push(expEv);
      next.eventLog.push(expEv);
    }
  }

  // 3. Clear turn-scoped locks & reveals from the resolved offer (Decision D6).
  next.finalCall = null;
  next.lockedSlots = [];
  next.publicReveals = [];
  next.privateReveals = { PLAYER: [], INSPECTOR: [] };
  next.privateLoupeClues = { PLAYER: [], INSPECTOR: [] };
  next.privateEdgeClues = { PLAYER: [], INSPECTOR: [] };
  next.privateGaugeSafeSlots = { PLAYER: [], INSPECTOR: [] };
  next.swapsUsedThisOffer = 0;

  next.lastResolution = {
    turnNumber: next.turnNumber,
    offerId: next.offerId,
    offerer,
    drawer,
    slotIndex: action.slotIndex,
    offererHandSizeBefore,
    legalDrawCountBefore,
    drawnTicket,
    drewUnlisted: drawnTicket.isUnlisted,
    matchedPair,
    stampTriggerNotes,
    wasFinalCall,
    unlistedStreakAfter: next.unlistedStreak,
  };

  // 4. End-of-duel check: ends immediately when only UNLISTED-0 remains.
  const totalRemaining = next.hands.PLAYER.length + next.hands.INSPECTOR.length;
  if (totalRemaining <= 1) {
    const holder = next.hands.PLAYER.some((t) => t.isUnlisted)
      ? SIDES.PLAYER
      : SIDES.INSPECTOR;
    next.phase = PHASES.OVER;
    next.swapsRemaining = 0;
    next.loser = holder;
    next.winner = otherSide(holder);
    next.endReason = "ONLY_UNLISTED_REMAINS";

    const endEv = {
      type: "DUEL_ENDED",
      turnNumber: next.turnNumber,
      winner: next.winner,
      loser: next.loser,
      endReason: next.endReason,
    };
    events.push(endEv);
    next.eventLog.push(endEv);
    return { ok: true, state: deepFreeze(next), events: deepFreeze(events) };
  }

  // 5. Switch roles for next turn (with defensive non-empty-hand safety).
  let nextOfferer = drawer;
  let nextDrawer = offerer;
  if (next.hands[nextOfferer].length === 0) {
    nextOfferer = offerer;
    nextDrawer = drawer;
  }

  next.offerer = nextOfferer;
  next.drawer = nextDrawer;
  next.turnNumber += 1;
  next.offerId += 1;
  next.phase = PHASES.OFFER;

  // Advance turn-based Carriage Condition expiration (Sealed Manifest @ T3, Drafty Window @ T5).
  if (
    next.condition &&
    !next.condition.expired &&
    Number.isInteger(next.condition.activeThroughTurn) &&
    next.turnNumber > next.condition.activeThroughTurn
  ) {
    next.condition = { ...next.condition, expired: true };
    const expEv = {
      type: "CONDITION_EXPIRED",
      turnNumber: next.turnNumber,
      conditionId: next.condition.id,
    };
    events.push(expEv);
    next.eventLog.push(expEv);
  }

  // 6. Check Final Call trigger on incoming offerer.
  if (next.unlistedStreak >= next.finalCallThreshold) {
    const fc = evaluateFinalCall(next.hands[nextOfferer], {
      unlistedStreak: next.unlistedStreak,
      threshold: next.finalCallThreshold,
      existingLockedIndices: [],
    });

    if (fc.triggered) {
      next.finalCall = fc.finalCall;
      next.lockedSlots = [fc.lockedSlot];
      const fcEv = {
        type: "FINAL_CALL_TRIGGERED",
        turnNumber: next.turnNumber,
        offerId: next.offerId,
        offerer: nextOfferer,
        slotIndex: fc.finalCall.slotIndex,
        streak: next.unlistedStreak,
      };
      events.push(fcEv);
      next.eventLog.push(fcEv);
    } else if (fc.waived) {
      next.finalCall = null;
      next.lockedSlots = [];
      next.unlistedStreak = 0;
      const waiveEv = {
        type: "FINAL_CALL_WAIVED",
        turnNumber: next.turnNumber,
        offerId: next.offerId,
        offerer: nextOfferer,
        reason: fc.waiveReason,
      };
      events.push(waiveEv);
      next.eventLog.push(waiveEv);
    }
  }

  // 7. Compute swapsRemaining for incoming offerer (Sealed Manifest + Stamp swap forfeits).
  const sealedBlock = isSealedManifestBlocking(next.condition, next.turnNumber);
  const forfeitBlock = Boolean(next.forfeitNextSwap[nextOfferer]);
  if (forfeitBlock) {
    next.forfeitNextSwap[nextOfferer] = false;
  }
  const canSwapThisOffer = !sealedBlock && !forfeitBlock;
  next.swapsRemaining = canSwapThisOffer ? 1 : 0;

  const turnEv = {
    type: "TURN_STARTED",
    turnNumber: next.turnNumber,
    offerId: next.offerId,
    offerer: nextOfferer,
    drawer: nextDrawer,
    offererCount: next.hands[nextOfferer].length,
    drawerCount: next.hands[nextDrawer].length,
    finalCallSlot: next.finalCall ? next.finalCall.slotIndex : null,
    offererSwapForfeited: !canSwapThisOffer,
  };
  events.push(turnEv);
  next.eventLog.push(turnEv);

  return { ok: true, state: deepFreeze(next), events: deepFreeze(events) };
}

/**
 * Export a complete pure-data replay bundle from any duel state.
 */
export function exportReplay(state) {
  return {
    config: {
      encounterSeed: state.config.encounterSeed,
      pairCount: state.config.pairCount,
      encounterIndex: state.config.encounterIndex,
      startingOfferer: state.config.startingOfferer,
      finalCallThreshold: state.config.finalCallThreshold,
      allowSmallTutorialDeck: state.config.allowSmallTutorialDeck,
      conditionId: state.config.conditionId,
      playerStamps: state.config.playerStamps.slice(),
      inspectorStamps: state.config.inspectorStamps.slice(),
      playerLanterns: state.config.playerLanterns,
      maxLanterns: state.config.maxLanterns,
      playerEdgeChecks: state.config.playerEdgeChecks,
      playerGaugeCharges: state.config.playerGaugeCharges,
      customDeckOrder: state.config.customDeckOrder
        ? state.config.customDeckOrder.slice()
        : null,
    },
    actions: state.actionLog.map((a) => ({ ...a })),
  };
}

/**
 * Deterministically replay a duel from its exported config + legal action log.
 */
export function replayDuel({ config, actions }) {
  let state = createDuel(config);
  if (!Array.isArray(actions)) {
    return { ok: false, state, failedIndex: 0, reason: "INVALID_ACTIONS_ARRAY" };
  }

  for (let i = 0; i < actions.length; i += 1) {
    const res = applyAction(state, actions[i]);
    if (!res.ok) {
      return {
        ok: false,
        state,
        failedIndex: i,
        reason: res.reason,
        message: res.message,
      };
    }
    state = res.state;
  }

  return { ok: true, state };
}

/**
 * Rigorous invariant verifier checking card conservation, legal-only pair discards,
 * hand parity, Stamp/Final Call lock legality, and zero-deadlock guarantees.
 */
export function verifyInvariants(state) {
  const errors = [];
  const expectedTotal = state.config.pairCount * 2 + 1;

  const allLive = [
    ...state.hands.PLAYER,
    ...state.hands.INSPECTOR,
    ...state.discardPile,
  ];

  if (allLive.length !== expectedTotal) {
    errors.push(`Expected ${expectedTotal} total tickets, found ${allLive.length}.`);
  }

  const expectedSet = new Set(state.initialTicketIds);
  const seenIds = new Set();
  for (const ticket of allLive) {
    if (!ticket || typeof ticket.ticketId !== "string") {
      errors.push("Encountered malformed ticket object.");
      continue;
    }
    if (!expectedSet.has(ticket.ticketId)) {
      errors.push(`Foreign ticketId found: ${ticket.ticketId}.`);
    }
    if (seenIds.has(ticket.ticketId)) {
      errors.push(`Duplicate ticketId found: ${ticket.ticketId}.`);
    }
    seenIds.add(ticket.ticketId);
  }

  for (const id of expectedSet) {
    if (!seenIds.has(id)) {
      errors.push(`Missing ticketId: ${id}.`);
    }
  }

  if (state.discardPile.some((t) => t.isUnlisted || t.ticketId === UNLISTED_ID)) {
    errors.push("UNLISTED-0 was illegally discarded.");
  }
  const playerHasUnlisted = state.hands.PLAYER.filter((t) => t.isUnlisted).length;
  const inspectorHasUnlisted = state.hands.INSPECTOR.filter((t) => t.isUnlisted).length;
  if (playerHasUnlisted + inspectorHasUnlisted !== 1) {
    errors.push(
      `Expected exactly 1 UNLISTED-0 in hands, found ${playerHasUnlisted + inspectorHasUnlisted}.`
    );
  }

  if (state.discardPile.length % 2 !== 0) {
    errors.push(`discardPile has odd length ${state.discardPile.length}.`);
  }
  if (state.discardPairs.length * 2 !== state.discardPile.length) {
    errors.push("discardPairs count does not match discardPile length.");
  }
  for (let i = 0; i < state.discardPile.length; i += 2) {
    const a = state.discardPile[i];
    const b = state.discardPile[i + 1];
    if (!a || !b) continue;
    if (a.isUnlisted || b.isUnlisted) {
      errors.push("Discard pair contains Unlisted.");
    }
    if (a.symbolId !== b.symbolId) {
      errors.push(`Mismatched discard pair: ${a.ticketId} paired with ${b.ticketId}.`);
    }
    if (a.ticketId === b.ticketId) {
      errors.push(`Self-paired duplicate ticket in discard: ${a.ticketId}.`);
    }
  }

  for (const side of [SIDES.PLAYER, SIDES.INSPECTOR]) {
    const syms = new Set();
    for (const t of state.hands[side]) {
      if (t.isUnlisted) continue;
      if (syms.has(t.symbolId)) {
        errors.push(`${side} hand retains un-discarded pair of ${t.symbolId}.`);
      }
      syms.add(t.symbolId);
    }
  }

  const holder = playerHasUnlisted === 1 ? SIDES.PLAYER : SIDES.INSPECTOR;
  const nonHolder = otherSide(holder);
  if (state.hands[holder].length !== state.hands[nonHolder].length + 1) {
    errors.push(
      `Hand parity broken: holder ${holder} has ${state.hands[holder].length}, ${nonHolder} has ${state.hands[nonHolder].length}.`
    );
  }

  if (state.lanterns.PLAYER < 0 || state.lanterns.PLAYER > state.maxLanterns) {
    errors.push(`Player lanterns out of bounds: ${state.lanterns.PLAYER}/${state.maxLanterns}.`);
  }

  const remainingInHands = state.hands.PLAYER.length + state.hands.INSPECTOR.length;
  if (state.phase === PHASES.OVER) {
    if (remainingInHands !== 1) {
      errors.push(`DUEL_OVER reached with ${remainingInHands} tickets remaining.`);
    }
    if (state.loser !== holder || state.winner !== nonHolder) {
      errors.push(
        `Wrong winner/loser: winner=${state.winner}, loser=${state.loser}, unlistedHolder=${holder}.`
      );
    }
  } else {
    if (remainingInHands <= 1) {
      errors.push("Duel remained active with <= 1 ticket remaining.");
    }
    if (state.hands[state.offerer].length < 1) {
      errors.push(`Active offerer ${state.offerer} has an empty hand.`);
    }
    const legal = getLegalActions(state);
    if (state.phase === PHASES.OFFER && !legal.canCommit) {
      errors.push("Deadlock: OFFER_PHASE cannot commit.");
    }
    if (state.phase === PHASES.DRAW && legal.legalDrawSlots.length < 1) {
      errors.push("Deadlock: DRAW_PHASE has zero legal draw slots.");
    }
    for (const lock of state.lockedSlots) {
      if (lock.reason === "BRASS_WEIGHT") {
        const card = state.hands[state.offerer][lock.slotIndex];
        if (!card || card.isUnlisted) {
          errors.push("Brass Weight illegally locked UNLISTED-0.");
        }
      }
    }
    if (state.finalCall && state.finalCall.active) {
      const slot = state.finalCall.slotIndex;
      const markedCard = state.hands[state.offerer][slot];
      if (!markedCard || !markedCard.isUnlisted) {
        errors.push(`Final Call slot ${slot} does not hold UNLISTED-0.`);
      }
      if (state.hands[state.offerer].length < 2) {
        errors.push("Final Call illegally active on a hand of size < 2.");
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
