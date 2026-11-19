/**
 * tests/phase1Suite.js
 * Portable zero-dependency Phase 1 automated test suite.
 * Runs identically in plain Node (`node --test`) and in the browser (`tests/browser.html`).
 */

import {
  createDuelStreams,
  createRng,
  deriveSeed,
  hashSeed,
  normalizeSeed,
} from "../src/core/rng.js";
import {
  MAX_PAIRS,
  MIN_PAIRS,
  TICKET_SYMBOLS,
  UNLISTED_ID,
  buildDeck,
} from "../src/data/tickets.js";
import {
  ACTION_TYPES,
  PHASES,
  REJECT_REASONS,
  SIDES,
  applyAction,
  createDuel,
  evaluateFinalCall,
  exportReplay,
  getActiveActor,
  getLegalActions,
  getStartingOfferer,
  otherSide,
  purgePairsFromHand,
  replayDuel,
  verifyInvariants,
} from "../src/core/engine.js";
import { createObserverView } from "../src/core/observer.js";
import { chooseRandomAction } from "../src/ai/randomOpponent.js";
import { STARTING_MODES, createDuelController } from "../src/ui/duelController.js";

function assert(condition, message = "Assertion failed") {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message = "") {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${message ? `${message}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertDeepEqual(actual, expected, message = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(
      `${message ? `${message}: ` : ""}deep equality mismatch.\nActual:   ${a.slice(0, 400)}\nExpected: ${b.slice(0, 400)}`
    );
  }
}

function assertThrows(fn, message = "Expected function to throw") {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(message);
  }
}

/**
 * Helper: build a custom deck order so startingOfferer receives offererIds
 * and startingDrawer receives drawerIds when dealt alternately.
 * Note: offererIds.length must equal drawerIds.length + 1.
 */
function interleaveHands(offererIds, drawerIds) {
  assertEqual(
    offererIds.length,
    drawerIds.length + 1,
    "Offerer must receive exactly 1 more card than drawer on deal"
  );
  const deck = [];
  for (let i = 0; i < offererIds.length; i += 1) {
    deck.push(offererIds[i]);
    if (i < drawerIds.length) {
      deck.push(drawerIds[i]);
    }
  }
  return deck;
}

/**
 * Helper: play a full duel using isolated random agents for both sides,
 * asserting every engine invariant at every single step.
 */
function runSimulatedRandomDuel(config, playerRngSeed, inspectorRngSeed) {
  let state = createDuel(config);
  const pRng = createRng(playerRngSeed);
  const iRng = createRng(inspectorRngSeed);

  const initialCheck = verifyInvariants(state);
  assert(
    initialCheck.ok,
    `Initial invariant failure: ${initialCheck.errors.join("; ")}`
  );

  let steps = 0;
  const maxSteps = 600;
  let finalCallCount = 0;

  while (state.phase !== PHASES.OVER) {
    steps += 1;
    assert(steps <= maxSteps, `Duel failed to terminate within ${maxSteps} actions`);

    const actor = getActiveActor(state);
    const view = createObserverView(state, actor);
    const rng = actor === SIDES.PLAYER ? pRng : iRng;
    const action = chooseRandomAction(view, rng);
    assert(action !== null, `Agent returned null action during ${state.phase}`);

    const res = applyAction(state, action);
    assert(res.ok, `Random legal action rejected: ${res.reason} (${res.message})`);
    if (res.events.some((e) => e.type === "FINAL_CALL_TRIGGERED")) {
      finalCallCount += 1;
    }

    state = res.state;
    const stepCheck = verifyInvariants(state);
    assert(
      stepCheck.ok,
      `Invariant failure at step ${steps}: ${stepCheck.errors.join("; ")}`
    );
  }

  return { state, steps, finalCallCount };
}

export const PHASE1_TESTS = [
  {
    name: "Deck composition: 6..12 pairs produce unique IDs, exact pairs, marked Emblems, and one Unlisted",
    run() {
      for (let p = MIN_PAIRS; p <= MAX_PAIRS; p += 1) {
        const deck = buildDeck(p);
        assertEqual(deck.length, 2 * p + 1, `Deck length for P=${p}`);

        const ids = new Set(deck.map((t) => t.ticketId));
        assertEqual(ids.size, 2 * p + 1, `Unique ticketIds for P=${p}`);

        const unlisted = deck.filter((t) => t.isUnlisted);
        assertEqual(unlisted.length, 1, "Exactly one Unlisted ticket");
        assertEqual(unlisted[0].ticketId, UNLISTED_ID);

        const symbolCounts = new Map();
        for (const t of deck) {
          if (t.isUnlisted) continue;
          symbolCounts.set(t.symbolId, (symbolCounts.get(t.symbolId) || 0) + 1);
        }
        assertEqual(symbolCounts.size, p, "Distinct ordinary symbols");
        for (const [sym, count] of symbolCounts.entries()) {
          assertEqual(count, 2, `Symbol ${sym} appears exactly twice`);
        }

        // All 4 marked Emblem pairs are always included when P >= 6.
        const emblemTickets = deck.filter((t) => t.isEmblem);
        assertEqual(emblemTickets.length, 8, "4 Emblem pairs (8 tickets) in every deck");
      }

      assertThrows(() => buildDeck(5), "Rejects pairCount < 6");
      assertThrows(() => buildDeck(13), "Rejects pairCount > 12");
      assertThrows(() => buildDeck(6.5), "Rejects non-integer pairCount");
      assertEqual(TICKET_SYMBOLS.length, 12, "Canonical 12 symbols defined");
    },
  },

  {
    name: "Initial pair discard preserves slot order and never discards The Unlisted",
    run() {
      const deck = buildDeck(6);
      const byId = new Map(deck.map((t) => [t.ticketId, t]));
      const sampleHand = [
        byId.get("LANTERN-A"),
        byId.get("KEY-A"),
        byId.get("UNLISTED-0"),
        byId.get("LANTERN-B"),
        byId.get("BELL-A"),
        byId.get("KEY-B"),
      ];

      const { remaining, pairs } = purgePairsFromHand(sampleHand);
      assertEqual(pairs.length, 2, "Discards LANTERN and KEY pairs");
      assertDeepEqual(
        pairs.map((pair) => pair.map((t) => t.ticketId)),
        [
          ["LANTERN-A", "LANTERN-B"],
          ["KEY-A", "KEY-B"],
        ]
      );
      assertDeepEqual(
        remaining.map((t) => t.ticketId),
        ["UNLISTED-0", "BELL-A"],
        "Preserves surviving ticket order"
      );
    },
  },

  {
    name: "Card conservation, legal pairs, and full termination across 560 duels (6..12 pairs, both sides)",
    run() {
      let playerWins = 0;
      let inspectorWins = 0;
      let totalFinalCalls = 0;
      let dealInstantEnds = 0;

      // 7 deck sizes * 2 starting sides * 40 seeds = 560 complete duels
      for (let pairCount = MIN_PAIRS; pairCount <= MAX_PAIRS; pairCount += 1) {
        for (const startingOfferer of [SIDES.INSPECTOR, SIDES.PLAYER]) {
          for (let s = 0; s < 40; s += 1) {
            const root = `CONSERVE-P${pairCount}-${startingOfferer}-${s}`;
            const { state, finalCallCount } = runSimulatedRandomDuel(
              {
                encounterSeed: deriveSeed(root, "shuffle"),
                pairCount,
                startingOfferer,
              },
              deriveSeed(root, "playerAi"),
              deriveSeed(root, "inspectorAi")
            );

            assertEqual(state.phase, PHASES.OVER);
            assertEqual(state.discardPile.length, pairCount * 2);
            assertEqual(state.hands.PLAYER.length + state.hands.INSPECTOR.length, 1);

            if (state.winner === SIDES.PLAYER) {
              playerWins += 1;
              assertEqual(state.hands.PLAYER.length, 0);
              assertEqual(state.hands.INSPECTOR[0].ticketId, UNLISTED_ID);
            } else {
              inspectorWins += 1;
              assertEqual(state.hands.INSPECTOR.length, 0);
              assertEqual(state.hands.PLAYER[0].ticketId, UNLISTED_ID);
            }

            if (state.endReason === "DEAL_ALL_PAIRED") {
              dealInstantEnds += 1;
            }
            totalFinalCalls += finalCallCount;
          }
        }
      }

      assert(playerWins > 150 && inspectorWins > 150, "Both sides win regularly across 560 duels");
      assert(
        totalFinalCalls > 20,
        `Expected Final Call to occur naturally in 560 duels, saw ${totalFinalCalls}`
      );
      assert(dealInstantEnds >= 0);
    },
  },

  {
    name: "Starting side alternation and clean empty-hand end rules (post-deal wipeout & last-pair draw, both sides)",
    run() {
      // Encounter alternation (Decision D1)
      assertEqual(getStartingOfferer(0), SIDES.INSPECTOR, "Stop 1: Inspector offers, Player draws first");
      assertEqual(getStartingOfferer(1), SIDES.PLAYER, "Stop 2: Player offers, Inspector draws first");
      assertEqual(getStartingOfferer(2), SIDES.INSPECTOR, "Stop 3: Inspector offers");
      assertEqual(getStartingOfferer(3), SIDES.PLAYER, "Stop 4: Player offers");
      assertEqual(getStartingOfferer(4), SIDES.INSPECTOR, "Stop 5: Inspector offers");

      // Post-deal wipeout A: Inspector receives 3 complete pairs + UNLISTED-0; Player receives 3 complete pairs -> Player empty, wins immediately!
      const wipeoutInspectorLoses = interleaveHands(
        ["LANTERN-A", "LANTERN-B", "WATCH-A", "WATCH-B", "KEY-A", "KEY-B", "UNLISTED-0"],
        ["BELL-A", "BELL-B", "TRUNK-A", "TRUNK-B", "SEAL-A", "SEAL-B"]
      );
      const stA = createDuel({
        encounterSeed: "WIPEOUT-A",
        pairCount: 6,
        startingOfferer: SIDES.INSPECTOR,
        customDeckOrder: wipeoutInspectorLoses,
      });
      assertEqual(stA.phase, PHASES.OVER, "Ends immediately when deal clears all 6 pairs");
      assertEqual(stA.endReason, "DEAL_ALL_PAIRED");
      assertEqual(stA.hands.PLAYER.length, 0);
      assertEqual(stA.hands.INSPECTOR.length, 1);
      assertEqual(stA.winner, SIDES.PLAYER);
      assertEqual(stA.loser, SIDES.INSPECTOR);
      assert(verifyInvariants(stA).ok);
      assertEqual(getLegalActions(stA, SIDES.PLAYER).canDraw, false);

      // Post-deal wipeout B: Player offers first, receives 3 pairs + UNLISTED-0 -> Inspector empty, Player loses immediately!
      const stB = createDuel({
        encounterSeed: "WIPEOUT-B",
        pairCount: 6,
        startingOfferer: SIDES.PLAYER,
        customDeckOrder: wipeoutInspectorLoses,
      });
      assertEqual(stB.phase, PHASES.OVER);
      assertEqual(stB.hands.INSPECTOR.length, 0);
      assertEqual(stB.hands.PLAYER.length, 1);
      assertEqual(stB.winner, SIDES.INSPECTOR);
      assertEqual(stB.loser, SIDES.PLAYER);
      assert(verifyInvariants(stB).ok);

      // Single surviving pair: Inspector offers [SEAL-A, UNLISTED-0], Player holds [SEAL-B].
      // Case 1: Inspector swaps [0, 1] -> [UNLISTED-0, SEAL-A], commits; Player draws slot 1 (SEAL-A) -> Player empties hand & wins immediately!
      const onePairDeck = interleaveHands(
        ["LANTERN-A", "LANTERN-B", "WATCH-A", "WATCH-B", "SEAL-A", "UNLISTED-0", "KEY-A"],
        ["BELL-A", "BELL-B", "TRUNK-A", "TRUNK-B", "SEAL-B", "KEY-B"]
      );
      // After purge: Inspector holds [SEAL-A, UNLISTED-0, KEY-A], Player holds [SEAL-B, KEY-B].
      let st = createDuel({
        encounterSeed: "LAST-PAIR",
        pairCount: 6,
        startingOfferer: SIDES.INSPECTOR,
        customDeckOrder: onePairDeck,
      });
      assertEqual(st.hands.INSPECTOR.length, 3);
      assertEqual(st.hands.PLAYER.length, 2);

      // Turn 1: Inspector commits; Player draws slot 2 (KEY-A) -> pairs KEY. Now Player holds [SEAL-B] (1), Inspector holds [SEAL-A, UNLISTED-0] (2).
      st = applyAction(st, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
      st = applyAction(st, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 2 }).state;
      assertEqual(st.phase, PHASES.OFFER);
      assertEqual(st.offerer, SIDES.PLAYER);
      assertEqual(st.hands.PLAYER.length, 1, "Player offers a single ordinary card");
      assertEqual(getLegalActions(st, SIDES.PLAYER).canSwap, false, "1-card hand cannot swap");
      assertEqual(getLegalActions(st, SIDES.PLAYER).canCommit, true, "1-card hand can still commit");

      // Turn 2: Player commits [SEAL-B]; Inspector draws slot 0 (SEAL-B) -> pairs SEAL! Player empty, Inspector stuck with [UNLISTED-0]!
      st = applyAction(st, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;
      st = applyAction(st, { type: ACTION_TYPES.DRAW, actor: SIDES.INSPECTOR, slotIndex: 0 }).state;
      assertEqual(st.phase, PHASES.OVER);
      assertEqual(st.winner, SIDES.PLAYER);
      assertEqual(st.loser, SIDES.INSPECTOR);
      assertEqual(st.hands.PLAYER.length, 0);
      assertDeepEqual(
        st.hands.INSPECTOR.map((t) => t.ticketId),
        [UNLISTED_ID]
      );
      assert(verifyInvariants(st).ok);
    },
  },

  {
    name: "Illegal and duplicate inputs are cleanly rejected without mutating state",
    run() {
      const deckOrder = interleaveHands(
        ["LANTERN-A", "WATCH-A", "KEY-A", "BELL-A", "TRUNK-A", "SEAL-A", "UNLISTED-0"],
        ["LANTERN-B", "WATCH-B", "KEY-B", "BELL-B", "TRUNK-B", "SEAL-B"]
      );
      const s0 = createDuel({
        encounterSeed: "REJECT-TEST",
        pairCount: 6,
        startingOfferer: SIDES.PLAYER,
        customDeckOrder: deckOrder,
      });
      const snap0 = JSON.parse(JSON.stringify(s0));

      const badCases = [
        [null, REJECT_REASONS.INVALID_ACTION_OBJECT],
        [{ type: "CHEAT", actor: SIDES.PLAYER }, REJECT_REASONS.UNKNOWN_ACTION_TYPE],
        [{ type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }, REJECT_REASONS.WRONG_ACTOR],
        [{ type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 0 }, REJECT_REASONS.WRONG_PHASE],
        [{ type: ACTION_TYPES.SWAP, actor: SIDES.PLAYER, indexA: 2, indexB: 2 }, REJECT_REASONS.SAME_SLOT_SWAP],
        [{ type: ACTION_TYPES.SWAP, actor: SIDES.PLAYER, indexA: -1, indexB: 0 }, REJECT_REASONS.INVALID_SLOT_INDEX],
        [{ type: ACTION_TYPES.SWAP, actor: SIDES.PLAYER, indexA: 0, indexB: 99 }, REJECT_REASONS.INVALID_SLOT_INDEX],
        [{ type: ACTION_TYPES.SWAP, actor: SIDES.PLAYER, indexA: 0, indexB: 1.5 }, REJECT_REASONS.INVALID_SLOT_INDEX],
        [{ type: ACTION_TYPES.SWAP, actor: SIDES.PLAYER, indexA: 0, indexB: NaN }, REJECT_REASONS.INVALID_SLOT_INDEX],
        [{ type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER, seq: 99 }, REJECT_REASONS.DUPLICATE_OR_STALE_SEQ],
        [{ type: ACTION_TYPES.USE_STAMP, actor: SIDES.PLAYER, stampId: "NONE" }, REJECT_REASONS.STAMP_UNAVAILABLE],
      ];

      for (const [action, expectedReason] of badCases) {
        const res = applyAction(s0, action);
        assertEqual(res.ok, false, `Should reject ${JSON.stringify(action)}`);
        assertEqual(res.reason, expectedReason);
        assertEqual(res.state, s0, "Returns original state reference");
        assertDeepEqual(s0, snap0, "Zero state mutation on rejection");
      }

      // Perform one valid swap (seq: 0), then verify duplicate seq: 0 and second swap are both rejected!
      const validSwap = { type: ACTION_TYPES.SWAP, actor: SIDES.PLAYER, indexA: 0, indexB: 6, seq: 0 };
      const r1 = applyAction(s0, validSwap);
      assert(r1.ok);
      const s1 = r1.state;
      const snap1 = JSON.parse(JSON.stringify(s1));

      const dupSwap = applyAction(s1, validSwap);
      assertEqual(dupSwap.ok, false, "Duplicate submission of same seq rejected");
      assertEqual(dupSwap.reason, REJECT_REASONS.DUPLICATE_OR_STALE_SEQ);

      const secondSwap = applyAction(s1, {
        type: ACTION_TYPES.SWAP,
        actor: SIDES.PLAYER,
        indexA: 1,
        indexB: 2,
        seq: 1,
      });
      assertEqual(secondSwap.ok, false, "Second swap in same offer rejected");
      assertEqual(secondSwap.reason, REJECT_REASONS.NO_SWAPS_REMAINING);
      assertDeepEqual(s1, snap1, "State untouched after rejected duplicate & extra swap");

      // Commit offer (seq: 1), then test illegal DRAW inputs + duplicate DRAW seq.
      const s2 = applyAction(s1, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER, seq: 1 }).state;
      assertEqual(
        applyAction(s2, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER, seq: 1 }).reason,
        REJECT_REASONS.DUPLICATE_OR_STALE_SEQ
      );
      assertEqual(
        applyAction(s2, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR, seq: 2 }).reason,
        REJECT_REASONS.WRONG_PHASE
      );
      assertEqual(
        applyAction(s2, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 0, seq: 2 }).reason,
        REJECT_REASONS.WRONG_ACTOR
      );
      assertEqual(
        applyAction(s2, { type: ACTION_TYPES.DRAW, actor: SIDES.INSPECTOR, slotIndex: 7, seq: 2 }).reason,
        REJECT_REASONS.INVALID_SLOT_INDEX
      );

      const drawAction = { type: ACTION_TYPES.DRAW, actor: SIDES.INSPECTOR, slotIndex: 0, seq: 2 };
      const s3 = applyAction(s2, drawAction).state;
      const dupDraw = applyAction(s3, drawAction);
      assertEqual(dupDraw.ok, false, "Duplicate draw rejected");
      assertEqual(dupDraw.reason, REJECT_REASONS.DUPLICATE_OR_STALE_SEQ);
    },
  },

  {
    name: "Final Call triggers at 3 consecutive Unlisted transfers, locks slot, forces a pair, resets streak, and never deadlocks tiny hands",
    run() {
      // Deal leaves Inspector with [LANTERN-A, WATCH-A, UNLISTED-0] and Player with [LANTERN-B, WATCH-B].
      const deckOrder = interleaveHands(
        ["KEY-A", "KEY-B", "BELL-A", "BELL-B", "LANTERN-A", "WATCH-A", "UNLISTED-0"],
        ["TRUNK-A", "TRUNK-B", "SEAL-A", "SEAL-B", "LANTERN-B", "WATCH-B"]
      );
      let st = createDuel({
        encounterSeed: "FINAL-CALL-SCRIPT",
        pairCount: 6,
        startingOfferer: SIDES.INSPECTOR,
        customDeckOrder: deckOrder,
      });

      // Transfer #1: Inspector offers [LANTERN-A, WATCH-A, UNLISTED-0], Player draws slot 2 (UNLISTED-0).
      st = applyAction(st, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
      st = applyAction(st, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 2 }).state;
      assertEqual(st.unlistedStreak, 1);
      assertEqual(st.finalCall, null);

      // Transfer #2: Player offers [LANTERN-B, WATCH-B, UNLISTED-0], Inspector draws slot 2 (UNLISTED-0).
      st = applyAction(st, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;
      st = applyAction(st, { type: ACTION_TYPES.DRAW, actor: SIDES.INSPECTOR, slotIndex: 2 }).state;
      assertEqual(st.unlistedStreak, 2);
      assertEqual(st.finalCall, null);

      // Transfer #3: Inspector swaps UNLISTED-0 (slot 2) to slot 0, commits; Player draws slot 0 (UNLISTED-0) -> streak hits 3 -> FINAL CALL!
      st = applyAction(st, {
        type: ACTION_TYPES.SWAP,
        actor: SIDES.INSPECTOR,
        indexA: 0,
        indexB: 2,
      }).state;
      st = applyAction(st, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
      const draw3 = applyAction(st, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 0 });
      assert(draw3.ok);
      assert(draw3.events.some((e) => e.type === "FINAL_CALL_TRIGGERED"));
      st = draw3.state;

      assertEqual(st.unlistedStreak, 3);
      assertEqual(st.offerer, SIDES.PLAYER);
      assert(st.finalCall && st.finalCall.active, "Final Call active on incoming offerer");
      assertEqual(st.finalCall.slotIndex, 2, "Marks slot 2 where UNLISTED-0 arrived");
      assertEqual(st.hands.PLAYER[st.finalCall.slotIndex].ticketId, UNLISTED_ID);

      // Locked Unlisted slot cannot be swapped, but the two unlocked ordinary slots [0, 1] CAN still swap.
      const illegalLockedSwap = applyAction(st, {
        type: ACTION_TYPES.SWAP,
        actor: SIDES.PLAYER,
        indexA: 0,
        indexB: 2,
      });
      assertEqual(illegalLockedSwap.ok, false);
      assertEqual(illegalLockedSwap.reason, REJECT_REASONS.SLOT_LOCKED);

      const legalUnlockedSwap = applyAction(st, {
        type: ACTION_TYPES.SWAP,
        actor: SIDES.PLAYER,
        indexA: 0,
        indexB: 1,
      });
      assert(legalUnlockedSwap.ok, "Offerer can still swap non-pinned slots during Final Call");
      st = legalUnlockedSwap.state;

      st = applyAction(st, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;

      // ObserverView publicly exposes Final Call slot and excludes it from legalDrawSlots.
      const inspView = createObserverView(st, SIDES.INSPECTOR);
      assertDeepEqual(inspView.legal.legalDrawSlots, [0, 1]);
      assertEqual(inspView.opponentSlots[2].lockReason, "FINAL_CALL");
      assertEqual(inspView.opponentSlots[2].revealedTicket.ticketId, UNLISTED_ID);

      // Attempting to draw locked Final Call slot is rejected.
      const illegalLockedDraw = applyAction(st, {
        type: ACTION_TYPES.DRAW,
        actor: SIDES.INSPECTOR,
        slotIndex: 2,
      });
      assertEqual(illegalLockedDraw.ok, false);
      assertEqual(illegalLockedDraw.reason, REJECT_REASONS.SLOT_LOCKED);

      // Drawing slot 0 forces a pair (WATCH), clears Final Call, and resets streak to 0!
      st = applyAction(st, { type: ACTION_TYPES.DRAW, actor: SIDES.INSPECTOR, slotIndex: 0 }).state;
      assertEqual(st.finalCall, null, "Final Call cleared after forced pair");
      assertEqual(st.lockedSlots.length, 0);
      assertEqual(st.unlistedStreak, 0, "Streak reset to 0");
      assert(verifyInvariants(st).ok);

      // Now test 2-card terminal Final Call: Player holds [LANTERN-B, UNLISTED-0], Inspector holds [LANTERN-A].
      // Bounce UNLISTED-0 three times between 2-card hands -> triggers Final Call on 2-card hand -> forces winning draw!
      // First advance to Player's offer (right now Inspector offers [LANTERN-A] to Player? No: Inspector just drew from Player, so Inspector is now offerer with [LANTERN-A]!)
      // Wait: if Player draws LANTERN-A from Inspector, the duel ends. So build a fresh 1-pair-left state where Inspector holds [LANTERN-A, UNLISTED-0] and Player holds [LANTERN-B]:
      const twoCardDeck = interleaveHands(
        ["KEY-A", "KEY-B", "BELL-A", "BELL-B", "WATCH-A", "WATCH-B", "UNLISTED-0"],
        ["TRUNK-A", "TRUNK-B", "SEAL-A", "SEAL-B", "LANTERN-A", "LANTERN-B"]
      );
      // Wait: keep LANTERN split:
      const splitOnePair = interleaveHands(
        ["KEY-A", "KEY-B", "BELL-A", "BELL-B", "WATCH-A", "LANTERN-A", "UNLISTED-0"],
        ["TRUNK-A", "TRUNK-B", "SEAL-A", "SEAL-B", "WATCH-B", "LANTERN-B"]
      );
      let s2 = createDuel({
        encounterSeed: "FC-2CARD",
        pairCount: 6,
        startingOfferer: SIDES.INSPECTOR,
        customDeckOrder: splitOnePair,
      });
      // Pair WATCH first so 1 pair remains:
      s2 = applyAction(s2, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
      s2 = applyAction(s2, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 0 }).state; // pairs WATCH -> Player offers [LANTERN-B], wait!
      // Instead have Player grab UNLISTED-0 first, then Inspector pairs WATCH:
      s2 = createDuel({
        encounterSeed: "FC-2CARD-B",
        pairCount: 6,
        startingOfferer: SIDES.INSPECTOR,
        customDeckOrder: splitOnePair,
      });
      s2 = applyAction(s2, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
      s2 = applyAction(s2, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 2 }).state; // streak 1 (Player got U)
      s2 = applyAction(s2, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;
      s2 = applyAction(s2, { type: ACTION_TYPES.DRAW, actor: SIDES.INSPECTOR, slotIndex: 0 }).state; // pairs WATCH -> streak resets to 0!
      assertEqual(s2.unlistedStreak, 0, "Matching a pair resets non-zero Unlisted streak");

      // Now Inspector holds [LANTERN-A] (1), Player holds [LANTERN-B, UNLISTED-0] (2). Wait: Inspector offers [LANTERN-A].
      // To get 2-card offerer with U: start from Player offering [LANTERN-B, UNLISTED-0] after Inspector draws U 3 times!
      s2 = createDuel({
        encounterSeed: "FC-2CARD-C",
        pairCount: 6,
        startingOfferer: SIDES.INSPECTOR,
        customDeckOrder: splitOnePair,
      });
      s2 = applyAction(s2, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.INSPECTOR }).state;
      s2 = applyAction(s2, { type: ACTION_TYPES.DRAW, actor: SIDES.PLAYER, slotIndex: 0 }).state; // pairs WATCH. Player=[LANTERN-B], Insp=[LANTERN-A, U]
      // Wait: Player offers [LANTERN-B] -> ends game. With 1 pair remaining, whoever offers with U has 2 cards [L, U]!
      // Start with splitOnePair2 where deal leaves Insp=[LANTERN-A, UNLISTED-0] (2) and Player=[LANTERN-B] (1):
      const exactOnePair = interleaveHands(
        ["KEY-A", "KEY-B", "BELL-A", "BELL-B", "WATCH-A", "WATCH-B", "UNLISTED-0"],
        ["TRUNK-A", "TRUNK-B", "SEAL-A", "SEAL-B", "LANTERN-A", "LANTERN-B"]
      );
      assert(exactOnePair.length === 13);
      // Put LANTERN-A in Inspector, TRUNK-A/B both in Inspector, SEAL-A/B both in Player:
      const onePairStart = interleaveHands(
        ["KEY-A", "KEY-B", "BELL-A", "BELL-B", "LANTERN-A", "UNLISTED-0", "WATCH-A"],
        ["TRUNK-A", "TRUNK-B", "SEAL-A", "SEAL-B", "LANTERN-B", "WATCH-B"]
      );
      // Deal with 5 pairs packed cleanly: Insp gets KEY-A,KEY-B,BELL-A,BELL-B,LANTERN-A,UNLISTED-0 (6 cards) and Player gets TRUNK-A,TRUNK-B,SEAL-A,SEAL-B,WATCH-A,WATCH-B,LANTERN-B (7 cards):
      const playerOffersTwo = interleaveHands(
        ["TRUNK-A", "TRUNK-B", "SEAL-A", "SEAL-B", "WATCH-A", "WATCH-B", "LANTERN-B"],
        ["KEY-A", "KEY-B", "BELL-A", "BELL-B", "LANTERN-A", "UNLISTED-0"]
      );
      let sEnd = createDuel({
        encounterSeed: "FC-ENDGAME",
        pairCount: 6,
        startingOfferer: SIDES.INSPECTOR,
        customDeckOrder: interleaveHands(
          ["KEY-A", "KEY-B", "BELL-A", "BELL-B", "WATCH-A", "WATCH-B", "LANTERN-A"],
          ["TRUNK-A", "TRUNK-B", "SEAL-A", "SEAL-B", "LANTERN-B", "UNLISTED-0"]
        ),
      });
      assert(playerOffersTwo.length === 13 && verifyInvariants(sEnd).ok);

      // Make Inspector start with [LANTERN-A, UNLISTED-0] (2) by giving Insp 2 pairs + LANTERN-A + UNLISTED-0 = 6 cards (Player offers first with 3 pairs + LANTERN-B = 7 cards, wait: offerer gets 7, drawer gets 6):
      // Offerer gets 7 = 2 pairs (4) + no, 2 pairs (4) + LANTERN-A + UNLISTED-0 = 6 (even). 3 pairs (6) + LANTERN-A = 7 (odd), drawer gets 2 pairs (4) + LANTERN-B + UNLISTED-0 = 6 (even)!
      // Let's get Offerer = [LANTERN-A, UNLISTED-0] via 7 pairs (15 cards): Offerer gets 8 = 3 pairs (6) + LANTERN-A + UNLISTED-0! Drawer gets 7 = 3 pairs (6) + LANTERN-B!
      const twoCardOffererDeck = interleaveHands(
        ["KEY-A", "KEY-B", "BELL-A", "BELL-B", "WATCH-A", "WATCH-B", "LANTERN-A", "UNLISTED-0"],
        ["TRUNK-A", "TRUNK-B", "SEAL-A", "SEAL-B", "WHISTLE-A", "WHISTLE-B", "LANTERN-B"]
      );
      sEnd = createDuel({
        encounterSeed: "FC-2CARD-EXACT",
        pairCount: 7,
        startingOfferer: SIDES.INSPECTOR,
        customDeckOrder: twoCardOffererDeck,
      });
      assertEqual(sEnd.hands.INSPECTOR.length, 2);
      assertEqual(sEnd.hands.PLAYER.length, 1);

      // Bounce UNLISTED-0 three times in a 2-card endgame:
      for (let bounce = 1; bounce <= 3; bounce += 1) {
        const off = sEnd.offerer;
        const drw = sEnd.drawer;
        sEnd = applyAction(sEnd, { type: ACTION_TYPES.COMMIT_OFFER, actor: off }).state;
        sEnd = applyAction(sEnd, { type: ACTION_TYPES.DRAW, actor: drw, slotIndex: 1 }).state;
        assertEqual(sEnd.unlistedStreak, bounce);
      }
      // Now Player offers [LANTERN-B, UNLISTED-0] under Final Call: slot 1 locked, canSwap false, canCommit true, only slot 0 drawable!
      assert(sEnd.finalCall && sEnd.finalCall.active);
      assertEqual(sEnd.offerer, SIDES.PLAYER);
      assertEqual(getLegalActions(sEnd, SIDES.PLAYER).canSwap, false);
      assertEqual(getLegalActions(sEnd, SIDES.PLAYER).canCommit, true);
      sEnd = applyAction(sEnd, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;
      assertDeepEqual(getLegalActions(sEnd, SIDES.INSPECTOR).legalDrawSlots, [0]);
      sEnd = applyAction(sEnd, { type: ACTION_TYPES.DRAW, actor: SIDES.INSPECTOR, slotIndex: 0 }).state;
      assertEqual(sEnd.phase, PHASES.OVER, "Forced draw resolves final pair and ends duel cleanly");
      assertEqual(sEnd.winner, SIDES.INSPECTOR);
      assertEqual(sEnd.loser, SIDES.PLAYER);
      assert(verifyInvariants(sEnd).ok);

      // Small-hand deadlock safety tests on evaluateFinalCall (RULES.md Section 6 & D3):
      const unlistedCard = buildDeck(6).find((t) => t.isUnlisted);
      const ordinaryCard = buildDeck(6).find((t) => !t.isUnlisted);

      const singleCardEval = evaluateFinalCall([unlistedCard], {
        unlistedStreak: 3,
        threshold: 3,
      });
      assertEqual(singleCardEval.triggered, false, "Never locks sole remaining card");
      assertEqual(singleCardEval.waived, true);
      assertEqual(singleCardEval.waiveReason, "INSUFFICIENT_DRAWABLE_SLOTS");

      const allOtherLockedEval = evaluateFinalCall([ordinaryCard, unlistedCard], {
        unlistedStreak: 3,
        threshold: 3,
        existingLockedIndices: [0],
      });
      assertEqual(allOtherLockedEval.triggered, false, "Waives lock if 0 drawable slots would remain");
      assertEqual(allOtherLockedEval.waived, true);
      assertEqual(allOtherLockedEval.waiveReason, "INSUFFICIENT_DRAWABLE_SLOTS");
    },
  },

  {
    name: "Replay determinism, seed uniqueness, and strict shuffle/AI PRNG stream isolation",
    run() {
      // Replay 60 diverse seeded duels and verify byte-identical final states & event logs.
      for (let i = 0; i < 60; i += 1) {
        const pairCount = MIN_PAIRS + (i % (MAX_PAIRS - MIN_PAIRS + 1));
        const startingOfferer = i % 2 === 0 ? SIDES.INSPECTOR : SIDES.PLAYER;
        const { state: original } = runSimulatedRandomDuel(
          {
            encounterSeed: `REPLAY-SEED-${i}`,
            pairCount,
            startingOfferer,
          },
          `P-BOT-${i}`,
          `I-BOT-${i}`
        );

        const bundle = exportReplay(original);
        const replayedA = replayDuel(bundle);
        const replayedB = replayDuel(JSON.parse(JSON.stringify(bundle)));

        assert(replayedA.ok && replayedB.ok, "Replay succeeded");
        assertDeepEqual(replayedA.state, original, `Replay A matches original duel #${i}`);
        assertDeepEqual(replayedB.state, original, `Replay B matches original duel #${i}`);
      }

      // Different seeds produce different shuffles.
      const d1 = createDuel({ encounterSeed: "MIDNIGHT-ALPHA", pairCount: 10 });
      const d2 = createDuel({ encounterSeed: "MIDNIGHT-BETA", pairCount: 10 });
      assert(
        JSON.stringify(d1.hands) !== JSON.stringify(d2.hands),
        "Distinct seeds yield distinct opening hands"
      );

      // Stream isolation: consuming aiRng heavily never alters shuffleRng output.
      const streamsA = createDuelStreams("STATION-77", 2);
      const streamsB = createDuelStreams("STATION-77", 2);
      const aiA = streamsA.createAiRng();
      for (let k = 0; k < 500; k += 1) aiA.next();

      const shufA = streamsA.createShuffleRng();
      const shufB = streamsB.createShuffleRng();
      const seqA = Array.from({ length: 20 }, () => shufA.next());
      const seqB = Array.from({ length: 20 }, () => shufB.next());
      assertDeepEqual(seqA, seqB, "Shuffle stream unaffected by AI stream consumption");

      const aiFresh = streamsB.createAiRng();
      assert(aiFresh.next() !== seqA[0], "AI and shuffle streams use distinct derived seeds");
      assertEqual(normalizeSeed("  COACH-9  "), "COACH-9");
      assert(hashSeed("A::[1]B") !== hashSeed("AB::[0]"));
    },
  },

  {
    name: "ObserverView never leaks opponent hidden cards, private swaps, or encounter seed",
    run() {
      const secretSeed = "TOP-SECRET-SHUFFLE-SEED-9941";
      const deckOrder = interleaveHands(
        ["LANTERN-A", "WATCH-A", "KEY-A", "BELL-A", "TRUNK-A", "SEAL-A", "UNLISTED-0"],
        ["LANTERN-B", "WATCH-B", "KEY-B", "BELL-B", "TRUNK-B", "SEAL-B"]
      );
      let st = createDuel({
        encounterSeed: secretSeed,
        pairCount: 6,
        startingOfferer: SIDES.PLAYER,
        customDeckOrder: deckOrder,
      });

      // Player performs a private swap (slot 1 <-> slot 6, moving UNLISTED-0 to slot 1) and commits.
      st = applyAction(st, {
        type: ACTION_TYPES.SWAP,
        actor: SIDES.PLAYER,
        indexA: 1,
        indexB: 6,
      }).state;
      st = applyAction(st, {
        type: ACTION_TYPES.COMMIT_OFFER,
        actor: SIDES.PLAYER,
      }).state;

      const inspView = createObserverView(st, SIDES.INSPECTOR);
      const serialized = JSON.stringify(inspView);

      assert(!serialized.includes(secretSeed), "Never leaks encounterSeed");
      assert(!serialized.includes("SWAP_PERFORMED"), "Never leaks opponent private swap event");
      for (const hiddenTicket of st.hands.PLAYER) {
        assert(
          !serialized.includes(hiddenTicket.ticketId),
          `ObserverView leaked hidden player ticketId ${hiddenTicket.ticketId}`
        );
      }
      assertEqual(inspView.opponentHandCount, 7);
      assertEqual(inspView.opponentHoldsUnlisted, true);
      assert(inspView.opponentSlots.every((slot) => slot.revealedTicket === null));
    },
  },

  {
    name: "Duel controller: plays full duels from both sides, blocks double-draws, and clears timers on restart/dispose",
    run() {
      // 1. Complete immediate duels from both starting modes + verify alternation.
      const ctrl = createDuelController({
        initialSeed: "CTRL-TEST-1",
        initialPairCount: 6,
        initialStartingMode: STARTING_MODES.ALTERNATE,
        immediate: true,
      });
      ctrl.startDuel();
      assertEqual(
        ctrl.getSnapshot().view.publicHistory[0].startingOfferer,
        SIDES.INSPECTOR,
        "Encounter 0: Player draws first"
      );

      for (let enc = 0; enc < 2; enc += 1) {
        if (enc > 0) ctrl.nextEncounter();
        const expectedOfferer = enc % 2 === 0 ? SIDES.INSPECTOR : SIDES.PLAYER;
        assertEqual(
          ctrl.getSnapshot().view.publicHistory[0].startingOfferer,
          expectedOfferer,
          `Encounter ${enc} alternates startingOfferer`
        );

        let guard = 0;
        while (ctrl.getSnapshot().view.phase !== PHASES.OVER) {
          guard += 1;
          assert(guard < 200, "Controller duel terminated");
          const { view } = ctrl.getSnapshot();
          assertEqual(view.activeActor, SIDES.PLAYER, "Controller automatically completes AI steps");

          if (view.phase === PHASES.OFFER) {
            if (view.legal.canSwap && view.legal.legalSwapSlots.length >= 2) {
              const a = view.legal.legalSwapSlots[0];
              const b = view.legal.legalSwapSlots[view.legal.legalSwapSlots.length - 1];
              assert(ctrl.selectOfferSlot(a).ok);
              assert(ctrl.selectOfferSlot(b).ok);
            }
            assert(ctrl.commitOffer().ok);
          } else {
            const pick = view.legal.legalDrawSlots[0];
            assert(ctrl.drawSlot(pick).ok);
          }
        }

        // Verify the controller's recorded replay reproduces cleanly.
        const replay = replayDuel(ctrl.getReplayBundle());
        assert(replay.ok && replay.state.phase === PHASES.OVER);
      }
      ctrl.dispose();

      // 2. Fake-timer verification: double-draw blocked during reveal beat, and restart cancels pending timers.
      let nextId = 1;
      const queue = new Map();
      const fakeScheduler = {
        setTimeout(fn, ms) {
          const id = nextId++;
          queue.set(id, { fn, ms });
          return id;
        },
        clearTimeout(id) {
          queue.delete(id);
        },
      };

      const flushOne = () => {
        const first = queue.entries().next();
        if (first.done) return false;
        const [id, entry] = first.value;
        queue.delete(id);
        entry.fn();
        return true;
      };

      const asyncCtrl = createDuelController({
        initialSeed: "LOCK-TEST-42",
        initialPairCount: 8,
        initialStartingMode: STARTING_MODES.PLAYER_DRAWS_FIRST,
        immediate: false,
        scheduler: fakeScheduler,
      });
      asyncCtrl.startDuel();

      // Advance Inspector's opening offer until it's Player's DRAW_PHASE.
      let ticks = 0;
      while (asyncCtrl.getSnapshot().inputLocked && ticks < 10) {
        flushOne();
        ticks += 1;
      }
      const beforeDraw = asyncCtrl.getSnapshot();
      assertEqual(beforeDraw.view.phase, PHASES.DRAW);
      assertEqual(beforeDraw.view.activeActor, SIDES.PLAYER);

      const firstSlot = beforeDraw.view.legal.legalDrawSlots[0];
      const firstClick = asyncCtrl.drawSlot(firstSlot);
      assertEqual(firstClick.ok, true, "First draw accepted");
      assertEqual(asyncCtrl.getSnapshot().inputLocked, true, "Input locks immediately on draw");

      const seqAfterFirst = asyncCtrl.getSnapshot().view.nextSeq;
      const rapidDoubleClick = asyncCtrl.drawSlot(0);
      assertEqual(rapidDoubleClick.ok, false, "Rapid double-draw rejected");
      assertEqual(rapidDoubleClick.reason, "INPUT_LOCKED");
      assertEqual(
        asyncCtrl.getSnapshot().view.nextSeq,
        seqAfterFirst,
        "Double-draw did not advance state"
      );

      // Restart while reveal timer is still queued -> old timer cleared cleanly.
      assert(queue.size >= 1, "Reveal timer was pending");
      asyncCtrl.restartDuel();
      asyncCtrl.dispose();
      assertEqual(queue.size, 0, "All timers cleared on dispose");

      // 3. Restarting with same seed & same player actions produces identical full duel & AI choices.
      const playDeterministicScript = () => {
        const c = createDuelController({
          initialSeed: "EXACT-REPEAT-88",
          initialPairCount: 7,
          initialStartingMode: STARTING_MODES.PLAYER_OFFERS_FIRST,
          immediate: true,
        });
        c.startDuel();
        let sawSwapTag = false;
        while (c.getSnapshot().view.phase !== PHASES.OVER) {
          const s = c.getSnapshot();
          if (s.view.phase === PHASES.OFFER) {
            if (s.view.legal.canSwap && s.view.legal.legalSwapSlots.length >= 2) {
              c.selectOfferSlot(s.view.legal.legalSwapSlots[0]);
              c.selectOfferSlot(s.view.legal.legalSwapSlots[1]);
              if (c.getSnapshot().lastSwappedSlots.length === 2) {
                sawSwapTag = true;
              }
            }
            c.commitOffer();
          } else {
            const slots = s.view.legal.legalDrawSlots;
            c.drawSlot(slots[slots.length - 1]);
          }
        }
        assert(sawSwapTag, "lastSwappedSlots confirms private swap before commit");
        const bundle = c.getReplayBundle();
        const finalView = c.getSnapshot().view;
        c.dispose();
        return { bundle, finalView };
      };

      const runA = playDeterministicScript();
      const runB = playDeterministicScript();
      assertDeepEqual(runA.bundle, runB.bundle, "Identical seed + inputs yield identical replay bundle");
      assertDeepEqual(runA.finalView, runB.finalView, "Identical final view on restart");

      // 4. Corrupted replay with extra action after DUEL_OVER is cleanly flagged.
      const tampered = {
        config: runA.bundle.config,
        actions: [
          ...runA.bundle.actions,
          { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER },
        ],
      };
      const badReplay = replayDuel(tampered);
      assertEqual(badReplay.ok, false, "Rejects trailing action after DUEL_OVER");
      assertEqual(badReplay.failedIndex, runA.bundle.actions.length);
      assertEqual(badReplay.reason, REJECT_REASONS.DUEL_ALREADY_OVER);
    },
  },
];

/**
 * Execute every test in PHASE1_TESTS and return structured summary results.
 */
export function runPhase1Suite() {
  const results = [];
  let passed = 0;
  let failed = 0;

  for (const tc of PHASE1_TESTS) {
    const start = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      tc.run();
      const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
      passed += 1;
      results.push({ name: tc.name, ok: true, durationMs: ms, error: null });
    } catch (err) {
      const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
      failed += 1;
      results.push({
        name: tc.name,
        ok: false,
        durationMs: ms,
        error: err instanceof Error ? err.stack || err.message : String(err),
      });
    }
  }

  return {
    total: PHASE1_TESTS.length,
    passed,
    failed,
    ok: failed === 0,
    results,
  };
}
