/**
 * The AnnData Zarr contract: what the app reads from an AnnData Zarr store,
 * and what it refuses, through the Zarr package (`formats/zarr`) and the one
 * AnnData reader (`data/anndata`), and through the public `AnnDataFileSource`.
 *
 * Stores are real: built in memory as Zarr v2 entries (`.zgroup`, `.zattrs`,
 * `.zarray` and chunk bytes, including canonical frames written by
 * numcodecs) and opened with `openZarr`. Format-neutral reader guarantees are
 * also covered in `anndata-reader-contract.test.mjs`; the codecs on their own
 * in `zarr-format-codecs.test.mjs` and `zarr-format-conformance.test.mjs`.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ZarrFormatError,
  ZarrUnsupportedError,
  memoryStore,
  openZarr,
} from '../assets/js/formats/zarr/index.js';
import { lz4DecodeBlockInto } from '../assets/js/formats/zarr/codecs/lz4.js';
import { vlenDecode } from '../assets/js/formats/zarr/codecs/vlen.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { readSparseMatrix, sparseContract } from '../assets/js/data/anndata/sparse.js';
import { nullableContract } from '../assets/js/data/anndata/dataframe.js';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { asWorkerLoader } from './helpers/worker-loader.mjs';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { getOpeningProgress } from '../assets/js/data/opening-progress.js';
import {
  connectivityEdgesOf,
  extractConnectivityEdges,
} from '../assets/js/data/connectivity-edges.js';
import {
  EmbeddingLoadError,
  describeAnnDataProbes,
} from '../assets/js/data/data-mapping-candidates.js';
import {
  annData,
  array,
  categorical,
  chunksOf,
  dataFrame,
  dense,
  group,
  mapping,
  minimalAnnData,
  nullable,
  recordingView,
  sparse,
  stringFrame,
  strings,
  zarrEntries,
} from './helpers/anndata-store.mjs';
import { edgeWeightsFrom, edgeWeightsOf, edgeListOf } from './helpers/connectivity-edges.mjs';

const MiB = 1024 * 1024;
const encoder = new TextEncoder();
const SUPERSEDED = /dataset.*(changed|superseded)|superseded.*dataset/i;

// ---------------------------------------------------------------------------
// Stores built from entries.
// ---------------------------------------------------------------------------

/** JSON metadata bytes (a string is written as it is). */
function json(value) {
  return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value));
}

function isChunkKey(key) {
  return !/(^|\/)\.z(group|attrs|array|metadata)$/.test(key);
}

/**
 * A memory store over entries (key → bytes) that lists every chunk key it
 * serves in `fetched`; `onChunk(key)` runs before a chunk is served and may
 * wait, or throw to fail that read.
 */
function entryStore(entries, { name = 'fixture.zarr', onChunk = null } = {}) {
  const inner = memoryStore(entries, { name });
  const fetched = [];
  const backend = {
    name,
    async get(key, options) {
      if (onChunk !== null && isChunkKey(key)) await onChunk(key);
      const bytes = await inner.get(key, options);
      if (bytes !== null && isChunkKey(key)) fetched.push(key);
      return bytes;
    },
    getMany(keys, options) {
      return Promise.all(keys.map(key => backend.get(key, options)));
    },
    getRanges: inner.getRanges,
    storedSize: inner.storedSize,
    list: inner.list,
    stats: inner.stats,
  };
  return { backend, fetched };
}

/** Open entries as a Zarr store; `reads` records every array read made through it. */
async function openRoot(entries, { name = 'fixture.zarr', onChunk = null, decodedChunkCacheBytes = 64 * MiB } = {}) {
  const { backend, fetched } = entryStore(entries, { name, onChunk });
  const opened = await openZarr(backend, { decodedChunkCacheBytes });
  const reads = [];
  return { opened, root: recordingView(opened, reads), fetched, reads };
}

/** Open entries (or a described tree) as an AnnData reader. */
async function openAnnData(entriesOrTree, {
  name = 'fixture.zarr',
  onChunk = null,
  decodedChunkCacheBytes = 64 * MiB,
  reader = new AnnDataReader(),
} = {}) {
  const entries = entriesOrTree instanceof Map ? entriesOrTree : zarrEntries(entriesOrTree);
  const { opened, root, fetched, reads } = await openRoot(entries, { name, onChunk, decodedChunkCacheBytes });
  await reader.open(root, { format: ZARR_FORMAT, name, decodedChunkBytes: decodedChunkCacheBytes });
  return { reader, opened, root, fetched, reads };
}

/** Reads of one array path recorded by `openRoot`. */
function readsOf(reads, path) {
  return reads.filter(read => read.path === `/${path}`);
}

/** One array, alone in a store, read whole. */
async function readArray(path, meta, chunks = {}) {
  const entries = new Map([['.zgroup', json({ zarr_format: 2 })], [`${path}/.zarray`, json(meta)]]);
  for (const [key, bytes] of Object.entries(chunks)) entries.set(`${path}/${key}`, bytes);
  const { opened } = await openRoot(entries);
  return opened.get(path).read();
}

/** A promise with its resolver. */
function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * An `onChunk` that holds the first fetch of `key` until released, and says
 * when that fetch has started.
 */
function holdFirst(key) {
  const started = deferred();
  const released = deferred();
  let held = false;
  return {
    started: started.promise,
    release: () => released.resolve(),
    async onChunk(chunkKey) {
      if (held || chunkKey !== key) return;
      held = true;
      started.resolve();
      await released.promise;
    },
  };
}

function metadata(overrides) {
  return {
    zarr_format: 2,
    shape: [1],
    chunks: [1],
    dtype: '<i4',
    compressor: null,
    fill_value: 0,
    filters: null,
    order: 'C',
    ...overrides
  };
}

function currentArrayAttrs(meta, overrides = {}) {
  const dtype = meta?.dtype;
  const isString =
    dtype === '|O' ||
    (typeof dtype === 'string' && /^[|<>=]?[SU]/.test(dtype));
  return {
    'encoding-type': isString ? 'string-array' : 'array',
    'encoding-version': '0.2.0',
    ...overrides,
  };
}

/** Write one array's metadata and chunks into `entries` (replacing what was there). */
function setArray(entries, path, meta, chunks = {}, attrs = currentArrayAttrs(meta)) {
  for (const key of [...entries.keys()]) {
    if (key.startsWith(`${path}/`)) entries.delete(key);
  }
  entries.set(`${path}/.zarray`, json(meta));
  if (attrs !== null) entries.set(`${path}/.zattrs`, json(attrs));
  for (const [key, bytes] of Object.entries(chunks)) entries.set(`${path}/${key}`, bytes);
}

function littleEndianBytes(values, setter, bytesPerValue) {
  const bytes = new Uint8Array(values.length * bytesPerValue);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view[setter](index * bytesPerValue, value, true);
  });
  return bytes;
}

function vlenUtf8Bytes(values) {
  const encoded = values.map(value => encoder.encode(value));
  const totalBytes = 4 + encoded.reduce(
    (sum, bytes) => sum + 4 + bytes.length,
    0
  );
  const result = new Uint8Array(totalBytes);
  const view = new DataView(result.buffer);
  view.setUint32(0, values.length, true);
  let cursor = 4;
  for (const bytes of encoded) {
    view.setUint32(cursor, bytes.length, true);
    cursor += 4;
    result.set(bytes, cursor);
    cursor += bytes.length;
  }
  return result;
}

