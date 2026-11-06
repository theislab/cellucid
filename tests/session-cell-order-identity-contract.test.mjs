import assert from 'node:assert/strict';
import test from 'node:test';
import { UNCHANGEABLE_GROUP_CLAUSE } from '../assets/js/data/dataset-mapping.js';

import {
  readBundle,
} from '../assets/js/app/session/bundle/reader.js';
import {
  writeBundle,
} from '../assets/js/app/session/bundle/writer.js';
import {
  NOT_A_SESSION_FILE_MESSAGE,
  SESSION_BUNDLE_MAGIC_BYTES,
} from '../assets/js/app/session/bundle/format.js';
import {
  assertDatasetFingerprint,
  datasetFingerprintMatches,
  describeDataMappingMismatch,
  describeMissingRequiredFields,
  verifySessionFingerprint,
} from '../assets/js/app/session/session-context.js';
import {
  validateDataMapping,
} from '../assets/js/data/data-mapping.js';
import { cellOrderDigest } from '../assets/js/data/cell-order-digest.js';

import {
  CELL_COUNT,
  VAR_COUNT,
  SELECTED_ROWS,
  IDENTITY_ORDER,
  KEYED_LAYOUTS,
  ANNDATA_LAYOUTS,
  keyedEmbeddings,
  keyedMapping,
  anndataEmbeddings,
  anndataMapping,
  positionsForCellOrder,
  makeDatasetState,
  makeDataSourceManager,
  makeSerializer,
  sessionOf,
  fingerprintOf,
  selectionPages,
  emptyPages,
  withNotificationHarness,
} from './helpers/session-dataset.mjs';

async function rewriteSessionBundle(blob, mutate) {
  const { manifest, chunkStream } = await readBundle(blob, {
    signal: null,
    onProgress: null,
  });
  const chunks = [];
  for await (const chunk of chunkStream) chunks.push(chunk.bytes);
  mutate(manifest, chunks);
  return writeBundle({ manifest, chunks });
}

async function readManifest(blob) {
  const { manifest, chunkStream } = await readBundle(blob, {
    signal: null,
    onProgress: null,
  });
  for await (const _chunk of chunkStream) {
    // Drain the stream so the reader settles.
  }
  return manifest;
}

async function captureSelectionBundle(options = {}) {
  const source = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: selectionPages(SELECTED_ROWS),
    ...options,
  });
  return {
    bundle: await sessionOf(source),
    source,
  };
}

function restoredSelection(state) {
  return state.highlightPages.flatMap(page => (
    page.highlightedGroups.map(group => [...group.cellIndices])
  ));
}

function heldPins(state) {
  return state.dimensionManager._layoutPins.size;
}

async function refusal(state, bundle) {
  let message = null;
  await withNotificationHarness(async () => {
    await assert.rejects(
      makeSerializer(state).restoreFromBlob(bundle),
      error => {
        assert.ok(error instanceof RangeError);
        message = error.message;
        return true;
      },
    );
  });
  return message;
}

test(
  're-exported dataset with permuted rows cannot silently restore a selection',
  async () => {
    const { bundle, source } = await captureSelectionBundle();
    // What the user actually selected, by cell, not by row.
    const selectedCells = SELECTED_ROWS.map(row => source.cellOrder[row]);
    assert.deepEqual(selectedCells, [0, 2]);

    // Same dataset id, same cell count, same gene count, same data mapping,
    // re-exported from re-sorted input: only the row order changed.
    const permutedOrder = [5, 4, 3, 2, 1, 0];
    const destination = makeDatasetState({
      cellOrder: permutedOrder,
      pages: emptyPages(),
    });
    assert.equal(destination.pointCount, source.pointCount);
    assert.equal(
      destination.varData.fields.length,
      source.varData.fields.length,
    );
    // The harm this refusal prevents: the saved rows point at other cells.
    assert.deepEqual(
      SELECTED_ROWS.map(row => permutedOrder[row]),
      [5, 3],
    );

    const untouchedPages = destination.highlightPages;
    const message = await refusal(destination, bundle);
    assert.match(message, /coordinates differ/);
    assert.match(message, /different order/);
    // Row order is one of the two things a coordinate difference can mean,
    // so it is offered, never asserted.
    assert.match(message, /Either the cells are listed in a different order/);
    assert.strictEqual(destination.highlightPages, untouchedPages);
    assert.deepEqual(restoredSelection(destination), []);
    assert.equal(heldPins(destination), 0);
  },
);

test('an unchanged dataset restores the exact selected set', async () => {
  const { bundle } = await captureSelectionBundle();
  const destination = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
  });

  await withNotificationHarness(async () => {
    await makeSerializer(destination).restoreFromBlob(bundle);
  });

  assert.deepEqual(restoredSelection(destination), [SELECTED_ROWS]);
  assert.deepEqual(
    restoredSelection(destination)[0].map(row => destination.cellOrder[row]),
    [0, 2],
  );
  assert.ok(
    destination.highlightPages[0].highlightedGroups[0].cellIndices
      instanceof Uint32Array,
  );
  assert.deepEqual(
    destination.highlightPages[0].highlightedGroups[0].label,
    'CD8 T cells',
  );
  // The live layout (held in memory here) was digested from its resident
  // positions; nothing was pinned or loaded.
  assert.deepEqual(destination.dimensionLog, [
    ['getPositions', 'X_umap_3d'],
  ]);
  assert.equal(heldPins(destination), 0);
});

