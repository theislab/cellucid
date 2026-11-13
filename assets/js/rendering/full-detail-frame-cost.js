/**
 * Whether drawing every cell is too slow for interaction on this device, and
 * whether the levels of detail and culling turned on for it make frames
 * faster.
 *
 * Levels of detail and frustum culling are off until the GPU's share of a
 * frame that draws every cell of every presented pane is measured over
 * `INTERACTIVE_FRAME_BUDGET_MS`; then the render controls turn them on
 * (`app/ui/modules/render-controls.js`) and ask for the frames drawn with
 * them to be measured (`verify`). No automatic choice may make a frame
 * slower: the frames drawn with them are kept only where the measurement
 * proves them faster (`verdictOf`, reported by `onVerified`); otherwise the
 * render controls turn them off again, for that framing, and say whether the
 * frames were measured no faster or closer than this browser can time. A
 * later framing (a zoom where culling would gain) is measured afresh. The
 * measurement, not a cell count or the dimension, decides: the same dataset
 * is fluid on one GPU and stalls on another, a small dataset never reaches
 * the budget anywhere, and a 2D view at full framing (whose level of detail
 * stays at every cell) gains nothing.
 *
 * **What is measured.** Two shares of a frame, each as bounds the true value
 * lies within (`Bounds`): the page's (`cpu`, from the start of the animation
 * frame to the frame's last command, read from the clock: exact) and the
 * GPU's (`gpu`, the time it took to execute the frame's commands). A browser
 * draws its frames in a pipeline, the GPU executing one frame while the page
 * prepares the next, so a frame lasts the longer of the two (`frame`, the
 * frame time a person sees while moving the view). Level of detail and
 * culling only change what the GPU draws: a frame is too slow for them to
 * help only when the GPU's share alone is proven over the budget (a page
 * that is slow on its own thread is not made faster by drawing fewer
 * cells), and their frames are faster only when the frame time is proven
 * lower.
 *
 * The GPU's share is read with the best instrument the browser offers:
 * - **A GPU timer** (`EXT_disjoint_timer_query_webgl2`: Chromium on a
 *   hardware GPU; not offered by Chromium's software GL, Firefox or WebKit):
 *   a `TIME_ELAPSED` query around
 *   the frame's commands gives the GPU's time exactly, whenever the page
 *   reads it. A sample the GPU reports as disjoint (its clock reset, the
 *   GPU switched) says nothing and another frame is asked for.
 * - **A fence** (`fenceSync`) polled in tasks after the frame, everywhere
 *   else: the GPU finished between the last poll that found the fence
 *   unsignaled (or the fence itself, when the first poll found it
 *   signaled) and the poll that found it signaled. The polls are as far
 *   apart as the browser runs tasks (nested timeouts are clamped, a busy
 *   page runs them late): a few milliseconds on an idle machine, and up to
 *   150 ms on a loaded hosted runner (28_decisions_rendering_layers.md). So
 *   from its start, the frame was done after `t.lo` and by `t.hi`; the GPU's
 *   share is at most `t.hi` and, the page's share having taken `cpu` of it,
 *   at least `t.lo - cpu`. The bounds are measured, not guessed: no constant
 *   is added for noise.
 *
 * **Samples and answers.** Each measurement takes `SAMPLES` frames
 * (`answerOf`). Its answer bounds the cheapest frame: the least of the
 * samples' lower bounds and the least of their upper bounds, so the first
 * frame of a dataset (its stores uploaded, its programs linked) or a stall
 * does not count against it. Its `spread` is how far the next-cheapest
 * frame is proven to lie above the cheapest (the next-cheapest's lower bound
 * over the cheapest's upper bound, or 0): frame-to-frame variation the
 * samples prove, never the instrument's resolution counted a second time.
 *
 * **The verdict** (`verdictOf`) compares bounds: the frames with the choice
 * on are `faster` when their upper bound lies below the frames of every
 * cell's lower bound by more than either measurement's spread; `not-faster`
 * when even the frames of every cell's upper bound is not above their lower
 * bound by more than it; otherwise `unresolved` (the bounds overlap: the
 * instrument cannot tell the frames apart here), which no exact instrument
 * reaches. No term is added to the cheapest sample for the poll interval: a
 * late poll on a busy runner would make it 150 ms and call a frame measured
 * 150 ms faster "no faster"; and the spread of three samples alone, without
 * the resolution, would call frames a poll interval apart faster
 * (28_decisions_rendering_layers.md).
 *
 * **When.** Once per opening: the viewer arms the measurement once it has
 * published a dataset's cells or another representation of them (a
 * publication that failed changed nothing, its measurement included), and
 * frames drawn at full detail after that are sampled until it has its
 * answer. Each sample asks for the next frame once it is read
 * (`requestFrame`), so the answer comes right after the opening, `SAMPLES`
 * frames later, not at the first interaction; frames drawn while a sample is
 * read are not sampled, so it never asks for more. Only frames of every cell
 * by setting are sampled for the first answer: turning levels of detail on
 * (a person's choice, a session's, a caller's) ends the opening's
 * measurement (`disarm`), frames drawn with them on are not reported
 * (`presentedAtFullDetail`, rendering/viewer.js), and an answer that lands
 * after they were turned on is dropped. `verify` then samples the frames
 * drawn with the automatic choice on, against that answer.
 *
 * **Only where an answer could change something.** The viewer looks at the
 * first frame of every cell it would sample (`presentedDrawsFewer`,
 * rendering/viewer.js): when no presented pane has a reduced level of
 * detail for its cells and every pane's cells lie in its view, nothing the
 * render controls could turn on would draw fewer cells, so the measurement
 * stops there (`disarm`) and asks for no frame; the viewer says so
 * (`nothing-fewer`), and the next framing is looked at afresh. Culling is
 * tried only where a cell may lie outside its pane's view. On a GPU that
 * takes seconds a frame the frames a measurement asks for would be most of an
 * opening's time.
 *
 * @module rendering/full-detail-frame-cost
 */

