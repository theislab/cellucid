/**
 * Hierarchical clustering kernels: pairwise distances and agglomeration.
 *
 * The Genes panel clusters genes (and groups) of its heatmap matrix. Both
 * kernels run in the analysis workers (compute/operation-handlers.js); the
 * main thread only routes their typed arrays (genes-panel/clustering-engine.js).
 *
 * Distances. Each pair's distance is computed in double precision with the
 * per-item terms taken once per item instead of once per pair:
 * - correlation: `1 - r`, r the Pearson coefficient from centred moments
 *   (`pairedCentredMoments` order of summation), 1 when either item is
 *   constant, r clamped to [-1, 1];
 * - euclidean: square root of the summed squared differences;
 * - cosine: `1 - dot / (|a| |b|)`, 1 when either item is all zero.
 * Every sum runs over the features in order, so a pair's distance is the same
 * double whichever item range (and so whichever worker) computed it. The
 * distances of items `[rowFrom, rowTo)` to every later item form one block of
 * the condensed (upper-triangle, row-major) matrix, so the matrix is computed
 * in disjoint blocks on several workers and agglomerated from those blocks
 * without being copied together.
 *
 * Agglomeration. The exact agglomerative clustering: every step merges the
 * closest pair of clusters (the smallest distance; among equal distances the
 * pair (i, j), i < j, of smallest i, then smallest j, where a cluster is
 * numbered by its smallest member) and updates the merged cluster's distances
 * by the Lance-Williams rule of the linkage (average: size-weighted mean;
 * complete: maximum; single: minimum), in double precision. Instead of
 * searching all pairs (O(n^3)) or keeping every pair in a heap (O(n^2 log n)
 * time, about 100 bytes per pair), each cluster keeps its nearest later
 * cluster and is rescanned only when that neighbour merged away (Müllner's
 * generic algorithm, arXiv:1109.2378, section 3.1): the same merges in the
 * same order with the same values, in O(n^2) time on real data and the
 * condensed matrix as the only O(n^2) memory, 8 bytes per pair.
 *
 * @module compute/hierarchical-clustering
 */

/** @typedef {'correlation'|'euclidean'|'cosine'} DistanceMetric */
/** @typedef {'average'|'complete'|'single'} LinkageMethod */

export const DISTANCE_METRICS = Object.freeze(['correlation', 'euclidean', 'cosine']);
export const LINKAGE_METHODS = Object.freeze(['average', 'complete', 'single']);

/**
 * Bytes clustering `itemCount` items holds at its peak: the condensed
 * distance matrix, one double per pair. Everything else (the items' centred
 * values, per-item bookkeeping, the merge table) is linear in the item count.
 *
 * @param {number} itemCount
 * @returns {number}
 */
export function clusteringWorkingSetBytes(itemCount) {
  return 8 * ((itemCount * (itemCount - 1)) / 2);
}

/**
 * Number of condensed-matrix pairs owned by the items before `row`.
 * @param {number} n
 * @param {number} row
 * @returns {number}
 */
function pairsBefore(n, row) {
  return row * n - (row * (row + 1)) / 2;
}

/**
 * Split the items `[0, n - 1)` that own pairs into at most `parts` contiguous
 * ranges with about equal pair counts (row i owns n - 1 - i pairs).
 *
 * @param {number} n - Item count (≥ 2)
 * @param {number} parts - Wanted range count (≥ 1)
 * @returns {Array<[number, number]>} `[rowFrom, rowTo)` ranges covering 0 .. n - 1
 */
export function condensedRowRanges(n, parts) {
  if (!Number.isSafeInteger(n) || n < 2) {
    throw new RangeError('Condensed row ranges need at least two items');
  }
  if (!Number.isSafeInteger(parts) || parts < 1) {
    throw new RangeError('Condensed row range count must be a positive integer');
  }
  const total = pairsBefore(n, n - 1);
  const ranges = [];
  let from = 0;
  for (let part = 1; part <= parts && from < n - 1; part++) {
    let to = n - 1;
    if (part < parts) {
      const target = (total * part) / parts;
      to = from + 1;
      while (to < n - 1 && pairsBefore(n, to) < target) to++;
    }
    ranges.push([from, to]);
    from = to;
  }
  return ranges;
}

