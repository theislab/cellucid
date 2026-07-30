import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONNECTIVITY_EDGE_PREFIX_STRIDE,
  buildAllVisibleConnectivityEdgePrefixOwner,
  buildConnectivityEdgePrefixOwner,
  resolveConnectivityEdgeRawPrefix,
  retireConnectivityEdgePrefixOwner,
} from '../assets/js/rendering/connectivity-edge-prefix.js';

function createIndependentEdges(edgeCount, visibleEdgeIndices) {
  const sources = new Uint32Array(edgeCount);
  const destinations = new Uint32Array(edgeCount);
  const visibilityBytes = new Uint8Array(edgeCount * 2);
  for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex++) {
    sources[edgeIndex] = edgeIndex * 2;
    destinations[edgeIndex] = edgeIndex * 2 + 1;
  }
  for (const edgeIndex of visibleEdgeIndices) {
    visibilityBytes[edgeIndex * 2] = 255;
    visibilityBytes[edgeIndex * 2 + 1] = 255;
  }
  return { destinations, sources, visibilityBytes };
}

test('sparse connectivity prefixes retain one Uint32 count per 4096 edges', () => {
  assert.equal(CONNECTIVITY_EDGE_PREFIX_STRIDE, 4096);
  const edgeCount = 100_000_000;
  const checkpointLength =
    Math.ceil(edgeCount / CONNECTIVITY_EDGE_PREFIX_STRIDE) + 1;
  assert.equal(checkpointLength, 24_416);
  assert.equal(
    checkpointLength * Uint32Array.BYTES_PER_ELEMENT,
    97_664
  );
  assert.ok(
    checkpointLength * Uint32Array.BYTES_PER_ELEMENT <
      edgeCount / 1000,
    'retained checkpoint bytes must remain O(E / 4096)'
  );
});

test('all-visible setup owners fill exact checkpoints without an E scan', () => {
  const edgeCount = CONNECTIVITY_EDGE_PREFIX_STRIDE * 2 + 5;
  const { owner, reusableCheckpoints } =
    buildAllVisibleConnectivityEdgePrefixOwner(edgeCount);

  assert.equal(reusableCheckpoints, null);
  assert.equal(Object.isFrozen(owner), true);
  assert.deepEqual(
    Object.keys(owner),
    ['checkpoints', 'edgeCount', 'visibleCount']
  );
  assert.equal(owner.edgeCount, edgeCount);
  assert.equal(owner.visibleCount, edgeCount);
  assert.deepEqual(
    Array.from(owner.checkpoints),
    [0, 4096, 8192, edgeCount]
  );

  const retired = retireConnectivityEdgePrefixOwner(owner);
  const reused = buildAllVisibleConnectivityEdgePrefixOwner(
    edgeCount,
    retired
  );
  assert.equal(reused.owner.checkpoints, retired);
  assert.equal(reused.reusableCheckpoints, null);

  const wrongSize = new Uint32Array(1);
  const zero = buildAllVisibleConnectivityEdgePrefixOwner(
    0,
    wrongSize
  );
  assert.deepEqual(Array.from(zero.owner.checkpoints), [0]);
  assert.equal(zero.owner.visibleCount, 0);
  assert.equal(zero.reusableCheckpoints, null);
  assert.equal(zero.owner.checkpoints, wrongSize);
});

test('all-visible setup owners reject inexact or unsupported edge counts', () => {
  for (const edgeCount of [
    -1,
    1.5,
    Number.NaN,
    100_000_001,
    '1',
  ]) {
    assert.throws(
      () => buildAllVisibleConnectivityEdgePrefixOwner(edgeCount),
      /edge count/i
    );
  }
});

