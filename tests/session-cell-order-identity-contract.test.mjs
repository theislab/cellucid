import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readBundle,
} from '../assets/js/app/session/bundle/reader.js';
import {
  writeBundle,
} from '../assets/js/app/session/bundle/writer.js';
import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';
import * as highlightsCellsContributor from
  '../assets/js/app/session/contributors/highlights-cells.js';
import * as highlightsMetaContributor from
  '../assets/js/app/session/contributors/highlights-meta.js';
import {
  highlightStateMethods,
} from '../assets/js/app/state/managers/highlight-manager.js';
import {
  SESSION_WITHOUT_CELL_IDENTITY_MESSAGE,
  datasetFingerprintMatches,
  describeDatasetFingerprintMismatch,
  getDatasetFingerprint,
} from '../assets/js/app/session/session-context.js';
import {
  SessionSerializer,
} from '../assets/js/app/session/session-serializer.js';

const CELL_COUNT = 6;
const VAR_COUNT = 4;
const SELECTED_ROWS = [0, 2];

/**
 * One coordinate triple per cell, distinct per cell, so a row permutation is
 * observable in the bytes exactly as it is in a real export.
 *
 * @param {readonly number[]} cellOrder Original cell id at each dataset row.
 * @returns {Float32Array}
 */
function positionsForCellOrder(cellOrder) {
  const positions = new Float32Array(cellOrder.length * 3);
  for (let row = 0; row < cellOrder.length; row++) {
    const cellId = cellOrder[row];
    positions[row * 3] = (cellId + 1) * 0.125;
    positions[row * 3 + 1] = (cellId + 1) * 0.25;
    positions[row * 3 + 2] = (cellId + 1) * 0.5;
  }
  return positions;
}

function makeDatasetState({
  cellOrder,
  pages,
  activePageId = 'page_1',
  dimension = 3,
}) {
  const state = Object.create(highlightStateMethods);
  state.getDatasetGeneration = () => 0;
  state.obsData = { fields: [] };
  state.pointCount = cellOrder.length;
  state.positionsArray = positionsForCellOrder(cellOrder);
  state.varData = { fields: Array.from({ length: VAR_COUNT }, () => ({})) };
  state.getViewDimensionLevel = viewId => {
    assert.equal(viewId, 'live');
    return dimension;
  };
  state.highlightPages = pages;
  state.activePageId = activePageId;
  state._highlightPageIdCounter = 1;
  state._highlightIdCounter = pages.flatMap(
    page => page.highlightedGroups,
  ).length;
  state._recomputeHighlightArray = () => {};
  state._notifyHighlightPageChange = () => {};
  state._notifyHighlightChange = () => {};
  // The cell ids the dataset rows actually carry, used only by assertions.
  state.cellOrder = [...cellOrder];
  return state;
}

function makeDataSourceManager() {
  return {
    getCurrentSourceType: () => 'local-demo',
    getCurrentDatasetId: () => 'pancreas',
  };
}

function makeSerializer(state) {
  return new SessionSerializer({
    state,
    viewer: {},
    sidebar: {},
    dataSourceManager: makeDataSourceManager(),
    comparisonModule: null,
    analysisWindowManager: null,
    cinematicCamera: null,
    contributors: [
      highlightsMetaContributor,
      highlightsCellsContributor,
    ],
  });
}

function selectionPages(cellIndices) {
  return [{
    id: 'page_1',
    name: 'Lasso work',
    color: '#112233',
    highlightedGroups: [{
      id: 'highlight_1',
      type: 'lasso',
      label: 'CD8 T cells',
      enabled: true,
      cellIndices: [...cellIndices],
      cellCount: cellIndices.length,
    }],
  }];
}

function emptyPages() {
  return [{
    id: 'page_1',
    name: 'Untouched',
    color: '#445566',
    highlightedGroups: [],
  }];
}

async function withNotificationHarness(run) {
  const notifications = getNotificationCenter();
  const names = [
    'completeDownload',
    'dismissDownload',
    'error',
    'failDownload',
    'info',
    'startDownload',
    'success',
    'updateDownload',
    'warning',
  ];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  for (const name of names) notifications[name] = () => {};
  notifications.startDownload = () => 'session-cell-order-test';
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => {
    queueMicrotask(() => callback(0));
    return 1;
  };
  try {
    return await run();
  } finally {
    for (const [name, original] of originals) notifications[name] = original;
    if (previousAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = previousAnimationFrame;
    }
  }
}

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

