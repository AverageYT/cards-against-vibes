/**
 * tests/phase2Suite.js
 * Portable zero-dependency Phase 2 automated test suite for Inspector AI Tiers 1–5,
 * positional bucket learning (smoothing, decay, edge->center shift, run reset),
 * offer-scoped reveal memory, strict hidden-card permutation invariance, and
 * developer-only decision trace.
 */

import {
  ACTION_TYPES,
  PHASES,
  SIDES,
  applyAction,
  createDuel,
  verifyInvariants,
} from "../src/core/engine.js";
import { createObserverView } from "../src/core/observer.js";
import { createRng, deriveSeed } from "../src/core/rng.js";
import { BUCKETS } from "../src/data/aiTuning.js";
import { UNLISTED_ID } from "../src/data/tickets.js";
import {
  createInspectorMemory,
  slotToBucket,
  slotToNormalizedPos,
} from "../src/ai/learner.js";
import {
  chooseInspectorAction,
  createInspectorAgent,
  estimateContinuationWinProb,
} from "../src/ai/inspector.js";
import {
  createCenterPolicy,
  createLeftEdgePolicy,
} from "../src/ai/policies.js";
import {
  STARTING_MODES,
  TIER_MODES,
  createDuelController,
} from "../src/ui/duelController.js";
import { runPairedBenchmark } from "./benchmark.js";

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
      `${message ? `${message}: ` : ""}deep equality mismatch.\nActual:   ${a.slice(0, 500)}\nExpected: ${b.slice(0, 500)}`
    );
  }
}

function interleaveHands(offererIds, drawerIds) {
  const deck = [];
  for (let i = 0; i < offererIds.length; i += 1) {
    deck.push(offererIds[i]);
    if (i < drawerIds.length) deck.push(drawerIds[i]);
  }
  return deck;
}

/**
 * Helper: measure where an Inspector tier actually places UNLISTED-0 across N committed offers
 * given the current memory state (without adding new player draws during probing).
 */
function measureUnlistedOfferDistribution(tier, baseMemory, sampleCount = 300, seedTag = "PROBE") {
  // 5-card Inspector offer hand with UNLISTED-0 starting at various slots so every bucket [0..4] maps 1-to-1!
  // Hand size 5 -> slot 0: LEFT_EDGE (0.0), slot 1: LEFT_MID (0.25), slot 2: CENTER (0.5),
  //                slot 3: RIGHT_MID (0.75), slot 4: RIGHT_EDGE (1.0).
  const inspBase = ["LANTERN-A", "WATCH-A", "KEY-A", "BELL-A", "UNLISTED-0"];
  const playerBase = ["LANTERN-B", "WATCH-B", "KEY-B", "BELL-B"];
  const extraInsp = ["TRUNK-A", "TRUNK-B"];
  const extraPlay = ["SEAL-A", "SEAL-B"];

  const counts = {
    LEFT_EDGE: 0,
    LEFT_MID: 0,
    CENTER: 0,
    RIGHT_MID: 0,
    RIGHT_EDGE: 0,
  };

  for (let i = 0; i < sampleCount; i += 1) {
    // Rotate starting position of UNLISTED-0 across all 5 slots so a no-swap agent is exact 20% per bucket.
    const rotated = inspBase.slice();
    const uStart = i % 5;
    const tmp = rotated[4];
    rotated[4] = rotated[uStart];
    rotated[uStart] = tmp;

    const deck = interleaveHands([...extraInsp, ...rotated], [...extraPlay, ...playerBase]);
    let st = createDuel({
      encounterSeed: `${seedTag}-D-${i}`,
      pairCount: 6,
      startingOfferer: SIDES.INSPECTOR,
      customDeckOrder: deck,
    });

    const mem = baseMemory.clone();
    mem.resetForNewDuel();
    const aiRng = createRng(`${seedTag}-AI-${i}`);

    let safety = 0;
    while (st.phase === PHASES.OFFER && safety < 5) {
      safety += 1;
      const view = createObserverView(st, SIDES.INSPECTOR);
      const { action } = chooseInspectorAction(view, aiRng, mem, tier);
      const res = applyAction(st, action);
      assert(res.ok, `Probe offer action failed: ${res.reason}`);
      st = res.state;
    }

    assertEqual(st.phase, PHASES.DRAW);
    assertEqual(st.hands.INSPECTOR.length, 5);
    const finalUnlistedSlot = st.hands.INSPECTOR.findIndex((t) => t.isUnlisted);
    const bucket = slotToBucket(finalUnlistedSlot, 5);
    counts[bucket] += 1;
  }

  const rates = {};
  for (const b of BUCKETS) {
    rates[b] = counts[b] / sampleCount;
  }
  return { counts, rates };
}

