/**
 * Failures of a dataset's lifecycle (opening, reloading, switching) and their
 * cleanup. A newer selection stops an older one with a `superseded`
 * cancellation (`utils/abort.js`), never a failure.
 *
 * @module data/dataset-lifecycle-errors
 */

import { isCancellation } from '../utils/abort.js';

/**
 * Combine an operation's failure with a failure in its cleanup or reporting.
 *
 * A cancelled operation (a newer selection superseded it) is returned
 * unchanged: its caller discards the result by recognising the cancellation,
 * which an aggregate would hide, turning a cancelled open into a reported
 * failure. The secondary failure is logged instead.
 *
 * @param {Error} primaryFailure
 * @param {unknown} secondaryFailure
 * @param {string} message
 * @returns {Error} The cancelled primary failure, or an AggregateError
 */
export function combineDatasetLifecycleFailures(
  primaryFailure,
  secondaryFailure,
  message
) {
  if (!(primaryFailure instanceof Error)) {
    throw new TypeError(
      'The primary dataset lifecycle failure must be an Error.'
    );
  }
  if (typeof message !== 'string' || message.length === 0) {
    throw new TypeError(
      'Dataset lifecycle aggregate message must be a non-empty string.'
    );
  }
  const secondaryError = secondaryFailure instanceof Error
    ? secondaryFailure
    : new TypeError(
        'The secondary dataset lifecycle failure was not an Error.',
        { cause: secondaryFailure }
      );
  if (isCancellation(primaryFailure)) {
    console.error(`[Cellucid] ${message}`, secondaryError);
    return primaryFailure;
  }
  return new AggregateError(
    [primaryFailure, secondaryError],
    message,
    { cause: primaryFailure }
  );
}
