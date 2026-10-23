/**
 * Byte-order contract for direct `.h5ad` reading.
 *
 * The array store (`formats/store.js`) records each array's stored byte order
 * in its element type and always returns values in host order; the AnnData
 * reader judges arrays by kind alone, so `>f4` and `<f4` read identically.
 * These tests pin that guarantee against real HDF5 files rather than assuming
 * it: `byte-order-big-endian.h5ad` and `byte-order-little-endian.h5ad` carry
 * identical values and differ only in the recorded datatype byte order, and
 * the reader must return the same numbers from both.
 *
 * A regression here is silent: a byte-swapped float is finite and plausible,
 * so a wrong plot would render without any error. The assertions therefore
 * compare exact values, never shapes or counts.
 */

import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { H5adDataSource } from '../assets/js/data/h5ad.js';
import { valueKind } from '../assets/js/data/anndata/elements.js';
import { openHdf5 } from '../assets/js/formats/hdf5/index.js';
import { storeDtype } from '../assets/js/formats/hdf5/datatype.js';
import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { edgeWeightsFrom, edgeWeightsOf, edgeListOf } from './helpers/connectivity-edges.mjs';
import { storedObsm } from './helpers/stored-obsm.mjs';

const BIG_ENDIAN_FIXTURE = fileURLToPath(
  new URL('./browser/fixtures/byte-order-big-endian.h5ad', import.meta.url)
);
const LITTLE_ENDIAN_FIXTURE = fileURLToPath(
  new URL('./browser/fixtures/byte-order-little-endian.h5ad', import.meta.url)
);

// Exactly the values written by scripts/generate-byte-order-h5ad-fixtures.py.
const EXPECTED = {
  embedding2d: [
    -4.5, 2.25, 0.5, -3.75, 12, 0.125, -0.0625, 48,
    7.5, -1.5, -256, 0.75, 3.25, 1024, -0.5, -0.125,
  ],
  embedding3d: [
    1.25, -2.5, 4, -8, 16.5, -0.75, 0.5, 0.25, -128, 64, -0.125, 2,
    -1.5, 32, 0.375, 256, -4.25, -6, -0.25, 1.75, 512, 3.5, -0.0625, 0.5,
  ],
  genes: {
    GENE_A: [1.5, 96, 1024, -8192, 0, 2.5, 65536, 7.125],
    GENE_B: [-2.25, 6.5, 0.001953125, 0.75, 1, -32, -0.25, 448],
    GENE_C: [0.125, -0.5, 3.75, 17.5, -1, 0.0625, 12, -0.03125],
  },
  obs: {
    score_f4: [1.5, -2.25, 0.125, 96, 6.5, -0.5, 1024, 0.001953125],
    score_f8: [1.5, -2.25, 0.125, 96, 6.5, -0.5, 1024, 0.001953125],
    count_i4: [1, -2, 65536, -2147483648, 16777216, 2130706432, 0, -16777216],
    count_u4: [1, 2, 65536, 4278190080, 16777216, 0, 4294967040, 256],
    count_i2: [1, -2, 32767, -32768, 256, 0, 4660, -4660],
    count_u2: [1, 2, 65535, 40000, 256, 0, 4660, 43981],
  },
  obsDtype: {
    score_f4: 'float',
    score_f8: 'float',
    count_i4: 'int',
    count_u4: 'uint',
    count_i2: 'int',
    count_u2: 'uint',
  },
  categorical: {
    codes: [0, 1, 2, 0, 1, 2, 0, 1],
    categories: ['alpha', 'beta', 'gamma'],
    ordered: false,
  },
  edges: {
    sources: [0, 0, 1, 2, 3, 6],
    destinations: [1, 2, 3, 4, 5, 7],
    weights: [0.5, 0.25, 0.75, 1, 0.125, 0.0625],
    nCells: 8,
    nEdges: 6,
    maxNeighbors: 2,
  },
};

/**
 * Reinterpret `values` as if their little-endian bytes had been read
 * big-endian. This is what the reader would produce if the byte-order
 * guarantee ever broke, and it is asserted to differ from the fixture values
 * so the fixture cannot silently stop discriminating.
 */
function readWithSwappedByteOrder(values, ArrayType) {
  const source = new ArrayType(values);
  const bytes = new Uint8Array(source.buffer.slice(0));
  const width = ArrayType.BYTES_PER_ELEMENT;
  for (let start = 0; start < bytes.length; start += width) {
    for (let offset = 0; offset < width >> 1; offset++) {
      const left = start + offset;
      const right = start + width - 1 - offset;
      const held = bytes[left];
      bytes[left] = bytes[right];
      bytes[right] = held;
    }
  }
  return Array.from(new ArrayType(bytes.buffer));
}

