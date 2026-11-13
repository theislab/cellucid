/**
 * Neighbor-graph extraction: turns one stored adjacency matrix (`obsp`,
 * dense or CSR/CSC) into the `ConnectivityEdges` payload the reader worker
 * hands to the page -- the forward adjacency of the unique undirected edges
 * (each edge once, at its smaller cell) with each edge's drawing strength.
 * Which edges a pane shows, and in what order, is computed from it
 * (rendering/connectivity-edge-selection.js); a cell's whole neighbor list
 * (the k-NN tool's) is read from the file by row (`getConnectivityRows`).
 *
 * Gene-expression columns are read by `data/anndata/matrix-access.js`, not
 * here.
 *
 * @module data/connectivity-edges
 */

import { yieldToMacrotask } from '../utils/yield-macrotask.js';
import { allocateTypedArray, copyTypedArray } from './sparse-column-index.js';
import { memoryAllowanceBytes, setWorkingSet } from './memory-budget.js';
import { formatBytes, formatCountOf } from '../utils/format-units.js';

/**
 * Stored entries a graph's extraction walks between yields to the reader's
 * other work (a scheduling choice: about a millisecond of walking).
 */
const CONNECTIVITY_STEP_ENTRIES = 1 << 18;

/**
 * The edges of one neighbor graph as the reader worker hands them to the
 * page: everything the page needs, computed beside the matrix, so the page
 * neither walks nor checks the graph again. An edge is a unique undirected
 * pair `source < destination`; edge `e` is the e-th in source, then
 * destination order (the upper triangle in row order). 8 bytes an edge and 4
 * a cell (a k = 15 graph of 50M cells: 350M edges, 3.0 GB).
 *
 * - `forwardOffsets` (`nCells + 1`): cell `c`'s edges are `forwardOffsets[c]
 *   .. forwardOffsets[c + 1]` (its forward neighbors: the cells above it it
 *   is joined to).
 * - `partners` (at least `nEdges`): edge `e`'s destination, ascending within
 *   each cell's edges.
 * - `strengths` (at least `nEdges`): edge `e`'s `float32` relative strength
 *   `Math.fround(weight / maxWeight)` (WebGL2 attributes are single
 *   precision), the smallest normal float32 where that ratio underflows.
 *   Nothing in the app reads a graph's absolute weights, so they do not
 *   cross to the page; `maxWeight` does.
 * - `maxNeighbors`: the largest degree.
 *
 * `partners` and `strengths` are sized by the stored entries before the
 * walk (a symmetric graph has at most half of them as edges), so a graph
 * that stores its diagonal (Seurat's) or explicit zeros keeps their unused
 * share past `nEdges` (never written, so never resident); one with at most
 * half that many edges (a subsample's induced subgraph) is copied to its
 * exact size.
 *
 * @typedef {Object} ConnectivityEdges
 * @property {Uint32Array} forwardOffsets
 * @property {Uint32Array} partners
 * @property {Float32Array} strengths
 * @property {number} maxWeight
 * @property {number} nCells
 * @property {number} nEdges
 * @property {number} maxNeighbors
 */

/**
 * One stored weight, checked: a finite, non-negative number.
 *
 * @param {*} value
 * @param {string} label - Names the matrix in the refusal
 * @returns {number}
 */
function connectivityWeight(value, label) {
  if (typeof value !== 'number') {
    throw new TypeError(
      `${label} must contain only real numeric weights`
    );
  }
  if (!Number.isFinite(value)) {
    throw new Error('Connectivity weights must all be finite');
  }
  if (value < 0) {
    throw new Error('Connectivity weights must all be non-negative');
  }
  return value;
}

function connectivityAsymmetry() {
  return new Error('Connectivity matrix topology and weights must be exactly symmetric');
}

/** Edge positions are uint32 (the offsets are Uint32Array). */
function requireEdgeCount(count) {
  if (count > 0xffff_ffff) {
    throw new RangeError('Connectivity edges exceed the uint32 edge positions of the renderer');
  }
  return count;
}

/**
 * The smallest strength an edge is drawn with: the smallest normal float32.
 * An edge whose weight is so much smaller than the strongest one that its
 * ratio underflows float32 is still an edge, drawn as the faintest (a
 * subnormal could be flushed to zero by the GPU).
 */
const FAINTEST_STRENGTH = 2 ** -126;

/**
 * The edge list of one connectivity matrix as a reader returns it, or null
 * for an absent matrix: what `getConnectivityEdges(key)` of a direct reader
 * answers. The matrix is checked and walked by `extractConnectivityEdges`.
 *
 * @param {Object|null} conn - A reader's `getConnectivities(key)` result
 * @param {number} nCells
 * @returns {Promise<ConnectivityEdges|null>}
 */
export async function connectivityEdgesOf(conn, nCells) {
  if (conn === null) return null;
  if (!conn || typeof conn !== 'object' || Array.isArray(conn)) {
    throw new TypeError(
      'Connectivity loader must return an exact null absence or one matrix object'
    );
  }
  // The walk yields every `CONNECTIVITY_STEP_ENTRIES` entries, so a gene or
  // field read asked for meanwhile never waits for the whole graph.
  return drain(connectivityEdgeSteps(conn, nCells));
}

