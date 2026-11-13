/**
 * The reader's gene index of a cell-major matrix in segments
 * (`prefix-column-index.js`): the segments an earlier opening carried, the
 * rest built in doubling segments, in store order where the open rows lie
 * spread through the store, or as every stored row's index restricted to
 * them, and grown with the gene sample. Which rows a gene is read for is
 * `_geneRows`.
 *
 * A method group of `AnnDataReader` (`reader.js`), mixed onto its
 * prototype: `this` is the reader. It writes `_carried` (taking its
 * segments), `_restricted` and `_storeOrdered`.
 *
 * @module data/anndata/reader/gene-segments
 */

import { DecodedChunks } from '../decoded-chunks.js';
import { allocateTypedArray, copyTypedArray } from '../../sparse-column-index.js';
import { residencyBudgetBytes } from '../../memory-budget.js';
import { isArrayNode, isGroup } from '../../../formats/store.js';
import { child, elementBytes } from '../elements.js';
import {
  columnIndexResidentBytes,
  geneLayoutOf,
  geneReadCost,
  openMatrixColumns,
  readInWholeChunks,
  readsThroughRowIndex,
} from '../matrix-access.js';
import { gatheredArray, runsOfPositions } from '../views/cell-subset.js';
import { orderByKey, sortUint32 } from '../../../utils/radix-order.js';
import {
  entriesPerRow,
  fileOrderedAccess,
  firstSegmentRows,
  restrictedAccess,
  growthSegmentBounds,
  rowRangeMatrix,
  rowsInterleaved,
  segmentBounds,
  segmentedColumns,
  sharedBudgetFactory,
  wholeGeneIndexActivity,
  wholeIsCheaper,
} from '../prefix-column-index.js';
import { keptIndexPrefix } from '../kept-column-index.js';
import { geneIndexActivityLabel } from './matrices.js';

