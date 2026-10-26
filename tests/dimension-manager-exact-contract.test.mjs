import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DimensionManager,
  parseEmbeddingMetadata,
  requireRepresentationRef,
} from '../assets/js/data/dimension-manager.js';
import { loadsAsReader } from './helpers/dimension-loads.mjs';

function axes(dimension) {
  return Array.from({ length: dimension }, (_, index) => index);
}

/**
 * A dataset identity's `embeddings` metadata. `entries` are `[id,
 * dimension, options]` in item order; `options.sourceKey` (the id by
 * default) and `options.columns` are the item's provenance and
 * `options.label` its display label. Item `i` reads `obsm` entry `i`.
 */
function embeddings(entries, defaults, defaultDimension) {
  const items = {};
  entries.forEach(([id, dimension, options = {}], index) => {
    const columns = options.columns ?? axes(dimension);
    items[id] = {
      label: options.label ?? id,
      dimension,
      path: `obsm/${index}/${columns.join('-')}`,
      source: {
        key: options.sourceKey ?? id,
        columns,
      },
    };
  });
  return {
    default_dimension: defaultDimension,
    defaults,
    items,
  };
}

function metadata(id = 'X_umap', dimension = 2) {
  return embeddings([[id, dimension]], { [`${dimension}d`]: id }, dimension);
}

/** Several embeddings per dimension, the case version 3 exists for. */
function multiLayoutMetadata() {
  return embeddings(
    [
      ['X_pca', 2, { label: 'PCA', sourceKey: 'X_pca', columns: [0, 1] }],
      ['X_pca_23', 2, { label: 'PCA 3/4', sourceKey: 'X_pca', columns: [2, 3] }],
      ['X_umap', 2, { label: 'UMAP', sourceKey: 'X_umap', columns: [0, 1] }],
      ['X_umap_3d', 3],
    ],
    { '2d': 'X_umap', '3d': 'X_umap_3d' },
    3
  );
}

test('valid embedding metadata replacement invalidates all prior coordinate state', () => {
  const manager = new DimensionManager({
    embeddingsMetadata: metadata('X_umap', 2),
  });
  const oldRaw = new Float32Array([1, 2, 3, 4]);
  const oldPadded = new Float32Array([1, 2, 0, 3, 4, 0]);
  let aborted = false;

  manager.positionCache.set('X_umap', oldRaw);
  manager.normalizedPositionCache.set('X_umap', oldPadded);
  manager.normTransformCache.set('X_umap', {
    center: [2, 3, 0],
    scale: 1,
  });
  manager.loadingPromises.set('X_umap', Promise.resolve(oldRaw));
  manager.normalizedLoadingPromises.set('X_umap', Promise.resolve(oldPadded));
  manager.loadingControllers.set('X_umap', {
    abort() {
      aborted = true;
    },
  });
  manager.viewLayouts.set('main', 'X_umap');
  manager.pinLayout('X_umap');
  manager.nCells = 2;
  const priorGeneration = manager._generation;

  manager.initFromMetadata(metadata('X_umap_3d', 3));

  assert.equal(aborted, true);
  assert.ok(manager._generation > priorGeneration);
  assert.deepEqual(manager.getAvailableDimensions(), [3]);
  assert.equal(manager.getDefaultDimension(), 3);
  assert.equal(manager.hasLayout('X_umap'), false);
  assert.deepEqual(manager.getEnabledLayoutKeys(), ['X_umap_3d']);
  assert.equal(manager.getDefaultLayout(3), 'X_umap_3d');
  assert.equal(manager.getDefaultLayout(2), null);
  assert.equal(manager.getDefaultLayoutKey(), 'X_umap_3d');
  assert.equal(manager.getLayout('X_umap_3d').path, 'obsm/0/0-1-2');
  assert.equal(manager.positionCache.size, 0);
  assert.equal(manager.normalizedPositionCache.size, 0);
  assert.equal(manager.normTransformCache.size, 0);
  assert.equal(manager.loadingPromises.size, 0);
  assert.equal(manager.normalizedLoadingPromises.size, 0);
  assert.equal(manager.loadingControllers.size, 0);
  assert.equal(manager.viewLayouts.size, 0);
  assert.equal(manager._layoutPins.size, 0);
  assert.equal(manager.nCells, 0);
});