test('a file without the session signature is refused by its signature, before anything is read', async () => {
  const { bundle } = await captureSelectionBundle();
  const bytes = new Uint8Array(await bundle.arrayBuffer());
  // The same framing behind an unversioned signature.
  const signature = new TextEncoder().encode('CELLUCID_SESSION\n');
  const rest = bytes.subarray(SESSION_BUNDLE_MAGIC_BYTES.byteLength);
  const unversioned = new Uint8Array(signature.byteLength + rest.byteLength);
  unversioned.set(signature, 0);
  unversioned.set(rest, signature.byteLength);
  const destination = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
  });

  await withNotificationHarness(async () => {
    await assert.rejects(
      makeSerializer(destination).restoreFromBlob(new Blob([unversioned])),
      error => {
        assert.equal(error.message, NOT_A_SESSION_FILE_MESSAGE);
        return true;
      },
    );
  });
  assert.deepEqual(restoredSelection(destination), []);
  // Refused at the signature: no layout was even looked at.
  assert.deepEqual(destination.dimensionLog, []);
});

test('a fingerprint missing a field is a schema violation', async () => {
  const { bundle } = await captureSelectionBundle();
  const withoutName = await rewriteSessionBundle(bundle, manifest => {
    delete manifest.datasetFingerprint.name;
  });
  const destination = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
  });
  await withNotificationHarness(async () => {
    await assert.rejects(
      makeSerializer(destination).restoreFromBlob(withoutName),
      /must contain exactly/,
    );
  });
  assert.deepEqual(destination.dimensionLog, []);
});

test(
  'a session saved in 3D opens while 2D is shown: the saved layout is loaded, not the live one',
  async () => {
    const { bundle } = await captureSelectionBundle();
    const manifest = await readManifest(bundle);
    assert.deepEqual(manifest.datasetFingerprint.cellOrder.embedding, {
      key: 'X_umap_3d',
      columns: [0, 1, 2],
    });
    assert.equal(manifest.datasetFingerprint.cellOrder.dimension, 3);

    const destination = makeDatasetState({
      cellOrder: IDENTITY_ORDER,
      pages: emptyPages(),
      liveLayoutKey: 'X_umap_2d',
    });
    const livePositions = destination.positionsArray;
    assert.equal(
      destination.dimensionManager.getResidentPositions('X_umap_3d'),
      null,
    );

    await withNotificationHarness(async () => {
      await makeSerializer(destination).restoreFromBlob(bundle);
    });

    assert.deepEqual(restoredSelection(destination), [SELECTED_ROWS]);
    // The 3D layout the session names (held in memory here) was loaded
    // without progress UI and digested; the live view kept showing its 2D
    // layout.
    assert.deepEqual(destination.dimensionLog, [
      ['getPositions', 'X_umap_3d'],
      ['load', 'X_umap_3d'],
    ]);
    assert.equal(heldPins(destination), 0);
    assert.equal(destination.dimensionManager.getViewLayout('live'), 'X_umap_2d');
    assert.strictEqual(destination.positionsArray, livePositions);
  },
);

test(
  'a session saved on a non-default embedding verifies that embedding, whatever is shown',
  async () => {
    // The session was saved while the live 2D view showed X_tsne_2d, not
    // the 2D default X_umap_2d.
    const { bundle } = await captureSelectionBundle({ liveLayoutKey: 'X_tsne_2d' });
    const manifest = await readManifest(bundle);
    assert.deepEqual(manifest.datasetFingerprint.cellOrder, {
      embedding: { key: 'X_tsne_2d', columns: [0, 1] },
      dimension: 2,
      digest: cellOrderDigest(positionsForCellOrder(IDENTITY_ORDER, 2, 3), 2),
    });
    // The mapping records the enabled set and the defaults, not what one view
    // shows.
    assert.deepEqual(manifest.datasetFingerprint.dataMapping, keyedMapping());

    const destination = makeDatasetState({
      cellOrder: IDENTITY_ORDER,
      pages: emptyPages(),
    });
    await withNotificationHarness(async () => {
      await makeSerializer(destination).restoreFromBlob(bundle);
    });
    assert.deepEqual(restoredSelection(destination), [SELECTED_ROWS]);
    assert.deepEqual(destination.dimensionLog.map(entry => entry.slice(0, 2)), [
      ['getPositions', 'X_tsne_2d'],
      ['load', 'X_tsne_2d'],
    ]);
    assert.equal(destination.dimensionManager.getViewLayout('live'), 'X_umap_3d');

    // The same check refuses that embedding when only it was re-ordered.
    const permutedTsne = makeDatasetState({
      cellOrder: IDENTITY_ORDER,
      pages: emptyPages(),
      positionsOverride: {
        X_tsne_2d: positionsForCellOrder([1, 0, 2, 3, 4, 5], 2, 3),
      },
    });
    const message = await refusal(permutedTsne, bundle);
    assert.match(message, /coordinates differ/);
    assert.deepEqual(restoredSelection(permutedTsne), []);
    assert.equal(heldPins(permutedTsne), 0);
  },
);

