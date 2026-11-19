/**
 * src/ai/randomOpponent.js
 * Phase 1 baseline uniform-random opponent.
 *
 * Strictly receives only a legal ObserverView and an isolated aiRng stream.
 * Never receives raw duel state, opponent hidden tickets, or shuffle seeds.
 */

import { ACTION_TYPES, PHASES } from "../core/engine.js";

/**
 * Choose one legal action for view.viewerSide using uniform random choices.
 */
export function chooseRandomAction(view, aiRng, { swapProbability = 0.5 } = {}) {
  if (!view || !view.legal || !view.legal.isMyTurn || view.phase === PHASES.OVER) {
    return null;
  }

  const actor = view.viewerSide;
  const seq = view.legal.nextSeq;

  if (view.phase === PHASES.OFFER) {
    if (view.legal.canSwap && view.legal.legalSwapSlots.length >= 2) {
      const roll = aiRng.next();
      if (roll < swapProbability) {
        const slots = view.legal.legalSwapSlots;
        const firstPos = aiRng.nextInt(slots.length);
        let secondPos = aiRng.nextInt(slots.length - 1);
        if (secondPos >= firstPos) {
          secondPos += 1;
        }
        return {
          type: ACTION_TYPES.SWAP,
          actor,
          indexA: slots[firstPos],
          indexB: slots[secondPos],
          seq,
        };
      }
    }
    return {
      type: ACTION_TYPES.COMMIT_OFFER,
      actor,
      seq,
    };
  }

  if (view.phase === PHASES.DRAW) {
    if (!view.legal.canDraw || view.legal.legalDrawSlots.length === 0) {
      return null;
    }
    const slotIndex = aiRng.pick(view.legal.legalDrawSlots);
    return {
      type: ACTION_TYPES.DRAW,
      actor,
      slotIndex,
      seq,
    };
  }

  return null;
}
