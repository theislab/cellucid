/**
 * @fileoverview The open cells of the dataset shown, grown or cut in place:
 * Apply with a larger or smaller share of the same method and seed (Open
 * data, Cells to open), and a progressive opening's steps toward the share
 * it was asked for.
 *
 * A subsample of the `uniform` or `blocks` method opens in priority order,
 * so a larger one with the same seed is the smaller one and more, and a
 * priority-ordered file opened whole is its prefixes and more
 * (`data/cell-identity.js`, `sharedOpenCells`). When the reader worker opens
 * the new cells (`AnnDataFileSource.reopenCells`, `resized`), nothing shown
 * is read again:
 *
 * 0. **Settle**: work on the open cells under way (a field, gene,
 *    embedding or vector field being loaded, an analysis run, outlier
 *    quantiles: `data/open-cells-work.js`) ends on them first; an analysis
 *    run's result arrives, and is marked stale once the cells change. From
 *    here until the commit, work about to start waits, then starts on the
 *    cells after it (a field picked meanwhile is loaded on them).
 * 1. **Read** (nothing on screen changes; Cancel, a newer change or a
 *    failure leaves the dataset as it was, the worker reopened at the
 *    earlier cells with their own request): the cells added -- rows
 *    `[from, to)` -- of every resident layout's positions, in the frame the
 *    cells are shown in, of every loaded obs field and every loaded gene
 *    (`loadCoordinateRows`, the loaders' `readRows`; the reader reads only
 *    what those rows need). Cutting reads nothing. Everything the commit
 *    needs is checked before it changes anything.
 * 2. **Commit**, synchronously, all or nothing: kept views are retired (made
 *    again from their record after; the renderer sizes them by the count),
 *    a selection under way is retired when cells are cut (it may name cells
 *    no longer open; growing keeps it), the dimension manager's layouts and
 *    the state's per-cell arrays grow or are cut
 *    (`DimensionManager.resizeCells`, `DataState.resizeOpenCells`), the
 *    runtime stage takes the new count, the viewer the new points with the
 *    camera where it was (`resizeLiveCells`), and the field shown, its
 *    filters, colours, centroids and highlights are made again from them.
 *    An embedding the added cells make unusable (a value that cannot be
 *    drawn) is let go, as an opening of those cells would refuse it; when it
 *    is the one shown, Apply shows the new cells as a new reading (a
 *    progressive opening stops at the cells open, and says why).
 * 3. **After**: the neighbour graph is read again on the new cells if it is
 *    shown, the vector field overlay likewise, outlier filters in use get
 *    their quantiles, the field shown is loaded again if it had to be
 *    released, analyses mark their results stale (their inputs changed),
 *    the notebook hears the cells now open, and the Dataset box the count.
 *
 * A new set of cells (another method or seed, or cells not first in the
 * open order) is shown as a new reading by the caller (`resize` answers
 * `{inPlace: false}`).
 *
 * Progressive opening (`grow`): a dataset whose reader opened a first view
 * smaller than the cells it was asked for (`cellSubset.growth`, decided in
 * the reader worker from the measured cost of reading) grows in place,
 * step by step, to them, in the background; each step is a sample of the
 * cells asked for, so every view, filter and analysis meanwhile is one. A
 * step waits for the work under way on the cells open now (step 0); Apply,
 * another dataset or a session's cells stop the growth.
 *
 * Every reading names its own cells (a cell subset request,
 * `cell-subset-policy.js`): a step, an Apply and the earlier cells read back
 * after a cancelled one never take each other's.
 *
 * @module open-cells-resize
 */

import { requestOfOpenCells } from '../data/cell-subset-policy.js';
import { cellPriorityOf, requireCellPriority } from '../data/cell-priority.js';
import { EmbeddingLoadError } from '../data/data-mapping-candidates.js';
import { beginCellsChange, cellWorkSettled } from '../data/open-cells-work.js';
import { formatCount, formatCountOf } from '../utils/format-units.js';

/**
 * Where each open cell of `after` was open in `before` (the same cells in
 * another order): `order[j]` is the earlier position of open cell `j`.
 */
