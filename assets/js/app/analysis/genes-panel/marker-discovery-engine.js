/**
 * Marker Discovery Engine
 *
 * Tests every gene for every tested group of a categorical field against its
 * reference (the rest, or one group), streaming each gene once to the
 * analysis workers (`compute/gene-statistics.js` `groupMarkers`), and keeps
 * the full statistics: every gene's p-value, adjusted p-value, score, fold
 * change, mean and non-zero fractions for every group. Filters, ranking and
 * the number of markers shown are applied afterwards to those arrays
 * (`marker-selection.js`), never by testing again.
 *
 * The genes go from the dataset's reader worker straight to the workers over
 * the run's gene route (`analysis/data/gene-route.js`): this thread sends which genes
 * each task computes and takes in the task's statistics, packed, and never
 * the genes' values.
 *
 * The run sizes itself (`shared/run-tuner.js`): how many genes a task takes,
 * how far ahead genes are read, how many tasks are in flight and how much
 * memory it holds all come from the device and what the run measures.
 *
 * Multiple testing is corrected per group over the genes tested for it
 * (Benjamini–Hochberg or Bonferroni); an untested gene is not in the family.
 *
 * @module genes-panel/marker-discovery-engine
 */

import { GeneRoute } from '../data/gene-route.js';
import { getWorkerPool } from '../compute/worker-pool.js';
import { createSlicedYield } from '../shared/concurrency-utils.js';
import { ANALYSIS_PHASES } from './constants.js';
import { benjaminiHochbergAdjusted, bonferroniAdjusted } from '../stats/statistical-tests.js';
import { createRunTunerFor, runGeneStream, taskGenes } from '../shared/gene-stream-runner.js';
import { isCategoricalCodes, missingCategoryCode } from '../../../data/categorical-storage-contract.js';
import { P_CONVENTIONS, TEST_METHODS } from '../compute/gene-statistics.js';
import { formatCount, formatCountOf } from '../../../utils/format-units.js';

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Marker workers retain one module-global categorical context. A discovery run
 * therefore owns every worker from context broadcast until its final marker
 * task settles. The queue is module-scoped so separate engine instances cannot
 * overwrite each other's context.
 */
let markerContextLeaseActive = false;
const markerContextLeaseWaiters = [];

function getAbortReason(signal) {
  return signal?.reason ??
    new DOMException('Marker discovery was aborted', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw getAbortReason(signal);
  }
}

/**
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<() => void>}
 */
async function acquireMarkerContextLease(signal) {
  throwIfAborted(signal);

  const createRelease = () => {
    let released = false;
    return () => {
      if (released) {
        throw new Error('Marker worker context lease was released more than once');
      }
      released = true;

      while (markerContextLeaseWaiters.length > 0) {
        const waiter = markerContextLeaseWaiters.shift();
        waiter.removeAbortListener();
        if (waiter.signal?.aborted) {
          waiter.reject(getAbortReason(waiter.signal));
          continue;
        }
        waiter.resolve(createRelease());
        return;
      }
      markerContextLeaseActive = false;
    };
  };

  let release;
  if (!markerContextLeaseActive) {
    markerContextLeaseActive = true;
    release = createRelease();
  } else {
    release = await new Promise((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        reject,
        removeAbortListener: () => {}
      };
      if (signal) {
        const handleAbort = () => {
          const index = markerContextLeaseWaiters.indexOf(waiter);
          if (index >= 0) {
            markerContextLeaseWaiters.splice(index, 1);
          }
          waiter.removeAbortListener();
          reject(getAbortReason(signal));
        };
        waiter.removeAbortListener = () => {
          signal.removeEventListener('abort', handleAbort);
        };
        signal.addEventListener('abort', handleAbort, { once: true });
      }
      markerContextLeaseWaiters.push(waiter);
    });
  }

  if (signal?.aborted) {
    release();
    throw getAbortReason(signal);
  }
  return release;
}

const CORRECTIONS = Object.freeze(['bh', 'bonferroni']);

// =============================================================================
// MARKER DISCOVERY ENGINE
// =============================================================================

