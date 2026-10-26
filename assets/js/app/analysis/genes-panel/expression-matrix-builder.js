/**
 * Expression matrices for the marker heatmap, from a marker run's statistics.
 *
 * A marker run computes every tested gene's mean in every group in the same
 * pass that tests it (`MarkerStatistics.meanInGroupByGroup`), so a heatmap of
 * any genes the run tested reads nothing again: it is those means, rows
 * genes and columns groups, with a transform.
 *
 * @module genes-panel/expression-matrix-builder
 */

import { zscoreRows, log1pTransform } from '../shared/matrix-utils.js';

/**
 * The one rule for turning a group's category into the text a user sees:
 * the heatmap's column headers, the group picker and the CSV `group` column
 * agree character for character, so two exports of one run can be joined.
 *
 * @param {unknown} groupName - The group's exact category name.
 * @param {string} groupId - The synthetic handle, for the error message only.
 * @returns {string}
 */
export function encodeGroupName(groupName, groupId) {
  if (typeof groupName === 'string') {
    if (groupName.length === 0 || groupName.trim().length === 0) {
      throw new TypeError(`Group "${groupId}" name must not be empty`);
    }
    return groupName;
  }
  if (typeof groupName === 'number') {
    if (!Number.isFinite(groupName)) {
      throw new TypeError(`Group "${groupId}" numeric name must be finite`);
    }
    return String(groupName);
  }
  if (typeof groupName === 'boolean') return String(groupName);
  throw new TypeError(`Group "${groupId}" name must be a string, finite number, or boolean`);
}

/** Apply a heatmap transform to row-major means. */
export function transformMatrix(rawValues, nRows, nCols, transform) {
  if (transform === 'zscore') return zscoreRows(rawValues, nRows, nCols);
  if (transform === 'log1p') return log1pTransform(rawValues);
  if (transform === 'none') return rawValues;
  throw new RangeError(`Unknown heatmap transform: ${String(transform)}`);
}

/**
 * The heatmap matrix of some genes over some groups of a marker run.
 *
 * @param {import('./constants.js').MarkerStatistics} stats
 * @param {{genes: string[], groupIndices: number[], transform: 'none'|'zscore'|'log1p'}} options
 * @returns {import('./constants.js').ExpressionMatrix}
 */
export function markerMatrix(stats, { genes, groupIndices, transform }) {
  const geneRow = new Map(stats.genes.map((gene, index) => [gene, index]));
  const nRows = genes.length;
  const nCols = groupIndices.length;
  const rawValues = new Float32Array(nRows * nCols);
  for (let r = 0; r < nRows; r++) {
    const known = geneRow.get(genes[r]);
    if (known === undefined) throw new RangeError(`Gene "${genes[r]}" was not tested in this run`);
    for (let c = 0; c < nCols; c++) {
      rawValues[r * nCols + c] = stats.meanInGroupByGroup[groupIndices[c]][known];
    }
  }
  const groups = groupIndices.map(index => stats.groups[index]);
  return {
    genes: [...genes],
    groupIds: groups.map(group => group.groupId),
    groupNames: groups.map(group => encodeGroupName(group.groupName, group.groupId)),
    groupColors: groups.map(group => group.color),
    values: transformMatrix(rawValues, nRows, nCols, transform),
    rawValues: transform === 'none' ? null : rawValues,
    nRows,
    nCols,
    transform
  };
}

/**
 * The same matrix under another transform.
 * @param {import('./constants.js').ExpressionMatrix} matrix
 * @param {'none'|'zscore'|'log1p'} transform
 */
export function retransformMatrix(matrix, transform) {
  const rawValues = matrix.rawValues ?? matrix.values;
  return {
    ...matrix,
    values: transformMatrix(rawValues, matrix.nRows, matrix.nCols, transform),
    rawValues: transform === 'none' ? null : rawValues,
    transform
  };
}