export function reorderOf(before, after) {
  const n = after.n;
  if (before.n !== n || before.digest !== after.digest || before.kept === null) throw new Error('The cells read again are not the cells shown.');
  const kept = before.kept;
  const all = Uint32Array.from({ length: n }, (_, j) => j);
  const indexOf = original => {
    let lo = 0;
    let hi = kept.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (kept[mid] < original) lo = mid + 1;
      else hi = mid;
    }
    if (lo === kept.length || kept[lo] !== original) throw new Error('The cells read again are not the cells shown.');
    return lo;
  };
  const earlierAt = new Uint32Array(n);
  const beforeOriginals = before.toOriginal(all);
  for (let i = 0; i < n; i++) earlierAt[indexOf(beforeOriginals[i])] = i;
  const afterOriginals = after.toOriginal(all);
  const order = new Uint32Array(n);
  for (let j = 0; j < n; j++) order[j] = earlierAt[indexOf(afterOriginals[j])];
  return order;
}

/** Whether an error is a cancellation. */
function isAbort(error) {
  return error?.name === 'AbortError';
}

/**
 * Check every added row read against the cells added, before the commit
 * changes anything (`resizeCells`, `resizeOpenCells` and the loaders would
 * refuse a wrong length half way). @private
 */
function requireAddedRows(read, added, dimensionOf) {
  for (const [layoutKey, { positions }] of read.positions) {
    const want = added * dimensionOf(layoutKey);
    if (!(positions instanceof Float32Array) || positions.length !== want) {
      throw new RangeError(`The cells added to embedding "${layoutKey}" hold ${formatCountOf(positions?.length ?? 0, 'value')}, not ${formatCount(want)}.`);
    }
  }
  for (const [label, rows] of [['field', read.obs], ['gene', read.genes]]) {
    for (const [key, row] of rows) {
      const array = row.codes ?? row.values;
      if (!ArrayBuffer.isView(array) || array.length !== added) {
        throw new RangeError(`The cells added to ${label} "${key}" hold ${formatCountOf(array?.length ?? 0, 'value')}, not ${formatCount(added)}.`);
      }
    }
  }
}

/**
 * @param {{
 *   state: object,
 *   viewer: object,
 *   runtime: {
 *     readPositionRows: (options: {path: string, dimension: number, rows: [number, number], signal: AbortSignal|null}) => Promise<{positions: Float32Array, bounds: Object|null}>,
 *     loadGeneration: (options: {expectedIdentityId: string, signal: AbortSignal|null}) => Promise<Object>,
 *     stage: () => object|null,
 *     adoptStage: (stage: object) => void,
 *     retireKeptViews: () => void,
 *     retireSelections: () => void,
 *     keptViews: {capture: () => object, restore: (record: object) => Promise<string[]>}|null,
 *     connectivity: {getConnectivityGraph: () => {summary: Object|null, url: string|null}, replaceConnectivityGraph: (graph: Object) => void, loadSummary: (url: string, signal: AbortSignal|null) => Promise<Object>},
 *     invalidateAnalysisData: () => void,
 *     loadMappingCandidates: (signal: AbortSignal|null) => Promise<Object>,
 *     adoptMetadata: (metadata: Object) => void,
 *     afterResize: () => Promise<void>,
 *   },
 *   notify?: (text: string) => void,
 *   onProgress?: (progress: {cells: number, target: number, chunked: boolean}|null) => void,
 * }} options
 */
