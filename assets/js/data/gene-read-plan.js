/**
 * What a person is told before a gene of a cell-major matrix is read
 * (`AnnDataReader.geneReadPlan`): a matrix stored cell by cell (CSR, or dense
 * in chunks spanning every gene) holds each gene spread over every cell, and
 * dense strips too wide to keep decoded are indexed whole (`geneLayoutOf`),
 * so its first gene reads the whole matrix, however small the gene. The cost is
 * stated up front, in bytes and, once the link is measured, in time; then
 * where the gene index that read builds is kept, or why it cannot be kept
 * (every gene then reads the matrix again) and what makes it fit. A
 * matrix whose open cells are in priority order (a subsample) is indexed in
 * segments (`anndata/prefix-column-index.js`): the gene's colors fill in on
 * a growing sample of the cells, and the notice says when the first appear.
 * A gene sample (`subsample-plan.js`, `genes`: a gene read for the first
 * open cells only) is named in one sentence everywhere (`geneSampleText`),
 * with its facts (`geneSampleFacts`) and the cost of reading the rest
 * (`geneSampleCostText`).
 *
 * @module data/gene-read-plan
 */

import { countNoun, formatBytes, formatCount, formatCountOf, formatRemaining } from '../utils/format-units.js';
import { PLACES, placePath } from '../app/ui/place-names.js';
import { upperFirst } from '../utils/text-case.js';

/** Where what is kept in this browser is listed and removed. */
const STORED_PLACE = placePath(PLACES.session, PLACES.stored);

/**
 * Where the cells genes are read for are changed (`gene-read-control.js`):
 * every message that says how to read genes for more cells names it.
 */
export const GENES_READ_PLACE = `${placePath(PLACES.session, PLACES.subsampling)}: Genes read for`;

/**
 * How each layout whose first gene reads the whole matrix is named (`geneLayoutOf`):
 * its short value, its reason, and what one gene reads of every open cell.
 */
const WHOLE_MATRIX_LAYOUTS = Object.freeze({
  csr: Object.freeze({
    stored: 'cell by cell (sparse, CSR)',
    reason: "this file stores expression cell by cell (sparse, CSR), so one gene's values are spread over every cell's row",
    part: 'rows',
    each: 'row',
  }),
  'dense-rows': Object.freeze({
    stored: 'row by row (dense)',
    reason: "this file stores expression densely, row by row (in one piece or in blocks of whole cells), so one gene's values lie in every block",
    part: 'blocks',
    each: 'block',
  }),
  'dense-wide-strips': Object.freeze({
    stored: 'in wide strips of genes (dense)',
    reason: "this file stores expression densely in strips of genes too wide to keep decoded, so every strip is read once and indexed in memory",
    part: 'strips',
    each: 'strip',
  }),
});

/**
 * Why one gene of a matrix stored this way reads every open cell's part of
 * it, in plain words, from the layout the reader found (`geneReadCost`'s
 * `layout`, `geneLayoutOf`): `csr` (sparse, cell by cell), `dense-rows`
 * (dense, row by row) or `dense-wide-strips` (dense strips indexed whole).
 * Null for a layout whose genes read only their own values (`csc`,
 * `dense-strips`). The one source of every notice that names the cause:
 * the auto-fit notice, the first gene's notice and the index pass's read
 * activity.
 *
 * @param {string|null} layout
 * @returns {string|null}
 */
export function geneLayoutReason(layout) {
  return Object.hasOwn(WHOLE_MATRIX_LAYOUTS, layout) ? WHOLE_MATRIX_LAYOUTS[layout].reason : null;
}

/**
 * @typedef {Object} FactRow
 * @property {string} label - A short name ("Stored")
 * @property {string} value - Its short value ("cell by cell (sparse, CSR)")
 * @property {string|null} title - The longer text behind it, or null
 */

