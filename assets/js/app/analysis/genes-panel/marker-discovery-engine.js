/**
 * Marker Discovery Engine
 *
 * Discovers marker genes for multiple groups using streaming gene loading and
 * worker-backed multi-group statistics.
 *
 * Core performance properties (per GENES_PANEL_ROADMAP):
 * - Download each gene once (StreamingGeneLoader)
 * - Compute one-vs-rest stats for all groups in a single pass per gene
 * - Keep memory bounded while emitting progressive partial results
 *
 * Implementation highlights:
 * - Uses the existing WorkerPool + data-worker.js for multi-core computation.
 * - Broadcasts a per-worker categorical context once per run to avoid re-sending
 *   large per-cell code arrays for every gene.
 * - Maintains Top-N heaps per group for progressive UI.
 * - Computes Benjamini–Hochberg adjusted p-values per group at the end.
 *
 * @module genes-panel/marker-discovery-engine
 */

import { StreamingGeneLoader } from '../data/streaming-gene-loader.js';
import { getWorkerPool } from '../compute/worker-pool.js';
import { waitForAvailableSlot } from '../shared/concurrency-utils.js';
import { DEFAULTS, ERROR_MESSAGES, formatError, ANALYSIS_PHASES } from './constants.js';

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function clampInt(value, min, max) {
  const n = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.min(max, Math.max(min, n));
}

function safeP(p) {
  return Number.isFinite(p) ? p : 1;
}

/**
 * Max-heap that keeps the "worst" element at the root, so we can evict it when
 * we exceed capacity.
 */
class TopNHeap {
  /**
   * @param {number} capacity
   * @param {(a: any, b: any) => boolean} isWorse - returns true if a is worse than b
   */
  constructor(capacity, isWorse) {
    this._cap = Math.max(1, capacity | 0);
    this._isWorse = isWorse;
    /** @type {any[]} */
    this._arr = [];
  }

  size() {
    return this._arr.length;
  }

  toArray() {
    return this._arr.slice();
  }

  peekWorst() {
    return this._arr.length > 0 ? this._arr[0] : null;
  }

  push(item) {
    const n = this._arr.length;
    if (n < this._cap) {
      this._arr.push(item);
      this._siftUp(n);
      return;
    }

    const worst = this._arr[0];
    // Replace worst only if the incoming item is better.
    if (this._isWorse(worst, item)) {
      this._arr[0] = item;
      this._siftDown(0);
    }
  }

  _siftUp(idx) {
    const arr = this._arr;
    const isWorse = this._isWorse;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (!isWorse(arr[idx], arr[parent])) break;
      const tmp = arr[idx];
      arr[idx] = arr[parent];
      arr[parent] = tmp;
      idx = parent;
    }
  }

  _siftDown(idx) {
    const arr = this._arr;
    const isWorse = this._isWorse;
    const n = arr.length;
    while (true) {
      const left = idx * 2 + 1;
      const right = left + 1;
      let worst = idx;

      if (left < n && isWorse(arr[left], arr[worst])) worst = left;
      if (right < n && isWorse(arr[right], arr[worst])) worst = right;

      if (worst === idx) break;
      const tmp = arr[idx];
      arr[idx] = arr[worst];
      arr[worst] = tmp;
      idx = worst;
    }
  }
}

/**
 * Benjamini–Hochberg correction for a Float32Array of p-values.
 * Returns a Float32Array of adjusted p-values (NaN preserved).
 *
 * @param {Float32Array} pValues
 * @returns {Float32Array}
 */
function benjaminiHochberg(pValues) {
  const n = pValues.length;
  const out = new Float32Array(n);
  out.fill(NaN);

  /** @type {{ index: number, p: number }[]} */
  const valid = [];
  for (let i = 0; i < n; i++) {
    const p = pValues[i];
    if (Number.isFinite(p)) valid.push({ index: i, p });
  }

  if (valid.length === 0) return out;

  valid.sort((a, b) => a.p - b.p);

  const m = valid.length;
  let nextAdj = valid[m - 1].p;
  out[valid[m - 1].index] = Math.min(nextAdj, 1);

  for (let i = m - 2; i >= 0; i--) {
    const raw = (valid[i].p * m) / (i + 1);
    nextAdj = Math.min(raw, nextAdj);
    out[valid[i].index] = Math.min(nextAdj, 1);
  }

  return out;
}

