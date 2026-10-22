/**
 * @fileoverview The two phases of a frame that are not the draw itself.
 *
 * A browser runs the animation-frame callbacks of one frame in the order they
 * were registered. While it draws, the viewer re-registers its own callback
 * before drawing, so a control that coalesces its input to a frame with its own
 * `requestAnimationFrame` (a slider drag, a legend edit) runs *after* the
 * viewer in the next frame: the scene draws the old state, the control then
 * changes it, and the change is drawn a frame later -- one frame of latency on
 * every slider step, 50-90 ms at 10M cells in four views.
 *
 * So the viewer owns the order:
 *
 * 1. **before** -- work queued with `runBeforeNextFrame` (coalesced input that
 *    changes what is drawn) runs at the top of the viewer's frame, before it
 *    decides whether anything must be drawn;
 * 2. the viewer draws (or decides nothing changed);
 * 3. **after** -- work queued with `runAfterNextFrame` (readouts, counts,
 *    observers that only reflect what was drawn) runs once the frame is
 *    drawn, so DOM work never sits between input and pixels.
 *
 * The viewer's loop stops once its scene has settled; queuing work asks the
 * driver for a frame (`requestFrame`), so queued work starts the loop again.
 *
 * While no viewer drives frames (before it starts, while it is paused, after
 * it is disposed) each callback runs from a plain animation frame of its own,
 * as it would without this module, so queued work is never stranded.
 *
 * @module rendering/frame-phases
 */

/** @type {Array<{run: () => void, cancelled: boolean, frame: number|null}>} */
let beforeQueue = [];
/** @type {Array<{run: () => void, cancelled: boolean, frame: number|null}>} */
let afterQueue = [];
/** @type {{isRunning: () => boolean, requestFrame?: () => void}|null} */
let driver = null;

function reportFailure(error) {
  if (typeof globalThis.reportError === 'function') {
    globalThis.reportError(error);
  } else {
    setTimeout(() => { throw error; });
  }
}

function runEntry(entry) {
  if (entry.cancelled) return;
  entry.cancelled = true;
  try {
    entry.run();
  } catch (error) {
    // One failing callback must not cost the frame or the others theirs.
    reportFailure(error);
  }
}

/** Undriven: the entry runs from an animation frame of its own. */
function runOnOwnFrame(entry) {
  entry.frame = requestAnimationFrame(() => {
    entry.frame = null;
    runEntry(entry);
  });
}

function enqueue(queue, run) {
  if (typeof run !== 'function') {
    throw new TypeError('A frame-phase callback must be a function.');
  }
  const entry = { run, cancelled: false, frame: null };
  if (driver !== null && driver.isRunning()) {
    queue.push(entry);
    // The viewer's loop stops while nothing changes: ask it for the frame.
    driver.requestFrame?.();
  } else {
    runOnOwnFrame(entry);
  }
  return () => {
    entry.cancelled = true;
    if (entry.frame !== null) {
      cancelAnimationFrame(entry.frame);
      entry.frame = null;
    }
  };
}

/**
 * Run `fn` at the top of the next frame, before the scene is drawn.
 * @param {() => void} fn
 * @returns {() => void} Cancels it if it has not run yet.
 */
export function runBeforeNextFrame(fn) {
  return enqueue(beforeQueue, fn);
}

/**
 * Run `fn` once the next frame has been drawn.
 * @param {() => void} fn
 * @returns {() => void} Cancels it if it has not run yet.
 */
export function runAfterNextFrame(fn) {
  return enqueue(afterQueue, fn);
}

/**
 * Run every callback queued before this frame (the viewer calls this at the
 * top of its frame). Callbacks queued while it runs wait for the next frame.
 */
export function drainBeforeFramePhase() {
  const queue = beforeQueue;
  beforeQueue = [];
  for (const entry of queue) runEntry(entry);
}

/** Run every callback queued for after this frame. */
export function drainAfterFramePhase() {
  const queue = afterQueue;
  afterQueue = [];
  for (const entry of queue) runEntry(entry);
}

/**
 * Register the viewer that drives frames, or null when it stops for good.
 * Work queued while it is not running runs from a frame of its own.
 *
 * @param {{isRunning: () => boolean, requestFrame?: () => void}|null} next
 */
export function setFramePhaseDriver(next) {
  driver = next;
  if (driver !== null && driver.isRunning()) return;
  // Stopped: what was queued for its frames runs from frames of its own.
  const queued = [...beforeQueue, ...afterQueue];
  beforeQueue = [];
  afterQueue = [];
  for (const entry of queued) {
    if (!entry.cancelled) runOnOwnFrame(entry);
  }
}
