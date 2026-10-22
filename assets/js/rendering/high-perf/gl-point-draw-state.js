/**
 * WebGL point-draw state validation and baseline restoration.
 *
 * The renderer must leave the GL state machine exactly as it found it after
 * every point draw. These helpers restore the baseline bindings and settle an
 * operation error against a restoration error without losing either one; the
 * error queue itself is checked by `requireCleanWebGLState` in `../gl-errors.js`.
 */

import { configureStraightAlphaBlending } from '../gl-utils.js';

/**
 * The blend state an opaque point pass draws with (see HP_FS_SCULPTED): the
 * colour replaces what is there, alpha composites "over" what is there (so an
 * opaque target stays opaque and a transparent export canvas gains the
 * point's coverage), and with multisampling the fragment's disc coverage
 * becomes its sample mask.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {boolean} multisampled - Whether the bound target has samples to mask.
 */
function enterOpaquePointBlending(gl, multisampled) {
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFuncSeparate(gl.ONE, gl.ZERO, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  if (multisampled) {
    gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  } else {
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  }
}

function restorePointDrawBaseline(gl, detachElementBuffer, opaquePass = false) {
  let failures = null;
  if (opaquePass) {
    // Back to the straight-alpha baseline every other pass assumes.
    try {
      gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      configureStraightAlphaBlending(gl);
    } catch (error) {
      failures = [error];
    }
  }
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
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  } catch (error) {
    if (failures === null) failures = [error];
    else failures.push(error);
  }
  try {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
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
  enterOpaquePointBlending,
  restorePointDrawBaseline,
  settlePointDraw,
};
