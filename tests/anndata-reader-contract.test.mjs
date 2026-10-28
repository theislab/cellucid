/**
 * The AnnData reader's contract: what it accepts, what it refuses (and
 * before reading what), and what it reads, for an `.h5ad` and an AnnData
 * Zarr store alike.
 *
 * The reader is written once against the array-store model
 * (`formats/store.js`), so its rules are tested on real stores built in
 * memory (`helpers/anndata-store.mjs`: a described tree written as a Zarr
 * store byte for byte and opened by the Zarr package). The store counts the
 * chunks it serves and the arrays the reader reads, so "reads no value",
 * "reads only that gene's entries" and "reads each chunk once" are asserted
 * on what was actually fetched. What only an HDF5 file can carry (its
 * signature and user block, boolean-enum attributes, every string storage,
 * gzip chunks) is read from real `.h5ad` files written by anndata and h5py
 * (`scripts/generate-anndata-contract-fixtures.py`).
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { asWorkerLoader } from './helpers/worker-loader.mjs';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { getOpeningProgress } from '../assets/js/data/opening-progress.js';
import { AnnDataReaderClient } from '../assets/js/data/anndata-reader-client.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { H5AD_FORMAT, ZARR_FORMAT } from '../assets/js/data/anndata/elements.js';
import { openDatasetStore } from '../assets/js/data/anndata/open.js';
import { INPUT_FORMATS } from '../assets/js/data/input-formats.js';
import { SLAB_BYTES, readFloat32 } from '../assets/js/data/anndata/values.js';
import { blobByteSource, httpByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { openZarr } from '../assets/js/formats/zarr/index.js';
import { numericDtype } from '../assets/js/formats/store.js';
import {
  combineDatasetLifecycleFailures,
  createDatasetReloadSupersededError,
  isDatasetReloadSupersededError,
} from '../assets/js/data/dataset-lifecycle-errors.js';
import { extractConnectivityEdges } from '../assets/js/data/connectivity-edges.js';
import {
  EmbeddingLoadError,
  describeAnnDataProbes,
} from '../assets/js/data/data-mapping-candidates.js';
import {
  annData,
  array,
  categorical,
  countingStore,
  dataFrame,
  dense,
  group,
  mapping,
  minimalAnnData,
  nullable,
  openReader,
  sparse,
  stringFrame,
  strings,
} from './helpers/anndata-store.mjs';
import { edgeWeightsFrom, edgeWeightsOf } from './helpers/connectivity-edges.mjs';
import { withObsmPayloads } from './helpers/anndata-mapping-mocks.mjs';

const INVALIDATED_REQUEST =
  /(dataset|cache|request).*(changed|cleared|closed|invalidated|superseded)|superseded/i;

const FIXTURES = new URL('./fixtures/anndata-contract/', import.meta.url);
const SMOKE_H5AD = new URL('./browser/fixtures/current-ui-smoke.h5ad', import.meta.url);
const USERBLOCK_H5 = new URL('./fixtures/hdf5/userblock.h5', import.meta.url);
const MiB = 1024 * 1024;

function fixtureFile(url, name = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)) {
  return new File([readFileSync(url)], name);
}

/** Open a real `.h5ad` through the app's own path into an AnnData reader. */
async function openH5adReader(url) {
  const file = fixtureFile(url);
  const opened = await openDatasetStore({ source: { file } }, { decodedChunkCacheBytes: 64 * MiB });
  const reader = new AnnDataReader();
  await reader.open(opened.root, { format: opened.readerFormat, name: opened.name });
  return reader;
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function rejection(promise) {
  return promise.then(() => null, error => error);
}

/** The chunk keys fetched under `path` (an array path, `obs/label/codes`). */
function chunksUnder(fetched, path) {
  return fetched.filter(key => key.startsWith(`${path}/`));
}

/**
 * The obsm reads a reader made: `[key, columns]` per read of `obsm/<key>`,
 * the columns being those its selection spans.
 */
function obsmReads(reads) {
  return reads
    .filter(read => read.path.startsWith('/obsm/'))
    .map(({ path, selection }) => {
      const [from, to] = selection?.[1] ?? [0, 1];
      return [path.slice('/obsm/'.length), Array.from({ length: to - from }, (_, i) => from + i)];
    });
}

/** Distinct values per cell and column: 10 * cell + column. */
function obsmValues(nObs, width) {
  return Float32Array.from({ length: nObs * width }, (_, index) => 10 * Math.floor(index / width) + (index % width));
}

/** An obsm mapping of dense float32 arrays of the given widths (null: one-dimensional). */
function obsmOfWidths(nObs, widths) {
  return mapping(Object.fromEntries(Object.entries(widths).map(([key, width]) => [
    key,
    width === null
      ? dense(Float32Array.from({ length: nObs }, (_, i) => i), [nObs])
      : dense(obsmValues(nObs, width), [nObs, width], { chunks: [nObs, 1] }),
  ])));
}

/** An adapter over a reader of a dataset whose obsm holds arrays of the given widths. */
async function initializeOverObsm(nObs, widths) {
  const { reader, reads } = await openReader(minimalAnnData({ nObs, X: null, obsm: obsmOfWidths(nObs, widths) }));
  reads.length = 0;
  const adapter = new BaseAnnDataAdapter(reader);
  await adapter.initialize();
  return { adapter, reads: obsmReads(reads) };
}

/** An adapter whose obsm entries are described from the reader's probes. */
async function adapterWithDescribedObsm(reader, options = {}) {
  const adapter = new BaseAnnDataAdapter(reader, options);
  adapter._describedObsm = describeAnnDataProbes(await reader.probeMapping()).obsm;
  return adapter;
}

/** A dataset of `nObs` cells whose obsm holds one embedding under `key`. */
function embeddingTree(embedding, nObs, key = 'X_umap_2d') {
  return minimalAnnData({ nObs, X: null, obsm: mapping({ [key]: embedding }) });
}

/** A dataset whose X is `X` (its shape names the cells and genes). */
function treeWithX(X, nObs, nVars) {
  return minimalAnnData({
    nObs,
    genes: Array.from({ length: nVars }, (_, i) => `gene-${i}`),
    X,
  });
}

function captureDownloadNotifications(t) {
  const notifications = getNotificationCenter();
  const methodNames = ['startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload'];
  const originals = new Map(methodNames.map(name => [name, notifications[name]]));
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

// ---------------------------------------------------------------------------
// Opening a file: its size, its signature, a damaged file.
// ---------------------------------------------------------------------------

test('a direct file has no size ceiling: its size alone refuses nothing', () => {
  // The file is read by ranges, never copied.
  for (const size of [512 * MiB + 1, 64 * 1024 ** 3, Number.MAX_SAFE_INTEGER]) {
    const source = httpByteSource({ url: 'https://example.org/big.h5ad', size, name: 'big.h5ad' });
    assert.equal(source.size, size);
    assert.equal(createByteReader(source).size ?? source.size, size);
  }
});

test('a remote file without an exact size is refused before anything is fetched', async t => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw new Error('fetch sentinel');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const [name, size] of [
    ['missing', undefined],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['non-safe', Number.MAX_SAFE_INTEGER + 1],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        openDatasetStore(
          { source: { file: { url: `https://example.org/${name}.h5ad`, size, name: `${name}.h5ad` } } },
          { decodedChunkCacheBytes: MiB }
        ),
        /needs the exact size of the file/
      );
      assert.equal(fetches, 0);
    });
  }
  await t.test('an empty local file', async () => {
    await assert.rejects(
      openDatasetStore({ source: { file: new File([], 'zero.h5ad') } }, { decodedChunkCacheBytes: MiB }),
      /The selected H5AD file is empty/
    );
  });
  await t.test('an empty remote file', async () => {
    await assert.rejects(
      openDatasetStore(
        { source: { file: { url: 'https://example.org/zero.h5ad', size: 0, name: 'zero.h5ad' } } },
        { decodedChunkCacheBytes: MiB }
      ),
      error => error.details?.explained === true
    );
    assert.equal(fetches, 0, 'a zero-byte file has nothing to fetch');
  });
});

test('an HDF5 file is found by its signature at byte zero or after a user block', async t => {
  const signature = new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);

  await t.test('a signature at byte zero opens', async () => {
    const opened = await openDatasetStore({ source: { file: fixtureFile(SMOKE_H5AD) } }, { decodedChunkCacheBytes: MiB });
    assert.equal(opened.readerFormat, H5AD_FORMAT);
    assert.equal(opened.format, 'h5ad');
    assert.equal(opened.layout, 'file');
    assert.equal(opened.root.kind, 'group');
  });

  await t.test('a signature after a 512-byte user block opens', async () => {
    const bytes = readFileSync(USERBLOCK_H5);
    assert.deepEqual([...bytes.subarray(512, 520)], [...signature], 'the fixture keeps a 512-byte user block');
    assert.notDeepEqual([...bytes.subarray(0, 8)], [...signature]);
    const opened = await openDatasetStore({ source: { file: fixtureFile(USERBLOCK_H5) } }, { decodedChunkCacheBytes: MiB });
    assert.equal(opened.root.kind, 'group');
  });

  await t.test('unrelated bytes are refused with an actionable format error', async () => {
    await assert.rejects(
      openDatasetStore(
        { source: { file: new File([new TextEncoder().encode('not-an-hdf5-file')], 'corrupt.h5ad') } },
        { decodedChunkCacheBytes: MiB }
      ),
      error => /^The selected file is not a valid HDF5 file, so it cannot be an AnnData \(\.h5ad\) file\. Save it again with anndata/.test(error.message)
        && error.details?.explained === true
    );
  });

  await t.test('every HDF5 format is named by its own registry entry when its bytes are not HDF5', async () => {
    for (const format of INPUT_FORMATS.filter(entry => entry.container === 'hdf5' && entry.names.file?.length > 0)) {
      const name = `wrong${format.names.file[0]}`;
      await assert.rejects(
        openDatasetStore(
          { source: { file: new File([new TextEncoder().encode('not-an-hdf5-file')], name) } },
          { decodedChunkCacheBytes: MiB }
        ),
        error => {
          assert.equal(
            error.message,
            `The selected file is not a valid HDF5 file, so it cannot be ${/^([aeiou]|r\b|h5)/i.test(format.label) ? 'an' : 'a'} ${format.label} file. ${format.writeAgain}`,
            name
          );
          assert.equal(error.details?.explained, true);
          return true;
        },
        name
      );
    }
  });

  await t.test('a signature with nothing readable behind it is explained as damaged', async () => {
    const bytes = new Uint8Array(64);
    bytes.set(signature);
    await assert.rejects(
      openDatasetStore({ source: { file: new File([bytes], 'truncated.h5ad') } }, { decodedChunkCacheBytes: MiB }),
      error => /^This \.h5ad file could not be read \(.*\)\. It may be corrupted or truncated\. Save it again with anndata/s.test(error.message)
        && error.details?.explained === true
    );
  });
});

// ---------------------------------------------------------------------------
// The structure: root, dataframes, mappings, axes.
// ---------------------------------------------------------------------------

