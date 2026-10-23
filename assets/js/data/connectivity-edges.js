/**
 * Neighbour-graph extraction: turns one stored adjacency matrix (`obsp`,
 * dense or CSR/CSC) into the `ConnectivityEdges` payload the reader worker
 * hands to the page -- unique undirected edges in the renderer's draw order
 * plus every cell's neighbour list.
 *
 * Gene-expression columns are read by `data/anndata/matrix-access.js`, not
 * here.
 *
 * @module data/connectivity-edges
 */

import { yieldToMacrotask } from '../utils/yield-macrotask.js';
import { CONNECTIVITY_RECORD_WORDS, createConnectivityEdgeOrder } from '../rendering/connectivity-edge-selection.js';

/**
 * Stored entries a graph's extraction walks between yields to the reader's
 * other work (a scheduling choice: about a millisecond of walking).
 */
const CONNECTIVITY_STEP_ENTRIES = 1 << 18;

/**
 * The edges of one neighbour graph as the reader worker hands them to the
 * page: everything the page needs, computed beside the matrix, so the page
 * neither walks, checks nor orders the graph again. An edge is a unique
 * undirected pair `source < destination`; edge `e` is the e-th in source,
 * then destination order (the upper triangle in row order).
 *
 * - `records` (`3 * nEdges` words): the edges in the renderer's fixed random
 *   draw order (`createConnectivityEdgeOrder`,
 *   rendering/connectivity-edge-selection.js): record `r` is edge
 *   `order.at(r)` as its source, its destination and the bits of its
 *   `float32` relative strength `Math.fround(weight / maxWeight)` (WebGL2
 *   attributes are single precision). Nothing in the app reads a graph's
 *   absolute weights, so they do not cross to the page; `maxWeight` does.
 * - `neighborOffsets` (`nCells + 1`) and `neighbors` (`2 * nEdges`): every
 *   cell's neighbours, ascending, `neighbors[neighborOffsets[c] ..
 *   neighborOffsets[c + 1]]` -- the cells below `c` first, then its forward
 *   neighbours (the destinations of its edges).
 * - `forwardOffsets` (`nCells + 1`): cell `c`'s edges are `forwardOffsets[c]
 *   .. forwardOffsets[c + 1]`, so its forward neighbours are the last
 *   `forwardOffsets[c + 1] - forwardOffsets[c]` of its neighbours.
 * - `maxNeighbors`: the largest degree.
 *
 * @typedef {Object} ConnectivityEdges
 * @property {Uint32Array} records
 * @property {number} maxWeight
 * @property {Uint32Array} neighborOffsets
 * @property {Uint32Array} neighbors
 * @property {Uint32Array} forwardOffsets
 * @property {number} nCells
 * @property {number} nEdges
 * @property {number} maxNeighbors
 */

/**
 * Validate one exact direct-AnnData connectivity matrix and construct its
 * edges (`ConnectivityEdges`) without mutating the matrix.
 *
 * Values must be finite and non-negative, the diagonal must be zero, and the
 * matrix must be exactly symmetric in both topology and weight. A stored
 * zero is no edge; a duplicate coordinate is corruption rather than an
 * instruction to sum or deduplicate scientific data.
 *
 * @param {Object} sparse - Dense, CSR, or CSC connectivity matrix
 * @param {number} nCells - Exact observation-axis length
 * @returns {ConnectivityEdges}
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

/** Cumulative counts in place: `counts[c + 1]` held line c's count. */
function accumulateOffsets(offsets) {
  for (let index = 1; index < offsets.length; index++) offsets[index] += offsets[index - 1];
}

/**
 * The entries of every major line in ascending minor order: the arrays as
 * they are when every line is sorted already (as scipy and anndata write
 * them), else a copy with the unsorted lines sorted. The input is never
 * changed.
 */
function sortedLines(indptr, indices, data, majorAxis) {
  let copied = null;
  for (let major = 0; major < majorAxis; major++) {
    const start = indptr[major];
    const end = indptr[major + 1];
    let ordered = true;
    for (let j = start + 1; j < end; j++) {
      if (indices[j] < indices[j - 1]) {
        ordered = false;
        break;
      }
    }
    if (ordered) continue;
    copied ??= { indices: indices.slice(), data: data.slice() };
    const order = Array.from({ length: end - start }, (_, i) => start + i)
      .sort((left, right) => indices[left] - indices[right]);
    order.forEach((from, i) => {
      copied.indices[start + i] = indices[from];
      copied.data[start + i] = data[from];
    });
  }
  return copied ?? { indices, data };
}

/**
 * The edge list of one connectivity matrix as a reader returns it, or null
 * for an absent matrix: what `getConnectivityEdges(key)` of a direct reader
 * answers. The matrix is checked and walked by `extractConnectivityEdges`.
 *
 * @param {Object|null} conn - A reader's `getConnectivities(key)` result
 * @param {number} nCells
 * @returns {ConnectivityEdges|null}
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
  const steps = connectivityEdgeSteps(conn, nCells);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await yieldToMacrotask();
  }
}

/**
 * A dense connectivity matrix as CSR lines of its non-zero entries, every
 * value checked (a dense graph is small: it holds n^2 values).
 */
