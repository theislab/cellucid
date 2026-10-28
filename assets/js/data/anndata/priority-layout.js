/**
 * Priority-ordered files: a file whose rows are its cells in priority order
 * (the uniform rank of the subsampling specification under the file's seed,
 * `../subsample.js`), as files Cellucid writes store them. Then the uniform
 * subsample of size k under the file's seed is file rows `[0, k)` of every
 * per-cell array: a prefix read, nothing scattered.
 *
 * The contract (written by `prepare()` / `cellucid_prepare()`; the
 * Cellucid-ready AnnData specification states it):
 *
 * - `uns['cellucid']['priority']` = `{seed, specVersion, nObs, levels}`
 *   (`specVersion` 1; `nObs` the cell count the file was written with;
 *   `levels` the prefix sizes `prefixLevels(nObs)`);
 * - `obs[PRIORITY_ORIGINAL_COLUMN]`: each row's original position (uint32 or
 *   int64), a permutation of `0 … n−1` whose ranks ascend down the rows;
 * - optionally `varm[PREFIX_COUNTS_KEY]` (n_vars × levels): for a gene-major
 *   X, each gene's stored values among the first `levels[j]` rows.
 *
 * The record is the claim, and it is verified before it is relied on: its
 * `nObs` is the file's cell count, its `levels` are those of that count, and
 * the stored column's first chunk of rows (when the column is there) are
 * original positions whose ranks ascend. A file saved again after its cells
 * were subset, combined or reordered (anndata keeps `uns` as it was) fails
 * that, and is read as a file Cellucid did not write: its rows are its
 * cells' original positions, its default sampling a foreign file's, and the
 * opening says why (`notice`). A file without `priority` is read as stored
 * (file rows are original positions). The positions themselves are computed
 * from the seed (`priorityPositions`), so a record whose column was dropped
 * still verifies.
 *
 * @module data/anndata/priority-layout
 */

import { isArrayNode, isGroup } from '../../formats/store.js';
import { child } from './elements.js';
import { readIntegers } from './values.js';
import { SUBSAMPLE_SPEC_VERSION, rankOf, seedKey } from '../subsample.js';
import { fmix32 } from '../cell-identity.js';
import { formatCountOf } from '../../utils/format-units.js';
import { allocateTypedArray } from '../sparse-column-index.js';
import { SharedWork } from '../../formats/io/abort.js';

/** The obs column holding each row's original position. */
export const PRIORITY_ORIGINAL_COLUMN = 'cellucid_original_position';
/** The varm array of each gene's stored values within each prefix level. */
export const PREFIX_COUNTS_KEY = 'cellucid_prefix_counts';

/**
 * The prefix sizes `varm['cellucid_prefix_counts']` counts at, ascending:
 * `n` stepped down by 3/4 (each `floor(previous * 3 / 4)`) to 1, `n` itself
 * left out and a repeat kept once -- the writers' rule (cellucid-python's
 * `prefix_levels`, cellucid-r's `.prefix_levels`).
 *
 * @param {number} n
 * @returns {number[]}
 */
export function prefixLevels(n) {
  const levels = [];
  let level = n;
  for (;;) {
    level = Math.floor((level * 3) / 4);
    if (level < 1 || (levels.length > 0 && level === levels[levels.length - 1])) break;
    levels.push(level);
  }
  return levels.reverse();
}

/** One scalar of the record, or undefined when it is not an array. */
async function scalar(node, readOptions) {
  if (!isArrayNode(node)) return undefined;
  const value = await node.read(undefined, readOptions);
  return Number(ArrayBuffer.isView(value) || Array.isArray(value) ? value[0] : value);
}

/** The inverse of `fmix32` (MurmurHash3's finaliser is a bijection on uint32). */
function unfmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7ed1b41d);
  h ^= (h >>> 13) ^ (h >>> 26);
  h = Math.imul(h, 0xa5cb9243);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The original positions of a priority-ordered file's rows, from its seed:
 * row `r` holds the cell of the `r`-th lowest rank (`rankOf`), so the
 * positions `0 … n−1` sorted by rank are the file's
 * `obs['cellucid_original_position']`, computed instead of read (a sort of
 * `n` ranks, each turned back into its position by the inverse hash) — the
 * stored column is the check (`readPriorityLayout`).
 *
 * @param {number} seed
 * @param {number} n
 * @returns {Uint32Array}
 */