function bytesFromHex(hex) {
  return Uint8Array.from(hex.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
}

function bytesFromBase64(base64) {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

/** A real in-memory File, as a folder picker hands one over. */
function memoryFile(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return new File([bytes], 'memory');
}

/** A folder selection of a store's entries (bytes become Files; other objects are kept). */
function fileListFromMap(files, rootName) {
  return Array.from(files, ([path, value]) => {
    const file = value instanceof Uint8Array ? memoryFile(value) : value;
    return {
      name: path.split('/').at(-1),
      webkitRelativePath: `${rootName}/${path}`,
      size: Number.isFinite(file.size) ? file.size : 0,
      text: () => file.text(),
      arrayBuffer: () => file.arrayBuffer()
    };
  });
}

function captureDownloadNotifications(t) {
  const notifications = getNotificationCenter();
  const methodNames = [
    'startDownload',
    'updateDownload',
    'completeDownload',
    'failDownload',
    'dismissDownload',
  ];
  const originals = new Map(
    methodNames.map(name => [name, notifications[name]])
  );
  const events = [];
  let nextId = 0;

  notifications.startDownload = name => {
    const id = `download-${++nextId}`;
    events.push({ id, kind: 'start', name });
    return id;
  };
  notifications.updateDownload = (id, loaded, total) => {
    events.push({ id, kind: 'update', loaded, total });
  };
  notifications.completeDownload = id => {
    events.push({ id, kind: 'complete' });
  };
  notifications.failDownload = (id, message) => {
    events.push({ id, kind: 'fail', message });
  };
  notifications.dismissDownload = id => {
    events.push({ id, kind: 'dismiss' });
  };

  t.after(() => {
    for (const [name, method] of originals) {
      if (method === undefined) delete notifications[name];
      else notifications[name] = method;
    }
  });
  return events;
}

/** One gene's column of X, found by its stored var name. */
async function geneColumnByName(reader, name) {
  const index = (await reader.readVarNames('X', null)).index.indexOf(name);
  assert.notEqual(index, -1, `gene '${name}' is on the var index`);
  return reader.getMatrixColumn('X', index);
}

/** One gene's values through a data source's adapter, found in its gene list. */
async function sourceGeneValuesByName(source, name) {
  const list = await source.getGeneList();
  const field = list.fields.find(gene => gene.key === name);
  assert.ok(field, `gene '${name}' is in the gene list`);
  return source.getAdapter().getGeneValues(field.path);
}

/** An adapter whose obsm entries are described from the reader's probes. */
async function adapterWithDescribedObsm(reader, options = {}) {
  const adapter = new BaseAnnDataAdapter(reader, options);
  adapter._describedObsm =
    describeAnnDataProbes(await reader.probeMapping()).obsm;
  return adapter;
}

/**
 * The working store of most tests: two cells (`cell-0`, `cell-1`), genes A
 * and B in a dense float32 X, and a 2-D UMAP.
 */
function completeTree({ embeddingValues, geneValues }) {
  return minimalAnnData({
    nObs: 2,
    genes: ['A', 'B'],
    X: dense(Float32Array.from(geneValues), [2, 2]),
    obsm: mapping({ X_umap_2d: dense(Float32Array.from(embeddingValues), [2, 2]) }),
  });
}

/**
 * `completeTree` whose var index is a nullable string array: opening reads
 * its mask (it checks that no gene name is missing), so a held mask chunk
 * keeps the opening in flight. (A plain string index is not read at opening.)
 */
function slowOpeningTree(values) {
  return minimalAnnData({
    nObs: 2,
    genes: ['A', 'B'],
    X: dense(Float32Array.from(values.geneValues), [2, 2]),
    obsm: mapping({ X_umap_2d: dense(Float32Array.from(values.embeddingValues), [2, 2]) }),
    extra: { var: dataFrame({ _index: nullable('nullable-string-array', ['A', 'B'], [0, 0]) }) },
  });
}

function completeZarrStoreFiles(values) {
  return zarrEntries(completeTree(values));
}

/** A store with `nObs` cells, the given genes, a UMAP, and extra root children. */
function storeWith({ nObs = 2, genes = ['A', 'B'], X = undefined, obs = {}, obsm = undefined, extra = {} } = {}) {
  return minimalAnnData({ nObs, genes, X, obs, obsm, extra });
}

/** A store whose X is the given sparse matrix. */
function sparseStore(options = {}) {
  const shape = options.shape ?? [2, 3];
  return storeWith({
    nObs: shape[0],
    genes: Array.from({ length: shape[1] }, (_, i) => `g${i}`),
    X: sparse({ data: new Float32Array([1, 2]), indices: new Int32Array([0, 2]), indptr: new Int32Array([0, 1, 2]), ...options, shape }),
  });
}

/** A store with a connectivity graph `obsp['connectivities']`. */
function connectivityStore(connectivities, nObs = 2) {
  return storeWith({ nObs, extra: { obsp: mapping({ connectivities }) } });
}

const CANONICAL_SPLIT_BLOSC_BASE64 =
  'AgEhBAAEAAAABAAARQEAABQAAAAAAQAAAAECAwQFBgcICQoLDA0ODxAREhMUFRYX' +
  'GBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZH' +
  'SElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3' +
  'eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaan' +
  'qKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX' +
  '2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/wsAAAAfAAEA' +
  '51AAAAAAAAsAAAAfAAEA51AAAAAAAAsAAAAfAAEA51AAAAAAAA==';

const CANONICAL_VLEN_MEMCPY_HEX =
  '02013301130000001300000023000000' +
  '03000000010000004101000000420100000043';

const CANONICAL_MULTIBLOCK_BLOSC_BASE64 =
  'AgEhBMBFBAAAAAQArQQAABgAAABUBAAACwEAAB8HAQD/////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '51AHBwcHBwsBAAAfAAEA////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '/////////////////////////////////////////+dQAAAAAAALAQAAHwABAP//' +
  '////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '///////////////////nUAAAAAAACwEAAB8AAQD/////////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////51AA' +
  'AAAAAFUAAAAfBwEA//////////////////////9tHwABAP//////////////////' +
  '//////////////////////////////////////////////////9rUAAAAAAA';

const CANONICAL_BLOCKSIZE_HINT_BLOSC_BASE64 =
  'AgEhBBAnAAAQJwAAdAAAABQAAAAUAAAAHwABAP///////////7RQAAAAAAAUAAAA' +
  'HwABAP///////////7RQAAAAAAAUAAAAHwABAP///////////7RQAAAAAAAUAAAA' +
  'HwABAP///////////7RQAAAAAAA=';

function bloscLz4Metadata(overrides = {}) {
  return {
    id: 'blosc',
    cname: 'lz4',
    clevel: 5,
    shuffle: 1,
    blocksize: 0,
    ...overrides
  };
}

function reorderBloscPhysicalBlocks(frame, physicalOrder) {
  const source = Uint8Array.from(frame);
  const sourceView = new DataView(source.buffer);
  const nbytes = sourceView.getUint32(4, true);
  const blocksize = sourceView.getUint32(8, true);
  const ctbytes = sourceView.getUint32(12, true);
  const blockCount = Math.ceil(nbytes / blocksize);
  assert.equal(physicalOrder.length, blockCount);

  const tableEnd = 16 + blockCount * 4;
  const starts = Array.from(
    { length: blockCount },
    (_, index) => sourceView.getUint32(16 + index * 4, true)
  );
  const logicalBlocks = starts.map((start, index) => {
    const end = index + 1 < blockCount ? starts[index + 1] : ctbytes;
    return source.slice(start, end);
  });

  const reordered = new Uint8Array(ctbytes);
  reordered.set(source.subarray(0, tableEnd));
  const reorderedView = new DataView(reordered.buffer);
  let cursor = tableEnd;
  for (const logicalIndex of physicalOrder) {
    reorderedView.setUint32(16 + logicalIndex * 4, cursor, true);
    reordered.set(logicalBlocks[logicalIndex], cursor);
    cursor += logicalBlocks[logicalIndex].byteLength;
  }
  assert.equal(cursor, ctbytes);
  return reordered;
}

// ---------------------------------------------------------------------------
// Array metadata, codecs and element types.
// ---------------------------------------------------------------------------

test('Zarr v2 arrays require a fill_value and refuse a codec they cannot decode', async t => {
  await t.test('missing fill_value', async () => {
    const candidate = metadata({});
    delete candidate.fill_value;
    await assert.rejects(
      readArray('values', candidate, { 0: new Uint8Array(4) }),
      error => error instanceof ZarrFormatError && /has no 'fill_value'/.test(error.message)
    );
  });

  // zarr-python reads an array without `compressor` or `filters` as one with
  // neither; so does this reader.
  for (const key of ['compressor', 'filters']) {
    await t.test(`missing ${key} reads as none`, async () => {
      const candidate = metadata({});
      delete candidate[key];
      assert.deepEqual(
        Array.from(await readArray('values', candidate, { 0: littleEndianBytes([5], 'setInt32', 4) })),
        [5]
      );
    });
  }

  await t.test('an object compressor named null is a codec it cannot decode', async () => {
    await assert.rejects(
      readArray('values', metadata({ compressor: { id: 'null' } }), { 0: new Uint8Array(4) }),
      error => error instanceof ZarrUnsupportedError && /'null'/.test(error.message)
    );
  });
});

test('AnnData string arrays accept any string storage, and object arrays need a string codec', async t => {
  // anndata writes variable-length UTF-8; other writers use fixed-length
  // strings, which read as the same text.
  await t.test('fixed-width byte strings are text', async () => {
    const entries = zarrEntries(storeWith({ nObs: 1 }));
    entries.set('obs/.zattrs', json({
      'encoding-type': 'dataframe', 'encoding-version': '0.2.0', _index: '_index', 'column-order': ['label'],
    }));
    setArray(entries, 'obs/label', metadata({ shape: [1], chunks: [1], dtype: '|S1', fill_value: 'AA==' }), { 0: encoder.encode('a') });
    const { reader } = await openAnnData(entries);
    assert.deepEqual(await reader.getObsFieldInfo('label'), { dtype: 'string' });
    assert.deepEqual((await reader.getObsField('label')).values, ['a']);
  });

  await t.test('object strings without VLenUTF8 are refused when the store opens', async () => {
    const entries = zarrEntries(storeWith({ nObs: 1 }));
    setArray(entries, 'obs/label', metadata({ shape: [1], chunks: [1], dtype: '|O', filters: null }));
    await assert.rejects(
      openRoot(entries),
      error => error instanceof ZarrFormatError && /without a string codec/.test(error.message)
    );
  });

  await t.test('exact VLenUTF8 storage is accepted', async () => {
    const { reader } = await openAnnData(storeWith({ nObs: 1, obs: { label: strings(['α']) } }));
    const field = await reader.getObsField('label');
    assert.equal(field.dtype, 'string');
    assert.deepEqual(field.values, ['α']);
  });
});

test('categorical ordered is a JSON boolean or the integer 0 or 1', async t => {
  const withOrdered = attrs => {
    const entries = zarrEntries(storeWith({ obs: { label: categorical([0, 1], ['a', 'b']) } }));
    entries.set('obs/label/.zattrs', json(attrs));
    return entries;
  };
  for (const [name, attrs, pattern] of [
    ['missing ordered', { 'encoding-type': 'categorical', 'encoding-version': '0.2.0' }, /ordered must be a boolean attribute/],
    ['string ordered', { 'encoding-type': 'categorical', 'encoding-version': '0.2.0', ordered: 'false' }, /ordered must be a boolean attribute/],
    ['an integer other than 0 or 1', { 'encoding-type': 'categorical', 'encoding-version': '0.2.0', ordered: 2 }, /ordered must be a boolean attribute/],
    ['wrong categorical version', { 'encoding-type': 'categorical', 'encoding-version': '0.1.0', ordered: false }, /encoding-version must be exactly '0\.2\.0'/],
  ]) {
    await t.test(`${name} is refused when the store opens`, async () => {
      await assert.rejects(openAnnData(withOrdered(attrs)), pattern);
    });
  }

  for (const [stored, ordered] of [[false, false], [true, true], [0, false], [1, true]]) {
    await t.test(`ordered ${JSON.stringify(stored)} reads as ${ordered}`, async () => {
      const { reader } = await openAnnData(withOrdered({
        'encoding-type': 'categorical', 'encoding-version': '0.2.0', ordered: stored,
      }));
      assert.equal((await reader.getObsFieldInfo('label')).ordered, ordered);
      assert.equal((await reader.getObsField('label')).ordered, ordered);
    });
  }
});

test('a group marker that is not Zarr v2 JSON is refused when the store opens', async t => {
  for (const path of ['obs/label', 'obs/count', 'X']) {
    const tree = sparseStore();
    tree.children.obs = stringFrame(['cell-0', 'cell-1'], {
      label: categorical([0, 1], ['a', 'b']),
      count: nullable('nullable-integer', new BigInt64Array([1n, 2n]), [0, 0]),
    });
    for (const [name, bytes, pattern] of [
      ['malformed', json('{'), /\.zgroup is not valid JSON/],
      ['non-v2', json('{"zarr_format":3}'), /\.zgroup' must declare "zarr_format": 2/],
    ]) {
      await t.test(`${path} ${name} marker`, async () => {
        const entries = zarrEntries(tree);
        entries.set(`${path}/.zgroup`, bytes);
        await assert.rejects(openRoot(entries), error => error instanceof ZarrFormatError && pattern.test(error.message));
      });
    }
  }
});

test('rejects directory selections that omit required Zarr v2 metadata', async () => {
  const fileList = [{
    name: '0.0',
    webkitRelativePath: 'incomplete.zarr/X/0.0',
    size: 4,
    text: async () => '',
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  }];
  const notifications = getNotificationCenter();
  const notificationMethods = [
    'info',
    'startDownload',
    'updateDownload',
    'completeDownload',
    'failDownload',
    'dismissDownload'
  ];
  const originals = new Map(
    notificationMethods.map(name => [name, notifications[name]])
  );
  for (const name of notificationMethods) notifications[name] = () => 'download';

  const source = new AnnDataFileSource();
  try {
    await assert.rejects(
      source.loadFolder(fileList
    ),
      error => {
        assert.match(error.message, /zarr\.json, \.zgroup, \.zarray or \.zmetadata/);
        // A browser folder picker may leave out the metadata files; the
        // person is told to open the store as a Zarr ZIP archive instead.
        assert.match(error.message, /Zarr ZIP/i);
        return true;
      }
    );
    assert.equal(await source.isAvailable(), false);
  } finally {
    source.clear();
    for (const [name, method] of originals) {
      notifications[name] = method;
    }
  }
});

test('reads AnnData default Blosc MEMCPY chunks and reverses VLenUTF8 filters', async () => {
  // Emitted by AnnData 0.11.4 / Zarr 2.18.3 / numcodecs 0.13.1.
  // The Blosc frame has MEMCPYED set and contains a VLenUTF8 payload.
  const values = await readArray('obs/cell_type/categories', metadata({
    shape: [3],
    chunks: [3],
    dtype: '|O',
    compressor: bloscLz4Metadata(),
    filters: [{ id: 'vlen-utf8' }]
  }), { 0: bytesFromHex(CANONICAL_VLEN_MEMCPY_HEX) });
  assert.deepEqual(values, ['A', 'B', 'C']);
});

test('decodes a canonical mixed raw/LZ4 Blosc block and reverses byte shuffle', async () => {
  // numcodecs 0.13.1 encoding of np.arange(256, dtype=np.int32).
  // SHA-256: 4bce9824199d121d940c7b73ccdb322c44067a242e3971098b828f3af9b22af3
  const values = await readArray('values', metadata({
    shape: [256],
    chunks: [256],
    compressor: bloscLz4Metadata()
  }), { 0: bytesFromBase64(CANONICAL_SPLIT_BLOSC_BASE64) });
  assert.deepEqual(Array.from(values), Array.from({ length: 256 }, (_, index) => index));
});

test('preserves canonical endian-neutral signed and unsigned one-byte dtypes', async () => {
  assert.deepEqual(
    Array.from(await readArray('signed', metadata({ shape: [5], chunks: [5], dtype: '|i1' }), { 0: bytesFromHex('ff0001027f') })),
    [-1, 0, 1, 2, 127]
  );
  assert.deepEqual(
    Array.from(await readArray('unsigned', metadata({ shape: [5], chunks: [5], dtype: '|u1' }), { 0: bytesFromHex('000102faff') })),
    [0, 1, 2, 250, 255]
  );
});

test('uses full declared chunk strides for overhanging Fortran-order edge chunks', async () => {
  const values = await readArray('obsm/X_fortran', metadata({
    shape: [5, 3],
    chunks: [3, 2],
    dtype: '<f4',
    order: 'F',
    dimension_separator: '.'
  }), {
    '0.0': bytesFromHex('0000803f000080400000e040000000400000a04000000041'),
    '0.1': bytesFromHex('000040400000c04000001041000000000000000000000000'),
    '1.0': bytesFromHex('000020410000504100000000000030410000604100000000'),
    '1.1': bytesFromHex('000040410000704100000000000000000000000000000000')
  });
  assert.deepEqual(Array.from(values), Array.from({ length: 15 }, (_, index) => index + 1));
});

test('honors slash-separated multidimensional chunk keys', async () => {
  const values = await readArray('obsm/X_slash', metadata({
    shape: [5, 2],
    chunks: [3, 1],
    dtype: '<i2',
    dimension_separator: '/'
  }), {
    '0/0': bytesFromHex('650067006900'),
    '0/1': bytesFromHex('660068006a00'),
    '1/0': bytesFromHex('6b006d000000'),
    '1/1': bytesFromHex('6c006e000000')
  });
  assert.deepEqual(Array.from(values), Array.from({ length: 10 }, (_, index) => index + 101));
});

test('materializes declared fill values for absent chunks', async () => {
  const values = await readArray('obsm/X_missing_fill', metadata({
    shape: [5, 2],
    chunks: [3, 1],
    dtype: '<i2',
    fill_value: 7,
    dimension_separator: '.'
  }), { '0.0': bytesFromHex('0b000c000d00') });
  assert.deepEqual(Array.from(values), [11, 7, 12, 7, 13, 7, 7, 7, 7, 7]);
});

test('rejects unsupported dtypes and filters instead of returning plausible corruption', async () => {
  // A complex number is not an AnnData column value: refused by the reader
  // before any value is read.
  const entries = zarrEntries(storeWith({ nObs: 1 }));
  entries.set('obs/.zattrs', json({
    'encoding-type': 'dataframe', 'encoding-version': '0.2.0', _index: '_index', 'column-order': ['complex'],
  }));
  setArray(entries, 'obs/complex', metadata({ dtype: '<c8' }), { 0: bytesFromHex('0000000000000000') });
  const opening = openAnnData(entries);
  await assert.rejects(opening, /Observation dataframe column 'complex' uses an unsupported element type/);

  await assert.rejects(
    readArray('filtered', metadata({ filters: [{ id: 'delta' }] }), { 0: bytesFromHex('01000000') }),
    error => error instanceof ZarrUnsupportedError && /'delta'/.test(error.message)
  );
  // A fixed-string size past the safe integers is malformed metadata, named
  // as such, not a crash.
  await assert.rejects(
    readArray('labels', metadata({ dtype: '|S9007199254740993' })),
    error => (error instanceof ZarrFormatError || error instanceof ZarrUnsupportedError) && /\/labels/.test(error.message)
  );
});

test('Blosc frames are read by their own header, as c-blosc reads them', async t => {
  // The frame header, not the array metadata, says how a frame was written;
  // only a format this reader does not know is refused.
  await t.test('container version 1 is read; a newer one is refused', async () => {
    const frame = bytesFromBase64(CANONICAL_SPLIT_BLOSC_BASE64);
    frame[0] = 1;
    const values = await readArray('values', metadata({ shape: [256], chunks: [256], compressor: bloscLz4Metadata() }), { 0: frame });
    assert.deepEqual(Array.from(values), Array.from({ length: 256 }, (_, index) => index));
    frame[0] = 3;
    await assert.rejects(
      readArray('values', metadata({ shape: [256], chunks: [256], compressor: bloscLz4Metadata() }), { 0: frame }),
      error => error instanceof ZarrUnsupportedError
    );
  });

  await t.test('an unknown inner LZ4 stream version is refused', async () => {
    const frame = bytesFromBase64(CANONICAL_SPLIT_BLOSC_BASE64);
    frame[1] = 2;
    await assert.rejects(
      readArray('values', metadata({ shape: [256], chunks: [256], compressor: bloscLz4Metadata() }), { 0: frame }),
      /Blosc lz4 stream format 2/
    );
  });

  await t.test('a MEMCPY frame is copied whatever codec its header names', async () => {
    const frame = bytesFromHex(CANONICAL_VLEN_MEMCPY_HEX);
    frame[2] = (frame[2] & 0x1f) | (4 << 5);
    const values = await readArray('labels', metadata({
      shape: [3], chunks: [3], dtype: '|O', compressor: bloscLz4Metadata(), filters: [{ id: 'vlen-utf8' }],
    }), { 0: frame });
    assert.deepEqual(values, ['A', 'B', 'C']);
  });

  await t.test('shuffle and typesize come from the frame, not the metadata', async () => {
    const labels = await readArray('labels', metadata({
      shape: [3], chunks: [3], dtype: '|O', compressor: bloscLz4Metadata({ shuffle: 0 }), filters: [{ id: 'vlen-utf8' }],
    }), { 0: bytesFromHex(CANONICAL_VLEN_MEMCPY_HEX) });
    assert.deepEqual(labels, ['A', 'B', 'C']);
    const values = await readArray('values', metadata({ shape: [1], chunks: [1], compressor: bloscLz4Metadata() }), {
      0: bytesFromHex('02013301040000000400000014000000' + '01000000'),
    });
    assert.deepEqual(Array.from(values), [1]);
  });
});

test('treats Blosc metadata blocksize as an encoder hint, not a frame invariant', async () => {
  const values = await readArray('values', metadata({
    shape: [2500],
    chunks: [2500],
    compressor: bloscLz4Metadata({ blocksize: 1024 })
  }), { 0: bytesFromBase64(CANONICAL_BLOCKSIZE_HINT_BLOSC_BASE64) });
  assert.equal(values.length, 2500);
  assert.ok(values.every(value => value === 0));
});

test('rejects an LZ4 stream that omits the required final literal sequence', () => {
  assert.throws(
    () => lz4DecodeBlockInto(bytesFromHex('10410100'), new Uint8Array(5)),
    /final literal/i
  );
});

test('decodes a real multi-block Blosc chunk with a final partial unsplit block', async () => {
  const values = await readArray('values', metadata({
    shape: [70000],
    chunks: [70000],
    compressor: bloscLz4Metadata()
  }), { 0: bytesFromBase64(CANONICAL_MULTIBLOCK_BLOSC_BASE64) });
  assert.equal(values.length, 70000);
  assert.ok(values.every(value => value === 7));
});

test('accepts non-monotonic logical block offsets from parallel Blosc writers', async () => {
  const canonical = bytesFromBase64(CANONICAL_MULTIBLOCK_BLOSC_BASE64);
  const reordered = reorderBloscPhysicalBlocks(canonical, [1, 0]);
  const offsets = new DataView(reordered.buffer);
  assert.ok(
    offsets.getUint32(16, true) > offsets.getUint32(20, true),
    'logical block offsets must exercise physical order independent of logical order'
  );
  const values = await readArray('values', metadata({
    shape: [70000],
    chunks: [70000],
    compressor: bloscLz4Metadata()
  }), { 0: reordered });
  assert.equal(values.length, 70000);
  assert.ok(values.every(value => value === 7));
});

test('public observation APIs preserve signed bytes and classify booleans', async () => {
  const { reader: signed } = await openAnnData(storeWith({
    nObs: 5,
    obs: { signed: array(Int8Array.from([-1, 0, 1, 2, 127]), { dtype: '|i1' }) },
  }));
  assert.deepEqual(await signed.getObsFieldInfo('signed'), { dtype: 'int' });
  const signedField = await signed.getObsField('signed');
  assert.equal(signedField.dtype, 'int');
  assert.deepEqual(Array.from(signedField.values), [-1, 0, 1, 2, 127]);

  const { reader: bool } = await openAnnData(storeWith({
    nObs: 3,
    obs: { flag: array([false, true, true], { dtype: '|b1' }) },
  }));
  assert.deepEqual(await bool.getObsFieldInfo('flag'), { dtype: 'bool' });
  assert.deepEqual(await bool.getObsField('flag'), {
    dtype: 'bool',
    values: [false, true, true]
  });
});

test('rejects invalid boolean bytes and malformed fixed-string UTF-8', async () => {
  const entries = zarrEntries(storeWith({ nObs: 2, obs: { flag: array([false, true], { dtype: '|b1' }) } }));
  entries.set('obs/flag/0', bytesFromHex('0002'));
  const { reader } = await openAnnData(entries);
  await assert.rejects(reader.getObsField('flag'), /boolean/i);

  await assert.rejects(
    readArray('labels', metadata({ shape: [1], chunks: [1], dtype: '|S1', fill_value: 'AA==' }), { 0: bytesFromHex('ff') }),
    /not valid UTF-8/
  );
});

test('preserves embedded NULs in fixed-width strings while trimming padding', async () => {
  assert.deepEqual(
    await readArray('byte_labels', metadata({ shape: [1], chunks: [1], dtype: '|S4', fill_value: 'AAAAAA==' }), {
      0: Uint8Array.from([0x41, 0x00, 0x42, 0x00]),
    }),
    ['A\u0000B']
  );
  const unicodeBytes = new Uint8Array(16);
  const unicodeView = new DataView(unicodeBytes.buffer);
  unicodeView.setUint32(0, 0x41, true);
  unicodeView.setUint32(4, 0x00, true);
  unicodeView.setUint32(8, 0x42, true);
  assert.deepEqual(
    await readArray('unicode_labels', metadata({ shape: [1], chunks: [1], dtype: '<U4', fill_value: '' }), { 0: unicodeBytes }),
    ['A\u0000B']
  );
});

// ---------------------------------------------------------------------------
// Categorical columns.
// ---------------------------------------------------------------------------

test('rejects categorical codes outside missing-or-category bounds', async () => {
  const { reader } = await openAnnData(storeWith({
    obs: { cell_type: categorical([0, 2], ['A', 'B']) },
  }));
  await assert.rejects(
    reader.getObsField('cell_type'),
    /categorical code.*bounds/i
  );
});

test('requires a signed-integer dtype for categorical codes', async () => {
  const tree = storeWith({ obs: { cell_type: categorical(new Float32Array([0, 1]), ['A', 'B'], { codesDtype: '<f4' }) } });
  await assert.rejects(
    openAnnData(tree),
    /categorical codes.*signed integer dtype/i
  );
});

test('rejects oversized category dictionaries before code or label payloads', async () => {
  const entries = zarrEntries(storeWith({ nObs: 1, obs: { group: categorical([0], array(new Int32Array([0]), { dtype: '<i4' })) } }));
  // Metadata of 2^32 categories: no chunk is written, and none may be read.
  setArray(entries, 'obs/group/categories', metadata({ shape: [4_294_967_296], chunks: [1_048_576], dtype: '<i4' }));
  const { root, fetched } = await openRoot(entries);
  await assert.rejects(
    new AnnDataReader().open(root, { format: ZARR_FORMAT, name: 'oversized.zarr' }),
    /4,294,967,296 categories.*at most 4,294,967,295.*reduce or merge/i
  );
  assert.deepEqual(chunksOf(fetched, 'obs/group/categories'), []);
  assert.deepEqual(chunksOf(fetched, 'obs/group/codes'), []);
});

test('reuses the validated categorical dictionary between info and field loads', async () => {
  const { reader, reads } = await openAnnData(storeWith({
    obs: { group: categorical([0, 1], ['A', 'B']) },
  }));
  const info = await reader.getObsFieldInfo('group');
  const field = await reader.getObsField('group');
  assert.equal(readsOf(reads, 'obs/group/categories').length, 1);
  assert.strictEqual(field.categories, info.categories);
  assert.deepEqual(Array.from(field.codes), [0, 1]);
});

test('Zarr dataset metadata counts categorical fields without label payloads', async () => {
  const { reader, reads } = await openAnnData(storeWith({
    nObs: 1,
    obs: { label: categorical([0], ['A']) },
  }), { name: 'metadata-only.zarr' });
  const dataset = await reader.getDatasetMetadata();
  assert.equal(dataset.stats.n_categorical_fields, 1);
  assert.deepEqual(dataset.probes, await reader.probeMapping());
  assert.equal(Object.hasOwn(dataset, 'embeddings'), false);
  assert.deepEqual(readsOf(reads, 'obs/label/categories'), []);
  assert.deepEqual(readsOf(reads, 'obs/label/codes'), []);
});

test('opening reads no category dictionary: a 21,751-category column is read with its first load', async () => {
  // A barcode stored as a categorical, one category per cell, as GEO files
  // often hold: its dictionary is megabytes the first view never needs.
  const nObs = 21_751;
  const barcodes = Array.from({ length: nObs }, (_, index) => `BARCODE-${index}`);
  const { reader, reads } = await openAnnData(storeWith({
    nObs,
    genes: ['A'],
    obs: {
      BARCODE: categorical(Int32Array.from({ length: nObs }, (_, index) => index), barcodes, { codesDtype: '<i4' }),
      group: categorical(Int8Array.from({ length: nObs }, (_, index) => index % 2), ['a', 'b']),
    },
  }), { name: 'barcodes.zarr' });
  const adapter = new BaseAnnDataAdapter(asWorkerLoader(reader));
  // Everything the first view waits for: the file's structure, its field
  // lists, the embedding it draws, and the dataset's identity.
  await adapter.initialize();
  const identity = await adapter.finalizeDirectIdentity({
    id: 'barcodes',
    name: 'barcodes',
    preferFileName: false,
    description: '',
    source: { name: 'Zarr store' },
  });
  assert.deepEqual(readsOf(reads, 'obs/BARCODE/categories'), []);
  assert.deepEqual(readsOf(reads, 'obs/group/categories'), []);
  assert.ok(readsOf(reads, 'obsm/X_umap_2d').length > 0, 'the first view\'s embedding was read');
  // How many categories each has is metadata, known without reading them.
  assert.deepEqual(
    identity.obs_fields.filter(field => field.kind === 'category'),
    [
      { key: 'BARCODE', kind: 'category', n_categories: nObs },
      { key: 'group', kind: 'category', n_categories: 2 },
    ]
  );

  const field = await adapter.getObsFieldData('BARCODE');
  assert.ok(readsOf(reads, 'obs/BARCODE/categories').length > 0);
  assert.equal(field.categories.length, nObs);
  assert.equal(field.categories[21_750], 'BARCODE-21750');
  assert.equal(field.dtype, 'uint16');
  assert.deepEqual(readsOf(reads, 'obs/group/categories'), [], 'only the field loaded');
});

test('Zarr adapter reuses retained categories after loader cache clearing', async () => {
  const { reader, reads } = await openAnnData(storeWith({
    obs: { label: categorical([0, 0], ['A'], { ordered: true }) },
  }), { name: 'retained-categories.zarr' });
  const adapter = new BaseAnnDataAdapter(asWorkerLoader(reader));
  await adapter.initialize();
  // Opening reads no category dictionary; the field's first load does.
  assert.equal(readsOf(reads, 'obs/label/categories').length, 0);
  assert.equal(adapter._obsFieldsMetadata[0].ordered, true);
  await adapter.getObsFieldData('label');
  const canonicalCategories =
    adapter._obsFieldsMetadata[0].categories;
  assert.equal(readsOf(reads, 'obs/label/categories').length, 1);

  adapter.clearCaches();
  reader.clearCache();
  const field = await adapter.getObsFieldData('label');

  assert.strictEqual(field.categories, canonicalCategories);
  assert.equal(field.ordered, true);
  assert.equal(readsOf(reads, 'obs/label/categories').length, 1);
  assert.equal(reader._cache.has('obs:label'), false);
  assert.equal(reader._cache.has('obs_info:label'), false);
});

test('preserves numeric and boolean AnnData categorical categories', async t => {
  const cases = [
    { name: 'numeric', categories: array(new Float32Array([1.5, 2.25]), { dtype: '<f4' }), expected: [1.5, 2.25] },
    { name: 'int64 numeric', categories: array(new BigInt64Array([-4n, 9n]), { dtype: '<i8' }), expected: [-4, 9] },
    { name: 'boolean', categories: array([false, true], { dtype: '|b1' }), expected: [false, true] },
  ];

  for (const categoryCase of cases) {
    await t.test(categoryCase.name, async () => {
      const { reader } = await openAnnData(storeWith({
        nObs: 3,
        obs: { group: categorical([0, 1, -1], categoryCase.categories) },
      }));
      assert.deepEqual(
        (await reader.getObsFieldInfo('group')).categories,
        categoryCase.expected
      );
      const field = await reader.getObsField('group');
      assert.deepEqual(field.categories, categoryCase.expected);
      assert.deepEqual(Array.from(field.codes), [0, 1, -1]);
      assert.deepEqual(field.values, [
        categoryCase.expected[0],
        categoryCase.expected[1],
        null
      ]);
    });
  }
});

test('Zarr rejects duplicate categorical labels under exact primitive semantics', async t => {
  const cases = [
    { name: 'string', categories: strings(['A', 'A']) },
    { name: 'number', categories: array(new Float32Array([7, 7]), { dtype: '<f4' }) },
    { name: 'boolean', categories: array([false, false], { dtype: '|b1' }) },
  ];

  for (const categoryCase of cases) {
    await t.test(categoryCase.name, async () => {
      const { reader } = await openAnnData(storeWith({
        nObs: 1,
        obs: { group: categorical([0], categoryCase.categories) },
      }));
      await assert.rejects(
        reader.getObsFieldInfo('group'),
        /categorical categories.*group.*duplicate.*label/i
      );
      assert.equal(reader._cache.has('obs_info:group'), false);
    });
  }
});

test('rejects malformed boolean categorical categories', async () => {
  const entries = zarrEntries(storeWith({
    nObs: 1,
    obs: { group: categorical([0], array([false], { dtype: '|b1' })) },
  }));
  entries.set('obs/group/categories/0', Uint8Array.from([2]));
  const { reader } = await openAnnData(entries);
  await assert.rejects(reader.getObsField('group'), /boolean/i);
});

// ---------------------------------------------------------------------------
// Fill values.
// ---------------------------------------------------------------------------

test('rejects out-of-range integer fill values instead of TypedArray wraparound', async t => {
  const cases = [
    ['uint8 negative', '|u1', -1],
    ['uint8 overflow', '|u1', 300],
    ['int8 overflow', '|i1', 128],
    ['uint64 overflow', '<u8', '18446744073709551616']
  ];

  for (const [name, dtype, fillValue] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        readArray('values', metadata({ shape: [1], chunks: [1], dtype, fill_value: fillValue })),
        /fill_value.*(range|valid)/i
      );
    });
  }
});

