/**
 * History v2 §6 test 1, seeds 1 to 700 of 2100 (`history-tree-properties.mjs`
 * holds the generator and the invariants; the shards run in parallel).
 * `HISTORY_SEEDS=n` runs seeds 1 to n here instead, for a deeper local run.
 */
import { runPoolTest, runSeeds } from './history-tree-properties.mjs';

const deeper = Number(process.env.HISTORY_SEEDS ?? 0);
if (deeper > 0) {
  if (1 === 1) runSeeds(1, deeper);
} else {
  runSeeds(1, 700);
}
runPoolTest();
