/**
 * src/data/conditions.js
 * Canonical Carriage Condition definitions (3 MUST SHIP + 1 SHOULD SHIP)
 * and live status/expiration formatters.
 */

export const CONDITION_IDS = Object.freeze({
  CLEAR_LINE: "CLEAR_LINE",
  SEALED_MANIFEST: "SEALED_MANIFEST",
  DRAFTY_WINDOW: "DRAFTY_WINDOW",
  LATE_SCHEDULE: "LATE_SCHEDULE",
  SHORT_WHISTLE: "SHORT_WHISTLE",
});

export const CLEAR_LINE_CONDITION = Object.freeze({
  id: CONDITION_IDS.CLEAR_LINE,
  name: "Clear Line",
  glyph: "—",
  priority: "BASE",
  ruleSummary: "Standard carriage rules — no extra table condition this stop.",
  expirySummary: "No condition active.",
});

export const CONDITION_LIST = Object.freeze([
  Object.freeze({
    id: CONDITION_IDS.SEALED_MANIFEST,
    name: "Sealed Manifest",
    glyph: "⊠",
    priority: "MUST",
    activeThroughTurn: 2,
    ruleSummary: "Neither side may swap tickets on their opening Offer (Turns 1–2; Night Transfer also waits).",
    expirySummary: "Expires at the start of Turn 3.",
  }),

  Object.freeze({
    id: CONDITION_IDS.DRAFTY_WINDOW,
    name: "Drafty Window",
    glyph: "≋",
    priority: "MUST",
    activeThroughTurn: 4,
    ruleSummary: "During Turns 1–4, committing a fan of 3+ tickets blows the leftmost unlocked ticket face-up for both sides.",
    expirySummary: "Expires at the start of Turn 5.",
  }),

  Object.freeze({
    id: CONDITION_IDS.LATE_SCHEDULE,
    name: "Late Schedule",
    glyph: "◴",
    priority: "MUST",
    baseRequiredPairs: 3,
    ruleSummary: "Active Stamps stay locked until 3 pairs are matched during play (scaled down if fewer pairs survived the deal).",
    expirySummary: "Expires as soon as the required played pairs are matched.",
  }),

  Object.freeze({
    id: CONDITION_IDS.SHORT_WHISTLE,
    name: "Short Whistle",
    glyph: "☍",
    priority: "SHOULD",
    finalCallThreshold: 2,
    ruleSummary: "Final Call triggers after 2 consecutive Unlisted passes instead of 3.",
    expirySummary: "Lasts until the end of this stop.",
  }),
]);

const CONDITION_MAP = new Map([
  [CLEAR_LINE_CONDITION.id, CLEAR_LINE_CONDITION],
  ...CONDITION_LIST.map((c) => [c.id, c]),
]);

export function getConditionDef(conditionId) {
  if (!conditionId) return CLEAR_LINE_CONDITION;
  return CONDITION_MAP.get(conditionId) || null;
}

/**
 * Create the per-duel condition runtime tracker from a condition ID and post-deal pair count.
 */
export function createDuelConditionState(conditionId, initialRemainingPairs) {
  if (!conditionId || conditionId === CONDITION_IDS.CLEAR_LINE) {
    return null;
  }
  const def = getConditionDef(conditionId);
  if (!def) {
    throw new RangeError(`Unknown conditionId: ${conditionId}`);
  }

  if (def.id === CONDITION_IDS.SEALED_MANIFEST) {
    return {
      id: def.id,
      name: def.name,
      glyph: def.glyph,
      expired: false,
      activeThroughTurn: def.activeThroughTurn,
      requiredPlayedPairs: null,
      finalCallThreshold: null,
    };
  }

  if (def.id === CONDITION_IDS.DRAFTY_WINDOW) {
    return {
      id: def.id,
      name: def.name,
      glyph: def.glyph,
      expired: false,
      activeThroughTurn: def.activeThroughTurn,
      requiredPlayedPairs: null,
      finalCallThreshold: null,
    };
  }

  if (def.id === CONDITION_IDS.LATE_SCHEDULE) {
    // Decision D10: scale down when initial deal leaves <= 3 pairs so Stamps unlock before the end.
    const req = Math.min(def.baseRequiredPairs, Math.max(1, initialRemainingPairs - 1));
    return {
      id: def.id,
      name: def.name,
      glyph: def.glyph,
      expired: initialRemainingPairs <= 0,
      activeThroughTurn: null,
      requiredPlayedPairs: req,
      finalCallThreshold: null,
    };
  }

  // SHORT_WHISTLE
  return {
    id: def.id,
    name: def.name,
    glyph: def.glyph,
    expired: false,
    activeThroughTurn: null,
    requiredPlayedPairs: null,
    finalCallThreshold: def.finalCallThreshold,
  };
}

/**
 * Produce a concise, always-accurate live status badge label showing remaining duration or expiry.
 */
export function describeConditionLiveStatus(condition, { turnNumber = 1, playedPairsDiscarded = 0, duelOver = false } = {}) {
  if (!condition) {
    return null;
  }
  const def = getConditionDef(condition.id);
  if (duelOver) {
    return {
      id: condition.id,
      name: condition.name,
      glyph: condition.glyph,
      expired: true,
      badgeText: "Ended with stop",
      ruleSummary: def?.ruleSummary || "",
    };
  }

  if (condition.expired) {
    let badgeText = "Expired";
    if (condition.id === CONDITION_IDS.SEALED_MANIFEST) {
      badgeText = "Expired · Swaps open";
    } else if (condition.id === CONDITION_IDS.DRAFTY_WINDOW) {
      badgeText = "Expired · Window shut";
    } else if (condition.id === CONDITION_IDS.LATE_SCHEDULE) {
      badgeText = "Expired · Stamps open";
    }
    return {
      id: condition.id,
      name: condition.name,
      glyph: condition.glyph,
      expired: true,
      badgeText,
      ruleSummary: def?.ruleSummary || "",
    };
  }

  let badgeText = "Active";
  if (condition.id === CONDITION_IDS.SEALED_MANIFEST) {
    const rem = Math.max(1, condition.activeThroughTurn - turnNumber + 1);
    badgeText = `Active · Turn ${turnNumber}/2 (${rem} ${rem === 1 ? "offer" : "offers"} left)`;
  } else if (condition.id === CONDITION_IDS.DRAFTY_WINDOW) {
    const rem = Math.max(1, condition.activeThroughTurn - turnNumber + 1);
    badgeText = `Active · Turn ${turnNumber}/4 (${rem} left)`;
  } else if (condition.id === CONDITION_IDS.LATE_SCHEDULE) {
    const req = condition.requiredPlayedPairs || 3;
    const left = Math.max(0, req - playedPairsDiscarded);
    badgeText = `Active · Stamps unlock in ${left} ${left === 1 ? "pair" : "pairs"} (${playedPairsDiscarded}/${req})`;
  } else if (condition.id === CONDITION_IDS.SHORT_WHISTLE) {
    badgeText = "Active all stop · Final Call at 2";
  }

  return {
    id: condition.id,
    name: condition.name,
    glyph: condition.glyph,
    expired: false,
    badgeText,
    ruleSummary: def?.ruleSummary || "",
  };
}
