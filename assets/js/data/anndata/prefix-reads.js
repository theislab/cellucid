/**
 * The prefix of a priority-ordered file an opening reads: the store rows
 * the first cells of an opening lie in (`prefixEndRow`), the prefix a
 * gene-major matrix is opened as (`openPrefixOf`), and the prefix counts an
 * opening reads as it opens (`startPrefixReads`). What the counts are and
 * how they are verified is `priority-layout.js`'s; when they are read is the
 * reader's (`reader.js`).
 *
 * @module data/anndata/prefix-reads
 */

import { child } from './elements.js';
import { readPrefixCounts } from './priority-layout.js';

/**
 * One past the highest store row of the first `count` cells of an opening
 * (`fileRows` in open order; null: cell `i` is row `i`): the prefix of
 * store rows that holds them.
 *
 * @param {ArrayLike<number>|null} fileRows
 * @param {number} count
 * @returns {number}
 */
export function prefixEndRow(fileRows, count) {
  if (fileRows === null) return count;
  let highest = -1;
  for (let i = 0; i < count; i++) if (fileRows[i] > highest) highest = fileRows[i];
  return highest + 1;
}

/**
 * The prefix a gene-major matrix is opened as, or null: the dataset's own
 * `X` takes the opening's prefix `k`; a modality's, its kept rows' count `m`
 * when they are its first `m` rows (as a priority-ordered file stores a
 * modality: by its cells' priority).
 */
export function openPrefixOf(prefix, keptRows, isModality) {
  if (prefix === null) return null;
  if (!isModality) return prefix;
  const m = keptRows.length;
  return m > 0 && keptRows[m - 1] === m - 1 ? m : null;
}

/**
 * The prefix counts an opening of the first `k` rows of a priority-ordered
 * file reads (`priority-layout.js`), started as it opens and awaited by the
 * first gene: for the dataset's `X` and each modality's, the column of the
 * smallest level holding `k` and the rows below that level (a modality's:
 * its rows of the cells below it, from its cell map's first rows). Keyed by
 * the matrix's path (`X`, `mod/<name>/X`); a matrix without counts is absent.
 */
export function startPrefixReads(full, resolution, readOptions) {
  const reads = new Map();
  const { prefix: k, levels } = resolution;
  if (k === null || k === undefined || !Array.isArray(levels)) return reads;
  const level = levels.findIndex(size => size >= k);
  if (level < 0) return reads;
  const levelCells = levels[level];
  const start = (key, group, rowsBelow) => {
    const table = child(child(group, 'varm'), 'cellucid_prefix_counts');
    if (table === null) return;
    const read = rowsBelow.then(async levelRows => {
      const counts = await readPrefixCounts(group, level, table.shape?.[0], readOptions, { levelRows });
      return counts === null ? null : { counts, levelRows };
    });
    read.catch(() => {});
    reads.set(key, read);
  };
  start('X', full, Promise.resolve(levelCells));
  for (const modality of Array.isArray(full.modalities) ? full.modalities : []) {
    const group = full.get(`mod/${modality.name}`);
    const rowsBelow = modality.obsmap === null
      ? Promise.resolve(levelCells)
      : modality.obsmap.read([[0, levelCells]], readOptions).then(map => {
        let rows = 0;
        for (let i = 0; i < map.length; i++) if (Number(map[i]) > 0) rows++;
        return rows;
      });
    start(`mod/${modality.name}/X`, group, rowsBelow);
  }
  return reads;
}
