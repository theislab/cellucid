import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as zarrCodecs from '../assets/js/data/zarr-codecs.js';
import {
  decodeLz4Block,
  decodeVLenUtf8,
  getZarrDtypeInfo
} from '../assets/js/data/zarr-codecs.js';
import * as zarrSourceModule from '../assets/js/data/zarr.js';
import * as zarrLoaderModule from '../assets/js/data/zarr-loader.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';
import { ZarrLoader } from '../assets/js/data/zarr-loader.js';

const zarrModule = { ...zarrSourceModule, ...zarrLoaderModule };
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import {
  buildCscFromCsr,
  extractConnectivityEdges,
  getSparseColumn
} from '../assets/js/data/sparse-utils.js';
import {
  EmbeddingLoadError,
  describeAnnDataProbes,
} from '../assets/js/data/data-mapping-candidates.js';
import { connectivityEdgesOf } from '../assets/js/data/sparse-utils.js';

/** One gene's column of X, found by its stored var name. */
function geneColumnByName(loader, name) {
  const index = loader.varNames.indexOf(name);
  assert.notEqual(index, -1, `gene '${name}' is on the var index`);
  return loader.getMatrixColumn('X', index);
}

/** One gene's values through a data source's adapter, found in its var manifest. */
async function sourceGeneValuesByName(source, name) {
  const manifest = await source.getVarManifest();
  const field = manifest.fields.find(([, fieldName]) => fieldName === name);
  assert.ok(field, `gene '${name}' is in the var manifest`);
  return source.getAdapter().getGeneValues(`var/${field[0]}.values.f32`);
}

/**
 * Call a private X column reader the way `getMatrixColumn` does: with the
 * resident X state (created when none is resident) and X's description.
 */
function readXColumn(loader, index, { sparse }) {
  loader._requireMatrixElement = async element => {
    assert.equal(element, 'X');
    return { path: 'X', label: 'X', sparse, nVars: loader._nVars };
  };
  return loader.getMatrixColumn('X', index);
}

/** Describe X without reading store metadata, for loaders built from stubs. */
function stubXElement(loader, { sparse, nVars }) {
  loader._requireMatrixElement = async element => {
    assert.equal(element, 'X');
    return { path: 'X', label: 'X', sparse, nVars };
  };
}

/** An adapter whose obsm entries are described from the loader's probes. */
async function adapterWithDescribedObsm(loader, options = {}) {
  const adapter = new BaseAnnDataAdapter(loader, options);
  adapter._describedObsm =
    describeAnnDataProbes(await loader.probeMapping()).obsm;
  return adapter;
}

/** Mapping probes for an obsm of dense arrays with the given widths. */
function obsmProbes(nObs, widths) {
  return {
    nObs,
    nVars: 0,
    obsm: Object.entries(widths).map(([key, width]) => ({
      key,
      storage: 'dense',
      shape: [nObs, width],
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

/**
 * Give a loader plottable mapping metadata: one 2-column X_umap_2d whose
 * reads return distinct values per cell.
 */
function stubPlottableObsm(loader, nObs) {
  loader.getDatasetMetadata = async () => ({
    stats: { n_cells: nObs, n_genes: 0 },
    probes: obsmProbes(nObs, { X_umap_2d: 2 }),
    obs_fields: [],
  });
  loader.readObsmColumns = async (_key, columns) => Float64Array.from(
    { length: nObs * columns.length },
    (_, index) => 10 * Math.floor(index / columns.length) +
      columns[index % columns.length]
  );
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

function littleEndianBytes(values, setter, bytesPerValue) {
  const bytes = new Uint8Array(values.length * bytesPerValue);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view[setter](index * bytesPerValue, value, true);
  });
  return bytes;
}

function vlenUtf8Bytes(values) {
  const encoder = new TextEncoder();
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

function sparseLoader({
  format = 'csr',
  shape = [2, 3],
  data = [1, 2],
  dataDtype = '<f4',
  dataBytes = littleEndianBytes(data, 'setFloat32', 4),
  indices = [0, 2],
  indptr = [0, 1, 2],
  indicesDtype = '<i4',
  indicesBytes = littleEndianBytes(indices, 'setInt32', 4)
} = {}) {
  const loader = new ZarrLoader();
  const files = new Map([
    ['.zgroup', memoryFile('{"zarr_format":2}')],
    ['.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'anndata',
      'encoding-version': '0.1.0'
    }))],
    ['X/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': `${format}_matrix`,
      'encoding-version': '0.1.0',
      shape
    }))],
    ['X/.zgroup', memoryFile('{"zarr_format":2}')],
    ['X/data/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [data.length],
      chunks: [Math.max(1, data.length)],
      dtype: dataDtype
    })))],
    ['X/data/0', memoryFile(dataBytes)],
    ['X/indices/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [indices.length],
      chunks: [Math.max(1, indices.length)],
      dtype: indicesDtype
    })))],
    ['X/indices/0', memoryFile(indicesBytes)],
    ['X/indptr/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [indptr.length],
      chunks: [indptr.length],
      dtype: '<i4'
    })))],
    ['X/indptr/0', memoryFile(littleEndianBytes(indptr, 'setInt32', 4))]
  ]);
  loader._files = files;
  return loader;
}

function connectivityLoader(options = {}, nObs = 2) {
  const loader = sparseLoader(options);
  loader._files = new Map(
    Array.from(loader._files, ([path, file]) => [
      path.replace(/^X(?=\/)/, 'obsp/connectivities'),
      file
    ])
  );
  setCurrentMapping(loader._files, 'obsp');
  loader._nObs = nObs;
  return loader;
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

function bytesFromHex(hex) {
  return Uint8Array.from(hex.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
}

function bytesFromBase64(base64) {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function memoryFile(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return {
    async text() {
      return new TextDecoder().decode(bytes);
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
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

function setCurrentArrayAttrs(files, path, meta, overrides = {}) {
  files.set(
    `${path}/.zattrs`,
    memoryFile(JSON.stringify(currentArrayAttrs(meta, overrides)))
  );
}

function setCurrentGroup(files, path, attrs) {
  files.set(`${path}/.zgroup`, memoryFile('{"zarr_format":2}'));
  files.set(`${path}/.zattrs`, memoryFile(JSON.stringify(attrs)));
}

function setCurrentMapping(files, path) {
  setCurrentGroup(files, path, {
    'encoding-type': 'dict',
    'encoding-version': '0.1.0',
  });
}

function deferredMemoryFile(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let markStarted;
  let releaseRead;
  const started = new Promise(resolve => {
    markStarted = resolve;
  });
  const released = new Promise(resolve => {
    releaseRead = resolve;
  });
  return {
    started,
    release() {
      releaseRead();
    },
    file: {
      async text() {
        return new TextDecoder().decode(bytes);
      },
      async arrayBuffer() {
        markStarted();
        await released;
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
    }
  };
}

function fileListFromMap(files, rootName) {
  return Array.from(files, ([path, file]) => ({
    name: path.split('/').at(-1),
    webkitRelativePath: `${rootName}/${path}`,
    size: Number.isFinite(file.size) ? file.size : 0,
    text: () => file.text(),
    arrayBuffer: () => file.arrayBuffer()
  }));
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

function arrayLoader(path, metadata, chunkFiles, attrs = null) {
  const loader = new ZarrLoader();
  loader._files = new Map([
    [`${path}/.zarray`, memoryFile(JSON.stringify(metadata))],
    [
      `${path}/.zattrs`,
      memoryFile(JSON.stringify(attrs ?? currentArrayAttrs(metadata)))
    ],
    ...Object.entries(chunkFiles).map(([chunkKey, bytes]) => [
      `${path}/${chunkKey}`,
      memoryFile(bytes)
    ])
  ]);
  return loader;
}

function canonicalObsDataframeAttrs(overrides = {}) {
  return {
    'encoding-type': 'dataframe',
    'encoding-version': '0.2.0',
    _index: '_index',
    'column-order': [],
    ...overrides
  };
}

function canonicalVarDataframeAttrs(overrides = {}) {
  return {
    'encoding-type': 'dataframe',
    'encoding-version': '0.2.0',
    _index: '_index',
    'column-order': [],
    ...overrides
  };
}

function denseStructureLoader({
  xShape = [2, 2],
  obsCount = 2,
  varNames = ['A', 'B']
} = {}) {
  const loader = new ZarrLoader();
  const xChunks = xShape.map(dimension => Math.max(1, dimension));
  const varCount = varNames.length;
  const obsNames = Array.from(
    { length: obsCount },
    (_, index) => `cell-${index}`
  );
  const files = new Map([
    ['.zgroup', memoryFile('{"zarr_format":2}')],
    ['.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'anndata',
      'encoding-version': '0.1.0'
    }))],
    ['X/.zarray', memoryFile(JSON.stringify(metadata({
      shape: xShape,
      chunks: xChunks,
      dtype: '<f4'
    })))],
    [
      'X/.zattrs',
      memoryFile(JSON.stringify(currentArrayAttrs({ dtype: '<f4' })))
    ],
    ['obs/.zgroup', memoryFile('{"zarr_format":2}')],
    [
      'obs/.zattrs',
      memoryFile(JSON.stringify(canonicalObsDataframeAttrs()))
    ],
    ['obs/_index/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [obsCount],
      chunks: [Math.max(1, obsCount)],
      dtype: '|O',
      filters: [{ id: 'vlen-utf8' }]
    })))],
    [
      'obs/_index/.zattrs',
      memoryFile(JSON.stringify(currentArrayAttrs({ dtype: '|O' })))
    ],
    ['var/.zgroup', memoryFile('{"zarr_format":2}')],
    [
      'var/.zattrs',
      memoryFile(JSON.stringify(canonicalVarDataframeAttrs()))
    ],
    ['var/_index/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [varCount],
      chunks: [Math.max(1, varCount)],
      dtype: '|O',
      filters: [{ id: 'vlen-utf8' }]
    })))],
    [
      'var/_index/.zattrs',
      memoryFile(JSON.stringify(currentArrayAttrs({ dtype: '|O' })))
    ]
  ]);
  if (obsCount > 0) {
    files.set('obs/_index/0', memoryFile(vlenUtf8Bytes(obsNames)));
  }
  if (varCount > 0) {
    files.set(
      'var/_index/0',
      memoryFile(vlenUtf8Bytes(varNames))
    );
  }
  loader._files = files;
  return loader;
}

function setNullableStringIndex(
  loader,
  axis,
  values,
  mask = new Uint8Array(values.length),
  valuesDtype = '|O'
) {
  const base = `${axis}/_index`;
  loader._files.delete(`${base}/.zarray`);
  loader._files.delete(`${base}/0`);
  loader._files.set(
    `${base}/.zgroup`,
    memoryFile('{"zarr_format":2}')
  );
  loader._files.set(
    `${base}/.zattrs`,
    memoryFile(JSON.stringify({
      'encoding-type': 'nullable-string-array',
      'encoding-version': '0.1.0'
    }))
  );
  loader._files.set(
    `${base}/values/.zarray`,
    memoryFile(JSON.stringify(metadata({
      shape: [values.length],
      chunks: [Math.max(1, values.length)],
      dtype: valuesDtype,
      fill_value: valuesDtype === '|O' ? 0 : 0,
      filters: valuesDtype === '|O' ? [{ id: 'vlen-utf8' }] : null
    })))
  );
  setCurrentArrayAttrs(
    loader._files,
    `${base}/values`,
    { dtype: valuesDtype }
  );
  loader._files.set(
    `${base}/values/0`,
    memoryFile(
      valuesDtype === '|O'
        ? vlenUtf8Bytes(values)
        : littleEndianBytes(values, 'setInt32', 4)
    )
  );
  loader._files.set(
    `${base}/mask/.zarray`,
    memoryFile(JSON.stringify(metadata({
      shape: [mask.length],
      chunks: [Math.max(1, mask.length)],
      dtype: '|b1',
      fill_value: false
    })))
  );
  setCurrentArrayAttrs(
    loader._files,
    `${base}/mask`,
    { dtype: '|b1' }
  );
  loader._files.set(`${base}/mask/0`, memoryFile(mask));
  return loader;
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

test('Zarr v2 arrays require exact mandatory metadata and defined absent-chunk fills', async t => {
  for (const key of ['compressor', 'fill_value', 'filters']) {
    await t.test(`missing ${key}`, () => {
      const candidate = metadata({});
      delete candidate[key];
      assert.throws(
        () => zarrCodecs.validateZarrArrayMetadata(candidate),
        new RegExp(`required.*${key}|${key}.*required`, 'i')
      );
    });
  }

  await t.test('object null compressor identity is unsupported', () => {
    assert.throws(
      () => zarrCodecs.validateZarrArrayMetadata(
        metadata({ compressor: { id: 'null' } })
      ),
      /compressor.*null.*unsupported|unsupported.*compressor.*null/i
    );
  });

  await t.test('null fill never becomes plausible numeric zeros', async () => {
    const meta = metadata({
      shape: [2],
      chunks: [2],
      dtype: '<f4',
      fill_value: null,
    });
    const loader = arrayLoader('values', meta, {});
    await assert.rejects(
      loader._readArray('values'),
      /absent.*chunk.*fill.*undefined|null.*fill.*absent.*chunk/i
    );
  });
});

test('AnnData string arrays require the exact Zarr object plus VLenUTF8 storage', async t => {
  const invalidCases = [
    [
      'fixed-width byte strings',
      metadata({
        shape: [1],
        chunks: [1],
        dtype: '|S1',
        fill_value: 'AA=='
      })
    ],
    [
      'object strings without VLenUTF8',
      metadata({
        shape: [1],
        chunks: [1],
        dtype: '|O',
        filters: null
      })
    ]
  ];

  for (const [name, meta] of invalidCases) {
    await t.test(name, async () => {
      const loader = arrayLoader('obs/label', meta, {});
      loader._nObs = 1;
      await assert.rejects(
        loader.getObsFieldInfo('label'),
        /string-array.*exact Zarr object dtype.*VLenUTF8|object dtype.*expected vlen-utf8/i
      );
    });
  }

  await t.test('exact VLenUTF8 storage is accepted', async () => {
    const meta = metadata({
      shape: [1],
      chunks: [1],
      dtype: '|O',
      filters: [{ id: 'vlen-utf8' }]
    });
    const loader = arrayLoader(
      'obs/label',
      meta,
      { 0: vlenUtf8Bytes(['α']) }
    );
    loader._nObs = 1;
    const field = await loader.getObsField('label');
    assert.equal(field.dtype, 'string');
    assert.deepEqual(field.values, ['α']);
  });
});

test('categorical ordered metadata is an own JSON boolean', async t => {
  const invalidAttrs = [
    [
      'missing ordered',
      {
        'encoding-type': 'categorical',
        'encoding-version': '0.2.0'
      }
    ],
    [
      'string ordered',
      {
        'encoding-type': 'categorical',
        'encoding-version': '0.2.0',
        ordered: 'false'
      }
    ],
    [
      'numeric ordered',
      {
        'encoding-type': 'categorical',
        'encoding-version': '0.2.0',
        ordered: 0
      }
    ],
    [
      'wrong categorical version',
      {
        'encoding-type': 'categorical',
        'encoding-version': '0.1.0',
        ordered: false
      }
    ]
  ];

  for (const [name, attrs] of invalidAttrs) {
    await t.test(name, async () => {
      const loader = new ZarrLoader();
      loader._files = new Map();
      setCurrentGroup(loader._files, 'obs/label', attrs);
      loader._nObs = 1;
      await assert.rejects(
        loader.getObsFieldInfo('label'),
        /ordered.*own boolean|encoding-version.*0\.2\.0/i
      );
    });
  }
});

test('group-valued AnnData elements require exact Zarr v2 group ownership', async t => {
  const representations = [
    {
      name: 'categorical',
      path: 'obs/label',
      makeLoader() {
        const loader = new ZarrLoader();
        loader._files = new Map();
        setCurrentGroup(loader._files, 'obs/label', {
          'encoding-type': 'categorical',
          'encoding-version': '0.2.0',
          ordered: false
        });
        loader._nObs = 1;
        return loader;
      },
      read: loader => loader.getObsFieldInfo('label')
    },
    {
      name: 'nullable',
      path: 'obs/count',
      makeLoader() {
        const loader = new ZarrLoader();
        loader._files = new Map();
        setCurrentGroup(loader._files, 'obs/count', {
          'encoding-type': 'nullable-integer',
          'encoding-version': '0.1.0'
        });
        loader._nObs = 1;
        return loader;
      },
      read: loader => loader.getObsFieldInfo('count')
    },
    {
      name: 'sparse',
      path: 'X',
      makeLoader: () => sparseLoader(),
      read: loader => loader._readSparseMetadataContract('X')
    }
  ];
  const invalidMarkers = [
    ['missing', (files, path) => files.delete(path)],
    [
      'malformed',
      (files, path) => files.set(path, memoryFile('{')),
    ],
    [
      'non-v2',
      (files, path) => files.set(
        path,
        memoryFile('{"zarr_format":3}')
      ),
    ]
  ];

  for (const representation of representations) {
    for (const [markerName, mutationFactory] of invalidMarkers) {
      await t.test(
        `${representation.name} ${markerName} marker`,
        async () => {
          const loader = representation.makeLoader();
          const markerPath = `${representation.path}/.zgroup`;
          mutationFactory(loader._files, markerPath);
          await assert.rejects(
            representation.read(loader),
            /\.zgroup.*(required|valid JSON|zarr_format.*2)/i
          );
        }
      );
    }
  }
});

function embeddingLoader({
  key = 'X_umap_2d',
  shape = [2, 2],
  chunks = shape.map(dimension => Math.max(1, dimension)),
  dtype = '<f4',
  values = [0, 0, 2, 4],
  nObs = 2,
  extraArrays = []
} = {}) {
  const loader = new ZarrLoader();
  const files = new Map([
    ['.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'anndata',
      'encoding-version': '0.1.0'
    }))],
    ['obsm/.zgroup', memoryFile('{"zarr_format":2}')],
    ['obsm/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'dict',
      'encoding-version': '0.1.0',
    }))],
    [`obsm/${key}/.zarray`, memoryFile(JSON.stringify(metadata({
      shape,
      chunks,
      dtype
    })))],
    [
      `obsm/${key}/.zattrs`,
      memoryFile(JSON.stringify(currentArrayAttrs({ dtype })))
    ],
    [`obsm/${key}/0.0`, memoryFile(littleEndianBytes(values, 'setFloat32', 4))]
  ]);

  for (const array of extraArrays) {
    const arrayChunks = array.chunks ??
      array.shape.map(dimension => Math.max(1, dimension));
    files.set(
      `obsm/${array.key}/.zarray`,
      memoryFile(JSON.stringify(metadata({
        shape: array.shape,
        chunks: arrayChunks,
        dtype: array.dtype ?? '<f4'
      })))
    );
    setCurrentArrayAttrs(
      files,
      `obsm/${array.key}`,
      { dtype: array.dtype ?? '<f4' }
    );
    if (array.values) {
      files.set(
        `obsm/${array.key}/0.0`,
        memoryFile(littleEndianBytes(array.values, 'setFloat32', 4))
      );
    }
  }

  loader._files = files;
  loader._rootName = 'fixture.zarr';
  loader._nObs = nObs;
  return loader;
}

function completeZarrStoreFiles({ embeddingValues, geneValues }) {
  const loader = denseStructureLoader();
  const files = new Map(loader._files);
  files.set(
    'X/0.0',
    memoryFile(littleEndianBytes(geneValues, 'setFloat32', 4))
  );
  setCurrentMapping(files, 'obsm');
  files.set(
    'obsm/X_umap_2d/.zarray',
    memoryFile(JSON.stringify(metadata({
      shape: [2, 2],
      chunks: [2, 2],
      dtype: '<f4'
    })))
  );
  setCurrentArrayAttrs(
    files,
    'obsm/X_umap_2d',
    { dtype: '<f4' }
  );
  files.set(
    'obsm/X_umap_2d/0.0',
    memoryFile(littleEndianBytes(embeddingValues, 'setFloat32', 4))
  );
  return files;
}

