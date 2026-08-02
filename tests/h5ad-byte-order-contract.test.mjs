/**
 * Byte-order contract for direct `.h5ad` reading.
 *
 * `classifyH5WasmDtype` matches the NumPy byte-order prefix and then discards
 * it, so `>f4` and `<f4` classify identically. That is only safe if the HDF5
 * reader underneath has already converted stored data to the host byte order.
 * These tests pin that guarantee against real HDF5 files rather than assuming
 * it: `byte-order-big-endian.h5ad` and `byte-order-little-endian.h5ad` carry
 * identical values and differ only in the recorded datatype byte order, and
 * the reader must return the same numbers from both.
 *
 * A regression here is silent: a byte-swapped float is finite and plausible,
 * so a wrong plot would render without any error. The assertions therefore
 * compare exact values, never shapes or counts.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { classifyH5WasmDtype, H5adDataSource } from '../assets/js/data/h5ad.js';

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
  const file = new File([bytes], fixturePath.split('/').pop(), {
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
    const embedding = await loader.getEmbedding(key);
    embeddings[key] = {
      data: Array.from(embedding.data),
      shape: embedding.shape,
      nDims: embedding.nDims,
    };
  }

  const genes = {};
  for (const name of Object.keys(EXPECTED.genes)) {
    genes[name] = Array.from(await loader.getGeneExpression(name));
  }

  const obs = {};
  for (const key of Object.keys(EXPECTED.obs)) {
    const field = await loader.getObsField(key);
    obs[key] = { dtype: field.dtype, values: Array.from(field.values) };
  }
  const categorical = await loader.getObsField('cell_type');

  const edges = await source.getConnectivityEdges();

  // The renderer-facing surface: normalized positions, packed obs payloads,
  // and the manifests built from them. These are what actually reach the GPU
  // and the UI, so they are compared as raw bytes.
  const published = {
    embedding2d: Array.from(await source.getEmbedding(2)),
    embedding3d: Array.from(await source.getEmbedding(3)),
    genes: {},
    obs: {},
    obsManifest: JSON.stringify(source.getObsManifest()),
    varManifest: JSON.stringify(source.getVarManifest()),
    connectivityManifest: JSON.stringify(await source.getConnectivityManifest()),
  };
  for (const name of Object.keys(EXPECTED.genes)) {
    published.genes[name] = Array.from(await source.getGeneExpression(name));
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
      sources: Array.from(edges.sources),
      destinations: Array.from(edges.destinations),
      weights: Array.from(edges.weights),
      nCells: edges.nCells,
      nEdges: edges.nEdges,
      maxNeighbors: edges.maxNeighbors,
    },
  };
}

test('H5AD dtype classification is independent of the NumPy byte-order prefix', () => {
  const byKind = {
    float: ['e', 'f', 'd'],
    int: ['b', 'h', 'i', 'q'],
    uint: ['B', 'H', 'I', 'Q'],
    string: ['S', 'U', 'O'],
  };

  for (const [kind, codes] of Object.entries(byKind)) {
    for (const code of codes) {
      const withoutPrefix = classifyH5WasmDtype(code);
      assert.equal(
        withoutPrefix,
        kind,
        `dtype '${code}' must classify as ${kind}`
      );
      for (const prefix of ['<', '>', '=', '|']) {
        assert.equal(
          classifyH5WasmDtype(`${prefix}${code}`),
          kind,
          `dtype '${prefix}${code}' must classify as ${kind}`
        );
        assert.equal(
          classifyH5WasmDtype(`${prefix}${code}4`),
          kind,
          `dtype '${prefix}${code}4' must classify as ${kind}`
        );
      }
    }
  }

  // The prefix is discarded, never used to reject: a big-endian dtype is as
  // readable as a little-endian one because h5wasm converts on read.
  assert.equal(classifyH5WasmDtype('>f4'), classifyH5WasmDtype('<f4'));
  assert.equal(classifyH5WasmDtype('>i8'), classifyH5WasmDtype('<i8'));
  assert.equal(classifyH5WasmDtype('>I'), classifyH5WasmDtype('<I'));
  assert.equal(classifyH5WasmDtype('?'), 'bool');
  assert.equal(classifyH5WasmDtype('>x4'), 'unknown');
  assert.equal(classifyH5WasmDtype(42), 'unknown');
});

test('the byte-order fixtures really do record opposite HDF5 byte orders', async () => {
  const module = await import('../assets/external/hdf5_hl.js');
  await module.ready;

  const bigEndianBytes = await readFile(BIG_ENDIAN_FIXTURE);
  const littleEndianBytes = await readFile(LITTLE_ENDIAN_FIXTURE);
  assert.notDeepEqual(
    new Uint8Array(bigEndianBytes),
    new Uint8Array(littleEndianBytes),
    'the two fixtures must not be byte-identical files'
  );

  const inspected = [];
  for (const [label, bytes] of [
    ['big', bigEndianBytes],
    ['little', littleEndianBytes],
  ]) {
    const virtualPath = `/cellucid-byte-order-${label}.h5ad`;
    module.FS.writeFile(virtualPath, new Uint8Array(bytes));
    const file = new module.File(virtualPath, 'r');
    try {
      inspected.push({
        label,
        X: file.get('X').metadata.littleEndian,
        umap2d: file.get('obsm/X_umap_2d').metadata.littleEndian,
        umap3d: file.get('obsm/X_umap_3d').metadata.littleEndian,
        connectivityData:
          file.get('obsp/connectivities/data').metadata.littleEndian,
        connectivityIndices:
          file.get('obsp/connectivities/indices').metadata.littleEndian,
        connectivityShape:
          file.get('obsp/connectivities').attrs.shape.metadata.littleEndian,
        obsScore: file.get('obs/score_f8').metadata.littleEndian,
        obsCount: file.get('obs/count_u4').metadata.littleEndian,
      });
    } finally {
      file.close();
      module.FS.unlink(virtualPath);
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
  assert.deepEqual(little.edges, EXPECTED.edges);
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
  'no h5ad reader accepts or rejects a value because of stored byte order',
  async () => {
    const source = await readFile(
      fileURLToPath(new URL('../assets/js/data/h5ad.js', import.meta.url)),
      'utf8'
    );
    const conditions = source
      .split('\n')
      .map((line, index) => [index + 1, line])
      .filter(([, line]) => (
        /littleEndian/.test(line) &&
        !/^\s*(\*|\/\/)/.test(line)
      ));
    assert.deepEqual(
      conditions,
      [],
      'h5wasm converts to host order while reading, so `metadata.littleEndian` ' +
      'describes only the file. A reader that branches on it rejects a ' +
      'readable dataset and reports it as a malformed value.'
    );
  }
);

test(
  'a big-endian boolean enum is still an exact HDF5 boolean',
  async () => {
    const module = await import('../assets/external/hdf5_hl.js');
    await module.ready;

    // The `ordered` attribute in both committed fixtures: an h5py boolean
    // enum. Byte order is the only field that differs from the big-endian
    // variant a big-endian writing host would produce.
    const bytes = await readFile(BIG_ENDIAN_FIXTURE);
    const virtualPath = '/cellucid-ordered-attribute.h5ad';
    module.FS.writeFile(virtualPath, new Uint8Array(bytes));
    const file = new module.File(virtualPath, 'r');
    let ordered;
    try {
      // `Attribute.value` reads lazily through the open file, so it must be
      // captured before the file is closed.
      const attribute = file.get('obs/cell_type').attrs.ordered;
      ordered = {
        dtype: attribute.dtype,
        shape: attribute.shape,
        metadata: attribute.metadata,
        value: attribute.value,
      };
    } finally {
      file.close();
      module.FS.unlink(virtualPath);
    }

    // Everything that actually determines the value. `size: 1` is why byte
    // order cannot participate: there is no second byte to order.
    assert.equal(ordered.dtype, 'unknown');
    assert.deepEqual(ordered.shape, []);
    assert.equal(ordered.metadata.type, 8);
    assert.equal(ordered.metadata.signed, true);
    assert.equal(ordered.metadata.vlen, false);
    assert.equal(ordered.metadata.size, 1);
    assert.equal(ordered.metadata.total_size, 1);
    assert.deepEqual(ordered.metadata.enum_type.members, { FALSE: 0, TRUE: 1 });
    assert.equal(ordered.value === 0 || ordered.value === 1, true);

    // The fixture-level gap this test exists to record: the committed
    // big-endian file does not carry a big-endian `ordered` attribute, so the
    // fixture comparison above cannot exercise this path.
    assert.equal(
      ordered.metadata.littleEndian,
      true,
      'if this ever becomes false the fixtures do cover the attribute and ' +
      'this note should be removed'
    );
  }
);
