/**
 * src/core/tutorial.js
 * Zero-prior-knowledge, hands-on interactive tutorial controller.
 *
 * Assumes the player has never played Old Maid or any card game. Walks them
 * step-by-step on a real engine-backed practice table through:
 *   1. Pairs, opening auto-clear, and the single goal (don't hold The Unlisted)
 *   2. Drawing a hidden card to match & discard a pair
 *   3. Offering your hand as roles alternate
 *   4. Drawing The Unlisted & how the 3-pass Final Call lock prevents stalemates
 *   5. Privately swapping two tickets to hide The Unlisted (and pattern awareness)
 *   6. Committing the bluff and watching the Inspector take The Unlisted back
 *   7. Using a custom Stamp (Inspection Window + its tradeoff) & Emblem (★) tickets
 *   8. Winning the duel + quick overview of Lanterns, 5 Stops, and Conditions
 *
 * Skippable at any step and replayable anytime.
 */

import { ACTION_TYPES, PHASES, SIDES, applyAction, createDuel } from "./engine.js";
import { createObserverView } from "./observer.js";
import { STAMP_IDS } from "../data/stamps.js";

export const TUTORIAL_STEPS = Object.freeze({
  INTRO_GOAL: "INTRO_GOAL",
  DRAW_PAIR: "DRAW_PAIR",
  FIRST_OFFER: "FIRST_OFFER",
  DRAW_UNLISTED: "DRAW_UNLISTED",
  SWAP_UNLISTED: "SWAP_UNLISTED",
  COMMIT_BLUFF: "COMMIT_BLUFF",
  USE_STAMP: "USE_STAMP",
  WINNING_DRAW: "WINNING_DRAW",
  COMPLETE: "COMPLETE",
});

export const TOTAL_TUTORIAL_STEPS = 8;

function interleaveHands(offererIds, drawerIds) {
  const deck = [];
  for (let i = 0; i < offererIds.length; i += 1) {
    deck.push(offererIds[i]);
    if (i < drawerIds.length) deck.push(drawerIds[i]);
  }
  return deck;
}

function buildTutorialInitialDuel() {
  // 5 pairs + Unlisted = 11 cards.
  // Deal clears TRUNK (Inspector) and LANTERN★ (Player) automatically, leaving:
  //   Inspector (offerer): [#1 WATCH-A, #2 UNLISTED-0, #3 KEY-A, #4 BELL-A]
  //   Player   (drawer):   [#1 WATCH-B, #2 KEY-B, #3 BELL-B]
  const deck = interleaveHands(
    ["TRUNK-A", "TRUNK-B", "WATCH-A", "UNLISTED-0", "KEY-A", "BELL-A"],
    ["LANTERN-A", "LANTERN-B", "WATCH-B", "KEY-B", "BELL-B"]
  );

  let state = createDuel({
    encounterSeed: "TUTORIAL-PRACTICE",
    pairCount: 5,
    allowSmallTutorialDeck: true,
    startingOfferer: SIDES.INSPECTOR,
    playerStamps: [STAMP_IDS.INSPECTION_WINDOW],
    playerLanterns: 3,
    maxLanterns: 3,
    customDeckOrder: deck,
  });

  // Inspector immediately commits his opening 4-card fan so the player starts in DRAW_PHASE.
  state = applyAction(state, {
    type: ACTION_TYPES.COMMIT_OFFER,
    actor: SIDES.INSPECTOR,
  }).state;

  return state;
}