test('a session naming an embedding this dataset does not have is refused by name', async () => {
  const { bundle } = await captureSelectionBundle({ liveLayoutKey: 'X_tsne_2d' });
  // The same data mapping, but the dataset has no X_tsne_2d layout.
  const destination = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    layouts: KEYED_LAYOUTS.filter(layout => layout.layoutKey !== 'X_tsne_2d'),
  });
  const message = await refusal(destination, bundle);
  assert.equal(
    message,
    "This session recorded its cell order on obsm['X_tsne_2d'] columns [0, 1] in 2D, "
      + 'which this dataset does not have. The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.',
  );
  assert.deepEqual(restoredSelection(destination), []);
  assert.deepEqual(destination.dimensionLog, []);

  // Other columns of an array the dataset plots are not the layout recorded.
  const otherColumns = await rewriteSessionBundle(bundle, manifest => {
    manifest.datasetFingerprint.cellOrder.embedding = {
      key: 'X_umap_3d',
      columns: [0, 1],
    };
  });
  const sameLayouts = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
  });
  assert.match(
    await refusal(sameLayouts, otherColumns),
    /^This session recorded its cell order on obsm\['X_umap_3d'\] columns \[0, 1\] in 2D, which this dataset does not have\./,
  );
  assert.deepEqual(sameLayouts.dimensionLog, []);
});

test('a session restores the embeddings it names, before its views', async () => {
  const { bundle } = await captureSelectionBundle();
  const saved = (await readManifest(bundle)).datasetFingerprint.dataMapping;

  // The dataset defaults to X_tsne_2d in 2D now; the session was saved with
  // X_umap_2d as that default, which this dataset also has, so the session
  // restores it.
  const otherSlot = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    mapping: keyedMapping({
      embeddings: keyedEmbeddings(
        ['X_tsne_2d', 'X_umap_2d', 'X_umap_3d'],
        { d2: 'X_tsne_2d', d3: 'X_umap_3d' },
      ),
    }),
  });
  await withNotificationHarness(async () => {
    await makeSerializer(otherSlot).restoreFromBlob(bundle);
  });
  assert.deepEqual(restoredSelection(otherSlot), [SELECTED_ROWS]);
  assert.deepEqual(otherSlot.appliedMappings, [{ mapping: saved, origin: 'session' }]);
  assert.deepEqual(otherSlot.getDataMapping(), saved);
});

test('a data mapping mismatch is refused naming the group, before any layout loads', async () => {
  const { bundle } = await captureSelectionBundle();

  // An enabled embedding this dataset does not have is refused by name.
  const missingSlot = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    layouts: KEYED_LAYOUTS.filter(layout => layout.layoutKey !== 'X_umap_2d'),
    mapping: keyedMapping({
      embeddings: keyedEmbeddings(
        ['X_tsne_2d', 'X_umap_3d'],
        { d2: 'X_tsne_2d', d3: 'X_umap_3d' },
      ),
    }),
  });
  assert.equal(
    await refusal(missingSlot, bundle),
    "This session shows obsm['X_umap_2d'] columns [0, 1], which this dataset does not "
      + 'have. The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.',
  );
  assert.deepEqual(missingSlot.dimensionLog, []);
  assert.deepEqual(missingSlot.appliedMappings, []);
  assert.deepEqual(restoredSelection(missingSlot), []);

  const otherGenes = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    mapping: keyedMapping({ geneNames: 'column:gene_symbols' }),
  });
  assert.equal(
    await refusal(otherGenes, bundle),
    'This session was saved with the var index as its gene names, and this '
      + "dataset is shown with var column 'gene_symbols'. The session was not opened."
      + ' Open the dataset version the session was saved on, then load the session again.',
  );
  assert.deepEqual(otherGenes.dimensionLog, []);
});

