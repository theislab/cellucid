/**
 * Pacing for frames drawn only because an ambient animation runs: one that
 * never ends and converges on nothing (smoke that animates, velocity
 * particles flowing, the highlight pulse, a backdrop's ambient motion), while
 * nothing else on screen changes.
 *
 * Such a frame redraws the whole scene, and the animation asks for one every
 * display frame for as long as it runs. Where the machine draws a frame
 * within a display interval, that is free. Where it does not, back-to-back
 * ambient frames took the machine from the page for good, on either of the
 * two resources a frame uses:
 * - **The main thread** (a software renderer, a headless browser that reads
 *   every WebGL frame back for compositing, millions of points): a marker
 *   run of 400 genes, 32 ms of statistics, took over 40 s because its worker
 *   replies only ran between frames.
 * - **The GPU** (Chromium's SwiftShader through ANGLE, which runs WebGL in
 *   the GPU process and leaves the main thread free; Firefox on the hosted
 *   macOS runners, where a 1024² fragment pass takes a minute): the page's
 *   own frames queued behind the viewer's GPU work. Measured under
 *   SwiftShader with the velocity overlay on: the page ran 17 frames a
 *   second instead of 60; on hosted macOS Firefox each click waited 10 to
 *   15 s for the frames it needs (CI run 42350760019).
 *
 * **The main-thread rule.** An ambient frame is due once the main thread has
 * been free since the last drawn frame for as long as that frame held it, so
 * ambient frames never take more than half of the main thread. A cheap frame
 * is due by the next display frame and nothing changes; a frame that costs
 * 450 ms is followed by 450 ms left to the page.
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
 * before it, and the wake follows one frame's cost later. An ambient frame
 * is therefore drawn within its frame's cost, the tasks queued ahead of the
 * measurement, and its own wait, which `tests/ambient-frame-pacing-contract`
 * proves on a simulated event loop with 450 ms frames, both when tasks run
 * before the next animation frame and when animation frames run first.
 *
 * **The GPU rule: the page's frames are timed, as a person sees them.** The
 * GPU's share of a frame is not on the main thread, and a fence does not
 * read it either: the GPU runs frames in a pipeline, so a fence after a
 * frame passes a frame or more later on a GPU that keeps up (Metal on an
 * Apple M1 Pro), and pacing every frame by it took smoke there from 60 to
 * 45 frames a second. What a GPU that falls behind does to the page is make
 * its animation frames come late: the browser starts the next frame once the
 * GPU has room for it. So every animation frame the viewer's loop runs in is
 * timed from the one before it (their timestamps, `frameStarted`). One that
 * came a whole display frame late or more (rounded to whole display
 * intervals: WebKit's timestamps jitter by up to a third of one) while the
 * GPU was still running the viewer's last frame when it was due ran late by
 * the display frames it missed. The next ambient frame is due only once the
 * page's frames have run on after the late one for as long as it ran late,
 * so ambient frames never make the page's frames late for more than about
 * half the time. While only this rule holds an ambient frame back, the
 * viewer runs the animation frames in between without drawing
 * (`watchesNextFrame`), and they are timed too: a pipeline hides the cost of
 * the first two or three frames of a burst (measured under SwiftShader, the
 * lateness of three frames came two frames after them), and a GPU still
 * working through them lengthens the wait. The wait ends once the GPU keeps
 * up again, and a GPU that keeps up makes no frame late: nothing is ever
 * held back there. Measured on an Apple M1 Pro (2026-11-07), the velocity
 * overlay of `data-mapping-multi.h5ad`: under SwiftShader through ANGLE the
 * page ran 34 to 38 frames a second instead of 17 with the overlay still
 * drawing 17, a change was shown in 60 ms instead of up to 112 and two
 * animation frames came in 10 to 60 ms instead of 71 to 112 (animated
 * smoke: 41 instead of 25, smoke still at 25); on Metal (Chromium, 60 Hz),
 * Firefox (120 Hz) and WebKit (60 Hz) every display frame still drew one,
 * overlay or smoke.
 *
 * **Late because of the GPU, not because the page stopped.** Browsers stop
 * animation frames for a hidden document or an iframe scrolled out of view
 * (a notebook's), and a long task holds the main thread: the frame after
 * either is late too, by as long. So a frame counts only where the GPU was
 * still running the viewer's last drawn frame at the moment the next frame
 * was due (`gpuBusy`, read by a timer for that moment, which a frame that
 * comes on time clears: a frame on time reads nothing), and only for as long
 * as the GPU was seen to run it: from that moment it is read again every
 * half display interval until it has finished, and once more as the late
 * frame starts. A page stopped, or a long task, while the GPU still ran a
 * slow frame (a phone's tab switched away from right after an ambient frame)
 * is late by far more than the GPU held it: a read that comes more than a
 * display interval after the one before says only that the GPU finished
 * somewhere in that gap, so the GPU's part ends at the read before it, and
 * the frame counts as late only by the display frames up to the first after
 * that (one more for the timestamps' rounding). Before this bound, a page
 * hidden 10 s after such a frame held its ambient animation 10 s once shown.
 * A frame the GPU held throughout (still running at the late frame's start:
 * the fence passes in order) is late by all of it. Nor does a frame after
 * one some change or input asked for count: that frame is the page's own
 * work.
 *
 * **The display interval is measured, never assumed**: 60 Hz, 120 Hz (Firefox
 * on a ProMotion display), 30 Hz under a browser's power saving. It is the
 * mean period of two animation frames the page ran once the GPU had finished
 * the viewer's last drawn frame (`gpuBusy` false) and in which the viewer drew
 * nothing: a frame while the GPU is busy may be late, which is not the
 * display's interval. It is measured before the first ambient frame, and
 * again whenever a late frame holds one back (a display that slowed makes
 * every frame look late until then).
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

/** What an animation frame of the viewer's loop drew. */
const DREW_NOTHING = 0;
const DREW_AMBIENT = 1;
const DREW_OTHER = 2;

