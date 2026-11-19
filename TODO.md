# TODO.md — *The Unlisted* (5-Day Contest Build Plan)

Source of truth for building and shipping **The Unlisted** for Hack Club Vibes.
- **Start date**: Wednesday, November 18, 2026
- **Contest deadline**: Monday, November 23, 2026 (~5 days total)
- **Shipping rule**: After every phase from Phase 1 onward, the repository runs as a complete, shippable static browser game. Always cut from the bottom of the priority list, never from the top.

---

## Priority Tiers

### MUST SHIP
- [x] Deterministic rules engine + automated Node & browser tests + playable duel from both sides *(Phase 1 — Node suite passed; live static build served)*
- [x] Inspector AI Tiers 1–3, strict legal-info boundary, separate AI RNG stream, positional habit learning (normalized buckets, smoothing, decay, run reset), developer-only decision trace *(Phase 2 — verified with permutation invariance, edge→center adaptation, run reset, and 36,000-duel paired-seed benchmark)*
- [ ] Full run: 4 carriage duels + Final Inspection, 3 lantern charges (early loss advance, boss rematch, defeat, victory), ≥6 Stamps with tradeoffs, ≥3 Carriage Conditions with expiry display, **beginner-friendly interactive tutorial (assumes zero knowledge of Old Maid or card games; simple step-by-step hands-on walkthrough of core rules + custom mechanics; skippable & replayable)**, seed entry/replay, restart
- [ ] Procedural railway-carriage tabletop art (Canvas + SVG), PS1-style pixelation + ordered dithering with live toggle, sharp UI layer, title/table/reward/result screens, phone portrait + desktop layouts
- [ ] Procedural WebAudio (draw, flip/match, punch/stamp, lantern loss), mute & volume, reduced-motion mode, double-draw protection, full keyboard play
- [ ] Short intro, 2 distinct endings (defeat + rule-payoff victory), event-driven courteous Inspector dialogue (with real-pattern remarks, cooldowns, no repeats, skip/mute), ≥3 inspectable carriage items
- [ ] Zero-build offline-ready static site deployable directly to GitHub Pages, `README.md` (30-sec how-to-play, deploy guide, file map, honest limitations)

### SHOULD SHIP
- [x] Inspector AI Tiers 4 and 5 *(Phase 2 — condition/small-hand/hide-habit auditor + plausible hidden-arrangement scorer, exact lookahead EV, and transition tracker with fallible exploration)*
- [ ] 8 Stamps total (+ *Bell Cord*, *Last-Stop Punch*) and 4 Carriage Conditions total (+ *Short Whistle*)
- [ ] Procedural WebAudio midnight-train ambient background music loop (separately balanced / respects mute & volume)

### STRETCH
- [x] Saved AI tier benchmark report (`docs/ai-benchmark.md`) *(Phase 2 — 36,000 paired duels across Tiers 1–5 and 6 fixed policies)*
- [ ] Extra inspectable carriage lore items (4–5 total)
- [ ] Extra dithering, window-rain reflection, and tactile card-motion polish

---

## Planned Architecture (Static ES Modules, No Build Step, Zero CDN)

- `index.html` — Single entry page (works on GitHub Pages and local static server, zero external URLs)
- `styles/` — Layout, crisp UI typography/tokens, ticket controls, responsive desktop/phone rules, reduced-motion overrides
- `src/core/rng.js` — Seed normalization, SplitMix32/Mulberry32 PRNG, isolated stream derivation (`run`, `shuffle`, `ai`, `visual`)
- `src/core/engine.js` — Pure duel state machine, setup/deal/purge, action validation, swap/commit/draw, Final Call, Stamp & Condition hooks, replay runner, invariant checker
- `src/core/observer.js` — Legal-information projection (`ObserverView`) enforcing AI information boundaries
- `src/core/run.js` — 5-stop run state machine, lantern charges, reward selection/replacement, rematches, tutorial controller, restart
- `src/ai/` — `learner.js` (5-bucket normalized draw tracker with decay + smoothing), `inspector.js` (Tiers 1–5 + decision trace), `policies.js` (scripted benchmark bots)
- `src/data/` — Easy-to-edit definitions: `tickets.js`, `stamps.js`, `conditions.js`, `carriages.js`, `dialogue.js`, `lore.js`, `palette.js`, `aiTuning.js`
- `src/visuals/` — `scene.js` (procedural carriage, inspector reflection, lamp, rain, low-res PS1 Bayer dithering pass + pixelation toggle), `tickets.js` (procedural SVG emblems + Unlisted punch), `motion.js` (timed transitions + reduced-motion profiles)
- `src/audio/sound.js` — Procedural WebAudio effects + optional ambient loop, mute & volume
- `src/ui/` — Screen controller, event/timer lifecycle registry (clean teardown on restart), keyboard navigation, dev trace drawer
- `tests/` — Plain Node (`node --test`) automated suites + `tests/browser.html` in-browser runner + AI benchmark script