function silenceNotifications(t) {
  const notifications = getNotificationCenter();
  const methodNames = [
    'startDownload',
    'updateDownload',
    'completeDownload',
    'failDownload',
    'dismissDownload',
    'warning',
    'error',
    'info',
  ];
  const originals = new Map(
    methodNames.map(name => [name, notifications[name]])
  );
  let nextId = 0;
  for (const name of methodNames) {
    notifications[name] = () => `${name}-${++nextId}`;
  }
  t.after(() => {
    for (const [name, method] of originals) {
      if (method === undefined) delete notifications[name];
      else notifications[name] = method;
    }
  });
}

function bytesOf(buffer) {
  return Array.from(new Uint8Array(buffer));
}

/**
 * Read every user-visible number a direct `.h5ad` load produces, through the
 * same public entry point the file picker uses.
 */
async function readEverything(t, fixturePath) {
  const bytes = await readFile(fixturePath);
  const file = new File([bytes], path.basename(fixturePath), {
    type: 'application/x-hdf5',
  });
  const source = new H5adDataSource();
  t.after(() => {
    source.clear();
  });

  const descriptor = await source.loadFromFile(file);
  const loader = source._loader;

  const embeddings = {};
  for (const key of ['X_umap_2d', 'X_umap_3d']) {
    const nDims = Number(key.at(-2));
    const columns = Array.from({ length: nDims }, (_, column) => column);
    const data = await storedObsm(file, key, columns);
    embeddings[key] = {
      data: Array.from(data),
      shape: [data.length / nDims, nDims],
      nDims,
    };
  }

  const genes = {};
  for (const name of Object.keys(EXPECTED.genes)) {
    const index = loader.varNames.indexOf(name);
    assert.notEqual(index, -1, `gene ${name} is on the var index`);
    genes[name] = Array.from(await loader.getMatrixColumn('X', index));
  }

  const obs = {};
  for (const key of Object.keys(EXPECTED.obs)) {
    const field = await loader.getObsField(key);
    obs[key] = { dtype: field.dtype, values: Array.from(field.values) };
  }
  const categorical = await loader.getObsField('cell_type');

  const edges = await source.getConnectivityEdges();

  // The renderer-facing surface: normalized positions, packed obs payloads,
  // and the field lists built from them. These are what actually reach the
  // GPU and the UI, so they are compared as raw bytes.
  const identityEmbeddings = source.getAdapter().getMetadata().embeddings;
  const shown = dimension =>
    identityEmbeddings.items[identityEmbeddings.defaults[`${dimension}d`]].path;
  const published = {
    embedding2d: Array.from(
      (await source.getAdapter().getEmbeddingPayload(shown(2), 2)).positions
    ),
    embedding3d: Array.from(
      (await source.getAdapter().getEmbeddingPayload(shown(3), 3)).positions
    ),
    candidates: JSON.stringify(source.getAdapter().getMappingCandidates()),
    genes: {},
    obs: {},
    obsFields: JSON.stringify(source.getObsFields()),
    geneList: JSON.stringify(await source.getGeneList()),
    connectivitySummary: JSON.stringify(await source.getConnectivitySummary()),
  };
  const geneList = JSON.parse(published.geneList);
  for (const name of Object.keys(EXPECTED.genes)) {
    const field = geneList.fields.find(gene => gene.key === name);
    assert.ok(field, `gene ${name} is in the gene list`);
    published.genes[name] = Array.from(
      await source.getAdapter().getGeneValues(field.path)
    );
  }
  for (const key of [...Object.keys(EXPECTED.obs), 'cell_type']) {
    const field = await source.getObsFieldData(key);
    published.obs[key] = { ...field, data: bytesOf(field.data) };
  }

  return {
    stats: descriptor.stats,
    published,
    embeddings,
    genes,
    obs,
    categorical: {
      codes: Array.from(categorical.codes),
      categories: categorical.categories,
      ordered: categorical.ordered,
      values: categorical.values,
    },
    edges: {
      sources: Array.from(edgeListOf(edges).sources),
      destinations: Array.from(edgeListOf(edges).destinations),
      ...edgeWeightsOf(edges),
      nCells: edges.nCells,
      nEdges: edges.nEdges,
      maxNeighbors: edges.maxNeighbors,
    },
  };
}

async function openFixture(fixturePath) {
  const bytes = new Uint8Array(await readFile(fixturePath));
  return openHdf5(createByteReader(bytesByteSource(bytes, { name: path.basename(fixturePath) })));
}