export class AnnDataReaderGeneSegmentMethods {
  /**
   * Gene columns of a cell-major matrix whose rows are in priority order,
   * indexed in segments (`prefix-column-index.js`): the segments an earlier
   * opening carried over (`_carried`), then new ones to the last row.
   * @this {import('../reader.js').AnnDataReader}
   */
  async _segmentedColumns(resolved, readOptions) {
    const { label, nRows, sourceVars, key: element } = resolved;
    // The rows a gene is read for: the gene sample's (`subsample-plan.js`,
    // `genes`), else every open row. Rows past them are not read, nor are
    // their row pointers: the segments are made of the rows read
    // (`_openRowsMatrix`), and of more of them as the sample grows.
    let readTo = this._geneRows(resolved);
    // The rows read as a matrix in open order, with their pointers: made
    // when a segment in open order needs it. Rows in store order never do
    // (a uniform share is millions of runs of one row in open order).
    let rowsRead = null;
    let openRead = null;
    const openRows = () => {
      openRead ??= this._openRowsMatrix(resolved, readTo, readOptions).then(read => (rowsRead = read));
      openRead.catch(() => { openRead = null; });
      return openRead;
    };
    const segments = [...(this._carried.get(element)?.segments ?? [])];
    this._carried.delete(element);
    // Each segment's store is placed with what the built ones before it left.
    const storeFactory = sharedBudgetFactory(this.columnStoreFactory, () => segments
      .filter(segment => segment.access.built?.() === true)
      .reduce((sum, segment) => sum + (segment.access.residentBytes?.() ?? 0), 0));
    let start = segments.length === 0 ? 0 : segments.at(-1).start + segments.at(-1).rows;
    // Runs of the rows after those an earlier opening carried over, kept in
    // this browser (a later visit, or another subsample of the same method
    // and seed); the rest is built in doubling segments, each kept as it is.
    const runs = await this._takeKeptRuns(resolved, () => openRows().then(read => read.pointers), readTo);
    let perRow = null;
    let first = null;
    // The open-order matrix and its first segment's rows, once a segment in open order is made.
    const inOpenOrder = async () => {
      await openRows();
      perRow ??= entriesPerRow(rowsRead.matrix, readTo);
      first ??= firstSegmentRows(readTo, perRow);
      return rowsRead;
    };
    // The segments in store order, by first row: what their passes read.
    const storeOrdered = new Map();
    // One activity for every unbuilt segment a gene waits for: the whole gene's bytes and time left.
    const layout = geneLayoutOf(resolved.node, { nObs: readTo, nVars: sourceVars, decodedChunkBytes: this._decodedChunkBytes });
    const valuesOnDemand = !this._readsAhead();
    const passBytes = async (matrix, rows) => {
      const cost = await geneReadCost(matrix, {
        format: this._format,
        label,
        nObs: rows,
        nVars: sourceVars,
        decodedChunkBytes: this._decodedChunkBytes,
        valuesOnDemand,
        retainIndicesBytes: residencyBudgetBytes('columnIndex'),
      });
      // What the pass fetches: none of what this browser keeps of the file.
      return (cost.scan?.fetchBytes ?? cost.scan?.storedBytes ?? 0) + (cost.index?.passes === 2 ? cost.index.secondPassStoredBytes ?? 0 : 0);
    };
    const onIndexStartAt = wholeGeneIndexActivity({
      nRows: () => readTo,
      create: () => this.createActivity?.({ kind: 'index', label: geneIndexActivityLabel(label, null, layout), background: true }) ?? null,
      createRescan: (_label, rescan) => this.createActivity?.({ kind: 'index', label: geneIndexActivityLabel(label, rescan, layout), background: false }) ?? null,
      bytesFrom: async row => {
        let bytes = 0;
        // A segment in store order is priced as it reads (pricing its rows in
        // open order would sort every row's run:
        // 23_decisions_partial_reading.md).
        const ordered = storeOrdered.get(row) ?? null;
        if (ordered !== null) {
          bytes += await passBytes(ordered.matrix, ordered.nObs ?? ordered.rows);
          row += ordered.rows;
        }
        if (row >= readTo) return bytes;
        const { matrix, pointers } = await inOpenOrder();
        return bytes + await passBytes(rowRangeMatrix(matrix, row, readTo, pointers), readTo - row);
      },
    });
    // A pass over the open rows' view (a subsample's: its rows gathered out
    // of the stored chunks) measures the view's work per entry too (`PassRates`).
    const noteViewPass = work => this._passRates.noteIndex(work, { overView: this._cellSubset?.fileRows != null });
    // Open rows `[segmentStart, end)` as a segment: from a kept run, or
    // built by a pass and kept as it is.
    const segmentOf = async (segmentStart, end, run) => {
      const { matrix, pointers } = rowsRead;
      const segment = rowRangeMatrix(matrix, segmentStart, end, pointers);
      const access = await openMatrixColumns(segment, {
        format: this._format,
        label,
        nObs: end - segmentStart,
        nVars: sourceVars,
        decodedChunkBytes: this._decodedChunkBytes,
        indexOptions: {
          ...this._indexOptions(),
          storeFactory,
          // Built by a pass (no run kept, or the kept run found damaged): kept.
          onBuilt: store => this._keepRun(resolved, segmentStart, end, store, { pointers }),
          onWork: noteViewPass,
          ...(run === null ? {} : { kept: run.kept }),
        },
        onIndexStart: onIndexStartAt(segmentStart, end - segmentStart),
        readOptions: { activity: readOptions.activity ?? null },
      });
      const residentBytes = columnIndexResidentBytes({
        layout: isGroup(matrix) ? 'sparse' : 'dense',
        nnz: pointers === null ? 0 : pointers[end] - pointers[segmentStart],
        nObs: end - segmentStart,
        nVars: sourceVars,
        valuesOnDemand: !this._readsAhead(),
        valuesBought: !this._readsAhead() && isGroup(matrix) && readInWholeChunks(matrix.storedData?.() ?? matrix.get('data')),
      });
      return { start: segmentStart, rows: end - segmentStart, access, residentBytes };
    };
    // Open rows `[segmentStart, end)` spread through the store (a uniform,
    // stratified or spatial share of a file in its own order:
    // `_inStoreOrder`), as one segment whose rows are in store order
    // (`fileOrderedAccess`): its pass reads and decodes each stored chunk
    // once, where segments in open order each read nearly every chunk
    // (measured: 23_decisions_partial_reading.md). From a kept run of the same rows in
    // store order, or built by a pass and kept as it is.
    const orderedSegmentOf = async (segmentStart, end, run, options = readOptions) => {
      const { order, matrix, pointers } = await this._takeStoreOrderMatrix(resolved, segmentStart, end, options);
      storeOrdered.set(segmentStart, { matrix, rows: end - segmentStart });
      const access = await openMatrixColumns(matrix, {
        format: this._format,
        label,
        nObs: end - segmentStart,
        nVars: sourceVars,
        decodedChunkBytes: this._decodedChunkBytes,
        indexOptions: {
          ...this._indexOptions(),
          storeFactory,
          onBuilt: store => this._keepRun(resolved, segmentStart, end, store, { pointers, order }),
          onWork: noteViewPass,
          ...(run === null ? {} : { kept: run.kept }),
        },
        onIndexStart: onIndexStartAt(segmentStart, end - segmentStart),
        readOptions: { activity: readOptions.activity ?? null },
      });
      const residentBytes = columnIndexResidentBytes({
        layout: pointers === null ? 'dense' : 'sparse',
        nnz: pointers === null ? 0 : pointers[end - segmentStart],
        nObs: end - segmentStart,
        nVars: sourceVars,
        valuesOnDemand: !this._readsAhead(),
        valuesBought: !this._readsAhead() && pointers !== null && readInWholeChunks(matrix.storedData?.() ?? matrix.get('data')),
      });
      return { start: segmentStart, rows: end - segmentStart, access: fileOrderedAccess(access, order, this._passRates.placing('own')), residentBytes };
    };
    // Open rows `[segmentStart, end)` (the rest of every open row, spread
    // through the store) as a segment of the index every cell builds, of
    // every stored row, restricted to them (`restrictedAccess`): chosen when
    // that is less work than their pass in store order (`_restrictsWhole`).
    // Its pass is every cell's, over the stored matrix as stored (the same
    // reads, the same decoded chunks). From that index kept in this browser
    // by any opening of every cell (or a share that built it), else built by
    // a pass and kept under every cell's rows, so either takes it over later.
    const restrictedSegmentOf = async (segmentStart, end) => {
      const stored = child(this._fullRoot, resolved.key);
      const nFile = this._cellSubset.nObs;
      storeOrdered.set(segmentStart, { matrix: stored, nObs: nFile, rows: end - segmentStart });
      const kept = await this._wholeKeptRun(resolved);
      const access = await openMatrixColumns(stored, {
        format: this._format,
        label,
        nObs: nFile,
        nVars: sourceVars,
        decodedChunkBytes: this._decodedChunkBytes,
        indexOptions: {
          ...this._indexOptions(),
          storeFactory,
          ...(kept === null
            ? { onBuilt: store => this._keepRun(resolved, 0, nFile, store, { pointers: store._rowPointers ?? null, everyCell: true }) }
            : { kept: kept.kept }),
        },
        onIndexStart: onIndexStartAt(segmentStart, end - segmentStart),
        readOptions: { activity: readOptions.activity ?? null },
      });
      const residentBytes = columnIndexResidentBytes({
        layout: isGroup(stored) ? 'sparse' : 'dense',
        nnz: isGroup(stored) ? stored.get('indices').shape[0] : 0,
        nObs: nFile,
        nVars: sourceVars,
        valuesOnDemand: !this._readsAhead(),
        valuesBought: !this._readsAhead() && isGroup(stored) && readInWholeChunks(stored.get('data')),
      });
      const fileRows = this._cellSubset.fileRows.subarray(segmentStart, end);
      const rows = this._cellSubset.rows;
      // Every stored row open in another order (a share raised back to every
      // cell in its order): its genes placed by the open rows' runs (a run
      // a block), where there are fewer runs than a gene's entries.
      const runs = rows.kept.length === rows.nOriginal ? () => rows.runs() : null;
      return { start: segmentStart, rows: end - segmentStart, access: restrictedAccess(access, fileRows, () => rows.positions(), segmentStart, runs, this._passRates.placing('whole')), residentBytes };
    };
    try {
      while (start < readTo) {
        let run = runs.find(item => item.start === start) ?? null;
        // A run kept past the rows a gene is read for is not taken: genes
        // are read for exactly the sample's cells.
        if (run !== null && start + run.rows > readTo) {
          runs.splice(runs.indexOf(run), 1);
          run.kept.release();
          run = null;
        }
        if (run !== null && run.storeOrder) {
          const segment = await orderedSegmentOf(start, start + run.rows, run);
          runs.splice(runs.indexOf(run), 1);
          segments.push(segment);
          start += run.rows;
          continue;
        }
        const next = runs.find(item => item.start > start);
        // The rows left, spread through the store: one segment, of every
        // stored row's index restricted to them, or in store order.
        if (run === null && next === undefined) {
          const restricts = await this._restrictsWhole(resolved, start);
          if (restricts || this._inStoreOrder(resolved, start, readTo)) {
            segments.push(await (restricts ? restrictedSegmentOf(start, readTo) : orderedSegmentOf(start, readTo, null)));
            start = readTo;
            continue;
          }
        }
        const rowsInOpenOrder = await inOpenOrder();
        let end = run === null ? segmentBounds(start, readTo, first)[0] : start + run.rows;
        if (run === null && next !== undefined) end = Math.min(end, next.start);
        // A segment whose genes are read as stored (a dense one in strips
        // the decoded-chunk budget holds) has no index: its run is let go.
        if (run !== null && !readsThroughRowIndex(rowRangeMatrix(rowsInOpenOrder.matrix, start, end, rowsInOpenOrder.pointers), { nObs: end - start, nVars: sourceVars, decodedChunkBytes: this._decodedChunkBytes })) {
          runs.splice(runs.indexOf(run), 1);
          run.kept.release();
          run = null;
        }
        const segment = await segmentOf(start, end, run);
        // Its index holds it now, and lets it go when it is disposed.
        if (run !== null) runs.splice(runs.indexOf(run), 1);
        segments.push(segment);
        start = end;
      }
    } finally {
      // Runs this opening did not use (they start inside rows carried over,
      // or the segments failed to open).
      for (const run of runs) run.kept.release();
    }
    // Unbuilt segments are built together when their indexes fit what the
    // budget leaves beside the built ones (`storeFactory.memoryBudgetBytes`).
    const together = unbuilt => unbuilt.reduce((sum, segment) => sum + (segment.residentBytes ?? Infinity), 0) <= storeFactory.memoryBudgetBytes;
    const columns = segmentedColumns({ nRows, segments, together });
    return {
      ...columns,
      /**
       * Read genes for the open rows up to `to` too (`growGeneSample`): the
       * segments after those there, unbuilt -- each from a run kept in this
       * browser where one starts (an earlier visit grew further: its rows
       * are not read again), the rest one in store order when the rows lie
       * spread through the store (`_inStoreOrder`), else doubling from them
       * (`growthSegmentBounds`); each is built when a gene is read on it.
       * Returns the new segments.
       */
      growTo: async (to, growOptions = {}) => {
        const end = Math.min(nRows, to);
        const from = columns.readRows();
        if (end <= from) return [];
        // The open rows' matrix to `end`, with their pointers (the added
        // rows' only: those before are held), once a segment in open order,
        // or the check of a kept run, needs it.
        let grown = null;
        const grownRows = async () => (grown ??= await this._openRowsMatrix(resolved, end, growOptions));
        // Runs kept past the rows read so far, within the growth (the
        // opening took those within the sample, `_takeKeptRuns`).
        const kept = [];
        for (const run of await this._takeKeptRuns(resolved, () => grownRows().then(read => read.pointers), end)) {
          if (run.start >= from && run.start + run.rows <= end) kept.push(run);
          else run.kept.release();
        }
        const added = [];
        let inOpenOrder = false;
        try {
          let at = from;
          while (at < end) {
            const run = kept.find(item => item.start === at) ?? null;
            if (run !== null) kept.splice(kept.indexOf(run), 1);
            // The rows up to the next kept run (or the end) when none starts here.
            const next = run !== null ? at + run.rows : Math.min(end, ...kept.filter(item => item.start > at).map(item => item.start));
            if (run?.storeOrder === true || (run === null && this._inStoreOrder(resolved, at, next))) {
              added.push(await orderedSegmentOf(at, next, run, growOptions));
            } else {
              rowsRead = await grownRows();
              inOpenOrder = true;
              perRow ??= entriesPerRow(rowsRead.matrix, end);
              if (run !== null) added.push(await segmentOf(at, next, run));
              else {
                let segmentStart = at;
                for (const bound of growthSegmentBounds(at, next, perRow)) {
                  added.push(await segmentOf(segmentStart, bound, null));
                  segmentStart = bound;
                }
              }
            }
            at = next;
          }
        } finally {
          // Runs no segment took (the growth failed before them).
          for (const run of kept) run.kept.release();
        }
        // The open-order matrix is made again for the rows read now, when a
        // segment needs it, unless this growth made it.
        rowsRead = inOpenOrder ? grown : null;
        openRead = inOpenOrder ? Promise.resolve(grown) : null;
        columns.extend(added);
        readTo = end;
        return added;
      },
      /** Read genes for the first `rows` open rows only: the unbuilt segments past them are let go (a growth stopped). */
      trimTo(rows) {
        columns.trimTo(rows);
        readTo = columns.readRows();
        for (const start of storeOrdered.keys()) if (start >= readTo) storeOrdered.delete(start);
      },
    };
  }

