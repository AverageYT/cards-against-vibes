/**
 * tests/phase2.test.js
 * Plain Node (`node --test`) entry point for Phase 2 AI & learning checks.
 */

import test from "node:test";
import { PHASE2_TESTS } from "./phase2Suite.js";

for (const tc of PHASE2_TESTS) {
  test(tc.name, () => {
    tc.run();
  });
}
