/**
 * tests/phase1.test.js
 * Plain Node (`node --test`) entry point for Phase 1 checks.
 */

import test from "node:test";
import { PHASE1_TESTS } from "./phase1Suite.js";

for (const tc of PHASE1_TESTS) {
  test(tc.name, () => {
    tc.run();
  });
}