/** Run a generator of steps to its end, yielding to other work between steps. */
async function drain(steps) {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await yieldToMacrotask();
  }
}

/**
 * A graph read line by line, as a reader streams it (`anndata/graph-lines.js`):
 * `slabs` yields runs of consecutive lines (rows of a CSR matrix, columns
 * of a CSC one: a symmetric matrix is its own transpose) in order, each
 * `{start, end, pointers, indices, data}` with `pointers` (`end - start + 1`
 * entries) indexing that slab's own `indices` and `data`.
 *
 * `relabel` (`{positions, nCells, wholeBuildBytes}`), when given, says the lines are not the
 * cells' own order: line `i` (and an index `i`) is cell `positions[i]` of
 * `nCells` (distinct; a cell no line names has no edge). What a
 * subsample's induced subgraph is, read in the stored graph's order (its
 * open cells' rows in stored order, each column its row's rank among them:
 * lines ascending, as the edges are built fastest and checked exactly),
 * when the cells were opened in another order; and a MuData modality's
 * graph in its own rows. The edges are built over the lines, then placed on
 * the cells (`relabelledEdges`).
 *
 * @typedef {Object} ConnectivityLines
 * @property {number} nnz - Stored entries of the lines handed out, at most (the edges are sized by them)
 * @property {boolean} float32 - Whether its weights are float32 (else held as float64)
 * @property {{positions: Uint32Array, nCells: number, wholeBuildBytes?: number}|null} [relabel] -
 *   `wholeBuildBytes`: what every stored line's edges take to build (`connectivityEdgeBytes`), which
 *   placing these lines' edges on the cells holds no more than
 * @property {AsyncIterable<{start: number, end: number, pointers: ArrayLike<number>, indices: ArrayLike<number>, data: ArrayLike<number>}>} slabs
 */

/**
 * The edges of a graph read line by line (`ConnectivityLines`): what the
 * reader worker answers for `obsp[key]`. Only one slab of the stored graph
 * is held at a time, beside the edges being built: a 10M-cell graph's
 * stored arrays (about 2 GB) are never held whole. `run(work)` runs each
 * slab's walk (the reader runs it as foreground work). Lines in another
 * order than the cells' (`relabel`) are built in their own order, then
 * placed on the cells.
 *
 * @param {ConnectivityLines} lines
 * @param {number} nCells
 * @param {{run?: (work: () => Promise<any>) => Promise<any>}} [options]
 * @returns {Promise<ConnectivityEdges>}
 */
export async function connectivityEdgesFromLines(lines, nCells, { run = work => work() } = {}) {
  const relabel = lines.relabel ?? null;
  if (relabel !== null && relabel.nCells !== nCells) throw new Error('Connectivity lines are relabeled onto another count of cells');
  const builder = createEdgeBuilder(relabel === null ? nCells : relabel.positions.length, lines.nnz, lines.float32, { relabel });
  try {
    for await (const slab of lines.slabs) await run(() => drain(builder.add(slab)));
    const held = { edges: await run(() => drain(builder.finish())) };
    // The built edges are handed over, not kept here: placing them lets each array go as soon as it is read.
    return relabel === null ? held.edges : await run(() => drain(relabelledEdges(held, relabel.positions, relabel.nCells, relabel.wholeBuildBytes ?? 0)));
  } finally {
    builder.release();
  }
}

/**
 * Edges built over lines in another order than the cells' (`ConnectivityLines`
 * `relabel`) placed on the cells, exactly as built from the cells' own lines:
 * each edge between lines `r1 < r2` is the edge between cells
 * `positions[r1]` and `positions[r2]`, kept at the smaller with the same
 * strength; a cell's edges, counted as the lines arrived (`cellOffsets`,
 * `createEdgeBuilder` `relabel`), are numbered after every earlier cell's,
 * placed, and sorted by partner. The built edges are handed over in
 * `held.edges` (and dropped there). Each edge's strength and partner are
 * placed in one walk when the four edge arrays (the lines' and the cells')
 * held at once take no more than every stored line's edges take to build
 * (`wholeBuildBytes`, within the device's allowance), else in two: the
 * strengths placed, each partner made its cell in place as it is met, and
 * the built strengths let go, then the partners, so at most three of the
 * four are held (12 bytes an edge, and 4 a cell twice:
 * `connectivityEdgeBytes` `relabelCells`). Each walk a typed loop of its
 * own (`placeRelabelled`): a closure an edge, or a count after the last
 * line, would make a large share's edges cost more than every cell's
 * (measured: 24_decisions_graph_edges_at_scale.md).
 *
 * @param {{edges: ConnectivityEdges & {cellOffsets: Uint32Array}|null}} held
 * @param {Uint32Array} positions
 * @param {number} nCells
 * @param {number} wholeBuildBytes
 */
