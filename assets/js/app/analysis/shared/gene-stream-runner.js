/**
 * @fileoverview Stream genes to worker tasks, as many in flight as the run's
 * tuner says (`run-tuner.js`): the one loop marker discovery, differential
 * expression and the gene-moments pass share.
 *
 * Each gene read (`StreamingGeneLoader.streamGenesRaw`) is handed to
 * `dispatch`, which starts its worker task and returns its promise; the task
 * reports its own run time to the tuner (`onTiming`). The loop waits for a
 * free slot before each dispatch, stops at the first failure or abort, and
 * settles every task it started before it returns or throws.
 *
 * @module analysis/shared/gene-stream-runner
 */

import { createRunTuner } from './run-tuner.js';

/**
 * A run's tuner for a data layer and a worker pool size.
 *
 * @param {Object} dataLayer
 * @param {number} poolSize
 */
export function createRunTunerFor(dataLayer, poolSize) {
  return createRunTuner({
    poolSize,
    cellCount: dataLayer.state.pointCount,
    link: () => (typeof dataLayer.linkMeasurement === 'function' ? dataLayer.linkMeasurement() : null),
  });
}

/**
 * Timing options for one task: the tuner hears its run time.
 *
 * @param {ReturnType<typeof createRunTuner>} tuner
 */
export function taskTiming(tuner) {
  tuner.taskStarted();
  return ({ runMs }) => tuner.observeTask({ ms: runMs });
}

/**
 * @param {object} options
 * @param {import('../data/streaming-gene-loader.js').StreamingGeneLoader} options.loader
 * @param {string[]} options.genes
 * @param {ReturnType<typeof createRunTuner>} options.tuner
 * @param {(gene: {gene: string, index: number, values: unknown, owned: boolean}, onTiming: Function) => Promise<unknown>} options.dispatch -
 *   Start the gene's task, passing `onTiming` to its execution options
 * @param {(gene: {gene: string, index: number}, result: unknown) => void} options.onResult
 * @param {AbortSignal|null} [options.signal]
 * @param {() => boolean} [options.isCurrent] - False stops the run (it then
 *   returns false)
 * @returns {Promise<boolean>} True when every gene was done
 */
export async function runGeneStream({ loader, genes, tuner, dispatch, onResult, signal = null, isCurrent = () => true }) {
  const inFlight = new Set();
  let failure = null;
  let stopped = false;
  const fail = error => {
    if (failure === null) failure = error;
  };
  try {
    for await (const item of loader.streamGenesRaw(genes)) {
      if (signal?.aborted) throw signal.reason;
      if (!isCurrent()) {
        stopped = true;
        loader.abort();
        break;
      }
      while (inFlight.size >= tuner.computeInFlight() && failure === null) {
        await Promise.race(inFlight);
      }
      if (failure !== null) {
        loader.abort();
        break;
      }
      const { gene, index } = item;
      let task;
      task = Promise.resolve()
        .then(() => dispatch(item, taskTiming(tuner)))
        .then(result => {
          if (!signal?.aborted && isCurrent()) onResult({ gene, index }, result);
        })
        .catch(fail)
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
  } catch (error) {
    fail(error);
  }
  await Promise.all(inFlight);
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  if (failure !== null) throw failure;
  return !stopped && isCurrent();
}
