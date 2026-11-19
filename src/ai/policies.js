/**
 * src/ai/policies.js
 * Fixed scripted player policies for automated adaptation tests and paired-seed
 * tier benchmarks. Every policy receives strictly its own legal ObserverView
 * and an isolated policy RNG stream.
 */

import { ACTION_TYPES, PHASES } from "../core/engine.js";

/**
 * Helper: uniformly conceal The Unlisted across all unlocked slots in 1 swap.
 */
function offerUniformConceal(view, rng, state) {
  const actor = view.viewerSide;
  const seq = view.legal.nextSeq;
  const slots = view.legal.legalSwapSlots;

  if (!view.legal.canSwap || slots.length < 2 || state.swappedOfferId === view.offerId) {
    return { type: ACTION_TYPES.COMMIT_OFFER, actor, seq };
  }

  const unlisted = view.myHand.find((s) => s.ticket.isUnlisted);
  if (!unlisted || !slots.includes(unlisted.slotIndex)) {
    return { type: ACTION_TYPES.COMMIT_OFFER, actor, seq };
  }

  const target = rng.pick(slots);
  if (target === unlisted.slotIndex) {
    return { type: ACTION_TYPES.COMMIT_OFFER, actor, seq };
  }
  state.swappedOfferId = view.offerId;
  return { type: ACTION_TYPES.SWAP, actor, indexA: unlisted.slotIndex, indexB: target, seq };
}

/**
 * Helper: pick legal slot closest to a target normalized coordinate uTarget in [0, 1],
 * breaking exact symmetric ties (e.g., a 2-card hand vs u = 0.5) randomly.
 */
function pickClosestNormalized(legalSlots, handSize, uTarget, rng) {
  let bestDist = Infinity;
  let tied = [];
  const denom = Math.max(1, handSize - 1);
  for (const s of legalSlots) {
    const u = handSize <= 1 ? 0.5 : s / denom;
    const d = Math.abs(u - uTarget);
    if (d < bestDist - 1e-9) {
      bestDist = d;
      tied = [s];
    } else if (Math.abs(d - bestDist) <= 1e-9) {
      tied.push(s);
    }
  }
  return tied.length === 1 || !rng ? tied[0] : rng.pick(tied);
}

/**
 * 1. True Uniform Random: places Unlisted uniformly and draws uniformly.
 * Theoretical neutral control (tests that no tier plays worse than random).
 */
export function createUniformPolicy() {
  const st = { swappedOfferId: null };
  return {
    id: "uniform",
    name: "Uniform Control",
    reset() {
      st.swappedOfferId = null;
    },
    act(view, rng) {
      if (view.phase === PHASES.OFFER) return offerUniformConceal(view, rng, st);
      return {
        type: ACTION_TYPES.DRAW,
        actor: view.viewerSide,
        slotIndex: rng.pick(view.legal.legalDrawSlots),
        seq: view.legal.nextSeq,
      };
    },
  };
}

/**
 * 2. Left-Edge Picker: consistently draws the leftmost legal slot; conceals own Unlisted uniformly.
 */
export function createLeftEdgePolicy({ bias = 1.0 } = {}) {
  const st = { swappedOfferId: null };
  return {
    id: bias >= 1 ? "left-edge" : "soft-left",
    name: bias >= 1 ? "Left-Edge Picker" : `Soft Left Picker (${Math.round(bias * 100)}%)`,
    reset() {
      st.swappedOfferId = null;
    },
    act(view, rng) {
      if (view.phase === PHASES.OFFER) return offerUniformConceal(view, rng, st);
      const slots = view.legal.legalDrawSlots;
      const slotIndex =
        bias >= 1 || rng.next() < bias ? slots[0] : rng.pick(slots);
      return {
        type: ACTION_TYPES.DRAW,
        actor: view.viewerSide,
        slotIndex,
        seq: view.legal.nextSeq,
      };
    },
  };
}

/**
 * 3. Center Picker: consistently draws the legal slot closest to center (u = 0.5).
 */
export function createCenterPolicy({ bias = 1.0 } = {}) {
  const st = { swappedOfferId: null };
  return {
    id: "center",
    name: "Center Picker",
    reset() {
      st.swappedOfferId = null;
    },
    act(view, rng) {
      if (view.phase === PHASES.OFFER) return offerUniformConceal(view, rng, st);
      const slots = view.legal.legalDrawSlots;
      const slotIndex =
        bias >= 1 || rng.next() < bias
          ? pickClosestNormalized(slots, view.opponentHandCount, 0.5, rng)
          : rng.pick(slots);
      return {
        type: ACTION_TYPES.DRAW,
        actor: view.viewerSide,
        slotIndex,
        seq: view.legal.nextSeq,
      };
    },
  };
}

/**
 * 4. Alternating-Edge Picker: strictly alternates leftmost and rightmost legal draw slots.
 * Flat marginal edge profile, strong 1st-order transition pattern (tests Tier 5).
 */