function* relabelledEdges(held, positions, nCells, wholeBuildBytes) {
  let { forwardOffsets: lineOffsets, partners: linePartners, strengths: lineStrengths } = held.edges;
  const { nEdges, maxWeight, maxNeighbors, cellOffsets: forwardOffsets } = held.edges;
  held.edges = null;
  const nLines = positions.length;
  for (let cell = 0; cell < nCells; cell++) forwardOffsets[cell + 1] += forwardOffsets[cell];
  // Each edge's place among the cells' edges, met in the same order once or twice.
  const together = lineOffsets.byteLength + linePartners.byteLength + lineStrengths.byteLength + 8 * nEdges + forwardOffsets.byteLength + 4 * nCells;
  const once = together <= wholeBuildBytes && together <= memoryAllowanceBytes();
  if (once) setWorkingSet('graph build', together);
  const strengths = allocateTypedArray(Float32Array, nEdges, 'Connectivity strengths');
  let partners = once ? allocateTypedArray(Uint32Array, nEdges, 'Connectivity edge partners') : null;
  let next = copyTypedArray(Uint32Array, forwardOffsets.subarray(0, nCells), 'Connectivity offsets');
  for (let line = 0; line < nLines;) {
    line = placeRelabelled(positions, lineOffsets, linePartners, next, lineStrengths, strengths, partners, line, nLines);
    yield;
  }
  lineStrengths = null;
  if (!once) {
    partners = allocateTypedArray(Uint32Array, nEdges, 'Connectivity edge partners');
    next = copyTypedArray(Uint32Array, forwardOffsets.subarray(0, nCells), 'Connectivity offsets');
    for (let line = 0; line < nLines;) {
      line = placeRelabelled(positions, lineOffsets, linePartners, next, null, partners, null, line, nLines);
      yield;
    }
  }
  next = null;
  linePartners = null;
  lineOffsets = null;
  // Each cell's edges by partner (partners are distinct within a cell).
  for (let cell = 0; cell < nCells; cell++) {
    sortEdges(partners, strengths, forwardOffsets[cell], forwardOffsets[cell + 1]);
    if ((cell & 0xffff) === 0xffff) yield;
  }
  return { forwardOffsets, partners, strengths, maxWeight, nCells, nEdges, maxNeighbors };
}

/**
 * Line `line`'s edges `[first, end)` (their partners lines) counted at
 * their smaller cell (`cellOffsets[cell + 1]`): a loop of its own.
 */
function countAtCells(positions, partners, cellOffsets, line, first, end) {
  const cell = positions[line];
  for (let edge = first; edge < end; edge++) {
    const other = positions[partners[edge]];
    cellOffsets[(cell < other ? cell : other) + 1]++;
  }
}

/**
 * Lines `[from, …)` of built edges placed at their smaller cell's next slot
 * (`next`), about `CONNECTIVITY_STEP_ENTRIES` edges at a time: with
 * `lineStrengths`, each strength into `out` and each partner made its cell
 * in place (`linePartners[edge] = positions[linePartners[edge]]`), and its
 * larger cell into `partners` too when given; without, partners already
 * cells, their larger cell into `out`. The line it stopped before.
 */
function placeRelabelled(positions, lineOffsets, linePartners, next, lineStrengths, out, partners, from, nLines) {
  const stop = lineOffsets[from] + CONNECTIVITY_STEP_ENTRIES;
  let line = from;
  if (lineStrengths === null) {
    for (; line < nLines && lineOffsets[line] < stop; line++) {
      const cell = positions[line];
      const end = lineOffsets[line + 1];
      for (let edge = lineOffsets[line]; edge < end; edge++) {
        const other = linePartners[edge];
        if (cell < other) out[next[cell]++] = other;
        else out[next[other]++] = cell;
      }
    }
    return line;
  }
  if (partners !== null) {
    for (; line < nLines && lineOffsets[line] < stop; line++) {
      const cell = positions[line];
      const end = lineOffsets[line + 1];
      for (let edge = lineOffsets[line]; edge < end; edge++) {
        const other = positions[linePartners[edge]];
        const at = cell < other ? next[cell]++ : next[other]++;
        partners[at] = cell < other ? other : cell;
        out[at] = lineStrengths[edge];
      }
    }
    return line;
  }
  for (; line < nLines && lineOffsets[line] < stop; line++) {
    const cell = positions[line];
    const end = lineOffsets[line + 1];
    for (let edge = lineOffsets[line]; edge < end; edge++) {
      const other = positions[linePartners[edge]];
      linePartners[edge] = other;
      out[cell < other ? next[cell]++ : next[other]++] = lineStrengths[edge];
    }
  }
  return line;
}

/** Order keys of `sortEdges` for long runs, grown as needed. */
let edgeKeys = new Float64Array(0);

/**
 * A cell's edges `[first, end)` sorted by partner (distinct), their
 * strengths with them, in place: by insertion when short, else by a typed
 * sort of keys `partner × 2^21 + offset` (exact below 2^53), the rest by
 * comparison.
 */
