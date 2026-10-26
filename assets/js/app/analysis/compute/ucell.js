/**
 * @fileoverview UCell scores (Andreatta & Carmona 2021) over a range of
 * cells, from one pass over every gene.
 *
 * In each cell every gene is ranked by its value, highest first, ties given
 * their average rank (`rank = greater + (equal + 1) / 2`, `equal` counting
 * the gene itself). A set gene ranked past `maxRank` counts as
 * `maxRank + 1`, and a set of S genes scores
 * `1 − (Σ rank − S(S+1)/2) / (S · maxRank)`.
 *
 * A worker holds a contiguous range of cells: each cell's set-gene values,
 * sorted, and two difference arrays over the S + 1 gaps between them. Every
 * gene's non-zero entries in the range then cost one binary search each:
 * an entry `v` with `a` set values below it and `b` at or below it is
 * greater than the set values `0 … a−1` and equal to `a … b−1`. Genes not
 * stored in a cell are zeros, added in one step at the end. A cell holds
 * 2(S + 1) signed 32-bit counters: 168 bytes for a 20-gene union.
 *
 * @module compute/ucell
 */

/**
 * Each cell's value of each set gene, cell-major (`cell * S + s`), from the
 * set genes' entries in the range: zero where a gene stores none.
 *
 * @param {number} cellCount - Cells in the range
 * @param {number} S - The distinct set genes
 * @param {Array<{slots: ArrayLike<number>, ranges: {pointers: Uint32Array, cells: Uint32Array, values: Float32Array}}>} parts -
 *   Gene `j` of a part's entries (`data/gene-delivery.js` `ranges`, cells
 *   counted from the range's start) is set gene `slots[j]`
 * @returns {Float32Array}
 */
export function ucellSetValues(cellCount, S, parts) {
  const setValues = new Float32Array(cellCount * S);
  for (const { slots, ranges } of parts) {
    const { pointers, cells, values } = ranges;
    if (pointers.length - 1 !== slots.length) {
      throw new RangeError('UCell set gene entries must name one set slot per gene');
    }
    for (let gene = 0; gene < slots.length; gene++) {
      const slot = slots[gene];
      if (!Number.isSafeInteger(slot) || slot < 0 || slot >= S) throw new RangeError('UCell set slot outside the set genes');
      for (let k = pointers[gene]; k < pointers[gene + 1]; k++) {
        const cell = cells[k];
        if (cell >= cellCount) throw new RangeError('UCell entry outside the cell range');
        setValues[cell * S + slot] = values[k];
      }
    }
  }
  return setValues;
}

/**
 * @param {object} options
 * @param {number} options.cellCount - Cells in the range
 * @param {Float32Array} options.setValues - Each cell's value of each set
 *   gene, cell-major (`cell * S + s`)
 * @param {number} options.setGeneCount - S, the distinct genes of every set
 * @param {number} options.geneCount - Genes in the dataset
 * @param {number[][]} options.sets - Each set's genes, as indices into S
 * @param {number} options.maxRank
 */
export function createUcellContext({ cellCount, setValues, setGeneCount, geneCount, sets, maxRank }) {
  const S = setGeneCount;
  if (!(setValues instanceof Float32Array) || setValues.length !== cellCount * S) {
    throw new TypeError('UCell set values must be a Float32Array of cells × set genes');
  }
  // Each cell's set values ascending, and where each set gene landed.
  const sorted = new Float32Array(cellCount * S);
  const slotOf = new Uint16Array(cellCount * S);
  const order = new Array(S);
  for (let c = 0; c < cellCount; c++) {
    const base = c * S;
    for (let s = 0; s < S; s++) order[s] = s;
    order.sort((x, y) => setValues[base + x] - setValues[base + y] || x - y);
    for (let k = 0; k < S; k++) {
      sorted[base + k] = setValues[base + order[k]];
      slotOf[base + order[k]] = k;
    }
  }
  return {
    cellCount,
    S,
    geneCount,
    sets,
    maxRank,
    sorted,
    slotOf,
    setValues,
    greaterDiff: new Int32Array(cellCount * (S + 1)),
    equalDiff: new Int32Array(cellCount * (S + 1)),
    stored: new Uint32Array(cellCount),
  };
}

/** How many of the S ascending values at `base` are below `v` (`strict`) or at most `v`. */
function bound(sorted, base, S, v, strict) {
  let lo = 0;
  let hi = S;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const u = sorted[base + mid];
    if (strict ? u < v : u <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Count one or more genes' stored entries of the range.
 *
 * @param {ReturnType<typeof createUcellContext>} context
 * @param {{pointers: Uint32Array, cells: Uint32Array, values: Float32Array}} genes -
 *   Gene `g`'s entries are `[pointers[g], pointers[g + 1])`; `cells` are
 *   positions within the range
 */
export function ucellAddGenes(context, { pointers, cells, values }) {
  const { S, sorted, greaterDiff, equalDiff, stored, cellCount } = context;
  const width = S + 1;
  const last = pointers[pointers.length - 1];
  for (let e = 0; e < last; e++) {
    const c = cells[e];
    if (c >= cellCount) throw new RangeError('UCell entry outside the cell range');
    const v = values[e];
    stored[c]++;
    if (!Number.isFinite(v)) continue;
    const base = c * S;
    const a = bound(sorted, base, S, v, true);
    const b = a === S || sorted[base + a] !== v ? a : bound(sorted, base, S, v, false);
    const row = c * width;
    if (a > 0) {
      greaterDiff[row]++;
      greaterDiff[row + a]--;
    }
    if (b > a) {
      equalDiff[row + a]++;
      equalDiff[row + b]--;
    }
  }
}

/**
 * The scores of every set for every cell of the range, once every gene was
 * added.
 *
 * @param {ReturnType<typeof createUcellContext>} context
 * @returns {Float32Array} cell-major (`cell * sets + k`)
 */
export function ucellFinish(context) {
  const { S, sorted, slotOf, greaterDiff, equalDiff, stored, cellCount, geneCount, sets, maxRank, setValues } = context;
  const width = S + 1;
  const scores = new Float32Array(cellCount * sets.length);
  const greater = new Float64Array(S);
  const equal = new Float64Array(S);
  for (let c = 0; c < cellCount; c++) {
    const base = c * S;
    const row = c * width;
    // Genes not stored in this cell are zeros.
    const zeros = geneCount - stored[c];
    const a0 = bound(sorted, base, S, 0, true);
    const b0 = bound(sorted, base, S, 0, false);
    let runningGreater = 0;
    let runningEqual = 0;
    for (let k = 0; k < S; k++) {
      runningGreater += greaterDiff[row + k] + (k < a0 ? zeros : 0);
      runningEqual += equalDiff[row + k];
      greater[k] = runningGreater;
      equal[k] = runningEqual + (k >= a0 && k < b0 ? zeros : 0);
    }
    for (let set = 0; set < sets.length; set++) {
      const members = sets[set];
      let rankSum = 0;
      let missing = false;
      for (const s of members) {
        if (!Number.isFinite(setValues[base + s])) {
          missing = true;
          break;
        }
        const k = slotOf[base + s];
        let rank = greater[k] + (equal[k] + 1) / 2;
        if (rank > maxRank) rank = maxRank + 1;
        rankSum += rank;
      }
      const size = members.length;
      scores[c * sets.length + set] = missing
        ? NaN
        : 1 - (rankSum - (size * (size + 1)) / 2) / (size * maxRank);
    }
  }
  return scores;
}