test('Zarr X=None does not advertise gene-expression fields', async () => {
  const withX = new ZarrLoader();
  withX._files = completeZarrStoreFiles({
    embeddingValues: [0, 0, 1, 1],
    geneValues: [1, 2, 3, 4]
  });
  assert.equal(withX.hasExpressionMatrix, true);

  const files = completeZarrStoreFiles({
    embeddingValues: [0, 0, 1, 1],
    geneValues: [1, 2, 3, 4]
  });
  files.delete('X/.zarray');
  files.delete('X/.zattrs');
  files.delete('X/0.0');

  const loader = new ZarrLoader();
  await loader.openFileMap(files, 'x-none.zarr');

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

test('rejects directory selections that omit required Zarr v2 metadata', async () => {
  const chunk = memoryFile(Uint8Array.from([1, 2, 3, 4]));
  const fileList = [{
    ...chunk,
    name: '0.0',
    webkitRelativePath: 'incomplete.zarr/X/0.0',
    size: 4
  }];
  const loader = new ZarrLoader();
  const notifications = getNotificationCenter();
  const notificationMethods = [
    'startDownload',
    'updateDownload',
    'completeDownload',
    'failDownload',
    'dismissDownload'
  ];
  const originals = new Map(
    notificationMethods.map(name => [name, notifications[name]])
  );
  notifications.startDownload = () => 'download';
  notifications.updateDownload = () => {};
  notifications.completeDownload = () => {};
  notifications.failDownload = () => {};
  notifications.dismissDownload = () => {};

  try {
    const { files, rootName } = zarrModule.zarrStoreFromFileList(fileList);
    await assert.rejects(
      loader.openFileMap(files, rootName),
      error => {
        assert.match(error.message, /browser.*omit|required.*metadata/i);
        assert.match(error.message, /Zarr ZIP/i);
        return true;
      }
    );
    assert.equal(loader.isOpen, false);
  } finally {
    loader.close();
    for (const [name, method] of originals) {
      notifications[name] = method;
    }
  }
});

test('reads AnnData default Blosc MEMCPY chunks and reverses VLenUTF8 filters', async () => {
  const loader = arrayLoader(
    'obs/cell_type/categories',
    metadata({
      shape: [3],
      chunks: [3],
      dtype: '|O',
      compressor: {
        id: 'blosc',
        cname: 'lz4',
        clevel: 5,
        shuffle: 1,
        blocksize: 0
      },
      filters: [{ id: 'vlen-utf8' }]
    }),
    {
      // Emitted by AnnData 0.11.4 / Zarr 2.18.3 / numcodecs 0.13.1.
      // The Blosc frame has MEMCPYED set and contains a VLenUTF8 payload.
      0: bytesFromHex(CANONICAL_VLEN_MEMCPY_HEX)
    }
  );

  const { data } = await loader._readArray('obs/cell_type/categories');
  assert.deepEqual(data, ['A', 'B', 'C']);
});

test('decodes a canonical mixed raw/LZ4 Blosc block and reverses byte shuffle', async () => {
  const loader = arrayLoader(
    'values',
    metadata({
      shape: [256],
      chunks: [256],
      compressor: {
        id: 'blosc',
        cname: 'lz4',
        clevel: 5,
        shuffle: 1,
        blocksize: 0
      }
    }),
    {
      // numcodecs 0.13.1 encoding of np.arange(256, dtype=np.int32).
      // SHA-256: 4bce9824199d121d940c7b73ccdb322c44067a242e3971098b828f3af9b22af3
      0: bytesFromBase64(CANONICAL_SPLIT_BLOSC_BASE64)
    }
  );

  const { data } = await loader._readArray('values');
  assert.deepEqual(Array.from(data), Array.from({ length: 256 }, (_, index) => index));
});

test('preserves canonical endian-neutral signed and unsigned one-byte dtypes', async () => {
  const signed = arrayLoader(
    'signed',
    metadata({ shape: [5], chunks: [5], dtype: '|i1' }),
    { 0: bytesFromHex('ff0001027f') }
  );
  const unsigned = arrayLoader(
    'unsigned',
    metadata({ shape: [5], chunks: [5], dtype: '|u1' }),
    { 0: bytesFromHex('000102faff') }
  );

  assert.deepEqual(
    Array.from((await signed._readArray('signed')).data),
    [-1, 0, 1, 2, 127]
  );
  assert.deepEqual(
    Array.from((await unsigned._readArray('unsigned')).data),
    [0, 1, 2, 250, 255]
  );
});

test('uses full declared chunk strides for overhanging Fortran-order edge chunks', async () => {
  const loader = arrayLoader(
    'obsm/X_fortran',
    metadata({
      shape: [5, 3],
      chunks: [3, 2],
      dtype: '<f4',
      order: 'F',
      dimension_separator: '.'
    }),
    {
      '0.0': bytesFromHex('0000803f000080400000e040000000400000a04000000041'),
      '0.1': bytesFromHex('000040400000c04000001041000000000000000000000000'),
      '1.0': bytesFromHex('000020410000504100000000000030410000604100000000'),
      '1.1': bytesFromHex('000040410000704100000000000000000000000000000000')
    }
  );

  assert.deepEqual(
    Array.from((await loader._readArray('obsm/X_fortran')).data),
    Array.from({ length: 15 }, (_, index) => index + 1)
  );
});

test('honors slash-separated multidimensional chunk keys', async () => {
  const loader = arrayLoader(
    'obsm/X_slash',
    metadata({
      shape: [5, 2],
      chunks: [3, 1],
      dtype: '<i2',
      dimension_separator: '/'
    }),
    {
      '0/0': bytesFromHex('650067006900'),
      '0/1': bytesFromHex('660068006a00'),
      '1/0': bytesFromHex('6b006d000000'),
      '1/1': bytesFromHex('6c006e000000')
    }
  );

  assert.deepEqual(
    Array.from((await loader._readArray('obsm/X_slash')).data),
    Array.from({ length: 10 }, (_, index) => index + 101)
  );
});

test('materializes declared fill values for absent chunks', async () => {
  const loader = arrayLoader(
    'obsm/X_missing_fill',
    metadata({
      shape: [5, 2],
      chunks: [3, 1],
      dtype: '<i2',
      fill_value: 7,
      dimension_separator: '.'
    }),
    {
      '0.0': bytesFromHex('0b000c000d00')
    }
  );

  assert.deepEqual(
    Array.from((await loader._readArray('obsm/X_missing_fill')).data),
    [11, 7, 12, 7, 13, 7, 7, 7, 7, 7]
  );
});

test('rejects unsupported dtypes and filters instead of returning plausible corruption', async () => {
  const unsupportedDtype = arrayLoader(
    'complex',
    metadata({ dtype: '<c8' }),
    { 0: bytesFromHex('0000000000000000') }
  );
  const unsupportedFilter = arrayLoader(
    'filtered',
    metadata({ filters: [{ id: 'delta' }] }),
    { 0: bytesFromHex('01000000') }
  );

  await assert.rejects(
    unsupportedDtype._readArray('complex'),
    /unsupported.*dtype/i
  );
  await assert.rejects(
    unsupportedFilter._readArray('filtered'),
    /unsupported.*filter/i
  );
  assert.throws(
    () => zarrCodecs.validateZarrArrayMetadata(metadata({
      dtype: '|S9007199254740993'
    })),
    /fixed string.*too large/i
  );
});

test('rejects Blosc metadata/header contradictions before returning values', async t => {
  await t.test('container version', async () => {
    const frame = bytesFromBase64(CANONICAL_SPLIT_BLOSC_BASE64);
    frame[0] = 1;
    const loader = arrayLoader(
      'values',
      metadata({
        shape: [256],
        chunks: [256],
        compressor: bloscLz4Metadata()
      }),
      { 0: frame }
    );
    await assert.rejects(loader._readArray('values'), /Blosc.*version/i);
  });

  await t.test('inner LZ4 version', async () => {
    const frame = bytesFromBase64(CANONICAL_SPLIT_BLOSC_BASE64);
    frame[1] = 2;
    const loader = arrayLoader(
      'values',
      metadata({
        shape: [256],
        chunks: [256],
        compressor: bloscLz4Metadata()
      }),
      { 0: frame }
    );
    await assert.rejects(loader._readArray('values'), /LZ4.*version/i);
  });

  await t.test('codec format even for MEMCPY frames', async () => {
    const frame = bytesFromHex(CANONICAL_VLEN_MEMCPY_HEX);
    frame[2] = (frame[2] & 0x1f) | (4 << 5);
    const loader = arrayLoader(
      'labels',
      metadata({
        shape: [3],
        chunks: [3],
        dtype: '|O',
        compressor: bloscLz4Metadata(),
        filters: [{ id: 'vlen-utf8' }]
      }),
      { 0: frame }
    );
    await assert.rejects(loader._readArray('labels'), /Blosc.*codec.*format/i);
  });

  await t.test('shuffle mode', async () => {
    const loader = arrayLoader(
      'labels',
      metadata({
        shape: [3],
        chunks: [3],
        dtype: '|O',
        compressor: bloscLz4Metadata({ shuffle: 0 }),
        filters: [{ id: 'vlen-utf8' }]
      }),
      { 0: bytesFromHex(CANONICAL_VLEN_MEMCPY_HEX) }
    );
    await assert.rejects(loader._readArray('labels'), /Blosc.*shuffle/i);
  });

  await t.test('numeric typesize', async () => {
    const frame = bytesFromHex(
      '02013301040000000400000014000000' +
      '01000000'
    );
    const loader = arrayLoader(
      'values',
      metadata({
        shape: [1],
        chunks: [1],
        compressor: bloscLz4Metadata()
      }),
      { 0: frame }
    );
    await assert.rejects(loader._readArray('values'), /Blosc.*typesize/i);
  });
});

test('treats Blosc metadata blocksize as an encoder hint, not a frame invariant', async () => {
  const loader = arrayLoader(
    'values',
    metadata({
      shape: [2500],
      chunks: [2500],
      compressor: bloscLz4Metadata({ blocksize: 1024 })
    }),
    { 0: bytesFromBase64(CANONICAL_BLOCKSIZE_HINT_BLOSC_BASE64) }
  );

  const { data } = await loader._readArray('values');
  assert.equal(data.length, 2500);
  assert.ok(data.every(value => value === 0));
});

test('rejects an LZ4 stream that omits the required final literal sequence', () => {
  assert.throws(
    () => decodeLz4Block(bytesFromHex('10410100'), 5),
    /final literal/i
  );
});

test('decodes a real multi-block Blosc chunk with a final partial unsplit block', async () => {
  const loader = arrayLoader(
    'values',
    metadata({
      shape: [70000],
      chunks: [70000],
      compressor: bloscLz4Metadata()
    }),
    { 0: bytesFromBase64(CANONICAL_MULTIBLOCK_BLOSC_BASE64) }
  );

  const { data } = await loader._readArray('values');
  assert.equal(data.length, 70000);
  assert.ok(data.every(value => value === 7));
});

test('accepts non-monotonic logical block offsets from parallel Blosc writers', async () => {
  const canonical = bytesFromBase64(CANONICAL_MULTIBLOCK_BLOSC_BASE64);
  const reordered = reorderBloscPhysicalBlocks(canonical, [1, 0]);
  const offsets = new DataView(reordered.buffer);
  assert.ok(
    offsets.getUint32(16, true) > offsets.getUint32(20, true),
    'logical block offsets must exercise physical order independent of logical order'
  );

  const loader = arrayLoader(
    'values',
    metadata({
      shape: [70000],
      chunks: [70000],
      compressor: bloscLz4Metadata()
    }),
    { 0: reordered }
  );
  const { data } = await loader._readArray('values');
  assert.equal(data.length, 70000);
  assert.ok(data.every(value => value === 7));
});

test('public observation APIs preserve signed bytes and classify booleans', async () => {
  const signed = arrayLoader(
    'obs/signed',
    metadata({ shape: [5], chunks: [5], dtype: '|i1' }),
    { 0: bytesFromHex('ff0001027f') }
  );
  const bool = arrayLoader(
    'obs/flag',
    metadata({ shape: [3], chunks: [3], dtype: '|b1' }),
    { 0: bytesFromHex('000101') }
  );
  signed._nObs = 5;
  bool._nObs = 3;

  assert.deepEqual(await signed.getObsFieldInfo('signed'), { dtype: 'int' });
  const signedField = await signed.getObsField('signed');
  assert.equal(signedField.dtype, 'int');
  assert.deepEqual(Array.from(signedField.values), [-1, 0, 1, 2, 127]);

  assert.deepEqual(await bool.getObsFieldInfo('flag'), { dtype: 'bool' });
  assert.deepEqual(await bool.getObsField('flag'), {
    dtype: 'bool',
    values: [false, true, true]
  });
});

test('rejects invalid boolean bytes and malformed fixed-string UTF-8', async () => {
  const bool = arrayLoader(
    'obs/flag',
    metadata({ shape: [2], chunks: [2], dtype: '|b1' }),
    { 0: bytesFromHex('0002') }
  );
  bool._nObs = 2;
  await assert.rejects(
    bool.getObsField('flag'),
    /boolean.*0 or 1/i
  );

  const text = arrayLoader(
    'labels',
    metadata({
      shape: [1],
      chunks: [1],
      dtype: '|S1',
      fill_value: 'AA=='
    }),
    { 0: bytesFromHex('ff') }
  );
  await assert.rejects(
    text._readArray('labels'),
    /fixed-string.*UTF-8/i
  );
});

test('preserves embedded NULs in fixed-width strings while trimming padding', async () => {
  const bytes = arrayLoader(
    'byte_labels',
    metadata({
      shape: [1],
      chunks: [1],
      dtype: '|S4',
      fill_value: 'AAAAAA=='
    }),
    { 0: Uint8Array.from([0x41, 0x00, 0x42, 0x00]) }
  );
  assert.deepEqual((await bytes._readArray('byte_labels')).data, ['A\u0000B']);

  const unicodeBytes = new Uint8Array(16);
  const unicodeView = new DataView(unicodeBytes.buffer);
  unicodeView.setUint32(0, 0x41, true);
  unicodeView.setUint32(4, 0x00, true);
  unicodeView.setUint32(8, 0x42, true);
  const unicode = arrayLoader(
    'unicode_labels',
    metadata({
      shape: [1],
      chunks: [1],
      dtype: '<U4',
      fill_value: ''
    }),
    { 0: unicodeBytes }
  );
  assert.deepEqual((await unicode._readArray('unicode_labels')).data, ['A\u0000B']);
});

test('rejects categorical codes outside missing-or-category bounds', async () => {
  const loader = new ZarrLoader();
  loader._files = new Map([
    ['obs/cell_type/.zgroup', memoryFile('{"zarr_format":2}')],
    ['obs/cell_type/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'categorical',
      'encoding-version': '0.2.0',
      ordered: false
    }))],
    ['obs/cell_type/categories/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [2],
      chunks: [2],
      dtype: '|O',
      filters: [{ id: 'vlen-utf8' }]
    })))],
    ['obs/cell_type/categories/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'string-array',
      'encoding-version': '0.2.0'
    }))],
    ['obs/cell_type/categories/0', memoryFile(vlenUtf8Bytes(['A', 'B']))],
    ['obs/cell_type/codes/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [2],
      chunks: [2],
      dtype: '|i1'
    })))],
    ['obs/cell_type/codes/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'array',
      'encoding-version': '0.2.0'
    }))],
    ['obs/cell_type/codes/0', memoryFile(Uint8Array.from([0, 2]))]
  ]);
  loader._nObs = 2;

  await assert.rejects(
    loader.getObsField('cell_type'),
    /categorical code.*bounds/i
  );
});

test('requires a signed-integer dtype for categorical codes', async () => {
  const loader = new ZarrLoader();
  loader._files = new Map([
    ['obs/cell_type/.zgroup', memoryFile('{"zarr_format":2}')],
    ['obs/cell_type/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'categorical',
      'encoding-version': '0.2.0',
      ordered: false
    }))],
    ['obs/cell_type/categories/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [2],
      chunks: [2],
      dtype: '|O',
      filters: [{ id: 'vlen-utf8' }]
    })))],
    ['obs/cell_type/categories/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'string-array',
      'encoding-version': '0.2.0'
    }))],
    ['obs/cell_type/categories/0', memoryFile(vlenUtf8Bytes(['A', 'B']))],
    ['obs/cell_type/codes/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [2],
      chunks: [2],
      dtype: '<f4'
    })))],
    ['obs/cell_type/codes/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'array',
      'encoding-version': '0.2.0'
    }))],
    ['obs/cell_type/codes/0', memoryFile(
      littleEndianBytes([0, 1], 'setFloat32', 4)
    )]
  ]);
  loader._nObs = 2;

  await assert.rejects(
    loader.getObsFieldInfo('cell_type'),
    /categorical codes.*signed integer dtype/i
  );
  await assert.rejects(
    loader.getObsField('cell_type'),
    /categorical codes.*signed integer dtype/i
  );
});

test('rejects oversized category dictionaries before code or label payloads', async () => {
  const loader = new ZarrLoader();
  loader._files = new Map([
    ['obs/group/.zgroup', memoryFile('{"zarr_format":2}')],
    ['obs/group/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'categorical',
      'encoding-version': '0.2.0',
      ordered: false
    }))],
    ['obs/group/codes/.zarray', memoryFile('{}')],
    ['obs/group/categories/.zarray', memoryFile('{}')]
  ]);
  loader._nObs = 1;
  loader._readAttrs = async path => path === 'obs/group'
    ? {
        'encoding-type': 'categorical',
        'encoding-version': '0.2.0',
        ordered: false
      }
    : {
        'encoding-type': 'array',
        'encoding-version': '0.2.0'
      };
  loader._readArrayMeta = async path => metadata(
    path.endsWith('/codes')
      ? {
          shape: [1],
          chunks: [1],
          dtype: '|i1'
        }
      : {
          shape: [4_294_967_296],
          chunks: [1_048_576],
          dtype: '<i4'
        }
  );
  const payloadPaths = [];
  loader._readArray = async path => {
    payloadPaths.push(path);
    throw new Error(`categorical payload '${path}' touched before category-count preflight`);
  };

  for (const read of [
    () => loader.getObsFieldInfo('group'),
    () => loader.getObsField('group')
  ]) {
    await assert.rejects(
      read(),
      /4,294,967,296 categories.*at most 4,294,967,295.*reduce or merge/i
    );
  }
  assert.deepEqual(payloadPaths, []);
});

test('reuses the validated categorical dictionary between info and field loads', async () => {
  const loader = new ZarrLoader();
  loader._files = new Map([
    ['obs/group/.zgroup', memoryFile('{"zarr_format":2}')],
    ['obs/group/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'categorical',
      'encoding-version': '0.2.0',
      ordered: false
    }))],
    ['obs/group/codes/.zarray', memoryFile('{}')],
    ['obs/group/categories/.zarray', memoryFile('{}')]
  ]);
  loader._nObs = 2;
  loader._readAttrs = async path => path === 'obs/group'
    ? {
        'encoding-type': 'categorical',
        'encoding-version': '0.2.0',
        ordered: false
      }
    : {
        'encoding-type': path.endsWith('/categories')
          ? 'string-array'
          : 'array',
        'encoding-version': '0.2.0'
      };
  loader._readArrayMeta = async path => metadata(
    path.endsWith('/codes')
      ? {
          shape: [2],
          chunks: [2],
          dtype: '|i1'
        }
      : {
          shape: [2],
          chunks: [2],
          dtype: '|O',
          filters: [{ id: 'vlen-utf8' }]
        }
  );
  const payloadPaths = [];
  loader._readArray = async path => {
    payloadPaths.push(path);
    if (path.endsWith('/categories')) {
      return {
        data: ['A', 'B'],
        shape: [2],
        dtype: '|O'
      };
    }
    return {
      data: Int8Array.from([0, 1]),
      shape: [2],
      dtype: '|i1'
    };
  };

  const info = await loader.getObsFieldInfo('group');
  const field = await loader.getObsField('group');

  assert.equal(
    payloadPaths.filter(path => path.endsWith('/categories')).length,
    1
  );
  assert.strictEqual(field.categories, info.categories);
  assert.deepEqual(Array.from(field.codes), [0, 1]);
});

