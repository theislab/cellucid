/**
 * Every analysis, on every way cells can be open, against an independent
 * reference on exactly the cells kept (`scripts/generate-subsample-analysis-fixtures.py`:
 * numpy, SciPy and pandas on the AnnData in memory, the kept cells from
 * `cellucid.subsample_cells`; `reference.json.sha256` catches a hand edit).
 *
 * Each opening is opened as the app opens it (`AnnDataFileSource`, the reader
 * worker in process, the request the link or the Cells to open control
 * gives): every cell of a file as given and of the same file in priority
 * order; uniform at the file's seed (a prefix of the priority file) and at
 * another seed; a smaller uniform at the file seed (a progressive opening
 * mid-growth, and the share lowered in place: nested in the larger one);
 * blocks; stratified, proportional and balanced; spatial; one (its
 * embedding refused: the control and link never ask for it) and two cells; the stores cellucid-python
 * and cellucid-r serve for the object (R's run from its sources by the
 * generator), whole and their uniform prefix. The open cells are checked to
 * be the ones `subsample_cells` keeps,
 * then each analysis kernel the app runs is given what the app gives it (the
 * open cells' codes and gene columns, in open order) and compared, cell by
 * cell through the original positions:
 *
 * - composition counts and dot plot sums, sizes and expressing counts:
 *   exactly (counts; sums of quarters are exact in float64);
 * - differential expression (Wilcoxon, Welch): sizes, U, means exactly (the
 *   same exact sums divided by the same counts); the fraction non-zero
 *   within 2 ulp (`x / n * 100` against `100 * x / n`); log2 fold change
 *   within 1e-13 relative (`expm1`, `log2` of each side's libm, at most an
 *   ulp each); Wilcoxon p within 1e-12 relative (the normal tail in
 *   float64 by other special-function code, as `analysis-scanpy-rank-genes-parity`
 *   measures); Welch t within 1e-10 (centred against raw moments) and its p
 *   within 3e-10: the app's incomplete beta (`tCDF`) stops its continued
 *   fraction once a factor is within 1e-10 of 1, so its relative error is a
 *   few 1e-10 (1.1e-10 measured here against SciPy's `stdtr`);
 * - the sparse block DE and markers read (`getMatrixCellSubset`, the
 *   groups' cells of every gene, in order and reversed, all of them and those
 *   among the first half of the open cells, which a priority file reads from
 *   those rows of each gene, as entries): the columns' values there, exactly;
 * - markers (one group against the rest, scanpy's z without tie
 *   correction): z within one float32 ulp (stored as float32), p within
 *   1e-12 relative;
 * - correlation: Pearson and Spearman within 1e-12 relative (float64 sums
 *   of a few hundred terms in another order);
 * - the mean signature score of each cell: exactly (float32 sums of
 *   quarters are exact, one division rounded once);
 * - the neighbour graph: the induced subgraph's edges, as pairs of original
 *   positions, and its largest weight, exactly;
 * - the vector field's vectors and the outlier quantiles, bit for bit: the
 *   ones `prepare()` stores are the whole dataset's, gathered (decision
 *   F-K7), and the served store, which stores none, computes them on the
 *   open cells and tags them as an estimate.
 *
 * Edge cases the openings make: categories with no, one or few open cells
 * (`rare`, `single`, `unused`), a gene with no non-zero open value (`RARE1`
 * in most subsamples, `EMPTY` always), NaN in a continuous obs column
 * (`score`), a group emptied by the subsample, one and two open cells.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { setNextCellSubsetRequest } from '../assets/js/data/cell-subset-policy.js';
import { compositionCounts } from '../assets/js/app/analysis/compute/composition-counts.js';
import { createGroupSummaryContext, summarizeGenesByGroup } from '../assets/js/app/analysis/compute/group-expression-summary.js';
import {
  createGroupingContext,
  geneSampleOf,
  groupMarkers,
  twoSampleDifferential,
} from '../assets/js/app/analysis/compute/gene-statistics.js';
import { computeCorrelation } from '../assets/js/app/analysis/compute/operation-handlers.js';
import { SignaturePageScorer } from '../assets/js/app/analysis/stats/signature-score.js';
import { mappingLatentOutlierPath } from '../assets/js/data/data-mapping-candidates.js';
import { outlierQuantilesEstimate } from '../assets/js/data/outlier-quantile-source.js';
import { LinkDataSource } from '../assets/js/data/link-source.js';
import { RemoteDataSource } from '../assets/js/data/remote-source.js';
import { ViewerHostDataSource } from '../assets/js/data/viewer-host-source.js';
import { viewerProtocolDocument } from '../assets/js/data/viewer-protocol.js';
import { DEFAULT_PROVIDERS, ProviderRegistry } from '../assets/js/data/sources/registry.js';
import './helpers/fake-host-socket.mjs';
import { zippedStoreEntries } from './helpers/zarr-corpus.mjs';

const FOLDER = new URL('./fixtures/subsample-analysis/', import.meta.url);
const REFERENCE_TEXT = readFileSync(new URL('reference.json', FOLDER), 'utf8');
const REFERENCE = JSON.parse(REFERENCE_TEXT);
const { genes: GENES, types: TYPES } = REFERENCE;
const LOG1P = { mode: 'log1p', base: null };

function quiet(t) {
  const notifications = getNotificationCenter();
  const names = ['startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload', 'warning', 'error', 'info', 'loading', 'complete', 'fail', 'dismiss'];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  for (const name of names) notifications[name] = () => `${name}-id`;
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  t.after(() => {
    for (const [name, method] of originals) notifications[name] = method;
    console.log = log;
    console.warn = warn;
  });
}

/** The opening as the app opens it: the open order (open cell i is original position order[i]) and its columns. */
async function open(t, opening) {
  const bytes = readFileSync(new URL(opening.file, FOLDER));
  // As the link and the Cells to open control ask: strictly.
  if (opening.request !== null) setNextCellSubsetRequest({ ...opening.request, strict: true });
  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  await source.loadFile(new File([bytes], opening.file));
  return viewOf(source.getAdapter());
}

