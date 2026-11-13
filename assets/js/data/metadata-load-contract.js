import { abortReason, onAbort, requireSignalOrNull, throwIfAborted } from '../utils/abort.js';
import { requireKeys } from '../utils/exact-record.js';

/**
 * Validate the one exact options seam shared by public metadata loaders.
 *
 * @param {unknown} options
 * @param {string} label
 * @returns {AbortSignal|null}
 */
export function getMetadataLoadSignal(options, label) {
  requireKeys(options, [], ['signal'], `${label} options`);
  const signal = Object.hasOwn(options, 'signal')
    ? options.signal
    : null;
  return requireSignalOrNull(
    signal,
    `${label} options.signal`
  );
}

/**
 * Execute one metadata generation as an atomic, fail-fast batch.
 *
 * A child controller lets the first item failure cancel every sibling without
 * retiring the caller's lifecycle owner. The method still drains every
 * sibling before rejecting, so no request or parser can continue after the
 * generation has already reported failure.
 *
 * @template T
 * @template R
 * @param {T[]} items
 * @param {AbortSignal|null} ownerSignal
 * @param {(item: T, signal: AbortSignal, index: number) => Promise<R>|R} loadItem
 * @param {string} label
 * @returns {Promise<R[]>}
 */
export async function loadMetadataBatchAtomically(
  items,
  ownerSignal,
  loadItem,
  label
) {
  if (!Array.isArray(items)) {
    throw new TypeError(`${label} items must be an array`);
  }
  requireSignalOrNull(ownerSignal, `${label} owner signal`);
  if (typeof loadItem !== 'function') {
    throw new TypeError(`${label} loader must be a function`);
  }

  const controller = new AbortController();
  const stopRelay = onAbort(ownerSignal, () => controller.abort(ownerSignal.reason));

  let hasFailure = false;
  let firstFailure;
  try {
    const settled = await Promise.allSettled(
      items.map(async (item, index) => {
        try {
          throwIfAborted(controller.signal);
          return await loadItem(item, controller.signal, index);
        } catch (error) {
          if (!hasFailure && !ownerSignal?.aborted) {
            hasFailure = true;
            firstFailure = error;
            controller.abort(error);
          }
          throw error;
        }
      })
    );

    if (ownerSignal?.aborted) throw abortReason(ownerSignal);
    if (hasFailure) throw firstFailure;
    return settled.map(outcome => outcome.value);
  } finally {
    stopRelay();
  }
}

