/**
 * Text matrices read map first, their matrix after it, keeping only the
 * share genes are read for (`assets/js/data/anndata/transcode/matrix-market.js`),
 * and the seek decoder that measured why a single gzip member cannot be read
 * in the middle without an index (`assets/js/formats/io/deflate-seek.js`).
 */

import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
// The plans asserted here weigh this machine's speed: held at rest (`helpers/machine-at-rest.mjs`).
import './helpers/machine-at-rest.mjs';
import zlib from 'node:zlib';

import { openDatasetStore, openTranscodedStore } from '../assets/js/data/anndata/open.js';
import { cellPriority } from '../assets/js/data/anndata/transcode/priority.js';
import { matrixMarketSets, shareFit } from '../assets/js/data/anndata/transcode/matrix-market.js';
import { child } from '../assets/js/data/anndata/elements.js';
import { DecodedBudget } from '../assets/js/formats/io/decoded-budget.js';
import { matrixMarketFileSets, isMatrixMarketMatrix } from '../assets/js/data/matrix-market-files.js';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { DeflateDecoder, MARKER, findBlockStart, gzipHeader } from '../assets/js/formats/io/deflate-seek.js';
import { heldPrefix } from '../assets/js/data/anndata/subsample-plan.js';
import { matrixArrived } from './helpers/matrix-share.mjs';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';

const t_after = [];
test.after(() => { for (const close of t_after) close(); });
import { opfsOnDisk } from './helpers/opfs-on-disk.mjs';
import { until } from './helpers/until.mjs';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { TRANSCODED_DIRECTORY } from '../assets/js/data/anndata/transcode/space.js';

const CACHE_BYTES = 1 << 24;

/** A cell-sorted count matrix of `nCells` × `nGenes` (features × cells, Cell Ranger's way) and its entries by cell. */
function countMatrix(nCells, nGenes, { seed = 7, perCell = 6 } = {}) {
  let state = seed;
  const next = () => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 4294967296);
  const byCell = [];
  const lines = [];
  for (let cell = 0; cell < nCells; cell++) {
    const genes = new Set();
    while (genes.size < Math.min(perCell, nGenes)) genes.add(Math.floor(next() * nGenes));
    const entries = [...genes].sort((a, b) => a - b).map(gene => [gene, 1 + Math.floor(next() * 9)]);
    byCell.push(entries);
    for (const [gene, value] of entries) lines.push(`${gene + 1} ${cell + 1} ${value}`);
  }
  const text = ['%%MatrixMarket matrix coordinate integer general', `${nGenes} ${nCells} ${lines.length}`, ...lines].join('\n') + '\n';
  return { text, byCell };
}

/** A File that counts the bytes read of it. */
function countedFile(bytes, name, counts) {
  class Counted extends File {
    slice(start = 0, end = this.size, type) {
      counts.set(name, (counts.get(name) ?? 0) + (Math.min(end, this.size) - start));
      return super.slice(start, end, type);
    }
  }
  return new Counted([bytes], name, { lastModified: 1 });
}

/** A Cell Ranger-like folder: the matrix, its lists, a table with UMAP columns. */
function folder(nCells, nGenes, { counts = new Map(), gzip = false, ...options } = {}) {
  const { text, byCell } = countMatrix(nCells, nGenes, options);
  const barcodes = Array.from({ length: nCells }, (_, i) => `CELL${i}-1`);
  const table = ['barcode,UMAP_1,UMAP_2,group', ...barcodes.map((cell, i) => `${cell},${i % 17},${(i * 7) % 23},g${i % 3}`)].join('\n') + '\n';
  const features = Array.from({ length: nGenes }, (_, g) => `ENSG${g}\tGENE${g}\tGene Expression`).join('\n') + '\n';
  const matrix = gzip ? zlib.gzipSync(text) : new TextEncoder().encode(text);
  const files = new Map([
    ['f/matrix.mtx' + (gzip ? '.gz' : ''), countedFile(matrix, 'matrix', counts)],
    ['f/features.tsv', countedFile(new TextEncoder().encode(features), 'features', counts)],
    ['f/barcodes.tsv', countedFile(new TextEncoder().encode(barcodes.join('\n') + '\n'), 'barcodes', counts)],
    ['f/cells.csv', countedFile(new TextEncoder().encode(table), 'cells', counts)],
  ]);
  return { source: { files, rootName: 'f' }, byCell, matrixBytes: matrix.length };
}