export function createOpenCellsResize({ state, viewer, runtime, notify = () => {}, onProgress = () => {} }) {
  let tail = Promise.resolve();
  let growth = null;

  /** Run `work` after every resize before it (one at a time). */
  function serialized(work) {
    const run = tail.then(work, work);
    tail = run.catch(() => {});
    return run;
  }

  /**
   * The added rows of every resident layout and loaded field, read for
   * cells `[from, to)`. A layout whose added rows hold a value that cannot
   * be drawn is `unusable` (its reason), as an opening of those cells would
   * find it. @private
   */
  async function readAddedRows(from, to, signal) {
    const rows = [from, to];
    const dimensionManager = state.getDimensionManager();
    const positions = new Map();
    const unusable = new Map();
    const obs = new Map();
    const genes = new Map();
    const changed = new Set();
    const reads = [];
    for (const { layoutKey, dimension, path } of dimensionManager.residentLayouts()) {
      if (path === null) continue;
      reads.push(runtime.readPositionRows({ path, dimension, rows, signal }).then(
        payload => { positions.set(layoutKey, { positions: payload.positions, bounds: payload.bounds }); },
        error => {
          if (!(error instanceof EmbeddingLoadError)) throw error;
          unusable.set(layoutKey, error.reason);
        }
      ));
    }
    const obsFields = state.obsData?.fields ?? [];
    obsFields.forEach((field, index) => {
      if (field?._isUserDefined === true || field?.loaded !== true) return;
      const key = field._originalKey || field.key || String(index);
      // Codes are read under the categories the file names (its dictionary,
      // or the ones a text column's first load found), never the names
      // shown (a category may have been renamed).
      const descriptor = state._obsFieldDescriptors?.[index] ?? null;
      const categories = field.kind !== 'category'
        ? null
        : Array.isArray(descriptor?.categories) ? descriptor.categories : state._fieldDataCache.get(key)?.categories ?? null;
      const loaderField = descriptor ?? field;
      reads.push(state.fieldLoader.readRows(loaderField, rows, { signal, categories }).then(result => {
        if (result.changed === true) changed.add(key);
        else obs.set(key, result.kind === 'category' ? { codes: result.codes } : { values: result.values });
      }));
    });
    const varFields = state.varData?.fields ?? [];
    varFields.forEach((field, index) => {
      if (field?._isUserDefined === true || field?.loaded !== true || state.varFieldLoader === null) return;
      const key = field._originalKey || field.key || String(index);
      const descriptor = state._varFieldDescriptors?.[index] ?? field;
      reads.push(state.varFieldLoader.readRows(descriptor, rows, { signal }).then(values => genes.set(key, { values })));
    });
    await Promise.all(reads);
    return { positions, unusable, obs, genes, changed };
  }

  /**
   * Read the open dataset again with the cells `cellSubset` asks for, in
   * place when they are the open ones grown or cut (module doc).
   *
   * @param {{annData: object, cellSubset: Object, signal?: AbortSignal|null, quiet?: boolean, step?: string, growing?: boolean}} options
   *   `growing`: a progressive opening's step, which must grow in place
   * @returns {Promise<{inPlace: boolean, from?: number, to?: number}>}
   */
  async function resizeOnce({ annData, cellSubset, signal = null, quiet = false, step = undefined, growing = false }) {
    const stage = runtime.stage();
    if (stage === null || stage.runtimeKind !== 'dataset') throw new Error('No dataset is shown to read again.');
    // Step 0: the work under way on the open cells ends on them; from here
    // until the commit, work about to start waits for it.
    await cellWorkSettled(signal);
    const end = beginCellsChange();
    let change;
    try {
      change = await readAndCommit({ stage, annData, cellSubset, signal, quiet, step, growing });
    } finally {
      end();
    }
    if (change.inPlace !== true) return change;
    return finish(change, signal);
  }

  /** Steps 1 and 2 (module doc). @private */
  async function readAndCommit({ stage, annData, cellSubset, signal, quiet, step, growing }) {
    // The earlier cells, read back when this reading does not land: their
    // own request, never the caller's.
    const previous = requestOfOpenCells(annData.getCellSubset());
    const restore = () => annData.reopenCells({ cellSubset: previous, quiet: true }).catch(restoreFailure => {
      console.error('[OpenCellsResize] The cells open before could not be read again:', restoreFailure);
    });
    const before = annData.getCellIdentity();
    const { metadata, resized, reordered } = await annData.reopenCells({ cellSubset, signal, quiet, ...(step === undefined ? {} : { step }) });
    if (reordered === true) return reorder({ stage, annData, metadata, before, signal, restore });
    if (resized === null) {
      // Other cells: shown as a new reading by the caller; a progressive
      // opening's step must grow what is shown.
      if (!growing) return { inPlace: false };
      await restore();
      throw new Error('A progressive opening step read other cells than the ones shown and more.');
    }
    const { from, to } = resized;
    const started = performance.now();
    const dimensionManager = state.getDimensionManager();
    const liveLayout = state.getViewLayoutKey('live');
    let read;
    let generation;
    let candidates;
    let identity;
    let priority;
    try {
      if (from !== state.pointCount) {
        throw new Error(`The dataset shows ${formatCountOf(state.pointCount, 'cell')}, not the ${formatCount(from)} its reader grew from.`);
      }
      [read, generation, candidates] = await Promise.all([
        to > from
          ? readAddedRows(from, to, signal)
          : { positions: new Map(), unusable: new Map(), obs: new Map(), genes: new Map(), changed: new Set() },
        runtime.loadGeneration({ expectedIdentityId: stage.generation.identity.id, signal }),
        runtime.loadMappingCandidates(signal),
      ]);
      if (signal?.aborted) throw signal.reason;
      // Everything the commit needs, checked before it changes anything.
      identity = annData.getCellIdentity();
      if (identity?.n !== to) throw new Error(`The reader opened ${formatCountOf(identity?.n ?? 0, 'cell')}, not the ${formatCount(to)} it grew to.`);
      priority = requireCellPriority(cellPriorityOf(annData.getCellSubset()), to);
      if (read.unusable.has(liveLayout)) {
        const why = `the embedding shown, "${liveLayout}", ${read.unusable.get(liveLayout)} among the cells added`;
        // An opening of these cells refuses that embedding and shows
        // another: Apply shows them as a new reading.
        if (!growing) return { inPlace: false };
        throw new Error(why);
      }
      const held = to > from
        ? read.positions.has(liveLayout)
        : dimensionManager.residentLayouts().some(layout => layout.layoutKey === liveLayout);
      if (!held) throw new Error(`The live view's embedding "${liveLayout}" is not loaded.`);
      requireAddedRows(read, to - from, layoutKey => dimensionManager.getLayout(layoutKey).dimension);
    } catch (error) {
      // The dataset on screen stays: its reader opens its cells again (what
      // they share is carried, nothing is fetched).
      await restore();
      throw error;
    }
    const readMs = performance.now() - started;

    // Step 2, the commit: one synchronous step.
    const committing = performance.now();
    const keptViews = viewer.hasSnapshots() && runtime.keptViews !== null ? runtime.keptViews.capture() : null;
    if (viewer.hasSnapshots()) runtime.retireKeptViews();
    // A selection under way names cells of the earlier count: growing keeps
    // every one of them open, cutting may not.
    if (to < from) runtime.retireSelections();
    const graph = runtime.connectivity.getConnectivityGraph();
    viewer.resetVectorFieldOverlay?.();
    const layouts = dimensionManager.resizeCells(to, read.positions);
    const positions = layouts.get(liveLayout);
    const outcome = state.resizeOpenCells({
      n: to,
      identity,
      priority,
      positions,
      obs: read.obs,
      var: read.genes,
      changed: read.changed,
    });
    // The loaders check every read against the open cells: the same
    // loaders (the same routes, the same mapping) for the new count.
    const fieldLoader = state.fieldLoader.resized(to);
    const varFieldLoader = state.varFieldLoader === null ? null : state.varFieldLoader.resized(to);
    state.setFieldLoader(fieldLoader);
    state.setVarFieldLoader(varFieldLoader);
    runtime.adoptStage(Object.freeze({
      ...stage,
      generation,
      positions,
      cellIdentity: identity,
      cellPriority: state.cellPriority,
      fieldLoader: stage.fieldLoader === null ? null : stage.fieldLoader.resized(to),
      varFieldLoader: stage.varFieldLoader === null ? null : stage.varFieldLoader.resized(to),
    }));
    runtime.invalidateAnalysisData();
    state.publishResizedCells({ layoutKey: liveLayout, from });
    // The data mapping's choices, listed at the cells open now.
    state.adoptResizedMappingCandidates(candidates);
    runtime.adoptMetadata(metadata);
    const commitMs = performance.now() - committing;
    // Not a measure of what showing a cell costs on an opening
    // (`data/opening-cost.js`): the GPU keeps the cells kept and takes only
    // those added, while their colours and filters are made again for every
    // open cell.
    console.log(`[OpenCellsResize] ${formatCount(from)} → ${formatCountOf(to, 'cell')} in place: read ${readMs.toFixed(0)} ms, shown ${commitMs.toFixed(0)} ms`);
    return { inPlace: true, from, to, readMs, commitMs, outcome, graph, keptViews, unusable: read.unusable };
  }

  /**
   * The same cells in another order (a subsample grown from few chunks put
   * in priority order, `progressive-open.js`): nothing is read; every
   * per-cell array moves with its cell (`DimensionManager.reorderCells`,
   * `DataState.reorderOpenCells`), checked whole first. @private
   */
  async function reorder({ stage, annData, metadata, before, signal, restore }) {
    const started = performance.now();
    const dimensionManager = state.getDimensionManager();
    const liveLayout = state.getViewLayoutKey('live');
    const n = state.pointCount;
    let identity;
    let priority;
    let order;
    let generation;
    let candidates;
    try {
      [generation, candidates] = await Promise.all([
        runtime.loadGeneration({ expectedIdentityId: stage.generation.identity.id, signal }),
        runtime.loadMappingCandidates(signal),
      ]);
      if (signal?.aborted) throw signal.reason;
      identity = annData.getCellIdentity();
      if (identity?.n !== n || before?.n !== n) throw new Error(`The reader reopened ${formatCountOf(identity?.n ?? 0, 'cell')}, and ${formatCount(n)} are shown.`);
      priority = requireCellPriority(cellPriorityOf(annData.getCellSubset()), n);
      order = reorderOf(before, identity);
      if (!dimensionManager.residentLayouts().some(layout => layout.layoutKey === liveLayout)) {
        throw new Error(`The live view's embedding "${liveLayout}" is not loaded.`);
      }
    } catch (error) {
      await restore();
      throw error;
    }
    const readMs = performance.now() - started;
    const committing = performance.now();
    const keptViews = viewer.hasSnapshots() && runtime.keptViews !== null ? runtime.keptViews.capture() : null;
    if (viewer.hasSnapshots()) runtime.retireKeptViews();
    // A selection under way names cells at their earlier positions.
    runtime.retireSelections();
    const graph = runtime.connectivity.getConnectivityGraph();
    viewer.resetVectorFieldOverlay?.();
    const positions = dimensionManager.reorderCells(order).get(liveLayout);
    const outcome = state.reorderOpenCells({ identity, priority, positions, order });
    runtime.adoptStage(Object.freeze({ ...stage, generation, positions, cellIdentity: identity, cellPriority: state.cellPriority }));
    runtime.invalidateAnalysisData();
    state.publishResizedCells({ layoutKey: liveLayout, from: n });
    state.adoptResizedMappingCandidates(candidates);
    runtime.adoptMetadata(metadata);
    const commitMs = performance.now() - committing;
    console.log(`[OpenCellsResize] ${formatCountOf(n, 'cell')} put in priority order in place: ${commitMs.toFixed(0)} ms`);
    return { inPlace: true, from: n, to: n, readMs, commitMs, outcome, graph, keptViews, unusable: new Map() };
  }

  /** Step 3 (module doc). @private */
  async function finish({ from, to, readMs, commitMs, outcome, graph, keptViews, unusable }, signal) {
    const followUps = [];
    if (graph.url !== null) {
      followUps.push(runtime.connectivity.loadSummary(graph.url, signal).then(
        summary => runtime.connectivity.replaceConnectivityGraph({ summary, url: graph.url }),
        error => { if (!isAbort(error)) notify(`The neighbour graph could not be read on the new cells: ${error.message}`); }
      ));
    }
    if (outcome.resumeActive !== null) followUps.push(resumeActiveField(outcome.resumeActive));
    // The vector field overlay draws the shown field again on the new cells
    // (`velocity-overlay-controls.js`); its load is work on the open cells
    // a next change waits for.
    state.emit('vectorFields:cells-changed');
    followUps.push(runtime.afterResize().catch(error => console.error('[OpenCellsResize] Refreshing after the resize failed:', error)));
    if (keptViews !== null) {
      followUps.push(runtime.keptViews.restore(keptViews).then(lost => {
        for (const reason of lost) notify(`Not kept after the cells changed — ${reason}`);
      }));
    }
    await Promise.all(followUps);
    for (const [layoutKey, reason] of unusable) {
      notify(`The embedding "${layoutKey}" ${reason} among the cells added: it cannot be shown on the cells open now.`);
    }
    const said = describeOutcome(outcome);
    if (said !== '') notify(said);
    return { inPlace: true, from, to, readMs, commitMs };
  }

  /** Load the field shown again (it was released by the resize) and show it. @private */
  async function resumeActiveField({ source, index }) {
    try {
      if (source === 'var') {
        await state.ensureVarFieldLoaded(index);
        if (state.activeFieldSource === null) state.setActiveVarField(index);
      } else {
        await state.ensureFieldLoaded(index);
        if (state.activeFieldSource === null) state.setActiveField(index);
      }
    } catch (error) {
      if (!isAbort(error)) notify(`The field shown could not be read on the new cells: ${error.message}`);
    }
  }

  /** Stop a progressive opening's growth under way. */
  function stopGrowth() {
    if (growth === null) return;
    growth.controller.abort(new DOMException('The open cells were changed.', 'AbortError'));
    growth = null;
    onProgress(null);
  }

  /**
   * Grow a progressive opening to the cells asked for (`cellSubset.growth`
   * of its reader: the counts of its steps, the request of the last and the
   * request of the others), in the background, one step after another;
   * `signal` (the dataset's publication) stops it.
   *
   * @param {object} annData
   * @param {AbortSignal} signal
   */
  function grow(annData, signal) {
    const plan = annData.getCellSubset()?.growth ?? null;
    if (plan === null) return Promise.resolve();
    stopGrowth();
    const controller = new AbortController();
    const stop = AbortSignal.any([signal, controller.signal]);
    growth = { controller };
    // A step's request: the cells of the first k of priority order, or,
    // grown from few chunks, the cells of the chunks that hold the first k
    // of chunk order (then put in priority order: `plan.final`).
    const requestOf = k => (plan.chunked
      ? { ...plan.step, chunks: { ...plan.step.chunks, cells: k } }
      : k === plan.target ? plan.final : { ...plan.step, k });
    const run = (async () => {
      for (const k of plan.steps) {
        if (stop.aborted) return;
        if (k <= state.pointCount) continue;
        onProgress({ cells: state.pointCount, target: plan.target, chunked: plan.chunked === true });
        await serialized(() => {
          if (stop.aborted) return null;
          return resizeOnce({
            annData,
            cellSubset: requestOf(k),
            signal: stop,
            quiet: true,
            step: `Reading more cells: ${formatCount(k)} of ${formatCount(plan.target)}`,
            growing: true,
          });
        });
      }
      if (plan.chunked && !stop.aborted) {
        onProgress({ cells: state.pointCount, target: plan.target, chunked: true });
        await serialized(() => (stop.aborted ? null : resizeOnce({
          annData,
          cellSubset: plan.final,
          signal: stop,
          quiet: true,
          step: `Putting the ${formatCountOf(plan.target, 'cell')} in their order`,
          growing: true,
        })));
      }
    })();
    return run.then(
      () => {
        if (growth?.controller === controller) {
          growth = null;
          onProgress(null);
        }
      },
      error => {
        if (growth?.controller === controller) {
          growth = null;
          onProgress(null);
        }
        if (!isAbort(error) && !stop.aborted) {
          console.error('[OpenCellsResize] Progressive opening stopped:', error);
          notify(`Reading the rest of the cells stopped: ${error.message}. ${formatCountOf(state.pointCount, 'cell')} are open.`);
        }
      }
    );
  }

  return Object.freeze({
    /**
     * Read the open dataset again with the cells `cellSubset` asks for: in
     * place when they are the open ones grown or cut, one resize at a time;
     * a progressive opening's growth stops first.
     *
     * @param {{annData: object, cellSubset: Object, signal?: AbortSignal|null}} options
     */
    resize({ annData, cellSubset, signal = null }) {
      stopGrowth();
      return serialized(() => resizeOnce({ annData, cellSubset, signal }));
    },
    grow,
    stopGrowth,
    /** Whether a progressive opening is growing. */
    get growing() {
      return growth !== null;
    },
  });
}

/**
 * What a resize could not keep as it was, in sentences, or ''.
 *
 * @param {{recoded: string[], droppedGroups: string[], resetRanges: string[]}} outcome
 * @returns {string}
 */
export function describeOutcome({ droppedGroups, resetRanges, recoded }) {
  const parts = [];
  if (droppedGroups.length > 0) {
    parts.push(droppedGroups.length === 1
      ? `The highlight group "${droppedGroups[0]}" has no cell open now and was removed.`
      : `${formatCountOf(droppedGroups.length, 'highlight group')} have no cell open now and were removed: ${droppedGroups.map(label => `"${label}"`).join(', ')}.`);
  }
  if (resetRanges.length > 0) {
    parts.push(`No cell open now lies in ${resetRanges.join(', ')}: ${resetRanges.length === 1 ? 'it was' : 'they were'} reset.`);
  }
  if (recoded.length > 0) {
    parts.push(`The cells added hold categories ${recoded.map(key => `"${key}"`).join(', ')} had not shown: ${recoded.length === 1 ? 'it is' : 'they are'} read again with every category.`);
  }
  return parts.join(' ');
}
