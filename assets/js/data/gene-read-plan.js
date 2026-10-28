/**
 * What a person is told before a gene of a cell-major matrix is read
 * (`AnnDataReader.geneReadPlan`): a matrix stored cell by cell (CSR, or dense
 * in chunks spanning many genes) holds each gene spread over every cell, so
 * its first gene reads the whole matrix, however small the gene. The cost is
 * stated up front, in bytes and, once the link is measured, in time; then
 * where the gene index that read builds is kept, or why it cannot be kept
 * (every gene then reads the matrix again) and what makes it fit. A
 * matrix whose open cells are in priority order (a subsample) is indexed in
 * segments (`anndata/prefix-column-index.js`): the gene's colours fill in on
 * a growing sample of the cells, and the notice says when the first appear.
 *
 * @module data/gene-read-plan
 */

import { formatBytes, formatCount, formatCountOf, formatRemaining } from '../utils/format-units.js';

/**
 * The plan of one gene read in words, or null when the gene reads only its
 * own entries (a gene-major matrix, or an index already built).
 *
 * @param {Object|null} plan - `geneReadPlan`
 * @returns {string|null}
 */
export function describeGeneReadPlan(plan) {
  if (plan === null || plan === undefined || !plan.cellMajor || plan.built) return null;
  const parts = [];
  const stored = plan.scan?.storedBytes ?? null;
  const amount = stored !== null ? formatBytes(stored) : `${formatBytes(plan.scan.valueBytes)} as values`;
  const time = stored !== null && plan.bytesPerSecond > 0
    ? ` (${formatRemaining((stored * 1000) / plan.bytesPerSecond)} at the measured ${formatBytes(plan.bytesPerSecond)}/s)`
    : '';
  const progressive = plan.progressive ?? null;
  parts.push(progressive !== null && progressive.done > 0
    ? `${plan.label} is stored cell by cell; ${formatCountOf(progressive.done, 'cell')} of it are indexed already, ` +
      `so the first gene reads the entries of the other ${formatCount(progressive.cells - progressive.done)}: ${amount}${time}.`
    : `${plan.label} is stored cell by cell, so the first gene reads every cell's entries: ${amount}${time}.`);
  if (progressive !== null) {
    // The open cells are in priority order (a subsample's), indexed in
    // segments: the gene shows on a sample of them as each one is read.
    const first = progressive.nextStoredBytes !== null ? ` (${formatBytes(progressive.nextStoredBytes)})` : '';
    parts.push(progressive.done > 0
      ? `Its colours show at once on the ${formatCountOf(progressive.done, 'cell')} indexed, a sample of the ` +
        `${formatCountOf(progressive.cells, 'open cell')}, and fill in as the others are read; cells not read yet show as missing.`
      : `Its colours fill in as cells are read: the first ${formatCount(progressive.next)} of ${formatCountOf(progressive.cells, 'cell')}${first}, ` +
        'a sample of them, then more; cells not read yet show as missing.');
  }
  const index = plan.index;
  if (index !== null) {
    if (index.placement === null) {
      parts.push(
        `No gene index of it can be kept (${index.refusal}), so every gene reads it again; ` +
        'opening a subsample of the cells makes the index fit.'
      );
    } else if (index.passes === 2) {
      const again = index.secondPassStoredBytes !== null ? formatBytes(index.secondPassStoredBytes) : 'the matrix';
      parts.push(
        `Then ${again} is read once more to keep a gene index ${index.placement === 'disk' ? 'on disk' : 'in memory'}; ` +
        'later genes read only it.'
      );
    } else {
      parts.push('Later genes read the gene index it builds.');
    }
  }
  return parts.join(' ');
}