/**
 * What the app gives the analyses of an open dataset: the open order (open
 * cell i is original position order[i]) and its columns, each read from
 * `matrix` (the expression's path: `X`, a layer, `raw/X`, a modality's).
 * A field the format cannot carry is null.
 */
async function viewOf(adapter, { matrix = 'X' } = {}) {
  const loader = adapter._loader;
  const k = loader.nObs;
  const order = loader.cellSubset?.openOrder ?? loader.cellSubset?.kept ?? Uint32Array.from({ length: k }, (_, i) => i);
  const keys = new Set(loader.obsKeys);
  // A text column (a Loom file's) is a field of its values, as the app
  // takes it: here codes by label, the labels in order of appearance.
  const field = async key => {
    if (!keys.has(key)) return null;
    const read = await loader.getObsField(key);
    if (read.dtype !== 'string') return read;
    const categories = [...new Set(read.values)];
    return { ...read, categories, codes: Uint16Array.from(read.values, value => categories.indexOf(value)) };
  };
  const cellType = await field('cell_type');
  const batch = await field('batch');
  const score = await field('score');
  const columns = await loader.getMatrixColumns(matrix, GENES.map((_, g) => g));
  const obsm = adapter.getMappingCandidates().obsm.map(item => item.key);
  const outliers = obsm.includes('X_pca') && cellType !== null
    ? () => {
      const entry = adapter.getObsFields().fields.find(item => item.key === 'cell_type');
      return adapter.getLatentOutlierQuantiles(mappingLatentOutlierPath(obsm.indexOf('X_pca'), entry.fieldIndex));
    }
    : null;
  const graphs = (adapter.getMappingCandidates().obsp ?? []).map(item => item.key);
  return { loader, matrix, k, order: Array.from(order), cellType, batch, score, columns, outliers, obsm, graphs };
}

function float32Ulp(value) {
  const f = Math.fround(Math.abs(value));
  if (f === 0) return 2 ** -149;
  return 2 ** (Math.floor(Math.log2(f)) - 23);
}

function close(actual, expected, relative, label) {
  if (expected === null || expected === undefined) {
    assert.ok(!Number.isFinite(actual), `${label}: expected none, got ${actual}`);
    return;
  }
  const scale = Math.max(Math.abs(expected), Number.MIN_VALUE);
  assert.ok(Math.abs(actual - expected) / scale <= relative, `${label}: ${actual} vs ${expected} (relative ${Math.abs(actual - expected) / scale})`);
}

const ulps = (actual, expected, count, label) => close(actual, expected, count * 2 ** -52, label);

/** Each open cell's type, by its category's label (the reference's order), -1 for none. */
function groupOf(codes, categories) {
  const index = categories.map(category => TYPES.indexOf(String(category)));
  const out = new Int32Array(codes.length);
  for (let i = 0; i < codes.length; i++) out[i] = codes[i] < categories.length ? index[codes[i]] : -1;
  return out;
}

test('the reference is the one the generator wrote, over the files beside it', () => {
  const sidecar = readFileSync(new URL('reference.json.sha256', FOLDER), 'utf8');
  assert.equal(sidecar, `${createHash('sha256').update(REFERENCE_TEXT).digest('hex')}  reference.json\n`);
  for (const [name, digest] of Object.entries(REFERENCE.files)) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(name, FOLDER))).digest('hex'), digest, name);
  }
  for (const [name, digest] of Object.entries(REFERENCE.classFiles)) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(`classes/${name}`, FOLDER))).digest('hex'), digest, name);
  }
  assert.equal(REFERENCE.openings.length, 18);
});

