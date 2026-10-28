import { countNoun } from '../utils/format-units.js';
/**
 * The one WebGL error boundary every renderer uses.
 *
 * A lost context is a terminal condition the viewer already owns a fence for,
 * not a defect: the frame loop stops, the GPU ownership graph is retired, and
 * only a reload builds a coherent replacement. It has to stay recognisable as
 * that everywhere, and `getError()` alone cannot guarantee it: the
 * specification reports `CONTEXT_LOST_WEBGL` once and `NO_ERROR` afterwards, so
 * whichever check happens to read it first would be the only one to see it.
 * `isContextLost()` answers for as long as the loss lasts, so it is asked first;
 * the error code still identifies the loss to whichever reader drains it.
 */

// `CONTEXT_LOST_WEBGL`, fixed by the specification. Read from the context when
// it exposes it, so a conformant renaming cannot defeat the check.
const CONTEXT_LOST_WEBGL = 0x9242;

// One read clears one error flag; no context holds more than a handful.
const MAX_PENDING_WEBGL_ERRORS = 32;

/** The name every refusal to work on a lost context carries. */
export const CONTEXT_LOST_ERROR_NAME = 'WebGLContextLostError';

/**
 * Whether this is a refusal to work on a context that is gone. Callers driven
 * by a platform callback — a frame, a resize — use it to tell that condition
 * apart from a real failure, because rethrowing it there reaches
 * `window.onerror` and reports a handled loss as a crash.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isContextLostError(error) {
  return error instanceof Error && error.name === CONTEXT_LOST_ERROR_NAME;
}

/**
 * @param {string} owner
 * @returns {Error} The recognisable refusal for `owner`.
 */
export function contextLostError(owner) {
  const error = new Error(
    `${owner} cannot continue after its WebGL context was lost.`
  );
  error.name = CONTEXT_LOST_ERROR_NAME;
  return error;
}

/**
 * Require an operational context, without reading the error queue.
 *
 * For writes into storage WebGL has already accepted (a sub-upload, a
 * transform-feedback pass into an allocated buffer): with the arguments
 * validated, such a write fails only when the context is gone, and
 * `getError()` is a synchronous round trip to the GPU process that waits for
 * every queued command -- the previous frame's point draws included. A filter
 * tick at 10M points in four views spent 40 ms of 75 ms there. Allocations
 * keep their check (`OUT_OF_MEMORY` lives there).
 *
 * @param {WebGL2RenderingContext} gl
 * @param {string} owner - Names the operation in the error.
 */
export function requireLiveContext(gl, owner) {
  if (typeof gl.isContextLost === 'function' && gl.isContextLost()) {
    throw contextLostError(owner);
  }
}

/**
 * Read the error queue empty, discarding what it held: after a failure that
 * is already being reported, so what that failure's clean-up raised is not
 * reported again under the next check's name.
 *
 * @param {WebGL2RenderingContext} gl
 */
export function drainWebGLErrors(gl) {
  for (let read = 0; read < MAX_PENDING_WEBGL_ERRORS && gl.getError() !== gl.NO_ERROR; read++);
}

/**
 * Require an operational context with an empty error queue.
 *
 * Throws the recognisable context-loss refusal when the context is gone, and an
 * ordinary error naming every pending code otherwise.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {string} owner - Names the operation in the error.
 */
export function requireCleanWebGLState(gl, owner) {
  if (
    gl === null ||
    typeof gl !== 'object' ||
    typeof gl.getError !== 'function' ||
    !Number.isInteger(gl.NO_ERROR)
  ) {
    throw new TypeError(`${owner} requires a complete WebGL error boundary.`);
  }
  if (typeof gl.isContextLost === 'function' && gl.isContextLost()) {
    throw contextLostError(owner);
  }
  const codes = [];
  for (let read = 0; read < MAX_PENDING_WEBGL_ERRORS; read++) {
    const code = gl.getError();
    // Each read clears the flag it reports, so a repeated code means nothing
    // further is pending.
    if (code === gl.NO_ERROR || codes.includes(code)) break;
    codes.push(code);
  }
  if (codes.length === 0) return;
  const contextLostCode = typeof gl.CONTEXT_LOST_WEBGL === 'number'
    ? gl.CONTEXT_LOST_WEBGL
    : CONTEXT_LOST_WEBGL;
  if (codes.includes(contextLostCode)) throw contextLostError(owner);
  throw new Error(
    `${owner} encountered WebGL ${countNoun(codes.length, 'error')} `
      + codes.map(code => `0x${code.toString(16)}`).join(', ')
      + '.'
      + outstandingDeferredChecksNote(gl)
  );
}

