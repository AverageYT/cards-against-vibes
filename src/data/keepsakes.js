/**
 * src/data/keepsakes.js
 * Permanent between-run progression items ("Platform Locker Keepsakes") and
 * Punched Stub reward tuning for The Unlisted.
 *
 * Design curve:
 * - Runs 1–2 ("Empty Pockets"): The Inspector starts strong (Tier 3->5) and uses
 *   his own legal Stamp kit across multi-deal carriages. New passengers rarely
 *   survive past Carriage II–III, but every matched pair, Emblem pair, deal win,
 *   and carriage win awards Punched Stubs.
 * - Tier I Keepsakes (20–25 Stubs): Early footholds affordable right after Run 1.
 * - Tier II Keystone Special Item — THE PERFORATION GAUGE (55 Stubs, ~Run 2–3):
 *   The turning-point contraband instrument that jams 1 Inspector Stamp per stop,
 *   marks a guaranteed-safe ticket every deal, and unlocks a 3-choice Starter
 *   Stamp draft at departure.
 * - Tier III Mastery Keepsakes (45–75 Stubs): Reward rerolls, streak Lantern
 *   recovery + Emergency Match, and a second Stamp jam + second Gauge charge to
 *   go toe-to-toe with the Tier 5 Chief Inspector on Final Inspection.
 */

export const KEEPSAKE_IDS = Object.freeze({
  WEATHERED_CASE: "WEATHERED_CASE",
  TALLOW_SEAL: "TALLOW_SEAL",
  PERFORATION_GAUGE: "PERFORATION_GAUGE",
  SMUGGLERS_CARBON: "SMUGGLERS_CARBON",
  DOUBLE_WICK_LAMP: "DOUBLE_WICK_LAMP",
  COUNTERFEIT_SEAL: "COUNTERFEIT_SEAL",
});

export const STUB_REWARDS = Object.freeze({
  pairsPerStub: 2,
  perEmblemPair: 1,
  perDealWon: 2,
  perCarriageWon: 4,
  victoryBonus: 18,
  firstRunMinimum: 20,
});