export class MarkerDiscoveryEngine {
  /**
   * @param {Object} options
   * @param {Object} options.dataLayer - DataLayer instance for gene loading
   */
  constructor(options) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('[MarkerDiscoveryEngine] options must be an object');
    }
    const { dataLayer } = options;
    if (dataLayer === null || typeof dataLayer !== 'object') {
      throw new TypeError('[MarkerDiscoveryEngine] dataLayer must be an object');
    }
    this.dataLayer = dataLayer;
  }

  /**
   * Test genes for every tested group of a grouping.
   *
   * @param {Object} options
   * @param {Object} options.grouping - What the workers group cells by
   * @param {Uint8Array|Uint16Array|Uint32Array} options.grouping.codes - The
   *   field's codes, at its own width
   * @param {Int32Array} options.grouping.codeToGroupIndex - Each code's group
   *   index, -1 for a code in no group (left out of the rest too)
   * @param {number} options.grouping.groupCount
   * @param {Uint8Array} options.grouping.tested - One flag per group
   * @param {number} options.grouping.reference - -1 (the rest) or a group index
   * @param {Uint8Array|null} options.grouping.scope - 1 for a cell in scope,
   *   or null for every cell
   * @param {string[]} options.genes - The genes to test
   * @param {'wilcox'|'ttest'|'ttest_overestim_var'} options.method
   * @param {'exact'|'normal'|'normal_tie'} options.pConvention
   * @param {'bh'|'bonferroni'} options.correction
   * @param {{mode: 'stored'|'log1p', base: number|null}} options.foldChange
   * @param {number} options.minCellsPerSide - A group is tested for a gene
   *   when it and its reference each hold this many measured cells
   * @param {import('../../jobs/cancellable-job.js').CancellableJob|null} [options.job]
   * @param {AbortSignal} [options.signal]
   * @param {string|null} [options.readOwner]
   * @param {string} [options.matrix='mapped'] - The expression matrix the
   *   genes are read from (`DataLayer.readGeneColumn`)
   * @param {(gene: string, moments: {sum: number, sumSq: number, nonZero: number, n: number}) => void} [options.onGeneMoments] -
   *   Each gene's moments over every cell, which the same pass computes
   *   (`shared/gene-moments-cache.js`)
   * @returns {Promise<Object>} The full statistics (`MarkerStatistics` without groups)
   */
  async discoverMarkers(options) {
    const startTime = performance.now();
    if (typeof this.dataLayer.readGeneColumn !== 'function') {
      throw new TypeError('[MarkerDiscoveryEngine] dataLayer must implement readGeneColumn');
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('[MarkerDiscoveryEngine] discovery options must be an object');
    }
    const {
      grouping,
      genes,
      method,
      pConvention,
      correction,
      foldChange,
      minCellsPerSide,
      job = null,
      signal,
      readOwner = null,
      matrix = 'mapped',
      onGeneMoments = null
    } = options;

    if (!TEST_METHODS.includes(method)) {
      throw new RangeError(`[MarkerDiscoveryEngine] method must be one of ${TEST_METHODS.join(', ')}`);
    }
    if (!P_CONVENTIONS.includes(pConvention)) {
      throw new RangeError(`[MarkerDiscoveryEngine] pConvention must be one of ${P_CONVENTIONS.join(', ')}`);
    }
    if (!CORRECTIONS.includes(correction)) {
      throw new RangeError('[MarkerDiscoveryEngine] correction must be bh or bonferroni');
    }
    if (foldChange === null || typeof foldChange !== 'object' || !['stored', 'log1p'].includes(foldChange.mode)) {
      throw new TypeError('[MarkerDiscoveryEngine] foldChange must name a mode, stored or log1p');
    }
    if (!Number.isSafeInteger(minCellsPerSide) || minCellsPerSide < 2) {
      throw new RangeError('[MarkerDiscoveryEngine] minCellsPerSide must be an integer of at least 2');
    }
    if (!Array.isArray(genes) || genes.length === 0 || new Set(genes).size !== genes.length) {
      throw new TypeError('[MarkerDiscoveryEngine] genes must be distinct gene keys');
    }
    const pointCount = this.dataLayer.state?.pointCount;
    const { codes, codeToGroupIndex, groupCount, tested, reference, scope } = grouping ?? {};
    if (!isCategoricalCodes(codes) || codes.length !== pointCount) {
      throw new TypeError('[MarkerDiscoveryEngine] grouping codes must cover every cell');
    }
    if (!(codeToGroupIndex instanceof Int32Array) || !Number.isSafeInteger(groupCount) || groupCount < 1) {
      throw new TypeError('[MarkerDiscoveryEngine] grouping needs codeToGroupIndex and groupCount');
    }
    if (!(tested instanceof Uint8Array) || tested.length !== groupCount) {
      throw new TypeError('[MarkerDiscoveryEngine] grouping needs one tested flag per group');
    }
    if (scope !== null && (!(scope instanceof Uint8Array) || scope.length !== pointCount)) {
      throw new TypeError('[MarkerDiscoveryEngine] grouping scope must be one byte per cell or null');
    }
    throwIfAborted(signal);

    const geneCount = genes.length;
    const releaseMarkerContext = await acquireMarkerContextLease(signal);
    const pool = getWorkerPool();
    try {
      await pool.init();
      throwIfAborted(signal);
      if (!pool.isReady()) throw new Error('Marker discovery requires Web Workers');
      const { poolSize } = pool.getStats();

      // Cells out of scope are in no group: the codes the workers keep map
      // them to the missing code, so one per-cell array crosses.
      const workerCodes = codes.slice();
      if (scope !== null) {
        const missing = missingCategoryCode(workerCodes);
        for (let cell = 0; cell < workerCodes.length; cell++) {
          if (scope[cell] === 0) workerCodes[cell] = missing;
        }
      }
      await pool.broadcast(
        'MARKERS_SET_CONTEXT',
        () => ({
          codes: workerCodes.slice(),
          codeToGroupIndex: codeToGroupIndex.slice(),
          groupCount,
          tested: tested.slice(),
          reference
        }),
        // A worker replaced after a cancelled task gets the context again.
        { timeout: 30000, signal: signal ?? null, retainAs: 'markers' }
      );
      throwIfAborted(signal);

      const lane = (ArrayType, fill) => Array.from({ length: groupCount }, () => new ArrayType(geneCount).fill(fill));
      const pValuesByGroup = lane(Float64Array, NaN);
      const scoresByGroup = lane(Float32Array, NaN);
      const log2FoldChangeByGroup = lane(Float32Array, NaN);
      const meanInGroupByGroup = lane(Float32Array, NaN);
      const pctInByGroup = lane(Float32Array, NaN);
      const pctRefByGroup = lane(Float32Array, NaN);
      const aurocByGroup = lane(Float32Array, NaN);
      const lanes = {
        pValuesByGroup, scoresByGroup, log2FoldChangeByGroup, meanInGroupByGroup,
        pctInByGroup, pctRefByGroup, aurocByGroup
      };

      const tuner = createRunTunerFor(this.dataLayer, poolSize, geneCount);
      const route = await GeneRoute.open({ dataLayer: this.dataLayer, pool, signal: signal ?? null });
      try {
        throwIfAborted(signal);
        job?.step(ANALYSIS_PHASES.DISCOVERY);
        job?.items(0, geneCount, 'genes');
        let completed = 0;
        const payloadBase = { method, minCells: minCellsPerSide, pConvention, foldChange };
        await runGeneStream({
          dataLayer: this.dataLayer,
          genes,
          tuner,
          route,
          matrix,
          owner: readOwner,
          signal: signal ?? null,
          dispatch: (task, onTiming) => {
            const payload = { ...payloadBase, ...taskGenes(task) };
            const execution = { timeout: 120000, transfer: true, signal: signal ?? null, onTiming };
            return task.worker === null
              ? pool.execute('MARKERS_COMPUTE_GENES', payload, execution)
              : pool.executeOnWorker(task.worker, 'MARKERS_COMPUTE_GENES', payload, execution);
          },
          onResult: (task, packed) => {
            ingestMarkerBatch(task, groupCount, packed, lanes, onGeneMoments !== null && scope === null ? onGeneMoments : null);
            completed += task.indices.length;
            job?.items(completed, geneCount, 'genes');
          }
        });
      } finally {
        // Queued on each worker behind the run's tasks.
        if (route !== null) {
          void route.close().catch(error => console.warn('[MarkerDiscovery] Closing the gene route failed:', error));
        }
      }
      throwIfAborted(signal);

      // Each group is its own family: its comparison over every gene tested
      // for it. An untested gene (NaN) is not in it — counting it as p = 1
      // would deflate every adjusted value of the group.
      job?.step(ANALYSIS_PHASES.CORRECTION);
      const adjustedPValuesByGroup = [];
      const genesTestedByGroup = [];
      const adjust = correction === 'bh' ? benjaminiHochbergAdjusted : bonferroniAdjusted;
      const yieldIfSliceSpent = createSlicedYield();
      for (let g = 0; g < groupCount; g++) {
        const { adjustedPValues, testedCount } = adjust(pValuesByGroup[g]);
        adjustedPValuesByGroup.push(adjustedPValues);
        genesTestedByGroup.push(testedCount);
        await yieldIfSliceSpent();
        throwIfAborted(signal);
      }

      return {
        genes: [...genes],
        method,
        pConvention,
        correction,
        foldChange: { mode: foldChange.mode, base: foldChange.base ?? null },
        minCellsPerSide,
        computedAt: Date.now(),
        computeDuration: performance.now() - startTime,
        pValuesByGroup,
        adjustedPValuesByGroup,
        scoresByGroup,
        log2FoldChangeByGroup,
        meanInGroupByGroup,
        pctInByGroup,
        pctRefByGroup,
        aurocByGroup,
        genesTestedByGroup,
        tuning: tuner.snapshot()
      };
    } finally {
      // The workers' copy of the groups (one entry a cell) goes with the
      // run, however it ended, and the pool stops replaying it to replaced
      // workers. Queued behind the run's tasks on each worker, and ahead of
      // the next run's context, which waits for the lease.
      if (pool.isReady()) {
        void pool.broadcast('MARKERS_CLEAR_CONTEXT', () => ({}), { releases: 'markers' })
          .catch(error => console.warn('[MarkerDiscovery] Releasing the worker groups failed:', error));
      }
      releaseMarkerContext();
    }
  }
}