test('every data mapping group is named the way the person loading the session knows it', () => {
  const base = anndataMapping();
  // The readers of a dataset that can show any embedding / none, and that
  // cannot change any other group.
  const fixed = () => UNCHANGEABLE_GROUP_CLAUSE;
  const canShowAny = { describeEmbeddingRefusal: () => null, describeChoiceRefusal: fixed };
  const hasNone = {
    describeEmbeddingRefusal: () => 'this dataset does not have',
    describeChoiceRefusal: fixed,
  };
  assert.equal(describeDataMappingMismatch(base, anndataMapping(), hasNone), null);
  const cases = [
    [
      anndataMapping({ knn: null }),
      "This session was saved with obsp['connectivities'] as its neighbour graph, "
        + 'and this dataset is shown with none. The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.',
    ],
    [
      anndataMapping({ expression: 'layer:log1p' }),
      'This session was saved with X as its expression matrix, and this dataset '
        + "is shown with layers['log1p']. The session was not opened."
      + ' Open the dataset version the session was saved on, then load the session again.',
    ],
    [
      anndataMapping({ latent: 'X_pca' }),
      'This session was saved with none as its latent space, and this dataset '
        + "is shown with obsm['X_pca']. The session was not opened."
      + ' Open the dataset version the session was saved on, then load the session again.',
    ],
    [
      anndataMapping({
        embeddings: anndataEmbeddings(['pca', 'umap3d'], { d2: 'pca', d3: 'umap3d' }),
      }),
      "This session shows obsm['X_umap'] columns [0, 1], which this dataset "
        + 'does not have. The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.',
    ],
    [
      anndataMapping({
        embeddings: anndataEmbeddings(['pca', 'umap'], { d2: 'umap' }),
      }),
      "This session shows obsm['X_umap_3d'] columns [0, 1, 2], which this "
        + 'dataset does not have. The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.',
    ],
  ];
  for (const [current, expected] of cases) {
    assert.equal(describeDataMappingMismatch(base, current, hasNone), expected);
  }
  // Embeddings the dataset can show are restored, not refused.
  for (const [current] of cases.slice(3, 5)) {
    assert.equal(describeDataMappingMismatch(base, current, canShowAny), null);
  }
  // A session that enables fewer embeddings than the dataset shows now is
  // restored: every embedding it names is one this dataset has.
  assert.equal(
    describeDataMappingMismatch(
      anndataMapping({
        embeddings: anndataEmbeddings(['umap'], { d2: 'umap' }),
      }),
      base,
      hasNone,
    ),
    null,
  );
  assert.throws(() => describeDataMappingMismatch(base, base), /embedding and a choice refusal reader/);

  // A group the dataset can change is restored when it can use the saved
  // choice, and refused, naming it, when it cannot.
  const changeable = refusal => ({
    describeEmbeddingRefusal: () => null,
    describeChoiceRefusal: (group, value) => (group === 'knn' ? refusal(value) : fixed()),
  });
  assert.equal(
    describeDataMappingMismatch(base, anndataMapping({ knn: 'scvi_connectivities' }), changeable(() => null)),
    null,
  );
  assert.equal(
    describeDataMappingMismatch(
      base,
      anndataMapping({ knn: null }),
      changeable(() => 'this dataset does not have'),
    ),
    "This session uses obsp['connectivities'] as its neighbour graph, which this dataset "
      + 'does not have. The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.',
  );
  assert.equal(
    describeDataMappingMismatch(
      anndataMapping({ knn: 'distances' }),
      base,
      changeable(() => 'this dataset cannot use (not symmetric — choose a connectivities matrix)'),
    ),
    "This session uses obsp['distances'] as its neighbour graph, which this dataset cannot "
      + 'use (not symmetric — choose a connectivities matrix). The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.',
  );
});

test('nothing is applied before verification passes', async () => {
  const { bundle } = await captureSelectionBundle();

  async function restoreWhileLoading(destination, settle) {
    const untouchedPages = destination.highlightPages;
    await withNotificationHarness(async () => {
      const restore = makeSerializer(destination).restoreFromBlob(bundle);
      restore.catch(() => {});
      while (destination.pendingLoads.length === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
      // The saved layout is still loading: the session is not verified, so
      // no contributor has run and no state has changed.
      for (let tick = 0; tick < 5; tick++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.strictEqual(destination.highlightPages, untouchedPages);
      assert.deepEqual(restoredSelection(destination), []);
      destination.pendingLoads.shift()();
      await settle(restore);
    });
    assert.equal(heldPins(destination), 0);
  }

  // A saved layout whose rows differ: refused once loaded, and nothing was
  // applied while it loaded or after.
  const permuted = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    liveLayoutKey: 'X_umap_2d',
    positionsOverride: {
      X_umap_3d: positionsForCellOrder([5, 4, 3, 2, 1, 0], 3),
    },
    deferLoads: true,
  });
  await restoreWhileLoading(permuted, restore => assert.rejects(
    restore,
    error => error instanceof RangeError && /coordinates differ/.test(error.message),
  ));
  assert.deepEqual(restoredSelection(permuted), []);

  // The same wait on a matching layout ends in the restore.
  const matching = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    liveLayoutKey: 'X_umap_2d',
    deferLoads: true,
  });
  await restoreWhileLoading(matching, restore => restore);
  assert.deepEqual(restoredSelection(matching), [SELECTED_ROWS]);
});