import { fenceHasPassed } from './gl-utils.js';

/**
 * The longest a frame may take for direct manipulation (orbiting, panning,
 * zooming) to stay fluid: 30 frames a second, the usual floor of smooth
 * motion. A UX target, not a property of any device.
 */
export const INTERACTIVE_FRAME_BUDGET_MS = 1000 / 30;

/** Frames a measurement samples; its answer bounds the cheapest. */
const SAMPLES = 3;

/** The WebGL2 extension that times the GPU's work exactly. */
export const GPU_TIMER_EXTENSION = 'EXT_disjoint_timer_query_webgl2';

/**
 * @typedef {{lo: number, hi: number}} Bounds
 *   Milliseconds: the true value lies in `[lo, hi]` (equal when exact).
 */

/**
 * @typedef {{cpu: number, gpu: Bounds, frame: Bounds}} FrameCostSample
 *   One frame: the page's share (exact), the GPU's, and the frame time, the
 *   longer of the two.
 */

/**
 * @typedef {{gpu: Bounds, frame: Bounds, spread: number}} FrameCostAnswer
 *   A measurement's cheapest frame and its proven frame-to-frame spread
 *   (`answerOf`).
 */

/**
 * @typedef {'faster'|'not-faster'|'unresolved'} FrameCostVerdict
 */

/**
 * The frame time of a sample whose page share is `cpu` and whose GPU share
 * lies in `gpu`: a pipelined frame lasts the longer of the two.
 *
 * @param {number} cpu
 * @param {Bounds} gpu
 * @returns {FrameCostSample}
 */
export function sampleOf(cpu, gpu) {
  return Object.freeze({
    cpu,
    gpu: Object.freeze({ lo: gpu.lo, hi: gpu.hi }),
    frame: Object.freeze({ lo: Math.max(cpu, gpu.lo), hi: Math.max(cpu, gpu.hi) }),
  });
}

/**
 * A fence's sample: the frame began at `startedAt`, issued its last command
 * (and the fence) at `issuedAt`, was last seen unfinished at `unsignaledAt`
 * (`issuedAt` when the first poll found it done) and seen done at
 * `signaledAt`. The GPU's share is at most the whole time to `signaledAt`,
 * and at least the time to `unsignaledAt` less the page's share.
 *
 * @param {{startedAt: number, issuedAt: number, unsignaledAt: number, signaledAt: number}} times
 * @returns {FrameCostSample}
 */
export function fenceSampleOf({ startedAt, issuedAt, unsignaledAt, signaledAt }) {
  const cpu = issuedAt - startedAt;
  return sampleOf(cpu, { lo: Math.max(0, unsignaledAt - startedAt - cpu), hi: signaledAt - startedAt });
}

/**
 * The answer of a measurement's samples (module doc): the cheapest frame's
 * bounds and the spread the two cheapest prove.
 *
 * @param {readonly FrameCostSample[]} samples
 * @returns {FrameCostAnswer}
 */