// The text-field opening is of formats that hold the field as text (below).
for (const opening of REFERENCE.openings.filter(entry => !entry.name.endsWith('-text'))) {
  test(`${opening.name}: every analysis on the open cells equals the reference on the kept cells`, async t => {
    quiet(t);
    const label = opening.name;
    if (opening.kept.length === 1) {
      // One cell has no coordinate variation to draw: the reader keeps the
      // one cell asked for (as `cellucid.subsample_cells` selects it), and
      // its embedding is refused, the rule a one-cell file is refused by
      // (docs: Data mapping, "no coordinate variation"). So the control
      // and the link never ask for it (`FEWEST_OPEN_CELLS`;
      // subsample-url-contract, subsample-address-and-control).
      await assert.rejects(open(t, opening), /no coordinate variation/);
      return;
    }
    await checkOpening(await open(t, opening), opening, { label, stored: !opening.file.startsWith('served') });
  });
}

/**
 * Every analysis of `view` against the reference of `opening` (module
 * doc). `stored`: the file stores the outlier quantiles (`prepare()`'s);
 * else they are computed on the open cells. A format that carries no
 * `batch`, `score`, vector field or graph skips what needs it.
 */
async function checkOpening(view, opening, { label, stored, allCategories = true }) {
  const { k, order } = view;

  // The open cells are exactly the kept ones, and the opening's own order
  // (priority order on a priority file or a uniform subsample).
  assert.equal(k, opening.kept.length, `${label}: open count`);
  assert.deepEqual([...order].sort((a, b) => a - b), opening.kept, `${label}: the kept cells`);
  // A stored categorical lists every category, the unused one too; a text
  // column (Loom, a table beside a matrix, a Cell Ranger clustering) the
  // values it holds, in its own order: each is matched by its label.
  if (allCategories) assert.deepEqual(view.cellType.categories, TYPES, `${label}: every category listed, the unused one too`);
  const typeOfCell = groupOf(view.cellType.codes, view.cellType.categories);
  order.forEach((p, i) => assert.equal(typeOfCell[i], REFERENCE.typeOfCell[p], `${label}: open cell ${i} type`));
  const positionOf = new Map(order.map((p, i) => [p, i]));

  // Composition: cell type by batch (each code to its label's place).
  if (view.batch !== null) {
    const indexOf = (categories, labels) => Int32Array.from(categories, category => labels.indexOf(String(category)));
    const counted = compositionCounts({
      typeCodes: view.cellType.codes,
      typeIndexOfCode: indexOf(view.cellType.categories, TYPES),
      typeCount: TYPES.length,
      sampleCodes: view.batch.codes,
      sampleIndexOfCode: indexOf(view.batch.categories, REFERENCE.batches),
      sampleCount: REFERENCE.batches.length,
      conditionCodes: null,
      conditionIndexOfCode: null,
      conditionCount: 1,
      scope: null,
    });
    const table = TYPES.map((_, type) => Array.from(counted.counts.subarray(type * counted.unitCount, (type + 1) * counted.unitCount)));
    assert.deepEqual(table, opening.composition, `${label}: composition`);
  }

  // Dot plot: sums, sizes and expressing counts per type.
  const summaryContext = createGroupSummaryContext(Int16Array.from(typeOfCell), TYPES.length);
  const dotGenes = REFERENCE.dotplotGenes;
  const summary = summarizeGenesByGroup(summaryContext, dotGenes.map(gene => view.columns[GENES.indexOf(gene)]), 0);
  dotGenes.forEach((gene, g) => {
    const want = opening.dotplot[gene];
    TYPES.forEach((type, group) => {
      const at = g * TYPES.length + group;
      assert.deepEqual(
        { size: summary.sizes[group], sum: summary.sum[at], expressing: summary.expressing[at] },
        want[group],
        `${label}: dot plot ${gene} in ${type}`,
      );
    });
  });

  // Differential expression, every gene, Wilcoxon and Welch.
  for (const pair of opening.de) {
    const a = Uint8Array.from(typeOfCell, type => (type === TYPES.indexOf(pair.a) ? 1 : 0));
    const b = Uint8Array.from(typeOfCell, type => (type === TYPES.indexOf(pair.b) ? 1 : 0));
    for (const want of pair.genes) {
      const values = view.columns[GENES.indexOf(want.gene)];
      const sideA = Float32Array.from(values.filter((_, cell) => a[cell] === 1));
      const sideB = Float32Array.from(values.filter((_, cell) => b[cell] === 1));
      const gl = `${label}: DE ${pair.a} vs ${pair.b} ${want.gene}`;
      const wilcox = twoSampleDifferential(geneSampleOf(sideA, 0), geneSampleOf(sideB, 1), 'wilcox', { pConvention: 'exact', foldChange: LOG1P });
      assert.equal(wilcox.nA, want.nA, `${gl} nA`);
      assert.equal(wilcox.nB, want.nB, `${gl} nB`);
      ulps(wilcox.pctA, want.pctA, 2, `${gl} % A`);
      ulps(wilcox.pctB, want.pctB, 2, `${gl} % B`);
      if (want.meanA === undefined) {
        // Under two cells a side: nothing is tested, nothing is invented.
        for (const key of ['meanA', 'meanB', 'log2FoldChange', 'pValue', 'statistic']) {
          assert.ok(Number.isNaN(wilcox[key]), `${gl}: ${key} with ${want.nA} and ${want.nB} cells`);
        }
        continue;
      }
      assert.equal(wilcox.meanA, want.meanA, `${gl} mean A`);
      assert.equal(wilcox.meanB, want.meanB, `${gl} mean B`);
      close(wilcox.log2FoldChange, want.log2FoldChange, 1e-13, `${gl} log2FC`);
      assert.equal(wilcox.statistic, want.U, `${gl} U`);
      if (want.pWilcox === null) {
        // Every value of both sides tied (SciPy: 0 / 0): no evidence of a
        // difference, which the app reports as p = 1.
        assert.equal(new Set([...sideA, ...sideB]).size, 1, `${gl}: SciPy has no p only when every value is tied`);
        assert.equal(wilcox.pValue, 1, `${gl}: p of a tied gene`);
      } else {
        close(wilcox.pValue, want.pWilcox, 1e-12, `${gl} Wilcoxon p (${want.wilcoxMethod})`);
      }
      const welch = twoSampleDifferential(geneSampleOf(sideA, 0), geneSampleOf(sideB, 1), 'ttest', { foldChange: LOG1P });
      if (want.t !== undefined) {
        close(welch.score, want.t, 1e-10, `${gl} t`);
        close(welch.pValue, want.pT, 3e-10, `${gl} Welch p`);
      }
    }
  }

  // The read Differential expression and Marker genes take: the groups'
  // cells of every gene as a sparse block (`getMatrixCellSubset`), the
  // columns' values there, bit for bit, cells given out of order too.
  {
    const groupCells = [...typeOfCell.keys()].filter(cell => typeOfCell[cell] === 0 || typeOfCell[cell] === 1);
    // Also among the first open cells only (a first pass's sample): read
    // from those rows of each gene.
    const firstHalf = groupCells.filter(cell => cell < k / 2);
    for (const cells of [groupCells, [...groupCells].reverse(), firstHalf, [...firstHalf].reverse()]) {
      if (cells.length === 0) continue;
      const genes = GENES.map((_, g) => g);
      const block = await view.loader.getMatrixCellSubset(view.matrix, cells, genes);
      const pointers = [0];
      const cellIndex = [];
      const values = [];
      genes.forEach(g => {
        const entries = cells.flatMap((cell, i) => (view.columns[g][cell] !== 0 ? [[i, view.columns[g][cell]]] : [])).sort((x, y) => x[0] - y[0]);
        for (const [i, value] of entries) { cellIndex.push(i); values.push(value); }
        pointers.push(cellIndex.length);
      });
      assert.deepEqual(Array.from(block.pointers), pointers, `${label}: cell subset pointers`);
      assert.deepEqual(Array.from(block.cellIndex), cellIndex, `${label}: cell subset cells`);
      assert.deepEqual(Array.from(block.values), values, `${label}: cell subset values`);
    }
  }

  // Markers: each type against the rest of the open cells.
  const context = createGroupingContext(typeOfCell, TYPES.length);
  GENES.forEach((gene, g) => {
    const result = groupMarkers(geneSampleOf(view.columns[g]), context, { method: 'wilcox', minCells: 1, pConvention: 'normal', foldChange: LOG1P });
    TYPES.forEach((type, group) => {
      const want = opening.markers[type];
      const gl = `${label}: markers ${type} ${gene}`;
      if (want === undefined) {
        // A type, or its rest, of under two open cells: no test.
        assert.ok(Number.isNaN(result.pValues[group]), `${gl}: untested`);
        return;
      }
      const row = want.genes[g];
      if (row.score === null) {
        assert.ok(!Number.isFinite(result.scores[group]) || Number.isNaN(result.pValues[group]), `${gl}: no score`);
        return;
      }
      assert.ok(Math.abs(result.scores[group] - row.score) <= float32Ulp(row.score), `${gl} z: ${result.scores[group]} vs ${row.score}`);
      close(result.pValues[group], row.p, 1e-12, `${gl} p`);
    });
  });

  // Correlation: gene with gene, gene with a continuous obs column (NaN in it).
  for (const want of opening.correlation) {
    if (view.score === null && (want.x === 'score' || want.y === 'score')) continue;
    const valuesOf = name => (name === 'score' ? view.score.values : view.columns[GENES.indexOf(name)]);
    for (const method of ['pearson', 'spearman']) {
      const gl = `${label}: ${method} ${want.x} ~ ${want.y}`;
      const result = computeCorrelation({ xValues: valuesOf(want.x), yValues: valuesOf(want.y), method });
      if (want.n < 3) {
        assert.ok(Number.isNaN(result.r), gl);
        continue;
      }
      assert.equal(result.n, want.n, `${gl} n`);
      if (want[method] === undefined) {
        // A variable constant on the open cells (a gene with no open
        // non-zero): SciPy has no coefficient; the app reports r = 0 and
        // p = 1, no evidence of a correlation (`pearsonFromCentredMoments`).
        assert.deepEqual([result.r, result.pValue], [0, 1], `${gl}: a constant variable`);
        continue;
      }
      close(result.r, want[method], 1e-12, gl);
    }
  }

  // The mean signature score of every cell, by original position.
  const scorer = new SignaturePageScorer({
    method: 'mean',
    geneCount: REFERENCE.signature.length,
    cellIndices: Uint32Array.from({ length: k }, (_, i) => i),
    pointCount: k,
  });
  for (const gene of REFERENCE.signature) scorer.addGene(view.columns[GENES.indexOf(gene)]);
  scorer.scoreCells(0, k);
  opening.kept.forEach((p, rank) => {
    assert.equal(scorer.scores[positionOf.get(p)], opening.signature[rank], `${label}: signature of cell ${p}`);
  });

  // The neighbour graph on the open cells: the induced subgraph, its
  // edges named by original positions.
  if (view.graphs.includes('connectivities')) {
    const edges = await view.loader.getConnectivityEdges('connectivities');
    const pairs = [];
    for (let cell = 0; cell < k; cell++) {
      const forward = edges.forwardOffsets[cell + 1] - edges.forwardOffsets[cell];
      const end = edges.neighborOffsets[cell + 1];
      for (let e = end - forward; e < end; e++) {
        const [p, q] = [order[cell], order[edges.neighbors[e]]];
        pairs.push(p < q ? [p, q] : [q, p]);
      }
    }
    pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    assert.equal(edges.nEdges, opening.graph.edges, `${label}: graph edges`);
    assert.equal(
      createHash('sha256').update(pairs.map(([p, q]) => `${p},${q}\n`).join('')).digest('hex'),
      opening.graph.pairsSha256,
      `${label}: graph edges are the kept cells' pairs`,
    );
    if (opening.graph.maxWeight !== null) assert.equal(edges.maxWeight, opening.graph.maxWeight, `${label}: graph largest weight`);
  }

  // Per-cell overlays, by original position: the vector field's vectors,
  // and the outlier quantiles of cell_type in X_pca: the file's (stored
  // by prepare(): the whole dataset's, gathered) or, from the served store
  // that stores none, computed on the open cells.
  const ascending = [...order.keys()].sort((a, b) => order[a] - order[b]);
  const byOriginal = (values, width = 1) => {
    const out = new Float32Array(values.length);
    ascending.forEach((open, rank) => { for (let c = 0; c < width; c++) out[rank * width + c] = values[open * width + c]; });
    return out;
  };
  const sha = values => createHash('sha256').update(Buffer.from(values.buffer, values.byteOffset, values.byteLength)).digest('hex');
  if (view.obsm.includes('velocity_umap')) {
    assert.equal(sha(byOriginal(await view.loader.readObsmColumns('velocity_umap', [0, 1]), 2)), opening.overlays.velocitySha256, `${label}: velocity`);
  }
  if (view.outliers === null) return;
  const quantiles = await view.outliers();
  assert.equal(
    sha(byOriginal(quantiles)),
    stored ? opening.overlays.outliersStoredSha256 : opening.overlays.outliersOpenSha256,
    `${label}: outlier quantiles ${stored ? 'stored (whole dataset)' : 'computed on the open cells'}`,
  );
  assert.deepEqual(outlierQuantilesEstimate(quantiles), stored || k === REFERENCE.nObs ? null : { open: k, of: REFERENCE.nObs }, `${label}: estimate`);
}