export const KEEPSAKE_LIST = Object.freeze([
  Object.freeze({
    id: KEEPSAKE_IDS.WEATHERED_CASE,
    name: "Weathered Stamp Case",
    glyph: "◧",
    tier: 1,
    tierLabel: "Tier I · Foothold",
    isKeystone: false,
    cost: 20,
    requiresMode: "NONE",
    requires: Object.freeze([]),
    shortEffect:
      "Begin every run with 1 random Starter Stamp already inked in Slot 1.",
    flavor:
      "Tucked under a third-class bench; one rubber die still smells faintly of station ink.",
  }),

  Object.freeze({
    id: KEEPSAKE_IDS.TALLOW_SEAL,
    name: "Thumb-Worn Tallow",
    glyph: "◫",
    tier: 1,
    tierLabel: "Tier I · Foothold",
    isKeystone: false,
    cost: 25,
    requiresMode: "NONE",
    requires: Object.freeze([]),
    shortEffect:
      "Unlock Check Edge (1/deal, key E): privately feel 1 hidden ticket in a fan of 3+ to learn if it is ★ Emblem Stock (100% safe pair) or Plain/Blank. Publicly marks the slot checked.",
    flavor:
      "Marked Emblem stock carries a raised brass border if you know where to press.",
  }),

  Object.freeze({
    id: KEEPSAKE_IDS.PERFORATION_GAUGE,
    name: "The Perforation Gauge",
    glyph: "⌖",
    tier: 2,
    tierLabel: "Tier II · ★ Keystone Special Item",
    isKeystone: true,
    cost: 60,
    requiresMode: "ANY",
    requires: Object.freeze([KEEPSAKE_IDS.WEATHERED_CASE, KEEPSAKE_IDS.TALLOW_SEAL]),
    shortEffect:
      "Breakthrough contraband tool: (1) Gauge Safe (1/deal, key G) privately flags 1 guaranteed-safe ticket when the Inspector offers 3+ cards with The Unlisted; (2) Jams 1 Inspector Stamp every stop; (3) Draft 1 of 3 Starter Stamps before Car I.",
    flavor:
      "Calibrated to a hair's breadth. It hears the hollow weight of a punched ticket — and snaps the Inspector's favorite brass die shut.",
  }),

  Object.freeze({
    id: KEEPSAKE_IDS.SMUGGLERS_CARBON,
    name: "Smuggler's Carbon Folio",
    glyph: "⎘",
    tier: 3,
    tierLabel: "Tier III · Line Mastery",
    isKeystone: false,
    cost: 55,
    requiresMode: "ALL",
    requires: Object.freeze([KEEPSAKE_IDS.PERFORATION_GAUGE]),
    shortEffect:
      "Gain 1 free Reroll on every Stamp Reward tray (and on the Departure Draft) to assemble stronger Stamp combos.",
    flavor:
      "A second sheet slipped beneath the official ledger reveals stamps never meant for passengers.",
  }),

  Object.freeze({
    id: KEEPSAKE_IDS.DOUBLE_WICK_LAMP,
    name: "Double-Wick Storm Lamp",
    glyph: "✦",
    tier: 3,
    tierLabel: "Tier III · Line Mastery",
    isKeystone: false,
    cost: 70,
    requiresMode: "ALL",
    requires: Object.freeze([KEEPSAKE_IDS.PERFORATION_GAUGE]),
    shortEffect:
      "Carry 1 Emergency Match per run (automatically voids your first carriage-losing final deal so you play another hand), and winning 2 carriages in a row restores +1 Lantern (up to 3).",
    flavor:
      "When the corridor draft takes the primary flame, the reserve wick catches on its own.",
  }),

  Object.freeze({
    id: KEEPSAKE_IDS.COUNTERFEIT_SEAL,
    name: "Guard's Master Counter-Seal",
    glyph: "⛨",
    tier: 3,
    tierLabel: "Tier III · Line Mastery",
    isKeystone: false,
    cost: 90,
    requiresMode: "ALL",
    requires: Object.freeze([KEEPSAKE_IDS.PERFORATION_GAUGE]),
    shortEffect:
      "Jam a 2nd Inspector Stamp on every stop and increase Perforation Gauge charges to 2 per deal.",
    flavor:
      "Stamped with the depot superintendent's cipher. Even the Chief Inspector must set two tools aside.",
  }),
]);

const KEEPSAKE_MAP = new Map(KEEPSAKE_LIST.map((k) => [k.id, k]));

export function getKeepsakeDef(id) {
  return KEEPSAKE_MAP.get(id) || null;
}

/**
 * Compute concrete gameplay modifiers from a list of active Keepsake IDs.
 */
export function computeKeepsakeBonuses(activeIds = []) {
  const set = new Set(activeIds);
  const hasCase = set.has(KEEPSAKE_IDS.WEATHERED_CASE);
  const hasTallow = set.has(KEEPSAKE_IDS.TALLOW_SEAL);
  const hasGauge = set.has(KEEPSAKE_IDS.PERFORATION_GAUGE);
  const hasCarbon = set.has(KEEPSAKE_IDS.SMUGGLERS_CARBON);
  const hasLamp = set.has(KEEPSAKE_IDS.DOUBLE_WICK_LAMP);
  const hasCounter = set.has(KEEPSAKE_IDS.COUNTERFEIT_SEAL);

  return Object.freeze({
    activeIds: Object.freeze(
      KEEPSAKE_LIST.map((k) => k.id).filter((id) => set.has(id))
    ),
    hasKeystoneGauge: hasGauge,
    starterStampMode: hasGauge ? "DRAFT_3" : hasCase ? "RANDOM_1" : "NONE",
    edgeChecksPerDeal: hasTallow ? 1 : 0,
    gaugeChargesPerDeal: hasGauge ? (hasCounter ? 2 : 1) : 0,
    inspectorStampJams: (hasGauge ? 1 : 0) + (hasCounter ? 1 : 0),
    rewardRerollsPerTray: hasCarbon ? 1 : 0,
    emergencyMatchesPerRun: hasLamp ? 1 : 0,
    winStreakLanternHeal: hasLamp ? 2 : 0,
  });
}