/** Each store row's entries of a cells × genes CSR group, as `[gene, value]` pairs. */
async function rowsOf(root, path = 'X') {
  const group = child(root, path);
  const [indptr, indices, data] = await Promise.all(['indptr', 'indices', 'data'].map(name => group.get(name).read()));
  const rows = [];
  for (let r = 0; r + 1 < indptr.length; r++) {
    const row = [];
    for (let k = Number(indptr[r]); k < Number(indptr[r + 1]); k++) row.push([Number(indices[k]), Number(data[k])]);
    rows.push(row);
  }
  return { format: group.attrs?.['encoding-type'] ?? null, rows };
}

const openFolder = (source, transcoding = { memory: true }) => openDatasetStore({ source }, { decodedChunkCacheBytes: CACHE_BYTES, transcoding });

test('sci-RNA-seq3 uploads pair their matrix with their cell and gene tables (GEO GSE119945, GSE186069, GSE228590)', () => {
  const moca = matrixMarketFileSets(['GSE119945_cell_annotate.csv.gz', 'GSE119945_gene_annotate.csv.gz', 'GSE119945_gene_count.txt.gz']);
  assert.deepEqual(moca.sets.map(set => [set.matrix, set.cells, set.features]), [
    ['GSE119945_gene_count.txt.gz', 'GSE119945_cell_annotate.csv.gz', 'GSE119945_gene_annotate.csv.gz'],
  ]);
  const runs = matrixMarketFileSets([
    'GSE228590_cell_annotation.run_13.csv.gz', 'GSE228590_cell_annotation.run_14.csv.gz', 'GSE228590_gene_annotation.csv.gz',
    'GSE228590_gene_count.run_13.mtx.gz', 'GSE228590_gene_count.run_14.mtx.gz',
  ]);
  assert.deepEqual(runs.sets.map(set => [set.matrix, set.cells, set.features]), [
    ['GSE228590_gene_count.run_13.mtx.gz', 'GSE228590_cell_annotation.run_13.csv.gz', 'GSE228590_gene_annotation.csv.gz'],
    ['GSE228590_gene_count.run_14.mtx.gz', 'GSE228590_cell_annotation.run_14.csv.gz', 'GSE228590_gene_annotation.csv.gz'],
  ]);
  assert.deepEqual(runs.problems, []);
  assert.equal(isMatrixMarketMatrix('GSE119945_gene_count.txt.gz'), true);
  assert.equal(isMatrixMarketMatrix('GSE131907_Lung_Cancer_raw_UMI_matrix.txt.gz'), false, 'a .txt is a matrix only as a gene_count beside its tables');
  // Without its tables, a gene_count.txt is a matrix whose tables are named as missing, on this computer as on a host.
  const lone = matrixMarketSets(new Map([['GSE1_gene_count.txt.gz', {}], ['GSE1_cell_annotate.csv.gz', {}]]));
  assert.equal(lone.length, 1);
  assert.equal(lone[0].features, null);
  assert.match(lone[0].problem, /GSE1_gene_count\.txt\.gz has no GSE1_gene_annotate\.csv\.gz beside it, so its features are not named/);
});

