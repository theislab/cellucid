/**
 * @fileoverview DataState: the gene sample -- the open cells a gene is read
 * for (`data/anndata/subsample-plan.js`, `genes`).
 *
 * A large atlas stored cell by cell opens every cell the device holds on the
 * map, and a gene is read for the first `cells` open cells in priority order
 * (a sample of them, sized to the gene-time target); on the others a gene
 * has no value (NaN: drawn neutral beneath the expressing cells, never a
 * zero). This mixin keeps the sample of the matrix genes are read from (the
 * mapped expression matrix) current for the page: `getGeneSample()`, read
 * synchronously by what draws or states a gene, refreshed when the var
 * loader changes and when the sample grows; `'gene-sample:changed'` is
 * emitted with it.
 *
 * Reading genes for more cells (`readGenesForMoreCells`: Genes read for, in
 * Session › Open data, `ui/modules/gene-read-control.js`) grows it in steps (each a segment of the gene index,
 * `prefix-column-index.js`): after each, every gene loaded gets its values
 * on the cells added (read from the index just built: their own values
 * only), the gene shown is drawn again, and analyses read on the larger
 * sample.
 *
 * The sample is sized before any gene is read, by a price over the link as
 * measured by then; the first gene then measures it. What is left of the
 * gene time after the first gene reads genes for more cells the same way
 * (`topUpGeneSample`): the gene is drawn on as many cells as the link
 * delivers in the gene time, whatever the price guessed.
 *
 * Mixed into DataState via `state/managers/field-manager.js`.
 *
 * @module state/managers/field/gene-sample
 */

import { isContinuousValues } from '../../../../data/continuous-values.js';
import { columnFormOf, filledForm, noteColumnForm } from '../../../../data/column-forms.js';
import { isCancellation } from '../../../../utils/abort.js';

/**
 * How many cells a read takes within `ms`, from the reads measured
 * (`{cells, ms}`, in order; `topUpGeneSample`): from the last two of
 * different sizes, a fixed time and a time a cell (the fixed part kept
 * within what either took); from one, a read at least as large at its rate
 * (a larger read spreads the fixed time thinner: it takes no longer),
 * none when `ms` is shorter than it took.
 *
 * @param {{cells: number, ms: number}[]} reads
 * @param {number} ms
 * @returns {number}
 */
function cellsWithin(reads, ms) {
  const last = reads.at(-1);
  const before = reads.length > 1 ? reads.at(-2) : null;
  if (before !== null && before.cells !== last.cells) {
    const msPerCell = (last.ms - before.ms) / (last.cells - before.cells);
    if (msPerCell > 0) {
      const fixedMs = Math.min(Math.max(0, last.ms - msPerCell * last.cells), before.ms, last.ms);
      return Math.max(0, Math.floor((ms - fixedMs) / msPerCell));
    }
  }
  return ms >= last.ms ? Math.floor(last.cells * ms / last.ms) : 0;
}

/** The gene sample of a loader, or null: `{cells, of, fit}` (`fit` null once grown or restored). */
function requireSample(sample) {
  if (sample === null || sample === undefined) return null;
  if (!Number.isSafeInteger(sample.cells) || !Number.isSafeInteger(sample.of) || sample.cells < 0 || sample.cells >= sample.of) {
    throw new TypeError('A gene sample is {cells, of}, fewer cells than open.');
  }
  return Object.freeze({ cells: sample.cells, of: sample.of, fit: sample.fit ?? null });
}

export class FieldGeneSampleMethods {
  /**
   * The open cells a gene of the mapped expression matrix is read for:
   * `{cells, of, fit}` (open cells `[0, cells)`), or null when a gene is read
   * for every open cell.
   *
   * @returns {Readonly<{cells: number, of: number, fit: Object|null}>|null}
   */
  getGeneSample() {
    // The matrix's own answer (`noteGeneSample`), while it was given for the
    // var loader and the open cells of now.
    const noted = this._geneSampleNoted ?? null;
    const sample = this._geneSample ?? null;
    if (noted !== null && noted.loader === (this.varFieldLoader ?? null) && noted.of === this.pointCount && (sample === null || sample.of === this.pointCount)) {
      return sample;
    }
    // Asked again, not answered yet (a new loader, the open cells changed in
    // place: an opening, a progressive step, Apply): the opening's sample,
    // known to the loader at once, stands for it -- never "every cell", which
    // a matrix read after its map does not have (its genes not read for any
    // cell yet: a gene picked then was refused as having no value).
    return this._openingGeneSample();
  }