test('reads int64 fill metadata beyond JSON safe integers exactly', async () => {
  const entries = new Map([
    ['.zgroup', json({ zarr_format: 2 })],
    ['values/.zarray', json(
      '{"zarr_format":2,"shape":[1],"chunks":[1],"dtype":"<i8",' +
      '"compressor":null,"fill_value":9007199254740993,"filters":null,"order":"C"}'
    )],
  ]);
  const { opened } = await openRoot(entries);
  assert.deepEqual(Array.from(await opened.get('values').read()), [9007199254740993n]);
});

test('rejects finite Float32 fill overflow while preserving explicit infinity', async () => {
  await assert.rejects(
    readArray('values', metadata({ dtype: '<f4', fill_value: 1e308 })),
    /fill_value.*float32 range/i
  );
  assert.deepEqual(
    Array.from(await readArray('values', metadata({ dtype: '<f4', fill_value: 'Infinity' }))),
    [Number.POSITIVE_INFINITY]
  );
});

test('decodes canonical short Base64 fixed-byte-string fills', async () => {
  for (const [fillValue, expected] of [['', ''], ['YQ==', 'a']]) {
    assert.deepEqual(
      await readArray('labels', metadata({ shape: [1], chunks: [1], dtype: '|S3', fill_value: fillValue })),
      [expected]
    );
  }
  await assert.rejects(
    readArray('labels', metadata({ shape: [1], chunks: [1], dtype: '|S3', fill_value: 'YWJjZA==' })),
    /fill_value holds more bytes than one element/
  );
});

test('truncates fixed-Unicode fills by code point to the declared width', async () => {
  assert.deepEqual(
    await readArray('labels', metadata({ shape: [1], chunks: [1], dtype: '<U1', fill_value: '😀B' })),
    ['😀']
  );
  assert.deepEqual(
    await readArray('padded_labels', metadata({ shape: [1], chunks: [1], dtype: '<U3', fill_value: 'A\u0000' })),
    ['A']
  );
});

test('rejects unpaired surrogates in fixed-Unicode fill metadata', async () => {
  await assert.rejects(
    readArray('invalid_labels', metadata({ shape: [1], chunks: [1], dtype: '<U1', fill_value: '\ud800' })),
    /invalid code point/
  );
});

test('VLen item counts are bounded by their payload, and chunks by their declared shape alone', async t => {
  assert.throws(
    () => vlenDecode(bytesFromHex('ffffff7f'), 0x7fffffff, 'labels'),
    /truncated/i
  );

  await t.test('no array size, chunk count or chunk size is refused for being large', async () => {
    for (const meta of [
      metadata({ shape: [600_000_000], chunks: [1], dtype: '|u1' }),
      metadata({ shape: [134_217_728], chunks: [16_777_216], dtype: '<f4' }),
      metadata({ shape: [40_000_000], chunks: [8_000_000], dtype: '|S8', fill_value: '' }),
      metadata({ shape: [100_001], chunks: [1] }),
      metadata({ shape: [1], chunks: [16_777_217], dtype: '<i4' }),
    ]) {
      const { opened } = await openRoot(new Map([
        ['.zgroup', json({ zarr_format: 2 })],
        ['a/.zarray', json(meta)],
      ]));
      assert.deepEqual(opened.get('a').shape, meta.shape);
    }
  });

  await t.test('a compressed string chunk is bounded by its codec, not a constant', async () => {
    const { gzipSync } = await import('node:zlib');
    const values = await readArray('labels', metadata({
      shape: [1],
      chunks: [1],
      dtype: '|O',
      filters: [{ id: 'vlen-utf8' }],
      compressor: { id: 'gzip', level: 1 },
    }), { 0: new Uint8Array(gzipSync(vlenUtf8Bytes(['abc']))) });
    assert.deepEqual(values, ['abc']);
  });
});

test('validates fill metadata before any value is allocated', async () => {
  for (const [dtype, fillValue] of [['|u1', -1], ['|S1', 'not Base64']]) {
    await assert.rejects(
      openRoot(new Map([
        ['.zgroup', json({ zarr_format: 2 })],
        ['a/.zarray', json(metadata({ shape: [60_000_000], chunks: [600], dtype, fill_value: fillValue }))],
      ])),
      /fill_value/i
    );
  }
});

test('bounds extended LZ4 lengths against remaining output during parsing', () => {
  assert.throws(
    () => lz4DecodeBlockInto(
      Uint8Array.from([0xf0, ...new Array(20).fill(0xff), 0x00]),
      new Uint8Array(10)
    ),
    /exceeds/i
  );
});

test('supports overlapping LZ4 matches followed by a final literal sequence', () => {
  const out = new Uint8Array(6);
  lz4DecodeBlockInto(bytesFromHex('106101001058'), out);
  assert.deepEqual(Array.from(out), [97, 97, 97, 97, 97, 88]);
});

// ---------------------------------------------------------------------------
// Expression matrices.
// ---------------------------------------------------------------------------

test('converts dense int64 gene expression to the nearest float32, beyond 2^53 too', async () => {
  const { reader: safe } = await openAnnData(storeWith({
    nObs: 2,
    genes: ['A'],
    X: dense(new BigInt64Array([1n, 2n]), [2, 1], { dtype: '<i8' }),
  }));
  assert.deepEqual(Array.from(await safe.getMatrixColumn('X', 0)), [1, 2]);

  const { reader: wide } = await openAnnData(storeWith({
    nObs: 2,
    genes: ['A'],
    X: dense(new BigInt64Array([9007199254740993n, -(2n ** 63n)]), [2, 1], { dtype: '<i8' }),
  }));
  assert.deepEqual(Array.from(await wide.getMatrixColumn('X', 0)), [Math.fround(2 ** 53), Math.fround(-(2 ** 63))]);
});

/**
 * A 4-cell x 20-gene uint8 X in chunks of 2 cells x 4 genes: genes 0-3 are
 * one strip of two chunks. Each value is 10 * cell + gene % 10.
 */
function stripTree() {
  const nRows = 4;
  const nCols = 20;
  return storeWith({
    nObs: nRows,
    genes: Array.from({ length: nCols }, (_, i) => `g${i}`),
    X: dense(
      Uint8Array.from({ length: nRows * nCols }, (_, i) => Math.floor(i / nCols) * 10 + (i % nCols) % 10),
      [nRows, nCols],
      { dtype: '|u1', chunks: [2, 4] }
    ),
  });
}

test('genes of one dense chunk strip decode each chunk once', async () => {
  const { reader, fetched, opened } = await openAnnData(stripTree());
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 0)), [0, 10, 20, 30]);
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 1)), [1, 11, 21, 31]);
  assert.deepEqual(chunksOf(fetched, 'X'), ['X/0.0', 'X/1.0']);
  assert.ok(opened.stats().cachedChunkBytes >= 2 * 2 * 4);

  // Concurrent genes of the same strip share one fetch of each chunk.
  const fresh = await openAnnData(stripTree());
  const [geneA, geneC] = await Promise.all([
    fresh.reader.getMatrixColumn('X', 0),
    fresh.reader.getMatrixColumn('X', 2),
  ]);
  assert.deepEqual(Array.from(geneA), [0, 10, 20, 30]);
  assert.deepEqual(Array.from(geneC), [2, 12, 22, 32]);
  assert.deepEqual(chunksOf(fresh.fetched, 'X').sort(), ['X/0.0', 'X/1.0']);
});

test('a failed dense chunk decode is not retained for the next gene', async () => {
  let failNext = true;
  const attempts = [];
  const { reader } = await openAnnData(stripTree(), {
    onChunk(key) {
      if (!key.startsWith('X/')) return;
      attempts.push(key);
      if (failNext && key === 'X/1.0') {
        failNext = false;
        throw new Error('chunk read failed');
      }
    },
  });
  await assert.rejects(reader.getMatrixColumn('X', 0), /chunk read failed/);
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 0)), [0, 10, 20, 30]);
  assert.equal(attempts.filter(key => key === 'X/1.0').length, 2);
});

test('decoded dense chunks are released when the dataset is closed', async () => {
  const { reader, opened } = await openAnnData(stripTree());
  await reader.getMatrixColumn('X', 0);
  assert.ok(opened.stats().cachedChunkBytes > 0);
  reader.close();
  assert.equal(opened.stats().cachedChunkBytes, 0);
});

test('sums duplicate sparse coordinates in direct CSC and converted CSR columns', async t => {
  for (const format of ['csc', 'csr']) {
    await t.test(format, async () => {
      const { reader } = await openAnnData(sparseStore({
        format,
        shape: [2, 1],
        data: new Float32Array([2, 3]),
        indices: new Int32Array([0, 0]),
        indptr: new Int32Array(format === 'csc' ? [0, 2] : [0, 2, 2]),
      }));
      assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 0)), [5, 0]);
    });
  }
});

test('a duplicate sum beyond the float32 range becomes an infinity, as numpy converts it', async () => {
  const { reader } = await openAnnData(sparseStore({
    format: 'csc',
    shape: [1, 1],
    data: new Float32Array([3.4e38, 3.4e38]),
    indices: new Int32Array([0, 0]),
    indptr: new Int32Array([0, 2]),
  }));
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 0)), [Number.POSITIVE_INFINITY]);
});