export function createTutorialSession() {
  let duelState = buildTutorialInitialDuel();
  let stepId = TUTORIAL_STEPS.INTRO_GOAL;
  let selectedSwapSlot = null;
  let lastSwappedSlots = [];
  let targetingStampId = null;
  let nudgeMessage = null;
  let peekedSlot = null;

  function reset() {
    duelState = buildTutorialInitialDuel();
    stepId = TUTORIAL_STEPS.INTRO_GOAL;
    selectedSwapSlot = null;
    lastSwappedSlots = [];
    targetingStampId = null;
    nudgeMessage = null;
    peekedSlot = null;
  }

  function acknowledge() {
    nudgeMessage = null;
    if (stepId === TUTORIAL_STEPS.INTRO_GOAL) {
      stepId = TUTORIAL_STEPS.DRAW_PAIR;
      return { ok: true, stepId };
    }
    return { ok: false, reason: "ACTION_REQUIRED" };
  }

  function handleDrawSlot(slotIndex) {
    nudgeMessage = null;

    if (stepId === TUTORIAL_STEPS.USE_STAMP && targetingStampId === STAMP_IDS.INSPECTION_WINDOW) {
      const res = applyAction(duelState, {
        type: ACTION_TYPES.USE_STAMP,
        actor: SIDES.PLAYER,
        stampId: STAMP_IDS.INSPECTION_WINDOW,
        targetSlot: slotIndex,
        seq: duelState.nextSeq,
      });
      if (!res.ok) return res;
      duelState = res.state;
      targetingStampId = null;
      peekedSlot = slotIndex;
      stepId = TUTORIAL_STEPS.WINNING_DRAW;
      return { ok: true, stepId };
    }

    if (stepId === TUTORIAL_STEPS.DRAW_PAIR) {
      if (slotIndex !== 0) {
        nudgeMessage = "Click glowing Slot #1 in the Inspector's fan to see a matching pair.";
        return { ok: false, reason: "TUTORIAL_GUIDE" };
      }
      const res = applyAction(duelState, {
        type: ACTION_TYPES.DRAW,
        actor: SIDES.PLAYER,
        slotIndex: 0,
        seq: duelState.nextSeq,
      });
      if (!res.ok) return res;
      duelState = res.state;
      stepId = TUTORIAL_STEPS.FIRST_OFFER;
      return { ok: true, stepId };
    }

    if (stepId === TUTORIAL_STEPS.DRAW_UNLISTED) {
      if (slotIndex !== 0) {
        nudgeMessage = "Click glowing Slot #1 so you can safely practice holding The Unlisted.";
        return { ok: false, reason: "TUTORIAL_GUIDE" };
      }
      const res = applyAction(duelState, {
        type: ACTION_TYPES.DRAW,
        actor: SIDES.PLAYER,
        slotIndex: 0,
        seq: duelState.nextSeq,
      });
      if (!res.ok) return res;
      duelState = res.state;
      selectedSwapSlot = null;
      lastSwappedSlots = [];
      stepId = TUTORIAL_STEPS.SWAP_UNLISTED;
      return { ok: true, stepId };
    }

    if (stepId === TUTORIAL_STEPS.WINNING_DRAW) {
      if (slotIndex !== 1) {
        nudgeMessage =
          "Slot #1 is The Unlisted! Click glowing Slot #2 to pair your Bell★ ticket and win.";
        return { ok: false, reason: "TUTORIAL_GUIDE" };
      }
      const res = applyAction(duelState, {
        type: ACTION_TYPES.DRAW,
        actor: SIDES.PLAYER,
        slotIndex: 1,
        seq: duelState.nextSeq,
      });
      if (!res.ok) return res;
      duelState = res.state;
      stepId = TUTORIAL_STEPS.COMPLETE;
      return { ok: true, stepId };
    }

    nudgeMessage = "Follow the highlighted tutorial step first (or click Skip Tutorial anytime).";
    return { ok: false, reason: "TUTORIAL_GUIDE" };
  }

  function handleSelectOfferSlot(slotIndex) {
    nudgeMessage = null;
    if (stepId !== TUTORIAL_STEPS.SWAP_UNLISTED) {
      nudgeMessage =
        stepId === TUTORIAL_STEPS.FIRST_OFFER
          ? "Press the glowing Commit Fan button to offer your hand."
          : "You already swapped — press Commit Fan to continue.";
      return { ok: false, reason: "TUTORIAL_GUIDE" };
    }

    if (slotIndex !== 0 && slotIndex !== 1) {
      return { ok: false, reason: "INVALID_SLOT_INDEX" };
    }

    if (selectedSwapSlot === null) {
      selectedSwapSlot = slotIndex;
      return { ok: true, staged: true };
    }
    if (selectedSwapSlot === slotIndex) {
      selectedSwapSlot = null;
      return { ok: true, staged: false };
    }

    const res = applyAction(duelState, {
      type: ACTION_TYPES.SWAP,
      actor: SIDES.PLAYER,
      indexA: selectedSwapSlot,
      indexB: slotIndex,
      seq: duelState.nextSeq,
    });
    if (!res.ok) return res;
    duelState = res.state;
    lastSwappedSlots = [0, 1];
    selectedSwapSlot = null;
    stepId = TUTORIAL_STEPS.COMMIT_BLUFF;
    return { ok: true, stepId };
  }

  function handleCommitOffer() {
    nudgeMessage = null;

    if (stepId === TUTORIAL_STEPS.FIRST_OFFER) {
      // Player commits [#1 KEY-B, #2 BELL-B]; Inspector draws #1 (pairs KEY) and commits [#1 UNLISTED-0, #2 BELL-A].
      let st = applyAction(duelState, {
        type: ACTION_TYPES.COMMIT_OFFER,
        actor: SIDES.PLAYER,
      }).state;
      st = applyAction(st, {
        type: ACTION_TYPES.DRAW,
        actor: SIDES.INSPECTOR,
        slotIndex: 0,
      }).state;
      st = applyAction(st, {
        type: ACTION_TYPES.COMMIT_OFFER,
        actor: SIDES.INSPECTOR,
      }).state;
      duelState = st;
      stepId = TUTORIAL_STEPS.DRAW_UNLISTED;
      return { ok: true, stepId };
    }

    if (stepId === TUTORIAL_STEPS.COMMIT_BLUFF) {
      // Player commits [#1 UNLISTED-0, #2 BELL-B]; Inspector falls for the swap, takes #1 (UNLISTED-0),
      // swaps his fan to [#1 UNLISTED-0, #2 BELL-A], and commits!
      let st = applyAction(duelState, {
        type: ACTION_TYPES.COMMIT_OFFER,
        actor: SIDES.PLAYER,
      }).state;
      st = applyAction(st, {
        type: ACTION_TYPES.DRAW,
        actor: SIDES.INSPECTOR,
        slotIndex: 0,
      }).state;
      st = applyAction(st, {
        type: ACTION_TYPES.SWAP,
        actor: SIDES.INSPECTOR,
        indexA: 0,
        indexB: 1,
      }).state;
      st = applyAction(st, {
        type: ACTION_TYPES.COMMIT_OFFER,
        actor: SIDES.INSPECTOR,
      }).state;
      duelState = st;
      lastSwappedSlots = [];
      stepId = TUTORIAL_STEPS.USE_STAMP;
      return { ok: true, stepId };
    }

    if (stepId === TUTORIAL_STEPS.SWAP_UNLISTED) {
      nudgeMessage =
        "Swap your two tickets first: click Slot #2 (The Unlisted), then click Slot #1 (Bell★).";
      return { ok: false, reason: "TUTORIAL_GUIDE" };
    }

    return { ok: false, reason: "TUTORIAL_GUIDE" };
  }

  function handleActivateStamp(stampId) {
    nudgeMessage = null;
    if (stepId !== TUTORIAL_STEPS.USE_STAMP || stampId !== STAMP_IDS.INSPECTION_WINDOW) {
      nudgeMessage = "Hold onto Inspection Window — we'll use it together in a moment!";
      return { ok: false, reason: "TUTORIAL_GUIDE" };
    }
    targetingStampId =
      targetingStampId === STAMP_IDS.INSPECTION_WINDOW ? null : STAMP_IDS.INSPECTION_WINDOW;
    return { ok: true, targetingStampId };
  }

  function describeStep() {
    switch (stepId) {
      case TUTORIAL_STEPS.INTRO_GOAL:
        return {
          stepId,
          stepNumber: 1,
          totalSteps: TOTAL_TUTORIAL_STEPS,
          title: "The One Rule: Match Pairs, Avoid The Unlisted",
          body: "Every normal ticket has 1 matching twin — Trunk and Lantern★ already matched and cleared automatically when dealt! Only 1 blank punched ticket has NO twin: The Unlisted. Clear every pair so the Inspector is stuck holding The Unlisted.",
          actionLabel: "Try Your First Draw →",
          highlight: { zone: "acknowledge" },
          summaryBullets: null,
        };

      case TUTORIAL_STEPS.DRAW_PAIR:
        return {
          stepId,
          stepNumber: 2,
          totalSteps: TOTAL_TUTORIAL_STEPS,
          title: "Your Draw: Pick 1 Face-Down Ticket",
          body: "Look at Your Hand below: you hold Watch★, Key★, and Bell★. Pick 1 hidden ticket from the Inspector's hand — if it matches yours, both discard automatically. Click glowing Slot #1 above.",
          actionLabel: null,
          highlight: { zone: "inspector", slot: 0 },
          summaryBullets: null,
        };

      case TUTORIAL_STEPS.FIRST_OFFER:
        return {
          stepId,
          stepNumber: 3,
          totalSteps: TOTAL_TUTORIAL_STEPS,
          title: "Your Offer: Roles Switch Every Turn",
          body: "Both Watch★ tickets paired and cleared! After you draw, roles flip to Your Offer — the Inspector picks 1 of your tickets (face-down to him). Press Commit Fan to offer your hand.",
          actionLabel: null,
          highlight: { zone: "commit" },
          summaryBullets: null,
        };

      case TUTORIAL_STEPS.DRAW_UNLISTED:
        return {
          stepId,
          stepNumber: 4,
          totalSteps: TOTAL_TUTORIAL_STEPS,
          title: "Spotting & Drawing The Unlisted",
          body: "The Inspector paired Key★ and now holds 2 tickets (Bell★ + The Unlisted) while you hold 1 (Bell★). Whoever holds The Unlisted always has 1 extra card! Click Slot #1 to safely see what happens if you draw it.",
          actionLabel: null,
          highlight: { zone: "inspector", slot: 0 },
          summaryBullets: null,
        };

      case TUTORIAL_STEPS.SWAP_UNLISTED:
        return {
          stepId,
          stepNumber: 5,
          totalSteps: TOTAL_TUTORIAL_STEPS,
          title: "Secret Swap & Final Call",
          body:
            selectedSwapSlot === null
              ? "The Unlisted has no match, so it landed at Slot #2 and lit Unlisted Streak (1/3 — at 3 in a row, Final Call locks it for 1 turn to force a pair). Before offering, swap 2 cards in secret: click Slot #2 (The Unlisted)."
              : `Great! Now click Slot #${selectedSwapSlot === 1 ? 1 : 2} to secretly swap places and hide The Unlisted.`,
          actionLabel: null,
          highlight: {
            zone: "player",
            slot: selectedSwapSlot === null ? 1 : selectedSwapSlot === 1 ? 0 : 1,
          },
          summaryBullets: null,
        };

      case TUTORIAL_STEPS.COMMIT_BLUFF:
        return {
          stepId,
          stepNumber: 6,
          totalSteps: TOTAL_TUTORIAL_STEPS,
          title: "Commit Your Bluff",
          body: "Your swap is hidden from the Inspector! (Tip: in real stops, he quietly learns which positions you usually grab — mix up your choices.) Press Commit Fan so he draws from your hand.",
          actionLabel: null,
          highlight: { zone: "commit" },
          summaryBullets: null,
        };

      case TUTORIAL_STEPS.USE_STAMP:
        return {
          stepId,
          stepNumber: 7,
          totalSteps: TOTAL_TUTORIAL_STEPS,
          title: "Custom Tools: Stamps & Emblem (★) Tickets",
          body:
            targetingStampId === STAMP_IDS.INSPECTION_WINDOW
              ? "Now click Inspector Slot #1 above to privately peek at that face-down ticket! (Tradeoff: in longer duels, peeking skips your next swap.)"
              : "He fell for your swap and took The Unlisted back! Winning stops earns Stamps (up to 3) with powerful effects and tradeoffs, and ★ EMB tickets recharge certain Stamps. Click Inspection Window in your Stamp Tray.",
          actionLabel: null,
          highlight:
            targetingStampId === STAMP_IDS.INSPECTION_WINDOW
              ? { zone: "inspector", slot: 0 }
              : { zone: "stamp", stampId: STAMP_IDS.INSPECTION_WINDOW },
          summaryBullets: null,
        };

      case TUTORIAL_STEPS.WINNING_DRAW:
        return {
          stepId,
          stepNumber: 8,
          totalSteps: TOTAL_TUTORIAL_STEPS,
          title: "Clear the Last Pair to Win!",
          body:
            peekedSlot === 1
              ? "Your peek confirmed Slot #2 is Bell★ — a guaranteed match! Click glowing Slot #2 to clear your hand and leave the Inspector holding The Unlisted."
              : "Caught it! Slot #1 is The Unlisted, which means Slot #2 must be your matching Bell★. Click glowing Slot #2 to clear your hand and win!",
          actionLabel: null,
          highlight: { zone: "inspector", slot: 1 },
          summaryBullets: null,
        };

      default:
        return {
          stepId: TUTORIAL_STEPS.COMPLETE,
          stepNumber: 8,
          totalSteps: TOTAL_TUTORIAL_STEPS,
          title: "Practice Cleared — Ready to Board!",
          body: "You left the Inspector holding The Unlisted! Here is how a full Midnight Line run works:",
          actionLabel: "Board Car I — Start Run →",
          highlight: { zone: "finish" },
          summaryBullets: [
            "5 Multi-Deal Stops: Clear 4 Carriages (First to 2 Deals, 7→10 pairs) and beat Stop 5: Final Inspection (First to 3 Deals, 12 pairs). Watch out — the Inspector brings his own Stamps too!",
            "3 Lanterns & Stamps: Winning a carriage offers 1 of 3 Stamps (up to 3 slots — replace or skip). Losing costs 1 Lantern (no Stamp) and moves on, or rematches on Stop 5. At 0 Lanterns, the run ends.",
            "Platform Locker (Between Runs): Early runs are tough! Every pair, ★ Emblem match, deal, and carriage earns Punched Stubs — spend them in the Locker to unlock Keepsakes like The Perforation Gauge.",
          ],
        };
    }
  }

  function getSnapshot() {
    const view = createObserverView(duelState, SIDES.PLAYER);
    const step = describeStep();
    return {
      view,
      step: {
        ...step,
        nudgeMessage,
      },
      selectedSwapSlot,
      lastSwappedSlots: lastSwappedSlots.slice(),
      newlyDrawnUnlistedSlot: stepId === TUTORIAL_STEPS.SWAP_UNLISTED ? 1 : null,
      targetingStampId,
      isComplete: stepId === TUTORIAL_STEPS.COMPLETE,
    };
  }

  return Object.freeze({
    reset,
    acknowledge,
    handleDrawSlot,
    handleSelectOfferSlot,
    handleCommitOffer,
    handleActivateStamp,
    getSnapshot,
    getRawDuelState: () => duelState,
  });
}
