/**
 * src/data/aiTuning.js
 * Centralized tuning table for the Inspector's habit learner and AI Tiers 1–5.
 *
 * Edit values here to adjust adaptation speed, smoothing, exploration, or
 * per-tier difficulty without touching rules or UI code.
 */

export const BUCKETS = Object.freeze([
  "LEFT_EDGE",
  "LEFT_MID",
  "CENTER",
  "RIGHT_MID",
  "RIGHT_EDGE",
]);

export const BUCKET_LABELS = Object.freeze({
  LEFT_EDGE: "left edge",
  LEFT_MID: "inner left",
  CENTER: "center",
  RIGHT_MID: "inner right",
  RIGHT_EDGE: "right edge",
});

export const LEARNER_TUNING = Object.freeze({
  // Exponential decay applied to all bucket weights before each new unforced player draw.
  drawDecay: 0.8,
  // Dirichlet prior pseudo-count per bucket (keeps sparse early data near uniform 0.20).
  drawSmoothingAlpha: 0.55,

  // Faster short-window tracker blended in by Tier 5 to catch sudden habit shifts.
  fastDrawDecay: 0.62,
  fastDrawAlpha: 0.35,

  // 1st-order transition tracker (prevBucket -> nextBucket) for alternating patterns (Tier 5).
  transitionDecay: 0.82,
  transitionAlpha: 0.3,
  minTransitionWeight: 1.15,

  // Legal tracking of where the player hides The Unlisted (from Inspector's own draw outcomes).
  hideDecay: 0.86,
  hideSmoothingAlpha: 0.65,
  // Penalty applied to a bucket when the Inspector draws an ordinary card there while player held Unlisted.
  hideMissWeight: 0.3,
  hideHitWeight: 1.15,

  // Prior belief that a casual player leaves a freshly drawn Unlisted at the right edge.
  rightEdgeStayPriorAlpha: 1.2,
  rightEdgeMovePriorBeta: 1.2,
  rightEdgeDecay: 0.85,

  // Thresholds for honest dialogue/trace pattern detection (never triggers on noise).
  patternMinObservations: 4,
  patternMinProbability: 0.34,

  // Maximum developer trace entries retained in memory per session.
  maxTraceEntries: 80,
});

/**
 * Per-tier behavior profiles corresponding to the 5 stops in RULES.md Section 10.
 *
 * Tiers 1–3: MUST SHIP.
 * Tiers 4–5: SHOULD SHIP.
 */