// ---------------------------------------------------------------------------
// Every class of source and format. The same cells, written in every format
// and matrix kind the app opens (`classes/`, the generator's
// `format_classes`, each in the cells' given order), and read from every
// kind of source, are held to the same references: a subsample's kept cells
// are original positions, whatever stores them.

const CLASSES = new URL('classes/', FOLDER);
const ALL_GIVEN = REFERENCE.openings.filter(opening => opening.file === 'given.zarr.zip' || opening.name === 'spatial' || opening.name === 'stratified-proportional')
  .filter(opening => ['all-given', 'uniform-file-seed-given', 'blocks', 'stratified-balanced', 'stratified-proportional', 'spatial', 'two-cells'].includes(opening.name));
// A format that holds the field as text (`allCategories: false`) stratifies
// by its labels in code-point order.
const TEXT_STRATIFIED = REFERENCE.openings.find(opening => opening.name === 'stratified-balanced-text');
const openingsOf = item => (item.allCategories === false
  ? [...ALL_GIVEN.filter(opening => !opening.name.startsWith('stratified')), TEXT_STRATIFIED]
  : ALL_GIVEN);
// Openings whose cells do not depend on the order a store keeps (blocks are
// runs of the file's order): what a store in priority order is held to.
const ORDER_FREE = ALL_GIVEN.filter(opening => opening.name !== 'blocks');

