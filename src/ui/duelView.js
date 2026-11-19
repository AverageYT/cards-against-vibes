/**
 * src/ui/duelView.js
 * Crisp DOM renderer and keyboard/pointer binding for a playable duel,
 * including the optional developer-only Inspector AI decision trace.
 *
 * Renders strictly from the controller's legal PLAYER ObserverView snapshot.
 * Uses an AbortController so teardown leaves zero lingering listeners.
 */

import { PHASES, SIDES } from "../core/engine.js";
import { BUCKET_LABELS, BUCKETS } from "../data/aiTuning.js";
import { TICKET_SYMBOLS } from "../data/tickets.js";
import { STARTING_MODES, TIER_MODES } from "./duelController.js";

function createDomHelpers(doc) {
  function el(tag, className = "", text = null) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== null) node.textContent = text;
    return node;
  }

  function buildFaceContent(ticket, slotNumber, tagText) {
    const frag = doc.createDocumentFragment();
    const top = el("span", "ticket-top");
    top.appendChild(el("span", "", `#${slotNumber}`));
    if (ticket.isUnlisted) {
      top.appendChild(el("span", "", "NO NAME"));
    } else if (ticket.isEmblem) {
      const star = el("span", "emblem-star", "★ EMB");
      star.title = "Marked Emblem Pair";
      top.appendChild(star);
    } else {
      top.appendChild(el("span", "", `C.${ticket.code}`));
    }
    frag.appendChild(top);

    if (ticket.isUnlisted) {
      const hole = el("span", "punch-hole");
      hole.setAttribute("aria-hidden", "true");
      frag.appendChild(hole);
    } else {
      const glyph = el("span", "ticket-glyph", ticket.glyph);
      glyph.setAttribute("aria-hidden", "true");
      frag.appendChild(glyph);
    }

    frag.appendChild(el("span", "ticket-name", ticket.shortLabel));
    frag.appendChild(el("span", "ticket-tag", tagText));
    return frag;
  }

  function buildBackContent(slotNumber, tagText) {
    const frag = doc.createDocumentFragment();
    const top = el("span", "ticket-top");
    top.appendChild(el("span", "", `#${slotNumber}`));
    top.appendChild(el("span", "", "TICKET"));
    frag.appendChild(top);

    const glyph = el("span", "ticket-glyph", "❖");
    glyph.setAttribute("aria-hidden", "true");
    frag.appendChild(glyph);

    frag.appendChild(el("span", "ticket-name", `Slot ${slotNumber}`));
    frag.appendChild(el("span", "ticket-tag", tagText));
    return frag;
  }

  return { el, buildFaceContent, buildBackContent };
}

