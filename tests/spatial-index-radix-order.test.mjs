import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  HIERARCHICAL_RADIX_SIZE,
  LOCALITY_BITS_BY_DIMENSION,
  SpatialIndex,
} from '../assets/js/rendering/high-perf/spatial-index.js';

const FIXED_BOUNDS = Object.freeze({
  minX: -512,
  maxX: 512,
  minY: -512,
  maxY: 512,
  minZ: -512,
  maxZ: 512,
});

/** Per-axis quantization bits, mirroring `LOCALITY_BITS_BY_DIMENSION`. */
const REFERENCE_AXIS_BITS = Object.freeze({ 1: 30, 2: 16, 3: 10 });

/**
 * Reverse the low `width` bits of `value`, most significant first.
 *
 * Written as a direct reversal rather than production's incremental
 * bit-reversed counter, so the two implementations cannot share a mistake.
 */
function reverseBits(value, width) {
  let reversed = 0;
  for (let bit = 0; bit < width; bit++) {
    reversed += ((value >>> bit) & 1) * 2 ** (width - bit - 1);
  }
  return reversed;
}

/**
 * Independent oracle for the published hierarchical order.
 *
 * Deliberately straightforward and structurally unlike production: boxed
 * records and `Array.prototype.sort` where production uses a typed LSD radix,
 * plain `2 ** k` arithmetic where production uses interleave masks, and a
 * direct bit reversal where production carries a counter. What it pins is the
 * two-step semantics that make a prefix a seamless subsample:
 *
 *   1. rank by the *plain* interleaved Morton code (ties keep ascending source
 *      order, which `sort` guarantees), so rank is a walk along a space-filling
 *      curve and rank density is point density;
 *   2. publish those ranks in bit-reversed order, so a prefix takes evenly
 *      spaced ranks — the same fraction of points from every neighbourhood the
 *      curve passes through.
 *
 * Reversing the bits of the Morton *code* instead is the defect this replaced:
 * it makes the sort key a bijection of the grid cell, so a prefix is a set of
 * whole cells on an axis-aligned sublattice and renders as blocks with gaps.
 */
function referenceHierarchicalOrder(positions, bounds, dimensionLevel) {
  const pointCount = positions.length / 3;
  const axisBits = REFERENCE_AXIS_BITS[dimensionLevel];
  const axisMaximum = 2 ** axisBits - 1;
  const scaleX = axisMaximum / Math.max(bounds.maxX - bounds.minX, 0.0001);
  const scaleY = axisMaximum / Math.max(bounds.maxY - bounds.minY, 0.0001);
  const scaleZ = axisMaximum / Math.max(bounds.maxZ - bounds.minZ, 0.0001);
  const clamp = binIndex => (
    binIndex < 0 ? 0 : (binIndex > axisMaximum ? axisMaximum : binIndex)
  );
  const ranked = new Array(pointCount);

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    const positionOffset = pointIndex * 3;
    const x = clamp(
      Math.floor((positions[positionOffset] - bounds.minX) * scaleX)
    );
    const y = clamp(
      Math.floor((positions[positionOffset + 1] - bounds.minY) * scaleY)
    );
    const z = clamp(
      Math.floor((positions[positionOffset + 2] - bounds.minZ) * scaleZ)
    );

    // `2 ** k` rather than `<<`: a 2D code fills all 32 bits, and the top bit
    // of a shifted interleave would read as a negative int32.
    let morton = 0;
    for (let bit = 0; bit < axisBits; bit++) {
      morton += ((x >>> bit) & 1) * 2 ** (bit * dimensionLevel);
      if (dimensionLevel >= 2) {
        morton += ((y >>> bit) & 1) * 2 ** (bit * dimensionLevel + 1);
      }
      if (dimensionLevel >= 3) {
        morton += ((z >>> bit) & 1) * 2 ** (bit * dimensionLevel + 2);
      }
    }
    ranked[pointIndex] = { idx: pointIndex, morton };
  }

  ranked.sort((left, right) => left.morton - right.morton);

  const reversalBits = pointCount <= 1
    ? 0
    : Math.ceil(Math.log2(pointCount));
  const reversalSpan = 2 ** reversalBits;
  const order = new Uint32Array(pointCount);
  let emitted = 0;
  for (let step = 0; step < reversalSpan; step++) {
    const rank = reverseBits(step, reversalBits);
    if (rank < pointCount) order[emitted++] = ranked[rank].idx;
  }
  return order;
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

test('typed radix ordering exactly matches the Morton-rank oracle across dimensions', () => {
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
        // More than one source ID lands in each locality cell.
        return ((pointIndex % 8) - 4) * 0.0001 + axis * 0.00001;
      },
    ),
  ];

  for (const dimensionLevel of [1, 2, 3]) {
    for (const positions of edgeDatasets) {
      assert.deepEqual(
        buildOrder(positions, dimensionLevel),
        referenceHierarchicalOrder(
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
        referenceHierarchicalOrder(
          positions,
          FIXED_BOUNDS,
          dimensionLevel,
        ),
        `${dimensionLevel}D randomized seed ${seed}`,
      );
    }
  }
});

