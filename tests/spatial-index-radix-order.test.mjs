import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  SpatialIndex,
} from '../assets/js/rendering/high-perf-renderer.js';

const FIXED_BOUNDS = Object.freeze({
  minX: -512,
  maxX: 512,
  minY: -512,
  maxY: 512,
  minZ: -512,
  maxZ: 512,
});

/**
 * Independent oracle copied from the retired boxed-object implementation.
 * Keeping this deliberately straightforward protects the exact historical
 * Morton, bit-reversal, and stable-tie semantics while production uses a
 * structurally different typed radix implementation.
 */
function legacyHierarchicalOrder(positions, bounds, dimensionLevel) {
  const pointCount = positions.length / 3;
  const scaleX = 1023 / Math.max(bounds.maxX - bounds.minX, 0.0001);
  const scaleY = 1023 / Math.max(bounds.maxY - bounds.minY, 0.0001);
  const scaleZ = 1023 / Math.max(bounds.maxZ - bounds.minZ, 0.0001);
  const mortonBits = dimensionLevel * 10;
  const ranked = new Array(pointCount);

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    const positionOffset = pointIndex * 3;
    const x =
      Math.floor((positions[positionOffset] - bounds.minX) * scaleX) &
      1023;
    const y =
      Math.floor((positions[positionOffset + 1] - bounds.minY) * scaleY) &
      1023;
    const z =
      Math.floor((positions[positionOffset + 2] - bounds.minZ) * scaleZ) &
      1023;

    let morton = 0;
    if (dimensionLevel === 1) {
      morton = x;
    } else if (dimensionLevel === 2) {
      for (let bit = 0; bit < 10; bit++) {
        morton |= ((x >> bit) & 1) << (bit * 2);
        morton |= ((y >> bit) & 1) << (bit * 2 + 1);
      }
    } else {
      for (let bit = 0; bit < 10; bit++) {
        morton |= ((x >> bit) & 1) << (bit * 3);
        morton |= ((y >> bit) & 1) << (bit * 3 + 1);
        morton |= ((z >> bit) & 1) << (bit * 3 + 2);
      }
    }

    let priority = 0;
    let remaining = morton;
    for (let bit = 0; bit < mortonBits; bit++) {
      priority = (priority << 1) | (remaining & 1);
      remaining >>= 1;
    }
    ranked[pointIndex] = { idx: pointIndex, priority };
  }

  ranked.sort((left, right) => left.priority - right.priority);
  return Uint32Array.from(ranked, entry => entry.idx);
}

function makeOrderOwner(
  positions,
  dimensionLevel,
  bounds = FIXED_BOUNDS,
) {
  return Object.assign(
    Object.create(SpatialIndex.prototype),
    {
      bounds,
      dimensionLevel,
      pointCount: positions.length / 3,
      positions,
    },
  );
}

function buildOrder(positions, dimensionLevel, bounds = FIXED_BOUNDS) {
  return makeOrderOwner(
    positions,
    dimensionLevel,
    bounds,
  )._buildHierarchicalOrder();
}

function createRandomPositions(pointCount, seed) {
  let state = seed >>> 0;
  const nextUint32 = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const positions = new Float32Array(pointCount * 3);
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    const offset = pointIndex * 3;
    if (pointIndex > 0 && pointIndex % 7 === 0) {
      // Exact duplicates and same-cell coordinates exercise stable priority
      // ties, including IDs separated by many input positions.
      const sourceOffset = (pointIndex - 1) * 3;
      positions[offset] = positions[sourceOffset];
      positions[offset + 1] = positions[sourceOffset + 1];
      positions[offset + 2] = positions[sourceOffset + 2];
      continue;
    }
    positions[offset] = (nextUint32() % 2049) * 0.25 - 256;
    positions[offset + 1] = (nextUint32() % 1025) * 0.5 - 256;
    positions[offset + 2] = (nextUint32() % 513) - 256;
  }
  return positions;
}

function median(values) {
  const ordered = values.slice().sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function measureMedian(operation, repetitions) {
  const durations = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    const start = performance.now();
    operation();
    durations.push(performance.now() - start);
  }
  return median(durations);
}