test('invalid view layouts reject without substituting or mutating state', () => {
  const manager = new DimensionManager({
    embeddingsMetadata: metadata(),
  });
  manager.setViewLayout('main', 'X_umap');

  assert.throws(
    () => manager.setViewLayout('main', 'X_umap_3d'),
    /layout "X_umap_3d" is not registered/i
  );
  // A dimension name is not a layout key: the layout key is the embedding id.
  assert.throws(
    () => manager.setViewLayout('main', '2d'),
    /layout "2d" is not registered/i
  );
  // No 3D representation is enabled: there is none to open on, and no
  // reference names one.
  assert.equal(manager.getOpeningLayout(3), null);
  assert.equal(manager.hasDimension(3), false);
  assert.throws(
    () => manager.resolveRepresentation({ key: 'X_umap_3d', columns: [0, 1, 2] }),
    /cannot plot obsm\['X_umap_3d'\] columns \[0, 1, 2\]/i
  );
  assert.equal(manager.getViewLayout('main'), 'X_umap');
  assert.equal(manager.getViewDimension('main'), 2);
  assert.equal(manager.viewLayouts.get('main'), 'X_umap');
});

test('dimension metadata and configuration reject coercive normalization', () => {
  assert.throws(
    () => new DimensionManager({
      embeddingsMetadata: {
        ...metadata(),
        umap_resolution: {
          source_key: 'X_umap',
          action: 'used_as',
        },
      },
    }),
    /exactly default_dimension, defaults, and items/i
  );
  // Slots are listed ascending, exactly one per dimension the items cover.
  const twoDimensions = embeddings(
    [['X_umap', 2], ['X_umap_3d', 3]],
    { '2d': 'X_umap', '3d': 'X_umap_3d' },
    3
  );
  assert.throws(
    () => new DimensionManager({
      embeddingsMetadata: {
        ...twoDimensions,
        defaults: { '3d': 'X_umap_3d', '2d': 'X_umap' },
      },
    }),
    /defaults must name exactly one embedding per dimension/i
  );
  assert.throws(
    () => new DimensionManager({
      embeddingsMetadata: { ...twoDimensions, defaults: { '3d': 'X_umap_3d' } },
    }),
    /defaults must name exactly one embedding per dimension/i
  );
  assert.throws(
    () => new DimensionManager({
      embeddingsMetadata: {
        ...twoDimensions,
        defaults: { '2d': 'X_umap_3d', '3d': 'X_umap_3d' },
      },
    }),
    /default for 2D must name a 2D embedding item/i
  );
  assert.throws(
    () => new DimensionManager({
      embeddingsMetadata: {
        ...twoDimensions,
        defaults: { '2d': 'X_missing', '3d': 'X_umap_3d' },
      },
    }),
    /default for 2D must name a 2D embedding item/i
  );
  assert.throws(
    () => new DimensionManager({
      embeddingsMetadata: { ...twoDimensions, default_dimension: 1 },
    }),
    /default_dimension must be a dimension the embeddings defaults name/i
  );
  assert.throws(
    () => new DimensionManager({
      embeddingsMetadata: { ...twoDimensions, default_dimension: '3' },
    }),
    /default_dimension must be a dimension the embeddings defaults name/i
  );
  assert.throws(
    () => new DimensionManager({
      embeddingsMetadata: { ...metadata(), items: {} },
    }),
    /items must be a non-empty object/i
  );
  const item = metadata().items.X_umap;
  for (const rejected of [
    { ...item, basis: 'umap' },
    { label: item.label, dimension: item.dimension, path: item.path },
    { ...item, source: { key: 'X_umap' } },
    { ...item, source: { ...item.source, extra: true } },
  ]) {
    assert.throws(
      () => new DimensionManager({
        embeddingsMetadata: { ...metadata(), items: { X_umap: rejected } },
      }),
      /exactly label, dimension, path, and source|source must be exactly \{ key, columns \}/
    );
  }
  for (const rejected of [
    { ...item, dimension: 4 },
    { ...item, label: '' },
    { ...item, file: '' },
    { ...item, source: { key: 'X_umap', columns: [0] } },
    { ...item, source: { key: 'X_umap', columns: [1, 1] } },
    { ...item, source: { key: '', columns: [0, 1] } },
  ]) {
    assert.throws(
      () => new DimensionManager({
        embeddingsMetadata: { ...metadata(), items: { X_umap: rejected } },
      })
    );
  }

  const manager = new DimensionManager({
    embeddingsMetadata: metadata(),
  });
  assert.throws(
    () => manager.setViewLayout('', 'X_umap'),
    /view.*id.*non-empty/i
  );
  assert.throws(
    () => manager.getViewLayout(''),
    /view.*id.*non-empty/i
  );
  assert.equal(manager.viewLayouts.size, 0);
});