export const AI_TIERS = Object.freeze({
  1: Object.freeze({
    tier: 1,
    name: "Novice Collector",
    stopLabel: "Stop 1 · Third-Class",
    summary: "Mostly uniform draws and occasional random swap bluffs; records habits without exploiting them.",
    usesReveals: false,
    usesParity: false,
    uniformUnlistedMix: false,
    randomOfferSwapProb: 0.3,
    avoidRepeatUnlistedSlot: false,
    exploitDrawLearning: false,
    offerSharpness: 0,
    smallHandSharpnessBoost: 0,
    streakSharpnessBoost: 0,
    fastRecencyBlend: 0,
    transitionBlend: 0,
    usesSwapForfeitDeduction: false,
    rightEdgeArrivalCaution: 0,
    exploitHideLearning: false,
    hideAvoidSharpness: 0,
    usesConditionTiming: false,
    usesPlausibleArrangements: false,
    plausibleSampleCap: 0,
    usesLookahead: false,
    explorationRate: 0.25,
  }),

  2: Object.freeze({
    tier: 2,
    name: "Carriage Examiner",
    stopLabel: "Stop 2 · Luggage Van",
    summary: "Always honors legal reveals, tracks hand-count parity, and conceals The Unlisted evenly across slots.",
    usesReveals: true,
    usesParity: true,
    uniformUnlistedMix: true,
    randomOfferSwapProb: 0.35,
    avoidRepeatUnlistedSlot: true,
    exploitDrawLearning: false,
    offerSharpness: 0,
    smallHandSharpnessBoost: 0,
    streakSharpnessBoost: 0,
    fastRecencyBlend: 0,
    transitionBlend: 0,
    usesSwapForfeitDeduction: true,
    rightEdgeArrivalCaution: 0.25,
    exploitHideLearning: false,
    hideAvoidSharpness: 0,
    usesConditionTiming: false,
    usesPlausibleArrangements: false,
    plausibleSampleCap: 0,
    usesLookahead: false,
    explorationRate: 0.14,
  }),

  3: Object.freeze({
    tier: 3,
    name: "Dining-Car Inspector",
    stopLabel: "Stop 3 · Dining Car",
    summary: "Adapts where he places The Unlisted to bait the player's learned draw positions.",
    usesReveals: true,
    usesParity: true,
    uniformUnlistedMix: true,
    randomOfferSwapProb: 0.4,
    avoidRepeatUnlistedSlot: true,
    exploitDrawLearning: true,
    offerSharpness: 1.35,
    smallHandSharpnessBoost: 0,
    streakSharpnessBoost: 0,
    fastRecencyBlend: 0,
    transitionBlend: 0,
    usesSwapForfeitDeduction: true,
    rightEdgeArrivalCaution: 0.35,
    exploitHideLearning: false,
    hideAvoidSharpness: 0,
    usesConditionTiming: false,
    usesPlausibleArrangements: false,
    plausibleSampleCap: 0,
    usesLookahead: false,
    explorationRate: 0.2,
  }),

  4: Object.freeze({
    tier: 4,
    name: "Sleeper Auditor",
    stopLabel: "Stop 4 · Sleeper Corridor",
    summary: "Sharpens baiting on small hands and Final Call setups, times condition clues, and avoids player hiding habits.",
    usesReveals: true,
    usesParity: true,
    uniformUnlistedMix: true,
    randomOfferSwapProb: 0.45,
    avoidRepeatUnlistedSlot: true,
    exploitDrawLearning: true,
    offerSharpness: 2.05,
    smallHandSharpnessBoost: 1.25,
    streakSharpnessBoost: 0.95,
    // Keep fastRecencyBlend at 0 on Tier 4: benchmarks showed un-transitioned recency lags alternating drawers by 1 turn.
    fastRecencyBlend: 0,
    transitionBlend: 0,
    usesSwapForfeitDeduction: true,
    rightEdgeArrivalCaution: 0.85,
    exploitHideLearning: true,
    hideAvoidSharpness: 2.4,
    usesConditionTiming: true,
    usesPlausibleArrangements: false,
    plausibleSampleCap: 0,
    usesLookahead: false,
    explorationRate: 0.12,
  }),

  5: Object.freeze({
    tier: 5,
    name: "Chief Manifest Inspector",
    stopLabel: "Stop 5 · Final Inspection",
    summary: "Scores plausible hidden hands, weighs next-turn and Final Call risk, and reacts fast to streaks and alternation while keeping small exploration.",
    usesReveals: true,
    usesParity: true,
    uniformUnlistedMix: true,
    randomOfferSwapProb: 0.5,
    avoidRepeatUnlistedSlot: false, // Willing to double-bluff the same slot if player keeps clicking it
    exploitDrawLearning: true,
    offerSharpness: 3.2,
    smallHandSharpnessBoost: 1.5,
    streakSharpnessBoost: 1.2,
    fastRecencyBlend: 0.45,
    transitionBlend: 0.78,
    usesSwapForfeitDeduction: true,
    rightEdgeArrivalCaution: 1.0,
    exploitHideLearning: true,
    hideAvoidSharpness: 3.2,
    usesConditionTiming: true,
    usesPlausibleArrangements: true,
    plausibleSampleCap: 24,
    usesLookahead: true,
    explorationRate: 0.08,
  }),
});

export const MIN_AI_TIER = 1;
export const MAX_AI_TIER = 5;

export function getTierConfig(tier = 1) {
  const clamped = Math.min(MAX_AI_TIER, Math.max(MIN_AI_TIER, Number.parseInt(tier, 10) || 1));
  return AI_TIERS[clamped];
}
