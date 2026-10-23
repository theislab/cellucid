import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  decodeCellSet,
} from '../assets/js/app/session/codecs/cell-set.js';
import {
  encodeUvarints,
} from '../assets/js/app/session/codecs/varint.js';
import {
  restore as restoreUserDefinedCodes,
} from '../assets/js/app/session/contributors/user-defined-codes.js';
import {
  DimensionManager,
} from '../assets/js/data/dimension-manager.js';

/**
 * A real DimensionManager with two 2D layouts, only the first of them
 * resident. Restored codes get centroids for exactly the resident layout,
 * computed from its positions: cell `i` sits at (i, 2i).
 */
function residentDimensionManager(pointCount) {
  const manager = new DimensionManager();
  manager.registerLayouts([
    {
      layoutKey: 'X_umap_2d',
      dimension: 2,
      label: 'UMAP',
      path: 'obsm/0/0-1',
      provenance: null,
      origin: 'identity',
    },
    {
      layoutKey: 'X_tsne_2d',
      dimension: 2,
      label: 'tSNE',
      path: 'obsm/1/0-1',
      provenance: null,
      origin: 'identity',
    },
  ]);
  manager.setRepresentations(['X_umap_2d', 'X_tsne_2d'], new Map([[2, 'X_umap_2d']]));
  manager.publishCellCount(pointCount);
  const positions = new Float32Array(pointCount * 2);
  for (let index = 0; index < pointCount; index++) {
    positions[index * 2] = index;
    positions[index * 2 + 1] = 2 * index;
  }
  manager.normalizedPositionCache.set('X_umap_2d', positions);
  return manager;
}

/** A user-defined codes payload in the runs encoding (1). */
function userCodesPayload({ length, pairs }) {
  const body = encodeUvarints([length, pairs.length, ...pairs.flat()]);
  const payload = new Uint8Array(1 + body.length);
  payload[0] = 1;
  payload.set(body, 1);
  return payload;
}

function userCodesContext(pointCount, signal = null) {
  const template = {
    _userDefinedId: 'field-a',
    _isUserDefined: true,
    kind: 'category',
    key: 'restored_groups',
    codes: null,
    loaded: false,
    _codesLengthHint: pointCount,
    _codesTypeHint: 'Uint8Array',
    // A session record carries no centroids: restoring codes computes them.
    centroidsByLayout: new Map(),
    _normalizedLayouts: new Set(),
    // Restoring codes bounds them against the field's own inventory, so a
    // categorical template without categories is not a state the metadata
    // restore can produce. The width here is what these payloads exercise, so
    // the inventory covers every uint8 code rather than constraining it.
    categories: Array.from({ length: 256 }, (_value, index) => `c${index}`),
  };
  const state = {
    pointCount,
    dimensionManager: residentDimensionManager(pointCount),
    obsData: { fields: [] },
    varData: { fields: [] },
    viewContexts: new Map(),
    getUserDefinedFieldsRegistry() {
      return {
        getField(fieldId) {
          return fieldId === 'field-a' ? template : null;
        },
      };
    },
    getActiveField() {
      return null;
    },
  };
  return {
    context: {
      abortSignal: signal,
      state,
    },
    template,
  };
}

function userCodesMetadata(payload) {
  return {
    id: 'user-defined/codes/field-a',
    contributorId: 'user-defined-codes',
    priority: 'lazy',
    kind: 'binary',
    codec: 'gzip',
    label: 'User-defined codes: restored_groups',
    datasetDependent: true,
    storedBytes: payload.byteLength,
    uncompressedBytes: payload.byteLength,
  };
}

