/**
 * GEO's MatrixMarket samples and gzipped R files:
 *
 * - which matrix goes with which lists, by name (`data/matrix-market-files.js`):
 *   a sample prefix, a shorter shared one, mixed `features`/`genes` naming,
 *   and every case that cannot be paired, each with what to do;
 * - the GEO provider grouping a series' listings (its folder and its
 *   `filelist.txt`) into samples with no request beyond the two listings,
 *   reading `_RAW.tar` members from their samples' folders with the sizes
 *   the file list states (no probe), and refusing an incomplete sample by
 *   the file it lacks;
 * - a sample's files, prefixed and read from a host, opening exactly as the
 *   same files in a folder on this computer;
 * - `.rds.gz` (saveRDS's gzip stream gzipped again, or a plain one gzipped
 *   once) told apart by content, whatever the name says, streamed through
 *   gunzip into the parser in pieces.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import test from 'node:test';

import { cellTablesBySet, matrixMarketFileSets, prefixesOf } from '../assets/js/data/matrix-market-files.js';
import geo, { geoDatasets, geoSupplementaryUrl, parseGeoFileList } from '../assets/js/data/sources/providers/geo.js';
import { getProviderRegistry } from '../assets/js/data/sources/registry.js';
import { openDatasetStore } from '../assets/js/data/anndata/open.js';
import { decompressed, readInOrder, readRFile } from '../assets/js/formats/rds/index.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { openZipArchive } from '../assets/js/formats/zip/index.js';

const CACHE_BYTES = 64 * 1024 * 1024;
const archive = await openZipArchive(createByteReader(bytesByteSource(
  new Uint8Array(readFileSync(new URL('./fixtures/rds/corpus.zip', import.meta.url))),
  { name: 'corpus.zip' }
)));
const corpus = async path => (await archive.entry(path).read()).slice();

test('a matrix takes the lists of its own sample prefix, whatever the producer named them', () => {
  const { sets, problems } = matrixMarketFileSets([
    'GSM1_RNA_3P-barcodes.tsv.gz', 'GSM1_RNA_3P-features.tsv.gz', 'GSM1_RNA_3P-matrix.mtx.gz',
    // Mixed naming across samples: Cell Ranger 2's genes beside Cell Ranger 3's features.
    'GSM2_genes.tsv.gz', 'GSM2_matrix.mtx.gz', 'GSM2_barcodes.tsv.gz',
    'GSM4_matrix.mtx', 'GSM4_genes.tsv', 'GSM4_barcodes.tsv',
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(sets.map(set => [set.matrix, set.features, set.cells, set.prefix]), [
    ['GSM1_RNA_3P-matrix.mtx.gz', 'GSM1_RNA_3P-features.tsv.gz', 'GSM1_RNA_3P-barcodes.tsv.gz', 'GSM1_RNA_3P-'],
    ['GSM2_matrix.mtx.gz', 'GSM2_genes.tsv.gz', 'GSM2_barcodes.tsv.gz', 'GSM2_'],
    ['GSM4_matrix.mtx', 'GSM4_genes.tsv', 'GSM4_barcodes.tsv', 'GSM4_'],
  ]);
  assert.deepEqual(prefixesOf('gsm1_rna_3p-'), ['gsm1_rna_3p-', 'gsm1_rna_', 'gsm1_', '']);
  // Cell Ranger's own folders: no prefix at all.
  const plain = matrixMarketFileSets(['outs/filtered_feature_bc_matrix/matrix.mtx.gz', 'outs/filtered_feature_bc_matrix/features.tsv.gz', 'outs/filtered_feature_bc_matrix/barcodes.tsv.gz']);
  assert.equal(plain.sets[0].features, 'outs/filtered_feature_bc_matrix/features.tsv.gz');
});

test('a shorter shared prefix serves several matrices, but never one that is another matrix\'s', () => {
  // CITE-seq: one barcode list for the RNA and the antibody matrices.
  const citeseq = matrixMarketFileSets([
    'GSE1_RNA_matrix.mtx.gz', 'GSE1_ADT_matrix.mtx.gz', 'GSE1_barcodes.tsv.gz', 'GSE1_RNA_features.tsv.gz', 'GSE1_ADT_features.tsv.gz',
  ]);
  assert.deepEqual(citeseq.problems, []);
  assert.deepEqual(citeseq.sets.map(set => [set.matrix, set.cells, set.shared.cells]), [
    ['GSE1_ADT_matrix.mtx.gz', 'GSE1_barcodes.tsv.gz', ['GSE1_RNA_matrix.mtx.gz']],
    ['GSE1_RNA_matrix.mtx.gz', 'GSE1_barcodes.tsv.gz', ['GSE1_ADT_matrix.mtx.gz']],
  ]);
  // `matrix.mtx.gz` owns the unprefixed lists: GSM9's matrix may not take them.
  const owned = matrixMarketFileSets(['x/GSM9_matrix.mtx.gz', 'x/matrix.mtx.gz', 'x/barcodes.tsv.gz', 'x/features.tsv.gz']);
  assert.deepEqual(owned.sets.map(set => set.matrix), ['x/matrix.mtx.gz']);
  assert.deepEqual(owned.problems.map(item => [item.matrix, item.missing.length]), [['x/GSM9_matrix.mtx.gz', 2]]);
  assert.match(owned.problems[0].message, /GSM9_matrix\.mtx\.gz has no GSM9_features\.tsv\.gz \(or GSM9_genes\.tsv\.gz\) and no GSM9_barcodes\.tsv\.gz beside it.*Download the missing files/);
});

test('a sample that cannot be paired says which file is missing or which two compete', () => {
  const { sets, problems } = matrixMarketFileSets([
    'GSM3_matrix.mtx.gz', 'GSM3_genes.tsv.gz',
    'GSM5_matrix.mtx.gz', 'GSM5_features.tsv.gz', 'GSM5_genes.tsv.gz', 'GSM5_barcodes.tsv.gz',
    'GSM6_matrix.mtx', 'GSM6_matrix.mtx.gz', 'GSM6_features.tsv.gz', 'GSM6_barcodes.tsv.gz',
  ]);
  assert.deepEqual(sets, []);
  const [missing, ambiguous, twice] = problems;
  assert.deepEqual(missing.missing, ['GSM3_barcodes.tsv.gz']);
  assert.match(missing.message, /GSM3_matrix\.mtx\.gz has no GSM3_barcodes\.tsv\.gz beside it, so its cells are not named\. Download the missing file/);
  assert.deepEqual(ambiguous.ambiguous, ['GSM5_features.tsv.gz', 'GSM5_genes.tsv.gz']);
  assert.match(ambiguous.message, /both GSM5_features\.tsv\.gz and GSM5_genes\.tsv\.gz.*the one feature list you mean/);
  assert.deepEqual(twice.ambiguous, ['GSM6_matrix.mtx', 'GSM6_matrix.mtx.gz']);
  assert.match(twice.message, /two matrices of one sample/);
});

test('a sample\'s cell tables are its own prefix\'s, not another sample\'s lists or tables', () => {
  const paths = ['GSM1_matrix.mtx.gz', 'GSM1_features.tsv.gz', 'GSM1_barcodes.tsv.gz', 'GSM1_cell_metadata.csv.gz',
    'GSM2_matrix.mtx.gz', 'GSM2_features.tsv.gz', 'GSM2_barcodes.tsv.gz', 'GSM2_umap.csv', 'GSE9_notes.txt'];
  const { sets } = matrixMarketFileSets(paths);
  const tables = cellTablesBySet(paths, sets);
  assert.deepEqual(tables.get('GSM1_matrix.mtx.gz'), ['GSM1_cell_metadata.csv.gz']);
  assert.deepEqual(tables.get('GSM2_matrix.mtx.gz'), ['GSM2_umap.csv']);
});

/** Replace fetch with one answering from `routes(url, init)`. */
function installFetch(t, routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', range: init.headers?.Range ?? init.headers?.range ?? null });
    const answer = routes(String(url), init) ?? { status: 404 };
    const bodiless = init.method === 'HEAD' || [204, 304].includes(answer.status);
    const response = new Response(bodiless ? null : (answer.body?.slice() ?? answer.text ?? ''), { status: answer.status, headers: answer.headers ?? {} });
    Object.defineProperty(response, 'url', { value: String(url) });
    return response;
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/** A host serving `bytes` with HEAD and ranged GET. */
function bytesRoute(bytes) {
  return (url, init) => {
    if (init.method === 'HEAD') return { status: 200, headers: { 'Content-Length': String(bytes.length), 'Accept-Ranges': 'bytes' } };
    const range = /bytes=(\d+)-(\d*)/.exec(init.headers?.Range ?? init.headers?.range ?? '');
    if (range === null) return { status: 200, body: bytes, headers: { 'Content-Length': String(bytes.length) } };
    const start = Number(range[1]);
    const end = range[2] === '' ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1);
    return {
      status: 206,
      body: bytes.subarray(start, end + 1),
      headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1) },
    };
  };
}