/** Every file below a fixture folder, as a picked folder gives them (`webkitRelativePath`). */
function pickedFolder(name) {
  const root = fileURLToPath(new URL(name, CLASSES));
  const files = [];
  const walk = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const file = new File([readFileSync(full)], entry.name);
        Object.defineProperty(file, 'webkitRelativePath', { value: `${name}/${path.relative(root, full).split(path.sep).join('/')}` });
        files.push(file);
      }
    }
  };
  walk(root);
  return files;
}

/** Every file below a fixture folder, by its path inside it. */
function folderEntries(name) {
  return new Map(pickedFolder(name).map(file => [file.webkitRelativePath.slice(name.length + 1), file]));
}

const FORMAT_CLASSES = [
  { name: '.h5ad, CSR X', file: 'csr.h5ad' },
  { name: '.h5ad, CSC X', file: 'csc.h5ad' },
  { name: '.h5ad, dense X', file: 'dense.h5ad' },
  { name: '.h5ad, the expression in a layer', file: 'layer.h5ad', matrix: 'layers/counts' },
  { name: '.h5ad, the expression in raw', file: 'raw.h5ad', matrix: 'raw/X' },
  { name: 'Zarr v3 zip', file: 'v3.zarr.zip' },
  { name: 'Zarr v2 folder', folder: 'v2.zarr' },
  { name: 'MuData .h5mu, a modality', file: 'mudata.h5mu', matrix: 'mod/rna/X' },
  { name: 'MuData Zarr zip, a modality', file: 'mudata.zarr.zip', matrix: 'mod/rna/X' },
  { name: 'Loom', file: 'cells.loom', allCategories: false },
  { name: 'SingleCellExperiment .rds (converted)', file: 'sce.rds' },
  { name: 'Seurat .rds (converted)', file: 'seurat.rds' },
  { name: 'MatrixMarket folder with a cell table (converted)', folder: 'mtx', allCategories: false },
  { name: 'Cell Ranger outs/ folder', folder: 'outs', allCategories: false },
];