test('a large sorted-delta cell set yields so a scheduled cancellation wins', async () => {
  const count = 256 * 1024;
  const header = encodeUvarints([count]);
  // Encoding 0, the count, a first index of 0, then deltas of 1.
  const payload = new Uint8Array(1 + header.length + count);
  payload[0] = 0;
  payload.set(header, 1);
  payload[1 + header.length] = 0;
  payload.fill(1, 2 + header.length);

  const controller = new AbortController();
  const cancellation = new Error('scheduled highlight cancellation');
  let abortFired = false;
  const timer = setTimeout(() => {
    abortFired = true;
    controller.abort(cancellation);
  }, 0);
  try {
    await assert.rejects(
      decodeCellSet(payload, {
        cellCount: count,
        reference: null,
        signal: controller.signal,
      }),
      error => error === cancellation,
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(abortFired, true);
});

test('a large bitset cell set yields so a scheduled cancellation wins', async () => {
  const cellCount = 8 * 1024 * 1024;
  const payload = new Uint8Array(1 + cellCount / 8).fill(0xff);
  payload[0] = 1;
  const controller = new AbortController();
  const cancellation = new Error('scheduled bitset cancellation');
  const timer = setTimeout(() => controller.abort(cancellation), 0);
  try {
    await assert.rejects(
      decodeCellSet(payload, { cellCount, reference: null, signal: controller.signal }),
      error => error === cancellation,
    );
  } finally {
    clearTimeout(timer);
  }
});

test('one very large code run yields and never publishes partial codes on cancel', async () => {
  const pointCount = 1024 * 1024;
  const payload = userCodesPayload({
    length: pointCount,
    pairs: [[7, pointCount]],
  });
  const controller = new AbortController();
  const cancellation = new Error('scheduled code cancellation');
  const { context, template } = userCodesContext(
    pointCount,
    controller.signal,
  );
  const unrestoredCentroids = template.centroidsByLayout;
  const unrestoredNormalized = template._normalizedLayouts;
  let abortFired = false;
  const timer = setTimeout(() => {
    abortFired = true;
    controller.abort(cancellation);
  }, 0);
  try {
    await assert.rejects(
      restoreUserDefinedCodes(
        context,
        userCodesMetadata(payload),
        payload,
      ),
      error => error === cancellation,
    );
  } finally {
    clearTimeout(timer);
  }

  assert.equal(abortFired, true);
  assert.equal(template.codes, null);
  assert.equal(template.loaded, false);
  assert.equal(template._codesLengthHint, pointCount);
  assert.equal(template._codesTypeHint, 'Uint8Array');
  // Nor centroids of codes it never published.
  assert.strictEqual(template.centroidsByLayout, unrestoredCentroids);
  assert.strictEqual(template._normalizedLayouts, unrestoredNormalized);
  assert.equal(template.centroidsByLayout.size, 0);
  assert.equal(template._normalizedLayouts.size, 0);
});

test('a run-encoded payload with many runs decodes directly into its final typed array', async () => {
  const pointCount = 128 * 1024;
  const pairs = new Array(pointCount);
  for (let index = 0; index < pointCount; index++) {
    pairs[index] = [index & 1, 1];
  }
  const payload = userCodesPayload({ length: pointCount, pairs });
  const { context, template } = userCodesContext(pointCount);

  await restoreUserDefinedCodes(
    context,
    userCodesMetadata(payload),
    payload,
  );

  assert.ok(template.codes instanceof Uint8Array);
  assert.equal(template.codes.length, pointCount);
  assert.deepEqual(
    Array.from(template.codes.subarray(0, 8)),
    [0, 1, 0, 1, 0, 1, 0, 1],
  );
  assert.equal(template.codes.at(-1), 1);

  // The session record carried no centroids; restoring the codes computed
  // them for the one resident layout, in normalized space.
  assert.deepEqual([...template.centroidsByLayout.keys()], ['X_umap_2d']);
  assert.deepEqual([...template._normalizedLayouts], ['X_umap_2d']);
  const centroids = template.centroidsByLayout.get('X_umap_2d');
  assert.equal(centroids.length, template.categories.length);
  const half = pointCount / 2;
  // Even cells hold code 0, odd cells code 1.
  assert.deepEqual(centroids[0], {
    category: 'c0',
    position: [half - 1, 2 * (half - 1)],
    n_points: half,
  });
  assert.deepEqual(centroids[1], {
    category: 'c1',
    position: [half, 2 * half],
    n_points: half,
  });
  assert.deepEqual(centroids[2], { category: 'c2', position: [0, 0], n_points: 0 });

  const source = await readFile(
    new URL(
      '../assets/js/app/session/contributors/user-defined-codes.js',
      import.meta.url,
    ),
    'utf8',
  );
  assert.doesNotMatch(source, /new Array\s*\(\s*pairCount\s*\)/);
  assert.match(source, /codes\.fill\s*\(/);
});
