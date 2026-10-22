import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import * as h5adSourceModule from '../assets/js/data/h5ad.js';
import * as h5adLoaderModule from '../assets/js/data/h5ad-loader.js';
import { BytesRangeSource } from '../assets/js/data/range-source.js';
import { AnnDataReaderClient } from '../assets/js/data/anndata-reader-client.js';
import {
  combineDatasetLifecycleFailures,
  createDatasetReloadSupersededError,
  isDatasetReloadSupersededError,
} from '../assets/js/data/dataset-lifecycle-errors.js';
import {
  extractConnectivityEdges,
} from '../assets/js/data/sparse-utils.js';
import {
  EmbeddingLoadError,
  describeAnnDataProbes,
} from '../assets/js/data/data-mapping-candidates.js';

const h5adModule = { ...h5adSourceModule, ...h5adLoaderModule };
const {
  H5adDataSource,
  H5adLoader,
} = h5adModule;

const INVALIDATED_REQUEST =
  /(dataset|cache|request).*(changed|cleared|closed|invalidated|superseded)|superseded/i;

function attribute(value) {
  return { value };
}

function h5BooleanAttribute(value) {
  return {
    dtype: 'unknown',
    shape: [],
    metadata: {
      signed: true,
      type: 8,
      enum_type: {
        type: 0,
        nmembers: 2,
        members: {
          FALSE: 0,
          TRUE: 1,
        },
      },
      vlen: false,
      littleEndian: true,
      size: 1,
      total_size: 1,
      shape: [],
      maxshape: [],
      chunks: null,
    },
    value: value ? 1 : 0,
  };
}

function inheritedAttribute(value) {
  const prototype = {};
  Object.defineProperty(prototype, 'value', {
    get() {
      return value;
    },
  });
  return Object.create(prototype);
}

function currentDatasetAttrs(dtype, overrides = {}) {
  const encodingType =
    dtype === 'O' ||
    (typeof dtype === 'string' && /^[|<>=]?[SU]/.test(dtype))
      ? 'string-array'
      : 'array';
  return {
    'encoding-type': encodingType,
    'encoding-version': '0.2.0',
    ...overrides,
  };
}

function dataset(value, {
  attrs = null,
  dtype = '<f4',
  metadata = null,
  shape = [value.length],
  type = 'Dataset',
  valueGetter = null,
} = {}) {
  const isStringDtype =
    dtype === 'O' ||
    (typeof dtype === 'string' && /^[|<>=]?[SU]/.test(dtype));
  const result = {
    dtype,
    metadata: metadata ?? (
      isStringDtype
        ? {
            cset: 1,
            size: 4,
            vlen: true,
          }
        : {
            size: ArrayBuffer.isView(value) ? value.BYTES_PER_ELEMENT : 8,
          }
    ),
    shape,
    type,
    attrs: Object.fromEntries(
      Object.entries(
        attrs ?? currentDatasetAttrs(dtype)
      ).map(([key, attrValue]) => [key, attribute(attrValue)])
    ),
  };
  const read = valueGetter ?? (() => value);
  Object.defineProperty(result, 'value', {
    configurable: true,
    enumerable: true,
    get: read,
  });
  // h5wasm's hyperslab read: row-major, one [start, stop) range per axis.
  result.slice = ranges => {
    const all = read();
    if (shape.length <= 1) {
      const [start, stop] = ranges[0];
      return all.slice(start, stop);
    }
    const [[rowStart, rowStop], [colStart, colStop] = [0, shape[1]]] = ranges;
    const width = colStop - colStart;
    const out = ArrayBuffer.isView(all)
      ? new all.constructor((rowStop - rowStart) * width)
      : new Array((rowStop - rowStart) * width);
    for (let row = rowStart; row < rowStop; row++) {
      for (let col = colStart; col < colStop; col++) {
        out[(row - rowStart) * width + col - colStart] = all[row * shape[1] + col];
      }
    }
    return out;
  };
  return result;
}

function group(children, attrs = {}) {
  const entries = new Map(Object.entries(children));
  return {
    attrs: Object.fromEntries(
      Object.entries(attrs).map(([key, value]) => [
        key,
        key === 'ordered' && typeof value === 'boolean'
          ? h5BooleanAttribute(value)
          : attribute(value),
      ])
    ),
    get(key) {
      return entries.get(key);
    },
    keys() {
      return [...entries.keys()];
    },
    type: 'Group',
  };
}

function currentDataFrame(children, {
  columnOrder = Object.keys(children).filter(key => key !== '_index'),
  indexKey = '_index',
} = {}) {
  return group(children, {
    'encoding-type': 'dataframe',
    'encoding-version': '0.2.0',
    _index: indexKey,
    'column-order': columnOrder,
  });
}

function currentAnnData(children) {
  return group(children, {
    'encoding-type': 'anndata',
    'encoding-version': '0.1.0',
  });
}

function currentMapping(children) {
  return group(children, {
    'encoding-type': 'dict',
    'encoding-version': '0.1.0',
  });
}

function currentStringFrame(values, {
  indexKey = '_index',
  columns = {},
} = {}) {
  return currentDataFrame({
    [indexKey]: dataset(values, { dtype: 'O' }),
    ...columns,
  }, {
    indexKey,
    columnOrder: Object.keys(columns),
  });
}

function sparseGroup({
  data = new Float32Array([1]),
  dataDtype = '<f4',
  encodingType = 'csr_matrix',
  indices = new Int32Array([0]),
  indptr = new Int32Array([0, 1]),
  shape = [1, 1],
  includeEncoding = true,
  includeShape = true,
} = {}) {
  const attrs = {
    'encoding-version': '0.1.0',
  };
  if (includeEncoding) attrs['encoding-type'] = encodingType;
  if (includeShape) attrs.shape = shape;
  return group({
    data: dataset(data, { attrs: {}, dtype: dataDtype }),
    indices: dataset(indices, { attrs: {}, dtype: '<i4' }),
    indptr: dataset(indptr, { attrs: {}, dtype: '<i4' }),
  }, attrs);
}

function loaderWithSparseX(X, {
  nObs = 1,
  nVars = 1,
  varNames = ['gene'],
} = {}) {
  const loader = new H5adLoader();
  loader._file = group({ X });
  loader._filename = 'fixture.h5ad';
  loader._nObs = nObs;
  loader._nVars = nVars;
  loader._varNames = [...varNames];
  return loader;
}

function loaderWithObs(fields, nObs) {
  const loader = new H5adLoader();
  const obs = group(fields, { 'column-order': Object.keys(fields) });
  loader._file = group({ obs });
  loader._filename = 'obs-fixture.h5ad';
  loader._nObs = nObs;
  loader._obsKeys = Object.keys(fields);
  return loader;
}

function loaderWithEmbedding(embedding, nObs, key = 'X_umap_2d') {
  const loader = new H5adLoader();
  loader._file = group({
    obsm: currentMapping({ [key]: embedding }),
    var: currentStringFrame(['gene']),
  });
  loader._filename = 'embedding.h5ad';
  loader._nObs = nObs;
  loader._nVars = 1;
  return loader;
}

/**
 * Mapping probes for a file whose obsm holds dense arrays of the given widths
 * (a width of null is a one-dimensional array).
 */
function obsmProbes(nObs, widths) {
  return {
    nObs,
    nVars: 0,
    obsm: Object.entries(widths).map(([key, width]) => ({
      key,
      storage: 'dense',
      shape: width === null ? [nObs] : [nObs, width],
      dtype: 'float32',
      numeric: true,
      nnz: null,
    })),
    obsp: [],
    varColumns: [],
    X: null,
    layers: [],
    raw: null,
  };
}

/** Distinct values per cell and column: 10 * cell + column. */
function obsmValues(nObs, columns) {
  return Float64Array.from(
    { length: nObs * columns.length },
    (_, index) => 10 * Math.floor(index / columns.length) +
      columns[index % columns.length]
  );
}

/**
 * Give a loader plottable mapping metadata: its probes list `widths`, and its
 * obsm reads return distinct values.
 */
function stubPlottableObsm(loader, nObs, widths = { X_umap_2d: 2 }) {
  const reads = [];
  loader.getDatasetMetadata = async () => ({
    stats: { n_cells: nObs, n_genes: 0 },
    probes: obsmProbes(nObs, widths),
    obs_fields: [],
  });
  loader.readObsmColumns = async (key, columns) => {
    reads.push([key, [...columns]]);
    return obsmValues(nObs, columns);
  };
  return reads;
}

/** An adapter initialized over obsm entries of the given widths. */
async function initializeOverObsm(nObs, widths) {
  const loader = {
    nObs,
    obsKeys: [],
    hasExpressionMatrix: false,
    close() {},
  };
  const reads = stubPlottableObsm(loader, nObs, widths);
  const adapter = new BaseAnnDataAdapter(loader);
  await adapter.initialize();
  return { adapter, reads };
}

/** An adapter whose obsm entries are described from the loader's probes. */
async function adapterWithDescribedObsm(loader, options = {}) {
  const adapter = new BaseAnnDataAdapter(loader, options);
  adapter._describedObsm =
    describeAnnDataProbes(await loader.probeMapping()).obsm;
  return adapter;
}

function nullableField(encodingType, values, mask, {
  valuesDtype = '<i8',
  valuesMetadata = null,
} = {}) {
  return group({
    values: dataset(values, {
      dtype: valuesDtype,
      metadata: valuesMetadata,
    }),
    mask: dataset(mask, {
      dtype: '|b1',
      metadata: {
        enum_type: { members: { FALSE: 0, TRUE: 1 } },
        size: 1,
      },
    }),
  }, {
    'encoding-type': encodingType,
    'encoding-version': '0.1.0',
  });
}

function categoricalField(codes, categories) {
  return group({
    categories,
    codes: dataset(codes, { dtype: '|i1' }),
  }, {
    'encoding-type': 'categorical',
    'encoding-version': '0.2.0',
    ordered: false,
  });
}

function countedDataset(value, options = {}) {
  let reads = 0;
  return {
    node: dataset(value, {
      ...options,
      valueGetter() {
        reads++;
        return value;
      },
    }),
    reads() {
      return reads;
    },
  };
}

function countedCategoryLayout(kind) {
  if (kind === 'modern-string') {
    const categories = countedDataset(
      ['alpha', 'beta'],
      { dtype: 'O' }
    );
    return {
      categories: categories.node,
      reads: categories.reads,
    };
  }
  if (kind === 'numeric') {
    const categories = countedDataset(
      new Int32Array([10, 20]),
      { dtype: '<i4' }
    );
    return {
      categories: categories.node,
      reads: categories.reads,
    };
  }
  if (kind === 'nullable-string') {
    const values = countedDataset(
      ['alpha', 'beta'],
      { dtype: 'O' }
    );
    const mask = countedDataset(
      new Uint8Array([0, 0]),
      {
        dtype: '|b1',
        metadata: {
          enum_type: { members: { FALSE: 0, TRUE: 1 } },
          size: 1,
        },
      }
    );
    return {
      categories: group({
        values: values.node,
        mask: mask.node,
      }, {
        'encoding-type': 'nullable-string-array',
        'encoding-version': '0.1.0',
      }),
      reads() {
        return values.reads() + mask.reads();
      },
    };
  }
  throw new Error(`Unknown category layout '${kind}'`);
}

