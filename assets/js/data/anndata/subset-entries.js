/**
 * Keeping the entries of a gene-major (CSC) matrix that fall in a cell
 * subset: the kernel of a cell subset read by gene (`matrix-access.js`,
 * `subsetByColumns`). It depends on nothing else, so it runs where the
 * entries are: on the reader thread, or on a decode worker
 * (`formats/io/decode-pool.js`, `runOnDecodeWorker`) with the run of genes'
 * entries transferred to it, where it keeps a whole run while the reader
 * thread goes on with the next.
 *
 * @module data/anndata/subset-entries
 */

/**
 * Append the entries `from..to` of one gene that fall in a cell subset to
 * `outPositions`/`outValues` at `at`: each entry whose row has a subset
 * position (`positionOf[row] >= 0`), with its value as float32, unless that
 * is zero (a stored zero is no entry, as `sparseColumnOf` leaves it out).
 * The rows must ascend strictly within `nObs` (one entry per cell, as scipy
 * and anndata write a canonical matrix); returns the new end, or -1 when
 * they do not (a duplicate coordinate, an unsorted gene), and the gene is
 * then read through `sparseColumnOf`.
 *
 * @param {ArrayLike<number>} rows
 * @param {ArrayLike<number>} values
 * @param {number} from
 * @param {number} to
 * @param {Int32Array} positionOf - Each cell's subset position, or -1
 * @param {number} nObs
 * @param {Int32Array} outPositions
 * @param {Float32Array} outValues
 * @param {number} at
 * @returns {number}
 */
export function keepSubsetEntries(rows, values, from, to, positionOf, nObs, outPositions, outValues, at) {
  let previous = -1;
  let kept = at;
  // Every entry is written and kept only when its cell is in the subset
  // (`~position >>> 31` is 1 for a position, 0 for -1): no branch on which
  // entries a subset keeps, which no predictor guesses.
  for (let entry = from; entry < to; entry++) {
    const row = rows[entry];
    if (!(row > previous && row < nObs)) return -1;
    previous = row;
    const position = positionOf[row];
    outPositions[kept] = position;
    outValues[kept] = values[entry];
    kept += ~position >>> 31;
  }
  // A stored zero is no entry: the few kept are dropped.
  let end = at;
  for (let entry = at; entry < kept; entry++) {
    if (outValues[entry] !== 0) {
      outPositions[end] = outPositions[entry];
      outValues[end++] = outValues[entry];
    }
  }
  return end;
}

/**
 * Sort entries `from..to` of `positions`/`values` by position (a gene of a
 * subset whose cells were not given ascending).
 *
 * @param {Int32Array} positions
 * @param {Float32Array} values
 * @param {number} from
 * @param {number} to
 */
export function sortSubsetEntries(positions, values, from, to) {
  if (to - from < 2) return;
  const order = Uint32Array.from({ length: to - from }, (_, i) => from + i).sort((a, b) => positions[a] - positions[b]);
  const sortedPositions = Int32Array.from(order, i => positions[i]);
  const sortedValues = Float32Array.from(order, i => values[i]);
  positions.set(sortedPositions, from);
  values.set(sortedValues, from);
}

/**
 * Keep a run of genes' entries in a cell subset: the genes' entries are
 * `rows`/`values` `[ranges[2k], ranges[2k + 1])` for the run's gene `k`.
 * Each gene's kept entries follow the one before's in `positions`/`values`
 * (`counts[k]` of them), sorted by position unless the cells were given
 * `ascending`. A gene whose rows do not ascend strictly within `nObs` is kept
 * nothing here: it is listed in `refused`, with its entries, for the caller
 * to read through `sparseColumnOf`.
 *
 * @param {{rows: ArrayLike<number>, values: ArrayLike<number>, ranges: Float64Array, nObs: number, ascending: boolean}} run
 * @param {Int32Array} positionOf - Each cell's subset position, or -1
 * @returns {{positions: Int32Array, values: Float32Array, counts: Float64Array,
 *   refused: Array<{gene: number, rows: ArrayLike<number>, values: ArrayLike<number>}>}}
 */
export function keepSubsetRun({ rows, values, ranges, nObs, ascending }, positionOf) {
  const genes = ranges.length / 2;
  let entries = 0;
  for (let k = 0; k < genes; k++) entries += ranges[2 * k + 1] - ranges[2 * k];
  const positions = new Int32Array(entries);
  const kept = new Float32Array(entries);
  const counts = new Float64Array(genes);
  const refused = [];
  let at = 0;
  for (let k = 0; k < genes; k++) {
    const from = ranges[2 * k];
    const to = ranges[2 * k + 1];
    const end = keepSubsetEntries(rows, values, from, to, positionOf, nObs, positions, kept, at);
    if (end < 0) {
      refused.push({ gene: k, rows: rows.slice(from, to), values: values.slice(from, to) });
      continue;
    }
    if (!ascending) sortSubsetEntries(positions, kept, at, end);
    counts[k] = end - at;
    at = end;
  }
  return { positions: positions.slice(0, at), values: kept.slice(0, at), counts, refused };
}