const SERIES = 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE164nnn/GSE164378/suppl/';
const sampleFolder = sample => `https://ftp.ncbi.nlm.nih.gov/geo/samples/GSM5008nnn/${sample}/suppl/`;
const SERIES_LISTING = `<pre><a href="/geo/series/GSE164nnn/GSE164378/">Parent Directory</a>
<a href="GSE164378_RAW.tar">GSE164378_RAW.tar</a> 2021-01-17 06:19  1.4G
<a href="GSE164378_sc.meta.data_3P.csv.gz">GSE164378_sc.meta.data_3P.csv.gz</a> 2021-01-07 09:42  3.0M
<a href="filelist.txt">filelist.txt</a></pre>`;
const FILE_LIST = [
  '#Archive/File\tName\tTime\tSize\tType',
  'Archive\tGSE164378_RAW.tar\t01/17/2021 06:19:10\t1467842560\tTAR',
  'File\tGSM5008737_RNA_3P-barcodes.tsv.gz\t01/04/2021 09:05:23\t683095\tTSV',
  'File\tGSM5008737_RNA_3P-features.tsv.gz\t01/04/2021 09:05:23\t233354\tTSV',
  'File\tGSM5008737_RNA_3P-matrix.mtx.gz\t01/04/2021 09:05:23\t1125353463\tMTX',
  'File\tGSM5008738_ADT_3P-barcodes.tsv.gz\t01/04/2021 09:07:42\t683095\tTSV',
  'File\tGSM5008738_ADT_3P-genes.tsv.gz\t01/04/2021 09:07:42\t1373\tTSV',
  'File\tGSM5008738_ADT_3P-matrix.mtx.gz\t01/04/2021 09:07:42\t104745344\tMTX',
  'File\tGSM5008739_HTO_3P-features.tsv.gz\t01/06/2021 21:08:18\t173\tTSV',
  'File\tGSM5008739_HTO_3P-matrix.mtx.gz\t01/06/2021 21:08:18\t9134\tMTX',
  'File\tGSM5008740_seurat.rds.gz\t01/06/2021 21:08:18\t5550\tRDS',
].join('\n');