test('verifySessionFingerprint checks identity, then mapping, then the digest', async () => {
  const source = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  const saved = await fingerprintOf(source);
  const ctx = state => ({ dataSourceManager: makeDataSourceManager(), state });

  const same = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    liveLayoutKey: 'X_tsne_2d',
  });
  assert.equal(await verifySessionFingerprint(ctx(same), saved), null);
  assert.equal(same.dimensionManager.getViewLayout('live'), 'X_tsne_2d');

  // A count difference wins over a mapping difference, which wins over the
  // digest: each refusal names the first thing that differs.
  const everythingDiffers = makeDatasetState({
    cellOrder: [0, 1, 2, 3, 4],
    pages: emptyPages(),
    mapping: keyedMapping({ geneNames: 'column:symbol' }),
  });
  assert.match(
    await verifySessionFingerprint(ctx(everythingDiffers), saved),
    /6 cells and 4 genes when it was saved, 5 cells and 4 genes now/,
  );
  assert.deepEqual(everythingDiffers.dimensionLog, []);

  const mappingAndRows = makeDatasetState({
    cellOrder: [5, 4, 3, 2, 1, 0],
    pages: emptyPages(),
    mapping: keyedMapping({ geneNames: 'column:symbol' }),
  });
  assert.match(
    await verifySessionFingerprint(ctx(mappingAndRows), saved),
    /as its gene names/,
  );
  assert.deepEqual(mappingAndRows.dimensionLog, []);

  // Told apart by identity, named by the names they show, never by an
  // identity id (an internal key: a link's is its encoded address).
  const otherCopy = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  const otherCopyRefusal = await verifySessionFingerprint(
    {
      dataSourceManager: {
        getCurrentIdentityId: () => 'pancreas-mirror',
        getCurrentMetadata: () => ({ name: 'Pancreas mirror' }),
      },
      state: otherCopy,
    },
    saved,
  );
  assert.match(otherCopyRefusal, /saved on a different dataset\. It has the same.*another dataset and "Pancreas mirror" is open now/);
  assert.doesNotMatch(otherCopyRefusal, /pancreas-mirror|"pancreas"/);

  // Validation precedes everything: a malformed record never reaches the
  // dataset.
  await assert.rejects(
    verifySessionFingerprint(ctx(same), {
      datasetId: saved.datasetId,
      cellCount: saved.cellCount,
      varCount: saved.varCount,
      cellOrder: { dimension: 3, digest: saved.cellOrder.digest },
    }),
    /must contain exactly/,
  );
});

test('a published starting view applies to any subsample of its dataset; another session names its cells', async () => {
  const { createCellIdentity } = await import('../assets/js/data/cell-identity.js');
  const source = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  const saved = await fingerprintOf(source);
  const ctx = state => ({ dataSourceManager: makeDataSourceManager(), state });
  // Four of the six cells open (fitted to the device, or named in the link).
  const subsample = makeDatasetState({ cellOrder: [0, 1, 2, 3], pages: emptyPages() });
  subsample.cellIdentity = createCellIdentity({ nObs: 6, kept: Uint32Array.of(0, 2, 3, 5) });
  assert.equal(await verifySessionFingerprint(ctx(subsample), saved, { profile: 'published-default' }), null);
  // A user session saved on every cell is restored on every cell (its cells are opened first).
  assert.match(await verifySessionFingerprint(ctx(subsample), saved), /6 cells and 4 genes when it was saved, 4 cells/);
  // A subsample of another dataset (another cell count) is still refused.
  subsample.cellIdentity = createCellIdentity({ nObs: 7, kept: Uint32Array.of(0, 2, 3, 5) });
  assert.match(await verifySessionFingerprint(ctx(subsample), saved, { profile: 'published-default' }), /different dataset/);
});

test(
  'a re-computed embedding at the same dimension is not called a re-ordering',
  async () => {
    const { bundle } = await captureSelectionBundle();
    // Same cells in the same rows: only the embedding was computed again, so
    // the coordinates moved and the digest changed. Nothing here re-ordered
    // any row, and the refusal must not say that it did.
    const destination = makeDatasetState({
      cellOrder: IDENTITY_ORDER,
      pages: emptyPages(),
      positionsOverride: {
        X_umap_3d: positionsForCellOrder(IDENTITY_ORDER, 3).map(
          value => value + 0.0009765625,
        ),
      },
    });

    const message = await refusal(destination, bundle);
    // The one thing the digest establishes.
    assert.match(message, /coordinates differ/);
    // Both causes it cannot separate, offered as alternatives.
    assert.match(message, /Either the cells are listed in a different order/);
    assert.match(message, /re-computed embedding/);
    // Never the old claim that a re-ordering is what happened.
    assert.doesNotMatch(message, /would mark the wrong cells/);
    assert.doesNotMatch(message, /but its cells are stored in a different order/);
    assert.deepEqual(restoredSelection(destination), []);
  },
);