function sortEdges(partners, strengths, first, end) {
  const length = end - first;
  if (length > 32) {
    if (length >= 2 ** 21) {
      const order = Array.from({ length }, (_, i) => first + i).sort((x, y) => partners[x] - partners[y]);
      const p = order.map(at => partners[at]);
      const w = order.map(at => strengths[at]);
      partners.set(p, first);
      strengths.set(w, first);
      return;
    }
    if (edgeKeys.length < 2 * length) edgeKeys = allocateTypedArray(Float64Array, 2 * length, 'Connectivity edge order');
    const keys = edgeKeys.subarray(0, length);
    const moved = edgeKeys.subarray(length, 2 * length);
    for (let i = 0; i < length; i++) keys[i] = partners[first + i] * 2 ** 21 + i;
    keys.sort();
    for (let i = 0; i < length; i++) moved[i] = strengths[first + keys[i] % 2 ** 21];
    for (let i = 0; i < length; i++) {
      partners[first + i] = Math.floor(keys[i] / 2 ** 21);
      strengths[first + i] = moved[i];
    }
    return;
  }
  for (let i = first + 1; i < end; i++) {
    const partner = partners[i];
    if (partner > partners[i - 1]) continue;
    const strength = strengths[i];
    let j = i - 1;
    while (j >= first && partners[j] > partner) {
      partners[j + 1] = partners[j];
      strengths[j + 1] = strengths[j];
      j--;
    }
    partners[j + 1] = partner;
    strengths[j + 1] = strength;
  }
}

/**
 * Some cells' neighbors from the edges held (`ConnectivityEdges`), as the
 * reader answers them from the file (`AnnDataReader.getConnectivityRows`:
 * cell `cells[i]`'s at `neighbors[offsets[i] .. offsets[i + 1]]`, `cells`
 * distinct): the same neighbors (no self, no stored zero, open cells only),
 * ascending. Two passes over every edge, one bit a cell beside: what a large
 * k-NN frontier costs when the page holds the edges anyway (measured:
 * 24_decisions_graph_edges_at_scale.md). Yields between
 * steps of `CONNECTIVITY_STEP_ENTRIES` edges; `signal` stops it.
 *
 * @param {ConnectivityEdges} edges
 * @param {Uint32Array} cells
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Promise<{offsets: Uint32Array, neighbors: Uint32Array}>}
 */
export async function forwardEdgeRows(edges, cells, { signal = null } = {}) {
  const { forwardOffsets, partners, nCells } = edges;
  const asked = allocateTypedArray(Uint32Array, Math.ceil(nCells / 32), 'Connectivity rows');
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (!(cell < nCells) || (asked[cell >>> 5] & (1 << (cell & 31))) !== 0) {
      throw new RangeError('Connectivity rows are asked for distinct cells of the graph.');
    }
    asked[cell >>> 5] |= 1 << (cell & 31);
  }
  // Each asked cell's slot in the request: from a table of every cell (4
  // bytes a cell, while it runs) for a frontier of more than 1/64 of the
  // cells, else by a search of the cells sorted (a few hundred bytes a cell
  // asked at most either way).
  let slotOf;
  if (cells.length * 64 > nCells) {
    const slots = allocateTypedArray(Uint32Array, nCells, 'Connectivity row slots');
    for (let i = 0; i < cells.length; i++) slots[cells[i]] = i;
    slotOf = cell => slots[cell];
  } else {
    const order = Uint32Array.from(cells.keys()).sort((a, b) => cells[a] - cells[b]);
    const sorted = Uint32Array.from(order, i => cells[i]);
    slotOf = cell => {
      let low = 0;
      let high = sorted.length - 1;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (sorted[middle] < cell) low = middle + 1;
        else high = middle;
      }
      return order[low];
    };
  }
  const offsets = allocateTypedArray(Uint32Array, cells.length + 1, 'Connectivity row offsets');
  const pass = async fill => {
    const cursor = fill === null ? null : offsets.slice(0, cells.length);
    let walked = 0;
    for (let cell = 0; cell < nCells; cell++) {
      const first = forwardOffsets[cell];
      const end = forwardOffsets[cell + 1];
      const own = (asked[cell >>> 5] & (1 << (cell & 31))) !== 0 ? slotOf(cell) : -1;
      for (let edge = first; edge < end; edge++) {
        const partner = partners[edge];
        // An edge `cell < partner` is a neighbor of both, met in ascending order.
        if ((asked[partner >>> 5] & (1 << (partner & 31))) !== 0) {
          const slot = slotOf(partner);
          if (fill === null) offsets[slot + 1]++;
          else fill[cursor[slot]++] = cell;
        }
      }
      if (own >= 0) {
        if (fill === null) offsets[own + 1] += end - first;
        else for (let edge = first; edge < end; edge++) fill[cursor[own]++] = partners[edge];
      }
      walked += end - first + 1;
      if (walked >= CONNECTIVITY_STEP_ENTRIES) {
        walked = 0;
        signal?.throwIfAborted();
        await yieldToMacrotask();
      }
    }
  };
  await pass(null);
  for (let i = 0; i < cells.length; i++) offsets[i + 1] += offsets[i];
  const neighbors = allocateTypedArray(Uint32Array, offsets[cells.length], 'Connectivity row neighbors');
  await pass(neighbors);
  return { offsets, neighbors };
}

/**
 * A dense connectivity matrix's rows `[start, end)` (`values`, row-major,
 * `nCells` wide) as one slab of lines of their non-zero entries.
 *
 * @param {ArrayLike<number>} values
 * @param {number} start
 * @param {number} end
 * @param {number} nCells
 * @returns {{start: number, end: number, pointers: Float64Array, indices: Int32Array, data: Float32Array|Float64Array}}
 */