test('per-view layout lookup requires an explicitly published view', () => {
  const manager = new DimensionManager({
    embeddingsMetadata: metadata(),
  });

  assert.throws(
    () => manager.getViewLayout('missing'),
    /layout.*not published.*missing/i,
  );
  assert.throws(
    () => manager.getViewDimension('missing'),
    /layout.*not published.*missing/i,
  );
  assert.throws(
    () => manager.copyViewLayout('missing', 'snapshot'),
    /layout.*not published.*missing/i,
  );
  assert.equal(manager.viewLayouts.size, 0);
});

test('the current metadata contract registers one layout per embedding item, several per dimension', () => {
  const parsed = parseEmbeddingMetadata(multiLayoutMetadata());
  assert.equal(parsed.defaultDimension, 3);
  assert.deepEqual(
    parsed.layouts.map(layout => layout.layoutKey),
    ['X_pca', 'X_pca_23', 'X_umap', 'X_umap_3d'],
  );
  assert.deepEqual([...parsed.defaults], [[2, 'X_umap'], [3, 'X_umap_3d']]);

  const manager = new DimensionManager({
    embeddingsMetadata: multiLayoutMetadata(),
  });

  assert.deepEqual(
    manager.getLayoutsForDimension(2).map(layout => layout.layoutKey),
    ['X_pca', 'X_pca_23', 'X_umap'],
  );
  assert.deepEqual(
    manager.getLayoutsForDimension(3).map(layout => layout.layoutKey),
    ['X_umap_3d'],
  );
  assert.deepEqual(manager.getLayoutsForDimension(1), []);
  assert.deepEqual(
    manager.getRegisteredLayouts().map(layout => layout.layoutKey),
    ['X_pca', 'X_pca_23', 'X_umap', 'X_umap_3d'],
  );
  assert.deepEqual(manager.getLayout('X_pca_23'), {
    layoutKey: 'X_pca_23',
    dimension: 2,
    label: 'PCA 3/4',
    path: 'obsm/1/2-3',
    provenance: { key: 'X_pca', columns: [2, 3] },
    origin: 'identity',
  });
  assert.deepEqual(manager.getLayout('X_umap_3d'), {
    layoutKey: 'X_umap_3d',
    dimension: 3,
    label: 'X_umap_3d',
    path: 'obsm/3/0-1-2',
    provenance: { key: 'X_umap_3d', columns: [0, 1, 2] },
    origin: 'identity',
  });
  // Every declared embedding is enabled, in item order: three 2D
  // representations and one 3D one, any of which a view can show.
  assert.deepEqual(
    manager.getEnabledLayoutKeys(),
    ['X_pca', 'X_pca_23', 'X_umap', 'X_umap_3d'],
  );
  assert.ok(Object.isFrozen(manager.getEnabledLayoutKeys()));
  assert.equal(manager.isEnabled('X_pca_23'), true);
  assert.deepEqual(
    manager.getEnabledLayoutsForDimension(2).map(layout => layout.layoutKey),
    ['X_pca', 'X_pca_23', 'X_umap'],
  );
  // Each dimension's default is the item `defaults` names, not the first item.
  assert.equal(manager.getDefaultLayout(1), null);
  assert.equal(manager.getDefaultLayout(2), 'X_umap');
  assert.equal(manager.getDefaultLayout(3), 'X_umap_3d');
  assert.equal(manager.getOpeningLayout(1), null);
  assert.equal(manager.getOpeningLayout(2), 'X_umap');
  assert.equal(manager.getDefaultDimension(), 3);
  assert.equal(manager.getDefaultLayoutKey(), 'X_umap_3d');
  assert.deepEqual(manager.getAvailableDimensions(), [2, 3]);
  assert.equal(manager.hasDimension(1), false);
  assert.equal(manager.hasDimension(2), true);
  assert.ok(Object.isFrozen(manager.getLayout('X_umap')));
  assert.ok(Object.isFrozen(manager.getLayout('X_pca').provenance));
  assert.ok(Object.isFrozen(manager.getLayout('X_pca').provenance.columns));
});

