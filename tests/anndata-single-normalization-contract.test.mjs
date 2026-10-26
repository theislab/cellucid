/**
 * One embedding, one set of displayed coordinates, whichever way it is opened.
 *
 * The format defines the payload: every writer normalizes an embedding on its
 * own (centred per axis, one `2 / max(axis ranges)` scale) at the input's
 * precision and rounds to float32 once. The reader worker makes that payload
 * (`embedding-payload.js`) and the DimensionManager publishes it as it is,
 * with the identity display transform; the vectors are scaled exactly once,
 * by the writer's factor, in the same worker.
 *
 * What made this fragile was ownership: the adapter handed the DimensionManager
 * the very array it kept in its own cache, so the in-place display
 * normalization rewrote the adapter's cache, a reload after an eviction
 * normalized that rewritten array again, and the eviction released nothing
 * while the adapter still held it. The payload route now hands its array over
 * and forgets it.
 *
 * The cases below load real `.h5ad` and Zarr ZIP fixtures, reload them after
 * evictions, and check every result against the one normalization rule.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { resolveVectorBinding } from '../assets/js/data/data-mapping-candidates.js';
import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';
import { createDimensionManager } from '../assets/js/data/dimension-manager.js';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { createVectorFieldManager } from '../assets/js/data/vector-field-manager.js';
import { normalizePositions } from '../assets/js/rendering/gl-utils.js';
import { storedObsm } from './helpers/stored-obsm.mjs';
import { loaderMetadata, obsmColumnReader, withObsmPayloads } from './helpers/anndata-mapping-mocks.mjs';

const CASES = [
  { fixture: 'data-mapping-full', file: 'data-mapping-full.h5ad', format: 'H5AD' },
  { fixture: 'data-mapping-multi', file: 'data-mapping-multi.h5ad', format: 'H5AD' },
  { fixture: 'data-mapping-full', file: 'data-mapping-full.zarr.zip', format: 'Zarr ZIP' },
];

const LAYOUT = 'X_umap';
const VECTOR_KEY = 'velocity_umap';

function silence(t) {
  const notifications = getNotificationCenter();
  const names = ['startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload', 'warning', 'error', 'info'];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  let next = 0;
  for (const name of names) notifications[name] = () => `${name}-${++next}`;
  const log = console.log;
  console.log = () => {};
  t.after(() => {
    console.log = log;
    for (const [name, method] of originals) {
      if (method === undefined) delete notifications[name];
      else notifications[name] = method;
    }
  });
}

async function openDirect(t, { file, format }) {
  const bytes = await readFile(new URL(`./browser/fixtures/${file}`, import.meta.url));
  const source = format === 'H5AD' ? new AnnDataFileSource() : new AnnDataFileSource();
  if (format === 'H5AD') await source.loadFile(new File([bytes], file));
  else await source.loadFile(new File([bytes], file));

  const manager = getDataSourceManager();
  const previous = { source: manager.activeSource, datasetId: manager.activeDatasetId };
  manager.activeSource = source;
  manager.activeDatasetId = source.datasetId;
  t.after(() => {
    manager.activeSource = previous.source;
    manager.activeDatasetId = previous.datasetId;
    source.clear();
  });
  return {
    adapter: source.getAdapter(),
    baseUrl: source.getBaseUrl(source.datasetId),
    identity: await source.getMetadata(source.datasetId),
  };
}

/** The stored values of `obsm[key]` at `columns` of one case's fixture. */
async function storedCaseObsm({ file }, key, columns) {
  const bytes = await readFile(new URL(`./browser/fixtures/${file}`, import.meta.url));
  return storedObsm(new File([bytes], file), key, columns);
}

function bitsOf(values) {
  return Array.from(new Uint32Array(values.buffer, values.byteOffset, values.length));
}