test('rejects out-of-range sparse columns instead of returning plausible zeros', async t => {
  for (const format of ['csc', 'csr']) {
    await t.test(format, async () => {
      const { reader } = await openAnnData(sparseStore({
        format,
        shape: [2, 2],
        data: new Float32Array([1]),
        indices: new Int32Array([0]),
        indptr: new Int32Array([0, 1, 1]),
      }));
      await assert.rejects(
        reader.getMatrixColumn('X', 2),
        /X has no gene column 2/i
      );
    });
  }
});

test('a sparse coordinate outside its shape is corruption, never a dropped value', async t => {
  // Skipping an out-of-range coordinate publishes 0.0 for that cell, and 0.0 in
  // an expression vector reads as a genuine non-detection. The reader must
  // refuse the matrix instead of quietly inventing a measurement.
  await t.test('a CSC row index', async () => {
    const { reader } = await openAnnData(sparseStore({
      format: 'csc',
      shape: [2, 1],
      data: new Float32Array([1, 2]),
      indices: new Int32Array([0, 7]),
      indptr: new Int32Array([0, 2]),
    }));
    await assert.rejects(reader.getMatrixColumn('X', 0), /row index 7 at entry 1 is outside its 2-row shape/i);
  });
  for (const bad of [5, -1]) {
    await t.test(`a CSR column index ${bad}`, async () => {
      const { reader } = await openAnnData(sparseStore({
        format: 'csr',
        shape: [2, 2],
        data: new Float32Array([1, 2]),
        indices: new Int32Array([0, bad]),
        indptr: new Int32Array([0, 1, 2]),
      }));
      await assert.rejects(reader.getMatrixColumn('X', 0), new RegExp(`${bad}.*outside`, 'i'));
      await assert.rejects(reader.getMatrixRows('X', [1]), new RegExp(`${bad}.*outside`, 'i'));
    });
  }
});

test('a sparse matrix must agree with its own declared shape', async t => {
  const cases = [
    ['more values than indices', { data: new Float32Array([1, 2]), indices: new Int32Array([0]), indptr: new Int32Array([0, 1, 2]) }],
    ['too few row pointers', { data: new Float32Array([1, 2]), indices: new Int32Array([0, 1]), indptr: new Int32Array([0, 1]) }],
    ['pointers ending before the values', { data: new Float32Array([1, 2]), indices: new Int32Array([0, 1]), indptr: new Int32Array([0, 1, 1]) }],
  ];
  for (const [name, arrays] of cases) {
    await t.test(name, async () => {
      await assert.rejects(async () => {
        const { reader } = await openAnnData(sparseStore({ format: 'csr', shape: [2, 2], ...arrays }));
        await reader.getMatrixColumn('X', 0);
        await reader.getMatrixRows('X', [0, 1]);
      }, /sparse X/i);
    });
  }
});

test('an embedding value float32 cannot hold is refused; a gene value becomes an infinity', async () => {
  const { reader: embedding } = await openAnnData(storeWith({
    nObs: 1,
    obsm: mapping({ X_umap: dense(new Float64Array([1e308]), [1, 1], { dtype: '<f8' }) }),
  }));
  // The column read returns the stored value; the adapter's load-time check
  // refuses it before any Float32 coordinate is produced.
  assert.deepEqual(
    Array.from(await embedding.readObsmColumns('X_umap', [0])),
    [1e308]
  );
  const adapter = await adapterWithDescribedObsm(embedding);
  await assert.rejects(
    adapter.getEmbeddingForRef({ key: 'X_umap', columns: [0] }),
    error => error instanceof EmbeddingLoadError &&
      error.reason === 'not representable as float32 at cell 0'
  );
  assert.equal(adapter._embeddingCache.size, 0);

  // A dense X of absent chunks whose fill value overflows Float32.
  const entries = zarrEntries(storeWith({ nObs: 1, genes: ['A'], X: dense(new Float64Array([0]), [1, 1], { dtype: '<f8' }) }));
  setArray(entries, 'X', metadata({ shape: [1, 70_000], chunks: [1, 700], dtype: '<f8', fill_value: 1e308 }));
  setArray(entries, 'var/_index', metadata({ shape: [70_000], chunks: [70_000], dtype: '|O', fill_value: null, filters: [{ id: 'vlen-utf8' }] }), {
    0: vlenUtf8Bytes(Array.from({ length: 70_000 }, (_, i) => `g${i}`)),
  });
  // Gene values beyond the float32 range become infinities, as numpy
  // converts them; only coordinates are refused.
  const { reader: denseFill } = await openAnnData(entries);
  assert.deepEqual(Array.from(await denseFill.getMatrixColumn('X', 0)), [Number.POSITIVE_INFINITY]);

  const { root } = await openRoot(zarrEntries(sparseStore({
    data: new Float64Array([1e308]),
    dataDtype: '<f8',
    indices: new Int32Array([0]),
    indptr: new Int32Array([0, 1, 1]),
  })));
  const sparse = await readSparseMatrix(root.get('X'), ZARR_FORMAT, 'Sparse X', 'float32');
  assert.deepEqual(Array.from(sparse.data), [Number.POSITIVE_INFINITY]);
});

/**
 * A 3-cell x 4-column obsm array in 2 x 2 chunks whose value is
 * 10 * row + column, in C or Fortran chunk order.
 */
function chunkedObsmEntries({ order = 'C', fill_value = 0, absent = [] } = {}) {
  const nRows = 3;
  const width = 4;
  const [chunkRows, chunkCols] = [2, 2];
  const chunkFiles = {};
  for (let chunkRow = 0; chunkRow < 2; chunkRow++) {
    for (let chunkColumn = 0; chunkColumn < 2; chunkColumn++) {
      const key = `${chunkRow}.${chunkColumn}`;
      if (absent.includes(key)) continue;
      const values = new Array(chunkRows * chunkCols).fill(0);
      for (let r = 0; r < chunkRows; r++) {
        for (let c = 0; c < chunkCols; c++) {
          const row = chunkRow * chunkRows + r;
          const column = chunkColumn * chunkCols + c;
          const value = row < nRows ? 10 * row + column : 0;
          values[order === 'F' ? c * chunkRows + r : r * chunkCols + c] = value;
        }
      }
      chunkFiles[key] = littleEndianBytes(values, 'setFloat32', 4);
    }
  }
  const entries = zarrEntries(storeWith({ nObs: nRows }));
  setArray(entries, 'obsm/X_pca', metadata({
    shape: [nRows, width],
    chunks: [chunkRows, chunkCols],
    dtype: '<f4',
    order,
    fill_value,
  }), chunkFiles);
  return entries;
}

test('Zarr obsm column reads decode only the chunks that hold a selected column', async t => {
  for (const order of ['C', 'F']) {
    await t.test(`${order} order, columns in two chunk columns`, async () => {
      const { reader, fetched } = await openAnnData(chunkedObsmEntries({ order }));
      assert.deepEqual(
        Array.from(await reader.readObsmColumns('X_pca', [3, 0])),
        [3, 0, 13, 10, 23, 20]
      );
      assert.deepEqual(chunksOf(fetched, 'obsm/X_pca').sort(), [
        'obsm/X_pca/0.0',
        'obsm/X_pca/0.1',
        'obsm/X_pca/1.0',
        'obsm/X_pca/1.1',
      ]);
    });

    await t.test(`${order} order, columns in one chunk column`, async () => {
      const { reader, fetched } = await openAnnData(chunkedObsmEntries({ order }));
      assert.deepEqual(
        Array.from(await reader.readObsmColumns('X_pca', [2, 3])),
        [2, 3, 12, 13, 22, 23]
      );
      assert.deepEqual(chunksOf(fetched, 'obsm/X_pca').sort(), ['obsm/X_pca/0.1', 'obsm/X_pca/1.1']);
    });
  }

  await t.test('an absent chunk reads as its fill value', async () => {
    const { reader } = await openAnnData(chunkedObsmEntries({ fill_value: 5, absent: ['1.1'] }));
    assert.deepEqual(
      Array.from(await reader.readObsmColumns('X_pca', [1, 3])),
      [1, 3, 11, 13, 21, 5]
    );
  });

  await t.test('an absent chunk with no fill value reads as its type\'s default, as zarr-python 3 writes it', async () => {
    const { reader } = await openAnnData(chunkedObsmEntries({ fill_value: null, absent: ['1.1'] }));
    assert.deepEqual(
      Array.from(await reader.readObsmColumns('X_pca', [1, 3])),
      [1, 3, 11, 13, 21, 0]
    );
  });
});

test('Zarr mapping probes describe every element from metadata, with the catalog reasons', async () => {
  const zeros = (shape, Type = Float32Array) => new Type(shape.reduce((a, b) => a * b, 1));
  const tree = annData({
    X: dense(zeros([3, 1]), [3, 1]),
    obs: stringFrame(['c0', 'c1', 'c2']),
    var: stringFrame(['gene'], {
      gene_symbols: strings(['G']),
      score: array(new Float32Array([1])),
    }),
    obsm: mapping({
      X_umap: dense(zeros([3, 2]), [3, 2]),
      X_sparse: sparse({ shape: [3, 5], data: new Float32Array(4), indices: new Int32Array(4), indptr: new Int32Array([0, 4, 4, 4]) }),
      X_df: stringFrame(['c0', 'c1', 'c2']),
      pseudotime: array(new Int32Array(3), { dtype: '<i4' }),
      labels: strings(['a', 'b', 'c']),
      flags: dense(new Array(6).fill(false), [3, 2], { dtype: '|b1' }),
    }),
    obsp: mapping({
      connectivities: sparse({ shape: [3, 3], data: new Float32Array([1, 1]), indices: new Int32Array([1, 0]), indptr: new Int32Array([0, 1, 2, 2]) }),
      distances: dense(zeros([3, 2]), [3, 2]),
    }),
    layers: mapping({
      counts: sparse({ shape: [3, 1], data: new Int32Array([1]), dataDtype: '<i4', indices: new Int32Array([0]), indptr: new Int32Array([0, 1, 1, 1]) }),
      wide: dense(zeros([3, 2]), [3, 2]),
    }),
    raw: group({
      X: sparse({ shape: [3, 4], data: new Float32Array(0), indices: new Int32Array(0), indptr: new Int32Array(4) }),
      var: stringFrame(['a', 'b', 'c', 'd']),
    }),
  });
  const { reader, fetched } = await openAnnData(tree, { name: 'probes.zarr' });
  const before = fetched.length;

  const described = describeAnnDataProbes(await reader.probeMapping());
  assert.equal(fetched.length, before, 'probes read no chunk');
  // A Zarr store lists its children in code-point order.
  assert.deepEqual(
    described.obsm.map(({ key, storage, shape, dtype, usable, reason }) =>
      [key, storage, shape, dtype, usable, reason]),
    [
      ['X_df', 'dataframe', [3, 0], 'object', false, 'obsm table, not an array'],
      ['X_sparse', 'csr', [3, 5], 'float32', false, 'sparse obsm arrays cannot be plotted'],
      ['X_umap', 'dense', [3, 2], 'float32', true, null],
      ['flags', 'dense', [3, 2], 'bool', false, 'not a numeric array'],
      ['labels', 'dense', [3], 'string', false, 'not a numeric array'],
      ['pseudotime', 'dense', [3], 'int32', true, null],
    ]
  );
  assert.deepEqual(
    described.obsp.map(({ key, storage, nnz, usable, reason }) =>
      [key, storage, nnz, usable, reason]),
    [
      ['connectivities', 'csr', 2, true, null],
      ['distances', 'dense', null, false, 'not square'],
    ]
  );
  assert.deepEqual(described.var, {
    n_vars: 1,
    columns: [
      { key: 'gene_symbols', dtype: 'string', usable: true, reason: null },
      { key: 'score', dtype: 'float32', usable: false, reason: 'floating-point values cannot name genes' },
    ],
  });
  assert.deepEqual(described.X, { storage: 'dense', dtype: 'float32' });
  assert.deepEqual(
    described.layers.map(({ key, dtype, usable, reason }) => [key, dtype, usable, reason]),
    [
      ['counts', 'int32', true, null],
      ['wide', 'float32', false, 'has shape 3 x 2, expected 3 x 1'],
    ]
  );
  assert.deepEqual(described.raw, {
    n_vars: 4,
    X: { storage: 'csr', dtype: 'float32' },
    var: { columns: [] },
  });
});

// ---------------------------------------------------------------------------
// Sparse matrix structure.
// ---------------------------------------------------------------------------

test('sparse components are checked for kind and length, never for size', async () => {
  const floatIndices = await openRoot(zarrEntries(group({
    X: sparse({ shape: [2, 3], data: new Float32Array([1, 2]), indices: new Float32Array([0, 2]), indicesDtype: '<f4', indptr: new Int32Array([0, 1, 2]) }),
  })));
  assert.throws(
    () => sparseContract(floatIndices.root.get('X'), ZARR_FORMAT, 'Sparse X'),
    /indices.*integer dtype/i
  );

  // 50 million cells and 500 million values, described by metadata alone.
  const entries = new Map([
    ['.zgroup', json({ zarr_format: 2 })],
    ['X/.zgroup', json({ zarr_format: 2 })],
    ['X/.zattrs', json({ 'encoding-type': 'csr_matrix', 'encoding-version': '0.1.0', shape: [50_000_000, 50_000_000] })],
    ['X/data/.zarray', json(metadata({ shape: [500_000_000], chunks: [1_000_000], dtype: '<f4' }))],
    ['X/indices/.zarray', json(metadata({ shape: [500_000_000], chunks: [1_000_000], dtype: '<i4' }))],
    ['X/indptr/.zarray', json(metadata({ shape: [50_000_001], chunks: [1_000_000], dtype: '<i8' }))],
  ]);
  const { root } = await openRoot(entries);
  assert.deepEqual(sparseContract(root.get('X'), ZARR_FORMAT, 'Sparse X').shape, [50_000_000, 50_000_000]);
});

test('validates sparse matrix structure before narrowing or conversion', async t => {
  const sparseX = async options => (await openRoot(zarrEntries(sparseStore(options)))).root.get('X');
  const valid = await readSparseMatrix(await sparseX({}), ZARR_FORMAT, 'Sparse X', 'float32');
  assert.deepEqual({
    format: valid.format,
    shape: valid.shape,
    data: Array.from(valid.data),
    indices: Array.from(valid.indices),
    indptr: Array.from(valid.indptr)
  }, {
    format: 'csr',
    shape: [2, 3],
    data: [1, 2],
    indices: [0, 2],
    indptr: [0, 1, 2]
  });

  const cases = [
    [
      'data/indices length mismatch',
      { data: new Float32Array([1]), indices: new Int32Array([0, 2]) },
      /data.*indices.*length/i
    ],
    [
      'indptr axis length',
      { indptr: new Int32Array([0, 2]) },
      /indptr.*length/i
    ],
    [
      'indptr starts away from zero',
      { indptr: new Int32Array([1, 1, 2]) },
      /indptr.*start.*zero/i
    ],
    [
      'indptr decreases',
      { indptr: new Int32Array([0, 2, 1]) },
      /indptr.*monotonic/i
    ],
    [
      'indptr does not end at nnz',
      { indptr: new Int32Array([0, 1, 1]) },
      /indptr.*last.*non-zero/i
    ],
    [
      'index outside the opposite axis',
      { indices: new Int32Array([0, 3]) },
      /sparse.*index.*bounds/i
    ],
    [
      '64-bit index outside the opposite axis is refused, never narrowed',
      {
        data: new Float32Array([1]),
        indices: new BigInt64Array([2147483648n]),
        indicesDtype: '<i8',
        indptr: new Int32Array([0, 1, 1]),
      },
      /sparse X index 2147483648 is outside axis bounds/i
    ],
    [
      'floating-point index dtype',
      { indices: new Float32Array([0, 2]), indicesDtype: '<f4' },
      /indices.*integer dtype/i
    ]
  ];

  for (const [name, options, expectedError] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        async () => readSparseMatrix(await sparseX(options), ZARR_FORMAT, 'Sparse X', 'float32'),
        expectedError
      );
    });
  }
});

test('requires unambiguous standard sparse format and shape metadata', async () => {
  const missingFormat = zarrEntries(sparseStore());
  missingFormat.set('X/.zattrs', json({ shape: [2, 3] }));
  await assert.rejects(
    openAnnData(missingFormat),
    /sparse.*encoding-type.*required/i
  );

  const missingShape = zarrEntries(sparseStore());
  missingShape.set('X/.zattrs', json({
    'encoding-type': 'csr_matrix',
    'encoding-version': '0.1.0'
  }));
  await assert.rejects(
    openAnnData(missingShape),
    /sparse.*shape.*required/i
  );
});

