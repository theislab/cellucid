import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import * as h5adModule from '../assets/js/data/h5ad.js';
import {
  extractConnectivityEdges,
} from '../assets/js/data/sparse-utils.js';

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
  Object.defineProperty(result, 'value', {
    configurable: true,
    enumerable: true,
    get: valueGetter ?? (() => value),
  });
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
  loader._varNameIndex = new Map(
    varNames.map((name, index) => [name, index])
  );
  loader._xIsSparse = true;
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

function loaderWithEmbedding(embedding, nObs) {
  const loader = new H5adLoader();
  loader._file = group({
    obsm: currentMapping({ X_umap_2d: embedding }),
  });
  loader._filename = 'embedding.h5ad';
  loader._nObs = nObs;
  loader._obsmKeys = ['X_umap_2d'];
  return loader;
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

test('H5AD direct-file size accepts the exact 512 MiB metadata boundary', () => {
  const browserLimit = 512 * 1024 * 1024;
  assert.equal(
    typeof h5adModule.validateH5adBrowserFileSize,
    'function'
  );
  assert.equal(
    h5adModule.validateH5adBrowserFileSize({
      name: 'boundary.h5ad',
      size: browserLimit,
    }),
    browserLimit
  );
});

test('H5AD rejects invalid direct-file sizes before browser or h5wasm access', async t => {
  const browserLimit = 512 * 1024 * 1024;
  const cases = [
    ['missing', undefined],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['non-safe', Number.MAX_SAFE_INTEGER + 1],
    ['over limit', browserLimit + 1],
  ];
  for (const [name, size] of cases) {
    await t.test(name, async () => {
      let payloadAccesses = 0;
      const file = {
        name: `${name}.h5ad`,
        size,
        arrayBuffer() {
          payloadAccesses++;
          throw new Error('arrayBuffer sentinel');
        },
        slice() {
          payloadAccesses++;
          throw new Error('slice sentinel');
        },
      };
      const loader = new H5adLoader();
      await assert.rejects(
        loader.open(file),
        /512 MiB.*server or prepared format/i
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
    const file = {
      name: 'corrupt.h5ad',
      size: bytes.byteLength,
      async arrayBuffer() {
        return bytes.slice().buffer;
      },
      slice(start, end) {
        return new Blob([bytes.slice(start, end)]);
      },
    };
    const loader = new H5adLoader();
    await assert.rejects(
      loader.open(file, { showProgress: false }),
      /not a valid HDF5\/H5AD file/i
    );
  });

  await t.test('open translates a structurally unreadable HDF5 handle', async () => {
    const bytes = signature.slice();
    const file = {
      name: 'truncated.h5ad',
      size: bytes.byteLength,
      async arrayBuffer() {
        return bytes.slice().buffer;
      },
      slice(start, end) {
        return new Blob([bytes.slice(start, end)]);
      },
    };
    const loader = new H5adLoader();
    await assert.rejects(
      loader.open(file, { showProgress: false }),
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
      Array.from(await loader.getGeneExpression('gene')),
      [1]
    );
  });

  await t.test('missing encoding-type is rejected', async () => {
    const loader = loaderWithSparseX(sparseGroup({ includeEncoding: false }));
    await assert.rejects(
      loader.getGeneExpression('gene'),
      /encoding-type.*csr_matrix.*csc_matrix/i
    );
  });

  await t.test('unknown encoding-type is rejected', async () => {
    const loader = loaderWithSparseX(
      sparseGroup({ encodingType: 'compressed_matrix' })
    );
    await assert.rejects(
      loader.getGeneExpression('gene'),
      /encoding-type.*csr_matrix.*csc_matrix/i
    );
  });

  await t.test('missing shape is rejected', async () => {
    const loader = loaderWithSparseX(sparseGroup({ includeShape: false }));
    await assert.rejects(
      loader.getGeneExpression('gene'),
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
      loader.getGeneExpression('gene'),
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
      loader.getGeneExpression('gene'),
      /indptr.*monotonic/i
    );
  });

  await t.test('out-of-range int64 indices are rejected instead of clamped', async () => {
    const loader = loaderWithSparseX(sparseGroup({
      indices: new BigInt64Array([2147483648n]),
    }));
    await assert.rejects(
      loader.getGeneExpression('gene'),
      /(index|int32).*range/i
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
    loader._varNameIndex = new Map([['old_gene', 0]]);
    loader._obsmKeys = ['old_embedding'];
    loader._xIsSparse = true;
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
    assert.deepEqual([...loader._varNameIndex], [['old_gene', 0]]);
    assert.deepEqual(loader.obsmKeys, ['old_embedding']);
    assert.equal(loader._xIsSparse, true);
  });
});

test('H5AD opening enforces X axes and unique variable names', async t => {
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

  await t.test('duplicate variable names are rejected', async () => {
    const loader = new H5adLoader();
    loader._file = currentAnnData({
      X: emptySparse([1, 2]),
      obs: frame(['cell']),
      var: frame(['duplicate', 'duplicate']),
    });
    await assert.rejects(
      loader._readStructure(),
      /duplicate.*variable|variable.*duplicate/i
    );
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
  assert.deepEqual(adapter.getVarManifest().fields, []);
  assert.deepEqual(adapter.getGeneNames(), []);
  await assert.rejects(
    adapter.getGeneExpression('A'),
    /does not contain an X expression matrix|no X expression matrix/i
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
    Array.from(await loader.getGeneExpression('gene')),
    [3, 4]
  );
});

test('H5AD integer sparse gene values remain exact when narrowed to Float32', async t => {
  await t.test('an unsafe source integer is rejected', async () => {
    const loader = loaderWithSparseX(sparseGroup({
      data: new BigInt64Array([16777217n]),
      dataDtype: '<i8',
    }));
    await assert.rejects(
      loader.getGeneExpression('gene'),
      /integer.*exactly.*Float32/i
    );
  });

  await t.test('an unsafe duplicate integer sum is rejected', async () => {
    const loader = loaderWithSparseX(sparseGroup({
      data: new Int32Array([16777216, 1]),
      dataDtype: '<i4',
      encodingType: 'csc_matrix',
      indices: new Int32Array([0, 0]),
      indptr: new Int32Array([0, 2]),
    }));
    await assert.rejects(
      loader.getGeneExpression('gene'),
      /integer sum.*exactly.*Float32/i
    );
  });
});

test('H5AD embeddings validate cell axes and reject finite Float64 overflow', async t => {
  await t.test('cell-axis mismatch is rejected before caching', async () => {
    const loader = loaderWithEmbedding(dataset(
      new Float64Array([0, 0, 1, 1]),
      { dtype: '<f8', shape: [2, 2] }
    ), 1);
    await assert.rejects(
      loader.getEmbedding('X_umap_2d'),
      /embedding.*rows.*1 cell/i
    );
    assert.equal(loader._cache.size, 0);
  });

  await t.test('finite overflow is rejected before caching', async () => {
    const loader = loaderWithEmbedding(dataset(
      new Float64Array([1e308, 0]),
      { dtype: '<f8', shape: [1, 2] }
    ), 1);
    await assert.rejects(
      loader.getEmbedding('X_umap_2d'),
      /embedding.*Float32 range/i
    );
    assert.equal(loader._cache.size, 0);
  });

  for (const [name, value] of [
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY]
  ]) {
    await t.test(`${name} is rejected before caching`, async () => {
      const loader = loaderWithEmbedding(dataset(
        new Float32Array([value, 0]),
        { dtype: '<f4', shape: [1, 2] }
      ), 1);
      await assert.rejects(
        loader.getEmbedding('X_umap_2d'),
        /embedding.*X_umap_2d.*non-finite.*component/i
      );
      assert.equal(loader._cache.size, 0);
    });
  }
});

test('H5AD releases only the exact requested raw embedding cache entry', () => {
  const loader = new H5adLoader();
  const consumed = {
    data: Float32Array.from([0, 1]),
    nDims: 2
  };
  const newer = {
    data: Float32Array.from([2, 3]),
    nDims: 2
  };
  const unrelated = { marker: 'keep' };
  loader._cache.set('obsm:X_umap_2d', newer);
  loader._cache.set('obs:group', unrelated);

  loader.releaseEmbedding('X_umap_2d', consumed);
  assert.strictEqual(loader._cache.get('obsm:X_umap_2d'), newer);

  loader.releaseEmbedding('X_umap_2d', newer);
  assert.equal(loader._cache.has('obsm:X_umap_2d'), false);
  assert.strictEqual(loader._cache.get('obs:group'), unrelated);
});

test('H5AD adapter enforces the raw plus normalized coordinate ceiling and releases the loader cache', async () => {
  const loader = loaderWithEmbedding(dataset(
    new Float32Array([0, 1]),
    { dtype: '<f4', shape: [1, 2] }
  ), 1);
  const adapter = new BaseAnnDataAdapter(loader, {
    maxMaterializedBytes: 8
  });
  adapter._metadata = {
    embeddings: {
      obsm_keys: { '2d': 'X_umap_2d' }
    }
  };
  adapter._embeddingKeysByDimension = {
    '2d': 'X_umap_2d'
  };
  let normalizationCalls = 0;
  const normalize = adapter._normalizeEmbedding.bind(adapter);
  adapter._normalizeEmbedding = (...args) => {
    normalizationCalls++;
    return normalize(...args);
  };

  await assert.rejects(
    adapter.getEmbedding(2),
    /embedding.*8-byte browser limit.*current coordinate results/i
  );
  assert.equal(normalizationCalls, 0);
  assert.equal(loader._cache.has('obsm:X_umap_2d'), false);
  assert.equal(adapter._coordinateCacheBytes, 0n);
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
    loader._varNameIndex = new Map([['gene', 0]]);
    loader._xIsSparse = false;
    return loader;
  }

  await t.test('shape mismatch is rejected before caching', async () => {
    const loader = denseLoader(dataset(
      new Float64Array([1]),
      { dtype: '<f8', shape: [1, 1] }
    ), 2, 1);
    await assert.rejects(
      loader.getGeneExpression('gene'),
      /dense X.*shape.*2.*1/i
    );
    assert.equal(loader._denseX, null);
  });

  await t.test('finite overflow is rejected before caching', async () => {
    const loader = denseLoader(dataset(
      new Float64Array([1e308]),
      { dtype: '<f8', shape: [1, 1] }
    ));
    await assert.rejects(
      loader.getGeneExpression('gene'),
      /dense X.*Float32 range/i
    );
    assert.equal(loader._denseX, null);
  });
});

test('H5AD preflights a sliced dense gene column before calling Dataset.slice', async () => {
  let sliceCalls = 0;
  const X = dataset(new Float32Array(0), {
    dtype: '<f4',
    shape: [140_000_000, 2],
    valueGetter() {
      throw new Error('full payload sentinel');
    },
  });
  X.slice = () => {
    sliceCalls++;
    throw new Error('slice sentinel');
  };
  const loader = new H5adLoader();
  loader._file = group({ X });
  loader._filename = 'wide-dense.h5ad';
  loader._nObs = 140_000_000;
  loader._nVars = 2;
  loader._varNames = ['GeneA', 'GeneB'];
  loader._varNameIndex = new Map([['GeneA', 0], ['GeneB', 1]]);
  loader._xIsSparse = false;

  await assert.rejects(
    loader.getGeneExpression('GeneA'),
    /dense X column.*working set.*server or prepared format/i
  );
  assert.equal(sliceCalls, 0);
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

test('H5AD preflights primitive observation output before reading payloads', async t => {
  const cases = [
    {
      dtype: '<f8',
      length: 50_000_000,
      metadata: { size: 8 },
      name: 'numeric',
      value: new Float64Array(0),
    },
    {
      dtype: '|b1',
      length: 60_000_000,
      metadata: {
        enum_type: { members: { FALSE: 0, TRUE: 1 } },
        size: 1,
      },
      name: 'boolean',
      value: new Uint8Array(0),
    },
    {
      dtype: 'O',
      length: 7_000_000,
      metadata: { cset: 1, size: 4, vlen: true },
      name: 'string',
      value: [],
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let payloadReads = 0;
      const field = dataset(scenario.value, {
        dtype: scenario.dtype,
        metadata: scenario.metadata,
        shape: [scenario.length],
        valueGetter() {
          payloadReads++;
          throw new Error('observation payload sentinel');
        },
      });
      const loader = loaderWithObs(
        { [scenario.name]: field },
        scenario.length
      );
      await assert.rejects(
        loader.getObsField(scenario.name),
        /observation field.*working set.*server or prepared format/i
      );
      assert.equal(payloadReads, 0);
    });
  }
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

test('H5AD preflights nullable-string JavaScript output before payload access', async () => {
  const length = 7_000_000;
  let valueReads = 0;
  let maskReads = 0;
  const values = dataset([], {
    dtype: 'O',
    metadata: { cset: 1, size: 8, vlen: true },
    shape: [length],
    valueGetter() {
      valueReads++;
      throw new Error('nullable string values payload sentinel');
    },
  });
  const mask = dataset(new Uint8Array(0), {
    dtype: '|b1',
    metadata: {
      enum_type: { members: { FALSE: 0, TRUE: 1 } },
      size: 1,
    },
    shape: [length],
    valueGetter() {
      maskReads++;
      throw new Error('nullable string mask payload sentinel');
    },
  });
  const loader = loaderWithObs({
    label: group(
      { values, mask },
      {
        'encoding-type': 'nullable-string-array',
        'encoding-version': '0.1.0',
      }
    ),
  }, length);

  await assert.rejects(
    loader.getObsField('label'),
    /nullable field.*working set.*server or prepared format/i
  );
  assert.equal(valueReads, 0);
  assert.equal(maskReads, 0);
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

test('H5AD measures actual nullable-string lengths before output allocation', async () => {
  const length = 610_000;
  const longValue = 'x'.repeat(400);
  const rawValues = new Proxy(
    { length },
    {
      get(target, property) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          return longValue;
        }
        return Reflect.get(target, property);
      }
    }
  );
  const loader = loaderWithObs({
    label: nullableField(
      'nullable-string-array',
      rawValues,
      new Uint8Array(length),
      {
        valuesDtype: 'O',
        valuesMetadata: { cset: 1, size: 8, vlen: true }
      }
    ),
  }, length);

  await assert.rejects(
    loader.getObsField('label'),
    /nullable string field.*working set.*server or prepared format/i
  );
  assert.equal(loader._cache.has('obs:label'), false);
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

    loader.getDatasetMetadata = async () => ({
      version: 2,
      stats: { n_cells: 2, n_genes: 0 },
      embeddings: {
        available_dimensions: [],
        default_dimension: null,
        obsm_keys: {}
      }
    });
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
  loader._obsmKeys = ['X_umap_2d'];
  loader.getEmbeddingShape = () => ({ shape: [1, 2], nDims: 2 });
  loader.hasConnectivities = async () => false;

  const metadata = await loader.getDatasetMetadata();
  assert.equal(metadata.stats.n_categorical_fields, 1);
  assert.equal(categoryReads, 0);
});

test('H5AD metadata accepts only exact dimension-suffixed UMAP keys', async t => {
  await t.test('an unsuffixed X_umap array is never shape-inferred', async () => {
    const loader = loaderWithObs({}, 2);
    loader._obsmKeys = ['X_umap'];
    let shapeReads = 0;
    loader.getEmbeddingShape = () => {
      shapeReads++;
      return { shape: [2, 2], nDims: 2 };
    };

    await assert.rejects(
      loader.getDatasetMetadata(),
      /exact UMAP.*X_umap_1d.*X_umap_2d.*X_umap_3d/i
    );
    assert.equal(shapeReads, 0);
  });

  await t.test('an explicit key is resolved without alias metadata', async () => {
    const loader = loaderWithObs({}, 2);
    loader._obsmKeys = ['X_umap', 'X_umap_2d'];
    const shapeReads = [];
    loader.getEmbeddingShape = key => {
      shapeReads.push(key);
      return { shape: [2, 2], nDims: 2 };
    };
    loader.hasConnectivities = async () => false;

    const metadata = await loader.getDatasetMetadata();
    assert.deepEqual(shapeReads, ['X_umap_2d']);
    assert.deepEqual(metadata.embeddings, {
      available_dimensions: [2],
      default_dimension: 2,
      obsm_keys: { '2d': 'X_umap_2d' },
    });
  });

  await t.test('a malformed explicit key cannot be skipped for another dimension', async () => {
    const loader = loaderWithObs({}, 2);
    loader._obsmKeys = ['X_umap_2d', 'X_umap_3d'];
    loader.getEmbeddingShape = key => (
      key === 'X_umap_2d'
        ? { shape: [2, 3], nDims: 3 }
        : { shape: [2, 3], nDims: 3 }
    );

    await assert.rejects(
      loader.getDatasetMetadata(),
      /X_umap_2d.*3 columns.*2D suffix/i
    );
  });
});

test('direct AnnData vector discovery requires dimension-suffixed obsm keys', async () => {
  const shapeReads = [];
  const adapter = new BaseAnnDataAdapter({
    obsmKeys: [
      'velocity_umap',
      'velocity_umap_2d',
      'drift_umap',
    ],
    getEmbeddingShape(key) {
      shapeReads.push(key);
      return { shape: [2, 2], nDims: 2 };
    },
  });
  adapter._metadata = {};

  await adapter._computeVectorFieldsMetadata();

  assert.deepEqual(shapeReads, ['velocity_umap_2d']);
  assert.deepEqual(adapter._metadata.vector_fields, {
    default_field: 'velocity_umap',
    fields: {
      velocity_umap: {
        label: 'Velocity (UMAP)',
        basis: 'umap',
        available_dimensions: [2],
        default_dimension: 2,
        obsm_keys: { '2d': 'velocity_umap_2d' },
      },
    },
  });
});

test('H5WASM initialization preserves the failure and leaves a later caller independent', async () => {
  const source = (await readFile(
    new URL('../assets/js/data/h5ad.js', import.meta.url),
    'utf8'
  )).replaceAll('\r\n', '\n');
  const start = source.indexOf('async function initH5wasm()');
  const end = source.indexOf(
    '/**\n * Check if h5wasm is available',
    start
  );
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
  scenario.loader.getDatasetMetadata = async () => ({
    version: 2,
    stats: { n_cells: 3, n_genes: 0 },
    embeddings: {
      available_dimensions: [],
      default_dimension: null,
      obsm_keys: {}
    }
  });
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
    shape: [65_536],
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
    /65,536 categories.*at most 65,535.*reduce or merge/i
  );
  assert.equal(payloadReads, 0);
});

test('CEL-AUDIT-0088 H5AD category ceiling rejects nullable metadata before payload access', async () => {
  let valueReads = 0;
  let maskReads = 0;
  const categories = group({
    values: dataset([], {
      dtype: 'O',
      shape: [65_536],
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
      shape: [65_536],
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
    /65,536 categories.*at most 65,535.*reduce or merge/i
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

test('CEL-AUDIT-0111 direct H5AD variable names include actual UTF-16 payload in the working set', async () => {
  const repeatedLongName = 'x'.repeat(4_096);
  const names = new Array(65_535).fill(repeatedLongName);
  let payloadReads = 0;
  const loader = new H5adLoader();
  loader._file = currentAnnData({
    obs: currentStringFrame([]),
    var: currentDataFrame({
      _index: dataset(names, {
        dtype: 'O',
        valueGetter() {
          payloadReads++;
          return names;
        },
      }),
    }, { indexKey: '_index', columnOrder: [] }),
  });

  await assert.rejects(
    loader._readStructure(),
    /variable index.*working set.*server or prepared format/i
  );
  assert.equal(payloadReads, 1);
  assert.deepEqual(loader.varNames, []);
});

test('CEL-AUDIT-0111 nullable H5AD variable names include actual UTF-16 payload in the working set', async () => {
  const repeatedLongName = 'x'.repeat(4_096);
  const names = new Array(65_535).fill(repeatedLongName);
  let valueReads = 0;
  const loader = new H5adLoader();
  loader._file = currentAnnData({
    obs: currentStringFrame([]),
    var: currentDataFrame({
      _index: group({
        values: dataset(names, {
          dtype: 'O',
          valueGetter() {
            valueReads++;
            return names;
          },
        }),
        mask: dataset(new Uint8Array(65_535), {
          dtype: '|b1',
          metadata: {
            enum_type: { members: { FALSE: 0, TRUE: 1 } },
            size: 1,
          },
        }),
      }, {
        'encoding-type': 'nullable-string-array',
        'encoding-version': '0.1.0',
      }),
    }, { indexKey: '_index', columnOrder: [] }),
  });

  await assert.rejects(
    loader._readStructure(),
    /variable index.*working set.*server or prepared format/i
  );
  assert.equal(valueReads, 1);
  assert.deepEqual(loader.varNames, []);
});

test('CEL-AUDIT-0111 direct H5AD categories include actual UTF-16 payload at the 65,535 boundary', async () => {
  const repeatedLongLabel = 'x'.repeat(4_096);
  const labels = new Array(65_535).fill(repeatedLongLabel);
  let payloadReads = 0;
  const loader = loaderWithObs({
    label: categoricalField(
      new Int8Array([0]),
      dataset(labels, {
        dtype: 'O',
        valueGetter() {
          payloadReads++;
          return labels;
        },
      })
    ),
  }, 1);

  await assert.rejects(
    loader.getObsFieldInfo('label'),
    /categorical categories.*working set.*server or prepared format/i
  );
  assert.equal(payloadReads, 1);
  assert.equal(loader._cache.has('obs_categories:label'), false);
});

test('H5AD preflights categorical codes before reading their payload', async () => {
  let codeReads = 0;
  const codes = dataset(new Int8Array(0), {
    dtype: '|b1',
    shape: [110_000_000],
    valueGetter() {
      codeReads++;
      throw new Error('categorical code sentinel');
    },
  });
  const loader = loaderWithObs({
    label: group({
      categories: dataset(['alpha'], { dtype: 'O' }),
      codes,
    }, {
      'encoding-type': 'categorical',
      'encoding-version': '0.2.0',
      ordered: false,
    }),
  }, 110_000_000);

  await assert.rejects(
    loader.getObsField('label'),
    /categorical codes.*working set.*server or prepared format/i
  );
  assert.equal(codeReads, 0);
});

test('CEL-AUDIT-0122 H5AD rejects PCA-only data instead of silently substituting it for UMAP', async () => {
  const loader = new H5adLoader();
  loader._file = currentAnnData({
    X: dataset(new Float32Array([1, 2]), {
      dtype: '<f4',
      shape: [2, 1],
    }),
    obs: currentStringFrame(['cell-a', 'cell-b']),
    var: currentStringFrame(['gene']),
    obsm: currentMapping({
      X_pca: dataset(
        new Float32Array([0, 0, 2, 2]),
        { dtype: '<f4', shape: [2, 2] }
      ),
    }),
  });
  loader._filename = 'pca-only.h5ad';
  await loader._readStructure();
  const adapter = new BaseAnnDataAdapter(loader);

  await assert.rejects(
    adapter.initialize(),
    /no exact UMAP embedding.*X_umap_1d.*X_umap_2d.*X_umap_3d/i
  );
  assert.equal(adapter.getMetadata(), null);
});

test('H5AD preflights retained loader and normalized public embedding storage', async () => {
  const nObs = 40_000_000;
  let payloadReads = 0;
  const loader = new H5adLoader();
  loader._file = group({
    obsm: currentMapping({
      X_umap_2d: dataset(new Int8Array(0), {
        dtype: '|i1',
        shape: [nObs, 2],
        valueGetter() {
          payloadReads++;
          throw new Error('embedding payload sentinel');
        },
      }),
    }),
  });
  loader._filename = 'oversized-public-embedding.h5ad';
  loader._nObs = nObs;
  loader._nVars = 0;
  loader._obsKeys = [];
  loader._obsmKeys = ['X_umap_2d'];
  const adapter = new BaseAnnDataAdapter(loader);

  await assert.rejects(
    adapter.initialize(),
    /embedding.*public working set.*server or prepared format/i
  );
  assert.equal(payloadReads, 0);
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
  loader._sparseXLoadPromise = pending.promise;

  const stale = loader.getGeneExpression('gene');
  const staleAssertion = assert.rejects(stale, INVALIDATED_REQUEST);
  loader.clearCache();
  pending.resolve({
    cscData: null,
    data: new Float32Array([7]),
    exactInteger: false,
    format: 'csc',
    indices: new Int32Array([0]),
    indptr: new Int32Array([0, 1]),
    shape: [1, 1],
  });

  await staleAssertion;
  assert.equal(loader._sparseX, null);
  assert.equal(loader._geneCache.size, 0);
});

test('H5AD gene LRU is bounded by retained bytes and resets its accounting', async () => {
  const X = dataset(new Float32Array([1, 2]), {
    dtype: '<f4',
    shape: [1, 2],
  });
  const loader = new H5adLoader();
  loader._file = group({ X });
  loader._filename = 'gene-lru.h5ad';
  loader._nObs = 1;
  loader._nVars = 2;
  loader._varNames = ['GeneA', 'GeneB'];
  loader._varNameIndex = new Map([['GeneA', 0], ['GeneB', 1]]);
  loader._xIsSparse = false;
  loader._geneCache.set('GeneA', {
    byteLength: 256 * 1024 * 1024,
  });
  loader._geneCacheBytes = 256 * 1024 * 1024;

  assert.deepEqual(
    Array.from(await loader.getGeneExpression('GeneB')),
    [2]
  );
  assert.deepEqual(Array.from(loader._geneCache.keys()), ['GeneB']);
  assert.equal(loader._geneCacheBytes, 4);

  loader.clearCache();
  assert.equal(loader._geneCache.size, 0);
  assert.equal(loader._geneCacheBytes, 0);
});

test('transactional H5AD loader adoption transfers gene-cache byte accounting', () => {
  const active = new H5adLoader();
  let activeCloseCalls = 0;
  active._file = {
    close() {
      activeCloseCalls++;
    },
  };
  active._geneCache.set('old', { byteLength: 123 });
  active._geneCacheBytes = 123;

  const candidate = new H5adLoader();
  const adoptedGene = { byteLength: 456 };
  candidate._file = { close() {} };
  candidate._filename = 'candidate.h5ad';
  candidate._geneCache.set('new', adoptedGene);
  candidate._geneCacheBytes = 456;

  assert.equal(typeof active._adoptCandidate, 'function');
  active._adoptCandidate(candidate);
  assert.equal(activeCloseCalls, 1);
  assert.deepEqual(Array.from(active._geneCache.entries()), [
    ['new', adoptedGene],
  ]);
  assert.equal(active._geneCacheBytes, 456);
  assert.equal(candidate._file, null);
});

test('H5AD rejects a wide CSR conversion peak before payload access', async () => {
  let payloadReads = 0;
  const unreadable = () => {
    payloadReads++;
    throw new Error('payload sentinel');
  };
  const X = group({
    data: dataset(new Float32Array(0), {
      dtype: '<f4',
      shape: [1],
      valueGetter: unreadable,
    }),
    indices: dataset(new Int32Array(0), {
      dtype: '<i4',
      shape: [1],
      valueGetter: unreadable,
    }),
    indptr: dataset(new Int32Array(0), {
      dtype: '<i4',
      shape: [2],
      valueGetter: unreadable,
    }),
  }, {
    'encoding-type': 'csr_matrix',
    'encoding-version': '0.1.0',
    shape: [1, 50_000_000],
  });
  const loader = loaderWithSparseX(X, {
    nObs: 1,
    nVars: 50_000_000,
  });

  await assert.rejects(
    loader.getGeneExpression('gene'),
    /sparse X.*working set.*browser limit/i
  );
  assert.equal(payloadReads, 0);
});

function sourceMetadata(name) {
  return {
    cellucid_data_version: 'h5ad_loader',
    description: 'test',
    embeddings: {
      available_dimensions: [2],
      default_dimension: 2,
      obsm_keys: { '2d': 'X_umap_2d' },
    },
    id: name,
    name,
    obs_fields: [],
    source: { filename: name, type: 'h5ad_loader' },
    stats: {
      has_connectivity: false,
      n_categorical_fields: 0,
      n_cells: 1,
      n_continuous_fields: 0,
      n_genes: 0,
      n_obs_fields: 0,
    },
    version: 2,
  };
}

async function withFakeH5adOpen(run) {
  const originalOpen = H5adLoader.prototype.open;
  const notificationCenter = getNotificationCenter();
  const notificationMethods = [
    'warning',
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

  notificationCenter.warning = (...args) => {
    warnings.push(args);
    return `warning-${warnings.length}`;
  };
  notificationCenter.startDownload = () => 'fake-download';
  notificationCenter.updateDownload = () => {};
  notificationCenter.completeDownload = () => {};
  notificationCenter.failDownload = () => {};
  notificationCenter.dismissDownload = () => {};
  H5adLoader.prototype.open = async function fakeOpen(file) {
    const record = {
      closeCalls: 0,
      loader: this,
      name: file.name,
    };
    records.set(file.name, record);
    this._file = {
      close() {
        record.closeCalls++;
      },
      keys() {
        return [];
      },
    };
    this._filename = file.name;
    this._nObs = 1;
    this._nVars = 0;
    this._obsKeys = [];
    this._obsmKeys = ['X_umap_2d'];
    this._varNames = [];
    this.getDatasetMetadata = async () => sourceMetadata(file.name);
    this.getEmbeddingShape = async key => {
      assert.equal(key, 'X_umap_2d');
      return { shape: [1, 2], nDims: 2 };
    };
    this.getEmbedding = async key => {
      assert.equal(key, 'X_umap_2d');
      if (file.corruptEmbedding) {
        throw new Error(`corrupt embedding payload in ${file.name}`);
      }
      return {
        data: new Float32Array([0, 0]),
        shape: [1, 2],
        nDims: 2
      };
    };

    if (file.fail) throw new Error(`invalid ${file.name}`);
    const pending = pendingByName.get(file.name);
    if (pending) await pending.promise;
  };

  try {
    await run({ pendingByName, records, warnings });
  } finally {
    H5adLoader.prototype.open = originalOpen;
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
      Array.from(await source.getEmbedding(2)),
      [0, 0]
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
  const originalOpen = H5adLoader.prototype.open;
  const originalWarning = notifications.warning;
  const olderGate = deferred();
  const openOptions = new Map();
  notifications.warning = () => {};
  t.after(() => {
    H5adLoader.prototype.open = originalOpen;
    notifications.warning = originalWarning;
  });

  H5adLoader.prototype.open = async function (file, options = {}) {
    openOptions.set(file.name, options);
    const ownsProgress = options.showProgress !== false;
    const trackerId = ownsProgress
      ? notifications.startDownload(`inner:${file.name}`)
      : null;
    this._file = {
      close() {},
      keys() {
        return [];
      },
    };
    this._filename = file.name;
    this._nObs = 1;
    this._nVars = 0;
    this._obsKeys = [];
    this._obsmKeys = ['X_umap_2d'];
    this._varNames = [];
    this.getDatasetMetadata = async () => sourceMetadata(file.name);
    this.getEmbeddingShape = async () => ({
      shape: [1, 2],
      nDims: 2,
    });
    this.getEmbedding = async () => ({
      data: new Float32Array([0, 0]),
      shape: [1, 2],
      nDims: 2,
    });

    if (file.name === 'older.h5ad') await olderGate.promise;
    if (trackerId) notifications.completeDownload(trackerId);
  };

  const source = new H5adDataSource();
  t.after(() => source.clear());
  const older = source.loadFromFile({ name: 'older.h5ad' });
  await Promise.resolve();
  const newer = await source.loadFromFile({ name: 'newer.h5ad' });
  olderGate.resolve();

  await assert.rejects(older, /superseded/i);
  assert.equal(newer.id, 'h5ad_newer');
  assert.equal(openOptions.get('older.h5ad').showProgress, false);
  assert.equal(openOptions.get('newer.h5ad').showProgress, false);
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

test('H5AD low-level open keeps direct progress opt-in by default', async t => {
  assert.equal(
    typeof H5adLoader.prototype._populateCandidateFromFile,
    'function',
    'public open needs a testable candidate-population seam'
  );
  const events = captureDownloadNotifications(t);
  const configure = (loader, gate = null) => {
    loader._populateCandidateFromFile = async (
      candidate,
      file,
      _totalBytes,
      _requestId,
      reportProgress
    ) => {
      candidate._file = { close() {} };
      candidate._filename = file.name;
      candidate._nObs = 1;
      candidate._nVars = 0;
      reportProgress(1, 1);
      if (gate) await gate.promise;
    };
  };

  const silent = new H5adLoader();
  configure(silent);
  await silent.open(
    { name: 'silent.h5ad', size: 1 },
    { showProgress: false }
  );
  assert.deepEqual(events, []);

  const direct = new H5adLoader();
  configure(direct);
  await direct.open({ name: 'direct.h5ad', size: 1 });
  assert.deepEqual(
    events.map(event => event.kind),
    ['start', 'update', 'complete']
  );

  events.length = 0;
  const overlapping = new H5adLoader();
  const olderGate = deferred();
  configure(overlapping);
  overlapping._populateCandidateFromFile = async (
    candidate,
    file,
    _totalBytes,
    _requestId,
    reportProgress
  ) => {
    candidate._file = { close() {} };
    candidate._filename = file.name;
    candidate._nObs = 1;
    candidate._nVars = 0;
    reportProgress(1, 1);
    if (file.name === 'older.h5ad') await olderGate.promise;
  };
  const older = overlapping.open({ name: 'older.h5ad', size: 1 });
  await Promise.resolve();
  await overlapping.open({ name: 'newer.h5ad', size: 1 });
  olderGate.resolve();
  await assert.rejects(older, /superseded/i);
  assert.deepEqual(
    events.map(event => event.kind),
    ['start', 'update', 'start', 'update', 'complete', 'dismiss']
  );
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
      await assert.rejects(loader.hasConnectivities(), expected);
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
  assert.equal(await loader.hasConnectivities(), true);
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

  assert.equal(await loader.hasConnectivities(), true);
  const result = await loader.getConnectivities();
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
    const result = await loader.getConnectivities();
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
    const result = await loader.getConnectivities();
    assert.equal(result.data instanceof Float64Array, true);
    assert.equal(result.data[0], weighted);
    const edges = extractConnectivityEdges(result, 2);
    assert.deepEqual(Array.from(edges.weights), [weighted]);
  });
});

test('H5AD rejects oversized dense connectivity before materializing it', async () => {
  let payloadReads = 0;
  const connectivities = dataset(new Float32Array(0), {
    dtype: '<f4',
    shape: [20_000, 20_000],
    valueGetter() {
      payloadReads++;
      throw new Error('payload sentinel');
    },
  });
  const loader = loaderWithConnectivity(connectivities, 20_000);

  await assert.rejects(
    loader.getConnectivities(),
    /(working set|browser limit|too large)/i
  );
  assert.equal(payloadReads, 0);
});

test('large dense H5AD gene access requires current slice support', async () => {
  let payloadReads = 0;
  const X = dataset(new Uint8Array(0), {
    dtype: '<B',
    shape: [20_000_000, 4],
    valueGetter() {
      payloadReads++;
      throw new Error('dense payload sentinel');
    },
  });
  const loader = new H5adLoader();
  loader._file = group({ X });
  loader._filename = 'large-dense.h5ad';
  loader._nObs = 20_000_000;
  loader._nVars = 4;
  loader._varNames = ['A', 'B', 'C', 'D'];
  loader._varNameIndex = new Map(
    loader._varNames.map((name, index) => [name, index])
  );

  await assert.rejects(
    loader.getGeneExpression('A'),
    /dense X.*slice.*required|slice.*dense X.*required/i
  );
  assert.equal(payloadReads, 0);
});