// =============================================================================
// MARKER DISCOVERY ENGINE
// =============================================================================

export class MarkerDiscoveryEngine {
  /**
   * @param {Object} options
   * @param {Object} options.dataLayer - DataLayer instance for gene loading
   * @param {Object} [options.config]
   */
  constructor(options) {
    const { dataLayer, config = {} } = options || {};

    if (!dataLayer) {
      throw new Error('[MarkerDiscoveryEngine] dataLayer is required');
    }

    this.dataLayer = dataLayer;

    this._config = {
      minCells: config.minCells ?? DEFAULTS.minCells,
      pValueThreshold: config.pValueThreshold ?? DEFAULTS.pValueThreshold,
      foldChangeThreshold: config.foldChangeThreshold ?? DEFAULTS.foldChangeThreshold,
      useAdjustedPValue: config.useAdjustedPValue ?? DEFAULTS.useAdjustedPValue,
      progressInterval: config.progressInterval ?? DEFAULTS.progressInterval,
      batchSize: config.batchSize ?? DEFAULTS.batchSize,
      networkConcurrency: config.networkConcurrency ?? DEFAULTS.networkConcurrency,
      memoryBudgetMB: config.memoryBudgetMB ?? DEFAULTS.memoryBudgetMB
    };
  }

  /**
   * Discover marker genes for all groups in a categorical field.
   *
   * @param {Object} options
   * @param {string} options.obsCategory
   * @param {Object[]} options.groups
   * @param {string} options.groups[].groupId
   * @param {string} [options.groups[].groupName]
   * @param {number} options.groups[].groupCode - Integer code (index into obs categories)
   * @param {number[]|Uint32Array} options.groups[].cellIndices
   * @param {number} [options.groups[].cellCount]
   * @param {string} [options.groups[].color]
   * @param {Uint16Array} options.obsCodes - Per-cell category codes for obsCategory
   * @param {string[]} [options.geneList] - Gene keys (null = all genes)
   * @param {'wilcox'|'ttest'} [options.method='wilcox']
   * @param {number} [options.topNPerGroup=10]
   * @param {number} [options.minCells=10]
   * @param {number} [options.pValueThreshold=0.05]
   * @param {number} [options.foldChangeThreshold=1.0]
   * @param {boolean} [options.useAdjustedPValue=true]
   * @param {number|'auto'} [options.parallelism='auto']
   * @param {Object} [options.batchConfig]
   * @param {Function} [options.onProgress]
   * @param {Function} [options.onPartialResults]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<MarkersByCategory>}
   */
  async discoverMarkers(options) {
    const startTime = performance.now();

    const {
      obsCategory = 'custom',
      groups,
      obsCodes,
      geneList = null,
      method = DEFAULTS.method,
      topNPerGroup = DEFAULTS.topNPerGroup,
      minCells = this._config.minCells,
      pValueThreshold = this._config.pValueThreshold,
      foldChangeThreshold = this._config.foldChangeThreshold,
      useAdjustedPValue = this._config.useAdjustedPValue,
      parallelism = 'auto',
      batchConfig = {},
      onProgress,
      onPartialResults,
      signal
    } = options || {};

    this._validateGroups(groups, minCells);
    if (!obsCodes || !Number.isFinite(obsCodes.length) || obsCodes.length === 0) {
      throw new Error('[MarkerDiscoveryEngine] obsCodes is required for marker discovery');
    }

    const allGenes = geneList || this.dataLayer.getAvailableVariables('gene_expression').map(v => v.key);
    if (!allGenes || allGenes.length === 0) {
      throw new Error('No gene expression variables available for analysis.');
    }

    const groupCount = groups.length;
    const geneCount = allGenes.length;

    // Worker pool (shared singleton used by ComputeManager too).
    const pool = getWorkerPool();
    await pool.init();

    const workersReady = pool.isReady();
    const poolStats = pool.getStats?.() || { poolSize: 1 };
    const poolSize = poolStats.poolSize || 1;

    // Build a code->groupIndex map (sized to max groupCode + 1).
    let mapLen = 0;
    for (const g of groups) {
      if (Number.isFinite(g.groupCode)) {
        mapLen = Math.max(mapLen, (g.groupCode | 0) + 1);
      }
    }
    const codeToGroupIndex = new Int16Array(Math.max(1, mapLen));
    codeToGroupIndex.fill(-1);
    for (let i = 0; i < groups.length; i++) {
      const code = groups[i].groupCode;
      if (Number.isFinite(code) && code >= 0 && code < codeToGroupIndex.length) {
        codeToGroupIndex[code] = i;
      }
    }

    // Broadcast marker context to workers (once per run).
    // Each worker needs its own backing buffers (transfer detaches).
    if (workersReady) {
      await pool.broadcast(
        'MARKERS_SET_CONTEXT',
        (/* workerIndex */) => ({
          codes: new Uint16Array(obsCodes),
          codeToGroupIndex: new Int16Array(codeToGroupIndex),
          groupCount,
          histBins: batchConfig?.wilcoxBins
        }),
        { timeout: 30000, signal }
      );
    }

    // Prepare per-group p-value storage for BH correction.
    const pValuesByGroup = Array.from({ length: groupCount }, () => {
      const arr = new Float32Array(geneCount);
      arr.fill(NaN);
      return arr;
    });

    // Store full per-gene stats so UI can re-threshold without recomputing.
    const log2FCByGroup = Array.from({ length: groupCount }, () => {
      const arr = new Float32Array(geneCount);
      arr.fill(NaN);
      return arr;
    });

    const effectiveTopNPerGroup = topNPerGroup === 'all'
      ? geneCount
      : clampInt(Number(topNPerGroup), 1, geneCount);

    // Per-group Top-N heaps for progressive results.
    const heaps = Array.from({ length: groupCount }, () => {
      // "Worst" = higher p-value; tie-break: smaller |log2FC| is worse.
      const isWorse = (a, b) => {
        const pa = safeP(a.pValue);
        const pb = safeP(b.pValue);
        if (pa !== pb) return pa > pb;
        const fa = Math.abs(a.log2FoldChange || 0);
        const fb = Math.abs(b.log2FoldChange || 0);
        return fa < fb;
      };
      return new TopNHeap(effectiveTopNPerGroup, isWorse);
    });

    const effectiveBatchConfig = {
      preloadCount: batchConfig.preloadCount ?? this._config.batchSize,
      networkConcurrency: batchConfig.networkConcurrency ?? this._config.networkConcurrency,
      memoryBudgetMB: batchConfig.memoryBudgetMB ?? this._config.memoryBudgetMB,
      wilcoxBins: batchConfig.wilcoxBins
    };

    // Choose bounded concurrency for worker compute.
    const requestedParallelism = parallelism === 'auto'
      ? poolSize
      : Number(parallelism);

    const maxWorkerParallelism = workersReady ? clampInt(requestedParallelism, 1, Math.min(poolSize, 8)) : 1;

    const totalCells = obsCodes.length;
    const bytesPerGene = totalCells * 4 * (method === 'wilcox' ? 2 : 1); // values + (wilcox) order scratch in worker
    const budgetBytes = effectiveBatchConfig.memoryBudgetMB * 1024 * 1024;
    const maxByMemory = Math.max(1, Math.floor(budgetBytes / Math.max(1, bytesPerGene)));
    const maxInFlight = Math.max(1, Math.min(maxWorkerParallelism, maxByMemory));

    // Stream raw genes (prefetch + memory-aware unloading).
    const loader = new StreamingGeneLoader({
      dataLayer: this.dataLayer,
      config: {
        preloadCount: effectiveBatchConfig.preloadCount,
        networkConcurrency: effectiveBatchConfig.networkConcurrency,
        memoryBudgetMB: effectiveBatchConfig.memoryBudgetMB
      },
      signal
    });

    let completedGenes = 0;
    let lastPartialEmit = 0;
    const inFlight = new Set();

    const reportProgress = () => {
      if (!onProgress) return;
      onProgress({
        phase: ANALYSIS_PHASES.DISCOVERY,
        progress: Math.round((completedGenes / geneCount) * 100),
        loaded: completedGenes,
        total: geneCount,
        message: `Analyzing genes (${completedGenes.toLocaleString()}/${geneCount.toLocaleString()})`
      });
    };

    reportProgress();

    const maybeEmitPartial = () => {
      if (!onPartialResults) return;
      if (completedGenes - lastPartialEmit < this._config.progressInterval) return;
      lastPartialEmit = completedGenes;

      const partialGroups = this._buildMarkersFromHeaps({
        groups,
        heaps,
        adjustedByGroup: null,
        pValueThreshold,
        foldChangeThreshold,
        useAdjustedPValue: false
      });

      onPartialResults({
        markers: {
          obsCategory,
          method,
          computedAt: Date.now(),
          computeDuration: performance.now() - startTime,
          geneCount,
          groups: partialGroups
        },
        genesProcessed: completedGenes,
        totalGenes: geneCount,
        isComplete: false
      });
    };

    for await (const { gene, values, index: geneIndex } of loader.streamGenesRaw(allGenes)) {
      if (signal?.aborted) break;

      await waitForAvailableSlot(inFlight, maxInFlight);

      // If we compute in a worker, copy now (bounded by maxInFlight) so we never
      // hold onto DataLayer-owned buffers beyond the concurrency window.
      const valuesCopyForWorker = workersReady ? new Float32Array(values) : null;

      const task = (async () => {
        try {
          if (workersReady) {
            const res = await pool.execute(
              'MARKERS_COMPUTE_GENE',
              { values: valuesCopyForWorker, method, minCells },
              // Restart the worker on abort to avoid subsequent runs timing out
              // behind a canceled long-running compute in the worker.
              { timeout: 120000, signal, transfer: true, restartWorkerOnAbort: true }
            );

            this._ingestGeneResult({
              gene,
              geneIndex,
              groups,
              pValuesByGroup,
              log2FCByGroup,
              heaps,
              result: res
            });
          } else {
            // Worker-less fallback: do not attempt Wilcoxon on large datasets.
            // We still provide t-test results to keep the feature usable.
            if (method === 'wilcox') {
              throw new Error('Wilcoxon requires Web Workers for performance; try t-test instead.');
            }

            const res = this._computeGeneMarkersFallback(values, codeToGroupIndex, obsCodes, groups.length, minCells);
            this._ingestGeneResult({
              gene,
              geneIndex,
              groups,
              pValuesByGroup,
              log2FCByGroup,
              heaps,
              result: res
            });
          }
        } finally {
          completedGenes++;
          reportProgress();
          maybeEmitPartial();
        }
      })();

      inFlight.add(task);
      task.finally(() => inFlight.delete(task));
    }

    // Wait for remaining work
    await Promise.allSettled(Array.from(inFlight));

    // If we were cancelled, do not proceed to heavy post-processing (BH correction).
    if (signal?.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }

    // BH correction per group
    const adjustedByGroup = pValuesByGroup.map((arr) => benjaminiHochberg(arr));

    // Final groups output
    const finalGroups = this._buildMarkersFromHeaps({
      groups,
      heaps,
      adjustedByGroup,
      pValueThreshold,
      foldChangeThreshold,
      useAdjustedPValue
    });

    const duration = performance.now() - startTime;

    if (onPartialResults) {
      onPartialResults({
        markers: {
          obsCategory,
          method,
          computedAt: Date.now(),
          computeDuration: duration,
          geneCount,
          groups: finalGroups
        },
        genesProcessed: completedGenes,
        totalGenes: geneCount,
        isComplete: true
      });
    }

    return {
      obsCategory,
      method,
      computedAt: Date.now(),
      computeDuration: duration,
      geneCount,
      groups: finalGroups,
      stats: {
        genes: allGenes,
        groupIds: groups.map(g => g.groupId),
        pValuesByGroup,
        adjustedPValuesByGroup: adjustedByGroup,
        log2FoldChangeByGroup: log2FCByGroup
      }
    };
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  _validateGroups(groups, minCells) {
    if (!groups || groups.length < 2) {
      throw new Error(formatError(ERROR_MESSAGES.TOO_FEW_GROUPS, { n: groups?.length || 0 }));
    }

    for (const group of groups) {
      if (!group.groupId) {
        throw new Error('Group must have a groupId');
      }
      if (!Number.isFinite(group.groupCode)) {
        throw new Error(`Group "${group.groupId}" is missing required groupCode`);
      }
      const n = group.cellIndices?.length || group.cellCount || 0;
      if (n < minCells) {
        throw new Error(formatError(ERROR_MESSAGES.TOO_FEW_CELLS, {
          name: group.groupName || group.groupId,
          n,
          min: minCells
        }));
      }
    }
  }

  _ingestGeneResult({ gene, geneIndex, groups, pValuesByGroup, log2FCByGroup, heaps, result }) {
    const { pValues, log2FoldChange, meanInGroup, meanOutGroup, percentInGroup, percentOutGroup, nIn, nOut } = result || {};
    if (!pValues || !log2FoldChange) return;

    for (let g = 0; g < groups.length; g++) {
      const p = pValues[g];
      if (Number.isFinite(geneIndex) && geneIndex >= 0 && geneIndex < pValuesByGroup[g].length) {
        pValuesByGroup[g][geneIndex] = p;
      }

      if (!Number.isFinite(p)) continue;
      const fc = log2FoldChange[g];
      if (!Number.isFinite(fc)) continue;
      if (log2FCByGroup && Number.isFinite(geneIndex) && geneIndex >= 0 && geneIndex < log2FCByGroup[g].length) {
        log2FCByGroup[g][geneIndex] = fc;
      }

      heaps[g].push({
        gene,
        geneIndex,
        groupId: groups[g].groupId,
        pValue: p,
        adjustedPValue: null,
        log2FoldChange: fc,
        meanInGroup: meanInGroup ? meanInGroup[g] : NaN,
        meanOutGroup: meanOutGroup ? meanOutGroup[g] : NaN,
        percentInGroup: percentInGroup ? percentInGroup[g] : NaN,
        percentOutGroup: percentOutGroup ? percentOutGroup[g] : NaN,
        nIn: nIn ? nIn[g] : null,
        nOut: nOut ? nOut[g] : null
      });
    }
  }

  _buildMarkersFromHeaps({ groups, heaps, adjustedByGroup, pValueThreshold, foldChangeThreshold, useAdjustedPValue }) {
    const out = {};

    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      const items = heaps[g].toArray();

      for (const item of items) {
        if (adjustedByGroup) {
          const adj = adjustedByGroup[g]?.[item.geneIndex];
          item.adjustedPValue = Number.isFinite(adj) ? adj : null;
        }
      }

      const pKey = useAdjustedPValue ? 'adjustedPValue' : 'pValue';
      const filtered = items.filter((m) => {
        const p = m[pKey];
        if (!Number.isFinite(p)) return false;
        if (p >= pValueThreshold) return false;
        return Math.abs(m.log2FoldChange) >= foldChangeThreshold;
      });

      filtered.sort((a, b) => {
        const pa = useAdjustedPValue ? safeP(a.adjustedPValue) : safeP(a.pValue);
        const pb = useAdjustedPValue ? safeP(b.adjustedPValue) : safeP(b.pValue);
        if (pa !== pb) return pa - pb;
        return Math.abs(b.log2FoldChange) - Math.abs(a.log2FoldChange);
      });

      const markers = filtered.map((m, i) => ({
        gene: m.gene,
        groupId: group.groupId,
        rank: i + 1,
        pValue: m.pValue,
        adjustedPValue: m.adjustedPValue,
        log2FoldChange: m.log2FoldChange,
        meanInGroup: m.meanInGroup,
        meanOutGroup: m.meanOutGroup,
        percentInGroup: m.percentInGroup,
        percentOutGroup: m.percentOutGroup,
        specificity: 0
      }));

      out[group.groupId] = {
        groupId: group.groupId,
        groupName: group.groupName || group.groupId,
        cellCount: group.cellCount ?? (group.cellIndices?.length || 0),
        color: group.color,
        markers
      };
    }

    return out;
  }