test('an embedding reference resolves by embedding id or by provenance, never by guess', () => {
  const manager = new DimensionManager({
    embeddingsMetadata: multiLayoutMetadata(),
  });

  // A reference without columns names no layout: every embedding reference
  // lists the columns it plots, so a bare key is refused, never looked up.
  for (const key of ['X_pca', 'X_pca_23', 'X_umap_3d', 'X_missing']) {
    assert.throws(
      () => manager.resolveRepresentation({ key, columns: null }),
      new RegExp(`reference to obsm\\['${key}'\\] must list the columns it plots`),
    );
  }

  // Columns name a source array and the columns plotted: the provenance.
  assert.equal(manager.resolveRepresentation({ key: 'X_pca', columns: [2, 3] }), 'X_pca_23');
  assert.equal(manager.resolveRepresentation({ key: 'X_pca', columns: [0, 1] }), 'X_pca');
  assert.equal(manager.findLayoutByProvenance('X_umap', [0, 1]), 'X_umap');
  assert.equal(manager.findLayoutByProvenance('X_pca', [2, 3]), 'X_pca_23');
  // Column order is part of the provenance.
  assert.equal(manager.findLayoutByProvenance('X_pca', [1, 0]), null);
  assert.throws(
    () => manager.resolveRepresentation({ key: 'X_pca', columns: [1, 0] }),
    /cannot plot obsm\['X_pca'\] columns \[1, 0\]/,
  );
  // An embedding id is not a provenance key: X_pca_23 was read from X_pca.
  assert.throws(
    () => manager.resolveRepresentation({ key: 'X_pca_23', columns: [2, 3] }),
    /cannot plot obsm\['X_pca_23'\] columns \[2, 3\]/,
  );
  assert.equal(manager.findLayoutByProvenance('X_umap_3d', [0, 1, 2]), 'X_umap_3d');
  assert.throws(
    () => manager.resolveRepresentation({ key: 'X_missing', columns: [0, 1] }),
    /cannot plot obsm\['X_missing'\] columns \[0, 1\]/,
  );
  for (const malformed of [
    { key: 'X_pca' },
    { key: 'X_pca', columns: null, extra: 1 },
    { key: '', columns: null },
    { key: 'X_pca', columns: [] },
    { key: 'X_pca', columns: [0, 0] },
    { key: 'X_pca', columns: [-1, 0] },
    { key: 'X_pca', columns: [0, 1, 2, 3] },
    { key: 'X_pca', columns: [0.5, 1] },
    ['X_pca', null],
    null,
  ]) {
    assert.throws(() => manager.resolveRepresentation(malformed), TypeError);
    assert.throws(() => requireRepresentationRef(malformed), TypeError);
  }
  // A valid reference comes back frozen, with a frozen copy of its columns.
  const columns = [2, 3];
  const ref = requireRepresentationRef({ key: 'X_pca', columns });
  assert.ok(Object.isFrozen(ref) && Object.isFrozen(ref.columns));
  assert.notEqual(ref.columns, columns);
  assert.deepEqual(requireRepresentationRef({ key: 'X_pca', columns: null }), { key: 'X_pca', columns: null });
});