export function priorityPositions(seed, n) {
  const key = seedKey(seed);
  const ranks = allocateTypedArray(Uint32Array, n, 'Priority ranks');
  for (let position = 0; position < n; position++) ranks[position] = fmix32((position ^ key) >>> 0);
  ranks.sort();
  for (let row = 0; row < n; row++) ranks[row] = (unfmix32(ranks[row]) ^ key) >>> 0;
  return ranks;
}

/** Each store root's verified layout: read once, however often its cells are opened again. */
const LAYOUTS = new WeakMap();

/**
 * The priority layout of a store root, verified (module comment): `layout`
 * null for a file without a record, or with one that does not describe its
 * cells, and then `notice` says why. Read once per root: opening its cells
 * again (a resize, Apply) reads nothing of it again.
 *
 * `layout.firstRows` is the stored column's first chunk of rows (null
 * without the column), the only part of it ever read; `order()` every row's
 * original position, computed from the seed once and checked against them.
 *
 * @param {Object} root
 * @param {number} nObs
 * @param {Object} readOptions
 * @returns {Promise<{layout: {seed: number, levels: number[]|null, firstRows: Uint32Array|null,
 *   order: () => Promise<Uint32Array>}|null, notice: string|null}>}
 */
export function readPriorityLayout(root, nObs, readOptions = {}) {
  let read = LAYOUTS.get(root);
  // Read once, shared by every opening asking meanwhile (`SharedWork`): its
  // reads stop only once every one of them withdrew, and are then read anew.
  if (read === undefined || read.nObs !== nObs || read.layout.abandoned) {
    read = { nObs, layout: new SharedWork(signal => verifiedLayout(root, nObs, { ...readOptions, signal })) };
    LAYOUTS.set(root, read);
    // A read that failed (a network error) is read again next time.
    const failed = read;
    read.layout.promise.catch(() => { if (LAYOUTS.get(root) === failed) LAYOUTS.delete(root); });
  }
  return read.layout.join(readOptions.signal ?? null);
}

async function verifiedLayout(root, nObs, readOptions) {
  const priority = child(child(child(root, 'uns'), 'cellucid'), 'priority');
  const column = child(child(root, 'obs'), PRIORITY_ORIGINAL_COLUMN);
  if (!isGroup(priority)) {
    return {
      layout: null,
      notice: column === null ? null
        : `This file has obs['${PRIORITY_ORIGINAL_COLUMN}'] and no priority record (uns['cellucid']['priority']) beside it, ` +
          'so the column names no order: its cells are read in the order stored',
    };
  }
  const stored = isArrayNode(column) && column.shape.length === 1 && column.shape[0] === nObs ? column : null;
  // The rows the stored column is checked over: its first chunk, read with
  // the record in one round trip (the rest of opening waits for neither).
  const checkRows = stored === null ? 0 : Math.max(0, Math.min(nObs, Array.isArray(stored.chunks) ? stored.chunks[0] : nObs));
  const levelsNode = priority.get('levels');
  const [seed, version, recorded, levelValues, firstRows] = await Promise.all([
    scalar(priority.get('seed'), readOptions),
    scalar(priority.get('specVersion'), readOptions),
    scalar(priority.get('nObs'), readOptions),
    isArrayNode(levelsNode) && levelsNode.shape.length === 1 ? readIntegers(levelsNode, 0, levelsNode.shape[0], 'levels', readOptions) : null,
    checkRows > 0 ? readIntegers(stored, 0, checkRows, PRIORITY_ORIGINAL_COLUMN, readOptions) : null,
  ]);
  const levels = levelValues === null ? null : Array.from(levelValues, Number);
  const reason = (() => {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) return 'its seed is not a whole number from 0 to 4294967295';
    if (version !== SUBSAMPLE_SPEC_VERSION) {
      return `it follows version ${version} of the subsampling specification, and this Cellucid follows ${SUBSAMPLE_SPEC_VERSION}`;
    }
    if (recorded === undefined) return 'it records no cell count (nObs)';
    if (recorded !== nObs) return `it was written for ${formatCountOf(recorded, 'cell')}, and the file holds ${formatCountOf(nObs, 'cell')} (cells were added or removed since)`;
    if (isArrayNode(levelsNode) && (levels === null || !sameNumbers(levels, prefixLevels(nObs)))) {
      return `its levels are not those of ${formatCountOf(nObs, 'cell')}`;
    }
    if (isArrayNode(column) && stored === null) return `obs['${PRIORITY_ORIGINAL_COLUMN}'] is not one original position per cell`;
    if (firstRows !== null) {
      let previous = -1;
      for (let row = 0; row < firstRows.length; row++) {
        const position = Number(firstRows[row]);
        if (!(Number.isInteger(position) && position >= 0 && position < nObs)) {
          return `obs['${PRIORITY_ORIGINAL_COLUMN}'] row ${row} is ${position}, not a position of its ${formatCountOf(nObs, 'cell')}`;
        }
        const rank = rankOf(seed, position);
        if (rank <= previous) return `its rows are not in its seed's order from row ${row} on (they were reordered since)`;
        previous = rank;
      }
    }
    return null;
  })();
  if (reason !== null) {
    return {
      layout: null,
      notice: `This file records a priority order (uns['cellucid']['priority']) that does not describe its cells: ${reason}. ` +
        'Its cells are read in the order stored, as a file Cellucid did not write',
    };
  }
  let stored32 = null;
  if (firstRows !== null) {
    stored32 = allocateTypedArray(Uint32Array, firstRows.length, 'Priority first rows');
    for (let i = 0; i < firstRows.length; i++) stored32[i] = Number(firstRows[i]);
  }
  /**
   * The original positions of every row, computed from the seed
   * (`priorityPositions`) once; the stored column's first rows, verified
   * above to ascend in rank, must be its first positions (a file whose first
   * rows ascend but are not the lowest ranks is damaged, not edited).
   */
  let computed = null;
  const order = async () => {
    if (computed !== null) return computed;
    const positions = priorityPositions(seed, nObs);
    if (stored32 !== null) {
      for (let row = 0; row < stored32.length; row++) {
        if (positions[row] !== stored32[row]) {
          throw new Error(`obs['${PRIORITY_ORIGINAL_COLUMN}'] row ${row} is ${stored32[row]}, and the file's priority seed places ${positions[row]} there; the file is damaged`);
        }
      }
    }
    return (computed = positions);
  };
  return { layout: { seed, levels, firstRows: stored32, order }, notice: null };
}