test('a cell list that is a table (MOCA): its header is dropped by count, its columns are obs, its tsne columns obsm; gene names from gene_short_name', async () => {
  const nCells = 300;
  const { text } = countMatrix(nCells, 5);
  const cells = Array.from({ length: nCells }, (_, i) => `sci3-me-001.CELL${i}`);
  const annotation = ['sample,id,sex,day,tsne_1,tsne_2,Main_Cluster', ...cells.map((cell, i) => `${cell},${i},F,13.5,${i % 11},${i % 13},${i % 4}`)].join('\n') + '\n';
  const genes = ['gene_id,gene_type,gene_short_name', ...Array.from({ length: 5 }, (_, g) => `ENSMUSG${g}.5,protein_coding,Gene${g}`)].join('\n') + '\n';
  const files = new Map([
    ['m/GSE1_gene_count.mtx', new File([text], 'GSE1_gene_count.mtx')],
    ['m/GSE1_cell_annotate.csv', new File([annotation], 'GSE1_cell_annotate.csv')],
    ['m/GSE1_gene_annotate.csv', new File([genes], 'GSE1_gene_annotate.csv')],
  ]);
  // GSE119945's matrix is a .txt, MatrixMarket by content: a link's provider names the format (`geo.js`).
  const txt = new Map([...files].map(([path, file]) => (path.endsWith('.mtx') ? ['m/GSE1_gene_count.txt', new File([text], 'GSE1_gene_count.txt')] : [path, file])));
  const fromLink = await openDatasetStore({ source: { files: txt, rootName: 'm' }, expect: { format: 'mtx', layout: 'folder' } }, { decodedChunkCacheBytes: CACHE_BYTES, transcoding: { memory: true } });
  assert.ok(child(fromLink.root, 'obsm/X_tsne') !== null);
  const source = new AnnDataFileSource();
  try {
    await source.loadFolder([...files].map(([path, file]) => {
      Object.defineProperty(file, 'webkitRelativePath', { value: path });
      return file;
    }));
    await matrixArrived(source.getAdapter());
    const loader = source.getAdapter()._loader;
    assert.equal(loader.nObs, nCells);
    assert.ok(loader.obsKeys.includes('Main_Cluster') && loader.obsKeys.includes('sex'), loader.obsKeys.join(', '));
    assert.deepEqual([...(await loader.readVarNames('X', null)).index], ['Gene0', 'Gene1', 'Gene2', 'Gene3', 'Gene4']);
  } finally {
    source.clear();
  }
});

test('a matrix larger than its map is read after it: the map has no entry, and the share kept holds exactly the first rows in priority order', async () => {
  const nCells = 4000;
  const nGenes = 40;
  const { source, byCell, matrixBytes } = folder(nCells, nGenes);
  const opened = await openFolder(source);
  const stream = opened.matrixStream;
  assert.ok(stream !== null && stream.held === 0, 'the map holds no matrix row');
  assert.equal(stream.nObs, nCells);
  assert.equal(stream.bytes, matrixBytes);
  const map = await rowsOf(opened.root);
  assert.equal(map.rows.length, nCells);
  assert.ok(map.rows.every(row => row.length === 0), 'an X with no entry yet');

  const G = 1234;
  const { store, held } = await stream.ensure(G);
  assert.equal(held, G);
  const { root } = await openTranscodedStore(store, { name: 'f', layout: 'folder', decodedBudget: new DecodedBudget(CACHE_BYTES) });
  const share = await rowsOf(root);
  assert.equal(share.format, 'csr_matrix', 'by cell, so the reader reads genes for the share as a gene sample');
  const { order } = cellPriority(nCells);
  for (let row = 0; row < nCells; row++) {
    const expected = row < G ? byCell[order[row]] : [];
    assert.deepEqual(share.rows[row], expected, `store row ${row}`);
  }
  // The map's columns and embeddings are the composite's.
  assert.ok(child(root, 'obsm/X_umap') !== null && child(root, 'obs/group') !== null);

  // Every cell: by gene with prefix counts, as every transcoded store.
  const all = await stream.ensure(nCells);
  assert.equal(all.held, nCells);
  const { root: whole } = await openTranscodedStore(all.store, { name: 'f', layout: 'folder', decodedBudget: new DecodedBudget(CACHE_BYTES) });
  assert.equal(child(whole, 'X').attrs['encoding-type'], 'csc_matrix');
  assert.ok(child(whole, 'varm/cellucid_prefix_counts') !== null);
});

test('a small matrix, or one of several modalities, is read with its map into one store, whole', async () => {
  // Small: no larger than the lists and tables.
  const small = folder(40, 3);
  const opened = await openFolder(small.source);
  assert.equal(opened.matrixStream, null, 'nothing is left to read');
  assert.equal(child(opened.root, 'X').attrs['encoding-type'], 'csc_matrix');
  // Several modalities (a multiome: Gene Expression and Peaks): a modality's
  // genes are read for every open cell, so its rows are all read first.
  const nCells = 3000;
  const { text, byCell } = countMatrix(nCells, 6);
  const barcodes = Array.from({ length: nCells }, (_, i) => `CELL${i}-1`);
  const features = Array.from({ length: 6 }, (_, g) => `F${g}\tF${g}\t${g < 4 ? 'Gene Expression' : 'Peaks'}`).join('\n') + '\n';
  const files = new Map([
    ['m/matrix.mtx', new File([text], 'matrix.mtx')],
    ['m/features.tsv', new File([features], 'features.tsv')],
    ['m/barcodes.tsv', new File([barcodes.join('\n') + '\n'], 'barcodes.tsv')],
    ['m/umap.csv', new File(['barcode,UMAP_1,UMAP_2\n' + barcodes.map((cell, i) => `${cell},${i % 7},${i % 5}`).join('\n') + '\n'], 'umap.csv')],
  ]);
  const multiome = await openFolder({ files, rootName: 'm' });
  assert.equal(multiome.matrixStream, null);
  const rna = child(multiome.root, 'mod/Gene Expression/X');
  assert.equal(rna.attrs['encoding-type'], 'csc_matrix');
  const stored = await rna.get('data').read();
  assert.equal(stored.length, byCell.flat().filter(([gene]) => gene < 4).length, 'every entry of the modality');
});

