/**
 * What a reader says of input it cannot read: whatever the format and
 * source, a failure the person can act on is one
 * sentence written for them (`details.explained`), naming the file and what
 * to do, never only "could not open" with the rule under Details.
 *
 * - A web page in place of data: a Zarr folder's host answering a missing
 *   object with its site page (a single-page site: 200 `text/html`) reads
 *   that object as absent, as a 404 does; a link answered with a page, or a
 *   page saved under a data file's name, is said to be one; a catalog file
 *   answered with a page is not found, not a network failure.
 * - A damaged R file is explained as the HDF5 and Zarr readers' are.
 * - A file whose AnnData parts break the format is explained, at opening
 *   and at a read, as the file's problem with what to do.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createAnnDataReaderHandler } from '../assets/js/data/anndata-reader-worker.js';
import { openDatasetStore } from '../assets/js/data/anndata/open.js';
import { fetchJson, DataSourceErrorCode } from '../assets/js/data/data-source.js';
import { downloadRemoteFile } from '../assets/js/data/sources/remote-file.js';
import { isWebPageAnswer, looksLikeWebPage } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { openZipArchive } from '../assets/js/formats/zip/index.js';
import { createZipWriter } from '../assets/js/formats/zip/writer.js';
import { group, numericDataset, stringDataset, writeHdf5 } from '../assets/js/formats/hdf5/writer.js';
import { array, categorical, dense, minimalAnnData, nullable, sparse, strings, zarrEntries } from './helpers/anndata-store.mjs';

const OPTIONS = { decodedChunkCacheBytes: 0 };
const encoder = new TextEncoder();
const PAGE = encoder.encode('<!DOCTYPE html>\n<html lang="en"><head><title>App</title></head><body><div id="root"></div></body></html>');

/** A reader worker's handler, called as the page calls it; a failure rejects with its wire form. */
function readerWorker() {
  const handle = createAnnDataReaderHandler({ post: () => {} });
  let id = 0;
  const call = async (method, ...args) => {
    const { reply } = await handle({ id: ++id, method, args });
    if (reply.error) throw Object.assign(new Error(reply.error.message), { details: reply.error.details });
    return reply.result;
  };
  return { call, close: () => handle({ id: -1, method: 'close', args: [] }) };
}

async function zipped(entries, name = 'cells.zarr.zip') {
  const parts = [];
  const zip = createZipWriter({ write: part => { parts.push(part); } });
  for (const [path, bytes] of entries) await zip.add(path, bytes);
  await zip.finish();
  return new File(parts, name);
}

/** Store entries with their consolidated metadata, as anndata writes a store for a web host. */
function consolidated(tree) {
  const entries = zarrEntries(tree);
  const metadata = {};
  for (const [key, bytes] of entries) {
    if (/(^|\/)\.z(group|attrs|array)$/.test(key)) metadata[key] = JSON.parse(new TextDecoder().decode(bytes));
  }
  entries.set('.zmetadata', encoder.encode(JSON.stringify({ zarr_consolidated_format: 1, metadata })));
  return entries;
}

function withFetch(t, fetchImpl) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  t.after(() => { globalThis.fetch = original; });
}

const explainedAs = pattern => error => {
  assert.equal(error.details?.explained, true, `explained: ${error.message}`);
  assert.match(error.message, pattern);
  return true;
};

test('a web page is told apart from data by its first bytes and its answer\'s type', () => {
  assert.equal(looksLikeWebPage(PAGE), true);
  assert.equal(looksLikeWebPage(encoder.encode('﻿  <!-- shell -->\n<html><body>x</body></html>')), true);
  assert.equal(looksLikeWebPage(encoder.encode('<HEAD><title>t</title></HEAD>')), true);
  // No format Cellucid reads starts as a page does.
  for (const data of ['\x89HDF\r\n\x1a\n', 'PK\x03\x04', '%%MatrixMarket matrix coordinate', '{"zarr_format": 2}', 'X\n', '<?xml version="1.0"?>', '<htmlish>']) {
    assert.equal(looksLikeWebPage(encoder.encode(data)), false, JSON.stringify(data));
  }
  assert.equal(looksLikeWebPage(new Uint8Array(0)), false);
  const answer = type => new Response(PAGE, { headers: type === null ? {} : { 'Content-Type': type } });
  assert.equal(isWebPageAnswer(answer('text/html; charset=utf-8'), PAGE), true);
  assert.equal(isWebPageAnswer(answer('text/html')), true, 'a body not read is judged by its type');
  assert.equal(isWebPageAnswer(answer('application/octet-stream'), PAGE), false);
  assert.equal(isWebPageAnswer(answer('text/html'), encoder.encode('\x89HDF\r\n\x1a\n')), false, 'a mislabelled data file is data');
});