test('Zarr dataset metadata counts categorical fields without label payloads', async () => {
  const loader = new ZarrLoader();
  loader._files = new Map([
    ['obs/label/.zgroup', memoryFile('{"zarr_format":2}')],
    ['obs/label/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'categorical',
      'encoding-version': '0.2.0',
      ordered: false
    }))],
    ['obs/label/codes/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [1],
      chunks: [1],
      dtype: '|i1'
    })))],
    ['obs/label/codes/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'array',
      'encoding-version': '0.2.0'
    }))],
    ['obs/label/codes/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'array',
      'encoding-version': '0.2.0'
    }))],
    ['obs/label/categories/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [1],
      chunks: [1],
      dtype: '|O',
      filters: [{ id: 'vlen-utf8' }]
    })))],
    ['obs/label/categories/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'string-array',
      'encoding-version': '0.2.0'
    }))]
  ]);
  loader._rootName = 'metadata-only.zarr';
  loader._nObs = 1;
  loader._obsKeys = ['label'];
  const probes = obsmProbes(1, { X_umap_2d: 2 });
  loader.probeMapping = async () => probes;
  loader.hasConnectivities = async () => false;
  let categoryReads = 0;
  loader._readCategoricalCategories = async () => {
    categoryReads++;
    throw new Error('metadata category payload sentinel');
  };

  const dataset = await loader.getDatasetMetadata();
  assert.equal(dataset.stats.n_categorical_fields, 1);
  assert.strictEqual(dataset.probes, probes);
  assert.equal(Object.hasOwn(dataset, 'embeddings'), false);
  assert.equal(categoryReads, 0);
});

test('Zarr adapter reuses retained categories after loader cache clearing', async () => {
  const loader = new ZarrLoader();
  loader._files = new Map([
    ['obs/label/.zgroup', memoryFile('{"zarr_format":2}')],
    ['obs/label/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'categorical',
      'encoding-version': '0.2.0',
      ordered: true
    }))],
    ['obs/label/codes/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [2],
      chunks: [2],
      dtype: '|i1'
    })))],
    ['obs/label/codes/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'array',
      'encoding-version': '0.2.0'
    }))],
    ['obs/label/categories/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [1],
      chunks: [1],
      dtype: '|O',
      filters: [{ id: 'vlen-utf8' }]
    })))],
    ['obs/label/categories/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'string-array',
      'encoding-version': '0.2.0'
    }))]
  ]);
  loader._rootName = 'retained-categories.zarr';
  // Two cells: one cell has no coordinate variation to plot.
  loader._nObs = 2;
  loader._obsKeys = ['label'];
  stubPlottableObsm(loader, 2);
  let categoryReads = 0;
  loader._readArray = async path => {
    if (path.endsWith('/categories')) {
      categoryReads++;
      return { data: ['A'], shape: [1], dtype: '|O' };
    }
    return {
      data: Int8Array.from([0, 0]),
      shape: [2],
      dtype: '|i1'
    };
  };

  const adapter = new BaseAnnDataAdapter(loader);
  await adapter.initialize();
  const canonicalCategories =
    adapter._obsFieldsMetadata[0].categories;
  assert.equal(categoryReads, 1);
  assert.equal(adapter._obsFieldsMetadata[0].ordered, true);

  adapter.clearCaches();
  loader.clearCache();
  const field = await adapter.getObsFieldData('label');

  assert.strictEqual(field.categories, canonicalCategories);
  assert.equal(field.ordered, true);
  assert.equal(categoryReads, 1);
  assert.equal(loader._cache.has('obs:label'), false);
  assert.equal(loader._cache.has('obs_info:label'), false);
});

test('preserves numeric and boolean AnnData categorical categories', async t => {
  const cases = [
    {
      name: 'numeric',
      dtype: '<f4',
      bytes: littleEndianBytes([1.5, 2.25], 'setFloat32', 4),
      expected: [1.5, 2.25]
    },
    {
      name: 'int64 numeric',
      dtype: '<i8',
      bytes: littleEndianBytes([-4n, 9n], 'setBigInt64', 8),
      expected: [-4, 9]
    },
    {
      name: 'boolean',
      dtype: '|b1',
      bytes: Uint8Array.from([0, 1]),
      expected: [false, true]
    }
  ];

  for (const categoryCase of cases) {
    await t.test(categoryCase.name, async () => {
      const loader = new ZarrLoader();
      loader._files = new Map([
        ['obs/group/.zgroup', memoryFile('{"zarr_format":2}')],
        ['obs/group/.zattrs', memoryFile(JSON.stringify({
          'encoding-type': 'categorical',
          'encoding-version': '0.2.0',
          ordered: false
        }))],
        ['obs/group/categories/.zarray', memoryFile(JSON.stringify(metadata({
          shape: [2],
          chunks: [2],
          dtype: categoryCase.dtype
        })))],
        ['obs/group/categories/.zattrs', memoryFile(JSON.stringify({
          'encoding-type': 'array',
          'encoding-version': '0.2.0'
        }))],
        ['obs/group/categories/0', memoryFile(categoryCase.bytes)],
        ['obs/group/codes/.zarray', memoryFile(JSON.stringify(metadata({
          shape: [3],
          chunks: [3],
          dtype: '|i1'
        })))],
        ['obs/group/codes/.zattrs', memoryFile(JSON.stringify({
          'encoding-type': 'array',
          'encoding-version': '0.2.0'
        }))],
        ['obs/group/codes/0', memoryFile(Uint8Array.from([0, 1, 255]))]
      ]);
      loader._nObs = 3;

      assert.deepEqual(
        (await loader.getObsFieldInfo('group')).categories,
        categoryCase.expected
      );
      const field = await loader.getObsField('group');
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
    {
      name: 'string',
      dtype: '|O',
      fillValue: 0,
      filters: [{ id: 'vlen-utf8' }],
      bytes: vlenUtf8Bytes(['A', 'A'])
    },
    {
      name: 'number',
      dtype: '<f4',
      fillValue: 0,
      bytes: littleEndianBytes([7, 7], 'setFloat32', 4)
    },
    {
      name: 'boolean',
      dtype: '|b1',
      fillValue: false,
      bytes: Uint8Array.from([0, 0])
    }
  ];

  for (const categoryCase of cases) {
    await t.test(categoryCase.name, async () => {
      const loader = new ZarrLoader();
      loader._files = new Map([
        ['obs/group/.zgroup', memoryFile('{"zarr_format":2}')],
        ['obs/group/.zattrs', memoryFile(JSON.stringify({
          'encoding-type': 'categorical',
          'encoding-version': '0.2.0',
          ordered: false
        }))],
        ['obs/group/categories/.zarray', memoryFile(JSON.stringify(metadata({
          shape: [2],
          chunks: [2],
          dtype: categoryCase.dtype,
          fill_value: categoryCase.fillValue,
          filters: categoryCase.filters ?? null
        })))],
        ['obs/group/categories/.zattrs', memoryFile(JSON.stringify(
          currentArrayAttrs({ dtype: categoryCase.dtype })
        ))],
        ['obs/group/categories/0', memoryFile(categoryCase.bytes)],
        ['obs/group/codes/.zarray', memoryFile(JSON.stringify(metadata({
          shape: [1],
          chunks: [1],
          dtype: '|i1'
        })))],
        ['obs/group/codes/.zattrs', memoryFile(JSON.stringify(
          currentArrayAttrs({ dtype: '|i1' })
        ))],
        ['obs/group/codes/0', memoryFile(Uint8Array.from([0]))]
      ]);
      loader._nObs = 1;

      await assert.rejects(
        loader.getObsFieldInfo('group'),
        /categorical categories.*group.*duplicate.*label/i
      );
      assert.equal(loader._cache.has('obs_info:group'), false);
    });
  }
});

test('rejects malformed boolean categorical categories', async () => {
  const loader = new ZarrLoader();
  loader._files = new Map([
    ['obs/group/.zgroup', memoryFile('{"zarr_format":2}')],
    ['obs/group/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'categorical',
      'encoding-version': '0.2.0',
      ordered: false
    }))],
    ['obs/group/categories/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [1],
      chunks: [1],
      dtype: '|b1'
    })))],
    ['obs/group/categories/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'array',
      'encoding-version': '0.2.0'
    }))],
    ['obs/group/categories/0', memoryFile(Uint8Array.from([2]))],
    ['obs/group/codes/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [1],
      chunks: [1],
      dtype: '|i1'
    })))],
    ['obs/group/codes/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'array',
      'encoding-version': '0.2.0'
    }))],
    ['obs/group/codes/0', memoryFile(Uint8Array.from([0]))]
  ]);
  loader._nObs = 1;

  await assert.rejects(
    loader.getObsField('group'),
    /boolean.*0 or 1/i
  );
});

test('rejects out-of-range integer fill values instead of TypedArray wraparound', async t => {
  const cases = [
    ['uint8 negative', '|u1', -1],
    ['uint8 overflow', '|u1', 300],
    ['int8 overflow', '|i1', 128],
    ['uint64 overflow', '<u8', '18446744073709551616']
  ];

  for (const [name, dtype, fillValue] of cases) {
    await t.test(name, async () => {
      const loader = arrayLoader(
        'values',
        metadata({
          shape: [1],
          chunks: [1],
          dtype,
          fill_value: fillValue
        }),
        {}
      );
      await assert.rejects(loader._readArray('values'), /fill_value.*range/i);
    });
  }
});

test('rejects lossy int64 fill metadata parsed beyond JSON safe integers', async () => {
  const loader = new ZarrLoader();
  loader._files = new Map([
    ['values/.zarray', memoryFile(
      '{"zarr_format":2,"shape":[1],"chunks":[1],"dtype":"<i8",' +
      '"compressor":null,"fill_value":9007199254740993,"filters":null,"order":"C"}'
    )],
    ['values/.zattrs', memoryFile('{}')]
  ]);

  await assert.rejects(
    loader._readArray('values'),
    /fill_value.*safe integer/i
  );
});

test('decodes canonical short Base64 fixed-byte-string fills', async () => {
  for (const [fillValue, expected] of [['', ''], ['YQ==', 'a']]) {
    const loader = arrayLoader(
      'labels',
      metadata({
        shape: [1],
        chunks: [1],
        dtype: '|S3',
        fill_value: fillValue
      }),
      {}
    );
    assert.deepEqual((await loader._readArray('labels')).data, [expected]);
  }

  const oversized = arrayLoader(
    'labels',
    metadata({
      shape: [1],
      chunks: [1],
      dtype: '|S3',
      fill_value: 'YWJjZA=='
    }),
    {}
  );
  await assert.rejects(
    oversized._readArray('labels'),
    /Base64 fill_value size/i
  );
});

test('truncates fixed-Unicode fills by code point to the declared width', async () => {
  const loader = arrayLoader(
    'labels',
    metadata({
      shape: [1],
      chunks: [1],
      dtype: '<U1',
      fill_value: '😀B'
    }),
    {}
  );

  assert.deepEqual((await loader._readArray('labels')).data, ['😀']);

  const padded = arrayLoader(
    'padded_labels',
    metadata({
      shape: [1],
      chunks: [1],
      dtype: '<U3',
      fill_value: 'A\u0000'
    }),
    {}
  );
  assert.deepEqual((await padded._readArray('padded_labels')).data, ['A']);
});

test('rejects unpaired surrogates in fixed-Unicode fill metadata', async () => {
  const invalid = arrayLoader(
    'invalid_labels',
    metadata({
      shape: [1],
      chunks: [1],
      dtype: '<U1',
      fill_value: '\ud800'
    }),
    {}
  );
  await assert.rejects(
    invalid._readArray('invalid_labels'),
    /invalid Unicode fill_value/i
  );
});

test('VLen item counts are bounded by their payload, and chunks by their declared shape alone', async t => {
  assert.throws(
    () => decodeVLenUtf8(bytesFromHex('ffffff7f'), 0x7fffffff),
    /item count exceeds payload bounds/i
  );

  await t.test('no array size, chunk count or chunk size is refused for being large', () => {
    for (const meta of [
      metadata({ shape: [600_000_000], chunks: [1], dtype: '|u1' }),
      metadata({ shape: [134_217_728], chunks: [16_777_216], dtype: '<f4' }),
      metadata({ shape: [40_000_000], chunks: [8_000_000], dtype: '|S8' }),
      metadata({ shape: [100_001], chunks: [1] }),
      metadata({ shape: [1], chunks: [16_777_217], dtype: '<i4' }),
    ]) {
      assert.doesNotThrow(() => zarrCodecs.validateZarrArrayMetadata(meta));
    }
    assert.equal(zarrCodecs.validateZarrMaterialization, undefined);
    assert.equal(zarrCodecs.MAX_ZARR_CHUNK_BYTES, undefined);
  });

  await t.test('a fixed-width chunk decodes to exactly its declared size', async () => {
    const meta = metadata({ shape: [4], chunks: [4], dtype: '<i4', compressor: null });
    await assert.rejects(
      zarrCodecs.decodeZarrChunk(new Uint8Array(12), meta, getZarrDtypeInfo('<i4'), 4),
      /decoded 12 bytes; expected 16/i
    );
  });

  await t.test('a compressed string chunk is bounded by its codec, not a constant', async () => {
    const { gzipSync } = await import('node:zlib');
    const payload = new Uint8Array(4 + 4 + 3);
    const view = new DataView(payload.buffer);
    view.setUint32(0, 1, true);
    view.setUint32(4, 3, true);
    payload.set([0x61, 0x62, 0x63], 8);
    const decoded = await zarrCodecs.decodeZarrChunk(
      gzipSync(payload),
      metadata({
        shape: [1],
        chunks: [1],
        dtype: '|O',
        filters: [{ id: 'vlen-utf8' }],
        compressor: { id: 'gzip', level: 1 },
      }),
      getZarrDtypeInfo('|O'),
      1
    );
    assert.deepEqual(decoded, ['abc']);
  });
});

test('validates fill metadata in an allocation-free array plan', () => {
  assert.equal(typeof zarrModule.prepareZarrArrayAllocation, 'function');
  for (const [dtype, fillValue] of [['|u1', -1], ['|S1', 'not Base64']]) {
    assert.throws(
      () => zarrModule.prepareZarrArrayAllocation(metadata({
        shape: [60_000_000],
        chunks: [600],
        dtype,
        fill_value: fillValue
      })),
      /fill_value/i
    );
  }
});

test('bounds extended LZ4 lengths against remaining output during parsing', () => {
  assert.throws(
    () => decodeLz4Block(
      Uint8Array.from([0xf0, ...new Array(20).fill(0xff), 0x00]),
      10
    ),
    /length exceeds output/i
  );
});

test('supports overlapping LZ4 matches followed by a final literal sequence', () => {
  assert.deepEqual(
    Array.from(decodeLz4Block(bytesFromHex('106101001058'), 6)),
    [97, 97, 97, 97, 97, 88]
  );
});

test('converts safe dense int64 gene expression and rejects lossy values', async () => {
  const safe = arrayLoader(
    'X',
    metadata({ shape: [2, 1], chunks: [2, 1], dtype: '<i8' }),
    {
      '0.0': littleEndianBytes([1n, 2n], 'setBigInt64', 8)
    }
  );
  safe._nObs = 2;
  safe._nVars = 1;
  assert.deepEqual(Array.from(await readXColumn(safe, 0, { sparse: false })), [1, 2]);

  const unsafe = arrayLoader(
    'X',
    metadata({ shape: [1, 1], chunks: [1, 1], dtype: '<i8' }),
    {
      '0.0': littleEndianBytes([9007199254740992n], 'setBigInt64', 8)
    }
  );
  unsafe._nObs = 1;
  unsafe._nVars = 1;
  await assert.rejects(
    readXColumn(unsafe, 0, { sparse: false }),
    /dense X.*safe numeric range/i
  );
});

function streamedDenseStripLoader() {
  // Float32 output beyond the full-matrix cache, so genes stream by strip:
  // two chunk rows of one 700-column strip hold genes 0-699.
  const nRows = 4;
  const nCols = 35_000_000;
  const chunk = rowOffset => Uint8Array.from(
    { length: 2 * 700 },
    (unused, index) => (rowOffset + Math.floor(index / 700)) * 10 + (index % 700) % 10
  );
  const loader = arrayLoader(
    'X',
    metadata({
      shape: [nRows, nCols],
      chunks: [2, 700],
      dtype: '|u1'
    }),
    { '0.0': chunk(0), '1.0': chunk(2) }
  );
  loader._nObs = nRows;
  loader._nVars = nCols;
  const chunkReads = [];
  const readChunkFile = loader._readChunkFile.bind(loader);
  loader._readChunkFile = path => {
    chunkReads.push(path);
    return readChunkFile(path);
  };
  loader._readArray = async () => {
    throw new Error('full dense cache must not be materialized');
  };
  return { chunkReads, loader };
}

test('genes of one dense chunk strip decode each chunk once', async () => {
  const { chunkReads, loader } = streamedDenseStripLoader();

  assert.deepEqual(
    Array.from(await loader.getMatrixColumn('X', 0)),
    [0, 10, 20, 30]
  );
  assert.deepEqual(
    Array.from(await loader.getMatrixColumn('X', 1)),
    [1, 11, 21, 31]
  );
  assert.deepEqual(chunkReads, ['X/0.0', 'X/1.0']);
  assert.equal(loader._decodedXBlocks.retainedBytes, 2 * 2 * 700);

  // Concurrent genes of the same strip share the retained chunks too.
  loader._decodedXBlocks.clear();
  chunkReads.length = 0;
  const [geneA, geneC] = await Promise.all([
    loader.getMatrixColumn('X', 0),
    loader.getMatrixColumn('X', 2)
  ]);
  assert.deepEqual(Array.from(geneA), [0, 10, 20, 30]);
  assert.deepEqual(Array.from(geneC), [2, 12, 22, 32]);
  assert.deepEqual(chunkReads, ['X/0.0', 'X/1.0']);
});

test('a failed dense chunk decode is not retained for the next gene', async () => {
  const { chunkReads, loader } = streamedDenseStripLoader();
  const readChunkFile = loader._readChunkFile;
  let failNext = true;
  loader._readChunkFile = path => {
    if (failNext && path === 'X/1.0') {
      failNext = false;
      chunkReads.push(path);
      return Promise.reject(new Error('chunk read failed'));
    }
    return readChunkFile(path);
  };
  await assert.rejects(loader.getMatrixColumn('X', 0), /chunk read failed/);
  assert.deepEqual(
    Array.from(await loader.getMatrixColumn('X', 0)),
    [0, 10, 20, 30]
  );
  assert.deepEqual(chunkReads, ['X/0.0', 'X/1.0', 'X/1.0']);
});

test('decoded dense chunks are released when the dataset is cleared or closed', async () => {
  const { loader } = streamedDenseStripLoader();
  await loader.getMatrixColumn('X', 0);
  assert.ok(loader._decodedXBlocks.retainedBytes > 0);
  loader.clearCache();
  assert.equal(loader._decodedXBlocks.retainedBytes, 0);

  const { loader: closing } = streamedDenseStripLoader();
  await closing.getMatrixColumn('X', 0);
  closing.close();
  assert.equal(closing._decodedXBlocks.retainedBytes, 0);
  assert.equal(closing._decodedXBlocks.size, 0);
});