test('ignored dimensions and equal codes rank by ascending source ID, then publish bit-reversed', () => {
  // Four points sharing one locality cell in the active dimensions. Ranking is
  // therefore ascending source ID, and the published order is that ranking read
  // in bit-reversed order — ranks 0, 2, 1, 3 for four points. Emitting the tie
  // group unpermuted would mean a prefix admitted or dropped a whole cell
  // together, which is the sublattice behaviour this ordering exists to avoid.
  const BIT_REVERSED_FOUR = Uint32Array.from([0, 2, 1, 3]);

  const positions = Float32Array.from([
    5, 100, 90,
    5, -100, -90,
    5, 50, 80,
    5, -50, -80,
  ]);

  assert.deepEqual(buildOrder(positions, 1), BIT_REVERSED_FOUR);

  positions[1] = 7;
  positions[4] = 7;
  positions[7] = 7;
  positions[10] = 7;
  assert.deepEqual(buildOrder(positions, 2), BIT_REVERSED_FOUR);

  positions[2] = 11;
  positions[5] = 11;
  positions[8] = 11;
  positions[11] = 11;
  assert.deepEqual(buildOrder(positions, 3), BIT_REVERSED_FOUR);
});

test('a prefix of the order subsamples every neighbourhood, not whole cells', () => {
  // The regression this ordering fixes, measured rather than described. A dense
  // core inside a sparse halo is binned onto a grid far coarser than the
  // locality cell; for each bin the retained count is compared against the
  // count a perfectly proportional subsample would retain.
  const POINT_COUNT = 300000;
  const REDUCTION = 44;
  const BINS = 16;
  let state = 0x9e3779b9;
  const nextUnit = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const positions = new Float32Array(POINT_COUNT * 3);
  for (let pointIndex = 0; pointIndex < POINT_COUNT; pointIndex++) {
    // Radius linear in the unit sample, so areal density falls as 1/r and the
    // measured bins span a wide range of true densities.
    const radius = 500 * nextUnit();
    const angle = nextUnit() * Math.PI * 2;
    positions[pointIndex * 3] = Math.cos(angle) * radius;
    positions[pointIndex * 3 + 1] = Math.sin(angle) * radius;
  }

  const order = buildOrder(positions, 2);
  const retained = Math.floor(POINT_COUNT / REDUCTION);
  const binOf = pointIndex => {
    const column = Math.min(BINS - 1, Math.max(0, Math.floor(
      ((positions[pointIndex * 3] + 512) / 1024) * BINS
    )));
    const row = Math.min(BINS - 1, Math.max(0, Math.floor(
      ((positions[pointIndex * 3 + 1] + 512) / 1024) * BINS
    )));
    return row * BINS + column;
  };
  const total = new Float64Array(BINS * BINS);
  const sampled = new Float64Array(BINS * BINS);
  for (let pointIndex = 0; pointIndex < POINT_COUNT; pointIndex++) {
    total[binOf(pointIndex)]++;
  }
  for (let rank = 0; rank < retained; rank++) {
    sampled[binOf(order[rank])]++;
  }

  let measuredBins = 0;
  let emptied = 0;
  let squaredError = 0;
  for (let bin = 0; bin < total.length; bin++) {
    const expected = total[bin] * (retained / POINT_COUNT);
    if (expected < 8) continue;
    measuredBins++;
    if (sampled[bin] === 0) emptied++;
    const relative = (sampled[bin] - expected) / expected;
    squaredError += relative * relative;
  }

  assert.ok(measuredBins > 150, `only ${measuredBins} bins were dense enough`);
  assert.equal(
    emptied,
    0,
    `${emptied} of ${measuredBins} populated bins render nothing at a `
    + `${REDUCTION}x reduction`,
  );
  // The reversed-Morton ordering this replaced measured above 1.0 here, with
  // more than 40% of populated bins rendering nothing at all. An independent
  // uniform-random subsample of the same size measures about 0.19; a stratified
  // walk does better than random, which is why the bound is well under it.
  const relativeError = Math.sqrt(squaredError / measuredBins);
  assert.ok(
    relativeError < 0.12,
    `local density error ${relativeError.toFixed(3)} is not seamless`,
  );
});

test('locality bits stay inside one Uint32 for every dimension level', () => {
  assert.deepEqual(
    Array.from(LOCALITY_BITS_BY_DIMENSION),
    [0, 30, 16, 10],
  );
  for (const dimensionLevel of [1, 2, 3]) {
    assert.equal(
      LOCALITY_BITS_BY_DIMENSION[dimensionLevel],
      REFERENCE_AXIS_BITS[dimensionLevel],
      `${dimensionLevel}D oracle and production must quantize alike`,
    );
    assert.ok(
      LOCALITY_BITS_BY_DIMENSION[dimensionLevel] * dimensionLevel <= 32,
      `${dimensionLevel}D locality code must fit one Uint32`,
    );
  }
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
    [
      HIERARCHICAL_RADIX_SIZE,
      owner.pointCount,
      owner.pointCount,
      owner.pointCount,
    ].sort(
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
      referenceHierarchicalOrder(positions, FIXED_BOUNDS, 3),
    );
  }
});

test('production hierarchy uses stable typed radix passes without boxed sorting', () => {
  // Read the live function rather than the file text: the assertion is about
  // the method that actually runs, so it cannot pass on stale source and does
  // not have to be updated when the method changes file.
  const methodSource =
    SpatialIndex.prototype._buildHierarchicalOrder.toString();

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
  referenceHierarchicalOrder(
    positions.subarray(0, 10_000 * 3),
    FIXED_BOUNDS,
    3,
  );
  buildOrder(positions.subarray(0, 10_000 * 3), 3);

  const legacyMedianMs = measureMedian(
    () => referenceHierarchicalOrder(
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
