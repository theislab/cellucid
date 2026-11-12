/**
 * @fileoverview How the open cells were chosen, as every analysis result
 * says it: a chip beside the result (`BaseAnalysisUI._showCellChoice`).
 *
 * Every analysis computes on the open cells "as if the file held only them"
 * (docs, Subsampled loading). That estimates the file only when the open
 * cells are a random sample of it at one rate:
 *
 * - **uniform** is; so is **stratified, proportional** with no minimum per
 *   category (a uniform sample within each category, at the file's
 *   proportions).
 * - **blocks** (whole runs of neighboring cells; the default subsample of a
 *   file Cellucid did not write) is a cluster sample: a file stored by
 *   sample or by cell type loses whole samples or types, and the cells of
 *   one block are alike, so proportions can be far from the file's and
 *   per-cell p-values overstate the evidence. The cells of an opening still
 *   growing (from its first chunks, or in its order: the share's cells in
 *   the blocks read so far) are the same.
 * - **stratified, balanced** (or with a minimum per category) and
 *   **spatial** re-weight the cells on purpose: rare categories or sparse
 *   regions keep more of their cells than the rest.
 *
 * And a result that read genes while they are read for a sample of the open
 * cells (`data/anndata/subsample-plan.js`, `genes`) is of each group's cells
 * among that sample: a line says so ("Genes read for 40K of 455K cells"),
 * linked to where more are read, with each group's share in its (i). The sample of a file in its own order is whole blocks
 * of its storage, so such a result is never a random sample of the file.
 *
 * @module shared/open-cell-choice
 */

import { formatCount, formatCountOf, formatOpenCells, formatShare, formatCompactCount } from '../../../utils/format-units.js';
import { GENES_READ_PLACE, geneSampleText } from '../../../data/gene-read-plan.js';

const NOT_THE_FILE = 'Open every cell, or a uniform subsample, to analyze the file.';

/**
 * How the open cells of `identity` were chosen, for a result computed on
 * them, and, when the result read genes for a sample of them (`genes`,
 * `shared/gene-sample-cells.js` `geneSampleUse`), that it is of each
 * group's cells among the sample (`genes`: `describeGeneSampleUse`, the
 * line that links to Genes read for); null when every cell is open and
 * every open cell's genes were read.
 *
 * @param {import('../../../data/cell-identity.js').CellIdentity|null|undefined} identity
 * @param {{genes?: {cells: number, of: number, groups?: Array<{name: string, used: number, of: number}>}|null}} [options]
 * @returns {null|{
 *   method: 'uniform'|'blocks'|'stratified'|'spatial'|'chunks'|'unknown'|'genes',
 *   open: number,
 *   of: number,
 *   field: string|null,
 *   representative: boolean,
 *   tone: 'info'|'warning',
 *   text: string|null,
 *   title: string|null,
 *   genes?: ReturnType<typeof describeGeneSampleUse>
 * }} `representative`: a random sample of the file at one rate, whose
 *   proportions and p-values estimate the file's; `field`: the field a
 *   stratified subsample was drawn by; `text` null: the open cells are every
 *   cell, and only the gene sample is said.
 */
export function describeOpenCellChoice(identity, { genes = null } = {}) {
  const base = describeSubsetChoice(identity);
  if (genes === null || genes === undefined) return base;
  return Object.freeze({
    method: base?.method ?? 'genes',
    open: base?.open ?? genes.of,
    of: base?.of ?? genes.of,
    field: base?.field ?? null,
    representative: false,
    tone: base?.tone ?? 'warning',
    text: base?.text ?? null,
    title: base?.title ?? null,
    genes: describeGeneSampleUse(genes),
  });
}

/**
 * What a result says about the gene sample it read genes for, in one line
 * that fits the narrowest panel (`text`: "Genes read for 3.8K of 2.3M
 * cells") and its exact words (`detail`: the counts, each group's cells
 * among the sample, and where more are read), for its (i).
 *
 * @param {{cells: number, of: number, groups?: Array<{name: string, used: number, of: number}>}} genes
 * @returns {Readonly<{cells: number, of: number, text: string, detail: string}>}
 */