/**
 * The periods of idle animation frames the display interval is the mean of.
 * Their timestamps jitter (WebKit's are the callbacks' own times, up to a
 * third of an interval apart from the display's); only the first and the
 * last count in a mean of consecutive periods, so over eight the jitter is
 * within a twelfth of an interval, far inside the half a late frame is told
 * by. Two periods measured 14.5 ms in WebKit and 7.5 ms in Firefox on 60 Hz
 * and 120 Hz displays.
 */
const INTERVAL_PERIODS = 8;

/**
 * A frame is late once it comes closer to two display intervals after the
 * one before than to one: it missed a display frame.
 */
const LATE_AT_INTERVALS = 1.5;

/**
 * @param {object} [options]
 * @param {() => number} [options.now] - Clock (ms), the clock of animation
 *   frame timestamps
 * @param {(callback: () => void) => void} [options.afterFrame] - Calls
 *   `callback` in the first task after the current one
 * @param {() => boolean} [options.gpuBusy] - Whether the GPU still runs the
 *   commands of the viewer's last drawn frame (never, where nothing is drawn
 *   on a GPU)
 * @param {(callback: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(handle: unknown) => void} [options.clearTimer]
 */
export function createAmbientFramePacer({
  now = () => performance.now(),
  afterFrame = inNextTask,
  gpuBusy = () => false,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = handle => clearTimeout(handle),
} = {}) {
  if (
    typeof now !== 'function'
    || typeof afterFrame !== 'function'
    || typeof gpuBusy !== 'function'
    || typeof setTimer !== 'function'
    || typeof clearTimer !== 'function'
  ) {
    throw new TypeError('Ambient frame pacer now, afterFrame, gpuBusy, setTimer and clearTimer must be functions');
  }

  // --- The main-thread rule ---
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

  // --- The GPU rule ---
  /** The display interval (ms), or null until it is measured. */
  let intervalMs = null;
  /** The timestamp of the last animation frame the loop ran in, or null. */
  let lastFrameAt = null;
  /** What that frame drew (DREW_*). */
  let lastFrameDrew = DREW_NOTHING;
  /** Whether the GPU still ran the last drawn frame when the next was due. */
  let gpuBehind = false;
  /**
   * The timer that reads that at the moment the next frame is late, then
   * reads again until the GPU has finished (`readGpu`).
   */
  let lateTimer = null;
  /** When a read last saw the GPU still run the last drawn frame (ms), or null. */
  let gpuSeenBusyAt = null;
  /**
   * Until when the GPU is known to have run the last drawn frame (ms), once
   * a read saw it finished; null while it is not seen finished.
   */
  let gpuRanUntil = null;
  /** The page's frames ran late: no ambient frame before this time (ms). */
  let lateUntil = -Infinity;
  /** How late the last late frame ran (ms), for diagnostics. */
  let lastLateMs = 0;
  /**
   * Measuring the display interval: 'gpu' while the GPU finishes the last
   * drawn frame, 'frames' while idle frames are timed, null when not.
   */
  let intervalPhase = null;
  let intervalTimer = null;
  /** The first idle frame timed, and the periods timed since. */
  let intervalFirstAt = null;
  let intervalPeriods = 0;

  const dueAt = () => lastFrameEndedAt + lastFrameCostMs;
  const mainThreadDue = at => heldSince === null && at >= dueAt();
  // In whole display frames: the frame that comes nearest the end of the
  // wait ends it (a wait of a measured interval is not missed by a rounding
  // of the timestamps).
  const gpuKeepsUp = at => intervalMs !== null && at >= lateUntil - intervalMs / 2;

  function clearWakeTimer() {
    if (wakeTimer === null) return;
    clearTimer(wakeTimer);
    wakeTimer = null;
  }

  function clearLateTimer() {
    if (lateTimer === null) return;
    clearTimer(lateTimer);
    lateTimer = null;
  }

  /**
   * Read whether the GPU still runs the last drawn frame, at `at`: while it
   * does, when it was seen to; once it has finished, until when it is known
   * to have run it -- this read, when the one before was within a display
   * interval, else the one before (the reads stopped meanwhile: a stopped
   * page, a long task). Returns whether it still runs it.
   */
  function readGpu(at) {
    if (gpuBusy()) {
      gpuSeenBusyAt = at;
      return true;
    }
    if (gpuRanUntil === null && gpuSeenBusyAt !== null) {
      gpuRanUntil = at - gpuSeenBusyAt <= intervalMs ? at : gpuSeenBusyAt;
    }
    return false;
  }

  /** Read the GPU every half display interval until it has finished the last drawn frame. */
  function watchGpu() {
    lateTimer = setTimer(() => {
      lateTimer = null;
      if (!disposed && readGpu(now())) watchGpu();
    }, intervalMs / 2);
  }

  /** Arm the wake for the time the main-thread rule lets a frame be drawn. */
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

  /**
   * Measure the display interval: once the GPU has finished the last drawn
   * frame (read in a task at a time), the next idle frames are timed. A
   * measurement under way goes on.
   */
  function measureInterval() {
    if (intervalPhase !== null || disposed) return;
    intervalPhase = 'gpu';
    const poll = () => {
      intervalTimer = null;
      if (disposed || intervalPhase !== 'gpu') return;
      if (gpuBusy()) {
        intervalTimer = setTimer(poll, 0);
        return;
      }
      intervalPhase = 'frames';
      intervalFirstAt = null;
      intervalPeriods = 0;
    };
    intervalTimer = setTimer(poll, 0);
  }

  function stopMeasuringInterval() {
    intervalPhase = null;
    if (intervalTimer !== null) {
      clearTimer(intervalTimer);
      intervalTimer = null;
    }
  }

  return Object.freeze({
    /**
     * An animation frame of the viewer's loop starts, at `timestamp` (the
     * frame's own timestamp). `consecutive`: the frame before it armed this
     * one, so the period between them is the page's frame time.
     * @param {number} timestamp
     * @param {boolean} consecutive
     */
    frameStarted(timestamp, consecutive) {
      if (disposed) return;
      clearLateTimer();
      const previousAt = lastFrameAt;
      const previousDrew = lastFrameDrew;
      const behind = gpuBehind;
      // Until when the GPU ran the last drawn frame: all along, when it
      // still runs it now (a fence passes in order); else as the reads saw.
      let gpuRanTo = gpuRanUntil;
      if (behind && gpuRanTo === null) gpuRanTo = readGpu(now()) ? now() : gpuRanUntil;
      lastFrameAt = timestamp;
      lastFrameDrew = DREW_NOTHING;
      gpuBehind = false;
      gpuSeenBusyAt = null;
      gpuRanUntil = null;
      const period = consecutive && previousAt !== null ? timestamp - previousAt : null;
      // Two callbacks at one timestamp (Firefox can run one) are one frame.
      const timed = period !== null && period > 0;
      if (timed && intervalMs !== null && previousDrew !== DREW_OTHER && behind) {
        // The display frames to this one, but no more than to the first
        // after the GPU finished (and one for the timestamps' rounding): a
        // page stopped meanwhile was not late behind the GPU.
        const gpuFrames = Math.ceil(Math.max(0, gpuRanTo - previousAt) / intervalMs) + 1;
        const missed = Math.min(Math.round(period / intervalMs), gpuFrames) - 1;
        if (missed > 0) {
          lastLateMs = missed * intervalMs;
          lateUntil = Math.max(lateUntil, timestamp + lastLateMs);
          // A display that slowed makes every frame look late until the
          // interval is measured again.
          measureInterval();
        }
      }
      if (intervalPhase === 'frames') {
        if (!timed || previousDrew !== DREW_NOTHING || intervalFirstAt === null) {
          intervalFirstAt = timestamp;
          intervalPeriods = 0;
        } else {
          intervalPeriods += 1;
          if (intervalPeriods === INTERVAL_PERIODS) {
            intervalMs = (timestamp - intervalFirstAt) / INTERVAL_PERIODS;
            stopMeasuringInterval();
          }
        }
      }
      // Whether the GPU still runs the last drawn frame once the next frame
      // is late: read then, and only if no frame came on time before it.
      if (intervalMs !== null) {
        lateTimer = setTimer(() => {
          lateTimer = null;
          if (disposed) return;
          gpuBehind = readGpu(now());
          // How long it goes on running it bounds how late the GPU made the next frame.
          if (gpuBehind) watchGpu();
        }, Math.max(0, timestamp + LATE_AT_INTERVALS * intervalMs - now()));
      }
    },

    /**
     * A frame was drawn that started at `startedAt`: measure what it held
     * once the browser has finished its own work on it. `ambient`: drawn for
     * an ambient animation alone (its cost is the animation's). The loop the
     * frame armed asks again, so a wake asked for before it is dropped.
     * @param {number} startedAt
     * @param {boolean} [ambient]
     */
    frameDrawn(startedAt, ambient = false) {
      if (disposed) return;
      lastFrameDrew = ambient ? DREW_AMBIENT : DREW_OTHER;
      // The GPU has work again: what the measurement waited for is not what
      // it would wait for now. The next ambient frame asks again while the
      // interval is unknown, a late frame once it is known.
      if (intervalPhase !== null) stopMeasuringInterval();
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

    /**
     * Whether an ambient frame may be drawn at `at`: the main thread has
     * been free as long as the last frames held it, and the page's frames
     * have run on as long since the last late one as it ran late. Before
     * the display interval is known none is: it is measured first.
     * @param {number} at
     */
    isDue(at) {
      if (disposed) return false;
      if (intervalMs === null) measureInterval();
      return mainThreadDue(at) && gpuKeepsUp(at);
    },

    /**
     * Whether only the GPU rule holds an ambient frame back at `at`: the
     * viewer then runs the next animation frame without drawing, so that it
     * is timed (and the display interval measured); otherwise it waits for
     * `wakeWhenDue`.
     * @param {number} at
     */
    watchesNextFrame(at) {
      return !disposed && mainThreadDue(at) && !gpuKeepsUp(at);
    },

    /**
     * Call `wake` once the main-thread rule lets an ambient frame be drawn:
     * one wake at a time, the latest asked for; while a frame is being
     * measured it is armed when the measurement answers.
     * @param {() => void} wake
     */
    wakeWhenDue(wake) {
      if (disposed) return;
      if (typeof wake !== 'function') throw new TypeError('An ambient frame wake must be a function');
      pendingWake = wake;
      if (wakeTimer === null) armWake();
    },

    /**
     * No ambient frame is wanted any more: drop the wake, and the timers
     * that watched the frames (the loop runs no more frames to watch).
     */
    cancelWake() {
      pendingWake = null;
      clearWakeTimer();
      clearLateTimer();
      stopMeasuringInterval();
    },

    /** The pacing as diagnostics read it. */
    snapshot() {
      const at = now();
      return Object.freeze({
        lastFrameCostMs,
        measuring: heldSince !== null,
        msUntilDue: heldSince !== null ? null : Math.max(0, dueAt() - at),
        wakePending: pendingWake !== null,
        displayIntervalMs: intervalMs,
        measuringInterval: intervalPhase !== null,
        lastLateMs,
        msUntilGpuKeepsUp: Math.max(0, lateUntil - at),
      });
    },

    dispose() {
      disposed = true;
      pendingWake = null;
      clearWakeTimer();
      clearLateTimer();
      stopMeasuringInterval();
    },
  });
}