test('sums duplicate sparse coordinates in direct CSC and converted CSR columns', async t => {
  for (const format of ['csc', 'csr']) {
    await t.test(format, async () => {
      const loader = sparseLoader({
        format,
        shape: [2, 1],
        data: [2, 3],
        indices: [0, 0],
        indptr: format === 'csc' ? [0, 2] : [0, 2, 2]
      });
      loader._nObs = 2;
      loader._nVars = 1;
      assert.deepEqual(Array.from(await readXColumn(loader, 0, { sparse: true })), [5, 0]);
    });
  }
});

test('rejects finite duplicate sums that overflow Float32 sparse output', async () => {
  const directCsc = sparseLoader({
    format: 'csc',
    shape: [1, 1],
    data: [3.4e38, 3.4e38],
    indices: [0, 0],
    indptr: [0, 2]
  });
  directCsc._nObs = 1;
  directCsc._nVars = 1;
  await assert.rejects(
    readXColumn(directCsc, 0, { sparse: true }),
    /sparse X column.*Float32 range/i
  );

  assert.throws(
    () => getSparseColumn({
      colIndptr: new Int32Array([0, 2]),
      rowIndices: new Int32Array([0, 0]),
      colData: new Float32Array([3.4e38, 3.4e38])
    }, 0, 1),
    /sparse column.*Float32 range/i
  );

  assert.deepEqual(
    Array.from(getSparseColumn({
      colIndptr: new Int32Array([0, 2]),
      rowIndices: new Int32Array([0, 0]),
      colData: new Float32Array([Number.POSITIVE_INFINITY, 1])
    }, 0, 1)),
    [Number.POSITIVE_INFINITY]
  );
});

test('rejects out-of-range sparse columns instead of returning plausible zeros', async t => {
  for (const format of ['csc', 'csr']) {
    await t.test(format, async () => {
      const loader = sparseLoader({
        format,
        shape: [2, 2],
        data: [1],
        indices: [0],
        indptr: [0, 1, 1]
      });
      loader._nObs = 2;
      loader._nVars = 2;
      await assert.rejects(
        readXColumn(loader, 2, { sparse: true }),
        /X has no gene column 2/i
      );
    });
  }
});

test('a sparse coordinate outside its shape is corruption, never a dropped value', () => {
  // Skipping an out-of-range coordinate publishes 0.0 for that cell, and 0.0 in
  // an expression vector reads as a genuine non-detection. The reader must
  // refuse the matrix instead of quietly inventing a measurement.
  assert.throws(
    () => buildCscFromCsr({
      data: new Float32Array([1, 2]),
      indices: new Int32Array([0, 5]),
      indptr: new Int32Array([0, 1, 2]),
      shape: [2, 2]
    }),
    /column index 5 at entry 1 is outside its 2-column shape/i
  );

  assert.throws(
    () => buildCscFromCsr({
      data: new Float32Array([1, 2]),
      indices: new Int32Array([0, -1]),
      indptr: new Int32Array([0, 1, 2]),
      shape: [2, 2]
    }),
    /column index -1 .* outside its 2-column shape/i
  );

  assert.throws(
    () => getSparseColumn({
      colIndptr: new Int32Array([0, 2]),
      rowIndices: new Int32Array([0, 7]),
      colData: new Float32Array([1, 2])
    }, 0, 2),
    /row index 7 at entry 1 is outside its 2-row shape/i
  );
});

test('a sparse matrix must agree with its own declared shape', () => {
  assert.throws(
    () => buildCscFromCsr({
      data: new Float32Array([1, 2]),
      indices: new Int32Array([0]),
      indptr: new Int32Array([0, 1, 2]),
      shape: [2, 2]
    }),
    /declares 2 values but 1 indices/i
  );

  assert.throws(
    () => buildCscFromCsr({
      data: new Float32Array([1, 2]),
      indices: new Int32Array([0, 1]),
      indptr: new Int32Array([0, 1]),
      shape: [2, 2]
    }),
    /2 rows requires 3 row pointers/i
  );

  assert.throws(
    () => buildCscFromCsr({
      data: new Float32Array([1, 2]),
      indices: new Int32Array([0, 1]),
      indptr: new Int32Array([0, 1, 1]),
      shape: [2, 2]
    }),
    /row pointers end at 1, which is not its 2 stored values/i
  );
});

test('rejects a shared sparse column before allocating its output', () => {
  assert.throws(
    () => getSparseColumn({
      colIndptr: new Int32Array([0]),
      rowIndices: new Int32Array(0),
      colData: new Float32Array(0)
    }, 0, Number.MAX_SAFE_INTEGER),
    /sparse column index.*out of bounds/i
  );
});

test('rejects finite values that overflow during Float32 conversion', async () => {
  const embedding = arrayLoader(
    'obsm/X_umap',
    metadata({ shape: [1, 1], chunks: [1, 1], dtype: '<f8' }),
    { '0.0': littleEndianBytes([1e308], 'setFloat64', 8) }
  );
  setCurrentMapping(embedding._files, 'obsm');
  embedding._nObs = 1;
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

  const denseFill = arrayLoader(
    'X',
    metadata({
      shape: [1, 70_000_000],
      chunks: [1, 700],
      dtype: '<f8',
      fill_value: 1e308
    }),
    {}
  );
  denseFill._nObs = 1;
  denseFill._nVars = 70_000_000;
  await assert.rejects(
    readXColumn(denseFill, 0, { sparse: false }),
    /dense X.*Float32 range/i
  );

  const sparse = sparseLoader({
    data: [1e308],
    dataDtype: '<f8',
    dataBytes: littleEndianBytes([1e308], 'setFloat64', 8),
    indices: [0],
    indptr: [0, 1, 1]
  });
  await assert.rejects(
    sparse._readSparseMatrix('X', 'float32'),
    /sparse data.*Float32 range/i
  );
});

test('rejects every non-finite embedding component before caching', async t => {
  for (const [name, value] of [
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY]
  ]) {
    await t.test(name, async () => {
      const loader = embeddingLoader({
        shape: [2, 2],
        chunks: [2, 2],
        values: [0, 0, value, 1],
        nObs: 2
      });
      const adapter = await adapterWithDescribedObsm(loader);
      const error = await adapter
        .getEmbeddingForRef({ key: 'X_umap_2d', columns: [0, 1] })
        .then(() => null, rejection => rejection);
      assert.ok(error instanceof EmbeddingLoadError);
      assert.equal(
        error.message,
        `Embedding 'X_umap_2d' cannot be plotted: ${
          name === 'NaN' ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity'
        } at cell 1.`
      );
      assert.equal(adapter._embeddingCache.size, 0);
      assert.equal(adapter._normInfo.size, 0);
    });
  }
});

/**
 * A 3-cell x 4-column obsm array in 2 x 2 chunks whose value is
 * 10 * row + column, in C or Fortran chunk order.
 */
function chunkedObsmLoader({ order = 'C', fill_value = 0, absent = [] } = {}) {
  const nRows = 3;
  const width = 4;
  const [chunkRows, chunkCols] = [2, 2];
  const meta = metadata({
    shape: [nRows, width],
    chunks: [chunkRows, chunkCols],
    dtype: '<f4',
    order,
    fill_value,
  });
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
  const loader = arrayLoader('obsm/X_pca', meta, chunkFiles);
  setCurrentMapping(loader._files, 'obsm');
  loader._nObs = nRows;
  const chunkReads = [];
  const readChunkFile = loader._readChunkFile.bind(loader);
  loader._readChunkFile = path => {
    chunkReads.push(path);
    return readChunkFile(path);
  };
  return { loader, chunkReads };
}

test('Zarr obsm column reads decode only the chunks that hold a selected column', async t => {
  for (const order of ['C', 'F']) {
    await t.test(`${order} order, columns in two chunk columns`, async () => {
      const { loader, chunkReads } = chunkedObsmLoader({ order });
      assert.deepEqual(
        Array.from(await loader.readObsmColumns('X_pca', [3, 0])),
        [3, 0, 13, 10, 23, 20]
      );
      assert.deepEqual(chunkReads.sort(), [
        'obsm/X_pca/0.0',
        'obsm/X_pca/0.1',
        'obsm/X_pca/1.0',
        'obsm/X_pca/1.1',
      ]);
    });

    await t.test(`${order} order, columns in one chunk column`, async () => {
      const { loader, chunkReads } = chunkedObsmLoader({ order });
      assert.deepEqual(
        Array.from(await loader.readObsmColumns('X_pca', [2, 3])),
        [2, 3, 12, 13, 22, 23]
      );
      assert.deepEqual(chunkReads.sort(), ['obsm/X_pca/0.1', 'obsm/X_pca/1.1']);
    });
  }

  await t.test('an absent chunk reads as its fill value', async () => {
    const { loader } = chunkedObsmLoader({ fill_value: 5, absent: ['1.1'] });
    assert.deepEqual(
      Array.from(await loader.readObsmColumns('X_pca', [1, 3])),
      [1, 3, 11, 13, 21, 5]
    );
  });

  await t.test('an absent chunk with no fill value is refused', async () => {
    const { loader } = chunkedObsmLoader({ fill_value: null, absent: ['1.1'] });
    await assert.rejects(
      loader.readObsmColumns('X_pca', [1, 3]),
      /obsm\['X_pca'\] has an absent chunk while fill_value is null/
    );
  });
});

test('Zarr mapping probes describe every element from metadata, with the catalog reasons', async () => {
  const files = new Map();
  const json = value => memoryFile(JSON.stringify(value));
  const denseArray = (path, shape, dtype = '<f4', extra = {}) => {
    const meta = metadata({ shape, chunks: shape.map(size => Math.max(1, size)), dtype, ...extra });
    files.set(`${path}/.zarray`, json(meta));
    setCurrentArrayAttrs(files, path, meta);
  };
  const sparse = (path, shape, nnz, dtype = '<f4') => {
    setCurrentGroup(files, path, {
      'encoding-type': 'csr_matrix',
      'encoding-version': '0.1.0',
      shape,
    });
    files.set(`${path}/data/.zarray`, json(metadata({ shape: [nnz], chunks: [Math.max(1, nnz)], dtype })));
  };
  const dataframe = (path, rows, columnOrder = []) => {
    setCurrentGroup(files, path, {
      'encoding-type': 'dataframe',
      'encoding-version': '0.2.0',
      _index: '_index',
      'column-order': columnOrder,
    });
    denseArray(`${path}/_index`, [rows], '|O', { filters: [{ id: 'vlen-utf8' }] });
  };

  denseArray('X', [3, 1]);
  dataframe('var', 1, ['gene_symbols', 'score']);
  denseArray('var/gene_symbols', [1], '|O', { filters: [{ id: 'vlen-utf8' }] });
  denseArray('var/score', [1]);
  setCurrentMapping(files, 'obsm');
  denseArray('obsm/X_umap', [3, 2]);
  sparse('obsm/X_sparse', [3, 5], 4);
  dataframe('obsm/X_df', 3);
  denseArray('obsm/pseudotime', [3], '<i4');
  denseArray('obsm/labels', [3], '|O', { filters: [{ id: 'vlen-utf8' }] });
  denseArray('obsm/flags', [3, 2], '|b1');
  setCurrentMapping(files, 'obsp');
  sparse('obsp/connectivities', [3, 3], 2);
  denseArray('obsp/distances', [3, 2]);
  setCurrentMapping(files, 'layers');
  sparse('layers/counts', [3, 1], 1, '<i4');
  denseArray('layers/wide', [3, 2]);
  sparse('raw/X', [3, 4], 0);
  dataframe('raw/var', 4);

  const loader = new ZarrLoader();
  loader._files = files;
  loader._rootName = 'probes.zarr';
  loader._nObs = 3;
  loader._nVars = 1;
  let chunkReads = 0;
  loader._readChunkFile = async () => {
    chunkReads++;
    throw new Error('probes must not read chunks');
  };

  const described = describeAnnDataProbes(await loader.probeMapping());
  assert.equal(chunkReads, 0);
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

test('Zarr obsm column reads return fresh arrays the loader does not retain', async () => {
  const loader = embeddingLoader();
  const first = await loader.readObsmColumns('X_umap_2d', [0, 1]);
  const second = await loader.readObsmColumns('X_umap_2d', [0, 1]);
  assert.ok(first instanceof Float64Array);
  assert.deepEqual(Array.from(first), [0, 0, 2, 4]);
  assert.notStrictEqual(first, second);
  first[0] = 99;
  assert.equal(second[0], 0);
  assert.equal(loader._cache.size, 0);
});

test('Zarr adapter loads an embedding whose raw plus normalized peak exceeds its cache budget', async () => {
  const loader = embeddingLoader();
  // 16 bytes hold the normalized Float32 result, not the Float64 read alive
  // while it is produced: the budget is a policy, so it still loads.
  const adapter = await adapterWithDescribedObsm(loader, {
    cacheBudgetBytes: 16
  });
  const embedding = await adapter.getEmbeddingForRef({ key: 'X_umap_2d', columns: [0, 1] });
  assert.ok(embedding instanceof Float32Array);
  assert.equal(adapter._coordinateReservedOutputBytes, 0n);
});

test('rejects finite Float32 fill overflow while preserving explicit infinity', async () => {
  const finiteOverflow = arrayLoader(
    'values',
    metadata({ dtype: '<f4', fill_value: 1e308 }),
    {}
  );
  await assert.rejects(
    finiteOverflow._readArray('values'),
    /fill_value.*Float32 range/i
  );

  const explicitInfinity = arrayLoader(
    'values',
    metadata({ dtype: '<f4', fill_value: 'Infinity' }),
    {}
  );
  assert.deepEqual(
    Array.from((await explicitInfinity._readArray('values')).data),
    [Number.POSITIVE_INFINITY]
  );
});

test('sparse components are checked for kind and length, never for size', () => {
  assert.equal(typeof zarrModule.validateSparseArrayContract, 'function');

  assert.throws(
    () => zarrModule.validateSparseArrayContract({
      format: 'csr',
      shape: [2, 3],
      dataMeta: metadata({ shape: [2], chunks: [2], dtype: '<f4' }),
      indicesMeta: metadata({ shape: [2], chunks: [2], dtype: '<f4' }),
      indptrMeta: metadata({ shape: [3], chunks: [3], dtype: '<i4' })
    }),
    /indices.*integer dtype/i
  );

  assert.doesNotThrow(
    () => zarrModule.validateSparseArrayContract({
      format: 'csr',
      shape: [50_000_000, 50_000_000],
      dataMeta: metadata({ shape: [500_000_000], chunks: [1_000_000], dtype: '<f4' }),
      indicesMeta: metadata({ shape: [500_000_000], chunks: [1_000_000], dtype: '<i4' }),
      indptrMeta: metadata({ shape: [50_000_001], chunks: [1_000_000], dtype: '<i8' })
    })
  );
});

test('validates sparse matrix structure before narrowing or conversion', async t => {
  const valid = await sparseLoader()._readSparseMatrix('X', 'float32');
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
      sparseLoader({ data: [1], indices: [0, 2] }),
      /data.*indices.*length/i
    ],
    [
      'indptr axis length',
      sparseLoader({ indptr: [0, 2] }),
      /indptr.*length/i
    ],
    [
      'indptr starts away from zero',
      sparseLoader({ indptr: [1, 1, 2] }),
      /indptr.*start.*zero/i
    ],
    [
      'indptr decreases',
      sparseLoader({ indptr: [0, 2, 1] }),
      /indptr.*monotonic/i
    ],
    [
      'indptr does not end at nnz',
      sparseLoader({ indptr: [0, 1, 1] }),
      /indptr.*last.*non-zero/i
    ],
    [
      'index outside the opposite axis',
      sparseLoader({ indices: [0, 3] }),
      /sparse.*index.*bounds/i
    ],
    [
      '64-bit index cannot be narrowed',
      sparseLoader({
        indices: [0],
        data: [1],
        indptr: [0, 1, 1],
        indicesDtype: '<i8',
        indicesBytes: littleEndianBytes([2147483648n], 'setBigInt64', 8)
      }),
      /sparse.*index.*Int32 range/i
    ],
    [
      'floating-point index dtype',
      sparseLoader({
        indices: [0, 2],
        indicesDtype: '<f4',
        indicesBytes: littleEndianBytes([0, 2], 'setFloat32', 4)
      }),
      /indices.*integer dtype/i
    ]
  ];

  for (const [name, loader, expectedError] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        loader._readSparseMatrix('X', 'float32'),
        expectedError
      );
    });
  }
});

test('requires unambiguous standard sparse format and shape metadata', async () => {
  const missingFormat = sparseLoader();
  missingFormat._files.set(
    'X/.zattrs',
    memoryFile(JSON.stringify({ shape: [2, 3] }))
  );
  await assert.rejects(
    missingFormat._readSparseMatrix('X', 'float32'),
    /sparse.*encoding-type.*required/i
  );

  const missingShape = sparseLoader();
  missingShape._files.set(
    'X/.zattrs',
    memoryFile(JSON.stringify({
      'encoding-type': 'csr_matrix',
      'encoding-version': '0.1.0'
    }))
  );
  await assert.rejects(
    missingShape._readSparseMatrix('X', 'float32'),
    /sparse.*shape.*required/i
  );
});

test('validates sparse component metadata while opening the AnnData structure', async () => {
  const mismatchedComponents = sparseLoader({
    data: [1],
    indices: [0, 2]
  });
  await assert.rejects(
    mismatchedComponents._readStructure(),
    /data.*indices.*length/i
  );

  const unsupportedEncoding = sparseLoader();
  unsupportedEncoding._files.set(
    'X/.zattrs',
    memoryFile(JSON.stringify({
      'encoding-type': 'mystery_matrix',
      'encoding-version': '0.1.0',
      shape: [2, 3]
    }))
  );
  await assert.rejects(
    unsupportedEncoding._readStructure(),
    /sparse.*encoding-type.*required/i
  );
});

test('rejects X dimensions that disagree with obs or var, including zero axes', async t => {
  const cases = [
    ['obs shorter', { obsCount: 1 }, /X.*obs.*dimension/i],
    ['obs longer', { obsCount: 3 }, /X.*obs.*dimension/i],
    ['var shorter', { varNames: ['A'] }, /X.*var.*dimension/i],
    ['var longer', { varNames: ['A', 'B', 'C'] }, /X.*var.*dimension/i],
    [
      'zero-cell X is known rather than missing',
      { xShape: [0, 2], obsCount: 1 },
      /X.*obs.*dimension/i
    ],
    [
      'zero-gene X is known rather than missing',
      { xShape: [2, 0], varNames: ['A'] },
      /X.*var.*dimension/i
    ]
  ];

  for (const [name, overrides, expectedError] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        denseStructureLoader(overrides)._readStructure(),
        expectedError
      );
    });
  }
});

test('keeps duplicate var names as stored for the adapter to make unique', async () => {
  // The loader no longer refuses a repeated var name: the adapter makes the
  // gene list unique with the data-mapping rule (`makeUniqueNames`), so each
  // name still selects exactly one column by position.
  const loader = denseStructureLoader({ varNames: ['A', 'A'] });
  await loader._readStructure();
  assert.equal(loader.nVars, 2);
  assert.deepEqual(loader.varNames, ['A', 'A']);
  const names = await loader.readVarNames('X', null);
  assert.deepEqual([...names.index], ['A', 'A']);
  assert.deepEqual([...names.values], ['A', 'A']);
});