test('validates sparse component metadata while opening the AnnData structure', async () => {
  await assert.rejects(
    openAnnData(sparseStore({ data: new Float32Array([1]), indices: new Int32Array([0, 2]) })),
    /data.*indices.*length/i
  );

  const unsupportedEncoding = zarrEntries(sparseStore());
  unsupportedEncoding.set('X/.zattrs', json({
    'encoding-type': 'mystery_matrix',
    'encoding-version': '0.1.0',
    shape: [2, 3]
  }));
  await assert.rejects(
    openAnnData(unsupportedEncoding),
    /sparse.*encoding-type.*required/i
  );
});

// ---------------------------------------------------------------------------
// The AnnData structure.
// ---------------------------------------------------------------------------

test('rejects X dimensions that disagree with obs or var, including zero axes', async t => {
  const structure = ({ xShape = [2, 2], obsCount = 2, varNames = ['A', 'B'] }) => annData({
    X: dense(new Float32Array(xShape[0] * xShape[1]), xShape),
    obs: stringFrame(Array.from({ length: obsCount }, (_, i) => `cell-${i}`)),
    var: stringFrame(varNames),
  });
  const cases = [
    ['obs shorter', { obsCount: 1 }, /Observation index length 1 does not match 2/],
    ['obs longer', { obsCount: 3 }, /Observation index length 3 does not match 2/],
    ['var shorter', { varNames: ['A'] }, /Variable index length 1 does not match 2/],
    ['var longer', { varNames: ['A', 'B', 'C'] }, /Variable index length 3 does not match 2/],
    [
      'zero-cell X is known rather than missing',
      { xShape: [0, 2], obsCount: 1 },
      /Observation index length 1 does not match 0/
    ],
    [
      'zero-gene X is known rather than missing',
      { xShape: [2, 0], varNames: ['A'] },
      /Variable index length 1 does not match 0/
    ]
  ];

  for (const [name, overrides, expectedError] of cases) {
    await t.test(name, async () => {
      await assert.rejects(openAnnData(structure(overrides)), expectedError);
    });
  }
});

/** Open a working store, then try a replacement that must fail and leave the working data in place. */
async function assertReplacementRefused(mutate, expectedError, { columnOrder = null } = {}) {
  const { reader } = await openAnnData(completeTree({
    embeddingValues: [0, 0, 2, 4],
    geneValues: [1, 2, 3, 4]
  }), { name: 'working.zarr' });

  const replacement = completeZarrStoreFiles({
    embeddingValues: [10, 20, 30, 40],
    geneValues: [5, 6, 7, 8]
  });
  if (columnOrder !== null) {
    replacement.set(`${columnOrder.frame}/.zattrs`, json({
      'encoding-type': 'dataframe',
      'encoding-version': '0.2.0',
      _index: '_index',
      'column-order': columnOrder.columns,
    }));
  }
  mutate(replacement);

  await assert.rejects(
    (async () => {
      const { root } = await openRoot(replacement, { name: 'invalid-replacement.zarr' });
      await reader.open(root, { format: ZARR_FORMAT, name: 'invalid-replacement.zarr' });
    })(),
    expectedError
  );
  assert.equal(reader._name, 'working.zarr');
  assert.deepEqual(
    Array.from(await reader.readObsmColumns('X_umap_2d', [0, 1])),
    [0, 0, 2, 4]
  );
  assert.deepEqual(
    Array.from(await geneColumnByName(reader, 'A')),
    [1, 3]
  );
}

test('requires canonical AnnData Zarr root identity without replacing working data', async t => {
  const invalidCases = [
    [
      'malformed root group metadata',
      files => files.set('.zgroup', json('{')),
      /\.zgroup is not valid JSON/i
    ],
    [
      'non-v2 root group metadata',
      files => files.set('.zgroup', json('{"zarr_format":3}')),
      /\.zgroup' must declare "zarr_format": 2/i
    ],
    [
      'lookalike encoding identity',
      files => files.set('.zattrs', json({
        'encoding-type': 'not-anndata',
        'encoding-version': '0.1.0'
      })),
      /AnnData Zarr root.*encoding-type.*exactly.*anndata/i
    ],
    [
      'missing AnnData encoding version',
      files => files.set('.zattrs', json({ 'encoding-type': 'anndata' })),
      /AnnData Zarr root.*encoding-version.*exactly.*0\.1\.0/i
    ],
    [
      'unsupported AnnData encoding version',
      files => files.set('.zattrs', json({
        'encoding-type': 'anndata',
        'encoding-version': '0.2.0'
      })),
      /AnnData Zarr root.*encoding-version.*exactly.*0\.1\.0/i
    ]
  ];

  for (const [name, mutate, expectedError] of invalidCases) {
    await t.test(name, () => assertReplacementRefused(mutate, expectedError));
  }
});

test('requires exact AnnData mapping identity before enumerating obsm', async t => {
  const invalidCases = [
    [
      'malformed obsm group metadata',
      files => files.set('obsm/.zgroup', json('{')),
      /obsm\/\.zgroup is not valid JSON/i,
    ],
    [
      'non-v2 obsm group metadata',
      files => files.set('obsm/.zgroup', json('{"zarr_format":3}')),
      /obsm\/\.zgroup' must declare "zarr_format": 2/i,
    ],
    [
      'missing obsm attributes',
      files => files.delete('obsm/.zattrs'),
      /AnnData Zarr obsm mapping encoding-type must be exactly 'dict'/,
    ],
    [
      'wrong obsm encoding type',
      files => files.set('obsm/.zattrs', json({
        'encoding-type': 'mapping',
        'encoding-version': '0.1.0',
      })),
      /obsm.*encoding-type.*dict/i,
    ],
    [
      'wrong obsm encoding version',
      files => files.set('obsm/.zattrs', json({
        'encoding-type': 'dict',
        'encoding-version': '9.9.9',
      })),
      /obsm.*encoding-version.*0\.1\.0/i,
    ],
  ];

  for (const [name, mutate, expected] of invalidCases) {
    await t.test(name, () => assertReplacementRefused(mutate, expected));
  }
});

test('requires the canonical AnnData obs dataframe contract without replacing working data', async t => {
  const frameAttrs = (overrides = {}) => ({
    'encoding-type': 'dataframe',
    'encoding-version': '0.2.0',
    _index: '_index',
    'column-order': [],
    ...overrides,
  });
  const invalidCases = [
    [
      'malformed obs group metadata',
      files => files.set('obs/.zgroup', json('{')),
      /obs\/\.zgroup is not valid JSON/i
    ],
    [
      'non-v2 obs group metadata',
      files => files.set('obs/.zgroup', json('{"zarr_format":3}')),
      /obs\/\.zgroup' must declare "zarr_format": 2/i
    ],
    [
      'missing obs attributes',
      files => files.delete('obs/.zattrs'),
      /AnnData Zarr obs encoding-type must be exactly 'dataframe'/
    ],
    [
      'missing dataframe encoding identity',
      files => files.set('obs/.zattrs', json({
        'encoding-version': '0.2.0',
        _index: '_index',
        'column-order': []
      })),
      /AnnData Zarr obs.*encoding-type.*exactly.*dataframe/i
    ],
    [
      'unsupported dataframe encoding identity',
      files => files.set('obs/.zattrs', json(frameAttrs({ 'encoding-type': 'not-dataframe' }))),
      /AnnData Zarr obs.*encoding-type.*exactly.*dataframe/i
    ],
    [
      'missing dataframe encoding version',
      files => files.set('obs/.zattrs', json({
        'encoding-type': 'dataframe',
        _index: '_index',
        'column-order': []
      })),
      /AnnData Zarr obs.*encoding-version.*exactly.*0\.2\.0/i
    ],
    [
      'unsupported dataframe encoding version',
      files => files.set('obs/.zattrs', json(frameAttrs({ 'encoding-version': '0.3.0' }))),
      /AnnData Zarr obs.*encoding-version.*exactly.*0\.2\.0/i
    ],
    [
      'missing dataframe index declaration',
      files => files.set('obs/.zattrs', json({
        'encoding-type': 'dataframe',
        'encoding-version': '0.2.0',
        'column-order': []
      })),
      /AnnData Zarr obs.*_index.*non-empty string/i
    ],
    [
      'invalid dataframe index declaration',
      files => files.set('obs/.zattrs', json(frameAttrs({ _index: 7 }))),
      /AnnData Zarr obs.*_index.*non-empty string/i
    ],
    [
      'duplicate column-order member',
      files => {
        files.set('obs/.zattrs', json(frameAttrs({ 'column-order': ['score', 'score'] })));
        setArray(files, 'obs/score', metadata({ shape: [2], chunks: [2], dtype: '<f4' }));
      },
      /AnnData Zarr obs column-order contains duplicate column 'score'/
    ],
    [
      'unversioned primitive dataframe index',
      files => files.set('obs/_index/.zattrs', json({ 'encoding-type': 'string-array' })),
      /Observation index encoding-version must be exactly '0\.2\.0'/
    ]
  ];

  for (const [name, mutate, expectedError] of invalidCases) {
    await t.test(name, () => assertReplacementRefused(mutate, expectedError));
  }
});

test('validates every observation column declared by column-order before adoption', async t => {
  await t.test('valid primitive column is accepted', async () => {
    const { reader } = await openAnnData(storeWith({ obs: { score: array(new Float32Array([1, 2])) } }));
    assert.deepEqual(reader.obsKeys, ['score']);
  });

  const invalidCases = [
    [
      'missing declared column',
      () => {},
      /AnnData Zarr obs declared column 'missing' was not found/
    ],
    [
      'unsupported declared column representation',
      files => {
        files.set('obs/missing/.zgroup', json({ zarr_format: 2 }));
        files.set('obs/missing/.zattrs', json({
          'encoding-type': 'unsupported-column',
          'encoding-version': '0.1.0'
        }));
      },
      /Observation dataframe column 'missing' uses unsupported encoding 'unsupported-column'/
    ],
    [
      'incomplete supported categorical column',
      files => {
        files.set('obs/missing/.zgroup', json({ zarr_format: 2 }));
        files.set('obs/missing/.zattrs', json({
          'encoding-type': 'categorical',
          'encoding-version': '0.2.0',
          ordered: false
        }));
      },
      /Categorical field 'missing' must contain codes and categories/
    ],
    [
      'categorical children cannot imply a missing parent encoding',
      files => {
        files.set('obs/missing/.zgroup', json({ zarr_format: 2 }));
        setArray(files, 'obs/missing/codes', metadata({ shape: [2], chunks: [2], dtype: '|i1' }));
        setArray(files, 'obs/missing/categories', metadata({
          shape: [1], chunks: [1], dtype: '|O', fill_value: null, filters: [{ id: 'vlen-utf8' }],
        }));
      },
      /Observation dataframe column 'missing' uses unsupported encoding 'unknown'/
    ]
  ];

  for (const [name, mutate, expectedError] of invalidCases) {
    await t.test(name, () => assertReplacementRefused(mutate, expectedError, {
      columnOrder: { frame: 'obs', columns: ['missing'] },
    }));
  }
});

test('requires the canonical AnnData var dataframe contract without replacing working data', async t => {
  const frameAttrs = (overrides = {}) => ({
    'encoding-type': 'dataframe',
    'encoding-version': '0.2.0',
    _index: '_index',
    'column-order': [],
    ...overrides,
  });
  const invalidCases = [
    [
      'malformed var group metadata',
      files => files.set('var/.zgroup', json('{')),
      /var\/\.zgroup is not valid JSON/i
    ],
    [
      'non-v2 var group metadata',
      files => files.set('var/.zgroup', json('{"zarr_format":3}')),
      /var\/\.zgroup' must declare "zarr_format": 2/i
    ],
    [
      'missing var attributes',
      files => files.delete('var/.zattrs'),
      /AnnData Zarr var encoding-type must be exactly 'dataframe'/
    ],
    [
      'missing dataframe encoding identity',
      files => files.set('var/.zattrs', json({
        'encoding-version': '0.2.0',
        _index: '_index',
        'column-order': []
      })),
      /AnnData Zarr var.*encoding-type.*exactly.*dataframe/i
    ],
    [
      'unsupported dataframe encoding identity',
      files => files.set('var/.zattrs', json(frameAttrs({ 'encoding-type': 'not-dataframe' }))),
      /AnnData Zarr var.*encoding-type.*exactly.*dataframe/i
    ],
    [
      'missing dataframe encoding version',
      files => files.set('var/.zattrs', json({
        'encoding-type': 'dataframe',
        _index: '_index',
        'column-order': []
      })),
      /AnnData Zarr var.*encoding-version.*exactly.*0\.2\.0/i
    ],
    [
      'unsupported dataframe encoding version',
      files => files.set('var/.zattrs', json(frameAttrs({ 'encoding-version': '0.3.0' }))),
      /AnnData Zarr var.*encoding-version.*exactly.*0\.2\.0/i
    ],
    [
      'missing dataframe index declaration',
      files => files.set('var/.zattrs', json({
        'encoding-type': 'dataframe',
        'encoding-version': '0.2.0',
        'column-order': []
      })),
      /AnnData Zarr var.*_index.*non-empty string/i
    ],
    [
      'invalid dataframe index declaration',
      files => files.set('var/.zattrs', json(frameAttrs({ _index: 7 }))),
      /AnnData Zarr var.*_index.*non-empty string/i
    ],
    [
      'missing column-order declaration',
      files => files.set('var/.zattrs', json({
        'encoding-type': 'dataframe',
        'encoding-version': '0.2.0',
        _index: '_index'
      })),
      /AnnData Zarr var column-order must be an array of non-empty strings/
    ],
    [
      'invalid column-order member',
      files => files.set('var/.zattrs', json(frameAttrs({ 'column-order': ['score', 7] }))),
      /AnnData Zarr var column-order must be an array of non-empty strings/
    ],
    [
      'duplicate column-order member',
      files => files.set('var/.zattrs', json(frameAttrs({ 'column-order': ['score', 'score'] }))),
      /AnnData Zarr var column-order contains duplicate column 'score'/
    ],
    [
      'missing declared index node',
      files => {
        files.delete('var/_index/.zarray');
        files.delete('var/_index/.zattrs');
        files.delete('var/_index/0');
      },
      /AnnData Zarr var index child '_index' was not found/
    ]
  ];

  for (const [name, mutate, expectedError] of invalidCases) {
    await t.test(name, () => assertReplacementRefused(mutate, expectedError));
  }
});

test('validates every variable column declared by column-order before adoption', async t => {
  await t.test('valid primitive column is accepted', async () => {
    const tree = storeWith();
    tree.children.var = stringFrame(['A', 'B'], { score: array(new Float32Array([1, 2])) });
    const { reader } = await openAnnData(tree);
    assert.deepEqual((await reader.readVarNames('X', null)).index, ['A', 'B']);
  });

  const invalidCases = [
    [
      'missing declared column',
      () => {},
      /AnnData Zarr var declared column 'missing' was not found/
    ],
    [
      'unsupported declared column representation',
      files => {
        files.set('var/missing/.zgroup', json({ zarr_format: 2 }));
        files.set('var/missing/.zattrs', json({
          'encoding-type': 'unsupported-column',
          'encoding-version': '0.1.0'
        }));
      },
      /Variable dataframe column 'missing' uses unsupported encoding 'unsupported-column'/
    ],
    [
      'incomplete supported categorical column',
      files => {
        files.set('var/missing/.zgroup', json({ zarr_format: 2 }));
        files.set('var/missing/.zattrs', json({
          'encoding-type': 'categorical',
          'encoding-version': '0.2.0',
          ordered: false
        }));
      },
      /Categorical field 'missing' must contain codes and categories/
    ],
    [
      'variable-axis length mismatch',
      files => setArray(files, 'var/missing', metadata({ shape: [1], chunks: [1], dtype: '<f4' })),
      /Variable dataframe column 'missing' length 1 does not match 2/
    ]
  ];

  for (const [name, mutate, expectedError] of invalidCases) {
    await t.test(name, () => assertReplacementRefused(mutate, expectedError, {
      columnOrder: { frame: 'var', columns: ['missing'] },
    }));
  }
});

test('public Zarr loading rejects X with no canonical var and preserves the working source', async () => {
  const notifications = getNotificationCenter();
  const originalWarning = notifications.info;
  notifications.info = () => 'warning';

  const source = new AnnDataFileSource();
  try {
    await source.loadFolder(
      fileListFromMap(
        completeZarrStoreFiles({
          embeddingValues: [0, 0, 1, 1],
          geneValues: [1, 0, 2, 0]
        }),
        'working.zarr'
      )
    );
    const workingAdapter = source.getAdapter();

    const missingVar = completeZarrStoreFiles({
      embeddingValues: [9, 9, 10, 10],
      geneValues: [9, 0, 10, 0]
    });
    missingVar.set('X/.zarray', json(metadata({ shape: [1, 1], chunks: [1, 1], dtype: '<f4' })));
    missingVar.set('X/0.0', littleEndianBytes([9], 'setFloat32', 4));
    missingVar.set('obs/_index/.zarray', json(metadata({
      shape: [1],
      chunks: [1],
      dtype: '|O',
      filters: [{ id: 'vlen-utf8' }]
    })));
    missingVar.set('obs/_index/0', vlenUtf8Bytes(['cell-0']));
    missingVar.set('obsm/X_umap_2d/.zarray', json(metadata({ shape: [1, 2], chunks: [1, 2], dtype: '<f4' })));
    missingVar.set('obsm/X_umap_2d/0.0', littleEndianBytes([9, 10], 'setFloat32', 4));
    missingVar.delete('var/.zgroup');
    missingVar.delete('var/.zattrs');
    missingVar.delete('var/_index/.zarray');
    missingVar.delete('var/_index/.zattrs');
    missingVar.delete('var/_index/0');

    await assert.rejects(
      source.loadFolder(
        fileListFromMap(missingVar, 'missing-var.zarr')
    ),
      /var.*(required|must be exactly 'dataframe')/i
    );
    assert.equal(source.filename, 'working.zarr');
    assert.equal(source.getAdapter(), workingAdapter);
    assert.deepEqual(
      Array.from(await sourceGeneValuesByName(source, 'A')),
      [1, 2]
    );
    assert.deepEqual(
      Array.from(
        (await source.getAdapter().getEmbeddingPayload('obsm/0/0-1', 2)).positions
      ),
      [-1, -1, 1, 1]
    );
  } finally {
    source.clear();
    notifications.info = originalWarning;
  }
});