/** The format's writer rule, written out from the specification. */
function formatPayload(raw, dimension) {
  const mins = new Array(dimension).fill(Infinity);
  const maxs = new Array(dimension).fill(-Infinity);
  for (let index = 0; index < raw.length; index++) {
    const axis = index % dimension;
    if (raw[index] < mins[axis]) mins[axis] = raw[index];
    if (raw[index] > maxs[axis]) maxs[axis] = raw[index];
  }
  let maxRange = 0;
  for (let axis = 0; axis < dimension; axis++) {
    maxRange = Math.max(maxRange, maxs[axis] - mins[axis]);
  }
  const centers = mins.map((min, axis) => (min + maxs[axis]) / 2);
  const scale = 2 / maxRange;
  const payload = new Float32Array(raw.length);
  for (let index = 0; index < raw.length; index++) {
    payload[index] = (raw[index] - centers[index % dimension]) * scale;
  }
  return { payload, scale };
}

function dimensionManagerFor(baseUrl, identity) {
  const manager = createDimensionManager({ baseUrl });
  manager.initFromMetadata(identity.embeddings);
  return manager;
}

function vectorManagerFor(baseUrl, dimensionManager, file) {
  return createVectorFieldManager({
    baseUrl,
    dimensionManager,
    vectorFields: Object.freeze({
      defaultField: 'velocity_umap',
      fields: new Map([
        ['velocity_umap', Object.freeze({ label: 'velocity_umap', files: Object.freeze({ [LAYOUT]: file }) })],
      ]),
    }),
  });
}

async function shown(dimensionManager) {
  const positions = await dimensionManager.getPositions(LAYOUT, { showProgress: false });
  return {
    positions,
    bits: bitsOf(positions),
    transform: structuredClone(dimensionManager.getNormTransform(LAYOUT)),
  };
}

for (const testCase of CASES) {
  test(`${testCase.format} ${testCase.fixture}: positions and vectors are normalized once, identically on every load`, async t => {
    silence(t);
    const { adapter, baseUrl, identity } = await openDirect(t, testCase);
    assert.equal(identity.embeddings.defaults['2d'], LAYOUT);
    const loader = adapter._loader;
    const raw = await storedCaseObsm(testCase, 'X_umap', [0, 1]);
    const rawVectors = await storedCaseObsm(testCase, VECTOR_KEY, [0, 1]);
    let embeddingReads = 0;
    const readEmbedding = loader.readEmbedding.bind(loader);
    loader.readEmbedding = (key, ...args) => {
      if (key === 'X_umap') embeddingReads++;
      return readEmbedding(key, ...args);
    };

    // The payload follows the one normalization rule, bit for bit.
    const writer = formatPayload(raw, 2);
    const { positions: payload, transform } = await adapter.getEmbeddingPayload(identity.embeddings.items[LAYOUT].path, 2);
    assert.deepEqual(bitsOf(payload), bitsOf(writer.payload));

    // The display shows that payload as it is: fitting it to the view again
    // would change nothing, and the display transform is the identity.
    const expected = new Float32Array(payload);
    const expectedTransform = { center: [0, 0, 0], scale: 1 };
    assert.deepEqual(transform, expectedTransform);
    assert.deepEqual(normalizePositions(new Float32Array(payload), 2), expectedTransform);

    // Direct AnnData: first load, then two reloads after evictions.
    const direct = dimensionManagerFor(baseUrl, identity);
    const loads = [];
    for (let load = 0; load < 3; load++) {
      if (load > 0) {
        assert.deepEqual(direct.evictUnpinned(), [LAYOUT]);
      }
      const readsBefore = embeddingReads;
      const result = await shown(direct);
      assert.deepEqual(result.bits, bitsOf(expected), `load ${load + 1} positions`);
      assert.deepEqual(result.transform, expectedTransform, `load ${load + 1} transform`);
      // The displayed array is the DimensionManager's alone: the adapter
      // keeps no reference to it, so an eviction frees it and the next load
      // reads the file again instead of reusing a rewritten array.
      assert.equal(
        [...adapter._embeddingCache.values()].includes(result.positions),
        false,
        `load ${load + 1} is not aliased by the adapter cache`
      );
      assert.equal(embeddingReads - readsBefore, 1, `load ${load + 1} reads the embedding once`);
      loads.push(result);
    }
    assert.notStrictEqual(loads[1].positions, loads[0].positions);

    // Vectors: scaled once, by the writer's factor.
    const vectorRoute = resolveVectorBinding(adapter.getMappingCandidates(), {
      key: VECTOR_KEY,
      embedding: { key: 'X_umap', columns: [0, 1] },
    });
    assert.equal(vectorRoute.ok, true);
    const expectedVectors = new Float32Array(rawVectors.length);
    for (let index = 0; index < rawVectors.length; index++) {
      expectedVectors[index] = rawVectors[index] * writer.scale;
    }
    const directVectors = vectorManagerFor(baseUrl, direct, vectorRoute.path);
    const firstField = await directVectors.loadField('velocity_umap', LAYOUT);
    assert.deepEqual(bitsOf(firstField.vectors), bitsOf(expectedVectors));
    direct.evictUnpinned();
    const reloadedField = await directVectors.loadField('velocity_umap', LAYOUT);
    assert.deepEqual(bitsOf(reloadedField.vectors), bitsOf(expectedVectors));
    assert.deepEqual(direct.getNormTransform(LAYOUT), expectedTransform);
  });
}