async function captureSelectionBundle() {
  const source = makeDatasetState({
    cellOrder: [0, 1, 2, 3, 4, 5],
    pages: selectionPages(SELECTED_ROWS),
  });
  return {
    bundle: await makeSerializer(source).createSessionBundle(),
    source,
  };
}

function restoredSelection(state) {
  return state.highlightPages.flatMap(page => (
    page.highlightedGroups.map(group => [...group.cellIndices])
  ));
}

test(
  're-exported dataset with permuted rows cannot silently restore a selection',
  async () => {
    const { bundle, source } = await captureSelectionBundle();
    // What the user actually selected, by cell, not by row.
    const selectedCells = SELECTED_ROWS.map(row => source.cellOrder[row]);
    assert.deepEqual(selectedCells, [0, 2]);

    // Same dataset id, same cell count, same gene count, re-exported from
    // re-sorted input: only the row order changed.
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
    await withNotificationHarness(async () => {
      await assert.rejects(
        makeSerializer(destination).restoreFromBlob(bundle),
        error => {
          assert.ok(error instanceof RangeError);
          assert.match(error.message, /coordinates differ/);
          assert.match(error.message, /different order/);
          // Row order is one of the two things a coordinate difference can
          // mean, so it is offered, never asserted.
          assert.match(error.message, /Either the cells are stored/);
          return true;
        },
      );
    });
    assert.strictEqual(destination.highlightPages, untouchedPages);
    assert.deepEqual(restoredSelection(destination), []);
  },
);

test('an unchanged dataset restores the exact selected set', async () => {
  const { bundle } = await captureSelectionBundle();
  const destination = makeDatasetState({
    cellOrder: [0, 1, 2, 3, 4, 5],
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
});

test('a session written without cell identity is refused, not trusted', async () => {
  const { bundle } = await captureSelectionBundle();
  const legacy = await rewriteSessionBundle(bundle, manifest => {
    // Exactly the fingerprint every already-published session file carries.
    delete manifest.datasetFingerprint.cellOrder;
  });
  const destination = makeDatasetState({
    cellOrder: [5, 4, 3, 2, 1, 0],
    pages: emptyPages(),
  });

  await withNotificationHarness(async () => {
    await assert.rejects(
      makeSerializer(destination).restoreFromBlob(legacy),
      error => {
        assert.equal(error.message, SESSION_WITHOUT_CELL_IDENTITY_MESSAGE);
        return true;
      },
    );
  });
  assert.deepEqual(restoredSelection(destination), []);
});

test(
  'a different embedding on screen is reported as such, not as re-ordered data',
  async () => {
    const { bundle } = await captureSelectionBundle();
    const destination = makeDatasetState({
      cellOrder: [0, 1, 2, 3, 4, 5],
      pages: emptyPages(),
      dimension: 2,
    });
    // The 2D embedding is a separate normalized export, so its coordinates
    // differ from the 3D ones even for an identical cell order.
    destination.positionsArray = destination.positionsArray.map(
      value => value * 0.5,
    );

    await withNotificationHarness(async () => {
      await assert.rejects(
        makeSerializer(destination).restoreFromBlob(bundle),
        error => {
          assert.match(error.message, /3D view was shown/);
          assert.match(error.message, /2D view is shown now/);
          assert.doesNotMatch(error.message, /different order|wrong cells/);
          return true;
        },
      );
    });
    assert.deepEqual(restoredSelection(destination), []);
  },
);

test(
  'a re-computed embedding at the same dimension is not called a re-ordering',
  async () => {
    const { bundle } = await captureSelectionBundle();
    // Same cells in the same rows: only the embedding was computed again, so
    // the coordinates moved and the digest changed. Nothing here re-ordered
    // any row, and the refusal must not say that it did.
    const destination = makeDatasetState({
      cellOrder: [0, 1, 2, 3, 4, 5],
      pages: emptyPages(),
    });
    destination.positionsArray = destination.positionsArray.map(
      value => value + 0.0009765625,
    );

    await withNotificationHarness(async () => {
      await assert.rejects(
        makeSerializer(destination).restoreFromBlob(bundle),
        error => {
          assert.ok(error instanceof RangeError);
          // The one thing the digest establishes.
          assert.match(error.message, /coordinates differ/);
          // Both causes it cannot separate, offered as alternatives.
          assert.match(error.message, /Either the cells are stored in a different order/);
          assert.match(error.message, /re-computed embedding/);
          // Never the old claim that a re-ordering is what happened.
          assert.doesNotMatch(error.message, /would mark the wrong cells/);
          assert.doesNotMatch(
            error.message,
            /but its cells are stored in a different order/,
          );
          return true;
        },
      );
    });
    assert.deepEqual(restoredSelection(destination), []);
  },
);

test('dataset fingerprints carry a cell-order digest over every cell', () => {
  const state = makeDatasetState({
    cellOrder: [0, 1, 2, 3, 4, 5],
    pages: emptyPages(),
  });
  const fingerprint = getDatasetFingerprint({
    dataSourceManager: makeDataSourceManager(),
    state,
  });
  assert.deepEqual(Object.keys(fingerprint).sort(), [
    'cellCount',
    'cellOrder',
    'datasetId',
    'sourceType',
    'varCount',
  ]);
  assert.equal(fingerprint.cellCount, CELL_COUNT);
  assert.equal(fingerprint.varCount, VAR_COUNT);
  assert.equal(fingerprint.cellOrder.dimension, 3);
  assert.match(fingerprint.cellOrder.digest, /^[0-9a-f]{16}$/);
  assert.equal(Object.isFrozen(fingerprint.cellOrder), true);

  // Swapping the two last cells is enough to change the digest: the check is
  // not a sample.
  const swapped = makeDatasetState({
    cellOrder: [0, 1, 2, 3, 5, 4],
    pages: emptyPages(),
  });
  const swappedFingerprint = getDatasetFingerprint({
    dataSourceManager: makeDataSourceManager(),
    state: swapped,
  });
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
      getDatasetFingerprint({
        dataSourceManager: makeDataSourceManager(),
        state: makeDatasetState({
          cellOrder: [0, 1, 2, 3, 4, 5],
          pages: emptyPages(),
        }),
      }),
    ),
    true,
  );
});

