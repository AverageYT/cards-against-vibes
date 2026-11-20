/**
 * tests/phase3Suite.js
 * Portable, framework-free verification suite for Phase 3 (runs in both plain Node
 * and tests/browser.html).
 *
 * Verifies:
 *  1. Zero-prior-knowledge interactive tutorial (full 8-step walkthrough, wrong-click
 *     nudges, engine invariants, skip at any step, and clean replay)
 *  2. All 8 Stamps: benefits, tradeoffs, strict privacy, deal-pair exclusion (D5),
 *     exposure deduplication (D8), and per-stop charge refresh / Spare Wick burn
 *  3. Stamp synergy combos measurably altering legal & optimal turn decisions
 *     (Inspection Window + Carbon Copy; Inspection Window + Night Transfer;
 *      Manifest Loupe + Brass Weight; Bell Cord + Carbon Copy)
 *  4. All 4 Carriage Conditions: pre-duel briefing, live status, exact expiration,
 *     Late Schedule small-hand scaling (D10), and Short Whistle threshold 2
 *  5. Stress fuzz (320 seeded duels) + JSON replay determinism with active Stamps &
 *     Conditions across 6–12 pair decks and Inspector Tiers 1–5
 *  6. Complete 5-stop run progression: 4 carriage wins + Stamp pick/replace/skip +
 *     Final Inspection Victory, early-carriage loss (lantern deduction, no reward,
 *     advance), Spare Wick mid-run heal, Final Inspection rematch, and 0-lantern Defeat
 *  7. Seed repeatability (identical conditions, Stamp offers, and encounter shuffles)
 *     and clean full-run restart (zero stale timers, full AI habit reset)
 */

import {
  ACTION_TYPES,
  PHASES,
  REJECT_REASONS,
  SIDES,
  applyAction,
  createDuel,
  exportReplay,
  getLegalActions,
  replayDuel,
  verifyInvariants,
} from "../src/core/engine.js";
import { createObserverView } from "../src/core/observer.js";
import { createRng, deriveSeed } from "../src/core/rng.js";
import {
  RUN_OUTCOMES,
  RUN_SCREENS,
  buildConditionSchedule,
  createRunController,
  rollStampRewardOffer,
} from "../src/core/run.js";
import { TOTAL_TUTORIAL_STEPS, TUTORIAL_STEPS } from "../src/core/tutorial.js";
import { MAX_STAMP_SLOTS, STAMP_IDS, STAMP_LIST } from "../src/data/stamps.js";
import { CONDITION_IDS, CONDITION_LIST } from "../src/data/conditions.js";
import { CARRIAGES, INITIAL_LANTERNS, resolveInspectorLoadout } from "../src/data/carriages.js";
import { KEEPSAKE_IDS, KEEPSAKE_LIST } from "../src/data/keepsakes.js";
import { META_STORAGE_KEY, createMetaStore } from "../src/core/meta.js";
import { createInspectorAgent } from "../src/ai/inspector.js";
import { BUCKETS } from "../src/data/aiTuning.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${message} — expected ${b}, got ${a}`);
  }
}

function interleave(offererIds, drawerIds) {
  const out = [];
  for (let i = 0; i < offererIds.length; i += 1) {
    out.push(offererIds[i]);
    if (i < drawerIds.length) out.push(drawerIds[i]);
  }
  return out;
}

/**
 * Play the currently active duel in a run controller to completion, optionally forcing
 * a PLAYER win or PLAYER loss using omniscient test-only deck inspection so every run
 * branch (win, early loss, boss rematch, 0-lantern defeat) is tested deterministically.
 */
/**
 * Helper to drive an active duel to an exact target winner when used alongside
 * a slot-0-drawing opponentOverride (places Unlisted at slot 0 when PLAYER should
 * win, or hides Unlisted away from slot 0 when INSPECTOR should win).
 */
function finishActiveDuelWithOutcome(ctrl, rawTargetWinner, actionRng) {
  let guard = 0;
  while (ctrl.getSnapshot().screen === RUN_SCREENS.DUEL) {
    guard += 1;
    assert(guard < 400, "Active run duel must terminate cleanly");
    const snap = ctrl.getSnapshot();
    const { view } = snap;
    assertEqual(view.activeActor, SIDES.PLAYER, "Immediate duel pauses only on PLAYER turns");

    if (view.phase === PHASES.OFFER) {
      if (view.legal.canSwap && view.legal.legalSwapSlots.length >= 2) {
        const unlSlot = view.myHand.find((s) => s.ticket.isUnlisted)?.slotIndex ?? -1;
        const firstOpen = view.legal.legalSwapSlots[0];
        const lastOpen = view.legal.legalSwapSlots[view.legal.legalSwapSlots.length - 1];
        if (
          rawTargetWinner === SIDES.PLAYER &&
          unlSlot !== -1 &&
          unlSlot !== firstOpen &&
          view.legal.legalSwapSlots.includes(unlSlot)
        ) {
          // Put Unlisted at firstOpen so the deterministic test opponent takes it!
          ctrl.selectOfferSlot(unlSlot);
          ctrl.selectOfferSlot(firstOpen);
        } else if (
          rawTargetWinner === SIDES.INSPECTOR &&
          unlSlot === firstOpen &&
          firstOpen !== lastOpen
        ) {
          // Hide Unlisted away from firstOpen so player keeps it!
          ctrl.selectOfferSlot(firstOpen);
          ctrl.selectOfferSlot(lastOpen);
        }
      }
      const res = ctrl.commitOffer();
      assert(res.ok, "Player commitOffer succeeded");
    } else {
      // Reconstruct live duel state from exported replay to pick Unlisted or a pair on demand.
      const rep = replayDuel(ctrl.getActiveDuelReplay());
      assert(rep.ok, "Live duel replay reconstructed");
      const inspHand = rep.state.hands.INSPECTOR;
      const legal = view.legal.legalDrawSlots;
      const unlistedSlot = legal.find((idx) => inspHand[idx]?.isUnlisted);
      const safeSlots = legal.filter((idx) => !inspHand[idx]?.isUnlisted);

      let pick;
      if (rawTargetWinner === SIDES.PLAYER) {
        pick = safeSlots.length > 0 ? safeSlots[0] : legal[0];
      } else if (rawTargetWinner === SIDES.INSPECTOR) {
        pick = unlistedSlot !== undefined ? unlistedSlot : legal[0];
      } else {
        pick = actionRng.pick(legal);
      }

      const res = ctrl.drawSlot(pick);
      assert(res.ok, "Player drawSlot succeeded");
    }
  }
}

function firstSlotTestOpponent(view) {
  if (view.phase === PHASES.OFFER) {
    return {
      type: ACTION_TYPES.COMMIT_OFFER,
      actor: SIDES.INSPECTOR,
      seq: view.legal.nextSeq,
    };
  }
  return {
    type: ACTION_TYPES.DRAW,
    actor: SIDES.INSPECTOR,
    slotIndex: view.legal.legalDrawSlots[0],
    seq: view.legal.nextSeq,
  };
}