test('GEO groups a series\' samples from its two listings alone, and opens one from its sample folder with the stated sizes', async t => {
  assert.equal(geoSupplementaryUrl('GSM5008737'), sampleFolder('GSM5008737'));
  assert.deepEqual(parseGeoFileList(FILE_LIST).map(file => [file.name, file.size, file.sample]).slice(0, 2), [
    ['GSM5008737_RNA_3P-barcodes.tsv.gz', 683095, 'GSM5008737'],
    ['GSM5008737_RNA_3P-features.tsv.gz', 233354, 'GSM5008737'],
  ]);
  const calls = installFetch(t, url => {
    if (url === SERIES) return { status: 200, text: SERIES_LISTING };
    if (url === `${SERIES}filelist.txt`) return { status: 200, text: FILE_LIST };
    return null;
  });
  // No link names a dataset: the choices, the incomplete sample named apart.
  await assert.rejects(geo.open('GSE164378'), error => {
    assert.match(error.message, /GEO GSE164378 has 3 datasets Cellucid opens \(2 MatrixMarket samples, opened by their matrix\)/);
    assert.match(error.message, /geo:GSE164378\/GSM5008740_seurat\.rds\.gz/);
    assert.match(error.message, /geo:GSE164378\/GSM5008737_RNA_3P-matrix\.mtx\.gz, geo:GSE164378\/GSM5008738_ADT_3P-matrix\.mtx\.gz/);
    assert.match(error.message, /GSM5008739_HTO_3P-matrix\.mtx\.gz cannot open/);
    return true;
  });
  assert.deepEqual(calls.map(call => call.url), [SERIES, `${SERIES}filelist.txt`], 'the two listings, asked for together, and nothing else');

  calls.length = 0;
  const opened = await geo.open('GSE164378/GSM5008737_RNA_3P-matrix.mtx.gz');
  assert.deepEqual(calls.map(call => call.url), [SERIES, `${SERIES}filelist.txt`], 'sizes come from the file list: no probe');
  assert.equal(opened.files.id, 'geo:GSE164378:GSM5008737_RNA_3P-matrix.mtx.gz');
  assert.deepEqual(opened.files.format, { format: 'mtx', layout: 'folder' });
  assert.deepEqual([...opened.files.files].map(([name, file]) => [name, file.url, file.size]), [
    ['GSM5008737_RNA_3P-matrix.mtx.gz', `${sampleFolder('GSM5008737')}GSM5008737_RNA_3P-matrix.mtx.gz`, 1125353463],
    ['GSM5008737_RNA_3P-features.tsv.gz', `${sampleFolder('GSM5008737')}GSM5008737_RNA_3P-features.tsv.gz`, 233354],
    ['GSM5008737_RNA_3P-barcodes.tsv.gz', `${sampleFolder('GSM5008737')}GSM5008737_RNA_3P-barcodes.tsv.gz`, 683095],
  ]);
  assert.equal(opened.title, 'GSE164378 / GSM5008737_RNA_3P-matrix.mtx.gz');

  // Mixed naming: the antibody sample's list is genes.tsv.gz.
  const adt = await geo.open('GSE164378/GSM5008738_ADT_3P-matrix.mtx.gz');
  assert.equal([...adt.files.files.keys()][1], 'GSM5008738_ADT_3P-genes.tsv.gz');

  // An incomplete sample names the file it lacks.
  await assert.rejects(
    geo.open('GSE164378/GSM5008739_HTO_3P-matrix.mtx.gz'),
    /GEO GSE164378 has GSM5008739_HTO_3P-matrix\.mtx\.gz, but no GSM5008739_HTO_3P-barcodes\.tsv\.gz for it, so its cells are not named\..*Open… › Folder…/
  );
  // A list opens through its matrix.
  await assert.rejects(
    geo.open('GSE164378/GSM5008737_RNA_3P-barcodes.tsv.gz'),
    /not a dataset Cellucid opens on its own\. Open a MatrixMarket sample by its matrix: geo:GSE164378\/GSM5008737_RNA_3P-matrix\.mtx\.gz/
  );
  // A gzipped R object in the archive opens from its sample folder, its size stated.
  calls.length = 0;
  const rds = await geo.open('GSE164378/GSM5008740_seurat.rds.gz');
  assert.equal(rds.file.resource.url, `https://ftp.ncbi.nlm.nih.gov/geo/samples/GSM5008nnn/GSM5008740/suppl/GSM5008740_seurat.rds.gz`);
  assert.equal(rds.file.resource.size, 5550);
  assert.deepEqual(rds.file.format, { format: 'rds', layout: 'file' });
  assert.equal(calls.length, 2, 'the listings only');
});