test('cell-order digests are stable and dataset-wide', () => {
  const cellOrder = Array.from({ length: 4096 }, (_value, index) => index);
  const first = getDatasetFingerprint({
    dataSourceManager: makeDataSourceManager(),
    state: makeDatasetState({ cellOrder, pages: emptyPages() }),
  });
  const second = getDatasetFingerprint({
    dataSourceManager: makeDataSourceManager(),
    state: makeDatasetState({ cellOrder, pages: emptyPages() }),
  });
  assert.equal(second.cellOrder.digest, first.cellOrder.digest);

  for (const row of [0, 1, 2047, 4094, 4095]) {
    const moved = [...cellOrder];
    const other = row === 0 ? 1 : row - 1;
    [moved[row], moved[other]] = [moved[other], moved[row]];
    const mutated = getDatasetFingerprint({
      dataSourceManager: makeDataSourceManager(),
      state: makeDatasetState({ cellOrder: moved, pages: emptyPages() }),
    });
    assert.notEqual(
      mutated.cellOrder.digest,
      first.cellOrder.digest,
      `swapping rows ${row} and ${other} must change the digest`,
    );
  }
});

test('mismatch messages are written for the person loading the session', () => {
  const base = getDatasetFingerprint({
    dataSourceManager: makeDataSourceManager(),
    state: makeDatasetState({
      cellOrder: [0, 1, 2, 3, 4, 5],
      pages: emptyPages(),
    }),
  });
  assert.equal(describeDatasetFingerprintMismatch(base, { ...base }), null);

  const messages = [
    describeDatasetFingerprintMismatch(base, { ...base, cellCount: 5 }),
    describeDatasetFingerprintMismatch(base, {
      ...base,
      cellOrder: { dimension: 2, digest: base.cellOrder.digest },
    }),
    describeDatasetFingerprintMismatch(base, {
      ...base,
      cellOrder: { dimension: 3, digest: '0123456789abcdef' },
    }),
    SESSION_WITHOUT_CELL_IDENTITY_MESSAGE,
  ];
  for (const message of messages) {
    assert.equal(typeof message, 'string');
    assert.doesNotMatch(
      message,
      /fingerprint|digest|hash|manifest|chunk|serializ|null|undefined|[A-Z]{4,}/,
    );
    assert.match(message, /\.$/);
    // Every refusal has to tell the user what to do next.
    assert.match(message, /Open the dataset|Switch back|Load the version|Re-create/);
  }
});