export function denseConnectivitySlab(values, start, end, nCells) {
  if (!values || values.length !== (end - start) * nCells) {
    throw new Error('Dense connectivity matrix must be square and cell-aligned');
  }
  const label = 'Dense connectivity matrix';
  let stored = 0;
  for (let index = 0; index < values.length; index++) {
    if (connectivityWeight(values[index], label) !== 0) stored++;
  }
  const pointers = allocateTypedArray(Float64Array, end - start + 1, 'Connectivity row pointers');
  const indices = allocateTypedArray(Int32Array, stored, 'Connectivity neighbors');
  const data = allocateTypedArray(values instanceof Float32Array ? Float32Array : Float64Array, stored, 'Connectivity weights');
  let at = 0;
  for (let row = 0; row < end - start; row++) {
    for (let column = 0; column < nCells; column++) {
      const weight = values[row * nCells + column];
      if (weight !== 0) {
        indices[at] = column;
        data[at] = weight;
        at++;
      }
    }
    pointers[row + 1] = at;
  }
  return { start, end, pointers, indices, data };
}

/** Whether a line's entries ascend (unsorted lines are allowed by scipy). */
function ascends(indices, from, to) {
  for (let j = from + 1; j < to; j++) if (indices[j] < indices[j - 1]) return false;
  return true;
}

/**
 * A sorter of lines into scratch arrays it keeps and grows (one per builder):
 * `sort(indices, data, from, to)` is the line's entries sorted by minor index
 * (stable), as `{indices, data}` at `[0, to - from)` of the scratch (indices as numbers,
 * each checked as it is walked; weights as they are): the input is never
 * changed. A short line is sorted by insertion; a longer one by a typed sort
 * of keys `index × 2^21 + position` (exact below 2^53: an index of a 32-bit
 * axis, a line of fewer than 2^21 entries), the rest by comparison. Lines
 * a file stores unsorted need it; a subsample's induced lines arrive with
 * each column its rank among the open rows in stored order
 * (`graph-lines.js` `inducedGraphLines`), so they stay ascending (renumbered
 * to open positions, nearly every line would arrive unsorted, and an array
 * and a comparator a line costs much of a large share's time; measured:
 * 24_decisions_graph_edges_at_scale.md).
 */
function lineSorter() {
  let lineIndices = new Float64Array(64);
  let lineData = new Float64Array(64);
  let keys = new Float64Array(0);
  const KEY_SCALE = 2 ** 21;
  return function sort(indices, data, from, to) {
    const length = to - from;
    if (lineIndices.length < length) {
      lineIndices = allocateTypedArray(Float64Array, 2 * length, 'Connectivity neighbors');
      lineData = allocateTypedArray(Float64Array, 2 * length, 'Connectivity weights');
    }
    // Weights a typed array cannot hold as a number (a plain array's
    // anything) are sorted in an array of their own, still checked as walked.
    const outData = ArrayBuffer.isView(data) && !(data instanceof BigInt64Array) && !(data instanceof BigUint64Array) ? lineData : new Array(length);
    if (length <= 32) {
      for (let i = 0; i < length; i++) {
        const index = Number(indices[from + i]);
        const weight = data[from + i];
        let j = i - 1;
        while (j >= 0 && lineIndices[j] > index) {
          lineIndices[j + 1] = lineIndices[j];
          outData[j + 1] = outData[j];
          j--;
        }
        lineIndices[j + 1] = index;
        outData[j + 1] = weight;
      }
    } else {
      let exact = length < KEY_SCALE;
      for (let i = 0; exact && i < length; i++) {
        const index = Number(indices[from + i]);
        exact = Number.isInteger(index) && index >= 0 && index < 2 ** 32;
      }
      if (exact) {
        if (keys.length < length) keys = allocateTypedArray(Float64Array, 2 * length, 'Connectivity line order');
        const view = keys.subarray(0, length);
        for (let i = 0; i < length; i++) view[i] = Number(indices[from + i]) * KEY_SCALE + i;
        view.sort();
        for (let i = 0; i < length; i++) {
          const at = view[i] % KEY_SCALE;
          lineIndices[i] = Number(indices[from + at]);
          outData[i] = data[from + at];
        }
      } else {
        const order = Array.from({ length }, (_, i) => from + i).sort((left, right) => indices[left] - indices[right]);
        order.forEach((at, i) => {
          lineIndices[i] = Number(indices[at]);
          outData[i] = data[at];
        });
      }
    }
    // The scratch itself, read at [0, length): a view a line would be garbage a line.
    return { indices: lineIndices, data: outData };
  };
}