test('sorted by cell, a share stops reading the stream after its last cell', async () => {
  // Under seed 0 the lowest rank of the first 12,647 to 63,628 cells is cell
  // 12,646's: the share of one cell ends a fifth into this file.
  const nCells = 63_000;
  const { source } = folder(nCells, 30);
  const opened = await openFolder(source);
  const { position } = cellPriority(nCells);
  assert.equal(position[12_646], 0);
  let reached = 0;
  await opened.matrixStream.ensure(1, { onProgress: ({ cells }) => { reached = cells; } });
  // Parsed a block at a time (`ENTRY_BLOCK_BYTES`, about 17,000 of these cells): stopped within the block past the share.
  assert.ok(reached > 12_646 && reached < 12_647 + 40_000, `parsed up to cell ${reached} of ${nCells}`);
  const { root } = await openTranscodedStore(opened.matrixStream.store(), { name: 'f', layout: 'folder', decodedBudget: new DecodedBudget(CACHE_BYTES) });
  const share = await rowsOf(root);
  assert.ok(share.rows[0].length > 0 && share.rows.slice(1).every(row => row.length === 0));
});

test('sorted by gene, a share reads the whole stream: rising cells within a gene are not taken for a stream sorted by cell', async () => {
  const nCells = 63_000;
  const { byCell } = countMatrix(nCells, 30);
  // The same entries, sorted by gene (kb-python's and alevin-fry's order).
  const byGene = [];
  byCell.forEach((entries, cell) => { for (const [gene, value] of entries) byGene.push([gene, cell, value]); });
  byGene.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const text = ['%%MatrixMarket matrix coordinate integer general', `30 ${nCells} ${byGene.length}`, ...byGene.map(([gene, cell, value]) => `${gene + 1} ${cell + 1} ${value}`)].join('\n') + '\n';
  const { source } = folder(nCells, 30);
  source.files.set('f/matrix.mtx', new File([text], 'matrix.mtx'));
  const opened = await openFolder(source);
  let reached = 0;
  await opened.matrixStream.ensure(1, { onProgress: () => { reached++; } });
  const { root } = await openTranscodedStore(opened.matrixStream.store(), { name: 'f', layout: 'folder', decodedBudget: new DecodedBudget(CACHE_BYTES) });
  const share = await rowsOf(root);
  assert.deepEqual(share.rows[0], byCell[12_646], 'every entry of the share\'s cell, from every gene');
});

test('the share is sized to the gene index this device holds, every cell when it fits', () => {
  const facts = { nCells: 1_000_000, nFeatures: 30_000, entries: 2_000_000_000 };
  assert.equal(shareFit({ nCells: 1000, nFeatures: 100, entries: 10_000 }, 1 << 30), 1000);
  const fitted = shareFit(facts, 2 ** 30);
  assert.ok(fitted > 1 && fitted < facts.nCells, `${fitted}`);
  // The fitted cells' index fits, one more does not.
  assert.ok(fitted < shareFit(facts, 2 ** 31));
});

