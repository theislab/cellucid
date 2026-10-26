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
  );
}