/** A file's or folder's adapter, opened from this computer with `request`. */
async function openLocalClass(t, item, request) {
  if (request !== null) setNextCellSubsetRequest({ ...request, strict: true });
  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  if (item.folder !== undefined) await source.loadFolder(pickedFolder(item.folder));
  else await source.loadFile(new File([readFileSync(new URL(item.file, CLASSES))], item.file));
  return source.getAdapter();
}

for (const item of FORMAT_CLASSES) {
  test(`${item.name}, opened from this computer: every analysis of every subsample equals the reference`, async t => {
    quiet(t);
    for (const opening of openingsOf(item)) {
      const label = `${item.name} ${opening.name}`;
      const adapter = await openLocalClass(t, item, opening.request);
      await checkOpening(await viewOf(adapter, { matrix: item.matrix }), opening, { label, stored: false, allCategories: item.allCategories ?? true });
    }
  });
}

function bytesAnswer(bytes, init) {
  const base = { 'Accept-Ranges': 'bytes', ETag: `"${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}"` };
  const range = new Headers(init?.headers ?? {}).get('Range');
  if ((init?.method ?? 'GET') === 'HEAD') return new Response(null, { status: 200, headers: { ...base, 'Content-Length': String(bytes.length) } });
  if (range !== null) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = Number(match[1]);
    const end = match[2] === '' ? bytes.length - 1 : Math.min(Number(match[2]), bytes.length - 1);
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1) },
    });
  }
  return new Response(bytes.slice(), { status: 200, headers: { ...base, 'Content-Length': String(bytes.length) } });
}

const jsonAnswer = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** Answer fetch from `route(url, init)`; what it does not answer is a 404. */
function host(t, route) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init.signal?.aborted) throw init.signal.reason;
    return (await route(url, init)) ?? new Response('not found', { status: 404 });
  };
  t.after(() => { globalThis.fetch = original; });
}

async function openLink(t, link, request) {
  if (request !== null) setNextCellSubsetRequest({ ...request, strict: true });
  const source = new LinkDataSource({ registry: new ProviderRegistry(DEFAULT_PROVIDERS) });
  const connection = await source.connect(link);
  t.after(() => source.disconnect());
  const id = connection.defaultDatasetId ?? connection.datasets[0].id;
  await source.getMetadata(id);
  return source.getAnnDataSource(id).getAdapter();
}

