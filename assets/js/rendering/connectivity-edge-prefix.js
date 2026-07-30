/**
 * Exact sparse connectivity-edge prefix ownership.
 *
 * Connectivity edges are shuffled once, then rendered as one raw instance
 * prefix. Per-view R8 visibility means the raw prefix required to admit K
 * visible edges differs by view. Retaining every cumulative edge count would
 * cost four bytes per edge, so accepted owners retain one count per 4096 raw
 * edges and refine a lookup by scanning at most one block.
 */

export const CONNECTIVITY_EDGE_PREFIX_STRIDE = 4096;

const MAX_CONNECTIVITY_EDGE_COUNT = 100_000_000;
const certifiedOwners = new WeakMap();
const acceptedCheckpointOwners = new WeakSet();
const OWNER_KEYS = 'checkpoints,edgeCount,visibleCount';

function requireExactUint32Array(value, label) {
  if (
    !(value instanceof Uint32Array) ||
    Object.getPrototypeOf(value) !== Uint32Array.prototype
  ) {
    throw new TypeError(`${label} must be one exact Uint32Array owner.`);
  }
  return value;
}

function requireExactUint8Array(value, label) {
  if (
    !(value instanceof Uint8Array) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  ) {
    throw new TypeError(`${label} must be one exact Uint8Array owner.`);
  }
  return value;
}

function requireEdgeInputs(sources, destinations, visibilityBytes) {
  const exactSources = requireExactUint32Array(
    sources,
    'Connectivity edge sources'
  );
  const exactDestinations = requireExactUint32Array(
    destinations,
    'Connectivity edge destinations'
  );
  const exactVisibility = requireExactUint8Array(
    visibilityBytes,
    'Connectivity accepted R8 visibility'
  );
  if (exactSources.length !== exactDestinations.length) {
    throw new RangeError(
      'Connectivity endpoint owners must contain the same number of edges.'
    );
  }
  if (exactSources.length > MAX_CONNECTIVITY_EDGE_COUNT) {
    throw new RangeError(
      `Connectivity sparse prefixes support at most ` +
      `${MAX_CONNECTIVITY_EDGE_COUNT.toLocaleString('en-US')} edges.`
    );
  }
  if (exactVisibility.length === 0) {
    throw new RangeError(
      'Connectivity accepted R8 visibility must contain at least one cell.'
    );
  }
  return {
    destinations: exactDestinations,
    edgeCount: exactSources.length,
    sources: exactSources,
    visibilityBytes: exactVisibility,
  };
}

function checkpointLengthForEdgeCount(edgeCount) {
  return Math.ceil(
    edgeCount / CONNECTIVITY_EDGE_PREFIX_STRIDE
  ) + 1;
}

function requireExactEdgeCount(edgeCount) {
  if (
    !Number.isSafeInteger(edgeCount) ||
    edgeCount < 0 ||
    edgeCount > MAX_CONNECTIVITY_EDGE_COUNT
  ) {
    throw new RangeError(
      `Connectivity edge count must be a non-negative safe integer no larger than ` +
      `${MAX_CONNECTIVITY_EDGE_COUNT.toLocaleString('en-US')}.`
    );
  }
  return edgeCount;
}

function acquireCheckpointCandidate(reusableCheckpoints, requiredLength) {
  if (reusableCheckpoints === null) {
    return {
      checkpoints: new Uint32Array(requiredLength),
      reusableCheckpoints: null,
    };
  }
  const reusable = requireExactUint32Array(
    reusableCheckpoints,
    'Connectivity reusable checkpoints'
  );
  if (acceptedCheckpointOwners.has(reusable)) {
    throw new Error(
      'Accepted connectivity checkpoints must be retired before reuse.'
    );
  }
  if (reusable.length !== requiredLength) {
    return {
      checkpoints: new Uint32Array(requiredLength),
      reusableCheckpoints: reusable,
    };
  }
  return {
    checkpoints: reusable,
    reusableCheckpoints: null,
  };
}

function requireCertifiedOwner(
  owner,
  sources,
  destinations,
  visibilityBytes
) {
  if (
    owner === null ||
    typeof owner !== 'object' ||
    Array.isArray(owner) ||
    Object.getPrototypeOf(owner) !== Object.prototype ||
    !Object.isFrozen(owner) ||
    Object.keys(owner).join(',') !== OWNER_KEYS
  ) {
    throw new TypeError(
      'Connectivity edge-prefix lookup requires one exact frozen owner.'
    );
  }
  const certificate = certifiedOwners.get(owner);
  if (
    certificate === undefined ||
    certificate.kind !== 'accepted-r8' ||
    certificate.sources !== sources ||
    certificate.destinations !== destinations ||
    certificate.visibilityBytes !== visibilityBytes
  ) {
    throw new Error(
      'Connectivity edge-prefix lookup requires its exact certified endpoint and R8 owners.'
    );
  }
  if (
    !(owner.checkpoints instanceof Uint32Array) ||
    Object.getPrototypeOf(owner.checkpoints) !== Uint32Array.prototype ||
    owner.checkpoints !== certificate.checkpoints ||
    owner.edgeCount !== sources.length ||
    !Number.isSafeInteger(owner.visibleCount) ||
    owner.visibleCount < 0 ||
    owner.visibleCount > owner.edgeCount ||
    owner.checkpoints.length !==
      checkpointLengthForEdgeCount(owner.edgeCount) ||
    owner.checkpoints[0] !== 0 ||
    owner.checkpoints[owner.checkpoints.length - 1] !==
      owner.visibleCount
  ) {
    throw new Error(
      'Connectivity edge-prefix owner no longer matches its accepted certificate.'
    );
  }
  return certificate;
}

