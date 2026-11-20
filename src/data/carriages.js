/**
 * src/data/carriages.js
 * Canonical 5-stop run schedule (4 Carriages + Final Inspection), multi-deal
 * match lengths, elevated Inspector AI tiers & legal Inspector Stamp loadouts,
 * and Lantern settings.
 *
 * Design notes:
 * - Each carriage is a multi-deal match (`dealsToWin: 2` = Best of 3 deals on
 *   Carriages I–IV; `dealsToWin: 3` = Best of 5 deals on Final Inspection),
 *   giving a complete run ~12–18 minutes of tense tabletop play and letting the
 *   Inspector's habit tracking develop across hands.
 * - From Stop 1 onward, the Inspector plays at Tier 3–5 and brings his own legal
 *   Stamp kit (obeying every rule and public tradeoff). Un-upgraded Run 1–2
 *   passengers face severe odds until they unlock Keepsakes — especially
 *   The Perforation Gauge — in the Platform Locker.
 *
 * HOW TO ADD OR EDIT A CARRIAGE:
 * Append or modify an entry in CARRIAGES (`pairCount` in 6..12, `aiTier` in 1..5,
 * `dealsToWin` >= 1, `inspectorStamps` array of up to 3 STAMP_IDS).
 */

import { STAMP_IDS } from "./stamps.js";

export const INITIAL_LANTERNS = 3;
export const MAX_LANTERNS = 3;

export const CARRIAGES = Object.freeze([
  Object.freeze({
    stopIndex: 0,
    stopNumber: 1,
    id: "CARRIAGE_1",
    code: "CAR I",
    name: "Third-Class Coach",
    stationName: "Alder Halt (Unlit)",
    pairCount: 7,
    dealsToWin: 2,
    aiTier: 3,
    inspectorStamps: Object.freeze([
      STAMP_IDS.INSPECTION_WINDOW,
      STAMP_IDS.BELL_CORD,
    ]),
    hasCondition: false,
    isFinalInspection: false,
    arrivalNote:
      "Rain beads along bare wooden benches. Even in third class, the Inspector lays an Inspection Window and Bell Cord beside his ledger.",
  }),

  Object.freeze({
    stopIndex: 1,
    stopNumber: 2,
    id: "CARRIAGE_2",
    code: "CAR II",
    name: "Luggage Van",
    stationName: "Mirebridge Crossing",
    pairCount: 8,
    dealsToWin: 2,
    aiTier: 4,
    inspectorStamps: Object.freeze([
      STAMP_IDS.INSPECTION_WINDOW,
      STAMP_IDS.MANIFEST_LOUPE,
      STAMP_IDS.NIGHT_TRANSFER,
    ]),
    hasCondition: true,
    isFinalInspection: false,
    arrivalNote:
      "Strapped trunks sit tagged for passengers never checked in. A glass loupe glints between the Inspector's gloved fingers.",
  }),

  Object.freeze({
    stopIndex: 2,
    stopNumber: 3,
    id: "CARRIAGE_3",
    code: "CAR III",
    name: "Dining Car",
    stationName: "Northfen Siding",
    pairCount: 9,
    dealsToWin: 2,
    aiTier: 4,
    inspectorStamps: Object.freeze([
      STAMP_IDS.INSPECTION_WINDOW,
      STAMP_IDS.BRASS_WEIGHT,
      STAMP_IDS.CARBON_COPY,
    ]),
    hasCondition: true,
    isFinalInspection: false,
    arrivalNote:
      "Cold teacups rattle softly. He watches which side of the fan you reach for — and slips carbon paper under every Emblem pair.",
  }),

  Object.freeze({
    stopIndex: 3,
    stopNumber: 4,
    id: "CARRIAGE_4",
    code: "CAR IV",
    name: "Sleeper Corridor",
    stationName: "Holloway Viaduct",
    pairCount: 10,
    dealsToWin: 2,
    aiTier: 5,
    inspectorStamps: Object.freeze([
      STAMP_IDS.INSPECTION_WINDOW,
      STAMP_IDS.MANIFEST_LOUPE,
      STAMP_IDS.NIGHT_TRANSFER,
    ]),
    hasCondition: true,
    isFinalInspection: false,
    arrivalNote:
      "Every berth door stands latched from within, each nameplate blank. Nothing escapes the Inspector's ledger this deep into the train.",
  }),

  Object.freeze({
    stopIndex: 4,
    stopNumber: 5,
    id: "FINAL_INSPECTION",
    code: "STOP V",
    name: "Final Inspection · Guard's Brake",
    stationName: "Terminus Platform Zero",
    pairCount: 12,
    dealsToWin: 3,
    aiTier: 5,
    inspectorStamps: Object.freeze([
      STAMP_IDS.INSPECTION_WINDOW,
      STAMP_IDS.MANIFEST_LOUPE,
      STAMP_IDS.BELL_CORD,
    ]),
    hasCondition: true,
    isFinalInspection: true,
    arrivalNote:
      "The end of the line. Every ticket on the midnight manifest goes on the table across a Best-of-5 inspection. Win three deals to step off free.",
  }),
]);

export const TOTAL_STOPS = CARRIAGES.length;

export function getCarriageDef(stopIndex) {
  return CARRIAGES[stopIndex] || null;
}

/**
 * Split a carriage's Inspector Stamps into jammed vs. active based on the
 * player's equipped Keepsakes (Perforation Gauge jams 1; Counter-Seal jams 2).
 */
export function resolveInspectorLoadout(carriage, jamCount = 0) {
  const all = Array.isArray(carriage?.inspectorStamps) ? carriage.inspectorStamps : [];
  const clamped = Math.max(0, Math.min(all.length, jamCount | 0));
  return {
    jammedIds: all.slice(0, clamped),
    activeIds: all.slice(clamped),
  };
}