---

## Phase Roadmap

### Phase 0 — Inspection, `RULES.md` & `TODO.md` (Done)
- **Status**: Completed
- **Deliverables**: Repository/environment inspection, `RULES.md` (including Decisions D1–D10), `TODO.md`, stack & constraint check, Phase 1 handoff prompt.

---

### Phase 1 — Core Mechanics & Playable Duel (Done)
- **Status**: Completed (Node checks verified 10/10; static server running on port 8080; interactive browser check ready for human playtest)
- **Time budget**: ~1 day (Day 1)
- **Dependencies**: Phase 0 (`RULES.md`)
- **Scope**:
  - Implement `src/core/rng.js`, `src/data/tickets.js`, `src/core/engine.js`, and `src/core/observer.js` (foundational legal view).
  - Support 6–12 pair decks, unique ticket IDs, seeded shuffle & alternating deal, auto-discard of initial pairs, first-action alternation, `OFFER_PHASE` (private swap + commit) and `DRAW_PHASE` (slot pick, pair discard, end check, role switch), Final Call (3-transfer streak lock + small-hand deadlock waiver), action validation/duplicate rejection, and deterministic action-log replay.
  - Build a clean, playable browser duel (`index.html`, `styles/main.css`, `src/ui/duelController.js`, `src/ui/duelView.js`, `src/main.js`) against a seeded uniform-random Inspector (`src/ai/randomOpponent.js`, isolated `aiStream`) with input locking, swap/arrival clarity badges, starting-side/seed/pair-count controls, reduced-motion toggle, keyboard navigation, and restart.
  - Create plain-Node test suite (`tests/phase1.test.js`, `tests/phase1Suite.js`, `tests/domIntegrity.test.js`) and `tests/browser.html`.
- **Review-loop comparison target**: *Old Maid* (hidden draw tension and pair-discard clarity).
- **Completion checks**:
  1. [x] Full duel completes cleanly from both starting sides (Player first and Inspector first), including immediate post-deal empty-hand termination when all ordinary pairs match on the deal *(verified via `node --test` engine, controller, and DOM-binding flows; human browser clickthrough pending)*.
  2. [x] Automated `node --test` checks verify strict card conservation and legal-only pair discards across 6–12 pair decks and 560 seeded duels (every step checked by `verifyInvariants`).
  3. [x] Automated checks verify duplicate/out-of-turn/out-of-bounds/locked input rejection (zero state mutation, controller double-draw input lock, and timer teardown on restart/dispose) and Final Call activation at 3 consecutive Unlisted transfers plus non-deadlocking small-hand fallback.
  4. [x] Automated replay tests confirm identical final states and event logs across 60 JSON-serialized seed+action replays, controller restart determinism, distinct deals across different seeds, and strict `shuffle`/`ai` RNG & `ObserverView` isolation.

---

### Phase 2 — Opponent AI, Habit Learning & Decision Trace (Done)
- **Status**: Completed (all 5 Tiers + learner + dev trace + `docs/ai-benchmark.md` verified; 16/16 Node checks passed; 36,000-duel paired-seed benchmark passed)
- **Time budget**: ~1 day (Day 2)
- **Dependencies**: Phase 1
- **Scope**:
  - Implemented `src/ai/learner.js`, `src/data/aiTuning.js`, `src/ai/inspector.js`, and `src/ai/policies.js`.
  - Shipped Tiers 1–3 (MUST) and Tiers 4–5 (SHOULD) strictly consuming `ObserverView` + isolated `aiStream`.
  - Implemented normalized 5-bucket positional learning (smoothing + exponential decay, forced-draw skip, transition tracking for Tier 5, new-run reset) and strictly offer-scoped reveal memory.
  - Added developer-only decision trace panel in the UI (hidden by default, toggleable via `Dev Trace` button, `Alt+D`, or `?dev=1`), Tier selector (`Ramp T1→T5` or direct `Tier 1..5`), plus UI clarity fixes from Phase 1 screenshot review (accurate 1-ticket offer text & tighter vertical fit).
  - Built and ran paired-seed benchmark suite (`tests/benchmark.js`, saved to `docs/ai-benchmark.md`) across all 5 tiers and 6 fixed policies; diagnosed and fixed Tier 4's anti-phase recency lag against alternating drawers.