function publishCheckpointOwner(
  checkpoints,
  edgeCount,
  visibleCount,
  certificate,
  reusableCheckpoints
) {
  const owner = Object.freeze({
    checkpoints,
    edgeCount,
    visibleCount,
  });
  certifiedOwners.set(owner, Object.freeze({
    ...certificate,
    checkpoints,
  }));
  acceptedCheckpointOwners.add(checkpoints);
  return Object.freeze({
    owner,
    reusableCheckpoints,
  });
}

/**
 * Build a setup-only all-visible owner in O(E / 4096) time.
 *
 * The caller must validate topology while copying its endpoints. This builder
 * accepts only the resulting exact edge count, so it does not add another
 * O(E) endpoint or visibility traversal. The owner represents an explicit
 * full draw until an accepted R8 generation replaces it; because it has no
 * endpoint/R8 identities, it cannot be passed to
 * `resolveConnectivityEdgeRawPrefix()`.
 *
 * @param {number} edgeCount
 * @param {Uint32Array|null} [reusableCheckpoints=null]
 * @returns {{
 *   owner: Readonly<{
 *     checkpoints: Uint32Array,
 *     edgeCount: number,
 *     visibleCount: number
 *   }>,
 *   reusableCheckpoints: Uint32Array|null
 * }}
 */
export function buildAllVisibleConnectivityEdgePrefixOwner(
  edgeCount,
  reusableCheckpoints = null
) {
  const exactEdgeCount = requireExactEdgeCount(edgeCount);
  const checkpointLength = checkpointLengthForEdgeCount(
    exactEdgeCount
  );
  const candidate = acquireCheckpointCandidate(
    reusableCheckpoints,
    checkpointLength
  );
  const checkpoints = candidate.checkpoints;
  checkpoints[0] = 0;
  for (
    let checkpointIndex = 1;
    checkpointIndex < checkpointLength;
    checkpointIndex++
  ) {
    checkpoints[checkpointIndex] = Math.min(
      checkpointIndex * CONNECTIVITY_EDGE_PREFIX_STRIDE,
      exactEdgeCount
    );
  }
  return publishCheckpointOwner(
    checkpoints,
    exactEdgeCount,
    exactEdgeCount,
    { kind: 'all-visible' },
    candidate.reusableCheckpoints
  );
}

/**
 * Build one unpublished sparse prefix candidate from exact endpoint owners and
 * one accepted per-cell R8 visibility generation.
 *
 * A reusable checkpoint array is consumed only when its exact length matches.
 * An incompatible array is returned untouched for another generation. Once
 * accepted, `owner.checkpoints` must not be mutated or reused until the owner
 * is explicitly retired with `retireConnectivityEdgePrefixOwner()`.
 *
 * @param {Uint32Array} sources
 * @param {Uint32Array} destinations
 * @param {Uint8Array} visibilityBytes
 * @param {Uint32Array|null} [reusableCheckpoints=null]
 * @returns {{
 *   owner: Readonly<{
 *     checkpoints: Uint32Array,
 *     edgeCount: number,
 *     visibleCount: number
 *   }>,
 *   reusableCheckpoints: Uint32Array|null
 * }}
 */
