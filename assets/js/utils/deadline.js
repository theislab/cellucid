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
 * @returns {{ signal: AbortSignal, release: () => void, extend: () => void }}
 */
export function createDeadline(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new RangeError('A deadline must be a positive number of milliseconds.');
  }
  const controller = new AbortController();
  const expire = () => controller.abort(
    new DOMException('The operation timed out.', 'TimeoutError')
  );
  let timer = setTimeout(expire, milliseconds);
  return Object.freeze({
    signal: controller.signal,
    release() {
      clearTimeout(timer);
    },
    extend() {
      if (controller.signal.aborted) return;
      clearTimeout(timer);
      timer = setTimeout(expire, milliseconds);
    },
  });
}