const MAPPED_UMAP = 'obsm/0/0-1';

function mockAdapter(arrays) {
  const widths = Object.fromEntries(
    Object.entries(arrays).map(([key, { width }]) => [key, width])
  );
  const loader = {
    nObs: 3,
    reads: 0,
    obsKeys: [],
    varNames: [],
    hasExpressionMatrix: false,
    async getDatasetMetadata() {
      return loaderMetadata({ nObs: 3, obsm: widths });
    },
    async readObsmColumns(key, columns) {
      this.reads++;
      return obsmColumnReader(arrays)(key, columns);
    },
    close() {},
  };
  return { adapter: new BaseAnnDataAdapter(withObsmPayloads(loader)), loader };
}

test('callers sharing one embedding read each own a pristine payload', async t => {
  silence(t);
  const { adapter, loader } = mockAdapter({ X_umap: { data: [0, 0, 4, 2, 2, 1], width: 2 } });
  await adapter.initialize();
  const readsAfterOpen = loader.reads;
  adapter.clearCaches();

  const [first, second] = (await Promise.all([
    adapter.getEmbeddingPayload(MAPPED_UMAP, 2),
    adapter.getEmbeddingPayload(MAPPED_UMAP, 2),
  ])).map(payload => payload.positions);
  assert.equal(loader.reads - readsAfterOpen, 1, 'one read serves both callers');
  assert.notStrictEqual(first, second);
  assert.deepEqual(Array.from(first), [-1, -0.5, 1, 0.5, 0, 0]);
  assert.deepEqual(Array.from(second), Array.from(first));
  assert.equal(adapter._embeddingCache.size, 0);
});

test('a narrow embedding gets the format scale, not a floor', async t => {
  silence(t);
  // A positive range far below 1e-8 is still a range: every writer scales it
  // to [-1, 1], so the direct payload must too.
  const raw = [0, 0, 4e-10, 2e-10, 2e-10, 1e-10];
  const { adapter } = mockAdapter({ X_umap: { data: raw, width: 2 } });
  await adapter.initialize();
  const { positions: payload } = await adapter.getEmbeddingPayload(MAPPED_UMAP, 2);
  assert.deepEqual(
    bitsOf(payload),
    bitsOf(formatPayload(Float64Array.from(raw), 2).payload)
  );
  assert.deepEqual(Array.from(payload), [-1, -0.5, 1, 0.5, 0, 0]);
});