test('GEO pairs a series folder\'s own triplet, probing the three sizes together when it opens', async t => {
  const listing = ['GSE9_matrix.mtx.gz', 'GSE9_genes.tsv.gz', 'GSE9_barcodes.tsv.gz', 'GSE9_metadata.csv.gz', 'GSE9_RAW.tar']
    .map(name => `<a href="${name}">${name}</a>`).join('\n');
  const folder = geoSupplementaryUrl('GSE9');
  const calls = installFetch(t, (url, init) => {
    if (url === folder) return { status: 200, text: listing };
    if (url.startsWith(folder) && url !== `${folder}filelist.txt`) return bytesRoute(new Uint8Array(77))(url, init);
    return null;
  });
  const opened = await geo.open('GSE9');
  assert.deepEqual([...opened.files.files.keys()], ['GSE9_matrix.mtx.gz', 'GSE9_genes.tsv.gz', 'GSE9_barcodes.tsv.gz', 'GSE9_metadata.csv.gz']);
  assert.ok([...opened.files.files.values()].every(file => file.size === 77));
  // The two listings, then one probe per file.
  assert.equal(calls.filter(call => call.url === folder || call.url.endsWith('filelist.txt')).length, 2);
});

test('a GEO sample accession lists its own folder', async t => {
  const registry = getProviderRegistry();
  assert.equal(registry.resolve('GSM5008737').locator, 'geo:GSM5008737');
  assert.equal(registry.resolve('https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSM5008737').locator, 'geo:GSM5008737');
  assert.equal(
    registry.resolve(`${sampleFolder('GSM5008737')}GSM5008737_RNA_3P-matrix.mtx.gz`).locator,
    'geo:GSM5008737/GSM5008737_RNA_3P-matrix.mtx.gz'
  );
  const listing = ['GSM5008737_RNA_3P-barcodes.tsv.gz', 'GSM5008737_RNA_3P-features.tsv.gz', 'GSM5008737_RNA_3P-matrix.mtx.gz']
    .map(name => `<a href="${name}">${name}</a>`).join('\n');
  const calls = installFetch(t, (url, init) => {
    if (url === sampleFolder('GSM5008737')) return { status: 200, text: listing };
    if (url.startsWith(sampleFolder('GSM5008737'))) return bytesRoute(new Uint8Array(5))(url, init);
    return null;
  });
  const opened = await geo.open('GSM5008737');
  assert.equal(opened.files.files.size, 3);
  assert.ok(!calls.some(call => call.url.endsWith('filelist.txt')), 'a sample has no file list');
});