test('layout registration validates the whole batch before publishing any', () => {
  const manager = new DimensionManager({ embeddingsMetadata: metadata() });
  const valid = {
    layoutKey: 'tsne',
    dimension: 2,
    label: 't-SNE',
    path: 'obsm/7/0-1',
    provenance: { key: 'X_tsne', columns: [0, 1] },
    origin: 'mapping',
  };
  for (const rejected of [
    [valid, { ...valid }],
    [valid, { ...valid, layoutKey: 'X_umap' }],
    [valid, { ...valid, layoutKey: 'x', dimension: 4 }],
    [valid, { ...valid, layoutKey: 'x', origin: 'guess' }],
    [valid, { ...valid, layoutKey: 'x', provenance: { key: 'X', columns: [0] } }],
    [valid, { ...valid, layoutKey: 'x', provenance: { key: 'X', columns: [1, 1] } }],
    [valid, { ...valid, layoutKey: 'x', extra: true }],
    [],
  ]) {
    assert.throws(() => manager.registerLayouts(rejected));
    assert.equal(manager.hasLayout('tsne'), false);
  }
  assert.deepEqual(manager.registerLayouts([valid]), ['tsne']);
  assert.deepEqual(
    manager.getLayoutsForDimension(2).map(layout => layout.layoutKey),
    ['X_umap', 'tsne'],
  );
  // Registering is not enabling: a second layout of a dimension is neither
  // offered to views nor the default until the mapping says so.
  assert.equal(manager.isEnabled('tsne'), false);
  assert.equal(manager.getDefaultLayout(2), 'X_umap');
  assert.throws(
    () => manager.setRepresentations(['X_umap', 'tsne'], new Map([[3, 'tsne']])),
    /2D and cannot be the 3D default/,
  );
  manager.setRepresentations(['X_umap', 'tsne'], new Map([[2, 'tsne']]));
  assert.equal(manager.isEnabled('tsne'), true);
  assert.equal(manager.getDefaultLayout(2), 'tsne');
  // The registered provenance is addressable like an identity item's.
  assert.equal(manager.findLayoutByProvenance('X_tsne', [0, 1]), 'tsne');
});

test('a reference names exactly one registered layout', () => {
  const manager = new DimensionManager({ embeddingsMetadata: metadata() });
  manager.registerLayouts([{
    layoutKey: 'tsne',
    dimension: 2,
    label: 't-SNE',
    path: 'obsm/7/0-1',
    provenance: { key: 'X_tsne', columns: [0, 1] },
    origin: 'mapping',
  }]);

  // Resolving names a registered layout whether or not it is enabled; the
  // data state refuses to show one that is not.
  assert.equal(manager.resolveRepresentation({ key: 'X_tsne', columns: [0, 1] }), 'tsne');
  // A bare key names no layout, registered or not.
  for (const key of ['X_umap', 'X_tsne', 'tsne', 'missing']) {
    assert.throws(
      () => manager.resolveRepresentation({ key, columns: null }),
      /must list the columns it plots/,
    );
  }
  assert.equal(manager.isEnabled('tsne'), false);
  // A layout key is not an obsm key.
  assert.throws(
    () => manager.resolveRepresentation({ key: 'tsne', columns: [0, 1] }),
    /cannot plot obsm\['tsne'\] columns \[0, 1\]/,
  );
  assert.throws(
    () => manager.resolveRepresentation({ key: 'tsne' }),
    /exactly \{ key, columns \}/,
  );
});

test('the cell axis is published through one validating seam', () => {
  const manager = new DimensionManager({ embeddingsMetadata: metadata() });

  // Nothing is known before an identity states it or an embedding teaches it,
  // and that zero is what leaves the first payload ceiling-bounded.
  assert.equal(manager.getCellCount(), 0);

  // `stats.n_cells` reaching the manager as a raw property write is how a
  // wrong axis becomes a wrong byte bound. Every non-count is refused instead.
  for (const rejected of [
    0, -1, 1.5, NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER + 2,
    '120', null, undefined, true, [120], { n_cells: 120 },
  ]) {
    assert.throws(
      () => manager.publishCellCount(rejected),
      /positive safe integer/,
      `publishing ${String(rejected)} must be refused`
    );
    assert.equal(manager.getCellCount(), 0, 'a refused axis must not be stored');
  }

  assert.equal(manager.publishCellCount(120), 120);
  assert.equal(manager.getCellCount(), 120);
  // Republishing the same axis is the idempotent case, not a conflict.
  assert.equal(manager.publishCellCount(120), 120);

  // A second dataset's axis must not overwrite the first one's silently.
  assert.throws(
    () => manager.publishCellCount(121),
    /already 120/
  );
  assert.equal(manager.getCellCount(), 120);

  // Clearing is the documented way to reuse a manager, and it restores both
  // the axis and the right to publish one.
  manager.clearCache();
  assert.equal(manager.getCellCount(), 0);
  assert.equal(manager.publishCellCount(7), 7);
});

