/**
 * WebGL point-draw state validation and baseline restoration.
 *
 * The renderer must leave the GL state machine exactly as it found it after
 * every point draw. These helpers assert a clean error queue, restore the
 * baseline bindings, and settle an operation error against a restoration error
 * without losing either one.
 */

function requireCleanWebGLState(gl, owner) {
  const errorCode = gl.getError();
  if (errorCode !== gl.NO_ERROR) {
    throw new Error(
      `${owner} encountered WebGL error 0x${errorCode.toString(16)}.`
    );
  }
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