export function buildConnectivityEdgePrefixOwner(
  sources,
  destinations,
  visibilityBytes,
  reusableCheckpoints = null
) {
  const exact = requireEdgeInputs(
    sources,
    destinations,
    visibilityBytes
  );

  const checkpointLength = checkpointLengthForEdgeCount(
    exact.edgeCount
  );
  const candidate = acquireCheckpointCandidate(
    reusableCheckpoints,
    checkpointLength
  );
  const checkpoints = candidate.checkpoints;
  checkpoints[0] = 0;

  let visibleCount = 0;
  const blockCount = checkpointLength - 1;
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    const blockStart =
      blockIndex * CONNECTIVITY_EDGE_PREFIX_STRIDE;
    const blockEnd = Math.min(
      blockStart + CONNECTIVITY_EDGE_PREFIX_STRIDE,
      exact.edgeCount
    );
    for (let edgeIndex = blockStart; edgeIndex < blockEnd; edgeIndex++) {
      const source = exact.sources[edgeIndex];
      const destination = exact.destinations[edgeIndex];
      if (
        source >= exact.visibilityBytes.length ||
        destination >= exact.visibilityBytes.length
      ) {
        throw new RangeError(
          `Connectivity edge ${edgeIndex} is outside the accepted R8 cell axis.`
        );
      }
      if (source >= destination) {
        throw new RangeError(
          `Connectivity edge ${edgeIndex} must satisfy source < destination.`
        );
      }
      const sourceByte = exact.visibilityBytes[source];
      const destinationByte = exact.visibilityBytes[destination];
      if (
        (sourceByte !== 0 && sourceByte !== 255) ||
        (destinationByte !== 0 && destinationByte !== 255)
      ) {
        throw new RangeError(
          `Connectivity edge ${edgeIndex} references an R8 visibility byte that must be 0 or 255.`
        );
      }
      if (
        sourceByte === 255 &&
        destinationByte === 255
      ) {
        visibleCount += 1;
      }
    }
    checkpoints[blockIndex + 1] = visibleCount;
  }

  return publishCheckpointOwner(
    checkpoints,
    exact.edgeCount,
    visibleCount,
    {
      destinations: exact.destinations,
      kind: 'accepted-r8',
      sources: exact.sources,
      visibilityBytes: exact.visibilityBytes,
    },
    candidate.reusableCheckpoints
  );
}

/**
 * Resolve the exact raw edge-prefix length that admits `targetVisible`
 * shader-visible edges.
 *
 * Zero always means zero GPU instances. Positive targets use a checkpoint
 * binary search followed by at most one 4096-edge scan, including the
 * all-visible target. This keeps filtered views at the shortest raw prefix
 * that contains every shader-visible edge instead of submitting hidden tail
 * instances.
 *
 * @param {Object} owner
 * @param {Uint32Array} sources
 * @param {Uint32Array} destinations
 * @param {Uint8Array} visibilityBytes
 * @param {number} targetVisible
 * @returns {number}
 */
export function resolveConnectivityEdgeRawPrefix(
  owner,
  sources,
  destinations,
  visibilityBytes,
  targetVisible
) {
  const exact = requireEdgeInputs(
    sources,
    destinations,
    visibilityBytes
  );
  requireCertifiedOwner(
    owner,
    exact.sources,
    exact.destinations,
    exact.visibilityBytes
  );
  if (
    !Number.isSafeInteger(targetVisible) ||
    targetVisible < 0 ||
    targetVisible > owner.edgeCount
  ) {
    throw new RangeError(
      'Connectivity visible-edge target must be a non-negative safe integer no larger than the edge count.'
    );
  }

  const exactTarget = Math.min(targetVisible, owner.visibleCount);
  if (exactTarget === 0) return 0;

  const checkpoints = owner.checkpoints;
  let low = 1;
  let high = checkpoints.length - 1;
  while (low < high) {
    const middle = low + ((high - low) >>> 1);
    if (checkpoints[middle] < exactTarget) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (checkpoints[low] < exactTarget) {
    throw new Error(
      'Connectivity sparse checkpoints do not contain the requested visible target.'
    );
  }

  const blockStart =
    (low - 1) * CONNECTIVITY_EDGE_PREFIX_STRIDE;
  const blockEnd = Math.min(
    blockStart + CONNECTIVITY_EDGE_PREFIX_STRIDE,
    owner.edgeCount
  );
  let visibleCount = checkpoints[low - 1];
  for (let edgeIndex = blockStart; edgeIndex < blockEnd; edgeIndex++) {
    const source = exact.sources[edgeIndex];
    const destination = exact.destinations[edgeIndex];
    const sourceByte = exact.visibilityBytes[source];
    const destinationByte = exact.visibilityBytes[destination];
    if (
      source >= exact.visibilityBytes.length ||
      destination >= exact.visibilityBytes.length ||
      (sourceByte !== 0 && sourceByte !== 255) ||
      (destinationByte !== 0 && destinationByte !== 255)
    ) {
      throw new Error(
        'Connectivity certified endpoint or R8 ownership changed after prefix publication.'
      );
    }
    if (sourceByte === 255 && destinationByte === 255) {
      visibleCount += 1;
      if (visibleCount === exactTarget) {
        return edgeIndex + 1;
      }
    }
  }
  throw new Error(
    'Connectivity sparse checkpoint refinement did not reach the requested visible target.'
  );
}

/**
 * Detach an accepted owner and return its checkpoint array for staging reuse.
 *
 * @param {Object} owner
 * @returns {Uint32Array}
 */
export function retireConnectivityEdgePrefixOwner(owner) {
  if (
    owner === null ||
    typeof owner !== 'object' ||
    !Object.isFrozen(owner) ||
    certifiedOwners.get(owner) === undefined
  ) {
    throw new TypeError(
      'Connectivity edge-prefix retirement requires one accepted owner.'
    );
  }
  const checkpoints = owner.checkpoints;
  certifiedOwners.delete(owner);
  acceptedCheckpointOwners.delete(checkpoints);
  return checkpoints;
}