  /**
   * Whether the rows a gene of a matrix indexed in segments still reads --
   * open rows `[start, nRows)`, after the segments an earlier opening
   * carried over, every open row on (no gene sample) -- are read through
   * the index every cell builds, of every stored row, restricted to them
   * (`restrictedAccess`), instead of their own pass in store order
   * (`fileOrderedAccess`). Only for rows spread through the store
   * (`_inStoreOrder`), or every stored row open in another order (a share
   * raised back to every cell in its order), that no run kept in this
   * browser of these rows starts (a kept run is taken as it is; the
   * carried rows' runs end at `start`). Yes when every stored row's index
   * is kept here (an opening of every cell kept it: nothing is read but
   * genes; raised back to every cell, the rows past the share's were
   * indexed again by a pass of their own: 23_decisions_partial_reading.md);
   * else, for rows spread
   * through the store, when the whole reads no more stored bytes than the
   * rows (`_readsNoMoreThanRows`: they lie in every chunk) and is no more
   * work to index and to answer each gene once (`wholeIsCheaper`, at the
   * rates measured on this source: the index's, the view's and each path's
   * placement of a gene in open order). Unmeasured, a share of two thirds
   * of the entries or more: each gene would place every stored row's
   * entries, which costs more than the share's own pass (measured:
   * 23_decisions_partial_reading.md). A gene sample (fewer rows) grows, segment by
   * segment, and stays in store order. Decided once per opening and
   * matrix, by whichever asks first (`_readyGeneRows`, `_segmentedColumns`:
   * both from the same rows).
   * @this {import('../reader.js').AnnDataReader}
   */
  _restrictsWhole(resolved, start) {
    const key = resolved.key;
    let decided = this._restricted.get(key);
    if (decided === undefined) {
      decided = (async () => {
        const nRows = resolved.nRows;
        if (this._geneRows(resolved) < nRows || start >= nRows) return false;
        const stored = child(this._fullRoot, resolved.key);
        const nFile = this._cellSubset.nObs;
        // Every stored row open in another order (a share raised back to
        // every cell in its order): the rows past those carried are every
        // stored row's but the carried, whatever their order, and every
        // stored row's index kept here serves them with nothing read.
        const inStoreOrder = this._inStoreOrder(resolved, start, nRows);
        if (!inStoreOrder && nRows < nFile) return false;
        const kept = this._keptIndexes;
        // What this browser keeps, looked up while the rest is weighed.
        const where = kept === null ? null : { environment: kept.environment, tab: kept.tab };
        const keptPrefixes = where === null ? null : Promise.all([
          keptIndexPrefix(this._keptGroup(resolved), where),
          keptIndexPrefix(this._keptGroup(resolved, { everyCell: true }), where),
        ]);
        keptPrefixes?.catch(() => {});
        const allEntries = isGroup(stored) ? stored.get('indices').shape[0] : nFile * resolved.sourceVars;
        const cheaper = wholeIsCheaper({ keptEntries: allEntries * (nRows - start) / nFile, allEntries, rates: this._passRates });
        if (keptPrefixes !== null) {
          const [own, whole] = await keptPrefixes;
          // A run kept of these rows (past those carried) is taken as it is;
          // every stored row's kept reads nothing but genes.
          if (own.ends.some(end => end > start)) return false;
          if (whole.rows >= nFile) return true;
        }
        if (!inStoreOrder || !cheaper) return false;
        const rows = start === 0 && this._cellSubset.rows?.count === nRows
          ? this._cellSubset.rows.ascending().kept
          : sortUint32(copyTypedArray(Uint32Array, this._cellSubset.fileRows.subarray(start, nRows), 'File rows'));
        return this._readsNoMoreThanRows({ node: stored, rows, nRows: nFile, valuesOnDemand: !this._readsAhead() });
      })();
      decided.catch(() => this._restricted.delete(key));
      this._restricted.set(key, decided);
    }
    return decided;
  }

