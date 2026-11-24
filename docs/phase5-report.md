# Phase 5 — Story, Inspectable Items & Inspector Dialogue

## Delivered

- Two-page, skippable title intro; five station arrival notes; four optional,
  independently inspectable carriage objects on the existing briefing screen;
  distinct two-page, skippable victory and defeat endings. They do not gate any
  action or contain rules required to play.
- Inspector remarks for the first deal, early player pair, player drawing the
  Unlisted, Final Call, Stamp reward, hand result and run result. Dialogue is
  text-only, has skip and independently muted controls, a global 1.8 s and
  per-category 7 s cooldown, event deduplication, and no consecutive repeated
  line. Suppressed events are discarded rather than queued, so nothing delays
  or changes gameplay. Reduced-motion and sound mute remain independent.
- Habit remarks use only `getInspectorHabitSummary()` (the existing learner's
  public-draw observation count and smoothed bucket probabilities). The same
  `LEARNER_TUNING` minimum sample and probability thresholds are applied; the
  dialogue never receives the learner's private reveal memory, hidden hands,
  ticket identities or an RNG. It does not modify the AI or game state.
- The live remark is an `aria-live` receipt with `pointer-events: none` in the
  desktop margin and a reserved flow slot on narrower layouts. Mute and skip
  are keyboard-accessible controls, independent of gameplay. The story modules
  have no asset or external-service dependencies.

## Checks run

- `npm test`: **51/51**. Tests cover every dialogue category, event selection,
  cooldowns, non-repetition, mute/skip, forced-draw exclusion and actual learner
  thresholds. Hidden-hand perturbation does not alter dialogue events. Paired
  complete seeded runs with and without dialogue observation produce identical
  outcome, run statistics and stop history.
- Chromium/SwiftShader at 1280×800 and emulated 390×844: advanced and skipped
  intro; opened all four objects; checked arrival note; saw first-deal remark;
  skipped and muted it; drew a card while muted. No page errors.
- Both ending screens were reached through actual seeded controller runs, with
  immediate timings and legal automated actions: `STORY-0` defeat and
  `STORY-58` victory. Both pages advanced and skipped at desktop and phone; no
  page errors. The harness directly invoked the real controller for speed; this
  is not a full manual clickthrough of both runs.
- A legal automated victory run with an accelerated **dialogue clock only**
  exercised first deal, early pair, Unlisted, Final Call, reward, hand outcomes,
  run victory and several learned buckets. At 1200×720, 1280×800, 2560×1080,
  800×720, 390×844 and 1080×2340, its visible dialogue bounds did not intersect
  enabled buttons, inputs or summaries. The normal real-time cooldown logic is
  separately covered by unit tests; accelerated dialogue was used only for this
  placement/event sweep.
- The full interactive tutorial was replayed at desktop and phone (emulated
  touch on phone) through the winning draw and briefing transition. The lamp
  rack was moved below a wrapped topbar after a victory screenshot exposed an
  overlap with the new controls.
- `git diff --check` clean. Original `TODO.md` Phase 4's human keyboard-only
  traversal checkbox and all Phase 6 completion checks remain open.

## Limitations

No physical touchscreen, hardware GPU, screen reader, real audio listening,
complete human keyboard-only run or exhaustive contrast/zoom audit was
available. Remarks are text rather than speech; their mute control silences text
remarks, not the separate sound engine. `tests/browser.html` still cannot load
Node-only imports; the Node suite and independent real-browser checks above ran.
Some simultaneous events are intentionally dropped during cooldown, rather than
replayed later. The pre-existing Final Call turn-slip notice precedence noted in
`ART-PASS.md` remains unchanged. Phase 6 is the next review step, not started.