test('a reader of a share: its gene sample stops at the rows held, a growth too, and a cell past them is never read as zeros', async () => {
  const nCells = 4000;
  const { source, byCell } = folder(nCells, 40);
  const opened = await openFolder(source);
  const G = 900;
  const { store } = await opened.matrixStream.ensure(G);
  const { root } = await openTranscodedStore(store, { name: 'f', layout: 'folder', decodedBudget: new DecodedBudget(CACHE_BYTES) });
  const reader = new AnnDataReader();
  t_after.push(() => reader.close());
  await reader.open(root, { format: ZARR_FORMAT, name: 'f', held: { rows: G, fitCells: G, bytes: 1 } });
  assert.deepEqual({ cells: reader.geneSample.cells, of: reader.geneSample.of, limit: reader.geneSample.fit.limit }, { cells: G, of: nCells, limit: 'stream' });
  assert.equal(reader.heldOpenCells(), G);
  assert.equal(reader.rowsForOpenCells(1500), 1500);
  // A gene: values on the held cells, none on the others.
  const [column] = await reader.getMatrixColumns('X', [5]);
  const { order } = cellPriority(nCells);
  for (let row = 0; row < nCells; row++) {
    if (row >= G) assert.ok(Number.isNaN(column[row]), `row ${row} is not read`);
    else assert.equal(column[row], byCell[order[row]].find(([gene]) => gene === 5)?.[1] ?? 0, `row ${row}`);
  }
  // Growth stops at the rows held.
  const grown = await reader.growGeneSample('X', nCells);
  assert.equal(grown?.cells ?? nCells, G);
  // A cell past them, by name: refused, never zeros.
  await assert.rejects(reader.getMatrixCellSubset('X', [G + 10], [5]), /holds genes for the first 900 open cells/);
  const within = await reader.getMatrixCellSubset('X', [3], [5]);
  assert.equal(within.values.length === 0 ? 0 : within.values[0], byCell[order[3]].find(([gene]) => gene === 5)?.[1] ?? 0);
});

test('the gene sample never reaches past the rows the store holds', () => {
  assert.equal(heldPrefix(null, 100, 40), 40);
  assert.equal(heldPrefix(null, 30, 40), 30);
  assert.equal(heldPrefix(Uint32Array.from([0, 3, 9, 41, 2]), 5, 40), 3, 'from the first open cell, up to the first one not held');
});

test('a gene sample sized to a matrix still arriving is fitted afresh by the next opening, never carried as a count', async () => {
  const { geneSampleRequestOf, requestOfOpenCells } = await import('../assets/js/data/cell-subset-policy.js');
  const { planProgressiveOpening } = await import('../assets/js/data/anndata/progressive-open.js');
  const arriving = cells => ({ cells, of: 3000, fit: { cells, limit: 'stream', fitCells: 3000, matrixBytes: 1, matrix: 'X', layout: null } });
  // Before any row arrived (0 cells) and after some did: its count is the
  // rows held then, not a choice; a count of 0 is no request at all.
  assert.equal(geneSampleRequestOf(arriving(0)), null);
  assert.equal(geneSampleRequestOf(arriving(900)), null);
  // Samples that are carried still are.
  assert.equal(geneSampleRequestOf(null), 'all');
  assert.equal(geneSampleRequestOf({ cells: 50, of: 3000, fit: null }), 50);
  const geneTime = { cells: 50, of: 3000, fit: { limit: 'geneTime' } };
  assert.deepEqual(geneSampleRequestOf(geneTime), { cells: 50, fit: geneTime.fit });
  // The open cells read again: no gene sample asked.
  assert.equal('genes' in requestOfOpenCells({ kept: null, genes: arriving(0) }), false);
  assert.equal('genes' in requestOfOpenCells({ kept: null, genes: arriving(900) }), false);
  // A progressive opening of a folder dropped while its matrix arrives (the
  // page's cost of showing cells measured, no link): every step and the last
  // are fitted afresh. Carried, the first step asked for a sample of 0 cells
  // and the opening failed ("A gene sample is ... not 0", WebKit in CI).
  const kept = Uint32Array.from({ length: 2000 }, (_, i) => i);
  const plan = await planProgressiveOpening(
    { kept, spec: { method: 'uniform', seed: 3, nObs: 3000, k: 2000 }, autoFit: null, prioritySeed: null, genes: arriving(0) },
    { nObs: 3000, costOf: async () => null, link: null, decodeBytesPerMs: Infinity, msPerCell: 2, targetMs: 1000 },
  );
  assert.ok(plan !== null, 'the opening grows');
  assert.equal(plan.first.genes, null);
  assert.equal(plan.growth.step.genes, null);
  assert.equal(plan.growth.final.genes, null);
});

