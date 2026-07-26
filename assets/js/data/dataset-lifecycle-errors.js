/**
 * Sole current identity for cancellation caused by a newer dataset selection.
 *
 * Kept in the neutral data layer so source-selection and application reload
 * transactions use one protocol without importing each other.
 */
export const DATASET_RELOAD_SUPERSEDED_CODE =
  'CELLUCID_DATASET_RELOAD_SUPERSEDED';

/**
 * @param {string} message
 * @returns {Error}
 */
export function createDatasetReloadSupersededError(message) {
  if (typeof message !== 'string' || message.length === 0) {
    throw new TypeError(
      'Dataset reload supersession message must be a non-empty string.'
    );
  }
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = DATASET_RELOAD_SUPERSEDED_CODE;
  return error;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isDatasetReloadSupersededError(error) {
  return error?.code === DATASET_RELOAD_SUPERSEDED_CODE;
}

/**
 * @param {Error} primaryFailure
 * @param {unknown} secondaryFailure
 * @param {string} message
 * @returns {AggregateError}
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
  return new AggregateError(
    [primaryFailure, secondaryError],
    message,
    { cause: primaryFailure }
  );
}