test('requires canonical AnnData Zarr root identity without replacing working data', async t => {
  const invalidCases = [
    [
      'missing root group metadata',
      files => files.delete('.zgroup'),
      /AnnData Zarr root.*\.zgroup.*required/i
    ],
    [
      'malformed root group metadata',
      files => files.set('.zgroup', memoryFile('{')),
      /AnnData Zarr root.*\.zgroup.*valid JSON/i
    ],
    [
      'non-v2 root group metadata',
      files => files.set(
        '.zgroup',
        memoryFile('{"zarr_format":3}')
      ),
      /AnnData Zarr root.*\.zgroup.*zarr_format.*2/i
    ],
    [
      'missing root attributes',
      files => files.delete('.zattrs'),
      /AnnData Zarr root.*\.zattrs.*required/i
    ],
    [
      'missing AnnData encoding identity',
      files => files.set('.zattrs', memoryFile('{}')),
      /AnnData Zarr root.*encoding-type.*exactly.*anndata/i
    ],
    [
      'lookalike encoding identity',
      files => files.set(
        '.zattrs',
        memoryFile(JSON.stringify({
          'encoding-type': 'not-anndata',
          'encoding-version': '0.1.0'
        }))
      ),
      /AnnData Zarr root.*encoding-type.*exactly.*anndata/i
    ],
    [
      'missing AnnData encoding version',
      files => files.set(
        '.zattrs',
        memoryFile(JSON.stringify({
          'encoding-type': 'anndata'
        }))
      ),
      /AnnData Zarr root.*encoding-version.*exactly.*0\.1\.0/i
    ],
    [
      'unsupported AnnData encoding version',
      files => files.set(
        '.zattrs',
        memoryFile(JSON.stringify({
          'encoding-type': 'anndata',
          'encoding-version': '0.2.0'
        }))
      ),
      /AnnData Zarr root.*encoding-version.*exactly.*0\.1\.0/i
    ]
  ];

  for (const [name, mutate, expectedError] of invalidCases) {
    await t.test(name, async () => {
      const loader = new ZarrLoader();
      await loader.openFileMap(
        completeZarrStoreFiles({
          embeddingValues: [0, 0, 2, 4],
          geneValues: [1, 2, 3, 4]
        }),
        'working.zarr'
      );

      const replacement = completeZarrStoreFiles({
        embeddingValues: [10, 20, 30, 40],
        geneValues: [5, 6, 7, 8]
      });
      mutate(replacement);

      await assert.rejects(
        loader.openFileMap(replacement, 'invalid-replacement.zarr'),
        expectedError
      );
      assert.equal(loader._rootName, 'working.zarr');
      assert.deepEqual(
        Array.from(await loader.readObsmColumns('X_umap_2d', [0, 1])),
        [0, 0, 2, 4]
      );
      assert.deepEqual(
        Array.from(await geneColumnByName(loader, 'A')),
        [1, 3]
      );
    });
  }
});

test('requires exact AnnData mapping identity before enumerating obsm', async t => {
  const invalidCases = [
    [
      'missing obsm group metadata',
      files => files.delete('obsm/.zgroup'),
      /obsm.*\.zgroup.*required/i,
    ],
    [
      'malformed obsm group metadata',
      files => files.set('obsm/.zgroup', memoryFile('{')),
      /obsm.*\.zgroup.*valid JSON/i,
    ],
    [
      'non-v2 obsm group metadata',
      files => files.set(
        'obsm/.zgroup',
        memoryFile('{"zarr_format":3}')
      ),
      /obsm.*\.zgroup.*zarr_format.*2/i,
    ],
    [
      'missing obsm attributes',
      files => files.delete('obsm/.zattrs'),
      /obsm.*\.zattrs.*required|obsm.*mapping.*required/i,
    ],
    [
      'wrong obsm encoding type',
      files => files.set(
        'obsm/.zattrs',
        memoryFile(JSON.stringify({
          'encoding-type': 'mapping',
          'encoding-version': '0.1.0',
        }))
      ),
      /obsm.*encoding-type.*dict/i,
    ],
    [
      'wrong obsm encoding version',
      files => files.set(
        'obsm/.zattrs',
        memoryFile(JSON.stringify({
          'encoding-type': 'dict',
          'encoding-version': '9.9.9',
        }))
      ),
      /obsm.*encoding-version.*0\.1\.0/i,
    ],
  ];

  for (const [name, mutate, expected] of invalidCases) {
    await t.test(name, async () => {
      const loader = new ZarrLoader();
      await loader.openFileMap(
        completeZarrStoreFiles({
          embeddingValues: [0, 0, 2, 4],
          geneValues: [1, 2, 3, 4],
        }),
        'working.zarr'
      );
      const replacement = completeZarrStoreFiles({
        embeddingValues: [10, 20, 30, 40],
        geneValues: [5, 6, 7, 8],
      });
      mutate(replacement);

      await assert.rejects(
        loader.openFileMap(replacement, 'invalid-obsm.zarr'),
        expected
      );
      assert.equal(loader._rootName, 'working.zarr');
      assert.deepEqual(
        Array.from(await loader.readObsmColumns('X_umap_2d', [0, 1])),
        [0, 0, 2, 4]
      );
    });
  }
});

test('requires the canonical AnnData obs dataframe contract without replacing working data', async t => {
  const invalidCases = [
    [
      'missing obs group metadata',
      files => files.delete('obs/.zgroup'),
      /AnnData obs.*\.zgroup.*required/i
    ],
    [
      'malformed obs group metadata',
      files => files.set('obs/.zgroup', memoryFile('{')),
      /AnnData obs.*\.zgroup.*valid JSON/i
    ],
    [
      'non-v2 obs group metadata',
      files => files.set(
        'obs/.zgroup',
        memoryFile('{"zarr_format":3}')
      ),
      /AnnData obs.*\.zgroup.*zarr_format.*2/i
    ],
    [
      'missing obs attributes',
      files => files.delete('obs/.zattrs'),
      /AnnData obs.*\.zattrs.*required/i
    ],
    [
      'missing dataframe encoding identity',
      files => files.set(
        'obs/.zattrs',
        memoryFile(JSON.stringify({
          'encoding-version': '0.2.0',
          _index: '_index',
          'column-order': []
        }))
      ),
      /AnnData obs.*encoding-type.*exactly.*dataframe/i
    ],
    [
      'unsupported dataframe encoding identity',
      files => files.set(
        'obs/.zattrs',
        memoryFile(JSON.stringify({
          ...canonicalObsDataframeAttrs(),
          'encoding-type': 'not-dataframe'
        }))
      ),
      /AnnData obs.*encoding-type.*exactly.*dataframe/i
    ],
    [
      'missing dataframe encoding version',
      files => files.set(
        'obs/.zattrs',
        memoryFile(JSON.stringify({
          'encoding-type': 'dataframe',
          _index: '_index',
          'column-order': []
        }))
      ),
      /AnnData obs.*encoding-version.*exactly.*0\.2\.0/i
    ],
    [
      'unsupported dataframe encoding version',
      files => files.set(
        'obs/.zattrs',
        memoryFile(JSON.stringify({
          ...canonicalObsDataframeAttrs(),
          'encoding-version': '0.3.0'
        }))
      ),
      /AnnData obs.*encoding-version.*exactly.*0\.2\.0/i
    ],
    [
      'missing dataframe index declaration',
      files => files.set(
        'obs/.zattrs',
        memoryFile(JSON.stringify({
          'encoding-type': 'dataframe',
          'encoding-version': '0.2.0',
          'column-order': []
        }))
      ),
      /AnnData obs.*_index.*non-empty string/i
    ],
    [
      'invalid dataframe index declaration',
      files => files.set(
        'obs/.zattrs',
        memoryFile(JSON.stringify({
          ...canonicalObsDataframeAttrs(),
          _index: 7
        }))
      ),
      /AnnData obs.*_index.*non-empty string/i
    ],
    [
      'duplicate column-order member',
      files => {
        files.set(
          'obs/.zattrs',
          memoryFile(JSON.stringify(canonicalObsDataframeAttrs({
            'column-order': ['score', 'score']
          })))
        );
        files.set(
          'obs/score/.zarray',
          memoryFile(JSON.stringify(metadata({
            shape: [2],
            chunks: [2],
            dtype: '<f4'
          })))
        );
      },
      /AnnData obs.*column-order.*unique/i
    ],
    [
      'dataframe index repeated as an observation field',
      files => files.set(
        'obs/.zattrs',
        memoryFile(JSON.stringify(canonicalObsDataframeAttrs({
          'column-order': ['_index']
        })))
      ),
      /AnnData obs.*column-order.*index|index.*observation.*field/i
    ],
    [
      'unversioned primitive dataframe index',
      files => files.set(
        'obs/_index/.zattrs',
        memoryFile(JSON.stringify({
          'encoding-type': 'string-array'
        }))
      ),
      /AnnData obs index.*encoding-version.*0\.2\.0/i
    ]
  ];

  for (const [name, mutate, expectedError] of invalidCases) {
    await t.test(name, async () => {
      const loader = new ZarrLoader();
      await loader.openFileMap(
        completeZarrStoreFiles({
          embeddingValues: [0, 0, 2, 4],
          geneValues: [1, 2, 3, 4]
        }),
        'working.zarr'
      );

      const replacement = completeZarrStoreFiles({
        embeddingValues: [10, 20, 30, 40],
        geneValues: [5, 6, 7, 8]
      });
      mutate(replacement);

      await assert.rejects(
        loader.openFileMap(replacement, 'invalid-obs-dataframe.zarr'),
        expectedError
      );
      assert.equal(loader._rootName, 'working.zarr');
      assert.deepEqual(
        Array.from(await loader.readObsmColumns('X_umap_2d', [0, 1])),
        [0, 0, 2, 4]
      );
      assert.deepEqual(
        Array.from(await geneColumnByName(loader, 'A')),
        [1, 3]
      );
    });
  }
});

test('validates every observation column declared by column-order before adoption', async t => {
  await t.test('valid primitive column is accepted', async () => {
    const files = completeZarrStoreFiles({
      embeddingValues: [0, 0, 2, 4],
      geneValues: [1, 2, 3, 4]
    });
    files.set(
      'obs/.zattrs',
      memoryFile(JSON.stringify(canonicalObsDataframeAttrs({
        'column-order': ['score']
      })))
    );
    files.set(
      'obs/score/.zarray',
      memoryFile(JSON.stringify(metadata({
        shape: [2],
        chunks: [2],
        dtype: '<f4'
      })))
    );
    setCurrentArrayAttrs(files, 'obs/score', { dtype: '<f4' });

    const loader = new ZarrLoader();
    await loader.openFileMap(files, 'valid-observation.zarr');
    assert.deepEqual(loader.obsKeys, ['score']);
  });

  const invalidCases = [
    [
      'missing declared column',
      () => {},
      /declared observation column.*missing.*missing|missing.*declared observation column/i
    ],
    [
      'unsupported declared column representation',
      files => {
        files.set(
          'obs/missing/.zgroup',
          memoryFile('{"zarr_format":2}')
        );
        files.set(
          'obs/missing/.zattrs',
          memoryFile(JSON.stringify({
            'encoding-type': 'unsupported-column',
            'encoding-version': '0.1.0'
          }))
        );
      },
      /declared observation column.*missing.*unsupported/i
    ],
    [
      'incomplete supported categorical column',
      files => {
        files.set(
          'obs/missing/.zgroup',
          memoryFile('{"zarr_format":2}')
        );
        files.set(
          'obs/missing/.zattrs',
          memoryFile(JSON.stringify({
            'encoding-type': 'categorical',
            'encoding-version': '0.2.0',
            ordered: false
          }))
        );
      },
      /declared observation column.*missing.*invalid.*codes.*\.zarray/i
    ],
    [
      'categorical children cannot imply a missing parent encoding',
      files => {
        files.set(
          'obs/missing/.zgroup',
          memoryFile('{"zarr_format":2}')
        );
        files.set(
          'obs/missing/codes/.zarray',
          memoryFile(JSON.stringify(metadata({
            shape: [2],
            chunks: [2],
            dtype: '|i1'
          })))
        );
        files.set(
          'obs/missing/codes/.zattrs',
          memoryFile(JSON.stringify({
            'encoding-type': 'array',
            'encoding-version': '0.2.0'
          }))
        );
        files.set(
          'obs/missing/categories/.zarray',
          memoryFile(JSON.stringify(metadata({
            shape: [1],
            chunks: [1],
            dtype: '|O',
            filters: [{ id: 'vlen-utf8' }]
          })))
        );
        files.set(
          'obs/missing/categories/.zattrs',
          memoryFile(JSON.stringify({
            'encoding-type': 'string-array',
            'encoding-version': '0.2.0'
          }))
        );
      },
      /declared observation column.*missing.*encoding-type/i
    ]
  ];

  for (const [name, mutate, expectedError] of invalidCases) {
    await t.test(name, async () => {
      const loader = new ZarrLoader();
      await loader.openFileMap(
        completeZarrStoreFiles({
          embeddingValues: [0, 0, 2, 4],
          geneValues: [1, 2, 3, 4]
        }),
        'working.zarr'
      );

      const replacement = completeZarrStoreFiles({
        embeddingValues: [10, 20, 30, 40],
        geneValues: [5, 6, 7, 8]
      });
      replacement.set(
        'obs/.zattrs',
        memoryFile(JSON.stringify(canonicalObsDataframeAttrs({
          'column-order': ['missing']
        })))
      );
      mutate(replacement);

      await assert.rejects(
        loader.openFileMap(replacement, 'invalid-observation.zarr'),
        expectedError
      );
      assert.equal(loader._rootName, 'working.zarr');
      assert.deepEqual(
        Array.from(await loader.readObsmColumns('X_umap_2d', [0, 1])),
        [0, 0, 2, 4]
      );
      assert.deepEqual(
        Array.from(await geneColumnByName(loader, 'A')),
        [1, 3]
      );
    });
  }
});

test('requires the canonical AnnData var dataframe contract without replacing working data', async t => {
  const invalidCases = [
    [
      'missing var group metadata',
      files => files.delete('var/.zgroup'),
      /AnnData var.*\.zgroup.*required/i
    ],
    [
      'malformed var group metadata',
      files => files.set('var/.zgroup', memoryFile('{')),
      /AnnData var.*\.zgroup.*valid JSON/i
    ],
    [
      'non-v2 var group metadata',
      files => files.set(
        'var/.zgroup',
        memoryFile('{"zarr_format":3}')
      ),
      /AnnData var.*\.zgroup.*zarr_format.*2/i
    ],
    [
      'missing var attributes',
      files => files.delete('var/.zattrs'),
      /AnnData var.*\.zattrs.*required/i
    ],
    [
      'missing dataframe encoding identity',
      files => files.set(
        'var/.zattrs',
        memoryFile(JSON.stringify({
          'encoding-version': '0.2.0',
          _index: '_index',
          'column-order': []
        }))
      ),
      /AnnData var.*encoding-type.*exactly.*dataframe/i
    ],
    [
      'unsupported dataframe encoding identity',
      files => files.set(
        'var/.zattrs',
        memoryFile(JSON.stringify({
          ...canonicalVarDataframeAttrs(),
          'encoding-type': 'not-dataframe'
        }))
      ),
      /AnnData var.*encoding-type.*exactly.*dataframe/i
    ],
    [
      'missing dataframe encoding version',
      files => files.set(
        'var/.zattrs',
        memoryFile(JSON.stringify({
          'encoding-type': 'dataframe',
          _index: '_index',
          'column-order': []
        }))
      ),
      /AnnData var.*encoding-version.*exactly.*0\.2\.0/i
    ],
    [
      'unsupported dataframe encoding version',
      files => files.set(
        'var/.zattrs',
        memoryFile(JSON.stringify({
          ...canonicalVarDataframeAttrs(),
          'encoding-version': '0.3.0'
        }))
      ),
      /AnnData var.*encoding-version.*exactly.*0\.2\.0/i
    ],
    [
      'missing dataframe index declaration',
      files => files.set(
        'var/.zattrs',
        memoryFile(JSON.stringify({
          'encoding-type': 'dataframe',
          'encoding-version': '0.2.0',
          'column-order': []
        }))
      ),
      /AnnData var.*_index.*non-empty string/i
    ],
    [
      'invalid dataframe index declaration',
      files => files.set(
        'var/.zattrs',
        memoryFile(JSON.stringify({
          ...canonicalVarDataframeAttrs(),
          _index: 7
        }))
      ),
      /AnnData var.*_index.*non-empty string/i
    ],
    [
      'missing column-order declaration',
      files => files.set(
        'var/.zattrs',
        memoryFile(JSON.stringify({
          'encoding-type': 'dataframe',
          'encoding-version': '0.2.0',
          _index: '_index'
        }))
      ),
      /AnnData var.*column-order.*array/i
    ],
    [
      'invalid column-order member',
      files => files.set(
        'var/.zattrs',
        memoryFile(JSON.stringify(canonicalVarDataframeAttrs({
          'column-order': ['score', 7]
        })))
      ),
      /Every AnnData var.*column-order.*non-empty string/i
    ],
    [
      'duplicate column-order member',
      files => files.set(
        'var/.zattrs',
        memoryFile(JSON.stringify(canonicalVarDataframeAttrs({
          'column-order': ['score', 'score']
        })))
      ),
      /AnnData var.*column-order.*unique/i
    ],
    [
      'dataframe index repeated as a variable field',
      files => files.set(
        'var/.zattrs',
        memoryFile(JSON.stringify(canonicalVarDataframeAttrs({
          'column-order': ['_index']
        })))
      ),
      /AnnData var.*column-order.*index|index.*variable.*field/i
    ],
    [
      'missing declared index node',
      files => {
        files.delete('var/_index/.zarray');
        files.delete('var/_index/.zattrs');
        files.delete('var/_index/0');
      },
      /AnnData var index.*missing/i
    ]
  ];

  for (const [name, mutate, expectedError] of invalidCases) {
    await t.test(name, async () => {
      const loader = new ZarrLoader();
      await loader.openFileMap(
        completeZarrStoreFiles({
          embeddingValues: [0, 0, 2, 4],
          geneValues: [1, 2, 3, 4]
        }),
        'working.zarr'
      );

      const replacement = completeZarrStoreFiles({
        embeddingValues: [10, 20, 30, 40],
        geneValues: [5, 6, 7, 8]
      });
      mutate(replacement);

      await assert.rejects(
        loader.openFileMap(replacement, 'invalid-var-dataframe.zarr'),
        expectedError
      );
      assert.equal(loader._rootName, 'working.zarr');
      assert.deepEqual(
        Array.from(await loader.readObsmColumns('X_umap_2d', [0, 1])),
        [0, 0, 2, 4]
      );
      assert.deepEqual(
        Array.from(await geneColumnByName(loader, 'A')),
        [1, 3]
      );
    });
  }
});

test('validates every variable column declared by column-order before adoption', async t => {
  await t.test('valid primitive column is accepted', async () => {
    const files = completeZarrStoreFiles({
      embeddingValues: [0, 0, 2, 4],
      geneValues: [1, 2, 3, 4]
    });
    files.set(
      'var/.zattrs',
      memoryFile(JSON.stringify(canonicalVarDataframeAttrs({
        'column-order': ['score']
      })))
    );
    files.set(
      'var/score/.zarray',
      memoryFile(JSON.stringify(metadata({
        shape: [2],
        chunks: [2],
        dtype: '<f4'
      })))
    );
    setCurrentArrayAttrs(files, 'var/score', { dtype: '<f4' });

    const loader = new ZarrLoader();
    await loader.openFileMap(files, 'valid-variable.zarr');
    assert.deepEqual(loader.varNames, ['A', 'B']);
  });

  const invalidCases = [
    [
      'missing declared column',
      () => {},
      /declared variable column.*missing.*missing|missing.*declared variable column/i
    ],
    [
      'unsupported declared column representation',
      files => {
        files.set(
          'var/missing/.zgroup',
          memoryFile('{"zarr_format":2}')
        );
        files.set(
          'var/missing/.zattrs',
          memoryFile(JSON.stringify({
            'encoding-type': 'unsupported-column',
            'encoding-version': '0.1.0'
          }))
        );
      },
      /declared variable column.*missing.*unsupported/i
    ],
    [
      'incomplete supported categorical column',
      files => {
        files.set(
          'var/missing/.zgroup',
          memoryFile('{"zarr_format":2}')
        );
        files.set(
          'var/missing/.zattrs',
          memoryFile(JSON.stringify({
            'encoding-type': 'categorical',
            'encoding-version': '0.2.0',
            ordered: false
          }))
        );
      },
      /declared variable column.*missing.*invalid.*codes.*\.zarray/i
    ],
    [
      'variable-axis length mismatch',
      files => {
        files.set(
          'var/missing/.zarray',
          memoryFile(JSON.stringify(metadata({
            shape: [1],
            chunks: [1],
            dtype: '<f4'
          })))
        );
        setCurrentArrayAttrs(
          files,
          'var/missing',
          { dtype: '<f4' }
        );
      },
      /declared variable column.*missing.*invalid.*length.*2 variables/i
    ]
  ];

  for (const [name, mutate, expectedError] of invalidCases) {
    await t.test(name, async () => {
      const loader = new ZarrLoader();
      await loader.openFileMap(
        completeZarrStoreFiles({
          embeddingValues: [0, 0, 2, 4],
          geneValues: [1, 2, 3, 4]
        }),
        'working.zarr'
      );

      const replacement = completeZarrStoreFiles({
        embeddingValues: [10, 20, 30, 40],
        geneValues: [5, 6, 7, 8]
      });
      replacement.set(
        'var/.zattrs',
        memoryFile(JSON.stringify(canonicalVarDataframeAttrs({
          'column-order': ['missing']
        })))
      );
      mutate(replacement);

      await assert.rejects(
        loader.openFileMap(replacement, 'invalid-variable.zarr'),
        expectedError
      );
      assert.equal(loader._rootName, 'working.zarr');
      assert.deepEqual(
        Array.from(await loader.readObsmColumns('X_umap_2d', [0, 1])),
        [0, 0, 2, 4]
      );
      assert.deepEqual(
        Array.from(await geneColumnByName(loader, 'A')),
        [1, 3]
      );
    });
  }
});

