/**
 * An in-memory dataset (a synthetic benchmark cloud, an injected array) is
 * published as given, so its layout's normalization is the identity -- and it
 * must say so: figure export, centroids and vectors read every layout's
 * transform through `getNormTransform`, and a missing one made figure export
 * refuse every synthetic cloud ("normalization for view live is incomplete").
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryDimensionManager } from '../assets/js/data/dimension-manager.js';

test('an in-memory layout publishes the identity normalization', () => {
  for (const dimension of [1, 2, 3]) {
    const positions = Float32Array.from({ length: 4 * dimension }, (_, index) => index / 8 - 0.5);
    const manager = createInMemoryDimensionManager({ positions, dimension });
    assert.deepEqual(manager.getNormTransform(`${dimension}d`), { center: [0, 0, 0], scale: 1 });
  }
});