test('grouping a large series listing is a single pass over its names', () => {
  // 20,000 samples' files, as GEO's largest file lists hold.
  const files = [];
  for (let i = 0; i < 20000; i++) {
    for (const kind of ['matrix.mtx.gz', i % 2 ? 'genes.tsv.gz' : 'features.tsv.gz', 'barcodes.tsv.gz']) {
      const name = `GSM${1000000 + i}_s${i}_${kind}`;
      files.push({ name, url: `https://x/${name}`, size: 1, path: `GSM${1000000 + i}/${name}` });
    }
  }
  const started = performance.now();
  const { samples, incomplete } = geoDatasets(files);
  const ms = performance.now() - started;
  assert.equal(samples.length, 20000);
  assert.equal(incomplete.length, 0);
  // Not a performance gate: it says how long a large listing takes.
  console.log(`[geo] grouped ${files.length} files into ${samples.length} samples in ${ms.toFixed(0)} ms`);
});

/** A served copy of the corpus' Cell Ranger 3 folder, renamed as a GEO sample. */
async function geoSample() {
  const names = {
    'filtered_feature_bc_matrix/matrix.mtx.gz': 'GSM7_PBMC-matrix.mtx.gz',
    'filtered_feature_bc_matrix/features.tsv.gz': 'GSM7_PBMC-features.tsv.gz',
    'filtered_feature_bc_matrix/barcodes.tsv.gz': 'GSM7_PBMC-barcodes.tsv.gz',
    'cell_metadata.csv': 'GSM7_PBMC-cell_metadata.csv',
  };
  const local = new Map();
  const served = new Map();
  for (const [inside, name] of Object.entries(names)) {
    const bytes = await corpus(`mtx/cellranger3/${inside}`);
    local.set(inside, new File([bytes], inside.split('/').pop()));
    served.set(name, bytes);
  }
  return { local, served };
}