export function mountDuelView(controller, doc = document) {
  const { el, buildFaceContent, buildBackContent } = createDomHelpers(doc);
  const abortController = new AbortController();
  const { signal } = abortController;

  const refs = {
    subtitle: doc.getElementById("encounter-subtitle"),
    controlsForm: doc.getElementById("duel-controls"),
    seedInput: doc.getElementById("seed-input"),
    pairsSelect: doc.getElementById("pairs-select"),
    tierSelect: doc.getElementById("tier-select"),
    starterSelect: doc.getElementById("starter-select"),
    newSeedBtn: doc.getElementById("new-seed-btn"),
    restartBtn: doc.getElementById("restart-btn"),
    reducedMotionToggle: doc.getElementById("reduced-motion-toggle"),
    inspectorSeat: doc.querySelector(".seat-inspector"),
    playerSeat: doc.querySelector(".seat-player"),
    inspectorTier: doc.getElementById("inspector-tier-badge"),
    inspectorRole: doc.getElementById("inspector-role-badge"),
    inspectorCount: doc.getElementById("inspector-count"),
    inspectorRisk: doc.getElementById("inspector-risk-note"),
    inspectorFan: doc.getElementById("inspector-fan"),
    playerRole: doc.getElementById("player-role-badge"),
    playerCount: doc.getElementById("player-count"),
    swapStatus: doc.getElementById("swap-status"),
    commitBtn: doc.getElementById("commit-offer-btn"),
    playerFan: doc.getElementById("player-fan"),
    phaseBanner: doc.getElementById("phase-banner"),
    phaseTag: doc.getElementById("phase-tag"),
    phasePrompt: doc.getElementById("phase-prompt"),
    streakBox: doc.getElementById("streak-box"),
    streakPips: doc.getElementById("streak-pips"),
    streakCaption: doc.getElementById("streak-caption"),
    spotlightTray: doc.getElementById("spotlight-tray"),
    resultPanel: doc.getElementById("result-panel"),
    resultKicker: doc.getElementById("result-kicker"),
    resultTitle: doc.getElementById("result-title"),
    resultBody: doc.getElementById("result-body"),
    nextDuelBtn: doc.getElementById("next-duel-btn"),
    replayDuelBtn: doc.getElementById("replay-duel-btn"),
    resetRunBtn: doc.getElementById("reset-run-btn"),
    manifestCount: doc.getElementById("manifest-count"),
    manifestList: doc.getElementById("manifest-list"),
    devTraceToggle: doc.getElementById("dev-trace-toggle"),
    devTracePanel: doc.getElementById("dev-trace-panel"),
    devTraceTitle: doc.getElementById("dev-trace-title"),
    devTraceMeta: doc.getElementById("dev-trace-meta"),
    devTraceSummary: doc.getElementById("dev-trace-summary"),
    devBuckets: doc.getElementById("dev-buckets"),
    devTraceList: doc.getElementById("dev-trace-list"),
  };

  function renderInspectorFan(snap) {
    const { view, inputLocked } = snap;
    refs.inspectorFan.replaceChildren();

    if (view.opponentHandCount === 0) {
      refs.inspectorFan.appendChild(
        el("div", "empty-hand-note", "All Inspector tickets paired and cleared.")
      );
      return;
    }

    const canPlayerDraw =
      !inputLocked && view.phase === PHASES.DRAW && view.activeActor === SIDES.PLAYER;
    const drawableSet = new Set(view.legal.legalDrawSlots);

    for (const slot of view.opponentSlots) {
      const num = slot.slotIndex + 1;
      const isDrawable = canPlayerDraw && drawableSet.has(slot.slotIndex);
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.dataset.zone = "inspector";
      btn.dataset.slot = String(slot.slotIndex);

      const classes = ["ticket"];
      let tagText = "Face down";
      let ariaLabel = `Inspector slot ${num} of ${view.opponentHandCount}, face down`;

      if (slot.revealedTicket) {
        classes.push(slot.revealedTicket.isUnlisted ? "ticket-unlisted" : "ticket-face");
        if (slot.revealedTicket.isEmblem) classes.push("is-emblem");
        if (slot.lockReason === "FINAL_CALL") {
          tagText = "FINAL CALL";
          ariaLabel = `Inspector slot ${num}, The Unlisted, locked by Final Call (cannot draw)`;
        } else {
          tagText = isDrawable ? "Draw (Shown)" : slot.revealSource || "Shown";
          ariaLabel = `Inspector slot ${num}, revealed ${slot.revealedTicket.name}`;
        }
        btn.appendChild(buildFaceContent(slot.revealedTicket, num, tagText));
      } else {
        classes.push("ticket-back");
        if (slot.locked) {
          tagText = "LOCKED";
          ariaLabel = `Inspector slot ${num}, locked (cannot draw)`;
        } else if (isDrawable) {
          tagText = "Draw →";
          ariaLabel = `Draw Inspector slot ${num} of ${view.opponentHandCount}`;
        }
        btn.appendChild(buildBackContent(num, tagText));
      }

      if (slot.locked) classes.push("is-locked");
      if (isDrawable) classes.push("is-drawable");

      btn.className = classes.join(" ");
      btn.disabled = !isDrawable;
      btn.setAttribute("aria-label", ariaLabel);

      if (isDrawable) {
        btn.addEventListener(
          "click",
          () => {
            controller.drawSlot(slot.slotIndex);
          },
          { signal }
        );
      }

      refs.inspectorFan.appendChild(btn);
    }
  }

  function renderPlayerFan(snap) {
    const { view, inputLocked, selectedSwapSlot, lastSwappedSlots, newlyDrawnUnlistedSlot } = snap;
    refs.playerFan.replaceChildren();

    if (view.myHandCount === 0) {
      refs.playerFan.appendChild(
        el("div", "empty-hand-note", "Your hand is empty — every ticket matched.")
      );
      return;
    }

    const canPlayerSwap =
      !inputLocked &&
      view.phase === PHASES.OFFER &&
      view.activeActor === SIDES.PLAYER &&
      view.legal.canSwap;
    const swappableSet = new Set(view.legal.legalSwapSlots);
    const swappedSet = new Set(lastSwappedSlots || []);

    for (const slot of view.myHand) {
      const num = slot.slotIndex + 1;
      const ticket = slot.ticket;
      const isSwappable = canPlayerSwap && swappableSet.has(slot.slotIndex);
      const isSelected = selectedSwapSlot === slot.slotIndex;
      const isSwapped = swappedSet.has(slot.slotIndex);
      const isFreshUnlisted =
        ticket.isUnlisted && newlyDrawnUnlistedSlot === slot.slotIndex && !isSwapped;

      const btn = doc.createElement("button");
      btn.type = "button";
      btn.dataset.zone = "player";
      btn.dataset.slot = String(slot.slotIndex);

      const classes = ["ticket", ticket.isUnlisted ? "ticket-unlisted" : "ticket-face"];
      if (ticket.isEmblem) classes.push("is-emblem");
      if (slot.locked) classes.push("is-locked");
      if (isSwappable) classes.push("is-swappable");
      if (isSelected) classes.push("is-selected");
      if (isSwapped) classes.push("is-swapped");
      if (isFreshUnlisted) classes.push("is-new-unlisted");
      if (view.phase === PHASES.DRAW && view.activeActor === SIDES.PLAYER && !ticket.isUnlisted) {
        classes.push("is-pair-candidate");
      }

      let tagText = ticket.isUnlisted ? "Unlisted" : "In Hand";
      if (slot.lockReason === "FINAL_CALL") {
        tagText = "FINAL CALL";
      } else if (slot.locked) {
        tagText = "LOCKED";
      } else if (isSelected) {
        tagText = "SWAP 1st";
      } else if (isSwapped) {
        tagText = "SWAPPED";
      } else if (isSwappable && selectedSwapSlot !== null) {
        tagText = "Swap Here";
      } else if (isFreshUnlisted && isSwappable) {
        tagText = "NEW · HIDE?";
      } else if (isSwappable) {
        tagText = "Swap?";
      } else if (slot.publiclyRevealed) {
        tagText = "Exposed";
      }

      btn.appendChild(buildFaceContent(ticket, num, tagText));
      btn.className = classes.join(" ");
      btn.disabled = !isSwappable;
      btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
      btn.setAttribute(
        "aria-label",
        `Your slot ${num}: ${ticket.name}${ticket.isEmblem ? " (Emblem pair)" : ""}${
          slot.locked ? ", locked by Final Call" : isSelected ? ", selected to swap" : ""
        }`
      );

      if (isSwappable) {
        btn.addEventListener(
          "click",
          () => {
            controller.selectOfferSlot(slot.slotIndex);
          },
          { signal }
        );
      }

      refs.playerFan.appendChild(btn);
    }
  }

  function renderStatusAndStreak(snap) {
    const { view, statusStage, selectedSwapSlot, lastSwappedSlots, lastNotice } = snap;
    const fcActive = Boolean(view.finalCall && view.finalCall.active);

    refs.phaseBanner.classList.toggle("is-final-call", fcActive);
    refs.streakBox.classList.toggle("is-final-call", fcActive);

    refs.streakPips.replaceChildren();
    const filled = fcActive
      ? view.finalCallThreshold
      : Math.min(view.unlistedStreak, view.finalCallThreshold);
    for (let i = 0; i < view.finalCallThreshold; i += 1) {
      const pip = el("span", i < filled ? "streak-pip is-filled" : "streak-pip");
      refs.streakPips.appendChild(pip);
    }

    if (fcActive) {
      const who = view.finalCall.offerer === SIDES.PLAYER ? "Your" : "Inspector's";
      refs.streakCaption.textContent = `FINAL CALL · ${who} #${view.finalCall.slotIndex + 1} locked`;
    } else {
      refs.streakCaption.textContent = `${view.unlistedStreak} / ${view.finalCallThreshold} to Final Call`;
    }

    if (view.phase === PHASES.OVER) {
      refs.phaseTag.textContent =
        view.winner === SIDES.PLAYER ? "STOP CLEARED · VICTORY" : "STOP FAILED · UNLISTED HELD";
      refs.phasePrompt.textContent =
        view.winner === SIDES.PLAYER
          ? "Only The Unlisted remains — in the Inspector's hand."
          : "Only The Unlisted remains — left in your hand.";
      return;
    }

    const fcPrefix = fcActive ? "FINAL CALL · " : "";
    if (statusStage === "REVEAL_BEAT") {
      refs.phaseTag.textContent = `${fcPrefix}TURN ${view.turnNumber} · RESOLVING DRAW`;
      refs.phasePrompt.textContent = "Checking drawn ticket against the manifest…";
      return;
    }

    if (view.activeActor === SIDES.INSPECTOR) {
      refs.phaseTag.textContent =
        view.phase === PHASES.OFFER
          ? `${fcPrefix}TURN ${view.turnNumber} · INSPECTOR OFFERING`
          : `${fcPrefix}TURN ${view.turnNumber} · INSPECTOR DRAWING`;
      refs.phasePrompt.textContent =
        view.phase === PHASES.OFFER
          ? "The Inspector arranges his face-down tickets…"
          : "The Inspector studies your committed fan and reaches for a slot…";
      return;
    }

    if (view.phase === PHASES.OFFER) {
      refs.phaseTag.textContent = `${fcPrefix}TURN ${view.turnNumber} · YOUR OFFER`;
      if (selectedSwapSlot !== null) {
        const pickedCard = view.myHand[selectedSwapSlot]?.ticket;
        const pickedLabel = pickedCard?.isUnlisted
          ? "The Unlisted"
          : pickedCard?.shortLabel || `slot #${selectedSwapSlot + 1}`;
        refs.phasePrompt.textContent = `Slot #${selectedSwapSlot + 1} (${pickedLabel}) lifted — pick a second slot to swap privately, or press Commit Fan.`;
      } else if (view.legal.canSwap) {
        if (snap.newlyDrawnUnlistedSlot !== null) {
          refs.phasePrompt.textContent = `The Unlisted arrived at slot #${
            snap.newlyDrawnUnlistedSlot + 1
          }. Swap it privately into another slot if you wish, then press Commit Fan.`;
        } else {
          refs.phasePrompt.textContent =
            "Optionally swap two of your tickets privately (once), then press Commit Fan so the Inspector must draw.";
        }
      } else if (view.myHandCount === 1) {
        refs.phasePrompt.textContent =
          "Only 1 ticket left — press Commit Fan so the Inspector takes it and matches the pair.";
      } else if (fcActive) {
        refs.phasePrompt.textContent =
          "Final Call pins The Unlisted and marks it unavailable this turn. Press Commit Fan to continue.";
      } else if (lastSwappedSlots && lastSwappedSlots.length === 2) {
        refs.phasePrompt.textContent =
          lastNotice || "Private swap complete. Press Commit Fan so the Inspector draws.";
      } else {
        refs.phasePrompt.textContent =
          "Swap unavailable on this offer. Press Commit Fan so the Inspector draws.";
      }
      return;
    }

    // Player DRAW_PHASE
    refs.phaseTag.textContent = `${fcPrefix}TURN ${view.turnNumber} · YOUR DRAW`;
    if (fcActive) {
      refs.phasePrompt.textContent = `Final Call pinned The Unlisted at slot #${
        view.finalCall.slotIndex + 1
      }. Draw any open ticket to guarantee a matching pair.`;
    } else if (view.opponentHoldsUnlisted) {
      const safeCount = view.opponentHandCount - 1;
      refs.phasePrompt.textContent = `Pick one ticket from the Inspector's fan (${safeCount} safe ${
        safeCount === 1 ? "pair" : "pairs"
      }, 1 Unlisted hidden).`;
    } else {
      refs.phasePrompt.textContent =
        "You currently hold The Unlisted — every ticket in the Inspector's fan matches one of yours. Pick any slot.";
    }
  }

  function renderSpotlight(snap) {
    const { activeSpotlight, lastNotice, statusStage } = snap;
    refs.spotlightTray.replaceChildren();
    refs.spotlightTray.classList.toggle("is-live", statusStage === "REVEAL_BEAT");
    refs.spotlightTray.classList.toggle(
      "is-unlisted",
      Boolean(activeSpotlight && activeSpotlight.kind === "UNLISTED")
    );

    if (!activeSpotlight) {
      const copy = el("div", "spotlight-copy");
      copy.appendChild(el("span", "spotlight-headline", "Manifest Open"));
      copy.appendChild(
        el(
          "span",
          "spotlight-detail",
          lastNotice || "Match every ordinary pair and leave the Inspector holding The Unlisted."
        )
      );
      refs.spotlightTray.appendChild(copy);
      return;
    }

    const stubs = el("div", "spotlight-stubs");
    if (activeSpotlight.kind === "UNLISTED") {
      const stub = el("span", "mini-stub is-unlisted");
      stub.appendChild(el("span", "mini-punch"));
      stub.appendChild(el("span", "", "UNLISTED"));
      stubs.appendChild(stub);
    } else {
      const m = activeSpotlight.ticketMeta;
      stubs.appendChild(el("span", "mini-stub", `${m.glyph} ${m.shortLabel}`));
      stubs.appendChild(el("span", "mini-stub", `${m.glyph} ${m.shortLabel}`));
    }
    refs.spotlightTray.appendChild(stubs);

    const copy = el("div", "spotlight-copy");
    const marker = activeSpotlight.kind === "UNLISTED" ? "● " : "✓ ";
    copy.appendChild(el("span", "spotlight-headline", `${marker}${activeSpotlight.headline}`));
    copy.appendChild(el("span", "spotlight-detail", activeSpotlight.detail));
    refs.spotlightTray.appendChild(copy);
  }

  function renderManifest(snap) {
    const { view } = snap;
    const totalPairs = view.pairCount;
    const clearedMap = new Map();
    for (const pair of view.discardPairs) {
      clearedMap.set(pair.symbolId, pair);
    }
    const recentSym = view.lastResolution?.matchedSymbolId || null;

    refs.manifestCount.textContent = `${clearedMap.size} / ${totalPairs} pairs cleared (${
      totalPairs - clearedMap.size
    } live)`;

    refs.manifestList.replaceChildren();
    for (let i = 0; i < totalPairs; i += 1) {
      const sym = TICKET_SYMBOLS[i];
      const cleared = clearedMap.get(sym.id);
      const classes = ["manifest-chip"];
      let suffix = "live";
      if (cleared) {
        classes.push("is-cleared");
        if (sym.id === recentSym) classes.push("is-recent");
        suffix =
          cleared.source === "DEAL"
            ? "deal"
            : cleared.owner === SIDES.PLAYER
              ? "you"
              : "insp";
      }
      const mark = sym.isEmblem ? "★" : "";
      refs.manifestList.appendChild(
        el("span", classes.join(" "), `${sym.glyph} ${sym.shortLabel}${mark} [${suffix}]`)
      );
    }
  }

  function renderResult(snap) {
    const { view, rootSeed, encounterIndex, activeTier } = snap;
    if (view.phase !== PHASES.OVER) {
      refs.resultPanel.classList.add("hidden");
      return;
    }

    const won = view.winner === SIDES.PLAYER;
    refs.resultPanel.classList.remove("hidden");
    refs.resultPanel.classList.toggle("is-defeat", !won);
    refs.resultKicker.textContent = won
      ? `STOP #${encounterIndex + 1} (TIER ${activeTier}) · PASSENGER CLEARED`
      : `STOP #${encounterIndex + 1} (TIER ${activeTier}) · UNLISTED HELD`;
    refs.resultTitle.textContent = won
      ? "You left the Inspector holding The Unlisted."
      : "You were left holding The Unlisted.";

    refs.resultBody.textContent =
      view.endReason === "DEAL_ALL_PAIRED"
        ? "Every ordinary pair matched on the initial deal, leaving only The Unlisted."
        : `Resolved in ${view.turnNumber} ${view.turnNumber === 1 ? "turn" : "turns"} (${
            view.playedPairsDiscarded
          } played ${view.playedPairsDiscarded === 1 ? "pair" : "pairs"}, ${
            view.initialDealPairCount
          } dealt ${view.initialDealPairCount === 1 ? "pair" : "pairs"}). Seed: ${rootSeed}.`;
  }

  function renderDevTrace(snap) {
    const { devTraceOpen, devTrace } = snap;
    refs.devTraceToggle.setAttribute("aria-expanded", devTraceOpen ? "true" : "false");
    refs.devTracePanel.classList.toggle("hidden", !devTraceOpen);
    if (!devTraceOpen || !devTrace) {
      return;
    }

    refs.devTraceTitle.textContent = `Tier ${devTrace.tier} · ${devTrace.tierName}`;
    const patText = devTrace.pattern.detected
      ? `Pattern: ${devTrace.pattern.label} (${Math.round(devTrace.pattern.probability * 100)}%)`
      : "Pattern: none above threshold";
    refs.devTraceMeta.textContent = `Observed draws: ${devTrace.observations} · ${patText}`;
    refs.devTraceSummary.textContent = `${devTrace.tierSummary} (Uses only legal ObserverView + isolated AI RNG.)`;

    refs.devBuckets.replaceChildren();
    for (const b of BUCKETS) {
      const pct = Math.round((devTrace.bucketProbs[b] || 0) * 100);
      const cell = el("div", "dev-bucket-cell");
      if (devTrace.pattern.detected && devTrace.pattern.bucket === b) {
        cell.classList.add("is-dominant");
      }
      cell.appendChild(el("span", "dev-bucket-name", BUCKET_LABELS[b]));
      const barWrap = el("span", "dev-bucket-bar");
      const fill = el("span", "dev-bucket-fill");
      fill.setAttribute("style", `width:${pct}%`);
      barWrap.appendChild(fill);
      cell.appendChild(barWrap);
      cell.appendChild(el("span", "dev-bucket-pct", `${pct}%`));
      refs.devBuckets.appendChild(cell);
    }

    refs.devTraceList.replaceChildren();
    if (devTrace.entries.length === 0) {
      refs.devTraceList.appendChild(
        el("li", "dev-trace-item", "No Inspector decisions recorded in this duel yet.")
      );
      return;
    }

    for (const entry of devTrace.entries) {
      const li = el("li", "dev-trace-item");
      const head = `[T${entry.turnNumber} · ${entry.role} · ${entry.actionType}${
        entry.rngRoll !== null ? ` · rng=${entry.rngRoll}` : ""
      }] `;
      li.appendChild(el("strong", "", head));
      li.appendChild(el("span", "", entry.reason));

      const facts = entry.observedFacts || {};
      const factBits = [
        `hands=${facts.myHandCount}v${facts.opponentHandCount}`,
        `streak=${facts.unlistedStreak}`,
      ];
      if (facts.validReveals && facts.validReveals.length > 0) {
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
      li.appendChild(el("div", "dev-trace-facts", `Facts: ${factBits.join(" · ")}`));
      refs.devTraceList.appendChild(li);
    }
  }

  function render(snap) {
    const {
      view,
      rootSeed,
      pairCount,
      startingMode,
      tierMode,
      activeTier,
      activeTierName,
      inspectorTell,
      encounterIndex,
      reducedMotion,
      inputLocked,
      lastSwappedSlots,
    } = snap;
    if (!view) return;

    doc.body.classList.toggle("reduced-motion", reducedMotion);
    if (doc.activeElement !== refs.seedInput) {
      refs.seedInput.value = rootSeed;
    }
    refs.pairsSelect.value = String(pairCount);
    refs.tierSelect.value = tierMode;
    refs.starterSelect.value = startingMode;
    refs.reducedMotionToggle.checked = reducedMotion;

    const firstDrawLabel =
      view.publicHistory[0]?.startingDrawer === SIDES.PLAYER
        ? "You drew 1st"
        : "Inspector drew 1st";
    refs.subtitle.textContent = `Stop #${encounterIndex + 1} · Seed ${rootSeed} · ${firstDrawLabel}`;
    refs.inspectorTier.textContent = `T${activeTier} · ${activeTierName}`;

    const playerOffering = view.phase === PHASES.OFFER && view.activeActor === SIDES.PLAYER;
    const playerDrawing = view.phase === PHASES.DRAW && view.activeActor === SIDES.PLAYER;

    refs.inspectorSeat.classList.toggle("active-target", !inputLocked && playerDrawing);
    refs.playerSeat.classList.toggle("active-target", !inputLocked && playerOffering);

    refs.inspectorRole.textContent =
      view.phase === PHASES.OVER
        ? view.loser === SIDES.INSPECTOR
          ? "HOLDS UNLISTED"
          : "CLEARED"
        : view.offerer === SIDES.INSPECTOR
          ? "OFFERER"
          : "DRAWER";
    refs.inspectorRole.classList.toggle("is-active", view.activeActor === SIDES.INSPECTOR);

    refs.playerRole.textContent =
      view.phase === PHASES.OVER
        ? view.loser === SIDES.PLAYER
          ? "HOLDS UNLISTED"
          : "CLEARED"
        : view.offerer === SIDES.PLAYER
          ? "OFFERER"
          : "DRAWER";
    refs.playerRole.classList.toggle("is-active", view.activeActor === SIDES.PLAYER);

    refs.inspectorCount.textContent = `${view.opponentHandCount} ${
      view.opponentHandCount === 1 ? "ticket" : "tickets"
    }`;
    refs.playerCount.textContent = `${view.myHandCount} ${
      view.myHandCount === 1 ? "ticket" : "tickets"
    }`;

    if (view.phase === PHASES.OVER) {
      refs.inspectorRisk.textContent = "";
    } else if (view.opponentHoldsUnlisted) {
      refs.inspectorRisk.textContent = inspectorTell
        ? `▲ Holds Unlisted · ${inspectorTell}`
        : "▲ Holds The Unlisted";
    } else {
      refs.inspectorRisk.textContent = "All ordinary tickets";
    }

    const showCommit = view.phase === PHASES.OFFER && view.activeActor === SIDES.PLAYER;
    refs.commitBtn.classList.toggle("hidden", !showCommit);
    refs.commitBtn.disabled = !showCommit || inputLocked;

    if (showCommit) {
      if (view.legal.canSwap) {
        refs.swapStatus.textContent = `${view.legal.swapsRemaining} private swap left`;
      } else if (view.myHandCount === 1) {
        refs.swapStatus.textContent = "Single ticket";
      } else if (lastSwappedSlots && lastSwappedSlots.length === 2) {
        refs.swapStatus.textContent = "Swap used";
      } else {
        refs.swapStatus.textContent = "Swap locked";
      }
    } else if (view.iHoldUnlisted && view.phase !== PHASES.OVER) {
      refs.swapStatus.textContent = "● The Unlisted is in your hand";
    } else {
      refs.swapStatus.textContent = "";
    }

    const activeEl = doc.activeElement;
    const prevFocusZone = activeEl?.dataset?.zone || null;
    const prevFocusSlot = activeEl?.dataset?.slot || null;

    renderStatusAndStreak(snap);
    renderSpotlight(snap);
    renderInspectorFan(snap);
    renderPlayerFan(snap);
    renderResult(snap);
    renderManifest(snap);
    renderDevTrace(snap);

    if (prevFocusZone && prevFocusSlot !== null && !inputLocked) {
      const fanEl = prevFocusZone === "inspector" ? refs.inspectorFan : refs.playerFan;
      const sameBtn = fanEl.querySelector(
        `button.ticket[data-slot="${prevFocusSlot}"]:not(:disabled)`
      );
      if (sameBtn) {
        sameBtn.focus();
      } else if (prevFocusZone === "player" && showCommit && !refs.commitBtn.disabled) {
        refs.commitBtn.focus();
      }
    }
  }

  // Controls form starts a fresh run (resetting learned AI habits).
  refs.controlsForm.addEventListener(
    "submit",
    (ev) => {
      ev.preventDefault();
      controller.startNewRun({
        seed: refs.seedInput.value,
        pairCount: Number.parseInt(refs.pairsSelect.value, 10),
        tierMode: refs.tierSelect.value || TIER_MODES.RAMP,
        startingMode: refs.starterSelect.value || STARTING_MODES.ALTERNATE,
      });
      refs.seedInput.value = controller.getSnapshot().rootSeed;
    },
    { signal }
  );

  refs.newSeedBtn.addEventListener(
    "click",
    () => {
      controller.startNewRun({
        allowRandomSeed: true,
        pairCount: Number.parseInt(refs.pairsSelect.value, 10),
        tierMode: refs.tierSelect.value || TIER_MODES.RAMP,
        startingMode: refs.starterSelect.value || STARTING_MODES.ALTERNATE,
      });
    },
    { signal }
  );

  refs.restartBtn.addEventListener(
    "click",
    () => {
      controller.restartDuel();
    },
    { signal }
  );

  refs.resetRunBtn.addEventListener(
    "click",
    () => {
      controller.startNewRun();
    },
    { signal }
  );

  refs.reducedMotionToggle.addEventListener(
    "change",
    () => {
      controller.setReducedMotion(refs.reducedMotionToggle.checked);
    },
    { signal }
  );

  refs.commitBtn.addEventListener(
    "click",
    () => {
      controller.commitOffer();
    },
    { signal }
  );

  refs.nextDuelBtn.addEventListener(
    "click",
    () => {
      controller.nextEncounter();
    },
    { signal }
  );

  refs.replayDuelBtn.addEventListener(
    "click",
    () => {
      controller.restartDuel();
    },
    { signal }
  );

  refs.devTraceToggle.addEventListener(
    "click",
    () => {
      controller.toggleDevTrace();
    },
    { signal }
  );

  doc.addEventListener(
    "keydown",
    (ev) => {
      if (ev.altKey && (ev.key === "d" || ev.key === "D")) {
        ev.preventDefault();
        controller.toggleDevTrace();
        return;
      }

      const targetTag = ev.target?.tagName;
      if (targetTag === "INPUT" || targetTag === "SELECT" || targetTag === "TEXTAREA") {
        return;
      }

      const snap = controller.getSnapshot();
      if (!snap.view || snap.inputLocked) return;

      if ((ev.key === "c" || ev.key === "C") && snap.view.legal.canCommit) {
        ev.preventDefault();
        controller.commitOffer();
        return;
      }

      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        const container =
          snap.view.phase === PHASES.DRAW && snap.view.activeActor === SIDES.PLAYER
            ? refs.inspectorFan
            : snap.view.phase === PHASES.OFFER && snap.view.activeActor === SIDES.PLAYER
              ? refs.playerFan
              : null;
        if (!container) return;

        const enabled = Array.from(container.querySelectorAll("button.ticket:not(:disabled)"));
        if (enabled.length === 0) return;
        ev.preventDefault();
        const idx = enabled.indexOf(doc.activeElement);
        let nextIdx;
        if (idx === -1) {
          nextIdx = ev.key === "ArrowRight" ? 0 : enabled.length - 1;
        } else {
          const delta = ev.key === "ArrowRight" ? 1 : -1;
          nextIdx = (idx + delta + enabled.length) % enabled.length;
        }
        enabled[nextIdx].focus();
      }
    },
    { signal }
  );

  const unsubscribe = controller.subscribe(render);

  function destroy() {
    unsubscribe();
    abortController.abort();
  }

  return Object.freeze({ destroy, render });
}