export function answerOf(samples) {
  if (samples.length < 2) throw new RangeError('A frame-cost answer needs at least two samples.');
  const least = key => Object.freeze({
    lo: Math.min(...samples.map(sample => sample[key].lo)),
    hi: Math.min(...samples.map(sample => sample[key].hi)),
  });
  const [cheapest, next] = [...samples].sort((a, b) => a.frame.hi - b.frame.hi);
  return Object.freeze({
    gpu: least('gpu'),
    frame: least('frame'),
    spread: Math.max(0, next.frame.lo - cheapest.frame.hi),
  });
}

/**
 * Whether frames drawn with the automatic choice on (`chosen`) are faster
 * than the frames of every cell (`full`), from what their bounds prove
 * (module doc).
 *
 * @param {FrameCostAnswer} full
 * @param {FrameCostAnswer} chosen
 * @returns {FrameCostVerdict}
 */
export function verdictOf(full, chosen) {
  const spread = Math.max(full.spread, chosen.spread);
  if (full.frame.lo - chosen.frame.hi > spread) return 'faster';
  if (full.frame.hi - chosen.frame.lo <= spread) return 'not-faster';
  return 'unresolved';
}

/**
 * Whether a measurement of frames of every cell proves them too slow for
 * the levels of detail and culling to help: the GPU's share alone over the
 * budget.
 *
 * @param {FrameCostAnswer} answer
 */
export function isTooSlow(answer) {
  return answer.gpu.lo > INTERACTIVE_FRAME_BUDGET_MS;
}

/**
 * @param {object} options
 * @param {WebGL2RenderingContext} options.gl
 * @param {(answer: FrameCostAnswer) => void} options.onTooSlow - Called once
 *   per armed measurement of frames of every cell proven too slow
 *   (`isTooSlow`).
 * @param {(result: {verdict: FrameCostVerdict, answer: FrameCostAnswer, full: FrameCostAnswer}) => void} options.onVerified -
 *   Called once per `verify` with its verdict (`verdictOf`).
 * @param {() => void} options.requestFrame - Asks the viewer for one frame.
 * @param {() => number} [options.now]
 * @param {(callback: () => void) => unknown} [options.schedule] - Runs the
 *   callback in a later task.
 */