  /**
   * The gene sample of the opening the var loader reads (`loader.geneSample`,
   * the reader's `cellSubset.genes`, current as soon as the open cells are)
   * when it is of the cells open now, else null. @private
   */
  _openingGeneSample() {
    const sample = this.varFieldLoader?.geneSample?.() ?? null;
    if (sample === null || sample.of !== this.pointCount) return null;
    const opening = this._openingSample ?? null;
    if (opening !== null && opening.cells === sample.cells && opening.of === sample.of && opening.fit === (sample.fit ?? null)) return opening;
    this._openingSample = requireSample(sample);
    return this._openingSample;
  }

  /**
   * Ask the source for the gene sample of the mapped expression matrix
   * again (a var loader was set, the gene list was read, genes were read for
   * more cells), and say when it changed (`'gene-sample:changed'`). A gene
   * loaded says its own as it arrives (`noteGeneSample`).
   *
   * @returns {Promise<Object|null>}
   */
  async refreshGeneSample() {
    const loader = this.varFieldLoader ?? null;
    const descriptor = this._varFieldDescriptors?.[0] ?? null;
    if (loader === null || typeof loader.geneSampleOf !== 'function') {
      return this.noteGeneSample(null);
    }
    if (descriptor === null) {
      // The gene list not read yet: nothing to ask the matrix about, and
      // nothing it has answered stands for these cells. The opening's
      // sample stands meanwhile (`getGeneSample`), never "every cell"; the
      // list's own refresh asks (`initVarData`).
      this._geneSampleNoted = null;
      return this.getGeneSample();
    }
    let of;
    try {
      of = await loader.geneSampleOf(descriptor);
    } catch (error) {
      // A dataset not bound yet, or closed or replaced meanwhile: the
      // first gene loaded says its sample (`noteGeneSample`).
      console.warn('[DataState] The gene sample could not be read:', error);
      return this.getGeneSample();
    }
    if (this.varFieldLoader !== loader) return this.getGeneSample();
    return this.noteGeneSample(of);
  }

  /**
   * The gene sample of the mapped expression matrix is `of` (`{cells, of}`,
   * or null: every open cell's genes are read), as a gene's read said it or
   * the source answered (`refreshGeneSample`); said when it changed.
   *
   * @param {{cells: number, of: number}|null} of
   * @returns {Readonly<{cells: number, of: number, fit: Object|null}>|null}
   */
  noteGeneSample(of) {
    // A sample grown to fill its gene time (`topUpGeneSample`) is still the
    // one the gene time sized: its fit stands (the reader's is a person's
    // count once grown).
    const toppedUp = this._toppedUp();
    const fitOf = sample => this.varFieldLoader?.geneSample?.()?.fit ?? (toppedUp !== null && toppedUp.of === sample.of ? toppedUp.fit : null);
    const sample = of === null || of === undefined ? null : requireSample({ ...of, fit: fitOf(of) });
    const before = this._geneSample ?? null;
    // Whose answer it is: the var loader's, for the cells open now.
    this._geneSampleNoted = { loader: this.varFieldLoader ?? null, of: this.pointCount };
    if (before?.cells === sample?.cells && before?.of === sample?.of && before?.fit === sample?.fit) {
      this._geneSample = before;
      return before;
    }
    this._geneSample = sample;
    this.emit?.('gene-sample:changed', { sample });
    return sample;
  }

  /**
   * What reading genes for the first `target` open cells costs beyond the
   * gene sample (`AnnDataReader.geneSampleCost`): bytes, time, the index's
   * memory; null when there is no sample.
   *
   * @param {number} [target] - Open cells; every one by default
   * @param {{geneTime?: {ms: number, spentBytes: number, spentRequests?: number}|null}} [options] -
   *   The top-up's (`topUpGeneSample`): the cells lowered to those a share's
   *   sample reads within every cell's bytes in its gene time (`ceiling`)
   */
  async geneSampleCost(target = this.pointCount, options = {}) {
    const loader = this.varFieldLoader ?? null;
    const descriptor = this._geneSampleDriver();
    if (this.getGeneSample() === null || loader === null || descriptor === null || typeof loader.geneSampleCost !== 'function') return null;
    return loader.geneSampleCost(descriptor, target, options);
  }

