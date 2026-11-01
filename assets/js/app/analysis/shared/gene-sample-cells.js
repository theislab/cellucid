/**
 * @fileoverview The cells an analysis that reads genes computes on, when
 * genes are read for a sample of the open cells (`data/anndata/subsample-plan.js`,
 * `genes`: the first `cells` open cells in priority order).
 *
 * A gene has no value on the other open cells: a dense column holds NaN
 * there, a sparse one no entry (which elsewhere means 0). So every analysis
 * that reads genes takes its cells -- its groups, pages, the visible cells
 * -- below the sample's count (`cellsReadFor`, `maskReadFor`), never a cell
 * past it as a zero; a per-cell result (a gene score) is NaN past it
 * (`fillUnread`); and the result says so (`geneSampleUse`, the chip beside
 * it, `shared/open-cell-choice.js`). Genes read for (Session › Open data) reads
 * the rest; an analysis run after it uses every cell.
 *
 * @module shared/gene-sample-cells
 */

import { formatCount, formatCountOf } from '../../../utils/format-units.js';
import { GENES_READ_PLACE } from '../../../data/gene-read-plan.js';

/**
 * The cells of `cells` (open positions, ascending) that genes are read for:
 * those below `sample.cells`. `cells` itself when every one is (or there is
 * no sample).
 *
 * @template {Uint32Array|Int32Array|number[]} T
 * @param {T} cells
 * @param {{cells: number}|null} sample
 * @returns {T}
 */
export function cellsReadFor(cells, sample) {
  if (sample === null || sample === undefined) return cells;
  const bound = sample.cells;
  // Ascending: the cells read are a prefix of the list.
  let low = 0;
  let high = cells.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (cells[mid] < bound) low = mid + 1;
    else high = mid;
  }
  return low === cells.length ? cells : cells.slice(0, low);
}

/**
 * A cell mask (1 for a cell in) with the cells genes are not read for left
 * out: a copy when any was in, else `mask` itself.
 *
 * @param {Uint8Array} mask
 * @param {{cells: number}|null} sample
 * @returns {Uint8Array}
 */
export function maskReadFor(mask, sample) {
  if (sample === null || sample === undefined || sample.cells >= mask.length) return mask;
  let any = false;
  for (let i = sample.cells; i < mask.length && !any; i++) any = mask[i] !== 0;
  if (!any) return mask;
  const out = mask.slice();
  out.fill(0, sample.cells);
  return out;
}

/**
 * A per-cell result over every open cell with NaN on the cells genes are not
 * read for (in place; the array is returned).
 *
 * @template {Float32Array|Float64Array} T
 * @param {T} values
 * @param {{cells: number}|null} sample
 * @returns {T}
 */
export function fillUnread(values, sample) {
  if (sample !== null && sample !== undefined && sample.cells < values.length) values.fill(Number.NaN, sample.cells);
  return values;
}

/**
 * What a result says about the gene sample it was computed on: the sample,
 * and for each group the cells it used of the cells it holds. Null when
 * genes are read for every open cell.
 *
 * @param {{cells: number, of: number}|null} sample
 * @param {Array<{name: string, used: number, of: number}>} [groups]
 * @returns {Readonly<{cells: number, of: number, groups: ReadonlyArray<{name: string, used: number, of: number}>}>|null}
 */
export function geneSampleUse(sample, groups = []) {
  if (sample === null || sample === undefined) return null;
  return Object.freeze({
    cells: sample.cells,
    of: sample.of,
    groups: Object.freeze(groups.map(group => Object.freeze({ name: group.name, used: group.used, of: group.of }))),
  });
}

/**
 * The sentence for a group too small once cut to the gene sample: "group A
 * has 1 of its 35 cells among the 40,000 cells genes are read for".
 *
 * @param {string} name
 * @param {number} used
 * @param {number} of
 * @param {{cells: number}} sample
 * @returns {string}
 */
export function describeGroupInGeneSample(name, used, of, sample) {
  return `${name} has ${formatCount(used)} of its ${formatCountOf(of, 'cell')} among the first ${formatCountOf(sample.cells, 'open cell')}, those genes are read for (read genes for more cells in ${GENES_READ_PLACE})`;
}