test('publishing the cell axis before the metadata is refused, not discarded', () => {
  // `initFromMetadata` clears the cache and a cache clear zeroes the axis, so
  // publishing first used to be silently dropped and left the first embedding
  // bounded only by the browser byte ceiling. The owning module now refuses
  // the order instead of relying on each construction site to remember it.
  const manager = new DimensionManager();
  manager.publishCellCount(120);
  assert.throws(
    () => manager.initFromMetadata(metadata()),
    /must be installed before the cell axis is published/
  );
  assert.equal(manager.getCellCount(), 120, 'the refused call must not clear');

  // The correct order is unaffected.
  const ordered = new DimensionManager();
  ordered.initFromMetadata(metadata());
  ordered.publishCellCount(120);
  assert.equal(ordered.getCellCount(), 120);
  assert.deepEqual(ordered.getAvailableDimensions(), [2]);

  // A construction site that supplies metadata up front is already past the
  // hazard, so it may publish immediately.
  const constructed = new DimensionManager({
    embeddingsMetadata: metadata(),
  });
  assert.equal(constructed.publishCellCount(120), 120);

  // An axis learned from a decoded payload is downstream of the metadata and
  // does not pin the ordering.
  const learned = new DimensionManager({ embeddingsMetadata: metadata() });
  learned.nCells = 120;
  assert.equal(learned.initFromMetadata(metadata('X_umap_3d', 3)), undefined);
  assert.equal(learned.getCellCount(), 0);
});

test('position caches are keyed by layout and every shown or pinned layout survives eviction', async () => {
  const cells = 4;
  const bytesPerLayout = cells * 2 * Float32Array.BYTES_PER_ELEMENT;
  const manager = new DimensionManager({
    embeddingsMetadata: metadata(),
    // Room for two resident 2D layouts, not for a third beside them.
    maxPositionBytes: bytesPerLayout * 3 - 1,
  });
  manager.registerLayouts(['tsne', 'pca'].map(layoutKey => ({
    layoutKey,
    dimension: 2,
    label: layoutKey,
    path: `obsm/${layoutKey}/0-1`,
    provenance: null,
    origin: 'mapping',
  })));
  const raw = new Map([
    ['X_umap', Float32Array.from([0, 0, 1, 1, 2, 2, 3, 3])],
    ['tsne', Float32Array.from([0, 0, 10, 10, 20, 20, 30, 30])],
    ['pca', Float32Array.from([0, 0, 2, 4, 4, 8, 6, 12])],
  ]);
  loadsAsReader(manager, async layoutKey => raw.get(layoutKey));

  manager.setViewLayout('live', 'X_umap');
  const umap = await manager.getPositions('X_umap', { showProgress: false });
  const releaseTsne = manager.pinLayout('tsne');
  const tsne = await manager.getPositions('tsne', { showProgress: false });
  assert.notStrictEqual(umap, tsne);
  assert.notDeepEqual(manager.getNormTransform('X_umap'), manager.getNormTransform('tsne'));

  // Both resident layouts are protected: the live view shows one, a caller
  // pinned the other. The budget is a residency policy, so a third layout is
  // still loaded beside them; nothing in use is evicted for it.
  await manager.getPositions('pca', { showProgress: false });
  assert.ok(manager.normalizedPositionCache.has('X_umap'));
  assert.ok(manager.normalizedPositionCache.has('tsne'));
  assert.ok(manager.normalizedPositionCache.has('pca'));
  manager.evictUnpinned();
  assert.deepEqual([...manager.normalizedPositionCache.keys()], ['X_umap', 'tsne']);

  // Released, the pinned layout is the least recently used evictable one.
  releaseTsne();
  releaseTsne();
  await manager.getPositions('pca', { showProgress: false });
  assert.deepEqual([...manager.normalizedPositionCache.keys()], ['X_umap', 'pca']);

  // A layout no view shows and nobody pinned is released explicitly.
  assert.deepEqual(manager.evictUnpinned(), ['pca']);
  assert.deepEqual([...manager.normalizedPositionCache.keys()], ['X_umap']);
  // The transform outlives eviction: centroids normalized with it stay valid.
  assert.ok(manager.getNormTransform('pca'));
});

