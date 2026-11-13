/**
 * The reader's gene sample: the open cells genes are read for, what a gene
 * read costs (its plan), what reading genes for more cells costs and its
 * growth, and the rows a store holding only some rows' values holds.
 *
 * A method group of `AnnDataReader` (`reader.js`), mixed onto its
 * prototype: `this` is the reader. It replaces `_cellSubset` when the
 * sample grows (`_setGeneRows`).
 *
 * @module data/anndata/reader/gene-sample
 */

import { onAbort } from '../../../utils/abort.js';
import { residencyBudgetBytes } from '../../memory-budget.js';
import { isGroup } from '../../../formats/store.js';
import { columnIndexResidentBytes, geneReadCost, readInWholeChunks } from '../matrix-access.js';
import {
  firstGeneReadCost,
  geneReadMs,
  heldPrefix,
  linkPriced,
  prefixRowsOf,
  wholeSampleCost,
} from '../subsample-plan.js';
import { rowRangeMatrix } from '../prefix-column-index.js';
import { pricingLink } from '../../host-link-memory.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { prefixEndRow } from '../prefix-reads.js';

export class AnnDataReaderGeneSampleMethods {
  /**
   * What reading a gene of one expression matrix costs now, before it is
   * read (`geneReadCost`, `matrix-access.js`): whether the matrix is stored
   * cell by cell (each gene spread over every cell), the stored bytes the
   * first gene must read when it is and no index is built yet, the index that
   * read builds and where it can be kept (`index.placement`: `memory`,
   * `disk`, or null with the `refusal` saying why nothing can hold it, when
   * every gene scans the matrix again), and the link's measured rate
   * (bytes per second, null until measured or for a local file). Once the
   * index is built, only `built: true` is said: a gene then reads only itself.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} element
   * @returns {Promise<Object>}
   */
  async geneReadPlan(element) {
    this._ensureOpen();
    await this._readyGeneRows(element);
    const matrix = this._requireMatrixElement(element);
    // A matrix whose index is built reads only the gene: nothing to weigh.
    // One indexed in segments (`prefix-column-index.js`) has what is left
    // to read after the segments built (an earlier opening's, carried), and
    // the gene shows on more cells after each segment.
    const segments = this._indexedInSegments(matrix) ? await this._segmentProgress(matrix) : null;
    // One indexed whole whose index is kept in this browser is built too.
    const keptWhole = segments === null && this._matrices.get(matrix.key)?.columns == null &&
      (await this._keptRunsOf(matrix, () => this._openRowPointers(matrix.node))).some(run => run.start === 0 && run.rows === matrix.nRows);
    // The open cells a gene is read for (the gene sample's, `genes`).
    const readTo = segments?.readTo ?? matrix.nRows;
    const sample = readTo < matrix.nRows ? { cells: readTo, of: matrix.nRows } : null;
    if (keptWhole || this._matrices.get(matrix.key)?.columns?.built?.() === true || (segments !== null && segments.done >= readTo)) {
      return { label: matrix.label, cells: readTo, sample, cellMajor: null, layout: null, entries: null, built: true, scan: null, index: null, progressive: null, bytesPerSecond: null };
    }
    const valuesOnDemand = !this._readsAhead();
    const retainIndicesBytes = residencyBudgetBytes('columnIndex');
    const costOf = (node, nObs) => geneReadCost(node, {
      format: this._format,
      label: matrix.label,
      nObs,
      nVars: matrix.sourceVars,
      decodedChunkBytes: this._decodedChunkBytes,
      valuesOnDemand,
      retainIndicesBytes,
    });
    const cost = segments === null ? await costOf(matrix.node, readTo) : await costOf(segments.rest.matrix, segments.rest.rows);
    let progressive = null;
    if (segments !== null && (segments.done > 0 || segments.next < readTo)) {
      const first = segments.next === readTo ? cost : await costOf(rowRangeMatrix(segments.matrix, segments.done, segments.next, segments.pointers), segments.next - segments.done);
      progressive = { cells: readTo, done: segments.done, next: segments.next, nextStoredBytes: first.scan?.fetchBytes ?? first.scan?.storedBytes ?? null };
    }
    let index = null;
    if (cost.index !== null) {
      const placed = valuesOnDemand && cost.index.passes === 1
        ? { kind: 'memory', refusal: null }
        : await this.columnStoreFactory.plan(cost.index.storeBytes);
      index = { ...cost.index, placement: placed.kind, refusal: placed.refusal };
    }
    const link = this._link?.snapshot?.() ?? null;
    return {
      label: matrix.label,
      // The open cells the first gene reads the rows of: the gene sample's
      // (`sample`, null when every open cell's are read).
      cells: readTo,
      sample,
      cellMajor: cost.cellMajor,
      layout: cost.layout,
      entries: cost.entries,
      built: !cost.cellMajor,
      scan: cost.scan,
      index,
      progressive,
      bytesPerSecond: link !== null && link.measured && !link.readsAhead && link.bytesPerMs !== null
        ? link.bytesPerMs * 1000
        : null,
    };
  }