/**
 * The per-item terms of a metric: the values each pair sum reads (centred for
 * correlation) and each item's own sum of squares.
 *
 * @param {ArrayLike<number>} values - Row-major items × features, finite
 * @param {number} nItems
 * @param {number} nFeatures
 * @param {DistanceMetric} metric
 * @param {number} fromItem - First item needed
 */
function itemTerms(values, nItems, nFeatures, metric, fromItem) {
  const terms = new Float64Array((nItems - fromItem) * nFeatures);
  const squares = new Float64Array(nItems - fromItem);
  for (let item = fromItem; item < nItems; item++) {
    const source = item * nFeatures;
    const target = (item - fromItem) * nFeatures;
    if (metric === 'correlation') {
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (let k = 0; k < nFeatures; k++) {
        const x = values[source + k];
        sum += x;
        if (x < min) min = x;
        if (x > max) max = x;
      }
      // A constant item has no variance: r is 0 against every item.
      if (min === max) continue;
      const mean = sum / nFeatures;
      let sxx = 0;
      for (let k = 0; k < nFeatures; k++) {
        const dx = values[source + k] - mean;
        terms[target + k] = dx;
        sxx += dx * dx;
      }
      squares[item - fromItem] = sxx;
    } else {
      let sxx = 0;
      for (let k = 0; k < nFeatures; k++) {
        const x = values[source + k];
        terms[target + k] = x;
        sxx += x * x;
      }
      squares[item - fromItem] = sxx;
    }
  }
  return { terms, squares };
}

/**
 * Distance of a pair from its dot product and the items' sums of squares.
 * @param {DistanceMetric} metric
 * @param {number} dot
 * @param {number} squaresA
 * @param {number} squaresB
 * @returns {number}
 */
function distanceOfDot(metric, dot, squaresA, squaresB) {
  if (metric === 'correlation') {
    if (!(squaresA > 0) || !(squaresB > 0)) return 1;
    const r = dot / Math.sqrt(squaresA * squaresB);
    return 1 - Math.max(-1, Math.min(1, r));
  }
  const denominator = Math.sqrt(squaresA) * Math.sqrt(squaresB);
  if (denominator === 0) return 1;
  return 1 - dot / denominator;
}

/**
 * Validate the shared inputs of the distance kernel.
 */
function requireDistanceInputs(values, nItems, nFeatures, metric) {
  if (!ArrayBuffer.isView(values) || values instanceof DataView) {
    throw new TypeError('Clustering values must be a typed array');
  }
  if (!Number.isSafeInteger(nItems) || nItems < 2) {
    throw new RangeError('Clustering needs at least two items');
  }
  if (!Number.isSafeInteger(nFeatures) || nFeatures < 1) {
    throw new RangeError('Clustering items need at least one feature');
  }
  if (values.length !== nItems * nFeatures) {
    throw new RangeError('Clustering value count must equal items × features');
  }
  if (!DISTANCE_METRICS.includes(metric)) {
    throw new RangeError(`Unknown distance metric: ${String(metric)}`);
  }
}

/**
 * The condensed distances of items `[rowFrom, rowTo)` to every later item:
 * `(i, j)` for i in the range and j > i, row by row.
 *
 * @param {ArrayLike<number>} values - Row-major items × features, all finite
 * @param {number} nItems
 * @param {number} nFeatures
 * @param {DistanceMetric} metric
 * @param {number} rowFrom
 * @param {number} rowTo
 * @returns {Float64Array}
 */
