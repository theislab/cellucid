/**
 * @fileoverview Exact teardown helpers for the community annotation UI.
 *
 * Community annotation teardown must never swallow a failure: every cleanup
 * entry runs, and the collected errors are rethrown as one.
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