  /**
   * The open cells genes are read for (`subsample-plan.js`, `genes`): the
   * first `cells` of the `of` open cells in priority order, and why no more
   * (`fit`: the first gene's time over the link, or its index's memory;
   * null once a person or a session chose the count); null when a gene is
   * read for every open cell. A gene of a matrix indexed in segments has a
   * value on those cells only (NaN on the others); a gene-major matrix's
   * genes are read for every open cell.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @returns {Readonly<{cells: number, of: number, fit: Object|null}>|null}
   */
  get geneSample() {
    return this._cellSubset?.genes ?? null;
  }

  /**
   * The gene sample a gene of `element` is read for: `{cells, of}` when the
   * matrix is indexed in segments (read through a row index, the dataset's
   * own) and genes are read for fewer than every open cell; null when its
   * genes are read for every open cell (a gene-major matrix, a modality's,
   * or no sample).
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} element
   * @returns {Readonly<{cells: number, of: number}>|null}
   */
  geneSampleOf(element) {
    this._ensureOpen();
    const sample = this.geneSample;
    if (sample === null) return null;
    const matrix = this._requireMatrixElement(element);
    const cells = this._geneRows(matrix);
    return cells < matrix.nRows ? Object.freeze({ cells, of: matrix.nRows }) : null;
  }

