/**
 * src/core/engine.js
 * Pure deterministic rules engine for The Unlisted.
 *
 * Serves both PLAYER and INSPECTOR identically. Never mutates input state,
 * never reads wall-clock time or Math.random, and never calls UI or audio.
 */

import { createRng, normalizeSeed } from "./rng.js";
import {
  DEFAULT_PAIRS,
  MAX_PAIRS,
  MIN_PAIRS,
  UNLISTED_ID,
  UNLISTED_SYMBOL,
  buildDeck,
} from "../data/tickets.js";

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
 * Preserves relative slot order of all surviving tickets. Never pairs UNLISTED-0.
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
 * If locking UNLISTED-0 leaves >= 1 drawable slot, marks & locks UNLISTED-0.
 * If locking UNLISTED-0 would leave 0 drawable slots (e.g., 1-ticket hand or all
 * other slots already locked), waives Final Call and resets the streak so the duel
 * can never deadlock.
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
    unlistedStreak: state.unlistedStreak,
    finalCallThreshold: state.finalCallThreshold,
    finalCall: state.finalCall ? { ...state.finalCall } : null,
    lockedSlots: state.lockedSlots.map((s) => ({ ...s })),
    publicReveals: state.publicReveals.map((r) => ({ ...r })),
    privateReveals: {
      PLAYER: state.privateReveals.PLAYER.map((r) => ({ ...r })),
      INSPECTOR: state.privateReveals.INSPECTOR.map((r) => ({ ...r })),
    },
    condition: state.condition ? { ...state.condition } : null,
    stamps: {
      PLAYER: state.stamps.PLAYER.map((s) => ({ ...s })),
      INSPECTOR: state.stamps.INSPECTOR.map((s) => ({ ...s })),
    },
    winner: state.winner,
    loser: state.loser,
    endReason: state.endReason,
    lastResolution: state.lastResolution,
    actionLog: state.actionLog.slice(),
    eventLog: state.eventLog.slice(),
  };
}

/**
 * Initialize a new duel from seed and rules configuration.
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

  const finalCallThreshold = rawConfig.finalCallThreshold ?? DEFAULT_FINAL_CALL_THRESHOLD;
  if (!Number.isInteger(finalCallThreshold) || finalCallThreshold < 1) {
    throw new RangeError(
      `finalCallThreshold must be a positive integer; got ${finalCallThreshold}`
    );
  }

  const baseDeck = buildDeck(pairCount, { minPairs });
  const initialTicketIds = baseDeck.map((t) => t.ticketId);
  const shuffledDeck = resolveShuffledDeck(
    baseDeck,
    encounterSeed,
    rawConfig.customDeckOrder ?? null
  );

  // Deal entire deck alternately starting with startingOfferer (RULES.md Section 4).
  const rawHands = {
    PLAYER: [],
    INSPECTOR: [],
  };
  for (let i = 0; i < shuffledDeck.length; i += 1) {
    const recipient = i % 2 === 0 ? startingOfferer : startingDrawer;
    rawHands[recipient].push(shuffledDeck[i]);
  }

  // Automatically discard matching pairs from both hands after dealing.
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

  const config = {
    encounterSeed,
    pairCount,
    encounterIndex,
    startingOfferer,
    finalCallThreshold,
    allowSmallTutorialDeck,
    condition: rawConfig.condition ? { ...rawConfig.condition } : null,
    customDeckOrder: rawConfig.customDeckOrder ? rawConfig.customDeckOrder.slice() : null,
  };

  const initialCondition = rawConfig.condition
    ? {
        id: rawConfig.condition.id,
        expired: false,
        activeThroughTurn: rawConfig.condition.activeThroughTurn ?? null,
      }
    : null;

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
    eventLog.push({
      type: "TURN_STARTED",
      turnNumber: 1,
      offerId: 1,
      offerer: startingOfferer,
      drawer: startingDrawer,
      offererCount: hands[startingOfferer].length,
      drawerCount: hands[startingDrawer].length,
      finalCallSlot: null,
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
    unlistedStreak: 0,
    finalCallThreshold,
    finalCall: null,
    lockedSlots: [],
    publicReveals: [],
    privateReveals: { PLAYER: [], INSPECTOR: [] },
    condition: initialCondition,
    stamps: { PLAYER: [], INSPECTOR: [] },
    winner,
    loser,
    endReason,
    lastResolution: null,
    actionLog: [],
    eventLog,
  };

  return deepFreeze(state);
}

/**
 * Return whichever side is currently expected to act, or null if the duel is over.
 */
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