export function pairwiseDistanceRows(values, nItems, nFeatures, metric, rowFrom, rowTo) {
  requireDistanceInputs(values, nItems, nFeatures, metric);
  if (
    !Number.isSafeInteger(rowFrom) || !Number.isSafeInteger(rowTo) ||
    rowFrom < 0 || rowFrom >= rowTo || rowTo > nItems - 1
  ) {
    throw new RangeError('Distance rows must be a non-empty range of the items that own pairs');
  }
  const m = nFeatures;
  const { terms: c, squares } = itemTerms(values, nItems, nFeatures, metric, rowFrom);
  const out = new Float64Array(pairsBefore(nItems, rowTo) - pairsBefore(nItems, rowFrom));
  const euclidean = metric === 'euclidean';
  let p = 0;
  for (let i = rowFrom; i < rowTo; i++) {
    const oi = (i - rowFrom) * m;
    const si = squares[i - rowFrom];
    let j = i + 1;
    // Four pairs at a time share each read of item i; each pair's sum still
    // runs over the features in order.
    for (; j + 3 < nItems; j += 4) {
      const o0 = (j - rowFrom) * m;
      const o1 = o0 + m;
      const o2 = o1 + m;
      const o3 = o2 + m;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      if (euclidean) {
        for (let k = 0; k < m; k++) {
          const x = c[oi + k];
          let d = x - c[o0 + k];
          s0 += d * d;
          d = x - c[o1 + k];
          s1 += d * d;
          d = x - c[o2 + k];
          s2 += d * d;
          d = x - c[o3 + k];
          s3 += d * d;
        }
        out[p++] = Math.sqrt(s0);
        out[p++] = Math.sqrt(s1);
        out[p++] = Math.sqrt(s2);
        out[p++] = Math.sqrt(s3);
      } else {
        for (let k = 0; k < m; k++) {
          const x = c[oi + k];
          s0 += x * c[o0 + k];
          s1 += x * c[o1 + k];
          s2 += x * c[o2 + k];
          s3 += x * c[o3 + k];
        }
        const base = j - rowFrom;
        out[p++] = distanceOfDot(metric, s0, si, squares[base]);
        out[p++] = distanceOfDot(metric, s1, si, squares[base + 1]);
        out[p++] = distanceOfDot(metric, s2, si, squares[base + 2]);
        out[p++] = distanceOfDot(metric, s3, si, squares[base + 3]);
      }
    }
    for (; j < nItems; j++) {
      const oj = (j - rowFrom) * m;
      let s = 0;
      if (euclidean) {
        for (let k = 0; k < m; k++) {
          const d = c[oi + k] - c[oj + k];
          s += d * d;
        }
        out[p++] = Math.sqrt(s);
      } else {
        for (let k = 0; k < m; k++) s += c[oi + k] * c[oj + k];
        out[p++] = distanceOfDot(metric, s, si, squares[j - rowFrom]);
      }
    }
  }
  return out;
}

/**
 * Agglomerate items from their condensed distance blocks.
 *
 * Merge `s` (0-based) joins the clusters with node ids `left[s]` and
 * `right[s]` at `height[s]` into node `n + s`; leaves are nodes 0 .. n - 1.
 * `left` is the cluster with the smaller smallest member. The blocks are
 * overwritten (they hold the running cluster distances).
 *
 * @param {Float64Array[]} blocks - `pairwiseDistanceRows` of `ranges`, in order
 * @param {Array<[number, number]>} ranges - `[rowFrom, rowTo)` of each block,
 *   contiguous from 0 to n - 1
 * @param {number} n - Item count
 * @param {LinkageMethod} linkage
 * @returns {{left: Int32Array, right: Int32Array, height: Float64Array}}
 */