export function createFullDetailFrameCost({
  gl,
  onTooSlow,
  onVerified,
  requestFrame,
  now = () => performance.now(),
  schedule = callback => setTimeout(callback, 0),
}) {
  if (typeof onTooSlow !== 'function' || typeof onVerified !== 'function' || typeof requestFrame !== 'function') {
    throw new TypeError('The full-detail frame cost needs onTooSlow, onVerified and requestFrame callbacks.');
  }
  /** 'full' (frames of every cell), 'verify' (frames as the choice draws them), or null. */
  let phase = null;
  /** The frame being drawn and measured: `{startedAt, timer, query}`, between `frameStarted` and `frameEnded`. */
  let open = null;
  /** The sample being read: `{query, timer, cpu}` or `{fence, startedAt, issuedAt, unsignaledAt}`. */
  let pending = null;
  let samples = [];
  /** The answer of the opening's frames of every cell, for `verify`. */
  let fullAnswer = null;

  function settle(sample) {
    samples.push(sample);
    if (samples.length < SAMPLES) {
      requestFrame();
      return;
    }
    const answer = answerOf(samples);
    const measured = phase;
    phase = null;
    samples = [];
    if (measured === 'full') {
      fullAnswer = answer;
      if (isTooSlow(answer)) onTooSlow(answer);
      return;
    }
    onVerified({ verdict: verdictOf(fullAnswer, answer), answer, full: fullAnswer });
  }

  function deleteQuery(query) {
    if (!gl.isContextLost()) gl.deleteQuery(query);
  }

  function pollTimer(record) {
    if (pending !== record) return;
    if (gl.isContextLost()) {
      pending = null;
      return;
    }
    if (!gl.getQueryParameter(record.query, gl.QUERY_RESULT_AVAILABLE)) {
      schedule(() => pollTimer(record));
      return;
    }
    const disjoint = gl.getParameter(record.timer.GPU_DISJOINT_EXT);
    const nanoseconds = Number(gl.getQueryParameter(record.query, gl.QUERY_RESULT));
    gl.deleteQuery(record.query);
    pending = null;
    if (phase === null) return;
    if (disjoint) {
      // The GPU's clock was not continuous over the frame: no sample.
      requestFrame();
      return;
    }
    const milliseconds = nanoseconds / 1e6;
    settle(sampleOf(record.cpu, { lo: milliseconds, hi: milliseconds }));
  }

  function pollFence(record) {
    if (pending !== record) return;
    if (gl.isContextLost()) {
      pending = null;
      return;
    }
    // Taken before the fence is asked: unsignaled, the GPU finished after it.
    const polledAt = now();
    if (!fenceHasPassed(gl, record.fence)) {
      record.unsignaledAt = polledAt;
      schedule(() => pollFence(record));
      return;
    }
    const signaledAt = now();
    gl.deleteSync(record.fence);
    pending = null;
    if (phase !== null) settle(fenceSampleOf({ ...record, signaledAt }));
  }

  // The frame being drawn is not measured after all: its query ended and
  // given back (a query left open would refuse the next one).
  function closeOpen() {
    if (open === null) return;
    if (open.query !== null && !gl.isContextLost()) {
      gl.endQuery(open.timer.TIME_ELAPSED_EXT);
      gl.deleteQuery(open.query);
    }
    open = null;
  }

  function drop() {
    closeOpen();
    if (pending !== null && !gl.isContextLost()) {
      if (pending.fence !== undefined) gl.deleteSync(pending.fence);
      else deleteQuery(pending.query);
    }
    pending = null;
  }

  return Object.freeze({
    /** Measure afresh: a dataset's cells or their positions were published. */
    arm() {
      drop();
      samples = [];
      fullAnswer = null;
      phase = 'full';
    },
    /**
     * Levels of detail were turned on: the opening's choice is made (by a
     * person, a session, a caller), so nothing more is measured until the
     * next opening arms it, even if they are turned off again. The answer of
     * the frames of every cell is kept for `verify`.
     */
    disarm() {
      drop();
      samples = [];
      phase = null;
    },
    /**
     * Measure the frames drawn now (with the automatic choice on) against
     * the opening's frames of every cell (`onVerified`). Nothing to compare
     * with before that answer: no measurement.
     */
    verify() {
      drop();
      samples = [];
      phase = fullAnswer === null ? null : 'verify';
    },
    isArmed() {
      return phase !== null;
    },
    /**
     * Whether a sampled frame is still being read: once it is, the
     * measurement asks for its next frame (`requestFrame`), or answers,
     * which can turn levels of detail and culling on. A scene is not quiet
     * while it is (`getFrameScheduleState().settled`).
     */
    isSampling() {
      return phase !== null && pending !== null;
    },
    /** 'full', 'verify' or null: which frames are sampled now. */
    phase() {
      return phase;
    },
    /**
     * A frame begins at `startedAt`, before its first command: opened for
     * measurement when measuring and no sample is being read (with the GPU
     * timer, its query begins here).
     *
     * @param {number} startedAt
     */
    frameStarted(startedAt) {
      closeOpen();
      if (phase === null || pending !== null || gl.isContextLost()) return;
      // The timer, unless another owner's query is open (the benchmark's
      // pass profiler, `app/ui/modules/benchmark/pass-profiler.js`): queries
      // cannot nest, and the fence measures this frame instead.
      const timer = gl.getExtension(GPU_TIMER_EXTENSION);
      let query = null;
      if (timer !== null && gl.getQuery(timer.TIME_ELAPSED_EXT, gl.CURRENT_QUERY) === null) {
        query = gl.createQuery();
        if (query !== null) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
      }
      open = { startedAt, timer, query };
    },
    /**
     * The frame opened by `frameStarted` issued its last command. Sampled
     * when it is one the phase measures (`eligible`: every cell of every
     * presented pane drawn, for 'full'; any frame drawn with the choice in
     * effect, for 'verify'); a frame that was not drawn, or not eligible,
     * is not.
     *
     * @param {boolean} eligible
     */
    frameEnded(eligible) {
      if (open === null) return;
      if (!eligible || phase === null || gl.isContextLost()) {
        closeOpen();
        return;
      }
      const { startedAt, timer, query } = open;
      open = null;
      const issuedAt = now();
      if (query !== null) {
        gl.endQuery(timer.TIME_ELAPSED_EXT);
        const record = { query, timer, cpu: issuedAt - startedAt };
        pending = record;
        schedule(() => pollTimer(record));
        return;
      }
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!fence) return;
      gl.flush();
      // Until a poll finds it unsignaled, the GPU may have finished at once.
      const record = { fence, startedAt, issuedAt, unsignaledAt: issuedAt };
      pending = record;
      schedule(() => pollFence(record));
    },
    /** The context is gone: its fence or query with it (nothing to delete). */
    handleContextLost() {
      open = null;
      pending = null;
      samples = [];
    },
    dispose() {
      drop();
      phase = null;
    },
  });
}
