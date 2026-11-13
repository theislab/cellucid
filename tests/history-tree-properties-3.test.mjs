/**
 * The history's tree properties, seeds 1401 to 2100 of 2100 (`history-tree-properties.mjs`
 * holds the generator and the invariants; the shards run in parallel).
 * `HISTORY_SEEDS=n` runs seeds 1 to n here instead, for a deeper local run.
 */
import { runPoolTest, runSeeds } from './history-tree-properties.mjs';

const deeper = Number(process.env.HISTORY_SEEDS ?? 0);
if (deeper > 0) {
  if (3 === 1) runSeeds(1, deeper);
} else {
  runSeeds(1401, 2100);
}