/**
 * A WebGL error code, in hex and by name.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {number} code
 * @returns {string}
 */
export function describeWebGLError(gl, code) {
  const name = ['INVALID_ENUM', 'INVALID_VALUE', 'INVALID_OPERATION', 'OUT_OF_MEMORY', 'INVALID_FRAMEBUFFER_OPERATION']
    .find(key => gl[key] === code);
  return `0x${code.toString(16)}${name ? ` (${name})` : ''}`;
}

// ============================================================================
// DEFERRED CHECKS
//
// `getError()` waits for the GPU process to run every queued command, and on
// Firefox and WebKit for the GPU itself: read after a transform-feedback
// write of 10M points it cost 10-13 ms of main thread there (Chromium under
// 1 ms). A write made often -- highlight words at every highlight change, a
// draw order adopted band by band in every frame -- is therefore checked
// later instead: a fence is put after it, and once the GPU has passed the
// fence (polled each frame, which never waits) the error queue is read; the
// read then waits for nothing. A failure is never silent: it goes to the
// batch's `onError`, named by the batch's own `diagnose` (the batch run again
// with every call checked).
//
// Between the batch and its check another reader may take the error first
// (an allocation's check, `requireCleanWebGLState`); such a reader's error
// names the batches whose checks were still outstanding.
// ============================================================================

/** Outstanding deferred checks of each context, earliest first. */
const deferredChecks = new WeakMap();

/**
 * Check the error queue for the WebGL calls just made (a batch) without
 * waiting for them: a fence goes after them, and the queue is read in a later
 * frame, once the GPU has passed it.
 *
 * When the read finds an error, every batch still outstanding is a suspect:
 * each one's `diagnose` runs, earliest first, until one throws an error naming
 * its failing call, and that batch's `onError` receives it, saying which
 * batches the read covered. When none names a call, the earliest batch's
 * `onError` receives the code and the batches it covers.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {{
 *   label: string,
 *   owner?: object,
 *   diagnose?: () => (boolean|void),
 *   onError: (error: Error) => void,
 *   readAfter?: () => boolean,
 * }} batch - `label` names the batch; `diagnose` runs it again with every
 *   call checked and throws an error naming the call that fails, returns
 *   false when it cannot run again (what it wrote into or read from is gone),
 *   and returns otherwise; `owner` lets `cancelDeferredWebGLErrorChecks`
 *   drop the owner's batches; `readAfter`, when given, holds the read until
 *   it answers true (a run of batches read once, at its end: in Chromium the
 *   read is a round trip that waits for every command queued before it, a
 *   whole frame of a 100M-point view, even once the fence has passed).
 */
export function deferWebGLErrorCheck(gl, batch) {
  if (typeof batch?.onError !== 'function' || typeof batch.label !== 'string') {
    throw new TypeError('A deferred WebGL error check needs a label and an onError.');
  }
  const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (fence === null) {
    // No fence: the check is made now (the context is lost, or refused one).
    const code = gl.getError();
    if (code !== gl.NO_ERROR) reportDeferredFailure(gl, [{ ...batch, fence: null }], code);
    return;
  }
  // The fence only signals once the commands before it reach the GPU.
  gl.flush();
  let state = deferredChecks.get(gl);
  if (state === undefined) {
    state = { batches: [], scheduled: false };
    deferredChecks.set(gl, state);
  }
  state.batches.push({ ...batch, fence });
  scheduleDeferredPoll(gl, state);
}

/**
 * Drop the outstanding checks `owner` made (it is disposed), or every one of
 * the context's when `owner` is not given.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} [owner]
 */
export function cancelDeferredWebGLErrorChecks(gl, owner) {
  const state = deferredChecks.get(gl);
  if (state === undefined) return;
  const kept = [];
  for (const batch of state.batches) {
    if (owner === undefined || batch.owner === owner) deleteFence(gl, batch.fence);
    else kept.push(batch);
  }
  state.batches = kept;
}

