import assert from 'node:assert/strict';
import test from 'node:test';

import * as zarrCodecs from '../assets/js/data/zarr-codecs.js';
import {
  decodeLz4Block,
  decodeVLenUtf8,
  getZarrDtypeInfo
} from '../assets/js/data/zarr-codecs.js';
import * as zarrModule from '../assets/js/data/zarr.js';
import { ZarrDataSource, ZarrLoader } from '../assets/js/data/zarr.js';
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import {
  extractConnectivityEdges,
  getSparseColumn
} from '../assets/js/data/sparse-utils.js';

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
  loader._obsmKeys = [key, ...extraArrays.map(array => array.key)];
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
  assert.deepEqual(adapter.getVarManifest().fields, []);
  assert.deepEqual(adapter.getGeneNames(), []);
  await assert.rejects(
    adapter.getGeneExpression('A'),
    /does not contain an X expression matrix|no X expression matrix/i
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
    await assert.rejects(
      loader.open(fileList),
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
      shape: [100_001],
      chunks: [1]
    })),
    /chunk count.*browser limit/i
  );
  assert.throws(
    () => zarrCodecs.validateZarrArrayMetadata(metadata({
      dtype: '|S9007199254740993'
    })),
    /fixed string.*too large/i
  );
  assert.throws(
    () => zarrCodecs.validateZarrArrayMetadata(metadata({
      shape: [1],
      chunks: [16_777_217],
      dtype: '<i4'
    })),
    /chunk.*browser limit/i
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

test('preflights ordinary numeric observation conversion before payload access', async () => {
  const nObs = 70_000_000;
  const loader = new ZarrLoader();
  loader._files = new Map([
    ['obs/count/.zarray', memoryFile('{}')],
    ['obs/count/.zattrs', memoryFile('{}')]
  ]);
  loader._nObs = nObs;
  loader._readAttrs = async () => ({
    'encoding-type': 'array',
    'encoding-version': '0.2.0'
  });
  loader._readArrayMeta = async () => metadata({
    shape: [nObs],
    chunks: [1000],
    dtype: '<i4'
  });
  let payloadTouched = false;
  loader._readArray = async () => {
    payloadTouched = true;
    throw new Error('ordinary observation payload touched before conversion preflight');
  };

  for (const read of [
    () => loader.getObsFieldInfo('count'),
    () => loader.getObsField('count')
  ]) {
    await assert.rejects(
      read(),
      /observation field.*working set.*browser limit/i
    );
  }
  assert.equal(payloadTouched, false);
});

test('preflights categorical code conversion before either payload access', async () => {
  const nObs = 70_000_000;
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
  loader._nObs = nObs;
  loader._readAttrs = async path => path === 'obs/group'
    ? {
        'encoding-type': 'categorical',
        'encoding-version': '0.2.0',
        ordered: false
      }
    : {
        'encoding-type': path.endsWith('/categories')
          ? 'array'
          : 'array',
        'encoding-version': '0.2.0'
      };
  loader._readArrayMeta = async path => metadata(
    path.endsWith('/codes')
      ? {
          shape: [nObs],
          chunks: [1000],
          dtype: '<i4'
        }
      : {
          shape: [2],
          chunks: [2],
          dtype: '|b1'
        }
  );
  const payloadPaths = [];
  loader._readArray = async path => {
    payloadPaths.push(path);
    throw new Error(`categorical payload '${path}' touched before conversion preflight`);
  };

  for (const read of [
    () => loader.getObsFieldInfo('group'),
    () => loader.getObsField('group')
  ]) {
    await assert.rejects(
      read(),
      /categorical field.*working set.*browser limit/i
    );
  }
  assert.deepEqual(payloadPaths, []);
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
          shape: [65_536],
          chunks: [1024],
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
      /65,536 categories.*at most 65,535.*reduce or merge/i
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
  loader._obsmKeys = ['X_umap_2d'];
  loader.getEmbeddingShape = async () => ({
    shape: [1, 2],
    nDims: 2
  });
  loader.hasConnectivities = async () => false;
  let categoryReads = 0;
  loader._readCategoricalCategories = async () => {
    categoryReads++;
    throw new Error('metadata category payload sentinel');
  };

  const dataset = await loader.getDatasetMetadata();
  assert.equal(dataset.stats.n_categorical_fields, 1);
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
      shape: [1],
      chunks: [1],
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
  loader._nObs = 1;
  loader._obsKeys = ['label'];
  loader.getDatasetMetadata = async () => ({
    version: 2,
    stats: { n_cells: 1, n_genes: 0 },
    embeddings: {
      available_dimensions: [],
      default_dimension: null,
      obsm_keys: {}
    }
  });
  let categoryReads = 0;
  loader._readArray = async path => {
    if (path.endsWith('/categories')) {
      categoryReads++;
      return { data: ['A'], shape: [1], dtype: '|O' };
    }
    return {
      data: Int8Array.from([0]),
      shape: [1],
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

test('preflights VLen counts, materialization size, and file size before allocation', async t => {
  assert.throws(
    () => decodeVLenUtf8(bytesFromHex('ffffff7f'), 0x7fffffff),
    /item count exceeds payload bounds/i
  );

  await t.test('array materialization', () => {
    assert.equal(typeof zarrCodecs.validateZarrMaterialization, 'function');
    assert.throws(
      () => zarrCodecs.validateZarrMaterialization(
        metadata({ shape: [600_000_000], chunks: [1], dtype: '|u1' }),
        getZarrDtypeInfo('|u1')
      ),
      /array.*browser limit/i
    );
  });

  await t.test('fixed-string pointer materialization', () => {
    assert.throws(
      () => zarrCodecs.validateZarrMaterialization(
        metadata({ shape: [70_000_000], chunks: [1], dtype: '|S1' }),
        getZarrDtypeInfo('|S1')
      ),
      /array.*browser limit/i
    );
  });

  await t.test('fixed-string peak working set', () => {
    assert.throws(
      () => zarrCodecs.validateZarrMaterialization(
        metadata({
          shape: [60_000_000],
          chunks: [60_000_000],
          dtype: '|S1'
        }),
        getZarrDtypeInfo('|S1')
      ),
      /string array.*working set.*browser limit/i
    );
  });

  await t.test('numeric result plus chunk working set', () => {
    assert.throws(
      () => zarrCodecs.validateZarrMaterialization(
        metadata({
          shape: [134_217_728],
          chunks: [16_777_216],
          dtype: '<f4'
        }),
        getZarrDtypeInfo('<f4')
      ),
      /array.*working set.*browser limit/i
    );
  });

  await t.test('fixed-string retained payload plus chunk working set', () => {
    assert.throws(
      () => zarrCodecs.validateZarrMaterialization(
        metadata({
          shape: [40_000_000],
          chunks: [8_000_000],
          dtype: '|S8'
        }),
        getZarrDtypeInfo('|S8')
      ),
      /string array.*working set.*browser limit/i
    );
  });

  await t.test('encoded chunk file', async () => {
    let readAttempted = false;
    const loader = arrayLoader(
      'values',
      metadata({ shape: [1], chunks: [1], dtype: '|u1' }),
      {}
    );
    loader._files.set('values/0', {
      size: 65 * 1024 * 1024,
      async arrayBuffer() {
        readAttempted = true;
        throw new Error('oversized file must not be read');
      }
    });

    await assert.rejects(loader._readArray('values'), /chunk file.*browser limit/i);
    assert.equal(readAttempted, false);
  });

  await t.test('decoded object chunk', async () => {
    const oversized = new Uint8Array(zarrCodecs.MAX_ZARR_CHUNK_BYTES + 1);
    new DataView(oversized.buffer).setUint32(0, 1, true);
    await assert.rejects(
      zarrCodecs.decodeZarrChunk(
        oversized,
        metadata({
          shape: [1],
          chunks: [1],
          dtype: '|O',
          filters: [{ id: 'vlen-utf8' }]
        }),
        getZarrDtypeInfo('|O'),
        1
      ),
      /chunk exceeds.*browser limit/i
    );
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
  assert.deepEqual(Array.from(await safe._getDenseColumn(0)), [1, 2]);

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
    unsafe._getDenseColumn(0),
    /dense X.*safe numeric range/i
  );
});

test('preflights dense column output before allocating it', async () => {
  const nRows = Number.MAX_SAFE_INTEGER;
  const loader = arrayLoader(
    'X',
    metadata({
      shape: [nRows, 1],
      chunks: [nRows, 1],
      dtype: '|u1'
    }),
    {}
  );
  loader._nObs = nRows;
  loader._nVars = 1;

  await assert.rejects(
    loader._getDenseColumn(0),
    /dense X(?: column| decoded chunk).*browser limit/i
  );
});

test('chooses dense streaming by Float32 cache size rather than source width', async () => {
  const loader = arrayLoader(
    'X',
    metadata({
      shape: [1, 70_000_000],
      chunks: [1, 700],
      dtype: '|u1'
    }),
    {}
  );
  loader._nObs = 1;
  loader._nVars = 70_000_000;
  let fullReadAttempted = false;
  loader._readArray = async () => {
    fullReadAttempted = true;
    throw new Error('full dense cache must not be materialized');
  };

  assert.deepEqual(Array.from(await loader._getDenseColumn(0)), [0]);
  assert.equal(fullReadAttempted, false);
});

test('bounds the gene LRU by retained bytes as well as entry count', async () => {
  const loader = new ZarrLoader();
  loader._files = new Map([['sentinel', memoryFile('')]]);
  loader._varNameIndex.set('GeneA', 0);
  loader._varNameIndex.set('GeneB', 1);
  loader._getDenseColumn = async index => ({
    byteLength: 200 * 1024 * 1024,
    index
  });

  await loader.getGeneExpression('GeneA');
  await loader.getGeneExpression('GeneB');
  assert.deepEqual(Array.from(loader._geneCache.keys()), ['GeneB']);
  assert.equal(loader._geneCacheBytes, 200 * 1024 * 1024);
});

test('serializes concurrent initialization of the full dense cache', async () => {
  const loader = arrayLoader(
    'X',
    metadata({ shape: [2, 2], chunks: [2, 2], dtype: '<f4' }),
    {}
  );
  loader._nObs = 2;
  loader._nVars = 2;
  loader._varNameIndex.set('GeneA', 0);
  loader._varNameIndex.set('GeneB', 1);
  let fullReadCount = 0;
  loader._readArray = async () => {
    fullReadCount++;
    await Promise.resolve();
    return {
      data: new Float32Array([1, 2, 3, 4]),
      shape: [2, 2],
      dtype: '<f4'
    };
  };

  const [geneA, geneB] = await Promise.all([
    loader.getGeneExpression('GeneA'),
    loader.getGeneExpression('GeneB')
  ]);
  assert.equal(fullReadCount, 1);
  assert.deepEqual(Array.from(geneA), [1, 3]);
  assert.deepEqual(Array.from(geneB), [2, 4]);
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
      assert.deepEqual(Array.from(await loader._getSparseColumn(0)), [5, 0]);
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
    directCsc._getSparseColumn(0),
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
        loader._getSparseColumn(2),
        /sparse X column index.*out of bounds/i
      );
    });
  }
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

test('preflights embedding Float32 expansion before reading the array', async () => {
  const loader = arrayLoader(
    'obsm/X_umap',
    metadata({
      shape: [200_000_000, 1],
      chunks: [2000, 1],
      dtype: '|u1'
    }),
    {}
  );
  setCurrentMapping(loader._files, 'obsm');
  loader._nObs = 200_000_000;
  let fullReadAttempted = false;
  loader._readArray = async () => {
    fullReadAttempted = true;
    throw new Error('oversized embedding must not be read');
  };

  await assert.rejects(
    loader.getEmbedding('X_umap'),
    /embedding.*browser limit/i
  );
  assert.equal(fullReadAttempted, false);
});

test('preflights retained raw and normalized public embedding storage', async () => {
  const nObs = 70_000_000;
  const loader = arrayLoader(
    'obsm/X_umap',
    metadata({
      shape: [nObs, 1],
      chunks: [1000, 1],
      dtype: '<f4'
    }),
    {}
  );
  setCurrentMapping(loader._files, 'obsm');
  loader._nObs = nObs;
  let payloadTouched = false;
  loader._readArray = async () => {
    payloadTouched = true;
    throw new Error('embedding payload touched before public working-set preflight');
  };

  await assert.rejects(
    loader.getEmbedding('X_umap'),
    /embedding.*public working set.*browser limit/i
  );
  assert.equal(payloadTouched, false);
});

test('rejects finite values that overflow during Float32 conversion', async () => {
  const embedding = arrayLoader(
    'obsm/X_umap',
    metadata({ shape: [1, 1], chunks: [1, 1], dtype: '<f8' }),
    { '0.0': littleEndianBytes([1e308], 'setFloat64', 8) }
  );
  setCurrentMapping(embedding._files, 'obsm');
  embedding._nObs = 1;
  await assert.rejects(
    embedding.getEmbedding('X_umap'),
    /embedding.*Float32 range/i
  );

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
    denseFill._getDenseColumn(0),
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
        shape: [1, 2],
        chunks: [1, 2],
        values: [value, 0],
        nObs: 1
      });
      await assert.rejects(
        loader.getEmbedding('X_umap_2d'),
        /embedding.*X_umap_2d.*non-finite.*component/i
      );
      assert.equal(loader._cache.has('obsm:X_umap_2d'), false);
    });
  }
});

