/**
 * A test's teardown, undone in the reverse of the order it was set up.
 *
 * `node:test` runs a test's `after` hooks in the order they were
 * registered, first registered first. A test that fakes a global (`fetch`,
 * `Worker`, `window`, `document`) before it makes what uses it (a source, a
 * reader, a worker pool, a control) and registers each one's undoing as it
 * goes would put the real global back before what used the fake is torn
 * down: work still under way then reaches the real thing -- a read left
 * running would fetch `data.example.org` over the real network, retrying,
 * and keep the test process from ever ending.
 * `undoLater(t, undo)` keeps each test's undoings and runs them last
 * registered first, each awaited, as a `finally` nest would: what was made
 * with a fake is gone before the fake is.
 *
 * @module tests/helpers/teardown
 */

/** Each test's undoings, in the order they were registered. */
const undoings = new WeakMap();

/**
 * Undo `undo` when test `t` ends, after everything registered here after it.
 * Every undoing runs, even when one throws; the first failure is reported.
 *
 * @param {import('node:test').TestContext} t
 * @param {() => unknown} undo
 */
export function undoLater(t, undo) {
  let list = undoings.get(t);
  if (list === undefined) {
    list = [];
    undoings.set(t, list);
    t.after(async () => {
      let failure = null;
      for (const step of list.splice(0).reverse()) {
        try {
          await step();
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== null) throw failure;
    });
  }
  list.push(undo);
}