  /**
   * The rows a gene of a matrix indexed in segments still reads start at:
   * where the segments an earlier opening carried over end.
   * @this {import('../reader.js').AnnDataReader}
   */
  _restrictedStart(resolved) {
    const carried = this._carried.get(resolved.key)?.segments ?? [];
    return carried.length === 0 ? 0 : carried.at(-1).start + carried.at(-1).rows;
  }

  /**
   * Whether open rows `[start, end)` of a cell-major matrix (CSR, or dense
   * in row chunks) lie so spread through its stored chunks that segments in
   * open order would each read most of them (`rowsInterleaved`, against the
   * first segment doubling from `start` would make): they are then indexed
   * in store order (`_takeStoreOrderMatrix`). Not for a file in its own
   * order or a priority-ordered file's prefix (rows ascending), whole
   * blocks, a modality's matrix, a column window, a matrix not in chunks.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  _inStoreOrder(resolved, start, end) {
    const fileRows = this._cellSubset?.fileRows ?? null;
    if (fileRows === null || resolved.start !== 0 || resolved.throughCells || resolved.key.startsWith('mod/')) return false;
    let stored = this._fullRoot ?? null;
    for (const part of resolved.key.split('/')) stored = isGroup(stored) ? stored.get(part) ?? null : null;
    const nFile = this._cellSubset.nObs;
    // Stored rows a chunk holds, about, and stored values a row.
    let rowsPerChunk = null;
    let perRow = 0;
    if (isGroup(resolved.node) && isGroup(stored) && typeof this._root?.rowsMatrix === 'function') {
      const indices = stored.get('indices') ?? null;
      const nnz = indices?.shape?.[0] ?? 0;
      if (Array.isArray(indices?.chunks) && indices.partialChunks !== true && nnz > 0) {
        rowsPerChunk = nFile * Number(indices.chunks[0]) / nnz;
        perRow = nnz / nFile;
      }
    } else if (isArrayNode(resolved.node) && resolved.node.gather !== undefined && isArrayNode(stored) && stored.shape.length === 2) {
      if (Array.isArray(stored.chunks) && stored.partialChunks !== true) {
        rowsPerChunk = Number(stored.chunks[0]);
        perRow = stored.shape[1];
      }
    }
    if (rowsPerChunk === null) return false;
    const firstRows = segmentBounds(start, end, firstSegmentRows(end, perRow))[0] - start;
    return rowsInterleaved(fileRows.subarray(start, end), end - start, firstRows, rowsPerChunk, nFile);
  }

  /**
   * Open rows `[start, end)` of a cell-major matrix in store order:
   * `order`, the open row (from `start`) of each row in ascending file row
   * (a radix order of their file rows); `matrix`, those rows as a matrix of
   * their own (a CSR matrix's `rowsMatrix`, after their pointers; a dense
   * one's gathered rows); `pointers`, a CSR matrix's row pointers (null for
   * a dense one).
   * Made once for the check of a run kept in store order and the segment
   * that then uses it (`_takeStoreOrderMatrix`).
   * @this {import('../reader.js').AnnDataReader}
   */
  _storeOrderMatrix(resolved, start, end, readOptions = {}) {
    const key = `${resolved.key}\u0000${start}\u0000${end}`;
    let made = this._storeOrdered.get(key);
    if (made === undefined) {
      // The view's own work making them, measured (`PassRates`: `_restrictsWhole` weighs it).
      const meter = this._passRates.view;
      const timed = work => {
        const started = performance.now();
        try {
          return work();
        } finally {
          meter.note(performance.now() - started);
        }
      };
      made = (async () => {
        // Every open row (the whole first segment): the open rows' own file
        // order (`CellRows` `byRow`), made once, beside the rows ascending
        // their pointers were read for; no row list or runs of its own.
        const cellRows = this._cellSubset.rows ?? null;
        if (start === 0 && end === resolved.nRows && cellRows?.count === end) {
          if (isGroup(resolved.node)) {
            await this._root.readRowPointers(resolved.key, readOptions);
            const { order, matrix } = timed(() => this._root.fileOrderMatrix(resolved.key, { chunks: this._scanChunks(resolved) }));
            return { order, matrix, pointers: matrix.rowPointers() };
          }
          // A dense matrix's open rows are a gather of the stored array over
          // the open rows' runs: in file order, over the same rows' runs ascending.
          const inner = resolved.node.gather;
          if (inner !== undefined && inner.runs === cellRows.runs()) {
            const { order, rows } = timed(() => cellRows.byRow());
            return { order, matrix: gatheredArray(inner.source, timed(() => rows.runs()), { mergeGapBytes: inner.mergeGapBytes, chunks: inner.chunks, meter }), pointers: null };
          }
        }
        const { order, rows } = timed(() => {
          const ascending = orderByKey(this._cellSubset.fileRows.subarray(start, end));
          if (start === 0) return { order: ascending, rows: ascending };
          const shifted = allocateTypedArray(Uint32Array, ascending.length, 'Rows in store order');
          for (let i = 0; i < ascending.length; i++) shifted[i] = ascending[i] + start;
          return { order: ascending, rows: shifted };
        });
        // A dense matrix's rows: a gather of its open rows, one gather of the stored array.
        if (!isGroup(resolved.node)) return { order, matrix: gatheredArray(resolved.node, timed(() => runsOfPositions(rows)), { mergeGapBytes: () => this._mergeGapBytes(), meter }), pointers: null };
        await this._root.readRowPointers(resolved.key, { ...readOptions, rows });
        const matrix = timed(() => this._root.rowsMatrix(resolved.key, rows, { chunks: this._scanChunks(resolved) }));
        return { order, matrix, pointers: matrix.rowPointers() };
      })();
      this._storeOrdered.set(key, made);
      made.catch(() => this._storeOrdered.delete(key));
    }
    return made;
  }

