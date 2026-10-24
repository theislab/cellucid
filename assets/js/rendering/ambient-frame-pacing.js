/**
 * Pacing for frames drawn only because an ambient animation runs: the
 * highlight pulse, while nothing else on screen changes.
 *
 * Such a frame redraws the whole scene, and the pulse asks for one every
 * display frame for as long as a highlight exists. Where a frame costs the
 * main thread less than a display interval, that is free. Where it costs
 * more (a software renderer, a headless browser that reads every WebGL frame
 * back for compositing, a weak GPU under millions of points), back-to-back
 * pulse frames held the main thread for good: a marker run of 400 genes,
 * 32 ms of statistics, took over 40 s because its worker replies only ran
 * between frames.
 *
 * The cost is measured, not assumed: from the frame's start to the first task
 * that runs after it, which in every engine comes after the browser's own
 * work on that frame (style, layout, compositing, a readback). An ambient
 * frame is due once the main thread has been free since the last frame for
 * as long as that frame took, so ambient frames never take more than half of
 * it. A cheap frame is always due by the next display frame and nothing
 * changes; a frame that costs 400 ms pulses at a little over one a second and
 * leaves the other 400 ms to the page.
 *
 * Only the ambient frames are paced. A frame some change, input, resize, or
 * other animation asks for is drawn at once, and still measured, so the next
 * ambient frame waits for it too.
 *
 * @module rendering/ambient-frame-pacing
 */

import { yieldToMacrotask } from '../utils/yield-macrotask.js';

/**
 * @param {object} [options]
 * @param {() => number} [options.now] - Clock (ms)
 * @param {() => Promise<void>} [options.afterFrame] - Resolves in the first
 *   task after the current one
 * @param {(callback: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(handle: unknown) => void} [options.clearTimer]
 */
export function createAmbientFramePacer({
  now = () => performance.now(),
  afterFrame = yieldToMacrotask,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = handle => clearTimeout(handle),
} = {}) {
  if (
    typeof now !== 'function'
    || typeof afterFrame !== 'function'
    || typeof setTimer !== 'function'
    || typeof clearTimer !== 'function'
  ) {
    throw new TypeError('Ambient frame pacer now, afterFrame, setTimer and clearTimer must be functions');
  }

  /** When the last measured frame's main-thread work ended (ms). */
  let lastFrameEndedAt = -Infinity;
  /** How long that frame held the main thread (ms). */
  let lastFrameCostMs = 0;
  let wakeTimer = null;
  let disposed = false;

  const dueAt = () => lastFrameEndedAt + lastFrameCostMs;

  return Object.freeze({
    /**
     * A frame was drawn that started at `startedAt`: measure what it cost
     * once the browser has finished its own work on it.
     * @param {number} startedAt
     */
    frameDrawn(startedAt) {
      if (disposed) return;
      // A later frame drawn before this one's task ran is inside the span
      // measured here, so the cost stays an upper bound, never an undercount.
      afterFrame().then(() => {
        if (disposed) return;
        const endedAt = now();
        lastFrameEndedAt = endedAt;
        lastFrameCostMs = Math.max(0, endedAt - startedAt);
      });
    },

    /** Whether an ambient frame may be drawn at `at`. */
    isDue(at) {
      return at >= dueAt();
    },

    /**
     * Call `wake` once an ambient frame is due (one pending wake at a time).
     * @param {() => void} wake
     */
    wakeWhenDue(wake) {
      if (disposed || wakeTimer !== null) return;
      const waitMs = Math.max(0, dueAt() - now());
      wakeTimer = setTimer(() => {
        wakeTimer = null;
        if (!disposed) wake();
      }, waitMs);
    },

    /** The pacing as diagnostics read it. */
    snapshot() {
      return Object.freeze({
        lastFrameCostMs,
        msUntilDue: Math.max(0, dueAt() - now()),
      });
    },

    dispose() {
      disposed = true;
      if (wakeTimer !== null) clearTimer(wakeTimer);
      wakeTimer = null;
    },
  });
}
