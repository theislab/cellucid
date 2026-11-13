/**
 * A promise settled from outside its executor.
 *
 * @module utils/promise-resolvers
 */

/**
 * A promise and the two functions that settle it: a lease released later, a
 * wait another call ends. What `Promise.withResolvers()` returns; that
 * method is ES2024, above the language level this code is held to
 * (`tsconfig.json`, `lib`).
 *
 * @template [T=void]
 * @returns {{promise: Promise<T>, resolve: (value?: T|PromiseLike<T>) => void, reject: (reason?: unknown) => void}}
 */
export function promiseWithResolvers() {
  /** @type {(value?: T|PromiseLike<T>) => void} */
  let resolve;
  /** @type {(reason?: unknown) => void} */
  let reject;
  const promise = /** @type {Promise<T>} */ (new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  }));
  return { promise, resolve, reject };
}