test('opened from this computer: the first view has no gene value, the share arrives, the reader is swapped onto it and genes read', async () => {
  const nCells = 4000;
  const { source, byCell } = folder(nCells, 40);
  const fileSource = new AnnDataFileSource();
  try {
    const files = [...source.files].map(([path, file]) => {
      Object.defineProperty(file, 'webkitRelativePath', { value: path });
      return file;
    });
    const arrival = new Promise(resolve => {
      import('../assets/js/data/anndata-reader-client.js').then(({ onMatrixShare }) => {
        const stop = onMatrixShare(message => {
          if (message.event === 'genes-arrived') {
            stop();
            resolve(message);
          }
        });
      });
    });
    await fileSource.loadFolder(files);
    const message = await arrival;
    assert.equal(message.error, undefined);
    const loader = fileSource.getAdapter()._loader;
    assert.equal(loader.geneSample, null, 'every cell of a small matrix fits: genes for every open cell');
    const [column] = await loader.getMatrixColumns('X', [3]);
    const order = loader.cellSubset?.openOrder ?? Uint32Array.from({ length: nCells }, (_, i) => i);
    for (let i = 0; i < nCells; i++) {
      const expected = byCell[order[i]].find(([gene]) => gene === 3)?.[1] ?? 0;
      assert.equal(column[i], expected, `open cell ${i}`);
    }
  } finally {
    fileSource.clear();
  }
});

test('a gene asked for before the share arrives waits for it and is read with its values, never as "not read" on every cell', async () => {
  // The map's X holds no entry: read then, every gene was NaN on every
  // cell and the page refused it as having no value (Web contracts run
  // 42280096732, Linux Firefox, `tests/browser/text-matrix-stream.spec.mjs`).
  const nCells = 4000;
  const { source, byCell } = folder(nCells, 40);
  const fileSource = new AnnDataFileSource();
  try {
    const files = [...source.files].map(([path, file]) => {
      Object.defineProperty(file, 'webkitRelativePath', { value: path });
      return file;
    });
    const { onMatrixShare } = await import('../assets/js/data/anndata-reader-client.js');
    const events = [];
    const stop = onMatrixShare(message => events.push(message.event));
    await fileSource.loadFolder(files);
    const loader = fileSource.getAdapter()._loader;
    assert.equal(loader.geneSample?.cells, 0, 'the first view: genes read for no cell');
    assert.equal(loader.geneSample?.fit?.limit, 'stream');
    assert.ok(!events.includes('genes-arrived'), `asked before the share arrived (${events.join(', ')})`);
    const [column] = await loader.getMatrixColumns('X', [3]);
    stop();
    assert.ok(events.includes('genes-arrived'), 'the read waited for the share');
    assert.equal(loader.geneSample, null, 'every cell of a small matrix fits: genes for every open cell');
    const order = loader.cellSubset?.openOrder ?? Uint32Array.from({ length: nCells }, (_, i) => i);
    for (let i = 0; i < nCells; i++) {
      const expected = byCell[order[i]].find(([gene]) => gene === 3)?.[1] ?? 0;
      assert.equal(column[i], expected, `open cell ${i}`);
    }
  } finally {
    fileSource.clear();
  }
});

test('kept for later visits: the map and the share open again without reading the matrix', async t => {
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const counts = new Map();
  const { source } = folder(2000, 20, { counts });
  const first = await openFolder(source, { environment: disk.environment });
  await first.matrixStream.ensure(700);
  counts.clear();
  const again = await openFolder(source, { environment: disk.environment });
  assert.equal(again.conversion.reused, true);
  assert.equal(again.matrixStream.held, 700, 'the share kept is found');
  assert.equal(counts.get('matrix') ?? 0, 0, 'nothing of the matrix is read again');
  assert.equal(counts.get('cells') ?? 0, 0, 'nor of the tables');
});

/** The directories a disk keeps converted stores in. */
function keptDirectories(disk) {
  try {
    return readdirSync(path.join(disk.root, TRANSCODED_DIRECTORY)).sort();
  } catch {
    return [];
  }
}

/**
 * Open a folder in the reader worker (in-process) as the app does, OPFS on
 * `disk`, progressively when showing a cell is measured to cost
 * `msPerCell` (null: not measured, it opens at once), and grow it to its
 * cells as the page does (`open-cells-resize.js` `grow`). Resolves once
 * the open cells hold their genes.
 */