  /**
   * Worker-less fallback for t-test only (one-vs-rest, one pass per gene).
   * Returns a subset of the worker result contract.
   */
  _computeGeneMarkersFallback(values, codeToGroupIndex, obsCodes, groupCount, minCells) {
    // Build per-cell group index (fast path; avoid per-gene allocations beyond sums).
    const mapLen = codeToGroupIndex.length;
    const nIn = new Uint32Array(groupCount);
    const sumIn = new Float64Array(groupCount);
    const sumSqIn = new Float64Array(groupCount);
    const exprIn = new Uint32Array(groupCount);

    let nAll = 0;
    let sumAll = 0;
    let sumSqAll = 0;
    let exprAll = 0;

    const len = Math.min(values.length, obsCodes.length);
    for (let i = 0; i < len; i++) {
      const code = obsCodes[i];
      if (code < 0 || code >= mapLen) continue;
      const gi = codeToGroupIndex[code];
      if (gi < 0) continue;
      const v = values[i];
      if (!Number.isFinite(v)) continue;

      nAll++;
      sumAll += v;
      sumSqAll += v * v;
      if (v > 0) exprAll++;

      nIn[gi]++;
      sumIn[gi] += v;
      sumSqIn[gi] += v * v;
      if (v > 0) exprIn[gi]++;
    }

    const pValues = new Float32Array(groupCount);
    const statistics = new Float32Array(groupCount);
    const log2FoldChange = new Float32Array(groupCount);
    const meanInGroup = new Float32Array(groupCount);
    const meanOutGroup = new Float32Array(groupCount);
    const percentInGroup = new Float32Array(groupCount);
    const percentOutGroup = new Float32Array(groupCount);
    const nOut = new Uint32Array(groupCount);

    pValues.fill(NaN);
    statistics.fill(NaN);
    log2FoldChange.fill(NaN);
    meanInGroup.fill(NaN);
    meanOutGroup.fill(NaN);

    for (let g = 0; g < groupCount; g++) {
      const nA = nIn[g];
      const nB = nAll - nA;
      nOut[g] = nB;
      if (nA < Math.max(2, minCells) || nB < Math.max(2, minCells)) continue;

      const meanA = sumIn[g] / nA;
      const sumB = sumAll - sumIn[g];
      const meanB = sumB / nB;

      const varA = nA > 1 ? (sumSqIn[g] - (sumIn[g] * sumIn[g]) / nA) / (nA - 1) : NaN;
      const sumSqB = sumSqAll - sumSqIn[g];
      const varB = nB > 1 ? (sumSqB - (sumB * sumB) / nB) / (nB - 1) : NaN;

      meanInGroup[g] = meanA;
      meanOutGroup[g] = meanB;
      log2FoldChange[g] = Math.log2((meanA + 0.01) / (meanB + 0.01));
      percentInGroup[g] = nA > 0 ? (exprIn[g] / nA) * 100 : 0;
      const exprB = exprAll - exprIn[g];
      percentOutGroup[g] = nB > 0 ? (exprB / nB) * 100 : 0;

      // Conservative fallback: no p-value (workers required for accurate distribution CDF).
      // Use NaN to avoid misleading significance. UI can still rank by log2FC if desired.
      pValues[g] = NaN;
      statistics[g] = NaN;
    }

    return {
      nAll,
      pValues,
      statistics,
      log2FoldChange,
      meanInGroup,
      meanOutGroup,
      percentInGroup,
      percentOutGroup,
      nIn,
      nOut
    };
  }
}

export function createMarkerDiscoveryEngine(options) {
  return new MarkerDiscoveryEngine(options);
}

export default MarkerDiscoveryEngine;