  /**
   * The decoded chunks a pass in store order over a CSR matrix's rows reads
   * through (`_storeOrderMatrix`): the store's (`decoded-chunks.js`) when the
   * matrix's chunks, decoded, fit what they keep; else a window of two
   * chunks of `indices` and of `data`, the ones a slab's read shares with
   * the next. A pass reads each stored chunk once, in order, and a later
   * one (the gene sample grown) starts again from the first: chunks kept
   * by recency within a budget smaller than the pass are evicted before
   * the next pass reaches them, so keeping them buys nothing and only holds
   * memory (measured: 23_decisions_partial_reading.md).
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  _scanChunks(resolved) {
    const chunks = this._decodedChunks ?? null;
    const stored = this._fullRoot === null ? null : child(this._fullRoot, resolved.key);
    if (chunks === null || !isGroup(stored)) return chunks;
    const indices = stored.get('indices');
    const data = stored.get('data');
    const chunkElements = array => (Array.isArray(array?.chunks) && array.partialChunks !== true ? Number(array.chunks[0]) : null);
    const decoded = (indices.shape[0] ?? 0) * (elementBytes(indices) + elementBytes(data));
    if (decoded <= chunks.budgetBytes || chunkElements(indices) === null || chunkElements(data) === null) return chunks;
    return new DecodedChunks(2 * (chunkElements(indices) * elementBytes(indices) + chunkElements(data) * elementBytes(data)));
  }

  /**
   * `_storeOrderMatrix`, taken by the segment it is made for (no longer held by the reader).
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  async _takeStoreOrderMatrix(resolved, start, end, readOptions = {}) {
    const made = await this._storeOrderMatrix(resolved, start, end, readOptions);
    this._storeOrdered.delete(`${resolved.key}\u0000${start}\u0000${end}`);
    return made;
  }

  /**
   * How far the segments of a matrix indexed in segments are built: `done`,
   * the rows of the built prefix of segments (its own, or those an earlier
   * opening carried over); `next`, where the next segment ends (the cells the
   * next gene shows on first); `matrix` and `pointers`, the rows read as a
   * matrix in open order and a CSR matrix's row pointers (null when the rest
   * is in store order); `rest`, the rows still to index as the pass reads
   * them (`{matrix, rows}`: in store order when they lie spread through the
   * store, `_inStoreOrder`, one segment, so `next` is the last of them; the
   * stored matrix and its rows when that segment reads every stored row's
   * index, `_restrictsWhole`).
   * @this {import('../reader.js').AnnDataReader}
   */
  async _segmentProgress(resolved) {
    const { nRows, key: element } = resolved;
    // The rows a gene is read for (the gene sample's): nothing past them is read.
    const readTo = this._geneRows(resolved);
    const segments = this._matrices.get(element)?.columns?.segments ?? this._carried.get(element)?.segments ?? [];
    let done = 0;
    for (const segment of segments) {
      if (segment.start !== done || segment.access.built?.() !== true) break;
      done += segment.rows;
    }
    // The rows read as a matrix in open order, with their pointers only
    // (`_openRowsMatrix`): made when a kept run is checked or the rest is
    // read in open order. Rows in store order never need it (a uniform
    // share's open rows in open order are millions of runs of one row).
    let opened = null;
    const openRows = () => (opened ??= this._openRowsMatrix(resolved, readTo));
    let runs = [];
    if (this._matrices.get(element)?.columns == null) {
      // Not opened yet: the runs kept in this browser are built too (those
      // within the gene sample: `_segmentedColumns` takes no other).
      runs = await this._keptRunsOf(resolved, () => openRows().then(read => read.pointers), readTo);
      for (const run of runs) if (run.start === done && done + run.rows <= readTo) done += run.rows;
    }
    done = Math.min(done, readTo);
    const pending = segments.find(segment => segment.start === done);
    const following = runs.find(run => run.start > done);
    // The rest read through every stored row's index (`_restrictsWhole`):
    // its pass is every stored row's.
    if (pending === undefined && following === undefined && done < readTo && await this._restrictsWhole(resolved, done)) {
      return { done, next: readTo, pointers: null, matrix: null, readTo, rest: { matrix: child(this._fullRoot, resolved.key), rows: this._cellSubset.nObs } };
    }
    // Rows spread through the store are one segment in store order (`_segmentedColumns`).
    if (pending === undefined && following === undefined && done < readTo && this._inStoreOrder(resolved, done, readTo)) {
      const ordered = await this._storeOrderMatrix(resolved, done, readTo);
      return { done, next: readTo, pointers: null, matrix: null, readTo, rest: { matrix: ordered.matrix, rows: readTo - done } };
    }
    const { matrix, pointers } = await openRows();
    const next = pending !== undefined
      ? done + pending.rows
      : Math.min(segmentBounds(done, readTo, firstSegmentRows(readTo, entriesPerRow(matrix, Math.min(nRows, readTo))))[0] ?? readTo, following?.start ?? readTo);
    const rest = done === 0 && readTo === nRows ? resolved.node : rowRangeMatrix(matrix, done, readTo, pointers);
    return { done, next, pointers, matrix, readTo, rest: { matrix: rest, rows: readTo - done } };
  }