async function openInWorker(source, disk, msPerCell) {
  const { recordShownCells, resetShownCells } = await import('../assets/js/data/opening-cost.js');
  const { onMatrixShare } = await import('../assets/js/data/anndata-reader-client.js');
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: disk.environment.navigator, configurable: true, writable: true });
  resetShownCells();
  if (msPerCell !== null) recordShownCells(1, msPerCell);
  const passes = [];
  const stop = onMatrixShare(message => {
    if (message.event === 'genes-arriving') passes.push(message.cells);
  });
  const fileSource = new AnnDataFileSource();
  try {
    const files = [...source.files].map(([at, file]) => {
      Object.defineProperty(file, 'webkitRelativePath', { value: at });
      return file;
    });
    await fileSource.loadFolder(files);
    const growth = fileSource.getCellSubset()?.growth ?? null;
    for (const k of growth?.steps ?? []) {
      await fileSource.reopenCells({ cellSubset: k === growth.target ? growth.final : { ...growth.step, k }, quiet: true });
    }
    const loader = fileSource.getAdapter()._loader;
    await until(() => loader.geneSample?.fit?.limit !== 'stream', 'the genes of the open cells streamed in', { boundMs: 60_000 });
    return { fileSource, loader, growth, passes };
  } finally {
    stop();
    resetShownCells();
    if (before === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', before);
  }
}

test('a progressive opening reads its matrix once: one pass for the cells it grows to serves every step, one share is kept', async t => {
  const nCells = 4000;
  const read = {};
  for (const msPerCell of [null, 2]) {
    const disk = opfsOnDisk();
    t.after(disk.cleanup);
    const counts = new Map();
    const { source, byCell } = folder(nCells, 40, { counts });
    const { fileSource, loader, growth, passes } = await openInWorker(source, disk, msPerCell);
    try {
      if (msPerCell === null) assert.equal(growth, null, 'not measured: opened at once');
      else assert.ok(growth !== null && growth.steps.length >= 2, 'measured slow: a first view, then steps');
      read[msPerCell === null ? 'once' : 'grown'] = { matrix: counts.get('matrix') ?? 0, passes: passes.length };
      // One pass, announced once, for every cell (they all fit here).
      assert.deepEqual(passes, [nCells]);
      assert.equal(loader.geneSample, null, 'genes for every open cell');
      // The map and one share: none written for a step.
      assert.equal(keptDirectories(disk).length, 2, keptDirectories(disk).join(', '));
      const [column] = await loader.getMatrixColumns('X', [3]);
      const order = loader.cellSubset?.openOrder ?? null;
      for (let i = 0; i < nCells; i++) {
        assert.equal(column[i], byCell[order === null ? i : order[i]].find(([gene]) => gene === 3)?.[1] ?? 0, `open cell ${i}`);
      }
    } finally {
      fileSource.clear();
    }
  }
  // Grown, it reads what opening at once reads: never the matrix again a step.
  assert.deepEqual(read.grown, read.once);
});

test('one pass serves every caller: as many rows or fewer join it, one stopping leaves it to the others, none waiting stops it', async () => {
  const nCells = 20_000;
  const counts = new Map();
  const { source, byCell, matrixBytes } = folder(nCells, 30, { counts });
  const opened = await openFolder(source);
  const stream = opened.matrixStream;
  counts.clear();
  const first = new AbortController();
  const second = new AbortController();
  const asked = stream.ensure(5000, { signal: first.signal });
  const joined = stream.ensure(2000, { signal: second.signal });
  assert.equal(stream.reading, 5000, 'one pass, for the most rows asked');
  // The caller that started it stops waiting: the pass goes on for the other.
  first.abort();
  await assert.rejects(asked, error => error.name === 'AbortError');
  const { held } = await joined;
  assert.equal(held, 5000);
  assert.ok((counts.get('matrix') ?? 0) <= matrixBytes, `the matrix read once: ${counts.get('matrix')} of ${matrixBytes} bytes`);
  const { root } = await openTranscodedStore(stream.store(), { name: 'f', layout: 'folder', decodedBudget: new DecodedBudget(CACHE_BYTES) });
  const { order } = cellPriority(nCells);
  const share = await rowsOf(root);
  for (const row of [0, 1999, 4999]) assert.deepEqual(share.rows[row], byCell[order[row]], `store row ${row}`);
  // Every caller stops waiting: the pass stops, nothing more is kept.
  counts.clear();
  const gone = new AbortController();
  const waiting = stream.ensure(nCells, { signal: gone.signal });
  gone.abort();
  await assert.rejects(waiting, error => error.name === 'AbortError');
  // The pass stops once its read under way is let go: nothing is read on.
  await until(() => stream.reading === 0, 'the pass stopped');
  assert.equal(stream.held, 5000);
});