test('dataset fingerprints are exactly six fields with a cell-order digest over every cell', async () => {
  const state = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
  });
  const fingerprint = await fingerprintOf(state);
  assert.deepEqual(Object.keys(fingerprint).sort(), [
    'cellCount',
    'cellOrder',
    'dataMapping',
    'datasetId',
    'name',
    'varCount',
  ]);
  assert.equal(fingerprint.datasetId, 'pancreas');
  assert.equal(fingerprint.cellCount, CELL_COUNT);
  assert.equal(fingerprint.varCount, VAR_COUNT);
  assert.deepEqual(Object.keys(fingerprint.cellOrder), ['embedding', 'dimension', 'digest']);
  assert.deepEqual(fingerprint.cellOrder.embedding, { key: 'X_umap_3d', columns: [0, 1, 2] });
  assert.equal(fingerprint.cellOrder.dimension, 3);
  assert.match(fingerprint.cellOrder.digest, /^[0-9a-f]{16}$/);
  assert.equal(
    fingerprint.cellOrder.digest,
    cellOrderDigest(positionsForCellOrder(IDENTITY_ORDER, 3), 3),
  );
  assert.equal(Object.isFrozen(fingerprint.cellOrder), true);
  assert.equal(Object.isFrozen(fingerprint.cellOrder.embedding), true);
  // The mapping is the canonical one, key order included, so its JSON is the
  // same bytes on every writer.
  assert.equal(
    JSON.stringify(fingerprint.dataMapping),
    JSON.stringify(validateDataMapping(keyedMapping())),
  );
  assert.deepEqual(Object.keys(fingerprint.dataMapping), [
    'kind',
    'embeddings',
    'knn',
    'geneNames',
    'expression',
    'log1p',
    'highlyVariable',
    'latent',
    'vectorFields',
  ]);
  assert.strictEqual(assertDatasetFingerprint(fingerprint, 'Fingerprint'), fingerprint);

  // Swapping the two last cells is enough to change the digest: the check is
  // not a sample.
  const swappedFingerprint = await fingerprintOf(makeDatasetState({
    cellOrder: [0, 1, 2, 3, 5, 4],
    pages: emptyPages(),
  }));
  assert.equal(swappedFingerprint.cellCount, fingerprint.cellCount);
  assert.equal(swappedFingerprint.varCount, fingerprint.varCount);
  assert.notEqual(
    swappedFingerprint.cellOrder.digest,
    fingerprint.cellOrder.digest,
  );
  assert.equal(datasetFingerprintMatches(fingerprint, swappedFingerprint), false);
  assert.equal(
    datasetFingerprintMatches(
      fingerprint,
      await fingerprintOf(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() })),
    ),
    true,
  );
  // The embedding and the mapping are part of the identity.
  assert.equal(
    datasetFingerprintMatches(
      fingerprint,
      await fingerprintOf(makeDatasetState({
        cellOrder: IDENTITY_ORDER,
        pages: emptyPages(),
        mapping: keyedMapping({ geneNames: 'column:symbol' }),
      })),
    ),
    false,
  );

  // The fingerprint needs the mapping the dataset is shown with.
  const unmapped = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  unmapped.getDataMapping = () => null;
  await assert.rejects(fingerprintOf(unmapped), /requires the loaded data mapping/);
  const noLayoutKey = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  delete noLayoutKey.getViewLayoutKey;
  await assert.rejects(fingerprintOf(noLayoutKey), /getViewLayoutKey/);
});

test('cellOrder.embedding names the live layout by obsm key and columns, whatever its layout key', async () => {
  const keyedFingerprint = await fingerprintOf(makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    liveLayoutKey: 'X_tsne_2d',
  }));
  assert.deepEqual(keyedFingerprint.cellOrder.embedding, { key: 'X_tsne_2d', columns: [0, 1] });
  assert.equal(keyedFingerprint.cellOrder.dimension, 2);

  const anndataFingerprint = await fingerprintOf(makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    kind: 'anndata',
    liveLayoutKey: 'X_pca:3,1',
  }));
  assert.deepEqual(anndataFingerprint.cellOrder.embedding, { key: 'X_pca', columns: [3, 1] });
  assert.equal(anndataFingerprint.cellOrder.dimension, 2);
  assert.deepEqual(anndataFingerprint.dataMapping, anndataMapping());
  assert.deepEqual(Object.keys(anndataFingerprint.dataMapping), [
    'kind',
    'embeddings',
    'knn',
    'geneNames',
    'expression',
    'log1p',
    'highlyVariable',
    'latent',
    'vectorFields',
  ]);

  // An AnnData layout with no obsm provenance cannot be named in a session.
  const unnamed = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    kind: 'anndata',
    layouts: [
      ...ANNDATA_LAYOUTS,
      { layoutKey: 'scratch', dimension: 2, scale: 7, provenance: null },
    ],
    liveLayoutKey: 'scratch',
  });
  await assert.rejects(fingerprintOf(unnamed), /no AnnData obsm provenance/);
});

test('an AnnData session is verified on the obsm columns it names', async () => {
  const { bundle } = await captureSelectionBundle({
    kind: 'anndata',
    liveLayoutKey: 'X_pca:3,1',
  });
  const manifest = await readManifest(bundle);
  assert.deepEqual(manifest.datasetFingerprint.cellOrder.embedding, {
    key: 'X_pca',
    columns: [3, 1],
  });

  // The same obsm columns registered under another layout key resolve by
  // their provenance, while the live view shows the 3D UMAP.
  const destination = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    kind: 'anndata',
    layouts: ANNDATA_LAYOUTS.map(layout => (
      layout.layoutKey === 'X_pca:3,1' ? { ...layout, layoutKey: 'pca-view' } : layout
    )),
  });
  await withNotificationHarness(async () => {
    await makeSerializer(destination).restoreFromBlob(bundle);
  });
  assert.deepEqual(restoredSelection(destination), [SELECTED_ROWS]);
  assert.deepEqual(destination.dimensionLog.map(entry => entry.slice(0, 2)), [
    ['getPositions', 'pca-view'],
    ['load', 'pca-view'],
  ]);

  // Other columns of the same array are another embedding.
  const otherColumns = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    kind: 'anndata',
    layouts: ANNDATA_LAYOUTS.map(layout => (
      layout.layoutKey === 'X_pca:3,1'
        ? { ...layout, provenance: { key: 'X_pca', columns: [1, 3] } }
        : layout
    )),
  });
  assert.equal(
    await refusal(otherColumns, bundle),
    "This session recorded its cell order on obsm['X_pca'] columns [3, 1] in 2D, "
      + 'which this dataset does not have. The session was not opened.'
      + ' Open the dataset version the session was saved on, then load the session again.',
  );
  assert.deepEqual(otherColumns.dimensionLog, []);

});

