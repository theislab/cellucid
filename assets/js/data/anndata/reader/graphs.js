/**
 * The reader's neighbor graphs (`obsp`): whether one is there, its edges
 * among the open cells, its rows (k-NN rows), the whole graph, how much of
 * it a subsample keeps, and how each is read (`graph-lines.js` reads the
 * lines). Whether a matrix is read by its rows at all is
 * `_readsNoMoreThanRows`, which stays with the reader (the gene index uses
 * it too).
 *
 * A method group of `AnnDataReader` (`reader.js`), mixed onto its
 * prototype: `this` is the reader. It writes `_graphShares` and the
 * `connectivity:metadata:` entries of `_cache`.
 *
 * @module data/anndata/reader/graphs
 */

import { connectivityEdgesFromLines } from '../../connectivity-edges.js';
import { requireObspKey } from '../../data-mapping-candidates.js';
import { isAnnDataMatrixDataKind } from '../../anndata-value-kinds.js';
import { allocateTypedArray } from '../../sparse-column-index.js';
import { isGroup } from '../../../formats/store.js';
import { AnnDataFormatError, requireMapping, shapeOf, validateArrayEncoding, valueKind } from '../elements.js';
import { sparseContract } from '../sparse.js';
import {
  denseGraphLines,
  gatheredGraph,
  heldGraphLines,
  inducedGraphLines,
  placedGraphLines,
  readGraphRows,
  readInducedGraph,
  readPlacedGraphRows,
  sparseGraphLines,
} from '../graph-lines.js';
import { formatCountOf } from '../../../utils/format-units.js';

export class AnnDataReaderGraphMethods {
  /**
   * How much of a neighbor graph a subsample keeps, once the graph was
   * read (`readInducedGraph`): `{kept, of}`, its stored entries between two
   * open cells of those of the open cells (the others join an open cell to
   * one left out); null before it is read, or when every cell is open.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} key - The `obsp` key
   * @returns {{kept: number, of: number}|null}
   */
  subsampleGraphShare(key) {
    this._ensureOpen();
    return this._graphShares.get(key) ?? null;
  }

  /**
   * One neighbor graph's metadata (`obsp[key]`), checked without reading
   * it, or null when `obsp` has no such key.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  _connectivityMetadata(key) {
    this._ensureOpen();
    requireObspKey(key);
    const cacheKey = `connectivity:metadata:${key}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const format = this._format;
    let result = null;
    if (this._root.has('obsp')) {
      const obsp = requireMapping(this._root.get('obsp'), format, `${format.file} obsp mapping`);
      if (obsp.has(key)) {
        const conn = obsp.get(key);
        // A subsample's graphs are stored on every cell; their induced
        // subgraph is read (`readInducedGraph`).
        const nStored = this._cellSubset?.rows?.nOriginal ?? this._nObs;
        if (isGroup(conn)) {
          const sparse = sparseContract(conn, format, 'Connectivity matrix');
          if (sparse.shape[0] !== nStored || sparse.shape[1] !== nStored) {
            throw new AnnDataFormatError(`Connectivity matrix shape ${sparse.shape[0]}×${sparse.shape[1]} does not match ${formatCountOf(nStored, 'cell')}`);
          }
          result = { kind: 'sparse', node: conn };
        } else {
          validateArrayEncoding(conn, format, 'Dense connectivity matrix', 'array');
          const shape = shapeOf(conn, 'Dense connectivity matrix', 2);
          if (shape[0] !== nStored || shape[1] !== nStored) {
            throw new AnnDataFormatError(`Connectivity matrix shape ${shape[0]}×${shape[1]} does not match ${formatCountOf(nStored, 'cell')}`);
          }
          if (!isAnnDataMatrixDataKind(valueKind(conn))) throw new AnnDataFormatError('Dense connectivity matrix must use a numeric dtype');
          result = { kind: 'dense', node: conn, shape };
        }
      }
    }
    this._cache.set(cacheKey, result);
    return result;
  }

  /** Whether `obsp[key]` holds a neighbor graph. @this {import('../reader.js').AnnDataReader} */
  async hasConnectivities(key) {
    this._ensureOpen();
    await this._ready([`obsp/${requireObspKey(key)}`]);
    return this._connectivityMetadata(key) !== null;
  }

  /**
   * The edges of `obsp[key]`, checked and extracted here, beside the matrix
   * (in the reader worker), so the page never walks a large graph. The
   * graph is read line by line (`graph-lines.js`): one slab of it is held
   * at a time, beside the edges being built.
   * @this {import('../reader.js').AnnDataReader}
   */
  async getConnectivityEdges(key, { signal = null, keys = null } = {}) {
    this._ensureOpen();
    await this._ready([`obsp/${requireObspKey(key)}`], { signal });
    const metadata = this._connectivityMetadata(key);
    if (metadata === null) return null;
    return this._track('graph', `obsp['${key}']`, async readOptions => {
      const generation = this._generation;
      const lines = await this._connectivityLines(key, metadata, readOptions);
      const edges = await connectivityEdgesFromLines(lines, this._nObs, { run: work => this._inForeground(work) });
      this._assertGeneration(generation, 'loading connectivity data');
      return edges;
    }, signal, null, keys);
  }