/**
 * The bytes building and holding the edges of a graph of `nnz` stored
 * entries over `nCells` cells cost (`createEdgeBuilder`), sized as the
 * builder sizes its arrays (at most `nnz / 2` edges): `held`, what the page
 * keeps (`ConnectivityEdges`: forward offsets, each edge's partner and
 * strength); `build`, the reader's peak (those, the next due edge of each
 * cell, and, for float64 weights, the exact weights until the strongest is
 * known). A k = 15 graph of 50M cells (700M stored entries, 350M edges) of
 * float32 weights: 3.2 GB to build, 3.0 GB to hold.
 *
 * Lines in another order than the cells' (`relabelCells`: the cells they
 * are placed on, `relabelledEdges`) hold three of the four edge arrays (the
 * lines' and the cells') while they are placed, with offsets and a cursor a
 * cell (the offsets counted from the build on): the faster build (in the
 * lines' order, checked exactly as they arrive) for about 1.5 times the
 * edges' bytes while it runs, counted here.
 *
 * @param {{nCells: number, nnz: number, float32: boolean, relabelCells?: number|null}} graph
 * @returns {{edges: number, build: number, held: number}}
 */
export function connectivityEdgeBytes({ nCells, nnz, float32, relabelCells = null }) {
  const edges = Math.floor(nnz / 2);
  const offsets = 4 * (nCells + 1);
  const held = offsets + 8 * edges;
  // float32 weights become the strengths in place; float64 ones are held
  // whole beside the strengths they become.
  const build = held + 4 * nCells + (float32 ? 0 : 8 * edges);
  if (relabelCells === null) return { edges, build, held };
  // The cells' offsets are counted as the lines arrive (`createEdgeBuilder` `relabel`).
  const placed = 4 * (relabelCells + 1) + 8 * edges;
  return { edges, build: Math.max(build + 4 * (relabelCells + 1), offsets + 12 * edges + 8 * (relabelCells + 1)), held: placed };
}

/**
 * The edges of a graph built as its lines arrive, in order, in one walk
 * that checks every entry: bounds, ascending order without duplicates,
 * finite non-negative weights, exact symmetry of topology and weight.
 *
 * A symmetric matrix is its own transpose, so a row of CSR and a column of
 * CSC are the same line, read with the major axis as the source. As line
 * `major` arrives, the lines before it are known: its upper entries
 * (`minor > major`, its forward neighbors) are its edges, numbered after
 * every earlier line's (edge `e` is the e-th in source, then destination
 * order), each kept with its partner and exact weight; its lower entries
 * (`minor < major`) must each be the partner placed at the next edge of
 * line `minor`, met in ascending `major`. Once every line has arrived,
 * every edge must have met its partner, and each weight becomes its
 * strength relative to the strongest. A self-loop (a diagonal entry: Seurat
 * counts each cell among its own neighbors) is no edge anyone can draw,
 * and is left out as a stored zero is; symmetry is unaffected, a diagonal
 * entry being its own transpose.
 *
 * Graphs too large to keep the forward adjacency in memory (100M cells; not
 * built) keep this exact count
 * check and compare pairs and weights by a well-mixed keyed 128-bit hash of
 * (source, target, weight bits) summed order-independently in both directions
 * (a false pass has probability 2^-128).
 *
 * Capacities are the stored entries (`nnz`): a symmetric graph has at most
 * `nnz / 2` edges; more is asymmetry. While it builds, what it holds is part
 * of the working set (`memory-budget.js`, `'graph build'`): the caches of
 * every thread make room for it, and `release()` ends it.
 *
 * @param {number} nCells
 * @param {number} nnz
 * @param {boolean} float32 - Whether the weights are float32 (they are kept exactly)
 * @param {{relabel?: {positions: Uint32Array, nCells: number}|null}} [options] - The cells the
 *   lines are then placed on (`ConnectivityLines` `relabel`, `relabelledEdges`): the working
 *   set counts both, and each edge is counted at its smaller cell as its line arrives
 *   (`cellOffsets`), while the walk waits for the next slab, not after the last
 */