test('a layout provider registers an AnnData reference once, as a mapping layout', () => {
  const manager = new DimensionManager({
    embeddingsMetadata: embeddings(
      [['X_umap', 2, { sourceKey: 'X_umap', columns: [0, 1] }]],
      { '2d': 'X_umap' },
      2
    ),
  });
  assert.equal(manager.hasLayoutProvider(), false);
  // Without a provider an unknown reference names nothing.
  assert.equal(manager.resolveProvenanceLayout('X_pca', [2, 3]), null);

  const calls = [];
  manager.setLayoutProvider(ref => {
    calls.push(ref);
    if (ref.key === 'X_df') throw new RangeError('obsm table, not an array');
    return {
      layoutKey: `${ref.key}[${ref.columns.join(',')}]`,
      dimension: ref.columns.length,
      label: `${ref.key}[${ref.columns.join(',')}]`,
      path: `obsm/1/${ref.columns.join('-')}`,
      provenance: { key: ref.key, columns: [...ref.columns] },
      origin: 'mapping',
    };
  });
  assert.equal(manager.hasLayoutProvider(), true);
  // A registered provenance never reaches the provider.
  assert.equal(manager.resolveProvenanceLayout('X_umap', [0, 1]), 'X_umap');
  assert.deepEqual(calls, []);

  assert.equal(manager.resolveProvenanceLayout('X_pca', [2, 3]), 'X_pca[2,3]');
  assert.equal(manager.getLayout('X_pca[2,3]').origin, 'mapping');
  assert.deepEqual(manager.getLayout('X_pca[2,3]').provenance, { key: 'X_pca', columns: [2, 3] });
  // A second request finds the registered layout and does not register again.
  assert.equal(manager.resolveProvenanceLayout('X_pca', [2, 3]), 'X_pca[2,3]');
  assert.equal(calls.length, 1);
  assert.equal(
    manager.resolveRepresentation({ key: 'X_pca', columns: [2, 3] }),
    'X_pca[2,3]'
  );

  // A refusal by the provider is "cannot plot", not a crash.
  assert.equal(manager.resolveProvenanceLayout('X_df', [0, 1]), null);
  assert.throws(
    () => manager.resolveRepresentation({ key: 'X_df', columns: [0, 1] }),
    /cannot plot obsm\['X_df'\] columns \[0, 1\]/
  );

  // A provider that describes anything but the requested reference is a bug.
  for (const wrong of [
    ref => ({ layoutKey: 'w1', dimension: 2, label: 'w1', path: 'obsm/4/0-1', provenance: { key: 'X_other', columns: ref.columns }, origin: 'mapping' }),
    ref => ({ layoutKey: 'w2', dimension: 2, label: 'w2', path: 'obsm/5/1-0', provenance: { key: ref.key, columns: [1, 0] }, origin: 'mapping' }),
    ref => ({ layoutKey: 'w3', dimension: 2, label: 'w3', path: 'obsm/6/0-1', provenance: { key: ref.key, columns: ref.columns }, origin: 'identity' }),
  ]) {
    manager.setLayoutProvider(wrong);
    assert.throws(
      () => manager.resolveProvenanceLayout('X_tsne', [0, 1]),
      /describe exactly the requested reference/
    );
  }
  assert.equal(manager.hasLayout('w1') || manager.hasLayout('w2') || manager.hasLayout('w3'), false);
  assert.throws(() => manager.setLayoutProvider('nope'), /function or null/);

  // Installing new metadata drops the provider of the previous dataset.
  manager.initFromMetadata(metadata());
  assert.equal(manager.hasLayoutProvider(), false);
});