test('public Zarr loading rejects X with no canonical var and preserves the working source', async () => {
  const notifications = getNotificationCenter();
  const originalWarning = notifications.info;
  notifications.info = () => 'warning';

  const source = new ZarrDataSource();
  try {
    await source.loadFromFileList(
      fileListFromMap(
        completeZarrStoreFiles({
          embeddingValues: [0, 0, 1, 1],
          geneValues: [1, 0, 2, 0]
        }),
        'working.zarr'
      ),
      { showProgress: false }
    );
    const workingAdapter = source.getAdapter();

    const missingVar = completeZarrStoreFiles({
      embeddingValues: [9, 9, 10, 10],
      geneValues: [9, 0, 10, 0]
    });
    missingVar.set(
      'X/.zarray',
      memoryFile(JSON.stringify(metadata({
        shape: [1, 1],
        chunks: [1, 1],
        dtype: '<f4'
      })))
    );
    missingVar.set(
      'X/0.0',
      memoryFile(littleEndianBytes([9], 'setFloat32', 4))
    );
    missingVar.set(
      'obs/_index/.zarray',
      memoryFile(JSON.stringify(metadata({
        shape: [1],
        chunks: [1],
        dtype: '|O',
        filters: [{ id: 'vlen-utf8' }]
      })))
    );
    missingVar.set(
      'obs/_index/0',
      memoryFile(vlenUtf8Bytes(['cell-0']))
    );
    missingVar.set(
      'obsm/X_umap_2d/.zarray',
      memoryFile(JSON.stringify(metadata({
        shape: [1, 2],
        chunks: [1, 2],
        dtype: '<f4'
      })))
    );
    missingVar.set(
      'obsm/X_umap_2d/0.0',
      memoryFile(littleEndianBytes([9, 10], 'setFloat32', 4))
    );
    missingVar.delete('var/.zgroup');
    missingVar.delete('var/.zattrs');
    missingVar.delete('var/_index/.zarray');
    missingVar.delete('var/_index/0');

    await assert.rejects(
      source.loadFromFileList(
        fileListFromMap(missingVar, 'missing-var.zarr'),
        { showProgress: false }
      ),
      /AnnData var.*required/i
    );
    assert.equal(source.dirname, 'working.zarr');
    assert.equal(source.getAdapter(), workingAdapter);
    assert.deepEqual(
      Array.from(await sourceGeneValuesByName(source, 'A')),
      [1, 2]
    );
    assert.deepEqual(
      Array.from(
        await source.getAdapter().getEmbeddingPayload('embeddings/0_2d.bin', 2)
      ),
      [-1, -1, 1, 1]
    );
  } finally {
    source.clear();
    notifications.info = originalWarning;
  }
});

test('Zarr opening supports official nullable-string dataframe indices', async t => {
  await t.test('valid observation and variable indices are accepted', async () => {
    const loader = denseStructureLoader();
    setNullableStringIndex(loader, 'obs', ['cell-a', 'cell-b']);
    setNullableStringIndex(loader, 'var', ['gene-a', 'gene-b']);

    await loader._readStructure();

    assert.equal(loader.nObs, 2);
    assert.equal(loader.nVars, 2);
    assert.deepEqual(loader.varNames, ['gene-a', 'gene-b']);
  });

  await t.test('missing observation names are rejected', async () => {
    const loader = denseStructureLoader();
    setNullableStringIndex(
      loader,
      'obs',
      ['cell-a', 'ignored'],
      new Uint8Array([0, 1])
    );
    setNullableStringIndex(loader, 'var', ['gene-a', 'gene-b']);

    await assert.rejects(
      loader._readStructure(),
      /obs.*index.*missing|missing.*obs.*index/i
    );
  });

  await t.test('nullable indices require string values', async () => {
    const loader = denseStructureLoader();
    setNullableStringIndex(
      loader,
      'obs',
      new Int32Array([1, 2]),
      new Uint8Array([0, 0]),
      '<i4'
    );
    setNullableStringIndex(loader, 'var', ['gene-a', 'gene-b']);

    await assert.rejects(
      loader._readStructure(),
      /obs.*index.*string|string.*obs.*index/i
    );
  });

  await t.test('nullable index lengths remain axis-aligned', async () => {
    const loader = denseStructureLoader();
    setNullableStringIndex(loader, 'obs', ['only-one']);
    setNullableStringIndex(loader, 'var', ['gene-a', 'gene-b']);

    await assert.rejects(
      loader._readStructure(),
      /X.*obs.*dimension|obs.*index.*length/i
    );
  });
});

test('requires every observation field to be one-dimensional and cell-aligned', async t => {
  await t.test('ordinary field length', async () => {
    const loader = arrayLoader(
      'obs/batch',
      metadata({ shape: [1], chunks: [1], dtype: '<i4' }),
      { 0: littleEndianBytes([7], 'setInt32', 4) }
    );
    loader._nObs = 2;
    await assert.rejects(
      loader.getObsField('batch'),
      /observation field.*batch.*length.*2/i
    );
  });

  await t.test('ordinary field rank', async () => {
    const loader = arrayLoader(
      'obs/batch',
      metadata({ shape: [2, 1], chunks: [2, 1], dtype: '<i4' }),
      { '0.0': littleEndianBytes([7, 8], 'setInt32', 4) }
    );
    loader._nObs = 2;
    await assert.rejects(
      loader.getObsField('batch'),
      /observation field.*batch.*one-dimensional/i
    );
  });

  await t.test('categorical codes metadata', async () => {
    const loader = new ZarrLoader();
    loader._nObs = 2;
    loader._files = new Map([
      ['obs/batch/.zgroup', memoryFile('{"zarr_format":2}')],
      ['obs/batch/.zattrs', memoryFile(JSON.stringify({
        'encoding-type': 'categorical',
        'encoding-version': '0.2.0',
        ordered: false
      }))],
      ['obs/batch/categories/.zarray', memoryFile(JSON.stringify(metadata({
        shape: [2],
        chunks: [2],
        dtype: '|O',
        filters: [{ id: 'vlen-utf8' }]
      })))],
      ['obs/batch/categories/.zattrs', memoryFile(JSON.stringify({
        'encoding-type': 'string-array',
        'encoding-version': '0.2.0'
      }))],
      ['obs/batch/categories/0', memoryFile(vlenUtf8Bytes(['A', 'B']))],
      ['obs/batch/codes/.zarray', memoryFile(JSON.stringify(metadata({
        shape: [1],
        chunks: [1],
        dtype: '|i1'
      })))],
      ['obs/batch/codes/.zattrs', memoryFile(JSON.stringify({
        'encoding-type': 'array',
        'encoding-version': '0.2.0'
      }))],
      ['obs/batch/codes/0', memoryFile(Uint8Array.from([0]))]
    ]);
    await assert.rejects(
      loader.getObsFieldInfo('batch'),
      /categorical codes.*length.*2/i
    );
    await assert.rejects(
      loader.getObsField('batch'),
      /categorical codes.*length.*2/i
    );
  });
});

test('normalizes continuous int64 and Float64 obs through the public adapter seam', async t => {
  function adapterFor(loader, key) {
    const adapter = new BaseAnnDataAdapter(loader);
    adapter._obsFieldsMetadata = [{ key, kind: 'continuous' }];
    return adapter;
  }

  await t.test('safe signed int64', async () => {
    const loader = arrayLoader(
      'obs/count',
      metadata({ shape: [2], chunks: [2], dtype: '<i8' }),
      { 0: littleEndianBytes([1n, 2n], 'setBigInt64', 8) }
    );
    loader._nObs = 2;
    const field = await adapterFor(loader, 'count').getObsFieldData('count');
    assert.equal(field.kind, 'continuous');
    assert.deepEqual(Array.from(new Float32Array(field.data)), [1, 2]);
  });

  await t.test('unsafe signed int64', async () => {
    const loader = arrayLoader(
      'obs/count',
      metadata({ shape: [1], chunks: [1], dtype: '<i8' }),
      { 0: littleEndianBytes([9_007_199_254_740_992n], 'setBigInt64', 8) }
    );
    loader._nObs = 1;
    await assert.rejects(
      adapterFor(loader, 'count').getObsFieldData('count'),
      /observation field.*count.*safe numeric range/i
    );
  });

  await t.test('finite Float64 overflow', async () => {
    const loader = arrayLoader(
      'obs/score',
      metadata({ shape: [1], chunks: [1], dtype: '<f8' }),
      { 0: littleEndianBytes([1e308], 'setFloat64', 8) }
    );
    loader._nObs = 1;
    await assert.rejects(
      adapterFor(loader, 'score').getObsFieldData('score'),
      /observation field.*score.*Float32 range/i
    );
  });
});

test('propagates malformed connectivity and enforces obs-aligned square shape', async t => {
  await t.test('loader corruption', async () => {
    const loader = connectivityLoader({
      shape: [2, 2],
      data: [1],
      indices: [0, 1],
      indptr: [0, 1, 1]
    });
    await assert.rejects(
      loader.getConnectivities('connectivities'),
      /data.*indices.*length/i
    );
  });

  await t.test('shape mismatch', async () => {
    const loader = connectivityLoader({
      shape: [3, 3],
      data: [1],
      indices: [1],
      indptr: [0, 1, 1, 1]
    }, 2);
    await assert.rejects(
      loader.getConnectivities('connectivities'),
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
        const source = new ZarrDataSource();
        try {
          const identity = await source.loadFromFileList(
            fileListFromMap(
              renamedEmbeddingStore(substituteKey),
              `${substituteKey.slice(2)}-only.zarr`
            ),
            { showProgress: false }
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
              await source.getAdapter().getEmbeddingPayload('embeddings/0_2d.bin', 2)
            ),
            [-1, -1, 1, 1]
          );
        } finally {
          source.clear();
        }
      });
    }

    await t.test('a file with nothing plottable is refused and the working source kept', async () => {
      const source = new ZarrDataSource();
      try {
        await source.loadFromFileList(
          fileListFromMap(
            completeZarrStoreFiles({
              embeddingValues: [0, 0, 1, 1],
              geneValues: [1, 0, 2, 0]
            }),
            'working.zarr'
          ),
          { showProgress: false }
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
        const error = await source.loadFromFileList(
          fileListFromMap(constant, 'constant.zarr'),
          { showProgress: false }
        ).then(() => null, rejection => rejection);
        assert.equal(error?.code, 'NO_PLOTTABLE_EMBEDDING');
        assert.equal(
          error.message,
          'Cellucid found nothing to plot. It needs an obsm array with one ' +
          'row per cell (2) and at least one numeric column. obsm holds: ' +
          'X_spatial (2 × 2, no coordinate variation).'
        );
        assert.equal(source.dirname, 'working.zarr');
        assert.equal(source.getAdapter(), workingAdapter);
      } finally {
        source.clear();
      }
    });
  } finally {
    notifications.info = originalWarning;
  }
});

test('Zarr slots follow the default rule, and a plain X_umap by width', async t => {
  async function initialized(loader) {
    const adapter = new BaseAnnDataAdapter(loader);
    await adapter.initialize();
    return adapter;
  }

  await t.test('an unsuffixed X_umap array is read at its own column count', async () => {
    const adapter = await initialized(embeddingLoader({ key: 'X_umap' }));
    assert.deepEqual(adapter._slots, {
      '1d': null,
      '2d': { key: 'X_umap', columns: [0, 1] },
      '3d': null,
    });
    assert.deepEqual(adapter.getMappingCandidates().guessed, []);
  });

  await t.test('an unsuffixed X_umap of a width no dimension has is best-guessed at its first columns', async () => {
    const adapter = await initialized(embeddingLoader({
      key: 'X_umap',
      shape: [2, 10],
      values: Array.from({ length: 20 }, (_, index) => index),
    }));
    assert.deepEqual(adapter._slots['2d'], { key: 'X_umap', columns: [0, 1] });
    assert.deepEqual(adapter.getMappingCandidates().guessed, ['embeddings.2d']);
  });

  await t.test('dimension-suffixed keys alone fill their slots', async () => {
    const adapter = await initialized(embeddingLoader({
      extraArrays: [{
        key: 'X_umap',
        shape: [2, 2],
        values: [4, 4, 5, 5],
      }],
    }));
    assert.deepEqual(adapter._slots['2d'], { key: 'X_umap_2d', columns: [0, 1] });
  });

  await t.test('a malformed suffixed key cannot be skipped for another dimension', async () => {
    await assert.rejects(
      initialized(embeddingLoader({
        key: 'X_umap_2d',
        shape: [2, 3],
        values: [0, 0, 0, 1, 1, 1],
        extraArrays: [{
          key: 'X_umap_3d',
          shape: [2, 3],
          values: [2, 2, 2, 3, 3, 3],
        }],
      })),
      /Embedding 'X_umap_2d' must have exactly 2 columns; got 3/
    );
  });
});

test('centralizes the numeric, rank, width, and observation-axis embedding contract', async t => {
  const cases = [
    [
      'zero columns',
      embeddingLoader({ key: 'X_umap', shape: [2, 0], chunks: [2, 1] }),
      'has no columns',
      /reads distinct columns/i
    ],
    [
      'wrong row count',
      embeddingLoader({
        key: 'X_umap',
        shape: [1, 2],
        chunks: [1, 2],
        values: [0, 1]
      }),
      'has 1 rows, the dataset has 2 cells',
      /obsm\['X_umap'\] has 1 rows but the dataset has 2 cells/
    ],
    [
      'nonnumeric dtype',
      embeddingLoader({
        key: 'X_umap',
        shape: [2, 2],
        dtype: '|S1'
      }),
      'not a numeric array',
      /obsm\['X_umap'\].*encoding-type.*array|numeric dtype/i
    ],
    [
      // A boolean is not a coordinate; the H5AD reader refuses the same
      // content, so the Zarr reader must too.
      'boolean dtype',
      embeddingLoader({
        key: 'X_umap',
        shape: [2, 2],
        dtype: '|b1',
        values: [0, 1, 1, 0]
      }),
      'not a numeric array',
      /obsm\['X_umap'\] must use a numeric dtype/
    ]
  ];

  for (const [name, loader, listedReason, readError] of cases) {
    await t.test(name, async () => {
      const [entry] = describeAnnDataProbes(await loader.probeMapping()).obsm;
      assert.equal(entry.usable, false);
      assert.equal(entry.reason, listedReason);
      await assert.rejects(loader.readObsmColumns('X_umap', [0, 1]), readError);
    });
  }

  await t.test('a one-dimensional array is one usable column', async () => {
    const loader = arrayLoader(
      'obsm/pseudotime',
      metadata({ shape: [2], chunks: [2], dtype: '<f4' }),
      { 0: littleEndianBytes([3, 7], 'setFloat32', 4) }
    );
    setCurrentMapping(loader._files, 'obsm');
    loader._nObs = 2;
    const [entry] = describeAnnDataProbes(await loader.probeMapping()).obsm;
    assert.deepEqual(
      [entry.key, entry.shape, entry.usable],
      ['pseudotime', [2], true]
    );
    assert.deepEqual(
      Array.from(await loader.readObsmColumns('pseudotime', [0])),
      [3, 7]
    );
  });
});

test('a dimension-suffixed vector field with the wrong cell axis is listed unusable and never bound', async () => {
  const loader = embeddingLoader({
    extraArrays: [{
      key: 'velocity_umap_2d',
      shape: [1, 2],
      values: [1, 2]
    }]
  });
  const adapter = new BaseAnnDataAdapter(loader);
  await adapter.initialize();
  assert.equal(adapter._vectorBindings.size, 0);
  const entry = adapter.getMappingCandidates().obsm
    .find(item => item.key === 'velocity_umap_2d');
  assert.equal(entry.usable, false);
  assert.equal(entry.reason, 'has 1 rows, the dataset has 2 cells');
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
  assert.deepEqual(Array.from(csc.sources), [0]);
  assert.deepEqual(Array.from(csc.destinations), [1]);

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
  const invalidCases = [
    [
      'missing group marker',
      files => files.delete('obsp/.zgroup'),
      /obsp.*\.zgroup.*required/i
    ],
    [
      'malformed group marker',
      files => files.set('obsp/.zgroup', memoryFile('{')),
      /obsp.*\.zgroup.*valid JSON/i
    ],
    [
      'non-v2 group marker',
      files => files.set(
        'obsp/.zgroup',
        memoryFile('{"zarr_format":3}')
      ),
      /obsp.*\.zgroup.*zarr_format.*2/i
    ],
    [
      'missing mapping attributes',
      files => files.delete('obsp/.zattrs'),
      /obsp.*\.zattrs.*required/i
    ],
    [
      'wrong mapping type',
      files => files.set(
        'obsp/.zattrs',
        memoryFile(JSON.stringify({
          'encoding-type': 'mapping',
          'encoding-version': '0.1.0'
        }))
      ),
      /obsp.*encoding-type.*dict/i
    ],
    [
      'wrong mapping version',
      files => files.set(
        'obsp/.zattrs',
        memoryFile(JSON.stringify({
          'encoding-type': 'dict',
          'encoding-version': '9.9.9'
        }))
      ),
      /obsp.*encoding-version.*0\.1\.0/i
    ]
  ];

  for (const [name, mutate, expected] of invalidCases) {
    await t.test(name, async () => {
      const loader = connectivityLoader({ shape: [2, 2] }, 2);
      mutate(loader._files);
      await assert.rejects(loader.hasConnectivities('connectivities'), expected);
    });
  }
});

test('keeps sparse connectivity payloads lazy while reporting metadata presence', async () => {
  const loader = embeddingLoader();
  setCurrentMapping(loader._files, 'obsp');
  loader._files.set(
    'obsp/connectivities/.zattrs',
    memoryFile(JSON.stringify({
      'encoding-type': 'csr_matrix',
      'encoding-version': '0.1.0',
      shape: [2, 2]
    }))
  );
  loader._files.set('obsp/connectivities/.zgroup', memoryFile('{"zarr_format":2}'));
  loader._readSparseMetadataContract = async () => ({
    format: 'csr',
    shape: [2, 2],
    dataMeta: metadata({ shape: [1], chunks: [1], dtype: '<f4' })
  });
  loader._readSparseMatrix = async () => {
    throw new Error('connectivity payload must remain lazy');
  };

  const dataset = await loader.getDatasetMetadata();
  assert.equal(dataset.stats.has_connectivity, true);
});