  /**
   * What reading genes of `element` for the first `target` open cells costs
   * beyond the gene sample, before it is read: the first gene reads the rows
   * of open cells `[cells, target)` (`firstGeneReadCost`, the cost model the
   * sample was fitted by): the stored bytes it fetches (`bytes`; none of
   * what this browser keeps, `keptBytes`), its requests, and the time over
   * the link as measured (`ms`; null for a link not measured, as a local
   * file's before it is read); `index`: the memory its gene index then
   * holds and where it would be kept (`placement`: `memory`, `disk`, or
   * null with the `refusal`; then `fits`: the most open cells whose index
   * is kept here, else `target`). Null when there is no gene sample, or
   * `element` is not read for one.
   *
   * `geneTime` (the page's top-up, `DataState.topUpGeneSample`): the
   * sample's gene time (`ms`, its fit's `budgetMs`) and what it has
   * transferred and asked for in it so far (`spentBytes`, `spentRequests`).
   * A share's sample then never transfers more bytes, nor makes more
   * requests, than every cell's would in the same gene time
   * (`wholeSampleCost` at `ms` over the link as measured now, the rule its
   * first gene was fitted by): `target` is lowered to the most cells whose
   * read stays within both (`ceiling`: those bytes and requests, or null
   * for every cell of a file in its own order, which is the whole).
   * Without it, a scattered share's steps each fetch nearly every stored
   * chunk again (each step's cells lie in all of them), and a share's
   * steps in the file's cell order reach past every cell's blocks a
   * request for a few cells each.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} element
   * @param {number} target - Open cells, more than the sample's
   * @param {{geneTime?: {ms: number, spentBytes: number, spentRequests?: number}|null}} [options]
   * @returns {Promise<{cells: number, target: number, bytes: number, keptBytes: number, requests: number, ms: number|null,
   *   index: {residentBytes: number, placement: string|null, refusal: string|null, fits: number},
   *   ceiling: {bytes: number, requests: number}|null}|null>}
   */
  async geneSampleCost(element, target, { geneTime = null } = {}) {
    this._ensureOpen();
    const sample = this.geneSample;
    if (sample === null) return null;
    await this._readyGeneRows(element);
    const matrix = this._requireMatrixElement(element);
    if (!this._indexedInSegments(matrix)) return null;
    let to = Math.min(matrix.nRows, Math.max(sample.cells, Math.floor(target)));
    const link = pricingLink(this._link?.snapshot?.() ?? null, this._hostLink ?? null);
    const valuesOnDemand = !this._readsAhead();
    const decodedChunkBytes = this._decodedChunkBytes;
    const cost = await firstGeneReadCost(this._fullRoot, this._cellSubset.nObs, {
      valuesOnDemand,
      decodedChunkBytes,
      expression: matrix.key,
      // The gaps the byte reader fetches through between scattered rows.
      mergeGapBytes: link?.mergeGapBytes ?? 0,
    });
    // Every cell in a cell order reads its blocks as runs; any other opening its open cells' rows.
    const whole = this._cellSubset.kept === null;
    const rowsOf = prefixRowsOf(this._cellSubset.fileRows ?? null, this._cellSubset.nObs, whole ? this._cellSubset.cellOrder ?? null : null, this._subsampleCache ?? undefined);
    const readTo = end => (cost === null ? { bytes: 0, requests: 0, keptBytes: 0 } : cost(rowsOf(end, sample.cells)));
    let read = readTo(to);
    let ceiling = null;
    const subset = this._cellSubset;
    if (geneTime !== null && geneTime.ms > 0 && cost !== null && !(subset.kept === null && subset.prioritySeed == null)) {
      ceiling = await wholeSampleCost(this._fullRoot, subset.nObs, subset.prioritySeed == null ? null : { seed: subset.prioritySeed }, {
        link,
        targetMs: geneTime.ms,
        valuesOnDemand,
        decodedChunkBytes,
        expression: matrix.key,
        seedBytesPerMs: Math.max(this._hostLink?.downlinkBytesPerMs ?? 0, this._hostLink?.bytesPerMs ?? 0) || null,
        subsampleCache: this._subsampleCache ?? undefined,
      });
      if (!Number.isFinite(ceiling.bytes) && !Number.isFinite(ceiling.requests)) ceiling = null;
      const allowedBytes = ceiling === null ? Infinity : ceiling.bytes - geneTime.spentBytes;
      const allowedRequests = ceiling === null ? Infinity : ceiling.requests - (geneTime.spentRequests ?? 0);
      const within = priced => priced.bytes <= allowedBytes && priced.requests <= allowedRequests;
      if (!within(read)) {
        // The most cells whose read stays within it (bytes and requests grow with the cells).
        let low = sample.cells;
        let high = to - 1;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (within(readTo(mid))) low = mid;
          else high = mid - 1;
        }
        to = low;
        read = readTo(to);
      }
    }
    // The index of the cells past the sample holds their entries: their
    // rows' pointers are not read for a price (every open row's would be
    // the whole `indptr` of a file opened whole), so they are taken at the
    // sample's entries a row (a sample of the open cells: priority order).
    const { pointers } = await this._openRowsMatrix(matrix, sample.cells);
    const entriesPerCell = pointers === null || sample.cells === 0 ? 0 : pointers[sample.cells] / sample.cells;
    const indexBytesTo = end => columnIndexResidentBytes({
      layout: isGroup(matrix.node) ? 'sparse' : 'dense',
      nnz: Math.round((end - sample.cells) * entriesPerCell),
      nObs: end - sample.cells,
      nVars: matrix.sourceVars,
      valuesOnDemand: !this._readsAhead(),
      // The stored `data`: a view's own is made only once every open row's pointers are read.
      valuesBought: !this._readsAhead() && isGroup(matrix.node) && readInWholeChunks(matrix.node.storedData?.() ?? matrix.node.get('data')),
    });
    const residentBytes = indexBytesTo(to);
    const placed = await this.columnStoreFactory.plan(residentBytes);
    // The gene index of every cell asked for fits neither the memory nor
    // this site's storage (`refusal`): the most open cells whose index does
    // (`fits`, the sample's own count when no more do).
    let fits = to;
    if ((placed.refusal ?? null) !== null) {
      let low = sample.cells;
      let high = to - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (((await this.columnStoreFactory.plan(indexBytesTo(mid))).refusal ?? null) === null) low = mid;
        else high = mid - 1;
      }
      fits = low;
    }
    return {
      cells: sample.cells,
      target: to,
      bytes: read.bytes,
      keptBytes: read.keptBytes,
      requests: read.requests,
      ms: linkPriced(link) && read.bytes > 0 ? geneReadMs(read, link) : (read.bytes === 0 ? 0 : null),
      index: { residentBytes, placement: placed.kind, refusal: placed.refusal ?? null, fits },
      ceiling,
    };
  }

  /**
   * Read genes for the first `target` open cells (a person's "Read for all
   * cells"): the segments of `element` after the gene sample, doubling as
   * the first ones did (`prefix-column-index.js`), each built by reading
   * gene `gene` on it (its index pass reads the rows of its cells once; every
   * later gene reads the index). After each segment the sample is that much
   * larger (`onStep(sample, cells)`): what is built stays when `signal`
   * stops the rest. Every other matrix open in segments reads genes for the
   * same cells: its new segments are built when one of its genes is read.
   * Resolves to the gene sample now (null: every open cell's). A person's
   * count has no fit; one grown to fill the gene time (`topUp`, the page's
   * `DataState.topUpGeneSample`) keeps the fit that sized it, so the same
   * cells opened again after a share change take it again
   * (`_geneSamplesSeen`).
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} element
   * @param {number} target
   * @param {{signal?: AbortSignal|null, gene?: number, onStep?: ((sample: Object|null, cells: number) => void)|null, topUp?: boolean}} [options]
   * @returns {Promise<Readonly<{cells: number, of: number, fit: Object|null}>|null>}
   */
  async growGeneSample(element, target, { signal = null, gene = 0, onStep = null, topUp = false } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const sample = this.geneSample;
    if (sample === null) return null;
    const ready = this._readyGeneRows(element, { signal });
    if (ready !== null) {
      await ready;
      this._assertGeneration(generation, `reading ${element}`);
    }
    const matrix = this._requireMatrixElement(element);
    if (!this._indexedInSegments(matrix)) throw new Error(`Genes of ${matrix.label} are read for every open cell`);
    if (!Number.isSafeInteger(gene) || gene < 0 || gene >= matrix.nVars) throw new RangeError(`${matrix.label} has no gene column ${String(gene)}`);
    // Never past the rows the store holds (`held`): the reader worker reads
    // more of the matrix first (`matrixStream`).
    const to = Math.min(matrix.nRows, this.heldOpenCells(), Math.max(sample.cells, Math.floor(target)));
    if (to <= sample.cells) return sample;
    return this._track('genes', `${matrix.label} for ${formatCountOf(to, 'open cell')} (genes read for ${formatCountOf(sample.cells, 'cell')} so far)`, async readOptions => {
      const columns = await this._matrixColumns(matrix, generation, readOptions);
      let cells = columns.readRows();
      const added = await columns.growTo(to, readOptions);
      // Withdrawn (a gene asked for on the page stops a top-up's step): the
      // unbuilt segments go at once, before any read after it sees them, so
      // a gene read next never waits for their index passes.
      const withdraw = () => {
        if (this._generation === generation) columns.trimTo(cells);
      };
      const stopWithdrawing = onAbort(readOptions.signal, withdraw);
      try {
        for (const segment of added) {
          // Its index pass, stopped with the read when `signal` withdraws it.
          await segment.access.sparseColumn(matrix.start + gene, { signal: readOptions.signal ?? null });
          this._assertGeneration(generation, `reading ${matrix.label} for more cells`);
          cells = segment.start + segment.rows;
          await this._setGeneRows(cells, matrix.key, topUp ? sample.fit : null);
          onStep?.(this.geneSample, cells);
        }
      } catch (error) {
        withdraw();
        throw error;
      } finally {
        stopWithdrawing();
      }
      return this.geneSample;
    }, signal);
  }

  /**
   * How many open cells, from the first, have their matrix rows in the store:
   * every one, unless the store holds only rows `[0, held.rows)` (a matrix
   * read after its map: `open`'s `held`).
   *
   * @this {import('../reader.js').AnnDataReader}
   * @returns {number}
   */
  heldOpenCells() {
    this._ensureOpen();
    const subset = this._cellSubset;
    const nOpen = subset.kept === null ? subset.nObs : subset.kept.length;
    return this._held == null ? nOpen : heldPrefix(subset.fileRows ?? null, nOpen, this._held.rows);
  }

  /**
   * The store rows the first `count` open cells lie in, as a prefix: one
   * past the highest of their rows (`count` where open cell `i` is row `i`):
   * what a matrix read after its map keeps for them (`held`).
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {number} count
   * @returns {number}
   */
  rowsForOpenCells(count) {
    this._ensureOpen();
    const subset = this._cellSubset;
    const nOpen = subset.kept === null ? subset.nObs : subset.kept.length;
    return prefixEndRow(subset.fileRows ?? null, Math.max(0, Math.min(nOpen, Math.floor(count))));
  }

  /**
   * The store rows a matrix read after its map keeps for this opening
   * (`held`): those its first `fitCells` open cells lie in or, for a
   * progressive opening, those of the first `fitCells` cells it grows to
   * (`growth`), so the one pass over the matrix serves its every step
   * (`anndata-reader-worker.js` `ensureMatrixShare`). A pass keeps the
   * rows of its cells only, but reads the stream to the last of them --
   * nearly all of it for cells spread over the file -- whatever their
   * count, so a pass a step read the whole matrix again.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {number} fitCells - The share sized to this device (`shareFit`)
   * @returns {number}
   */
  shareRows(fitCells) {
    return Math.max(this.rowsForOpenCells(fitCells), this._grownShareRows ?? 0);
  }

  /**
   * Rows `[0, heldRows)` of the store hold their matrix rows: every row,
   * unless the store is a matrix read after its map (`open`'s `held`).
   *
   * @this {import('../reader.js').AnnDataReader}
   * @returns {number}
   */
  get heldRows() {
    this._ensureOpen();
    return this._held?.rows ?? this._cellSubset.nObs;
  }

  /**
   * The gene sample is now the first `cells` open cells (`growGeneSample`;
   * `fit` the one that sized it when the gene time grew it, null for a
   * person's count): every other matrix open in segments reads genes for
   * them too (its new segments built when one of its genes is read).
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  async _setGeneRows(cells, grown, fit = null) {
    const subset = this._cellSubset;
    const of = subset.genes?.of ?? this._nObs;
    this._cellSubset = { ...subset, genes: cells >= of ? null : Object.freeze({ cells, of, fit }) };
    for (const [element, state] of this._matrices) {
      if (element !== grown && typeof state.columns?.growTo === 'function') await state.columns.growTo(cells);
    }
  }
}
