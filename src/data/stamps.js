/**
 * src/data/stamps.js
 * Canonical definitions for all 8 Stamps (6 MUST SHIP + 2 SHOULD SHIP).
 *
 * HOW TO ADD A NEW STAMP:
 * 1. Add a frozen descriptor object to STAMP_LIST below (unique `id`, `phase`,
 *    `targetType`, `shortBenefit`, `shortTradeoff`, etc.).
 * 2. Add its usability rule in `getStampUsability` and its resolution effect in
 *    `resolveStampAction` (or `resolvePairStampTriggers` for passive pair Stamps)
 *    inside `src/core/engine.js`.
 * 3. Add a unit test in `tests/phase3Suite.js` covering both its effect and tradeoff.
 */

export const MAX_STAMP_SLOTS = 3;
export const REWARD_CHOICE_COUNT = 3;

export const STAMP_IDS = Object.freeze({
  INSPECTION_WINDOW: "INSPECTION_WINDOW",
  CARBON_COPY: "CARBON_COPY",
  NIGHT_TRANSFER: "NIGHT_TRANSFER",
  SPARE_WICK: "SPARE_WICK",
  MANIFEST_LOUPE: "MANIFEST_LOUPE",
  BRASS_WEIGHT: "BRASS_WEIGHT",
  BELL_CORD: "BELL_CORD",
  LAST_STOP_PUNCH: "LAST_STOP_PUNCH",
});

