/**
 * tests/phase3.test.js
 * Plain-Node (`node --test`) entry point executing every Phase 3 check.
 */

import test from "node:test";
import { getPhase3Tests } from "./phase3Suite.js";

for (const entry of getPhase3Tests()) {
  test(entry.name, () => {
    entry.fn();
  });
}