  /**
   * Read genes for the first `target` open cells (Genes read for), in
   * steps: after each, every loaded gene's values on the cells added are
   * read (from the index just built) and the gene shown is drawn again
   * (`onStep(sample, cells)` then). What is read stays when `signal` stops
   * the rest.
   *
   * @param {number} [target]
   * @param {{signal?: AbortSignal|null, onStep?: ((sample: Object|null, cells: number) => void)|null}} [options]
   * @returns {Promise<Object|null>} The gene sample now (null: every open cell)
   */
  async readGenesForMoreCells(target = this.pointCount, { signal = null, onStep = null, topUp = false } = {}) {
    const loader = this.varFieldLoader ?? null;
    const descriptor = this._geneSampleDriver();
    // A person's growth takes over from one filling the gene time
    // (`topUpGeneSample`): it stops, keeping what it read.
    const running = this._geneSampleGrowth ?? null;
    if (running !== null && running.topUp && !topUp) {
      running.controller.abort(Object.assign(new Error('Genes are read for the cells you asked for instead.'), { name: 'AbortError' }));
      await running.settled;
    }
    const start = this.getGeneSample();
    if (start === null || loader === null || descriptor === null) return start;
    if (this._geneSampleGrowth != null) throw new Error('Genes are being read for more cells already.');
    // A count the person chose from here on: no longer the gene time's.
    if (!topUp) this._geneSampleTopUp = null;
    const generation = this._datasetGeneration ?? 0;
    // Stopped by `signal`, or by `stopReadingGenesForMoreCells`.
    const controller = new AbortController();
    const stop = signal === null ? controller.signal : AbortSignal.any([signal, controller.signal]);
    let settle;
    const growth = { controller, target: Math.min(this.pointCount, target), cells: start.cells, topUp, settled: new Promise(resolve => { settle = resolve; }) };
    this._geneSampleGrowth = growth;
    this.emit?.('gene-sample:changed', { sample: start, growth: { cells: growth.cells, target: growth.target } });
    signal = stop;
    let filled = start.cells;
    // Steps are filled in order, one after another.
    let filling = Promise.resolve();
    const fill = cells => {
      filling = filling.then(async () => {
        if ((this._datasetGeneration ?? 0) !== generation || cells <= filled) return;
        await this._fillGeneRows(filled, cells, signal);
        filled = cells;
        growth.cells = cells;
        // The sample said with the values filled, in the same turn (nothing
        // sees values past the sample it states), then asked of the source.
        this.noteGeneSample(cells >= this.pointCount ? null : { cells, of: this.pointCount });
        await this.refreshGeneSample();
        if (this._geneSampleGrowth === growth) this.emit?.('gene-sample:changed', { sample: this.getGeneSample(), growth: { cells, target: growth.target } });
        onStep?.(this.getGeneSample(), cells);
      });
      return filling;
    };
    try {
      await loader.growGeneSample(descriptor, target, { signal, topUp, onStep: (_sample, cells) => { void fill(cells); } });
    } finally {
      // What the reader read is the sample now, stopped or not: its values
      // filled too (not stopped by the growth's own signal).
      const now = loader.geneSample?.();
      signal = null;
      await fill(now === null || now === undefined ? this.pointCount : now.cells).catch(() => {});
      if (this._geneSampleGrowth === growth) this._geneSampleGrowth = null;
      this.emit?.('gene-sample:changed', { sample: this.getGeneSample(), growth: null });
      settle();
    }
    return this.getGeneSample();
  }