async function valuesOf(opened) {
  const X = opened.root.get('X');
  const umap = opened.root.get('obsm').get('X_umap');
  const index = opened.root.get('obs').get(opened.root.get('obs').attrs._index);
  return {
    indptr: Array.from(await X.get('indptr').read()),
    data: Array.from(await X.get('data').read()),
    umap: Array.from(await umap.read()),
    cells: [...await index.read()],
  };
}

test('a GEO sample read from the host opens as the same files in a folder on this computer', async t => {
  const { local, served } = await geoSample();
  const host = sampleFolder('GSM7');
  installFetch(t, (url, init) => {
    const name = decodeURIComponent(url.slice(host.length));
    return served.has(name) ? bytesRoute(served.get(name))(url, init) : null;
  });
  const remote = new Map([...served].map(([name, bytes]) => [name, {
    url: `${host}${encodeURIComponent(name)}`,
    size: bytes.length,
    name,
    identity: { kind: 'remote', key: `geo:GSE7:${name}`, version: `size:${bytes.length}` },
  }]));
  const fromHost = await openDatasetStore(
    { source: { files: remote, rootName: 'GSE7 GSM7_PBMC' }, expect: { format: 'mtx', layout: 'folder' } },
    { decodedChunkCacheBytes: CACHE_BYTES }
  );
  const fromDisk = await openDatasetStore({ source: { files: local, rootName: 'cellranger3' } }, { decodedChunkCacheBytes: CACHE_BYTES });
  assert.equal(fromHost.format, 'mtx');
  assert.deepEqual(await valuesOf(fromHost), await valuesOf(fromDisk));
  // The prefixed names alone make it a MatrixMarket folder.
  const prefixedLocal = new Map([...served].map(([name, bytes]) => [name, new File([bytes], name)]));
  const named = await openDatasetStore({ source: { files: prefixedLocal, rootName: 'GSM7' } }, { decodedChunkCacheBytes: CACHE_BYTES });
  assert.equal(named.format, 'mtx');
  assert.deepEqual(await valuesOf(named), await valuesOf(fromDisk));
});

test('a folder of several GEO samples asks which one to open', async () => {
  const { served } = await geoSample();
  const files = new Map();
  for (const sample of ['GSM7_PBMC-', 'GSM8_PBMC-']) {
    for (const [name, bytes] of served) files.set(name.replace('GSM7_PBMC-', sample), new File([bytes], name));
  }
  let asked = null;
  const opened = await openDatasetStore({ source: { files, rootName: 'GSE7_RAW' } }, {
    decodedChunkCacheBytes: CACHE_BYTES,
    transcoding: { choose: async choice => { asked = choice; return 1; } },
  });
  assert.equal(opened.format, 'mtx');
  assert.match(asked.question, /GSE7_RAW holds 2 MatrixMarket samples/);
  assert.deepEqual(asked.options, ['GSM7_PBMC-matrix.mtx.gz', 'GSM8_PBMC-matrix.mtx.gz']);
});

