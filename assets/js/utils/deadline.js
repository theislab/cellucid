/**
 * A deadline whose timer is released as soon as the work it bounds settles.
 *
 * `AbortSignal.timeout()` cannot be cancelled, so its timer outlives the work
 * it bounds, and some runtimes do not keep a process alive for it. This owns an
 * ordinary timer, aborts its signal with a `TimeoutError` when it fires, and
 * clears the timer on `release()`. `extend()` starts the full interval again,
 * so work that reports its progress is bounded by how long it goes without
 * any, not by how long it takes.
 *
 * @param {number} milliseconds
 * @param {{after?: (ms: number, callback: () => void) => () => void}} [options]
 *   `after`, the timer the deadline runs on: it calls `callback` once `ms`
 *   have passed and returns what cancels it (`setTimeout`; tests give a
 *   virtual clock's timers)
 * @returns {{ signal: AbortSignal, release: () => void, extend: () => void }}
 */
export function createDeadline(milliseconds, { after = afterTimeout } = {}) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new RangeError('A deadline must be a positive number of milliseconds.');
  }
  if (typeof after !== 'function') {
    throw new TypeError('A deadline timer must be a function.');
  }
  const controller = new AbortController();
  const expire = () => controller.abort(
    new DOMException('The operation timed out.', 'TimeoutError')
  );
  let cancel = after(milliseconds, expire);
  return Object.freeze({
    signal: controller.signal,
    release() {
      cancel();
    },
    extend() {
      if (controller.signal.aborted) return;
      cancel();
      cancel = after(milliseconds, expire);
    },
  });
}

/** `setTimeout` as a timer that returns what cancels it. */
function afterTimeout(ms, callback) {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
}