/**
 * What one gene of a matrix stored cell by cell reads, as rows of label and
 * short value (the longer text in `title`), or null for a layout whose genes
 * read only their own values (`geneLayoutReason`): how it is stored and why
 * that matters, what one gene reads of the `cells` open cells (`amount`: its
 * size and time, when known), what later genes read, and what avoids it.
 *
 * @param {string|null} layout
 * @param {{cells: number|null, amount?: string|null}} options - `cells` null: not known
 * @returns {FactRow[]|null}
 */
export function geneLayoutFacts(layout, { cells, amount = null }) {
  const reason = geneLayoutReason(layout);
  if (reason === null) return null;
  const { stored, part, each } = WHOLE_MATRIX_LAYOUTS[layout];
  return [
    { label: 'Stored', value: stored, title: `${upperFirst(reason)}.` },
    { label: 'One gene reads', value: `${Number.isFinite(cells) ? `the ${part} of ${formatCountOf(cells, 'open cell')}` : `every open cell's ${part}`}${amount === null ? '' : ` (${amount})`}`, title: `Every open cell's ${each} is read once, for the first gene.` },
    { label: 'Later genes', value: 'only their own values', title: 'They reuse the gene index the first gene builds.' },
    { label: 'Faster', value: 'fewer cells, or a gene-major copy', title: 'Open fewer cells, or open a copy written gene-major: cellucid.prepare() in Python or cellucid_prepare() in R writes one, and its genes read only their own values.' },
  ];
}

/**
 * Fact rows as plain text, one row a line ("Stored: cell by cell (sparse,
 * CSR). This file stores …"): a notification's details.
 *
 * @param {FactRow[]} rows
 * @returns {string}
 */
export function factsText(rows) {
  return rows.map(row => `${row.label}: ${row.value}.${row.title === null ? '' : ` ${row.title}`}`).join('\n');
}

/**
 * The states of a gene on a sample, as drawn (`rendering/read-cell-layer.js`),
 * in one line said by the legend and the figure's note alike: the cells not
 * read faded toward the background, and, when its zeros are drawn gray (gray
 * for zero on, or a log scale: `zeroGray.drawn` of the legend model), the
 * cells read where it is 0 gray; the others are in the color scale.
 *
 * @param {boolean} zeroGray - Whether the gene's zeros are drawn gray
 * @returns {string}
 */
export function geneSampleLayersNote(zeroGray) {
  return zeroGray ? 'Faded: not read · gray: 0' : 'Faded: not read';
}

/**
 * The one sentence that names a gene sample (`subsample-plan.js`,
 * `genes`): "Gene read for 40,000 of 455,000 cells" ("Genes read for …"
 * where it is about every gene, `plural`). Every place that shows a gene's
 * values says it in these words (the legend, the gene's notice, the Cells
 * to open line, the analyses' cell statement); a line that must fit the
 * narrowest panel writes the counts compactly (`format`: "40K of 455K
 * cells"), the exact sentence in its tooltip.
 *
 * @param {{cells: number, of: number}} genes
 * @param {{plural?: boolean, format?: (value: number) => string}} [options]
 * @returns {string}
 */
export function geneSampleText(genes, { plural = false, format = formatCount } = {}) {
  return `${plural ? 'Genes' : 'Gene'} read for ${format(genes.cells)} of ${format(genes.of)} ${countNoun(genes.of, 'cell')}`;
}

/**
 * What reading genes for more cells costs (`AnnDataReader.geneSampleCost`):
 * "1.6 GB, ~11 min 30 s", the time once the link is measured; "kept here,
 * nothing to download" when nothing is downloaded. `compact`: the words
 * beside the action, which fit the narrowest panel beside its button --
 * the time in its largest unit ("9.1 GB, ~1.3 h", "kept here"); the exact
 * words in its tooltip, which say when the cells' totals of normalized
 * values are part of it (`totals`, `state/managers/field/gene-sample.js`).
 *
 * @param {{bytes: number, ms: number|null, totals?: Object|null}} cost
 * @param {{compact?: boolean}} [options]
 * @returns {string}
 */
export function geneSampleCostText(cost, { compact = false } = {}) {
  if (!(cost.bytes > 0)) return compact ? 'kept here' : 'kept here, nothing to download';
  const time = cost.ms === null ? [] : [formatRemaining(cost.ms, { compact })];
  const totals = !compact && cost.totals != null ? ', with the cells\' totals of normalized values' : '';
  return `${[formatBytes(cost.bytes), ...time].join(', ')}${totals}`;
}

/**
 * Why a gene is read for a sample of the open cells (`genes`,
 * `geneSampleOf`), as fact rows: the sample, what sized it (the first
 * gene's time over this connection, or its index's memory) and what every
 * open cell would take, what this browser keeps of it, then the layout's
 * own rows. Empty for no sample.
 *
 * @param {{cells: number, of: number, fit: Object|null}|null} genes
 * @returns {FactRow[]}
 */
export function geneSampleFacts(genes) {
  if (genes === null || genes === undefined) return [];
  const fit = genes.fit ?? null;
  const rows = [{
    label: 'Genes read',
    value: `${formatCount(genes.cells)} of ${formatCountOf(genes.of, 'open cell')}`,
    title: `A gene is read for the first ${formatCountOf(genes.cells, 'open cell')}, a sample of them, and every later gene for the same cells. The others show no value until read (${GENES_READ_PLACE}).`,
  }];
  if (fit?.limit === 'geneTime') {
    rows.push({
      label: 'Sized to',
      value: `a gene in ${formatRemaining(fit.budgetMs)} here`,
      title: fit.neededMs === null
        ? `This connection is not measured yet on this visit (nothing was downloaded to open it), so the first gene of ${fit.matrix}, the matrix genes are read from, is read for the cells kept in this browser; it measures the connection, and genes are then read for more cells within the same time.`
        : `Every open cell would take ${formatRemaining(fit.neededMs)} for the first gene of ${fit.matrix}, the matrix genes are read from, on this connection.`,
    });
  } else if (fit?.limit === 'columnIndex') {
    rows.push({
      label: 'Sized to',
      value: `memory: needs ${formatBytes(fit.neededBytes)}, has ${formatBytes(fit.budgetBytes)}`,
      title: `The gene index of every open cell of ${fit.matrix} would hold ${formatBytes(fit.neededBytes)} in memory; this device keeps ${formatBytes(fit.budgetBytes)} for it beside the open cells.`,
    });
  } else if (fit?.limit === 'stream') {
    const size = fit.matrixBytes === null ? 'one compressed text stream' : `one compressed text stream of ${formatBytes(fit.matrixBytes)}`;
    rows.push({
      label: 'Sized to',
      value: genes.cells === 0 ? 'the matrix, arriving' : 'the matrix read so far',
      title: `${fit.matrix} is ${size}, read after the cells were drawn: genes are read for the cells its share holds ` +
        `(${formatCountOf(fit.fitCells, 'cell')} on this device), and reading genes for more cells (${GENES_READ_PLACE}) reads it again.`,
    });
  } else {
    rows.push({ label: 'Sized to', value: 'as chosen', title: `Read for these cells by choice (${GENES_READ_PLACE}, or the session).` });
  }
  const kept = fit?.kept ?? null;
  if (kept !== null) {
    rows.push({
      label: 'Kept here',
      value: [
        ...(kept.cells > 0 ? [`the gene index of ${formatCountOf(kept.cells, 'cell')}`] : []),
        ...(kept.bytes > 0 ? [`${formatBytes(kept.bytes)} of the matrix`] : []),
      ].join(', '),
      title: `Read on an earlier visit and kept in this browser: those cells cost the first gene no download, so genes are read for more cells within the same time (${STORED_PLACE}).`,
    });
  }
  return [...rows, ...(fit === null ? [] : geneLayoutFacts(fit.layout, { cells: genes.cells }) ?? [])];
}

/**
 * The plan of one gene read before it is read, or null when the gene reads
 * only its own entries (a gene-major matrix, or an index already built): a
 * short line (`summary`: what it reads and how long, and where its first
 * colors show) and the fact rows behind it (`rows`: why, from the layout,
 * and what follows).
 *
 * @param {Object|null} plan - `geneReadPlan`
 * @returns {{summary: string, rows: FactRow[]}|null}
 */
export function geneReadPlanFacts(plan) {
  if (plan === null || plan === undefined || !plan.cellMajor || plan.built) return null;
  const stored = plan.scan?.storedBytes ?? null;
  // What the read fetches: none of what this browser keeps of the file from
  // an earlier reading (`io/kept-parts.js`), which is read from this
  // machine's disk.
  const fetched = plan.scan?.fetchBytes ?? stored;
  const kept = stored !== null && fetched !== null && fetched < stored ? stored - fetched : 0;
  const size = fetched !== null ? formatBytes(fetched) : `${formatBytes(plan.scan.valueBytes)} as values`;
  const ms = fetched !== null && plan.bytesPerSecond > 0 ? (fetched * 1000) / plan.bytesPerSecond : null;
  const progressive = plan.progressive ?? null;
  const cells = progressive?.cells ?? plan.cells;
  const rest = progressive !== null && progressive.done > 0 ? progressive.cells - progressive.done : cells;
  const summary = [size, ...(ms === null ? [] : [formatRemaining(ms)]), ...(Number.isFinite(rest) ? [`${formatCountOf(rest, 'cell')} to read`] : [])].join(' · ');
  const amount = ms === null ? size : `${size}, ${formatRemaining(ms)} at the measured ${formatBytes(plan.bytesPerSecond)}/s`;
  const rows = geneLayoutFacts(plan.layout, { cells: rest, amount }) ??
    [{ label: 'One gene reads', value: `every cell's entries of ${plan.label} (${amount})`, title: `${plan.label} is stored cell by cell.` }];
  if (kept > 0) {
    rows.push({ label: 'Kept here', value: `${formatBytes(kept)} of ${formatBytes(stored)}`, title: `Downloaded on an earlier visit and kept in this browser: read from this computer, not downloaded again (${STORED_PLACE}).` });
  }
  if (progressive !== null && progressive.done > 0) {
    rows.push({ label: 'Indexed already', value: formatCountOf(progressive.done, 'open cell'), title: 'Their colors show at once; the others fill in as they are read, and show as missing until then.' });
  } else if (progressive !== null) {
    const first = progressive.nextStoredBytes !== null ? ` (${formatBytes(progressive.nextStoredBytes)})` : '';
    rows.push({ label: 'First colors', value: `on ${formatCount(progressive.next)} of ${formatCountOf(progressive.cells, 'cell')}${first}`, title: 'A sample of the open cells; the others fill in as they are read, and show as missing until then.' });
  }
  if (plan.sample != null) {
    rows.unshift({ label: 'Genes read', value: `${formatCount(plan.sample.cells)} of ${formatCountOf(plan.sample.of, 'open cell')}`, title: `A sample of the open cells; the others show no value until read (${GENES_READ_PLACE}).` });
  }
  const index = plan.index;
  if (index !== null && index.placement === null) {
    rows.push({ label: 'Gene index', value: 'cannot be kept: every gene reads it again', title: `${upperFirst(index.refusal)}. Opening a subsample of the cells makes the index fit.` });
  } else if (index !== null && index.passes === 2) {
    const again = index.secondPassStoredBytes !== null ? formatBytes(index.secondPassStoredBytes) : 'the matrix';
    rows.push({ label: 'Gene index', value: `${again} read once more, kept ${index.placement === 'disk' ? 'on disk' : 'in memory'}`, title: 'Later genes read only it.' });
  }
  return { summary, rows };
}

/**
 * `geneReadPlanFacts` as one text: the short line, then the rows (exported
 * for tests; the app shows the facts through `geneReadPlanFacts`).
 *
 * @param {Object|null} plan - `geneReadPlan`
 * @returns {string|null}
 */
export function describeGeneReadPlan(plan) {
  const facts = geneReadPlanFacts(plan);
  return facts === null ? null : `${facts.summary}.\n${factsText(facts.rows)}`;
}