export function agglomerate(blocks, ranges, n, linkage) {
  if (!Number.isSafeInteger(n) || n < 2) {
    throw new RangeError('Agglomeration needs at least two items');
  }
  if (!LINKAGE_METHODS.includes(linkage)) {
    throw new RangeError(`Unknown linkage method: ${String(linkage)}`);
  }
  if (!Array.isArray(blocks) || !Array.isArray(ranges) || blocks.length !== ranges.length) {
    throw new TypeError('Agglomeration needs one distance block per row range');
  }
  // Row k's distance to item m > k is rows[k][base[k] + m].
  const rows = new Array(n);
  const base = new Float64Array(n);
  let expectedFrom = 0;
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b];
    const range = ranges[b];
    if (!(block instanceof Float64Array) || !Array.isArray(range) || range.length !== 2) {
      throw new TypeError('Agglomeration blocks must be Float64Array with [rowFrom, rowTo) ranges');
    }
    const [from, to] = range;
    if (from !== expectedFrom || !(to > from) || to > n - 1) {
      throw new RangeError('Agglomeration row ranges must be contiguous from the first item');
    }
    if (block.length !== pairsBefore(n, to) - pairsBefore(n, from)) {
      throw new RangeError('Agglomeration block length does not match its row range');
    }
    const offset = pairsBefore(n, from);
    for (let k = from; k < to; k++) {
      rows[k] = block;
      base[k] = pairsBefore(n, k) - offset - k - 1;
    }
    expectedFrom = to;
  }
  if (expectedFrom !== n - 1) {
    throw new RangeError('Agglomeration row ranges must cover every item that owns pairs');
  }
  for (const block of blocks) {
    for (let index = 0; index < block.length; index++) {
      if (!Number.isFinite(block[index])) {
        throw new TypeError('Agglomeration distances must be finite');
      }
    }
  }

  const active = new Uint8Array(n).fill(1);
  const size = new Float64Array(n).fill(1);
  const node = new Int32Array(n);
  for (let k = 0; k < n; k++) node[k] = k;
  // nearest[k]: the smallest later active item at the smallest distance from k.
  const nearest = new Int32Array(n).fill(-1);
  const nearestDistance = new Float64Array(n).fill(Infinity);
  const rescan = k => {
    const row = rows[k];
    const b = base[k];
    let best = -1;
    let bestDistance = Infinity;
    // Merged-away items read +Infinity, so the scan is a plain minimum.
    for (let m = k + 1; m < n; m++) {
      const d = row[b + m];
      if (d < bestDistance) {
        bestDistance = d;
        best = m;
      }
    }
    nearest[k] = best;
    nearestDistance[k] = bestDistance;
  };
  for (let k = 0; k < n - 1; k++) rescan(k);

  const average = linkage === 'average';
  const single = linkage === 'single';
  const left = new Int32Array(n - 1);
  const right = new Int32Array(n - 1);
  const height = new Float64Array(n - 1);
  for (let step = 0; step < n - 1; step++) {
    let i = -1;
    let best = Infinity;
    for (let k = 0; k < n; k++) {
      const d = nearestDistance[k];
      if (d < best) {
        best = d;
        i = k;
      }
    }
    if (i < 0) {
      throw new Error('Agglomeration found no pair to merge');
    }
    const j = nearest[i];
    left[step] = node[i];
    right[step] = node[j];
    height[step] = best;

    const sizeI = size[i];
    const sizeJ = size[j];
    const merged = sizeI + sizeJ;
    active[j] = 0;
    nearest[j] = -1;
    nearestDistance[j] = Infinity;
    const rowI = rows[i];
    const baseI = base[i];
    const rowJ = rows[j];
    const baseJ = base[j];
    for (let k = 0; k < i; k++) {
      if (!active[k]) continue;
      const row = rows[k];
      const a = base[k] + i;
      const bj = base[k] + j;
      const x = row[a];
      const y = row[bj];
      const d = average
        ? (x * sizeI + y * sizeJ) / merged
        : single ? (x < y ? x : y) : (x > y ? x : y);
      row[a] = d;
      row[bj] = Infinity;
      const neighbour = nearest[k];
      if (neighbour === i || neighbour === j) {
        rescan(k);
      } else if (d < nearestDistance[k] || (d === nearestDistance[k] && i < neighbour)) {
        nearest[k] = i;
        nearestDistance[k] = d;
      }
    }
    for (let k = i + 1; k < j; k++) {
      if (!active[k]) continue;
      const a = baseI + k;
      const bj = base[k] + j;
      const x = rowI[a];
      const y = rows[k][bj];
      rowI[a] = average
        ? (x * sizeI + y * sizeJ) / merged
        : single ? (x < y ? x : y) : (x > y ? x : y);
      rows[k][bj] = Infinity;
      if (nearest[k] === j) rescan(k);
    }
    rowI[baseI + j] = Infinity;
    for (let k = j + 1; k < n; k++) {
      if (!active[k]) continue;
      const a = baseI + k;
      const x = rowI[a];
      const y = rowJ[baseJ + k];
      rowI[a] = average
        ? (x * sizeI + y * sizeJ) / merged
        : single ? (x < y ? x : y) : (x > y ? x : y);
    }
    size[i] = merged;
    node[i] = n + step;
    if (i < n - 1) rescan(i);
  }
  return { left, right, height };
}

/**
 * Leaves of a merge table in dendrogram order (left subtree first).
 *
 * @param {Int32Array} left
 * @param {Int32Array} right
 * @param {number} n - Leaf count
 * @returns {Int32Array}
 */
export function dendrogramLeafOrder(left, right, n) {
  const order = new Int32Array(n);
  if (n === 1) return order;
  let position = 0;
  const stack = [2 * n - 2];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id < n) {
      order[position++] = id;
    } else {
      stack.push(right[id - n], left[id - n]);
    }
  }
  if (position !== n) {
    throw new Error('Dendrogram leaf order is not a permutation of the leaves');
  }
  return order;
}