function sameNumbers(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * Each gene's stored values within the first `levels[level]` rows, from
 * `varm[PREFIX_COUNTS_KEY]` (one column, read once), or null when the file
 * has none. `entryCounts(gene)` is each gene's stored values (`X/indptr`):
 * a count is a whole number no larger than it nor than the level's rows,
 * else the file is refused, since a count past its gene would read another
 * gene's values (`requirePrefixRows` checks the rows those counts hold).
 */
export async function readPrefixCounts(root, level, nVars, readOptions = {}, { levelRows = null, entryCounts = null } = {}) {
  const node = child(child(root, 'varm'), PREFIX_COUNTS_KEY);
  if (!isArrayNode(node) || node.shape[0] !== nVars) return null;
  if (node.shape.length !== 2 || !(level < node.shape[1])) {
    throw new Error(`varm['${PREFIX_COUNTS_KEY}'] has no column ${level} for uns['cellucid']['priority']['levels']`);
  }
  const read = await node.read([[0, nVars], [level, level + 1]], readOptions);
  const values = allocateTypedArray(Float64Array, read.length, `varm['${PREFIX_COUNTS_KEY}']`);
  for (let gene = 0; gene < read.length; gene++) values[gene] = Number(read[gene]);
  for (let gene = 0; gene < nVars; gene++) {
    const count = values[gene];
    const limit = Math.min(levelRows ?? Infinity, entryCounts === null ? Infinity : entryCounts(gene));
    if (!(Number.isInteger(count) && count >= 0 && count <= limit)) {
      const rowsOf = levelRows === null ? "the level's rows" : `the first ${formatCountOf(levelRows, 'row')}`;
      throw new Error(`varm['${PREFIX_COUNTS_KEY}'] counts ${formatCountOf(count, 'value')} of gene ${gene} in ${rowsOf}, more than it can hold; the file is damaged`);
    }
  }
  return values;
}

/**
 * Check a gene read by its prefix count (`read` rows ascending: the counted
 * ones, and the next when the gene has one): every counted row below the
 * level's `levelRows`, and the next at or past it, so the count holds
 * exactly the gene's values below the level.
 */
export function requirePrefixRows(rows, read, count, levelRows, gene) {
  const fault = count > 0 && !(rows[count - 1] < levelRows)
    ? `its value ${count} is at row ${rows[count - 1]}`
    : read > count && rows[count] < levelRows ? `its value ${count + 1}, at row ${rows[count]}, is below the level too` : null;
  if (fault !== null) {
    throw new Error(`varm['${PREFIX_COUNTS_KEY}'] counts ${formatCountOf(count, 'value')} of gene ${gene} in the first ${formatCountOf(levelRows, 'row')}, and ${fault}; the file is damaged`);
  }
}