test('sparse matrices require an explicit standard encoding and shape', async t => {
  for (const [name, mutate, pattern] of [
    ['missing encoding-type', X => delete X.attrs['encoding-type'], /encoding-type.*csr_matrix.*csc_matrix/i],
    ['unknown encoding-type', X => {
      X.attrs['encoding-type'] = 'compressed_matrix';
    }, /encoding-type.*csr_matrix.*csc_matrix/i],
    ['missing shape', X => delete X.attrs.shape, /shape.*required/i],
  ]) {
    await t.test(name, async () => {
      const X = sparse();
      mutate(X);
      await assert.rejects(openReader(treeWithX(X, 1, 1)), pattern);
    });
  }

  await t.test('a valid matrix reads', async () => {
    const { reader } = await openReader(treeWithX(sparse(), 1, 1));
    assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 0)), [1]);
  });
});

test('an observation column of an element type AnnData never stores is refused before any value is read', async () => {
  const tree = minimalAnnData({
    nObs: 2,
    obs: { unsupported: array([[1, 0], [2, 0]], { dtype: '<c8' }) },
  });
  const { store, fetched } = countingStore(tree);
  const root = await openZarr(store);
  await assert.rejects(
    new AnnDataReader().open(root, { format: ZARR_FORMAT, name: 'complex.zarr' }),
    /column 'unsupported' uses an unsupported element type/i
  );
  assert.deepEqual(chunksUnder(fetched, 'obs/unsupported'), []);
});

test('sparse matrices with a malformed structure are refused, never clamped', async t => {
  await t.test('data and indices lengths must match', async () => {
    await assert.rejects(
      openReader(treeWithX(sparse({ data: new Float32Array([1, 2]), indices: new Int32Array([0]) }), 1, 1)),
      /data and indices lengths differ/i
    );
  });

  await t.test('indptr must be monotonic', async () => {
    for (const format of ['csr', 'csc']) {
      const X = sparse({
        format,
        data: new Float32Array([1, 2]),
        indices: new Int32Array([0, 0]),
        indptr: new Int32Array([0, 2, 1]),
        shape: format === 'csr' ? [2, 1] : [1, 2],
      });
      const { reader } = await openReader(treeWithX(X, format === 'csr' ? 2 : 1, format === 'csr' ? 1 : 2));
      await assert.rejects(reader.getMatrixColumn('X', 0), /indptr.*monotonic/i, format);
    }
  });

  await t.test('out-of-range int64 indices are refused instead of clamped', async () => {
    for (const format of ['csr', 'csc']) {
      const X = sparse({ format, indices: new BigInt64Array([2147483648n]), indicesDtype: '<i8' });
      const { reader } = await openReader(treeWithX(X, 1, 1));
      await assert.rejects(reader.getMatrixColumn('X', 0), /index.*(range|outside)/i, format);
    }
  });
});

test('the structure must be the one current AnnData layout, and a failed open publishes nothing', async t => {
  const validRoot = () => annData({
    X: dense(new Float32Array([1]), [1, 1]),
    obs: stringFrame(['cell']),
    var: stringFrame(['gene']),
    obsm: mapping({ X_umap_2d: dense(new Float32Array([0, 0]), [1, 2]) }),
  });

  await t.test('accepts the current root and dataframe identities', async () => {
    const { reader } = await openReader(validRoot());
    assert.equal(reader.nObs, 1);
    assert.equal(reader.nVars, 1);
    assert.deepEqual((await reader.readVarNames('X', null)).index, ['gene']);
  });

  await t.test('rejects an unversioned primitive dataframe index', async () => {
    const root = validRoot();
    root.children.obs.children._index.attrs = { 'encoding-type': 'string-array' };
    await assert.rejects(openReader(root), /observation index.*encoding-version.*0\.2\.0/i);
  });

  await t.test('accepts an empty column-order', async () => {
    const root = validRoot();
    root.children.var.attrs['column-order'] = [];
    const { reader } = await openReader(root);
    assert.equal(reader.nVars, 1);
    assert.deepEqual((await reader.readVarNames('X', null)).index, ['gene']);
  });

  const invalidCases = [
    ['wrong root encoding-type', root => {
      root.attrs['encoding-type'] = 'not-anndata';
    }, /root.*encoding-type.*anndata/i],
    ['wrong root encoding-version', root => {
      root.attrs['encoding-version'] = '9.9.9';
    }, /root.*encoding-version.*0\.1\.0/i],
    ['missing obs dataframe', root => delete root.children.obs, /obs.*required.*dataframe/i],
    ['missing var dataframe', root => delete root.children.var, /var.*required.*dataframe/i],
    ['wrong obs dataframe encoding', root => {
      root.children.obs.attrs['encoding-type'] = 'mapping';
    }, /obs.*encoding-type.*dataframe/i],
    ['wrong var dataframe version', root => {
      root.children.var.attrs['encoding-version'] = '0.1.0';
    }, /var.*encoding-version.*0\.2\.0/i],
    ['missing obsm mapping identity', root => {
      root.children.obsm.attrs = {};
    }, /obsm.*encoding-type.*dict|obsm.*mapping/i],
    ['wrong obsm mapping version', root => {
      root.children.obsm.attrs['encoding-version'] = '9.9.9';
    }, /obsm.*encoding-version.*0\.1\.0/i],
    ['missing index attribute', root => delete root.children.obs.attrs._index, /obs.*_index.*non-empty string/i],
    ['empty index attribute', root => {
      root.children.obs.attrs._index = '';
    }, /obs.*_index.*non-empty string/i],
    ['an index attribute that is not a string', root => {
      root.children.obs.attrs._index = ['_index'];
    }, /obs.*_index.*non-empty string/i],
    ['a string column-order instead of a sequence', root => {
      root.children.obs.attrs['column-order'] = 'label';
    }, /obs.*column-order.*array.*strings/i],
    ['duplicate column-order entry', root => {
      root.children.obs = dataFrame({ _index: strings(['cell']), label: strings(['A']) }, { columnOrder: ['label', 'label'] });
    }, /obs.*column-order.*duplicate.*label/i],
    ['non-string column-order entry', root => {
      root.children.obs.attrs['column-order'] = ['label', 7];
    }, /obs.*column-order.*strings/i],
    ['missing declared child', root => {
      root.children.obs.attrs['column-order'] = ['missing'];
    }, /obs.*declared column.*missing.*not found/i],
    ['missing index child', root => {
      root.children.obs.attrs._index = 'missing_index';
    }, /obs.*index.*missing_index.*not found/i],
    ['the anndata 0.7 __categories layout inside a current dataframe', root => {
      root.children.obs = dataFrame({
        _index: strings(['cell']),
        label: array(new Int8Array([0]), { dtype: '|i1' }),
        __categories: group({ label: strings(['A']) }),
      }, { columnOrder: ['label'] });
    }, /declares the current dataframe encoding but keeps categories in '__categories'/i],
  ];
  for (const [name, mutate, pattern] of invalidCases) {
    await t.test(name, async () => {
      const root = validRoot();
      mutate(root);
      await assert.rejects(openReader(root), pattern);
    });
  }

  await t.test('a late axis failure leaves the open dataset as it was', async () => {
    const { reader } = await openReader(annData({
      X: dense(new Float32Array(2), [2, 1]),
      obs: stringFrame(['old-a', 'old-b'], { old_obs: dense(new Float32Array(2), [2]) }),
      var: stringFrame(['old_gene']),
    }));
    await assert.rejects(
      openReader(annData({
        X: dense(new Float32Array([1]), [1, 1]),
        obs: stringFrame(['cell']),
        var: stringFrame(['gene-a', 'gene-b']),
      }), { reader }),
      /variable index.*length 2.*match 1/i
    );
    assert.equal(reader.nObs, 2);
    assert.equal(reader.nVars, 1);
    assert.deepEqual(reader.obsKeys, ['old_obs']);
    assert.deepEqual((await reader.readVarNames('X', null)).index, ['old_gene']);
    assert.equal(reader.isOpen, true);
  });
});

test('opening enforces the X axes and keeps variable names as stored', async t => {
  const frame = names => dataFrame({ index: strings(names) }, { index: 'index', columnOrder: [] });
  const nullableStringFrame = (names, mask = new Uint8Array(names.length), valuesDtype = '|O', valuesAttrs = undefined) => {
    const index = nullable('nullable-string-array', names, mask, { valuesDtype });
    if (valuesAttrs !== undefined) index.children.values.attrs = valuesAttrs;
    return dataFrame({ _index: index }, { columnOrder: [] });
  };
  const emptySparse = shape => sparse({
    data: new Float32Array(0),
    indices: new Int32Array(0),
    indptr: new Int32Array(shape[0] + 1),
    shape,
  });

  await t.test('an observation axis mismatch is refused', async () => {
    await assert.rejects(
      openReader(annData({ X: emptySparse([2, 1]), obs: frame(['only-one']), var: frame(['gene']) })),
      /observation index length 1 does not match 2/i
    );
  });

  await t.test('a dense X whose shape does not match the dataframes is refused', async () => {
    await assert.rejects(
      openReader(annData({ X: dense(new Float64Array([1]), [1, 1], { dtype: '<f8' }), obs: frame(['a', 'b']), var: frame(['gene']) })),
      /observation index length 2 does not match 1/i
    );
  });

  await t.test('a zero-cell X remains a known axis and cannot be overwritten', async () => {
    await assert.rejects(
      openReader(annData({ X: emptySparse([0, 1]), obs: frame(['unexpected']), var: frame(['gene']) })),
      /observation index length 1 does not match 0/i
    );
  });

  await t.test('a variable axis mismatch is refused', async () => {
    await assert.rejects(
      openReader(annData({ X: emptySparse([1, 1]), obs: frame(['cell']), var: frame(['gene-a', 'gene-b']) })),
      /variable index length 2 does not match 1/i
    );
  });

  await t.test('duplicate variable names open and are kept as stored', async () => {
    // The reader does not refuse a repeated var name: the adapter makes the
    // gene list unique with the data-mapping rule (`makeUniqueNames`).
    const { reader } = await openReader(annData({
      X: emptySparse([1, 2]),
      obs: frame(['cell']),
      var: frame(['duplicate', 'duplicate']),
    }));
    assert.equal(reader.nVars, 2);
    assert.deepEqual((await reader.readVarNames('X', null)).index, ['duplicate', 'duplicate']);
    const names = await reader.readVarNames('X', null);
    assert.deepEqual([...names.index], ['duplicate', 'duplicate']);
    assert.deepEqual([...names.values], ['duplicate', 'duplicate']);
  });

  await t.test('nullable-string observation and variable indices are accepted', async () => {
    const { reader } = await openReader(annData({
      X: emptySparse([2, 2]),
      obs: nullableStringFrame(['cell-a', 'cell-b']),
      var: nullableStringFrame(['gene-a', 'gene-b']),
    }));
    assert.equal(reader.nObs, 2);
    assert.equal(reader.nVars, 2);
    assert.deepEqual((await reader.readVarNames('X', null)).index, ['gene-a', 'gene-b']);
  });

  await t.test('a nullable dataframe index cannot contain missing names', async () => {
    await assert.rejects(
      openReader(annData({
        X: emptySparse([2, 1]),
        obs: nullableStringFrame(['cell-a', 'ignored'], new Uint8Array([0, 1])),
        var: nullableStringFrame(['gene']),
      })),
      /observation index cannot contain missing names/i
    );
  });

  await t.test('a nullable dataframe index requires string values', async () => {
    await assert.rejects(
      openReader(annData({
        X: emptySparse([1, 1]),
        obs: nullableStringFrame(new Int32Array([1]), new Uint8Array([0]), '<i4', {
          'encoding-type': 'string-array',
          'encoding-version': '0.2.0',
        }),
        var: nullableStringFrame(['gene']),
      })),
      /observation index.*string/i
    );
  });
});

