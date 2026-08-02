/**
 * @fileoverview Exact teardown helpers for the community annotation UI.
 *
 * Community annotation teardown must never swallow a failure: every cleanup
 * entry runs, and the collected errors are rethrown as one. Modal document
 * layers additionally get one retry, because losing the layer owner leaves the
 * page permanently covered.
 *
 * @module ui/modules/community-annotation/cleanup
 */

export function runExactCleanup(context, entries) {
  const errors = [];
  for (const [label, operation] of entries) {
    if (operation === null || operation === undefined) continue;
    if (typeof operation !== 'function') {
      errors.push(new TypeError(`${label} cleanup must be a function`));
      continue;
    }
    try {
      operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `${context} failed in ${errors.length} cleanup operations`
    );
  }
}

export function releaseExactModalDocumentLayer(release, label) {
  if (typeof release !== 'function') {
    throw new TypeError(`${label} release owner must be a function`);
  }
  try {
    if (release() !== true) {
      throw new Error(`${label} lost its exact document-layer owner`);
    }
    return true;
  } catch (primaryError) {
    try {
      if (release() !== true) {
        throw new Error(`${label} document-layer retry lost ownership`);
      }
      return true;
    } catch (retryError) {
      throw new AggregateError(
        [primaryError, retryError],
        `${label} document-layer release failed twice`
      );
    }
  }
}
