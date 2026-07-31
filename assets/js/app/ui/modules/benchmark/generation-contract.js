/**
 * @fileoverview Exact message contract for off-thread synthetic generation.
 *
 * Shared by the benchmark harness and its generation worker so neither side
 * can invent a field the other does not publish.
 *
 * @module app/ui/modules/benchmark/generation-contract
 */

/** Patterns the generation worker can produce. */
export const SYNTHETIC_PATTERNS = Object.freeze([
  'atlas',
  'batches',
  'clusters',
  'flatumap',
  'glb',
  'octopus',
  'spirals',
  'uniform'
]);

/** Patterns whose source data is fetched rather than computed. */
export const FETCHED_PATTERNS = Object.freeze(['glb']);

/**
 * @param {unknown} pattern - Candidate pattern name.
 * @returns {string} The exact pattern name.
 */
export function assertSyntheticPattern(pattern) {
  if (!SYNTHETIC_PATTERNS.includes(pattern)) {
    throw new RangeError(
      `Synthetic pattern must be one of ${SYNTHETIC_PATTERNS.join(', ')}; ` +
      `received ${String(pattern)}.`
    );
  }
  return pattern;
}

/**
 * @param {unknown} count - Candidate point count.
 * @returns {number} The exact point count.
 */
export function assertSyntheticCount(count) {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new TypeError(
      'Synthetic point count must be one positive safe integer.'
    );
  }
  return count;
}

/**
 * Validate a request before it crosses the worker boundary.
 *
 * @param {unknown} request - Candidate request.
 * @returns {Object} Frozen request record.
 */
export function assertGenerationRequest(request) {
  if (
    request === null ||
    typeof request !== 'object' ||
    Array.isArray(request)
  ) {
    throw new TypeError('Generation request must be one plain object.');
  }
  if (!Number.isSafeInteger(request.requestId) || request.requestId < 0) {
    throw new TypeError(
      'Generation request id must be one non-negative safe integer.'
    );
  }
  const pattern = assertSyntheticPattern(request.pattern);
  const count = assertSyntheticCount(request.count);
  const sourceUrl = request.sourceUrl ?? null;
  if (FETCHED_PATTERNS.includes(pattern)) {
    if (typeof sourceUrl !== 'string' || sourceUrl.length === 0) {
      throw new TypeError(
        `Generation pattern "${pattern}" requires one absolute sourceUrl; ` +
        'a worker cannot resolve a document-relative one.'
      );
    }
  } else if (sourceUrl !== null) {
    throw new TypeError(
      `Generation pattern "${pattern}" is computed and takes no sourceUrl.`
    );
  }
  return Object.freeze({ requestId: request.requestId, pattern, count, sourceUrl });
}

/**
 * Validate a worker response, including the exact array lengths the viewer's
 * publication path demands. Catching a length mismatch here means the failure
 * is reported against generation rather than against the renderer.
 *
 * @param {unknown} response - Candidate response.
 * @param {number} expectedCount - Points the request asked for.
 * @returns {Object} The response, when exact.
 */
export function assertGenerationResponse(response, expectedCount) {
  if (
    response === null ||
    typeof response !== 'object' ||
    Array.isArray(response)
  ) {
    throw new TypeError('Generation response must be one plain object.');
  }
  if (!Number.isSafeInteger(response.requestId) || response.requestId < 0) {
    throw new TypeError(
      'Generation response id must be one non-negative safe integer.'
    );
  }
  if (response.ok !== true) {
    throw new TypeError('Generation response must publish ok === true.');
  }
  assertSyntheticCount(expectedCount);
  if (
    !(response.positions instanceof Float32Array) ||
    response.positions.length !== expectedCount * 3
  ) {
    throw new TypeError(
      `Generation response must carry ${expectedCount * 3} Float32 position ` +
      'components.'
    );
  }
  if (
    !(response.colors instanceof Uint8Array) ||
    response.colors.length !== expectedCount * 4
  ) {
    throw new TypeError(
      `Generation response must carry ${expectedCount * 4} Uint8 colour ` +
      'components.'
    );
  }
  if (![1, 2, 3].includes(response.dimensionLevel)) {
    throw new TypeError(
      'Generation response dimension level must be exactly 1, 2, or 3.'
    );
  }
  if (
    typeof response.elapsedMs !== 'number' ||
    !Number.isFinite(response.elapsedMs) ||
    response.elapsedMs < 0
  ) {
    throw new TypeError(
      'Generation response must publish a finite non-negative elapsedMs.'
    );
  }
  return response;
}