test('representations are published as one validated replacement', () => {
  const manager = new DimensionManager({ embeddingsMetadata: multiLayoutMetadata() });
  const before = () => ({
    enabled: [...manager.getEnabledLayoutKeys()],
    defaults: [1, 2, 3].map(dimension => manager.getDefaultLayout(dimension)),
  });
  const original = before();

  for (const [enabled, defaults, pattern] of [
    [[], new Map([[2, 'X_umap']]), /At least one representation/],
    ['X_umap', new Map([[2, 'X_umap']]), /At least one representation/],
    [['X_umap', 'X_umap'], new Map([[2, 'X_umap']]), /enabled twice/],
    [['X_umap', 'nope'], new Map([[2, 'X_umap']]), /"nope" is not registered/],
    [['X_umap'], new Map(), /non-empty Map/],
    [['X_umap'], { 2: 'X_umap' }, /non-empty Map/],
    [['X_umap'], new Map([[2, 'X_pca']]), /2D default "X_pca" is not enabled/],
    [['X_umap', 'X_umap_3d'], new Map([[3, 'X_umap']]), /2D and cannot be the 3D default/],
    [['X_umap'], new Map([[4, 'X_umap']]), /dimension/i],
  ]) {
    assert.throws(() => manager.setRepresentations(enabled, defaults), pattern);
    assert.deepEqual(before(), original, 'a refused replacement changes nothing');
  }

  // Any number of representations of any dimension; a dimension may have
  // enabled layouts and no default, and then opens on its first one.
  manager.setRepresentations(
    ['X_pca_23', 'X_pca', 'X_umap_3d'],
    new Map([[3, 'X_umap_3d']])
  );
  assert.deepEqual(manager.getEnabledLayoutKeys(), ['X_pca_23', 'X_pca', 'X_umap_3d']);
  assert.equal(manager.isEnabled('X_umap'), false);
  assert.equal(manager.getDefaultLayout(2), null);
  assert.equal(manager.getOpeningLayout(2), 'X_pca_23');
  assert.deepEqual(manager.getAvailableDimensions(), [2, 3]);
  assert.equal(manager.getDefaultDimension(), 3);

  // The identity opens on 3D; while 3D has no default the dataset opens on
  // the highest dimension that has one, and returns to 3D when it has one
  // again.
  manager.setRepresentations(['X_pca', 'X_umap_3d'], new Map([[2, 'X_pca']]));
  assert.equal(manager.getDefaultDimension(), 2);
  assert.equal(manager.getDefaultLayoutKey(), 'X_pca');
  assert.equal(manager.hasDimension(3), true, '3D is still enabled, only not a default');
  manager.setRepresentations(['X_pca'], new Map([[2, 'X_pca']]));
  assert.deepEqual(manager.getAvailableDimensions(), [2]);
  assert.equal(manager.hasDimension(3), false);
  manager.setRepresentations(['X_pca', 'X_umap_3d'], new Map([[2, 'X_pca'], [3, 'X_umap_3d']]));
  assert.equal(manager.getDefaultDimension(), 3);
  assert.equal(manager.getDefaultLayoutKey(), 'X_umap_3d');

  // Views are not the registry's to police: the data state moves every view
  // off a layout before disabling it.
  manager.setViewLayout('live', 'X_pca_23');
  manager.setRepresentations(['X_pca'], new Map([[2, 'X_pca']]));
  assert.equal(manager.getViewLayout('live'), 'X_pca_23');
});

test('before any representation is published there is nothing to open on', () => {
  const manager = new DimensionManager();
  assert.deepEqual(manager.getEnabledLayoutKeys(), []);
  assert.deepEqual(manager.getAvailableDimensions(), []);
  assert.equal(manager.getDefaultLayoutKey(), null);
  assert.equal(manager.getOpeningLayout(2), null);
  assert.equal(manager.getDefaultDimension(), 3, 'the placeholder dimension');
});


test('the position budget never refuses the layouts the views show plus the one being shown', async () => {
  const cells = 4;
  const bytesPerLayout = cells * 2 * Float32Array.BYTES_PER_ELEMENT;
  const manager = new DimensionManager({
    embeddingsMetadata: metadata(),
    // Smaller than one layout: a browser that reports little memory.
    maxPositionBytes: bytesPerLayout - 1,
  });
  manager.registerLayouts([{
    layoutKey: 'tsne',
    dimension: 2,
    label: 'tsne',
    path: 'obsm/7/0-1',
    provenance: null,
    origin: 'mapping',
  }]);
  const raw = new Map([
    ['X_umap', Float32Array.from([0, 0, 1, 1, 2, 2, 3, 3])],
    ['tsne', Float32Array.from([0, 0, 10, 10, 20, 20, 30, 30])],
  ]);
  loadsAsReader(manager, async layoutKey => raw.get(layoutKey));
  manager.setViewLayout('live', 'X_umap');
  await manager.getPositions('X_umap', { showProgress: false });
  // A second view shows t-SNE beside UMAP: both are shown, so both stay.
  manager.setViewLayout('snapshot-1', 'tsne');
  await manager.getPositions('tsne', { showProgress: false });
  assert.deepEqual([...manager.normalizedPositionCache.keys()].sort(), ['X_umap', 'tsne']);
});