test('a file without X does not advertise gene expression', async () => {
  const withX = await openReader(treeWithX(sparse(), 1, 1));
  assert.equal(withX.reader.hasExpressionMatrix, true);

  const { reader } = await openReader(annData({
    obs: stringFrame(['cell-a', 'cell-b']),
    var: stringFrame(['A', 'B']),
    obsm: mapping({ X_umap_2d: dense(new Float32Array([0, 0, 1, 1]), [2, 2]) }),
  }));
  assert.equal(reader.hasExpressionMatrix, false);
  assert.equal(reader.nVars, 2);
  assert.deepEqual((await reader.readVarNames('X', null)).index, ['A', 'B']);

  const adapter = new BaseAnnDataAdapter(reader);
  await adapter.initialize();
  assert.deepEqual((await adapter.getGeneList()).fields, []);
  await assert.rejects(
    adapter.getGeneValues('var/0'),
    /no expression matrix; gene expression is unavailable/i
  );
  await assert.rejects(reader.getMatrixColumn('X', 0), /no X expression matrix/i);
});

// ---------------------------------------------------------------------------
// Gene columns.
// ---------------------------------------------------------------------------

test('sparse gene columns sum duplicate coordinates', async () => {
  for (const format of ['csc', 'csr']) {
    const X = format === 'csc'
      ? sparse({ format, data: new Int32Array([1, 2, 4]), dataDtype: '<i4', indices: new Int32Array([0, 0, 1]), indptr: new Int32Array([0, 3]), shape: [2, 1] })
      : sparse({ format, data: new Int32Array([1, 2, 4]), dataDtype: '<i4', indices: new Int32Array([0, 0, 0]), indptr: new Int32Array([0, 2, 3]), shape: [2, 1] });
    const { reader } = await openReader(treeWithX(X, 2, 1));
    assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 0)), [3, 4], format);
  }
});

// Both writers store expression as Float32 and round integers above 2^24 to
// the nearest Float32, so a file read directly reads the same values.
test('integer sparse gene values round to Float32 as the writers export them', async t => {
  await t.test('an integer above 2^24 rounds to its nearest Float32', async () => {
    const { reader } = await openReader(treeWithX(sparse({ data: new BigInt64Array([16777217n]), dataDtype: '<i8' }), 1, 1));
    assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 0)), [16_777_216]);
  });

  await t.test('a duplicate integer sum rounds to its nearest Float32', async () => {
    const { reader } = await openReader(treeWithX(sparse({
      format: 'csc',
      data: new Int32Array([16777216, 1]),
      dataDtype: '<i4',
      indices: new Int32Array([0, 0]),
      indptr: new Int32Array([0, 2]),
    }), 1, 1));
    assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 0)), [Math.fround(16_777_216 + 1)]);
  });
});

test('a dense X Float64 value beyond the Float32 range reads as an infinity, as numpy converts it', async () => {
  const { reader } = await openReader(treeWithX(dense(new Float64Array([1e308, -1e308]), [2, 1], { dtype: '<f8' }), 2, 1));
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 0)), [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
});

test('a dense X stored in one piece is read once and serves every gene', async () => {
  const nObs = 3;
  const nVars = 4;
  const values = Float32Array.from({ length: nObs * nVars }, (_, index) => index);
  const { reader, fetched } = await openReader(treeWithX(dense(values, [nObs, nVars]), nObs, nVars));
  fetched.length = 0;
  for (let gene = 0; gene < nVars; gene++) {
    assert.deepEqual(Array.from(await reader.getMatrixColumn('X', gene)), [gene, gene + nVars, gene + 2 * nVars]);
  }
  assert.deepEqual(fetched, ['X/0.0'], 'the one chunk is fetched once; no gene reads it again');
});

/** A dense X of 4 cells whose chunks of 2 rows x 4 columns put genes 0-3 in one strip. */
function chunkedDenseTree() {
  const nObs = 4;
  const nVars = 12;
  const values = Float32Array.from({ length: nObs * nVars }, (_, index) => Math.floor(index / nVars) * 10 + (index % nVars));
  return treeWithX(dense(values, [nObs, nVars], { chunks: [2, 4] }), nObs, nVars);
}

test('genes of one dense chunk strip fetch each chunk of the strip once', async () => {
  const { reader, fetched } = await openReader(chunkedDenseTree());
  fetched.length = 0;
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 0)), [0, 10, 20, 30]);
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 1)), [1, 11, 21, 31]);
  assert.deepEqual(fetched, ['X/0.0', 'X/1.0']);

  // Concurrent genes of the same strip share one fetch per chunk.
  const fresh = await openReader(chunkedDenseTree());
  fresh.fetched.length = 0;
  const [geneA, geneC] = await Promise.all([
    fresh.reader.getMatrixColumn('X', 0),
    fresh.reader.getMatrixColumn('X', 2),
  ]);
  assert.deepEqual(Array.from(geneA), [0, 10, 20, 30]);
  assert.deepEqual(Array.from(geneC), [2, 12, 22, 32]);
  assert.deepEqual([...fresh.fetched].sort(), ['X/0.0', 'X/1.0']);
});

test('a dense gene is read by its chunk strip only while the whole strip fits the decoded-chunk budget', async () => {
  // A strip is 4 cells x 4 genes of float32: 64 bytes. Within the budget the
  // store keeps the strip's chunks decoded for its neighbouring genes; beyond
  // it, reading strip by strip would decode the same chunks again for every
  // gene, so the matrix is indexed by gene in row slabs instead.
  const strip = await openReader(chunkedDenseTree(), { decodedChunkCacheBytes: 64 });
  strip.reads.length = 0;
  assert.deepEqual(Array.from(await strip.reader.getMatrixColumn('X', 1)), [1, 11, 21, 31]);
  assert.deepEqual(strip.reads.map(read => read.selection), [[[0, 4], [1, 2]]]);

  const indexed = await openReader(chunkedDenseTree(), { decodedChunkCacheBytes: 63 });
  indexed.reads.length = 0;
  assert.deepEqual(Array.from(await indexed.reader.getMatrixColumn('X', 1)), [1, 11, 21, 31]);
  assert.ok(indexed.reads.length > 0);
  for (const read of indexed.reads) {
    assert.equal(read.path, '/X');
    assert.deepEqual(read.selection[1], [0, 12], 'the index reads whole rows, never a strip');
  }
  assert.deepEqual(Array.from(await indexed.reader.getMatrixColumn('X', 11)), [11, 21, 31, 41]);
});

test('a failed dense chunk read is not kept: the next read fetches it again', async () => {
  let failurePending = true;
  const { reader, fetched } = await openReader(chunkedDenseTree(), {
    onChunk: key => {
      if (failurePending && key === 'X/1.0') {
        failurePending = false;
        throw new Error('block read failed');
      }
    },
  });
  fetched.length = 0;
  await assert.rejects(reader.getMatrixColumn('X', 0), /block read failed/);
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 0)), [0, 10, 20, 30]);
  assert.deepEqual(fetched.filter(key => key === 'X/1.0'), ['X/1.0']);
  assert.ok(fetched.includes('X/0.0'));
});

test('gene columns of a gzip-chunked HDF5 X match its stored values across chunk edges', async () => {
  // 7 cells x 5 genes in gzip chunks of 3 x 2: strips of 2 + 2 + 1 genes and
  // row blocks of 3 + 3 + 1 cells; X[cell, gene] = (5 * cell + gene) / 2.
  const reader = await openH5adReader(new URL('chunked-gzip-dense.h5ad', FIXTURES));
  assert.equal(reader.nObs, 7);
  assert.equal(reader.nVars, 5);
  for (let gene = 0; gene < 5; gene++) {
    assert.deepEqual(
      Array.from(await reader.getMatrixColumn('X', gene)),
      Array.from({ length: 7 }, (_, cell) => (5 * cell + gene) * 0.5)
    );
  }
  assert.deepEqual(
    (await reader.getMatrixColumns('X', [4, 0])).map(column => Array.from(column)),
    [4, 0].map(gene => Array.from({ length: 7 }, (_, cell) => (5 * cell + gene) * 0.5))
  );
});

test('CSC gene columns read only that gene\'s entries', async () => {
  // 3 cells x 3 genes, CSC: gene g has entries indptr[g]..indptr[g+1].
  const X = sparse({
    format: 'csc',
    data: new Float32Array([1, 2, 3, 4]),
    indices: new Int32Array([0, 2, 1, 1]),
    indptr: new Int32Array([0, 2, 3, 4]),
    shape: [3, 3],
  });
  const { reader, reads } = await openReader(treeWithX(X, 3, 3));
  reads.length = 0;
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 0)), [1, 0, 2]);
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 2)), [0, 4, 0]);
  const entryReads = reads
    .filter(read => read.path === '/X/data' || read.path === '/X/indices')
    .map(read => [read.path.slice(3), ...read.selection[0]])
    .sort();
  assert.deepEqual(entryReads, [
    ['data', 0, 2], ['data', 3, 4],
    ['indices', 0, 2], ['indices', 3, 4],
  ]);
});

test('a CSR gene index serves every gene, duplicate coordinates summed', async () => {
  // 4 cells x 3 genes, CSR, with a duplicate coordinate in cell 1.
  const X = sparse({
    data: new Float32Array([1, 2, 3, 0.5, 4, 5]),
    indices: new Int32Array([0, 2, 1, 1, 0, 2]),
    indptr: new Int32Array([0, 2, 4, 5, 6]),
    shape: [4, 3],
  });
  const { reader } = await openReader(treeWithX(X, 4, 3));
  const [a, b, c] = await Promise.all([0, 1, 2].map(gene => reader.getMatrixColumn('X', gene)));
  assert.deepEqual(Array.from(a), [1, 0, 4, 0]);
  assert.deepEqual(Array.from(b), [0, Math.fround(3 + 0.5), 0, 0]);
  assert.deepEqual(Array.from(c), [2, 0, 0, 5]);
});