test('zero, plateau, tail, and minimal full-visible lookup stay exact', () => {
  const edgeCount = CONNECTIVITY_EDGE_PREFIX_STRIDE * 2 + 13;
  const fixture = createIndependentEdges(
    edgeCount,
    [5, 8194, 8204]
  );
  const { owner, reusableCheckpoints } =
    buildConnectivityEdgePrefixOwner(
      fixture.sources,
      fixture.destinations,
      fixture.visibilityBytes
    );

  assert.equal(reusableCheckpoints, null);
  assert.equal(Object.isFrozen(owner), true);
  assert.deepEqual(
    Object.keys(owner),
    ['checkpoints', 'edgeCount', 'visibleCount']
  );
  assert.equal(owner.edgeCount, edgeCount);
  assert.equal(owner.visibleCount, 3);
  assert.deepEqual(Array.from(owner.checkpoints), [0, 1, 1, 3]);

  assert.equal(
    resolveConnectivityEdgeRawPrefix(
      owner,
      fixture.sources,
      fixture.destinations,
      fixture.visibilityBytes,
      0
    ),
    0
  );
  assert.equal(
    resolveConnectivityEdgeRawPrefix(
      owner,
      fixture.sources,
      fixture.destinations,
      fixture.visibilityBytes,
      1
    ),
    6
  );
  assert.equal(
    resolveConnectivityEdgeRawPrefix(
      owner,
      fixture.sources,
      fixture.destinations,
      fixture.visibilityBytes,
      2
    ),
    8195,
    'binary search must cross a complete zero-count checkpoint plateau'
  );
  assert.equal(
    resolveConnectivityEdgeRawPrefix(
      owner,
      fixture.sources,
      fixture.destinations,
      fixture.visibilityBytes,
      3
    ),
    8205,
    'admitting every visible edge must omit the hidden raw tail'
  );
});

test('zero visible edges resolve to zero rather than the full raw graph', () => {
  const fixture = createIndependentEdges(5000, []);
  const { owner } = buildConnectivityEdgePrefixOwner(
    fixture.sources,
    fixture.destinations,
    fixture.visibilityBytes
  );
  assert.equal(owner.visibleCount, 0);
  assert.deepEqual(Array.from(owner.checkpoints), [0, 0, 0]);
  for (const target of [0, 1, 4999, 5000]) {
    assert.equal(
      resolveConnectivityEdgeRawPrefix(
        owner,
        fixture.sources,
        fixture.destinations,
        fixture.visibilityBytes,
        target
      ),
      0
    );
  }
});

test('a positive full-visible target stops at the last visible edge', () => {
  const fixture = createIndependentEdges(5000, [3, 9]);
  const { owner } = buildConnectivityEdgePrefixOwner(
    fixture.sources,
    fixture.destinations,
    fixture.visibilityBytes
  );
  assert.equal(
    resolveConnectivityEdgeRawPrefix(
      owner,
      fixture.sources,
      fixture.destinations,
      fixture.visibilityBytes,
      2
    ),
    10
  );
});

test('empty topology retains one zero checkpoint and resolves zero', () => {
  const sources = new Uint32Array(0);
  const destinations = new Uint32Array(0);
  const visibilityBytes = Uint8Array.of(255);
  const { owner } = buildConnectivityEdgePrefixOwner(
    sources,
    destinations,
    visibilityBytes
  );
  assert.equal(owner.edgeCount, 0);
  assert.equal(owner.visibleCount, 0);
  assert.deepEqual(Array.from(owner.checkpoints), [0]);
  assert.equal(
    resolveConnectivityEdgeRawPrefix(
      owner,
      sources,
      destinations,
      visibilityBytes,
      0
    ),
    0
  );
});

test('accepted checkpoints require retirement before exact staging reuse', () => {
  const first = createIndependentEdges(5000, [2, 4098]);
  const firstResult = buildConnectivityEdgePrefixOwner(
    first.sources,
    first.destinations,
    first.visibilityBytes
  );
  assert.throws(
    () => buildConnectivityEdgePrefixOwner(
      first.sources,
      first.destinations,
      first.visibilityBytes,
      firstResult.owner.checkpoints
    ),
    /must be retired before reuse/i
  );

  const staging = retireConnectivityEdgePrefixOwner(firstResult.owner);
  assert.equal(staging, firstResult.owner.checkpoints);
  assert.throws(
    () => resolveConnectivityEdgeRawPrefix(
      firstResult.owner,
      first.sources,
      first.destinations,
      first.visibilityBytes,
      1
    ),
    /exact certified|exact frozen owner/i
  );

  const second = createIndependentEdges(5000, [10]);
  const secondResult = buildConnectivityEdgePrefixOwner(
    second.sources,
    second.destinations,
    second.visibilityBytes,
    staging
  );
  assert.equal(secondResult.owner.checkpoints, staging);
  assert.equal(secondResult.reusableCheckpoints, null);
  assert.equal(secondResult.owner.visibleCount, 1);

  const incompatibleStaging = new Uint32Array(1);
  const third = createIndependentEdges(20, [0]);
  const thirdResult = buildConnectivityEdgePrefixOwner(
    third.sources,
    third.destinations,
    third.visibilityBytes,
    incompatibleStaging
  );
  assert.notEqual(thirdResult.owner.checkpoints, incompatibleStaging);
  assert.equal(thirdResult.reusableCheckpoints, incompatibleStaging);
});

