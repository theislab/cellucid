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
 * `outPositions`/`outValues` at `at`: each entry whose row is a subset
 * cell's (`subset`: their rows ascending and each one's position,
 * `matrix-access.js` `subsetCells`), at that cell's position, with its value
 * as float32, unless that is zero (a stored zero is no entry, as
 * `sparseColumnOf` leaves it out). The rows must ascend strictly within
 * `nObs` (one entry per cell, as scipy and anndata write a canonical
 * matrix); returns the new end, or -1 when they do not (a duplicate
 * coordinate, an unsorted gene), and the gene is then read through
 * `sparseColumnOf`. The gene's rows and the subset's are walked together,
 * the subset's by galloping past the rows the gene skips: a few cells of a
 * gene of many entries cost the entries, many cells of a sparse gene about
 * its entries' logarithms.
 *
 * @param {ArrayLike<number>} rows
 * @param {ArrayLike<number>} values
 * @param {number} from
 * @param {number} to
 * @param {{rows: Uint32Array, positions: Int32Array}} subset
 * @param {number} nObs
 * @param {Int32Array} outPositions
 * @param {Float32Array} outValues
 * @param {number} at
 * @returns {number}
 */
export function keepSubsetEntries(rows, values, from, to, subset, nObs, outPositions, outValues, at) {
  const cellRows = subset.rows;
  const cells = cellRows.length;
  let previous = -1;
  let kept = at;
  let c = 0;
  for (let entry = from; entry < to; entry++) {
    const row = rows[entry];
    if (!(row > previous && row < nObs)) return -1;
    previous = row;
    if (c < cells && cellRows[c] < row) {
      // Gallop to the first subset row at or past this one.
      let step = 1;
      let low = c;
      while (c + step < cells && cellRows[c + step] < row) {
        low = c + step;
        step *= 2;
      }
      let high = Math.min(cells, c + step);
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (cellRows[middle] < row) low = middle + 1;
        else high = middle;
      }
      c = low;
    }
    if (c < cells && cellRows[c] === row) {
      const value = values[entry];
      if (value !== 0) {
        outPositions[kept] = subset.positions[c];
        outValues[kept++] = value;
      }
      c++;
    }
  }
  return kept;
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
 * @param {{rows: Uint32Array, positions: Int32Array}} subset - The subset's cells (`keepSubsetEntries`)
 * @returns {{positions: Int32Array, values: Float32Array, counts: Float64Array,
 *   refused: Array<{gene: number, rows: ArrayLike<number>, values: ArrayLike<number>}>}}
 */
export function keepSubsetRun({ rows, values, ranges, nObs, ascending }, subset) {
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
    const end = keepSubsetEntries(rows, values, from, to, subset, nObs, positions, kept, at);
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