/**
 * Summarize legal actions for a side at the current duel state.
 */
export function getLegalActions(state, actor = getActiveActor(state)) {
  const activeActor = getActiveActor(state);
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
      usableStampIds: [],
    };
  }

  // DRAW_PHASE
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
    usableStampIds: [],
  };
}

function reject(reason, message) {
  return { ok: false, reason, message };
}

/**
 * Pure validator for candidate actions. Never mutates state.
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
    type !== ACTION_TYPES.USE_STAMP
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

  // USE_STAMP (reserved for Phase 3 Stamp modifiers)
  return reject(REJECT_REASONS.STAMP_UNAVAILABLE, "No usable Stamp is active in this duel.");
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
  return { ...action, seq };
}

/**
 * Apply one validated action and return a brand-new frozen duel state plus new events.
 * On illegal or duplicate input, returns { ok: false, state, reason, message }
 * with the original state untouched.
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

  if (action.type === ACTION_TYPES.SWAP) {
    const hand = next.hands[next.offerer];
    const tmp = hand[action.indexA];
    hand[action.indexA] = hand[action.indexB];
    hand[action.indexB] = tmp;
    next.swapsRemaining -= 1;
    next.swapsUsedThisOffer += 1;

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

    // Apply commit-time Drafty Window public exposure if active (RULES.md Section 9.2).
    let exposedSlot = null;
    if (
      next.condition &&
      !next.condition.expired &&
      next.condition.id === "DRAFTY_WINDOW" &&
      next.hands[next.offerer].length >= 3
    ) {
      const unlockedNow = getUnlockedSlots(next);
      if (unlockedNow.length > 0) {
        const slotIdx = unlockedNow[0];
        const ticket = next.hands[next.offerer][slotIdx];
        next.publicReveals.push({
          owner: next.offerer,
          slotIndex: slotIdx,
          ticket,
          source: "DRAFTY_WINDOW",
          offerId: next.offerId,
        });
        exposedSlot = slotIdx;
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
      publicRevealSlot: exposedSlot,
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

  // 1. Transfer chosen ticket to drawer's hand (arrives at rightmost index, Decision D4).
  const [drawnTicket] = offererHand.splice(action.slotIndex, 1);
  drawerHand.push(drawnTicket);
  const arrivalIndex = drawerHand.length - 1;

  let matchedPair = null;

  // 2. Resolve Unlisted transfer vs. matching pair discard.
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
  }

  // 3. Clear turn-scoped locks & reveals from the resolved offer (Decision D6).
  next.finalCall = null;
  next.lockedSlots = [];
  next.publicReveals = [];
  next.privateReveals = { PLAYER: [], INSPECTOR: [] };
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

  // 5. Switch roles for the next turn (with defensive non-empty-hand safety).
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

  // Advance turn-based condition expiration (e.g., Drafty Window expires at start of Turn 5).
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

  // 7. Compute swapsRemaining for incoming offerer.
  let canSwapThisOffer = true;
  if (next.forfeitNextSwap[nextOfferer]) {
    canSwapThisOffer = false;
    next.forfeitNextSwap[nextOfferer] = false;
  }
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
 * Export a minimal pure-data replay bundle from any duel state.
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
      condition: state.config.condition ? { ...state.config.condition } : null,
      customDeckOrder: state.config.customDeckOrder
        ? state.config.customDeckOrder.slice()
        : null,
    },
    actions: state.actionLog.map((a) => ({ ...a })),
  };
}

/**
 * Deterministically replay a duel from its config + legal action log.
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
 * Rigorous invariant verifier for automated tests and assertions.
 * Checks card conservation, legal pairs, hand parity, Final Call validity,
 * terminal conditions, and non-deadlock guarantees.
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

  // Unlisted must be in exactly one hand and never in discardPile.
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

  // Discard pile must consist strictly of valid matching ordinary pairs.
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

  // Neither hand may contain an un-discarded matching ordinary pair.
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

  // Two-player hand-parity check: holder of Unlisted has otherHand.length + 1.
  const holder = playerHasUnlisted === 1 ? SIDES.PLAYER : SIDES.INSPECTOR;
  const nonHolder = otherSide(holder);
  if (state.hands[holder].length !== state.hands[nonHolder].length + 1) {
    errors.push(
      `Hand parity broken: holder ${holder} has ${state.hands[holder].length}, ${nonHolder} has ${state.hands[nonHolder].length}.`
    );
  }

  // Phase & non-deadlock checks.
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
