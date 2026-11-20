/**
 * src/core/meta.js
 * Offline-first persistent meta-progression store for Punched Stubs, Keepsake
 * unlocks, optional per-item toggles (for challenge / seeded parity runs), and
 * lifetime run statistics. Never requires any server, account, or network call.
 */

import {
  KEEPSAKE_LIST,
  STUB_REWARDS,
  computeKeepsakeBonuses,
  getKeepsakeDef,
} from "../data/keepsakes.js";

export const META_STORAGE_KEY = "the_unlisted_meta_v1";

const VALID_IDS = new Set(KEEPSAKE_LIST.map((k) => k.id));

function createEmptyProfile() {
  return {
    version: 1,
    stubs: 0,
    lifetimeStubs: 0,
    runsCompleted: 0,
    runsWon: 0,
    bestStopReached: 0, // 1..5
    unlockedIds: [],
    disabledIds: [],
    tutorialSeen: false,
  };
}

function sanitizeProfile(raw) {
  const base = createEmptyProfile();
  if (!raw || typeof raw !== "object") return base;

  const unlocked = Array.isArray(raw.unlockedIds)
    ? Array.from(new Set(raw.unlockedIds.filter((id) => VALID_IDS.has(id))))
    : [];
  const unlockedSet = new Set(unlocked);
  const disabled = Array.isArray(raw.disabledIds)
    ? Array.from(
        new Set(raw.disabledIds.filter((id) => VALID_IDS.has(id) && unlockedSet.has(id)))
      )
    : [];

  return {
    version: 1,
    stubs: Number.isInteger(raw.stubs) && raw.stubs >= 0 ? raw.stubs : 0,
    lifetimeStubs:
      Number.isInteger(raw.lifetimeStubs) && raw.lifetimeStubs >= 0 ? raw.lifetimeStubs : 0,
    runsCompleted:
      Number.isInteger(raw.runsCompleted) && raw.runsCompleted >= 0 ? raw.runsCompleted : 0,
    runsWon: Number.isInteger(raw.runsWon) && raw.runsWon >= 0 ? raw.runsWon : 0,
    bestStopReached:
      Number.isInteger(raw.bestStopReached) && raw.bestStopReached >= 0
        ? Math.min(5, raw.bestStopReached)
        : 0,
    unlockedIds: unlocked,
    disabledIds: disabled,
    tutorialSeen: Boolean(raw.tutorialSeen),
  };
}

/**
 * Evaluate prerequisite & stub affordability for a Keepsake against a profile.
 */
export function getKeepsakeStatus(profile, keepsakeId) {
  const def = getKeepsakeDef(keepsakeId);
  if (!def) {
    return { valid: false, unlocked: false, active: false, canBuy: false, lockReason: "Unknown" };
  }

  const unlockedSet = new Set(profile.unlockedIds);
  const disabledSet = new Set(profile.disabledIds);
  const unlocked = unlockedSet.has(def.id);
  const active = unlocked && !disabledSet.has(def.id);

  if (unlocked) {
    return {
      valid: true,
      unlocked: true,
      active,
      prereqMet: true,
      canBuy: false,
      lockReason: null,
    };
  }

  let prereqMet = true;
  let lockReason = null;

  if (def.requiresMode === "ANY" && def.requires.length > 0) {
    prereqMet = def.requires.some((id) => unlockedSet.has(id));
    if (!prereqMet) {
      lockReason = "Unlock any Tier I Keepsake first";
    }
  } else if (def.requiresMode === "ALL" && def.requires.length > 0) {
    const missing = def.requires.filter((id) => !unlockedSet.has(id));
    prereqMet = missing.length === 0;
    if (!prereqMet) {
      const names = missing.map((id) => getKeepsakeDef(id)?.name || id).join(", ");
      lockReason = `Requires ${names}`;
    }
  }

  const canAfford = profile.stubs >= def.cost;
  if (prereqMet && !canAfford) {
    lockReason = `Need ${def.cost - profile.stubs} more Stubs`;
  }

  return {
    valid: true,
    unlocked: false,
    active: false,
    prereqMet,
    canBuy: prereqMet && canAfford,
    lockReason,
  };
}

/**
 * Calculate Punched Stubs earned from a completed run (win or defeat).
 */
export function calculateRunStubPayout({
  playerPairsMatched = 0,
  playerEmblemPairsMatched = 0,
  dealsWon = 0,
  carriagesWon = 0,
  victory = false,
  isFirstCompletedRun = false,
} = {}) {
  const pairStubs = Math.floor(
    Math.max(0, playerPairsMatched) / Math.max(1, STUB_REWARDS.pairsPerStub || 2)
  );
  const emblemStubs = Math.max(0, playerEmblemPairsMatched) * STUB_REWARDS.perEmblemPair;
  const dealStubs = Math.max(0, dealsWon) * STUB_REWARDS.perDealWon;
  const carriageStubs = Math.max(0, carriagesWon) * STUB_REWARDS.perCarriageWon;
  const victoryStubs = victory ? STUB_REWARDS.victoryBonus : 0;

  const subtotal = pairStubs + emblemStubs + dealStubs + carriageStubs + victoryStubs;
  const firstRunBoost =
    isFirstCompletedRun && subtotal < STUB_REWARDS.firstRunMinimum
      ? STUB_REWARDS.firstRunMinimum - subtotal
      : 0;
  const total = subtotal + firstRunBoost;

  const lines = [
    { label: `Pairs matched (${playerPairsMatched} · 1 per 2)`, amount: pairStubs },
    { label: `Emblem ★ pairs (${playerEmblemPairsMatched})`, amount: emblemStubs },
    { label: `Deals won (${dealsWon})`, amount: dealStubs },
    { label: `Carriages cleared (${carriagesWon})`, amount: carriageStubs },
  ];
  if (victoryStubs > 0) {
    lines.push({ label: "Final Inspection cleared", amount: victoryStubs });
  }
  if (firstRunBoost > 0) {
    lines.push({ label: "Unclaimed first-passage stubs", amount: firstRunBoost });
  }

  return {
    total,
    lines,
  };
}