test('a cell subset of a row-major matrix is read by cell, gene-major, and equals the columns', async () => {
  // 5 cells x 4 genes, CSR (cell 1 lists gene 2 twice: summed).
  const X = sparse({
    data: new Float32Array([1, 2, 3, 0.5, 4, 5, 6, 7]),
    indices: new Int32Array([0, 2, 2, 2, 1, 3, 0, 1]),
    indptr: new Int32Array([0, 2, 4, 6, 7, 8]),
    shape: [5, 4],
    // Stored as a written file's: a chunk is decoded whole.
    compressed: true,
  });
  const { reader, reads } = await openReader(treeWithX(X, 5, 4));
  const columns = await reader.getMatrixColumns('X', [0, 1, 2, 3]);
  reads.length = 0;
  const cells = [4, 1, 2];
  const genes = [2, 0, 1];
  const block = await reader.getMatrixCellSubset('X', cells, genes);
  assert.ok(block !== null);
  genes.forEach((gene, g) => {
    const expected = cells.map(cell => columns[gene][cell]);
    const actual = new Array(cells.length).fill(0);
    for (let entry = block.pointers[g]; entry < block.pointers[g + 1]; entry++) {
      actual[block.cellIndex[entry]] = block.values[entry];
    }
    assert.deepEqual(actual, expected, `gene ${gene}`);
  });
  // The asked cells' entries were read as one range (cells 1, 2 and 4 lie in
  // one chunk, decoded once): from cell 1's first entry to cell 4's last.
  const entryReads = reads.filter(read => read.path === '/X/data').map(read => read.selection[0]);
  assert.deepEqual(entryReads, [[2, 8]]);

  // Every cell for one gene: the same values, whichever way it is read.
  const whole = await reader.getMatrixCellSubset('X', [0, 1, 2, 3, 4], [0]);
  assert.deepEqual(Array.from(whole.pointers), [0, 2]);
  assert.deepEqual(Array.from(whole.cellIndex), [0, 3]);
  assert.deepEqual(Array.from(whole.values), [1, 6]);
  await assert.rejects(reader.getMatrixCellSubset('X', [1, 1], [0]), /names a cell more than once/);
});

test('a cell subset of a column-major matrix is read by gene', async () => {
  const X = sparse({
    format: 'csc',
    data: new Float32Array([1, 2]),
    indices: new Int32Array([0, 1]),
    indptr: new Int32Array([0, 1, 2]),
    shape: [2, 2],
  });
  const { reader } = await openReader(treeWithX(X, 2, 2));
  const block = await reader.getMatrixCellSubset('X', [0], [0, 1]);
  assert.deepEqual(Array.from(block.pointers), [0, 1, 1]);
  assert.deepEqual(Array.from(block.cellIndex), [0]);
  assert.deepEqual(Array.from(block.values), [1]);
});

test('clearing the reader invalidates a gene read under way without publishing it', async () => {
  const gate = deferred();
  let gated = false;
  const X = sparse({
    format: 'csc',
    data: new Float32Array([7]),
    indices: new Int32Array([0]),
    indptr: new Int32Array([0, 1]),
  });
  const { reader } = await openReader(treeWithX(X, 1, 1), {
    onChunk: async key => {
      if (key === 'X/indptr/0' && !gated) {
        gated = true;
        await gate.promise;
      }
    },
  });
  const stale = reader.getMatrixColumn('X', 0);
  const staleAssertion = assert.rejects(stale, INVALIDATED_REQUEST);
  while (!gated) await new Promise(resolve => setImmediate(resolve));
  const state = reader._matrices.get('X');
  reader.clearCache();
  gate.resolve();
  await staleAssertion;
  assert.equal(reader._matrices.size, 0);
  assert.equal(state.columns, null, 'the stale load is not published to the released matrix');
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 0)), [7], 'a later read is independent');
});

