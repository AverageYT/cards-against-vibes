/**
 * src/ai/inspector.js
 * Strategic Inspector AI (Tiers 1–5) with positional learning and developer trace.
 *
 * Strict Information Boundary:
 * Consumes ONLY (observerView, aiRng, memory, tier). Never touches raw duel state,
 * hidden player ticket positions, deck order, or the shuffle RNG stream.
 */

import { ACTION_TYPES, PHASES, SIDES } from "../core/engine.js";
import { BUCKET_LABELS, BUCKETS, getTierConfig } from "../data/aiTuning.js";
import {
  createInspectorMemory,
  extractOfferPublicContext,
  slotToBucket,
  slotToNormalizedPos,
} from "./learner.js";

/**
 * Sample one candidate from positive weights using a single roll from aiRng.
 */
function sampleWeighted(candidates, aiRng, explorationRate = 0) {
  const n = candidates.length;
  if (n === 1) {
    const only = { ...candidates[0], prob: 1 };
    return { picked: only, roll: 0, scored: [only] };
  }

  let weightSum = 0;
  for (const c of candidates) {
    weightSum += Math.max(0, c.weight);
  }

  const eps = Math.min(1, Math.max(0, explorationRate));
  const uniform = 1 / n;
  const scored = candidates.map((c) => {
    const baseProb = weightSum > 0 ? Math.max(0, c.weight) / weightSum : uniform;
    const prob = (1 - eps) * baseProb + eps * uniform;
    return { ...c, prob };
  });

  // Normalize final probabilities cleanly.
  let probSum = 0;
  for (const s of scored) probSum += s.prob;
  for (const s of scored) s.prob = probSum > 0 ? s.prob / probSum : uniform;

  const roll = aiRng.next();
  let cumulative = 0;
  let picked = scored[scored.length - 1];
  for (const s of scored) {
    cumulative += s.prob;
    if (roll < cumulative) {
      picked = s;
      break;
    }
  }

  return { picked, roll, scored };
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function formatBucketProbs(probs) {
  const out = {};
  for (const b of BUCKETS) {
    out[b] = round3(probs[b]);
  }
  return out;
}

/**
 * Exact bounded dynamic-programming estimate of Inspector's duel win probability
 * from (remainingPairs, inspectorHoldsUnlisted, streak, threshold) given estimated
 * per-card bait boost. Used by Tier 5 to weigh immediate draw risk vs next-turn state.
 */
export function estimateContinuationWinProb({
  remainingPairs,
  inspectorHoldsUnlisted,
  streak,
  threshold,
  baitBoost = 1.0,
}) {
  if (remainingPairs <= 0) {
    return inspectorHoldsUnlisted ? 0 : 1;
  }

  const capPairs = Math.min(12, Math.max(0, remainingPairs));
  const capThresh = Math.min(4, Math.max(1, threshold));
  // States at start of an OFFER_PHASE where the holder of Unlisted offers (m + 1 cards)
  // vs where the non-holder of Unlisted offers (m ordinary cards, guaranteed pair).
  // Use iterative value iteration over m = 0..capPairs (handles Unlisted transfer cycle cleanly).
  // State key: (m, offererIsInspector: 0|1, holderIsInspector: 0|1, streak: 0..capThresh)
  const memo = new Map();
  const key = (m, offI, holdI, st) => `${m}:${offI}:${holdI}:${st}`;

  for (let m = 1; m <= capPairs; m += 1) {
    // When offerer does NOT hold Unlisted, draw is a guaranteed pair -> m - 1, streak = 0, roles flip.
    // Solve coupled states for fixed m via a few Bellman sweeps (converges in < 12 steps since Final Call breaks cycles!).
    for (const offI of [0, 1]) {
      for (const holdI of [0, 1]) {
        for (let st = 0; st <= capThresh; st += 1) {
          memo.set(key(m, offI, holdI, st), holdI ? 0.38 : 0.62);
        }
      }
    }

    const val = (mm, oI, hI, s) => {
      if (mm <= 0) return hI ? 0 : 1;
      return memo.get(key(mm, oI, hI, Math.min(capThresh, s)));
    };

    for (let iter = 0; iter < 16; iter += 1) {
      for (const offI of [0, 1]) {
        for (const holdI of [0, 1]) {
          for (let st = 0; st <= capThresh; st += 1) {
            let v;
            if (offI !== holdI) {
              // Offerer holds only m ordinary tickets -> guaranteed pair, streak resets to 0.
              v = val(m - 1, 1 - offI, holdI, 0);
            } else if (st >= capThresh) {
              // Final Call pins offerer's Unlisted -> forced pair, offerer keeps Unlisted, streak resets to 0.
              v = val(m - 1, 1 - offI, holdI, 0);
            } else {
              // Offerer holds m ordinary tickets + 1 Unlisted (fanSize = m + 1).
              const fanSize = m + 1;
              let pDrawUnlisted = 1 / fanSize;
              if (offI === 1) {
                // Inspector offering: learned bait boost raises player's chance of picking Unlisted.
                pDrawUnlisted = Math.min(0.88, pDrawUnlisted * baitBoost);
              }
              const vTransfer = val(m, 1 - offI, 1 - holdI, st + 1);
              const vPair = val(m - 1, 1 - offI, holdI, 0);
              v = pDrawUnlisted * vTransfer + (1 - pDrawUnlisted) * vPair;
            }
            memo.set(key(m, offI, holdI, st), v);
          }
        }
      }
    }
  }

  // Called right after a hypothetical draw resolves -> incoming offerer is the drawer (Inspector = 1).
  return memo.get(
    key(
      capPairs,
      1,
      inspectorHoldsUnlisted ? 1 : 0,
      Math.min(capThresh, Math.max(0, streak))
    )
  );
}

/**
 * Evaluate plausible hidden player arrangements consistent with all public clues
 * (Tier 5). Returns posterior P(slot holds Unlisted) across opponent slots plus
 * count of plausible configurations considered.
 */
function evaluatePlausibleArrangements(view, memory, offerCtx, sampleCap = 24) {
  const n = view.opponentHandCount;
  const slotRisks = new Array(n).fill(0);
  if (!view.opponentHoldsUnlisted || n === 0) {
    return { slotRisks, arrangementCount: 1, basis: "opponent-lacks-unlisted" };
  }

  const reveals = memory.getValidReveals(view.offerId);
  const revealBySlot = new Map(reveals.map((r) => [r.slotIndex, r]));

  // If Unlisted is directly revealed in a slot, only arrangements with Unlisted there are valid.
  for (const r of reveals) {
    if (r.isUnlisted && r.slotIndex >= 0 && r.slotIndex < n) {
      slotRisks[r.slotIndex] = 1;
      return { slotRisks, arrangementCount: 1, basis: "revealed-unlisted" };
    }
  }

  // If opponent just drew Unlisted and forfeited their swap, Unlisted MUST remain at rightmost slot.
  const rightIdx = n - 1;
  if (offerCtx.opponentJustDrewUnlisted && offerCtx.opponentSwapForfeited) {
    if (!revealBySlot.has(rightIdx) || revealBySlot.get(rightIdx).isUnlisted) {
      slotRisks[rightIdx] = 1;
      return { slotRisks, arrangementCount: 1, basis: "forfeited-swap-right-edge" };
    }
  }

  // Identify all slots legally capable of holding UNLISTED-0:
  // - Cannot be a slot revealed as an ordinary ticket.
  // - Cannot be a slot locked by BRASS_WEIGHT (which can only lock ordinary tickets, RULES.md #8.6).
  const candidateUnlistedSlots = [];
  for (let s = 0; s < n; s += 1) {
    const slotInfo = view.opponentSlots[s];
    const rev = revealBySlot.get(s);
    if (rev && !rev.isUnlisted) continue;
    if (slotInfo && slotInfo.locked && slotInfo.lockReason === "BRASS_WEIGHT") continue;
    candidateUnlistedSlots.push(s);
  }

  if (candidateUnlistedSlots.length === 0) {
    const fallback = 1 / n;
    return {
      slotRisks: new Array(n).fill(fallback),
      arrangementCount: n,
      basis: "uniform-fallback",
    };
  }

  const hideProbs = memory.getHideBucketProbs();
  const bucketCounts = {};
  for (const s of candidateUnlistedSlots) {
    const b = slotToBucket(s, n);
    bucketCounts[b] = (bucketCounts[b] || 0) + 1;
  }

  // Enumerate plausible hypothesis configurations (no-swap hold, bluff swap, targeted swap to each slot),
  // capped cleanly at sampleCap.
  const hypotheses = [];
  const pStay = memory.getRightEdgeStayProb();

  if (offerCtx.opponentJustDrewUnlisted && candidateUnlistedSlots.includes(rightIdx)) {
    // Hypothesis family A: Unlisted stayed at arrival slot N - 1 (player held pat or bluff-swapped two ordinary cards).
    hypotheses.push({
      unlistedSlot: rightIdx,
      likelihood: pStay * (0.75 + hideProbs[slotToBucket(rightIdx, n)]),
      kind: "arrival-stay",
    });

    // Hypothesis family B: Player executed their single swap to move Unlisted from N - 1 into slot s != N - 1.
    const others = candidateUnlistedSlots.filter((s) => s !== rightIdx);
    if (others.length > 0) {
      let moveNorm = 0;
      const rawMoves = others.map((s) => {
        const b = slotToBucket(s, n);
        const w = hideProbs[b] / (bucketCounts[b] || 1);
        moveNorm += w;
        return { s, w };
      });
      for (const m of rawMoves) {
        if (hypotheses.length >= sampleCap) break;
        const share = moveNorm > 0 ? m.w / moveNorm : 1 / others.length;
        hypotheses.push({
          unlistedSlot: m.s,
          likelihood: (1 - pStay) * share,
          kind: "single-swap-move",
        });
      }
    }
  } else {
    // Continuing holder: evaluate arrangements placing Unlisted at each feasible hidden slot
    // weighted by learned player hiding buckets (plus ordinary-pair symmetry factor, capped at sampleCap).
    for (const s of candidateUnlistedSlots) {
      if (hypotheses.length >= sampleCap) break;
      const b = slotToBucket(s, n);
      const bucketDensity = hideProbs[b] / (bucketCounts[b] || 1);
      // Blend uniform prior with learned hiding preference so sparse data stays balanced.
      const obsWeight = Math.min(0.75, memory.snapshot().hideObservations / 8);
      const likelihood = (1 - obsWeight) * (1 / candidateUnlistedSlots.length) + obsWeight * bucketDensity;
      hypotheses.push({
        unlistedSlot: s,
        likelihood,
        kind: "hidden-placement",
      });
    }
  }

  let totalL = 0;
  for (const h of hypotheses) totalL += Math.max(0, h.likelihood);
  for (const h of hypotheses) {
    const p = totalL > 0 ? Math.max(0, h.likelihood) / totalL : 1 / hypotheses.length;
    slotRisks[h.unlistedSlot] += p;
  }

  return {
    slotRisks,
    arrangementCount: hypotheses.length,
    basis: offerCtx.opponentJustDrewUnlisted ? "arrival+swap-hypotheses" : "continuing-holder-hypotheses",
  };
}

/**
 * Check if an active carriage condition or marker will publicly expose a slot on commit.
 */
function getPredictedExposedSlots(view) {
  const exposed = new Set();
  const cond = view.condition;
  if (cond && !cond.expired && cond.id === "DRAFTY_WINDOW" && view.myHandCount >= 3) {
    exposed.add(0);
  }
  for (const slot of view.myHand) {
    if (slot.publiclyRevealed) {
      exposed.add(slot.slotIndex);
    }
  }
  return exposed;
}

function opponentHuntsEmblems(view) {
  if (!Array.isArray(view.opponentStamps)) return false;
  return view.opponentStamps.some(
    (s) => (s.id === "CARBON_COPY" || s.id === "BELL_CORD") && !s.spent
  );
}

/**
 * Decide an OFFER_PHASE action for the Inspector.
 */
function decideOfferAction(view, aiRng, memory, cfg) {
  const actor = view.viewerSide;
  const seq = view.legal.nextSeq;
  const n = view.myHandCount;
  const swapSlots = view.legal.legalSwapSlots;
  const unlistedEntry = view.myHand.find((s) => s.ticket.isUnlisted) || null;
  const unlistedSlot = unlistedEntry ? unlistedEntry.slotIndex : null;
  const pending = memory.getPendingOfferSwapTarget();

  const drawProbs = memory.getDrawBucketProbs({
    fastBlend: cfg.fastRecencyBlend,
    transitionBlend: cfg.transitionBlend,
  });
  const pattern = memory.getDetectedPattern();

  const baseFacts = {
    myHandCount: n,
    opponentHandCount: view.opponentHandCount,
    iHoldUnlisted: view.iHoldUnlisted,
    unlistedStreak: view.unlistedStreak,
    finalCallActive: Boolean(view.finalCall && view.finalCall.active),
    conditionId: view.condition && !view.condition.expired ? view.condition.id : null,
    playerDrawObservations: pattern.observations,
    drawBucketProbs: formatBucketProbs(drawProbs),
    detectedPattern: pattern.detected
      ? `${pattern.label} (${Math.round(pattern.probability * 100)}%)`
      : "none yet",
  };

  const commitWithReason = (reason, candidates = [], roll = null) => {
    memory.setPendingOfferSwapTarget(null);
    if (unlistedSlot !== null) {
      memory.setLastOfferedUnlisted(unlistedSlot, n);
    }
    const action = { type: ACTION_TYPES.COMMIT_OFFER, actor, seq };
    const trace = {
      tier: cfg.tier,
      tierName: cfg.name,
      turnNumber: view.turnNumber,
      offerId: view.offerId,
      phase: view.phase,
      role: "OFFERER",
      actionType: action.type,
      reason,
      rngRoll: roll === null ? null : round3(roll),
      observedFacts: baseFacts,
      candidates,
    };
    return { action, trace };
  };

  // Already completed planned swap, or no swap permitted/possible -> commit immediately.
  if (
    !view.legal.canSwap ||
    swapSlots.length < 2 ||
    (pending && pending.offerId === view.offerId)
  ) {
    const why =
      pending && pending.offerId === view.offerId
        ? "Committed fan after executing private swap."
        : n < 2
          ? "Single ticket in hand — committed offer."
          : view.finalCall?.active
            ? "Final Call active — committed fan."
            : "No swap remaining — committed offer.";
    return commitWithReason(why);
  }

  // Case 1: Inspector does NOT hold Unlisted (or Unlisted is pinned under Final Call).
  if (!view.iHoldUnlisted || unlistedSlot === null || !swapSlots.includes(unlistedSlot)) {
    // Tier 4–5: if player owns an Emblem-pair Stamp, move Emblem cards out of player's top bucket.
    if (cfg.usesConditionTiming && opponentHuntsEmblems(view)) {
      const emblemSlots = swapSlots.filter((idx) => view.myHand[idx]?.ticket.isEmblem);
      const plainSlots = swapSlots.filter((idx) => !view.myHand[idx]?.ticket.isEmblem);
      if (emblemSlots.length > 0 && plainSlots.length > 0) {
        let riskiestEmblem = emblemSlots[0];
        let highestHit = -1;
        for (const s of emblemSlots) {
          const p = drawProbs[slotToBucket(s, n)];
          if (p > highestHit) {
            highestHit = p;
            riskiestEmblem = s;
          }
        }
        let safestPlain = plainSlots[0];
        let lowestHit = Infinity;
        for (const s of plainSlots) {
          const p = drawProbs[slotToBucket(s, n)];
          if (p < lowestHit) {
            lowestHit = p;
            safestPlain = s;
          }
        }
        if (highestHit > lowestHit + 0.05) {
          memory.setPendingOfferSwapTarget({ offerId: view.offerId, done: true });
          const action = {
            type: ACTION_TYPES.SWAP,
            actor,
            indexA: riskiestEmblem,
            indexB: safestPlain,
            seq,
          };
          return {
            action,
            trace: {
              tier: cfg.tier,
              tierName: cfg.name,
              turnNumber: view.turnNumber,
              offerId: view.offerId,
              phase: view.phase,
              role: "OFFERER",
              actionType: action.type,
              reason: "Shifted Emblem ticket away from player's favored draw zone to slow Stamp synergy.",
              rngRoll: null,
              observedFacts: baseFacts,
              candidates: [],
            },
          };
        }
      }
    }

    // Occasional light bluff shuffle among ordinary cards.
    const roll = aiRng.next();
    if (roll < cfg.randomOfferSwapProb * 0.5) {
      const firstPos = aiRng.nextInt(swapSlots.length);
      let secondPos = aiRng.nextInt(swapSlots.length - 1);
      if (secondPos >= firstPos) secondPos += 1;
      const indexA = swapSlots[firstPos];
      const indexB = swapSlots[secondPos];
      memory.setPendingOfferSwapTarget({ offerId: view.offerId, done: true });
      return {
        action: { type: ACTION_TYPES.SWAP, actor, indexA, indexB, seq },
        trace: {
          tier: cfg.tier,
          tierName: cfg.name,
          turnNumber: view.turnNumber,
          offerId: view.offerId,
          phase: view.phase,
          role: "OFFERER",
          actionType: ACTION_TYPES.SWAP,
          reason: cfg.usesParity
            ? "Hand parity shows all own tickets are ordinary; performed light table shuffle."
            : "Occasional random rearrangement before offering.",
          rngRoll: round3(roll),
          observedFacts: baseFacts,
          candidates: [],
        },
      };
    }

    return commitWithReason(
      cfg.usesParity
        ? "All own tickets are ordinary pairs — committed fan cleanly."
        : "Held fan order and committed.",
      [],
      roll
    );
  }

  // Case 2: Tier 1 offering with Unlisted — occasional uniform bluff swap; does not exploit habits.
  if (!cfg.uniformUnlistedMix && !cfg.exploitDrawLearning) {
    const roll = aiRng.next();
    if (roll < cfg.randomOfferSwapProb) {
      const firstPos = aiRng.nextInt(swapSlots.length);
      let secondPos = aiRng.nextInt(swapSlots.length - 1);
      if (secondPos >= firstPos) secondPos += 1;
      const indexA = swapSlots[firstPos];
      const indexB = swapSlots[secondPos];
      memory.setPendingOfferSwapTarget({ offerId: view.offerId, done: true });
      return {
        action: { type: ACTION_TYPES.SWAP, actor, indexA, indexB, seq },
        trace: {
          tier: cfg.tier,
          tierName: cfg.name,
          turnNumber: view.turnNumber,
          offerId: view.offerId,
          phase: view.phase,
          role: "OFFERER",
          actionType: ACTION_TYPES.SWAP,
          reason: "Tier 1 occasional random bluff swap (habits logged but not exploited).",
          rngRoll: round3(roll),
          observedFacts: baseFacts,
          candidates: [],
        },
      };
    }
    return commitWithReason(
      "Tier 1 offered fan without moving tickets (habits logged only).",
      [],
      roll
    );
  }

  // Case 3: Tiers 2–5 strategic target-slot selection for The Unlisted.
  const bucketCounts = {};
  for (const s of swapSlots) {
    const b = slotToBucket(s, n);
    bucketCounts[b] = (bucketCounts[b] || 0) + 1;
  }

  const lastOffered = memory.getLastOfferedUnlisted();
  const exposedSlots = cfg.usesConditionTiming ? getPredictedExposedSlots(view) : new Set();

  let sharpness = cfg.offerSharpness;
  if (cfg.exploitDrawLearning) {
    if (n <= 4) sharpness += cfg.smallHandSharpnessBoost;
    if (view.unlistedStreak === view.finalCallThreshold - 1) {
      sharpness += cfg.streakSharpnessBoost;
    }
  }

  const slotCandidates = swapSlots.map((s) => {
    const bucket = slotToBucket(s, n);
    const u = slotToNormalizedPos(s, n);
    let weight = 1;
    const notes = [bucket];

    if (cfg.exploitDrawLearning) {
      const perSlotHit = drawProbs[bucket] / (bucketCounts[bucket] || 1);
      // Slight within-bucket preference toward true outer edges when an edge bucket is favored,
      // and toward exact u = 0.5 when CENTER is favored.
      let withinBucketFactor = 1;
      if (bucket === "LEFT_EDGE" && bucketCounts[bucket] > 1) {
        withinBucketFactor = 1.15 - u;
      } else if (bucket === "RIGHT_EDGE" && bucketCounts[bucket] > 1) {
        withinBucketFactor = 0.15 + u;
      } else if (bucket === "CENTER" && bucketCounts[bucket] > 1) {
        withinBucketFactor = 1.15 - Math.abs(u - 0.5);
      }
      weight = Math.pow(Math.max(0.005, perSlotHit * withinBucketFactor), sharpness);
    }

    if (cfg.avoidRepeatUnlistedSlot && lastOffered.slotIndex === s && swapSlots.length >= 2) {
      const penalty = cfg.exploitDrawLearning ? 0.76 : 0.5;
      weight *= penalty;
      notes.push("varied-from-prev");
    }

    if (exposedSlots.has(s) && swapSlots.length >= 2) {
      weight *= 0.04;
      notes.push("avoid-exposed-slot");
    }

    return {
      targetSlot: s,
      bucket,
      weight,
      note: notes.join(", "),
    };
  });

  const { picked, roll, scored } = sampleWeighted(
    slotCandidates,
    aiRng,
    cfg.exploitDrawLearning ? cfg.explorationRate : 0
  );

  // Build non-leaking trace candidate summary (lists bucket weights, never leaks live secret slot to normal UI).
  const candidateSummary = scored.map((c) => ({
    slot: c.targetSlot + 1,
    bucket: c.bucket,
    prob: round3(c.prob),
    note: c.note,
  }));

  if (cfg.usesLookahead) {
    const livePairs = view.opponentHandCount; // Inspector holds Unlisted -> opponent holds m cards
    const peakBoost = Math.max(1, pattern.probability * 5 * 0.75);
    baseFacts.lookaheadWinIfBaited = round3(
      estimateContinuationWinProb({
        remainingPairs: livePairs,
        inspectorHoldsUnlisted: false,
        streak: view.unlistedStreak + 1,
        threshold: view.finalCallThreshold,
        baitBoost: peakBoost,
      })
    );
    baseFacts.lookaheadWinIfPaired = round3(
      estimateContinuationWinProb({
        remainingPairs: livePairs - 1,
        inspectorHoldsUnlisted: true,
        streak: 0,
        threshold: view.finalCallThreshold,
        baitBoost: peakBoost,
      })
    );
  }

  const chosenBucketLabel = BUCKET_LABELS[picked.bucket];
  const baseReason = cfg.exploitDrawLearning
    ? `Targeted ${chosenBucketLabel} (${picked.bucket}) from smoothed player draw profile (obs=${pattern.observations}, sharpness=${round3(sharpness)}).`
    : "Concealed The Unlisted evenly across legal fan positions and avoided static repeats.";

  if (picked.targetSlot === unlistedSlot) {
    return commitWithReason(
      `${baseReason} Desired position already matched; committed without moving.`,
      candidateSummary,
      roll
    );
  }

  memory.setPendingOfferSwapTarget({
    offerId: view.offerId,
    targetSlot: picked.targetSlot,
  });

  return {
    action: {
      type: ACTION_TYPES.SWAP,
      actor,
      indexA: unlistedSlot,
      indexB: picked.targetSlot,
      seq,
    },
    trace: {
      tier: cfg.tier,
      tierName: cfg.name,
      turnNumber: view.turnNumber,
      offerId: view.offerId,
      phase: view.phase,
      role: "OFFERER",
      actionType: ACTION_TYPES.SWAP,
      reason: `${baseReason} Repositioned via private swap.`,
      targetBucket: picked.bucket,
      rngRoll: round3(roll),
      observedFacts: baseFacts,
      candidates: candidateSummary,
    },
  };
}

/**
 * Decide a DRAW_PHASE action for the Inspector.
 */
function decideDrawAction(view, aiRng, memory, cfg) {
  const actor = view.viewerSide;
  const seq = view.legal.nextSeq;
  const legalSlots = view.legal.legalDrawSlots;
  const oppCount = view.opponentHandCount;

  const validReveals = memory.getValidReveals(view.offerId);
  const offerCtx = extractOfferPublicContext(
    view.publicHistory,
    view.publicHistory.length,
    view.opponentSide
  );
  // Combine history-derived parity with direct visible count parity.
  const effectiveCtx = {
    ...offerCtx,
    opponentHeldUnlisted: view.opponentHoldsUnlisted,
  };

  const hideProbs = memory.getHideBucketProbs();
  const observedFacts = {
    myHandCount: view.myHandCount,
    opponentHandCount: oppCount,
    legalSlotCount: legalSlots.length,
    opponentHoldsUnlisted: view.opponentHoldsUnlisted,
    opponentJustDrewUnlisted: effectiveCtx.opponentJustDrewUnlisted,
    opponentSwapForfeited: effectiveCtx.opponentSwapForfeited,
    unlistedStreak: view.unlistedStreak,
    finalCallActive: Boolean(view.finalCall && view.finalCall.active),
    validReveals: validReveals.map((r) => ({
      slot: r.slotIndex + 1,
      symbolId: r.symbolId,
      isUnlisted: r.isUnlisted,
      source: r.source,
    })),
  };

  // Forced single-slot draw (e.g., 2-card fan under Final Call or 1-card ordinary offer).
  if (legalSlots.length === 1) {
    const onlySlot = legalSlots[0];
    return {
      action: { type: ACTION_TYPES.DRAW, actor, slotIndex: onlySlot, seq },
      trace: {
        tier: cfg.tier,
        tierName: cfg.name,
        turnNumber: view.turnNumber,
        offerId: view.offerId,
        phase: view.phase,
        role: "DRAWER",
        actionType: ACTION_TYPES.DRAW,
        chosenSlot: onlySlot + 1,
        reason: view.finalCall?.active
          ? `Final Call locked slot #${view.finalCall.slotIndex + 1}; drew only open slot #${onlySlot + 1} for forced pair.`
          : `Drew sole legal slot #${onlySlot + 1}.`,
        rngRoll: null,
        observedFacts,
        candidates: [{ slot: onlySlot + 1, prob: 1, note: "forced" }],
      },
    };
  }

  // Tier 1: uniform random over legal draw slots.
  if (cfg.tier === 1) {
    const unif = legalSlots.map((s) => ({ slotIndex: s, weight: 1, note: "uniform" }));
    const { picked, roll, scored } = sampleWeighted(unif, aiRng, 0);
    return {
      action: { type: ACTION_TYPES.DRAW, actor, slotIndex: picked.slotIndex, seq },
      trace: {
        tier: cfg.tier,
        tierName: cfg.name,
        turnNumber: view.turnNumber,
        offerId: view.offerId,
        phase: view.phase,
        role: "DRAWER",
        actionType: ACTION_TYPES.DRAW,
        chosenSlot: picked.slotIndex + 1,
        reason: `Tier 1 uniform legal draw -> slot #${picked.slotIndex + 1}.`,
        rngRoll: round3(roll),
        observedFacts,
        candidates: scored.map((c) => ({ slot: c.slotIndex + 1, prob: round3(c.prob), note: c.note })),
      },
    };
  }

  // Tiers 2–5: Honor valid offer-scoped reveals immediately.
  if (cfg.usesReveals && validReveals.length > 0) {
    const legalSet = new Set(legalSlots);
    const revealedSafe = validReveals.filter((r) => !r.isUnlisted && legalSet.has(r.slotIndex));
    if (revealedSafe.length > 0) {
      const cands = revealedSafe.map((r) => ({
        slotIndex: r.slotIndex,
        // Tier 4–5 slightly prefer clearing an Emblem pair on the Inspector's own turn so player can't claim it.
        weight: cfg.usesConditionTiming && r.isEmblem ? 1.4 : 1,
        note: `revealed-pair:${r.symbolId}`,
      }));
      const { picked, roll, scored } = sampleWeighted(cands, aiRng, 0);
      return {
        action: { type: ACTION_TYPES.DRAW, actor, slotIndex: picked.slotIndex, seq },
        trace: {
          tier: cfg.tier,
          tierName: cfg.name,
          turnNumber: view.turnNumber,
          offerId: view.offerId,
          phase: view.phase,
          role: "DRAWER",
          actionType: ACTION_TYPES.DRAW,
          chosenSlot: picked.slotIndex + 1,
          reason: `Drew known revealed ticket at slot #${picked.slotIndex + 1} for guaranteed pair.`,
          rngRoll: scored.length > 1 ? round3(roll) : null,
          observedFacts,
          candidates: scored.map((c) => ({
            slot: c.slotIndex + 1,
            prob: round3(c.prob),
            note: c.note,
          })),
        },
      };
    }
  }

  // Filter out any slot legally revealed to hold The Unlisted (when alternatives exist).
  const revealedUnlistedSlots = new Set(
    cfg.usesReveals
      ? validReveals.filter((r) => r.isUnlisted).map((r) => r.slotIndex)
      : []
  );
  let pool = legalSlots.filter((s) => !revealedUnlistedSlots.has(s));
  const avoidedRevealedUnlisted = pool.length > 0 && pool.length < legalSlots.length;
  if (pool.length === 0) {
    pool = legalSlots.slice();
  }

  // Hand-count parity: if Inspector holds Unlisted, all opponent tickets are safe pairs!
  if (cfg.usesParity && !view.opponentHoldsUnlisted) {
    const cands = pool.map((s) => ({ slotIndex: s, weight: 1, note: "parity-all-safe" }));
    const { picked, roll, scored } = sampleWeighted(cands, aiRng, 0);
    return {
      action: { type: ACTION_TYPES.DRAW, actor, slotIndex: picked.slotIndex, seq },
      trace: {
        tier: cfg.tier,
        tierName: cfg.name,
        turnNumber: view.turnNumber,
        offerId: view.offerId,
        phase: view.phase,
        role: "DRAWER",
        actionType: ACTION_TYPES.DRAW,
        chosenSlot: picked.slotIndex + 1,
        reason: `Hand parity (${view.myHandCount} vs ${oppCount}): all player slots are safe pairs; picked slot #${picked.slotIndex + 1}.`,
        rngRoll: round3(roll),
        observedFacts,
        candidates: scored.map((c) => ({ slot: c.slotIndex + 1, prob: round3(c.prob), note: c.note })),
      },
    };
  }

  // Exact forfeited-swap arrival deduction (Decision D4):
  const rightIdx = oppCount - 1;
  if (
    cfg.usesSwapForfeitDeduction &&
    effectiveCtx.opponentJustDrewUnlisted &&
    effectiveCtx.opponentSwapForfeited &&
    pool.includes(rightIdx) &&
    pool.length > 1
  ) {
    const safePool = pool.filter((s) => s !== rightIdx);
    const cands = safePool.map((s) => ({
      slotIndex: s,
      weight: 1,
      note: "avoided-forfeited-arrival",
    }));
    const { picked, roll, scored } = sampleWeighted(cands, aiRng, 0);
    return {
      action: { type: ACTION_TYPES.DRAW, actor, slotIndex: picked.slotIndex, seq },
      trace: {
        tier: cfg.tier,
        tierName: cfg.name,
        turnNumber: view.turnNumber,
        offerId: view.offerId,
        phase: view.phase,
        role: "DRAWER",
        actionType: ACTION_TYPES.DRAW,
        chosenSlot: picked.slotIndex + 1,
        reason: `Player drew Unlisted last turn and forfeited swap — avoided slot #${rightIdx + 1}, drew safe slot #${picked.slotIndex + 1}.`,
        rngRoll: scored.length > 1 ? round3(roll) : null,
        observedFacts,
        candidates: scored.map((c) => ({ slot: c.slotIndex + 1, prob: round3(c.prob), note: c.note })),
      },
    };
  }

  // Estimate per-slot risk P(slot holds Unlisted) across remaining pool.
  let slotRisks = new Array(oppCount).fill(1 / pool.length);
  let reasonDetail = avoidedRevealedUnlisted
    ? "Avoided revealed Unlisted slot."
    : `Hand parity (${view.myHandCount} vs ${oppCount}) indicates player holds The Unlisted.`;

  if (cfg.usesPlausibleArrangements) {
    const evalRes = evaluatePlausibleArrangements(
      view,
      memory,
      effectiveCtx,
      cfg.plausibleSampleCap
    );
    slotRisks = evalRes.slotRisks;
    observedFacts.plausibleArrangements = evalRes.arrangementCount;
    observedFacts.arrangementBasis = evalRes.basis;
    observedFacts.rightEdgeStayEstimate = round3(memory.getRightEdgeStayProb());
    observedFacts.hideBucketProbs = formatBucketProbs(hideProbs);
    reasonDetail = `Scored ${evalRes.arrangementCount} plausible hidden hands (${evalRes.basis})`;
  } else {
    // Tiers 2–4 heuristic risk scoring from legal arrival & hiding observations.
    const rawRisk = new Map();
    const stayProb = memory.getRightEdgeStayProb();
    for (const s of pool) {
      let r = 1;
      if (effectiveCtx.opponentJustDrewUnlisted && cfg.rightEdgeArrivalCaution > 0) {
        if (s === rightIdx) {
          // If player leaves Unlisted at right edge often, raise risk; if they actively move it away, lower risk.
          const staySignal = cfg.exploitHideLearning ? stayProb : 0.6;
          r *= Math.max(0.2, 1 + cfg.rightEdgeArrivalCaution * (staySignal - 0.3) * 3.2);
        }
      }
      if (cfg.exploitHideLearning) {
        const b = slotToBucket(s, oppCount);
        r *= 0.5 + hideProbs[b] * 2.5;
      }
      rawRisk.set(s, Math.max(0.02, r));
    }
    let rSum = 0;
    for (const v of rawRisk.values()) rSum += v;
    slotRisks = new Array(oppCount).fill(0);
    for (const [s, v] of rawRisk.entries()) {
      slotRisks[s] = rSum > 0 ? v / rSum : 1 / pool.length;
    }
    if (cfg.exploitHideLearning) {
      observedFacts.hideBucketProbs = formatBucketProbs(hideProbs);
      reasonDetail =
        oppCount <= 4
          ? "Small-hand risk filter using arrival cue and observed player hiding habits."
          : "Weighted slots against observed player hiding habits and arrival position.";
    } else if (effectiveCtx.opponentJustDrewUnlisted && cfg.rightEdgeArrivalCaution > 0) {
      reasonDetail = "Applied right-edge arrival caution after player drew The Unlisted.";
    }
  }

  // Tier 5: combine slot risk with exact 1-step lookahead win value (including Final Call impact).
  let vSafe = 1;
  let vUnlisted = 0;
  if (cfg.usesLookahead) {
    const livePairs = view.myHandCount; // Player holds Unlisted -> Inspector holds m cards
    const pat = memory.getDetectedPattern();
    const baitBoost = Math.max(1, pat.probability * 5 * 0.75);
    vSafe = estimateContinuationWinProb({
      remainingPairs: livePairs - 1,
      inspectorHoldsUnlisted: false,
      streak: 0,
      threshold: view.finalCallThreshold,
      baitBoost,
    });
    vUnlisted = estimateContinuationWinProb({
      remainingPairs: livePairs,
      inspectorHoldsUnlisted: true,
      streak: view.unlistedStreak + 1,
      threshold: view.finalCallThreshold,
      baitBoost,
    });
    observedFacts.lookaheadWinIfSafePair = round3(vSafe);
    observedFacts.lookaheadWinIfDrawUnlisted = round3(vUnlisted);
    reasonDetail += ` with next-turn EV (pair=${round3(vSafe)}, unlisted=${round3(vUnlisted)}).`;
  }

  const sharpness =
    cfg.hideAvoidSharpness > 0
      ? cfg.hideAvoidSharpness + (oppCount <= 4 ? 0.8 : 0)
      : 1.5;

  const drawCandidates = pool.map((s) => {
    const risk = Math.min(0.995, Math.max(0.0, slotRisks[s] ?? 1 / pool.length));
    const safety = Math.max(0.005, 1 - risk);
    const ev = safety * vSafe + risk * vUnlisted;
    const weight = Math.pow(safety, sharpness) * (0.5 + ev);
    const notes = [`risk=${round3(risk)}`];
    if (cfg.usesLookahead) notes.push(`ev=${round3(ev)}`);
    return {
      slotIndex: s,
      risk,
      ev,
      weight,
      note: notes.join(" "),
    };
  });

  // Only allow exploration over non-revealed-Unlisted slots so Tier 2–5 never knowingly draw a revealed Unlisted.
  const { picked, roll, scored } = sampleWeighted(drawCandidates, aiRng, cfg.explorationRate);

  return {
    action: { type: ACTION_TYPES.DRAW, actor, slotIndex: picked.slotIndex, seq },
    trace: {
      tier: cfg.tier,
      tierName: cfg.name,
      turnNumber: view.turnNumber,
      offerId: view.offerId,
      phase: view.phase,
      role: "DRAWER",
      actionType: ACTION_TYPES.DRAW,
      chosenSlot: picked.slotIndex + 1,
      reason: `${reasonDetail} Chose slot #${picked.slotIndex + 1}.`,
      rngRoll: round3(roll),
      observedFacts,
      candidates: scored.map((c) => ({
        slot: c.slotIndex + 1,
        prob: round3(c.prob),
        note: c.note,
      })),
    },
  };
}

/**
 * Stateless/explicit decision entry point: given a legal ObserverView, an
 * isolated aiRng, an InspectorMemory, and a tier (1..5), choose one legal
 * action and produce its developer-only trace.
 */
export function chooseInspectorAction(view, aiRng, memory, tier = 1) {
  if (!view || !view.legal || !view.legal.isMyTurn || view.phase === PHASES.OVER) {
    return { action: null, trace: null };
  }

  const mem = memory || createInspectorMemory();
  mem.syncFromView(view);
  const cfg = getTierConfig(tier);

  let result;
  if (view.phase === PHASES.OFFER) {
    result = decideOfferAction(view, aiRng, mem, cfg);
  } else if (view.phase === PHASES.DRAW) {
    result = decideDrawAction(view, aiRng, mem, cfg);
  } else {
    return { action: null, trace: null };
  }

  if (result.trace) {
    mem.recordTrace(result.trace);
  }
  return result;
}

/**
 * Create a stateful Inspector agent managing tier and run-level learning memory.
 */
export function createInspectorAgent({ tier = 1, memory = null, tuning = {} } = {}) {
  let currentTier = getTierConfig(tier).tier;
  const mem = memory || createInspectorMemory(tuning);

  function decide(view, aiRng) {
    return chooseInspectorAction(view, aiRng, mem, currentTier);
  }

  function act(view, aiRng) {
    return decide(view, aiRng).action;
  }

  function observe(view) {
    mem.syncFromView(view);
  }

  function setTier(nextTier) {
    currentTier = getTierConfig(nextTier).tier;
    return currentTier;
  }

  function getTier() {
    return currentTier;
  }

  function getTierInfo() {
    return getTierConfig(currentTier);
  }

  function getMemory() {
    return mem;
  }

  function getTraceLog() {
    return mem.getTraceLog();
  }

  function resetForNewDuel() {
    mem.resetForNewDuel();
  }

  function resetForNewRun() {
    mem.resetForNewRun();
  }

  return Object.freeze({
    decide,
    act,
    observe,
    setTier,
    getTier,
    getTierInfo,
    getMemory,
    getTraceLog,
    resetForNewDuel,
    resetForNewRun,
  });
}