/** The packed worker result's arrays a run keeps, one value per gene and group. */
const MARKER_BATCH_LANES = Object.freeze([
  ['pValues', Float64Array],
  ['scores', Float32Array],
  ['auroc', Float32Array],
  ['log2FoldChange', Float32Array],
  ['meanInGroup', Float32Array],
  ['percentInGroup', Float32Array],
  ['percentOutGroup', Float32Array],
]);

/**
 * Check one task's packed worker result (`MARKERS_COMPUTE_GENES`: gene `k`'s
 * value for group `g` at `k * groupCount + g`) and store each gene's
 * statistics in every group's lanes; hand each gene's moments over every
 * cell to `onGeneMoments`, when given.
 * @private
 */
function ingestMarkerBatch(task, groupCount, packed, lanes, onGeneMoments) {
  const genes = task.indices.length;
  if (packed === null || typeof packed !== 'object' || Array.isArray(packed) ||
      packed.genes !== genes || packed.groupCount !== groupCount) {
    throw new TypeError(
      `Marker worker returned an invalid result for ${genes === 1 ? `"${task.genes[0]}"` : formatCountOf(genes, 'gene')}`
    );
  }
  for (const [name, ArrayType] of MARKER_BATCH_LANES) {
    if (!(packed[name] instanceof ArrayType) || packed[name].length !== genes * groupCount) {
      throw new TypeError(`Marker worker ${name} must be a ${ArrayType.name} with one value per gene and group`);
    }
  }
  if (!(packed.moments instanceof Float64Array) || packed.moments.length !== genes * 4) {
    throw new TypeError('Marker worker moments must be a Float64Array of four values per gene');
  }
  const { pValues, scores, auroc, log2FoldChange, meanInGroup, percentInGroup, percentOutGroup, moments } = packed;
  for (let k = 0; k < genes; k++) {
    const geneIndex = task.indices[k];
    const base = k * groupCount;
    for (let g = 0; g < groupCount; g++) {
      const p = pValues[base + g];
      // NaN is the worker's word for "not tested for this gene": the group is
      // not tested, is the reference, or a side held too few measured cells.
      if (!Number.isNaN(p) && !(p >= 0 && p <= 1)) {
        throw new RangeError(`Marker worker p-value for "${task.genes[k]}" group ${g} must be between 0 and 1`);
      }
      lanes.pValuesByGroup[g][geneIndex] = p;
      lanes.scoresByGroup[g][geneIndex] = scores[base + g];
      lanes.aurocByGroup[g][geneIndex] = auroc[base + g];
      lanes.log2FoldChangeByGroup[g][geneIndex] = log2FoldChange[base + g];
      lanes.meanInGroupByGroup[g][geneIndex] = meanInGroup[base + g];
      lanes.pctInByGroup[g][geneIndex] = percentInGroup[base + g];
      lanes.pctRefByGroup[g][geneIndex] = percentOutGroup[base + g];
    }
    if (onGeneMoments !== null) {
      onGeneMoments(task.genes[k], {
        sum: moments[k * 4],
        sumSq: moments[k * 4 + 1],
        nonZero: moments[k * 4 + 2],
        n: moments[k * 4 + 3]
      });
    }
  }
}

/** The run's plan, as its job states it. */
export function describeMarkerRun({ geneCount, testedCount, groupCount }) {
  return `${formatCountOf(geneCount, 'gene')} · ${formatCount(testedCount)} of ${formatCountOf(groupCount, 'group')} tested`;
}