const BYTE_ORDERED_ARRAYS = [
  'X',
  'obsm/X_umap_2d',
  'obsm/X_umap_3d',
  'obsp/connectivities/data',
  'obsp/connectivities/indices',
  'obs/score_f4',
  'obs/score_f8',
  'obs/count_i4',
  'obs/count_u4',
  'obs/count_i2',
  'obs/count_u2',
];

test('the AnnData value kind of an array is independent of its stored byte order', async () => {
  const big = await openFixture(BIG_ENDIAN_FIXTURE);
  const little = await openFixture(LITTLE_ENDIAN_FIXTURE);
  try {
    for (const key of BYTE_ORDERED_ARRAYS) {
      const bigArray = big.get(key);
      const littleArray = little.get(key);
      assert.equal(valueKind(bigArray), valueKind(littleArray), `${key} has one kind in both byte orders`);
      assert.notEqual(valueKind(bigArray), 'unknown', `${key} is a value AnnData reads`);
      assert.equal(bigArray.dtype.name, littleArray.dtype.name, `${key} has one element type in both byte orders`);
    }
    assert.equal(valueKind(big.get('obs/score_f4')), 'float');
    assert.equal(valueKind(big.get('obs/count_i2')), 'int');
    assert.equal(valueKind(big.get('obs/count_u4')), 'uint');
  } finally {
    big.close();
    little.close();
  }
});

test('the byte-order fixtures really do record opposite HDF5 byte orders', async () => {
  const bigEndianBytes = await readFile(BIG_ENDIAN_FIXTURE);
  const littleEndianBytes = await readFile(LITTLE_ENDIAN_FIXTURE);
  assert.notDeepEqual(
    new Uint8Array(bigEndianBytes),
    new Uint8Array(littleEndianBytes),
    'the two fixtures must not be byte-identical files'
  );

  const inspected = [];
  for (const [label, fixturePath] of [
    ['big', BIG_ENDIAN_FIXTURE],
    ['little', LITTLE_ENDIAN_FIXTURE],
  ]) {
    const root = await openFixture(fixturePath);
    try {
      inspected.push({
        label,
        X: root.get('X').dtype.littleEndian,
        umap2d: root.get('obsm/X_umap_2d').dtype.littleEndian,
        umap3d: root.get('obsm/X_umap_3d').dtype.littleEndian,
        connectivityData: root.get('obsp/connectivities/data').dtype.littleEndian,
        connectivityIndices: root.get('obsp/connectivities/indices').dtype.littleEndian,
        connectivityShape: root.get('obsp/connectivities').attributeType('shape').dtype.littleEndian,
        obsScore: root.get('obs/score_f8').dtype.littleEndian,
        obsCount: root.get('obs/count_u4').dtype.littleEndian,
      });
    } finally {
      root.close();
    }
  }

  const [big, little] = inspected;
  for (const key of Object.keys(big)) {
    if (key === 'label') continue;
    assert.equal(big[key], false, `big-endian fixture ${key} must be stored big-endian`);
    assert.equal(
      little[key],
      true,
      `little-endian fixture ${key} must be stored little-endian`
    );
  }
});

test('a byte-order regression would change the fixture values', () => {
  const cases = [
    [EXPECTED.embedding2d, Float32Array],
    [EXPECTED.embedding3d, Float32Array],
    [EXPECTED.genes.GENE_A, Float32Array],
    [EXPECTED.genes.GENE_B, Float32Array],
    [EXPECTED.genes.GENE_C, Float32Array],
    [EXPECTED.obs.score_f4, Float32Array],
    [EXPECTED.obs.count_i4, Int32Array],
    [EXPECTED.obs.count_u4, Uint32Array],
    [EXPECTED.obs.count_i2, Int16Array],
    [EXPECTED.obs.count_u2, Uint16Array],
    [EXPECTED.edges.weights, Float64Array],
  ];

  for (const [values, ArrayType] of cases) {
    const swapped = readWithSwappedByteOrder(values, ArrayType);
    const differs = values.some(
      (value, index) => !Object.is(value, swapped[index])
    );
    assert.ok(
      differs,
      `${ArrayType.name} fixture values must differ when read in the wrong byte order`
    );
  }
});