test('a fingerprint record must be exact and its data mapping canonical', async () => {
  const keyedFingerprint = await fingerprintOf(makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
  }));
  const anndataFingerprint = await fingerprintOf(makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    kind: 'anndata',
  }));
  const clone = value => structuredClone({
    ...value,
    cellOrder: { ...value.cellOrder },
  });
  const rejects = (mutate, pattern, base = keyedFingerprint) => {
    const record = clone(base);
    mutate(record);
    assert.throws(
      () => assertDatasetFingerprint(record, 'Saved dataset fingerprint'),
      error => error instanceof TypeError && pattern.test(error.message),
    );
  };

  assert.doesNotThrow(() => assertDatasetFingerprint(clone(keyedFingerprint), 'Saved'));
  assert.doesNotThrow(() => assertDatasetFingerprint(clone(anndataFingerprint), 'Saved'));

  // Exact top-level and cellOrder keys.
  rejects(record => { record.legacyDimension = 3; }, /must contain exactly|legacyDimension/);
  rejects(record => { record.cellOrder.layoutKey = 'X_umap_3d'; }, /cellOrder/);
  // A record with a mapping but a cell order without its embedding is a
  // schema violation, not the pre-mapping file.
  rejects(record => { delete record.cellOrder.embedding; }, /cellOrder/);
  rejects(record => { record.cellOrder.digest = 'ABCDEF0123456789'; }, /hexadecimal/);
  rejects(record => { record.cellOrder.dimension = 4; }, /dimension/);
  // An embedding is named by its obsm key and columns, one column per axis.
  rejects(
    record => { record.cellOrder.embedding = { key: 'X_umap_3d', columns: [0, 1] }; },
    /exactly 3 columns/,
    anndataFingerprint,
  );
  rejects(
    record => { record.cellOrder.embedding = { key: 'X_umap_3d', columns: null }; },
    /must be a list/,
    anndataFingerprint,
  );
  // The mapping must validate and already be canonical.
  rejects(record => { record.dataMapping.kind = 'h5ad'; }, /kind/);
  rejects(
    record => {
      const { kind, embeddings, knn, geneNames, expression, log1p, highlyVariable, latent, vectorFields } = record.dataMapping;
      record.dataMapping = { kind, geneNames, embeddings, knn, expression, log1p, highlyVariable, latent, vectorFields };
    },
    /canonical form/,
  );
  rejects(
    record => {
      record.dataMapping.vectorFields = [
        { key: 'velocity_umap_3d', embedding: { key: 'X_umap_3d', columns: [0, 1, 2] } },
        { key: 'drift_umap_2d', embedding: { key: 'X_umap_2d', columns: [0, 1] } },
      ];
    },
    /sorted/,
  );
  rejects(
    record => {
      record.dataMapping.embeddings.defaults = { '1d': null, '2d': null, '3d': null };
    },
    /at least one default/,
  );
  rejects(
    record => {
      record.dataMapping.embeddings = record.dataMapping.embeddings.defaults;
    },
    /\(missing: defaults, enabled; unexpected: 1d, 2d, 3d\)/,
  );

  // A record without its name, or with a name that is not a string, is a
  // schema violation; null is a dataset that states none.
  rejects(record => { delete record.name; }, /must contain exactly/);
  rejects(record => { record.name = 7; }, /name/);
  assert.doesNotThrow(() => assertDatasetFingerprint({ ...clone(keyedFingerprint), name: null }, 'Saved'));
});

test('cell-order digests are stable and dataset-wide', async () => {
  const cellOrder = Array.from({ length: 4096 }, (_value, index) => index);
  const first = await fingerprintOf(makeDatasetState({ cellOrder, pages: emptyPages() }));
  const second = await fingerprintOf(makeDatasetState({ cellOrder, pages: emptyPages() }));
  assert.equal(second.cellOrder.digest, first.cellOrder.digest);

  for (const row of [0, 1, 2047, 4094, 4095]) {
    const moved = [...cellOrder];
    const other = row === 0 ? 1 : row - 1;
    [moved[row], moved[other]] = [moved[other], moved[row]];
    const mutated = await fingerprintOf(makeDatasetState({ cellOrder: moved, pages: emptyPages() }));
    assert.notEqual(
      mutated.cellOrder.digest,
      first.cellOrder.digest,
      `swapping rows ${row} and ${other} must change the digest`,
    );
  }
});