  /**
   * The neighbors of some open cells in `obsp[key]` (`cells`, distinct
   * open cells), read from the file by row: what the k-NN tool expands
   * through, so no thread holds every cell's neighbor list. A subsample's
   * cells are read at their stored rows, keeping the neighbors it opened
   * (renumbered); a cell is never its own neighbor, and a stored zero is no
   * neighbor (as the edges, `connectivity-edges.js`). Null when the file
   * has no such matrix.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} key
   * @param {Uint32Array} cells
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<{offsets: Uint32Array, neighbors: Uint32Array}|null>}
   *   Cell `cells[i]`'s neighbors are `neighbors[offsets[i] .. offsets[i + 1]]`.
   */
  async getConnectivityRows(key, cells, { signal = null } = {}) {
    this._ensureOpen();
    await this._ready([`obsp/${requireObspKey(key)}`], { signal });
    if (!(cells instanceof Uint32Array)) throw new TypeError('Connectivity rows are asked for by a Uint32Array of open cells.');
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] >= this._nObs) throw new RangeError(`Cell ${cells[i]} is outside the ${formatCountOf(this._nObs, 'open cell')}.`);
    }
    const metadata = this._connectivityMetadata(key);
    if (metadata === null) return null;
    return this._track('graph', `obsp['${key}'] rows`, async readOptions => {
      const generation = this._generation;
      const subset = this._cellSubset?.rows ?? null;
      const nStored = subset?.nOriginal ?? this._nObs;
      // The stored rows, ascending, each with the request slot it answers.
      const stored = subset === null ? cells : Uint32Array.from(cells, cell => subset.kept[cell]);
      const order = Uint32Array.from(cells.keys()).sort((a, b) => stored[a] - stored[b]);
      const lines = Uint32Array.from(order, slot => stored[slot]);
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] === lines[i - 1]) throw new RangeError('Connectivity rows are asked for distinct cells.');
      }
      const rowOptions = { mergeGapBytes: () => this._mergeGapBytes(), readOptions, chunks: this._decodedChunks, inFlightEntries: this._graphReadAhead() };
      // The rows alone, or the whole graph streamed when that costs less
      // (a large frontier: `_graphReadPlan`); a MuData modality's graph
      // placed on the cells in its own rows.
      const read = typeof metadata.node.graphPlacement === 'function'
        ? await readPlacedGraphRows(metadata.node, lines, { ...rowOptions, choose: target => this._graphReadPlan(target) })
        : await readGraphRows(metadata.node, lines, nStored, {
          ...rowOptions,
          plan: metadata.kind === 'sparse' ? await this._graphReadPlan({ group: metadata.node, rows: lines, nRows: nStored }) : 'rows',
        });
      this._assertGeneration(generation, 'loading connectivity rows');
      const positions = subset === null ? null : subset.positions();
      // Each answer's neighbors, in request order.
      const counts = allocateTypedArray(Uint32Array, cells.length + 1, 'Connectivity row offsets');
      const kept = allocateTypedArray(Int32Array, read.indices.length, 'Connectivity row neighbors');
      for (let line = 0; line < lines.length; line++) {
        let count = 0;
        for (let entry = read.pointers[line]; entry < read.pointers[line + 1]; entry++) {
          const column = Number(read.indices[entry]);
          if (!(column >= 0 && column < nStored) || !Number.isInteger(column)) {
            throw new AnnDataFormatError(`Connectivity index ${String(read.indices[entry])} is outside axis bounds [0, ${nStored})`);
          }
          const neighbor = positions === null ? column : positions.get(column);
          kept[entry] = neighbor < 0 || column === lines[line] || Number(read.data[entry]) === 0 ? -1 : neighbor;
          if (kept[entry] >= 0) count++;
        }
        counts[order[line] + 1] = count;
      }
      for (let i = 0; i < cells.length; i++) counts[i + 1] += counts[i];
      const neighbors = allocateTypedArray(Uint32Array, counts[cells.length], 'Connectivity row neighbors');
      for (let line = 0; line < lines.length; line++) {
        let write = counts[order[line]];
        for (let entry = read.pointers[line]; entry < read.pointers[line + 1]; entry++) {
          if (kept[entry] >= 0) neighbors[write++] = kept[entry];
        }
      }
      return { offsets: counts, neighbors };
    }, signal);
  }

  /**
   * One neighbor graph, `obsp[key]`, as stored (a dense array, or its
   * sparse lines gathered), read whole: what a caller that wants the matrix
   * itself reads. Not cached: its edges are.
   * @this {import('../reader.js').AnnDataReader}
   */
  async getConnectivities(key, { signal = null } = {}) {
    this._ensureOpen();
    await this._ready([`obsp/${requireObspKey(key)}`], { signal });
    const metadata = this._connectivityMetadata(key);
    if (metadata === null) return null;
    return this._track('graph', `obsp['${key}']`, async readOptions => {
      const generation = this._generation;
      let result;
      if (this._cellSubset?.rows != null) {
        result = await this._inducedGraph(key, metadata, readOptions);
      } else if (metadata.kind === 'dense') {
        const [nRows, nCols] = metadata.shape;
        // Every row, every column: a two-dimensional read, not a row range of
        // a one-dimensional array.
        const data = await metadata.node.read([[0, nRows], [0, nCols]], readOptions);
        if (!data || data.length !== nRows * nCols) throw new AnnDataFormatError('Dense connectivity matrix payload length does not match its shape');
        result = { data, format: 'dense', shape: metadata.shape };
      } else {
        result = await gatheredGraph(await sparseGraphLines(metadata.node, this._format, 'Connectivity matrix', readOptions), 'Connectivity matrix');
      }
      this._assertGeneration(generation, 'loading connectivity data');
      return result;
    }, signal);
  }

  /**
   * The lines of `obsp[key]` as the open cells see it (`graph-lines.js`),
   * streamed: a subsample's induced subgraph a slab of open cells at a time
   * (a dense one, small by nature, held), else the stored graph.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  async _connectivityLines(key, metadata, readOptions) {
    const rows = this._cellSubset?.rows ?? null;
    if (rows !== null && metadata.kind === 'sparse') {
      return inducedGraphLines(metadata.node, rows, {
        mergeGapBytes: () => this._mergeGapBytes(),
        roundTripBytes: () => this._link?.roundTripBytes ?? 0,
        readOptions,
        chunks: this._decodedChunks,
        choose: target => this._graphReadPlan(target),
        onShare: share => this._graphShares.set(key, share),
        inFlightEntries: this._graphReadAhead(),
      });
    }
    if (rows !== null) return heldGraphLines(await this._inducedGraph(key, metadata, readOptions));
    // A MuData modality's graph placed on the cells, streamed in its own rows.
    if (typeof metadata.node.graphPlacement === 'function') return placedGraphLines(metadata.node, this._nObs, { readOptions });
    if (metadata.kind === 'dense') return denseGraphLines(metadata.node, metadata.shape[0], readOptions);
    return sparseGraphLines(metadata.node, this._format, 'Connectivity matrix', readOptions);
  }

  /**
   * Entries of a graph's slabs read ahead of the one built (`graph-lines.js`):
   * none past the next from a disk (or a link as fast), else what fills every
   * request the link runs at once (`_inFlightEntries`), within the decoded
   * chunks' share of memory (`decodedBlocks`, what slabs being decoded are):
   * a large atlas's graph over a web host with every request the link runs
   * filled holds gigabytes of slabs in flight (measured:
   * 24_decisions_graph_edges_at_scale.md).
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  _graphReadAhead() {
    if (this._readsAhead()) return 0;
    const decoded = this._decodedChunkBytes;
    return Math.min(this._inFlightEntries(), Math.floor(decoded / 8));
  }

  /**
   * How some rows of a stored graph are read (`graph-lines.js`
   * `GraphReadPlan`): the whole graph streamed when it reads no more than
   * the rows alone (`_readsNoMoreThanRows`, values included), else the
   * rows: where the rows lie in every chunk, the stream reads the same
   * bytes in fewer requests and walks its entries in order, where the rows
   * gather each open row's entries apart. `target`: `{group, rows, nRows}`,
   * the graph's group and the rows read (ascending) of its `nRows`.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  async _graphReadPlan({ group, rows, nRows }) {
    if (rows.length === 0 || !isGroup(group)) return 'rows';
    return await this._readsNoMoreThanRows({ node: group, rows, nRows, valuesOnDemand: false }) ? 'stream' : 'rows';
  }

  /**
   * A subsample's induced subgraph of `obsp[key]` (`readInducedGraph`), its share kept.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  async _inducedGraph(key, metadata, readOptions) {
    const generation = this._generation;
    const { share, ...graph } = await readInducedGraph(metadata.node, this._cellSubset.rows, {
      mergeGapBytes: () => this._mergeGapBytes(),
      roundTripBytes: () => this._link?.roundTripBytes ?? 0,
      readOptions,
      chunks: this._decodedChunks,
      choose: target => this._graphReadPlan(target),
      inFlightEntries: this._graphReadAhead(),
    });
    this._assertGeneration(generation, 'loading connectivity data');
    this._graphShares.set(key, share);
    return graph;
  }
}