export function createAlternatingEdgePolicy() {
  const st = { swappedOfferId: null, pickRight: false };
  return {
    id: "alternating-edge",
    name: "Alternating-Edge Picker",
    reset() {
      st.swappedOfferId = null;
      st.pickRight = false;
    },
    act(view, rng) {
      if (view.phase === PHASES.OFFER) return offerUniformConceal(view, rng, st);
      const slots = view.legal.legalDrawSlots;
      const slotIndex = st.pickRight ? slots[slots.length - 1] : slots[0];
      if (slots.length >= 2) {
        st.pickRight = !st.pickRight;
      }
      return {
        type: ACTION_TYPES.DRAW,
        actor: view.viewerSide,
        slotIndex,
        seq: view.legal.nextSeq,
      };
    },
  };
}

/**
 * 5. Habitual Hider & Mild Drawer: favors left/center draws (~65%) AND habitually
 * hides its own Unlisted on the left edge (slot 0), simulating a human player who
 * always tucks the bad card to slot #1 and reaches slightly left-of-center.
 */
export function createHabitualHumanPolicy() {
  const st = { swappedOfferId: null };
  return {
    id: "habitual-human",
    name: "Habitual Player (Left-Hide + Soft-Left Draw)",
    reset() {
      st.swappedOfferId = null;
    },
    act(view, rng) {
      const actor = view.viewerSide;
      const seq = view.legal.nextSeq;

      if (view.phase === PHASES.OFFER) {
        const slots = view.legal.legalSwapSlots;
        if (!view.legal.canSwap || slots.length < 2 || st.swappedOfferId === view.offerId) {
          return { type: ACTION_TYPES.COMMIT_OFFER, actor, seq };
        }
        const unlisted = view.myHand.find((s) => s.ticket.isUnlisted);
        if (unlisted && slots.includes(unlisted.slotIndex)) {
          // 85% of the time hides Unlisted at leftmost legal slot!
          const target = rng.next() < 0.85 ? slots[0] : rng.pick(slots);
          if (target !== unlisted.slotIndex) {
            st.swappedOfferId = view.offerId;
            return { type: ACTION_TYPES.SWAP, actor, indexA: unlisted.slotIndex, indexB: target, seq };
          }
        }
        return { type: ACTION_TYPES.COMMIT_OFFER, actor, seq };
      }

      const slots = view.legal.legalDrawSlots;
      const r = rng.next();
      let slotIndex;
      if (r < 0.62) {
        slotIndex = slots[0];
      } else {
        slotIndex = rng.pick(slots);
      }
      return { type: ACTION_TYPES.DRAW, actor, slotIndex, seq };
    },
  };
}

/**
 * 6. Reveal-Aware Arrival-Avoider: uses every legal slot reveal (takes safe pairs,
 * dodges revealed Unlisted), avoids opponent's right-edge arrival slot (punishing
 * Tier 1's infrequent swapping!), and occasionally forgets to move its own Unlisted.
 */
export function createRevealAwarePolicy() {
  const st = { swappedOfferId: null };
  return {
    id: "reveal-aware",
    name: "Reveal-Aware Arrival-Avoider",
    reset() {
      st.swappedOfferId = null;
    },
    act(view, rng) {
      const actor = view.viewerSide;
      const seq = view.legal.nextSeq;

      if (view.phase === PHASES.OFFER) {
        // 45% holds pat (occasionally leaves arrival Unlisted at right edge), 55% conceals uniformly.
        if (rng.next() < 0.45) {
          return { type: ACTION_TYPES.COMMIT_OFFER, actor, seq };
        }
        return offerUniformConceal(view, rng, st);
      }

      const slots = view.legal.legalDrawSlots;
      const legalSet = new Set(slots);

      // 1. Always take a revealed ordinary ticket.
      for (const s of view.opponentSlots) {
        if (s.revealedTicket && !s.revealedTicket.isUnlisted && legalSet.has(s.slotIndex)) {
          return { type: ACTION_TYPES.DRAW, actor, slotIndex: s.slotIndex, seq };
        }
      }

      // 2. Always avoid a revealed Unlisted ticket.
      let pool = slots.filter((idx) => {
        const s = view.opponentSlots[idx];
        return !(s && s.revealedTicket && s.revealedTicket.isUnlisted);
      });
      if (pool.length === 0) pool = slots;

      // 3. Avoid opponent's right edge when opponent holds Unlisted (exploits lazy shufflers like Tier 1).
      const rightIdx = view.opponentHandCount - 1;
      if (view.opponentHoldsUnlisted && pool.length > 1 && pool.includes(rightIdx)) {
        pool = pool.filter((idx) => idx !== rightIdx);
      }

      return {
        type: ACTION_TYPES.DRAW,
        actor,
        slotIndex: rng.pick(pool),
        seq,
      };
    },
  };
}