function denseConnectivityLines(sparse, nCells) {
  const { data, shape } = sparse;
  if (!Array.isArray(shape) ||
      shape.length !== 2 ||
      shape[0] !== nCells ||
      shape[1] !== nCells ||
      !data ||
      data.length !== nCells * nCells) {
    throw new Error('Dense connectivity matrix must be square and cell-aligned');
  }
  const label = 'Dense connectivity matrix';
  let stored = 0;
  for (let index = 0; index < data.length; index++) {
    if (connectivityWeight(data[index], label) !== 0) stored++;
  }
  const indptr = new Float64Array(nCells + 1);
  const indices = new Int32Array(stored);
  const values = data instanceof Float32Array ? new Float32Array(stored) : new Float64Array(stored);
  let at = 0;
  for (let row = 0; row < nCells; row++) {
    for (let column = 0; column < nCells; column++) {
      const weight = data[row * nCells + column];
      if (weight !== 0) {
        indices[at] = column;
        values[at] = weight;
        at++;
      }
    }
    indptr[row + 1] = at;
  }
  return { format: 'csr', shape: [nCells, nCells], indptr, indices, data: values };
}

/**
 * Pass 1 of a sparse graph's extraction: check every entry of every line
 * (bounds, ascending order without duplicates, a zero diagonal, finite
 * non-negative weights), count each line's non-zero upper entries into
 * `forwardOffsets[line + 1]` and lower entries into `lowerOffsets[line +
 * 1]`, and keep the entry its upper entries start at in `upperStarts[line]`.
 * Null when a line is stored unsorted (nothing else is wrong yet): the
 * caller sorts and counts again.
 *
 * @returns {{upperCount: number, lowerCount: number, maxWeight: number, maxNeighbors: number}|null}
 */
function* countConnectivityLines(indptr, lineIndices, lineData, majorAxis, nCells, forwardOffsets, lowerOffsets, upperStarts) {
  const integralIndices = lineIndices instanceof Int32Array || lineIndices instanceof Uint32Array ||
    lineIndices instanceof Int16Array || lineIndices instanceof Uint16Array ||
    lineIndices instanceof Int8Array || lineIndices instanceof Uint8Array;
  const fastWeights = ArrayBuffer.isView(lineData) &&
    !(lineData instanceof BigInt64Array) && !(lineData instanceof BigUint64Array);
  const label = 'Sparse connectivity matrix';
  const fast = integralIndices && fastWeights;
  let upperCount = 0;
  let lowerCount = 0;
  let maxWeight = 0;
  let maxNeighbors = 0;
  let stepStart = 0;
  for (let major = 0; major < majorAxis; major++) {
    const end = indptr[major + 1];
    if (end - stepStart >= CONNECTIVITY_STEP_ENTRIES) {
      stepStart = end;
      yield;
    }
    let previous = -1;
    let upper = 0;
    let lower = 0;
    let below = indptr[major];
    for (let j = below; j < end; j++) {
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
        if (minor < previous) return null;
        connectivityWeight(weight, label);
      }
      previous = minor;
      if (minor <= major) below = j + 1;
      if (weight !== 0) {
        if (minor > major) upper++;
        else if (minor < major) lower++;
        else throw new Error('Connectivity diagonal values must all be exactly zero');
        if (weight > maxWeight) maxWeight = weight;
      }
    }
    forwardOffsets[major + 1] = upper;
    lowerOffsets[major + 1] = lower;
    upperStarts[major] = below;
    upperCount += upper;
    lowerCount += lower;
    if (upper + lower > maxNeighbors) maxNeighbors = upper + lower;
  }
  return { upperCount, lowerCount, maxWeight, maxNeighbors };
}

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
 */
