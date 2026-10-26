/**
 * How many analysis workers this device runs.
 *
 * Nothing else about an analysis run's size is configured: how far ahead it
 * reads, how many tasks it keeps in flight and how much memory it holds are
 * decided per run from what the device reports and what the run measures
 * (`run-tuner.js`), and how many reads go out at once is the reader's fetch
 * scheduler's (the link it measured).
 *
 * @module shared/performance-config
 */

/**
 * Analysis workers to run: one per core, less one core for the page and one
 * for the AnnData reader worker that feeds them — the same rule the reader's
 * decode pool follows (formats/io/decode-pool.js). A browser that does not
 * report its cores is taken to have four, as the decode pool takes it.
 *
 * @param {Object} [environment] - `globalThis`, or a stand-in in tests
 * @returns {number}
 */
export function analysisWorkerCount(environment = globalThis) {
  const reported = environment?.navigator?.hardwareConcurrency;
  const cores = Number.isSafeInteger(reported) && reported > 0 ? reported : 4;
  return Math.max(1, cores - 2);
}