test('a big-endian .h5ad yields the same values as its little-endian twin', async t => {
  silenceNotifications(t);

  const little = await readEverything(t, LITTLE_ENDIAN_FIXTURE);
  const big = await readEverything(t, BIG_ENDIAN_FIXTURE);

  // The control: the little-endian twin must itself be right, otherwise the
  // two files could agree on the same wrong numbers.
  assert.deepEqual(little.embeddings.X_umap_2d, {
    data: EXPECTED.embedding2d,
    shape: [8, 2],
    nDims: 2,
  });
  assert.deepEqual(little.embeddings.X_umap_3d, {
    data: EXPECTED.embedding3d,
    shape: [8, 3],
    nDims: 3,
  });
  for (const [name, values] of Object.entries(EXPECTED.genes)) {
    assert.deepEqual(little.genes[name], values, `gene ${name}`);
  }
  for (const [key, values] of Object.entries(EXPECTED.obs)) {
    assert.deepEqual(
      little.obs[key],
      { dtype: EXPECTED.obsDtype[key], values },
      `obs field ${key}`
    );
  }
  assert.deepEqual(little.categorical.codes, EXPECTED.categorical.codes);
  assert.deepEqual(
    little.categorical.categories,
    EXPECTED.categorical.categories
  );
  assert.equal(little.categorical.ordered, EXPECTED.categorical.ordered);
  const { weights: expectedWeights, ...expectedEdges } = EXPECTED.edges;
  assert.deepEqual(little.edges, { ...expectedEdges, ...edgeWeightsFrom(expectedWeights) });
  assert.deepEqual(
    { min: little.published.obs.count_u4.min, max: little.published.obs.count_u4.max },
    { min: 0, max: 4294967040 },
    'published continuous range must come from the decoded values'
  );
  assert.deepEqual(
    little.published.genes.GENE_C,
    EXPECTED.genes.GENE_C,
    'published gene expression must match the decoded column'
  );

  // The comparison that settles the byte-order question. Every user-visible
  // number, from the dense X, the obsm embeddings, the obs columns, the
  // categorical codes, and the sparse connectivity matrix — including the
  // numeric `shape` HDF5 attribute that sizes it — must match exactly, both as
  // the loader decodes it and as the data source publishes it downstream.
  assert.deepEqual(big, little);
});

/**
 * The binary fixtures above swap the byte order of *datasets*, but AnnData
 * writes the categorical `ordered` flag as a scalar enum *attribute* whose
 * base type h5py takes from the writing host. Both fixtures therefore report
 * `littleEndian: true` for it, and neither can catch a reader that conditions
 * on that field. These two tests close the gap the fixtures leave open.
 */
test(
  'no AnnData reader accepts or rejects a value because of stored byte order',
  async () => {
    const files = [
      '../assets/js/data/h5ad.js',
      '../assets/js/data/zarr.js',
      ...(await readdir(fileURLToPath(new URL('../assets/js/data/anndata/', import.meta.url))))
        .filter(name => name.endsWith('.js'))
        .map(name => `../assets/js/data/anndata/${name}`),
    ];
    const conditions = [];
    for (const file of files) {
      const source = await readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      source.split('\n').forEach((line, index) => {
        if (/littleEndian/.test(line) && !/^\s*(\*|\/\/)/.test(line)) conditions.push([file, index + 1, line]);
      });
    }
    assert.deepEqual(
      conditions,
      [],
      'the store converts to host order while reading, so `dtype.littleEndian` ' +
      'describes only the file. A reader that branches on it rejects a ' +
      'readable array and reports it as a malformed value.'
    );
  }
);

test(
  'a big-endian boolean enum is still an exact HDF5 boolean',
  async () => {
    // The `ordered` attribute in both committed fixtures: an h5py boolean
    // enum, decoded by the store to a boolean.
    const root = await openFixture(BIG_ENDIAN_FIXTURE);
    let ordered;
    let orderedType;
    try {
      const cellType = root.get('obs/cell_type');
      ordered = cellType.attrs.ordered;
      orderedType = cellType.attributeType('ordered');
    } finally {
      root.close();
    }
    assert.equal(ordered, false);
    assert.equal(orderedType.dtype.kind, 'bool');
    assert.equal(orderedType.dtype.bytes, 1);
    assert.deepEqual(orderedType.shape, []);

    // The fixtures' `ordered` attribute takes its base type from the writing
    // host, so neither committed file carries a big-endian one. The datatype
    // a big-endian host would write -- FALSE = 0, TRUE = 1 over a big-endian
    // one-byte integer -- is the same boolean: `size: 1` is why byte order
    // cannot participate, there is no second byte to order.
    for (const littleEndian of [true, false]) {
      const base = { class: 'fixed-point', size: 1, signed: true, littleEndian, bitOffset: 0, precision: 8 };
      const dtype = storeDtype({ class: 'enum', size: 1, base, names: ['FALSE', 'TRUE'], values: [0, 1] });
      assert.equal(dtype.kind, 'bool', `a ${littleEndian ? 'little' : 'big'}-endian boolean enum is a boolean`);
      assert.equal(dtype.bytes, 1);
    }
  }
);
