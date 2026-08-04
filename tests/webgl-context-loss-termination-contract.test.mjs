/**
 * @fileoverview A lost WebGL context is a handled ending, not a crash.
 *
 * Two places refuse to work on a context that is gone: `_assertOperational()`
 * in the renderer, through `HighPerfRendererContextLostError`, and
 * `requireCleanWebGLState()`, which sees `CONTEXT_LOST_WEBGL` come back from
 * `getError()` and cannot construct that class — it lives in the module that
 * imports it. So the two agree on a name instead, and the frame loop tests
 * against that name to tell a handled loss from a defect.
 *
 * That agreement was prose. Nothing executed it, and nothing caught the
 * refusal: a context lost between a frame starting and `webglcontextlost` being
 * delivered reached the GL preflight, and the refusal escaped the animation
 * callback to `window.onerror`. It surfaced as an intermittent
 * `viewer-terminal-disposal` failure — a page error asserted absent, present —
 * on one engine at a time, because it needs the loss to land inside that
 * window.
 *
 * This file holds the halves together: both producers stay recognisable to the
 * one predicate the frame loop uses, and an ordinary GL error stays
 * unrecognised, because absorbing one of those at a frame boundary would bury a
 * real defect instead of a handled ending.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTEXT_LOST_ERROR_NAME,
  isContextLostError,
  requireCleanWebGLState,
} from '../assets/js/rendering/high-perf/gl-point-draw-state.js';
import {
  HighPerfRendererContextLostError,
} from '../assets/js/rendering/high-perf-renderer.js';

/** The specification's own value, so a fixture cannot drift from the code. */
const CONTEXT_LOST_WEBGL = 0x9242;

function glReporting(errorCode, { exposeConstant = true } = {}) {
  const gl = {
    NO_ERROR: 0,
    getError: () => errorCode,
  };
  if (exposeConstant) gl.CONTEXT_LOST_WEBGL = CONTEXT_LOST_WEBGL;
  return gl;
}

test('the renderer fence is recognised by the frame loop predicate', () => {
  const error = new HighPerfRendererContextLostError('publish colors');
  assert.equal(error.name, CONTEXT_LOST_ERROR_NAME);
  assert.equal(
    isContextLostError(error),
    true,
    'the class the renderer throws must be the condition the frame loop '
      + 'absorbs, or a handled loss reaches window.onerror as a crash',
  );
});

test('the GL preflight refusal is recognised by the same predicate', () => {
  // The other producer. It cannot import the class above, so this is the only
  // thing keeping the two ends of the contract on the same name.
  assert.throws(
    () => requireCleanWebGLState(glReporting(CONTEXT_LOST_WEBGL), 'a draw'),
    error => {
      assert.equal(
        isContextLostError(error),
        true,
        'a preflight that met a lost context must raise the same recognisable '
          + 'condition the renderer does',
      );
      assert.match(error.message, /after its WebGL context was lost/);
      return true;
    },
  );
});

test('a context that hides the constant is still recognised', () => {
  // `requireCleanWebGLState` reads the value off the context when it is there
  // and falls back to the specification's. Both paths must classify.
  assert.throws(
    () => requireCleanWebGLState(
      glReporting(CONTEXT_LOST_WEBGL, { exposeConstant: false }),
      'a draw',
    ),
    error => isContextLostError(error),
  );
});

test('an ordinary WebGL error is not a context loss', () => {
  // INVALID_OPERATION. Absorbing this at a frame boundary would silence a real
  // defect, so the predicate has to say no.
  assert.throws(
    () => requireCleanWebGLState(glReporting(0x0502), 'a draw'),
    error => {
      assert.equal(
        isContextLostError(error),
        false,
        'only a lost context is a handled ending; every other GL error is a '
          + 'defect and must keep propagating',
      );
      assert.match(error.message, /encountered WebGL error 0x502/);
      return true;
    },
  );
});

test('the predicate refuses look-alikes', () => {
  const impostor = new Error('cannot continue after its WebGL context was lost.');
  assert.equal(
    isContextLostError(impostor),
    false,
    'the message is not the marker; a coincidental sentence must not be '
      + 'absorbed as a terminal condition',
  );
  for (const value of [null, undefined, 'lost', { name: CONTEXT_LOST_ERROR_NAME }]) {
    assert.equal(
      isContextLostError(value),
      false,
      `${JSON.stringify(value)} is not an Error`,
    );
  }
});

test('a clean error queue raises nothing', () => {
  assert.doesNotThrow(() => requireCleanWebGLState(glReporting(0), 'a draw'));
});