test('a cancelled gene read stops at once, cancels its store reads, and keeps the matrix access', async () => {
  // 3 cells x 2 genes, CSC: the pointers are read once, then each gene reads
  // its own entries.
  const X = sparse({
    format: 'csc',
    data: new Float32Array([1, 2, 3]),
    indices: new Int32Array([0, 2, 1]),
    indptr: new Int32Array([0, 2, 3]),
    shape: [3, 2],
  });
  const gate = deferred();
  const dataSignals = [];
  const { reader, fetched } = await openReader(treeWithX(X, 3, 2), {
    onChunk: async (key, options) => {
      if (key.startsWith('X/data/') && dataSignals.length === 0) {
        dataSignals.push(options?.signal ?? null);
        await gate.promise;
      }
    },
  });
  const controller = new AbortController();
  const read = reader.getMatrixColumn('X', 0, { signal: controller.signal });
  while (dataSignals.length === 0) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(read, { name: 'AbortError' });
  assert.equal(dataSignals[0]?.aborted, true, 'the store read carries the caller\'s signal');
  gate.resolve();
  const pointerReads = chunksUnder(fetched, 'X/indptr').length;
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 1)), [0, 3, 0]);
  assert.deepEqual(Array.from(await reader.getMatrixColumn('X', 0)), [1, 0, 2]);
  assert.equal(chunksUnder(fetched, 'X/indptr').length, pointerReads, 'a cancelled read is not a failure: the pointers are kept');
  // A signal aborted before the call reads nothing.
  const before = fetched.length;
  await assert.rejects(reader.getMatrixColumns('X', [0, 1], { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(fetched.length, before);
});

test('clearing the reader releases cell-row access even when releasing the gene columns fails', async () => {
  const { reader } = await openReader(treeWithX(sparse(), 1, 1));
  const failure = new Error('matrix release failed');
  let rowsReleased = 0;
  reader._matrices.set('X', { element: 'X', loadPromise: null, columns: { dispose() { throw failure; } } });
  reader._rows = { element: 'X', rows: Promise.resolve({ dispose() { rowsReleased++; } }) };
  assert.throws(() => reader.clearCache(), error => error === failure);
  assert.equal(reader._matrices.size, 0);
  assert.equal(reader._rows, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rowsReleased, 1);
});

// ---------------------------------------------------------------------------
// Embeddings (obsm).
// ---------------------------------------------------------------------------

test('embeddings check the cell axis and refuse values that cannot be plotted', async t => {
  await t.test('a cell-axis mismatch is refused by the column read', async () => {
    const tree = embeddingTree(dense(new Float64Array([0, 0, 1, 1]), [2, 2], { dtype: '<f8' }), 1);
    const { reader } = await openReader(tree);
    await assert.rejects(
      reader.readObsmColumns('X_umap_2d', [0, 1]),
      /obsm\['X_umap_2d'\] has 2 rows but the dataset has 1 cell$/
    );
    assert.equal(reader._cache.size, 0);
  });

  for (const [name, values, reason] of [
    ['finite Float64 overflow', [1e308, 0, 0, 1], 'not representable as float32 at cell 0'],
    ['a non-zero value that narrows to zero', [0, 0, 1e-60, 1], 'not representable as float32 at cell 1'],
    ['NaN', [0, 0, Number.NaN, 1], 'NaN at cell 1'],
    ['positive infinity', [Number.POSITIVE_INFINITY, 0, 0, 1], 'Infinity at cell 0'],
    ['negative infinity', [0, 0, Number.NEGATIVE_INFINITY, 1], '-Infinity at cell 1'],
    ['constant coordinates', [2, 3, 2, 3], 'no coordinate variation'],
  ]) {
    await t.test(`${name} is refused before normalization or caching`, async () => {
      const { reader } = await openReader(embeddingTree(dense(new Float64Array(values), [2, 2], { dtype: '<f8' }), 2));
      const adapter = await adapterWithDescribedObsm(reader);
      const error = await rejection(adapter.getEmbeddingForRef({ key: 'X_umap_2d', columns: [0, 1] }));
      assert.ok(error instanceof EmbeddingLoadError);
      assert.equal(error.key, 'X_umap_2d');
      assert.deepEqual(error.columns, [0, 1]);
      assert.equal(error.reason, reason);
      assert.equal(error.message, `Embedding 'X_umap_2d' cannot be plotted: ${reason}.`);
      assert.equal(adapter._embeddingCache.size, 0);
      assert.equal(adapter._embeddingInfo.size, 0);
      assert.equal(adapter._coordinateCacheBytes, 0n);
    });
  }
});

test('mapping probes describe every element from metadata, with the catalog reasons', async () => {
  const tree = annData({
    X: dense(new Float32Array(3), [3, 1]),
    obs: stringFrame(['c0', 'c1', 'c2']),
    var: stringFrame(['gene'], {
      gene_symbols: strings(['G']),
      score: dense(new Float32Array([1]), [1]),
    }),
    obsm: mapping({
      X_umap: dense(new Float32Array(6), [3, 2]),
      X_sparse: sparse({ shape: [3, 5] }),
      X_df: stringFrame(['c0', 'c1', 'c2']),
      pseudotime: dense(new Int32Array(3), [3], { dtype: '<i4' }),
      labels: strings(['a', 'b', 'c']),
      X_short: dense(new Float64Array(4), [2, 2], { dtype: '<f8' }),
    }),
    obsp: mapping({
      connectivities: sparse({
        data: new Float32Array([1, 1]),
        indices: new Int32Array([1, 0]),
        indptr: new Int32Array([0, 1, 2, 2]),
        shape: [3, 3],
      }),
      distances: dense(new Float32Array(6), [3, 2]),
    }),
    layers: mapping({
      counts: sparse({ data: new Int32Array([1]), dataDtype: '<i4', shape: [3, 1], indptr: new Int32Array([0, 1, 1, 1]) }),
      wide: dense(new Float32Array(6), [3, 2]),
    }),
    raw: group({
      X: sparse({ shape: [3, 4], indptr: new Int32Array([0, 1, 1, 1]) }),
      var: stringFrame(['a', 'b', 'c', 'd']),
    }),
  });
  const { reader, fetched } = await openReader(tree);
  fetched.length = 0;
  const probes = await reader.probeMapping();
  assert.deepEqual(fetched, [], 'probes read no array value');
  assert.equal(probes.nObs, 3);
  assert.equal(probes.nVars, 1);
  const described = describeAnnDataProbes(probes);
  // Keys are listed in code-point order, as every store lists children.
  assert.deepEqual(
    described.obsm.map(({ key, storage, shape, dtype, usable, reason }) => [key, storage, shape, dtype, usable, reason]),
    [
      ['X_df', 'dataframe', [3, 0], 'object', false, 'obsm table, not an array'],
      ['X_short', 'dense', [2, 2], 'float64', false, 'has 2 rows, the dataset has 3 cells'],
      ['X_sparse', 'csr', [3, 5], 'float32', false, 'sparse obsm arrays cannot be plotted'],
      ['X_umap', 'dense', [3, 2], 'float32', true, null],
      ['labels', 'dense', [3], 'string', false, 'not a numeric array'],
      ['pseudotime', 'dense', [3], 'int32', true, null],
    ]
  );
  assert.deepEqual(
    described.obsp.map(({ key, storage, nnz, usable, reason }) => [key, storage, nnz, usable, reason]),
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
    described.layers.map(({ key, usable, reason }) => [key, usable, reason]),
    [
      ['counts', true, null],
      ['wide', false, 'has shape 3 x 2, expected 3 x 1'],
    ]
  );
  assert.deepEqual(described.raw, {
    n_vars: 4,
    X: { storage: 'csr', dtype: 'float32' },
    var: { columns: [] },
  });
});

test('obsm column reads return fresh arrays the reader does not keep', async () => {
  const { reader } = await openReader(embeddingTree(dense(new Float32Array([0, 1, 2, 3]), [2, 2]), 2));
  const first = await reader.readObsmColumns('X_umap_2d', [0, 1]);
  const second = await reader.readObsmColumns('X_umap_2d', [0, 1]);
  // A float32 array reads as float32, exactly as stored.
  assert.ok(first instanceof Float32Array);
  assert.deepEqual(Array.from(first), [0, 1, 2, 3]);
  assert.notStrictEqual(first, second);
  first[0] = 99;
  assert.equal(second[0], 0);
  assert.equal(reader._cache.size, 0);
});

test('obsm column reads select the narrowest column ranges and fetch only their chunks', async t => {
  // A 3-cell x 6-column array whose value is 10 * row + column, one column per chunk.
  const nRows = 3;
  const width = 6;
  const pca = () => embeddingTree(dense(obsmValues(nRows, width), [nRows, width], { chunks: [nRows, 1] }), nRows, 'X_pca');

  for (const [name, columns, expectedRanges] of [
    ['adjacent columns are one range', [0, 1, 2], [[0, 3]]],
    ['a narrow slab is one range', [3, 2], [[2, 4]]],
    ['a wide span is one range per column', [5, 1], [[5, 6], [1, 2]]],
  ]) {
    await t.test(name, async () => {
      const { reader, reads, fetched } = await openReader(pca());
      reads.length = 0;
      fetched.length = 0;
      const result = await reader.readObsmColumns('X_pca', columns);
      assert.deepEqual(reads.map(read => read.selection[1]), expectedRanges);
      const fetchedColumns = fetched.map(key => Number(key.split('.')[1])).sort((a, b) => a - b);
      assert.deepEqual(fetchedColumns, expectedRanges.flatMap(([from, to]) => Array.from({ length: to - from }, (_, i) => from + i)).sort((a, b) => a - b));
      const expected = [];
      for (let row = 0; row < nRows; row++) {
        for (const column of columns) expected.push(10 * row + column);
      }
      assert.deepEqual(Array.from(result), expected);
    });
  }

  await t.test('a selection spanning the whole array reads its values in the order asked', async () => {
    const { reader } = await openReader(embeddingTree(dense(Float32Array.from([0, 1, 10, 11]), [2, 2]), 2));
    assert.deepEqual(Array.from(await reader.readObsmColumns('X_umap_2d', [1, 0])), [1, 0, 11, 10]);
  });

  await t.test('a one-dimensional array is one column', async () => {
    const { reader } = await openReader(embeddingTree(dense(new Int32Array([4, 5, 6]), [3], { dtype: '<i4' }), 3, 'pseudotime'));
    assert.deepEqual(Array.from(await reader.readObsmColumns('pseudotime', [0])), [4, 5, 6]);
  });

  await t.test('columns outside the array or repeated are refused', async () => {
    const { reader } = await openReader(pca());
    await assert.rejects(reader.readObsmColumns('X_pca', [0, 6]), /reads distinct columns between 0 and 5/);
    await assert.rejects(reader.readObsmColumns('X_pca', [1, 1]), /distinct columns/);
    await assert.rejects(reader.readObsmColumns('X_missing', [0, 1]), /obsm\['X_missing'\] does not exist/);
  });
});

test('the adapter loads an embedding larger than its cache budget', async () => {
  const { reader } = await openReader(embeddingTree(dense(new Float32Array([0, 1, 2, 3]), [2, 2]), 2));
  // The budget is a residency policy: a 16-byte result under an 8-byte
  // budget still loads.
  const adapter = await adapterWithDescribedObsm(reader, { cacheBudgetBytes: 8 });
  const embedding = await adapter.getEmbeddingForRef({ key: 'X_umap_2d', columns: [0, 1] });
  assert.ok(embedding instanceof Float32Array);
  assert.equal(embedding.length, 4);
});

test('direct AnnData slots follow the default rule, and a plain X_umap by width', async t => {
  await t.test('an unsuffixed X_umap array is read at its own column count', async () => {
    const { adapter, reads } = await initializeOverObsm(2, { X_umap: 2 });
    assert.deepEqual(adapter._slots, {
      '1d': null,
      '2d': { key: 'X_umap', columns: [0, 1] },
      '3d': null,
    });
    assert.deepEqual(adapter.getMappingCandidates().guessed, []);
    assert.deepEqual(reads, [['X_umap', [0, 1]]]);
  });

  await t.test('an unsuffixed X_umap of a width no dimension has is best-guessed at its first columns', async () => {
    const { adapter } = await initializeOverObsm(2, { X_umap: 10 });
    assert.deepEqual(adapter._slots['2d'], { key: 'X_umap', columns: [0, 1] });
    assert.deepEqual(adapter.getMappingCandidates().guessed, ['embeddings.2d']);
  });

  await t.test('dimension-suffixed keys alone fill their slots', async () => {
    const { adapter, reads } = await initializeOverObsm(2, { X_umap: 2, X_umap_2d: 2, X_tsne: 2 });
    assert.deepEqual(adapter._slots, {
      '1d': null,
      '2d': { key: 'X_umap_2d', columns: [0, 1] },
      '3d': null,
    });
    // Only the default dimension's embedding is read while opening.
    assert.deepEqual(reads, [['X_umap_2d', [0, 1]]]);
  });

  await t.test('a malformed suffixed key cannot be skipped for another dimension', async () => {
    await assert.rejects(
      initializeOverObsm(2, { X_umap_2d: 3, X_umap_3d: 3 }),
      /Embedding 'X_umap_2d' must have exactly 2 columns; got 3/
    );
  });
});

test('direct AnnData vector discovery binds <field>_<basis> keys to X_<basis>, on any basis', async t => {
  async function discover(widths) {
    const { adapter } = await initializeOverObsm(2, widths);
    // The bindings stay private to the adapter: the data mapping draws them
    // (`resolveVectorFields`).
    const bindings = Object.fromEntries(
      [...adapter._vectorBindings].map(([fieldId, byEmbedding]) => [fieldId, Object.fromEntries(byEmbedding)])
    );
    const enabled = adapter.getMappingCandidates().defaults.embeddings.enabled.map(ref => ref.key);
    return { bindings, enabled };
  }

  await t.test('velocity on a non-UMAP embedding binds automatically, beside the UMAP one', async () => {
    const { bindings, enabled } = await discover({
      X_umap: 2,
      X_branches: 3,
      velocity_umap: 2,
      velocity_branches: 3,
    });
    // One field, `velocity`, drawn over whichever of its embeddings a view shows.
    assert.deepEqual(bindings, {
      velocity: { X_branches: 'velocity_branches', X_umap: 'velocity_umap' },
    });
    assert.deepEqual(enabled, ['X_branches', 'X_umap']);
  });

  await t.test('per-dimension UMAP keys bind to the embedding they are named for', async () => {
    const { bindings } = await discover({ X_umap_2d: 2, X_umap_3d: 3, velocity_umap_2d: 2, velocity_umap_3d: 3 });
    assert.deepEqual(bindings, {
      velocity: { X_umap_2d: 'velocity_umap_2d', X_umap_3d: 'velocity_umap_3d' },
    });
  });

  await t.test('a key named for no embedding is an ordinary array', async () => {
    const { bindings, enabled } = await discover({ X_umap: 2, velocity_umap_2d: 2 });
    assert.deepEqual(bindings, {});
    assert.deepEqual(enabled, ['X_umap', 'velocity_umap_2d']);
  });

  await t.test('several fields of one basis are recorded in code-point order', async () => {
    const { bindings } = await discover({ X_umap: 2, velocity_umap: 2, T_fwd_umap: 2, drift_umap: 2 });
    assert.deepEqual(Object.keys(bindings), ['T_fwd', 'drift', 'velocity']);
  });

  await t.test('a vector of another width than its embedding stays unbound, and is no embedding', async () => {
    const { bindings, enabled } = await discover({ X_umap: 2, velocity_umap: 3 });
    assert.deepEqual(bindings, {});
    assert.deepEqual(enabled, ['X_umap']);
  });
});

/** A dataset of two cells, one gene, and the given obsm. */
function pcaOnlyTree(obsm) {
  return annData({
    X: dense(new Float32Array([1, 2]), [2, 1]),
    obs: stringFrame(['cell-a', 'cell-b']),
    var: stringFrame(['gene']),
    obsm: mapping(obsm),
  });
}

test('a PCA-only file is best-guessed and the guess is recorded', async () => {
  const { reader } = await openReader(pcaOnlyTree({ X_pca: dense(new Float32Array([0, 1, 5, 2, 3, 7]), [2, 3]) }));
  const adapter = new BaseAnnDataAdapter(reader);
  await adapter.initialize();
  // No UMAP: the one narrow candidate is 3 columns wide, so it fills 3D.
  assert.deepEqual(adapter._slots, {
    '1d': null,
    '2d': null,
    '3d': { key: 'X_pca', columns: [0, 1, 2] },
  });
  const candidates = adapter.getMappingCandidates();
  assert.deepEqual(candidates.guessed, ['embeddings.3d']);
  assert.deepEqual(candidates.defaults.embeddings.defaults['3d'], { key: 'X_pca', columns: [0, 1, 2] });
  // The guessed default is the one representation enabled.
  assert.deepEqual(candidates.defaults.embeddings.enabled, [{ key: 'X_pca', columns: [0, 1, 2] }]);
});

test('a wide PCA is read at its first two columns only', async () => {
  const values = Float32Array.from({ length: 10 }, (_, index) => index * index);
  const { reader, reads, fetched } = await openReader(pcaOnlyTree({ X_pca: dense(values, [2, 5], { chunks: [2, 1] }) }));
  reads.length = 0;
  fetched.length = 0;
  const adapter = new BaseAnnDataAdapter(reader);
  await adapter.initialize();
  assert.deepEqual(adapter._slots['2d'], { key: 'X_pca', columns: [0, 1] });
  assert.deepEqual(adapter.getMappingCandidates().guessed, ['embeddings.2d']);
  // Only the two columns plotted are read, never the whole array.
  assert.deepEqual(obsmReads(reads), [['X_pca', [0, 1]]]);
  assert.deepEqual(chunksUnder(fetched, 'obsm/X_pca').sort(), ['obsm/X_pca/0.0', 'obsm/X_pca/0.1']);
  const identity = await adapter.finalizeDirectIdentity({
    id: 'pca-only',
    name: 'pca-only',
    preferFileName: false,
    description: '',
    source: { name: 'H5AD file' },
  });
  assert.deepEqual(identity.embeddings.defaults, { '2d': 'X_pca[0,1]' });
  assert.deepEqual(identity.embeddings.items['X_pca[0,1]'].source, { key: 'X_pca', columns: [0, 1] });
});

test('a file with nothing plottable is refused with what obsm holds', async () => {
  const { reader } = await openReader(pcaOnlyTree({
    X_df: stringFrame(['cell-a', 'cell-b']),
    spatial: dense(new Float32Array([0, 1, Number.NaN, 2]), [2, 2]),
  }));
  const adapter = new BaseAnnDataAdapter(reader);
  const error = await rejection(adapter.initialize());
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'DataSourceError');
  assert.equal(error.code, 'NO_PLOTTABLE_EMBEDDING');
  assert.equal(
    error.message,
    'Cellucid found nothing to plot. It needs an obsm array with one row per ' +
    'cell (2) and at least one numeric column. obsm holds: X_df (table), ' +
    'spatial (2 × 2, NaN at cell 1).' +
    ' Add a 2-D embedding to obsm (for example with sc.tl.umap in Scanpy), then open the data again.'
  );
  assert.equal(adapter.getMetadata(), null);
});

