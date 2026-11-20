/**
 * src/ui/appView.js
 * Accessible DOM renderer & full keyboard handler for The Unlisted:
 * Title Screen, Platform Locker (meta-progression Keepsakes & ★ Perforation Gauge),
 * Interactive Beginner Tutorial, Departure Stamp Draft, Carriage Briefing,
 * Multi-Deal Carriage Table (3 Lanterns, Deal Score, Inspector Stamp Kit &
 * counter-play alerts, Locker Tools [G/E], 3-slot Stamp tray [1–3], live Condition
 * countdown, and hidden Dev Trace), Deal/Stop Result, Stamp Reward Tray (+ Reroll),
 * and Run Over screen with itemized Punched Stub receipt.
 *
 * All element creation uses the injected `doc` reference and every event listener
 * is registered through a single disposable list to guarantee zero listener leaks.
 */

import { PHASES, SIDES } from "../core/engine.js";
import { RUN_OUTCOMES, RUN_SCREENS } from "../core/run.js";
import { BUCKETS, BUCKET_LABELS } from "../data/aiTuning.js";
import { CONDITION_IDS } from "../data/conditions.js";
import { STAMP_IDS, getStampDef } from "../data/stamps.js";
import { getTicketMeta } from "../data/tickets.js";

const STAMP_SYNERGY_PARTNERS = Object.freeze({
  [STAMP_IDS.INSPECTION_WINDOW]: [
    STAMP_IDS.CARBON_COPY,
    STAMP_IDS.NIGHT_TRANSFER,
    STAMP_IDS.BELL_CORD,
  ],
  [STAMP_IDS.CARBON_COPY]: [
    STAMP_IDS.INSPECTION_WINDOW,
    STAMP_IDS.MANIFEST_LOUPE,
    STAMP_IDS.BELL_CORD,
  ],
  [STAMP_IDS.NIGHT_TRANSFER]: [STAMP_IDS.INSPECTION_WINDOW, STAMP_IDS.BELL_CORD],
  [STAMP_IDS.SPARE_WICK]: [],
  [STAMP_IDS.MANIFEST_LOUPE]: [STAMP_IDS.CARBON_COPY, STAMP_IDS.BRASS_WEIGHT],
  [STAMP_IDS.BRASS_WEIGHT]: [STAMP_IDS.MANIFEST_LOUPE],
  [STAMP_IDS.BELL_CORD]: [
    STAMP_IDS.CARBON_COPY,
    STAMP_IDS.NIGHT_TRANSFER,
    STAMP_IDS.INSPECTION_WINDOW,
  ],
  [STAMP_IDS.LAST_STOP_PUNCH]: [STAMP_IDS.MANIFEST_LOUPE, STAMP_IDS.INSPECTION_WINDOW],
});

function hasTraySynergy(candidateId, equippedDefs) {
  const partners = STAMP_SYNERGY_PARTNERS[candidateId] || [];
  if (partners.length === 0) return null;
  const match = equippedDefs.find((d) => d && partners.includes(d.id));
  return match ? match.name : null;
}

/**
 * Check strictly public history to alert an observant player when the Inspector
 * just drew The Unlisted AND entered his Offer with his swap forfeited (and didn't
 * stamp Night Transfer) — rewarding reading his Stamp tradeoffs!
 */
function inspectorPinnedUnlistedAtRight(view) {
  if (
    !view ||
    view.phase !== PHASES.DRAW ||
    view.offerer !== SIDES.INSPECTOR ||
    !view.opponentHoldsUnlisted ||
    !Array.isArray(view.publicHistory)
  ) {
    return false;
  }
  let turnStart = null;
  let prevDraw = null;
  let recoveredSwap = false;
  for (let i = view.publicHistory.length - 1; i >= 0; i -= 1) {
    const ev = view.publicHistory[i];
    if (!turnStart && ev.type === "STAMP_USED" && ev.actor === SIDES.INSPECTOR && ev.grantedSwap) {
      recoveredSwap = true;
    } else if (!turnStart && ev.type === "TURN_STARTED" && ev.offerer === SIDES.INSPECTOR) {
      turnStart = ev;
    } else if (ev.type === "TICKET_DRAWN") {
      prevDraw = ev;
      break;
    }
  }
  return Boolean(
    turnStart &&
      turnStart.offererSwapForfeited &&
      !recoveredSwap &&
      prevDraw &&
      prevDraw.drawer === SIDES.INSPECTOR &&
      prevDraw.drewUnlisted
  );
}