test('Zarr releases only the exact requested raw embedding cache entry', () => {
  const loader = new ZarrLoader();
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

test('Zarr adapter enforces the raw plus normalized coordinate ceiling and releases the loader cache', async () => {
  const loader = embeddingLoader({
    shape: [1, 2],
    chunks: [1, 2],
    values: [0, 1],
    nObs: 1
  });
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

test('caps cumulative decoded string storage rather than only pointer count', () => {
  assert.equal(typeof zarrCodecs.accountZarrStringStorage, 'function');
  const oneMiB = 'x'.repeat(1024 * 1024);
  assert.throws(
    () => zarrCodecs.accountZarrStringStorage(
      0,
      new Array(257).fill(oneMiB)
    ),
    /string array.*browser limit/i
  );
});

test('preflights sparse component dtypes and aggregate working memory', () => {
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

  assert.throws(
    () => zarrModule.validateSparseArrayContract({
      format: 'csr',
      shape: [50_000_000, 50_000_000],
      dataMeta: metadata({
        shape: [50_000_000],
        chunks: [1000],
        dtype: '<f4'
      }),
      indicesMeta: metadata({
        shape: [50_000_000],
        chunks: [1000],
        dtype: '<i4'
      }),
      indptrMeta: metadata({
        shape: [50_000_001],
        chunks: [1000],
        dtype: '<i4'
      })
    }),
    /sparse.*working set.*browser limit/i
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

test('rejects duplicate var names instead of silently selecting the last column', async () => {
  await assert.rejects(
    denseStructureLoader({ varNames: ['A', 'A'] })._readStructure(),
    /duplicate.*var.*A.*var_names_make_unique/i
  );
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
        Array.from((await loader.getEmbedding('X_umap_2d')).data),
        [0, 0, 2, 4]
      );
      assert.deepEqual(
        Array.from(await loader.getGeneExpression('A')),
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
        Array.from((await loader.getEmbedding('X_umap_2d')).data),
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
        Array.from((await loader.getEmbedding('X_umap_2d')).data),
        [0, 0, 2, 4]
      );
      assert.deepEqual(
        Array.from(await loader.getGeneExpression('A')),
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
        Array.from((await loader.getEmbedding('X_umap_2d')).data),
        [0, 0, 2, 4]
      );
      assert.deepEqual(
        Array.from(await loader.getGeneExpression('A')),
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
        Array.from((await loader.getEmbedding('X_umap_2d')).data),
        [0, 0, 2, 4]
      );
      assert.deepEqual(
        Array.from(await loader.getGeneExpression('A')),
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
        Array.from((await loader.getEmbedding('X_umap_2d')).data),
        [0, 0, 2, 4]
      );
      assert.deepEqual(
        Array.from(await loader.getGeneExpression('A')),
        [1, 3]
      );
    });
  }
});

test('public Zarr loading rejects X with no canonical var and preserves the working source', async () => {
  const notifications = getNotificationCenter();
  const originalWarning = notifications.warning;
  notifications.warning = () => 'warning';

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
      Array.from(await source.getGeneExpression('A')),
      [1, 2]
    );
    assert.deepEqual(
      Array.from(await source.getEmbedding(2)),
      [-1, -1, 1, 1]
    );
  } finally {
    source.clear();
    notifications.warning = originalWarning;
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
      loader.getConnectivities(),
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
      loader.getConnectivities(),
      /connectivity.*shape.*3.*2 cells/i
    );
  });

  await t.test('adapter propagation', async () => {
    const adapter = new BaseAnnDataAdapter({
      nObs: 2,
      async getConnectivities() {
        throw new Error('malformed connectivity payload');
      }
    });
    await assert.rejects(
      adapter.getConnectivityEdges(),
      /malformed connectivity payload/i
    );
  });
});