  /**
   * How many of a matrix's open rows a gene is read for: the gene sample's
   * cells (`subsample-plan.js`, `genes`: the first open cells in priority
   * order) for a matrix indexed in segments, else every row.
   * @this {import('../reader.js').AnnDataReader}
   */
  _geneRows(resolved) {
    const genes = this._cellSubset?.genes ?? null;
    return genes === null || !this._indexedInSegments(resolved) ? resolved.nRows : Math.min(resolved.nRows, genes.cells);
  }

  /**
   * Whether a matrix is read by gene through a row-major index (a CSR
   * matrix, or a dense one not stored in gene strips the decoded-chunk
   * budget holds: `openMatrixColumns`), and its rows are the open cells in
   * priority order: then it is indexed in segments.
   * @this {import('../reader.js').AnnDataReader}
   */
  _indexedInSegments(resolved) {
    if (this._cellSubset?.ordered !== true || resolved.throughCells || resolved.prefix !== null || resolved.cells !== null) return false;
    if (resolved.key.startsWith('mod/') || resolved.start !== 0) return false;
    // The layout as stored: the open cells' view of a CSR matrix has no
    // arrays until their row pointers are read (`readRowPointers`), and
    // whether genes are read through a row index does not depend on them.
    const stored = this._fullRoot === null ? null : child(this._fullRoot, resolved.key);
    return readsThroughRowIndex(stored ?? resolved.node, { nObs: resolved.nRows, nVars: resolved.sourceVars, decodedChunkBytes: this._decodedChunkBytes });
  }
}