async function verifyRefusals() {
  const saved = await fingerprintOf(makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
    liveLayoutKey: 'X_tsne_2d',
  }));
  const verify = (state, manager = makeDataSourceManager()) => (
    verifySessionFingerprint({ dataSourceManager: manager, state }, saved)
  );
  return {
    counts: await verify(makeDatasetState({ cellOrder: [0, 1, 2, 3, 4], pages: emptyPages() })),
    copy: await verify(
      makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }),
      { getCurrentIdentityId: () => null },
    ),
    kind: await verify(makeDatasetState({
      cellOrder: IDENTITY_ORDER,
      pages: emptyPages(),
      kind: 'anndata',
    })),
    slot: await verify(makeDatasetState({
      cellOrder: IDENTITY_ORDER,
      pages: emptyPages(),
      layouts: KEYED_LAYOUTS.filter(layout => layout.layoutKey !== 'X_umap_2d'),
      mapping: keyedMapping({
        embeddings: keyedEmbeddings(
          ['X_tsne_2d', 'X_umap_3d'],
          { d2: 'X_tsne_2d', d3: 'X_umap_3d' },
        ),
      }),
    })),
    group: await verify(makeDatasetState({
      cellOrder: IDENTITY_ORDER,
      pages: emptyPages(),
      mapping: keyedMapping({ geneNames: 'column:symbol' }),
    })),
    missingEmbedding: await verify(makeDatasetState({
      cellOrder: IDENTITY_ORDER,
      pages: emptyPages(),
      layouts: KEYED_LAYOUTS.filter(layout => layout.layoutKey !== 'X_tsne_2d'),
    })),
    digest: await verify(makeDatasetState({
      cellOrder: [5, 4, 3, 2, 1, 0],
      pages: emptyPages(),
    })),
    // Choosing None leaves zero cells open: no dataset at all.
    none: await verify(
      { pointCount: 0, varData: { fields: [] } },
      { getCurrentIdentityId: () => null },
    ),
    missingFields: describeMissingRequiredFields(
      makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }),
      { obs: ['cell_type', 'donor'], var: ['Cd8a'] },
    ),
  };
}

test('mismatch messages are written for the person loading the session', async () => {
  const refusals = await verifyRefusals();
  for (const [cause, message] of Object.entries(refusals)) {
    assert.equal(typeof message, 'string', cause);
    assert.doesNotMatch(
      message,
      /fingerprint|digest|hash|manifest|chunk|serializ|null|undefined|[A-Z]{4,}/,
      cause,
    );
    assert.match(message, /\.$/, cause);
  }
  // Each cause has its own sentence.
  assert.equal(new Set(Object.values(refusals)).size, Object.keys(refusals).length);
});

test('with no dataset open there are no counts to compare, only a dataset to name', async () => {
  const { none } = await verifyRefusals();
  assert.match(none, /^No dataset is open\. /);
  assert.doesNotMatch(none, /\b0 cells\b/);
});

test('every refusal tells the person loading the session what to do next', async () => {
  const refusals = await verifyRefusals();
  const withoutNextStep = Object.entries(refusals)
    .filter(([, message]) => !/Open the dataset|Open its dataset|Load the version|Re-create/.test(message))
    .map(([cause, message]) => `${cause}: ${message}`);
  assert.deepEqual(withoutNextStep, []);
});

test('a session saved with a duplicated gene restores on the reloaded dataset', async () => {
  // Duplicating a gene appends a user-defined var field. That field is session
  // content, restored from the session itself, so it is not part of the
  // dataset the fingerprint describes: the reloaded dataset, which has only
  // its source genes, must still be accepted.
  const source = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: selectionPages(SELECTED_ROWS),
  });
  source.varData.fields.push({
    key: 'GENE_A (copy)',
    _isUserDefined: true,
    _userDefinedId: 'user_var_1',
    _fieldSource: 'var',
  });
  const savedFingerprint = await fingerprintOf(source);
  assert.equal(savedFingerprint.varCount, VAR_COUNT);
  const bundle = await sessionOf(source);

  const reloaded = makeDatasetState({
    cellOrder: IDENTITY_ORDER,
    pages: emptyPages(),
  });
  assert.equal(reloaded.varData.fields.length, VAR_COUNT);
  await withNotificationHarness(async () => {
    await makeSerializer(reloaded).restoreFromBlob(bundle);
  });
  assert.deepEqual(restoredSelection(reloaded), [SELECTED_ROWS]);
});

test('the digest of a compact 1D/2D embedding equals the digest of its zero-padded XYZ triples', () => {
  for (const dimension of [1, 2]) {
    const compact = positionsForCellOrder([3, 0, 5, 1, 4, 2], dimension);
    const padded = new Float32Array((compact.length / dimension) * 3);
    for (let cell = 0; cell < compact.length / dimension; cell++) {
      for (let axis = 0; axis < dimension; axis++) {
        padded[cell * 3 + axis] = compact[cell * dimension + axis];
      }
    }
    assert.equal(
      cellOrderDigest(compact, dimension),
      cellOrderDigest(padded, 3),
      `${dimension}D digest must not depend on the in-memory layout`,
    );
  }
  assert.throws(
    () => cellOrderDigest(new Float32Array(5), 2),
    /whole cells/,
  );
});