test('public Zarr loading requires explicit UMAP and never substitutes another embedding', async t => {
  const notifications = getNotificationCenter();
  const originalWarning = notifications.warning;
  notifications.warning = () => 'warning';

  try {
    for (const substituteKey of ['X_pca', 'X_tsne', 'X_phate']) {
      await t.test(substituteKey, async () => {
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

          const replacement = completeZarrStoreFiles({
            embeddingValues: [9, 9, 10, 10],
            geneValues: [9, 0, 10, 0]
          });
          const embeddingMeta =
            replacement.get('obsm/X_umap_2d/.zarray');
          const embeddingAttrs =
            replacement.get('obsm/X_umap_2d/.zattrs');
          const embeddingChunk =
            replacement.get('obsm/X_umap_2d/0.0');
          replacement.delete('obsm/X_umap_2d/.zarray');
          replacement.delete('obsm/X_umap_2d/.zattrs');
          replacement.delete('obsm/X_umap_2d/0.0');
          replacement.set(
            `obsm/${substituteKey}/.zarray`,
            embeddingMeta
          );
          replacement.set(
            `obsm/${substituteKey}/.zattrs`,
            embeddingAttrs
          );
          replacement.set(
            `obsm/${substituteKey}/0.0`,
            embeddingChunk
          );

          await assert.rejects(
            source.loadFromFileList(
              fileListFromMap(
                replacement,
                `${substituteKey.slice(2)}-only.zarr`
              ),
              { showProgress: false }
            ),
            /requires an exact UMAP embedding/i
          );
          assert.equal(source.dirname, 'working.zarr');
          assert.equal(source.getAdapter(), workingAdapter);
          assert.deepEqual(
            Array.from(await source.getGeneExpression('A')),
            [1, 2]
          );
          assert.deepEqual(
            Array.from(await source.getEmbedding(2)),
            [-1, -1, 1, 1]
          );
        } finally {
          source.clear();
        }
      });
    }
  } finally {
    notifications.warning = originalWarning;
  }
});