export function getPhase3Tests() {
  return [
    {
      name: "1. Interactive tutorial walks zero-knowledge player through all 8 steps, supports skip anywhere & clean replay",
      fn() {
        let seenSaved = false;
        const ctrl = createRunController({
          initialSeed: "TUT-RUN-1",
          immediate: true,
          tutorialCompleted: false,
          onTutorialSeen: (v) => {
            seenSaved = v;
          },
        });

        assertEqual(ctrl.getSnapshot().screen, RUN_SCREENS.TITLE, "Starts on TITLE screen");
        assertEqual(ctrl.getSnapshot().hasCompletedTutorial, false, "First-time tutorial flag false");

        // Launch tutorial and step through all 8 hands-on beats.
        ctrl.startTutorial();
        let snap = ctrl.getSnapshot();
        assertEqual(snap.screen, RUN_SCREENS.TUTORIAL, "Entered TUTORIAL screen");
        assertEqual(snap.tutorial.stepId, TUTORIAL_STEPS.INTRO_GOAL, "Step 1 INTRO_GOAL");
        assertEqual(snap.tutorial.stepNumber, 1, "Step 1 of 8");
        assertEqual(snap.tutorial.totalSteps, TOTAL_TUTORIAL_STEPS, "Total tutorial steps = 8");
        assertEqual(snap.view.discardPairs.length, 2, "2 opening pairs cleared automatically on deal");

        // Step 1 -> Step 2 (acknowledge goal & pair rule)
        assert(ctrl.tutorialAcknowledge().ok, "Step 1 acknowledge");
        snap = ctrl.getSnapshot();
        assertEqual(snap.tutorial.stepId, TUTORIAL_STEPS.DRAW_PAIR, "Step 2 DRAW_PAIR");

        // Off-script click gives a friendly nudge without mutating state.
        const wrongDraw = ctrl.drawSlot(2);
        assertEqual(wrongDraw.ok, false, "Off-script slot gently blocked");
        assert(
          Boolean(ctrl.getSnapshot().tutorial.nudgeMessage),
          "Friendly nudge message surfaced"
        );

        // Step 2 -> Step 3: click Slot #1 to pair WATCH★
        assert(ctrl.drawSlot(0).ok, "Step 2 draw matching pair");
        snap = ctrl.getSnapshot();
        assertEqual(snap.tutorial.stepId, TUTORIAL_STEPS.FIRST_OFFER, "Step 3 FIRST_OFFER");
        assertEqual(snap.view.lastResolution.matchedSymbolId, "WATCH", "Matched WATCH★ pair");

        // Step 3 -> Step 4: click Commit Fan
        assert(ctrl.commitOffer().ok, "Step 3 commit first offer");
        snap = ctrl.getSnapshot();
        assertEqual(snap.tutorial.stepId, TUTORIAL_STEPS.DRAW_UNLISTED, "Step 4 DRAW_UNLISTED");
        assertEqual(snap.view.opponentHandCount, 2, "Inspector holds 2 cards (Unlisted + Bell★)");
        assertEqual(snap.view.myHandCount, 1, "Player holds 1 card (Bell★)");

        // Step 4 -> Step 5: draw The Unlisted safely to learn Streak & Final Call
        assert(ctrl.drawSlot(0).ok, "Step 4 draw The Unlisted");
        snap = ctrl.getSnapshot();
        assertEqual(snap.tutorial.stepId, TUTORIAL_STEPS.SWAP_UNLISTED, "Step 5 SWAP_UNLISTED");
        assertEqual(snap.view.unlistedStreak, 1, "Unlisted streak incremented to 1/3");
        assert(
          snap.view.myHand[1].ticket.isUnlisted,
          "Unlisted arrived at right edge (Slot #2)"
        );

        // Premature commit nudges player to practice swapping first.
        assertEqual(ctrl.commitOffer().ok, false, "Premature commit nudges swap");

        // Step 5 -> Step 6: secret 2-card swap (#2 <-> #1)
        assert(ctrl.selectOfferSlot(1).ok, "Stage Slot #2 for swap");
        assertEqual(ctrl.getSnapshot().selectedSwapSlot, 1, "Slot #2 selected");
        assert(ctrl.selectOfferSlot(0).ok, "Complete swap with Slot #1");
        snap = ctrl.getSnapshot();
        assertEqual(snap.tutorial.stepId, TUTORIAL_STEPS.COMMIT_BLUFF, "Step 6 COMMIT_BLUFF");
        assert(snap.view.myHand[0].ticket.isUnlisted, "Unlisted privately moved to Slot #1");
        assertDeepEqual(snap.lastSwappedSlots, [0, 1], "Swapped indicator tracked");

        // Step 6 -> Step 7: commit bluff; Inspector draws Unlisted & re-offers
        assert(ctrl.commitOffer().ok, "Step 6 commit bluff");
        snap = ctrl.getSnapshot();
        assertEqual(snap.tutorial.stepId, TUTORIAL_STEPS.USE_STAMP, "Step 7 USE_STAMP");
        assertEqual(snap.view.unlistedStreak, 2, "Inspector drew Unlisted -> streak 2/3");

        // Step 7 -> Step 8: activate Inspection Window Stamp & peek Slot #1
        assert(ctrl.activateStamp(STAMP_IDS.INSPECTION_WINDOW).ok, "Arm Inspection Window");
        assertEqual(
          ctrl.getSnapshot().activeStampTargeting?.stampId,
          STAMP_IDS.INSPECTION_WINDOW,
          "Targeting mode active for Inspection Window"
        );
        assert(ctrl.drawSlot(0).ok, "Peek Inspector Slot #1");
        snap = ctrl.getSnapshot();
        assertEqual(snap.tutorial.stepId, TUTORIAL_STEPS.WINNING_DRAW, "Step 8 WINNING_DRAW");
        assertEqual(
          snap.view.opponentSlots[0].revealSource,
          "PRIVATE",
          "Slot #1 privately revealed to player"
        );
        assertEqual(
          snap.view.opponentSlots[0].revealedTicket.isUnlisted,
          true,
          "Peek revealed The Unlisted at Slot #1"
        );
        assertEqual(
          snap.view.myForfeitNextSwap,
          true,
          "Stamp tradeoff (forfeit next swap) recorded"
        );

        // Step 8 -> COMPLETE: draw Slot #2 (BELL★) to clear last pair & win!
        assertEqual(ctrl.drawSlot(0).ok, false, "Tutorial prevents accidentally picking revealed Unlisted");
        assert(ctrl.drawSlot(1).ok, "Draw Slot #2 (BELL★) to win tutorial");
        snap = ctrl.getSnapshot();
        assertEqual(snap.tutorial.stepId, TUTORIAL_STEPS.COMPLETE, "Reached COMPLETE summary");
        assertEqual(snap.view.phase, PHASES.OVER, "Tutorial duel finished cleanly");
        assertEqual(snap.view.winner, SIDES.PLAYER, "Player won tutorial duel");
        assertEqual(snap.tutorial.summaryBullets.length, 3, "Run overview has 3 concise bullets");

        // Finish tutorial -> launches Stop 1 Briefing cleanly
        assert(ctrl.tutorialAcknowledge().ok, "Transition from tutorial into Run Stop 1");
        snap = ctrl.getSnapshot();
        assertEqual(snap.screen, RUN_SCREENS.BRIEFING, "Now at Stop 1 BRIEFING");
        assertEqual(snap.stopNumber, 1, "At Carriage 1");
        assertEqual(snap.lanterns, INITIAL_LANTERNS, "Full 3 Lanterns");
        assertEqual(snap.equippedStamps.length, 0, "Clean starting Stamp tray");
        assertEqual(seenSaved, true, "Tutorial completion callback invoked");

        // Verify skipping from multiple mid-tutorial steps AND clean replay anytime.
        for (const advanceCount of [0, 2, 4]) {
          ctrl.startTutorial();
          assertEqual(ctrl.getSnapshot().tutorial.stepNumber, 1, "Tutorial resets to Step 1 on replay");
          if (advanceCount >= 1) ctrl.tutorialAcknowledge();
          if (advanceCount >= 2) ctrl.drawSlot(0);
          if (advanceCount >= 3) ctrl.commitOffer();
          if (advanceCount >= 4) ctrl.drawSlot(0);
          const skipRes = ctrl.skipTutorial();
          assert(skipRes.ok, `Skip succeeded after ${advanceCount} steps`);
          assertEqual(ctrl.getSnapshot().screen, RUN_SCREENS.BRIEFING, "Skip lands on Stop 1 Briefing");
          assertEqual(ctrl.getSnapshot().stopIndex, 0, "Skip starts fresh at Stop 1");
        }

        ctrl.dispose();
      },
    },

    {
      name: "2. All 8 Stamps shipped with exact effects, tradeoffs, privacy boundary, and D5/D8 rules",
      fn() {
        assertEqual(STAMP_LIST.length, 8, "All 8 Stamps (6 MUST + 2 SHOULD) shipped");

        // --- A. Inspection Window + Carbon Copy + D5 deal-pair non-trigger ---
        // Deal clears LANTERN★, SEAL, and WHISTLE on deal (must NOT trigger Carbon Copy), leaving:
        //   Inspector (offerer, 4): [WATCH-A, UNLISTED-0, KEY-A, TRUNK-A]
        //   Player   (drawer, 3):   [WATCH-B, KEY-B, TRUNK-B]
        const deckA = interleave(
          ["LANTERN-A", "LANTERN-B", "WATCH-A", "UNLISTED-0", "KEY-A", "TRUNK-A", "WHISTLE-A"],
          ["SEAL-A", "SEAL-B", "WATCH-B", "KEY-B", "TRUNK-B", "WHISTLE-B"]
        );
        let st = createDuel({
          encounterSeed: "STAMP-A",
          pairCount: 7,
          startingOfferer: SIDES.INSPECTOR,
          playerStamps: [STAMP_IDS.INSPECTION_WINDOW, STAMP_IDS.CARBON_COPY],
          customDeckOrder: [...deckA, "BELL-A", "BELL-B"],
        });
        assertEqual(
          st.eventLog.some((e) => e.type === "STAMP_TRIGGERED"),
          false,
          "D5: Opening deal Emblem pair never fires Carbon Copy"
        );
        st = applyAction(st, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;

        // Peek slot 1 (UNLISTED-0): visible to PLAYER, strictly hidden from INSPECTOR!
        let r = applyAction(st, {
          type: ACTION_TYPES.USE_STAMP,
          actor: SIDES.PLAYER,
          stampId: STAMP_IDS.INSPECTION_WINDOW,
          targetSlot: 1,
        });
        assert(r.ok, "Inspection Window succeeded");
        st = r.state;
        const pView = createObserverView(st, SIDES.PLAYER);
        const iView = createObserverView(st, SIDES.INSPECTOR);
        assertEqual(
          pView.opponentSlots[1].revealedTicket.symbolId,
          "UNLISTED",
          "Player sees peeked Unlisted"
        );
        assertEqual(
          pView.opponentSlots[1].revealSource,
          "PRIVATE",
          "Marked as PRIVATE reveal"
        );
        assertEqual(
          iView.publicHistory.some((e) => e.type === "PRIVATE_REVEAL"),
          false,
          "Inspector publicHistory never receives PRIVATE_REVEAL"
        );
        assertEqual(st.stamps.PLAYER[0].spent, true, "Inspection Window marked spent");
        assertEqual(st.forfeitNextSwap.PLAYER, true, "Next player swap marked forfeited");

        // Draw slot 0 (WATCH-A -> pairs WATCH★ during play) -> Carbon Copy refreshes Inspection Window!
        st = applyAction(st, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 0 }).state;
        assertEqual(st.stamps.PLAYER[0].spent, false, "Carbon Copy refreshed Inspection Window");
        assertEqual(st.stamps.PLAYER[1].spent, true, "Carbon Copy spent (1/stop)");
        assertEqual(st.privateReveals.PLAYER.length, 0, "Private reveal cleared on draw");
        // Now it's Turn 2 Player Offer: Inspection Window tradeoff enforced -> swapsRemaining === 0!
        assertEqual(st.offerer, SIDES.PLAYER, "Turn 2 Player offering");
        assertEqual(st.swapsRemaining, 0, "Inspection Window tradeoff forfeited Player's swap");
        assertEqual(
          applyAction(st, { type: ACTION_TYPES.SWAP, actor: SIDES.PLAYER, indexA: 0, indexB: 1 })
            .reason,
          REJECT_REASONS.NO_SWAPS_REMAINING,
          "SWAP rejected while forfeited"
        );
        assert(verifyInvariants(st).ok, "Invariants hold after Inspection Window + Carbon Copy");

        // --- B. Night Transfer (2 swaps on 3+ hand, rejected on 2-card hand) ---
        const deckB = interleave(
          ["LANTERN-A", "WATCH-A", "KEY-A", "BELL-A", "TRUNK-A", "SEAL-A", "UNLISTED-0"],
          ["LANTERN-B", "WATCH-B", "KEY-B", "BELL-B", "TRUNK-B", "SEAL-B"]
        );
        let stB = createDuel({
          encounterSeed: "STAMP-B",
          pairCount: 6,
          startingOfferer: SIDES.PLAYER,
          playerStamps: [STAMP_IDS.NIGHT_TRANSFER],
          customDeckOrder: deckB,
        });
        assertEqual(stB.swapsRemaining, 1, "Starts with 1 swap");
        r = applyAction(stB, {
          type: ACTION_TYPES.USE_STAMP,
          actor: SIDES.PLAYER,
          stampId: STAMP_IDS.NIGHT_TRANSFER,
        });
        assert(r.ok, "Night Transfer activates on 7-card hand");
        stB = r.state;
        assertEqual(stB.swapsRemaining, 2, "Night Transfer grants 2 swaps this offer");
        stB = applyAction(stB, {
          type: ACTION_TYPES.SWAP,
          actor: SIDES.PLAYER,
          indexA: 6,
          indexB: 3,
        }).state;
        stB = applyAction(stB, {
          type: ACTION_TYPES.SWAP,
          actor: SIDES.PLAYER,
          indexA: 3,
          indexB: 0,
        }).state;
        assertEqual(stB.swapsRemaining, 0, "Both swaps consumed cleanly");
        assert(stB.hands.PLAYER[0].isUnlisted, "Two swaps moved Unlisted 6 -> 3 -> 0");
        assert(verifyInvariants(stB).ok, "Invariants hold after Night Transfer");

        // --- C. Spare Wick (+1 Lantern, rejected at 3/3, permanently burns & frees slot) ---
        let stFull = createDuel({
          encounterSeed: "STAMP-C1",
          pairCount: 6,
          startingOfferer: SIDES.PLAYER,
          playerStamps: [STAMP_IDS.SPARE_WICK],
          playerLanterns: 3,
          maxLanterns: 3,
        });
        assertEqual(
          applyAction(stFull, {
            type: ACTION_TYPES.USE_STAMP,
            actor: SIDES.PLAYER,
            stampId: STAMP_IDS.SPARE_WICK,
          }).reason,
          REJECT_REASONS.STAMP_UNAVAILABLE,
          "Spare Wick blocked when Lanterns already full (3/3)"
        );
        let stHurt = createDuel({
          encounterSeed: "STAMP-C2",
          pairCount: 6,
          startingOfferer: SIDES.PLAYER,
          playerStamps: [STAMP_IDS.SPARE_WICK, STAMP_IDS.INSPECTION_WINDOW],
          playerLanterns: 1,
          maxLanterns: 3,
        });
        r = applyAction(stHurt, {
          type: ACTION_TYPES.USE_STAMP,
          actor: SIDES.PLAYER,
          stampId: STAMP_IDS.SPARE_WICK,
        });
        assert(r.ok, "Spare Wick burns when Lanterns < 3");
        stHurt = r.state;
        assertEqual(stHurt.lanterns.PLAYER, 2, "Lanterns increased 1 -> 2");
        assertEqual(stHurt.stamps.PLAYER.length, 1, "Spare Wick immediately freed its slot");
        assertEqual(stHurt.stamps.PLAYER[0].id, STAMP_IDS.INSPECTION_WINDOW, "Other Stamp kept");
        assertDeepEqual(stHurt.consumedStamps.PLAYER, [STAMP_IDS.SPARE_WICK], "Burn recorded");

        // --- D. Manifest Loupe + Brass Weight + Exposure Deduplication (D8) ---
        let stD = createDuel({
          encounterSeed: "STAMP-D",
          pairCount: 6,
          startingOfferer: SIDES.INSPECTOR,
          conditionId: CONDITION_IDS.DRAFTY_WINDOW,
          playerStamps: [
            STAMP_IDS.MANIFEST_LOUPE,
            STAMP_IDS.BRASS_WEIGHT,
            STAMP_IDS.CARBON_COPY,
          ],
          customDeckOrder: deckB, // Inspector has 7 cards (UNLISTED at slot 6), Player has 6 (LANTERN..COAT)
        });
        stD = applyAction(stD, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
        // Check adjacent pair (0, 1) -> NO (Unlisted is at slot 6)
        r = applyAction(stD, {
          type: ACTION_TYPES.USE_STAMP,
          actor: SIDES.PLAYER,
          stampId: STAMP_IDS.MANIFEST_LOUPE,
          targetSlot: 0,
        });
        assert(r.ok, "Manifest Loupe activated on (0,1)");
        stD = r.state;
        assertDeepEqual(
          createObserverView(stD, SIDES.PLAYER).myLoupeClues,
          [{ offerId: 1, slotA: 0, slotB: 1, hasUnlisted: false }],
          "Loupe reports NO for (0,1)"
        );
        assertEqual(
          createObserverView(stD, SIDES.INSPECTOR).myLoupeClues.length,
          0,
          "Loupe clue stays private from Inspector"
        );
        assertEqual(stD.pendingPublicExposure.PLAYER.left, true, "Left exposure queued");

        // Draw slot 0 (LANTERN-A) -> Carbon Copy refreshes Manifest Loupe!
        stD = applyAction(stD, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 0 }).state;
        assertEqual(stD.stamps.PLAYER[0].spent, false, "Carbon Copy refreshes Manifest Loupe too!");
        assertEqual(stD.privateLoupeClues.PLAYER.length, 0, "Loupe clues cleared after draw");

        // Turn 2 Player Offer: use Brass Weight to lock slot 2 (KEY-B)
        r = applyAction(stD, {
          type: ACTION_TYPES.USE_STAMP,
          actor: SIDES.PLAYER,
          stampId: STAMP_IDS.BRASS_WEIGHT,
          targetSlot: 2,
        });
        assert(r.ok, "Brass Weight locked ordinary slot 2");
        stD = r.state;
        assertEqual(
          applyAction(stD, { type: ACTION_TYPES.SWAP, actor: SIDES.PLAYER, indexA: 2, indexB: 0 })
            .reason,
          REJECT_REASONS.SLOT_LOCKED,
          "Cannot swap a Brass-Weighted slot"
        );
        // Commit Offer under Drafty Window + queued left exposure: D8 deduplicates slot 0 to 1 reveal!
        stD = applyAction(stD, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;
        assertEqual(
          stD.publicReveals.filter((rv) => rv.slotIndex === 0).length,
          1,
          "D8: Drafty Window + Loupe left exposure reveals slot 0 only once"
        );
        assertEqual(
          applyAction(stD, { type: ACTION_TYPES.DRAW, actor: SIDES.INSPECTOR, slotIndex: 2 })
            .reason,
          REJECT_REASONS.SLOT_LOCKED,
          "Inspector cannot draw Brass-Weighted slot"
        );
        assertEqual(
          stD.pendingPublicExposure.PLAYER.right,
          true,
          "Brass Weight right-edge exposure persists for player's NEXT offer"
        );
        // Follow through to Player's next Offer (Turn 4) and confirm right-edge exposure fires then!
        stD = applyAction(stD, { type: ACTION_TYPES.DRAW, actor: SIDES.INSPECTOR, slotIndex: 0 }).state;
        stD = applyAction(stD, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
        stD = applyAction(stD, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 0 }).state;
        assertEqual(stD.turnNumber, 4, "Reached Player's next Offer (Turn 4)");
        stD = applyAction(stD, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;
        const lastSlotIdx = stD.hands.PLAYER.length - 1;
        assert(
          stD.publicReveals.some(
            (rv) => rv.slotIndex === lastSlotIdx && rv.source === "STAMP_EXPOSURE_RIGHT"
          ),
          "Brass Weight exposed player's rightmost slot on next Offer"
        );
        assertEqual(
          stD.pendingPublicExposure.PLAYER.right,
          false,
          "Right-edge exposure consumed after firing"
        );
        // Also verify Brass Weight forbids locking UNLISTED-0:
        let stUnl = createDuel({
          encounterSeed: "STAMP-BW-UNL",
          pairCount: 6,
          startingOfferer: SIDES.PLAYER,
          playerStamps: [STAMP_IDS.BRASS_WEIGHT],
          customDeckOrder: deckB, // Player has UNLISTED-0 at slot 6
        });
        assertEqual(
          applyAction(stUnl, {
            type: ACTION_TYPES.USE_STAMP,
            actor: SIDES.PLAYER,
            stampId: STAMP_IDS.BRASS_WEIGHT,
            targetSlot: 6,
          }).reason,
          REJECT_REASONS.INVALID_STAMP_TARGET,
          "Brass Weight strictly refuses to lock UNLISTED-0"
        );

        // --- E. Bell Cord (dormant -> KEY★/BELL★ pair charges -> reveals hidden Emblem★ + swap forfeit) ---
        // Inspector: [KEY-A, TRUNK-A, WATCH-A, SEAL-A, WHISTLE-A, COMPASS-A, UNLISTED-0]
        // Player:    [KEY-B, TRUNK-B, WATCH-B, SEAL-B, WHISTLE-B, COMPASS-B]
        const deckE = interleave(
          ["KEY-A", "TRUNK-A", "WATCH-A", "SEAL-A", "WHISTLE-A", "COMPASS-A", "UNLISTED-0"],
          ["KEY-B", "TRUNK-B", "WATCH-B", "SEAL-B", "WHISTLE-B", "COMPASS-B"]
        );
        let stE = createDuel({
          encounterSeed: "STAMP-E",
          pairCount: 8,
          startingOfferer: SIDES.INSPECTOR,
          playerStamps: [STAMP_IDS.BELL_CORD],
          customDeckOrder: [
            "LANTERN-A",
            "BELL-A",
            "LANTERN-B",
            "BELL-B",
            ...deckE,
          ],
        });
        stE = applyAction(stE, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
        assertEqual(
          applyAction(stE, {
            type: ACTION_TYPES.USE_STAMP,
            actor: SIDES.PLAYER,
            stampId: STAMP_IDS.BELL_CORD,
          }).reason,
          REJECT_REASONS.STAMP_UNAVAILABLE,
          "Bell Cord dormant before KEY★/BELL★ is matched"
        );
        // Draw slot 0 (KEY-A) -> charges Bell Cord!
        stE = applyAction(stE, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 0 }).state;
        assertEqual(stE.stamps.PLAYER[0].tokenReady, true, "Matching KEY★ charged Bell Cord");
        // Advance back to Player Draw (Turn 3)
        stE = applyAction(stE, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;
        stE = applyAction(stE, { type: ACTION_TYPES.DRAW, actor: SIDES.INSPECTOR, slotIndex: 0 }).state; // pairs TRUNK
        stE = applyAction(stE, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
        // Inspector now holds [WATCH-A (only Emblem★!), COAT-A, BRIDGE-A, CLOCK-A, UNLISTED-0]
        r = applyAction(stE, {
          type: ACTION_TYPES.USE_STAMP,
          actor: SIDES.PLAYER,
          stampId: STAMP_IDS.BELL_CORD,
        });
        assert(r.ok, "Charged Bell Cord activates in Draw phase");
        stE = r.state;
        assertEqual(stE.publicReveals.length, 1, "Bell Cord revealed 1 Emblem★ slot");
        assertEqual(stE.publicReveals[0].ticket.symbolId, "WATCH", "Revealed WATCH★ slot");
        assertEqual(stE.stamps.PLAYER[0].spent, true, "Bell Cord spent");
        assertEqual(stE.forfeitNextSwap.PLAYER, true, "Bell Cord forfeits next Offer swap");
        assert(verifyInvariants(stE).ok, "Invariants hold after Bell Cord");

        // --- F. Last-Stop Punch (streak +1 -> instant Final Call on Unlisted draw; left expose on pair) ---
        let stF = createDuel({
          encounterSeed: "STAMP-F",
          pairCount: 6,
          startingOfferer: SIDES.INSPECTOR,
          playerStamps: [STAMP_IDS.LAST_STOP_PUNCH],
          customDeckOrder: deckB, // Inspector has UNLISTED-0 at slot 6
        });
        // Pass Unlisted twice: T1 Player draws #6 (streak=1), T2 Inspector draws #6 (streak=2)
        stF = applyAction(stF, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
        assertEqual(
          applyAction(stF, {
            type: ACTION_TYPES.USE_STAMP,
            actor: SIDES.PLAYER,
            stampId: STAMP_IDS.LAST_STOP_PUNCH,
          }).reason,
          REJECT_REASONS.STAMP_UNAVAILABLE,
          "Last-Stop Punch blocked at streak 0"
        );
        stF = applyAction(stF, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 6 }).state;
        assertEqual(stF.unlistedStreak, 1, "Streak = 1");
        stF = applyAction(stF, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;
        stF = applyAction(stF, { type: ACTION_TYPES.DRAW, actor: SIDES.INSPECTOR, slotIndex: 6 }).state;
        assertEqual(stF.unlistedStreak, 2, "Streak = 2");
        stF = applyAction(stF, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;

        // Branch F1: activate Last-Stop Punch (streak 2 -> 3) and draw a PAIR (slot 0) -> left exposure penalty!
        const rPunch = applyAction(stF, {
          type: ACTION_TYPES.USE_STAMP,
          actor: SIDES.PLAYER,
          stampId: STAMP_IDS.LAST_STOP_PUNCH,
        });
        assert(rPunch.ok, "Last-Stop Punch activates at streak >= 1");
        const stPair = applyAction(rPunch.state, {
          type: ACTION_TYPES.DRAW,
          actor: SIDES.PLAYER,
          slotIndex: 0,
        }).state;
        assertEqual(stPair.unlistedStreak, 0, "Normal pair resets streak to 0");
        assertEqual(
          stPair.pendingPublicExposure.PLAYER.left,
          true,
          "Last-Stop Punch penalty queues left-slot exposure after pairing"
        );

        // Branch F2: at streak 1, activate Punch (streak 1 -> 2), draw UNLISTED (streak -> 3) -> Final Call!
        let stF2 = createDuel({
          encounterSeed: "STAMP-F2",
          pairCount: 6,
          startingOfferer: SIDES.PLAYER,
          playerStamps: [STAMP_IDS.LAST_STOP_PUNCH],
          customDeckOrder: deckB, // Player has UNLISTED at slot 6
        });
        stF2 = applyAction(stF2, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;
        stF2 = applyAction(stF2, { type: ACTION_TYPES.DRAW, actor: SIDES.INSPECTOR, slotIndex: 6 }).state;
        assertEqual(stF2.unlistedStreak, 1, "Inspector drew Unlisted -> streak 1");
        stF2 = applyAction(stF2, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
        stF2 = applyAction(stF2, {
          type: ACTION_TYPES.USE_STAMP,
          actor: SIDES.PLAYER,
          stampId: STAMP_IDS.LAST_STOP_PUNCH,
        }).state;
        assertEqual(stF2.unlistedStreak, 2, "Punch raised streak 1 -> 2");
        // Draw Unlisted at Inspector's arrival right edge (slot 6) -> streak hits 3 -> Final Call locks Player's Unlisted!
        stF2 = applyAction(stF2, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 6 }).state;
        assertEqual(Boolean(stF2.finalCall?.active), true, "Punch accelerated Final Call by 1 pass!");
        assertEqual(
          stF2.pendingPublicExposure.PLAYER.left,
          false,
          "No exposure penalty when Unlisted is drawn"
        );
        assert(verifyInvariants(stF2).ok, "Invariants hold after Last-Stop Punch Final Call");
      },
    },

    {
      name: "3. Three distinct Stamp synergy combos measurably alter legal & optimal turn decisions on identical seeds",
      fn() {
        // Combo 1: Inspection Window + Carbon Copy vs Inspection Window alone
        const comboDeck1 = interleave(
          ["UNLISTED-0", "LANTERN-A", "KEY-A", "BELL-A", "TRUNK-A", "SEAL-A", "WATCH-A"],
          ["LANTERN-B", "KEY-B", "BELL-B", "TRUNK-B", "SEAL-B", "WATCH-B"]
        );
        function runPeekSequence(stamps) {
          let s = createDuel({
            encounterSeed: "COMBO-1",
            pairCount: 6,
            startingOfferer: SIDES.INSPECTOR,
            playerStamps: stamps,
            customDeckOrder: comboDeck1,
          });
          s = applyAction(s, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
          // Turn 1: Peek slot 0 (spots UNLISTED-0!), then draw slot 1 (pairs LANTERN★!)
          s = applyAction(s, {
            type: ACTION_TYPES.USE_STAMP,
            actor: SIDES.PLAYER,
            stampId: STAMP_IDS.INSPECTION_WINDOW,
            targetSlot: 0,
          }).state;
          s = applyAction(s, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 1 }).state;
          // Turn 2: Player commits, Inspector draws slot 0 (KEY-B), Inspector commits Turn 3
          s = applyAction(s, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;
          s = applyAction(s, { type: ACTION_TYPES.DRAW, actor: SIDES.INSPECTOR, slotIndex: 0 }).state;
          s = applyAction(s, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
          return getLegalActions(s, SIDES.PLAYER);
        }

        const soloLegal = runPeekSequence([STAMP_IDS.INSPECTION_WINDOW]);
        const comboLegal = runPeekSequence([STAMP_IDS.INSPECTION_WINDOW, STAMP_IDS.CARBON_COPY]);
        assertEqual(
          soloLegal.usableStampIds.includes(STAMP_IDS.INSPECTION_WINDOW),
          false,
          "Solo Inspection Window stays spent on Turn 3"
        );
        assertEqual(
          comboLegal.usableStampIds.includes(STAMP_IDS.INSPECTION_WINDOW),
          true,
          "Inspection Window + Carbon Copy unlocks a second full peek on Turn 3"
        );

        // Combo 2: Inspection Window + Night Transfer cancels swap-forfeit to hide drawn Unlisted
        function runSwapCancelSequence(stamps) {
          let s = createDuel({
            encounterSeed: "COMBO-2",
            pairCount: 6,
            startingOfferer: SIDES.INSPECTOR,
            playerStamps: stamps,
            customDeckOrder: comboDeck1,
          });
          s = applyAction(s, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
          // Peek slot 1 (LANTERN-A), draw slot 0 (UNLISTED-0 -> lands at right edge of Player hand)
          s = applyAction(s, {
            type: ACTION_TYPES.USE_STAMP,
            actor: SIDES.PLAYER,
            stampId: STAMP_IDS.INSPECTION_WINDOW,
            targetSlot: 1,
          }).state;
          s = applyAction(s, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 0 }).state;
          if (stamps.includes(STAMP_IDS.NIGHT_TRANSFER)) {
            const nt = applyAction(s, {
              type: ACTION_TYPES.USE_STAMP,
              actor: SIDES.PLAYER,
              stampId: STAMP_IDS.NIGHT_TRANSFER,
            });
            assert(nt.ok, "Night Transfer fires despite Inspection Window swap forfeit");
            s = nt.state;
          }
          return getLegalActions(s, SIDES.PLAYER);
        }

        const trappedOffer = runSwapCancelSequence([STAMP_IDS.INSPECTION_WINDOW]);
        const freedOffer = runSwapCancelSequence([
          STAMP_IDS.INSPECTION_WINDOW,
          STAMP_IDS.NIGHT_TRANSFER,
        ]);
        assertEqual(trappedOffer.canSwap, false, "Without Night Transfer, Unlisted is pinned at right edge");
        assertEqual(freedOffer.canSwap, true, "With Night Transfer, player regains private swap to hide Unlisted");

        // Combo 3: Brass Weight boosts Inspector Unlisted-draw odds from 1/3 to 1/2 on 3-card fan
        const threeCardDeck = interleave(
          ["LANTERN-A", "LANTERN-B", "WATCH-A", "WATCH-B", "KEY-A", "BELL-A", "UNLISTED-0"],
          ["TRUNK-A", "TRUNK-B", "SEAL-A", "SEAL-B", "KEY-B", "BELL-B"]
        );
        let sBase = createDuel({
          encounterSeed: "COMBO-3",
          pairCount: 6,
          startingOfferer: SIDES.PLAYER,
          playerStamps: [],
          customDeckOrder: threeCardDeck,
        });
        sBase = applyAction(sBase, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;

        let sWeight = createDuel({
          encounterSeed: "COMBO-3",
          pairCount: 6,
          startingOfferer: SIDES.PLAYER,
          playerStamps: [STAMP_IDS.BRASS_WEIGHT],
          customDeckOrder: threeCardDeck,
        });
        sWeight = applyAction(sWeight, {
          type: ACTION_TYPES.USE_STAMP,
          actor: SIDES.PLAYER,
          stampId: STAMP_IDS.BRASS_WEIGHT,
          targetSlot: 0, // Lock KEY-A, leaving only [BELL-A, UNLISTED-0]
        }).state;
        sWeight = applyAction(sWeight, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;

        const baseSlots = getLegalActions(sBase, SIDES.INSPECTOR).legalDrawSlots;
        const weightSlots = getLegalActions(sWeight, SIDES.INSPECTOR).legalDrawSlots;
        assertEqual(baseSlots.length, 3, "Base 3-card offer has 1/3 Unlisted hit rate");
        assertEqual(weightSlots.length, 2, "Brass Weight narrows legal draws to 2 (1/2 Unlisted hit rate)");
        assert(weightSlots.includes(2), "Unlisted slot remains unlocked and drawable");
      },
    },

    {
      name: "4. All 4 Carriage Conditions enforce rules, report live status, scale Late Schedule (D10), and expire cleanly",
      fn() {
        assertEqual(CONDITION_LIST.length, 4, "All 4 Carriage Conditions (3 MUST + 1 SHOULD) shipped");
        const fullDeck = interleave(
          ["LANTERN-A", "WATCH-A", "KEY-A", "BELL-A", "TRUNK-A", "SEAL-A", "UNLISTED-0"],
          ["LANTERN-B", "WATCH-B", "KEY-B", "BELL-B", "TRUNK-B", "SEAL-B"]
        );

        // 1. SEALED_MANIFEST: blocks swaps + Night Transfer on Turns 1–2, expires at Turn 3
        let s1 = createDuel({
          encounterSeed: "COND-SEALED",
          pairCount: 6,
          startingOfferer: SIDES.PLAYER,
          conditionId: CONDITION_IDS.SEALED_MANIFEST,
          playerStamps: [STAMP_IDS.NIGHT_TRANSFER],
          customDeckOrder: fullDeck,
        });
        assertEqual(s1.swapsRemaining, 0, "Turn 1 swap blocked by Sealed Manifest");
        assertEqual(
          applyAction(s1, {
            type: ACTION_TYPES.USE_STAMP,
            actor: SIDES.PLAYER,
            stampId: STAMP_IDS.NIGHT_TRANSFER,
          }).reason,
          REJECT_REASONS.STAMP_UNAVAILABLE,
          "Night Transfer blocked during Sealed Manifest"
        );
        assertEqual(createObserverView(s1, SIDES.PLAYER).conditionLive.expired, false, "Active on T1");
        s1 = applyAction(s1, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;
        s1 = applyAction(s1, { type: ACTION_TYPES.DRAW, actor: SIDES.INSPECTOR, slotIndex: 0 }).state;
        assertEqual(s1.turnNumber, 2, "Turn 2");
        assertEqual(s1.swapsRemaining, 0, "Turn 2 swap also blocked by Sealed Manifest");
        s1 = applyAction(s1, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
        s1 = applyAction(s1, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 0 }).state;
        assertEqual(s1.turnNumber, 3, "Turn 3");
        assertEqual(s1.condition.expired, true, "Sealed Manifest expired at start of Turn 3");
        assertEqual(s1.swapsRemaining, 1, "Normal swaps restored on Turn 3");
        assertEqual(
          getLegalActions(s1, SIDES.PLAYER).usableStampIds.includes(STAMP_IDS.NIGHT_TRANSFER),
          true,
          "Night Transfer unlocked on Turn 3"
        );

        // 2. DRAFTY_WINDOW: exposes leftmost unlocked slot Turns 1–4, expires at Turn 5
        let s2 = createDuel({
          encounterSeed: "COND-DRAFTY",
          pairCount: 6,
          startingOfferer: SIDES.PLAYER,
          conditionId: CONDITION_IDS.DRAFTY_WINDOW,
          customDeckOrder: fullDeck,
        });
        for (let t = 1; t <= 4; t += 1) {
          assertEqual(s2.condition.expired, false, `Drafty Window active on Turn ${t}`);
          s2 = applyAction(s2, { type: ACTION_TYPES.COMMIT_OFFER, actor: s2.offerer }).state;
          assertEqual(s2.publicReveals.length, 1, `Leftmost slot exposed on Turn ${t}`);
          s2 = applyAction(s2, { type: ACTION_TYPES.DRAW, actor: s2.drawer, slotIndex: 0 }).state;
        }
        assertEqual(s2.turnNumber, 5, "Reached Turn 5");
        assertEqual(s2.condition.expired, true, "Drafty Window expired at Turn 5");
        assertEqual(createObserverView(s2, SIDES.PLAYER).conditionLive.expired, true, "Live badge shows expired");
        s2 = applyAction(s2, { type: ACTION_TYPES.COMMIT_OFFER, actor: s2.offerer }).state;
        assertEqual(s2.publicReveals.length, 0, "Zero Drafty Window reveals on Turn 5");

        // 3. LATE_SCHEDULE: blocks active Stamps until 3 played pairs, AND scales down on small post-deal hand (D10)
        let s3 = createDuel({
          encounterSeed: "COND-LATE",
          pairCount: 6,
          startingOfferer: SIDES.INSPECTOR,
          conditionId: CONDITION_IDS.LATE_SCHEDULE,
          playerStamps: [STAMP_IDS.INSPECTION_WINDOW, STAMP_IDS.NIGHT_TRANSFER],
          customDeckOrder: fullDeck,
        });
        assertEqual(s3.condition.requiredPlayedPairs, 3, "Full deal requires 3 played pairs");
        for (let p = 0; p < 3; p += 1) {
          s3 = applyAction(s3, { type: ACTION_TYPES.COMMIT_OFFER, actor: s3.offerer }).state;
          assertEqual(
            getLegalActions(s3, s3.drawer).usableStampIds.length,
            0,
            `Stamps locked at ${p}/3 played pairs`
          );
          s3 = applyAction(s3, { type: ACTION_TYPES.DRAW, actor: s3.drawer, slotIndex: 0 }).state;
        }
        assertEqual(s3.condition.expired, true, "Late Schedule expired immediately on 3rd played pair");
        assertEqual(
          getLegalActions(s3, SIDES.PLAYER).usableStampIds.includes(STAMP_IDS.NIGHT_TRANSFER),
          true,
          "Stamps immediately usable after Late Schedule expires"
        );

        // D10 small-hand scaling: only 2 live pairs left after opening deal -> requiredPlayedPairs = 1
        const smallDealDeck = interleave(
          ["LANTERN-A", "LANTERN-B", "WATCH-A", "WATCH-B", "KEY-A", "BELL-A", "UNLISTED-0"],
          ["TRUNK-A", "TRUNK-B", "SEAL-A", "SEAL-B", "KEY-B", "BELL-B"]
        );
        let s3Small = createDuel({
          encounterSeed: "COND-LATE-SMALL",
          pairCount: 6,
          startingOfferer: SIDES.INSPECTOR,
          conditionId: CONDITION_IDS.LATE_SCHEDULE,
          playerStamps: [STAMP_IDS.INSPECTION_WINDOW],
          customDeckOrder: smallDealDeck,
        });
        assertEqual(s3Small.initialRemainingPairs, 2, "2 remaining pairs after deal");
        assertEqual(s3Small.condition.requiredPlayedPairs, 1, "D10 scaled Late Schedule down to 1 pair");

        // 4. SHORT_WHISTLE: Final Call triggers at streak 2 and stays active all duel
        let s4 = createDuel({
          encounterSeed: "COND-WHISTLE",
          pairCount: 6,
          startingOfferer: SIDES.INSPECTOR,
          conditionId: CONDITION_IDS.SHORT_WHISTLE,
          customDeckOrder: fullDeck, // Inspector holds UNLISTED-0 at slot 6
        });
        assertEqual(s4.finalCallThreshold, 2, "Short Whistle sets threshold to 2");
        s4 = applyAction(s4, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
        s4 = applyAction(s4, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 6 }).state;
        assertEqual(s4.finalCall, null, "No Final Call after 1 pass");
        s4 = applyAction(s4, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;
        s4 = applyAction(s4, { type: ACTION_TYPES.DRAW, actor: SIDES.INSPECTOR, slotIndex: 6 }).state;
        assertEqual(Boolean(s4.finalCall?.active), true, "Final Call fires after 2 passes under Short Whistle");
        assertEqual(s4.condition.expired, false, "Short Whistle stays active all carriage");
      },
    },

    {
      name: "5. 320-duel Stamp + Condition fuzz & JSON replay audit preserves conservation, zero deadlocks & exact determinism",
      fn() {
        const allStampIds = STAMP_LIST.map((s) => s.id);
        const condPool = [null, ...CONDITION_LIST.map((c) => c.id)];
        const agent = createInspectorAgent({ tier: 3 });

        let totalStampUses = 0;
        let totalPairTriggers = 0;
        let totalConditionExpiries = 0;

        for (let i = 0; i < 320; i += 1) {
          const masterRng = createRng(deriveSeed("P3-FUZZ", i));
          const pairCount = 6 + (i % 7); // 6..12
          const conditionId = condPool[i % condPool.length];
          const tier = 1 + (i % 5);
          const stampCount = 1 + (i % MAX_STAMP_SLOTS);
          const playerStamps = masterRng.shuffle(allStampIds).slice(0, stampCount);
          const playerLanterns = 1 + (i % 3);

          agent.setTier(tier);
          if (i % 5 === 0) agent.resetForNewRun();
          else agent.resetForNewDuel();

          const aiRng = createRng(deriveSeed("P3-FUZZ-AI", i));
          const botRng = createRng(deriveSeed("P3-FUZZ-BOT", i));

          let st = createDuel({
            encounterSeed: `P3-DEAL-${i}`,
            pairCount,
            encounterIndex: i,
            conditionId,
            playerStamps,
            playerLanterns,
            maxLanterns: 3,
          });

          let inv = verifyInvariants(st);
          assert(inv.ok, `Init invariant failure on duel ${i}: ${inv.errors.join("; ")}`);

          let steps = 0;
          while (st.phase !== PHASES.OVER) {
            steps += 1;
            assert(steps < 400, `Duel ${i} terminated without deadlock`);

            if (st.phase === PHASES.OFFER && st.offerer === SIDES.INSPECTOR) {
              const a = agent.act(createObserverView(st, SIDES.INSPECTOR), aiRng);
              const r = applyAction(st, a);
              assert(r.ok, `Inspector offer valid on duel ${i}: ${r.message}`);
              st = r.state;
            } else if (st.phase === PHASES.DRAW && st.drawer === SIDES.INSPECTOR) {
              const a = agent.act(createObserverView(st, SIDES.INSPECTOR), aiRng);
              const r = applyAction(st, a);
              assert(r.ok, `Inspector draw valid on duel ${i}: ${r.message}`);
              st = r.state;
              agent.observe(createObserverView(st, SIDES.INSPECTOR));
            } else {
              // Player bot eagerly exercises all usable Stamps (~65% chance), swaps, commits, and draws!
              const legal = getLegalActions(st, SIDES.PLAYER);
              const usable = legal.stampStatuses.filter((s) => s.canUse);
              if (usable.length > 0 && botRng.next() < 0.65) {
                const chosen = botRng.pick(usable);
                const act = {
                  type: ACTION_TYPES.USE_STAMP,
                  actor: SIDES.PLAYER,
                  stampId: chosen.id,
                  seq: legal.nextSeq,
                };
                if (chosen.needsTarget) {
                  act.targetSlot = botRng.pick(chosen.validTargets);
                }
                const r = applyAction(st, act);
                assert(r.ok, `Player USE_STAMP ${chosen.id} valid on duel ${i}: ${r.message}`);
                st = r.state;
                totalStampUses += 1;
              } else if (st.phase === PHASES.OFFER) {
                if (legal.canSwap && legal.legalSwapSlots.length >= 2 && botRng.next() < 0.6) {
                  const picked = botRng.shuffle(legal.legalSwapSlots);
                  const r = applyAction(st, {
                    type: ACTION_TYPES.SWAP,
                    actor: SIDES.PLAYER,
                    indexA: picked[0],
                    indexB: picked[1],
                    seq: legal.nextSeq,
                  });
                  assert(r.ok, `Player SWAP valid on duel ${i}`);
                  st = r.state;
                } else {
                  const r = applyAction(st, {
                    type: ACTION_TYPES.COMMIT_OFFER,
                    actor: SIDES.PLAYER,
                    seq: legal.nextSeq,
                  });
                  assert(r.ok, `Player COMMIT valid on duel ${i}`);
                  st = r.state;
                }
              } else {
                const slot = botRng.pick(legal.legalDrawSlots);
                const r = applyAction(st, {
                  type: ACTION_TYPES.DRAW,
                  actor: SIDES.PLAYER,
                  slotIndex: slot,
                  seq: legal.nextSeq,
                });
                assert(r.ok, `Player DRAW valid on duel ${i}`);
                st = r.state;
                agent.observe(createObserverView(st, SIDES.INSPECTOR));
              }
            }

            inv = verifyInvariants(st);
            assert(inv.ok, `Step invariant failure on duel ${i}: ${inv.errors.join("; ")}`);
          }

          totalPairTriggers += st.eventLog.filter((e) => e.type === "STAMP_TRIGGERED").length;
          totalConditionExpiries += st.eventLog.filter((e) => e.type === "CONDITION_EXPIRED").length;

          // Verify full JSON round-trip replay on every 4th duel (80 full Stamp+Condition replays).
          if (i % 4 === 0) {
            const bundle = JSON.parse(JSON.stringify(exportReplay(st)));
            const rep = replayDuel(bundle);
            assert(rep.ok, `Replay succeeded on duel ${i}: ${rep.message}`);
            assertEqual(rep.state.winner, st.winner, `Replay winner match on duel ${i}`);
            assertEqual(rep.state.lanterns.PLAYER, st.lanterns.PLAYER, `Replay lanterns match on duel ${i}`);
            assertDeepEqual(rep.state.stamps, st.stamps, `Replay stamps match on duel ${i}`);
            assertDeepEqual(rep.state.eventLog, st.eventLog, `Replay eventLog match on duel ${i}`);
          }
        }

        assert(totalStampUses >= 150, `Exercised plenty of active Stamp uses (${totalStampUses})`);
        assert(totalPairTriggers >= 15, `Exercised passive Emblem pair triggers (${totalPairTriggers})`);
        assert(totalConditionExpiries >= 80, `Exercised Condition expirations (${totalConditionExpiries})`);
      },
    },

    {
      name: "6. Full 5-stop multi-deal run progression: Bo3/Bo5 deals, Stamp pick/replace/skip, early loss, Spare Wick heal, boss rematch & 0-lantern Defeat",
      fn() {
        const rng = createRng("RUN-FLOW-RNG");

        // Helper: finish an entire multi-deal carriage with desired side winning every deal,
        // verifying per-deal starter alternation, per-deal Stamp refresh, and no Lantern loss mid-match!
        function finishCarriageWithWinner(controller, desiredWinner, splitOneDeal = false) {
          const dealStarters = [];
          let lostOne = false;
          controller.beginStopDuel();
          while (controller.getSnapshot().screen === RUN_SCREENS.DUEL) {
            const ds = controller.getSnapshot();
            dealStarters.push(ds.view.offerer);
            for (const s of ds.view.myStamps) {
              assertEqual(s.spent, false, `Stamp ${s.id} refreshed at start of deal`);
            }
            const target =
              splitOneDeal && !lostOne
                ? desiredWinner === SIDES.PLAYER
                  ? SIDES.INSPECTOR
                  : SIDES.PLAYER
                : desiredWinner;
            if (target !== desiredWinner) lostOne = true;

            const lanternsPre = ds.lanterns;
            finishActiveDuelWithOutcome(controller, target, rng);
            const post = controller.getSnapshot();
            if (post.screen === RUN_SCREENS.STOP_RESULT && post.lastStopSummary.kind === "DEAL_CONTINUE") {
              assertEqual(post.lanterns, lanternsPre, "Mid-carriage deal never deducts a Lantern");
              controller.continueAfterStop();
              assertEqual(
                controller.getSnapshot().screen,
                RUN_SCREENS.DUEL,
                "continueAfterStop launches next deal in multi-deal carriage"
              );
            }
          }
          // Verify strict alternation across consecutive deals inside the carriage!
          for (let i = 1; i < dealStarters.length; i += 1) {
            assert(
              dealStarters[i] !== dealStarters[i - 1],
              "Starting offerer strictly alternates between deals"
            );
          }
          return dealStarters;
        }

        // --- Scenario A: Full 5-stop multi-deal Victory (Bo3 on Car I–IV incl. 2-1 split, Bo5 on Stop V) ---
        const ctrl = createRunController({
          initialSeed: "VICTORY-TRAIN-7",
          immediate: true,
          opponentOverride: firstSlotTestOpponent,
        });
        ctrl.startRun({ seed: "VICTORY-TRAIN-7" });

        const allDealStarters = [];
        for (let stop = 0; stop < 5; stop += 1) {
          let snap = ctrl.getSnapshot();
          assertEqual(snap.screen, RUN_SCREENS.BRIEFING, `Stop ${stop + 1} starts at BRIEFING`);
          assertEqual(snap.stopIndex, stop, `Stop index = ${stop}`);
          assertEqual(
            snap.briefing.carriage.pairCount,
            CARRIAGES[stop].pairCount,
            `Stop ${stop + 1} pairCount matches schedule`
          );
          assertEqual(
            snap.briefing.tier,
            CARRIAGES[stop].aiTier,
            `Stop ${stop + 1} elevated AI tier = T${CARRIAGES[stop].aiTier}`
          );
          assertEqual(
            snap.briefing.dealsRequired,
            stop === 4 ? 3 : 2,
            `Stop ${stop + 1} dealsRequired = ${stop === 4 ? 3 : 2}`
          );

          // Split 1 deal on Stop 1 (win 2–1) and Stop 5 (win 3–1) to test full Bo3 & Bo5 match scoring!
          const starters = finishCarriageWithWinner(
            ctrl,
            SIDES.PLAYER,
            stop === 0 || stop === 4
          );
          allDealStarters.push(...starters);
          snap = ctrl.getSnapshot();

          if (stop < 4) {
            assertEqual(snap.screen, RUN_SCREENS.STOP_RESULT, `Stop ${stop + 1} shows STOP_RESULT`);
            assertEqual(snap.lastStopSummary.kind, "CARRIAGE_OVER", "Carriage marked complete");
            assertEqual(snap.lastStopSummary.won, true, `Won Stop ${stop + 1}`);
            assertEqual(snap.lastStopSummary.dealWins, 2, "Won 2 deals on Carriage I–IV");
            if (stop === 0) {
              assertEqual(snap.lastStopSummary.dealLosses, 1, "Tracked 2–1 Best-of-3 score");
            }
            assertEqual(snap.lanterns, 3, "Lanterns unchanged on carriage win");

            ctrl.continueAfterStop();
            snap = ctrl.getSnapshot();
            assertEqual(snap.screen, RUN_SCREENS.REWARD, `Stop ${stop + 1} win opens REWARD tray`);
            assertEqual(snap.reward.choices.length, 3, "Offered 3 distinct unowned Stamps");
            const ids = snap.reward.choices.map((c) => c.id);
            assertEqual(new Set(ids).size, 3, "All 3 Stamp choices are distinct");
            const ownedIds = snap.equippedStamps.map((s) => s.id);
            assert(
              ids.every((id) => !ownedIds.includes(id)),
              "Never offers an already-equipped Stamp"
            );

            if (stop < 3) {
              assert(ctrl.chooseRewardStamp(ids[0]).ok, `Picked Stamp #${stop + 1}`);
              assertEqual(
                ctrl.getSnapshot().equippedStamps.length,
                stop + 1,
                `Tray holds ${stop + 1} Stamp(s)`
              );
            } else {
              assertEqual(snap.reward.slotsFull, true, "Tray marked full at 3/3");
              const stageRes = ctrl.chooseRewardStamp(ids[1]);
              assertEqual(stageRes.needsReplaceSlot, true, "Prompts for replacement slot when full");
              ctrl.cancelRewardReplacement();
              assertEqual(ctrl.getSnapshot().reward.pendingReplaceStamp, null, "Cancel clears stage");
              assert(ctrl.chooseRewardStamp(ids[1], 1).ok, "Replaced slot 1 cleanly");
              assertEqual(ctrl.getSnapshot().equippedStamps.length, 3, "Still capped at 3 Stamps");
              assertEqual(ctrl.getSnapshot().equippedStamps[1].id, ids[1], "Slot 1 holds new Stamp");
            }
          } else {
            assertEqual(snap.screen, RUN_SCREENS.RUN_OVER, "Stop 5 win reaches RUN_OVER");
            assertEqual(snap.runOutcome, RUN_OUTCOMES.VICTORY, "Run outcome is VICTORY");
            assertEqual(snap.lastStopSummary.dealWins, 3, "Stop 5 required 3 deal wins (Bo5)");
            assertEqual(snap.lastStopSummary.dealLosses, 1, "Stop 5 recorded 3–1 match score");
            assertEqual(snap.stopHistory.length, 5, "All 5 stops recorded in history");
            assert(snap.lastRunPayout && snap.lastRunPayout.total > 20, "Victory awards Punched Stubs");
          }
        }

        // Starter strictly alternates across every single deal of the run!
        assert(allDealStarters.length >= 13, "Played >= 13 deals across full multi-deal run");
        for (let i = 0; i < allDealStarters.length; i += 1) {
          assertEqual(
            allDealStarters[i],
            i % 2 === 0 ? SIDES.INSPECTOR : SIDES.PLAYER,
            `Deal #${i + 1} starting offerer alternates strictly`
          );
        }

        // --- Scenario B: Early loss (-1 Lantern, no reward, advance) + Skip Reward + Spare Wick heal + Boss Rematch -> Victory ---
        ctrl.startRun({
          seed: "GRIT-RUN-9",
          startingStamps: [STAMP_IDS.SPARE_WICK],
        });
        finishCarriageWithWinner(ctrl, SIDES.INSPECTOR);
        let sB = ctrl.getSnapshot();
        assertEqual(sB.screen, RUN_SCREENS.STOP_RESULT, "Early loss shows STOP_RESULT");
        assertEqual(sB.lastStopSummary.won, false, "Stop 1 lost");
        assertEqual(sB.lastStopSummary.hasReward, false, "No reward on lost stop");
        assertEqual(sB.lanterns, 2, "Lanterns dropped 3 -> 2");
        ctrl.continueAfterStop();
        sB = ctrl.getSnapshot();
        assertEqual(sB.screen, RUN_SCREENS.BRIEFING, "Early loss skips REWARD and enters Stop 2 BRIEFING");
        assertEqual(sB.stopIndex, 1, "Advanced to Stop 2");

        // Stop 2: burn Spare Wick mid-deal (Lanterns 2 -> 3, slot freed!), win both deals, then SKIP reward!
        ctrl.beginStopDuel();
        assert(ctrl.activateStamp(STAMP_IDS.SPARE_WICK).ok, "Burned Spare Wick in Stop 2 Deal 1");
        assertEqual(ctrl.getSnapshot().lanterns, 3, "Spare Wick restored Lantern to 3/3");
        assertEqual(ctrl.getSnapshot().equippedStamps.length, 0, "Spare Wick freed its slot in run state");
        finishActiveDuelWithOutcome(ctrl, SIDES.PLAYER, rng);
        ctrl.continueAfterStop(); // Deal 2 of Stop 2
        assertEqual(ctrl.getSnapshot().equippedStamps.length, 0, "Spare Wick stays consumed in Deal 2");
        finishActiveDuelWithOutcome(ctrl, SIDES.PLAYER, rng);
        ctrl.continueAfterStop();
        assertEqual(ctrl.getSnapshot().screen, RUN_SCREENS.REWARD, "Stop 2 win offers reward");
        assert(ctrl.skipReward().ok, "Skip reward works cleanly");
        assertEqual(ctrl.getSnapshot().equippedStamps.length, 0, "Zero Stamps after skipping");
        assertEqual(ctrl.getSnapshot().stopIndex, 2, "Advanced to Stop 3 after skip");

        // Win Stops 3 & 4 (taking 1 Stamp each) to reach Stop 5 with 3 Lanterns
        for (const stp of [2, 3]) {
          finishCarriageWithWinner(ctrl, SIDES.PLAYER);
          ctrl.continueAfterStop();
          const offer = ctrl.getSnapshot().reward.choices[0].id;
          ctrl.chooseRewardStamp(offer);
          assertEqual(ctrl.getSnapshot().stopIndex, stp + 1, `Reached Stop ${stp + 2}`);
        }

        // Stop 5 (Final Inspection Bo5): lose twice (3 -> 2 -> 1 Lanterns), verify rematch stays on Stop 5 & alternates starter (3 deals = odd -> flips!), win 3rd try!
        const bossStarter0 = ctrl.getSnapshot().briefing.startingOfferer;
        finishCarriageWithWinner(ctrl, SIDES.INSPECTOR);
        sB = ctrl.getSnapshot();
        assertEqual(sB.screen, RUN_SCREENS.STOP_RESULT, "Boss loss with Lanterns left goes to STOP_RESULT");
        assertEqual(sB.lastStopSummary.isRematchNext, true, "Flagged for Final Inspection rematch");
        assertEqual(sB.lanterns, 2, "Lanterns 3 -> 2");
        ctrl.continueAfterStop();
        sB = ctrl.getSnapshot();
        assertEqual(sB.screen, RUN_SCREENS.BRIEFING, "Returned to Stop 5 BRIEFING for rematch #1");
        assertEqual(sB.stopIndex, 4, "Still on Final Inspection (Stop 5)");
        assertEqual(sB.rematchCount, 1, "rematchCount = 1");
        assert(
          sB.briefing.startingOfferer !== bossStarter0,
          "Final Inspection rematch alternates starting actor"
        );

        // Also verify real Inspector AI preserves learned habits across deals & stops!
        const realAiCtrl = createRunController({ initialSeed: "REAL-AI-RUN-5", immediate: true });
        realAiCtrl.startRun({ seed: "REAL-AI-RUN-5" });
        realAiCtrl.beginStopDuel();
        finishActiveDuelWithOutcome(realAiCtrl, null, rng);
        const obsAfterDeal1 = realAiCtrl.getInspectorMemorySnapshot().totalObservations;
        assert(obsAfterDeal1 >= 1, "Real Inspector records habits in Stop 1 Deal 1");
        realAiCtrl.continueAfterStop(); // launches Stop 1 Deal 2
        assertEqual(
          realAiCtrl.getInspectorMemorySnapshot().totalObservations,
          obsAfterDeal1,
          "Real Inspector preserves learned habits into Deal 2"
        );
        realAiCtrl.dispose();

        // Lose rematch #1 (2 -> 1 Lantern), then win rematch #2!
        finishCarriageWithWinner(ctrl, SIDES.INSPECTOR);
        assertEqual(ctrl.getSnapshot().lanterns, 1, "Lanterns 2 -> 1");
        ctrl.continueAfterStop();
        assertEqual(ctrl.getSnapshot().rematchCount, 2, "rematchCount = 2");

        finishCarriageWithWinner(ctrl, SIDES.PLAYER);
        sB = ctrl.getSnapshot();
        assertEqual(sB.screen, RUN_SCREENS.RUN_OVER, "Won Final Inspection rematch #2");
        assertEqual(sB.runOutcome, RUN_OUTCOMES.VICTORY, "Rematch win yields VICTORY");
        assertEqual(sB.lanterns, 1, "Finished with 1 Lantern remaining");

        // --- Scenario C: Lose 3 carriages -> 0 Lanterns -> Immediate DEFEAT (+ Punched Stub consolation payout!) ---
        ctrl.startRun({ seed: "DARK-PLATFORM-3" });
        for (let lossNum = 1; lossNum <= 3; lossNum += 1) {
          finishCarriageWithWinner(ctrl, SIDES.INSPECTOR);
          const snap = ctrl.getSnapshot();
          if (lossNum < 3) {
            assertEqual(snap.lanterns, 3 - lossNum, `Lanterns = ${3 - lossNum} after loss ${lossNum}`);
            assertEqual(snap.screen, RUN_SCREENS.STOP_RESULT, "Still alive while Lanterns >= 1");
            ctrl.continueAfterStop();
          } else {
            assertEqual(snap.lanterns, 0, "Lanterns hit 0 on 3rd loss");
            assertEqual(snap.screen, RUN_SCREENS.RUN_OVER, "0 Lanterns immediately ends run");
            assertEqual(snap.runOutcome, RUN_OUTCOMES.DEFEAT, "Run outcome is DEFEAT");
          }
        }

        ctrl.dispose();
      },
    },

    {
      name: "7. Run seed reproduces identical conditions, Stamp offers & encounter shuffles; restart leaves zero timers or stale AI habits",
      fn() {
        const seed = "MIDNIGHT-EXPRESS-42";

        // Condition schedule determinism & uniqueness across Stops 2–5
        const schedA = buildConditionSchedule(seed);
        const schedB = buildConditionSchedule(seed);
        assertDeepEqual(schedA, schedB, "Same seed gives identical 5-stop condition schedule");
        assertEqual(schedA[0], null, "Stop 1 has Clear Line (no condition)");
        assertEqual(
          new Set(schedA.slice(1)).size,
          4,
          "Stops 2–5 schedule all 4 distinct Carriage Conditions"
        );

        // Reward offer determinism
        for (let stop = 0; stop < 4; stop += 1) {
          const offerA = rollStampRewardOffer(seed, stop, [STAMP_IDS.INSPECTION_WINDOW]);
          const offerB = rollStampRewardOffer(seed, stop, [STAMP_IDS.INSPECTION_WINDOW]);
          assertDeepEqual(offerA, offerB, `Stop ${stop + 1} reward offer identical for same seed`);
        }

        // Full two-controller run comparison across all 5 stops
        function collectRunSignature(runSeed) {
          const rng = createRng("SIG-DRIVER");
          const c = createRunController({ initialSeed: runSeed, immediate: true });
          c.startRun({ seed: runSeed });
          const sig = {
            conditions: c.getSnapshot().conditionSchedule,
            openingHands: [],
            outcomes: [],
            offers: [],
          };
          while (c.getSnapshot().screen !== RUN_SCREENS.RUN_OVER) {
            const cur = c.getSnapshot();
            if (cur.screen === RUN_SCREENS.BRIEFING) {
              c.beginStopDuel();
            } else if (cur.screen === RUN_SCREENS.DUEL) {
              sig.openingHands.push(cur.view.myHand.map((slot) => slot.ticket.ticketId));
              finishActiveDuelWithOutcome(c, SIDES.PLAYER, rng);
              const post = c.getSnapshot();
              sig.outcomes.push({
                stop: post.stopIndex,
                kind: post.lastStopSummary?.kind,
                won: post.lastStopSummary?.won,
                lanterns: post.lanterns,
              });
            } else if (cur.screen === RUN_SCREENS.STOP_RESULT) {
              c.continueAfterStop();
            } else if (cur.screen === RUN_SCREENS.REWARD) {
              const offerIds = cur.reward.choices.map((s) => s.id);
              sig.offers.push(offerIds);
              c.chooseRewardStamp(offerIds[0], cur.reward.slotsFull ? 0 : null);
            }
          }
          c.dispose();
          return sig;
        }

        const run1 = collectRunSignature(seed);
        const run2 = collectRunSignature(seed);
        const runDiff = collectRunSignature("DIFFERENT-TRAIN-99");
        assertDeepEqual(run1, run2, "Same run seed reproduces identical conditions, deals & Stamp offers");
        assert(
          JSON.stringify(run1.openingHands) !== JSON.stringify(runDiff.openingHands) ||
            JSON.stringify(run1.offers) !== JSON.stringify(runDiff.offers),
          "Different run seed produces different deals and Stamp offers"
        );

        // Async timer cleanup + AI habit reset on mid-duel restartRun()
        const scheduled = new Map();
        let nextId = 1;
        const fakeScheduler = {
          setTimeout(fn, ms) {
            const id = nextId++;
            scheduled.set(id, { fn, ms });
            return id;
          },
          clearTimeout(id) {
            scheduled.delete(id);
          },
        };

        // First accumulate learned habits in an immediate run, then switch to async timers & restart!
        const ctrl = createRunController({
          initialSeed: "LEAK-CHECK-2",
          immediate: false,
          scheduler: fakeScheduler,
        });
        ctrl.startRun({ seed: "LEAK-CHECK-2" });
        ctrl.beginStopDuel(); // Stop 1: Inspector offers first -> schedules async Inspector timer!
        assert(scheduled.size >= 1, "Async Inspector timer scheduled");
        assertEqual(ctrl.getSnapshot().inputLocked, true, "Player input locked during Inspector step");
        assertEqual(
          ctrl.drawSlot(0).reason,
          "INPUT_LOCKED",
          "Duplicate/out-of-turn click rejected while locked"
        );

        // Fire Inspector offer step(s) (optional SWAP + COMMIT_OFFER), then player draws slot 0!
        while (scheduled.size > 0) {
          const [id, entry] = scheduled.entries().next().value;
          scheduled.delete(id);
          entry.fn();
        }
        assertEqual(ctrl.getSnapshot().inputLocked, false, "Unlocked on Player draw");
        assert(ctrl.drawSlot(0).ok, "Player draws slot 0");
        assertEqual(
          ctrl.drawSlot(1).reason,
          "INPUT_LOCKED",
          "Rapid second click rejected by double-draw lock"
        );
        assert(scheduled.size >= 1, "Reveal beat timer active");
        assert(
          ctrl.getInspectorMemorySnapshot().totalObservations >= 1,
          "Inspector recorded player draw habit before restart"
        );

        // Mid-duel restart must cancel every timer and reset Lanterns, Stamps, stopIndex, and AI memory!
        ctrl.restartRun();
        assertEqual(scheduled.size, 0, "Zero pending timers survive restartRun()");
        assertEqual(ctrl.getSnapshot().pendingTimerCount, 0, "Controller reports 0 pending timers");
        assertEqual(ctrl.getSnapshot().screen, RUN_SCREENS.BRIEFING, "Restart lands on Stop 1 BRIEFING");
        assertEqual(ctrl.getSnapshot().lanterns, 3, "Lanterns reset to 3");
        assertEqual(ctrl.getSnapshot().equippedStamps.length, 0, "Stamps reset to empty");
        const memAfter = ctrl.getInspectorMemorySnapshot();
        assertEqual(memAfter.totalObservations, 0, "AI observations wiped to 0 on restart");
        for (const b of BUCKETS) {
          assert(
            Math.abs(memAfter.drawBucketProbs[b] - 0.2) < 1e-9,
            `AI bucket ${b} reset to uniform 0.20`
          );
        }

        ctrl.dispose();
        assertEqual(scheduled.size, 0, "Zero pending timers after dispose()");
      },
    },

    {
      name: "8. Platform Locker meta-progression: Punched Stubs, ★ Perforation Gauge, Check Edge, Reroll, Storm Lamp & offline persistence",
      fn() {
        // Fake offline localStorage to verify persistence round-trip.
        const backing = new Map();
        const fakeStorage = {
          getItem: (k) => (backing.has(k) ? backing.get(k) : null),
          setItem: (k, v) => backing.set(k, String(v)),
          removeItem: (k) => backing.delete(k),
        };

        const store = createMetaStore({ storage: fakeStorage });
        assertEqual(store.getSnapshot().items.length, KEEPSAKE_LIST.length, "All 6 Keepsakes listed");
        assertEqual(store.getSnapshot().stubs, 0, "Fresh profile starts with 0 Stubs");
        assertEqual(
          store.unlock(KEEPSAKE_IDS.PERFORATION_GAUGE).ok,
          false,
          "Cannot buy Perforation Gauge before unlocking a Tier I Foothold"
        );

        // First-run minimum guarantees even a total wipeout grants >= 20 Stubs (enough for Weathered Stamp Case!).
        const r1 = store.recordCompletedRun({
          playerPairsMatched: 2,
          playerEmblemPairsMatched: 0,
          dealsWon: 0,
          carriagesWon: 0,
          stopReached: 2,
          victory: false,
        });
        assert(r1.payout.total >= 20, "First-run loss guarantees >= 20 Punched Stubs");
        assert(store.unlock(KEEPSAKE_IDS.WEATHERED_CASE).ok, "Unlocked Weathered Stamp Case right after Run 1");

        // Still blocked from Tier III until Keystone Perforation Gauge is unlocked!
        store.grantStubsForTest(300);
        assertEqual(
          store.unlock(KEEPSAKE_IDS.SMUGGLERS_CARBON).ok,
          false,
          "Tier III requires Keystone Perforation Gauge"
        );
        assertEqual(store.getSnapshot().keystoneReadyToBuy, true, "Flags Perforation Gauge ready to buy");
        assert(store.unlock(KEEPSAKE_IDS.PERFORATION_GAUGE).ok, "Unlocked ★ The Perforation Gauge");
        assert(store.unlock(KEEPSAKE_IDS.TALLOW_SEAL).ok, "Unlocked Thumb-Worn Tallow");
        assert(store.unlock(KEEPSAKE_IDS.SMUGGLERS_CARBON).ok, "Unlocked Smuggler's Carbon Folio");
        assert(store.unlock(KEEPSAKE_IDS.DOUBLE_WICK_LAMP).ok, "Unlocked Double-Wick Storm Lamp");
        assert(store.unlock(KEEPSAKE_IDS.COUNTERFEIT_SEAL).ok, "Unlocked Guard's Master Counter-Seal");

        // Active/Stowed toggle + reload from offline storage!
        assertEqual(store.toggleActive(KEEPSAKE_IDS.COUNTERFEIT_SEAL).active, false, "Stowed Counter-Seal");
        assert(backing.has(META_STORAGE_KEY), "Saved profile under META_STORAGE_KEY");
        const reloaded = createMetaStore({ storage: fakeStorage });
        assertEqual(reloaded.getSnapshot().unlockedIds.length, 6, "Reloaded all 6 unlocked Keepsakes");
        assertEqual(reloaded.getBonuses().gaugeChargesPerDeal, 1, "Stowed Counter-Seal keeps Gauge at 1/deal");
        assertEqual(reloaded.toggleActive(KEEPSAKE_IDS.COUNTERFEIT_SEAL).active, true, "Re-equipped Counter-Seal");
        assertEqual(reloaded.getBonuses().gaugeChargesPerDeal, 2, "Re-equipped Counter-Seal raises Gauge to 2/deal");
        assertEqual(reloaded.getBonuses().inspectorStampJams, 2, "Perforation Gauge + Counter-Seal jam 2 Inspector Stamps");

        // Verify Check Edge + Perforation Gauge engine legality, strict privacy boundary & exact replay determinism!
        // Note: startingOfferer = INSPECTOR receives even deck indices (0, 2, 4, 6, 8, 10, 12);
        // PLAYER receives odd deck indices (1, 3, 5, 7, 9, 11).
        const customDeck = [
          // Inspector (7 cards): LANTERN-B★, UNLISTED-0, TRUNK-B, WATCH-B★, KEY-B★, SEAL-B, BELL-B★
          // Player (6 cards): LANTERN-A★, WATCH-A★, KEY-A★, BELL-A★, TRUNK-A, SEAL-A
          "LANTERN-B", "LANTERN-A",
          "UNLISTED-0", "WATCH-A",
          "TRUNK-B", "KEY-A",
          "WATCH-B", "BELL-A",
          "KEY-B", "TRUNK-A",
          "SEAL-B", "SEAL-A",
          "BELL-B",
        ];
        let toolState = createDuel({
          encounterSeed: 77701,
          pairCount: 6,
          startingOfferer: SIDES.INSPECTOR,
          customDeckOrder: customDeck,
          playerEdgeChecks: 1,
          playerGaugeCharges: 1,
        });
        toolState = applyAction(toolState, {
          type: ACTION_TYPES.COMMIT_OFFER,
          actor: SIDES.INSPECTOR,
          seq: toolState.nextSeq,
        }).state;

        // Check Edge on slot 0 (LANTERN-B★ -> Emblem = true)
        const edgeRes = applyAction(toolState, {
          type: ACTION_TYPES.CHECK_EDGE,
          actor: SIDES.PLAYER,
          slotIndex: 0,
          seq: toolState.nextSeq,
        });
        assert(edgeRes.ok, "CHECK_EDGE succeeded");
        toolState = edgeRes.state;
        const pView1 = createObserverView(toolState, SIDES.PLAYER);
        const iView1 = createObserverView(toolState, SIDES.INSPECTOR);
        assertEqual(pView1.myEdgeClues.length, 1, "Player receives private Edge clue");
        assertEqual(pView1.myEdgeClues[0].isEmblem, true, "Slot 0 identified as ★ Emblem");
        assertEqual(iView1.myEdgeClues.length, 0, "Inspector never sees player's Edge clue");
        assertEqual(pView1.legal.edgeChecksRemaining, 0, "Edge check spent for this deal");

        // Use Perforation Gauge -> marks 1 unknown guaranteed-safe slot (never UNLISTED-0 at slot 1, never already-checked slot 0!)
        const gaugeRes = applyAction(toolState, {
          type: ACTION_TYPES.USE_GAUGE,
          actor: SIDES.PLAYER,
          seq: toolState.nextSeq,
        });
        assert(gaugeRes.ok, "USE_GAUGE succeeded");
        toolState = gaugeRes.state;
        const pView2 = createObserverView(toolState, SIDES.PLAYER);
        const iView2 = createObserverView(toolState, SIDES.INSPECTOR);
        assertEqual(pView2.myGaugeSafeSlots.length, 1, "Player receives 1 Gauge safe slot");
        const safeIdx = pView2.myGaugeSafeSlots[0].slotIndex;
        assert(safeIdx !== 1, "Perforation Gauge NEVER marks UNLISTED-0");
        assert(safeIdx !== 0, "Perforation Gauge picks an unknown safe slot (not already edge-checked)");
        assertEqual(
          toolState.hands.INSPECTOR[safeIdx].isUnlisted,
          false,
          "Gauge-flagged slot is truly an ordinary pair"
        );
        assertEqual(iView2.myGaugeSafeSlots.length, 0, "Inspector never leaks player's Gauge safe slot");
        assertEqual(
          JSON.stringify(iView2).includes("gaugeSafe"),
          false,
          "Zero Gauge clue fields leak in Inspector ObserverView"
        );
        assertEqual(
          verifyInvariants(toolState).ok,
          true,
          "Engine invariants hold after CHECK_EDGE + USE_GAUGE"
        );

        // Replay reproduces identical Gauge slot & state!
        const rep = replayDuel(exportReplay(toolState));
        assert(rep.ok, "Replay with CHECK_EDGE + USE_GAUGE succeeds");
        assertDeepEqual(
          rep.state.gaugeSafeSlots,
          toolState.gaugeSafeSlots,
          "Replay reproduces exact deterministic Perforation Gauge slot"
        );

        // Verify Departure Stamp Draft, Reroll, Emergency Match save & 2-win Storm Lamp Lantern heal in RunController!
        const rng = createRng("META-RUN-TEST");
        const metaCtrl = createRunController({
          initialSeed: "LOCKER-POWER-8",
          immediate: true,
          metaStore: reloaded,
          opponentOverride: firstSlotTestOpponent,
        });
        metaCtrl.startRun({ seed: "LOCKER-POWER-8" });
        let ms = metaCtrl.getSnapshot();
        assertEqual(ms.screen, RUN_SCREENS.STARTER_DRAFT, "Perforation Gauge opens 3-choice Departure Draft");
        assertEqual(ms.reward.choices.length, 3, "Departure Draft offers 3 Stamps");
        assertEqual(ms.reward.rerollsLeft, 1, "Smuggler's Carbon grants 1 Reroll on Departure Draft");
        const beforeReroll = ms.reward.choices.map((c) => c.id);
        assert(metaCtrl.rerollRewardChoices().ok, "Rerolled Departure Draft cleanly");
        const afterReroll = metaCtrl.getSnapshot().reward.choices.map((c) => c.id);
        assert(
          afterReroll.every((id) => !beforeReroll.includes(id)),
          "Reroll produces 3 fresh Stamps when pool has >= 6 unowned"
        );
        assert(metaCtrl.chooseStarterStamp(afterReroll[0]).ok, "Picked Starter Stamp");
        assertEqual(metaCtrl.getSnapshot().screen, RUN_SCREENS.BRIEFING, "Enters Stop 1 BRIEFING");
        assertEqual(metaCtrl.getSnapshot().equippedStamps.length, 1, "Starter Stamp inked in Slot 1");

        // Stop 1: lose Deal 1, lose Deal 2 -> Emergency Match flares & saves the carriage! Then lose Deal 3 -> Lanterns 3 -> 2!
        metaCtrl.beginStopDuel();
        finishActiveDuelWithOutcome(metaCtrl, SIDES.INSPECTOR, rng); // 0-1
        metaCtrl.continueAfterStop();
        finishActiveDuelWithOutcome(metaCtrl, SIDES.INSPECTOR, rng); // would be 0-2 -> Emergency Match saves!
        ms = metaCtrl.getSnapshot();
        assertEqual(ms.lastStopSummary.kind, "DEAL_CONTINUE", "Emergency Match prevented carriage loss");
        assertEqual(ms.lastStopSummary.emergencyMatchSaved, true, "Flagged emergencyMatchSaved");
        assertEqual(ms.emergencyMatchesLeft, 0, "Emergency Match consumed");
        assertEqual(ms.lanterns, 3, "All 3 Lanterns still intact");
        metaCtrl.continueAfterStop();
        finishActiveDuelWithOutcome(metaCtrl, SIDES.INSPECTOR, rng); // now 0-2 -> loses Stop 1 (Lanterns 3 -> 2)
        assertEqual(metaCtrl.getSnapshot().lanterns, 2, "Second deciding loss drops Lanterns 3 -> 2");
        metaCtrl.continueAfterStop(); // -> Stop 2 BRIEFING

        // Win Stop 2 & Stop 3 consecutively -> Double-Wick Storm Lamp heals +1 Lantern (2 -> 3)!
        for (const stp of [1, 2]) {
          metaCtrl.beginStopDuel();
          finishActiveDuelWithOutcome(metaCtrl, SIDES.PLAYER, rng);
          metaCtrl.continueAfterStop();
          finishActiveDuelWithOutcome(metaCtrl, SIDES.PLAYER, rng);
          if (stp === 1) {
            assertEqual(metaCtrl.getSnapshot().lanterns, 2, "1 win streak does not heal yet");
            metaCtrl.continueAfterStop();
            metaCtrl.skipReward();
          } else {
            assertEqual(metaCtrl.getSnapshot().lastStopSummary.lanternHealed, true, "2nd straight win triggers Storm Lamp heal");
            assertEqual(metaCtrl.getSnapshot().lanterns, 3, "Lantern restored from 2 -> 3");
          }
        }

        metaCtrl.resetLockerProgress();
        assertEqual(metaCtrl.getSnapshot().meta.stubs, 0, "resetLockerProgress wipes stubs");
        assertEqual(metaCtrl.getSnapshot().meta.unlockedIds.length, 0, "resetLockerProgress wipes unlocks");
        metaCtrl.dispose();
      },
    },

    {
      name: "9. Armed Inspector AI uses Stamps legally, respects Locker jamming & preserves 100% hidden-card permutation invariance",
      fn() {
        // 1. Verify Locker jamming across all 5 stops.
        const car2 = CARRIAGES[1]; // 3 Inspector Stamps
        const j0 = resolveInspectorLoadout(car2, 0);
        const j1 = resolveInspectorLoadout(car2, 1);
        const j2 = resolveInspectorLoadout(car2, 2);
        assertEqual(j0.activeIds.length, 3, "0 jams leaves all 3 Inspector Stamps active");
        assertEqual(j1.jammedIds.length, 1, "Perforation Gauge jams 1 Inspector Stamp");
        assertEqual(j1.activeIds.length, 2, "2 active after 1 jam");
        assertEqual(j2.jammedIds.length, 2, "Gauge + Counter-Seal jams 2 Inspector Stamps");
        assertEqual(j2.activeIds.length, 1, "1 active after 2 jams");

        // 2. Verify Inspector actually plays Stamps legally in live deals without violating any invariant!
        const pRng = createRng("INSP-STAMP-PLAY");
        let sawInspectorStamp = false;
        for (let i = 0; i < 12; i += 1) {
          const agent = createInspectorAgent({ tier: 5 });
          const aiRng = createRng(91000 + i);
          let st = createDuel({
            encounterSeed: 81000 + i,
            pairCount: 8,
            startingOfferer: i % 2 === 0 ? SIDES.PLAYER : SIDES.INSPECTOR,
            inspectorStamps: [
              STAMP_IDS.INSPECTION_WINDOW,
              STAMP_IDS.MANIFEST_LOUPE,
              STAMP_IDS.BRASS_WEIGHT,
            ],
          });
          while (st.phase !== PHASES.OVER) {
            const actor = st.phase === PHASES.OFFER ? st.offerer : st.offerer === SIDES.PLAYER ? SIDES.INSPECTOR : SIDES.PLAYER;
            if (actor === SIDES.INSPECTOR) {
              const act = agent.act(createObserverView(st, SIDES.INSPECTOR), aiRng);
              if (act.type === ACTION_TYPES.USE_STAMP) sawInspectorStamp = true;
              const r = applyAction(st, act);
              assert(r.ok, `Armed Inspector emitted legal action ${act.type}`);
              st = r.state;
            } else if (st.phase === PHASES.OFFER) {
              st = applyAction(st, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER, seq: st.nextSeq }).state;
            } else {
              const legal = getLegalActions(st, SIDES.PLAYER).legalDrawSlots;
              st = applyAction(st, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: pRng.pick(legal), seq: st.nextSeq }).state;
              agent.observe(createObserverView(st, SIDES.INSPECTOR));
            }
            assert(verifyInvariants(st).ok, "Invariants hold throughout armed Inspector duel");
          }
        }
        assert(sawInspectorStamp, "Armed Inspector actively uses his equipped Stamps during play");

        // 3. Strict hidden-card permutation invariance WITH Inspector Stamps equipped!
        // Permute Player's 3 face-down cards (including moving UNLISTED-0 from slot 0 to slot 2):
        // before peeking, Inspector's exact chosen action & trace MUST be 100% identical!
        // After deal pairs (KEY, BELL, TRUNK, SEAL auto-clear):
        // deckOrderA -> Player holds [UNLISTED-0, LANTERN-A, WATCH-A]; Inspector holds [LANTERN-B, WATCH-B]
        // deckOrderB -> Player holds [WATCH-A, LANTERN-A, UNLISTED-0]; Inspector holds [LANTERN-B, WATCH-B]
        const deckOrderA = [
          "UNLISTED-0", "LANTERN-B",
          "LANTERN-A", "WATCH-B",
          "WATCH-A", "TRUNK-A",
          "KEY-A", "TRUNK-B",
          "KEY-B", "SEAL-A",
          "BELL-A", "SEAL-B",
          "BELL-B",
        ];
        const deckOrderB = [
          "WATCH-A", "LANTERN-B",
          "LANTERN-A", "WATCH-B",
          "UNLISTED-0", "TRUNK-A",
          "KEY-A", "TRUNK-B",
          "KEY-B", "SEAL-A",
          "BELL-A", "SEAL-B",
          "BELL-B",
        ];

        for (const stampSet of [
          [STAMP_IDS.INSPECTION_WINDOW],
          [STAMP_IDS.MANIFEST_LOUPE],
          [STAMP_IDS.BELL_CORD],
        ]) {
          let stA = createDuel({
            encounterSeed: 555,
            pairCount: 6,
            startingOfferer: SIDES.PLAYER,
            customDeckOrder: deckOrderA,
            inspectorStamps: stampSet,
          });
          let stB = createDuel({
            encounterSeed: 555,
            pairCount: 6,
            startingOfferer: SIDES.PLAYER,
            customDeckOrder: deckOrderB,
            inspectorStamps: stampSet,
          });
          stA = applyAction(stA, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER, seq: stA.nextSeq }).state;
          stB = applyAction(stB, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER, seq: stB.nextSeq }).state;

          for (const tier of [3, 4, 5]) {
            const agA = createInspectorAgent({ tier });
            const agB = createInspectorAgent({ tier });
            const actA = agA.act(createObserverView(stA, SIDES.INSPECTOR), createRng(4242 + tier));
            const actB = agB.act(createObserverView(stB, SIDES.INSPECTOR), createRng(4242 + tier));
            assertDeepEqual(
              actA,
              actB,
              `Armed Tier ${tier} (${stampSet[0]}) decision is 100% invariant to hidden player card order`
            );
          }
        }
      },
    },
  ];
}

export function runPhase3Suite() {
  const tests = getPhase3Tests();
  const results = [];
  let passed = 0;

  for (const t of tests) {
    const start = performance.now();
    try {
      t.fn();
      const durationMs = performance.now() - start;
      passed += 1;
      results.push({ name: t.name, ok: true, durationMs, error: null });
    } catch (err) {
      const durationMs = performance.now() - start;
      results.push({
        name: t.name,
        ok: false,
        durationMs,
        error: err instanceof Error ? err.stack || err.message : String(err),
      });
    }
  }

  return {
    total: tests.length,
    passed,
    failed: tests.length - passed,
    results,
  };
}