test('supports bounded dense AnnData connectivity arrays without sparse misclassification', async () => {
  const loader = embeddingLoader();
  setCurrentMapping(loader._files, 'obsp');
  loader._files.set(
    'obsp/connectivities/.zattrs',
    memoryFile(JSON.stringify({
      'encoding-type': 'array',
      'encoding-version': '0.2.0'
    }))
  );
  loader._files.set(
    'obsp/connectivities/.zarray',
    memoryFile(JSON.stringify(metadata({
      shape: [2, 2],
      chunks: [2, 2],
      dtype: '<f4'
    })))
  );
  loader._files.set(
    'obsp/connectivities/0.0',
    memoryFile(littleEndianBytes([0, 1, 1, 0], 'setFloat32', 4))
  );

  const adapter = new BaseAnnDataAdapter(loader);
  await adapter.initialize();
  assert.equal(adapter.getMetadata().stats.has_connectivity, true);
  const edges = await adapter.getConnectivityEdges();
  assert.equal(edges.nEdges, 1);
  assert.deepEqual(Array.from(edges.sources), [0]);
  assert.deepEqual(Array.from(edges.destinations), [1]);
  assert.deepEqual(Array.from(edges.weights), [1]);
});

test('rejects mixed dense and sparse connectivity representations', async () => {
  const loader = embeddingLoader();
  setCurrentMapping(loader._files, 'obsp');
  loader._files.set(
    'obsp/connectivities/.zattrs',
    memoryFile(JSON.stringify({
      'encoding-type': 'array',
      'encoding-version': '0.2.0'
    }))
  );
  loader._files.set(
    'obsp/connectivities/.zarray',
    memoryFile(JSON.stringify(metadata({
      shape: [2, 2],
      chunks: [2, 2],
      dtype: '<f4'
    })))
  );
  loader._files.set(
    'obsp/connectivities/.zgroup',
    memoryFile('{"zarr_format":2}')
  );

  await assert.rejects(
    loader.hasConnectivities('connectivities'),
    /exactly one dense or sparse representation/i
  );
});

test('Zarr preserves exact sparse connectivity weights through extraction', async () => {
  const weighted = 1 + (2 ** -30);
  const loader = connectivityLoader({
    shape: [2, 2],
    data: [weighted, weighted],
    dataDtype: '<f8',
    dataBytes: littleEndianBytes(
      [weighted, weighted],
      'setFloat64',
      8
    ),
    indices: [1, 0],
    indptr: [0, 1, 2],
  }, 2);
  const result = await loader.getConnectivities('connectivities');
  assert.equal(result.data instanceof Float64Array, true);
  assert.equal(result.data[0], weighted);
  const edges = extractConnectivityEdges(result, 2);
  assert.deepEqual(Array.from(edges.weights), [weighted]);
});

test('preserves an explicitly present empty connectivity matrix', async () => {
  const connLoader = connectivityLoader({
    shape: [2, 2],
    data: [],
    indices: [],
    indptr: [0, 0, 0]
  });
  const embedding = embeddingLoader();
  for (const [path, file] of embedding._files) {
    connLoader._files.set(path, file);
  }
  connLoader._rootName = 'empty-connectivity.zarr';

  const adapter = new BaseAnnDataAdapter(connLoader);
  await adapter.initialize();
  assert.equal(adapter.getMetadata().stats.has_connectivity, true);
  const edges = await adapter.getConnectivityEdges();
  assert.equal(edges.nCells, 2);
  assert.equal(edges.nEdges, 0);
  assert.equal(edges.maxNeighbors, 0);
  assert.deepEqual(Array.from(edges.sources), []);
  assert.deepEqual(Array.from(edges.destinations), []);
  assert.deepEqual(Array.from(edges.weights), []);
});

test('a later sparse X caller starts clean after an earlier rejected invocation', async () => {
  const loader = new ZarrLoader();
  loader._files = new Map([['.zattrs', memoryFile('{}')]]);
  loader._nObs = 2;
  loader._nVars = 1;
  let calls = 0;
  loader._openMatrixColumns = async () => {
    calls++;
    if (calls === 1) throw new Error('transient sparse read failure');
    return { column: () => Float32Array.from([4, 0]) };
  };

  await assert.rejects(
    readXColumn(loader, 0, { sparse: true }),
    /transient sparse read failure/i
  );
  assert.deepEqual(Array.from(await readXColumn(loader, 0, { sparse: true })), [4, 0]);
  assert.equal(calls, 2);
});

test('opens and replaces Zarr stores transactionally without stale caches', async () => {
  const loader = new ZarrLoader();
  const malformed = new Map([
    ['.zgroup', memoryFile('{"zarr_format":2}')],
    ['.zattrs', memoryFile('{')]
  ]);

  assert.equal(typeof loader.openFileMap, 'function');
  await assert.rejects(
    loader.openFileMap(malformed, 'malformed.zarr'),
    /JSON|property name|expected/i
  );
  assert.equal(loader.isOpen, false);

  await loader.openFileMap(
    completeZarrStoreFiles({
      embeddingValues: [0, 0, 2, 4],
      geneValues: [1, 2, 3, 4]
    }),
    'first.zarr'
  );
  assert.deepEqual(Array.from(await loader.readObsmColumns('X_umap_2d', [0, 1])), [0, 0, 2, 4]);
  assert.deepEqual(Array.from(await geneColumnByName(loader, 'A')), [1, 3]);

  await loader.openFileMap(
    completeZarrStoreFiles({
      embeddingValues: [10, 20, 30, 40],
      geneValues: [5, 6, 7, 8]
    }),
    'second.zarr'
  );
  assert.deepEqual(
    Array.from(await loader.readObsmColumns('X_umap_2d', [0, 1])),
    [10, 20, 30, 40]
  );
  assert.deepEqual(Array.from(await geneColumnByName(loader, 'A')), [5, 7]);

  await assert.rejects(
    loader.openFileMap(malformed, 'replacement.zarr'),
    /JSON|property name|expected/i
  );
  assert.equal(loader.isOpen, true);
  assert.deepEqual(
    Array.from(await loader.readObsmColumns('X_umap_2d', [0, 1])),
    [10, 20, 30, 40]
  );
  assert.deepEqual(Array.from(await geneColumnByName(loader, 'A')), [5, 7]);
});

test('a categorical dictionary past 65,535 categories is served with uint32 codes', async () => {
  const categories = Array.from({ length: 65_536 }, (_, index) => `C${index}`);
  const adapter = new BaseAnnDataAdapter({
    nObs: 2,
    async getObsField() {
      return {
        dtype: 'categorical',
        categories,
        codes: Int32Array.from([65_535, -1])
      };
    }
  });
  adapter._obsFieldsMetadata = [{
    key: 'large_category',
    kind: 'category',
    categories
  }];

  assert.doesNotThrow(() => adapter.getObsManifest());
  const payload = await adapter.getObsFieldData('large_category');
  assert.equal(payload.dtype, 'uint32');
  assert.equal(payload.missingValue, 4_294_967_295);
  assert.deepEqual(Array.from(new Uint32Array(payload.data)), [65_535, 4_294_967_295]);
});

test('loads standard nullable integer and boolean observation groups with missing values', async () => {
  const loader = embeddingLoader({
    nObs: 3,
    shape: [3, 2],
    values: [0, 0, 1, 1, 2, 2]
  });
  loader._obsKeys = [
    'nullable_count',
    'nullable_flag',
    'nullable_label'
  ];
  setCurrentGroup(loader._files, 'obs/nullable_count', {
    'encoding-type': 'nullable-integer',
    'encoding-version': '0.1.0'
  });
  loader._files.set(
    'obs/nullable_count/values/.zarray',
    memoryFile(JSON.stringify(metadata({
      shape: [3],
      chunks: [3],
      dtype: '<i8'
    })))
  );
  setCurrentArrayAttrs(
    loader._files,
    'obs/nullable_count/values',
    { dtype: '<i8' }
  );
  loader._files.set(
    'obs/nullable_count/values/0',
    memoryFile(littleEndianBytes([1n, 0n, 3n], 'setBigInt64', 8))
  );
  loader._files.set(
    'obs/nullable_count/mask/.zarray',
    memoryFile(JSON.stringify(metadata({
      shape: [3],
      chunks: [3],
      dtype: '|b1'
    })))
  );
  setCurrentArrayAttrs(
    loader._files,
    'obs/nullable_count/mask',
    { dtype: '|b1' }
  );
  loader._files.set(
    'obs/nullable_count/mask/0',
    memoryFile(Uint8Array.from([0, 1, 0]))
  );
  setCurrentGroup(loader._files, 'obs/nullable_flag', {
    'encoding-type': 'nullable-boolean',
    'encoding-version': '0.1.0'
  });
  for (const child of ['values', 'mask']) {
    loader._files.set(
      `obs/nullable_flag/${child}/.zarray`,
      memoryFile(JSON.stringify(metadata({
        shape: [3],
        chunks: [3],
        dtype: '|b1'
      })))
    );
    setCurrentArrayAttrs(
      loader._files,
      `obs/nullable_flag/${child}`,
      { dtype: '|b1' }
    );
  }
  loader._files.set(
    'obs/nullable_flag/values/0',
    memoryFile(Uint8Array.from([1, 0, 0]))
  );
  loader._files.set(
    'obs/nullable_flag/mask/0',
    memoryFile(Uint8Array.from([0, 1, 0]))
  );
  setCurrentGroup(loader._files, 'obs/nullable_label', {
    'encoding-type': 'nullable-string-array',
    'encoding-version': '0.1.0'
  });
  loader._files.set(
    'obs/nullable_label/values/.zarray',
    memoryFile(JSON.stringify(metadata({
      shape: [3],
      chunks: [3],
      dtype: '|O',
      filters: [{ id: 'vlen-utf8' }]
    })))
  );
  setCurrentArrayAttrs(
    loader._files,
    'obs/nullable_label/values',
    { dtype: '|O' }
  );
  loader._files.set(
    'obs/nullable_label/values/0',
    memoryFile(vlenUtf8Bytes(['A', 'ignored', 'C']))
  );
  loader._files.set(
    'obs/nullable_label/mask/.zarray',
    memoryFile(JSON.stringify(metadata({
      shape: [3],
      chunks: [3],
      dtype: '|b1'
    })))
  );
  setCurrentArrayAttrs(
    loader._files,
    'obs/nullable_label/mask',
    { dtype: '|b1' }
  );
  loader._files.set(
    'obs/nullable_label/mask/0',
    memoryFile(Uint8Array.from([0, 1, 0]))
  );
  loader._nObs = 3;

  const adapter = new BaseAnnDataAdapter(loader);
  await adapter.initialize();
  assert.deepEqual(
    adapter.getMetadata().obs_fields,
    [
      { key: 'nullable_count', kind: 'continuous', n_categories: undefined },
      { key: 'nullable_flag', kind: 'category', n_categories: 2 },
      { key: 'nullable_label', kind: 'category', n_categories: 2 }
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

test('connectivity extraction refuses no graph for its size', () => {
  // The only limit on a graph is the memory the engine grants when the
  // arrays are allocated; a large graph is never refused by a fixed cap.
  const source = readFileSync(
    new URL('../assets/js/data/sparse-utils.js', import.meta.url),
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
  assert.deepEqual(Array.from(edges.sources), [0, 1]);
  assert.deepEqual(Array.from(edges.destinations), [1, 2]);
});

test('does not publish an invalidated in-flight sparse matrix into replacement state', async () => {
  const loader = new ZarrLoader();
  loader._files = new Map([['.zattrs', memoryFile('{}')]]);
  loader._nObs = 1;
  loader._nVars = 1;
  let resolveOld;
  let calls = 0;
  const oldRead = new Promise(resolve => {
    resolveOld = resolve;
  });
  loader._openMatrixColumns = async () => {
    calls++;
    if (calls === 1) return oldRead;
    return { column: () => Float32Array.from([9]) };
  };

  const oldColumn = readXColumn(loader, 0, { sparse: true });
  const staleAssertion = assert.rejects(
    oldColumn,
    /dataset.*(changed|superseded)|superseded.*dataset/i
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  const staleState = loader._matrix;
  loader.clearCache();
  assert.equal(loader._matrix, null, 'clearing releases the resident matrix');
  resolveOld({ column: () => Float32Array.from([7]) });

  await staleAssertion;
  assert.equal(staleState.columns, null, 'the stale load is not published');
  assert.deepEqual(Array.from(await readXColumn(loader, 0, { sparse: true })), [9]);
  assert.notStrictEqual(loader._matrix, staleState);
  assert.equal(calls, 2);
});

// Both writers store every continuous value as Float32 and round integers
// above 2^24 to the nearest Float32, so a file read directly reads the same.
test('integer observation values round to Float32 exactly as the writers export them', async () => {
  const loader = arrayLoader(
    'obs/count',
    metadata({ shape: [1], chunks: [1], dtype: '<i8' }),
    { 0: littleEndianBytes([16_777_217n], 'setBigInt64', 8) }
  );
  loader._nObs = 1;
  const adapter = new BaseAnnDataAdapter(loader);
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
  const supersededPattern = /dataset.*(changed|superseded)|superseded.*dataset/i;

  await t.test('dense gene load and outer gene cache', async () => {
    const loader = new ZarrLoader();
    const oldStore = completeZarrStoreFiles({
      embeddingValues: [1, 2, 3, 4],
      geneValues: [7, 0, 8, 0]
    });
    const delayed = deferredMemoryFile(
      littleEndianBytes([7, 0, 8, 0], 'setFloat32', 4)
    );
    oldStore.set('X/0.0', delayed.file);
    await loader.openFileMap(oldStore, 'old-dense.zarr');

    const staleRequest = geneColumnByName(loader, 'A');
    const staleAssertion = assert.rejects(staleRequest, supersededPattern);
    await delayed.started;
    await loader.openFileMap(
      completeZarrStoreFiles({
        embeddingValues: [9, 10, 11, 12],
        geneValues: [9, 0, 10, 0]
      }),
      'new-dense.zarr'
    );
    delayed.release();

    await staleAssertion;
    assert.deepEqual(Array.from(await geneColumnByName(loader, 'A')), [9, 10]);
  });

  await t.test('embedding cache', async () => {
    const loader = new ZarrLoader();
    const oldStore = completeZarrStoreFiles({
      embeddingValues: [1, 2, 3, 4],
      geneValues: [1, 0, 2, 0]
    });
    const delayed = deferredMemoryFile(
      littleEndianBytes([1, 2, 3, 4], 'setFloat32', 4)
    );
    oldStore.set('obsm/X_umap_2d/0.0', delayed.file);
    await loader.openFileMap(oldStore, 'old-embedding.zarr');

    const staleRequest = loader.readObsmColumns('X_umap_2d', [0, 1]);
    const staleAssertion = assert.rejects(staleRequest, supersededPattern);
    await delayed.started;
    await loader.openFileMap(
      completeZarrStoreFiles({
        embeddingValues: [9, 10, 11, 12],
        geneValues: [9, 0, 10, 0]
      }),
      'new-embedding.zarr'
    );
    delayed.release();

    await staleAssertion;
    assert.deepEqual(
      Array.from(await loader.readObsmColumns('X_umap_2d', [0, 1])),
      [9, 10, 11, 12]
    );
  });

  await t.test('sparse outer gene cache', async () => {
    const loader = new ZarrLoader();
    loader._files = new Map([['.zattrs', memoryFile('{}')]]);
    loader._rootName = 'old-sparse.zarr';
    loader._nObs = 1;
    loader._nVars = 1;
    loader._varNames = ['A'];
    stubXElement(loader, { sparse: true, nVars: 1 });

    let markStarted;
    let releaseOld;
    const started = new Promise(resolve => {
      markStarted = resolve;
    });
    const oldRead = new Promise(resolve => {
      releaseOld = resolve;
    });
    let calls = 0;
    loader._openMatrixColumns = async () => {
      calls++;
      if (calls === 1) {
        markStarted();
        return oldRead;
      }
      return { column: () => Float32Array.from([9]) };
    };

    const staleRequest = geneColumnByName(loader, 'A');
    const staleAssertion = assert.rejects(staleRequest, supersededPattern);
    await started;
    loader.clearCache();
    releaseOld({ column: () => Float32Array.from([7]) });

    await staleAssertion;
    assert.deepEqual(Array.from(await geneColumnByName(loader, 'A')), [9]);
    assert.equal(calls, 2);
  });

  await t.test('observation metadata cache', async () => {
    const loader = new ZarrLoader();
    loader._files = new Map([['obs/label/.zarray', memoryFile('{}')]]);
    loader._nObs = 1;

    let markStarted;
    let releaseOld;
    const started = new Promise(resolve => {
      markStarted = resolve;
    });
    const oldMeta = new Promise(resolve => {
      releaseOld = resolve;
    });
    let calls = 0;
    loader._readArrayMeta = async () => {
      calls++;
      if (calls === 1) {
        markStarted();
        return oldMeta;
      }
      return metadata({
        shape: [1],
        chunks: [1],
        dtype: '|O',
        filters: [{ id: 'vlen-utf8' }]
      });
    };
    loader._readAttrs = async () => ({
      'encoding-type': calls <= 1 ? 'array' : 'string-array',
      'encoding-version': '0.2.0'
    });

    const staleRequest = loader.getObsFieldInfo('label');
    const staleAssertion = assert.rejects(staleRequest, supersededPattern);
    await started;
    loader.clearCache();
    releaseOld(metadata({ shape: [1], chunks: [1], dtype: '<f4' }));

    await staleAssertion;
    assert.deepEqual(await loader.getObsFieldInfo('label'), { dtype: 'string' });
  });

  await t.test('observation value cache', async () => {
    const loader = new ZarrLoader();
    loader._files = new Map([['obs/value/.zarray', memoryFile('{}')]]);
    loader._nObs = 1;
    loader._readAttrs = async () => ({
      'encoding-type': 'array',
      'encoding-version': '0.2.0'
    });
    loader._readArrayMeta = async () => metadata({
      shape: [1],
      chunks: [1],
      dtype: '<f4'
    });

    let markStarted;
    let releaseOld;
    const started = new Promise(resolve => {
      markStarted = resolve;
    });
    const oldArray = new Promise(resolve => {
      releaseOld = resolve;
    });
    let calls = 0;
    loader._readArray = async () => {
      calls++;
      if (calls === 1) {
        markStarted();
        return oldArray;
      }
      return {
        data: Float32Array.from([9]),
        dtype: '<f4',
        shape: [1]
      };
    };

    const staleRequest = loader.getObsField('value');
    const staleAssertion = assert.rejects(staleRequest, supersededPattern);
    await started;
    loader.clearCache();
    releaseOld({
      data: Float32Array.from([1]),
      dtype: '<f4',
      shape: [1]
    });

    await staleAssertion;
    assert.deepEqual(
      Array.from((await loader.getObsField('value')).values),
      [9]
    );
  });

  await t.test('connectivity metadata cache', async () => {
    const loader = new ZarrLoader();
    loader._files = new Map([
      ['obsp/connectivities/.zarray', memoryFile('{}')],
      ['obsp/connectivities/.zattrs', memoryFile(JSON.stringify({
        'encoding-type': 'array',
        'encoding-version': '0.2.0'
      }))]
    ]);
    setCurrentMapping(loader._files, 'obsp');
    loader._nObs = 1;

    let markStarted;
    let releaseOld;
    const started = new Promise(resolve => {
      markStarted = resolve;
    });
    const oldMeta = new Promise(resolve => {
      releaseOld = resolve;
    });
    loader._readArrayMeta = async () => {
      markStarted();
      return oldMeta;
    };

    const staleRequest = loader.hasConnectivities('connectivities');
    const staleAssertion = assert.rejects(staleRequest, supersededPattern);
    await started;
    loader._files = new Map([['.zattrs', memoryFile('{}')]]);
    loader.clearCache();
    releaseOld(metadata({
      shape: [1, 1],
      chunks: [1, 1],
      dtype: '<f4'
    }));

    await staleAssertion;
    assert.equal(await loader.hasConnectivities('connectivities'), false);
  });

  await t.test('connectivity payload cache', async () => {
    const loader = new ZarrLoader();
    loader._files = new Map([
      ['obsp/connectivities/.zarray', memoryFile('{}')],
      ['obsp/connectivities/.zattrs', memoryFile(JSON.stringify({
        'encoding-type': 'array',
        'encoding-version': '0.2.0'
      }))]
    ]);
    setCurrentMapping(loader._files, 'obsp');
    loader._nObs = 1;
    loader._readArrayMeta = async () => metadata({
      shape: [1, 1],
      chunks: [1, 1],
      dtype: '<f4'
    });

    let markStarted;
    let releaseOld;
    const started = new Promise(resolve => {
      markStarted = resolve;
    });
    const oldArray = new Promise(resolve => {
      releaseOld = resolve;
    });
    loader._readArray = async () => {
      markStarted();
      return oldArray;
    };

    const staleRequest = loader.getConnectivities('connectivities');
    const staleAssertion = assert.rejects(staleRequest, supersededPattern);
    await started;
    loader._files = new Map([['.zattrs', memoryFile('{}')]]);
    loader.clearCache();
    releaseOld({
      data: Float32Array.from([1]),
      shape: [1, 1]
    });

    await staleAssertion;
    assert.equal(await loader.getConnectivities('connectivities'), null);
  });
});

test('reads official categorical v0.2 layouts with nullable-string categories', async () => {
  const loader = new ZarrLoader();
  loader._files = new Map([
    ['obs/label/.zgroup', memoryFile('{"zarr_format":2}')],
    ['obs/label/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'categorical',
      'encoding-version': '0.2.0',
      ordered: false
    }))],
    ['obs/label/codes/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [3],
      chunks: [3],
      dtype: '|i1'
    })))],
    ['obs/label/codes/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'array',
      'encoding-version': '0.2.0'
    }))],
    ['obs/label/codes/0', memoryFile(Uint8Array.from([0, 255, 1]))],
    ['obs/label/categories/.zgroup', memoryFile('{"zarr_format":2}')],
    ['obs/label/categories/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'nullable-string-array',
      'encoding-version': '0.1.0'
    }))],
    ['obs/label/categories/values/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [2],
      chunks: [2],
      dtype: '|O',
      fill_value: 0,
      filters: [{ id: 'vlen-utf8' }]
    })))],
    ['obs/label/categories/values/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'string-array',
      'encoding-version': '0.2.0'
    }))],
    ['obs/label/categories/values/0', memoryFile(vlenUtf8Bytes(['A', 'C']))],
    ['obs/label/categories/mask/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [2],
      chunks: [2],
      dtype: '|b1',
      fill_value: false
    })))],
    ['obs/label/categories/mask/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'array',
      'encoding-version': '0.2.0'
    }))],
    ['obs/label/categories/mask/0', memoryFile(Uint8Array.from([0, 0]))]
  ]);
  loader._rootName = 'nullable-categories.zarr';
  loader._nObs = 3;
  loader._nVars = 0;
  loader._obsKeys = ['label'];
  stubPlottableObsm(loader, 3);

  const adapter = new BaseAnnDataAdapter(loader);
  await adapter.initialize();

  const categorical = adapter.getObsManifest()._categoricalFields[0];
  assert.equal(categorical[0], 0);
  assert.equal(categorical[1], 'label');
  assert.deepEqual(categorical[2], ['A', 'C']);
  const field = await adapter.getObsFieldData('label');
  assert.equal(field.kind, 'category');
  assert.deepEqual(field.categories, ['A', 'C']);
  assert.deepEqual(Array.from(new Uint8Array(field.data)), [0, 255, 1]);
});