test('Zarr metadata accepts only exact dimension-suffixed UMAP keys', async t => {
  await t.test('an unsuffixed X_umap array is never shape-inferred', async () => {
    const loader = embeddingLoader({ key: 'X_umap' });
    let shapeReads = 0;
    loader.getEmbeddingShape = async () => {
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
    const loader = embeddingLoader({
      extraArrays: [{
        key: 'X_umap',
        shape: [2, 2],
        values: [4, 4, 5, 5],
      }],
    });
    const getEmbeddingShape =
      loader.getEmbeddingShape.bind(loader);
    const shapeReads = [];
    loader.getEmbeddingShape = async key => {
      shapeReads.push(key);
      return getEmbeddingShape(key);
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
    const loader = embeddingLoader({
      key: 'X_umap_2d',
      shape: [2, 3],
      values: [0, 0, 0, 1, 1, 1],
      extraArrays: [{
        key: 'X_umap_3d',
        shape: [2, 3],
        values: [2, 2, 2, 3, 3, 3],
      }],
    });

    await assert.rejects(
      loader.getDatasetMetadata(),
      /X_umap_2d.*3 columns.*2D suffix/i
    );
  });
});

test('centralizes the numeric, rank, width, and observation-axis embedding contract', async t => {
  const cases = [
    [
      'zero columns',
      embeddingLoader({ key: 'X_umap', shape: [2, 0], chunks: [2, 1] }),
      /embedding.*positive.*columns|embedding.*1.*3/i
    ],
    [
      'wrong rank',
      embeddingLoader({ key: 'X_umap', shape: [2], chunks: [2] }),
      /embedding.*two-dimensional/i
    ],
    [
      'wrong row count',
      embeddingLoader({
        key: 'X_umap',
        shape: [1, 2],
        chunks: [1, 2],
        values: [0, 1]
      }),
      /embedding.*rows.*2 cells/i
    ],
    [
      'nonnumeric dtype',
      embeddingLoader({
        key: 'X_umap',
        shape: [2, 2],
        dtype: '|S1'
      }),
      /embedding.*encoding-type.*array|embedding.*numeric dtype/i
    ]
  ];

  for (const [name, loader, expectedError] of cases) {
    await t.test(name, async () => {
      await assert.rejects(loader.getEmbeddingShape('X_umap'), expectedError);
    });
  }

  const direct = embeddingLoader({
    key: 'X_umap',
    shape: [1, 2],
    chunks: [1, 2],
    values: [0, 1]
  });
  await assert.rejects(
    direct.getEmbedding('X_umap'),
    /embedding.*rows.*2 cells/i
  );
});

test('rejects a dimension-suffixed vector field with the wrong cell axis', async () => {
  const loader = embeddingLoader({
    extraArrays: [{
      key: 'velocity_umap_2d',
      shape: [1, 2],
      values: [1, 2]
    }]
  });
  const adapter = new BaseAnnDataAdapter(loader);
  await assert.rejects(
    adapter.initialize(),
    /velocity_umap_2d.*1 rows.*2 cells/i
  );
  assert.equal(adapter.getMetadata(), null);
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
      await assert.rejects(loader.hasConnectivities(), expected);
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
    loader.hasConnectivities(),
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
  const result = await loader.getConnectivities();
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
  connLoader._obsmKeys = ['X_umap_2d'];

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
  loader._nObs = 2;
  let calls = 0;
  loader._readSparseMatrix = async () => {
    calls++;
    if (calls === 1) throw new Error('transient sparse read failure');
    return {
      format: 'csc',
      shape: [2, 1],
      data: Float32Array.from([4]),
      indices: Int32Array.from([0]),
      indptr: Int32Array.from([0, 1]),
      cscData: null
    };
  };

  await assert.rejects(
    loader._getSparseColumn(0),
    /transient sparse read failure/i
  );
  assert.deepEqual(Array.from(await loader._getSparseColumn(0)), [4, 0]);
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
  assert.deepEqual(Array.from((await loader.getEmbedding('X_umap_2d')).data), [0, 0, 2, 4]);
  assert.deepEqual(Array.from(await loader.getGeneExpression('A')), [1, 3]);

  await loader.openFileMap(
    completeZarrStoreFiles({
      embeddingValues: [10, 20, 30, 40],
      geneValues: [5, 6, 7, 8]
    }),
    'second.zarr'
  );
  assert.deepEqual(
    Array.from((await loader.getEmbedding('X_umap_2d')).data),
    [10, 20, 30, 40]
  );
  assert.deepEqual(Array.from(await loader.getGeneExpression('A')), [5, 7]);

  await assert.rejects(
    loader.openFileMap(malformed, 'replacement.zarr'),
    /JSON|property name|expected/i
  );
  assert.equal(loader.isOpen, true);
  assert.deepEqual(
    Array.from((await loader.getEmbedding('X_umap_2d')).data),
    [10, 20, 30, 40]
  );
  assert.deepEqual(Array.from(await loader.getGeneExpression('A')), [5, 7]);
});

test('rejects categorical dictionaries that would require uint32 buffers', async () => {
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

  assert.throws(
    () => adapter.getObsManifest(),
    /65,536 categories.*at most 65,535.*reduce or merge/i
  );
  await assert.rejects(
    adapter.getObsFieldData('large_category'),
    /65,536 categories.*at most 65,535.*reduce or merge/i
  );
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

test('rejects big-endian and temporary-string peaks before allocating chunks', () => {
  const bigEndian = metadata({
    shape: [100_000_000],
    chunks: [16_777_216],
    dtype: '>f4'
  });
  assert.throws(
    () => zarrCodecs.validateZarrMaterialization(
      bigEndian,
      getZarrDtypeInfo(bigEndian.dtype)
    ),
    /peak working set.*browser limit/i
  );

  const fixedEdgeChunk = metadata({
    shape: [1],
    chunks: [16_000_000],
    dtype: '|S4',
    fill_value: ''
  });
  assert.throws(
    () => zarrCodecs.validateZarrMaterialization(
      fixedEdgeChunk,
      getZarrDtypeInfo(fixedEdgeChunk.dtype)
    ),
    /string array peak working set.*browser limit/i
  );

  const vlenEdgeChunk = metadata({
    shape: [1],
    chunks: [8_000_000],
    dtype: '|O',
    filters: [{ id: 'vlen-utf8' }],
    fill_value: ''
  });
  assert.throws(
    () => zarrCodecs.validateZarrMaterialization(
      vlenEdgeChunk,
      getZarrDtypeInfo(vlenEdgeChunk.dtype)
    ),
    /string array peak working set.*browser limit/i
  );
});

test('preflights dense and sparse connectivity edge storage before payload access', () => {
  let denseTouched = false;
  const denseData = new Proxy(
    {
      // A plausible 6000×6000 Float64 payload fits with one canonical edge
      // pair, but not with the additional render-owned pair.
      length: 36_000_000,
      byteLength: 288_000_000,
    },
    {
      get(target, property) {
        if (/^\d+$/.test(String(property))) {
          denseTouched = true;
          throw new Error('dense payload touched before capacity validation');
        }
        return target[property];
      }
    }
  );
  assert.throws(
    () => extractConnectivityEdges({
      format: 'dense',
      shape: [6_000, 6_000],
      data: denseData
    }, 6_000),
    /connectivity edge working set.*browser limit/i
  );
  assert.equal(denseTouched, false);

  let sparseTouched = false;
  const sparseIndices = new Proxy(
    { length: 40_000_000, byteLength: 160_000_000 },
    {
      get(target, property) {
        if (/^\d+$/.test(String(property))) {
          sparseTouched = true;
          throw new Error('sparse payload touched before capacity validation');
        }
        return target[property];
      }
    }
  );
  const sparseData = new Proxy(
    { length: 40_000_000, byteLength: 160_000_000 },
    {
      get(target, property) {
        if (/^\d+$/.test(String(property))) {
          sparseTouched = true;
          throw new Error('sparse payload touched before capacity validation');
        }
        return target[property];
      }
    }
  );
  assert.throws(
    () => extractConnectivityEdges({
      format: 'csr',
      shape: [2, 2],
      data: sparseData,
      indptr: Int32Array.from([0, 40_000_000, 40_000_000]),
      indices: sparseIndices
    }, 2),
    /connectivity edge working set.*browser limit/i
  );
  assert.equal(sparseTouched, false);
});

test('does not publish an invalidated in-flight sparse matrix into replacement state', async () => {
  const loader = new ZarrLoader();
  loader._nObs = 1;
  let resolveOld;
  let calls = 0;
  const oldRead = new Promise(resolve => {
    resolveOld = resolve;
  });
  loader._readSparseMatrix = async () => {
    calls++;
    if (calls === 1) return oldRead;
    return {
      format: 'csc',
      shape: [1, 1],
      data: Float32Array.from([9]),
      indices: Int32Array.from([0]),
      indptr: Int32Array.from([0, 1]),
      cscData: null
    };
  };

  const oldColumn = loader._getSparseColumn(0);
  const staleAssertion = assert.rejects(
    oldColumn,
    /dataset.*(changed|superseded)|superseded.*dataset/i
  );
  await Promise.resolve();
  loader.clearCache();
  resolveOld({
    format: 'csc',
    shape: [1, 1],
    data: Float32Array.from([7]),
    indices: Int32Array.from([0]),
    indptr: Int32Array.from([0, 1]),
    cscData: null
  });

  await staleAssertion;
  assert.deepEqual(Array.from(await loader._getSparseColumn(0)), [9]);
  assert.equal(calls, 2);
});

test('rejects integer observation values that Float32 cannot represent exactly', async () => {
  const loader = arrayLoader(
    'obs/count',
    metadata({ shape: [1], chunks: [1], dtype: '<i8' }),
    { 0: littleEndianBytes([16_777_217n], 'setBigInt64', 8) }
  );
  loader._nObs = 1;
  const adapter = new BaseAnnDataAdapter(loader);
  adapter._obsFieldsMetadata = [{ key: 'count', kind: 'continuous' }];

  await assert.rejects(
    adapter.getObsFieldData('count'),
    /observation field.*count.*exactly.*Float32|precision/i
  );
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

    const staleRequest = loader.getGeneExpression('A');
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
    assert.deepEqual(Array.from(await loader.getGeneExpression('A')), [9, 10]);
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

    const staleRequest = loader.getEmbedding('X_umap_2d');
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
      Array.from((await loader.getEmbedding('X_umap_2d')).data),
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
    loader._varNameIndex = new Map([['A', 0]]);
    loader._xIsSparse = true;

    let markStarted;
    let releaseOld;
    const started = new Promise(resolve => {
      markStarted = resolve;
    });
    const oldRead = new Promise(resolve => {
      releaseOld = resolve;
    });
    let calls = 0;
    loader._readSparseMatrix = async () => {
      calls++;
      if (calls === 1) {
        markStarted();
        return oldRead;
      }
      return {
        format: 'csc',
        shape: [1, 1],
        data: Float32Array.from([9]),
        indices: Int32Array.from([0]),
        indptr: Int32Array.from([0, 1]),
        cscData: null
      };
    };

    const staleRequest = loader.getGeneExpression('A');
    const staleAssertion = assert.rejects(staleRequest, supersededPattern);
    await started;
    loader.clearCache();
    releaseOld({
      format: 'csc',
      shape: [1, 1],
      data: Float32Array.from([7]),
      indices: Int32Array.from([0]),
      indptr: Int32Array.from([0, 1]),
      cscData: null
    });

    await staleAssertion;
    assert.deepEqual(Array.from(await loader.getGeneExpression('A')), [9]);
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

    const staleRequest = loader.hasConnectivities();
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
    assert.equal(await loader.hasConnectivities(), false);
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

    const staleRequest = loader.getConnectivities();
    const staleAssertion = assert.rejects(staleRequest, supersededPattern);
    await started;
    loader._files = new Map([['.zattrs', memoryFile('{}')]]);
    loader.clearCache();
    releaseOld({
      data: Float32Array.from([1]),
      shape: [1, 1]
    });

    await staleAssertion;
    assert.equal(await loader.getConnectivities(), null);
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
  loader.getDatasetMetadata = async () => ({
    version: 2,
    id: 'nullable-categories',
    name: 'nullable-categories',
    stats: { n_cells: 3, n_genes: 0 },
    embeddings: {
      available_dimensions: [],
      default_dimension: null,
      obsm_keys: {}
    }
  });

  const adapter = new BaseAnnDataAdapter(loader);
  await adapter.initialize();

  const categorical = adapter.getObsManifest()._categoricalFields[0];
  assert.equal(categorical[0], 'label');
  assert.deepEqual(categorical[1], ['A', 'C']);
  const field = await adapter.getObsFieldData('label');
  assert.equal(field.kind, 'category');
  assert.deepEqual(field.categories, ['A', 'C']);
  assert.deepEqual(Array.from(new Uint8Array(field.data)), [0, 255, 1]);
});

test('preflights nullable fields as one working set before reading payloads', async () => {
  const nObs = 50_000_000;
  const loader = new ZarrLoader();
  loader._files = new Map([
    ['obs/count/.zgroup', memoryFile('{"zarr_format":2}')],
    ['obs/count/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'nullable-integer',
      'encoding-version': '0.1.0'
    }))]
  ]);
  loader._nObs = nObs;
  loader._readAttrs = async path => path === 'obs/count'
    ? {
        'encoding-type': 'nullable-integer',
        'encoding-version': '0.1.0'
      }
    : {
        'encoding-type': 'array',
        'encoding-version': '0.2.0'
      };
  loader._readArrayMeta = async path => metadata({
    shape: [nObs],
    chunks: [1_000_000],
    dtype: path.endsWith('/mask') ? '|b1' : '<i8',
    fill_value: path.endsWith('/mask') ? false : 0
  });
  let payloadTouched = false;
  loader._readArray = async () => {
    payloadTouched = true;
    throw new Error('nullable payload touched before aggregate preflight');
  };

  await assert.rejects(
    loader.getObsField('count'),
    /nullable.*working set.*browser limit/i
  );
  assert.equal(payloadTouched, false);
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

test('includes transient strings in the combined nullable working set', async () => {
  // At this size the string array still fits independently, while its retained
  // values plus mask and public nullable output exceed the combined ceiling.
  const nObs = 1_755_000;
  const loader = new ZarrLoader();
  loader._files = new Map([
    ['obs/label/.zgroup', memoryFile('{"zarr_format":2}')],
    ['obs/label/.zattrs', memoryFile(JSON.stringify({
      'encoding-type': 'nullable-string-array',
      'encoding-version': '0.1.0'
    }))]
  ]);
  loader._nObs = nObs;
  loader._readAttrs = async path => path === 'obs/label'
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
    shape: [nObs],
    chunks: [nObs],
    dtype: path.endsWith('/mask') ? '|b1' : '|O',
    fill_value: path.endsWith('/mask') ? false : 0,
    filters: path.endsWith('/mask') ? null : [{ id: 'vlen-utf8' }]
  });
  let payloadTouched = false;
  loader._readArray = async () => {
    payloadTouched = true;
    throw new Error('nullable string payload touched before aggregate preflight');
  };

  await assert.rejects(
    loader.getObsField('label'),
    /nullable.*working set.*browser limit/i
  );
  assert.equal(payloadTouched, false);
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
  assert.deepEqual(Array.from(await loader.getGeneExpression('A')), [1, 3]);
  assert.deepEqual(
    Array.from((await loader.getEmbedding('X_umap_2d')).data),
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
  assert.deepEqual(Array.from(await loader.getGeneExpression('A')), [9, 10]);
});

test('Zarr low-level directory open is silent when nested and neutral when stale', async t => {
  const events = captureDownloadNotifications(t);
  const createStore = values => completeZarrStoreFiles({
    embeddingValues: values,
    geneValues: [1, 0, 2, 0],
  });

  const silent = new ZarrLoader();
  await silent.open(
    fileListFromMap(createStore([0, 0, 1, 1]), 'silent.zarr'),
    { showProgress: false }
  );
  assert.deepEqual(events, []);

  const direct = new ZarrLoader();
  await direct.open(
    fileListFromMap(createStore([0, 0, 1, 1]), 'direct.zarr')
  );
  assert.equal(events[0].kind, 'start');
  assert.equal(events.at(-1).kind, 'complete');
  assert.equal(
    events.some(event => event.kind === 'fail' || event.kind === 'dismiss'),
    false
  );

  events.length = 0;
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
  const older = overlapping.open(
    fileListFromMap(firstStore, 'older.zarr')
  );
  const olderAssertion = assert.rejects(older, /superseded/i);
  await firstStarted;
  await overlapping.open(
    fileListFromMap(createStore([9, 10, 11, 12]), 'newer.zarr')
  );
  releaseFirst();
  await olderAssertion;

  assert.deepEqual(
    events
      .filter(event => event.kind !== 'update')
      .map(event => event.kind),
    ['start', 'start', 'complete', 'dismiss']
  );
});

test('keeps the latest concurrent ZarrDataSource selection', async () => {
  const notifications = getNotificationCenter();
  const notificationMethods = [
    'warning',
    'startDownload',
    'updateDownload',
    'completeDownload',
    'failDownload',
    'dismissDownload'
  ];
  const originals = new Map(
    notificationMethods.map(name => [name, notifications[name]])
  );
  notifications.warning = () => 'warning';
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
      Array.from(await source.getGeneExpression('A')),
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
  const originalWarning = notifications.warning;
  const warnings = [];
  notifications.warning = (...args) => {
    warnings.push(args);
    return `warning-${warnings.length}`;
  };
  t.after(() => {
    notifications.warning = originalWarning;
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
  const originalWarning = notifications.warning;
  notifications.warning = () => {};
  t.after(() => {
    notifications.warning = originalWarning;
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
    'warning',
    'startDownload',
    'updateDownload',
    'completeDownload',
    'failDownload'
  ];
  const originals = new Map(
    notificationMethods.map(name => [name, notifications[name]])
  );
  notifications.warning = () => 'warning';
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
      Array.from(await source.getGeneExpression('A')),
      [1, 2]
    );
    assert.deepEqual(
      Array.from(await source.getEmbedding(2)),
      [-1, -1, 1, 1]
    );
  } finally {
    source.clear();
    for (const [name, method] of originals) {
      notifications[name] = method;
    }
  }
});

test('rejects non-exact duplicate integer sparse sums', async t => {
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
      await assert.rejects(
        loader._getSparseColumn(0),
        /sparse.*exactly.*Float32|sparse.*precision/i
      );
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
