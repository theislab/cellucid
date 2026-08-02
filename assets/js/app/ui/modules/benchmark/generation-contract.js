/**
 * @fileoverview Exact message contract for off-thread synthetic generation.
 *
 * Shared by the benchmark harness and its generation worker so neither side
 * can invent a field the other does not publish.
 *
 * It also owns the point-count bounds, because the control and the validators
 * used to state three different rules: `#benchmark-count` advertised
 * 1,000–50,000,000, `assertSyntheticCount` accepted one point and no ceiling,
 * and `dev/benchmark.js` accepted the same but only checked it on the GLB
 * path. `dev/benchmark.js` now imports the bounds, `index.html` declares them,
 * and `benchmark-generation-contract.test.mjs` fails when the markup drifts.
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
 * Smallest synthetic dataset the benchmark builds.
 *
 * One point is a complete dataset: the renderer publishes it and the
 * determinism tests generate a few dozen. Anything above one would reject
 * counts the rest of the system accepts.
 */
export const MIN_SYNTHETIC_COUNT = 1;

/**
 * Largest synthetic dataset the benchmark builds.
 *
 * This is the point-count control's own advertised ceiling, made binding.
 * Above it the two source arrays alone reach 800 MB — 600 MB of Float32 XYZ
 * and 200 MB of Uint8 RGBA — before the state's per-point arrays or any GPU
 * copy, so a larger request does not produce a slow benchmark, it produces a
 * failed allocation.
 *
 * It is a declared product limit, not the hardware's. The device's true
 * ceiling is `MAX_TEXTURE_SIZE²` for the renderer's alpha texture, which
 * varies by engine and is reported by the renderer when publication exceeds
 * it. Raising this constant is therefore a deliberate act, and raising it here
 * raises it everywhere: the control, both validators and the worker boundary
 * all read this one value.
 */
export const MAX_SYNTHETIC_COUNT = 50_000_000;

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
  if (
    !Number.isSafeInteger(count) ||
    count < MIN_SYNTHETIC_COUNT ||
    count > MAX_SYNTHETIC_COUNT
  ) {
    throw new TypeError(
      `Synthetic point count must be one integer between ` +
      `${MIN_SYNTHETIC_COUNT} and ${MAX_SYNTHETIC_COUNT}; ` +
      `received ${String(count)}.`
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