test('accepts a small Blosc-compressed nullable string working set', async () => {
  const loader = new ZarrLoader();
  loader._files = new Map([
    [
      'obs/label/categories/.zgroup',
      memoryFile('{"zarr_format":2}')
    ],
    ['obs/label/categories/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'nullable-string-array',
      'encoding-version': '0.1.0'
    }))]
  ]);
  loader._readAttrs = async path =>
    path === 'obs/label/categories'
      ? {
          'encoding-type': 'nullable-string-array',
          'encoding-version': '0.1.0'
        }
      : {
          'encoding-type': path.endsWith('/values')
            ? 'string-array'
            : 'array',
          'encoding-version': '0.2.0'
        };
  loader._readArrayMeta = async path => metadata({
    shape: [2],
    chunks: [2],
    dtype: path.endsWith('/mask') ? '|b1' : '|O',
    fill_value: path.endsWith('/mask') ? false : 0,
    compressor: {
      id: 'blosc',
      cname: 'lz4',
      clevel: 5,
      shuffle: 1,
      blocksize: 0
    },
    filters: path.endsWith('/mask') ? null : [{ id: 'vlen-utf8' }]
  });

  await loader._readNullableObsContract(
    'obs/label/categories',
    "label' categories",
    'nullable-string-array',
    null
  );
});

test('reads nullable values and masks without overlapping decoder peaks', async () => {
  const loader = new ZarrLoader();
  loader._nObs = 2;
  loader._files = new Map([
    ['obs/label/.zgroup', memoryFile('{"zarr_format":2}')],
    ['obs/label/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'nullable-string-array',
      'encoding-version': '0.1.0'
    }))]
  ]);
  loader._readNullableObsContract = async () => ({
    valuesInfo: { category: 'object' }
  });

  let releaseValues;
  let markValuesStarted;
  const valuesStarted = new Promise(resolve => {
    markValuesStarted = resolve;
  });
  const valuesReleased = new Promise(resolve => {
    releaseValues = resolve;
  });
  let valuesActive = false;
  let maskStartedWhileValuesActive = false;
  loader._readArray = async path => {
    if (path.endsWith('/values')) {
      valuesActive = true;
      markValuesStarted();
      await valuesReleased;
      valuesActive = false;
      return { data: ['A', 'B'] };
    }
    if (path.endsWith('/mask')) {
      maskStartedWhileValuesActive = valuesActive;
      return { data: Uint8Array.from([0, 1]) };
    }
    throw new Error(`Unexpected nullable path '${path}'`);
  };

  const request = loader.getObsField('label');
  await valuesStarted;
  await Promise.resolve();
  const overlapped = maskStartedWhileValuesActive;
  releaseValues();
  const field = await request;

  assert.equal(overlapped, false);
  assert.deepEqual(field.values, ['A', null]);
});

test('ignores semantically irrelevant masked nullable integer backing values', async () => {
  const loader = new ZarrLoader();
  loader._files = new Map([
    ['obs/count/.zgroup', memoryFile('{"zarr_format":2}')],
    ['obs/count/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'nullable-integer',
      'encoding-version': '0.1.0'
    }))],
    ['obs/count/values/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [1],
      chunks: [1],
      dtype: '<u8'
    })))],
    ['obs/count/values/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'array',
      'encoding-version': '0.2.0'
    }))],
    [
      'obs/count/values/0',
      memoryFile(littleEndianBytes([18_446_744_073_709_551_615n], 'setBigUint64', 8))
    ],
    ['obs/count/mask/.zarray', memoryFile(JSON.stringify(metadata({
      shape: [1],
      chunks: [1],
      dtype: '|b1',
      fill_value: false
    })))],
    ['obs/count/mask/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'array',
      'encoding-version': '0.2.0'
    }))],
    ['obs/count/mask/0', memoryFile(Uint8Array.from([1]))]
  ]);
  loader._nObs = 1;

  const field = await loader.getObsField('count');
  assert.equal(field.dtype, 'uint');
  assert.equal(field.values.length, 1);
  assert.equal(Number.isNaN(field.values[0]), true);
});

test('decodes portable IEEE-754 float16 values in both endian orders', async () => {
  const expectedFinite = [
    0,
    -0,
    1,
    -2,
    65_504,
    5.960464477539063e-8
  ];
  const little = arrayLoader(
    'half',
    metadata({
      shape: [9],
      chunks: [9],
      dtype: '<f2'
    }),
    {
      0: bytesFromHex('00000080003c00c0ff7b0100007c00fc007e')
    }
  );
  const big = arrayLoader(
    'half',
    metadata({
      shape: [9],
      chunks: [9],
      dtype: '>f2'
    }),
    {
      0: bytesFromHex('000080003c00c0007bff00017c00fc007e00')
    }
  );

  for (const loader of [little, big]) {
    const { data } = await loader._readArray('half');
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
  files.set(
    'X/.zarray',
    memoryFile(JSON.stringify(metadata({
      shape: [2, 2],
      chunks: [2, 2],
      dtype: '<f2'
    })))
  );
  files.set('X/0.0', memoryFile(bytesFromHex('003c004000420044')));
  files.set(
    'obsm/X_umap_2d/.zarray',
    memoryFile(JSON.stringify(metadata({
      shape: [2, 2],
      chunks: [2, 2],
      dtype: '<f2'
    })))
  );
  files.set(
    'obsm/X_umap_2d/0.0',
    memoryFile(bytesFromHex('00000000003c003c'))
  );

  const loader = new ZarrLoader();
  await loader.openFileMap(files, 'float16-writer.zarr');
  assert.deepEqual(Array.from(await geneColumnByName(loader, 'A')), [1, 3]);
  assert.deepEqual(
    Array.from(await loader.readObsmColumns('X_umap_2d', [0, 1])),
    [0, 0, 1, 1]
  );
});

test('keeps the latest concurrent Zarr open request', async () => {
  const firstStore = completeZarrStoreFiles({
    embeddingValues: [1, 2, 3, 4],
    geneValues: [1, 0, 2, 0]
  });
  let markStarted;
  let releaseFirst;
  const firstStarted = new Promise(resolve => {
    markStarted = resolve;
  });
  const firstReleased = new Promise(resolve => {
    releaseFirst = resolve;
  });
  firstStore.set('.zattrs', {
    async text() {
      markStarted();
      await firstReleased;
      return JSON.stringify({
        'encoding-type': 'anndata',
        'encoding-version': '0.1.0'
      });
    },
    async arrayBuffer() {
      throw new Error('root metadata must be read as text');
    }
  });

  const loader = new ZarrLoader();
  const firstRequest = loader.openFileMap(firstStore, 'first-slow.zarr');
  const firstAssertion = assert.rejects(
    firstRequest,
    /open request.*superseded|superseded.*open request/i
  );
  await firstStarted;
  await loader.openFileMap(
    completeZarrStoreFiles({
      embeddingValues: [9, 10, 11, 12],
      geneValues: [9, 0, 10, 0]
    }),
    'second-fast.zarr'
  );
  releaseFirst();

  await firstAssertion;
  assert.equal(loader._rootName, 'second-fast.zarr');
  assert.deepEqual(Array.from(await geneColumnByName(loader, 'A')), [9, 10]);
});

test('the Zarr reader publishes no notifications and a newer store supersedes an older one', async t => {
  const events = captureDownloadNotifications(t);
  const createStore = values => completeZarrStoreFiles({
    embeddingValues: values,
    geneValues: [1, 0, 2, 0],
  });

  const direct = new ZarrLoader();
  await direct.openFileMap(createStore([0, 0, 1, 1]), 'direct.zarr');
  assert.deepEqual(events, [], 'the reader runs in a worker; the data source owns notifications');

  const firstStore = createStore([1, 2, 3, 4]);
  let markStarted;
  let releaseFirst;
  const firstStarted = new Promise(resolve => {
    markStarted = resolve;
  });
  const firstReleased = new Promise(resolve => {
    releaseFirst = resolve;
  });
  firstStore.set('.zattrs', {
    async text() {
      markStarted();
      await firstReleased;
      return JSON.stringify({
        'encoding-type': 'anndata',
        'encoding-version': '0.1.0',
      });
    },
    async arrayBuffer() {
      throw new Error('root metadata must be read as text');
    },
  });

  const overlapping = new ZarrLoader();
  const older = overlapping.openFileMap(firstStore, 'older.zarr');
  const olderAssertion = assert.rejects(older, /superseded/i);
  await firstStarted;
  await overlapping.openFileMap(createStore([9, 10, 11, 12]), 'newer.zarr');
  releaseFirst();
  await olderAssertion;
  assert.equal(overlapping._rootName, 'newer.zarr');
  assert.deepEqual(events, []);
});

test('keeps the latest concurrent ZarrDataSource selection', async () => {
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
  let markStarted;
  let releaseFirst;
  const firstStarted = new Promise(resolve => {
    markStarted = resolve;
  });
  const firstReleased = new Promise(resolve => {
    releaseFirst = resolve;
  });
  firstStore.set('.zattrs', {
    async text() {
      markStarted();
      await firstReleased;
      return JSON.stringify({
        'encoding-type': 'anndata',
        'encoding-version': '0.1.0'
      });
    },
    async arrayBuffer() {
      throw new Error('root metadata must be read as text');
    }
  });

  const source = new ZarrDataSource();
  try {
    const firstRequest = source.loadFromFileList(
      fileListFromMap(firstStore, 'first-slow.zarr')
    );
    const firstAssertion = assert.rejects(
      firstRequest,
      /Zarr.*(load|selection).*superseded|superseded.*Zarr/i
    );
    await firstStarted;
    await source.loadFromFileList(
      fileListFromMap(
        completeZarrStoreFiles({
          embeddingValues: [9, 10, 11, 12],
          geneValues: [9, 0, 10, 0]
        }),
        'second-fast.zarr'
      )
    );
    releaseFirst();

    await firstAssertion;
    assert.equal(source.dirname, 'second-fast.zarr');
    assert.deepEqual(
      Array.from(await sourceGeneValuesByName(source, 'A')),
      [9, 10]
    );
  } finally {
    releaseFirst();
    source.clear();
    for (const [name, method] of originals) {
      notifications[name] = method;
    }
  }
});

test('Zarr direct-load warning is published only after successful adoption', async t => {
  captureDownloadNotifications(t);
  const notifications = getNotificationCenter();
  const originalWarning = notifications.info;
  const warnings = [];
  notifications.info = (...args) => {
    warnings.push(args);
    return `warning-${warnings.length}`;
  };
  t.after(() => {
    notifications.info = originalWarning;
  });

  const source = new ZarrDataSource();
  t.after(() => source.clear());
  await assert.rejects(
    source.loadFromFileList(
      fileListFromMap(
        new Map([
          ['.zgroup', memoryFile('{"zarr_format":2}')],
        ]),
        'broken.zarr'
      ),
      { showProgress: false }
    ),
    /root.*zattrs|required/i
  );
  assert.equal(warnings.length, 0);

  await source.loadFromFileList(
    fileListFromMap(
      completeZarrStoreFiles({
        embeddingValues: [0, 0, 1, 1],
        geneValues: [1, 0, 2, 0],
      }),
      'working.zarr'
    ),
    { showProgress: false }
  );
  assert.equal(warnings.length, 0);

  await source.loadFromFileList(
    fileListFromMap(
      completeZarrStoreFiles({
        embeddingValues: [2, 2, 3, 3],
        geneValues: [3, 0, 4, 0],
      }),
      'visible-warning.zarr'
    ),
    { showProgress: true }
  );
  assert.equal(warnings.length, 1);
});

test('ZarrDataSource owns one terminal event across overlapping candidates', async t => {
  const notifications = getNotificationCenter();
  const originalWarning = notifications.info;
  notifications.info = () => {};
  t.after(() => {
    notifications.info = originalWarning;
  });
  const events = captureDownloadNotifications(t);
  const firstStore = completeZarrStoreFiles({
    embeddingValues: [1, 2, 3, 4],
    geneValues: [1, 0, 2, 0]
  });
  let markStarted;
  let releaseFirst;
  const firstStarted = new Promise(resolve => {
    markStarted = resolve;
  });
  const firstReleased = new Promise(resolve => {
    releaseFirst = resolve;
  });
  firstStore.set('.zattrs', {
    async text() {
      markStarted();
      await firstReleased;
      return JSON.stringify({
        'encoding-type': 'anndata',
        'encoding-version': '0.1.0'
      });
    },
    async arrayBuffer() {
      throw new Error('root metadata must be read as text');
    }
  });

  const source = new ZarrDataSource();
  t.after(() => source.clear());
  const older = source.loadFromFileList(
    fileListFromMap(firstStore, 'older.zarr')
  );
  const olderAssertion = assert.rejects(older, /superseded/i);
  await firstStarted;
  const newer = await source.loadFromFileList(
    fileListFromMap(
      completeZarrStoreFiles({
        embeddingValues: [9, 10, 11, 12],
        geneValues: [9, 0, 10, 0]
      }),
      'newer.zarr'
    )
  );
  releaseFirst();
  await olderAssertion;

  assert.equal(newer.id, 'zarr_newer');
  assert.deepEqual(
    events
      .filter(event => event.kind !== 'update')
      .map(event => event.kind),
    ['start', 'start', 'complete', 'dismiss']
  );
  const completedId = events.find(event => event.kind === 'complete').id;
  const newerStart = events.find(
    event => event.kind === 'start' && /newer\.zarr/.test(event.name)
  );
  assert.equal(completedId, newerStart.id);
});

test('ZarrDataSource preserves a working source when required embedding bytes are corrupt', async () => {
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

  const source = new ZarrDataSource();
  try {
    await source.loadFromFileList(
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
    corrupt.set(
      'obsm/X_umap_2d/0.0',
      memoryFile(Uint8Array.from([0xff]))
    );

    await assert.rejects(
      source.loadFromFileList(
        fileListFromMap(corrupt, 'corrupt-embedding.zarr')
      ),
      /embedding|chunk|byte length|payload/i
    );
    assert.equal(source.dirname, 'working.zarr');
    assert.equal(source.getAdapter(), workingAdapter);
    assert.deepEqual(
      Array.from(await sourceGeneValuesByName(source, 'A')),
      [1, 2]
    );
    assert.deepEqual(
      Array.from(
        await source.getAdapter().getEmbeddingPayload('embeddings/0_2d.bin', 2)
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
      const loader = sparseLoader({
        format,
        shape: [1, 1],
        data: [16_777_216, 1],
        dataDtype: '<i4',
        dataBytes: littleEndianBytes(
          [16_777_216, 1],
          'setInt32',
          4
        ),
        indices: [0, 0],
        indptr: [0, 2]
      });
      loader._nObs = 1;
      loader._nVars = 1;
      const column = await readXColumn(loader, 0, { sparse: true });
      assert.deepEqual(Array.from(column), [Math.fround(16_777_216 + 1)]);
    });
  }
});

test('Zarr observation dtype metadata cannot be replaced by value inference', async () => {
  const loader = arrayLoader(
    'obs/score',
    metadata({
      shape: [2],
      chunks: [2],
      dtype: 'not-a-zarr-dtype',
    }),
    { 0: littleEndianBytes([1, 2], 'setFloat32', 4) }
  );
  loader._files.set(
    'obs/score/.zattrs',
    memoryFile(JSON.stringify({
      'encoding-type': 'array',
      'encoding-version': '0.2.0',
    }))
  );
  loader._nObs = 2;
  loader._obsKeys = ['score'];

  await assert.rejects(
    loader.getObsField('score'),
    /dtype|unsupported/i
  );
});

test('Zarr and H5AD share one value-kind contract for dense X and booleans', async () => {
  const { validateDenseColumnContract } = zarrModule;
  assert.throws(
    () => validateDenseColumnContract(metadata({
      shape: [2, 2],
      chunks: [2, 2],
      dtype: '|b1',
    })),
    /Dense X has unsupported dtype: \|b1/
  );
  assert.doesNotThrow(() => validateDenseColumnContract(metadata({
    shape: [2, 2],
    chunks: [2, 2],
    dtype: '<f4',
  })));

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
  const loader = connectivityLoader({
    shape: [2, 2],
    data: [1, 1],
    indices: [1, 0],
    indptr: [0, 1, 2],
  }, 2);
  const first = await loader.getConnectivities('connectivities');
  assert.equal(first.indices.length, 2);
  for (const [key, value] of loader._cache) {
    assert.notStrictEqual(value, first, `cache entry "${key}" retains the raw matrix`);
  }
});