test('more rows asked while a smaller pass runs replace it; a completed larger share replaces the smaller, which is let go and removed', async t => {
  const { holdTranscodedStore, letGoTranscodedStore } = await import('../assets/js/data/anndata/transcode/space.js');
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const nCells = 20_000;
  const counts = new Map();
  const { source, matrixBytes } = folder(nCells, 30, { counts });
  // The page's part (`anndata-reader-client.js`): hold what completes, let go what is replaced.
  const page = [];
  const onStore = ({ directory, state }) => {
    page.push(state);
    if (state === 'complete') page.push(holdTranscodedStore(directory, disk.environment));
    if (state === 'replaced') page.push(letGoTranscodedStore(directory, disk.environment));
  };
  const opened = await openFolder(source, { environment: disk.environment, onStore });
  const stream = opened.matrixStream;
  const map = keptDirectories(disk);
  counts.clear();
  // Asked in the same moment: the smaller pass stops before it reads, the
  // larger serves both.
  const small = stream.ensure(1000);
  const large = stream.ensure(8000);
  const [a, b] = await Promise.all([small, large]);
  assert.equal(a.held, 8000);
  assert.equal(b.held, 8000);
  assert.ok((counts.get('matrix') ?? 0) <= matrixBytes, `one reading of the matrix: ${counts.get('matrix')} of ${matrixBytes} bytes`);
  // Completed, then a larger one: the smaller is replaced and, let go, removed.
  const { held } = await stream.ensure(nCells);
  assert.equal(held, nCells);
  assert.equal(keptDirectories(disk).length, map.length + 2, 'kept until no reader reads it');
  stream.letGo();
  await Promise.all(page.filter(item => typeof item?.then === 'function'));
  assert.ok(page.includes('replaced'));
  assert.equal(keptDirectories(disk).length, map.length + 1, 'one share kept: the largest');
  // A later visit opens the largest.
  const again = await openFolder(source, { environment: disk.environment });
  assert.equal(again.matrixStream.held, nCells);
});

test('the seek decoder: from the start it is the stream; from an access point it resumes exactly; from a block found by trial every byte it knows is exact', () => {
  const { text } = countMatrix(6000, 2000, { perCell: 40 });
  const bytes = Buffer.from(text);
  const gz = zlib.gzipSync(bytes);
  const header = gzipHeader(gz);
  assert.equal(header.length, 10);
  const points = [];
  const decoder = new DeflateDecoder({ bit: header.length * 8, inputStart: 0, window: new Uint8Array(0), onBlock: (bit, produced) => points.push({ bit, produced }) });
  decoder.push(gz);
  decoder.end();
  const parts = [];
  while (!decoder.done) parts.push(Buffer.from(decoder.decode().output));
  assert.ok(Buffer.concat(parts).equals(bytes));
  assert.ok(points.length > 3);
  for (const point of points) {
    const window = bytes.subarray(Math.max(0, point.produced - 32768), point.produced);
    const from = Math.floor(point.bit / 8);
    const resumed = new DeflateDecoder({ bit: point.bit, inputStart: from, window: Uint8Array.from(window) });
    resumed.push(gz.subarray(from, from + 200_000));
    const { output } = resumed.decode(50_000);
    assert.ok(Buffer.from(output).equals(bytes.subarray(point.produced, point.produced + output.length)), `access point at bit ${point.bit}`);
  }
  // A block start found by trial from an arbitrary byte, decoded without its window.
  const accept = byte => (byte >= 48 && byte <= 57) || byte === 32 || byte === 10;
  const start = Math.floor(gz.length / 2);
  const bit = findBlockStart(gz.subarray(start, start + 300_000), 0, 300_000 * 8, { accept });
  assert.notEqual(bit, null);
  const point = points.find(item => item.bit === start * 8 + bit);
  assert.ok(point !== undefined, 'the block found is a block of the stream');
  const marked = new DeflateDecoder({ bit: start * 8 + bit, inputStart: start, marked: true });
  marked.push(gz.subarray(start));
  const { output } = marked.decode(200_000);
  let markers = 0;
  for (let i = 0; i < output.length; i++) {
    if (output[i] === MARKER) markers++;
    else assert.equal(output[i], bytes[point.produced + i], `byte ${i}`);
  }
  assert.ok(markers > 0, 'bytes from before the start are unknown, never guessed');
});