export function describeGeneSampleUse(genes) {
  const groups = genes.groups ?? [];
  const cut = groups.filter(group => group.used < group.of);
  const perGroup = cut.length === 0 ? '' : ` (${cut.map(group => `${group.name}: ${formatCount(group.used)} of ${formatCount(group.of)}`).join('; ')})`;
  let used = 0;
  let of = 0;
  for (const group of groups) {
    used += group.used;
    of += group.of;
  }
  const total = groups.length === 0 ? '' : `: ${formatCount(used)} of its groups' ${formatCountOf(of, 'cell')}`;
  return Object.freeze({
    cells: genes.cells,
    of: genes.of,
    text: geneSampleText(genes, { plural: true, format: formatCompactCount }),
    detail: `Genes are read for ${formatCount(genes.cells)} of the ${formatCountOf(genes.of, 'open cell')}, the first in their order (a sample of them), so this was computed on each group's cells among them${total}${perGroup}. The other cells have no gene value yet, which is not 0. Read genes for more cells in ${GENES_READ_PLACE}, then run it again.`,
  });
}

/** How a subsample's cells were chosen (`describeOpenCellChoice` without a gene sample). */
function describeSubsetChoice(identity) {
  if (identity === null || identity === undefined || identity.isSubset !== true) return null;
  const open = identity.n;
  const of = identity.nOriginal;
  const cells = formatOpenCells(open, of);
  const share = formatShare(open, of);
  const choice = identity.choice ?? null;
  const spec = choice?.spec ?? null;
  const described = (method, representative, words, title, field = null) => Object.freeze({
    method,
    open,
    of,
    field,
    representative,
    tone: representative ? 'info' : 'warning',
    text: `${share} of cells · ${words}`,
    title
  });

  if (choice?.chunked === true) {
    return described('chunks', false, 'first chunks',
      `Computed on ${cells}: the subsample's cells in the parts of the file read so far, while it opens. They lie in whole runs of neighboring cells, not a sample of the file, so proportions and p-values are of these cells only. Run again once the opening has finished.`);
  }
  if (spec === null) {
    return described('unknown', false, 'subsample',
      `Computed on ${cells}, chosen in a way this opening does not record, so proportions and p-values are of these cells only. ${NOT_THE_FILE}`);
  }
  switch (spec.method) {
    case 'uniform':
      return described('uniform', true, 'uniform',
        `Computed on ${cells}, a uniform random sample of the file. Proportions and p-values are of these cells and estimate the file's.`);
    case 'blocks':
      return described('blocks', false, 'blocks',
        `Computed on ${cells}: whole blocks of ${spec.blockSize} neighboring cells, not a random sample of the file. A file stored by sample or by cell type loses whole samples or types, and the cells of one block are alike, so proportions can be far from the file's and p-values overstate the evidence. ${NOT_THE_FILE}`);
    case 'stratified': {
      const field = spec.field;
      if (spec.allocation === 'proportional' && spec.minPerCategory === 0) {
        return described('stratified', true, `stratified by ${field}`,
          `Computed on ${cells}: a uniform sample within each category of "${field}", in proportion. Proportions and p-values estimate the file's.`, field);
      }
      const how = spec.allocation === 'balanced'
        ? `every category of "${field}" kept at about the same size`
        : `each category of "${field}" kept in proportion, with at least ${formatCountOf(spec.minPerCategory, 'cell')} each`;
      return described('stratified', false, `stratified by ${field}`,
        `Computed on ${cells}: ${how}, so rare categories are over-represented. Proportions of "${field}", and of any field related to it, are the subsample's design, not the data. ${NOT_THE_FILE}`, field);
    }
    case 'spatial':
      return described('spatial', false, 'spatial',
        `Computed on ${cells}: sparse regions of "${spec.embedding}" keep their cells while dense ones are thinned, so rare states are over-represented. Proportions and p-values are of this design, not the file. ${NOT_THE_FILE}`);
    default:
      throw new RangeError(`Unknown subsample method "${String(spec.method)}"`);
  }
}