test('a Zarr folder whose host answers a missing object with its site page reads that object as absent', async t => {
  const tree = minimalAnnData({ nObs: 4, genes: ['a', 'b'], obs: { kind: categorical([0, 1, 0, 1], ['x', 'y']) } });
  const entries = consolidated(tree);
  // Left out, as zarr-python leaves out a chunk of fill values only.
  entries.delete('obs/kind/codes/0');
  entries.delete('X/0.0');
  const asked = [];
  withFetch(t, async url => {
    const key = decodeURIComponent(new URL(String(url)).pathname.slice('/site/cells.zarr/'.length));
    asked.push(key);
    const bytes = entries.get(key);
    // A single-page site: its page, 200, for every path it has nothing at.
    return bytes === undefined
      ? new Response(PAGE, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      : new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  });
  const worker = readerWorker();
  t.after(() => worker.close());
  const opened = await worker.call('open', { source: { url: 'https://pages.example.org/site/cells.zarr/', name: 'cells.zarr' } });
  assert.equal(opened.nObs, 4);
  const field = await worker.call('getObsField', 'kind');
  assert.deepEqual(Array.from(field.codes), [0, 0, 0, 0], 'the missing codes chunk is its fill value');
  assert.deepEqual(Array.from((await worker.call('getMatrixColumn', 'X', 1)).column), [0, 0, 0, 0], 'the missing X chunk is its fill value');
  assert.ok(asked.includes('obs/kind/codes/0') && asked.includes('X/0.0'));
});

test('a store folder a site has nothing at is said to be missing, not damaged JSON', async t => {
  withFetch(t, async () => new Response(PAGE, { status: 200, headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(
    openDatasetStore({ source: { url: 'https://pages.example.org/site/typo.zarr/', name: 'typo.zarr' } }, OPTIONS),
    explainedAs(/no Zarr store is at this address/)
  );
});

test('a link answered with a web page is said to be one, with what to do, whatever the read', async t => {
  const answers = [
    // The whole file asked for, answered with a sign-in page.
    async () => new Response(PAGE, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    // A range asked for, answered with a page (a preview host ignoring it).
    async () => new Response(PAGE, { status: 206, headers: { 'Content-Type': 'text/html', 'Content-Range': `bytes 0-${PAGE.length - 1}/4096` } }),
  ];
  for (const answer of answers) {
    withFetch(t, answer);
    await assert.rejects(
      openDatasetStore({ source: { file: { url: 'https://share.example.org/cells.h5ad', size: 4096, name: 'cells.h5ad' } } }, OPTIONS),
      explainedAs(/^cells\.h5ad: share\.example\.org answered with a web page instead of the file .* direct download link/)
    );
  }
  // Its first bytes read with the probe (`describeRemoteFile`): said before any read.
  await assert.rejects(
    openDatasetStore({ source: { file: { url: 'https://share.example.org/cells.h5ad', size: PAGE.length, name: 'cells.h5ad', head: { bytes: PAGE, etag: null, ms: 5 } } } }, OPTIONS),
    explainedAs(/^cells\.h5ad: its link answered with a web page .* direct download link/)
  );
});

test('a file downloaded whole whose link answers with a web page is refused before anything is kept', async t => {
  withFetch(t, async () => new Response(PAGE, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  let stored = 0;
  const environment = { navigator: { storage: { getDirectory: async () => { stored++; throw new Error('nothing is kept'); } } } };
  await assert.rejects(
    downloadRemoteFile({ url: 'https://share.example.org/cells.h5ad.gz', name: 'cells.h5ad.gz', size: null, compression: 'gzip' }, { environment }),
    explainedAs(/^cells\.h5ad\.gz: share\.example\.org answered with a web page instead of the file/)
  );
  assert.equal(stored, 0, 'the page is never written to this browser\'s storage');
});

test('a web page saved under a data file\'s name is said to be one, for every format the name promises', async () => {
  for (const name of ['cells.h5ad', 'cells.zarr.zip', 'cells.loom', 'cells.h5mu', 'object.rds', 'filtered_feature_bc_matrix.h5']) {
    await assert.rejects(
      openDatasetStore({ source: { file: new File([PAGE], name) } }, OPTIONS),
      explainedAs(new RegExp(`^${name.replace(/\./g, '\\.')} is a web page saved under a data file's name, not the data\\. Download the file itself`)),
      name
    );
  }
});

test('a catalog file answered with a site page is not found, not a network failure to try again', async t => {
  withFetch(t, async () => new Response(PAGE, { status: 200, headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(fetchJson('https://pages.example.org/catalog/datasets.json', 'remote'), error => {
    assert.equal(error.code, DataSourceErrorCode.NOT_FOUND);
    assert.match(error.message, /answered with a web page/);
    return true;
  });
});

test('a damaged or truncated R file is explained with what to do, for every compression', async () => {
  const archive = await openZipArchive(createByteReader(bytesByteSource(new Uint8Array(readFileSync(new URL('./fixtures/rds/corpus.zip', import.meta.url))), { name: 'corpus.zip' })));
  for (const name of ['seurat5_gzip.rds', 'seurat5_xz.rds', 'seurat5_bzip2.rds', 'sce.rds']) {
    const bytes = (await archive.entry(`rds/${name}`).read()).slice();
    await assert.rejects(
      openDatasetStore({ source: { file: new File([bytes.subarray(0, bytes.length >> 1)], name) } }, OPTIONS),
      error => {
        assert.equal(error.details?.explained, true, `${name}: ${error.message}`);
        assert.match(error.message, /^This R object \(\.rds\) file could not be read \(The (gzip|xz|bzip2) stream .*\)\. It may be corrupted or truncated\. In R, /);
        // The browser's decompressor may name no reason: no empty brackets.
        assert.doesNotMatch(error.message, /\(\)/);
        return true;
      },
      name
    );
  }
});

/** Open a crafted store as a `.zarr.zip` in the reader worker; `read` reads after opening. */
async function failureOf(tree, read = null) {
  const worker = readerWorker();
  try {
    await worker.call('open', { source: { file: await zipped(zarrEntries(tree)) } });
    if (read === null) return null;
    await read(worker.call);
    return null;
  } catch (error) {
    return error;
  } finally {
    await worker.close();
  }
}

test('a file whose AnnData parts break the format is explained at opening, naming the element and what to do', async () => {
  const cases = [
    ['obs without its index', tree => { delete tree.children.obs.children._index; }, /obs index child '_index' was not found/],
    ['a numeric obs index', tree => { tree.children.obs.children._index = array(new Float32Array([1, 2, 3, 4])); }, /Observation index encoding-type must be exactly 'string-array'/],
    ['a column listed twice', tree => { tree.children.obs.attrs['column-order'] = ['kind', 'kind']; }, /column-order contains duplicate column 'kind'/],
    ['no var', tree => { delete tree.children.var; }, /var is required/],
    ['X with fewer rows than obs', tree => { tree.children.X = dense(new Float32Array(6), [3, 2]); }, /length 4 does not match 3/],
    ['sparse data and indices of different lengths', tree => {
      tree.children.X = sparse({ shape: [4, 2], data: new Float32Array([1]), indices: new Int32Array([0, 1]), indptr: new Int32Array([0, 1, 2, 2, 2]) });
    }, /data and indices lengths differ/],
    ['a dense X of text', tree => { tree.children.X = strings(Array.from({ length: 8 }, (_, i) => `v${i}`), { shape: [4, 2] }); }, /Dense X encoding-type must be exactly 'array'/],
  ];
  for (const [label, breakIt, rule] of cases) {
    const tree = minimalAnnData({ nObs: 4, genes: ['a', 'b'], obs: { kind: categorical([0, 1, 0, 1], ['x', 'y']) } });
    breakIt(tree);
    const error = await failureOf(tree);
    assert.ok(error !== null, `${label} is refused`);
    assert.equal(error.details?.explained, true, `${label}: ${error.message}`);
    assert.match(error.message, /^This AnnData Zarr store breaks the AnnData format: /, label);
    assert.match(error.message, rule, label);
    assert.match(error.message, /Write it again with anndata/, label);
  }
});

test('a field or gene whose stored values break the format is explained at its read', async () => {
  const fields = [
    ['codes past the categories', categorical([0, 5, 0, 1], ['x', 'y']), /Categorical code 5 for 'bad' is outside/],
    ['a category named twice', categorical([0, 1, 0, 1], ['x', 'x']), /contain a duplicate label/],
    ['a nullable mask shorter than its values', nullable('nullable-integer', [1n, 2n, 3n, 4n], [0, 1, 0]), /Nullable mask for 'bad' length 3 does not match 4/],
  ];
  for (const [label, column, rule] of fields) {
    const tree = minimalAnnData({ nObs: 4, genes: ['a', 'b'], obs: { bad: column } });
    const error = await failureOf(tree, call => call('getObsField', 'bad'));
    assert.ok(error !== null, `${label} is refused`);
    assert.equal(error.details?.explained, true, `${label}: ${error.message}`);
    assert.match(error.message, /^This AnnData Zarr store breaks the AnnData format: /, label);
    assert.match(error.message, rule, label);
  }
  const matrices = [
    ['a CSR column index past the shape', sparse({ shape: [4, 2], data: new Float32Array([1, 2]), indices: new Int32Array([0, 5]), indptr: new Int32Array([0, 1, 1, 2, 2]) }),
      /Sparse matrix column index 5 at entry 1 is outside its 2-column shape/],
    // Rising past the stored values, then falling: the value past them is named, not the last.
    ['CSR pointers past the stored values', sparse({ shape: [4, 2], data: new Float32Array([1, 2]), indices: new Int32Array([0, 1]), indptr: new Int32Array([0, 1, 3, 2, 2]) }),
      /Sparse X indptr 3 at row 2 is past its 2 stored values/],
    ['a CSC row index past the shape', sparse({ format: 'csc', shape: [4, 2], data: new Float32Array([1, 2]), indices: new Int32Array([0, 9]), indptr: new Int32Array([0, 1, 2]) }),
      /Sparse column row index 9 at entry 1 is outside its 4-row shape/],
  ];
  for (const [label, X, rule] of matrices) {
    const tree = minimalAnnData({ nObs: 4, genes: ['a', 'b'], X });
    const error = await failureOf(tree, call => call('getMatrixColumn', 'X', 1));
    assert.ok(error !== null, `${label} is refused`);
    assert.equal(error.details?.explained, true, `${label}: ${error.message}`);
    assert.match(error.message, rule, label);
  }
});

test('a format presented as AnnData whose parts break its layout is explained in its own terms', async t => {
  // A Cell Ranger matrix naming one gene for four features.
  const texts = (prefix, count) => stringDataset(Array.from({ length: count }, (_, i) => `${prefix}${i}`));
  const matrix = writeHdf5(group({}, [['matrix', group({}, [
    ['barcodes', texts('AAAC-', 6)],
    ['data', numericDataset('int32', [3], new Int32Array([1, 2, 3]))],
    ['indices', numericDataset('int64', [3], new BigInt64Array([0n, 1n, 2n]))],
    ['indptr', numericDataset('int64', [7], new BigInt64Array([0n, 1n, 2n, 3n, 3n, 3n, 3n]))],
    ['shape', numericDataset('int32', [2], new Int32Array([4, 6]))],
    ['features', group({}, [
      ['id', texts('E', 4)], ['name', texts('G', 1)],
      ['feature_type', stringDataset(Array(4).fill('Gene Expression'))], ['genome', stringDataset(Array(4).fill('GRCh38'))],
    ])],
  ])]]));
  const projection = `Barcode,UMAP-1,UMAP-2\n${Array.from({ length: 6 }, (_, i) => `AAAC-${i},${i},${(i * 2) % 5}`).join('\n')}\n`;
  const worker = readerWorker();
  t.after(() => worker.close());
  await assert.rejects(worker.call('open', { source: { rootName: 'outs', files: new Map([
    ['outs/filtered_feature_bc_matrix.h5', new File([matrix], 'filtered_feature_bc_matrix.h5')],
    ['outs/analysis/umap/gene_expression_2_components/projection.csv', new File([projection], 'projection.csv')],
  ]) } }), explainedAs(/^This Cell Ranger outs\/ folder file is not laid out as its format requires: Variable index length 1 does not match 4\. Read filtered_feature_bc_matrix\.h5 with scanpy/));
});

test('a file is refused for what it is, never for an embedding a format it is not would have', async t => {
  // A Loom or 10x file missing the part its layout needs is not read as AnnData
  // and refused as "has no cell embedding"; nor is an HDF5 file or Zarr
  // store of no format at all, nor an AnnData store without obs.
  const worker = readerWorker();
  t.after(() => worker.close());
  const refusalOf = async file => {
    try {
      await worker.call('open', { source: { file } });
    } catch (error) {
      return error;
    }
    return null;
  };
  const texts = (prefix, count) => stringDataset(Array.from({ length: count }, (_, i) => `${prefix}${i}`));
  const loom = matrix => writeHdf5(group({}, [
    ...(matrix === null ? [] : [['matrix', matrix]]),
    ['col_attrs', group({}, [['CellID', texts('c', 4)], ['X_umap', numericDataset('float32', [4, 2], new Float32Array(8))]])],
    ['row_attrs', group({}, [['Gene', texts('g', 3)]])],
  ]));
  const tenx = arrays => writeHdf5(group({}, [['matrix', group({}, [
    ['barcodes', texts('AAAC-', 4)],
    ...arrays,
    ['shape', numericDataset('int32', [2], new Int32Array([3, 4]))],
    ['features', group({}, [['id', texts('E', 3)], ['name', texts('G', 3)], ['feature_type', stringDataset(Array(3).fill('Gene Expression'))]])],
  ])]]));
  const loomRule = /a Loom file holds its genes × cells matrix at \/matrix, a two-dimensional array; this one /;
  const cases = [
    ['a Loom file without /matrix', new File([loom(null)], 'cells.loom'),
      /^This Loom \(\.loom\) file is not laid out as its format requires: /, loomRule, /this one has none\. Write it again with loompy/],
    ['a Loom file whose /matrix is one-dimensional', new File([loom(numericDataset('float32', [12], new Float32Array(12)))], 'cells.loom'),
      loomRule, /holds a 1-dimensional array there/],
    ['a Loom file whose /matrix is a group', new File([loom(group({}, []))], 'cells.loom'), loomRule, /holds a group there/],
    // The content decides the format the refusal speaks of, not the name.
    ['a Loom file named .h5', new File([loom(null)], 'cells.h5'), /^This Loom \(\.loom\) file is not laid out/],
    ['a 10x matrix without its data and pointers', new File([tenx([['indices', numericDataset('int64', [1], new BigInt64Array([0n]))]])], 'filtered_feature_bc_matrix.h5'),
      /^This 10x Cell Ranger HDF5 \(\.h5\) file is not laid out as its format requires: its matrix group \/matrix has no data and indptr arrays/],
    ['an HDF5 file of no format, named .h5ad', new File([writeHdf5(group({}, [['notes', texts('n', 3)]]))], 'cells.h5ad'),
      /^cells\.h5ad is an HDF5 file, but not in any format Cellucid reads from one \(AnnData \(\.h5ad\), Loom \(\.loom\), /, /it has no obs, var or X/],
    ['an HDF5 file of no format, named .loom', new File([writeHdf5(group({}, [['notes', texts('n', 3)]]))], 'cells.loom'),
      /^cells\.loom is an HDF5 file, but not in any format Cellucid reads/],
    ['a Zarr store of no format', await zipped(zarrEntries({ kind: 'group', attrs: {}, children: { notes: strings(['a', 'b']) } })),
      /^cells\.zarr\.zip is a Zarr store, but not in any format Cellucid reads from one/],
  ];
  for (const [label, file, ...rules] of cases) {
    const error = await refusalOf(file);
    assert.ok(error !== null, `${label} is refused`);
    assert.equal(error.details?.explained, true, `${label}: ${error.message}`);
    assert.doesNotMatch(error.message, /no cell embedding/, label);
    for (const rule of rules) assert.match(error.message, rule, label);
  }
  // An AnnData store without obs (nor an embedding) is refused for its obs.
  const tree = minimalAnnData({ nObs: 4, genes: ['a', 'b'], obsm: null });
  delete tree.children.obs;
  delete tree.children.obsm;
  const error = await failureOf(tree);
  assert.ok(error !== null);
  assert.match(error.message, /^This AnnData Zarr store breaks the AnnData format: .*obs is required/);
  assert.doesNotMatch(error.message, /no cell embedding/);
});

test('a truncated HDF5 file names both sizes in bytes', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('./browser/fixtures/current-ui-smoke.h5ad', import.meta.url)));
  await assert.rejects(
    openDatasetStore({ source: { file: new File([bytes.subarray(0, 1000)], 'cells.h5ad') } }, OPTIONS),
    explainedAs(/the superblock says it is [\d,]+ bytes long, but it is 1,000 bytes\./)
  );
});