- **Review-loop comparison target**: *Slay the Spire* / *Buckshot Roulette* (readable opponent intent/pressure without hidden-state cheating).
- **Completion checks**:
  1. [x] Automated information-barrier test proves that permuting the player's hidden unrevealed tickets (full fan, partial *Drafty Window* reveal, private player swap, and offer phase) while keeping `ObserverView` and `aiStream` seed constant produces the exact same Inspector action and decision trace across Tiers 1–5.
  2. [x] Automated adaptation test proves a scripted left-edge picker raises Tier 3/4/5 left-edge Unlisted placement (e.g., Tier 3: `21.5% → 65.8%`, Tier 5: `→ 94.5%` while Tier 1 stays `18.0%`), switching mid-run to a center picker decays left-edge and shifts placement to center (Tier 3: `CENTER 63.7%` vs `LEFT_EDGE 12.5%`; Tier 5: `CENTER 93.5%` vs `LEFT_EDGE 2.0%`), and starting a new run resets learned weights to uniform `0.20`.
  3. [x] Paired-seed benchmark (`N = 1,200` paired duels/cell, `36,000` total duels) confirms monotonic overall scaling across exploitable policies (`T1 44.5% → T2 49.9% → T3 62.3% → T4 67.4% → T5 71.2%`) and ~50% neutrality vs. Uniform Control, with non-monotonic Tier 4 alternation lag investigated, fixed, and recorded in `docs/ai-benchmark.md`.
  4. [x] Developer-only decision trace records observed facts, active reveal memory, lookahead values, and 5-bucket probabilities behind each AI move without exposing hidden player cards (or live unpicked slot indices), and stays hidden during normal play.

---

