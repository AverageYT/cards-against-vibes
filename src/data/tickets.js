/**
 * src/data/tickets.js
 * Canonical railway ticket symbol definitions and deck factory.
 *
 * Easy to edit: each entry in TICKET_SYMBOLS defines one matching pair.
 * The first 4 entries are marked Emblem Pairs (isEmblem: true), guaranteed
 * to appear in every encounter (MIN_PAIRS = 6) for Stamp interactions.
 */

export const MIN_PAIRS = 6;
export const MAX_PAIRS = 12;
export const DEFAULT_PAIRS = 6;
export const UNLISTED_ID = "UNLISTED-0";
export const UNLISTED_SYMBOL = "UNLISTED";

export const TICKET_SYMBOLS = Object.freeze([
  Object.freeze({
    id: "LANTERN",
    name: "Signal Lantern",
    shortLabel: "Lantern",
    code: "01",
    glyph: "◈",
    isEmblem: true,
    emblemGroup: "CARBON",
    lineNote: "Platform Oil Lamp",
  }),
  Object.freeze({
    id: "WATCH",
    name: "Conductor's Watch",
    shortLabel: "Watch",
    code: "02",
    glyph: "◷",
    isEmblem: true,
    emblemGroup: "CARBON",
    lineNote: "Stopped at 00:14",
  }),
  Object.freeze({
    id: "KEY",
    name: "Sleeper Key",
    shortLabel: "Key",
    code: "03",
    glyph: "⚷",
    isEmblem: true,
    emblemGroup: "BELL_CORD",
    lineNote: "Berth Compartment 7",
  }),
  Object.freeze({
    id: "BELL",
    name: "Platform Bell",
    shortLabel: "Bell",
    code: "04",
    glyph: "⍾",
    isEmblem: true,
    emblemGroup: "BELL_CORD",
    lineNote: "Departure Chime",
  }),
  Object.freeze({
    id: "TRUNK",
    name: "Baggage Trunk",
    shortLabel: "Trunk",
    code: "05",
    glyph: "▣",
    isEmblem: false,
    emblemGroup: null,
    lineNote: "Luggage Van Claim",
  }),
  Object.freeze({
    id: "SEAL",
    name: "Manifest Seal",
    shortLabel: "Seal",
    code: "06",
    glyph: "❂",
    isEmblem: false,
    emblemGroup: null,
    lineNote: "Stamped Red Wax",
  }),
  Object.freeze({
    id: "WHISTLE",
    name: "Brass Whistle",
    shortLabel: "Whistle",
    code: "07",
    glyph: "☍",
    isEmblem: false,
    emblemGroup: null,
    lineNote: "Guard's Signal",
  }),
  Object.freeze({
    id: "COMPASS",
    name: "Line Compass",
    shortLabel: "Compass",
    code: "08",
    glyph: "✦",
    isEmblem: false,
    emblemGroup: null,
    lineNote: "Northbound Spur",
  }),
  Object.freeze({
    id: "TEACUP",
    name: "Dining Cup",
    shortLabel: "Cup",
    code: "09",
    glyph: "⏍",
    isEmblem: false,
    emblemGroup: null,
    lineNote: "Car III Porcelain",
  }),
  Object.freeze({
    id: "UMBRELLA",
    name: "Rain Umbrella",
    shortLabel: "Umbrella",
    code: "10",
    glyph: "☂",
    isEmblem: false,
    emblemGroup: null,
    lineNote: "Left in Rack",
  }),
  Object.freeze({
    id: "COUPLER",
    name: "Iron Coupler",
    shortLabel: "Coupler",
    code: "11",
    glyph: "⛓",
    isEmblem: false,
    emblemGroup: null,
    lineNote: "Carriage Link",
  }),
  Object.freeze({
    id: "SIGNAL",
    name: "Semaphore Arm",
    shortLabel: "Semaphore",
    code: "12",
    glyph: "⚐",
    isEmblem: false,
    emblemGroup: null,
    lineNote: "Track Clear / Halt",
  }),
]);

export const UNLISTED_TICKET = Object.freeze({
  ticketId: UNLISTED_ID,
  symbolId: UNLISTED_SYMBOL,
  copy: "0",
  name: "The Unlisted",
  shortLabel: "Unlisted",
  code: "00",
  glyph: "●",
  isUnlisted: true,
  isEmblem: false,
  emblemGroup: null,
  lineNote: "Name Punched Out",
});

const SYMBOL_MAP = new Map(TICKET_SYMBOLS.map((sym) => [sym.id, sym]));

export function getTicketMeta(symbolId) {
  if (symbolId === UNLISTED_SYMBOL) {
    return UNLISTED_TICKET;
  }
  return SYMBOL_MAP.get(symbolId) || null;
}

/**
 * Create a single ordinary ticket object (immutable).
 */
export function makeOrdinaryTicket(symbolDef, copySuffix) {
  return Object.freeze({
    ticketId: `${symbolDef.id}-${copySuffix}`,
    symbolId: symbolDef.id,
    copy: copySuffix,
    name: symbolDef.name,
    shortLabel: symbolDef.shortLabel,
    code: symbolDef.code,
    glyph: symbolDef.glyph,
    isUnlisted: false,
    isEmblem: symbolDef.isEmblem,
    emblemGroup: symbolDef.emblemGroup,
    lineNote: symbolDef.lineNote,
  });
}

/**
 * Build the canonical unshuffled deck for pairCount pairs (2 * pairCount + 1 tickets).
 * Each ordinary symbol appears twice with unique IDs (-A, -B), plus UNLISTED-0.
 */
export function buildDeck(pairCount = DEFAULT_PAIRS, { minPairs = MIN_PAIRS } = {}) {
  if (!Number.isInteger(pairCount) || pairCount < minPairs || pairCount > MAX_PAIRS) {
    throw new RangeError(
      `pairCount must be an integer between ${minPairs} and ${MAX_PAIRS}; received ${pairCount}`
    );
  }

  const deck = [];
  for (let i = 0; i < pairCount; i += 1) {
    const sym = TICKET_SYMBOLS[i];
    deck.push(makeOrdinaryTicket(sym, "A"));
    deck.push(makeOrdinaryTicket(sym, "B"));
  }
  deck.push(UNLISTED_TICKET);
  return deck;
}