test('Zarr opening supports official nullable-string dataframe indices', async t => {
  const withIndices = (obsIndex, varIndex) => annData({
    X: dense(new Float32Array(4), [2, 2]),
    obs: dataFrame({ _index: obsIndex }, { columnOrder: [] }),
    var: dataFrame({ _index: varIndex }, { columnOrder: [] }),
  });
  const names = values => nullable('nullable-string-array', values, new Uint8Array(values.length));

  await t.test('valid observation and variable indices are accepted', async () => {
    const { reader } = await openAnnData(withIndices(names(['cell-a', 'cell-b']), names(['gene-a', 'gene-b'])));
    assert.equal(reader.nObs, 2);
    assert.equal(reader.nVars, 2);
    assert.deepEqual((await reader.readVarNames('X', null)).index, ['gene-a', 'gene-b']);
  });

  await t.test('missing observation names are rejected', async () => {
    await assert.rejects(
      openAnnData(withIndices(
        nullable('nullable-string-array', ['cell-a', 'ignored'], [0, 1]),
        names(['gene-a', 'gene-b'])
      )),
      /Observation index cannot contain missing names/
    );
  });

  await t.test('nullable indices require string values', async () => {
    await assert.rejects(
      openAnnData(withIndices(
        nullable('nullable-string-array', new Int32Array([1, 2]), [0, 0], { valuesDtype: '<i4' }),
        names(['gene-a', 'gene-b'])
      )),
      /Nullable values for 'Observation index' declares string-array but does not use a string dtype|Observation index.*string/
    );
  });

  await t.test('nullable index lengths remain axis-aligned', async () => {
    await assert.rejects(
      openAnnData(withIndices(names(['only-one']), names(['gene-a', 'gene-b']))),
      /Nullable values for 'Observation index' length 1 does not match 2/
    );
  });
});

test('requires every observation field to be one-dimensional and cell-aligned', async t => {
  await t.test('ordinary field length', async () => {
    await assert.rejects(
      openAnnData(storeWith({ obs: { batch: array(new Int32Array([7]), { dtype: '<i4' }) } })),
      /Observation dataframe column 'batch' length 1 does not match 2/
    );
  });

  await t.test('ordinary field rank', async () => {
    await assert.rejects(
      openAnnData(storeWith({ obs: { batch: dense(new Int32Array([7, 8]), [2, 1], { dtype: '<i4' }) } })),
      /Observation dataframe column 'batch' must have exactly 1 dimension/
    );
  });

  await t.test('categorical codes metadata', async () => {
    await assert.rejects(
      openAnnData(storeWith({ obs: { batch: categorical([0], ['A', 'B']) } })),
      /Categorical codes for 'batch' length 1 does not match 2/
    );
  });
});

test('normalizes continuous int64 and Float64 obs through the public adapter seam', async t => {
  async function adapterFor(values, dtype, key) {
    const { reader } = await openAnnData(storeWith({
      nObs: values.length,
      obs: { [key]: array(values, { dtype }) },
    }));
    const adapter = new BaseAnnDataAdapter(reader);
    adapter._obsFieldsMetadata = [{ key, kind: 'continuous' }];
    return adapter;
  }

  await t.test('safe signed int64', async () => {
    const adapter = await adapterFor(new BigInt64Array([1n, 2n]), '<i8', 'count');
    const field = await adapter.getObsFieldData('count');
    assert.equal(field.kind, 'continuous');
    assert.deepEqual(Array.from(new Float32Array(field.data)), [1, 2]);
  });

  await t.test('int64 beyond 2^53 reads as the nearest float32', async () => {
    const adapter = await adapterFor(new BigInt64Array([9_007_199_254_740_993n, 2n ** 63n - 1n]), '<i8', 'count');
    const field = await adapter.getObsFieldData('count');
    assert.deepEqual(Array.from(new Float32Array(field.data)), [Math.fround(2 ** 53), Math.fround(2 ** 63)]);
  });

  await t.test('a Float64 value beyond float32 becomes an infinity, as numpy converts it', async () => {
    const adapter = await adapterFor(new Float64Array([1e308, 2.5]), '<f8', 'score');
    const field = await adapter.getObsFieldData('score');
    assert.deepEqual(Array.from(new Float32Array(field.data)), [Number.POSITIVE_INFINITY, 2.5]);
  });
});

// ---------------------------------------------------------------------------
// Neighbour graphs.
// ---------------------------------------------------------------------------

test('propagates malformed connectivity and enforces obs-aligned square shape', async t => {
  await t.test('loader corruption', async () => {
    const { reader } = await openAnnData(connectivityStore(sparse({
      shape: [2, 2],
      data: new Float32Array([1]),
      indices: new Int32Array([0, 1]),
      indptr: new Int32Array([0, 1, 1]),
    })));
    await assert.rejects(
      reader.getConnectivities('connectivities'),
      /data.*indices.*length/i
    );
  });

  await t.test('shape mismatch', async () => {
    const { reader } = await openAnnData(connectivityStore(sparse({
      shape: [3, 3],
      data: new Float32Array([1]),
      indices: new Int32Array([1]),
      indptr: new Int32Array([0, 1, 1, 1]),
    }), 2));
    await assert.rejects(
      reader.getConnectivities('connectivities'),
      /connectivity.*shape.*3.*2 cells/i
    );
  });

  await t.test('adapter propagation', async () => {
    const adapter = new BaseAnnDataAdapter({
      nObs: 2,
      async getConnectivityEdges() {
        return connectivityEdgesOf(await this.readConnectivityMatrix(), this.nObs);
      },
      async readConnectivityMatrix() {
        throw new Error('malformed connectivity payload');
      }
    });
    await assert.rejects(
      adapter.getConnectivityEdges(),
      /malformed connectivity payload/i
    );
  });
});

test('public Zarr loading best-guesses a file without a UMAP and records the guess', async t => {
  const notifications = getNotificationCenter();
  const originalWarning = notifications.info;
  notifications.info = () => 'warning';

  function renamedEmbeddingStore(key) {
    const store = completeZarrStoreFiles({
      embeddingValues: [9, 9, 10, 10],
      geneValues: [9, 0, 10, 0]
    });
    for (const file of ['.zarray', '.zattrs', '0.0']) {
      store.set(`obsm/${key}/${file}`, store.get(`obsm/X_umap_2d/${file}`));
      store.delete(`obsm/X_umap_2d/${file}`);
    }
    return store;
  }

  try {
    for (const substituteKey of ['X_pca', 'X_tsne', 'X_phate']) {
      await t.test(substituteKey, async () => {
        const source = new AnnDataFileSource();
        try {
          const identity = await source.loadFolder(
            fileListFromMap(
              renamedEmbeddingStore(substituteKey),
              `${substituteKey.slice(2)}-only.zarr`
            )
    );
          const candidates = source.getAdapter().getMappingCandidates();
          assert.deepEqual(candidates.guessed, ['embeddings.2d']);
          assert.deepEqual(candidates.defaults.embeddings.defaults['2d'], {
            key: substituteKey,
            columns: [0, 1]
          });
          assert.deepEqual(candidates.defaults.embeddings.enabled, [
            { key: substituteKey, columns: [0, 1] }
          ]);
          assert.deepEqual(identity.embeddings.defaults, { '2d': substituteKey });
          assert.deepEqual(
            Array.from(
              (await source.getAdapter().getEmbeddingPayload('obsm/0/0-1', 2)).positions
            ),
            [-1, -1, 1, 1]
          );
        } finally {
          source.clear();
        }
      });
    }

    await t.test('a file with nothing plottable is refused and the working source kept', async () => {
      const source = new AnnDataFileSource();
      try {
        await source.loadFolder(
          fileListFromMap(
            completeZarrStoreFiles({
              embeddingValues: [0, 0, 1, 1],
              geneValues: [1, 0, 2, 0]
            }),
            'working.zarr'
          )
    );
        const workingAdapter = source.getAdapter();
        const constant = completeZarrStoreFiles({
          embeddingValues: [3, 3, 3, 3],
          geneValues: [9, 0, 10, 0]
        });
        for (const file of ['.zarray', '.zattrs', '0.0']) {
          constant.set(`obsm/X_spatial/${file}`, constant.get(`obsm/X_umap_2d/${file}`));
          constant.delete(`obsm/X_umap_2d/${file}`);
        }
        const error = await source.loadFolder(
          fileListFromMap(constant, 'constant.zarr')
    ).then(() => null, rejection => rejection);
        assert.equal(error?.code, 'NO_PLOTTABLE_EMBEDDING');
        assert.equal(
          error.message,
          'Cellucid found nothing to plot. It needs an obsm array with one ' +
          'row per cell (2) and at least one numeric column. obsm holds: ' +
          'X_spatial (2 × 2, no coordinate variation).' +
          ' Add a 2-D embedding to obsm (for example with sc.tl.umap in Scanpy), then open the data again.'
        );
        assert.equal(source.filename, 'working.zarr');
        assert.equal(source.getAdapter(), workingAdapter);
      } finally {
        source.clear();
      }
    });
  } finally {
    notifications.info = originalWarning;
  }
});

/** A store whose obsm holds the given 2-cell arrays (`{key: [shape, values]}`). */
function obsmStore(arrays, nObs = 2) {
  return storeWith({
    nObs,
    obsm: mapping(Object.fromEntries(Object.entries(arrays).map(([key, [shape, values, options]]) =>
      [key, dense(Float32Array.from(values), shape, options)]))),
  });
}

test('Zarr slots follow the default rule, and a plain X_umap by width', async t => {
  async function initialized(tree) {
    const { reader } = await openAnnData(tree);
    const adapter = new BaseAnnDataAdapter(reader);
    await adapter.initialize();
    return adapter;
  }

  await t.test('an unsuffixed X_umap array is read at its own column count', async () => {
    const adapter = await initialized(obsmStore({ X_umap: [[2, 2], [0, 0, 2, 4]] }));
    assert.deepEqual(adapter._slots, {
      '1d': null,
      '2d': { key: 'X_umap', columns: [0, 1] },
      '3d': null,
    });
    assert.deepEqual(adapter.getMappingCandidates().guessed, []);
  });

  await t.test('an unsuffixed X_umap of a width no dimension has is best-guessed at its first columns', async () => {
    const adapter = await initialized(obsmStore({
      X_umap: [[2, 10], Array.from({ length: 20 }, (_, index) => index)],
    }));
    assert.deepEqual(adapter._slots['2d'], { key: 'X_umap', columns: [0, 1] });
    assert.deepEqual(adapter.getMappingCandidates().guessed, ['embeddings.2d']);
  });

  await t.test('dimension-suffixed keys alone fill their slots', async () => {
    const adapter = await initialized(obsmStore({
      X_umap_2d: [[2, 2], [0, 0, 2, 4]],
      X_umap: [[2, 2], [4, 4, 5, 5]],
    }));
    assert.deepEqual(adapter._slots['2d'], { key: 'X_umap_2d', columns: [0, 1] });
  });

  await t.test('a malformed suffixed key cannot be skipped for another dimension', async () => {
    await assert.rejects(
      initialized(obsmStore({
        X_umap_2d: [[2, 3], [0, 0, 0, 1, 1, 1]],
        X_umap_3d: [[2, 3], [2, 2, 2, 3, 3, 3]],
      })),
      /Embedding 'X_umap_2d' must have exactly 2 columns; got 3/
    );
  });
});

test('centralizes the numeric, rank, width, and observation-axis embedding contract', async t => {
  const cases = [
    [
      'zero columns',
      storeWith({ obsm: mapping({ X_umap: dense(new Float32Array(0), [2, 0], { chunks: [2, 1] }) }) }),
      'has no columns',
      /reads distinct columns/i
    ],
    [
      'wrong row count',
      obsmStore({ X_umap: [[1, 2], [0, 1]] }),
      'has 1 row, the dataset has 2 cells',
      /obsm\['X_umap'\] has 1 row but the dataset has 2 cells/
    ],
    [
      'nonnumeric dtype',
      storeWith({ obsm: mapping({ X_umap: array(['a', 'b', 'c', 'd'], { dtype: '|S1', shape: [2, 2] }) }) }),
      'not a numeric array',
      /obsm\['X_umap'\] holds text, not numbers/
    ],
    [
      // A boolean is not a coordinate; the H5AD reader refuses the same
      // content, so the Zarr reader must too.
      'boolean dtype',
      storeWith({ obsm: mapping({ X_umap: array([false, true, true, false], { dtype: '|b1', shape: [2, 2] }) }) }),
      'not a numeric array',
      /obsm\['X_umap'\] must use a numeric dtype/
    ]
  ];

  for (const [name, tree, listedReason, readError] of cases) {
    await t.test(name, async () => {
      const { reader } = await openAnnData(tree);
      const [entry] = describeAnnDataProbes(await reader.probeMapping()).obsm;
      assert.equal(entry.usable, false);
      assert.equal(entry.reason, listedReason);
      await assert.rejects(reader.readObsmColumns('X_umap', [0, 1]), readError);
    });
  }

  await t.test('a one-dimensional array is one usable column', async () => {
    const { reader } = await openAnnData(storeWith({
      obsm: mapping({ pseudotime: array(new Float32Array([3, 7])) }),
    }));
    const [entry] = describeAnnDataProbes(await reader.probeMapping()).obsm;
    assert.deepEqual(
      [entry.key, entry.shape, entry.usable],
      ['pseudotime', [2], true]
    );
    assert.deepEqual(
      Array.from(await reader.readObsmColumns('pseudotime', [0])),
      [3, 7]
    );
  });
});

test('a dimension-suffixed vector field with the wrong cell axis is listed unusable and never bound', async () => {
  const { reader } = await openAnnData(obsmStore({
    X_umap_2d: [[2, 2], [0, 0, 2, 4]],
    velocity_umap_2d: [[1, 2], [1, 2]],
  }));
  const adapter = new BaseAnnDataAdapter(reader);
  await adapter.initialize();
  assert.equal(adapter._vectorBindings.size, 0);
  const entry = adapter.getMappingCandidates().obsm
    .find(item => item.key === 'velocity_umap_2d');
  assert.equal(entry.usable, false);
  assert.equal(entry.reason, 'has 1 row, the dataset has 2 cells');
  assert.deepEqual(adapter.getMappingCandidates().defaults.vectorFields, []);
});

test('extracts exact symmetric CSC connectivity and rejects duplicate coordinates', () => {
  const csc = extractConnectivityEdges({
    format: 'csc',
    shape: [2, 2],
    data: Float32Array.from([1, 1]),
    indptr: Int32Array.from([0, 1, 2]),
    indices: Int32Array.from([1, 0])
  }, 2);
  assert.deepEqual(Array.from(edgeListOf(csc).sources), [0]);
  assert.deepEqual(Array.from(edgeListOf(csc).destinations), [1]);

  assert.throws(
    () => extractConnectivityEdges({
      format: 'csr',
      shape: [2, 2],
      data: Float32Array.from([1, 1, 1]),
      indptr: Int32Array.from([0, 2, 3]),
      indices: Int32Array.from([1, 1, 0])
    }, 2),
    /duplicate coordinate/i
  );
});

