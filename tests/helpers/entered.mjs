/**
 * Wait until an operation reaches a point a test is waiting for, or fail as
 * soon as the operation settles without reaching it.
 *
 * A test that only awaited the point would wait forever when the operation
 * failed before it (node:test has no default timeout), and report nothing;
 * this reports the operation's own error instead.
 *
 * @param {Promise<void>} entered - Resolves when the point is reached.
 * @param {Promise<unknown>} operation - The operation that should reach it.
 * @param {string} what - The point, for the failure message.
 * @returns {Promise<void>}
 */
export function untilEntered(entered, operation, what) {
  return Promise.race([
    entered,
    Promise.resolve(operation).then(
      () => {
        throw new Error(`The operation finished before it reached ${what}.`);
      },
      error => {
        throw new Error(`The operation failed before it reached ${what}: ${error?.message ?? error}`, { cause: error });
      }
    ),
  ]);
}