  /**
   * The first gene read for a sample the gene time sized
   * (`subsample-plan.js` `geneTimeFit`, `fit.limit` 'geneTime') took `ms`:
   * the sample's rows are read and indexed, and what is left of the target
   * (`fit.budgetMs`) reads genes for more cells, so the gene is drawn on as
   * many cells as the link really delivers in the gene time rather than as
   * many as were priced before it was measured. The price is made over the
   * link the reads measured so far: on a first visit to a host its early
   * reads are small and measure a fraction of its rate (a CELLxGENE atlas
   * over S3: 1 MB/s priced at the opening, 11 MB/s measured over the first
   * gene), and a host's speed changes while it is read. So the steps are
   * sized by what the reads took, never by a price: the time of a read is
   * the one fact that holds whatever the link model says.
   *
   * A read takes a fixed time (its dependent round trips: chunk index
   * levels, row pointers before entries) and a time a cell. Once two reads
   * of different sizes are measured, the next step is sized from both (the
   * two times on a line, the fixed part within what either took); after the
   * first alone, only a step at least as large as it is sized, from its
   * rate (its fixed time spread over as many cells or more: never longer
   * than the time left). The first gene's cells whose gene index was kept
   * in this browser (`fit.kept`) cost it nothing: only the cells it read
   * count. A later visit's first gene reads only those (coming back is
   * never slower than the first visit): its first step then reads the
   * cells the target priced over the link (`fit.growTo`; a quarter more
   * over a link with no price), and the steps after it are sized by what
   * that read took. No step reads more than the gene index can be kept for
   * (`geneSampleCost`, `index.fits`), and a share's sample transfers no
   * more bytes, nor makes more requests, over its gene time than every
   * cell's would (`ceiling`, the rule
   * its first gene was fitted by: a scattered share's steps each fetch
   * nearly every stored chunk again, so without it its top-up could read
   * more of the matrix than every cell's); it is read as Genes read for reads (`readGenesForMoreCells`:
   * every loaded gene fills in, the legend counts the cells, Stop keeps
   * what is read). It stops when the time left would add less than a
   * quarter of the cells read (a scheduling choice: such a step is mostly
   * its round trips and adds little the eye sees), when the person stops
   * it or asks for cells themselves (their growth takes over), or when the
   * dataset changes. Once per sample: a later gene reads the index.
   *
   * @param {number} ms - How long the first gene took, from its read's start
   * @returns {Promise<void>|null} The steps, or null when there are none to make
   */
  topUpGeneSample(ms) {
    const sample = this.getGeneSample();
    const fit = sample?.fit ?? null;
    if (sample === null || fit?.limit !== 'geneTime' || !(fit.budgetMs > 0) || !(ms > 0) || ms >= fit.budgetMs) return null;
    if (this._geneSampleGrowth != null || this._toppedUp() !== null) return null;
    const generation = this._datasetGeneration ?? 0;
    // `yields`: genes asked for meanwhile (`yieldGeneSampleTopUp`), which
    // the steps wait for; `resume`: what lets them go on.
    const topUp = { of: sample.of, fit, generation, yields: 0, yielded: false, resume: null };
    this._geneSampleTopUp = topUp;
    const current = () => (this._datasetGeneration ?? 0) === generation && this._geneSampleTopUp === topUp;
    const steps = (async () => {
      let spent = ms;
      let cells = sample.cells;
      // Each read: how many cells it read, and in how long.
      const reads = [{ cells: sample.cells - Math.min(sample.cells, fit.kept?.cells ?? 0), ms }];
      // A later visit's first gene is read for the cells kept here alone
      // (`geneTimeFit`): it read none from the file and measured nothing.
      // The first step reads the cells the target priced over the link
      // (`fit.growTo`), or, over a link with no price, the least step a
      // top-up makes (a quarter of the cells); its reads then size the next,
      // as after a first gene that read cells.
      if (reads[0].cells === 0) reads.length = 0;
      // A later visit's cells whose gene index was kept count as read at
      // the rate the first read from the file measured on the others: the
      // gene time buys no more cells in all than it would have read from
      // the file (a revisit with a large kept sample tops up little or
      // nothing).
      const reachOf = () => ((fit.kept?.cells ?? 0) > 0 && reads.length > 0 ? cellsWithin(reads.slice(0, 1), fit.budgetMs) : Infinity);
      // What the sample has transferred, and asked for, in its gene time (as
      // priced: the first gene's, then each step's).
      let spentBytes = fit.bytes ?? 0;
      let spentRequests = fit.requests ?? 0;
      while (current()) {
        // A gene asked for goes first: the steps wait until it is read.
        if (topUp.yields > 0) {
          await new Promise(resolve => { topUp.resume = resolve; });
          topUp.resume = null;
          if (!current()) return;
        }
        const left = fit.budgetMs - spent;
        const first = Math.max(fit.growTo ?? 0, cells + Math.ceil(cells / 4));
        let to = Math.min(sample.of, reachOf(), reads.length === 0 ? first : cells + cellsWithin(reads, left));
        if ((to - cells) * 4 < cells) return;
        const cost = await this.geneSampleCost(to, { geneTime: { ms: fit.budgetMs, spentBytes, spentRequests } });
        if (cost === null || !current()) return;
        to = Math.min(to, cost.target ?? to, cost.index?.fits ?? to);
        if ((to - cells) * 4 < cells) return;
        spentBytes += cost.bytes ?? 0;
        spentRequests += cost.requests ?? 0;
        const startedAt = performance.now();
        topUp.yielded = false;
        let now;
        try {
          now = await this.readGenesForMoreCells(to, { topUp: true });
        } catch (error) {
          // Stopped for a gene asked for: what it read is the sample now.
          if (!topUp.yielded || !isCancellation(error)) throw error;
          now = this.getGeneSample();
        }
        const stepMs = performance.now() - startedAt;
        if (now === null) return;
        if (now.cells < to) {
          // Stopped for a gene asked for: what it read stays, its time is
          // spent, and the steps go on once the gene is read.
          if (!topUp.yielded || !current()) return;
          spent += stepMs;
          cells = now.cells;
          continue;
        }
        spent += stepMs;
        reads.push({ cells: now.cells - cells, ms: stepMs });
        cells = now.cells;
      }
    })();
    return steps.catch(error => {
      if (!isCancellation(error)) console.warn('[DataState] Genes could not be read for more cells in the gene time:', error);
    });
  }

