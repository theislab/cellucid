/**
 * One embedding, one set of displayed coordinates, whichever way it is opened.
 *
 * The export format defines the payload: every writer normalizes an embedding
 * on its own (centred per axis, one `2 / max(axis ranges)` scale) at the
 * input's precision and rounds to float32 once. The direct H5AD/Zarr adapters
 * produce that payload in the browser, and the DimensionManager then
 * normalizes whatever payload it is handed, in place, for display. A payload
 * already in the format's coordinates is a fixed point of that second step,
 * so the viewer transform is the identity and the vectors are scaled exactly
 * once, by the writer's factor.
 *
 * What made this fragile was ownership: the adapter handed the DimensionManager
 * the very array it kept in its own cache, so the in-place display
 * normalization rewrote the adapter's cache, a reload after an eviction
 * normalized that rewritten array again, and the eviction released nothing
 * while the adapter still held it. The payload route now hands its array over
 * and forgets it.
 *
 * The cases below load real `.h5ad` and Zarr ZIP fixtures through the
 * direct-AnnData path, reload them after evictions, and compare every result
 * with the prepared-export path for the same data. `PREPARED` holds the
 * SHA-256 digests of the payloads `cellucid-python` writes for the fixture's
 * `X_umap` and its `velocity_umap_2d` vectors:
 *
 *   adata = anndata.read_h5ad(fixture)
 *   cellucid.prepare(
 *       out_dir=out, obs=adata.obs[[]], obs_keys=[],
 *       latent_space=np.asarray(adata.obsm["X_umap"]),
 *       centroid_outlier_quantile=None, obs_categorical_dtype="uint8",
 *       dataset_name="dx14", dataset_id="dx14",
 *       embeddings={"X_umap": cellucid.Embedding(adata.obsm["X_umap"], columns=[0, 1])},
 *       vector_fields={"velocity_umap": {"X_umap": np.asarray(adata.obsm["velocity_umap_2d"])}},
 *   )
 *   sha256(out / "embeddings/0_2d.bin"), sha256(out / "vectors/0_0.bin")
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { BaseAnnDataAdapter } from '../assets/js/data/base-anndata-adapter.js';
import { resolveVectorBinding } from '../assets/js/data/data-mapping-candidates.js';
import { getDataSourceManager } from '../assets/js/data/data-source-manager.js';
import { createDimensionManager } from '../assets/js/data/dimension-manager.js';
import { H5adDataSource } from '../assets/js/data/h5ad.js';
import { createVectorFieldManager } from '../assets/js/data/vector-field-manager.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';
import { normalizePositions } from '../assets/js/rendering/gl-utils.js';
import { loaderMetadata, obsmColumnReader } from './helpers/anndata-mapping-mocks.mjs';

const PREPARED = Object.freeze({
  'data-mapping-full': Object.freeze({
    embedding: '4c83fe825614c6922f96b729eac25d3c87db1824714d69ca2f41e66e4609e8fd',
    vectors: 'bba8d8019acde033d0d89d0efc975dda2ccd165ca4cab508fc40cb0b07771933',
  }),
  'data-mapping-multi': Object.freeze({
    embedding: '77b3cf51dc97b7d3e7f9e44f4a6d13d770ae2f5baf8c7db4dd9564ab29c6e6e8',
    vectors: '66d9e6241357628e89496fe9a2efc8a77c6cb9b601e937b299af65b283501373',
  }),
});

const CASES = [
  { fixture: 'data-mapping-full', file: 'data-mapping-full.h5ad', format: 'H5AD' },
  { fixture: 'data-mapping-multi', file: 'data-mapping-multi.h5ad', format: 'H5AD' },
  { fixture: 'data-mapping-full', file: 'data-mapping-full.zarr.zip', format: 'Zarr ZIP' },
];

const LAYOUT = 'X_umap';
const VECTOR_KEY = 'velocity_umap_2d';
const PREPARED_BASE = 'https://prepared.test/exports/dx14/';

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
  const source = format === 'H5AD' ? new H5adDataSource() : new ZarrDataSource();
  if (format === 'H5AD') await source.loadFromFile(new File([bytes], file));
  else await source.loadFromArchiveFile(new File([bytes], file));

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

function serve(t, files) {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const bytes = files.get(String(url));
    if (bytes === undefined) return new Response(null, { status: 404 });
    // A fresh body per request, exactly like the network.
    return new Response(bytes.slice(), { status: 200 });
  };
  t.after(() => {
    if (original === undefined) delete globalThis.fetch;
    else globalThis.fetch = original;
  });
}

function sha256(view) {
  return createHash('sha256')
    .update(Buffer.from(view.buffer, view.byteOffset, view.byteLength))
    .digest('hex');
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
  test(`${testCase.format} ${testCase.fixture}: positions and vectors are normalized once, identically on every load and on the prepared path`, async t => {
    silence(t);
    const { adapter, baseUrl, identity } = await openDirect(t, testCase);
    assert.equal(identity.embeddings.defaults['2d'], LAYOUT);
    const loader = adapter._loader;
    const raw = await loader.readObsmColumns('X_umap', [0, 1]);
    const rawVectors = await loader.readObsmColumns(VECTOR_KEY, [0, 1]);
    let embeddingReads = 0;
    const readObsmColumns = loader.readObsmColumns.bind(loader);
    loader.readObsmColumns = (key, columns) => {
      if (key === 'X_umap') embeddingReads++;
      return readObsmColumns(key, columns);
    };

    // The direct payload is the prepared payload, byte for byte.
    const writer = formatPayload(raw, 2);
    const payload = await adapter.getEmbeddingPayload(identity.embeddings.items[LAYOUT].file, 2);
    assert.equal(sha256(payload), PREPARED[testCase.fixture].embedding);
    assert.deepEqual(bitsOf(payload), bitsOf(writer.payload));

    // What the display shows is that payload normalized exactly once more,
    // which for a payload in the format's coordinates is the identity.
    const expected = new Float32Array(payload);
    const expectedTransform = normalizePositions(expected, 2);
    assert.deepEqual(expectedTransform, { center: [0, 0, 0], scale: 1 });
    assert.deepEqual(bitsOf(expected), bitsOf(payload));

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

    // Vectors: the payload is scaled by the writer's factor, then the display
    // scales it by the one viewer transform its positions got.
    const vectorRoute = resolveVectorBinding(adapter.getMappingCandidates(), {
      key: VECTOR_KEY,
      embedding: { key: 'X_umap', columns: [0, 1] },
    });
    assert.equal(vectorRoute.ok, true);
    const vectorPayload = await adapter.getVectorPayload(vectorRoute.path, 2);
    assert.equal(sha256(vectorPayload), PREPARED[testCase.fixture].vectors);
    const expectedVectors = new Float32Array(rawVectors.length);
    for (let index = 0; index < rawVectors.length; index++) {
      expectedVectors[index] =
        Math.fround(rawVectors[index] * writer.scale) * expectedTransform.scale;
    }
    const directVectors = vectorManagerFor(baseUrl, direct, vectorRoute.path);
    const firstField = await directVectors.loadField('velocity_umap', LAYOUT, { showProgress: false });
    assert.deepEqual(bitsOf(firstField.vectors), bitsOf(expectedVectors));
    direct.evictUnpinned();
    const reloadedField = await directVectors.loadField('velocity_umap', LAYOUT, { showProgress: false });
    assert.deepEqual(bitsOf(reloadedField.vectors), bitsOf(expectedVectors));
    assert.deepEqual(direct.getNormTransform(LAYOUT), expectedTransform);

    // The prepared-export path for the same data shows the same bits.
    serve(t, new Map([
      [`${PREPARED_BASE}embeddings/0_2d.bin`, new Uint8Array(payload.buffer.slice(0))],
      [`${PREPARED_BASE}vectors/0_0.bin`, new Uint8Array(vectorPayload.buffer.slice(0))],
    ]));
    const prepared = dimensionManagerFor(PREPARED_BASE, identity);
    for (let load = 0; load < 2; load++) {
      if (load > 0) prepared.evictUnpinned();
      const result = await shown(prepared);
      assert.deepEqual(result.bits, loads[0].bits, `prepared load ${load + 1} positions`);
      assert.deepEqual(result.transform, loads[0].transform, `prepared load ${load + 1} transform`);
    }
    const preparedField = await vectorManagerFor(PREPARED_BASE, prepared, 'vectors/0_0.bin')
      .loadField('velocity_umap', LAYOUT, { showProgress: false });
    assert.deepEqual(bitsOf(preparedField.vectors), bitsOf(firstField.vectors));
    assert.equal(preparedField.maxMagnitude, firstField.maxMagnitude);
  });
}

const MAPPED_UMAP = '_cellucid/mapping/embeddings/0/0-1.bin';

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
  return { adapter: new BaseAnnDataAdapter(loader), loader };
}

test('callers sharing one embedding read each own a pristine payload', async t => {
  silence(t);
  const { adapter, loader } = mockAdapter({ X_umap: { data: [0, 0, 4, 2, 2, 1], width: 2 } });
  await adapter.initialize();
  const readsAfterOpen = loader.reads;
  adapter.clearCaches();

  const [first, second] = await Promise.all([
    adapter.getEmbeddingPayload(MAPPED_UMAP, 2),
    adapter.getEmbeddingPayload(MAPPED_UMAP, 2),
  ]);
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
  const payload = await adapter.getEmbeddingPayload(MAPPED_UMAP, 2);
  assert.deepEqual(
    bitsOf(payload),
    bitsOf(formatPayload(Float64Array.from(raw), 2).payload)
  );
  assert.deepEqual(Array.from(payload), [-1, -0.5, 1, 0.5, 0, 0]);
  assert.equal(adapter._normInfo.get('X_umap').scale, 2 / 4e-10);
});
