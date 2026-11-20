/**
 * tests/phase4.test.js
 * Node test entry for the Phase 4 suite (procedural art, PS1 stage, ticket art,
 * tactile motion, reduced motion, and procedural WebAudio).
 */

import test from "node:test";
import {
  testKeyboardAndNonColorIndicators,
  testMotionProfilesAndCueMapping,
  testRapidInputCannotDuplicate,
  testResponsiveConstraints,
  testPaletteAndPs1Quantisation,
  testPresentationWiringContract,
  testProceduralAudio,
  testProceduralTicketArt,
  testSceneRendersDeterministicFrame,
  testSceneCompositionAndAnchors,
  testStageSoftwareFallbackAndToggle,
} from "./phase4Suite.js";

test("10. Palette + PS1 ordered-dither quantisation stay in the locked 5-bit palette ramps", () => {
  testPaletteAndPs1Quantisation();
});

test("11. Procedural 2.5D carriage renders deterministically: 300+ low-poly facets across background/table/fixtures, clipped rain, one post pass, sway in full motion only", () => {
  testSceneRendersDeterministicFrame();
});

test("12. Stage mounts its software shader fallback, toggles pixelation live, pauses when hidden, and disposes every rAF", () => {
  testStageSoftwareFallbackAndToggle();
});

test("13. All 12 ticket emblems + Unlisted punch + card back are procedural, cached, offline SVG data URIs", () => {
  testProceduralTicketArt();
});

test("14. Motion cue map covers every gameplay beat, reduced motion is shorter and never shakes, sway returns to exact rest", () => {
  testMotionProfilesAndCueMapping();
});

test("15. WebAudio synthesises every cue, debounces repeats, obeys mute/volume immediately and across reloads, and disposes nodes", () => {
  testProceduralAudio();
});

test("16. Presentation layer binds audio/pixelation controls, M/P shortcuts, click-through stage, and phone/short-viewport rules", () => {
  testPresentationWiringContract();
});

test("17. Rapid repeat clicks/keypresses during resolution cannot trigger duplicate actions", () => {
  testRapidInputCannotDuplicate();
});

test("18. Keyboard-only traversal works and every gameplay state has a text/shape indicator independent of colour", () => {
  testKeyboardAndNonColorIndicators();
});

test("19. Desktop 1280x800 and phone portrait 390x844 layouts cannot overflow; the stage is layout-free", () => {
  testResponsiveConstraints();
});

test("20. Carriage composition: Inspector upper-centre, table widens toward the foreground, fans at the far and near edges, every HUD anchor present in both framings", () => {
  testSceneCompositionAndAnchors();
});