test('Zarr connectivity requires exact obsp mapping identity', async t => {
  const graph = () => zarrEntries(connectivityStore(sparse({
    shape: [2, 2],
    data: new Float32Array([1, 1]),
    indices: new Int32Array([1, 0]),
    indptr: new Int32Array([0, 1, 2]),
  })));
  const storeRefusals = [
    ['malformed group marker', files => files.set('obsp/.zgroup', json('{')), /obsp\/\.zgroup is not valid JSON/i],
    ['non-v2 group marker', files => files.set('obsp/.zgroup', json('{"zarr_format":3}')), /obsp\/\.zgroup' must declare "zarr_format": 2/i],
  ];
  for (const [name, mutate, expected] of storeRefusals) {
    await t.test(name, async () => {
      const entries = graph();
      mutate(entries);
      await assert.rejects(openRoot(entries), expected);
    });
  }

  const readerRefusals = [
    ['missing mapping attributes', files => files.delete('obsp/.zattrs'), /AnnData Zarr obsp mapping encoding-type must be exactly 'dict'/],
    [
      'wrong mapping type',
      files => files.set('obsp/.zattrs', json({ 'encoding-type': 'mapping', 'encoding-version': '0.1.0' })),
      /obsp.*encoding-type.*dict/i
    ],
    [
      'wrong mapping version',
      files => files.set('obsp/.zattrs', json({ 'encoding-type': 'dict', 'encoding-version': '9.9.9' })),
      /obsp.*encoding-version.*0\.1\.0/i
    ]
  ];
  for (const [name, mutate, expected] of readerRefusals) {
    await t.test(name, async () => {
      const entries = graph();
      mutate(entries);
      const { reader } = await openAnnData(entries);
      await assert.rejects(reader.hasConnectivities('connectivities'), expected);
    });
  }
});

test('keeps sparse connectivity payloads lazy while reporting metadata presence', async () => {
  const { reader, fetched } = await openAnnData(connectivityStore(sparse({
    shape: [2, 2],
    data: new Float32Array([1, 1]),
    indices: new Int32Array([1, 0]),
    indptr: new Int32Array([0, 1, 2]),
  })));
  const dataset = await reader.getDatasetMetadata();
  assert.equal(dataset.stats.has_connectivity, true);
  assert.deepEqual(fetched.filter(key => key.startsWith('obsp/')), []);
});

test('supports bounded dense AnnData connectivity arrays without sparse misclassification', async () => {
  const { reader } = await openAnnData(connectivityStore(dense(new Float32Array([0, 1, 1, 0]), [2, 2])));
  const adapter = new BaseAnnDataAdapter(reader);
  await adapter.initialize();
  assert.equal(adapter.getMetadata().stats.has_connectivity, true);
  const edges = await adapter.getConnectivityEdges();
  assert.equal(edges.nEdges, 1);
  assert.deepEqual(Array.from(edgeListOf(edges).sources), [0]);
  assert.deepEqual(Array.from(edgeListOf(edges).destinations), [1]);
  assert.deepEqual(edgeWeightsOf(edges), edgeWeightsFrom([1]));
});

test('rejects mixed dense and sparse connectivity representations', async () => {
  const entries = zarrEntries(connectivityStore(dense(new Float32Array([0, 1, 1, 0]), [2, 2])));
  entries.set('obsp/connectivities/.zgroup', json({ zarr_format: 2 }));
  await assert.rejects(
    openRoot(entries),
    /is both an array \(\.zarray\) and a group \(\.zgroup\)/
  );
});

test('preserves an explicitly present empty connectivity matrix', async () => {
  const { reader } = await openAnnData(connectivityStore(sparse({
    shape: [2, 2],
    data: new Float32Array(0),
    indices: new Int32Array(0),
    indptr: new Int32Array([0, 0, 0]),
  })), { name: 'empty-connectivity.zarr' });
  const adapter = new BaseAnnDataAdapter(reader);
  await adapter.initialize();
  assert.equal(adapter.getMetadata().stats.has_connectivity, true);
  const edges = await adapter.getConnectivityEdges();
  assert.equal(edges.nCells, 2);
  assert.equal(edges.nEdges, 0);
  assert.equal(edges.maxNeighbors, 0);
  assert.deepEqual(Array.from(edgeListOf(edges).sources), []);
  assert.deepEqual(Array.from(edgeListOf(edges).destinations), []);
  assert.deepEqual(edgeWeightsOf(edges), edgeWeightsFrom([]));
});

// ---------------------------------------------------------------------------
// Lifecycle: failed reads, replacement, superseded work.
// ---------------------------------------------------------------------------

/** A 2-cell, 1-gene CSC X whose column is [4, 0]. */
function cscStore() {
  return storeWith({
    nObs: 2,
    genes: ['A'],
    X: sparse({ format: 'csc', shape: [2, 1], data: new Float32Array([4]), indices: new Int32Array([0]), indptr: new Int32Array([0, 1]) }),
  });
}

test('a later sparse X caller starts clean after an earlier rejected invocation', async () => {
  let failures = 0;
  const { reader, reads } = await openAnnData(cscStore(), {
    onChunk(key) {
      if (key === 'X/indptr/0' && failures === 0) {
        failures++;
        throw new Error('transient sparse read failure');
      }
    },
  });

  await assert.rejects(
    reader.getMatrixColumn('X', 0),
    /transient sparse read failure/i
  );
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 0)), [4, 0]);
  assert.equal(readsOf(reads, 'X/indptr').length, 2);
});

test('opens and replaces Zarr stores transactionally without stale caches', async () => {
  const malformed = new Map([
    ['.zgroup', json({ zarr_format: 2 })],
    ['.zattrs', json('{')]
  ]);
  const reader = new AnnDataReader();
  const openInto = async (entries, name) => {
    const { root } = await openRoot(entries, { name });
    await reader.open(root, { format: ZARR_FORMAT, name });
  };

  await assert.rejects(openInto(malformed, 'malformed.zarr'), /not valid JSON/i);
  assert.equal(reader.isOpen, false);

  await openInto(completeZarrStoreFiles({ embeddingValues: [0, 0, 2, 4], geneValues: [1, 2, 3, 4] }), 'first.zarr');
  assert.deepEqual(Array.from(await reader.readObsmColumns('X_umap_2d', [0, 1])), [0, 0, 2, 4]);
  assert.deepEqual(Array.from(await geneColumnByName(reader, 'A')), [1, 3]);

  await openInto(completeZarrStoreFiles({ embeddingValues: [10, 20, 30, 40], geneValues: [5, 6, 7, 8] }), 'second.zarr');
  assert.deepEqual(
    Array.from(await reader.readObsmColumns('X_umap_2d', [0, 1])),
    [10, 20, 30, 40]
  );
  assert.deepEqual(Array.from(await geneColumnByName(reader, 'A')), [5, 7]);

  await assert.rejects(openInto(malformed, 'replacement.zarr'), /not valid JSON/i);
  assert.equal(reader.isOpen, true);
  assert.deepEqual(
    Array.from(await reader.readObsmColumns('X_umap_2d', [0, 1])),
    [10, 20, 30, 40]
  );
  assert.deepEqual(Array.from(await geneColumnByName(reader, 'A')), [5, 7]);
});

test('a categorical dictionary past 65,535 categories is served with uint32 codes', async () => {
  const categories = Array.from({ length: 65_536 }, (_, index) => `C${index}`);
  const adapter = new BaseAnnDataAdapter({
    nObs: 2,
    async getObsField() {
      return {
        dtype: 'categorical',
        categories,
        // As the reader worker narrows them (`narrowCategoricalCodes`).
        codes: Uint32Array.from([65_535, 0xffffffff])
      };
    }
  });
  adapter._obsFieldsMetadata = [{
    key: 'large_category',
    kind: 'category',
    categories
  }];

  assert.doesNotThrow(() => adapter.getObsFields());
  const payload = await adapter.getObsFieldData('large_category');
  assert.equal(payload.dtype, 'uint32');
  assert.equal(payload.missingValue, 4_294_967_295);
  assert.deepEqual(Array.from(new Uint32Array(payload.data)), [65_535, 4_294_967_295]);
});

test('loads standard nullable integer and boolean observation groups with missing values', async () => {
  const { reader } = await openAnnData(storeWith({
    nObs: 3,
    obs: {
      nullable_count: nullable('nullable-integer', new BigInt64Array([1n, 0n, 3n]), [0, 1, 0]),
      nullable_flag: nullable('nullable-boolean', [true, false, false], [0, 1, 0]),
      nullable_label: nullable('nullable-string-array', ['A', 'ignored', 'C'], [0, 1, 0]),
    },
  }));

  const adapter = new BaseAnnDataAdapter(reader);
  await adapter.initialize();
  assert.deepEqual(
    adapter.getMetadata().obs_fields,
    [
      { key: 'nullable_count', kind: 'continuous', n_categories: undefined },
      // Boolean and string columns: their categories are found when they
      // are first loaded, so opening reads none of their values.
      { key: 'nullable_flag', kind: 'category', n_categories: null },
      { key: 'nullable_label', kind: 'category', n_categories: null }
    ]
  );

  const count = new Float32Array(
    (await adapter.getObsFieldData('nullable_count')).data
  );
  assert.equal(count[0], 1);
  assert.equal(Number.isNaN(count[1]), true);
  assert.equal(count[2], 3);

  const flag = await adapter.getObsFieldData('nullable_flag');
  assert.deepEqual(flag.categories, [false, true]);
  assert.deepEqual(Array.from(new Uint8Array(flag.data)), [1, 255, 0]);

  const label = await adapter.getObsFieldData('nullable_label');
  assert.deepEqual(label.categories, ['A', 'C']);
  assert.deepEqual(Array.from(new Uint8Array(label.data)), [0, 255, 1]);
});

test('opening reads no value of a string column, however many distinct labels it has; loading it finds them', async () => {
  // A per-cell unique column (a barcode, CELLxGENE's observation_joinid) is
  // read only when it is used.
  const nObs = 5000;
  const ids = Array.from({ length: nObs }, (_, cell) => `cell-${cell}`);
  const { reader, fetched } = await openAnnData(storeWith({
    nObs,
    obs: {
      observation_joinid: strings(ids),
      flag: nullable('nullable-boolean', Array.from({ length: nObs }, (_, cell) => cell % 2 === 0), new Array(nObs).fill(0)),
    },
  }));
  const adapter = new BaseAnnDataAdapter(reader);
  await adapter.initialize();
  assert.deepEqual(fetched.filter(key => key.startsWith('obs/observation_joinid/') || key.startsWith('obs/flag/')), [],
    'opening fetched no chunk of either column');
  assert.deepEqual(
    adapter.getObsFields().fields.filter(field => field.kind === 'category').map(field => [field.key, field.categories, field.codesDtype, field.codesMissingValue]),
    [['observation_joinid', null, null, null], ['flag', null, null, null]]
  );

  const joinid = await adapter.getObsFieldData('observation_joinid');
  assert.ok(fetched.some(key => key.startsWith('obs/observation_joinid/')), 'loading reads it');
  assert.equal(joinid.categories.length, nObs);
  assert.equal(joinid.dtype, 'uint16', 'its code width follows the categories found');
  const codes = new Uint16Array(joinid.data);
  assert.equal(joinid.categories[codes[1234]], 'cell-1234');

  const flag = await adapter.getObsFieldData('flag');
  assert.deepEqual(flag.categories, [false, true]);
  assert.deepEqual(Array.from(new Uint8Array(flag.data).subarray(0, 3)), [1, 0, 1]);
});

test('connectivity extraction refuses no graph for its size', () => {
  // The only limit on a graph is the memory the engine grants when the
  // arrays are allocated; a large graph is never refused by a fixed cap.
  const source = readFileSync(
    new URL('../assets/js/data/connectivity-edges.js', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(source, /MAX_CONNECTIVITY_WORKING_BYTES|working set exceeds|browser limit/i);
  // A valid symmetric CSR graph extracts its unique upper-triangle edges.
  const edges = extractConnectivityEdges({
    format: 'csr',
    shape: [3, 3],
    data: Float32Array.from([1, 1, 2, 2]),
    indptr: Int32Array.from([0, 1, 3, 4]),
    indices: Int32Array.from([1, 0, 2, 1]),
  }, 3);
  assert.deepEqual(Array.from(edgeListOf(edges).sources), [0, 1]);
  assert.deepEqual(Array.from(edgeListOf(edges).destinations), [1, 2]);
});

test('does not publish an invalidated in-flight sparse matrix into replacement state', async () => {
  const hold = holdFirst('X/indptr/0');
  const { reader, reads } = await openAnnData(cscStore(), { onChunk: hold.onChunk });

  const oldColumn = reader.getMatrixColumn('X', 0);
  const staleAssertion = assert.rejects(oldColumn, SUPERSEDED);
  await hold.started;
  const staleState = reader._matrices.get('X');
  reader.clearCache();
  assert.equal(reader._matrices.size, 0, 'clearing releases the resident matrices');
  hold.release();

  await staleAssertion;
  assert.equal(staleState.columns, null, 'the stale load is not published');
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 0)), [4, 0]);
  assert.notStrictEqual(reader._matrices.get('X'), staleState);
  // A CSC matrix's pointers are read once, as the dataset opens: they are
  // the file's, so a cleared cache reads them no second time.
  assert.equal(readsOf(reads, 'X/indptr').length, 1);
});

// Both writers store every continuous value as Float32 and round integers
// above 2^24 to the nearest Float32, so a file read directly reads the same.
test('integer observation values round to Float32 exactly as the writers export them', async () => {
  const { reader } = await openAnnData(storeWith({
    nObs: 1,
    obs: { count: array(new BigInt64Array([16_777_217n]), { dtype: '<i8' }) },
  }));
  const adapter = new BaseAnnDataAdapter(reader);
  adapter._obsFieldsMetadata = [{ key: 'count', kind: 'continuous' }];

  const field = await adapter.getObsFieldData('count');
  assert.equal(field.kind, 'continuous');
  assert.deepEqual(Array.from(new Float32Array(field.data)), [16_777_216]);
});

test('rejects duplicate connectivity coordinates instead of summing them', () => {
  assert.throws(
    () => extractConnectivityEdges({
      format: 'csr',
      shape: [2, 2],
      data: Float32Array.from([1, 1, 1]),
      indptr: Int32Array.from([0, 2, 3]),
      indices: Int32Array.from([1, 1, 0])
    }, 2),
    /duplicate coordinate/i
  );
});

test('rejects async results from a superseded Zarr dataset generation', async t => {
  await t.test('dense gene load and outer gene cache', async () => {
    const hold = holdFirst('X/0.0');
    const reader = new AnnDataReader();
    await openAnnData(completeTree({ embeddingValues: [1, 2, 3, 4], geneValues: [7, 0, 8, 0] }), {
      reader, name: 'old-dense.zarr', onChunk: hold.onChunk,
    });

    const staleAssertion = assert.rejects(geneColumnByName(reader, 'A'), SUPERSEDED);
    await hold.started;
    await openAnnData(completeTree({ embeddingValues: [9, 10, 11, 12], geneValues: [9, 0, 10, 0] }), {
      reader, name: 'new-dense.zarr',
    });
    hold.release();

    await staleAssertion;
    assert.deepEqual(Array.from(await geneColumnByName(reader, 'A')), [9, 10]);
  });

  await t.test('embedding cache', async () => {
    const hold = holdFirst('obsm/X_umap_2d/0.0');
    const reader = new AnnDataReader();
    await openAnnData(completeTree({ embeddingValues: [1, 2, 3, 4], geneValues: [1, 0, 2, 0] }), {
      reader, name: 'old-embedding.zarr', onChunk: hold.onChunk,
    });

    const staleAssertion = assert.rejects(reader.readObsmColumns('X_umap_2d', [0, 1]), SUPERSEDED);
    await hold.started;
    await openAnnData(completeTree({ embeddingValues: [9, 10, 11, 12], geneValues: [9, 0, 10, 0] }), {
      reader, name: 'new-embedding.zarr',
    });
    hold.release();

    await staleAssertion;
    assert.deepEqual(
      Array.from(await reader.readObsmColumns('X_umap_2d', [0, 1])),
      [9, 10, 11, 12]
    );
  });

  await t.test('sparse outer gene cache', async () => {
    const hold = holdFirst('X/indptr/0');
    const { reader, reads } = await openAnnData(cscStore(), { name: 'old-sparse.zarr', onChunk: hold.onChunk });

    const staleAssertion = assert.rejects(geneColumnByName(reader, 'A'), SUPERSEDED);
    await hold.started;
    reader.clearCache();
    hold.release();

    await staleAssertion;
    assert.deepEqual(Array.from(await geneColumnByName(reader, 'A')), [4, 0]);
    assert.equal(readsOf(reads, 'X/indptr').length, 1, 'the pointers read as the dataset opened serve the next gene');
  });

  await t.test('observation metadata cache', async () => {
    const hold = holdFirst('obs/label/categories/0');
    const { reader } = await openAnnData(storeWith({
      nObs: 1,
      obs: { label: categorical([0], ['A']) },
    }), { onChunk: hold.onChunk });

    const staleAssertion = assert.rejects(reader.getObsFieldInfo('label'), SUPERSEDED);
    await hold.started;
    reader.clearCache();
    hold.release();

    await staleAssertion;
    assert.deepEqual(await reader.getObsFieldInfo('label'), { dtype: 'categorical', categories: ['A'], ordered: false, colors: null });
  });

  await t.test('observation value cache', async () => {
    const hold = holdFirst('obs/value/0');
    const { reader } = await openAnnData(storeWith({
      nObs: 1,
      obs: { value: array(new Float32Array([9])) },
    }), { onChunk: hold.onChunk });

    const staleAssertion = assert.rejects(reader.getObsField('value'), SUPERSEDED);
    await hold.started;
    reader.clearCache();
    hold.release();

    await staleAssertion;
    assert.deepEqual(Array.from((await reader.getObsField('value')).values), [9]);
  });

  await t.test('connectivity payload cache', async () => {
    const hold = holdFirst('obsp/connectivities/0.0');
    const { reader } = await openAnnData(connectivityStore(dense(new Float32Array([0, 1, 1, 0]), [2, 2])), {
      onChunk: hold.onChunk,
    });

    const staleAssertion = assert.rejects(reader.getConnectivities('connectivities'), SUPERSEDED);
    await hold.started;
    reader.clearCache();
    hold.release();

    await staleAssertion;
    assert.deepEqual(Array.from((await reader.getConnectivities('connectivities')).data), [0, 1, 1, 0]);
  });
});