const WEB = 'https://data.example.org/cells/';

test('every format by a link (a web address), and a Zarr folder over HTTP: every analysis of every subsample equals the reference', async t => {
  quiet(t);
  const v2 = folderEntries('v2.zarr');
  host(t, async (url, init) => {
    if (!url.startsWith(WEB)) return null;
    const name = decodeURIComponent(url.slice(WEB.length));
    if (name.startsWith('v2.zarr/')) {
      const file = v2.get(name.slice('v2.zarr/'.length));
      return file === undefined ? null : bytesAnswer(new Uint8Array(await file.arrayBuffer()), init);
    }
    try {
      return bytesAnswer(new Uint8Array(readFileSync(new URL(name, CLASSES))), init);
    } catch {
      return null;
    }
  });
  for (const item of [...FORMAT_CLASSES.filter(entry => entry.file !== undefined), { name: 'Zarr v2 folder over HTTP', file: 'v2.zarr/' }]) {
    for (const opening of openingsOf(item)) {
      const label = `${item.name} by link ${opening.name}`;
      const adapter = await openLink(t, `${WEB}${item.file}`, opening.request);
      await checkOpening(await viewOf(adapter, { matrix: item.matrix }), opening, { label, stored: false, allCategories: item.allCategories ?? true });
    }
  }
});

test('folders on a host (a set of files: MatrixMarket, Cell Ranger outs/): every analysis of every subsample equals the reference', async t => {
  quiet(t);
  for (const item of FORMAT_CLASSES.filter(entry => entry.folder !== undefined && entry.folder !== 'v2.zarr')) {
    const files = folderEntries(item.folder);
    host(t, async (url, init) => {
      const name = url.startsWith(`${WEB}${item.folder}/`) ? decodeURIComponent(url.slice(`${WEB}${item.folder}/`.length)) : null;
      return name !== null && files.has(name) ? bytesAnswer(new Uint8Array(await files.get(name).arrayBuffer()), init) : null;
    });
    const remote = new Map([...files].map(([name, file]) => [name, { url: `${WEB}${item.folder}/${name}`, size: file.size, name: name.split('/').at(-1) }]));
    for (const opening of openingsOf(item)) {
      if (opening.request !== null) setNextCellSubsetRequest({ ...opening.request, strict: true });
      const source = new AnnDataFileSource();
      t.after(() => source.clear());
      await source.loadRemoteFileSet({ files: remote, rootName: item.folder });
      await checkOpening(await viewOf(source.getAdapter()), opening, { label: `${item.name} on a host ${opening.name}`, stored: false, allCategories: false });
    }
  }
});

test('link providers (Zenodo, GitHub, Figshare through a signed redirect): every analysis of a subsample equals the reference', async t => {
  quiet(t);
  const bytes = new Uint8Array(readFileSync(new URL('csr.h5ad', CLASSES)));
  host(t, (url, init) => {
    if (url === 'https://zenodo.org/api/records/7') {
      return jsonAnswer({ id: 9, conceptrecid: '7', doi: '10.5281/zenodo.9', metadata: { title: 'Cells', license: { id: 'cc-by-4.0' } }, files: [{ key: 'csr.h5ad', size: bytes.length, checksum: 'md5:bb' }] });
    }
    if (url === 'https://zenodo.org/api/records/9/files/csr.h5ad/content') return bytesAnswer(bytes, init);
    if (url === 'https://raw.githubusercontent.com/owner/repo/HEAD/data/csr.h5ad') return bytesAnswer(bytes, init);
    if (url === 'https://api.figshare.com/v2/articles/16566057') {
      return jsonAnswer({
        id: 16566057, version: 1, title: 'csr.h5ad', doi: '10.6084/m9.figshare.16566057.v1',
        figshare_url: 'https://figshare.com/articles/dataset/cells/16566057', license: { name: 'CC BY 4.0' },
        files: [{ id: 30639279, name: 'csr.h5ad', size: bytes.length, computed_md5: 'abc', is_link_only: false }],
      });
    }
    if (url === 'https://ndownloader.figshare.com/files/30639279') {
      const response = bytesAnswer(bytes, init);
      Object.defineProperty(response, 'url', { value: 'https://s3.example.org/f?X-Amz-Expires=3600&X-Amz-Signature=sig' });
      return response;
    }
    if (url.startsWith('https://s3.example.org/f?')) return bytesAnswer(bytes, init);
    return null;
  });
  for (const link of ['zenodo:7', 'gh:owner/repo/data/csr.h5ad', 'figshare:16566057']) {
    for (const opening of ALL_GIVEN.filter(entry => ['uniform-file-seed-given', 'stratified-balanced'].includes(entry.name))) {
      const adapter = await openLink(t, link, opening.request);
      await checkOpening(await viewOf(adapter), opening, { label: `${link} ${opening.name}`, stored: false });
    }
  }
});