  /**
   * Hold the gene sample still for an analysis about to read genes: a
   * growth filling the gene time (`topUpGeneSample`) stops, keeping what it
   * read, and makes no further step; this resolves once its last step is
   * filled and said (`'gene-sample:changed'`), so the analysis reads on the
   * sample that stays. A growth the person asked for (Genes read for)
   * goes on. A sample growing under a run was a new load to the data layer:
   * a DE started while the first gene's top-up read on failed ("invalidated
   * by a dataset lifecycle change", 10M cells). Null when no top-up step
   * runs (nothing to wait for: the caller goes on in the same turn).
   *
   * @returns {Promise<void>|null}
   */
  holdGeneSample() {
    const topUp = this._toppedUp();
    // Its loop sees it is no longer current and makes no further step.
    if (topUp !== null && topUp.held !== true) this._geneSampleTopUp = { ...topUp, held: true };
    const running = this._geneSampleGrowth ?? null;
    if (running === null || !running.topUp) return null;
    running.controller.abort(Object.assign(new Error('An analysis reads genes on the cells read so far.'), { name: 'AbortError' }));
    return running.settled;
  }

  /**
   * A gene is asked for (`loading.js`): one filling the gene time
   * (`topUpGeneSample`) never keeps it waiting behind its step. The step
   * under way stops at once, keeping what it read, and no other starts
   * until the returned function is called (the gene read, or failed); the
   * steps then go on within what is left of the gene time.
   *
   * @returns {() => void} What lets the steps go on
   */
  yieldGeneSampleTopUp() {
    const topUp = this._toppedUp();
    if (topUp === null) return () => {};
    topUp.yields++;
    const growth = this._geneSampleGrowth ?? null;
    if (growth !== null && growth.topUp) {
      topUp.yielded = true;
      growth.controller.abort(Object.assign(new Error('A gene was asked for: genes for more cells wait for it.'), { name: 'AbortError' }));
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--topUp.yields === 0) topUp.resume?.();
    };
  }

  /**
   * Genes being read for more cells now (`readGenesForMoreCells`): how many
   * are read so far and for how many; null when none is.
   *
   * @returns {{cells: number, target: number}|null}
   */
  getGeneSampleGrowth() {
    const growth = this._geneSampleGrowth ?? null;
    return growth === null ? null : { cells: growth.cells, target: growth.target };
  }

  /** Stop reading genes for more cells: what is read stays. */
  stopReadingGenesForMoreCells() {
    this._geneSampleGrowth?.controller.abort(Object.assign(new Error('Reading genes for more cells was stopped.'), { name: 'AbortError' }));
  }

  /** The sample of this dataset grown to fill its gene time (`topUpGeneSample`), or null. @private */
  _toppedUp() {
    const topUp = this._geneSampleTopUp ?? null;
    return topUp !== null && topUp.generation === (this._datasetGeneration ?? 0) ? topUp : null;
  }

  /**
   * The gene whose read builds each step of a growth: the gene shown, else
   * the first. @private
   */
  _geneSampleDriver() {
    const descriptors = this._varFieldDescriptors ?? null;
    if (descriptors === null || descriptors.length === 0) return null;
    const active = this.activeFieldSource === 'var' ? this.activeVarFieldIndex : -1;
    return descriptors[active >= 0 ? active : 0] ?? descriptors[0];
  }

  /**
   * Every loaded gene's values on open cells `[from, to)`, read now that
   * the gene sample holds them (they were NaN, not read), in new arrays;
   * the gene shown is drawn again. @private
   */
  async _fillGeneRows(from, to, signal = null) {
    const loader = this.varFieldLoader ?? null;
    const fields = this.varData?.fields ?? [];
    if (loader === null || typeof loader.readRows !== 'function' || to <= from) return;
    const generation = this._datasetGeneration ?? 0;
    const reads = [];
    fields.forEach((field, index) => {
      if (field?._isUserDefined === true || field?.loaded !== true || !isContinuousValues(field.values)) return;
      const descriptor = this._varFieldDescriptors?.[index] ?? field;
      reads.push(loader.readRows(descriptor, [from, to], { signal }).then(rows => ({ field, index, rows })));
    });
    const read = await Promise.all(reads);
    if ((this._datasetGeneration ?? 0) !== generation) return;
    const outcome = { from: this.pointCount, to: this.pointCount, released: [], extended: [], droppedGroups: [], resetRanges: [], resumeActive: null };
    // Each gene's values before and after: a kept view's fields share the arrays.
    const swapped = new Map();
    for (const { field, index, rows } of read) {
      if (field.loaded !== true || !isContinuousValues(field.values) || rows.length !== to - from) continue;
      // A new array: a field's values are never written in place (their scan is kept by array).
      const values = new field.values.constructor(field.values.length);
      values.set(field.values);
      values.set(rows, from);
      // Its sparse form grows with it (`data/column-forms.js`).
      noteColumnForm(values, filledForm(columnFormOf(field.values), from, columnFormOf(rows)));
      swapped.set(field.values, values);
      field.values = values;
      const key = field._originalKey || field.key || String(index);
      const entry = this._varFieldDataCache.get(key);
      if (entry !== undefined) this._varFieldDataCache.set(key, { ...entry, values });
      // Its statistics measured again over the cells now read, its ranges carried.
      this._carryContinuousRanges(field, this.pointCount, outcome);
    }
    // Every kept view showing these genes takes the values read, and is
    // drawn from them when it is focused (`setActiveView`): never a gene
    // shown with fewer cells read than the legend says.
    for (const [viewId, context] of this.viewContexts ?? new Map()) {
      if (viewId === this.activeViewId || context?.varData === this.varData) continue;
      let changed = false;
      for (const field of context?.varData?.fields ?? []) {
        const next = swapped.get(field?.values);
        if (next !== undefined) {
          field.values = next;
          // Its own statistics measured again, its ranges carried.
          this._carryContinuousRanges(field, this.pointCount, outcome);
          changed = true;
        }
      }
      if (changed) context.geneValuesRead = true;
    }
    if (this.activeFieldSource === 'var' && this.activeVarFieldIndex >= 0 && this.varData?.fields?.[this.activeVarFieldIndex]?.loaded === true) {
      // Drawn again, and every filter applied again (a gene's range judges the cells now read).
      this.setActiveVarField(this.activeVarFieldIndex);
    } else if (read.length > 0) {
      this.computeGlobalVisibility?.();
    }
  }
}
