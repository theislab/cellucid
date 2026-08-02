/**
 * @fileoverview Main-thread owner of the benchmark generation worker.
 *
 * One worker per request, terminated as soon as the request settles. A
 * benchmark generates a dataset a handful of times per session, so a resident
 * pool would hold a thread and its copy of the module graph for nothing.
 *
 * @module app/ui/modules/benchmark/generation
 */

import {
  assertGenerationRequest,
  assertGenerationResponse,
  FETCHED_PATTERNS
} from './generation-contract.js';

const WORKER_URL = new URL('./generation-worker.js', import.meta.url).href;

/**
 * Generate a synthetic dataset without blocking the main thread.
 *
 * The worker evaluates its own instance of the generator module, so the
 * dataset is built from `DEFAULT_SYNTHETIC_SEED` — the same constant the main
 * thread would have used, which is what makes the two paths byte-identical.
 * A `SyntheticDataGenerator.setSeed()` performed on the main thread does not
 * cross this boundary: the request carries no seed field, so nothing here can
 * silently observe a different one.
 *
 * @param {Object} options - Exact request.
 * @param {string} options.pattern - One of `SYNTHETIC_PATTERNS`.
 * @param {number} options.count - Points to generate.
 * @param {string} [options.sourceUrl] - Absolute URL for fetched patterns.
 * @param {AbortSignal} [options.signal] - Aborts and terminates the worker.
 * @returns {Promise<Object>} `{ positions, colors, dimensionLevel, elapsedMs }`
 */
export function generateSyntheticDataOffThread(options = {}) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    throw new TypeError('Off-thread generation options must be an object.');
  }
  if (typeof Worker !== 'function') {
    throw new Error(
      'Off-thread benchmark generation requires Worker support; this ' +
      'environment publishes none.'
    );
  }
  const pattern = options.pattern;
  let sourceUrl = options.sourceUrl ?? null;
  if (
    FETCHED_PATTERNS.includes(pattern) &&
    sourceUrl === null &&
    typeof globalThis.location?.href === 'string'
  ) {
    // A worker resolves relative URLs against its own script, not the page.
    // Resolve here so the worker only ever receives an absolute URL.
    sourceUrl = new URL(
      'assets/img/kemal-inecik.glb',
      globalThis.location.href
    ).href;
  }
  const request = assertGenerationRequest({
    requestId: 0,
    pattern,
    count: options.count,
    sourceUrl
  });
  const signal = options.signal ?? null;
  if (signal !== null && typeof signal.addEventListener !== 'function') {
    throw new TypeError(
      'Off-thread generation signal must be one AbortSignal.'
    );
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { type: 'module' });
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      if (signal !== null) signal.removeEventListener('abort', onAbort);
      worker.terminate();
      settle(value);
    };
    function onAbort() {
      finish(
        reject,
        new DOMException('Synthetic generation aborted.', 'AbortError')
      );
    }
    if (signal !== null) {
      if (signal.aborted) {
        worker.terminate();
        reject(new DOMException('Synthetic generation aborted.', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    worker.addEventListener('message', event => {
      const payload = event.data;
      if (payload?.ok !== true) {
        finish(
          reject,
          new Error(
            `Synthetic generation failed in the worker: ` +
            `${payload?.name ?? 'Error'}: ${payload?.message ?? 'unknown'}`
          )
        );
        return;
      }
      try {
        assertGenerationResponse(payload, request.count);
      } catch (error) {
        finish(reject, error);
        return;
      }
      finish(resolve, {
        positions: payload.positions,
        colors: payload.colors,
        dimensionLevel: payload.dimensionLevel,
        elapsedMs: payload.elapsedMs
      });
    });
    worker.addEventListener('error', event => {
      finish(
        reject,
        new Error(
          `Synthetic generation worker failed: ${event.message ?? 'unknown'}`
        )
      );
    });
    worker.addEventListener('messageerror', () => {
      finish(
        reject,
        new Error('Synthetic generation worker published an unreadable message.')
      );
    });

    worker.postMessage(request);
  });
}
