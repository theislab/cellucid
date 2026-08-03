/**
 * WebGL point-draw state validation and baseline restoration.
 *
 * The renderer must leave the GL state machine exactly as it found it after
 * every point draw. These helpers assert a clean error queue, restore the
 * baseline bindings, and settle an operation error against a restoration error
 * without losing either one.
 */

// `CONTEXT_LOST_WEBGL`. Fixed by the WebGL specification, and read from the
// context when it exposes it so a conformant renaming cannot silently defeat the
// check below.
const CONTEXT_LOST_WEBGL = 0x9242;

function requireCleanWebGLState(gl, owner) {
  const errorCode = gl.getError();
  if (errorCode === gl.NO_ERROR) return;
  const contextLostCode = typeof gl.CONTEXT_LOST_WEBGL === 'number'
    ? gl.CONTEXT_LOST_WEBGL
    : CONTEXT_LOST_WEBGL;
  // A lost context answers `CONTEXT_LOST_WEBGL` from every call, including this
  // one, and keeps answering it. That is not dirty state a previous caller
  // leaked — it is the context being gone — and the renderer already owns a
  // fence for that, thrown by `_assertOperational` and identified by name.
  // Reporting it as an unexpected WebGL error turned a handled loss into an
  // unhandled page error whenever a publication began before the loss event was
  // delivered, which is the window a forced context loss lands in.
  if (errorCode === contextLostCode) {
    const lost = new Error(
      `${owner} cannot continue after its WebGL context was lost.`
    );
    lost.name = 'HighPerfRendererContextLostError';
    throw lost;
  }
  throw new Error(
    `${owner} encountered WebGL error 0x${errorCode.toString(16)}.`
  );
}

function restorePointDrawBaseline(gl, detachElementBuffer) {
  let failures = null;
  if (detachElementBuffer) {
    try {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    } catch (error) {
      failures = [error];
    }
  }
  try {
    gl.bindVertexArray(null);
  } catch (error) {
    if (failures === null) failures = [error];
    else failures.push(error);
  }
  try {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
  } catch (error) {
    if (failures === null) failures = [error];
    else failures.push(error);
  }
  try {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  } catch (error) {
    if (failures === null) failures = [error];
    else failures.push(error);
  }
  if (failures !== null) {
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(
      failures,
      'HighPerfRenderer point-draw baseline restoration failed.'
    );
  }
}

function settlePointDraw(operationError, restorationError, owner) {
  if (operationError !== null) {
    if (restorationError !== null) {
      const restorationFailures =
        restorationError instanceof AggregateError
          ? restorationError.errors
          : null;
      throw new AggregateError(
        restorationFailures === null
          ? [operationError, restorationError]
          : [operationError, ...restorationFailures],
        `${owner} and baseline restoration both failed.`
      );
    }
    throw operationError;
  }
  if (restorationError !== null) throw restorationError;
}

export {
  requireCleanWebGLState,
  restorePointDrawBaseline,
  settlePointDraw,
};