test('typed radix ordering exactly matches legacy Morton priorities across dimensions', () => {
  const edgeDatasets = [
    Float32Array.from([0, 0, 0]),
    new Float32Array(48 * 3).fill(-0),
    Float32Array.from([
      -512, -512, -512,
      512, 512, 512,
      -512, 512, -512,
      512, -512, 512,
      0, 0, 0,
      Number.MIN_VALUE, -Number.MIN_VALUE, 0,
      -511.999, 511.999, -0,
      511.999, -511.999, 0,
    ]),
    Float32Array.from(
      { length: 96 * 3 },
      (_, scalarIndex) => {
        const pointIndex = Math.floor(scalarIndex / 3);
        const axis = scalarIndex % 3;
        // More than one source ID lands in each 10-bit cell.
        return ((pointIndex % 8) - 4) * 0.0001 + axis * 0.00001;
      },
    ),
  ];

  for (const dimensionLevel of [1, 2, 3]) {
    for (const positions of edgeDatasets) {
      assert.deepEqual(
        buildOrder(positions, dimensionLevel),
        legacyHierarchicalOrder(
          positions,
          FIXED_BOUNDS,
          dimensionLevel,
        ),
        `${dimensionLevel}D edge dataset with ${positions.length / 3} points`,
      );
    }

    for (let seed = 1; seed <= 16; seed++) {
      const pointCount = 1 + ((seed * 137) % 1024);
      const positions = createRandomPositions(pointCount, seed);
      assert.deepEqual(
        buildOrder(positions, dimensionLevel),
        legacyHierarchicalOrder(
          positions,
          FIXED_BOUNDS,
          dimensionLevel,
        ),
        `${dimensionLevel}D randomized seed ${seed}`,
      );
    }
  }
});

test('ignored dimensions and equal priorities retain ascending source-ID tie order', () => {
  const positions = Float32Array.from([
    5, 100, 90,
    5, -100, -90,
    5, 50, 80,
    5, -50, -80,
  ]);

  assert.deepEqual(
    buildOrder(positions, 1),
    Uint32Array.from([0, 1, 2, 3]),
  );

  positions[1] = 7;
  positions[4] = 7;
  positions[7] = 7;
  positions[10] = 7;
  assert.deepEqual(
    buildOrder(positions, 2),
    Uint32Array.from([0, 1, 2, 3]),
  );

  positions[2] = 11;
  positions[5] = 11;
  positions[8] = 11;
  positions[11] = 11;
  assert.deepEqual(
    buildOrder(positions, 3),
    Uint32Array.from([0, 1, 2, 3]),
  );
});

test('hierarchical order retains only one exact typed owner and prefix views share it', () => {
  const positions = createRandomPositions(4097, 0xdecafbad);
  const owner = makeOrderOwner(positions, 3);
  const NativeUint32Array = globalThis.Uint32Array;
  const allocations = [];

  class TrackingUint32Array extends NativeUint32Array {
    constructor(...args) {
      super(...args);
      allocations.push(this);
    }
  }

  globalThis.Uint32Array = TrackingUint32Array;
  let order;
  try {
    order = owner._buildHierarchicalOrder();
  } finally {
    globalThis.Uint32Array = NativeUint32Array;
  }

  assert.ok(order instanceof NativeUint32Array);
  assert.equal(order.length, owner.pointCount);
  assert.equal(order.byteOffset, 0);
  assert.equal(
    order.buffer.byteLength,
    owner.pointCount * NativeUint32Array.BYTES_PER_ELEMENT,
  );
  assert.deepEqual(
    allocations.map(allocation => allocation.length).sort(
      (left, right) => left - right,
    ),
    [1024, owner.pointCount, owner.pointCount, owner.pointCount].sort(
      (left, right) => left - right,
    ),
    'one priority array, two ID arrays, and one bounded radix-count array',
  );
  assert.deepEqual(
    Object.entries(owner).filter(([, value]) => (
      allocations.includes(value)
    )),
    [['_hierarchicalOrder', order]],
    'priority, scratch IDs, and radix counts must not escape the build',
  );
  assert.equal(owner._buildHierarchicalOrder(), order);

  const prefix = owner._stratifiedSample(1000);
  assert.equal(prefix.buffer, order.buffer);
  assert.equal(prefix.byteOffset, order.byteOffset);
  assert.equal(prefix.length, 1000);
  assert.deepEqual(prefix, order.subarray(0, 1000));
});