function createEdgeBuilder(nCells, nnz, float32, { relabel = null } = {}) {
  const relabelCells = relabel?.nCells ?? null;
  if (!Number.isSafeInteger(nCells) || nCells <= 0) {
    throw new Error('Connectivity cell count must be a positive safe integer');
  }
  if (!Number.isSafeInteger(nnz) || nnz < 0) throw new Error('Sparse connectivity storage has an invalid length');
  // Refused before any of it is allocated when the build cannot fit the
  // device's allowance (`memory-budget.js`): a partial build of gigabytes
  // only to fail at its last array, naming no size.
  const plan = connectivityEdgeBytes({ nCells, nnz, float32, relabelCells });
  const allowance = memoryAllowanceBytes();
  if (plan.build > allowance) {
    const refusal = new RangeError(
      `The neighbor graph's ${formatCountOf(plan.edges, 'edge')} need ${formatBytes(plan.build)} to build ` +
      `and ${formatBytes(plan.held)} to show, more than this device's ${formatBytes(allowance)} for Cellucid.`
    );
    refusal.code = 'TOO_LARGE';
    refusal.bytes = plan.build;
    throw refusal;
  }
  setWorkingSet('graph build', plan.build);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    setWorkingSet('graph build', 0);
  };
  let forwardOffsets;
  let placed;
  let partners;
  let weights;
  // Each cell's edges kept at it, counted (at `cell + 1`) as the lines arrive, when they are placed on other cells.
  let cellOffsets = null;
  const positions = relabel?.positions ?? null;
  const capacity = Math.floor(nnz / 2);
  try {
    if (relabel !== null) cellOffsets = allocateTypedArray(Uint32Array, relabelCells + 1, 'Connectivity offsets');
    forwardOffsets = allocateTypedArray(Uint32Array, nCells + 1, 'Connectivity offsets');
    // The next edge of each line whose partner (a later line's lower entry) is due.
    placed = allocateTypedArray(Uint32Array, nCells, 'Connectivity offsets');
    // Each edge's partner and exact weight: the partner stays (the forward
    // adjacency), the weight becomes its strength.
    partners = allocateTypedArray(Uint32Array, capacity, 'Connectivity edge partners');
    weights = allocateTypedArray(float32 ? Float32Array : Float64Array, capacity, 'Connectivity weights');
  } catch (error) {
    release();
    throw error;
  }
  const label = 'Sparse connectivity matrix';
  const sort = lineSorter();
  let next = 0;
  let maxWeight = 0;
  let maxNeighbors = 0;

  /** One slab of lines, `[start, end)`, walked in steps. */
  function* add({ start, end, pointers, indices, data }) {
    if (start !== next || !(end >= start) || end > nCells) {
      throw new Error('Connectivity lines must arrive once each, in order');
    }
    if (!pointers || pointers.length !== end - start + 1 || !indices || !data || indices.length !== data.length) {
      throw new Error('Sparse connectivity data and indices lengths differ');
    }
    const integral = indices instanceof Int32Array || indices instanceof Uint32Array ||
      indices instanceof Int16Array || indices instanceof Uint16Array ||
      indices instanceof Int8Array || indices instanceof Uint8Array;
    const typedWeights = ArrayBuffer.isView(data) && !(data instanceof BigInt64Array) && !(data instanceof BigUint64Array);
    let stepStart = 0;
    for (let major = start; major < end; major++) {
      let from = pointers[major - start];
      let to = pointers[major - start + 1];
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > indices.length) {
        throw new Error('Connectivity pointers must be monotonic safe integers within the sparse entry bounds');
      }
      if (to - stepStart >= CONNECTIVITY_STEP_ENTRIES) {
        stepStart = to;
        yield;
      }
      let lineIndices = indices;
      let lineData = data;
      let fast = integral && typedWeights;
      if (!ascends(indices, from, to)) {
        ({ indices: lineIndices, data: lineData } = sort(indices, data, from, to));
        to -= from;
        from = 0;
        fast = false;
      }
      const firstEdge = forwardOffsets[major];
      let degree = 0;
      let upper = 0;
      let previous = -1;
      for (let j = from; j < to; j++) {
        const minor = lineIndices[j];
        const weight = lineData[j];
        // One test for the common case: integer indices ascending within the
        // shape, typed finite non-negative weights.
        if (!(fast && minor > previous && minor < nCells && weight >= 0 && weight !== Infinity)) {
          if (!(minor >= 0 && minor < nCells) || !Number.isInteger(minor)) {
            throw new Error(`Connectivity index ${minor} is outside cell bounds`);
          }
          if (minor === previous) {
            throw new Error('Sparse connectivity matrix contains a duplicate coordinate');
          }
          connectivityWeight(weight, label);
        }
        previous = minor;
        if (weight === 0 || minor === major) continue;
        if (weight > maxWeight) maxWeight = weight;
        degree++;
        if (minor < major) {
          const edge = placed[minor]++;
          if (edge >= forwardOffsets[minor + 1] || partners[edge] !== major || weights[edge] !== weight) throw connectivityAsymmetry();
        } else {
          const edge = firstEdge + upper++;
          if (edge >= capacity) throw connectivityAsymmetry();
          partners[edge] = minor;
          weights[edge] = weight;
        }
      }
      forwardOffsets[major + 1] = firstEdge + upper;
      placed[major] = firstEdge;
      if (cellOffsets !== null && upper > 0) countAtCells(positions, partners, cellOffsets, major, firstEdge, firstEdge + upper);
      if (degree > maxNeighbors) maxNeighbors = degree;
    }
    next = end;
  }

  /** Every line arrived: check every edge met its partner, and turn each weight into its strength. */
  function* finish() {
    if (next !== nCells) throw new Error('Sparse connectivity matrix must be square and cell-aligned');
    for (let cell = 0; cell < nCells; cell++) {
      if (placed[cell] !== forwardOffsets[cell + 1]) throw connectivityAsymmetry();
    }
    placed = null;
    const edgeCount = requireEdgeCount(forwardOffsets[nCells]);
    yield;
    // float32 weights become their strengths in place; float64 ones are
    // read into a float32 array of their own, then let go.
    const strengths = float32 ? weights : allocateTypedArray(Float32Array, edgeCount, 'Connectivity strengths');
    for (let stepStart = 0; stepStart < edgeCount; stepStart += CONNECTIVITY_STEP_ENTRIES) {
      const stepEnd = Math.min(edgeCount, stepStart + CONNECTIVITY_STEP_ENTRIES);
      for (let edge = stepStart; edge < stepEnd; edge++) {
        const relative = Math.fround(weights[edge] / maxWeight);
        strengths[edge] = relative > 0 ? relative : FAINTEST_STRENGTH;
      }
      if (stepEnd < edgeCount) yield;
    }
    weights = null;
    // A graph with at most half the edges its stored entries allowed (a
    // subsample's induced subgraph, sized by the open cells' entries) is
    // copied to its exact size: the copy is no larger than the part never
    // written, which was never resident either.
    let shownPartners = partners;
    let shownStrengths = strengths;
    if (2 * edgeCount <= partners.length && edgeCount < partners.length) {
      yield;
      shownPartners = copyTypedArray(Uint32Array, partners.subarray(0, edgeCount), 'Connectivity edge partners');
      partners = null;
      if (shownStrengths.length !== edgeCount) {
        shownStrengths = copyTypedArray(Float32Array, strengths.subarray(0, edgeCount), 'Connectivity strengths');
      }
    }
    // Handed over whole: the builder keeps nothing of them (edges placed on
    // other cells, `relabelledEdges`, let each go as soon as it is read).
    const shownOffsets = forwardOffsets;
    forwardOffsets = null;
    partners = null;
    const counted = cellOffsets;
    cellOffsets = null;
    return {
      ...(counted === null ? {} : { cellOffsets: counted }),
      forwardOffsets: shownOffsets,
      partners: shownPartners,
      strengths: shownStrengths,
      maxWeight,
      nCells,
      nEdges: edgeCount,
      maxNeighbors,
    };
  }

  return { add, finish, release };
}

