/**
 * The `sculpted` shader quality: soft studio-lit, antialiased sphere
 * impostors whose centre shows the legend colour, drawn opaque so the edge can
 * be a multisample coverage mask with depth on, and a selection that holds
 * still.
 *
 * The pixels are checked in the browser suite; this file pins the contracts
 * around them that a refactor could break without changing a pixel on the
 * machine it was run on.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enterOpaquePointBlending,
  restorePointDrawBaseline,
} from '../assets/js/rendering/high-perf/gl-point-draw-state.js';
import { HighlightRenderer } from '../assets/js/rendering/highlight-renderer.js';
import {
  DEFAULT_SHADER_QUALITY,
  describeShaderQualities,
  isShaderQuality,
  SHADER_QUALITIES,
  SHADER_QUALITY_TRAITS,
} from '../assets/js/rendering/shader-quality.js';
import {
  HIGHLIGHT_STYLES_BY_QUALITY,
  HP_FS_SCULPTED,
  HP_FS_SCULPTED_NO_DEPTH,
  sculptedCenterShade,
  writePointShaderFrame,
} from '../assets/js/rendering/shaders/high-perf-shaders.js';

test('one list names every quality, the default first and unchanged', () => {
  assert.deepEqual(SHADER_QUALITIES, ['full', 'sculpted', 'light', 'ultralight']);
  assert.equal(DEFAULT_SHADER_QUALITY, 'full');
  assert.equal(SHADER_QUALITIES[0], DEFAULT_SHADER_QUALITY);
  assert.ok(isShaderQuality('sculpted'));
  assert.ok(!isShaderQuality('studio'));
  assert.equal(
    describeShaderQualities(),
    '"full", "sculpted", "light", or "ultralight"'
  );
  assert.deepEqual(Object.keys(SHADER_QUALITY_TRAITS).sort(), [...SHADER_QUALITIES].sort());
  assert.deepEqual(Object.keys(HIGHLIGHT_STYLES_BY_QUALITY).sort(), [...SHADER_QUALITIES].sort());
});

test('a sculpted sphere centre shows exactly the legend colour', () => {
  // The fragment shader multiplies its lighting by u_invCenterShade, which
  // writePointShaderFrame derives from the same constants the shader is built
  // from, so the lighting is exactly one at the normal (0, 0, 1).
  const frame = {
    modelView: new Float32Array(16),
    halfDir: new Float32Array(3),
    invCenterShade: 0,
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const length = Math.hypot(0.5, 0.7, 0.5);
  const lightDir = [0.5 / length, 0.7 / length, 0.5 / length];
  writePointShaderFrame(frame, identity, identity, lightDir, 800, 1);
  assert.equal(frame.invCenterShade, 1 / sculptedCenterShade(lightDir));

  // Linear light is the square of the display value and is encoded back with
  // a square root, so the round trip of a lit-by-one colour is exact.
  for (const source of [HP_FS_SCULPTED, HP_FS_SCULPTED_NO_DEPTH]) {
    assert.match(source, /vec3 albedo = v_color \* v_color;/);
    assert.match(source, /vec3 shaded = sqrt\(lit\);/);
    assert.match(source, /sculptedShade\(normal, sky\) \* u_invCenterShade/);
    // The gloss fades in from the vertex shader's sprite radius, never from
    // screen-space derivatives, which are undefined along a sprite's edge.
    assert.doesNotMatch(source, /\bfwidth\(|\bdFd[xy]\(/);
  }
});

test('the sculpted depth pass antialiases through a coverage mask, never a blended rim', () => {
  assert.match(HP_FS_SCULPTED, /if \(v_alpha < 0\.01 \|\| coverage <= u_coverageFloor\) discard;/);
  // Single-sampled it writes full alpha; multisampled the coverage feeds
  // SAMPLE_ALPHA_TO_COVERAGE.
  assert.match(HP_FS_SCULPTED, /u_coverageFloor > 0\.0 \? 1\.0 : coverage/);
  assert.doesNotMatch(HP_FS_SCULPTED_NO_DEPTH, /\bdiscard\b/);
});

function recordingGl() {
  const calls = [];
  const gl = {
    BLEND: 0x0be2,
    FUNC_ADD: 0x8006,
    ONE: 1,
    ZERO: 0,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    SAMPLE_ALPHA_TO_COVERAGE: 0x809e,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE_2D: 0x0de1,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    calls,
  };
  for (const name of [
    'enable', 'disable', 'blendEquation', 'blendFuncSeparate',
    'bindBuffer', 'bindVertexArray', 'activeTexture', 'bindTexture',
  ]) {
    gl[name] = (...args) => calls.push([name, ...args]);
  }
  return gl;
}

test('the opaque pass state is entered per draw and fully undone after it', () => {
  for (const multisampled of [true, false]) {
    const gl = recordingGl();
    enterOpaquePointBlending(gl, multisampled);
    assert.deepEqual(gl.calls, [
      ['enable', gl.BLEND],
      ['blendEquation', gl.FUNC_ADD],
      ['blendFuncSeparate', gl.ONE, gl.ZERO, gl.ONE, gl.ONE_MINUS_SRC_ALPHA],
      [multisampled ? 'enable' : 'disable', gl.SAMPLE_ALPHA_TO_COVERAGE],
    ]);
  }

  const gl = recordingGl();
  restorePointDrawBaseline(gl, false, true);
  assert.deepEqual(gl.calls.slice(0, 4), [
    ['disable', gl.SAMPLE_ALPHA_TO_COVERAGE],
    ['enable', gl.BLEND],
    ['blendEquation', gl.FUNC_ADD],
    ['blendFuncSeparate', gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA],
  ]);

  // Every other program leaves the blend state alone.
  const untouched = recordingGl();
  restorePointDrawBaseline(untouched, false, false);
  assert.ok(!untouched.calls.some(([name]) => name.startsWith('blend')));
});

test('only an animated highlight style keeps the viewer drawing', () => {
  const renderer = Object.assign(Object.create(HighlightRenderer.prototype), {
    _styleGeneration: 0,
    _totalHighlightedCount: 5,
    highlightStylesByQuality: HIGHLIGHT_STYLES_BY_QUALITY,
  });
  const animated = {};
  for (const quality of SHADER_QUALITIES) {
    renderer.setQuality(quality);
    animated[quality] = renderer.isAnimated();
  }
  // `sculpted` draws the same 3-D torus as `full`, held still.
  assert.deepEqual(animated, {
    full: true,
    sculpted: false,
    light: false,
    ultralight: false,
  });
  assert.equal(
    HIGHLIGHT_STYLES_BY_QUALITY.sculpted.ringStyle,
    HIGHLIGHT_STYLES_BY_QUALITY.full.ringStyle
  );

  renderer._totalHighlightedCount = 0;
  renderer.setQuality('full');
  assert.equal(renderer.isAnimated(), false, 'nothing highlighted, nothing to animate');
});