test('failed candidate construction never changes an accepted owner', () => {
  const accepted = createIndependentEdges(5000, [4, 4099]);
  const acceptedResult = buildConnectivityEdgePrefixOwner(
    accepted.sources,
    accepted.destinations,
    accepted.visibilityBytes
  );
  const acceptedSnapshot = Array.from(
    acceptedResult.owner.checkpoints
  );

  const staging = new Uint32Array(
    acceptedResult.owner.checkpoints.length
  );
  const malformed = createIndependentEdges(5000, [1]);
  malformed.destinations[4500] = malformed.sources[4500];
  assert.throws(
    () => buildConnectivityEdgePrefixOwner(
      malformed.sources,
      malformed.destinations,
      malformed.visibilityBytes,
      staging
    ),
    /source < destination/i
  );
  assert.deepEqual(
    Array.from(acceptedResult.owner.checkpoints),
    acceptedSnapshot
  );
  assert.equal(
    resolveConnectivityEdgeRawPrefix(
      acceptedResult.owner,
      accepted.sources,
      accepted.destinations,
      accepted.visibilityBytes,
      1
    ),
    5
  );

  malformed.destinations[4500] = malformed.sources[4500] + 1;
  const recovered = buildConnectivityEdgePrefixOwner(
    malformed.sources,
    malformed.destinations,
    malformed.visibilityBytes,
    staging
  );
  assert.equal(recovered.owner.checkpoints, staging);
});

test('builders reject malformed endpoints and non-binary accepted R8 bytes', () => {
  const valid = createIndependentEdges(2, [0]);
  assert.throws(
    () => buildConnectivityEdgePrefixOwner(
      new Uint16Array(valid.sources),
      valid.destinations,
      valid.visibilityBytes
    ),
    /exact Uint32Array/i
  );
  assert.throws(
    () => buildConnectivityEdgePrefixOwner(
      valid.sources,
      valid.destinations.subarray(0, 1),
      valid.visibilityBytes
    ),
    /same number of edges/i
  );

  const nonBinary = valid.visibilityBytes.slice();
  nonBinary[2] = 1;
  assert.throws(
    () => buildConnectivityEdgePrefixOwner(
      valid.sources,
      valid.destinations,
      nonBinary
    ),
    /must be 0 or 255/i
  );

  const outside = createIndependentEdges(2, [0]);
  outside.destinations[1] = outside.visibilityBytes.length;
  assert.throws(
    () => buildConnectivityEdgePrefixOwner(
      outside.sources,
      outside.destinations,
      outside.visibilityBytes
    ),
    /outside the accepted R8 cell axis/i
  );
});

test('resolver rejects fabricated owners, changed identities, and bad targets', () => {
  const fixture = createIndependentEdges(4, [0, 2]);
  const { owner } = buildConnectivityEdgePrefixOwner(
    fixture.sources,
    fixture.destinations,
    fixture.visibilityBytes
  );
  const fabricated = Object.freeze({
    checkpoints: owner.checkpoints,
    edgeCount: owner.edgeCount,
    visibleCount: owner.visibleCount,
  });
  assert.throws(
    () => resolveConnectivityEdgeRawPrefix(
      fabricated,
      fixture.sources,
      fixture.destinations,
      fixture.visibilityBytes,
      1
    ),
    /exact certified/i
  );
  assert.throws(
    () => resolveConnectivityEdgeRawPrefix(
      owner,
      fixture.sources.slice(),
      fixture.destinations,
      fixture.visibilityBytes,
      1
    ),
    /exact certified/i
  );
  for (const target of [-1, 1.5, 5]) {
    assert.throws(
      () => resolveConnectivityEdgeRawPrefix(
        owner,
        fixture.sources,
        fixture.destinations,
        fixture.visibilityBytes,
        target
      ),
      /visible-edge target/i
    );
  }
});