test('reads official categorical v0.2 layouts with nullable-string categories', async () => {
  const { reader } = await openAnnData(storeWith({
    nObs: 3,
    obs: {
      label: categorical([0, -1, 1], nullable('nullable-string-array', ['A', 'C'], [0, 0])),
    },
  }), { name: 'nullable-categories.zarr' });

  const adapter = new BaseAnnDataAdapter(asWorkerLoader(reader));
  await adapter.initialize();

  const categoricalField = adapter.getObsFields().fields.filter(field => field.kind === 'category')[0];
  assert.equal(categoricalField.fieldIndex, 0);
  assert.equal(categoricalField.key, 'label');
  // Its categories are read with the field, not when the store opens.
  assert.equal(categoricalField.categories, null);
  const field = await adapter.getObsFieldData('label');
  assert.equal(field.kind, 'category');
  assert.deepEqual(field.categories, ['A', 'C']);
  assert.deepEqual(Array.from(new Uint8Array(field.data)), [0, 255, 1]);
});

test('accepts a small Blosc-compressed nullable string working set', async () => {
  const entries = zarrEntries(group({
    categories: nullable('nullable-string-array', ['A', 'B'], [0, 0]),
  }));
  for (const child of ['values', 'mask']) {
    const isMask = child === 'mask';
    entries.set(`categories/${child}/.zarray`, json(metadata({
      shape: [2],
      chunks: [2],
      dtype: isMask ? '|b1' : '|O',
      fill_value: isMask ? false : 0,
      compressor: bloscLz4Metadata(),
      filters: isMask ? null : [{ id: 'vlen-utf8' }],
    })));
  }
  const { root } = await openRoot(entries);
  const contract = nullableContract(root.get('categories'), "label' categories", 'nullable-string-array', ZARR_FORMAT, null);
  assert.equal(contract.valuesLength, 2);
  assert.equal(contract.valuesKind, 'string');
});

test('ignores semantically irrelevant masked nullable integer backing values', async () => {
  const { reader } = await openAnnData(storeWith({
    nObs: 1,
    obs: {
      count: nullable('nullable-integer', new BigUint64Array([18_446_744_073_709_551_615n]), [1], { valuesDtype: '<u8' }),
    },
  }));
  const field = await reader.getObsField('count');
  assert.equal(field.dtype, 'uint');
  assert.equal(field.values.length, 1);
  assert.equal(Number.isNaN(field.values[0]), true);
});

test('decodes portable IEEE-754 float16 values in both endian orders', async () => {
  const expectedFinite = [0, -0, 1, -2, 65_504, 5.960464477539063e-8];
  for (const [dtype, hex] of [
    ['<f2', '00000080003c00c0ff7b0100007c00fc007e'],
    ['>f2', '000080003c00c0007bff00017c00fc007e00'],
  ]) {
    const data = await readArray('half', metadata({ shape: [9], chunks: [9], dtype }), { 0: bytesFromHex(hex) });
    for (let index = 0; index < expectedFinite.length; index++) {
      assert.equal(Object.is(data[index], expectedFinite[index]), true);
    }
    assert.equal(data[6], Number.POSITIVE_INFINITY);
    assert.equal(data[7], Number.NEGATIVE_INFINITY);
    assert.equal(Number.isNaN(data[8]), true);
  }
});

test('opens official-writer float16 X and embedding through public methods', async () => {
  const files = completeZarrStoreFiles({
    embeddingValues: [0, 0, 1, 1],
    geneValues: [1, 2, 3, 4]
  });
  setArray(files, 'X', metadata({ shape: [2, 2], chunks: [2, 2], dtype: '<f2' }), { '0.0': bytesFromHex('003c004000420044') });
  setArray(files, 'obsm/X_umap_2d', metadata({ shape: [2, 2], chunks: [2, 2], dtype: '<f2' }), { '0.0': bytesFromHex('00000000003c003c') });

  const { reader } = await openAnnData(files, { name: 'float16-writer.zarr' });
  assert.deepEqual(Array.from(await geneColumnByName(reader, 'A')), [1, 3]);
  assert.deepEqual(
    Array.from(await reader.readObsmColumns('X_umap_2d', [0, 1])),
    [0, 0, 1, 1]
  );
});

test('keeps the latest concurrent Zarr open request', async () => {
  // The first open is still checking its var index when the second is asked for.
  const hold = holdFirst('var/_index/mask/0');
  const reader = new AnnDataReader();
  const firstRequest = openAnnData(
    slowOpeningTree({ embeddingValues: [1, 2, 3, 4], geneValues: [1, 0, 2, 0] }),
    { reader, name: 'first-slow.zarr', onChunk: hold.onChunk }
  );
  const firstAssertion = assert.rejects(
    firstRequest,
    /open request.*superseded|superseded.*open request/i
  );
  await hold.started;
  await openAnnData(
    completeTree({ embeddingValues: [9, 10, 11, 12], geneValues: [9, 0, 10, 0] }),
    { reader, name: 'second-fast.zarr' }
  );
  hold.release();

  await firstAssertion;
  assert.equal(reader._name, 'second-fast.zarr');
  assert.deepEqual(Array.from(await geneColumnByName(reader, 'A')), [9, 10]);
});

test('the Zarr reader publishes no notifications and a newer store supersedes an older one', async t => {
  const events = captureDownloadNotifications(t);
  const createStore = values => completeTree({
    embeddingValues: values,
    geneValues: [1, 0, 2, 0],
  });

  await openAnnData(createStore([0, 0, 1, 1]), { name: 'direct.zarr' });
  assert.deepEqual(events, [], 'the reader runs in a worker; the data source owns notifications');

  const hold = holdFirst('var/_index/mask/0');
  const overlapping = new AnnDataReader();
  const older = openAnnData(slowOpeningTree({ embeddingValues: [1, 2, 3, 4], geneValues: [1, 0, 2, 0] }), { reader: overlapping, name: 'older.zarr', onChunk: hold.onChunk });
  const olderAssertion = assert.rejects(older, /superseded/i);
  await hold.started;
  await openAnnData(createStore([9, 10, 11, 12]), { reader: overlapping, name: 'newer.zarr' });
  hold.release();
  await olderAssertion;
  assert.equal(overlapping._name, 'newer.zarr');
  assert.deepEqual(events, []);
});

/** A `.zattrs` file for the root whose bytes arrive only when released. */
function slowRootAttributes(markStarted, released) {
  const slowRoot = encoder.encode(JSON.stringify({
    'encoding-type': 'anndata',
    'encoding-version': '0.1.0'
  }));
  const slowBytes = async () => {
    markStarted();
    await released;
    return slowRoot.slice().buffer;
  };
  return {
    size: slowRoot.length,
    slice: () => ({ arrayBuffer: slowBytes }),
    arrayBuffer: slowBytes,
    text: async () => new TextDecoder().decode(await slowBytes()),
  };
}

test('keeps the latest concurrent AnnDataFileSource selection', async () => {
  const notifications = getNotificationCenter();
  const notificationMethods = [
    'info',
    'startDownload',
    'updateDownload',
    'completeDownload',
    'failDownload',
    'dismissDownload'
  ];
  const originals = new Map(
    notificationMethods.map(name => [name, notifications[name]])
  );
  notifications.info = () => 'warning';
  notifications.startDownload = () => 'download';
  notifications.updateDownload = () => {};
  notifications.completeDownload = () => {};
  notifications.failDownload = () => {};
  notifications.dismissDownload = () => {};

  const firstStore = completeZarrStoreFiles({
    embeddingValues: [1, 2, 3, 4],
    geneValues: [1, 0, 2, 0]
  });
  const started = deferred();
  const released = deferred();
  // The root metadata arrives only when released: the first open is still
  // reading it when the second is asked for.
  firstStore.set('.zattrs', slowRootAttributes(started.resolve, released.promise));

  const source = new AnnDataFileSource();
  try {
    const firstRequest = source.loadFolder(
      fileListFromMap(firstStore, 'first-slow.zarr')
    );
    const firstAssertion = assert.rejects(
      firstRequest,
      /load request was superseded by a newer selection/i
    );
    await started.promise;
    await source.loadFolder(
      fileListFromMap(
        completeZarrStoreFiles({
          embeddingValues: [9, 10, 11, 12],
          geneValues: [9, 0, 10, 0]
        }),
        'second-fast.zarr'
      )
    );
    released.resolve();

    await firstAssertion;
    assert.equal(source.filename, 'second-fast.zarr');
    assert.deepEqual(
      Array.from(await sourceGeneValuesByName(source, 'A')),
      [9, 10]
    );
  } finally {
    released.resolve();
    source.clear();
    for (const [name, method] of originals) {
      notifications[name] = method;
    }
  }
});

test('a superseded Zarr candidate leaves the opening to the newer one, which ends it opened', async t => {
  const progress = getOpeningProgress();
  const states = [];
  t.after(progress.subscribe(snapshot => {
    if (snapshot !== null) states.push(`${snapshot.id}:${snapshot.state}`);
  }));
  const firstStore = completeZarrStoreFiles({
    embeddingValues: [1, 2, 3, 4],
    geneValues: [1, 0, 2, 0]
  });
  const started = deferred();
  const released = deferred();
  // The root metadata arrives only when released: the first open is still
  // reading it when the second is asked for.
  firstStore.set('.zattrs', slowRootAttributes(started.resolve, released.promise));

  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  const older = source.loadFolder(
    fileListFromMap(firstStore, 'older.zarr')
  );
  const olderAssertion = assert.rejects(older, /superseded/i);
  await started.promise;
  const newer = await source.loadFolder(
    fileListFromMap(
      completeZarrStoreFiles({
        embeddingValues: [9, 10, 11, 12],
        geneValues: [9, 0, 10, 0]
      }),
      'newer.zarr'
    )
  );
  released.resolve();
  await olderAssertion;

  assert.equal(newer.id, 'zarr_newer');
  // One opening on screen for both: the newer joined it, and the older's
  // supersession neither failed nor ended it.
  const ids = new Set(states.map(state => state.split(':')[0]));
  assert.equal(ids.size, 1);
  assert.equal(states.filter(state => !state.endsWith(':running')).length, 1);
  assert.match(states.at(-1), /:done$/);
});

test('AnnDataFileSource preserves a working source when required embedding bytes are corrupt', async () => {
  const notifications = getNotificationCenter();
  const notificationMethods = [
    'info',
    'startDownload',
    'updateDownload',
    'completeDownload',
    'failDownload'
  ];
  const originals = new Map(
    notificationMethods.map(name => [name, notifications[name]])
  );
  notifications.info = () => 'warning';
  notifications.startDownload = () => 'download';
  notifications.updateDownload = () => {};
  notifications.completeDownload = () => {};
  notifications.failDownload = () => {};

  const source = new AnnDataFileSource();
  try {
    await source.loadFolder(
      fileListFromMap(
        completeZarrStoreFiles({
          embeddingValues: [0, 0, 1, 1],
          geneValues: [1, 0, 2, 0]
        }),
        'working.zarr'
      )
    );
    const workingAdapter = source.getAdapter();
    const corrupt = completeZarrStoreFiles({
      embeddingValues: [9, 9, 10, 10],
      geneValues: [9, 0, 10, 0]
    });
    corrupt.set('obsm/X_umap_2d/0.0', Uint8Array.from([0xff]));

    await assert.rejects(
      source.loadFolder(
        fileListFromMap(corrupt, 'corrupt-embedding.zarr')
      ),
      /embedding|chunk|byte length|payload|decodes to/i
    );
    assert.equal(source.filename, 'working.zarr');
    assert.equal(source.getAdapter(), workingAdapter);
    assert.deepEqual(
      Array.from(await sourceGeneValuesByName(source, 'A')),
      [1, 2]
    );
    assert.deepEqual(
      Array.from(
        (await source.getAdapter().getEmbeddingPayload('obsm/0/0-1', 2)).positions
      ),
      [-1, -1, 1, 1]
    );
  } finally {
    source.clear();
    for (const [name, method] of originals) {
      notifications[name] = method;
    }
  }
});

test('duplicate integer sparse coordinates sum in Float32', async t => {
  for (const format of ['csc', 'csr']) {
    await t.test(format.toUpperCase(), async () => {
      const { reader } = await openAnnData(sparseStore({
        format,
        shape: [1, 1],
        data: new Int32Array([16_777_216, 1]),
        dataDtype: '<i4',
        indices: new Int32Array([0, 0]),
        indptr: new Int32Array([0, 2]),
      }));
      const column = await reader.getMatrixColumn('X', 0);
      assert.deepEqual(Array.from(column), [Math.fround(16_777_216 + 1)]);
    });
  }
});

test('Zarr observation dtype metadata cannot be replaced by value inference', async () => {
  const entries = zarrEntries(storeWith({ obs: { score: array(new Float32Array([1, 2])) } }));
  setArray(entries, 'obs/score', metadata({ shape: [2], chunks: [2], dtype: 'not-a-zarr-dtype' }), {
    0: littleEndianBytes([1, 2], 'setFloat32', 4),
  }, { 'encoding-type': 'array', 'encoding-version': '0.2.0' });
  await assert.rejects(openRoot(entries), /'not-a-zarr-dtype' is not a NumPy type/);
});

test('Zarr and H5AD share one value-kind contract for dense X and booleans', async () => {
  // A boolean matrix (a mask, a detection call) reads as 0 and 1.
  const { reader: mask } = await openAnnData(storeWith({ X: dense([false, true, true, false], [2, 2], { dtype: '|b1' }) }));
  assert.deepEqual(Array.from(await mask.getMatrixColumn('X', 0)), [0, 1]);
  const { reader } = await openAnnData(storeWith({ X: dense(new Float32Array([1, 2, 3, 4]), [2, 2]) }));
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 1)), [2, 4]);

  const { decodeAnnDataBoolean } = await import(
    '../assets/js/data/anndata-value-kinds.js'
  );
  for (const [stored, decoded] of [[0, false], [1, true], [false, false], [true, true], [1n, true]]) {
    assert.equal(decodeAnnDataBoolean(stored, 'bad'), decoded);
  }
  for (const corrupt of [2, -1, 255, 0.5, '1', null, Number.NaN]) {
    assert.throws(() => decodeAnnDataBoolean(corrupt, 'not a boolean'), /not a boolean/);
  }
});

test('Zarr does not keep the raw connectivity matrix once it is read', async () => {
  const { reader } = await openAnnData(connectivityStore(sparse({
    shape: [2, 2],
    data: new Float32Array([1, 1]),
    indices: new Int32Array([1, 0]),
    indptr: new Int32Array([0, 1, 2]),
  })));
  const first = await reader.getConnectivities('connectivities');
  assert.equal(first.indices.length, 2);
  for (const [key, value] of reader._cache) {
    assert.notStrictEqual(value, first, `cache entry "${key}" retains the raw matrix`);
  }
});

test('a Zarr store names itself by uns["title"], as AnnData writes it', async () => {
  const scalarString = text => array([text], {
    dtype: '|O',
    shape: [],
    chunks: [],
    attrs: { 'encoding-type': 'string', 'encoding-version': '0.2.0' },
  });
  const titleOf = async (uns, mutate = () => {}) => {
    const entries = zarrEntries(storeWith({ extra: { uns: mapping(uns) } }));
    mutate(entries);
    const { reader } = await openAnnData(entries);
    return (await reader.getDatasetMetadata()).title;
  };
  assert.equal(await titleOf({ title: scalarString('  Synthetic islands — 2D ') }), 'Synthetic islands — 2D');

  // No title, a blank one, or one that is not a scalar string is no title,
  // and never stops the store from opening.
  assert.equal(await titleOf({ subtitle: scalarString('not the title') }), null);
  assert.equal(await titleOf({ title: scalarString('   ') }), null);
  // A one-element string array (R writers, anndata 0.6) is a title; a longer list is not.
  assert.equal(await titleOf({ title: strings(['in an array']) }), 'in an array');
  assert.equal(await titleOf({ title: strings(['a', 'list']) }), null);
  assert.equal(
    await titleOf({ title: scalarString('corrupt') }, entries => entries.set('uns/title/0', new Uint8Array([1, 2, 3]))),
    null
  );
});

test('opening reads no gene name; the var index is read when the names are first asked for', async () => {
  const { reader, reads } = await openAnnData(completeTree({ embeddingValues: [1, 2, 3, 4], geneValues: [1, 0, 2, 0] }), { name: 'names-later.zarr' });
  assert.equal(readsOf(reads, 'var/_index').length, 0, 'opening checks the var index without reading its names');
  assert.equal(reader.nVars, 2);
  assert.deepEqual((await reader.readVarNames('X', null)).index, ['A', 'B']);
  assert.equal(readsOf(reads, 'var/_index').length, 1, 'read once, when asked for');
  await reader.readVarNames('X', null);
  assert.equal(readsOf(reads, 'var/_index').length, 1, 'and kept');
});