test('allocation failures never publish a partial hierarchy and retry succeeds', () => {
  const positions = createRandomPositions(257, 0x12345678);
  const NativeUint32Array = globalThis.Uint32Array;

  for (let failingAllocation = 1; failingAllocation <= 4; failingAllocation++) {
    const owner = makeOrderOwner(positions, 3);
    let allocationCount = 0;

    class FailingUint32Array extends NativeUint32Array {
      constructor(...args) {
        allocationCount++;
        if (allocationCount === failingAllocation) {
          throw new Error(`synthetic allocation ${failingAllocation} failure`);
        }
        super(...args);
      }
    }

    globalThis.Uint32Array = FailingUint32Array;
    try {
      assert.throws(
        () => owner._buildHierarchicalOrder(),
        new RegExp(`synthetic allocation ${failingAllocation} failure`),
      );
    } finally {
      globalThis.Uint32Array = NativeUint32Array;
    }

    assert.equal(
      Object.hasOwn(owner, '_hierarchicalOrder'),
      false,
      `allocation ${failingAllocation} published partial state`,
    );
    assert.deepEqual(
      owner._buildHierarchicalOrder(),
      legacyHierarchicalOrder(positions, FIXED_BOUNDS, 3),
    );
  }
});

test('production hierarchy uses stable typed radix passes without boxed sorting', async () => {
  const source = await readFile(
    new URL('../assets/js/rendering/high-perf-renderer.js', import.meta.url),
    'utf8',
  );
  const methodStart = source.indexOf('  _buildHierarchicalOrder() {');
  const methodEnd = source.indexOf('\n  _stratifiedSample(', methodStart);
  assert.ok(methodStart >= 0 && methodEnd > methodStart);
  const methodSource = source.slice(methodStart, methodEnd);

  assert.doesNotMatch(methodSource, /new Array\s*\(|\.sort\s*\(|ranked|{\s*idx\s*:/);
  assert.match(methodSource, /new Uint32Array\(n\)/);
  assert.match(methodSource, /RADIX_BITS|RADIX_SIZE|RADIX_MASK/);
  assert.match(methodSource, /priority/);
  assert.match(methodSource, /sourceIds|targetIds/);
});

test('bounded typed-radix benchmark reports paired legacy improvement', t => {
  const pointCount = 100_000;
  const positions = createRandomPositions(pointCount, 0x51ab1e);

  // Warm both JIT paths before the bounded paired samples.
  legacyHierarchicalOrder(
    positions.subarray(0, 10_000 * 3),
    FIXED_BOUNDS,
    3,
  );
  buildOrder(positions.subarray(0, 10_000 * 3), 3);

  const legacyMedianMs = measureMedian(
    () => legacyHierarchicalOrder(
      positions,
      FIXED_BOUNDS,
      3,
    ),
    3,
  );
  const radixMedianMs = measureMedian(
    () => buildOrder(positions, 3),
    5,
  );
  const speedup = legacyMedianMs / radixMedianMs;

  assert.ok(Number.isFinite(legacyMedianMs) && legacyMedianMs > 0);
  assert.ok(Number.isFinite(radixMedianMs) && radixMedianMs > 0);
  // Timing is diagnostic rather than a pass/fail ratio: the structural test
  // above enforces the O(dimensions * n) radix path without making CI depend
  // on host load, JIT tiering, or garbage-collection scheduling.
  t.diagnostic(
    `100k 3D median: legacy ${legacyMedianMs.toFixed(2)} ms, ` +
    `typed radix ${radixMedianMs.toFixed(2)} ms, ` +
    `${speedup.toFixed(2)}x`,
  );
});
