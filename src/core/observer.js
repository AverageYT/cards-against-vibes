/**
 * src/core/observer.js
 * Legal-information projection (ObserverView) for a given side.
 *
 * Enforces the strict information boundary required by RULES.md Section 10:
 * - Never exposes opponent hidden slot-to-ticket mappings.
 * - Never exposes private SWAP actions made by the opponent.
 * - Never exposes encounterSeed or customDeckOrder.
 * - Exposes Final Call slot marks, public reveals, and private reveals owned
 *   strictly by viewerSide, only while the current offer is active.
 */

import {
  PHASES,
  getActiveActor,
  getLegalActions,
  getSlotLock,
  isValidSide,
  otherSide,
} from "./engine.js";
import { UNLISTED_TICKET } from "../data/tickets.js";

function sanitizePublicEvent(ev) {
  if (ev.privateTo) {
    return null;
  }
  if (ev.type === "TICKET_DRAWN") {
    return {
      type: ev.type,
      turnNumber: ev.turnNumber,
      offerId: ev.offerId,
      offerer: ev.offerer,
      drawer: ev.drawer,
      slotIndex: ev.slotIndex,
      offererHandSizeBefore: ev.offererHandSizeBefore,
      legalDrawCountBefore: ev.legalDrawCountBefore,
      drewUnlisted: ev.drewUnlisted,
      matchedSymbolId: ev.matchedSymbolId,
      wasFinalCall: ev.wasFinalCall,
      unlistedStreakAfter: ev.unlistedStreakAfter,
      arrivalIndex: ev.arrivalIndex,
    };
  }
  return {
    ...ev,
    dealtCounts: ev.dealtCounts ? { ...ev.dealtCounts } : undefined,
    ticketIds: ev.ticketIds ? ev.ticketIds.slice() : undefined,
  };
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

/**
 * Create a frozen ObserverView containing only facts legally visible to viewerSide.
 */
export function createObserverView(state, viewerSide) {
  if (!isValidSide(viewerSide)) {
    throw new RangeError(`Invalid viewerSide: ${viewerSide}`);
  }
  const opponentSide = otherSide(viewerSide);
  const viewerIsOfferer = state.offerer === viewerSide;
  const opponentIsOfferer = state.offerer === opponentSide;

  // Build visible lookup for opponent's current offer slots (only valid during current offer).
  const publicRevealBySlot = new Map();
  for (const rev of state.publicReveals) {
    if (rev.owner === opponentSide && rev.ticket) {
      publicRevealBySlot.set(rev.slotIndex, rev.ticket);
    }
  }

  const privateRevealBySlot = new Map();
  for (const rev of state.privateReveals[viewerSide] || []) {
    if (rev.owner === opponentSide && rev.ticket) {
      privateRevealBySlot.set(rev.slotIndex, rev.ticket);
    }
  }

  const ownPublicRevealSlots = new Set(
    state.publicReveals.filter((r) => r.owner === viewerSide).map((r) => r.slotIndex)
  );

  const myHand = state.hands[viewerSide].map((ticket, slotIndex) => {
    const lock = viewerIsOfferer ? getSlotLock(state, slotIndex) : null;
    return {
      slotIndex,
      ticket,
      locked: Boolean(lock),
      lockReason: lock ? lock.reason : null,
      publiclyRevealed: ownPublicRevealSlots.has(slotIndex),
    };
  });

  const opponentHandLen = state.hands[opponentSide].length;
  const opponentSlots = [];
  for (let slotIndex = 0; slotIndex < opponentHandLen; slotIndex += 1) {
    const lock = opponentIsOfferer ? getSlotLock(state, slotIndex) : null;
    let revealedTicket = null;
    let revealSource = null;

    if (lock && lock.reason === "FINAL_CALL") {
      revealedTicket = UNLISTED_TICKET;
      revealSource = "FINAL_CALL";
    } else if (privateRevealBySlot.has(slotIndex)) {
      revealedTicket = privateRevealBySlot.get(slotIndex);
      revealSource = "PRIVATE";
    } else if (publicRevealBySlot.has(slotIndex)) {
      revealedTicket = publicRevealBySlot.get(slotIndex);
      revealSource = "PUBLIC";
    } else if (state.phase === PHASES.OVER && opponentHandLen === 1) {
      // At DUEL_OVER only UNLISTED-0 remains; its identity is public.
      revealedTicket = UNLISTED_TICKET;
      revealSource = "DUEL_OVER";
    }

    opponentSlots.push({
      slotIndex,
      locked: Boolean(lock),
      lockReason: lock ? lock.reason : null,
      revealedTicket,
      revealSource,
    });
  }

  const publicHistory = [];
  for (const ev of state.eventLog) {
    const clean = sanitizePublicEvent(ev);
    if (clean) {
      publicHistory.push(clean);
    }
  }

  const discardPairs = state.discardPairs.map((pair) => ({
    pairNumber: pair.pairNumber,
    owner: pair.owner,
    source: pair.source,
    turnNumber: pair.turnNumber,
    symbolId: pair.symbolId,
    isEmblem: pair.isEmblem,
    ticketIds: pair.ticketIds.slice(),
  }));

  // Last resolution sanitized to public/legal facts (matched pair symbol is public; Unlisted transfer is public).
  const lastResolution = state.lastResolution
    ? {
        turnNumber: state.lastResolution.turnNumber,
        offerId: state.lastResolution.offerId,
        offerer: state.lastResolution.offerer,
        drawer: state.lastResolution.drawer,
        slotIndex: state.lastResolution.slotIndex,
        offererHandSizeBefore: state.lastResolution.offererHandSizeBefore,
        legalDrawCountBefore: state.lastResolution.legalDrawCountBefore,
        drewUnlisted: state.lastResolution.drewUnlisted,
        matchedSymbolId: state.lastResolution.matchedPair
          ? state.lastResolution.matchedPair.symbolId
          : null,
        wasFinalCall: state.lastResolution.wasFinalCall,
        unlistedStreakAfter: state.lastResolution.unlistedStreakAfter,
      }
    : null;

  const view = {
    viewerSide,
    opponentSide,
    pairCount: state.config.pairCount,
    phase: state.phase,
    turnNumber: state.turnNumber,
    offerId: state.offerId,
    nextSeq: state.nextSeq,
    offerer: state.offerer,
    drawer: state.drawer,
    activeActor: getActiveActor(state),
    myHand,
    myHandCount: myHand.length,
    iHoldUnlisted: myHand.some((slot) => slot.ticket.isUnlisted),
    opponentSlots,
    opponentHandCount: opponentHandLen,
    // In 2-player Old Maid, opponent holds UNLISTED-0 iff opponentHandCount > myHandCount.
    opponentHoldsUnlisted: opponentHandLen > myHand.length,
    discardPairs,
    initialDealPairCount: state.initialDealPairCount,
    initialRemainingPairs: state.initialRemainingPairs,
    playedPairsDiscarded: state.playedPairsDiscarded,
    unlistedStreak: state.unlistedStreak,
    finalCallThreshold: state.finalCallThreshold,
    finalCall: state.finalCall
      ? {
          active: state.finalCall.active,
          offerer: state.offerer,
          slotIndex: state.finalCall.slotIndex,
          streakAtTrigger: state.finalCall.streakAtTrigger,
        }
      : null,
    condition: state.condition ? { ...state.condition } : null,
    myStamps: state.stamps[viewerSide].map((s) => ({ ...s })),
    opponentStamps: state.stamps[opponentSide].map((s) => ({
      id: s.id,
      spent: Boolean(s.spent),
    })),
    myForfeitNextSwap: Boolean(state.forfeitNextSwap[viewerSide]),
    legal: getLegalActions(state, viewerSide),
    lastResolution,
    publicHistory,
    winner: state.winner,
    loser: state.loser,
    endReason: state.endReason,
  };

  return deepFreeze(view);
}
