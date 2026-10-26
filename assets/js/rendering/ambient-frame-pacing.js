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
 * **The rule.** An ambient frame is due once the main thread has been free
 * since the last drawn frame for as long as that frame held it, so ambient
 * frames never take more than half of the main thread. A cheap frame is due
 * by the next display frame and nothing changes; a frame that costs 450 ms
 * pulses a little under once a second and leaves the other 450 ms to the
 * page.
 *
 * **What a frame held is measured, never assumed.** It is the span from the
 * frame's start to the first task that runs after it, which in every engine
 * comes after the browser's own work on that frame (style, layout,
 * compositing, a readback). Frames drawn before that task runs (a change, an
 * input, a settle frame) are inside the span, which runs from the first of
 * them: the span is an upper bound on what they held together, never the
 * cost of the last one alone.
 *
 * **Nothing is due while a frame is being measured.** A browser may run the
 * next animation frame before any task queued during the last one: Firefox
 * does whenever a display interval has passed, and every engine does once
 * rendering has waited long enough behind tasks. An ambient frame decided
 * then, from the frame before, was drawn back to back with the one still
 * unmeasured, and under a queue of tasks (an analysis's worker replies)
 * every frame was. So the measurement owes its answer before any ambient
 * frame is drawn, and the wake that brings the loop back is armed from the
 * answer.
 *
 * **It always answers.** While the measurement is owed the viewer leaves its
 * loop unarmed, so nothing of the viewer's stands between the task that
 * measures and the main thread: that task runs behind whatever was queued
 * before it, and the wake follows one frame's cost later. A pulse frame is
 * therefore drawn within its frame's cost, the tasks queued ahead of the
 * measurement, and its own wait, which `tests/ambient-frame-pacing-contract`
 * proves on a simulated event loop with 450 ms frames, both when tasks run
 * before the next animation frame and when animation frames run first.
 *
 * Only the ambient frames are paced. A frame some change, input, resize, or
 * other animation asks for is drawn at once, and still measured, so the next
 * ambient frame waits for it too.
 *
 * @module rendering/ambient-frame-pacing
 */

import { yieldToMacrotask } from '../utils/yield-macrotask.js';

/** Run `callback` in the first task after the current one. */
function inNextTask(callback) {
  yieldToMacrotask().then(callback);
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now] - Clock (ms)
 * @param {(callback: () => void) => void} [options.afterFrame] - Calls
 *   `callback` in the first task after the current one
 * @param {(callback: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(handle: unknown) => void} [options.clearTimer]
 */
export function createAmbientFramePacer({
  now = () => performance.now(),
  afterFrame = inNextTask,
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

  /** When the last measured span of frames ended (ms). */
  let lastFrameEndedAt = -Infinity;
  /** How long that span held the main thread (ms). */
  let lastFrameCostMs = 0;
  /** Start of the first frame not yet measured, or null when none is owed. */
  let heldSince = null;
  /** The latest drawn frame; only its measurement settles what is owed. */
  let frameToken = 0;
  /** The callback that brings the loop back once an ambient frame is due. */
  let pendingWake = null;
  let wakeTimer = null;
  let disposed = false;

  const dueAt = () => lastFrameEndedAt + lastFrameCostMs;

  function clearWakeTimer() {
    if (wakeTimer === null) return;
    clearTimer(wakeTimer);
    wakeTimer = null;
  }

  /** Arm the wake for the time the next ambient frame is due. */
  function armWake() {
    clearWakeTimer();
    if (pendingWake === null || heldSince !== null || disposed) return;
    wakeTimer = setTimer(() => {
      wakeTimer = null;
      const wake = pendingWake;
      pendingWake = null;
      if (!disposed && wake !== null) wake();
    }, Math.max(0, dueAt() - now()));
  }

  return Object.freeze({
    /**
     * A frame was drawn that started at `startedAt`: measure what it held
     * once the browser has finished its own work on it. The loop the frame
     * armed asks again, so a wake asked for before it is dropped.
     * @param {number} startedAt
     */
    frameDrawn(startedAt) {
      if (disposed) return;
      if (heldSince === null) heldSince = startedAt;
      frameToken += 1;
      const token = frameToken;
      pendingWake = null;
      clearWakeTimer();
      afterFrame(() => {
        if (disposed || token !== frameToken) return;
        const endedAt = now();
        lastFrameEndedAt = endedAt;
        lastFrameCostMs = Math.max(0, endedAt - heldSince);
        heldSince = null;
        armWake();
      });
    },

    /** Whether an ambient frame may be drawn at `at`. */
    isDue(at) {
      return heldSince === null && at >= dueAt();
    },

    /**
     * Call `wake` once an ambient frame is due: one wake at a time, the
     * latest asked for; while a frame is being measured it is armed when
     * the measurement answers.
     * @param {() => void} wake
     */
    wakeWhenDue(wake) {
      if (disposed) return;
      if (typeof wake !== 'function') throw new TypeError('An ambient frame wake must be a function');
      pendingWake = wake;
      if (wakeTimer === null) armWake();
    },

    /** No ambient frame is wanted any more: drop the wake. */
    cancelWake() {
      pendingWake = null;
      clearWakeTimer();
    },

    /** The pacing as diagnostics read it. */
    snapshot() {
      return Object.freeze({
        lastFrameCostMs,
        measuring: heldSince !== null,
        msUntilDue: heldSince !== null ? null : Math.max(0, dueAt() - now()),
        wakePending: pendingWake !== null,
      });
    },

    dispose() {
      disposed = true;
      pendingWake = null;
      clearWakeTimer();
    },
  });
}