export const PHASE2_TESTS = [
  {
    name: "Normalized bucket learner: handles shrinking hands, smooths sparse data, ignores forced draws, and resets cleanly",
    run() {
      // Hand size 5 maps 1-to-1 across all 5 buckets.
      assertEqual(slotToBucket(0, 5), "LEFT_EDGE");
      assertEqual(slotToBucket(1, 5), "LEFT_MID");
      assertEqual(slotToBucket(2, 5), "CENTER");
      assertEqual(slotToBucket(3, 5), "RIGHT_MID");
      assertEqual(slotToBucket(4, 5), "RIGHT_EDGE");

      // Hand size 3 maps cleanly to LEFT_EDGE, CENTER, RIGHT_EDGE.
      assertEqual(slotToBucket(0, 3), "LEFT_EDGE");
      assertEqual(slotToBucket(1, 3), "CENTER");
      assertEqual(slotToBucket(2, 3), "RIGHT_EDGE");

      // Hand size 2 maps cleanly to LEFT_EDGE and RIGHT_EDGE.
      assertEqual(slotToBucket(0, 2), "LEFT_EDGE");
      assertEqual(slotToBucket(1, 2), "RIGHT_EDGE");

      // Large hand size 11 keeps edge, mid, and center aligned.
      assertEqual(slotToBucket(0, 11), "LEFT_EDGE");
      assertEqual(slotToBucket(1, 11), "LEFT_EDGE");
      assertEqual(slotToBucket(3, 11), "LEFT_MID");
      assertEqual(slotToBucket(5, 11), "CENTER");
      assertEqual(slotToBucket(7, 11), "RIGHT_MID");
      assertEqual(slotToBucket(10, 11), "RIGHT_EDGE");
      assertEqual(slotToNormalizedPos(0, 1), 0.5);

      const mem = createInspectorMemory();
      const prior = mem.getDrawBucketProbs();
      for (const b of BUCKETS) {
        assert(Math.abs(prior[b] - 0.2) < 1e-9, "Fresh prior is exact uniform 0.20");
      }
      assertEqual(mem.getDetectedPattern().detected, false, "No pattern flagged on empty memory");

      // Forced draw (1 legal option, e.g., Final Call on 2-card hand) must be ignored.
      assertEqual(mem.recordPlayerDraw(0, 2, 1), null, "Ignores forced 1-slot draw");
      assertEqual(mem.snapshot().drawObservations, 0);

      // Single observation stays smoothed (never jumps to 100%, other buckets remain > 10%).
      mem.recordPlayerDraw(0, 7, 7);
      const afterOne = mem.getDrawBucketProbs();
      assert(
        afterOne.LEFT_EDGE > 0.3 && afterOne.LEFT_EDGE < 0.5,
        `Sparse 1-draw smoothing expected moderate rise, got ${afterOne.LEFT_EDGE}`
      );
      assert(afterOne.CENTER > 0.12, "Unvisited buckets retain smoothed mass");
      assertEqual(
        mem.getDetectedPattern().detected,
        false,
        "Pattern remark does not fire after just 1 draw"
      );

      // Reset wipes all state completely.
      mem.resetForNewRun();
      assertEqual(mem.snapshot().drawObservations, 0);
      for (const b of BUCKETS) {
        assert(Math.abs(mem.getDrawBucketProbs()[b] - 0.2) < 1e-9, "Uniform after resetForNewRun");
      }
    },
  },

  {
    name: "Adaptation: scripted left-edge picker shifts Tier 3–5 Unlisted placement left; switching to center shifts it to center; new run resets",
    run() {
      const mem = createInspectorMemory();
      const leftBot = createLeftEdgePolicy({ bias: 1.0 });
      const centerBot = createCenterPolicy({ bias: 1.0 });
      const botRng = createRng("ADAPT-BOT-RNG");

      // Baseline placement before any observations (uniform ~20% per bucket).
      const baselineT3 = measureUnlistedOfferDistribution(3, mem, 300, "BASE-T3");
      assert(
        baselineT3.rates.LEFT_EDGE > 0.13 && baselineT3.rates.LEFT_EDGE < 0.28,
        `Baseline T3 LEFT_EDGE should be near 20%, got ${(baselineT3.rates.LEFT_EDGE * 100).toFixed(1)}%`
      );

      // Phase A: Play real duels against Left-Edge Picker (accumulating ~12 unforced draws across shrinking hand sizes).
      const trainAgainstPolicy = (policy, duelCount, tag) => {
        const agent = createInspectorAgent({ tier: 3, memory: mem });
        for (let d = 0; d < duelCount; d += 1) {
          agent.resetForNewDuel();
          let st = createDuel({
            encounterSeed: `${tag}-SHUF-${d}`,
            pairCount: 8,
            startingOfferer: d % 2 === 0 ? SIDES.INSPECTOR : SIDES.PLAYER,
          });
          const aiRng = createRng(`${tag}-AI-${d}`);
          while (st.phase !== PHASES.OVER) {
            const actor = st.phase === PHASES.OFFER ? st.offerer : st.drawer;
            const view = createObserverView(st, actor);
            const action =
              actor === SIDES.INSPECTOR ? agent.act(view, aiRng) : policy.act(view, botRng);
            st = applyAction(st, action).state;
          }
          agent.observe(createObserverView(st, SIDES.INSPECTOR));
        }
      };

      trainAgainstPolicy(leftBot, 3, "LEFT-PHASE");
      const probsAfterLeft = mem.getDrawBucketProbs();
      const patLeft = mem.getDetectedPattern();

      assert(probsAfterLeft.LEFT_EDGE > 0.55, `Expected strong LEFT_EDGE belief, got ${probsAfterLeft.LEFT_EDGE}`);
      assertEqual(patLeft.detected, true);
      assertEqual(patLeft.bucket, "LEFT_EDGE");

      // Tier 1 logs habits without exploiting them (stays near ~20%).
      const t1Left = measureUnlistedOfferDistribution(1, mem, 300, "AFTER-LEFT-T1");
      assert(
        t1Left.rates.LEFT_EDGE < 0.28,
        `Tier 1 must not exploit learned habits, got ${(t1Left.rates.LEFT_EDGE * 100).toFixed(1)}%`
      );

      // Tiers 3, 4, and 5 all measurably shift Unlisted placement to LEFT_EDGE!
      const t3Left = measureUnlistedOfferDistribution(3, mem, 300, "AFTER-LEFT-T3");
      const t4Left = measureUnlistedOfferDistribution(4, mem, 300, "AFTER-LEFT-T4");
      const t5Left = measureUnlistedOfferDistribution(5, mem, 300, "AFTER-LEFT-T5");

      assert(
        t3Left.rates.LEFT_EDGE > baselineT3.rates.LEFT_EDGE + 0.3,
        `Tier 3 LEFT_EDGE placement (${t3Left.rates.LEFT_EDGE}) must rise strongly over baseline (${baselineT3.rates.LEFT_EDGE})`
      );
      assert(t4Left.rates.LEFT_EDGE > 0.65, `Tier 4 strongly baits LEFT_EDGE (${t4Left.rates.LEFT_EDGE})`);
      assert(t5Left.rates.LEFT_EDGE > 0.75, `Tier 5 sharply baits LEFT_EDGE (${t5Left.rates.LEFT_EDGE})`);
      // Tier 5 still keeps small exploration (not 100.0% deterministic).
      assert(t5Left.rates.LEFT_EDGE < 0.99, "Tier 5 preserves fallible exploration");

      // Phase B: Switch the SAME opponent mid-run to Center Picker -> LEFT_EDGE decays and CENTER takes over!
      trainAgainstPolicy(centerBot, 4, "CENTER-PHASE");
      const probsAfterCenter = mem.getDrawBucketProbs();
      const patCenter = mem.getDetectedPattern();

      assert(
        probsAfterCenter.LEFT_EDGE < probsAfterLeft.LEFT_EDGE * 0.45,
        `Old LEFT_EDGE habit (${probsAfterCenter.LEFT_EDGE}) must decay substantially from (${probsAfterLeft.LEFT_EDGE})`
      );
      assert(
        probsAfterCenter.CENTER > 0.5,
        `New CENTER habit (${probsAfterCenter.CENTER}) must dominate`
      );
      assertEqual(patCenter.detected, true);
      assertEqual(patCenter.bucket, "CENTER");

      const t3Center = measureUnlistedOfferDistribution(3, mem, 300, "AFTER-CENTER-T3");
      const t5Center = measureUnlistedOfferDistribution(5, mem, 300, "AFTER-CENTER-T5");
      assert(
        t3Center.rates.CENTER > t3Center.rates.LEFT_EDGE + 0.3,
        `Tier 3 shifted from LEFT_EDGE (${t3Center.rates.LEFT_EDGE}) to CENTER (${t3Center.rates.CENTER})`
      );
      assert(
        t5Center.rates.CENTER > 0.75 && t5Center.rates.LEFT_EDGE < 0.1,
        `Tier 5 adapted rapidly to CENTER (${t5Center.rates.CENTER}) and faded LEFT_EDGE (${t5Center.rates.LEFT_EDGE})`
      );

      // Phase C: Starting a new run resets placement back to uniform baseline.
      mem.resetForNewRun();
      const afterResetT3 = measureUnlistedOfferDistribution(3, mem, 300, "RESET-T3");
      assert(
        afterResetT3.rates.CENTER < 0.28 && afterResetT3.rates.LEFT_EDGE < 0.28,
        "New run resets Tier 3 placement back to uniform"
      );
    },
  },

  {
    name: "Hidden-card permutation invariance: changing player hidden cards with identical observations & AI seed yields identical decisions & traces across Tiers 1–5",
    run() {
      const playerCards = [
        "LANTERN-A",
        "WATCH-A",
        "KEY-A",
        "BELL-A",
        "TRUNK-A",
        "SEAL-A",
        "UNLISTED-0",
      ];
      const inspCards = ["LANTERN-B", "WATCH-B", "KEY-B", "BELL-B", "TRUNK-B", "SEAL-B"];
      const permRng = createRng("PERMUTE-HIDDEN");

      // Pre-populate realistic non-uniform memory so every learning, hiding, transition, and lookahead branch runs!
      const richMemory = createInspectorMemory();
      richMemory.recordPlayerDraw(0, 7, 7);
      richMemory.recordPlayerDraw(6, 7, 7);
      richMemory.recordPlayerDraw(0, 5, 5);
      richMemory.recordPlayerDraw(2, 5, 5);
      richMemory.recordPlayerDraw(0, 4, 4);
      richMemory.recordInspectorDrawOutcome({
        slotIndex: 0,
        handSize: 5,
        legalDrawCount: 5,
        drewUnlisted: true,
        opponentJustDrewUnlisted: true,
        opponentSwapForfeited: false,
      });

      // 1. DRAW_PHASE with completely hidden player hand: 20 scrambled permutations (Unlisted moves everywhere).
      const buildDrawState = (orderedPlayerCards, seedName, condition = null) => {
        const s0 = createDuel({
          encounterSeed: seedName,
          pairCount: 6,
          startingOfferer: SIDES.PLAYER,
          condition,
          customDeckOrder: interleaveHands(orderedPlayerCards, inspCards),
        });
        return applyAction(s0, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;
      };

      const refState = buildDrawState(playerCards, "SECRET-SHUFFLE-REF");

      for (let tier = 1; tier <= 5; tier += 1) {
        const refMem = richMemory.clone();
        refMem.resetForNewDuel();
        const refView = createObserverView(refState, SIDES.INSPECTOR);
        const refDecision = chooseInspectorAction(
          refView,
          createRng(`FIXED-AI-SEED-T${tier}`),
          refMem,
          tier
        );

        for (let p = 0; p < 20; p += 1) {
          const permutedPlayer = permRng.shuffle(playerCards);
          // Even give each state a DIFFERENT hidden encounterSeed AND optionally a private player SWAP!
          let altState = createDuel({
            encounterSeed: `DIFFERENT-HIDDEN-SEED-${tier}-${p}`,
            pairCount: 6,
            startingOfferer: SIDES.PLAYER,
            customDeckOrder: interleaveHands(permutedPlayer, inspCards),
          });
          if (p % 2 === 0) {
            altState = applyAction(altState, {
              type: ACTION_TYPES.SWAP,
              actor: SIDES.PLAYER,
              indexA: 0,
              indexB: 6,
            }).state;
          }
          altState = applyAction(altState, {
            type: ACTION_TYPES.COMMIT_OFFER,
            actor: SIDES.PLAYER,
          }).state;

          const altMem = richMemory.clone();
          altMem.resetForNewDuel();
          const altView = createObserverView(altState, SIDES.INSPECTOR);
          // Override nextSeq difference only when testing private swap? Keep exact same public action seq:
          const cleanAltState = buildDrawState(permutedPlayer, `DIFF-SECRET-${tier}-${p}`);
          const cleanAltView = createObserverView(cleanAltState, SIDES.INSPECTOR);

          const altDecision = chooseInspectorAction(
            cleanAltView,
            createRng(`FIXED-AI-SEED-T${tier}`),
            altMem,
            tier
          );

          assertDeepEqual(
            altDecision.action,
            refDecision.action,
            `Tier ${tier} DRAW action must be identical across hidden permutation #${p}`
          );
          assertDeepEqual(
            altDecision.trace,
            refDecision.trace,
            `Tier ${tier} DRAW trace must be identical across hidden permutation #${p}`
          );

          // Also verify private player SWAP doesn't change chosen slotIndex!
          const swapMem = richMemory.clone();
          swapMem.resetForNewDuel();
          const swapDecision = chooseInspectorAction(
            altView,
            createRng(`FIXED-AI-SEED-T${tier}`),
            swapMem,
            tier
          );
          assertEqual(
            swapDecision.action.slotIndex,
            refDecision.action.slotIndex,
            `Tier ${tier} cannot see private player swaps`
          );

          // Zero hidden ticket leakage in trace.
          const traceJson = JSON.stringify(altDecision.trace);
          assert(!traceJson.includes(`DIFF-SECRET-${tier}-${p}`), "Trace never leaks seed");
          for (const hidden of cleanAltState.hands.PLAYER) {
            assert(
              !traceJson.includes(hidden.ticketId),
              `Tier ${tier} trace leaked hidden ${hidden.ticketId}`
            );
          }
        }
      }

      // 2. Partial reveal (Drafty Window exposes slot 0 = UNLISTED-0; hidden slots 1..6 permuted).
      const draftyCond = { id: "DRAFTY_WINDOW", activeThroughTurn: 4 };
      const fixedSlot0 = "UNLISTED-0";
      const hiddenTail = ["LANTERN-A", "WATCH-A", "KEY-A", "BELL-A", "TRUNK-A", "SEAL-A"];
      const refPartial = buildDrawState([fixedSlot0, ...hiddenTail], "PARTIAL-REF", draftyCond);

      for (let tier = 1; tier <= 5; tier += 1) {
        const refMem = richMemory.clone();
        refMem.resetForNewDuel();
        const refRes = chooseInspectorAction(
          createObserverView(refPartial, SIDES.INSPECTOR),
          createRng(`PARTIAL-AI-${tier}`),
          refMem,
          tier
        );

        for (let p = 0; p < 12; p += 1) {
          const permTail = permRng.shuffle(hiddenTail);
          const altPartial = buildDrawState(
            [fixedSlot0, ...permTail],
            `PARTIAL-ALT-${tier}-${p}`,
            draftyCond
          );
          const altMem = richMemory.clone();
          altMem.resetForNewDuel();
          const altRes = chooseInspectorAction(
            createObserverView(altPartial, SIDES.INSPECTOR),
            createRng(`PARTIAL-AI-${tier}`),
            altMem,
            tier
          );
          assertDeepEqual(altRes.action, refRes.action, `Tier ${tier} partial-reveal action invariant`);
          assertDeepEqual(altRes.trace, refRes.trace, `Tier ${tier} partial-reveal trace invariant`);
        }
      }

      // 3. OFFER_PHASE invariance: scrambling Player's hidden hand never changes Inspector's offer decision.
      const inspOfferCards = [
        "LANTERN-A",
        "WATCH-A",
        "KEY-A",
        "BELL-A",
        "TRUNK-A",
        "SEAL-A",
        "UNLISTED-0",
      ];
      const playerDrawCards = ["LANTERN-B", "WATCH-B", "KEY-B", "BELL-B", "TRUNK-B", "SEAL-B"];
      const refOffer = createDuel({
        encounterSeed: "OFFER-REF",
        pairCount: 6,
        startingOfferer: SIDES.INSPECTOR,
        customDeckOrder: interleaveHands(inspOfferCards, playerDrawCards),
      });

      for (let tier = 1; tier <= 5; tier += 1) {
        const mA = richMemory.clone();
        mA.resetForNewDuel();
        const dA = chooseInspectorAction(
          createObserverView(refOffer, SIDES.INSPECTOR),
          createRng(`OFFER-AI-${tier}`),
          mA,
          tier
        );

        const mB = richMemory.clone();
        mB.resetForNewDuel();
        const altOffer = createDuel({
          encounterSeed: "OFFER-ALT",
          pairCount: 6,
          startingOfferer: SIDES.INSPECTOR,
          customDeckOrder: interleaveHands(inspOfferCards, permRng.shuffle(playerDrawCards)),
        });
        const dB = chooseInspectorAction(
          createObserverView(altOffer, SIDES.INSPECTOR),
          createRng(`OFFER-AI-${tier}`),
          mB,
          tier
        );
        assertDeepEqual(dB.action, dA.action, `Tier ${tier} OFFER action invariant`);
        assertDeepEqual(dB.trace, dA.trace, `Tier ${tier} OFFER trace invariant`);
      }
    },
  },

  {
    name: "Valid-offer reveal memory: Tiers 2–5 exploit active reveals, dodge revealed Unlisted, and expire reveals when offer ends",
    run() {
      const drafty = { id: "DRAFTY_WINDOW", activeThroughTurn: 4 };

      // Case A: Slot 0 revealed as ordinary LANTERN-A -> Tiers 2–5 pick slot 0 every single time.
      const safeRevealDeck = interleaveHands(
        ["LANTERN-A", "WATCH-A", "KEY-A", "BELL-A", "TRUNK-A", "SEAL-A", "UNLISTED-0"],
        ["LANTERN-B", "WATCH-B", "KEY-B", "BELL-B", "TRUNK-B", "SEAL-B"]
      );
      let sSafe = createDuel({
        encounterSeed: "REV-SAFE",
        pairCount: 6,
        startingOfferer: SIDES.PLAYER,
        condition: drafty,
        customDeckOrder: safeRevealDeck,
      });
      sSafe = applyAction(sSafe, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;
      assert(verifyInvariants(sSafe).ok);

      for (let tier = 2; tier <= 5; tier += 1) {
        for (let seed = 0; seed < 15; seed += 1) {
          const mem = createInspectorMemory();
          const { action, trace } = chooseInspectorAction(
            createObserverView(sSafe, SIDES.INSPECTOR),
            createRng(`SAFE-REV-${tier}-${seed}`),
            mem,
            tier
          );
          assertEqual(action.slotIndex, 0, `Tier ${tier} always draws revealed safe pair at slot 0`);
          assertEqual(mem.getValidReveals(sSafe.offerId).length, 1);
          assertEqual(mem.getValidReveals(sSafe.offerId + 1).length, 0, "Not valid for future offerId");
          assert(trace.observedFacts.validReveals.length === 1);
        }
      }

      // Case B: Slot 0 revealed as UNLISTED-0 -> Tiers 2–5 NEVER pick slot 0; then reveal expires on next turn!
      const badRevealDeck = interleaveHands(
        ["UNLISTED-0", "WATCH-A", "KEY-A", "BELL-A", "TRUNK-A", "SEAL-A", "LANTERN-A"],
        ["LANTERN-B", "WATCH-B", "KEY-B", "BELL-B", "TRUNK-B", "SEAL-B"]
      );
      let sBad = createDuel({
        encounterSeed: "REV-BAD",
        pairCount: 6,
        startingOfferer: SIDES.PLAYER,
        condition: drafty,
        customDeckOrder: badRevealDeck,
      });
      sBad = applyAction(sBad, { type: ACTION_TYPES.COMMIT_OFFER, actor: SIDES.PLAYER }).state;

      for (let tier = 2; tier <= 5; tier += 1) {
        const mem = createInspectorMemory();
        for (let seed = 0; seed < 25; seed += 1) {
          const { action } = chooseInspectorAction(
            createObserverView(sBad, SIDES.INSPECTOR),
            createRng(`BAD-REV-${tier}-${seed}`),
            mem,
            tier
          );
          assert(action.slotIndex !== 0, `Tier ${tier} must never draw revealed Unlisted at slot 0`);
        }

        // Advance past the draw -> prior offer reveal must expire immediately!
        const oldOfferId = sBad.offerId;
        const afterDraw = applyAction(sBad, {
          type: ACTION_TYPES.DRAW,
          actor: SIDES.INSPECTOR,
          slotIndex: 1,
        }).state;
        mem.syncFromView(createObserverView(afterDraw, SIDES.INSPECTOR));
        assertEqual(
          mem.getValidReveals(oldOfferId).length,
          0,
          `Tier ${tier} clears expired offer reveals once draw resolves`
        );
        assertEqual(mem.getValidReveals(afterDraw.offerId).length, 0);
      }

      // Verify Drafty Window expires cleanly at Turn 5 (no public reveal on Turn 5 commit).
      let sExp = createDuel({
        encounterSeed: "REV-EXPIRE",
        pairCount: 8,
        startingOfferer: SIDES.PLAYER,
        condition: drafty,
      });
      while (sExp.phase !== PHASES.OVER && sExp.turnNumber < 5) {
        if (sExp.phase === PHASES.OFFER) {
          sExp = applyAction(sExp, { type: ACTION_TYPES.COMMIT_OFFER, actor: sExp.offerer }).state;
        } else {
          sExp = applyAction(sExp, {
            type: ACTION_TYPES.DRAW,
            actor: sExp.drawer,
            slotIndex: 0,
          }).state;
        }
      }
      if (sExp.phase === PHASES.OFFER && sExp.turnNumber === 5) {
        assertEqual(sExp.condition.expired, true, "Drafty Window marked expired on Turn 5");
        sExp = applyAction(sExp, { type: ACTION_TYPES.COMMIT_OFFER, actor: sExp.offerer }).state;
        assertEqual(sExp.publicReveals.length, 0, "Zero public reveals after Turn 5 expiry");
      }
    },
  },

  {
    name: "Tier 5 lookahead & developer trace: stays hidden by default, logs legal factors, carries across stops, and resets on new run",
    run() {
      // Continuation value sanity checks.
      assertEqual(
        estimateContinuationWinProb({
          remainingPairs: 0,
          inspectorHoldsUnlisted: false,
          streak: 0,
          threshold: 3,
        }),
        1
      );
      assertEqual(
        estimateContinuationWinProb({
          remainingPairs: 0,
          inspectorHoldsUnlisted: true,
          streak: 0,
          threshold: 3,
        }),
        0
      );
      const vAdv = estimateContinuationWinProb({
        remainingPairs: 2,
        inspectorHoldsUnlisted: false,
        streak: 0,
        threshold: 3,
      });
      const vDis = estimateContinuationWinProb({
        remainingPairs: 2,
        inspectorHoldsUnlisted: true,
        streak: 0,
        threshold: 3,
      });
      assert(vAdv > vDis && vAdv > 0.5 && vDis < 0.5, "Lookahead favors not holding The Unlisted");

      // Controller trace & run-level memory lifecycle.
      const ctrl = createDuelController({
        initialSeed: "TRACE-RUN-5",
        initialPairCount: 6,
        initialStartingMode: STARTING_MODES.ALTERNATE,
        initialTierMode: TIER_MODES.RAMP,
        immediate: true,
      });
      ctrl.startNewRun();

      // Hidden by default during normal play!
      assertEqual(ctrl.getSnapshot().devTraceOpen, false);
      assertEqual(ctrl.getSnapshot().devTrace, null);
      assertEqual(ctrl.getSnapshot().activeTier, 1, "Ramp starts at Tier 1");

      // Play 3 encounters picking leftmost slot; verify tier ramps 1->2->3 and learning persists.
      for (let stop = 0; stop < 3; stop += 1) {
        if (stop > 0) ctrl.nextEncounter();
        assertEqual(ctrl.getSnapshot().activeTier, stop + 1, `Ramps to Tier ${stop + 1}`);
        while (ctrl.getSnapshot().view.phase !== PHASES.OVER) {
          const { view } = ctrl.getSnapshot();
          if (view.phase === PHASES.OFFER) {
            ctrl.commitOffer();
          } else {
            ctrl.drawSlot(view.legal.legalDrawSlots[0]);
          }
        }
      }

      ctrl.toggleDevTrace();
      const traceSnap = ctrl.getSnapshot().devTrace;
      assertEqual(ctrl.getSnapshot().devTraceOpen, true);
      assertEqual(traceSnap.tier, 3);
      assert(traceSnap.observations >= 3, "Recorded player draws across carriages");
      assert(
        traceSnap.bucketProbs.LEFT_EDGE > traceSnap.bucketProbs.CENTER,
        "Dev trace reflects learned left-edge preference"
      );
      assert(traceSnap.entries.length > 0, "Dev trace logs Inspector move explanations");

      // Starting a new run clears all learned habits back to zero.
      ctrl.startNewRun({ seed: "TRACE-FRESH-99" });
      const freshTrace = ctrl.getSnapshot().devTrace;
      assertEqual(freshTrace.tier, 1);
      assertEqual(freshTrace.observations, 0, "Learned observations wiped on new run");
      assert(Math.abs(freshTrace.bucketProbs.LEFT_EDGE - 0.2) < 1e-9, "Uniform buckets on new run");
      ctrl.dispose();
    },
  },

  {
    name: "Paired-seed tier ramp sanity: T1 < T2 < T3 < T4 < T5 against targeted fixed policies",
    run() {
      // Fast deterministic check (N = 240 paired duels/cell); full N = 1,200 report via `node tests/benchmark.js`.
      const report = runPairedBenchmark({
        runsPerPolicy: 60,
        duelsPerRun: 4,
        tiers: [1, 2, 3, 4, 5],
        seedPrefix: "SUITE-PAIRED",
      });

      const byId = new Map(report.rows.map((r) => [r.policyId, r.tierStats]));

      // T2 beats T1 decisively when reveals & arrival-avoidance matter.
      assert(
        byId.get("reveal-aware")[2].winRate > byId.get("reveal-aware")[1].winRate + 0.08,
        "Tier 2 significantly outperforms Tier 1 vs Reveal-Aware policy"
      );
      // T3 beats T2 decisively vs Left-Edge and Center policies.
      assert(
        byId.get("left-edge")[3].winRate > byId.get("left-edge")[2].winRate + 0.14,
        "Tier 3 significantly outperforms Tier 2 vs Left-Edge policy"
      );
      assert(
        byId.get("center")[3].winRate > byId.get("center")[2].winRate + 0.14,
        "Tier 3 significantly outperforms Tier 2 vs Center policy"
      );
      // T4 beats T3 vs Habitual Human and Left-Edge.
      assert(
        byId.get("habitual-human")[4].winRate > byId.get("habitual-human")[3].winRate + 0.03,
        "Tier 4 outperforms Tier 3 vs Habitual Player"
      );
      // T5 beats T4 decisively vs Alternating-Edge via transition tracking.
      assert(
        byId.get("alternating-edge")[5].winRate > byId.get("alternating-edge")[4].winRate + 0.08,
        "Tier 5 outperforms Tier 4 vs Alternating-Edge policy"
      );
      // Overall strictly increasing T1 < T2 < T3 < T4 < T5!
      for (let t = 1; t <= 4; t += 1) {
        assert(
          report.aggregate[t + 1].winRate > report.aggregate[t].winRate,
          `Overall win rate must rise from Tier ${t} (${report.aggregate[t].winRate}) to Tier ${t + 1} (${report.aggregate[t + 1].winRate})`
        );
      }
    },
  },
];

export function runPhase2Suite() {
  const results = [];
  let passed = 0;
  let failed = 0;

  for (const tc of PHASE2_TESTS) {
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
    total: PHASE2_TESTS.length,
    passed,
    failed,
    ok: failed === 0,
    results,
  };
}