/**
 * Create a self-contained meta-progression manager backed by an optional storage
 * object (e.g., `window.localStorage`) or pure in-memory state for tests.
 */
export function createMetaStore({ storage = null, initialProfile = null } = {}) {
  function readFromStorage() {
    if (initialProfile) return sanitizeProfile(initialProfile);
    if (!storage || typeof storage.getItem !== "function") {
      return createEmptyProfile();
    }
    try {
      const raw = storage.getItem(META_STORAGE_KEY);
      if (!raw) return createEmptyProfile();
      return sanitizeProfile(JSON.parse(raw));
    } catch {
      return createEmptyProfile();
    }
  }

  let profile = readFromStorage();

  function persist() {
    if (!storage || typeof storage.setItem !== "function") return;
    try {
      storage.setItem(META_STORAGE_KEY, JSON.stringify(profile));
    } catch {
      // Ignore quota/sandboxed storage errors; session stays playable.
    }
  }

  function getActiveIds() {
    const disabled = new Set(profile.disabledIds);
    return KEEPSAKE_LIST.map((k) => k.id).filter(
      (id) => profile.unlockedIds.includes(id) && !disabled.has(id)
    );
  }

  function getBonuses() {
    return computeKeepsakeBonuses(getActiveIds());
  }

  function getSnapshot() {
    const items = KEEPSAKE_LIST.map((def) => ({
      ...def,
      ...getKeepsakeStatus(profile, def.id),
    }));
    const affordableCount = items.filter((it) => it.canBuy).length;
    const keystoneItem = items.find((it) => it.isKeystone) || null;

    return {
      stubs: profile.stubs,
      lifetimeStubs: profile.lifetimeStubs,
      runsCompleted: profile.runsCompleted,
      runsWon: profile.runsWon,
      bestStopReached: profile.bestStopReached,
      tutorialSeen: profile.tutorialSeen,
      unlockedIds: profile.unlockedIds.slice(),
      disabledIds: profile.disabledIds.slice(),
      activeIds: getActiveIds(),
      bonuses: getBonuses(),
      items,
      affordableCount,
      keystoneReadyToBuy: Boolean(keystoneItem && keystoneItem.canBuy),
      keystoneUnlocked: Boolean(keystoneItem && keystoneItem.unlocked),
    };
  }

  function unlock(keepsakeId) {
    const def = getKeepsakeDef(keepsakeId);
    const status = getKeepsakeStatus(profile, keepsakeId);
    if (!def || !status.canBuy) {
      return {
        ok: false,
        reason: status.unlocked ? "ALREADY_UNLOCKED" : "CANNOT_BUY",
        message: status.lockReason || "Cannot unlock this Keepsake yet.",
      };
    }

    profile = {
      ...profile,
      stubs: profile.stubs - def.cost,
      unlockedIds: [...profile.unlockedIds, def.id],
      disabledIds: profile.disabledIds.filter((id) => id !== def.id),
    };
    persist();
    return { ok: true, keepsake: def, snapshot: getSnapshot() };
  }

  function toggleActive(keepsakeId) {
    if (!profile.unlockedIds.includes(keepsakeId)) {
      return { ok: false, reason: "NOT_UNLOCKED" };
    }
    const isDisabled = profile.disabledIds.includes(keepsakeId);
    const nextDisabled = isDisabled
      ? profile.disabledIds.filter((id) => id !== keepsakeId)
      : [...profile.disabledIds, keepsakeId];
    profile = {
      ...profile,
      disabledIds: nextDisabled,
    };
    persist();
    return { ok: true, active: isDisabled, snapshot: getSnapshot() };
  }

  function recordCompletedRun({
    playerPairsMatched = 0,
    playerEmblemPairsMatched = 0,
    dealsWon = 0,
    carriagesWon = 0,
    stopReached = 1,
    victory = false,
  } = {}) {
    const payout = calculateRunStubPayout({
      playerPairsMatched,
      playerEmblemPairsMatched,
      dealsWon,
      carriagesWon,
      victory,
      isFirstCompletedRun: profile.runsCompleted === 0,
    });

    profile = {
      ...profile,
      stubs: profile.stubs + payout.total,
      lifetimeStubs: profile.lifetimeStubs + payout.total,
      runsCompleted: profile.runsCompleted + 1,
      runsWon: profile.runsWon + (victory ? 1 : 0),
      bestStopReached: Math.max(profile.bestStopReached, Math.min(5, Math.max(1, stopReached))),
    };
    persist();
    return { payout, snapshot: getSnapshot() };
  }

  function setTutorialSeen(flag = true) {
    profile = {
      ...profile,
      tutorialSeen: Boolean(flag),
    };
    persist();
  }

  function grantStubsForTest(amount) {
    if (!Number.isInteger(amount) || amount < 0) return;
    profile = {
      ...profile,
      stubs: profile.stubs + amount,
      lifetimeStubs: profile.lifetimeStubs + amount,
    };
    persist();
  }

  function resetProgress() {
    const keepTutorial = profile.tutorialSeen;
    profile = {
      ...createEmptyProfile(),
      tutorialSeen: keepTutorial,
    };
    persist();
    return getSnapshot();
  }

  return Object.freeze({
    getSnapshot,
    getBonuses,
    getActiveIds,
    unlock,
    toggleActive,
    recordCompletedRun,
    setTutorialSeen,
    grantStubsForTest,
    resetProgress,
  });
}