// ---------------------------------------------------------------------------
// Observation fields.
// ---------------------------------------------------------------------------

test('nullable integer and boolean observation columns read with missing values', async () => {
  const { reader } = await openReader(minimalAnnData({
    nObs: 2,
    obs: {
      count: nullable('nullable-integer', new BigInt64Array([42n, 9007199254740993n]), [0, 1]),
      detected: nullable('nullable-boolean', [true, false], [0, 1]),
      unsigned_count: nullable('nullable-integer', new BigUint64Array([7n, 18446744073709551615n]), [0, 1], { valuesDtype: '<u8' }),
    },
  }));

  assert.deepEqual(await reader.getObsFieldInfo('count'), { dtype: 'int' });
  const count = await reader.getObsField('count');
  assert.equal(count.dtype, 'int');
  assert.equal(count.values[0], 42);
  assert.equal(Number.isNaN(count.values[1]), true, 'a masked value is missing, whatever is stored under the mask');

  assert.deepEqual(await reader.getObsField('detected'), { dtype: 'bool', values: [true, null] });

  assert.deepEqual(await reader.getObsFieldInfo('unsigned_count'), { dtype: 'uint' });
  const unsignedCount = await reader.getObsField('unsigned_count');
  assert.equal(unsignedCount.dtype, 'uint');
  assert.equal(unsignedCount.values[0], 7);
  assert.equal(Number.isNaN(unsignedCount.values[1]), true);
});

test('string arrays read from any string storage, and a non-string declared string-array is refused', async t => {
  // anndata writes variable-length UTF-8; other writers use fixed-length or
  // ASCII strings, which hold the same text.
  for (const [name, node, expected] of [
    ['variable-length UTF-8', strings(['α', 'β']), ['α', 'β']],
    ['variable-length bytes (ASCII)', strings(['one', 'two'], { vlen: 'bytes' }), ['one', 'two']],
    ['fixed-length ASCII', array(['one', 'two'], { dtype: '|S4' }), ['one', 'two']],
    ['fixed-length unicode', array(['α', 'βγ'], { dtype: '<U2' }), ['α', 'βγ']],
  ]) {
    await t.test(`Zarr ${name}`, async () => {
      const { reader } = await openReader(minimalAnnData({ nObs: 2, obs: { label: node } }));
      assert.deepEqual(await reader.getObsFieldInfo('label'), { dtype: 'string' });
      assert.deepEqual((await reader.getObsField('label')).values, expected);
    });
  }

  await t.test('HDF5 variable-length UTF-8 and ASCII, fixed-length UTF-8 and ASCII', async () => {
    const reader = await openH5adReader(new URL('hdf5-storage-variants.h5ad', FIXTURES));
    for (const [key, expected] of [
      ['utf8_vlen', ['α', 'β', 'γ']],
      ['ascii_vlen', ['one', 'two', 'six']],
      ['utf8_fixed', ['α', 'β', 'γ']],
      ['ascii_fixed', ['one', 'two', 'six']],
    ]) {
      assert.deepEqual(await reader.getObsFieldInfo(key), { dtype: 'string' }, key);
      assert.deepEqual((await reader.getObsField(key)).values, expected, key);
    }
  });

  await t.test('a numeric array declared string-array is refused before any value is read', async () => {
    const label = dense(new Float32Array([1, 2]), [2], {
      attrs: { 'encoding-type': 'string-array', 'encoding-version': '0.2.0' },
    });
    const { store, fetched } = countingStore(minimalAnnData({ nObs: 2, obs: { label } }));
    await assert.rejects(
      new AnnDataReader().open(await openZarr(store), { format: ZARR_FORMAT, name: 'x.zarr' }),
      /declares string-array but does not use a string dtype/
    );
    assert.deepEqual(chunksUnder(fetched, 'obs/label'), []);
  });
});

test('a nullable observation index is checked by its mask alone; its names are never read', async () => {
  const length = 5;
  const index = nullable('nullable-string-array', Array.from({ length }, (_, i) => `cell-${i}`), new Uint8Array(length));
  const { reader, fetched } = await openReader(annData({
    X: dense(new Float32Array(0), [length, 0]),
    obs: dataFrame({ cell_id: index }, { index: 'cell_id', columnOrder: [] }),
    var: stringFrame([]),
  }));
  assert.equal(reader.nObs, length);
  assert.deepEqual(chunksUnder(fetched, 'obs/cell_id/mask'), ['obs/cell_id/mask/0']);
  assert.deepEqual(chunksUnder(fetched, 'obs/cell_id/values'), []);
});

test('categorical labels read from nested nullable-string groups', async () => {
  const categories = nullable('nullable-string-array', ['alpha', 'beta'], [0, 0]);
  const { reader } = await openReader(minimalAnnData({
    nObs: 3,
    obs: { label: categorical(new Int8Array([0, -1, 1]), categories) },
  }));
  assert.deepEqual(await reader.getObsFieldInfo('label'), {
    dtype: 'categorical',
    categories: ['alpha', 'beta'],
    ordered: false,
    // No `uns['label_colors']`: no palette.
    colors: null,
  });
  const field = await reader.getObsField('label');
  assert.deepEqual(Array.from(field.codes), [0, -1, 1]);
  assert.deepEqual(field.categories, ['alpha', 'beta']);
  assert.deepEqual(field.values, ['alpha', null, 'beta']);
});

test('categorical ordered is a boolean (or 0 / 1) and is preserved downstream', async t => {
  const labelTree = ordered => {
    const field = categorical(new Int8Array([0, 1]), ['low', 'high']);
    if (ordered === undefined) delete field.attrs.ordered;
    else field.attrs.ordered = ordered;
    return minimalAnnData({ nObs: 2, obs: { label: field } });
  };

  for (const [name, ordered] of [
    ['missing ordered', undefined],
    ['string ordered', 'false'],
    ['an integer other than 0 or 1', 2],
    ['an empty array', []],
    ['a two-element array', [false, true]],
  ]) {
    await t.test(`${name} is refused before any value is read`, async () => {
      const { store, fetched } = countingStore(labelTree(ordered));
      await assert.rejects(
        new AnnDataReader().open(await openZarr(store), { format: ZARR_FORMAT, name: 'x.zarr' }),
        /ordered must be a boolean attribute/i
      );
      assert.deepEqual(chunksUnder(fetched, 'obs/label'), []);
    });
  }

  for (const [name, ordered, expected] of [
    ['a JSON boolean false', false, false],
    ['a JSON boolean true', true, true],
    ['the integer 0', 0, false],
    ['the integer 1', 1, true],
    // R writers store every attribute as a one-element array.
    ['a one-element array', [true], true],
  ]) {
    await t.test(`${name} is ordered=${expected}`, async () => {
      const { reader } = await openReader(labelTree(ordered));
      assert.equal((await reader.getObsFieldInfo('label')).ordered, expected);
      assert.equal((await reader.getObsField('label')).ordered, expected);
    });
  }

  // Byte order is not a property of a one-byte value: h5py takes the enum's
  // base type from the writing host, so an `.h5ad` written on a big-endian
  // machine records `ordered` on a big-endian base. It is the same boolean.
  await t.test('HDF5 boolean enums, little- or big-endian, and an integer attribute', async () => {
    const reader = await openH5adReader(new URL('hdf5-storage-variants.h5ad', FIXTURES));
    for (const [key, expected] of [['le_true', true], ['be_false', false], ['be_true', true], ['int_ordered', true]]) {
      assert.equal((await reader.getObsFieldInfo(key)).ordered, expected, key);
      assert.equal((await reader.getObsField(key)).ordered, expected, key);
    }
  });

  await t.test('ordered true survives the reader and adapter seams', async () => {
    const { reader } = await openReader(labelTree(true));
    assert.equal((await reader.getObsFieldInfo('label')).ordered, true);
    assert.equal((await reader.getObsField('label')).ordered, true);
    const adapter = new BaseAnnDataAdapter(asWorkerLoader(reader));
    await adapter.initialize();
    assert.equal(adapter._obsFieldsMetadata[0].ordered, true);
    assert.equal((await adapter.getObsFieldData('label')).ordered, true);
  });
});

test('dataset metadata counts categorical fields without reading their labels', async () => {
  const { reader, fetched } = await openReader(minimalAnnData({
    nObs: 1,
    obs: { label: categorical(new Int8Array([0]), ['alpha']) },
  }), { name: 'metadata-only.zarr' });
  fetched.length = 0;
  const metadata = await reader.getDatasetMetadata();
  assert.equal(metadata.stats.n_categorical_fields, 1);
  assert.deepEqual(metadata.probes, await reader.probeMapping());
  assert.equal(Object.hasOwn(metadata, 'embeddings'), false);
  assert.deepEqual(chunksUnder(fetched, 'obs/label'), []);
});

test('observation fields of any length are read in bounded slabs, never whole', async () => {
  // A float64 field of two slabs and a little: each read stays within
  // SLAB_BYTES of decoded values, and every value lands in place.
  const rowsPerSlab = SLAB_BYTES / 8;
  const length = 2 * rowsPerSlab + 3;
  const selections = [];
  const field = {
    kind: 'array',
    path: '/obs/score',
    name: 'score',
    attrs: {},
    shape: [length],
    dtype: numericDtype('float', 8),
    chunks: null,
    async read(selection) {
      selections.push(selection.map(pair => [...pair]));
      const [[start, stop]] = selection;
      return Float64Array.from({ length: stop - start }, (_, i) => (start + i) * 0.5);
    },
  };
  const values = await readFloat32(field, 0, length, 'score');
  assert.deepEqual(selections, [[[0, rowsPerSlab]], [[rowsPerSlab, 2 * rowsPerSlab]], [[2 * rowsPerSlab, length]]]);
  assert.equal(values.length, length);
  for (const at of [0, 1, rowsPerSlab - 1, rowsPerSlab, length - 1]) assert.equal(values[at], Math.fround(at * 0.5));

  // Through the reader, a field read in several chunks reads its values.
  const { reader } = await openReader(minimalAnnData({
    nObs: 20,
    obs: { score: dense(Float64Array.from({ length: 20 }, (_, i) => i * 0.5), [20], { dtype: '<f8', chunks: [8] }) },
  }));
  assert.deepEqual(Array.from((await reader.getObsField('score')).values), Array.from({ length: 20 }, (_, i) => i * 0.5));
});

// ---------------------------------------------------------------------------
// Categories: read once, shared, bounded.
// ---------------------------------------------------------------------------