/**
 * Validate one connectivity matrix and construct its edges
 * (`ConnectivityEdges`) without mutating the matrix, in one synchronous walk
 * (`connectivityEdgesOf` is the yielding form).
 *
 * Values must be finite and non-negative, and the matrix exactly symmetric
 * in both topology and weight; the diagonal is left out (a self-loop is no
 * edge). A stored zero is no edge; a duplicate coordinate is corruption
 * rather than an instruction to sum or deduplicate scientific data.
 *
 * @param {Object} sparse - Dense, CSR, or CSC connectivity matrix
 * @param {number} nCells - Exact observation-axis length
 * @returns {ConnectivityEdges}
 */
export function extractConnectivityEdges(sparse, nCells) {
  const steps = connectivityEdgeSteps(sparse, nCells);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * The extraction of `extractConnectivityEdges` as steps: it yields between
 * runs of `CONNECTIVITY_STEP_ENTRIES` stored entries and returns the edges.
 * A matrix held whole is one slab of lines (`createEdgeBuilder`).
 */
function* connectivityEdgeSteps(sparse, nCells) {
  if (!Number.isSafeInteger(nCells) || nCells <= 0) {
    throw new Error('Connectivity cell count must be a positive safe integer');
  }
  if (sparse?.format === 'dense') {
    const { data, shape } = sparse;
    if (!Array.isArray(shape) || shape.length !== 2 || shape[0] !== nCells || shape[1] !== nCells) {
      throw new Error('Dense connectivity matrix must be square and cell-aligned');
    }
    const slab = denseConnectivitySlab(data, 0, nCells, nCells);
    return yield* builtFrom(createEdgeBuilder(nCells, slab.indices.length, slab.data instanceof Float32Array), slab);
  }
  const { indptr, indices, data, shape } = sparse ?? {};
  const format = sparse?.format;
  if (format !== 'csr' && format !== 'csc') {
    throw new Error(`Unsupported connectivity sparse format '${format}'`);
  }
  if (!Array.isArray(shape) ||
      shape.length !== 2 ||
      shape[0] !== nCells ||
      shape[1] !== nCells) {
    throw new Error('Sparse connectivity matrix must be square and cell-aligned');
  }
  if (!data) {
    throw new Error(
      'Sparse connectivity data is required; implicit values are not supported'
    );
  }
  if (!indices || !indptr ||
      !Number.isSafeInteger(indices.length) ||
      !Number.isSafeInteger(indptr.length) ||
      !Number.isSafeInteger(data.length)) {
    throw new Error('Sparse connectivity storage has an invalid length');
  }
  if (data.length !== indices.length) {
    throw new Error('Sparse connectivity data and indices lengths differ');
  }
  if (indptr.length !== nCells + 1) {
    throw new Error('Connectivity pointer array does not match its sparse format');
  }
  for (let index = 0; index < indptr.length; index++) {
    const pointer = indptr[index];
    if (!Number.isSafeInteger(pointer) ||
        pointer < 0 ||
        pointer > indices.length ||
        (index > 0 && pointer < indptr[index - 1])) {
      throw new Error(
        'Connectivity pointers must be monotonic safe integers within the sparse entry bounds'
      );
    }
  }
  if (indptr[0] !== 0 ||
      indptr[indptr.length - 1] !== indices.length) {
    throw new Error('Connectivity pointers must span every sparse entry');
  }
  return yield* builtFrom(
    createEdgeBuilder(nCells, indices.length, data instanceof Float32Array),
    { start: 0, end: nCells, pointers: indptr, indices, data },
  );
}

/** The edges of one slab of every line, the builder released however it ends. */
function* builtFrom(builder, slab) {
  try {
    yield* builder.add(slab);
    return yield* builder.finish();
  } finally {
    builder.release();
  }
}
