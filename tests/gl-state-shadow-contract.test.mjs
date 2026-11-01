/**
 * Fixed-function WebGL state is read from the context's state shadow
 * (`rendering/gl-state-shadow.js`), never asked of the context on a path
 * that runs per frame or per change.
 *
 * Measured with a 64 MB texture upload queued (tests/… see the module
 * overview): in Firefox and WebKit `isEnabled`, and `getParameter` of
 * ACTIVE_TEXTURE, VIEWPORT, SCISSOR_BOX, COLOR_WRITEMASK, the blend
 * functions and equations, COLOR_CLEAR_VALUE and the enable capabilities,
 * each waited 6–24 ms for the GPU process to run every queued command;
 * bindings and pixel-store parameters answered in 0 ms in every engine. The
 * backdrop look asked three of the waiting kind per pane per frame, the GPU
 * gather one per draw-order change.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { glStateOf, primeGlState } from '../assets/js/rendering/gl-state-shadow.js';

function fakeContext() {
  const queries = [];
  const state = new Map([
    [0x0be2, false], // BLEND
    [0x0b71, true], // DEPTH_TEST
  ]);
  const gl = {
    BLEND: 0x0be2,
    DEPTH_TEST: 0x0b71,
    SCISSOR_TEST: 0x0c11,
    ACTIVE_TEXTURE: 0x84e0,
    TEXTURE0: 0x84c0,
    VIEWPORT: 0x0ba2,
    BLEND_SRC_RGB: 0x80c9,
    BLEND_DST_RGB: 0x80c8,
    BLEND_SRC_ALPHA: 0x80cb,
    BLEND_DST_ALPHA: 0x80ca,
    ONE: 1,
    ZERO: 0,
    isEnabled(capability) {
      queries.push(`isEnabled:${capability}`);
      return state.get(capability) ?? false;
    },
    getParameter(name) {
      queries.push(`getParameter:${name}`);
      if (name === this.ACTIVE_TEXTURE) return this.TEXTURE0;
      if (name === this.VIEWPORT) return Int32Array.of(0, 0, 300, 150);
      return this.ONE;
    },
    enable(capability) { state.set(capability, true); },
    disable(capability) { state.set(capability, false); },
    activeTexture() {},
    viewport() {},
    blendFuncSeparate() {},
  };
  return { gl, queries };
}

test('a value is asked of the context at most once (all at once where the context is made), and setters keep it after', () => {
  const { gl, queries } = fakeContext();
  primeGlState(gl);
  const shadow = glStateOf(gl);
  const installed = [...queries];
  assert.ok(installed.includes(`isEnabled:${gl.DEPTH_TEST}`), 'read where the context is made');
  assert.equal(shadow.isEnabled(gl.DEPTH_TEST), true);
  assert.equal(shadow.isEnabled(gl.DEPTH_TEST), true);
  assert.deepEqual(queries, installed, 'nothing is asked after');
  // A generic vertex attribute is never asked: the initial value, or the last set.
  assert.deepEqual([...shadow.genericAttribute(1)], [0, 0, 0, 1]);
  gl.vertexAttribI4ui?.(1, 0, 0, 0, 0);
  if (typeof gl.vertexAttribI4ui === 'function') assert.ok(shadow.genericAttribute(1) instanceof Uint32Array);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.activeTexture(gl.TEXTURE0 + 2);
  gl.viewport(1, 2, 30, 40);
  gl.blendFuncSeparate(gl.ONE, gl.ZERO, gl.ZERO, gl.ONE);
  assert.equal(shadow.isEnabled(gl.DEPTH_TEST), false);
  assert.equal(shadow.isEnabled(gl.BLEND), true);
  assert.equal(shadow.activeTexture, gl.TEXTURE0 + 2);
  assert.deepEqual([...shadow.viewport], [1, 2, 30, 40]);
  assert.deepEqual(shadow.blendFunc, { srcRgb: gl.ONE, dstRgb: gl.ZERO, srcAlpha: gl.ZERO, dstAlpha: gl.ONE });
  assert.deepEqual(queries, installed, 'nothing else was asked of the context');
  // A copy: the caller cannot change the shadow.
  shadow.viewport[0] = 99;
  assert.equal(shadow.viewport[0], 1);
  // One shadow per context.
  assert.equal(glStateOf(gl), shadow);
});

const RENDERING = fileURLToPath(new URL('../assets/js/rendering/', import.meta.url));

function sources(directory) {
  return readdirSync(directory).flatMap(name => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return sources(full);
    return name.endsWith('.js') ? [full] : [];
  });
}

test('no renderer asks the context for state the shadow keeps', () => {
  const waiting = /(?<![\w.])(this\.)?gl\.isEnabled\(|(?<![\w.])(this\.)?gl\.getParameter\((this\.)?gl\.(ACTIVE_TEXTURE|VIEWPORT|SCISSOR_BOX|COLOR_WRITEMASK|COLOR_CLEAR_VALUE|BLEND\w*|DEPTH_TEST|DEPTH_WRITEMASK|CULL_FACE|SCISSOR_TEST|STENCIL_TEST|DITHER|RASTERIZER_DISCARD)\)/;
  const offenders = [];
  for (const file of sources(RENDERING)) {
    if (file.endsWith('gl-state-shadow.js')) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (waiting.test(line)) offenders.push(`${path.relative(RENDERING, file)}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('the viewer installs the shadow on its context, read whole, before drawing', () => {
  const viewer = readFileSync(path.join(RENDERING, 'viewer.js'), 'utf8');
  const created = viewer.indexOf("canvas.getContext('webgl2'");
  const installed = viewer.indexOf('primeGlState(gl);', created);
  const firstState = viewer.indexOf('createSceneMsaaTarget(gl)', created);
  assert.ok(created > 0 && installed > created && installed < firstState);
});