/** A dataset whose `label` column has categories in one of three layouts. */
function categoryLayoutTree(kind) {
  const categories = {
    'modern-string': () => strings(['alpha', 'beta']),
    numeric: () => dense(new Int32Array([10, 20]), [2], { dtype: '<i4' }),
    'nullable-string': () => nullable('nullable-string-array', ['alpha', 'beta'], [0, 0]),
  }[kind]();
  return minimalAnnData({ nObs: 3, obs: { label: categorical(new Int8Array([0, 1, -1]), categories) } });
}

/** Open with no decoded-chunk cache, so every read of an array fetches it. */
async function openCountingCategories(kind, options = {}) {
  const opened = await openReader(categoryLayoutTree(kind), { decodedChunkCacheBytes: 0, ...options });
  opened.fetched.length = 0;
  return {
    ...opened,
    categoryReads: () => chunksUnder(opened.fetched, 'obs/label/categories').length,
    codeReads: () => chunksUnder(opened.fetched, 'obs/label/codes').length,
  };
}

test('the adapter reuses retained categories after the reader cache is cleared', async () => {
  const scenario = await openCountingCategories('modern-string');
  const adapter = new BaseAnnDataAdapter(asWorkerLoader(scenario.reader));
  await adapter.initialize();
  // Opening reads no category dictionary; the field's first load does.
  assert.equal(scenario.categoryReads(), 0);
  assert.equal(adapter._obsFieldsMetadata[0].categories, null);
  await adapter.getObsFieldData('label');
  const canonicalCategories = adapter._obsFieldsMetadata[0].categories;
  assert.equal(scenario.categoryReads(), 1);

  adapter.clearCaches();
  scenario.reader.clearCache();
  const field = await adapter.getObsFieldData('label');

  assert.strictEqual(field.categories, canonicalCategories);
  assert.equal(scenario.categoryReads(), 1);
  assert.equal(scenario.reader._cache.has('obs:label'), false);
  assert.equal(scenario.reader._cache.has('obs_info:label'), false);
  assert.equal(scenario.reader._cache.has('obs_categories:label'), false);
});

for (const layout of ['modern-string', 'numeric', 'nullable-string']) {
  test(`${layout} categories read for field info are reused by identity and frozen`, async () => {
    const scenario = await openCountingCategories(layout);
    // A nullable category array is two arrays: values and mask.
    const expectedCategoryReads = layout === 'nullable-string' ? 2 : 1;
    const info = await scenario.reader.getObsFieldInfo('label');
    const field = await scenario.reader.getObsField('label');
    assert.equal(scenario.categoryReads(), expectedCategoryReads, 'getObsField must not read labels getObsFieldInfo cached');
    assert.equal(scenario.codeReads(), 1);
    assert.strictEqual(field.categories, info.categories);
    assert.equal(Object.isFrozen(info.categories), true);
    assert.throws(() => {
      info.categories[0] = 'mutated';
    }, TypeError);
  });

  test(`${layout} categories of a field read twice are read once`, async () => {
    const scenario = await openCountingCategories(layout);
    const expectedCategoryReads = layout === 'nullable-string' ? 2 : 1;
    const first = await scenario.reader.getObsField('label');
    const second = await scenario.reader.getObsField('label');
    assert.equal(scenario.categoryReads(), expectedCategoryReads);
    assert.equal(scenario.codeReads(), 1);
    assert.strictEqual(first, second);
    assert.equal(Object.isFrozen(first.categories), true);
  });
}

test('category metadata invalidated while it is read leaves a later caller independent', async () => {
  let reader = null;
  let categoryFetches = 0;
  ({ reader } = await openReader(categoryLayoutTree('modern-string'), {
    decodedChunkCacheBytes: 0,
    onChunk: key => {
      if (key.startsWith('obs/label/categories/')) {
        categoryFetches++;
        if (categoryFetches === 1) reader.clearCache();
      }
    },
  }));
  await assert.rejects(reader.getObsFieldInfo('label'), INVALIDATED_REQUEST);
  assert.equal(reader._cache.size, 0);

  const info = await reader.getObsFieldInfo('label');
  const field = await reader.getObsField('label');
  assert.equal(categoryFetches, 2);
  assert.strictEqual(field.categories, info.categories);
  assert.equal(Object.isFrozen(info.categories), true);
});

test('a category count beyond the ceiling is refused from metadata before any label is read', async t => {
  const tooMany = 4_294_967_296;
  for (const [name, categories] of [
    ['direct', strings([], { shape: [tooMany], chunks: [1 << 20], writeChunks: false })],
    ['nullable', (() => {
      const node = nullable('nullable-string-array', [], []);
      node.children.values = strings([], { shape: [tooMany], chunks: [1 << 20], writeChunks: false });
      node.children.mask = array([], { dtype: '|b1', shape: [tooMany], chunks: [1 << 20], writeChunks: false });
      return node;
    })()],
  ]) {
    await t.test(name, async () => {
      const { store, fetched } = countingStore(minimalAnnData({ nObs: 1, obs: { label: categorical(new Int8Array([0]), categories) } }));
      await assert.rejects(
        new AnnDataReader().open(await openZarr(store), { format: ZARR_FORMAT, name: 'x.zarr' }),
        /4,294,967,296 categories.*at most 4,294,967,295.*reduce or merge/i
      );
      assert.deepEqual(chunksUnder(fetched, 'obs/label'), []);
    });
  }
});

test('65,535 categories are read, direct or nullable', async () => {
  const direct = await openReader(minimalAnnData({
    nObs: 1,
    obs: { label: categorical(new Int8Array([0]), dense(Int32Array.from({ length: 65_535 }, (_, i) => i), [65_535], { dtype: '<i4' })) },
  }));
  assert.equal((await direct.reader.getObsFieldInfo('label')).categories.length, 65_535);

  const nullableCategories = nullable(
    'nullable-string-array',
    Array.from({ length: 65_535 }, (_, i) => `category-${i}`),
    new Uint8Array(65_535)
  );
  const withNullable = await openReader(minimalAnnData({ nObs: 1, obs: { label: categorical(new Int8Array([0]), nullableCategories) } }));
  assert.equal((await withNullable.reader.getObsFieldInfo('label')).categories.length, 65_535);
});

test('numeric and boolean categorical labels are kept as they are', async t => {
  await t.test('numeric labels', async () => {
    const { reader } = await openReader(minimalAnnData({
      nObs: 2,
      obs: { label: categorical(new Int8Array([0, 1]), dense(new BigInt64Array([10n, 20n]), [2], { dtype: '<i8' })) },
    }));
    const field = await reader.getObsField('label');
    assert.deepEqual(field.categories, [10, 20]);
    assert.deepEqual(field.values, [10, 20]);
  });

  await t.test('boolean labels', async () => {
    const { reader } = await openReader(minimalAnnData({
      nObs: 2,
      obs: { label: categorical(new Int8Array([1, 0]), array([false, true], { dtype: '|b1' })) },
    }));
    const field = await reader.getObsField('label');
    assert.deepEqual(field.categories, [false, true]);
    assert.deepEqual(field.values, [true, false]);
  });
});

test('duplicate categorical labels are refused under exact primitive semantics', async t => {
  for (const [name, categories] of [
    ['string', strings(['same', 'same'])],
    ['number', dense(new Float32Array([7, 7]), [2])],
    ['boolean', array([false, false], { dtype: '|b1' })],
  ]) {
    await t.test(name, async () => {
      const { reader } = await openReader(minimalAnnData({ nObs: 1, obs: { label: categorical(new Int8Array([0]), categories) } }));
      await assert.rejects(reader.getObsFieldInfo('label'), /categorical categories.*label.*duplicate.*label/i);
      assert.equal(reader._cache.has('obs_categories:label'), false);
      assert.equal(reader._cache.has('obs_info:label'), false);
    });
  }
});