export function mountAppView(controller, doc = document) {
  const listeners = [];
  let resetConfirmArmed = false;

  function listen(target, event, handler) {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(event, handler);
    listeners.push(() => target.removeEventListener(event, handler));
  }

  function el(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setHidden(node, hide) {
    if (!node) return;
    node.classList.toggle("hidden", Boolean(hide));
  }

  const dom = {
    app: doc.getElementById("app"),
    encounterSubtitle: doc.getElementById("encounter-subtitle"),
    runHud: doc.getElementById("run-hud"),
    routeTrack: doc.getElementById("route-track"),
    matchScorePill: doc.getElementById("match-score-pill"),
    lanternMeter: doc.getElementById("lantern-meter"),
    stubsChip: doc.getElementById("stubs-chip"),
    seedChip: doc.getElementById("seed-chip"),
    navLockerBtn: doc.getElementById("nav-locker-btn"),
    navTutorialBtn: doc.getElementById("nav-tutorial-btn"),
    navRestartBtn: doc.getElementById("nav-restart-btn"),
    navTitleBtn: doc.getElementById("nav-title-btn"),
    reducedMotionToggle: doc.getElementById("reduced-motion-toggle"),

    // Screens
    titleScreen: doc.getElementById("title-screen"),
    lockerScreen: doc.getElementById("locker-screen"),
    briefingScreen: doc.getElementById("briefing-screen"),
    tableScreen: doc.getElementById("table-screen"),
    stopResultScreen: doc.getElementById("stop-result-screen"),
    rewardScreen: doc.getElementById("reward-screen"),
    runOverScreen: doc.getElementById("run-over-screen"),

    // Title controls
    titlePrimaryBtn: doc.getElementById("title-primary-btn"),
    titleSecondaryBtn: doc.getElementById("title-secondary-btn"),
    titleLockerBtn: doc.getElementById("title-locker-btn"),
    titleLoadoutBar: doc.getElementById("title-loadout-bar"),
    seedForm: doc.getElementById("seed-form"),
    seedInput: doc.getElementById("seed-input"),
    randomSeedBtn: doc.getElementById("random-seed-btn"),
    startSeededBtn: doc.getElementById("start-seeded-btn"),

    // Platform Locker controls
    lockerWallet: doc.getElementById("locker-wallet"),
    lockerNotice: doc.getElementById("locker-notice"),
    lockerGrid: doc.getElementById("locker-grid"),
    lockerBackBtn: doc.getElementById("locker-back-btn"),
    lockerStartRunBtn: doc.getElementById("locker-start-run-btn"),
    lockerResetBtn: doc.getElementById("locker-reset-btn"),

    // Briefing controls
    briefingKicker: doc.getElementById("briefing-kicker"),
    briefingTitle: doc.getElementById("briefing-title"),
    briefingStation: doc.getElementById("briefing-station"),
    briefingDesc: doc.getElementById("briefing-desc"),
    briefingFacts: doc.getElementById("briefing-facts"),
    briefingInspectorBox: doc.getElementById("briefing-inspector-box"),
    briefingInspectorNote: doc.getElementById("briefing-inspector-note"),
    briefingInspectorStamps: doc.getElementById("briefing-inspector-stamps"),
    briefingConditionBox: doc.getElementById("briefing-condition-box"),
    briefingConditionExpiry: doc.getElementById("briefing-condition-expiry"),
    briefingConditionName: doc.getElementById("briefing-condition-name"),
    briefingConditionRule: doc.getElementById("briefing-condition-rule"),
    briefingStampCount: doc.getElementById("briefing-stamp-count"),
    briefingToolsRow: doc.getElementById("briefing-tools-row"),
    briefingStampList: doc.getElementById("briefing-stamp-list"),
    beginDuelBtn: doc.getElementById("begin-duel-btn"),

    // Tutorial banner
    tutorialBanner: doc.getElementById("tutorial-banner"),
    tutorialStepPill: doc.getElementById("tutorial-step-pill"),
    skipTutorialBtn: doc.getElementById("skip-tutorial-btn"),
    tutorialTitle: doc.getElementById("tutorial-title"),
    tutorialBody: doc.getElementById("tutorial-body"),
    tutorialSummaryList: doc.getElementById("tutorial-summary-list"),
    tutorialNudge: doc.getElementById("tutorial-nudge"),
    tutorialActions: doc.getElementById("tutorial-actions"),
    tutorialNextBtn: doc.getElementById("tutorial-next-btn"),

    // Table controls
    conditionStrip: doc.getElementById("condition-strip"),
    inspectorTierBadge: doc.getElementById("inspector-tier-badge"),
    inspectorRole: doc.getElementById("inspector-role-badge"),
    inspectorCount: doc.getElementById("inspector-count"),
    inspectorRisk: doc.getElementById("inspector-risk-note"),
    inspectorStampsBar: doc.getElementById("inspector-stamps-bar"),
    inspectorFan: doc.getElementById("inspector-fan"),

    phaseTag: doc.getElementById("phase-tag"),
    phasePrompt: doc.getElementById("phase-prompt"),
    streakBox: doc.getElementById("streak-box"),
    streakPips: doc.getElementById("streak-pips"),
    streakCaption: doc.getElementById("streak-caption"),
    spotlightTray: doc.getElementById("spotlight-tray"),
    manifestCount: doc.getElementById("manifest-count"),
    manifestList: doc.getElementById("manifest-list"),

    playerRole: doc.getElementById("player-role-badge"),
    playerCount: doc.getElementById("player-count"),
    swapStatus: doc.getElementById("swap-status"),
    commitBtn: doc.getElementById("commit-offer-btn"),
    playerFan: doc.getElementById("player-fan"),
    toolsBar: doc.getElementById("tools-bar"),
    stampTrayHint: doc.getElementById("stamp-tray-hint"),
    stampTray: doc.getElementById("stamp-tray"),
    devTraceToggle: doc.getElementById("dev-trace-toggle"),

    // Deal / Stop result controls
    stopResultCard: doc.getElementById("stop-result-card"),
    stopResultKicker: doc.getElementById("stop-result-kicker"),
    stopResultTitle: doc.getElementById("stop-result-title"),
    stopResultScore: doc.getElementById("stop-result-score"),
    stopResultBody: doc.getElementById("stop-result-body"),
    stopResultLanterns: doc.getElementById("stop-result-lanterns"),
    stopContinueBtn: doc.getElementById("stop-continue-btn"),

    // Reward / Departure Draft controls
    rewardKicker: doc.getElementById("reward-kicker"),
    rewardTitle: doc.getElementById("reward-title"),
    rewardSub: doc.getElementById("reward-sub"),
    rewardCurrentBox: doc.getElementById("reward-current-box"),
    rewardSlotsLabel: doc.getElementById("reward-slots-label"),
    cancelReplaceBtn: doc.getElementById("cancel-replace-btn"),
    rewardCurrentSlots: doc.getElementById("reward-current-slots"),
    rewardGrid: doc.getElementById("reward-grid"),
    rerollRewardBtn: doc.getElementById("reroll-reward-btn"),
    skipRewardBtn: doc.getElementById("skip-reward-btn"),

    // Run over controls
    runOverCard: doc.getElementById("run-over-card"),
    runOverKicker: doc.getElementById("run-over-kicker"),
    runOverTitle: doc.getElementById("run-over-title"),
    runOverBody: doc.getElementById("run-over-body"),
    runPayoutBox: doc.getElementById("run-payout-box"),
    runSummaryGrid: doc.getElementById("run-summary-grid"),
    runHistoryList: doc.getElementById("run-history-list"),
    runOverLockerBtn: doc.getElementById("run-over-locker-btn"),
    replaySeedBtn: doc.getElementById("replay-seed-btn"),
    freshRunBtn: doc.getElementById("fresh-run-btn"),
    runOverTutorialBtn: doc.getElementById("run-over-tutorial-btn"),
    runOverTitleBtn: doc.getElementById("run-over-title-btn"),

    // Dev trace
    devTracePanel: doc.getElementById("dev-trace-panel"),
    devTraceTitle: doc.getElementById("dev-trace-title"),
    devTraceMeta: doc.getElementById("dev-trace-meta"),
    devTraceSummary: doc.getElementById("dev-trace-summary"),
    devBuckets: doc.getElementById("dev-buckets"),
    devTraceList: doc.getElementById("dev-trace-list"),
  };

  // -------------------------
  // Control Wire-up
  // -------------------------

  function readSeedField() {
    return dom.seedInput ? dom.seedInput.value : controller.getSnapshot().runSeed;
  }

  listen(dom.titlePrimaryBtn, "click", () => {
    const snap = controller.getSnapshot();
    const seed = readSeedField();
    if (!snap.hasCompletedTutorial) {
      controller.startTutorial({ seed });
    } else {
      controller.startRun({ seed, withTutorial: false });
    }
  });

  listen(dom.titleSecondaryBtn, "click", () => {
    const snap = controller.getSnapshot();
    const seed = readSeedField();
    if (!snap.hasCompletedTutorial) {
      controller.skipTutorial();
      if (seed && seed.trim() && seed.trim() !== snap.runSeed) {
        controller.startRun({ seed, withTutorial: false });
      }
    } else {
      controller.startTutorial({ seed });
    }
  });

  listen(dom.titleLockerBtn, "click", () => {
    resetConfirmArmed = false;
    controller.openLocker();
  });

  listen(dom.navLockerBtn, "click", () => {
    resetConfirmArmed = false;
    controller.openLocker();
  });

  listen(dom.lockerBackBtn, "click", () => {
    resetConfirmArmed = false;
    controller.closeLocker();
  });

  listen(dom.lockerStartRunBtn, "click", () => {
    resetConfirmArmed = false;
    const snap = controller.getSnapshot();
    if (snap.lockerReturnScreen === RUN_SCREENS.RUN_OVER) {
      controller.startFreshRandomRun();
    } else {
      controller.startRun({ seed: snap.runSeed, withTutorial: false });
    }
  });

  listen(dom.lockerResetBtn, "click", () => {
    if (!resetConfirmArmed) {
      resetConfirmArmed = true;
      if (dom.lockerResetBtn) {
        dom.lockerResetBtn.textContent = "Confirm Reset (Erase Stubs & Keepsakes)";
      }
      return;
    }
    resetConfirmArmed = false;
    controller.resetLockerProgress();
  });

  listen(dom.seedForm, "submit", (ev) => {
    ev.preventDefault();
    controller.startRun({ seed: readSeedField(), withTutorial: false });
  });

  listen(dom.randomSeedBtn, "click", () => {
    const res = controller.setSeed("", { allowRandom: true });
    if (res.ok && dom.seedInput) {
      dom.seedInput.value = res.runSeed;
    }
  });

  listen(dom.navTutorialBtn, "click", () => {
    controller.startTutorial();
  });

  listen(dom.navRestartBtn, "click", () => {
    controller.restartRun();
  });

  listen(dom.navTitleBtn, "click", () => {
    controller.openTitle();
  });

  listen(dom.reducedMotionToggle, "change", () => {
    controller.setReducedMotion(dom.reducedMotionToggle.checked);
  });

  listen(dom.beginDuelBtn, "click", () => {
    controller.beginStopDuel();
  });

  listen(dom.skipTutorialBtn, "click", () => {
    controller.skipTutorial();
  });

  listen(dom.tutorialNextBtn, "click", () => {
    controller.tutorialAcknowledge();
  });

  listen(dom.commitBtn, "click", () => {
    controller.commitOffer();
  });

  listen(dom.stopContinueBtn, "click", () => {
    controller.continueAfterStop();
  });

  listen(dom.cancelReplaceBtn, "click", () => {
    controller.cancelRewardReplacement();
  });

  listen(dom.rerollRewardBtn, "click", () => {
    controller.rerollRewardChoices();
  });

  listen(dom.skipRewardBtn, "click", () => {
    controller.skipReward();
  });

  listen(dom.runOverLockerBtn, "click", () => {
    resetConfirmArmed = false;
    controller.openLocker();
  });

  listen(dom.replaySeedBtn, "click", () => {
    controller.restartRun();
  });

  listen(dom.freshRunBtn, "click", () => {
    controller.startFreshRandomRun();
  });

  listen(dom.runOverTutorialBtn, "click", () => {
    controller.startTutorial();
  });

  listen(dom.runOverTitleBtn, "click", () => {
    controller.openTitle();
  });

  listen(dom.devTraceToggle, "click", () => {
    controller.toggleDevTrace();
  });

  // -------------------------
  // Full Keyboard Navigation
  // -------------------------

  function getActiveFanButtons() {
    const snap = controller.getSnapshot();
    if (
      (snap.screen !== RUN_SCREENS.DUEL && snap.screen !== RUN_SCREENS.TUTORIAL) ||
      snap.inputLocked ||
      !snap.view
    ) {
      return [];
    }
    if (snap.activeStampTargeting) {
      const container =
        snap.activeStampTargeting.targetType === "OWN_ORDINARY_SLOT"
          ? dom.playerFan
          : dom.inspectorFan;
      return container ? Array.from(container.querySelectorAll("button:not(:disabled)")) : [];
    }
    const { view } = snap;
    if (view.phase === PHASES.DRAW && view.drawer === SIDES.PLAYER) {
      return dom.inspectorFan
        ? Array.from(dom.inspectorFan.querySelectorAll("button:not(:disabled)"))
        : [];
    }
    if (view.phase === PHASES.OFFER && view.offerer === SIDES.PLAYER) {
      return dom.playerFan
        ? Array.from(dom.playerFan.querySelectorAll("button:not(:disabled)"))
        : [];
    }
    return [];
  }

  listen(doc, "keydown", (ev) => {
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

    if (ev.altKey && (ev.key === "d" || ev.key === "D")) {
      ev.preventDefault();
      controller.toggleDevTrace();
      return;
    }

    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

    const snap = controller.getSnapshot();

    if (ev.key === "Escape") {
      if (snap.activeStampTargeting) {
        ev.preventDefault();
        controller.cancelStampTargeting();
      } else if (snap.screen === RUN_SCREENS.REWARD && snap.reward?.pendingReplaceStamp) {
        ev.preventDefault();
        controller.cancelRewardReplacement();
      } else if (snap.screen === RUN_SCREENS.LOCKER) {
        ev.preventDefault();
        controller.closeLocker();
      }
      return;
    }

    if (snap.screen === RUN_SCREENS.DUEL || snap.screen === RUN_SCREENS.TUTORIAL) {
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        const buttons = getActiveFanButtons();
        if (buttons.length === 0) return;
        ev.preventDefault();
        const currentIdx = buttons.indexOf(doc.activeElement);
        const delta = ev.key === "ArrowRight" ? 1 : -1;
        const nextIdx =
          currentIdx === -1
            ? delta > 0
              ? 0
              : buttons.length - 1
            : (currentIdx + delta + buttons.length) % buttons.length;
        buttons[nextIdx].focus();
        return;
      }

      if ((ev.key === "c" || ev.key === "C") && !snap.inputLocked && snap.view) {
        if (snap.view.phase === PHASES.OFFER && snap.view.offerer === SIDES.PLAYER) {
          ev.preventDefault();
          controller.commitOffer();
        }
        return;
      }

      if (snap.screen === RUN_SCREENS.DUEL && !snap.inputLocked && snap.view) {
        if ((ev.key === "g" || ev.key === "G") && snap.view.legal.canUseGauge) {
          ev.preventDefault();
          controller.activateGauge();
          return;
        }
        if (
          (ev.key === "e" || ev.key === "E") &&
          (snap.view.legal.canCheckEdge || snap.activeStampTargeting?.targetType === "EDGE_CHECK")
        ) {
          ev.preventDefault();
          controller.activateCheckEdge();
          return;
        }
      }

      if (ev.key === "1" || ev.key === "2" || ev.key === "3") {
        const idx = Number.parseInt(ev.key, 10) - 1;
        const st = snap.view?.legal?.stampStatuses?.[idx];
        if (st && (st.canUse || snap.activeStampTargeting?.stampId === st.id)) {
          ev.preventDefault();
          controller.activateStamp(st.id);
        }
      }
    }
  });

  // -------------------------
  // Rendering Helpers
  // -------------------------

  function renderLanternPips(container, lit, max, extraText) {
    clear(container);
    for (let i = 0; i < max; i += 1) {
      const isLit = i < lit;
      const pip = el(
        "span",
        `lantern-pip ${isLit ? "is-lit" : "is-out"}`,
        isLit ? "✦" : "·"
      );
      pip.setAttribute("aria-hidden", "true");
      container.appendChild(pip);
    }
    container.appendChild(
      el("span", "lantern-text", extraText || `${lit}/${max} Lanterns`)
    );
  }

  function formatMatchLabel(dealsRequired) {
    if (dealsRequired <= 1) return "Single Deal";
    const bestOf = dealsRequired * 2 - 1;
    return `First to ${dealsRequired} Deals (Best of ${bestOf})`;
  }

  function renderTopBar(snap) {
    if (dom.app) {
      dom.app.classList.toggle("reduced-motion", Boolean(snap.reducedMotion));
    }
    if (dom.reducedMotionToggle) {
      dom.reducedMotionToggle.checked = Boolean(snap.reducedMotion);
    }
    if (dom.seedChip) {
      dom.seedChip.textContent = `Seed: ${snap.runSeed}`;
    }
    if (dom.stubsChip && snap.meta) {
      dom.stubsChip.textContent = `◈ ${snap.meta.stubs} ${
        snap.meta.stubs === 1 ? "Stub" : "Stubs"
      }`;
      dom.stubsChip.classList.toggle("has-unlock", snap.meta.affordableCount > 0);
    }

    const inTitle = snap.screen === RUN_SCREENS.TITLE;
    const inLocker = snap.screen === RUN_SCREENS.LOCKER;
    const inTutorial = snap.screen === RUN_SCREENS.TUTORIAL;
    const showRunHud = !inTitle && !inLocker && !inTutorial;

    setHidden(dom.runHud, !showRunHud);
    setHidden(
      dom.navLockerBtn,
      inLocker || (!inTitle && snap.screen !== RUN_SCREENS.RUN_OVER)
    );
    if (dom.navLockerBtn && snap.meta) {
      dom.navLockerBtn.textContent =
        snap.meta.affordableCount > 0
          ? `Locker (${snap.meta.affordableCount}!)`
          : "Locker";
      dom.navLockerBtn.classList.toggle("has-alert", snap.meta.affordableCount > 0);
    }
    setHidden(dom.navRestartBtn, inTitle || inLocker || inTutorial);
    setHidden(dom.navTitleBtn, inTitle);
    setHidden(dom.navTutorialBtn, inTutorial || inLocker);

    if (dom.encounterSubtitle) {
      if (inTitle) {
        dom.encounterSubtitle.textContent = "Midnight Line · 5-Stop Roguelike Duel";
      } else if (inLocker) {
        dom.encounterSubtitle.textContent = "Terminus Underpass · Platform Locker";
      } else if (inTutorial) {
        dom.encounterSubtitle.textContent = "Practice Stop · Interactive Tutorial";
      } else if (snap.screen === RUN_SCREENS.STARTER_DRAFT) {
        dom.encounterSubtitle.textContent = "Platform Departure · Starter Stamp Draft";
      } else if (snap.screen === RUN_SCREENS.RUN_OVER) {
        dom.encounterSubtitle.textContent =
          snap.runOutcome === RUN_OUTCOMES.VICTORY
            ? "Terminus Reached · Run Victory"
            : "Lanterns Extinguished · Run Ended";
      } else {
        const rem =
          snap.carriage.isFinalInspection && snap.rematchCount > 0
            ? ` (Rematch #${snap.rematchCount})`
            : "";
        dom.encounterSubtitle.textContent = `Stop ${snap.stopNumber}/${snap.totalStops} · ${snap.carriage.name}${rem}`;
      }
    }

    if (showRunHud && dom.routeTrack && dom.lanternMeter) {
      clear(dom.routeTrack);
      for (const car of snap.carriages) {
        const records = snap.stopHistory.filter((h) => h.stopIndex === car.stopIndex);
        const wonRecord = records.some((r) => r.won);
        const lostAndMovedOn =
          !wonRecord && records.length > 0 && car.stopIndex < snap.stopIndex;
        const isCurrent =
          snap.screen !== RUN_SCREENS.RUN_OVER && car.stopIndex === snap.stopIndex;

        let cls = "route-node";
        let mark = "";
        if (isCurrent) {
          cls += " is-current";
          mark = "▸ ";
        } else if (wonRecord) {
          cls += " is-won";
          mark = "✓ ";
        } else if (lostAndMovedOn) {
          cls += " is-passed-loss";
          mark = "− ";
        }

        const label = car.isFinalInspection
          ? `${mark}V★`
          : `${mark}${car.code.replace("CAR ", "")}`;
        const li = el("li", cls, label);
        li.title = `Stop ${car.stopNumber}: ${car.name} (${car.pairCount} pairs, first to ${car.dealsToWin})`;
        dom.routeTrack.appendChild(li);
      }

      const showMatchScore =
        snap.dealsRequired > 1 &&
        (snap.screen === RUN_SCREENS.DUEL ||
          (snap.screen === RUN_SCREENS.STOP_RESULT &&
            snap.lastStopSummary?.kind === "DEAL_CONTINUE"));
      setHidden(dom.matchScorePill, !showMatchScore);
      if (dom.matchScorePill && showMatchScore) {
        const matchTag = snap.emergencyMatchesLeft > 0 ? " · 🔥1" : "";
        dom.matchScorePill.textContent = `Deals: You ${snap.dealWins}–${snap.dealLosses} Insp (to ${snap.dealsRequired})${matchTag}`;
        dom.matchScorePill.title = `Win ${snap.dealsRequired} deals to clear ${snap.carriage.name}${
          snap.emergencyMatchesLeft > 0 ? " · 1 Emergency Match ready" : ""
        }`;
      }

      renderLanternPips(dom.lanternMeter, snap.lanterns, snap.maxLanterns);
    }
  }

  function renderTitleScreen(snap) {
    if (dom.seedInput && doc.activeElement !== dom.seedInput) {
      dom.seedInput.value = snap.runSeed;
    }
    if (dom.titlePrimaryBtn && dom.titleSecondaryBtn) {
      if (!snap.hasCompletedTutorial) {
        dom.titlePrimaryBtn.textContent = "Play Interactive Tutorial (2 min)";
        dom.titleSecondaryBtn.textContent = "Start Run (Skip Tutorial)";
      } else {
        dom.titlePrimaryBtn.textContent = "Board Midnight Line — Start Run";
        dom.titleSecondaryBtn.textContent = "Play Interactive Tutorial";
      }
    }

    if (dom.titleLockerBtn && snap.meta) {
      const m = snap.meta;
      if (m.keystoneReadyToBuy) {
        dom.titleLockerBtn.textContent = `★ Unlock Perforation Gauge! (◈ ${m.stubs})`;
      } else if (m.affordableCount > 0) {
        dom.titleLockerBtn.textContent = `Platform Locker · ◈ ${m.stubs} (${m.affordableCount} ready!)`;
      } else {
        dom.titleLockerBtn.textContent = `Platform Locker · ◈ ${m.stubs} (${m.unlockedIds.length}/${m.items.length})`;
      }
      dom.titleLockerBtn.classList.toggle("has-alert", m.affordableCount > 0);
    }

    if (dom.titleLoadoutBar && snap.meta) {
      clear(dom.titleLoadoutBar);
      const activeItems = snap.meta.items.filter((it) => it.active);
      if (activeItems.length === 0) {
        const msg =
          snap.meta.runsCompleted === 0
            ? "Active Coat Pocket: Empty — early runs against the Inspector are harsh. Every run earns ◈ Punched Stubs for the Locker."
            : `Active Coat Pocket: Empty (${snap.meta.stubs} ◈ Stubs saved · ${snap.meta.runsCompleted} ${
                snap.meta.runsCompleted === 1 ? "run" : "runs"
              } logged).`;
        dom.titleLoadoutBar.appendChild(el("span", "loadout-empty-note", msg));
      } else {
        dom.titleLoadoutBar.appendChild(el("span", "loadout-label", "Equipped Keepsakes:"));
        for (const it of activeItems) {
          dom.titleLoadoutBar.appendChild(
            el(
              "span",
              `loadout-pill ${it.isKeystone ? "is-keystone" : ""}`,
              `${it.glyph} ${it.name}`
            )
          );
        }
      }
    }
  }

  function renderLockerScreen(snap) {
    const m = snap.meta;
    if (!m) return;

    if (dom.lockerWallet) {
      clear(dom.lockerWallet);
      dom.lockerWallet.appendChild(
        el("div", "wallet-stubs", `◈ ${m.stubs} Punched ${m.stubs === 1 ? "Stub" : "Stubs"}`)
      );
      const bestText = m.bestStopReached > 0 ? `Stop ${m.bestStopReached}/5` : "—";
      dom.lockerWallet.appendChild(
        el(
          "div",
          "wallet-stats",
          `Runs: ${m.runsCompleted} · Cleared: ${m.runsWon} · Best: ${bestText}`
        )
      );
    }

    setHidden(dom.lockerNotice, !snap.lockerNotice);
    if (dom.lockerNotice && snap.lockerNotice) {
      dom.lockerNotice.textContent = snap.lockerNotice;
    }

    if (dom.lockerResetBtn && !resetConfirmArmed) {
      dom.lockerResetBtn.textContent = "Reset Locker Progress";
    }

    if (dom.lockerGrid) {
      clear(dom.lockerGrid);
      for (const item of m.items) {
        const card = el("article", "keepsake-card");
        if (item.isKeystone) card.classList.add("is-keystone");
        if (item.unlocked && item.active) card.classList.add("is-active");
        else if (item.unlocked && !item.active) card.classList.add("is-stowed");
        else if (item.canBuy) card.classList.add("is-affordable");
        else card.classList.add("is-locked");

        const top = el("div", "keepsake-top");
        const metaRow = el("div", "keepsake-meta-row");
        metaRow.appendChild(
          el(
            "span",
            `keepsake-tier ${item.isKeystone ? "is-keystone" : ""}`,
            item.tierLabel
          )
        );
        const stateText = item.unlocked
          ? item.active
            ? "✓ ACTIVE"
            : "STOWED"
          : `◈ ${item.cost} Stubs`;
        metaRow.appendChild(el("span", "keepsake-cost", stateText));
        top.appendChild(metaRow);

        top.appendChild(el("h3", "keepsake-name", `${item.glyph} ${item.name}`));
        top.appendChild(el("p", "keepsake-effect", item.shortEffect));
        top.appendChild(el("p", "keepsake-flavor", item.flavor));

        // Progress bar on the Keystone Perforation Gauge before unlock!
        if (item.isKeystone && !item.unlocked) {
          const pct = Math.min(100, Math.round((m.stubs / item.cost) * 100));
          const progWrap = el("div", "keystone-progress-wrap");
          const barOuter = el("div", "keystone-progress-bar");
          const barFill = el("div", "keystone-progress-fill");
          barFill.style.width = `${pct}%`;
          barOuter.appendChild(barFill);
          progWrap.appendChild(barOuter);
          progWrap.appendChild(
            el(
              "span",
              "keystone-progress-label",
              `${Math.min(m.stubs, item.cost)} / ${item.cost} ◈ Stubs toward breakthrough`
            )
          );
          top.appendChild(progWrap);
        }

        card.appendChild(top);

        const actionRow = el("div", "keepsake-actions");
        if (item.unlocked) {
          const toggleBtn = el(
            "button",
            `btn btn-sm ${item.active ? "btn-subtle" : "btn-brass"}`,
            item.active ? "Equipped ✓ (Click to Stow)" : "Stowed — Click to Equip"
          );
          toggleBtn.type = "button";
          listen(toggleBtn, "click", () => controller.toggleKeepsake(item.id));
          actionRow.appendChild(toggleBtn);
        } else if (item.canBuy) {
          const buyBtn = el(
            "button",
            "btn btn-brass",
            item.isKeystone
              ? `★ Unlock ${item.name} (◈ ${item.cost})`
              : `Unlock for ◈ ${item.cost} Stubs`
          );
          buyBtn.type = "button";
          listen(buyBtn, "click", () => controller.buyKeepsake(item.id));
          actionRow.appendChild(buyBtn);
        } else {
          const lockBtn = el("button", "btn btn-subtle", item.lockReason || `◈ ${item.cost}`);
          lockBtn.type = "button";
          lockBtn.disabled = true;
          actionRow.appendChild(lockBtn);
        }
        card.appendChild(actionRow);

        dom.lockerGrid.appendChild(card);
      }
    }
  }

  function renderBriefingScreen(snap) {
    const b = snap.briefing;
    if (!b) return;
    const { carriage, condition } = b;

    if (dom.briefingKicker) {
      if (carriage.isFinalInspection) {
        dom.briefingKicker.textContent =
          b.rematchCount > 0
            ? `STOP 5 OF 5 · FINAL INSPECTION (REMATCH #${b.rematchCount})`
            : "STOP 5 OF 5 · FINAL INSPECTION";
      } else {
        dom.briefingKicker.textContent = `STOP ${carriage.stopNumber} OF ${snap.totalStops} · ${carriage.code}`;
      }
    }
    if (dom.briefingTitle) dom.briefingTitle.textContent = carriage.name;
    if (dom.briefingStation) dom.briefingStation.textContent = `Station: ${carriage.stationName}`;
    if (dom.briefingDesc) dom.briefingDesc.textContent = carriage.arrivalNote;

    if (dom.briefingFacts) {
      clear(dom.briefingFacts);
      const chips = [
        `Match: ${formatMatchLabel(b.dealsRequired)}`,
        `${carriage.pairCount} Pairs + Unlisted (${carriage.pairCount * 2 + 1} cards)`,
        b.playerDrawsFirst ? "Deal 1: You Draw 1st" : "Deal 1: You Offer 1st",
        `Inspector: T${b.tier} · ${b.tierName}`,
        `Lanterns: ${snap.lanterns}/${snap.maxLanterns}`,
      ];
      for (const text of chips) {
        dom.briefingFacts.appendChild(el("span", "fact-chip", text));
      }
    }

    // Inspector's Stamp Kit (showing live + jammed Stamps!)
    const totalInspStamps =
      (b.inspectorActiveStamps?.length || 0) + (b.inspectorJammedStamps?.length || 0);
    setHidden(dom.briefingInspectorBox, totalInspStamps === 0);
    if (dom.briefingInspectorBox && totalInspStamps > 0) {
      if (dom.briefingInspectorNote) {
        const jCount = b.inspectorJammedStamps.length;
        dom.briefingInspectorNote.textContent =
          jCount > 0
            ? `${b.inspectorActiveStamps.length} active · ${jCount} jammed by Locker!`
            : `${b.inspectorActiveStamps.length} active — punish his tradeoffs`;
      }
      if (dom.briefingInspectorStamps) {
        clear(dom.briefingInspectorStamps);
        for (const st of b.inspectorJammedStamps) {
          if (!st) continue;
          const pill = el("span", "insp-stamp-pill is-jammed", `✕ ${st.name} (JAMMED)`);
          pill.title = `Jammed by your Platform Locker gear — cannot be used this stop!`;
          dom.briefingInspectorStamps.appendChild(pill);
        }
        for (const st of b.inspectorActiveStamps) {
          if (!st) continue;
          const pill = el("span", "insp-stamp-pill", `${st.glyph} ${st.name}`);
          pill.title = `${st.shortBenefit} Tradeoff: ${st.shortTradeoff}`;
          dom.briefingInspectorStamps.appendChild(pill);
        }
      }
    }

    if (dom.briefingConditionBox) {
      dom.briefingConditionBox.classList.toggle(
        "is-clear",
        condition.id === CONDITION_IDS.CLEAR_LINE
      );
    }
    if (dom.briefingConditionName) {
      dom.briefingConditionName.textContent = `${condition.glyph} ${condition.name}`;
    }
    if (dom.briefingConditionRule) {
      dom.briefingConditionRule.textContent = condition.ruleSummary;
    }
    if (dom.briefingConditionExpiry) {
      dom.briefingConditionExpiry.textContent = condition.expirySummary;
    }

    if (dom.briefingStampCount) {
      dom.briefingStampCount.textContent = `${snap.equippedStamps.length} / ${snap.maxStampSlots} slots`;
    }

    // Active Locker Tools summary row
    if (dom.briefingToolsRow) {
      clear(dom.briefingToolsRow);
      const toolPills = [];
      if (snap.runBonuses?.gaugeChargesPerDeal > 0) {
        toolPills.push(
          `⌖ Perforation Gauge (${snap.runBonuses.gaugeChargesPerDeal}/deal · key G)`
        );
      }
      if (snap.runBonuses?.edgeChecksPerDeal > 0) {
        toolPills.push(`◫ Check Edge (${snap.runBonuses.edgeChecksPerDeal}/deal · key E)`);
      }
      if (snap.emergencyMatchesLeft > 0) {
        toolPills.push(`🔥 Emergency Match (${snap.emergencyMatchesLeft} left)`);
      }
      if (b.starterGiftStamp) {
        toolPills.push(`Starter Stamp inked: ${b.starterGiftStamp.name}`);
      }
      setHidden(dom.briefingToolsRow, toolPills.length === 0);
      for (const txt of toolPills) {
        dom.briefingToolsRow.appendChild(el("span", "tool-summary-pill", txt));
      }
    }

    if (dom.briefingStampList) {
      clear(dom.briefingStampList);
      for (let i = 0; i < snap.maxStampSlots; i += 1) {
        const st = snap.equippedStamps[i];
        if (!st) {
          dom.briefingStampList.appendChild(
            el("div", "mini-stamp-slot is-empty", `Slot ${i + 1} · Empty`)
          );
        } else {
          const box = el("div", "mini-stamp-slot");
          box.appendChild(el("span", "mini-stamp-name", `${st.glyph} ${st.name}`));
          box.appendChild(el("span", "mini-stamp-meta", st.timingLabel));
          dom.briefingStampList.appendChild(box);
        }
      }
    }

    if (dom.beginDuelBtn) {
      dom.beginDuelBtn.textContent =
        b.dealsRequired > 1
          ? `Take Your Seat — Deal 1 of ${b.dealsRequired * 2 - 1}`
          : "Take Your Seat — Deal Tickets";
    }
  }

  function createTicketNode({
    zone,
    slotIndex,
    totalSlots,
    isInteractive,
    isStampTarget,
    stampTargetLabel,
    isTutorialTarget,
    isSelected,
    isFaceUp,
    ticketMeta,
    lockReason,
    publicReveal,
    privateReveal,
    willExposeOnCommit,
    emblemHookLabel,
    loupeState, // null | "DANGER" | "SAFE"
    gaugeSafe,
    edgeClueState, // null | "EMBLEM_SAFE" | "PLAIN_OR_BLANK" | "DEDUCED_UNLISTED"
    edgeCheckedPublic,
    pinnedUnlistedHint,
    wasSwapped,
    isNewlyArrivedUnlisted,
    onActivate,
    ariaContext,
  }) {
    const node = el(isInteractive || isStampTarget ? "button" : "div", "ticket-card");
    if (isInteractive || isStampTarget) {
      node.type = "button";
    }
    if (zone) node.dataset.zone = zone;
    node.dataset.slot = String(slotIndex);
    // Presentation layer reads these to swap in the procedural ticket art.
    if (isFaceUp && ticketMeta) {
      node.dataset.symbol = ticketMeta.isUnlisted ? "UNLISTED" : ticketMeta.symbolId || "";
      node.dataset.emblem = ticketMeta.isEmblem ? "1" : "0";
    }
    node.classList.add(isFaceUp ? "is-face-up" : "is-face-down");
    if (ticketMeta?.isUnlisted) node.classList.add("is-unlisted");
    if (isInteractive) node.classList.add("is-interactive");
    if (isStampTarget) node.classList.add("is-stamp-target");
    if (isTutorialTarget) node.classList.add("tutorial-target");
    if (isSelected) node.classList.add("is-selected");
    if (lockReason === "FINAL_CALL") node.classList.add("is-locked");
    if (lockReason === "BRASS_WEIGHT") node.classList.add("is-weight-locked");
    if (
      loupeState === "DANGER" ||
      edgeClueState === "DEDUCED_UNLISTED" ||
      pinnedUnlistedHint
    ) {
      node.classList.add("is-loupe-danger");
    } else if (
      loupeState === "SAFE" ||
      gaugeSafe ||
      edgeClueState === "EMBLEM_SAFE"
    ) {
      node.classList.add("is-loupe-safe");
    }

    const top = el("div", "ticket-top");
    top.appendChild(el("span", "slot-num", `#${slotIndex + 1}`));
    if (isFaceUp && ticketMeta?.isEmblem) {
      const star = el("span", "emblem-star", "★ EMB");
      star.title = "Marked Emblem Pair (triggers Emblem Stamps)";
      top.appendChild(star);
    }
    node.appendChild(top);

    if (isFaceUp && ticketMeta) {
      if (ticketMeta.isUnlisted) {
        const hole = el("div", "punch-hole");
        hole.setAttribute("aria-hidden", "true");
        node.appendChild(hole);
      } else {
        const g = el("div", "ticket-glyph", ticketMeta.glyph);
        g.setAttribute("aria-hidden", "true");
        node.appendChild(g);
      }
      node.appendChild(el("div", "ticket-name", ticketMeta.shortLabel));
      node.appendChild(el("div", "ticket-code", ticketMeta.code));
    } else {
      const g = el("div", "ticket-glyph", "❖");
      g.setAttribute("aria-hidden", "true");
      node.appendChild(g);
      node.appendChild(el("div", "ticket-name", "Manifest"));
      node.appendChild(el("div", "ticket-code", "FACE DOWN"));
    }

    const badges = el("div", "ticket-badges");
    if (isTutorialTarget) {
      badges.appendChild(el("span", "card-flag flag-target", "CLICK HERE"));
    } else if (isStampTarget) {
      badges.appendChild(el("span", "card-flag flag-target", stampTargetLabel || "SELECT"));
    }
    if (lockReason === "FINAL_CALL") {
      badges.appendChild(el("span", "card-flag flag-lock", "Final Call · Lock"));
    } else if (lockReason === "BRASS_WEIGHT") {
      badges.appendChild(el("span", "card-flag flag-weight", "Weighted · Lock"));
    }
    if (publicReveal) {
      badges.appendChild(el("span", "card-flag flag-reveal", "Exposed"));
    } else if (willExposeOnCommit) {
      badges.appendChild(el("span", "card-flag flag-reveal", "Will Expose"));
    }
    if (privateReveal) {
      badges.appendChild(el("span", "card-flag flag-peek", "Peeked (You)"));
    }
    if (gaugeSafe) {
      badges.appendChild(el("span", "card-flag flag-safe", "⌖ Gauge: Safe ✓"));
    }
    if (edgeClueState === "EMBLEM_SAFE") {
      badges.appendChild(el("span", "card-flag flag-safe", "★ Emblem · Safe ✓"));
    } else if (edgeClueState === "DEDUCED_UNLISTED") {
      badges.appendChild(el("span", "card-flag flag-lock", "⚠ Unlisted (Deduced)"));
    } else if (edgeClueState === "PLAIN_OR_BLANK") {
      badges.appendChild(el("span", "card-flag flag-reveal", "◫ Plain / Blank"));
    } else if (edgeCheckedPublic && zone === "player") {
      badges.appendChild(el("span", "card-flag flag-reveal", "Edge Checked"));
    }
    if (pinnedUnlistedHint && !privateReveal && !publicReveal) {
      badges.appendChild(el("span", "card-flag flag-lock", "⚠ No Swap: Unlisted!"));
    }
    if (emblemHookLabel) {
      badges.appendChild(el("span", "card-flag flag-safe", emblemHookLabel));
    }
    if (loupeState === "DANGER") {
      badges.appendChild(el("span", "card-flag flag-lock", "Loupe: Unlisted?"));
    } else if (loupeState === "SAFE" && !gaugeSafe) {
      badges.appendChild(el("span", "card-flag flag-safe", "Loupe: Safe ✓"));
    }
    if (isSelected) {
      badges.appendChild(el("span", "card-flag flag-swap", "Selected"));
    } else if (wasSwapped) {
      badges.appendChild(el("span", "card-flag flag-swap", "Swapped"));
    }
    if (isNewlyArrivedUnlisted) {
      badges.appendChild(el("span", "card-flag flag-new", "Just Drawn"));
    }
    if (badges.childNodes.length > 0) {
      node.appendChild(badges);
    }

    const labelParts = [`Slot ${slotIndex + 1} of ${totalSlots}`];
    if (isFaceUp && ticketMeta) {
      labelParts.push(ticketMeta.name);
      if (ticketMeta.isEmblem) labelParts.push("Marked Emblem ticket");
    } else {
      labelParts.push("Face-down ticket");
    }
    if (lockReason) labelParts.push(`Locked (${lockReason})`);
    if (publicReveal) labelParts.push("Publicly exposed");
    else if (willExposeOnCommit) labelParts.push("Will be publicly exposed when committed");
    if (privateReveal) labelParts.push("Privately peeked by you");
    if (gaugeSafe) labelParts.push("Perforation Gauge confirmed safe pair");
    if (edgeClueState === "EMBLEM_SAFE") labelParts.push("Check Edge confirmed Emblem safe pair");
    if (edgeClueState === "DEDUCED_UNLISTED") labelParts.push("Deduced to be The Unlisted");
    if (edgeClueState === "PLAIN_OR_BLANK") labelParts.push("Check Edge: plain or blank stock");
    if (pinnedUnlistedHint) labelParts.push("Inspector could not swap after drawing The Unlisted");
    if (emblemHookLabel) labelParts.push(emblemHookLabel);
    if (loupeState === "DANGER") labelParts.push("Manifest Loupe: Unlisted in this pair");
    if (loupeState === "SAFE") labelParts.push("Manifest Loupe: Confirmed safe");
    if (ariaContext) labelParts.push(ariaContext);
    node.setAttribute("aria-label", labelParts.join(", "));
    if (isSelected) node.setAttribute("aria-pressed", "true");

    if ((isInteractive || isStampTarget) && typeof onActivate === "function") {
      listen(node, "click", onActivate);
    }

    return node;
  }

  function renderTableScreen(snap) {
    const { view, tutorial, activeStampTargeting } = snap;
    if (!view) return;
    const isTutorial = snap.screen === RUN_SCREENS.TUTORIAL;
    const tutHighlight = tutorial?.highlight || null;

    // 1. Tutorial guide banner
    setHidden(dom.tutorialBanner, !isTutorial);
    if (isTutorial && tutorial) {
      if (dom.tutorialStepPill) {
        dom.tutorialStepPill.textContent = `TUTORIAL · STEP ${tutorial.stepNumber} OF ${tutorial.totalSteps}`;
      }
      if (dom.tutorialTitle) dom.tutorialTitle.textContent = tutorial.title;
      if (dom.tutorialBody) dom.tutorialBody.textContent = tutorial.body;

      if (dom.tutorialSummaryList) {
        clear(dom.tutorialSummaryList);
        const hasBullets =
          Array.isArray(tutorial.summaryBullets) && tutorial.summaryBullets.length > 0;
        setHidden(dom.tutorialSummaryList, !hasBullets);
        if (hasBullets) {
          for (const b of tutorial.summaryBullets) {
            dom.tutorialSummaryList.appendChild(el("li", null, b));
          }
        }
      }

      setHidden(dom.tutorialNudge, !tutorial.nudgeMessage);
      if (dom.tutorialNudge && tutorial.nudgeMessage) {
        dom.tutorialNudge.textContent = tutorial.nudgeMessage;
      }

      const showNext = Boolean(tutorial.actionLabel);
      setHidden(dom.tutorialActions, !showNext);
      if (dom.tutorialNextBtn && showNext) {
        dom.tutorialNextBtn.textContent = tutorial.actionLabel;
        dom.tutorialNextBtn.classList.toggle(
          "tutorial-target",
          tutHighlight?.zone === "acknowledge" || tutHighlight?.zone === "finish"
        );
      }
    }

    // 2. Live Condition, Your Tradeoffs & Exploitable Inspector Tradeoffs!
    const inspPinnedRight = !isTutorial && inspectorPinnedUnlistedAtRight(view);
    if (dom.conditionStrip) {
      clear(dom.conditionStrip);
      const pills = [];

      if (!isTutorial && view.conditionLive) {
        const cl = view.conditionLive;
        const p = el(
          "span",
          `cond-pill ${cl.expired ? "is-expired" : ""}`,
          `${cl.glyph} ${cl.name}: ${cl.badgeText}`
        );
        p.title = cl.ruleSummary;
        pills.push(p);
      }

      // Exploitable public tradeoffs owed by the Inspector!
      if (!isTutorial) {
        if (inspPinnedRight) {
          pills.push(
            el(
              "span",
              "cond-pill is-advantage",
              `✓ Read: Inspector couldn't swap — Slot #${view.opponentHandCount} is The Unlisted!`
            )
          );
        } else if (view.opponentForfeitNextSwap) {
          pills.push(
            el(
              "span",
              "cond-pill is-advantage",
              "✓ Inspector Next Offer: Swap forfeited!"
            )
          );
        }
        if (view.opponentPendingExposure?.left) {
          pills.push(
            el(
              "span",
              "cond-pill is-advantage",
              "✓ Inspector Next Offer: Left ticket exposed!"
            )
          );
        }
        if (
          view.opponentPendingExposure?.right ||
          view.opponentPendingExposure?.nextOfferRight
        ) {
          pills.push(
            el(
              "span",
              "cond-pill is-advantage",
              "✓ Inspector Next Offer: Right ticket exposed!"
            )
          );
        }
      }

      // Your own pending Stamp tradeoffs
      if (view.myForfeitNextSwap) {
        pills.push(el("span", "cond-pill is-penalty", "⚠ Your Next Offer: Swap forfeited"));
      }
      if (view.myPendingExposure?.left) {
        pills.push(
          el("span", "cond-pill is-penalty", "⚠ Your Next Offer: Leftmost ticket exposed")
        );
      }
      if (view.myPendingExposure?.right) {
        pills.push(
          el("span", "cond-pill is-penalty", "⚠ This Offer: Rightmost ticket exposed")
        );
      } else if (view.myPendingExposure?.nextOfferRight) {
        pills.push(
          el("span", "cond-pill is-penalty", "⚠ Your Next Offer: Rightmost ticket exposed")
        );
      }
      if (view.lastStopPunchArmed) {
        pills.push(
          el("span", "cond-pill is-penalty", "◉ Last-Stop Punch armed (pair = left exposed)")
        );
      }

      setHidden(dom.conditionStrip, pills.length === 0);
      for (const p of pills) dom.conditionStrip.appendChild(p);
    }

    // 3. Seat headers & Inspector's Live Stamp Strip
    if (dom.inspectorTierBadge) {
      dom.inspectorTierBadge.textContent = isTutorial
        ? "Practice Guide"
        : `T${snap.activeTier} · ${snap.activeTierName}`;
    }

    const inspectorOffering = view.offerer === SIDES.INSPECTOR;
    if (dom.inspectorRole) {
      dom.inspectorRole.textContent =
        view.phase === PHASES.OVER ? "DONE" : inspectorOffering ? "OFFERING" : "DRAWING";
      dom.inspectorRole.classList.toggle(
        "is-active",
        view.activeActor === SIDES.INSPECTOR && view.phase !== PHASES.OVER
      );
    }
    if (dom.playerRole) {
      dom.playerRole.textContent =
        view.phase === PHASES.OVER ? "DONE" : inspectorOffering ? "DRAWING" : "OFFERING";
      dom.playerRole.classList.toggle(
        "is-active",
        view.activeActor === SIDES.PLAYER && view.phase !== PHASES.OVER
      );
    }
    if (dom.inspectorCount) {
      dom.inspectorCount.textContent = `${view.opponentHandCount} ${
        view.opponentHandCount === 1 ? "ticket" : "tickets"
      }`;
    }
    if (dom.playerCount) {
      dom.playerCount.textContent = `${view.myHandCount} ${
        view.myHandCount === 1 ? "ticket" : "tickets"
      }`;
    }

    const playerHoldsUnlisted = view.myHand.some((c) => c.ticket.isUnlisted);
    if (dom.inspectorRisk) {
      if (view.phase === PHASES.OVER) {
        dom.inspectorRisk.textContent = "";
      } else if (snap.inspectorTell) {
        dom.inspectorRisk.textContent = snap.inspectorTell;
      } else if (!playerHoldsUnlisted) {
        dom.inspectorRisk.textContent = "Holds The Unlisted (1 ticket has no twin)";
      } else {
        dom.inspectorRisk.textContent = "All ordinary tickets";
      }
    }

    // Render Inspector's visible Stamp Kit (live/spent/jammed)
    if (dom.inspectorStampsBar) {
      clear(dom.inspectorStampsBar);
      const oppStamps = isTutorial ? [] : view.opponentStamps || [];
      const jammed = isTutorial ? [] : snap.inspectorJammedStamps || [];
      const showInspBar = oppStamps.length > 0 || jammed.length > 0;
      setHidden(dom.inspectorStampsBar, !showInspBar);
      if (showInspBar) {
        dom.inspectorStampsBar.appendChild(
          el("span", "inspector-stamps-label", "Inspector Kit:")
        );
        for (const st of oppStamps) {
          const def = getStampDef(st.id);
          if (!def) continue;
          const stateTxt = st.spent
            ? "SPENT"
            : st.id === STAMP_IDS.BELL_CORD && !st.tokenReady
              ? "NEEDS ★"
              : "READY";
          const pill = el(
            "span",
            `insp-stamp-pill ${st.spent ? "is-spent" : "is-live"}`,
            `${def.glyph} ${def.name} · ${stateTxt}`
          );
          pill.title = `${def.shortBenefit} Tradeoff: ${def.shortTradeoff}`;
          dom.inspectorStampsBar.appendChild(pill);
        }
        for (const def of jammed) {
          if (!def) continue;
          const pill = el("span", "insp-stamp-pill is-jammed", `✕ ${def.name} · JAMMED`);
          pill.title = "Jammed by your Platform Locker gear!";
          dom.inspectorStampsBar.appendChild(pill);
        }
      }
    }

    // 4. Center banner & Final Call streak
    if (dom.phaseTag && dom.phasePrompt) {
      const dealTag =
        !isTutorial && snap.dealsRequired > 1 ? `DEAL ${snap.dealNumberInStop} · ` : "";
      if (view.phase === PHASES.OVER) {
        dom.phaseTag.textContent = `${dealTag}HAND COMPLETE`;
        dom.phasePrompt.textContent =
          view.winner === SIDES.PLAYER
            ? "You cleared every pair — the Inspector is stuck with The Unlisted!"
            : "Only The Unlisted remains in your hand.";
      } else if (activeStampTargeting) {
        dom.phaseTag.textContent = `${dealTag}TURN ${view.turnNumber} · TARGETING`;
        dom.phasePrompt.textContent =
          snap.lastNotice || `Select a glowing slot for ${activeStampTargeting.name}.`;
      } else if (snap.statusStage === "REVEAL_BEAT") {
        dom.phaseTag.textContent = `${dealTag}TURN ${view.turnNumber} · RESOLVING`;
        dom.phasePrompt.textContent = snap.activeSpotlight?.headline || "Resolving ticket…";
      } else if (view.activeActor === SIDES.INSPECTOR) {
        dom.phaseTag.textContent = `${dealTag}TURN ${view.turnNumber} · INSPECTOR'S ${
          view.phase === PHASES.OFFER ? "OFFER" : "DRAW"
        }`;
        dom.phasePrompt.textContent =
          snap.lastNotice && snap.lastNotice.startsWith("The Inspector ")
            ? snap.lastNotice
            : view.phase === PHASES.OFFER
              ? "The Inspector arranges his fan across the scratched wood…"
              : "The Inspector pauses above your offered fan…";
      } else if (view.phase === PHASES.OFFER) {
        dom.phaseTag.textContent = `${dealTag}TURN ${view.turnNumber} · YOUR OFFER`;
        if (snap.lastNotice) {
          dom.phasePrompt.textContent = snap.lastNotice;
        } else if (view.legal.canSwap) {
          dom.phasePrompt.textContent =
            "Optional: click two of your tickets to swap in secret, then press Commit Fan.";
        } else if (view.myHandCount < 2) {
          dom.phasePrompt.textContent =
            "Only one ticket left — press Commit Fan so the Inspector draws.";
        } else {
          dom.phasePrompt.textContent =
            "No swaps remaining this Offer — press Commit Fan so the Inspector draws.";
        }
      } else {
        dom.phaseTag.textContent = `${dealTag}TURN ${view.turnNumber} · YOUR DRAW`;
        if (snap.lastNotice) {
          dom.phasePrompt.textContent = snap.lastNotice;
        } else if (view.finalCall?.active) {
          dom.phasePrompt.textContent = `Final Call! Slot #${
            view.finalCall.slotIndex + 1
          } is The Unlisted and locked — draw any other ticket for a safe match.`;
        } else {
          dom.phasePrompt.textContent =
            "Click one ticket in the Inspector's fan to draw it (or use a Tool / Draw Stamp).";
        }
      }
    }

    if (dom.streakBox && dom.streakPips && dom.streakCaption) {
      dom.streakBox.classList.toggle("is-final-call", Boolean(view.finalCall?.active));
      clear(dom.streakPips);
      for (let i = 0; i < view.finalCallThreshold; i += 1) {
        const pip = el("span", "streak-pip");
        if (i < view.unlistedStreak || view.finalCall?.active) {
          pip.classList.add("is-lit");
        }
        dom.streakPips.appendChild(pip);
      }
      dom.streakCaption.textContent = view.finalCall?.active
        ? "FINAL CALL ACTIVE"
        : `${view.unlistedStreak} / ${view.finalCallThreshold} to Final Call`;
    }

    // 5. Spotlight & Manifest Ledger
    if (dom.spotlightTray) {
      clear(dom.spotlightTray);
      if (snap.activeSpotlight) {
        const sp = snap.activeSpotlight;
        const card = el(
          "div",
          `spotlight-card ${sp.kind === "PAIR" ? "is-pair" : "is-unlisted"}`
        );
        const icon = el("div", "spotlight-icon", sp.ticketMeta?.glyph || "●");
        icon.setAttribute("aria-hidden", "true");
        const txt = el("div", "spotlight-text");
        txt.appendChild(el("div", "spotlight-headline", sp.headline));
        txt.appendChild(el("div", "spotlight-detail", sp.detail));
        card.appendChild(icon);
        card.appendChild(txt);
        dom.spotlightTray.appendChild(card);
      }
    }

    if (dom.manifestCount && dom.manifestList) {
      dom.manifestCount.textContent = `${view.discardPairs.length} / ${view.pairCount} pairs cleared`;
      clear(dom.manifestList);
      if (view.discardPairs.length === 0) {
        dom.manifestList.appendChild(el("span", "fan-empty", "No pairs cleared yet."));
      } else {
        for (const p of view.discardPairs) {
          const meta = getTicketMeta(p.symbolId);
          const src =
            p.source === "DEAL" ? "Deal" : p.owner === SIDES.PLAYER ? "You" : "Inspector";
          const chip = el(
            "span",
            `manifest-chip ${p.source === "DEAL" ? "is-deal" : ""}`,
            `${meta.glyph} ${meta.shortLabel}${p.isEmblem ? " ★" : ""} · ${src}`
          );
          dom.manifestList.appendChild(chip);
        }
      }
    }

    // 6. Compute Manifest Loupe, Perforation Gauge & Check Edge clues for opponent fan
    const loupeBySlot = new Map();
    if (Array.isArray(view.myLoupeClues) && view.myLoupeClues.length > 0) {
      for (const clue of view.myLoupeClues) {
        if (clue.hasUnlisted) {
          loupeBySlot.set(clue.slotA, "DANGER");
          loupeBySlot.set(clue.slotB, "DANGER");
          for (const slot of view.opponentSlots) {
            if (
              !slot.locked &&
              slot.slotIndex !== clue.slotA &&
              slot.slotIndex !== clue.slotB &&
              !loupeBySlot.has(slot.slotIndex)
            ) {
              loupeBySlot.set(slot.slotIndex, "SAFE");
            }
          }
        } else {
          loupeBySlot.set(clue.slotA, "SAFE");
          loupeBySlot.set(clue.slotB, "SAFE");
        }
      }
    }

    const gaugeSafeSet = new Set(
      (view.myGaugeSafeSlots || []).map((g) => g.slotIndex)
    );
    const myPlainCount = view.myHand.filter(
      (s) => !s.ticket.isEmblem && !s.ticket.isUnlisted
    ).length;
    const edgeClueBySlot = new Map();
    for (const clue of view.myEdgeClues || []) {
      if (clue.isEmblem) {
        edgeClueBySlot.set(clue.slotIndex, "EMBLEM_SAFE");
      } else if (myPlainCount === 0 && view.opponentHoldsUnlisted) {
        edgeClueBySlot.set(clue.slotIndex, "DEDUCED_UNLISTED");
      } else {
        edgeClueBySlot.set(clue.slotIndex, "PLAIN_OR_BLANK");
      }
    }

    // 7. Inspector Fan
    if (dom.inspectorFan) {
      clear(dom.inspectorFan);
      if (view.opponentSlots.length === 0) {
        dom.inspectorFan.appendChild(
          el("span", "fan-empty", "Hand cleared — zero tickets remain.")
        );
      } else {
        const oppStampTargets =
          activeStampTargeting &&
          (activeStampTargeting.targetType === "OPPONENT_SLOT" ||
            activeStampTargeting.targetType === "OPPONENT_ADJACENT" ||
            activeStampTargeting.targetType === "EDGE_CHECK")
            ? new Set(activeStampTargeting.validTargets)
            : null;

        const canDrawNow =
          !snap.inputLocked &&
          !oppStampTargets &&
          view.phase === PHASES.DRAW &&
          view.drawer === SIDES.PLAYER;

        const loupePairMap = new Map();
        if (activeStampTargeting?.targetType === "OPPONENT_ADJACENT") {
          for (const [a, b] of activeStampTargeting.loupePairs || []) {
            loupePairMap.set(a, `Loupe #${a + 1}+#${b + 1}`);
          }
        }

        for (const slot of view.opponentSlots) {
          const isStampTarget = Boolean(
            oppStampTargets && oppStampTargets.has(slot.slotIndex)
          );
          let stampTargetLabel = null;
          if (isStampTarget) {
            stampTargetLabel =
              activeStampTargeting.targetType === "EDGE_CHECK"
                ? "CHECK EDGE"
                : loupePairMap.get(slot.slotIndex) || "PEEK";
          }
          const drawable =
            canDrawNow && view.legal.legalDrawSlots.includes(slot.slotIndex);
          const meta = slot.revealedTicket
            ? getTicketMeta(slot.revealedTicket.symbolId)
            : null;
          const isTutTarget =
            tutHighlight?.zone === "inspector" && tutHighlight.slot === slot.slotIndex;

          const card = createTicketNode({
            zone: "inspector",
            slotIndex: slot.slotIndex,
            totalSlots: view.opponentSlots.length,
            isInteractive: drawable,
            isStampTarget,
            stampTargetLabel,
            isTutorialTarget: isTutTarget,
            isSelected: false,
            isFaceUp: Boolean(slot.revealedTicket),
            ticketMeta: meta,
            lockReason: slot.lockReason,
            publicReveal: slot.revealSource === "PUBLIC",
            privateReveal: slot.revealSource === "PRIVATE",
            willExposeOnCommit: false,
            emblemHookLabel: null,
            loupeState: loupeBySlot.get(slot.slotIndex) || null,
            gaugeSafe: gaugeSafeSet.has(slot.slotIndex),
            edgeClueState: edgeClueBySlot.get(slot.slotIndex) || null,
            edgeCheckedPublic: Boolean(slot.edgeChecked),
            pinnedUnlistedHint:
              inspPinnedRight && slot.slotIndex === view.opponentSlots.length - 1,
            wasSwapped: false,
            isNewlyArrivedUnlisted: false,
            ariaContext: isStampTarget
              ? `Click to use ${activeStampTargeting.name}`
              : drawable
                ? "Click to draw this ticket"
                : null,
            onActivate: () => controller.drawSlot(slot.slotIndex),
          });
          dom.inspectorFan.appendChild(card);
        }
      }
    }

    // 8. Player Controls & Fan
    const playerOffering =
      !snap.inputLocked &&
      view.phase === PHASES.OFFER &&
      view.offerer === SIDES.PLAYER;

    if (dom.swapStatus) {
      if (playerOffering) {
        if (view.legal.canSwap) {
          dom.swapStatus.textContent =
            snap.selectedSwapSlot !== null
              ? `Swapping #${snap.selectedSwapSlot + 1} — pick 2nd slot`
              : `${view.legal.swapsRemaining} secret ${
                  view.legal.swapsRemaining === 1 ? "swap" : "swaps"
                } left`;
        } else {
          dom.swapStatus.textContent = view.myHandCount < 2 ? "Single card" : "0 swaps left";
        }
      } else {
        dom.swapStatus.textContent = "";
      }
    }

    if (dom.commitBtn) {
      setHidden(dom.commitBtn, !playerOffering);
      dom.commitBtn.disabled = !playerOffering;
      dom.commitBtn.classList.toggle("tutorial-target", tutHighlight?.zone === "commit");
    }

    if (dom.playerFan) {
      clear(dom.playerFan);
      if (view.myHand.length === 0) {
        dom.playerFan.appendChild(
          el("span", "fan-empty", "Hand cleared — all pairs matched!")
        );
      } else {
        const ownStampTargets =
          activeStampTargeting && activeStampTargeting.targetType === "OWN_ORDINARY_SLOT"
            ? new Set(activeStampTargeting.validTargets)
            : null;

        const willExposeSlots = new Set();
        if (playerOffering) {
          const unlockedOwn = view.myHand
            .filter((s) => !s.locked)
            .map((s) => s.slotIndex);
          if (unlockedOwn.length > 0) {
            const draftyActive =
              view.condition &&
              !view.condition.expired &&
              view.condition.id === CONDITION_IDS.DRAFTY_WINDOW &&
              view.myHand.length >= 3;
            if (draftyActive || view.myPendingExposure?.left) {
              willExposeSlots.add(unlockedOwn[0]);
            }
            if (view.myPendingExposure?.right) {
              willExposeSlots.add(unlockedOwn[unlockedOwn.length - 1]);
            }
          }
        }

        const hasReadyCarbon =
          view.myStamps.some((s) => s.id === STAMP_IDS.CARBON_COPY && !s.spent) &&
          view.myStamps.some((s) => getStampDef(s.id)?.isInspection && s.spent);
        const hasDormantBellCord = view.myStamps.some(
          (s) => s.id === STAMP_IDS.BELL_CORD && !s.spent && !s.tokenReady
        );

        for (const slot of view.myHand) {
          const isStampTarget = Boolean(
            ownStampTargets && ownStampTargets.has(slot.slotIndex)
          );
          const swappable =
            !ownStampTargets &&
            playerOffering &&
            view.legal.canSwap &&
            view.legal.legalSwapSlots.includes(slot.slotIndex);
          const meta = getTicketMeta(slot.ticket.symbolId);
          const isTutTarget =
            tutHighlight?.zone === "player" && tutHighlight.slot === slot.slotIndex;

          const symId = slot.ticket.symbolId;
          let emblemHookLabel = null;
          if (hasReadyCarbon && (symId === "LANTERN" || symId === "WATCH")) {
            emblemHookLabel = "★ Refills Stamp";
          } else if (hasDormantBellCord && (symId === "KEY" || symId === "BELL")) {
            emblemHookLabel = "★ Charges Cord";
          }

          const card = createTicketNode({
            zone: "player",
            slotIndex: slot.slotIndex,
            totalSlots: view.myHand.length,
            isInteractive: swappable,
            isStampTarget,
            stampTargetLabel: isStampTarget ? "LOCK" : null,
            isTutorialTarget: isTutTarget,
            isSelected: snap.selectedSwapSlot === slot.slotIndex,
            isFaceUp: true,
            ticketMeta: meta,
            lockReason: slot.lockReason,
            publicReveal: slot.publiclyRevealed,
            privateReveal: false,
            willExposeOnCommit:
              willExposeSlots.has(slot.slotIndex) && slot.lockReason !== "FINAL_CALL",
            emblemHookLabel,
            loupeState: null,
            gaugeSafe: false,
            edgeClueState: null,
            edgeCheckedPublic: false,
            pinnedUnlistedHint: false,
            wasSwapped: snap.lastSwappedSlots.includes(slot.slotIndex),
            isNewlyArrivedUnlisted: snap.newlyDrawnUnlistedSlot === slot.slotIndex,
            ariaContext: isStampTarget
              ? "Click to lock with Brass Weight"
              : swappable
                ? "Click to select for private swap"
                : null,
            onActivate: () => controller.selectOfferSlot(slot.slotIndex),
          });
          dom.playerFan.appendChild(card);
        }
      }
    }

    // 9. Passenger Locker Tools Bar (Perforation Gauge & Check Edge)
    if (dom.toolsBar) {
      clear(dom.toolsBar);
      const maxGauge = isTutorial ? 0 : snap.runBonuses?.gaugeChargesPerDeal || 0;
      const maxEdge = isTutorial ? 0 : snap.runBonuses?.edgeChecksPerDeal || 0;
      const showTools = maxGauge > 0 || maxEdge > 0;
      setHidden(dom.toolsBar, !showTools);

      if (showTools) {
        dom.toolsBar.appendChild(el("span", "tools-bar-label", "Locker Tools:"));

        if (maxGauge > 0) {
          const left = view.legal.gaugeChargesRemaining || 0;
          const ready = !snap.inputLocked && Boolean(view.legal.canUseGauge);
          const btn = el(
            "button",
            `tool-btn is-keystone ${ready ? "is-ready" : ""} ${left === 0 ? "is-spent" : ""}`
          );
          btn.type = "button";
          btn.disabled = !ready;
          const status =
            left === 0
              ? "SPENT"
              : ready
                ? `USE (${left}/${maxGauge})`
                : `${left}/${maxGauge} · Need 3+ w/ Unlisted`;
          btn.textContent = `[G] ⌖ Perforation Gauge · ${status}`;
          btn.title =
            "Privately mark 1 guaranteed-safe ticket when drawing from an Inspector fan of 3+ holding The Unlisted.";
          listen(btn, "click", () => controller.activateGauge());
          dom.toolsBar.appendChild(btn);
        }

        if (maxEdge > 0) {
          const left = view.legal.edgeChecksRemaining || 0;
          const isArmed = activeStampTargeting?.targetType === "EDGE_CHECK";
          const ready = !snap.inputLocked && (Boolean(view.legal.canCheckEdge) || isArmed);
          const btn = el(
            "button",
            `tool-btn ${isArmed ? "is-armed" : ready ? "is-ready" : ""} ${
              left === 0 ? "is-spent" : ""
            }`
          );
          btn.type = "button";
          btn.disabled = !ready;
          const status = isArmed
            ? "ARMED · Cancel"
            : left === 0
              ? "SPENT"
              : ready
                ? `USE (${left}/${maxEdge})`
                : `${left}/${maxEdge} · Draw (3+ fan)`;
          btn.textContent = `[E] ◫ Check Edge · ${status}`;
          btn.title =
            "Privately test 1 hidden slot in a fan of 3+ to see if it is ★ Emblem Stock (100% safe pair) or Plain/Blank.";
          listen(btn, "click", () => controller.activateCheckEdge());
          dom.toolsBar.appendChild(btn);
        }
      }
    }

    // 10. 3-Slot Stamp Tray
    if (dom.stampTray) {
      clear(dom.stampTray);
      const statuses = view.legal.stampStatuses || [];
      for (let i = 0; i < snap.maxStampSlots; i += 1) {
        const st = statuses[i];
        if (!st) {
          dom.stampTray.appendChild(
            el(
              "div",
              "stamp-slot is-empty",
              isTutorial ? "Empty Stamp Slot (earn up to 3)" : `Slot ${i + 1} · Empty`
            )
          );
          continue;
        }

        const def = getStampDef(st.id);
        const isArmed = activeStampTargeting?.stampId === st.id;
        const interactive = !snap.inputLocked && (st.canUse || isArmed);
        const isTutStamp =
          tutHighlight?.zone === "stamp" && tutHighlight.stampId === st.id;

        const slotEl = el(interactive ? "button" : "div", "stamp-slot");
        if (interactive) slotEl.type = "button";
        if (isArmed) slotEl.classList.add("is-armed");
        else if (interactive) slotEl.classList.add("is-ready");
        if (st.spent) slotEl.classList.add("is-spent");
        if (isTutStamp) slotEl.classList.add("tutorial-target");

        const top = el("div", "stamp-slot-top");
        top.appendChild(el("span", "stamp-slot-name", `[${i + 1}] ${def.glyph} ${def.name}`));
        top.appendChild(
          el("span", "stamp-slot-status", isArmed ? "ARMED · Cancel" : st.statusText)
        );
        slotEl.appendChild(top);

        slotEl.appendChild(
          el("div", "stamp-slot-desc", `${def.shortBenefit} Tradeoff: ${def.shortTradeoff}`)
        );

        if (interactive) {
          listen(slotEl, "click", () => controller.activateStamp(st.id));
        }
        dom.stampTray.appendChild(slotEl);
      }
    }
  }

  function renderStopResultScreen(snap) {
    const s = snap.lastStopSummary;
    if (!s) return;

    const isMidMatch = s.kind === "DEAL_CONTINUE";
    const positive = s.won || s.emergencyMatchSaved;

    if (dom.stopResultCard) {
      dom.stopResultCard.classList.toggle("is-win", positive);
      dom.stopResultCard.classList.toggle("is-loss", !positive);
    }

    setHidden(dom.stopResultScore, s.dealsRequired <= 1);
    if (dom.stopResultScore && s.dealsRequired > 1) {
      dom.stopResultScore.textContent = `Match Score: You ${s.dealWins} — ${s.dealLosses} Inspector (First to ${s.dealsRequired})`;
    }

    if (isMidMatch) {
      const nextDealNum = snap.dealNumberInStop;
      if (s.emergencyMatchSaved) {
        if (dom.stopResultKicker) {
          dom.stopResultKicker.textContent = `${s.carriage.code} · 🔥 EMERGENCY MATCH FLARED`;
        }
        if (dom.stopResultTitle) {
          dom.stopResultTitle.textContent = "Double-Wick Storm Lamp Held the Flame!";
        }
        if (dom.stopResultBody) {
          dom.stopResultBody.textContent = `You were caught holding The Unlisted on the deciding deal, but your Emergency Match voided the loss! The score stays ${s.dealWins}–${s.dealLosses}, and all Stamps & Locker Tools refresh for Deal ${nextDealNum}.`;
        }
      } else if (s.won) {
        const needed = s.dealsRequired - s.dealWins;
        if (dom.stopResultKicker) {
          dom.stopResultKicker.textContent = `${s.carriage.code} · DEAL ${s.dealJustPlayed} WON`;
        }
        if (dom.stopResultTitle) {
          dom.stopResultTitle.textContent = "The Inspector Holds The Unlisted";
        }
        if (dom.stopResultBody) {
          dom.stopResultBody.textContent = `You took Deal ${s.dealJustPlayed} in ${s.turns} turns! Win ${needed} more ${
            needed === 1 ? "deal" : "deals"
          } to clear ${s.carriage.name}. First turn alternates and all Stamps & Locker Tools refresh.`;
        }
      } else {
        const margin = s.dealsRequired - s.dealLosses;
        if (dom.stopResultKicker) {
          dom.stopResultKicker.textContent = `${s.carriage.code} · DEAL ${s.dealJustPlayed} LOST`;
        }
        if (dom.stopResultTitle) {
          dom.stopResultTitle.textContent = "Caught With The Unlisted — Still in the Match";
        }
        if (dom.stopResultBody) {
          dom.stopResultBody.textContent = `The Inspector took Deal ${s.dealJustPlayed} — no Lantern lost yet (${
            margin === 1 ? "sudden death if he wins 1 more!" : `${margin} deals before carriage loss`
          }). All Stamps & Locker Tools refresh and first turn switches for Deal ${nextDealNum}.`;
        }
      }
      if (dom.stopContinueBtn) {
        dom.stopContinueBtn.textContent = `Deal Hand ${nextDealNum} →`;
      }
    } else if (s.won) {
      if (dom.stopResultKicker) {
        dom.stopResultKicker.textContent = `${s.carriage.code} CLEARED · VICTORY`;
      }
      if (dom.stopResultTitle) {
        dom.stopResultTitle.textContent = `${s.carriage.name} Passed`;
      }
      const healNote = s.lanternHealed
        ? " Your Double-Wick Storm Lamp relit +1 Lantern for clearing 2 carriages in a row!"
        : "";
      if (dom.stopResultBody) {
        dom.stopResultBody.textContent = `You defeated the Inspector (${s.dealWins}–${s.dealLosses}) and left him holding The Unlisted.${healNote} Choose a Stamp from his brass tray before the next carriage.`;
      }
      if (dom.stopContinueBtn) {
        dom.stopContinueBtn.textContent = s.hasReward
          ? "Open Stamp Reward Tray →"
          : "Advance to Next Carriage →";
      }
    } else if (s.isRematchNext) {
      if (dom.stopResultKicker) {
        dom.stopResultKicker.textContent = "FINAL INSPECTION LOST · 1 LANTERN SPENT";
      }
      if (dom.stopResultTitle) {
        dom.stopResultTitle.textContent = "Your Lantern Flickers — Rematch Available";
      }
      if (dom.stopResultBody) {
        dom.stopResultBody.textContent = `The Chief Inspector took the match (${s.dealWins}–${s.dealLosses}), dimming 1 Lantern (${s.lanternsAfter} of ${snap.maxLanterns} left). While at least 1 Lantern burns, he must deal Final Inspection again with all Stamps & Tools refreshed.`;
      }
      if (dom.stopContinueBtn) {
        dom.stopContinueBtn.textContent = "Rematch Final Inspection →";
      }
    } else {
      const nextCar = snap.carriages[Math.min(snap.totalStops - 1, snap.stopIndex + 1)];
      if (dom.stopResultKicker) {
        dom.stopResultKicker.textContent = `${s.carriage.code} LOST · 1 LANTERN SPENT`;
      }
      if (dom.stopResultTitle) {
        dom.stopResultTitle.textContent = "A Lantern Goes Out — You Ride On";
      }
      if (dom.stopResultBody) {
        dom.stopResultBody.textContent = `The Inspector won the carriage (${s.dealWins}–${s.dealLosses}). 1 Lantern goes dark and no Stamp reward is offered, but your matched pairs still count toward ◈ Punched Stubs as you ride on to ${nextCar.name}.`;
      }
      if (dom.stopContinueBtn) {
        dom.stopContinueBtn.textContent = `Continue to ${nextCar.code}: ${nextCar.name} →`;
      }
    }

    if (dom.stopResultLanterns) {
      const lanternMsg = s.lanternLost
        ? `${s.lanternsAfter}/${snap.maxLanterns} Lanterns remaining (−1)`
        : s.lanternHealed
          ? `${s.lanternsAfter}/${snap.maxLanterns} Lanterns (+1 Storm Lamp!)`
          : `${s.lanternsAfter}/${snap.maxLanterns} Lanterns intact`;
      renderLanternPips(dom.stopResultLanterns, s.lanternsAfter, snap.maxLanterns, lanternMsg);
    }
  }

  function renderRewardScreen(snap) {
    const rw = snap.reward;
    if (!rw) return;
    const replacing = rw.pendingReplaceStamp;
    const isStarter = Boolean(rw.isStarterDraft);

    if (dom.rewardKicker) {
      dom.rewardKicker.textContent = isStarter
        ? "★ PERFORATION GAUGE · DEPARTURE STAMP DRAFT"
        : `${snap.carriage.code} VICTORY · STAMP REWARD`;
    }
    if (dom.rewardTitle) {
      dom.rewardTitle.textContent = replacing
        ? `Replace Which Slot With ${replacing.name}?`
        : isStarter
          ? "Choose 1 Starter Stamp Before Carriage I"
          : "Choose 1 of 3 Stamps (or Skip)";
    }
    if (dom.rewardSub) {
      dom.rewardSub.textContent = isStarter
        ? "Your Perforation Gauge lets you slip 1 Stamp into Slot 1 before boarding Third-Class Coach — pick the edge you want for this run."
        : replacing
          ? `All 3 Stamp slots are full. Click one of your existing Stamps below to replace it with ${replacing.name}, or press Cancel.`
          : rw.slotsFull
            ? "Your 3 Stamp slots are full — pick a new Stamp to replace one of yours, or skip to keep your current loadout."
            : `Pick 1 Stamp to add to your tray (${snap.equippedStamps.length}/${snap.maxStampSlots} slots filled), or skip if you don't want its tradeoff.`;
    }

    if (dom.rewardCurrentBox) {
      dom.rewardCurrentBox.classList.toggle("is-replacing", Boolean(replacing));
      setHidden(dom.rewardCurrentBox, isStarter);
    }
    if (dom.rewardSlotsLabel) {
      dom.rewardSlotsLabel.textContent = replacing
        ? `Click a slot below to replace with ${replacing.glyph} ${replacing.name}:`
        : `Your Stamp Tray (${snap.equippedStamps.length}/${snap.maxStampSlots})`;
    }
    setHidden(dom.cancelReplaceBtn, !replacing);

    setHidden(dom.rerollRewardBtn, !(rw.rerollsLeft > 0));
    if (dom.rerollRewardBtn && rw.rerollsLeft > 0) {
      dom.rerollRewardBtn.textContent = `⎘ Reroll Stamps (${rw.rerollsLeft} left)`;
    }
    if (dom.skipRewardBtn) {
      dom.skipRewardBtn.textContent = isStarter
        ? "Board Without Starter Stamp →"
        : "Skip Reward — Advance to Next Carriage →";
    }

    if (dom.rewardCurrentSlots && !isStarter) {
      clear(dom.rewardCurrentSlots);
      for (let i = 0; i < snap.maxStampSlots; i += 1) {
        const st = snap.equippedStamps[i];
        if (!st) {
          dom.rewardCurrentSlots.appendChild(
            el("div", "mini-stamp-slot is-empty", `Slot ${i + 1} · Open`)
          );
        } else if (replacing) {
          const btn = el("button", "mini-stamp-slot is-replaceable");
          btn.type = "button";
          btn.appendChild(
            el("span", "mini-stamp-name", `Replace Slot ${i + 1}: ${st.glyph} ${st.name}`)
          );
          btn.appendChild(el("span", "mini-stamp-meta", st.shortBenefit));
          listen(btn, "click", () => controller.chooseRewardStamp(replacing.id, i));
          dom.rewardCurrentSlots.appendChild(btn);
        } else {
          const box = el("div", "mini-stamp-slot");
          box.appendChild(el("span", "mini-stamp-name", `${st.glyph} ${st.name}`));
          box.appendChild(el("span", "mini-stamp-meta", st.timingLabel));
          dom.rewardCurrentSlots.appendChild(box);
        }
      }
    }

    if (dom.rewardGrid) {
      clear(dom.rewardGrid);
      for (const st of rw.choices) {
        const isChosen = replacing && replacing.id === st.id;
        const card = el(
          "article",
          `reward-card ${isChosen ? "is-selected-replace" : ""}`
        );

        const top = el("div", "reward-card-top");
        const badges = el("div", "reward-card-badges");
        badges.appendChild(el("span", "reward-tag", st.timingLabel));
        if (st.triggerSymbols.length > 0) {
          const symNames = st.triggerSymbols
            .map((id) => `${getTicketMeta(id)?.shortLabel || id}★`)
            .join(" / ");
          badges.appendChild(el("span", "reward-tag", `Emblem: ${symNames}`));
        }
        const partnerName = hasTraySynergy(st.id, snap.equippedStamps);
        if (partnerName) {
          badges.appendChild(
            el("span", "reward-tag is-synergy", `★ Combos w/ ${partnerName}`)
          );
        }
        top.appendChild(badges);

        top.appendChild(el("h3", "reward-card-name", `${st.glyph} ${st.name}`));
        top.appendChild(el("p", "reward-effect", st.shortBenefit));
        top.appendChild(el("p", "reward-tradeoff", `Tradeoff: ${st.shortTradeoff}`));
        top.appendChild(el("p", "reward-combo", st.synergyHint));
        card.appendChild(top);

        const pickBtn = el(
          "button",
          `btn ${isChosen ? "btn-subtle" : "btn-brass"}`,
          isChosen
            ? "Selected — Pick Slot Above"
            : rw.slotsFull
              ? `Replace a Slot with ${st.name}`
              : `Take ${st.name}`
        );
        pickBtn.type = "button";
        listen(pickBtn, "click", () => controller.chooseRewardStamp(st.id));
        card.appendChild(pickBtn);

        dom.rewardGrid.appendChild(card);
      }
    }
  }

  function renderRunOverScreen(snap) {
    const victory = snap.runOutcome === RUN_OUTCOMES.VICTORY;

    if (dom.runOverCard) {
      dom.runOverCard.classList.toggle("is-win", victory);
      dom.runOverCard.classList.toggle("is-loss", !victory);
    }
    if (dom.runOverKicker) {
      dom.runOverKicker.textContent = victory
        ? "TERMINUS REACHED · RUN VICTORY"
        : "ALL LANTERNS OUT · RUN DEFEAT";
    }
    if (dom.runOverTitle) {
      dom.runOverTitle.textContent = victory
        ? "MANIFEST CLEARED"
        : "LEFT ON THE PLATFORM";
    }
    if (dom.runOverBody) {
      dom.runOverBody.textContent = victory
        ? "Across four multi-deal carriages and the Final Inspection, every pair on the midnight manifest has been settled — and the blank punched ticket rests in the Inspector's gloved hand as the doors unlatch."
        : "Your third Lantern goes dark beside the scratched fold-down table. The train pulls out — but the Punched Stubs in your coat pocket stay yours for the Platform Locker.";
    }

    // Punched Stubs Earned Receipt + Breakthrough Callout!
    const payout = snap.lastRunPayout;
    setHidden(dom.runPayoutBox, !payout);
    if (dom.runPayoutBox && payout) {
      clear(dom.runPayoutBox);
      const head = el("div", "payout-header");
      head.appendChild(el("span", "payout-title", "PUNCHED STUBS EARNED"));
      head.appendChild(el("strong", "payout-total", `+${payout.total} ◈`));
      dom.runPayoutBox.appendChild(head);

      const list = el("ul", "payout-lines");
      for (const line of payout.lines) {
        const li = el("li", "payout-line");
        li.appendChild(el("span", null, line.label));
        li.appendChild(el("strong", null, `+${line.amount} ◈`));
        list.appendChild(li);
      }
      dom.runPayoutBox.appendChild(list);

      if (snap.meta) {
        const foot = el("div", "payout-footer");
        foot.appendChild(
          el("span", null, `Platform Locker Balance: ◈ ${snap.meta.stubs} Stubs`)
        );
        if (snap.meta.keystoneReadyToBuy) {
          foot.appendChild(
            el(
              "strong",
              "payout-callout is-keystone",
              "★ READY TO UNLOCK: THE PERFORATION GAUGE!"
            )
          );
        } else if (snap.meta.affordableCount > 0) {
          foot.appendChild(
            el(
              "strong",
              "payout-callout",
              `${snap.meta.affordableCount} Locker ${
                snap.meta.affordableCount === 1 ? "Keepsake" : "Keepsakes"
              } ready to unlock!`
            )
          );
        } else if (!snap.meta.keystoneUnlocked) {
          const gauge = snap.meta.items.find((it) => it.isKeystone);
          if (gauge) {
            const rem = Math.max(0, gauge.cost - snap.meta.stubs);
            foot.appendChild(
              el(
                "span",
                "payout-callout",
                `${rem} ◈ more to unlock ★ The Perforation Gauge`
              )
            );
          }
        }
        dom.runPayoutBox.appendChild(foot);
      }
    }

    if (dom.runOverLockerBtn && snap.meta) {
      dom.runOverLockerBtn.textContent = snap.meta.keystoneReadyToBuy
        ? "★ Unlock The Perforation Gauge →"
        : snap.meta.affordableCount > 0
          ? `Open Platform Locker (${snap.meta.affordableCount} Ready!) →`
          : `Platform Locker (◈ ${snap.meta.stubs}) →`;
      dom.runOverLockerBtn.classList.toggle("has-alert", snap.meta.affordableCount > 0);
    }

    if (dom.runSummaryGrid) {
      clear(dom.runSummaryGrid);
      const stampNames =
        snap.equippedStamps.length > 0
          ? snap.equippedStamps.map((s) => s.name).join(", ")
          : "None";
      const stats = [
        ["Run Seed", snap.runSeed],
        ["Deals Won", `${snap.runStats?.dealsWon || 0} / ${snap.runStats?.dealsPlayed || 0}`],
        ["Lanterns Left", `${snap.lanterns} / ${snap.maxLanterns}`],
        ["Final Stamps", stampNames],
      ];
      for (const [label, val] of stats) {
        const box = el("div", "summary-stat");
        box.appendChild(el("span", "summary-stat-label", label));
        box.appendChild(el("span", "summary-stat-val", val));
        dom.runSummaryGrid.appendChild(box);
      }
    }

    if (dom.runHistoryList) {
      clear(dom.runHistoryList);
      for (const h of snap.stopHistory) {
        const li = el("li", `run-history-item ${h.won ? "is-win" : "is-loss"}`);
        const rem = h.rematchAttempt > 0 ? ` (Rematch #${h.rematchAttempt})` : "";
        li.appendChild(el("span", null, `${h.code} · ${h.name}${rem}`));
        const scoreTxt = h.dealScore ? `Deals ${h.dealScore}` : `${h.turns} turns`;
        li.appendChild(
          el(
            "strong",
            null,
            `${h.won ? "✓ Cleared" : "✕ Lost (−1 Lantern)"} · ${scoreTxt}`
          )
        );
        dom.runHistoryList.appendChild(li);
      }
    }
  }

  function renderDevTrace(snap) {
    if (!dom.devTracePanel || !dom.devTraceToggle) return;
    const open = Boolean(snap.devTraceOpen && snap.devTrace);
    setHidden(dom.devTracePanel, !open);
    dom.devTraceToggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (!open) return;

    const dt = snap.devTrace;
    if (dom.devTraceTitle) {
      dom.devTraceTitle.textContent = `Inspector Decision Trace — Tier ${dt.tier}: ${dt.tierName}`;
    }
    if (dom.devTraceMeta) {
      const pat = dt.pattern.detected
        ? `Habit: ${dt.pattern.label} (${Math.round(dt.pattern.peakProb * 100)}%)`
        : "Habit: none above threshold";
      dom.devTraceMeta.textContent = `Observed draws: ${dt.observations} · ${pat}`;
    }
    if (dom.devTraceSummary) {
      dom.devTraceSummary.textContent = `${dt.tierSummary} Legal info only — player hidden slots are never accessed.`;
    }

    if (dom.devBuckets) {
      clear(dom.devBuckets);
      for (const bucket of BUCKETS) {
        const p = dt.bucketProbs[bucket] ?? 0.2;
        const pct = Math.round(p * 100);
        const box = el(
          "div",
          `dev-bucket ${
            dt.pattern.detected && dt.pattern.bucket === bucket ? "is-peak" : ""
          }`
        );
        box.appendChild(el("span", null, `${BUCKET_LABELS[bucket]}: ${pct}%`));
        const bar = el("div", "dev-bucket-bar");
        bar.style.width = `${Math.min(100, pct)}%`;
        box.appendChild(bar);
        dom.devBuckets.appendChild(box);
      }
    }

    if (dom.devTraceList) {
      clear(dom.devTraceList);
      if (dt.entries.length === 0) {
        dom.devTraceList.appendChild(el("li", "dev-trace-item", "No Inspector actions yet."));
      } else {
        for (const entry of dt.entries) {
          const li = el("li", "dev-trace-item");
          const head = `[T${entry.turnNumber} · ${entry.role} · ${entry.actionType}${
            entry.rngRoll !== null && entry.rngRoll !== undefined
              ? ` · rng=${entry.rngRoll}`
              : ""
          }] `;
          li.appendChild(el("strong", null, head));
          const facts = entry.observedFacts || {};
          const factBits = [];
          if (facts.myHandCount !== undefined) {
            factBits.push(`hands=${facts.myHandCount}v${facts.opponentHandCount}`);
          }
          if (facts.unlistedStreak !== undefined) {
            factBits.push(`streak=${facts.unlistedStreak}`);
          }
          if (Array.isArray(facts.validReveals) && facts.validReveals.length > 0) {
            factBits.push(
              `reveals=${facts.validReveals.map((r) => `#${r.slot}:${r.symbolId}`).join(",")}`
            );
          }
          if (facts.plausibleArrangements !== undefined) {
            factBits.push(`arrangements=${facts.plausibleArrangements}`);
          }
          if (facts.lookaheadWinIfSafePair !== undefined) {
            factBits.push(
              `EV(safe=${facts.lookaheadWinIfSafePair},U=${facts.lookaheadWinIfDrawUnlisted})`
            );
          }
          if (facts.lookaheadWinIfBaited !== undefined) {
            factBits.push(
              `EV(bait=${facts.lookaheadWinIfBaited},miss=${facts.lookaheadWinIfPaired})`
            );
          }
          const factSuffix = factBits.length > 0 ? ` [${factBits.join(" · ")}]` : "";
          li.appendChild(doc.createTextNode(`${entry.reason}${factSuffix}`));
          dom.devTraceList.appendChild(li);
        }
      }
    }
  }

  function render(snap) {
    // Preserve active ticket button focus across table re-renders for keyboard play.
    const prevZone = doc.activeElement?.dataset?.zone || null;
    const prevSlot = doc.activeElement?.dataset?.slot ?? null;

    renderTopBar(snap);

    const isTitle = snap.screen === RUN_SCREENS.TITLE;
    const isLocker = snap.screen === RUN_SCREENS.LOCKER;
    const isBriefing = snap.screen === RUN_SCREENS.BRIEFING;
    const isTable =
      snap.screen === RUN_SCREENS.DUEL || snap.screen === RUN_SCREENS.TUTORIAL;
    const isStopResult = snap.screen === RUN_SCREENS.STOP_RESULT;
    const isReward =
      snap.screen === RUN_SCREENS.REWARD || snap.screen === RUN_SCREENS.STARTER_DRAFT;
    const isRunOver = snap.screen === RUN_SCREENS.RUN_OVER;

    setHidden(dom.titleScreen, !isTitle);
    setHidden(dom.lockerScreen, !isLocker);
    setHidden(dom.briefingScreen, !isBriefing);
    setHidden(dom.tableScreen, !isTable);
    setHidden(dom.stopResultScreen, !isStopResult);
    setHidden(dom.rewardScreen, !isReward);
    setHidden(dom.runOverScreen, !isRunOver);

    if (isTitle) renderTitleScreen(snap);
    else if (isLocker) renderLockerScreen(snap);
    else if (isBriefing) renderBriefingScreen(snap);
    else if (isTable) {
      renderTableScreen(snap);
      if (prevZone && prevSlot !== null) {
        const fan = prevZone === "player" ? dom.playerFan : dom.inspectorFan;
        const match = fan?.querySelector?.(
          `button[data-slot="${prevSlot}"]:not(:disabled)`
        );
        if (match) match.focus();
      }
    } else if (isStopResult) renderStopResultScreen(snap);
    else if (isReward) renderRewardScreen(snap);
    else if (isRunOver) renderRunOverScreen(snap);

    renderDevTrace(snap);
  }

  const unsubscribe = controller.subscribe(render);

  return function unmount() {
    unsubscribe();
    while (listeners.length > 0) {
      const off = listeners.pop();
      off();
    }
  };
}