function* connectivityEdgeSteps(sparse, nCells) {
  if (!Number.isSafeInteger(nCells) || nCells <= 0) {
    throw new Error('Connectivity cell count must be a positive safe integer');
  }
  if (BigInt(nCells) * BigInt(nCells) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Connectivity dimensions exceed safe edge-key range');
  }
  const matrix = sparse?.format === 'dense' ? denseConnectivityLines(sparse, nCells) : sparse;
  const { indptr, indices, data, shape } = matrix ?? {};
  const format = matrix?.format;
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
      !Number.isSafeInteger(data.length) ||
      indices.length < 0 ||
      indptr.length < 0 ||
      data.length < 0) {
    throw new Error('Sparse connectivity storage has an invalid length');
  }
  if (data.length !== indices.length) {
    throw new Error('Sparse connectivity data and indices lengths differ');
  }

  const majorAxis = format === 'csr' ? shape[0] : shape[1];
  if (indptr.length !== majorAxis + 1) {
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

  // A symmetric matrix is its own transpose, so a row of CSR and a column of
  // CSC are the same line, read with the major axis as the source. Three
  // passes, two of them in storage order:
  //
  // 1. every entry is checked (bounds, order, diagonal, weight) and each
  //    line's non-zero upper entries (its forward neighbours) and lower
  //    entries (its other neighbours) are counted, and where its upper
  //    entries start is kept, so passes 2 and 3 walk only their half;
  // 2. a line's lower entries are its first neighbours, written in storage
  //    order, and each is placed where its partner belongs -- entry (c, r),
  //    r < c, at the next edge of row r, met in ascending c;
  // 3. a line's upper entries are its last neighbours; each must match the
  //    partner placed at its edge, topology and exact weight, and its record
  //    is written at the edge's rank in the draw order.
  //
  // Passes 2 and 3 each write one array out of order (the partners, the
  // records); nothing reads out of order (a partner looked up per entry is
  // a dependent cache miss per edge).
  const forwardOffsets = new Uint32Array(nCells + 1);
  const lowerOffsets = new Uint32Array(nCells + 1);
  // Where each line's upper entries start (its entries ascend).
  const upperStarts = new Float64Array(majorAxis);
  let lines = { indices, data };
  let counted = yield* countConnectivityLines(indptr, lines.indices, lines.data, majorAxis, nCells, forwardOffsets, lowerOffsets, upperStarts);
  if (counted === null) {
    // A line stored unsorted (scipy allows it): read a sorted copy instead.
    lines = sortedLines(indptr, indices, data, majorAxis);
    forwardOffsets.fill(0);
    lowerOffsets.fill(0);
    counted = yield* countConnectivityLines(indptr, lines.indices, lines.data, majorAxis, nCells, forwardOffsets, lowerOffsets, upperStarts);
  }
  const { upperCount, lowerCount, maxWeight, maxNeighbors } = counted;
  if (upperCount !== lowerCount) throw connectivityAsymmetry();
  const edgeCount = requireEdgeCount(upperCount);
  accumulateOffsets(forwardOffsets);
  accumulateOffsets(lowerOffsets);
  const neighborOffsets = new Uint32Array(nCells + 1);
  for (let cell = 0; cell <= nCells; cell++) neighborOffsets[cell] = forwardOffsets[cell] + lowerOffsets[cell];

  const lineIndices = lines.indices;
  const lineData = lines.data;
  const neighbors = new Uint32Array(2 * edgeCount);
  // Each edge's partner and exact weight, until pass 3 has matched them.
  const partners = new Uint32Array(edgeCount);
  const weights = lineData instanceof Float32Array ? new Float32Array(edgeCount) : new Float64Array(edgeCount);
  const placed = forwardOffsets.slice(0, nCells);
  let stepStart = 0;
  for (let major = 0; major < majorAxis; major++) {
    const end = indptr[major + 1];
    if (end - stepStart >= CONNECTIVITY_STEP_ENTRIES) {
      stepStart = end;
      yield;
    }
    let write = neighborOffsets[major];
    // A line's lower entries come first (its entries ascend).
    const lowerEnd = upperStarts[major];
    for (let j = indptr[major]; j < lowerEnd; j++) {
      const minor = lineIndices[j];
      const weight = lineData[j];
      if (weight === 0) continue;
      neighbors[write++] = minor;
      const edge = placed[minor]++;
      if (edge >= forwardOffsets[minor + 1]) throw connectivityAsymmetry();
      partners[edge] = major;
      weights[edge] = weight;
    }
  }
  const rankOf = createConnectivityEdgeOrder(edgeCount).rankOf;
  const records = new Uint32Array(edgeCount * CONNECTIVITY_RECORD_WORDS);
  const strengths = new Float32Array(records.buffer);
  stepStart = 0;
  for (let major = 0; major < majorAxis; major++) {
    const end = indptr[major + 1];
    if (end - stepStart >= CONNECTIVITY_STEP_ENTRIES) {
      stepStart = end;
      yield;
    }
    let edge = forwardOffsets[major];
    let write = neighborOffsets[major + 1] - (forwardOffsets[major + 1] - edge);
    for (let j = upperStarts[major]; j < end; j++) {
      const minor = lineIndices[j];
      const weight = lineData[j];
      if (weight === 0) continue;
      if (partners[edge] !== minor || weights[edge] !== weight) throw connectivityAsymmetry();
      const relative = Math.fround(weight / maxWeight);
      if (!(relative > 0)) {
        throw new Error('Connectivity weight range exceeds WebGL2 Float32 rendering precision.');
      }
      neighbors[write++] = minor;
      const at = rankOf(edge) * CONNECTIVITY_RECORD_WORDS;
      records[at] = major;
      records[at + 1] = minor;
      strengths[at + 2] = relative;
      edge++;
    }
  }
  // Every edge was a lower entry's (pass 2) and matched an upper one (above).
  return {
    records,
    maxWeight,
    neighborOffsets,
    neighbors,
    forwardOffsets,
    nCells,
    nEdges: edgeCount,
    maxNeighbors,
  };
}