export const STAMP_LIST = Object.freeze([
  Object.freeze({
    id: STAMP_IDS.INSPECTION_WINDOW,
    name: "Inspection Window",
    glyph: "◰",
    priority: "MUST",
    phase: "DRAW",
    targetType: "OPPONENT_SLOT",
    isInspection: true,
    consumable: false,
    triggerSymbols: Object.freeze([]),
    timingLabel: "Your Draw · 1/stop",
    shortBenefit: "Privately peek at 1 face-down Inspector ticket before drawing.",
    shortTradeoff: "Your next Offer turn cannot swap tickets.",
    synergyHint: "Refreshed by Carbon Copy (Lantern★ / Watch★); swap penalty cleared by Night Transfer.",
  }),

  Object.freeze({
    id: STAMP_IDS.CARBON_COPY,
    name: "Carbon Copy",
    glyph: "⧉",
    priority: "MUST",
    phase: "PASSIVE",
    targetType: "NONE",
    isInspection: false,
    consumable: false,
    triggerSymbols: Object.freeze(["LANTERN", "WATCH"]),
    timingLabel: "Passive · 1/stop",
    shortBenefit: "Matching Lantern★ or Watch★ during play refills 1 spent Inspection Stamp.",
    shortTradeoff: "Does nothing unless you hold Inspection Window or Manifest Loupe and spend it first.",
    synergyHint: "Pairs with Inspection Window or Manifest Loupe.",
  }),

  Object.freeze({
    id: STAMP_IDS.NIGHT_TRANSFER,
    name: "Night Transfer",
    glyph: "⇄",
    priority: "MUST",
    phase: "OFFER",
    targetType: "NONE",
    isInspection: false,
    consumable: false,
    triggerSymbols: Object.freeze([]),
    timingLabel: "Your Offer · 1/stop",
    shortBenefit: "Gain +1 private swap this Offer (also restores a forfeited swap).",
    shortTradeoff: "Requires 3+ tickets in hand; leaves a visible stamp mark on the table.",
    synergyHint: "Cancels swap loss from Inspection Window or Bell Cord while holding 3+ tickets.",
  }),

  Object.freeze({
    id: STAMP_IDS.SPARE_WICK,
    name: "Spare Wick",
    glyph: "🕯",
    priority: "MUST",
    phase: "EITHER",
    targetType: "NONE",
    isInspection: false,
    consumable: true,
    triggerSymbols: Object.freeze([]),
    timingLabel: "Your Turn · Single Use",
    shortBenefit: "Restore +1 Lantern charge (up to the maximum of 3), then discard this Stamp.",
    shortTradeoff: "Gives no advantage on the table while held and leaves an empty slot once burned.",
    synergyHint: "Insurance after an early stop loss or before Final Inspection.",
  }),

  Object.freeze({
    id: STAMP_IDS.MANIFEST_LOUPE,
    name: "Manifest Loupe",
    glyph: "⌕",
    priority: "MUST",
    phase: "DRAW",
    targetType: "OPPONENT_ADJACENT",
    isInspection: true,
    consumable: false,
    triggerSymbols: Object.freeze([]),
    timingLabel: "Your Draw · 1/stop",
    shortBenefit: "Pick 2 side-by-side Inspector slots (fan of 3+): privately learn if The Unlisted is in them.",
    shortTradeoff: "Your next Offer exposes your leftmost unlocked ticket face-up.",
    synergyHint: "Counts as an Inspection Stamp — Carbon Copy (Lantern★ / Watch★) refills it.",
  }),

  Object.freeze({
    id: STAMP_IDS.BRASS_WEIGHT,
    name: "Brass Weight",
    glyph: "⏚",
    priority: "MUST",
    phase: "OFFER",
    targetType: "OWN_ORDINARY_SLOT",
    isInspection: false,
    consumable: false,
    triggerSymbols: Object.freeze([]),
    timingLabel: "Your Offer · 1/stop",
    shortBenefit: "Lock 1 of your normal tickets (hand of 3+) so the Inspector must draw from the rest.",
    shortTradeoff: "Cannot lock The Unlisted; your next Offer exposes your rightmost unlocked ticket.",
    synergyHint: "Raises the odds the Inspector draws your Unlisted; stacks cleanly with Loupe.",
  }),

  Object.freeze({
    id: STAMP_IDS.BELL_CORD,
    name: "Bell Cord",
    glyph: "⍾",
    priority: "SHOULD",
    phase: "DRAW",
    targetType: "NONE",
    isInspection: false,
    consumable: false,
    triggerSymbols: Object.freeze(["KEY", "BELL"]),
    timingLabel: "Key★/Bell★ → Your Draw · 1/stop",
    shortBenefit: "After matching Key★ or Bell★, ring in Draw (fan of 3+) to reveal an Emblem★ slot.",
    shortTradeoff: "Dormant until Key★ or Bell★ is matched; ringing forfeits your next Offer swap.",
    synergyHint: "Reveals Lantern★ or Watch★ to safely trigger Carbon Copy; Night Transfer restores the swap.",
  }),

  Object.freeze({
    id: STAMP_IDS.LAST_STOP_PUNCH,
    name: "Last-Stop Punch",
    glyph: "◉",
    priority: "SHOULD",
    phase: "DRAW",
    targetType: "NONE",
    isInspection: false,
    consumable: false,
    triggerSymbols: Object.freeze([]),
    timingLabel: "Your Draw · 1/stop",
    shortBenefit: "When Unlisted Streak is 1+ (fan of 3+), add +1 Streak before drawing to reach Final Call early.",
    shortTradeoff: "If your draw makes a normal pair instead, your next Offer exposes your leftmost ticket.",
    synergyHint: "Strong under Short Whistle or at Streak 2 to auto-shield The Unlisted if drawn.",
  }),
]);

const STAMP_MAP = new Map(STAMP_LIST.map((s) => [s.id, s]));

export function getStampDef(stampId) {
  return STAMP_MAP.get(stampId) || null;
}

/**
 * Create a fresh per-duel runtime state object for an equipped Stamp.
 */
export function createDuelStampState(stampId) {
  const def = getStampDef(stampId);
  if (!def) {
    throw new RangeError(`Unknown stampId: ${stampId}`);
  }
  return {
    id: def.id,
    spent: false,
    // Bell Cord begins dormant and unlocks once KEY or BELL is matched during play.
    tokenReady: def.id === STAMP_IDS.BELL_CORD ? false : true,
  };
}