test('missing categorical labels and out-of-bounds codes are refused', async t => {
  await t.test('nullable category labels cannot be missing', async () => {
    const categories = nullable('nullable-string-array', ['alpha', 'sentinel'], [0, 1]);
    const { reader } = await openReader(minimalAnnData({ nObs: 2, obs: { label: categorical(new Int8Array([0, 0]), categories) } }));
    await assert.rejects(reader.getObsField('label'), /categories.*missing labels/i);
  });

  await t.test('categorical codes must stay within missing-or-label bounds', async () => {
    const { reader } = await openReader(minimalAnnData({ nObs: 2, obs: { label: categorical(new Int8Array([0, 2]), ['alpha', 'beta']) } }));
    await assert.rejects(reader.getObsField('label'), /categorical code.*bounds/i);
  });

  await t.test('categorical codes must use a signed integer dtype', async () => {
    for (const codesDtype of ['|u1', '|b1']) {
      const label = categorical([0, 1], ['alpha', 'beta'], { codesDtype });
      await assert.rejects(
        openReader(minimalAnnData({ nObs: 2, obs: { label } })),
        /categorical codes.*signed integer dtype/i,
        codesDtype
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The neighbour graph (obsp).
// ---------------------------------------------------------------------------

/** A dataset of `nObs` cells whose obsp holds `connectivities`. */
function connectivityTree(connectivities, nObs) {
  return minimalAnnData({ nObs, extra: { obsp: mapping({ connectivities }) } });
}

test('a neighbour graph requires the exact obsp mapping identity', async t => {
  for (const [name, mutate, expected] of [
    ['missing identity', tree => {
      tree.children.obsp.attrs = {};
    }, /obsp.*encoding-type.*dict|obsp.*mapping/i],
    ['wrong type', tree => {
      tree.children.obsp.attrs['encoding-type'] = 'mapping';
    }, /obsp.*encoding-type.*dict/i],
    ['wrong version', tree => {
      tree.children.obsp.attrs['encoding-version'] = '9.9.9';
    }, /obsp.*encoding-version.*0\.1\.0/i],
    ['an array instead of a group', tree => {
      tree.children.obsp = dense(new Float32Array([0]), [1]);
    }, /obsp.*mapping group/i],
  ]) {
    await t.test(name, async () => {
      const tree = connectivityTree(sparse({ shape: [1, 1] }), 1);
      mutate(tree);
      const { reader } = await openReader(tree);
      await assert.rejects(reader.hasConnectivities('connectivities'), expected);
    });
  }
});

test('a sparse neighbour graph is found from metadata without reading it', async () => {
  const { reader, fetched } = await openReader(connectivityTree(sparse({
    data: new Float32Array([1, 1]),
    indices: new Int32Array([1, 0]),
    indptr: new Int32Array([0, 1, 2]),
    shape: [2, 2],
  }), 2));
  fetched.length = 0;
  assert.equal(await reader.hasConnectivities('connectivities'), true);
  assert.deepEqual(fetched, []);
});

test('a dense neighbour graph is read', async () => {
  const { reader } = await openReader(connectivityTree(dense(new Float32Array([0, 1, 0, 1, 0, 1, 0, 1, 0]), [3, 3]), 3));
  assert.equal(await reader.hasConnectivities('connectivities'), true);
  const result = await reader.getConnectivities('connectivities');
  assert.equal(result.format, 'dense');
  assert.deepEqual(result.shape, [3, 3]);
  assert.deepEqual(Array.from(result.data), [0, 1, 0, 1, 0, 1, 0, 1, 0]);
});

test('neighbour weights stay exact through graph extraction', async t => {
  const weighted = 1 + (2 ** -30);

  await t.test('dense Float64', async () => {
    const { reader } = await openReader(connectivityTree(dense(Float64Array.from([0, weighted, weighted, 0]), [2, 2], { dtype: '<f8' }), 2));
    const result = await reader.getConnectivities('connectivities');
    assert.equal(result.data instanceof Float64Array, true);
    assert.equal(result.data[1], weighted);
    assert.deepEqual(edgeWeightsOf(extractConnectivityEdges(result, 2)), edgeWeightsFrom([weighted]));
  });

  await t.test('sparse Float64', async () => {
    const { reader } = await openReader(connectivityTree(sparse({
      data: Float64Array.from([weighted, weighted]),
      dataDtype: '<f8',
      indices: Int32Array.from([1, 0]),
      indptr: Int32Array.from([0, 1, 2]),
      shape: [2, 2],
    }), 2));
    const result = await reader.getConnectivities('connectivities');
    assert.equal(result.data instanceof Float64Array, true);
    assert.equal(result.data[0], weighted);
    assert.deepEqual(edgeWeightsOf(extractConnectivityEdges(result, 2)), edgeWeightsFrom([weighted]));
  });
});

test('the raw neighbour matrix is not kept once it is read', async () => {
  const { reader } = await openReader(connectivityTree(dense(new Float32Array([0, 1, 1, 0]), [2, 2]), 2));
  const first = await reader.getConnectivities('connectivities');
  assert.equal(first.format, 'dense');
  for (const [key, value] of reader._cache) {
    assert.notStrictEqual(value, first, `cache entry "${key}" retains the raw matrix`);
  }
});

// ---------------------------------------------------------------------------
// Opening, superseding and closing.
// ---------------------------------------------------------------------------

test('an open superseded before it finishes rejects as superseded', async () => {
  const gate = deferred();
  const { store } = countingStore(minimalAnnData({ nObs: 2 }), {
    onChunk: () => gate.promise,
  });
  const root = await openZarr(store);
  const reader = new AnnDataReader();
  const opening = reader.open(root, { format: ZARR_FORMAT, name: 'superseded.zarr' });
  reader.close();
  gate.resolve();
  await assert.rejects(opening, error => {
    assert.equal(
      isDatasetReloadSupersededError(error),
      true,
      `expected the superseded error itself, received ${error?.name}: ${error?.message}`
    );
    assert.equal(error instanceof AggregateError, false);
    return true;
  });
  assert.equal(reader.isOpen, false);
});

test('a superseded failure is never folded into a cleanup aggregate', () => {
  const superseded = createDatasetReloadSupersededError('Request superseded.');
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    assert.strictEqual(
      combineDatasetLifecycleFailures(superseded, new Error('cleanup failed'), 'Opening and cleanup both failed.'),
      superseded
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(logged.length, 1);
  assert.match(String(logged[0][1]?.message), /cleanup failed/);

  const ordinary = combineDatasetLifecycleFailures(
    new Error('open failed'),
    new Error('cleanup failed'),
    'Opening and cleanup both failed.'
  );
  assert.ok(ordinary instanceof AggregateError);
});

test('the reader publishes no notifications, and a newer open supersedes an older one', async t => {
  const events = captureDownloadNotifications(t);
  const direct = await openReader(minimalAnnData({ nObs: 1 }), { name: 'direct.zarr' });
  assert.equal(direct.reader.isOpen, true);
  assert.deepEqual(events, [], 'the reader runs in a worker; the data source owns notifications');

  const olderGate = deferred();
  const older = countingStore(minimalAnnData({ nObs: 1 }), { name: 'older.zarr', onChunk: () => olderGate.promise });
  const newer = countingStore(minimalAnnData({ nObs: 2 }), { name: 'newer.zarr' });
  const reader = new AnnDataReader();
  const olderOpen = reader.open(await openZarr(older.store), { format: ZARR_FORMAT, name: 'older.zarr' });
  await reader.open(await openZarr(newer.store), { format: ZARR_FORMAT, name: 'newer.zarr' });
  olderGate.resolve();
  await assert.rejects(olderOpen, /superseded/i);
  assert.equal(reader._name, 'newer.zarr');
  assert.equal(reader.nObs, 2);
  assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------
// The H5AD data source over the reader client: adoption, failure, latest wins.
// ---------------------------------------------------------------------------

function sourceMetadata() {
  return {
    obs_fields: [],
    probes: {
      nObs: 2,
      nVars: 0,
      obsm: [{ key: 'X_umap_2d', storage: 'dense', shape: [2, 2], dtype: 'float32', numeric: true, nnz: null }],
      obsp: [],
      varColumns: [],
      X: null,
      layers: [],
      raw: null,
      log1p: null,
    },
    stats: {
      has_connectivity: false,
      n_categorical_fields: 0,
      n_cells: 2,
      n_continuous_fields: 0,
      n_genes: 0,
      n_obs_fields: 0,
    },
  };
}

/** A reader open on a two-cell dataset, for calls the client forwards. */
async function readerEngine(name) {
  const { reader } = await openReader(minimalAnnData({ nObs: 2, X: null }), { name });
  return reader;
}

/**
 * Stand the client's worker open in for the given files: each opens a
 * reader on a two-cell dataset in-process; `fail` refuses it, `corruptEmbedding`
 * fails its embedding read, and a pending gate holds the open.
 */
function fakeClientOpen({ pendingByName = new Map(), records = new Map() } = {}) {
  return async function fakeOpen({ file }) {
    const record = { closeCalls: 0, loader: this, name: file.name };
    records.set(file.name, record);
    const close = this.close.bind(this);
    this.close = () => {
      if (!this._closed) record.closeCalls++;
      close();
    };
    this._snapshot = {
      nObs: 2,
      nVars: 0,
      obsKeys: [],
      hasExpressionMatrix: false,
      isOpen: true,
    };
    const engine = await readerEngine(file.name);
    this._call = async (method, ...args) => engine[method](...args);
    this.getDatasetMetadata = async () => sourceMetadata();
    this.readObsmColumns = async (key, columns) => {
      assert.equal(key, 'X_umap_2d');
      assert.deepEqual(columns, [0, 1]);
      if (file.corruptEmbedding) throw new Error(`corrupt embedding payload in ${file.name}`);
      return new Float64Array([0, 0, 1, 1]);
    };
    withObsmPayloads(this);
    if (file.fail) throw new Error(`invalid ${file.name}`);
    const pending = pendingByName.get(file.name);
    if (pending) await pending.promise;
    return { name: file.name, format: 'h5ad', layout: 'file', zarrVersion: null };
  };
}

async function withFakeH5adOpen(run) {
  const originalOpen = AnnDataReaderClient.prototype.open;
  const pendingByName = new Map();
  const records = new Map();
  AnnDataReaderClient.prototype.open = fakeClientOpen({ pendingByName, records });
  try {
    await run({ pendingByName, records });
  } finally {
    AnnDataReaderClient.prototype.open = originalOpen;
  }
}

test('AnnDataFileSource keeps a working dataset when a replacement fails', async () => {
  await withFakeH5adOpen(async () => {
    const source = new AnnDataFileSource();
    await source.loadFile({ name: 'working.h5ad' });
    const originalAdapter = source.getAdapter();
    await assert.rejects(source.loadFile({ fail: true, name: 'broken.h5ad' }), /invalid broken/i);
    assert.equal(source.datasetId, 'h5ad_working');
    assert.equal(source.getAdapter(), originalAdapter);
    assert.equal(await source.isAvailable(), true);
    source.clear();
  });
});

test('AnnDataFileSource keeps a working dataset when a replacement\'s embedding bytes are corrupt', async () => {
  await withFakeH5adOpen(async () => {
    const source = new AnnDataFileSource();
    await source.loadFile({ name: 'working.h5ad' });
    const workingAdapter = source.getAdapter();
    await assert.rejects(
      source.loadFile({ corruptEmbedding: true, name: 'corrupt-embedding.h5ad' }),
      /corrupt embedding payload/i
    );
    assert.equal(source.datasetId, 'h5ad_working');
    assert.equal(source.getAdapter(), workingAdapter);
    assert.equal(await source.isAvailable(), true);
    assert.deepEqual(Array.from((await source.getAdapter().getEmbeddingPayload('obsm/0/0-1', 2)).positions), [-1, -1, 1, 1]);
    source.clear();
  });
});

test('AnnDataFileSource makes overlapping selections latest-wins', async () => {
  await withFakeH5adOpen(async ({ pendingByName, records }) => {
    const oldPending = deferred();
    pendingByName.set('older.h5ad', oldPending);
    const source = new AnnDataFileSource();
    const older = source.loadFile({ name: 'older.h5ad' });
    await Promise.resolve();
    const newer = await source.loadFile({ name: 'newer.h5ad' });
    oldPending.resolve();
    await assert.rejects(older, /superseded/i);
    assert.equal(newer.id, 'h5ad_newer');
    assert.equal(source.datasetId, 'h5ad_newer');
    assert.equal(source.filename, 'newer.h5ad');
    assert.equal(records.get('older.h5ad').closeCalls, 1);
    assert.equal(records.get('newer.h5ad').closeCalls, 0);
    source.clear();
  });
});

test('a superseded H5AD candidate leaves the opening to the newer one, which ends it opened', async t => {
  const states = [];
  t.after(getOpeningProgress().subscribe(snapshot => {
    if (snapshot !== null) states.push(`${snapshot.id}:${snapshot.state}`);
  }));
  const originalOpen = AnnDataReaderClient.prototype.open;
  const olderGate = deferred();
  t.after(() => {
    AnnDataReaderClient.prototype.open = originalOpen;
  });
  AnnDataReaderClient.prototype.open = fakeClientOpen({ pendingByName: new Map([['older.h5ad', olderGate]]) });

  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  const older = source.loadFile({ name: 'older.h5ad' });
  await Promise.resolve();
  const newer = await source.loadFile({ name: 'newer.h5ad' });
  olderGate.resolve();

  await assert.rejects(older, /superseded/i);
  assert.equal(newer.id, 'h5ad_newer');
  // One opening on screen for both, ended once, opened.
  assert.equal(new Set(states.map(state => state.split(':')[0])).size, 1);
  assert.equal(states.filter(state => !state.endsWith(':running')).length, 1);
  assert.match(states.at(-1), /:done$/);
});

test('AnnDataFileSource has one reader owner and closes it once', async () => {
  await withFakeH5adOpen(async () => {
    const source = new AnnDataFileSource();
    await source.loadFile({ name: 'owned.h5ad' });
    const loader = source._loader;
    const originalClose = loader.close.bind(loader);
    let closeCalls = 0;
    loader.close = () => {
      closeCalls++;
      return originalClose();
    };
    source.clear();
    assert.equal(closeCalls, 1);
  });
});