function loaderWithCountedCategories(kind) {
  const layout = countedCategoryLayout(kind);
  const codes = countedDataset(
    new Int8Array([0, 1, -1]),
    { dtype: '|i1' }
  );
  const loader = loaderWithObs({
    label: group({
      categories: layout.categories,
      codes: codes.node,
    }, {
      'encoding-type': 'categorical',
      'encoding-version': '0.2.0',
      ordered: false,
    }),
  }, 3);
  return {
    categoryReads: layout.reads,
    codeReads: codes.reads,
    loader,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

test('H5AD direct files have no size ceiling', () => {
  // The file is read by ranges, never copied: its size alone refuses nothing.
  for (const size of [512 * 1024 * 1024 + 1, 64 * 1024 ** 3, Number.MAX_SAFE_INTEGER]) {
    assert.equal(h5adModule.validateH5adSourceSize({ name: 'big.h5ad', size }), size);
  }
  assert.equal(h5adModule.validateH5adBrowserFileSize, undefined);
});

test('H5AD rejects a source without a positive exact size before reading it', async t => {
  const cases = [
    ['missing', undefined],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['non-safe', Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const [name, size] of cases) {
    await t.test(name, async () => {
      let payloadAccesses = 0;
      const source = {
        name: `${name}.h5ad`,
        size,
        identity: {},
        readInto() {
          payloadAccesses++;
          throw new Error('readInto sentinel');
        },
      };
      const loader = new H5adLoader();
      await assert.rejects(
        loader.open(source),
        name === 'zero'
          ? /empty or does not report its size/i
          : /(range source needs an exact size|empty or does not report its size)/i
      );
      assert.equal(payloadAccesses, 0);
    });
  }
});

test('H5AD validates the standard HDF5 signature before opening h5wasm state', async t => {
  const signature = new Uint8Array([
    0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  await t.test('accepts a signature at byte zero', () => {
    assert.equal(typeof h5adModule.hasHdf5Signature, 'function');
    assert.equal(h5adModule.hasHdf5Signature(signature), true);
  });

  await t.test('accepts a standard HDF5 user-block offset', () => {
    const bytes = new Uint8Array(512 + signature.length);
    bytes.set(signature, 512);
    assert.equal(h5adModule.hasHdf5Signature(bytes), true);
  });

  await t.test('rejects unrelated bytes', () => {
    assert.equal(
      h5adModule.hasHdf5Signature(
        new TextEncoder().encode('not-an-hdf5-file')
      ),
      false
    );
  });

  await t.test('open reports an actionable format error', async () => {
    const bytes = new TextEncoder().encode('not-an-hdf5-file');
    const file = new BytesRangeSource(bytes, { name: 'corrupt.h5ad' });
    const loader = new H5adLoader();
    await assert.rejects(
      loader.open(file),
      /not a valid HDF5\/H5AD file/i
    );
  });

  await t.test('open translates a structurally unreadable HDF5 handle', async () => {
    const bytes = new Uint8Array(64);
    bytes.set(signature);
    const file = new BytesRangeSource(bytes, { name: 'truncated.h5ad' });
    const loader = new H5adLoader();
    await assert.rejects(
      loader.open(file),
      /H5AD file could not be read.*corrupted or truncated/i
    );
  });
});

test('H5AD sparse matrices require explicit standard encoding and shape metadata', async t => {
  await t.test('h5wasm prototype-backed attributes are read', async () => {
    const X = sparseGroup();
    X.attrs['encoding-type'] = inheritedAttribute('csr_matrix');
    X.attrs.shape = inheritedAttribute(new BigUint64Array([1n, 1n]));
    const loader = loaderWithSparseX(X);
    assert.deepEqual(
      Array.from(await loader.getMatrixColumn('X', 0)),
      [1]
    );
  });

  await t.test('missing encoding-type is rejected', async () => {
    const loader = loaderWithSparseX(sparseGroup({ includeEncoding: false }));
    await assert.rejects(
      loader.getMatrixColumn('X', 0),
      /encoding-type.*csr_matrix.*csc_matrix/i
    );
  });

  await t.test('unknown encoding-type is rejected', async () => {
    const loader = loaderWithSparseX(
      sparseGroup({ encodingType: 'compressed_matrix' })
    );
    await assert.rejects(
      loader.getMatrixColumn('X', 0),
      /encoding-type.*csr_matrix.*csc_matrix/i
    );
  });

  await t.test('missing shape is rejected', async () => {
    const loader = loaderWithSparseX(sparseGroup({ includeShape: false }));
    await assert.rejects(
      loader.getMatrixColumn('X', 0),
      /shape.*required/i
    );
  });
});

test('H5AD rejects unsupported primitive observation dtypes before payload access', async () => {
  let reads = 0;
  const values = new Float32Array([1, 2]);
  const unsupported = dataset(values, {
    dtype: '<c8',
    valueGetter() {
      reads++;
      return values;
    },
  });
  const loader = loaderWithObs({ unsupported }, 2);

  await assert.rejects(
    loader.getObsField('unsupported'),
    /observation field.*unsupported.*unsupported HDF5 dtype/i
  );
  assert.equal(reads, 0);
});

test('H5AD sparse matrices reject malformed structure without clamping', async t => {
  await t.test('data and indices lengths must match', async () => {
    const loader = loaderWithSparseX(sparseGroup({
      data: new Float32Array([1, 2]),
      indices: new Int32Array([0]),
    }));
    await assert.rejects(
      loader.getMatrixColumn('X', 0),
      /data and indices lengths differ/i
    );
  });

  await t.test('indptr must span a monotonic major axis', async () => {
    const loader = loaderWithSparseX(sparseGroup({
      data: new Float32Array([1, 2]),
      indices: new Int32Array([0, 0]),
      indptr: new Int32Array([0, 2, 1]),
      shape: [2, 1],
    }), { nObs: 2 });
    await assert.rejects(
      loader.getMatrixColumn('X', 0),
      /indptr.*monotonic/i
    );
  });

  await t.test('out-of-range int64 indices are rejected instead of clamped', async () => {
    const loader = loaderWithSparseX(sparseGroup({
      indices: new BigInt64Array([2147483648n]),
    }));
    await assert.rejects(
      loader.getMatrixColumn('X', 0),
      /index.*(range|outside)/i
    );
  });
});

test('CEL-AUDIT-0119 H5AD structure requires the one current AnnData dataframe contract transactionally', async t => {
  const validRoot = () => currentAnnData({
    X: dataset(new Float32Array([1]), {
      dtype: '<f4',
      shape: [1, 1],
    }),
    obs: currentStringFrame(['cell']),
    var: currentStringFrame(['gene']),
    obsm: currentMapping({
      X_umap_2d: dataset(new Float32Array([0, 0]), {
        dtype: '<f4',
        shape: [1, 2],
      }),
    }),
  });

  await t.test('accepts exact current root and dataframe identities', async () => {
    const loader = new H5adLoader();
    loader._file = validRoot();

    await loader._readStructure();

    assert.equal(loader.nObs, 1);
    assert.equal(loader.nVars, 1);
    assert.deepEqual(loader.varNames, ['gene']);
  });

  await t.test(
    'rejects an unversioned primitive dataframe index',
    async () => {
      const loader = new H5adLoader();
      const root = validRoot();
      const index = root.get('obs').get('_index');
      index.attrs = {
        'encoding-type': attribute('string-array'),
      };
      loader._file = root;

      await assert.rejects(
        loader._readStructure(),
        /observation index.*encoding-version.*0\.2\.0/i
      );
    }
  );

  await t.test('accepts h5wasm empty typed column-order attributes', async () => {
    const loader = new H5adLoader();
    const root = validRoot();
    root.get('var').attrs['column-order'] =
      attribute(new Float64Array(0));
    loader._file = root;

    await loader._readStructure();

    assert.equal(loader.nVars, 1);
    assert.deepEqual(loader.varNames, ['gene']);
  });

  const invalidCases = [
    [
      'wrong root encoding-type',
      root => {
        root.attrs['encoding-type'] = attribute('not-anndata');
      },
      /root.*encoding-type.*anndata/i,
    ],
    [
      'wrong root encoding-version',
      root => {
        root.attrs['encoding-version'] = attribute('9.9.9');
      },
      /root.*encoding-version.*0\.1\.0/i,
    ],
    [
      'missing obs dataframe',
      root => root.keys = () => ['X', 'var', 'obsm'],
      /obs.*required.*dataframe/i,
    ],
    [
      'missing var dataframe',
      root => root.keys = () => ['X', 'obs', 'obsm'],
      /var.*required.*dataframe/i,
    ],
    [
      'wrong obs dataframe encoding',
      root => {
        root.get('obs').attrs['encoding-type'] = attribute('mapping');
      },
      /obs.*encoding-type.*dataframe/i,
    ],
    [
      'wrong var dataframe version',
      root => {
        root.get('var').attrs['encoding-version'] = attribute('0.1.0');
      },
      /var.*encoding-version.*0\.2\.0/i,
    ],
    [
      'missing obsm mapping identity',
      root => {
        root.get('obsm').attrs = {};
      },
      /obsm.*encoding-type.*dict|obsm.*mapping/i,
    ],
    [
      'wrong obsm mapping version',
      root => {
        root.get('obsm').attrs['encoding-version'] =
          attribute('9.9.9');
      },
      /obsm.*encoding-version.*0\.1\.0/i,
    ],
    [
      'missing index attribute',
      root => {
        delete root.get('obs').attrs._index;
      },
      /obs.*_index.*non-empty string/i,
    ],
    [
      'empty index attribute',
      root => {
        root.get('obs').attrs._index = attribute('');
      },
      /obs.*_index.*non-empty string/i,
    ],
    [
      'untyped index attribute',
      root => {
        root.get('obs').attrs._index = attribute(['_index']);
      },
      /obs.*_index.*non-empty string/i,
    ],
    [
      'string column-order instead of a typed sequence',
      root => {
        root.get('obs').attrs['column-order'] = attribute('label');
      },
      /obs.*column-order.*array.*strings/i,
    ],
    [
      'duplicate column-order entry',
      root => {
        const obs = currentDataFrame({
          _index: dataset(['cell'], { dtype: 'O' }),
          label: dataset(['A'], { dtype: 'O' }),
        }, { columnOrder: ['label', 'label'] });
        const originalGet = root.get.bind(root);
        root.get = key => key === 'obs' ? obs : originalGet(key);
      },
      /obs.*column-order.*duplicate.*label/i,
    ],
    [
      'non-string column-order entry',
      root => {
        root.get('obs').attrs['column-order'] =
          attribute(['label', 7]);
      },
      /obs.*column-order.*strings/i,
    ],
    [
      'missing declared child',
      root => {
        root.get('obs').attrs['column-order'] = attribute(['missing']);
      },
      /obs.*declared column.*missing.*not found/i,
    ],
    [
      'missing index child',
      root => {
        root.get('obs').attrs._index = attribute('missing_index');
      },
      /obs.*index.*missing_index.*not found/i,
    ],
    [
      'unsupported __categories dataframe layout',
      root => {
        const obs = currentDataFrame({
          _index: dataset(['cell'], { dtype: 'O' }),
          label: dataset(new Int8Array([0]), { dtype: '|i1' }),
          __categories: group({
            label: dataset(['A'], { dtype: 'O' }),
          }),
        }, { columnOrder: ['label'] });
        const originalGet = root.get.bind(root);
        root.get = key => key === 'obs' ? obs : originalGet(key);
      },
      /unsupported dataframe 0\.1.*__categories/i,
    ],
  ];

  for (const [name, mutate, pattern] of invalidCases) {
    await t.test(name, async () => {
      const loader = new H5adLoader();
      const root = validRoot();
      mutate(root);
      loader._file = root;
      await assert.rejects(loader._readStructure(), pattern);
    });
  }

  await t.test('late axis failure does not publish partial candidate state', async () => {
    const loader = new H5adLoader();
    loader._nObs = 17;
    loader._nVars = 23;
    loader._obsKeys = ['old_obs'];
    loader._varNames = ['old_gene'];
    loader._file = currentAnnData({
      X: dataset(new Float32Array([1]), {
        dtype: '<f4',
        shape: [1, 1],
      }),
      obs: currentStringFrame(['cell']),
      var: currentStringFrame(['gene-a', 'gene-b']),
    });

    await assert.rejects(
      loader._readStructure(),
      /variable index.*length 2.*match 1|1 genes.*2/i
    );

    assert.equal(loader.nObs, 17);
    assert.equal(loader.nVars, 23);
    assert.deepEqual(loader.obsKeys, ['old_obs']);
    assert.deepEqual(loader.varNames, ['old_gene']);
  });
});

test('H5AD opening enforces X axes and keeps variable names as stored', async t => {
  function frame(indexValues) {
    return currentDataFrame({
      index: dataset(indexValues, { dtype: 'O' }),
    }, { indexKey: 'index', columnOrder: [] });
  }

  function nullableStringFrame(
    indexValues,
    mask = new Uint8Array(indexValues.length),
    valuesDtype = 'O'
  ) {
    return currentDataFrame({
      _index: nullableField(
        'nullable-string-array',
        indexValues,
        mask,
        { valuesDtype }
      ),
    }, { indexKey: '_index', columnOrder: [] });
  }

  function emptySparse(shape) {
    const pointerLength = shape[0] + 1;
    return sparseGroup({
      data: new Float32Array(0),
      indices: new Int32Array(0),
      indptr: new Int32Array(pointerLength),
      shape,
    });
  }

  await t.test('observation axis mismatch is rejected', async () => {
    const loader = new H5adLoader();
    loader._file = currentAnnData({
      X: emptySparse([2, 1]),
      obs: frame(['only-one']),
      var: frame(['gene']),
    });
    await assert.rejects(
      loader._readStructure(),
      /X.*observation|observation.*X|2 cells.*1/i
    );
  });

  await t.test('zero-cell X remains a known axis and cannot be overwritten', async () => {
    const loader = new H5adLoader();
    loader._file = currentAnnData({
      X: emptySparse([0, 1]),
      obs: frame(['unexpected']),
      var: frame(['gene']),
    });
    await assert.rejects(
      loader._readStructure(),
      /X.*observation|observation.*X|0 cells.*1/i
    );
  });

  await t.test('variable axis mismatch is rejected', async () => {
    const loader = new H5adLoader();
    loader._file = currentAnnData({
      X: emptySparse([1, 1]),
      obs: frame(['cell']),
      var: frame(['gene-a', 'gene-b']),
    });
    await assert.rejects(
      loader._readStructure(),
      /X.*variable|variable.*X|1 genes.*2/i
    );
  });

  await t.test('duplicate variable names open and are kept as stored', async () => {
    // The loader does not refuse a repeated var name: the adapter makes the
    // gene list unique with the data-mapping rule (`makeUniqueNames`).
    const loader = new H5adLoader();
    loader._file = currentAnnData({
      X: emptySparse([1, 2]),
      obs: frame(['cell']),
      var: frame(['duplicate', 'duplicate']),
    });
    await loader._readStructure();
    assert.equal(loader.nVars, 2);
    assert.deepEqual(loader.varNames, ['duplicate', 'duplicate']);
    const names = await loader.readVarNames('X', null);
    assert.deepEqual([...names.index], ['duplicate', 'duplicate']);
    assert.deepEqual([...names.values], ['duplicate', 'duplicate']);
  });

  await t.test(
    'official nullable-string observation and variable indices are accepted',
    async () => {
      const loader = new H5adLoader();
      loader._file = currentAnnData({
        X: emptySparse([2, 2]),
        obs: nullableStringFrame(['cell-a', 'cell-b']),
        var: nullableStringFrame(['gene-a', 'gene-b']),
      });

      await loader._readStructure();

      assert.equal(loader.nObs, 2);
      assert.equal(loader.nVars, 2);
      assert.deepEqual(loader.varNames, ['gene-a', 'gene-b']);
    }
  );

  await t.test('nullable dataframe indices cannot contain missing names', async () => {
    const loader = new H5adLoader();
    loader._file = currentAnnData({
      X: emptySparse([2, 1]),
      obs: nullableStringFrame(
        ['cell-a', 'ignored'],
        new Uint8Array([0, 1])
      ),
      var: nullableStringFrame(['gene']),
    });

    await assert.rejects(
      loader._readStructure(),
      /observation index.*missing|missing.*observation index/i
    );
  });

  await t.test('nullable dataframe indices require string values', async () => {
    const loader = new H5adLoader();
    loader._file = currentAnnData({
      X: emptySparse([1, 1]),
      obs: nullableStringFrame(
        new Int32Array([1]),
        new Uint8Array([0]),
        '<i4'
      ),
      var: nullableStringFrame(['gene']),
    });

    await assert.rejects(
      loader._readStructure(),
      /observation index.*string|string.*observation index/i
    );
  });
});

test('H5AD X=None does not advertise gene-expression fields', async () => {
  assert.equal(
    loaderWithSparseX(sparseGroup()).hasExpressionMatrix,
    true
  );

  const frame = indexValues => currentDataFrame({
    index: dataset(indexValues, { dtype: 'O' }),
  }, { indexKey: 'index', columnOrder: [] });
  const loader = new H5adLoader();
  loader._file = currentAnnData({
    obs: frame(['cell-a', 'cell-b']),
    var: frame(['A', 'B']),
    obsm: currentMapping({
      X_umap_2d: dataset(
        new Float32Array([0, 0, 1, 1]),
        { dtype: '<f4', shape: [2, 2] }
      ),
    }),
  });
  loader._filename = 'x-none.h5ad';

  await loader._readStructure();

  assert.equal(loader.hasExpressionMatrix, false);
  assert.equal(loader.nVars, 2);
  assert.deepEqual(loader.varNames, ['A', 'B']);

  const adapter = new BaseAnnDataAdapter(loader);
  await adapter.initialize();
  assert.deepEqual((await adapter.getVarManifest()).fields, []);
  await assert.rejects(
    adapter.getGeneValues('var/0.values.f32'),
    /no expression matrix; gene expression is unavailable/i
  );
  await assert.rejects(
    loader.getMatrixColumn('X', 0),
    /no X expression matrix/i
  );
});

test('H5AD sparse gene columns sum duplicate coordinates', async () => {
  const loader = loaderWithSparseX(sparseGroup({
    data: new Int32Array([1, 2, 4]),
    dataDtype: '<i4',
    encodingType: 'csc_matrix',
    indices: new Int32Array([0, 0, 1]),
    indptr: new Int32Array([0, 3]),
    shape: [2, 1],
  }), { nObs: 2 });

  assert.deepEqual(
    Array.from(await loader.getMatrixColumn('X', 0)),
    [3, 4]
  );
});

// Both writers store expression as Float32 and round integers above 2^24 to
// the nearest Float32, so a file read directly reads the same values.
test('H5AD integer sparse gene values round to Float32 as the writers export them', async t => {
  await t.test('an integer above 2^24 rounds to its nearest Float32', async () => {
    const loader = loaderWithSparseX(sparseGroup({
      data: new BigInt64Array([16777217n]),
      dataDtype: '<i8',
    }));
    const values = await loader.getMatrixColumn('X', 0);
    assert.deepEqual(Array.from(values), [16_777_216]);
  });

  await t.test('a duplicate integer sum rounds to its nearest Float32', async () => {
    const loader = loaderWithSparseX(sparseGroup({
      data: new Int32Array([16777216, 1]),
      dataDtype: '<i4',
      encodingType: 'csc_matrix',
      indices: new Int32Array([0, 0]),
      indptr: new Int32Array([0, 2]),
    }));
    const values = await loader.getMatrixColumn('X', 0);
    assert.deepEqual(Array.from(values), [Math.fround(16_777_216 + 1)]);
  });
});

test('H5AD embeddings validate cell axes and reject values that cannot be plotted', async t => {
  await t.test('cell-axis mismatch is rejected by the column read', async () => {
    const loader = loaderWithEmbedding(dataset(
      new Float64Array([0, 0, 1, 1]),
      { dtype: '<f8', shape: [2, 2] }
    ), 1);
    await assert.rejects(
      loader.readObsmColumns('X_umap_2d', [0, 1]),
      /obsm\['X_umap_2d'\] has 2 rows but the dataset has 1 cells/
    );
    assert.equal(loader._cache.size, 0);
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
      const loader = loaderWithEmbedding(dataset(
        new Float64Array(values),
        { dtype: '<f8', shape: [2, 2] }
      ), 2);
      const adapter = await adapterWithDescribedObsm(loader);
      let normalizationCalls = 0;
      const normalize = adapter._normalizeEmbedding.bind(adapter);
      adapter._normalizeEmbedding = (...args) => {
        normalizationCalls++;
        return normalize(...args);
      };
      const error = await adapter
        .getEmbeddingForRef({ key: 'X_umap_2d', columns: [0, 1] })
        .then(() => null, rejection => rejection);
      assert.ok(error instanceof EmbeddingLoadError);
      assert.equal(error.key, 'X_umap_2d');
      assert.deepEqual(error.columns, [0, 1]);
      assert.equal(error.reason, reason);
      assert.equal(
        error.message,
        `Embedding 'X_umap_2d' cannot be plotted: ${reason}.`
      );
      assert.equal(normalizationCalls, 0);
      assert.equal(adapter._embeddingCache.size, 0);
      assert.equal(adapter._normInfo.size, 0);
      assert.equal(adapter._coordinateCacheBytes, 0n);
    });
  }
});

test('H5AD mapping probes describe every element from metadata, with the catalog reasons', async () => {
  const unreadable = () => {
    throw new Error('probes must not read array values');
  };
  const loader = new H5adLoader();
  loader._file = currentAnnData({
    X: dataset(new Float32Array(3), { dtype: '<f4', shape: [3, 1], valueGetter: unreadable }),
    obs: currentStringFrame(['c0', 'c1', 'c2']),
    var: currentStringFrame(['gene'], {
      columns: {
        gene_symbols: dataset(['G'], { dtype: 'O' }),
        score: dataset(new Float32Array([1]), { dtype: '<f4' }),
      },
    }),
    obsm: currentMapping({
      X_umap: dataset(new Float32Array(6), { dtype: '<f4', shape: [3, 2], valueGetter: unreadable }),
      X_sparse: sparseGroup({ shape: [3, 5] }),
      X_df: currentStringFrame(['c0', 'c1', 'c2']),
      pseudotime: dataset(new Int32Array(3), { dtype: '<i4', shape: [3], valueGetter: unreadable }),
      labels: dataset(['a', 'b', 'c'], { dtype: 'O', valueGetter: unreadable }),
      X_short: dataset(new Float64Array(4), { dtype: '<f8', shape: [2, 2], valueGetter: unreadable }),
    }),
    obsp: currentMapping({
      connectivities: sparseGroup({
        data: new Float32Array([1, 1]),
        indices: new Int32Array([1, 0]),
        indptr: new Int32Array([0, 1, 2, 2]),
        shape: [3, 3],
      }),
      distances: dataset(new Float32Array(6), { dtype: '<f4', shape: [3, 2], valueGetter: unreadable }),
    }),
    layers: currentMapping({
      counts: sparseGroup({ data: new Int32Array([1]), dataDtype: '<i4', shape: [3, 1] }),
      wide: dataset(new Float32Array(6), { dtype: '<f4', shape: [3, 2], valueGetter: unreadable }),
    }),
    raw: group({
      X: sparseGroup({ shape: [3, 4] }),
      var: currentStringFrame(['a', 'b', 'c', 'd']),
    }),
  });
  await loader._readStructure();

  const probes = await loader.probeMapping();
  assert.equal(probes.nObs, 3);
  assert.equal(probes.nVars, 1);
  const described = describeAnnDataProbes(probes);
  assert.deepEqual(
    described.obsm.map(({ key, storage, shape, dtype, usable, reason }) =>
      [key, storage, shape, dtype, usable, reason]),
    [
      ['X_umap', 'dense', [3, 2], 'float32', true, null],
      ['X_sparse', 'csr', [3, 5], 'float32', false, 'sparse obsm arrays cannot be plotted'],
      ['X_df', 'dataframe', [3, 0], 'object', false, 'obsm table, not an array'],
      ['pseudotime', 'dense', [3], 'int32', true, null],
      ['labels', 'dense', [3], 'string', false, 'not a numeric array'],
      ['X_short', 'dense', [2, 2], 'float64', false, 'has 2 rows, the dataset has 3 cells'],
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

test('H5AD obsm column reads return fresh arrays the loader does not retain', async () => {
  const loader = loaderWithEmbedding(dataset(
    new Float32Array([0, 1, 2, 3]),
    { dtype: '<f4', shape: [2, 2] }
  ), 2);
  const first = await loader.readObsmColumns('X_umap_2d', [0, 1]);
  const second = await loader.readObsmColumns('X_umap_2d', [0, 1]);
  assert.ok(first instanceof Float64Array);
  assert.deepEqual(Array.from(first), [0, 1, 2, 3]);
  assert.notStrictEqual(first, second);
  first[0] = 99;
  assert.equal(second[0], 0);
  assert.equal(loader._cache.size, 0);
});

test('H5AD obsm column reads select the narrowest hyperslabs', async t => {
  // A 3-cell x 6-column array whose value is 10 * row + column.
  const nRows = 3;
  const width = 6;
  const values = Float32Array.from(
    { length: nRows * width },
    (_, index) => 10 * Math.floor(index / width) + (index % width)
  );
  function slicingDataset() {
    const reads = [];
    const node = dataset(values, { dtype: '<f4', shape: [nRows, width] });
    const fullValue = Object.getOwnPropertyDescriptor(node, 'value').get;
    Object.defineProperty(node, 'value', {
      configurable: true,
      enumerable: true,
      get() {
        reads.push('value');
        return fullValue();
      },
    });
    node.slice = ranges => {
      const [[r0, r1], [c0, c1]] = ranges;
      reads.push(`slice ${c0}-${c1}`);
      const out = new Float32Array((r1 - r0) * (c1 - c0));
      for (let row = r0; row < r1; row++) {
        for (let column = c0; column < c1; column++) {
          out[(row - r0) * (c1 - c0) + column - c0] = values[row * width + column];
        }
      }
      return out;
    };
    return { node, reads };
  }

  for (const [name, columns, expectedReads] of [
    ['adjacent columns are one hyperslab', [0, 1, 2], ['slice 0-3']],
    ['a narrow slab is one hyperslab', [3, 2], ['slice 2-4']],
    ['a wide span is one hyperslab per column', [5, 1], ['slice 5-6', 'slice 1-2']],
  ]) {
    await t.test(name, async () => {
      const { node, reads } = slicingDataset();
      const loader = loaderWithEmbedding(node, nRows, 'X_pca');
      const result = await loader.readObsmColumns('X_pca', columns);
      assert.deepEqual(reads, expectedReads);
      const expected = [];
      for (let row = 0; row < nRows; row++) {
        for (const column of columns) expected.push(10 * row + column);
      }
      assert.deepEqual(Array.from(result), expected);
    });
  }

  await t.test('a selection spanning the whole array is one hyperslab, never a whole-array read', async () => {
    const node = dataset(Float32Array.from([0, 1, 10, 11]), {
      dtype: '<f4',
      shape: [2, 2],
    });
    Object.defineProperty(node, 'value', {
      get() {
        throw new Error('a whole-array read would stage the array in the WASM heap');
      },
    });
    const loader = loaderWithEmbedding(node, 2);
    assert.deepEqual(
      Array.from(await loader.readObsmColumns('X_umap_2d', [1, 0])),
      [1, 0, 11, 10]
    );
  });

  await t.test('a one-dimensional array is one column', async () => {
    const loader = loaderWithEmbedding(dataset(
      new Int32Array([4, 5, 6]),
      { dtype: '<i4', shape: [3] }
    ), 3, 'pseudotime');
    assert.deepEqual(
      Array.from(await loader.readObsmColumns('pseudotime', [0])),
      [4, 5, 6]
    );
  });

  await t.test('columns outside the array or repeated are refused', async () => {
    const { node } = slicingDataset();
    const loader = loaderWithEmbedding(node, nRows, 'X_pca');
    await assert.rejects(loader.readObsmColumns('X_pca', [0, 6]), /reads distinct columns between 0 and 5/);
    await assert.rejects(loader.readObsmColumns('X_pca', [1, 1]), /distinct columns/);
    await assert.rejects(loader.readObsmColumns('X_missing', [0, 1]), /obsm\['X_missing'\] does not exist/);
  });
});

test('H5AD adapter loads an embedding whose raw plus normalized peak exceeds its cache budget', async () => {
  const loader = loaderWithEmbedding(dataset(
    new Float32Array([0, 1, 2, 3]),
    { dtype: '<f4', shape: [2, 2] }
  ), 2);
  // 16 bytes hold the normalized Float32 result, not the Float64 read alive
  // while it is produced: the budget is a policy, so it still loads.
  const adapter = await adapterWithDescribedObsm(loader, {
    cacheBudgetBytes: 16
  });
  const embedding = await adapter.getEmbeddingForRef({ key: 'X_umap_2d', columns: [0, 1] });
  assert.ok(embedding instanceof Float32Array);
  assert.equal(adapter._coordinateReservedOutputBytes, 0n);
});

test('H5AD dense X validates shape and rejects finite Float64 overflow', async t => {
  function denseLoader(X, nObs = 1, nVars = 1) {
    const loader = new H5adLoader();
    loader._file = group({ X });
    loader._filename = 'dense.h5ad';
    loader._nObs = nObs;
    loader._nVars = nVars;
    loader._varNames = ['gene'];
    return loader;
  }

  await t.test('shape mismatch is rejected before caching', async () => {
    const loader = denseLoader(dataset(
      new Float64Array([1]),
      { dtype: '<f8', shape: [1, 1] }
    ), 2, 1);
    await assert.rejects(
      loader.getMatrixColumn('X', 0),
      /dense X.*shape.*2.*1/i
    );
    assert.equal(loader._matrix.element, 'X');
    assert.equal(loader._matrix.columns, null);
  });

  await t.test('finite overflow is rejected before caching', async () => {
    const loader = denseLoader(dataset(
      new Float64Array([1e308]),
      { dtype: '<f8', shape: [1, 1] }
    ));
    await assert.rejects(
      loader.getMatrixColumn('X', 0),
      /dense X.*Float32 range/i
    );
    assert.equal(loader._matrix.element, 'X');
    assert.equal(loader._matrix.columns, null);
  });
});

test('H5AD transposes a contiguous dense X once, in row slabs, and serves every gene from it', async () => {
  const nObs = 3;
  const nVars = 4;
  const values = Float32Array.from({ length: nObs * nVars }, (_, index) => index);
  const X = dataset(values, {
    dtype: '<f4',
    shape: [nObs, nVars],
    valueGetter() {
      throw new Error('a whole-matrix read would stage it in the WASM heap');
    },
  });
  const slices = [];
  const slice = X.slice;
  X.slice = ranges => {
    slices.push(ranges);
    return values.slice(ranges[0][0] * nVars, ranges[0][1] * nVars);
  };
  const loader = new H5adLoader();
  loader._file = group({ X });
  loader._filename = 'contiguous-dense.h5ad';
  loader._nObs = nObs;
  loader._nVars = nVars;
  loader._varNames = ['A', 'B', 'C', 'D'];
  for (let gene = 0; gene < nVars; gene++) {
    assert.deepEqual(
      Array.from(await loader.getMatrixColumn('X', gene)),
      [gene, gene + nVars, gene + 2 * nVars]
    );
  }
  // One row slab covers the whole matrix; no gene re-reads it.
  assert.deepEqual(slices, [[[0, 3], [0, 4]]]);
  assert.equal(typeof slice, 'function');
});

function chunkedDenseLoader({ failFirstBlockAt = null } = {}) {
  // Float32 output beyond the full-matrix cache, so genes are sliced; HDF5
  // chunks of 2 rows × 4 columns put genes 0-3 in one strip.
  const nObs = 4;
  const nVars = 20_000_000;
  const slices = [];
  const X = dataset(new Float32Array(0), {
    dtype: '<f4',
    metadata: { chunks: [2, 4], size: 4 },
    shape: [nObs, nVars],
    valueGetter() {
      throw new Error('full payload sentinel');
    },
  });
  let failurePending = failFirstBlockAt !== null;
  X.slice = ([[rowStart, rowEnd], [colStart, colEnd]]) => {
    slices.push([rowStart, rowEnd, colStart, colEnd]);
    if (failurePending && rowStart === failFirstBlockAt) {
      failurePending = false;
      throw new Error('block read failed');
    }
    const width = colEnd - colStart;
    const values = new Float32Array((rowEnd - rowStart) * width);
    for (let row = rowStart; row < rowEnd; row++) {
      for (let col = colStart; col < colEnd; col++) {
        values[(row - rowStart) * width + (col - colStart)] = row * 10 + col;
      }
    }
    return values;
  };
  const loader = new H5adLoader();
  loader._file = group({ X });
  loader._filename = 'chunked-dense.h5ad';
  loader._nObs = nObs;
  loader._nVars = nVars;
  loader._varNames = ['GeneA', 'GeneB', 'GeneC'];
  return { loader, slices };
}

test('H5AD genes of one dense chunk strip read each chunk block once', async () => {
  const { loader, slices } = chunkedDenseLoader();
  assert.deepEqual(
    Array.from(await loader.getMatrixColumn('X', 0)),
    [0, 10, 20, 30]
  );
  assert.deepEqual(
    Array.from(await loader.getMatrixColumn('X', 1)),
    [1, 11, 21, 31]
  );
  assert.deepEqual(slices, [[0, 2, 0, 4], [2, 4, 0, 4]]);
  assert.equal(loader._decodedXBlocks.retainedBytes, 2 * 2 * 4 * 4);

  // Concurrent genes of the same strip share one read per block.
  loader._decodedXBlocks.clear();
  slices.length = 0;
  const [geneA, geneC] = await Promise.all([
    loader.getMatrixColumn('X', 0),
    loader.getMatrixColumn('X', 2),
  ]);
  assert.deepEqual(Array.from(geneA), [0, 10, 20, 30]);
  assert.deepEqual(Array.from(geneC), [2, 12, 22, 32]);
  assert.deepEqual(slices, [[0, 2, 0, 4], [2, 4, 0, 4]]);

  loader.clearCache();
  assert.equal(loader._decodedXBlocks.retainedBytes, 0);
  assert.equal(loader._decodedXBlocks.size, 0);
});

test('H5AD does not retain a failed dense chunk block read', async () => {
  const { loader, slices } = chunkedDenseLoader({ failFirstBlockAt: 2 });
  await assert.rejects(loader.getMatrixColumn('X', 0), /block read failed/);
  assert.deepEqual(
    Array.from(await loader.getMatrixColumn('X', 0)),
    [0, 10, 20, 30]
  );
  assert.deepEqual(slices, [[0, 2, 0, 4], [2, 4, 0, 4], [2, 4, 0, 4]]);
});

test('H5AD chunk-block column reads match h5wasm column slices', async () => {
  const hdf5 = await import('../assets/external/hdf5_hl.js');
  await hdf5.ready;
  const path = '/chunk-block-column-contract.h5';
  const nObs = 7;
  const nVars = 5;
  const values = Float32Array.from(
    { length: nObs * nVars },
    (unused, index) => index * 0.5
  );
  const writer = new hdf5.File(path, 'w');
  writer.create_dataset({
    name: 'X',
    data: values,
    shape: [nObs, nVars],
    dtype: '<f4',
    chunks: [3, 2],
    compression: 'gzip',
    compression_opts: [4],
  });
  writer.close();
  const reader = new hdf5.File(path, 'r');
  try {
    const X = reader.get('X');
    assert.deepEqual(X.metadata.chunks, [3, 2]);
    const loader = new H5adLoader();
    for (let gene = 0; gene < nVars; gene++) {
      const column = await loader._readChunkedDenseColumn(
        X,
        [nObs, nVars],
        [3, 2],
        gene,
        loader._generation
      );
      assert.deepEqual(
        Array.from(column),
        Array.from(X.slice([[0, nObs], [gene, gene + 1]]))
      );
    }
    // Three column strips (2 + 2 + 1 columns) × three row blocks.
    assert.equal(loader._decodedXBlocks.size, 9);
  } finally {
    reader.close();
    hdf5.FS.unlink(path);
  }
});

test('H5AD reads official nullable integer and boolean observation groups', async () => {
  const loader = loaderWithObs({
    count: nullableField(
      'nullable-integer',
      new BigInt64Array([42n, 9007199254740993n]),
      new Uint8Array([0, 1])
    ),
    detected: nullableField(
      'nullable-boolean',
      new Uint8Array([1, 0]),
      new Uint8Array([0, 1]),
      {
        valuesDtype: '|b1',
        valuesMetadata: {
          enum_type: { members: { FALSE: 0, TRUE: 1 } },
          size: 1,
        },
      }
    ),
    unsigned_count: nullableField(
      'nullable-integer',
      new BigUint64Array([7n, 18446744073709551615n]),
      new Uint8Array([0, 1]),
      { valuesDtype: '<Q8' }
    ),
  }, 2);

  assert.deepEqual(await loader.getObsFieldInfo('count'), { dtype: 'int' });
  const count = await loader.getObsField('count');
  assert.equal(count.dtype, 'int');
  assert.equal(count.values[0], 42);
  assert.equal(Number.isNaN(count.values[1]), true);

  assert.deepEqual(
    await loader.getObsField('detected'),
    { dtype: 'bool', values: [true, null] }
  );

  assert.deepEqual(
    await loader.getObsFieldInfo('unsigned_count'),
    { dtype: 'uint' }
  );
  const unsignedCount = await loader.getObsField('unsigned_count');
  assert.equal(unsignedCount.dtype, 'uint');
  assert.equal(unsignedCount.values[0], 7);
  assert.equal(Number.isNaN(unsignedCount.values[1]), true);
});

test('AnnData string arrays require variable-length UTF-8 HDF5 storage', async t => {
  const invalidCases = [
    [
      'fixed-width UTF-8',
      { cset: 1, size: 8, vlen: false }
    ],
    [
      'variable-length ASCII',
      { cset: 0, size: 8, vlen: true }
    ]
  ];

  for (const [name, metadata] of invalidCases) {
    await t.test(name, async () => {
      let payloadReads = 0;
      const loader = loaderWithObs({
        label: dataset(['alpha'], {
          dtype: 'S',
          metadata,
          valueGetter() {
            payloadReads++;
            throw new Error('string payload sentinel');
          }
        })
      }, 1);

      await assert.rejects(
        loader.getObsFieldInfo('label'),
        /string-array.*variable-length UTF-8 HDF5 storage/i
      );
      assert.equal(payloadReads, 0);
    });
  }

  await t.test('h5wasm-style variable-length UTF-8 metadata is accepted', async () => {
    const loader = loaderWithObs({
      label: dataset(['α'], {
        dtype: 'S',
        metadata: { cset: 1, size: 8, vlen: true }
      })
    }, 1);

    assert.deepEqual(await loader.getObsFieldInfo('label'), {
      dtype: 'string'
    });
    assert.deepEqual((await loader.getObsField('label')).values, ['α']);
  });
});

test('H5AD mask-only nullable observation indices do not budget unread values', async () => {
  const length = 7_000_000;
  let valueReads = 0;
  let maskReads = 0;
  const index = group({
    values: dataset([], {
      dtype: 'O',
      metadata: { cset: 1, size: 8, vlen: true },
      shape: [length],
      valueGetter() {
        valueReads++;
        throw new Error('observation index values sentinel');
      },
    }),
    mask: dataset(new Uint8Array(0), {
      dtype: '|b1',
      metadata: {
        enum_type: { members: { FALSE: 0, TRUE: 1 } },
        size: 1,
      },
      shape: [length],
      valueGetter() {
        maskReads++;
        throw new Error('observation index mask sentinel');
      },
    }),
  }, {
    'encoding-type': 'nullable-string-array',
    'encoding-version': '0.1.0',
  });
  const loader = new H5adLoader();
  loader._file = currentAnnData({
    X: dataset(new Float32Array(0), {
      dtype: '<f4',
      shape: [length, 0],
    }),
    obs: currentDataFrame(
      { cell_id: index },
      { indexKey: 'cell_id', columnOrder: [] }
    ),
    var: currentStringFrame([]),
  });

  await assert.rejects(
    loader._readStructure(),
    /observation index mask sentinel/i
  );
  assert.equal(maskReads, 1);
  assert.equal(valueReads, 0);
});

test('H5AD reads categorical labels from nested nullable-string groups', async () => {
  const categories = nullableField(
    'nullable-string-array',
    ['alpha', 'beta'],
    new Uint8Array([0, 0]),
    { valuesDtype: 'O' }
  );
  const loader = loaderWithObs({
    label: categoricalField(new Int8Array([0, -1, 1]), categories),
  }, 3);

  assert.deepEqual(await loader.getObsFieldInfo('label'), {
    dtype: 'categorical',
    categories: ['alpha', 'beta'],
    ordered: false,
  });
  const field = await loader.getObsField('label');
  assert.deepEqual(Array.from(field.codes), [0, -1, 1]);
  assert.deepEqual(field.categories, ['alpha', 'beta']);
  assert.deepEqual(field.values, ['alpha', null, 'beta']);
});

test('H5AD categorical ordered is one exact scalar HDF5 boolean and is preserved downstream', async t => {
  for (const [name, mutate] of [
    [
      'missing ordered',
      field => {
        delete field.attrs.ordered;
      }
    ],
    [
      'semantic boolean without HDF5 enum storage',
      field => {
        field.attrs.ordered = attribute(false);
      }
    ],
    [
      'string ordered',
      field => {
        field.attrs.ordered = attribute('false');
      }
    ],
    [
      'numeric ordered',
      field => {
        field.attrs.ordered = attribute(0);
      }
    ],
    [
      'one-element boolean enum array',
      field => {
        field.attrs.ordered = h5BooleanAttribute(false);
        field.attrs.ordered.shape = [1];
      }
    ],
    [
      'coercible enum member values',
      field => {
        field.attrs.ordered = h5BooleanAttribute(false);
        field.attrs.ordered.metadata.enum_type.members.FALSE = '0';
      }
    ],
    [
      'inherited ordered',
      field => {
        const attrs = { ...field.attrs };
        delete attrs.ordered;
        field.attrs = Object.assign(
          Object.create({ ordered: attribute(false) }),
          attrs
        );
      }
    ]
  ]) {
    await t.test(name, async () => {
      let payloadReads = 0;
      const field = categoricalField(
        new Int8Array([0]),
        dataset(['alpha'], {
          dtype: 'S',
          valueGetter() {
            payloadReads++;
            throw new Error('categorical payload sentinel');
          }
        })
      );
      mutate(field);
      const loader = loaderWithObs({ label: field }, 1);
      await assert.rejects(
        loader.getObsFieldInfo('label'),
        /ordered must be a scalar HDF5 enum boolean/i
      );
      assert.equal(payloadReads, 0);
    });
  }

  // Byte order is not a property of a one-byte value. h5py takes the enum's
  // base type from the writing host, so an `.h5ad` written on a big-endian
  // machine reports `littleEndian: false` for `ordered` while h5wasm still
  // returns the correct 0 or 1. Rejecting it read as "this is not a boolean",
  // which was both wrong and unactionable.
  for (const ordered of [false, true]) {
    await t.test(
      `big-endian ordered=${ordered} is an exact boolean`,
      async () => {
        const field = categoricalField(
          new Int8Array([0, 1]),
          dataset(['low', 'high'], { dtype: 'S' })
        );
        field.attrs.ordered = h5BooleanAttribute(ordered);
        field.attrs.ordered.metadata.littleEndian = false;
        const loader = loaderWithObs({ label: field }, 2);

        const info = await loader.getObsFieldInfo('label');
        assert.equal(info.ordered, ordered);
        assert.equal((await loader.getObsField('label')).ordered, ordered);
      }
    );
  }

  await t.test('ordered true survives loader and adapter seams', async () => {
    const field = categoricalField(
      new Int8Array([0, 1]),
      dataset(['low', 'high'], { dtype: 'S' })
    );
    field.attrs.ordered = h5BooleanAttribute(true);
    const loader = loaderWithObs({ label: field }, 2);

    const info = await loader.getObsFieldInfo('label');
    assert.equal(info.ordered, true);
    assert.equal((await loader.getObsField('label')).ordered, true);

    stubPlottableObsm(loader, 2);
    const adapter = new BaseAnnDataAdapter(loader);
    await adapter.initialize();
    assert.equal(adapter._obsFieldsMetadata[0].ordered, true);
    assert.equal((await adapter.getObsFieldData('label')).ordered, true);
  });
});

test('H5AD dataset metadata counts categorical fields without label payloads', async () => {
  let categoryReads = 0;
  const categories = dataset(['alpha'], {
    dtype: 'O',
    valueGetter() {
      categoryReads++;
      throw new Error('metadata category payload sentinel');
    },
  });
  const loader = loaderWithObs({
    label: categoricalField(new Int8Array([0]), categories),
  }, 1);
  loader._filename = 'metadata-only.h5ad';
  const probes = obsmProbes(1, { X_umap_2d: 2 });
  loader.probeMapping = async () => probes;
  loader.hasConnectivities = async () => false;

  const metadata = await loader.getDatasetMetadata();
  assert.equal(metadata.stats.n_categorical_fields, 1);
  assert.strictEqual(metadata.probes, probes);
  assert.equal(Object.hasOwn(metadata, 'embeddings'), false);
  assert.equal(categoryReads, 0);
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
    const { adapter, reads } = await initializeOverObsm(2, {
      X_umap: 2,
      X_umap_2d: 2,
      X_tsne: 2,
    });
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

test('direct AnnData vector discovery requires dimension-suffixed obsm keys bound by the default rule', async t => {
  async function discover(widths) {
    const { adapter } = await initializeOverObsm(2, widths);
    // The bindings stay private: the public vector_fields block is built
    // only by finalizeDirectIdentity(), keyed by embedding id.
    assert.equal(Object.hasOwn(adapter._metadata, 'vector_fields'), false);
    return Object.fromEntries(
      [...adapter._vectorBindings].map(([fieldId, byEmbedding]) => [
        fieldId,
        Object.fromEntries(byEmbedding),
      ])
    );
  }

  await t.test('only <field>_umap_<d>d keys are vector fields', async () => {
    const bindings = await discover({
      X_umap_2d: 2,
      velocity_umap: 2,
      velocity_umap_2d: 2,
      drift_umap: 2,
    });
    // X_umap_2d matches the vector grammar but is an embedding, never a vector.
    assert.deepEqual(bindings, {
      velocity_umap: { X_umap_2d: 'velocity_umap_2d' },
    });
  });

  await t.test('a vector binds only where its slot shows X_umap_<d>d or X_umap', async () => {
    const bindings = await discover({
      X_umap: 2,
      X_pca_3d: 3,
      velocity_umap_2d: 2,
      velocity_umap_3d: 3,
      drift_umap_1d: 1,
    });
    // The default rule fills only 2D (from X_umap): neither the 3D nor the
    // 1D vector has a slot to bind to.
    assert.deepEqual(bindings, {
      velocity_umap: { X_umap: 'velocity_umap_2d' },
    });
  });

  await t.test('several fields are recorded in code-point order', async () => {
    const bindings = await discover({
      X_umap_2d: 2,
      velocity_umap_2d: 2,
      T_fwd_umap_2d: 2,
      drift_umap_2d: 2,
    });
    assert.deepEqual(Object.keys(bindings), [
      'T_fwd_umap',
      'drift_umap',
      'velocity_umap',
    ]);
  });

  await t.test('a bound key of the wrong width is refused', async () => {
    await assert.rejects(
      initializeOverObsm(2, { X_umap_2d: 2, velocity_umap_2d: 3 }),
      /Vector field 'velocity_umap_2d' has 3 columns, but its 2D suffix requires exactly 2/
    );
  });
});

test('H5WASM initialization preserves the failure and leaves a later caller independent', async () => {
  const source = (await readFile(
    new URL('../assets/js/data/h5ad-loader.js', import.meta.url),
    'utf8'
  )).replaceAll('\r\n', '\n');
  const start = source.indexOf('async function initH5wasm()');
  const end = source.indexOf('function isBooleanEnum(metadata)', start);
  assert.ok(start >= 0 && end > start);
  const initialization = source.slice(start, end);

  assert.doesNotMatch(
    initialization,
    /refresh|pre-exported|prepared format|another format/i
  );
  assert.equal(
    initialization.match(/import\('\.\.\/\.\.\/external\/hdf5_hl\.js'\)/g)
      ?.length,
    1
  );
  assert.doesNotMatch(
    initialization,
    /\bwhile\b|(?:await|return)\s+initH5wasm\s*\(/
  );
  assert.doesNotMatch(initialization, /throw new Error/);
  assert.match(
    initialization,
    /catch\s*\(err\)\s*\{[\s\S]*h5wasmInitializationPromise\s*===\s*initialization[\s\S]*h5wasmInitializationPromise\s*=\s*null[\s\S]*throw err;\s*\}/
  );
});

test('H5AD adapter reuses retained categories after loader cache clearing', async () => {
  const scenario = loaderWithCountedCategories('modern-string');
  stubPlottableObsm(scenario.loader, 3);
  const adapter = new BaseAnnDataAdapter(scenario.loader);
  await adapter.initialize();
  const canonicalCategories =
    adapter._obsFieldsMetadata[0].categories;
  assert.equal(scenario.categoryReads(), 1);

  adapter.clearCaches();
  scenario.loader.clearCache();
  const field = await adapter.getObsFieldData('label');

  assert.strictEqual(field.categories, canonicalCategories);
  assert.equal(scenario.categoryReads(), 1);
  assert.equal(scenario.loader._cache.has('obs:label'), false);
  assert.equal(scenario.loader._cache.has('obs_info:label'), false);
  assert.equal(
    scenario.loader._cache.has('obs_categories:label'),
    false
  );
});

for (const layout of [
  'modern-string',
  'numeric',
  'nullable-string',
]) {
  test(`CEL-AUDIT-0087 H5AD reuses ${layout} info categories by immutable identity`, async () => {
    const scenario = loaderWithCountedCategories(layout);
    const expectedCategoryReads =
      layout === 'nullable-string' ? 2 : 1;

    const info = await scenario.loader.getObsFieldInfo('label');
    const field = await scenario.loader.getObsField('label');

    assert.equal(
      scenario.categoryReads(),
      expectedCategoryReads,
      'getObsField must not rematerialize labels cached by getObsFieldInfo'
    );
    assert.equal(scenario.codeReads(), 1);
    assert.strictEqual(field.categories, info.categories);
    assert.equal(Object.isFrozen(info.categories), true);
    assert.throws(() => {
      info.categories[0] = 'mutated';
    }, TypeError);
  });
}

for (const layout of [
  'modern-string',
  'numeric',
  'nullable-string',
]) {
  test(`CEL-AUDIT-0087 direct H5AD ${layout} categories materialize once`, async () => {
    const scenario = loaderWithCountedCategories(layout);
    const expectedCategoryReads =
      layout === 'nullable-string' ? 2 : 1;

    const first = await scenario.loader.getObsField('label');
    const second = await scenario.loader.getObsField('label');

    assert.equal(scenario.categoryReads(), expectedCategoryReads);
    assert.equal(scenario.codeReads(), 1);
    assert.strictEqual(first, second);
    assert.equal(Object.isFrozen(first.categories), true);
  });
}

test('CEL-AUDIT-0087 invalidated H5AD category metadata leaves a later caller independent', async () => {
  let categoryReads = 0;
  let loader;
  const categories = dataset(['alpha', 'beta'], {
    dtype: 'O',
    valueGetter() {
      categoryReads++;
      if (categoryReads === 1) loader.clearCache();
      return ['alpha', 'beta'];
    },
  });
  loader = loaderWithObs({
    label: categoricalField(
      new Int8Array([0, 1]),
      categories
    ),
  }, 2);

  await assert.rejects(
    loader.getObsFieldInfo('label'),
    INVALIDATED_REQUEST
  );
  assert.equal(loader._cache.size, 0);

  const info = await loader.getObsFieldInfo('label');
  const field = await loader.getObsField('label');
  assert.equal(categoryReads, 2);
  assert.strictEqual(field.categories, info.categories);
  assert.equal(Object.isFrozen(info.categories), true);
});

test('CEL-AUDIT-0088 H5AD category ceiling rejects direct metadata before payload access', async () => {
  let payloadReads = 0;
  const categories = dataset([], {
    dtype: 'O',
    shape: [4_294_967_296],
    valueGetter() {
      payloadReads++;
      throw new Error('oversized direct categories payload sentinel');
    },
  });
  const loader = loaderWithObs({
    label: categoricalField(new Int8Array([0]), categories),
  }, 1);

  await assert.rejects(
    loader.getObsFieldInfo('label'),
    /4,294,967,296 categories.*at most 4,294,967,295.*reduce or merge/i
  );
  assert.equal(payloadReads, 0);
});

test('CEL-AUDIT-0088 H5AD category ceiling rejects nullable metadata before payload access', async () => {
  let valueReads = 0;
  let maskReads = 0;
  const categories = group({
    values: dataset([], {
      dtype: 'O',
      shape: [4_294_967_296],
      valueGetter() {
        valueReads++;
        throw new Error('oversized nullable values payload sentinel');
      },
    }),
    mask: dataset(new Uint8Array(0), {
      dtype: '|b1',
      metadata: {
        enum_type: { members: { FALSE: 0, TRUE: 1 } },
        size: 1,
      },
      shape: [4_294_967_296],
      valueGetter() {
        maskReads++;
        throw new Error('oversized nullable mask payload sentinel');
      },
    }),
  }, {
    'encoding-type': 'nullable-string-array',
    'encoding-version': '0.1.0',
  });
  const loader = loaderWithObs({
    label: categoricalField(new Int8Array([0]), categories),
  }, 1);

  await assert.rejects(
    loader.getObsFieldInfo('label'),
    /4,294,967,296 categories.*at most 4,294,967,295.*reduce or merge/i
  );
  assert.equal(valueReads, 0);
  assert.equal(maskReads, 0);
});

test('CEL-AUDIT-0088 H5AD category ceiling accepts direct 65,535 boundary', async () => {
  const categories = dataset(Int32Array.from(
    { length: 65_535 },
    (_, index) => index
  ), {
    dtype: '<i4',
  });
  const loader = loaderWithObs({
    label: categoricalField(new Int8Array([0]), categories),
  }, 1);

  const info = await loader.getObsFieldInfo('label');
  assert.equal(info.categories.length, 65_535);
});

test('CEL-AUDIT-0088 H5AD category ceiling accepts nullable 65,535 boundary', async () => {
  const categoryValues = Array.from(
    { length: 65_535 },
    (_, index) => `category-${index}`
  );
  const categories = nullableField(
    'nullable-string-array',
    categoryValues,
    new Uint8Array(65_535),
    { valuesDtype: 'O' }
  );
  const loader = loaderWithObs({
    label: categoricalField(new Int8Array([0]), categories),
  }, 1);

  const info = await loader.getObsFieldInfo('label');
  assert.equal(info.categories.length, 65_535);
});

function pcaOnlyLoader(obsm) {
  const loader = new H5adLoader();
  loader._file = currentAnnData({
    X: dataset(new Float32Array([1, 2]), {
      dtype: '<f4',
      shape: [2, 1],
    }),
    obs: currentStringFrame(['cell-a', 'cell-b']),
    var: currentStringFrame(['gene']),
    obsm: currentMapping(obsm),
  });
  loader._filename = 'pca-only.h5ad';
  return loader;
}

test('CEL-AUDIT-0122 H5AD best-guesses a PCA-only file and records the guess', async () => {
  const loader = pcaOnlyLoader({
    X_pca: dataset(
      new Float32Array([0, 1, 5, 2, 3, 7]),
      { dtype: '<f4', shape: [2, 3] }
    ),
  });
  await loader._readStructure();
  const adapter = new BaseAnnDataAdapter(loader);
  await adapter.initialize();

  // No UMAP: the one narrow candidate is 3 columns wide, so it fills 3D.
  assert.deepEqual(adapter._slots, {
    '1d': null,
    '2d': null,
    '3d': { key: 'X_pca', columns: [0, 1, 2] },
  });
  const candidates = adapter.getMappingCandidates();
  assert.deepEqual(candidates.guessed, ['embeddings.3d']);
  assert.deepEqual(candidates.defaults.embeddings.defaults['3d'], {
    key: 'X_pca',
    columns: [0, 1, 2],
  });
  // The guessed default is the one representation enabled.
  assert.deepEqual(candidates.defaults.embeddings.enabled, [
    { key: 'X_pca', columns: [0, 1, 2] },
  ]);
});

test('CEL-AUDIT-0122 H5AD reads a wide PCA at its first two columns', async () => {
  const values = Float32Array.from({ length: 10 }, (_, index) => index * index);
  const pca = dataset(values, { dtype: '<f4', shape: [2, 5] });
  const slices = [];
  pca.slice = ([[r0, r1], [c0, c1]]) => {
    slices.push([c0, c1]);
    const out = new Float32Array((r1 - r0) * (c1 - c0));
    for (let row = r0; row < r1; row++) {
      for (let column = c0; column < c1; column++) {
        out[(row - r0) * (c1 - c0) + column - c0] = values[row * 5 + column];
      }
    }
    return out;
  };
  const loader = pcaOnlyLoader({ X_pca: pca });
  await loader._readStructure();
  const adapter = new BaseAnnDataAdapter(loader);
  await adapter.initialize();

  assert.deepEqual(adapter._slots['2d'], { key: 'X_pca', columns: [0, 1] });
  assert.deepEqual(adapter.getMappingCandidates().guessed, ['embeddings.2d']);
  // Only the two columns plotted are read, never the whole array.
  assert.deepEqual(slices, [[0, 2]]);
  const identity = await adapter.finalizeDirectIdentity({
    id: 'pca-only',
    name: 'pca-only',
    description: '',
    cellucidDataVersion: 'h5ad_loader',
    source: { name: 'H5AD file' },
  });
  assert.deepEqual(identity.embeddings.defaults, { '2d': 'X_pca[0,1]' });
  assert.deepEqual(identity.embeddings.items['X_pca[0,1]'].source, {
    key: 'X_pca',
    columns: [0, 1],
  });
});

test('H5AD with nothing plottable is refused with what obsm holds', async () => {
  const loader = pcaOnlyLoader({
    X_df: currentStringFrame(['cell-a', 'cell-b']),
    spatial: dataset(
      new Float32Array([0, 1, Number.NaN, 2]),
      { dtype: '<f4', shape: [2, 2] }
    ),
  });
  await loader._readStructure();
  const adapter = new BaseAnnDataAdapter(loader);

  const error = await adapter.initialize().then(() => null, rejection => rejection);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'DataSourceError');
  assert.equal(error.code, 'NO_PLOTTABLE_EMBEDDING');
  assert.equal(
    error.message,
    'Cellucid found nothing to plot. It needs an obsm array with one row per ' +
    'cell (2) and at least one numeric column. obsm holds: X_df (table), ' +
    'spatial (2 × 2, NaN at cell 1).'
  );
  assert.equal(adapter.getMetadata(), null);
});

test('H5AD preserves official numeric and boolean categorical labels', async t => {
  await t.test('numeric labels', async () => {
    const loader = loaderWithObs({
      label: categoricalField(
        new Int8Array([0, 1]),
        dataset(new BigInt64Array([10n, 20n]), { dtype: '<i8' })
      ),
    }, 2);
    const field = await loader.getObsField('label');
    assert.deepEqual(field.categories, [10, 20]);
    assert.deepEqual(field.values, [10, 20]);
  });

  await t.test('boolean labels', async () => {
    const loader = loaderWithObs({
      label: categoricalField(
        new Int8Array([1, 0]),
        dataset(new Uint8Array([0, 1]), {
          dtype: '|b1',
          metadata: {
            enum_type: { members: { FALSE: 0, TRUE: 1 } },
            size: 1,
          },
        })
      ),
    }, 2);
    const field = await loader.getObsField('label');
    assert.deepEqual(field.categories, [false, true]);
    assert.deepEqual(field.values, [true, false]);
  });
});

test('H5AD rejects duplicate categorical labels under exact primitive semantics', async t => {
  const cases = [
    {
      name: 'string',
      categories: dataset(['same', 'same'], { dtype: 'O' })
    },
    {
      name: 'number',
      categories: dataset(
        new Float32Array([7, 7]),
        { dtype: '<f4' }
      )
    },
    {
      name: 'boolean',
      categories: dataset(new Uint8Array([0, 0]), {
        dtype: '|b1',
        metadata: {
          enum_type: { members: { FALSE: 0, TRUE: 1 } },
          size: 1
        }
      })
    }
  ];

  for (const categoryCase of cases) {
    await t.test(categoryCase.name, async () => {
      const loader = loaderWithObs({
        label: categoricalField(
          new Int8Array([0]),
          categoryCase.categories
        )
      }, 1);
      await assert.rejects(
        loader.getObsFieldInfo('label'),
        /categorical categories.*label.*duplicate.*label/i
      );
      assert.equal(loader._cache.has('obs_categories:label'), false);
      assert.equal(loader._cache.has('obs_info:label'), false);
    });
  }
});

test('H5AD rejects missing categorical labels and out-of-bounds codes', async t => {
  await t.test('nullable category labels cannot be missing', async () => {
    const categories = nullableField(
      'nullable-string-array',
      ['alpha', 'sentinel'],
      new Uint8Array([0, 1]),
      { valuesDtype: 'O' }
    );
    const loader = loaderWithObs({
      label: categoricalField(new Int8Array([0, 0]), categories),
    }, 2);
    await assert.rejects(
      loader.getObsField('label'),
      /categories.*missing labels/i
    );
  });

  await t.test('categorical codes must stay within missing-or-label bounds', async () => {
    const loader = loaderWithObs({
      label: categoricalField(
        new Int8Array([0, 2]),
        dataset(['alpha', 'beta'], { dtype: 'O' })
      ),
    }, 2);
    await assert.rejects(
      loader.getObsField('label'),
      /categorical code.*bounds/i
    );
  });

  await t.test('categorical metadata requires signed integer codes', async () => {
    const unsignedLoader = loaderWithObs({
      label: group({
        categories: dataset(['alpha', 'beta'], { dtype: 'O' }),
        codes: dataset(new Uint8Array([0, 1]), { dtype: '|B1' }),
      }, {
        'encoding-type': 'categorical',
        'encoding-version': '0.2.0',
        ordered: false,
      }),
    }, 2);
    await assert.rejects(
      unsignedLoader.getObsFieldInfo('label'),
      /categorical codes.*signed integer dtype/i
    );

    const booleanLoader = loaderWithObs({
      label: group({
        categories: dataset(['alpha', 'beta'], { dtype: 'O' }),
        codes: dataset(new Uint8Array([0, 1]), {
          dtype: '|b1',
          metadata: {
            enum_type: { members: { FALSE: 0, TRUE: 1 } },
            size: 1,
          },
        }),
      }, {
        'encoding-type': 'categorical',
        'encoding-version': '0.2.0',
        ordered: false,
      }),
    }, 2);
    await assert.rejects(
      booleanLoader.getObsFieldInfo('label'),
      /categorical codes.*signed integer dtype/i
    );
  });
});

test('clearing an H5AD loader invalidates delayed sparse work without stale cache publication', async () => {
  const loader = loaderWithSparseX(sparseGroup());
  const pending = deferred();
  const state = {
    element: 'X',
    columns: null,
    loadPromise: pending.promise,
  };
  loader._matrix = state;

  const stale = loader.getMatrixColumn('X', 0);
  const staleAssertion = assert.rejects(stale, INVALIDATED_REQUEST);
  loader.clearCache();
  pending.resolve({ column: () => new Float32Array([7]) });

  await staleAssertion;
  assert.equal(loader._matrix, null);
  assert.equal(state.columns, null, 'the stale load is not published to the released matrix');
});

function sourceMetadata() {
  return {
    obs_fields: [],
    probes: obsmProbes(2, { X_umap_2d: 2 }),
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

function fakeEngine(name) {
  const engine = new H5adLoader();
  engine._file = { close() {}, keys() { return []; } };
  engine._filename = name;
  engine._nObs = 2;
  engine._nVars = 0;
  engine._obsKeys = [];
  engine._varNames = [];
  return engine;
}

async function withFakeH5adOpen(run) {
  const originalOpen = AnnDataReaderClient.prototype.open;
  const notificationCenter = getNotificationCenter();
  const notificationMethods = [
    'info',
    'startDownload',
    'updateDownload',
    'completeDownload',
    'failDownload',
    'dismissDownload',
  ];
  const originalNotifications = new Map(
    notificationMethods.map(name => [name, notificationCenter[name]])
  );
  const pendingByName = new Map();
  const records = new Map();
  const warnings = [];

  notificationCenter.info = (...args) => {
    warnings.push(args);
    return `info-${warnings.length}`;
  };
  notificationCenter.startDownload = () => 'fake-download';
  notificationCenter.updateDownload = () => {};
  notificationCenter.completeDownload = () => {};
  notificationCenter.failDownload = () => {};
  notificationCenter.dismissDownload = () => {};
  AnnDataReaderClient.prototype.open = async function fakeOpen(file) {
    const record = {
      closeCalls: 0,
      loader: this,
      name: file.name,
    };
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
      varNames: [],
      hasExpressionMatrix: false,
      isOpen: true,
    };
    // The calls reach a reader configured as the fixture, in-process.
    const engine = fakeEngine(file.name);
    this._call = async (method, ...args) => engine[method](...args);
    this.getDatasetMetadata = async () => sourceMetadata();
    this.readObsmColumns = async (key, columns) => {
      assert.equal(key, 'X_umap_2d');
      assert.deepEqual(columns, [0, 1]);
      if (file.corruptEmbedding) {
        throw new Error(`corrupt embedding payload in ${file.name}`);
      }
      return new Float64Array([0, 0, 1, 1]);
    };

    if (file.fail) throw new Error(`invalid ${file.name}`);
    const pending = pendingByName.get(file.name);
    if (pending) await pending.promise;
  };

  try {
    await run({ pendingByName, records, warnings });
  } finally {
    AnnDataReaderClient.prototype.open = originalOpen;
    for (const [name, method] of originalNotifications) {
      if (method === undefined) delete notificationCenter[name];
      else notificationCenter[name] = method;
    }
  }
}

test('H5AD direct-load warning is published only after successful adoption', async () => {
  await withFakeH5adOpen(async ({ warnings }) => {
    const source = new H5adDataSource();

    await assert.rejects(
      source.loadFromFile({ fail: true, name: 'broken.h5ad' }),
      /invalid broken/i
    );
    assert.equal(warnings.length, 0);

    await source.loadFromFile({ name: 'working.h5ad' });
    assert.equal(warnings.length, 1);
    source.clear();
  });
});

test('H5adDataSource preserves a working dataset when a replacement fails', async () => {
  await withFakeH5adOpen(async () => {
    const source = new H5adDataSource();
    await source.loadFromFile({ name: 'working.h5ad' });
    const originalAdapter = source.getAdapter();

    await assert.rejects(
      source.loadFromFile({ fail: true, name: 'broken.h5ad' }),
      /invalid broken/i
    );
    assert.equal(source.datasetId, 'h5ad_working');
    assert.equal(source.getAdapter(), originalAdapter);
    assert.equal(await source.isAvailable(), true);
    source.clear();
  });
});

test('H5adDataSource preserves a working dataset when required embedding bytes are corrupt', async () => {
  await withFakeH5adOpen(async () => {
    const source = new H5adDataSource();
    await source.loadFromFile({ name: 'working.h5ad' });
    const workingAdapter = source.getAdapter();

    await assert.rejects(
      source.loadFromFile({
        corruptEmbedding: true,
        name: 'corrupt-embedding.h5ad'
      }),
      /corrupt embedding payload/i
    );
    assert.equal(source.datasetId, 'h5ad_working');
    assert.equal(source.getAdapter(), workingAdapter);
    assert.equal(await source.isAvailable(), true);
    assert.deepEqual(
      Array.from(
        await source.getAdapter().getEmbeddingPayload('embeddings/0_2d.bin', 2)
      ),
      [-1, -1, 1, 1]
    );
    source.clear();
  });
});

test('H5adDataSource makes overlapping selections latest-wins', async () => {
  await withFakeH5adOpen(async ({ pendingByName, records }) => {
    const oldPending = deferred();
    pendingByName.set('older.h5ad', oldPending);
    const source = new H5adDataSource();

    const older = source.loadFromFile({ name: 'older.h5ad' });
    await Promise.resolve();
    const newer = await source.loadFromFile({ name: 'newer.h5ad' });
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

test('H5AD notification owner spans validation and dismisses a stale candidate', async t => {
  const notifications = getNotificationCenter();
  const events = captureDownloadNotifications(t);
  const originalOpen = AnnDataReaderClient.prototype.open;
  const originalInfo = notifications.info;
  const olderGate = deferred();
  notifications.info = () => {};
  t.after(() => {
    AnnDataReaderClient.prototype.open = originalOpen;
    notifications.info = originalInfo;
  });

  AnnDataReaderClient.prototype.open = async function (file) {
    this._snapshot = {
      nObs: 2,
      nVars: 0,
      obsKeys: [],
      varNames: [],
      hasExpressionMatrix: false,
      isOpen: true,
    };
    const engine = fakeEngine(file.name);
    this._call = async (method, ...args) => engine[method](...args);
    this.getDatasetMetadata = async () => sourceMetadata();
    this.readObsmColumns = async () => new Float64Array([0, 0, 1, 1]);

    if (file.name === 'older.h5ad') await olderGate.promise;
  };

  const source = new H5adDataSource();
  t.after(() => source.clear());
  const older = source.loadFromFile({ name: 'older.h5ad' });
  await Promise.resolve();
  const newer = await source.loadFromFile({ name: 'newer.h5ad' });
  olderGate.resolve();

  await assert.rejects(older, /superseded/i);
  assert.equal(newer.id, 'h5ad_newer');
  assert.deepEqual(
    events
      .filter(event => event.kind !== 'update')
      .map(event => event.kind),
    ['start', 'start', 'complete', 'dismiss']
  );
  const completedId = events.find(event => event.kind === 'complete').id;
  const newerStart = events.find(
    event => event.kind === 'start' &&
      /newer\.h5ad/.test(event.name)
  );
  assert.equal(completedId, newerStart.id);
});

test('H5AD low-level open publishes no notifications and a newer open supersedes an older one', async t => {
  const events = captureDownloadNotifications(t);
  const configure = (loader, gate = null) => {
    loader._populateCandidate = async (candidate, source) => {
      candidate._file = { close() {} };
      candidate._filename = source.name;
      candidate._nObs = 1;
      candidate._nVars = 0;
      if (gate && source.name === 'older.h5ad') await gate.promise;
    };
  };
  const source = name => ({ name, size: 1, identity: {}, readInto() {} });

  const direct = new H5adLoader();
  configure(direct);
  await direct.open(source('direct.h5ad'));
  assert.deepEqual(events, [], 'the reader runs in a worker; the data source owns notifications');

  const overlapping = new H5adLoader();
  const olderGate = deferred();
  configure(overlapping, olderGate);
  const older = overlapping.open(source('older.h5ad'));
  await Promise.resolve();
  await overlapping.open(source('newer.h5ad'));
  olderGate.resolve();
  await assert.rejects(older, /superseded/i);
  assert.equal(overlapping._filename, 'newer.h5ad');
  assert.deepEqual(events, []);
});

test('H5adDataSource has one loader owner and closes it once', async () => {
  await withFakeH5adOpen(async () => {
    const source = new H5adDataSource();
    await source.loadFromFile({ name: 'owned.h5ad' });
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

function loaderWithConnectivity(connectivities, nObs) {
  const loader = new H5adLoader();
  loader._file = group({
    obsp: currentMapping({ connectivities }),
  });
  loader._filename = 'connectivity.h5ad';
  loader._nObs = nObs;
  return loader;
}

test('H5AD connectivity requires exact obsp mapping identity', async t => {
  const invalidCases = [
    [
      'missing identity',
      mapping => {
        mapping.attrs = {};
      },
      /obsp.*encoding-type.*dict|obsp.*mapping/i
    ],
    [
      'wrong type',
      mapping => {
        mapping.attrs['encoding-type'] = attribute('mapping');
      },
      /obsp.*encoding-type.*dict/i
    ],
    [
      'wrong version',
      mapping => {
        mapping.attrs['encoding-version'] = attribute('9.9.9');
      },
      /obsp.*encoding-version.*0\.1\.0/i
    ],
    [
      'dataset instead of group',
      (_mapping, loader) => {
        loader._file = group({
          obsp: dataset(new Float32Array([0]), {
            dtype: '<f4',
            shape: [1]
          })
        });
      },
      /obsp.*mapping group/i
    ]
  ];

  for (const [name, mutate, expected] of invalidCases) {
    await t.test(name, async () => {
      const loader = loaderWithConnectivity(
        sparseGroup({ shape: [1, 1] }),
        1
      );
      mutate(loader._file.get('obsp'), loader);
      await assert.rejects(loader.hasConnectivities('connectivities'), expected);
    });
  }
});

test('H5AD discovers sparse connectivity from metadata without reading payloads', async () => {
  let payloadReads = 0;
  const unreadable = () => {
    payloadReads++;
    throw new Error('payload sentinel');
  };
  const connectivities = group({
    data: dataset(new Float32Array(0), {
      dtype: '<f4',
      shape: [2],
      valueGetter: unreadable,
    }),
    indices: dataset(new Int32Array(0), {
      dtype: '<i4',
      shape: [2],
      valueGetter: unreadable,
    }),
    indptr: dataset(new Int32Array(0), {
      dtype: '<i4',
      shape: [3],
      valueGetter: unreadable,
    }),
  }, {
    'encoding-type': 'csr_matrix',
    'encoding-version': '0.1.0',
    shape: [2, 2],
  });
  const loader = loaderWithConnectivity(connectivities, 2);

  assert.equal(typeof loader.hasConnectivities, 'function');
  assert.equal(await loader.hasConnectivities('connectivities'), true);
  assert.equal(payloadReads, 0);
});

test('H5AD supports bounded dense connectivity matrices', async () => {
  const connectivities = dataset(
    new Float32Array([
      0, 1, 0,
      1, 0, 1,
      0, 1, 0,
    ]),
    { dtype: '<f4', shape: [3, 3] }
  );
  const loader = loaderWithConnectivity(connectivities, 3);

  assert.equal(await loader.hasConnectivities('connectivities'), true);
  const result = await loader.getConnectivities('connectivities');
  assert.equal(result.format, 'dense');
  assert.deepEqual(result.shape, [3, 3]);
  assert.deepEqual(Array.from(result.data), [
    0, 1, 0,
    1, 0, 1,
    0, 1, 0,
  ]);
});

test('H5AD preserves exact connectivity weights through graph extraction', async t => {
  const weighted = 1 + (2 ** -30);

  await t.test('dense Float64', async () => {
    const loader = loaderWithConnectivity(
      dataset(
        Float64Array.from([
          0, weighted,
          weighted, 0,
        ]),
        { dtype: '<f8', shape: [2, 2] }
      ),
      2
    );
    const result = await loader.getConnectivities('connectivities');
    assert.equal(result.data instanceof Float64Array, true);
    assert.equal(result.data[1], weighted);
    const edges = extractConnectivityEdges(result, 2);
    assert.deepEqual(Array.from(edges.weights), [weighted]);
  });

  await t.test('sparse Float64', async () => {
    const loader = loaderWithConnectivity(
      sparseGroup({
        data: Float64Array.from([weighted, weighted]),
        dataDtype: '<f8',
        indices: Int32Array.from([1, 0]),
        indptr: Int32Array.from([0, 1, 2]),
        shape: [2, 2],
      }),
      2
    );
    const result = await loader.getConnectivities('connectivities');
    assert.equal(result.data instanceof Float64Array, true);
    assert.equal(result.data[0], weighted);
    const edges = extractConnectivityEdges(result, 2);
    assert.deepEqual(Array.from(edges.weights), [weighted]);
  });
});

test('an H5AD open superseded before its file is mounted rejects as superseded', async () => {
  const hdf5 = await import('../assets/external/hdf5_hl.js');
  await hdf5.ready;
  const bytes = new Uint8Array(4096);
  bytes.set([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const file = new BytesRangeSource(bytes, { name: 'superseded.h5ad' });
  const before = new Set(hdf5.FS.readdir('/'));

  const loader = new H5adLoader();
  // The signature check is synchronous; the open then waits for h5wasm, and
  // a close in that window supersedes it before anything is mounted.
  const opening = loader.open(file);
  loader.close();

  await assert.rejects(opening, error => {
    assert.equal(
      isDatasetReloadSupersededError(error),
      true,
      `expected the superseded error itself, received ${error?.name}: ${error?.message}`
    );
    assert.equal(error instanceof AggregateError, false);
    return true;
  });
  const leftovers = hdf5.FS.readdir('/').filter(entry => !before.has(entry));
  assert.deepEqual(leftovers, []);
});

test('a superseded failure is never folded into a cleanup aggregate', () => {
  const superseded = createDatasetReloadSupersededError('Request superseded.');
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    assert.strictEqual(
      combineDatasetLifecycleFailures(
        superseded,
        new Error('cleanup failed'),
        'Opening and cleanup both failed.'
      ),
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

test('H5AD does not keep the raw connectivity matrix once it is read', async () => {
  const loader = loaderWithConnectivity(
    dataset(
      new Float32Array([0, 1, 1, 0]),
      { dtype: '<f4', shape: [2, 2] }
    ),
    2
  );
  const first = await loader.getConnectivities('connectivities');
  assert.equal(first.format, 'dense');
  for (const [key, value] of loader._cache) {
    assert.notStrictEqual(value, first, `cache entry "${key}" retains the raw matrix`);
  }
});

// ---------------------------------------------------------------------------
// No size ceiling: every array is read in bounded hyperslabs, and gene
// columns are reached without holding the whole matrix.
// ---------------------------------------------------------------------------

function slabCountingDataset(length, elementBytes, valueAt) {
  const slices = [];
  const node = dataset(new Float64Array(0), {
    dtype: '<f8',
    // A large element size makes the 64 MiB slab hold only a few elements,
    // so slabbing is observable on a tiny array.
    metadata: { size: elementBytes },
    shape: [length],
    valueGetter() {
      throw new Error('a whole-array read would stage the array in the WASM heap');
    },
  });
  node.slice = ([[start, stop]]) => {
    slices.push([start, stop]);
    return Float64Array.from({ length: stop - start }, (_, i) => valueAt(start + i));
  };
  return { node, slices };
}

test('H5AD observation fields of any length are read in bounded slabs, never whole', async () => {
  const length = 20;
  const { node, slices } = slabCountingDataset(length, 8 * 1024 * 1024, i => i * 0.5);
  const loader = loaderWithObs({ score: node }, length);
  const field = await loader.getObsField('score');
  assert.deepEqual(Array.from(field.values), Array.from({ length }, (_, i) => i * 0.5));
  // 64 MiB / 8 MiB per element = 8 elements per slab.
  assert.deepEqual(slices, [[0, 8], [8, 16], [16, 20]]);
});

test('H5AD CSC gene columns read only that gene\'s entries', async () => {
  // 3 cells x 3 genes, CSC: gene g has entries indptr[g]..indptr[g+1].
  const data = new Float32Array([1, 2, 3, 4]);
  const indices = new Int32Array([0, 2, 1, 1]);
  const indptr = new Int32Array([0, 2, 3, 4]);
  const X = sparseGroup({ data, indices, indptr, encodingType: 'csc_matrix', shape: [3, 3] });
  const reads = [];
  for (const key of ['data', 'indices']) {
    const node = X.get(key);
    const slice = node.slice;
    node.slice = ranges => {
      reads.push([key, ...ranges[0]]);
      return slice(ranges);
    };
    Object.defineProperty(node, 'value', {
      get() { throw new Error('a CSC gene read must not read the whole matrix'); },
    });
  }
  const loader = loaderWithSparseX(X, { nObs: 3, nVars: 3, varNames: ['a', 'b', 'c'] });
  assert.deepEqual(Array.from(await loader.getMatrixColumn('X', 0)), [1, 0, 2]);
  assert.deepEqual(Array.from(await loader.getMatrixColumn('X', 2)), [0, 4, 0]);
  assert.deepEqual(reads, [
    ['indices', 0, 2], ['data', 0, 2],
    ['indices', 3, 4], ['data', 3, 4],
  ]);
});

test('H5AD CSR gene index is a streaming transpose that never reads the matrix whole', async () => {
  // 4 cells x 3 genes, CSR, with a duplicate coordinate in cell 1.
  const data = new Float32Array([1, 2, 3, 0.5, 4, 5]);
  const indices = new Int32Array([0, 2, 1, 1, 0, 2]);
  const indptr = new Int32Array([0, 2, 4, 5, 6]);
  const X = sparseGroup({ data, indices, indptr, shape: [4, 3] });
  for (const key of ['data', 'indices', 'indptr']) {
    Object.defineProperty(X.get(key), 'value', {
      get() { throw new Error('the CSR matrix must never be read whole'); },
    });
  }
  const loader = loaderWithSparseX(X, { nObs: 4, nVars: 3, varNames: ['a', 'b', 'c'] });
  const [a, b, c] = await Promise.all([0, 1, 2].map(g => loader.getMatrixColumn('X', g)));
  assert.deepEqual(Array.from(a), [1, 0, 4, 0]);
  assert.deepEqual(Array.from(b), [0, Math.fround(3 + 0.5), 0, 0]);
  assert.deepEqual(Array.from(c), [2, 0, 0, 5]);
});