/** A `cellucid serve` (Python) or `cellucid_serve()` (R) of a store, its keys answered by a fake host. */
function servedHost(t, keys, runtime) {
  const file = { url: '_cellucid/anndata/cells.zarr/', kind: 'zarr', layout: 'folder' };
  const counts = { n_cells: REFERENCE.nObs, n_genes: GENES.length };
  host(t, (url, init) => {
    const where = decodeURIComponent(new URL(url).pathname.slice(1));
    if (where === '_cellucid/health') return jsonAnswer({ status: 'ok', type: 'anndata', version: '1.2.3', format: 'zarr', ...counts });
    if (where === '_cellucid/info') return jsonAnswer({ version: '1.2.3', type: 'anndata', format: 'zarr', host: '127.0.0.1', port: 8765, ...counts, runtime });
    if (where === '_cellucid/protocol') return jsonAnswer(viewerProtocolDocument());
    if (where === '_cellucid/datasets') return jsonAnswer({ datasets: [{ id: 'cells', name: 'Served cells', anndata: { file, defaults: {} } }] });
    if (where.startsWith(file.url)) {
      const bytes = keys.get(where.slice(file.url.length));
      return bytes === undefined ? null : bytesAnswer(bytes, init);
    }
    return null;
  });
}

for (const [store, runtime] of [['served.zarr.zip', 'python'], ['served-r.zarr.zip', 'r']]) {
  test(`${runtime === 'r' ? 'R' : 'Python'} serving an object, read over HTTP and by the viewer host a notebook opens: every analysis equals the reference`, async t => {
    quiet(t);
    const keys = await zippedStoreEntries(fileURLToPath(new URL(store, FOLDER)));
    servedHost(t, keys, runtime);
    for (const opening of ORDER_FREE.filter(entry => ['uniform-file-seed-given', 'stratified-balanced', 'spatial'].includes(entry.name))) {
      setNextCellSubsetRequest({ ...opening.request, strict: true });
      const remote = new RemoteDataSource();
      await remote.connect({ url: 'http://127.0.0.1:8765' });
      t.after(() => remote.disconnect());
      await remote.listDatasets();
      await remote.getMetadata('cells');
      await checkOpening(await viewOf(remote.getAnnDataSource().getAdapter()), opening, { label: `${store} served ${opening.name}`, stored: false });

      const previousWindow = globalThis.window;
      globalThis.window = { location: new URL('http://127.0.0.1:8765/?viewer=true&viewerId=viewer-1&viewerToken=secret-1&anndata=true') };
      t.after(() => { globalThis.window = previousWindow; });
      setNextCellSubsetRequest({ ...opening.request, strict: true });
      const viewerHost = new ViewerHostDataSource({ serverUrl: 'http://127.0.0.1:8765', viewerId: 'viewer-1', viewerToken: 'secret-1' });
      assert.equal(await viewerHost.initialize(), true);
      t.after(() => viewerHost.disconnect());
      await viewerHost.listDatasets();
      await viewerHost.getMetadata('cells');
      await checkOpening(await viewOf(viewerHost.getAnnDataSource().getAdapter()), opening, { label: `${store} viewer host ${opening.name}`, stored: false });
    }
  });
}

test('a MatrixMarket folder whose first gene or cell starts like a header word (IDH1, cell0) keeps it: a header is a whole word', async t => {
  quiet(t);
  const file = (name, text) => {
    const made = new File([text], name);
    Object.defineProperty(made, 'webkitRelativePath', { value: `words/${name}` });
    return made;
  };
  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  await source.loadFolder([
    file('matrix.mtx', '%%MatrixMarket matrix coordinate real general\n3 4 4\n1 1 1\n2 2 2\n3 3 3\n1 4 4\n'),
    file('features.tsv', 'IDH1\tIDH1\tGene Expression\nID2\tID2\tGene Expression\nGene1\tGene1\tGene Expression\n'),
    file('barcodes.tsv', 'cell0\ncell1\ncells_2\ncell_3\n'),
    file('cells.tsv', 'barcode\tUMAP_1\tUMAP_2\ncell0\t0\t1\ncell1\t1\t0\ncells_2\t2\t2\ncell_3\t3\t1\n'),
  ]);
  const loader = source.getAdapter()._loader;
  assert.equal(loader.nObs, 4);
  const columns = await loader.getMatrixColumns('X', [0, 1, 2]);
  // By original position: the gene list and every cell are the files'.
  const order = loader.cellSubset?.openOrder ?? Uint32Array.from({ length: 4 }, (_, i) => i);
  const byOriginal = column => Array.from(order.keys()).sort((a, b) => order[a] - order[b]).map(cell => column[cell]);
  assert.deepEqual(columns.map(byOriginal), [[1, 0, 0, 4], [0, 2, 0, 0], [0, 0, 3, 0]]);
});