### Phase 3 — Run Structure, Stamps, Conditions & Beginner-Friendly Interactive Tutorial
- **Time budget**: ~1 day (Day 3)
- **Dependencies**: Phase 2
- **Scope**:
  - Implement `src/data/stamps.js`, `src/data/conditions.js`, `src/data/carriages.js`, `src/core/tutorial.js`, and `src/core/run.js`, wired into `src/core/engine.js` and the browser UI.
  - 5-stop run (Carriages I–IV + Final Inspection, 6→7→9→10→12 pairs, alternating first action, Tiers 1→5), 3 Lantern charges, early-loss progression (lose 1 lantern, no reward, advance), Final Inspection rematch while lanterns remain, defeat on 0 lanterns, victory on Stop 5 win.
  - Ship ≥6 Stamps (target all 8) tied to marked Emblem Pairs ★ (`LANTERN`, `WATCH`, `KEY`, `BELL`), 3 Stamp slots, post-win reward tray (pick 1 of 3, replace existing, or skip).
  - Ship ≥3 Carriage Conditions (target all 4) with pre-duel briefing and live on-table expiry countdown.
  - **Zero-prior-knowledge interactive tutorial (skippable & replayable)**: assume the player has *never* played Old Maid or any card game before. Use short, plain-language prompts right on a live guided practice table to walk them hands-on through every step one concept at a time:
    1. What tickets and pairs are, why automatic opening pairs clear, and the single goal (pair every ticket; never be left alone with the blank punched **Unlisted** ticket),
    2. Taking a **Draw** turn (picking one face-down ticket from the Inspector's fan and seeing it match a ticket in your hand and vanish),
    3. Drawing **The Unlisted** (seeing that it has no matching twin, stays in your hand, and advances the **Unlisted Streak** toward **Final Call** — explaining simply how Final Call pins it after 3 passes in a row),
    4. Taking an **Offer** turn (privately swapping two of your own tickets to hide The Unlisted, why the Inspector watches patterns, and clicking **Commit Fan** so he draws from you),
    5. Introducing the custom run mechanics hands-on: using a sample **Stamp** (*Inspection Window* — including its tradeoff), spotting marked **Emblem Pairs (`★`)** that interact with Stamps, seeing how **Carriage Conditions** work and expire, and seeing how your **3 Lantern charges** carry you across the 4 carriages + Final Inspection.
    - Never dump a wall of text; highlight only the exact control/ticket needed for the current step, allow **Skip Tutorial** at any point, and let players re-open the tutorial anytime from the start/menu screen.
  - Add repeatable/shareable run seed entry/display, and full run restart (resetting AI learner cleanly).
- **Review-loop comparison target**: *Balatro* (meaningful upgrade tradeoffs, slot tension, Stamp synergies changing in-duel decisions, and effortless learn-by-doing onboarding).
- **Completion checks**:
  1. [ ] Beginner-friendly interactive tutorial works step-by-step from zero Old Maid knowledge through core draw/pair/Unlisted/swap/offer play AND custom mechanics (Stamp use + tradeoff, Emblem pairs `★`, Final Call, Carriage Conditions, Lanterns), can be skipped at any step, and can be replayed cleanly.
  2. [ ] Automated + controller flow tests pass for full 5-stop run progression: 4 carriage wins with Stamp pick/replace/skip, Final Inspection victory, early-carriage loss (spends 1 lantern, no reward, advances), Final Inspection loss rematch while lanterns remain, 0-lantern Defeat, and clean full-run restart.
  3. [ ] Every shipped Stamp (≥6, target 8) and Carriage Condition (≥3, target 4) passes card-conservation, no-deadlock, charge-reset, and expiration checks, and at least two Stamp combinations (*Inspection Window + Carbon Copy* and *Inspection Window + Night Transfer* / *Manifest Loupe + Brass Weight*) measurably alter legal/optimal turn actions in scripted seed tests.
  4. [ ] Same run seed reproduces identical carriage conditions, Stamp offers, and encounter shuffles across independent runs.

---

### Phase 4 — Procedural Art, Tabletop Feel & WebAudio
- **Time budget**: ~1 day (Day 4)
- **Dependencies**: Phase 3
- **Scope**:
  - Implement `src/data/palette.js`, `src/visuals/scene.js`, `src/visuals/tickets.js`, `src/visuals/motion.js`, and `src/audio/sound.js`.
  - Procedural midnight railway carriage scene on offscreen low-res `<canvas>`: scratched fold-down table, brass lamp & trim, rain-streaked window, weak amber overhead cone, dark blue shadows, still Inspector in rain-dark coat partly obscured by window reflection.
  - PS1-style pixelation pass with ordered Bayer dithering and restrained color quantization + live Pixelation toggle; crisp separate UI/SVG layer for labels, ticket symbols, Emblem markers, condition badges, and focus rings.
  - Stylized aged ticket stock, 12 high-contrast railway emblems, and the damp blank Unlisted ticket with black punch hole across Title Screen, Table, Reward Tray, and Result Screen.
  - Tactile animations (lift/settle, commit-to-reveal suspense beat, pair snap, heavy ticket punch, lantern loss, subtle train sway), double-draw lock, reduced-motion toggle, full keyboard controls, responsive phone portrait + desktop layouts, and non-color-only state indicators.
  - Procedural WebAudio synth: draw, flip/match, stamp punch, lantern loss (MUST) + subtle ambient train/chords loop (SHOULD), with mute toggle and volume slider.
- **Review-loop comparison target**: *Buckshot Roulette* (tabletop framing, pause-before-reveal tension, and distinct physical action cues).
- **Completion checks**:
  1. [ ] Title screen, carriage table, reward tray, and result screen fit cleanly on both desktop (1280×800) and phone portrait (390×844) layouts with accessible controls and pixelation toggle switching cleanly while UI text/symbols stay sharp (verified in a real browser if available; otherwise verified via layout/render unit checks plus live preview for human screenshot verification).
  2. [ ] Procedural WebAudio cues for draw, match, punch/stamp, and lantern loss (plus ambient loop if shipped) synthesize without errors and obey mute and volume settings immediately and across reloads.
  3. [ ] Reduced-motion toggle shortens animations and stops ambient carriage sway; rapid repeat clicks/keypresses during resolution cannot trigger duplicate actions.
  4. [ ] Keyboard-only focus traversal works across all screens and every gameplay state (locks, public/private reveals, Emblem pairs, lanterns, Final Call) has an explicit icon/shape/text indicator independent of color and sound.

---

### Phase 5 — Story, Inspectable Items & Inspector Dialogue
- **Time budget**: ~0.5 day (Day 5 morning)
- **Dependencies**: Phase 4
- **Scope**:
  - Implement `src/data/lore.js`, `src/data/dialogue.js`, and UI integration for story beats.
  - Short skippable opening intro, abandoned-station carriage arrival notes, ≥3 optional inspectable carriage items between duels (target 4: e.g., *Brass Manifest Clipboard*, *Water-Stained Timetable*, *Unclaimed Luggage Tag*, *Guard's Punch Ledger*) building the mystery of crossed-out names while keeping all rules out of optional lore.
  - Distinct Defeat ending and Victory ending paying off in the rules (why the Inspector can never be the passenger left standing on the platform).
  - Event-driven courteous Inspector dialogue for first deal, early success, drawing the Unlisted, genuine AI-observed habit patterns, Final Call, Stamp rewards, and duel/run outcomes — with per-category and global cooldowns, no back-to-back repeats, strict no-hidden-card guarantee, non-obstructive placement, and skip/mute control.
- **Review-loop comparison target**: *Buckshot Roulette* (terse opponent remarks that reinforce table presence without interrupting play).
- **Completion checks**:
  1. [ ] Intro, ≥3 inspectable carriage items between stops, Defeat ending, and Victory ending all render, advance, and skip cleanly, with zero gameplay rules hidden solely inside optional lore.
  2. [ ] Dialogue engine tests verify triggers for all required events, enforce global + category cooldowns and zero consecutive repeats, and honor dialogue skip/mute.
  3. [ ] Learning-remark tests confirm habit lines fire only when backed by actual thresholded `learner.js` bucket skew and never reference hidden ticket identities, and UI placement never overlaps or disables legal actions.

---

### Phase 6 — Polish, Final QA, Static Deploy & Submission
- **Time budget**: ~0.5 day + buffer (Day 5 afternoon)
- **Dependencies**: Phase 5
- **Scope**:
  - End-to-end verification pass: fresh session (cleared storage), tutorial skip, full keyboard-only play, phone portrait & desktop, mute/volume & reduced-motion & pixelation & dialogue toggles, seed replay, normal carriage loss, Final Inspection rematch & loss, full victory, and repeated mid-duel/post-run restarts.
  - Verify strict disposal of all timers (`setTimeout`/`setInterval`), `requestAnimationFrame` loops, DOM listeners, and audio nodes when starting a new run.
  - Audit `src/data/` for clean modifiability (names, cards, colors, Stamps, Conditions, AI tuning) and document exact steps to add a carriage or Stamp.
  - Verify static GitHub Pages readiness (relative paths, zero CDN/network calls, tiny download size, optional `.nojekyll`), optionally output stretch `docs/ai-benchmark.md`.
  - Write final `README.md` (30-second "How to Play", controls, seed sharing, local run/test steps, GitHub Pages deploy instructions, complete file map, completed checklist, and honest list of remaining limitations/human-playtest items).
- **Review-loop comparison target**: *Old Maid* + *Balatro* onboarding-to-depth flow (30-second comprehension, 10–20 minute complete run).
- **Completion checks**:
  1. [ ] Full automated test suite + lifecycle leak check pass (confirming zero stale timers, RAF handles, or event listeners survive a run restart across every scenario: tutorial skip, seed replay, normal loss, boss rematch, boss loss, victory).
  2. [ ] Modifiability check confirms ticket data, palette, Stamp definitions, conditions, carriages, dialogue, and AI tuning are centralized in `src/data/` with a clear guide for adding a carriage or Stamp.
  3. [ ] Static build audit confirms zero external/CDN URLs, zero binary art/audio assets, compact download size, and drop-in GitHub Pages compatibility.
  4. [ ] `README.md` and `TODO.md` are finalized with the 30-second how-to-play, file map, GitHub Pages deployment steps, verified results, and transparent notes on any checks requiring human browser/audio review.