/**
 * Hand an error a synchronous check read, and did not raise itself (its own
 * calls run again raised nothing), to the outstanding deferred checks: they
 * are checked now. Returns whether there were any to take it.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {number} code
 * @returns {boolean}
 */
export function claimWebGLErrorForDeferredChecks(gl, code) {
  const state = deferredChecks.get(gl);
  if (state === undefined || state.batches.length === 0) return false;
  const batches = state.batches;
  state.batches = [];
  reportDeferredFailure(gl, batches, code);
  return true;
}

/** The labels of the outstanding deferred checks, for an error message. */
function outstandingDeferredChecksNote(gl) {
  const batches = deferredChecks.get(gl)?.batches ?? [];
  if (batches.length === 0) return '';
  return ` Checks deferred after ${batches.map(batch => batch.label).join('; ')} were still outstanding: the error may be theirs.`;
}

function scheduleDeferredPoll(gl, state) {
  if (state.scheduled) return;
  state.scheduled = true;
  const poll = () => pollDeferredChecks(gl, state);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(poll);
  else setTimeout(poll, 16);
}

function pollDeferredChecks(gl, state) {
  state.scheduled = false;
  if (state.batches.length === 0) return;
  if (typeof gl.isContextLost === 'function' && gl.isContextLost()) {
    // The loss has its own fence and report; nothing on the GPU is checked.
    state.batches = [];
    return;
  }
  // A batch whose run is not over yet holds the read (`readAfter`).
  if (state.batches.some(batch => typeof batch.readAfter === 'function' && batch.readAfter() !== true)) {
    scheduleDeferredPoll(gl, state);
    return;
  }
  // `getSyncParameter` answers from the page's copy of the fence's status,
  // which the browser updates between tasks: it never waits.
  if (gl.getSyncParameter(state.batches[0].fence, gl.SYNC_STATUS) !== gl.SIGNALED) {
    scheduleDeferredPoll(gl, state);
    return;
  }
  let passed = 1;
  while (passed < state.batches.length
    && gl.getSyncParameter(state.batches[passed].fence, gl.SYNC_STATUS) === gl.SIGNALED) passed++;
  // The GPU has run the batches before the fence. The read is still a round
  // trip in Chromium, which waits for the commands queued since.
  const code = gl.getError();
  if (code === gl.NO_ERROR) {
    for (const batch of state.batches.splice(0, passed)) deleteFence(gl, batch.fence);
  } else {
    // Batches after the last fence passed may have raised it too (their calls
    // were validated when they were made): every outstanding one is a suspect.
    const batches = state.batches;
    state.batches = [];
    reportDeferredFailure(gl, batches, code);
  }
  if (state.batches.length > 0) scheduleDeferredPoll(gl, state);
}

function reportDeferredFailure(gl, batches, code) {
  for (const batch of batches) deleteFence(gl, batch.fence);
  drainWebGLErrors(gl);
  const covers = `a deferred check after ${batches.map(batch => batch.label).join('; ')}`;
  let culprit = null;
  let named = null;
  const notRun = [];
  for (const batch of batches) {
    if (typeof batch.diagnose !== 'function') {
      notRun.push(batch.label);
      continue;
    }
    try {
      if (batch.diagnose() === false) notRun.push(batch.label);
    } catch (error) {
      culprit = batch;
      named = error;
      break;
    }
  }
  if (culprit !== null) {
    const error = new Error(`${named.message} (found by ${covers}).`, { cause: named });
    if (named.name === CONTEXT_LOST_ERROR_NAME) error.name = CONTEXT_LOST_ERROR_NAME;
    culprit.onError(error);
    return;
  }
  const ran = batches.length - notRun.length;
  batches[0].onError(new Error(
    `${covers} read WebGL error ${describeWebGLError(gl, code)}`
      + (notRun.length > 0
        ? `; ${notRun.join('; ')} could not be run again (what ${notRun.length === 1 ? 'it' : 'they'} wrote or read is gone)`
        : '')
      + (ran > 0
        ? `; run again with every call checked, ${ran === batches.length ? 'none' : 'none of the others'} raised it`
        : '')
      + (notRun.length === 0 ? ': a call made after them did.' : '.')
  ));
}

function deleteFence(gl, fence) {
  if (fence !== null) gl.deleteSync(fence);
}