/** Every decompressed byte of an R file's pieces. */
async function drain(pieces) {
  const parts = [];
  for await (const piece of pieces) parts.push(piece);
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

test('an .rds.gz is told single- or double-gzipped by its content, and streams into the parser in pieces', async () => {
  const once = await corpus('rds/seurat5_gzip.rds');
  const plain = new Uint8Array(gunzipSync(once));
  const twice = new Uint8Array(gzipSync(once));
  const pieces = [];
  const fileOf = bytes => ({
    size: bytes.length,
    read: async (offset, length) => {
      pieces.push(length);
      return bytes.subarray(offset, offset + length);
    },
  });
  for (const [bytes, wraps] of [[once, ['gzip']], [twice, ['gzip', 'gzip']]]) {
    pieces.length = 0;
    const unwrapped = await decompressed(readInOrder(fileOf(bytes), { pieceBytes: 4099 }));
    assert.deepEqual(unwrapped.compressions, wraps);
    const out = await drain(unwrapped.pieces);
    assert.deepEqual(out, plain, 'the same serialized object, however often it was gzipped');
    assert.ok(pieces.every(length => length <= 4099), 'read in pieces, never whole');
    const parsed = await readRFile(fileOf(bytes));
    assert.deepEqual(parsed.compressions, wraps);
    assert.equal(parsed.container, 'rds');
  }
  // The name does not decide: a doubly gzipped file named .rds, a singly
  // gzipped one named .rds.gz, both open as the same object.
  const cells = async (bytes, name) => {
    const opened = await openDatasetStore({ source: { file: new File([bytes], name) } }, { decodedChunkCacheBytes: CACHE_BYTES });
    assert.equal(opened.format, 'rds');
    const obs = opened.root.get('obs');
    return [...await obs.get(obs.attrs._index).read()];
  };
  const expected = await cells(once, 'pbmc.rds');
  assert.deepEqual(await cells(twice, 'GSM1_pbmc.rds.gz'), expected);
  assert.deepEqual(await cells(once, 'GSM1_pbmc.rds.gz'), expected);
  assert.deepEqual(await cells(twice, 'pbmc.rds'), expected);
});

test('a MatrixMarket matrix of several feature types opens as one modality per type, as a 10x file does', async () => {
  const { AnnDataReader } = await import('../assets/js/data/anndata/reader.js');
  // A multiome matrix: genes and peaks interleaved in features.tsv, 4 cells.
  const features = [
    ['ENSG1', 'GENE1', 'Gene Expression'],
    ['chr1:1-100', 'chr1:1-100', 'Peaks'],
    ['ENSG2', 'GENE2', 'Gene Expression'],
    ['chr1:200-300', 'chr1:200-300', 'Peaks'],
    ['chr2:5-50', 'chr2:5-50', 'Peaks'],
  ];
  const entries = [[1, 1, 3], [2, 1, 4], [3, 2, 5], [5, 3, 6], [3, 4, 7], [1, 4, 8]];
  const text = rows => new TextEncoder().encode(rows.map(row => row.join('\t')).join('\n') + '\n');
  const matrix = new TextEncoder().encode(
    '%%MatrixMarket matrix coordinate integer general\n' +
    `5 4 ${entries.length}\n` + entries.map(row => row.join(' ')).join('\n') + '\n'
  );
  const files = new Map([
    ['x/matrix.mtx', new File([matrix], 'matrix.mtx')],
    ['x/features.tsv', new File([text(features)], 'features.tsv')],
    ['x/barcodes.tsv', new File([text([['A'], ['B'], ['C'], ['D']])], 'barcodes.tsv')],
    ['x/umap.csv', new File([text([['barcode', 'UMAP_1', 'UMAP_2'], ['A', 0, 1], ['B', 1, 0], ['C', 2, 2], ['D', 3, 1]].map(row => [row.join(',')]))], 'umap.csv')],
  ]);
  const opened = await openDatasetStore({ source: { files, rootName: 'x' } }, { decodedChunkCacheBytes: CACHE_BYTES, transcoding: { memory: true } });
  const reader = new AnnDataReader();
  await reader.open(opened.root, { format: opened.readerFormat, name: opened.name });
  const probe = await reader.probeMapping();
  assert.deepEqual(probe.modalities.map(item => item.name), ['Gene Expression', 'Peaks'], 'gene expression first, the default');
  const peaks = opened.root.get('mod/Peaks/X');
  const genes = opened.root.get('mod/Gene Expression/X');
  const peakVar = opened.root.get('mod/Peaks/var');
  assert.deepEqual([...await peakVar.get(peakVar.attrs._index).read()], ['chr1:1-100', 'chr1:200-300', 'chr2:5-50']);
  // The store keeps its cells in priority order: row r is cell positions[r].
  const positions = await opened.root.get('obs/cellucid_original_position').read();
  const dense = async (node, nFeatures) => {
    const indptr = await node.get('indptr').read();
    const indices = await node.get('indices').read();
    const data = await node.get('data').read();
    const out = Array.from({ length: 4 }, () => new Array(nFeatures).fill(0));
    if (node.attrs['encoding-type'] === 'csr_matrix') {
      for (let row = 0; row < 4; row++) for (let k = indptr[row]; k < indptr[row + 1]; k++) out[positions[row]][indices[k]] = data[k];
    } else {
      for (let f = 0; f < nFeatures; f++) for (let k = indptr[f]; k < indptr[f + 1]; k++) out[positions[indices[k]]][f] = data[k];
    }
    return out;
  };
  // Features 1 and 3 are the genes, 2, 4 and 5 the peaks, each in its own
  // modality's columns in order.
  assert.deepEqual(await dense(genes, 2), [[3, 0], [0, 5], [0, 0], [8, 7]]);
  assert.deepEqual(await dense(peaks, 3), [[4, 0, 0], [0, 0, 0], [0, 0, 6], [0, 0, 0]]);
  reader.close();
});

test('a cell table\'s clustering columns are categories even when their labels are numbers', async () => {
  const { isClusteringColumn, joinTable } = await import('../assets/js/data/anndata/transcode/tables.js');
  for (const name of ['Cluster', 'clusters', 'seurat_clusters', 'leiden', 'louvain_r1', 'kmeans_10_clusters', 'graphclust', 'RNA_snn_res.0.8_clusters']) {
    assert.ok(isClusteringColumn(name), name);
  }
  for (const name of ['n_counts', 'percent.mt', 'clustered_score_x', 'UMAP_1']) assert.ok(!isClusteringColumn(name), name);
  const table = {
    names: ['barcode', 'Cluster', 'leiden', 'n_counts'],
    columns: [['A', 'B', 'C'], ['2', '10', '2'], ['0', '1', '1'], ['100', '250', '75']],
    rows: 3,
  };
  const { columns } = joinTable(table, ['A', 'B', 'C']);
  const byName = Object.fromEntries(columns.map(entry => [entry.name, entry.column]));
  assert.equal(byName.Cluster.kind, 'categorical');
  assert.deepEqual(byName.Cluster.categories, ['2', '10'], 'numeric labels in numeric order');
  assert.deepEqual(Array.from(byName.Cluster.codes), [0, 1, 0]);
  assert.equal(byName.leiden.kind, 'categorical');
  assert.equal(byName.n_counts.kind, 'numbers');
});

test('a cell table longer than the engine\'s argument limit is read whole', async () => {
  // Math.max(...rows) over a 500,000-cell projection.csv exceeded the
  // argument limit, so the table was dropped and the folder refused as
  // having no embedding.
  const { readTable } = await import('../assets/js/data/anndata/transcode/tables.js');
  const rows = 300_000;
  const lines = ['Barcode,UMAP-1,UMAP-2'];
  for (let i = 0; i < rows; i++) lines.push(`C${i}-1,${i % 97},${-(i % 89)}`);
  const bytes = new TextEncoder().encode(`${lines.join('\n')}\n`);
  const reader = { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) };
  const table = await readTable(reader);
  assert.equal(table.rows, rows);
  assert.deepEqual(table.names, ['Barcode', 'UMAP-1', 'UMAP-2']);
  assert.equal(table.columns[1][rows - 1], String((rows - 1) % 97));
});
