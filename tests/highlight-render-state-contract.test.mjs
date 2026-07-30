import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighlightRenderer,
} from '../assets/js/rendering/highlight-renderer.js';

test('highlight draw restores the renderer-owned depth mask after an intermediate failure', () => {
  const depthMasks = [];
  const vertexArrayBindings = [];
  const gl = {
    BLEND: 0x0be2,
    DEPTH_TEST: 0x0b71,
    FUNC_ADD: 0x8006,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    SRC_ALPHA: 0x0302,
    blendEquation(equation) {
      assert.equal(equation, this.FUNC_ADD);
    },
    blendFuncSeparate(sourceRgb, destinationRgb, sourceAlpha, destinationAlpha) {
      assert.equal(sourceRgb, this.SRC_ALPHA);
      assert.equal(destinationRgb, this.ONE_MINUS_SRC_ALPHA);
      assert.equal(sourceAlpha, this.ONE);
      assert.equal(destinationAlpha, this.ONE_MINUS_SRC_ALPHA);
    },
    bindVertexArray(vertexArray) {
      vertexArrayBindings.push(vertexArray);
    },
    depthMask(enabled) {
      depthMasks.push(enabled);
    },
    enable(capability) {
      assert.ok(
        capability === this.DEPTH_TEST ||
        capability === this.BLEND,
      );
    },
    useProgram() {
      throw new Error('synthetic highlight shader failure');
    },
  };
  const renderer = Object.assign(
    Object.create(HighlightRenderer.prototype),
    {
      _viewBuffers: new Map([
        ['live', {
          buffer: {},
          pointCount: 1,
          vertexArray: {},
        }],
      ]),
      gl,
      program: {},
    },
  );

  assert.throws(
    () => renderer.draw({
      dimensionLevel: 3,
      viewId: 'live',
    }),
    /synthetic highlight shader failure/,
  );
  assert.deepEqual(depthMasks, [false, true]);
  assert.deepEqual(vertexArrayBindings, [null]);

  assert.doesNotThrow(
    () => renderer.draw({
      dimensionLevel: 3,
      viewId: 'live',
    }),
    'the exact failed draw generation must be fenced on later animation frames',
  );
  assert.deepEqual(depthMasks, [false, true]);
  assert.deepEqual(vertexArrayBindings, [null]);

  renderer._styleGeneration = 1;
  assert.throws(
    () => renderer.draw({
      dimensionLevel: 3,
      viewId: 'live',
    }),
    /synthetic highlight shader failure/,
    'a meaningful style generation must enable one new attempt',
  );
  assert.deepEqual(depthMasks, [false, true, false, true]);
  assert.deepEqual(vertexArrayBindings, [null, null]);
});

test('highlight animation frames bind only the preconfigured per-view VAO', () => {
  const vertexArray = { id: 'live-highlight-vao' };
  const vertexArrayBindings = [];
  const depthMasks = [];
  let drawCalls = 0;
  const gl = {
    BLEND: 0x0be2,
    DEPTH_TEST: 0x0b71,
    FUNC_ADD: 0x8006,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    POINTS: 0,
    SRC_ALPHA: 0x0302,
    bindBuffer() {
      throw new Error(
        'highlight animation frames must not bind attribute buffers'
      );
    },
    bindVertexArray(candidate) {
      vertexArrayBindings.push(candidate);
    },
    blendEquation() {},
    blendFuncSeparate() {},
    depthMask(value) {
      depthMasks.push(value);
    },
    drawArrays(mode, first, count) {
      assert.equal(mode, this.POINTS);
      assert.equal(first, 0);
      assert.equal(count, 2);
      drawCalls++;
    },
    enable() {},
    enableVertexAttribArray() {
      throw new Error(
        'highlight animation frames must not enable attributes'
      );
    },
    uniform1f() {},
    uniform3fv() {},
    uniformMatrix4fv() {},
    useProgram() {},
    vertexAttribPointer() {
      throw new Error(
        'highlight animation frames must not configure attributes'
      );
    },
  };
  const renderer = Object.assign(
    Object.create(HighlightRenderer.prototype),
    {
      _viewBuffers: new Map([
        ['live', {
          buffer: { id: 'live-highlight-buffer' },
          pointCount: 2,
          vertexArray,
        }],
      ]),
      gl,
      highlightColor: [0.4, 0.85, 1],
      highlightHaloShape: 0,
      highlightHaloStrength: 0.7,
      highlightRingStyle: 0,
      highlightRingWidth: 0.4,
      highlightScale: 1.8,
      hpRenderer: {
        getCurrentLODSizeMultiplier() {
          return 1;
        },
        getFogFar() {
          return 100;
        },
        getFogNear() {
          return 1;
        },
      },
      program: {},
      startTime: performance.now(),
      uniformLocations: {
        fogColor: null,
        fogDensity: null,
        fogFar: null,
        fogNear: null,
        fov: null,
        haloShape: null,
        haloStrength: null,
        highlightColor: null,
        highlightScale: null,
        lightDir: null,
        lightingStrength: null,
        modelMatrix: null,
        mvpMatrix: null,
        pointSize: null,
        projectionMatrix: null,
        ringStyle: null,
        ringWidth: null,
        sizeAttenuation: null,
        time: null,
        viewMatrix: null,
        viewportHeight: null,
      },
    },
  );
  const params = {
    dimensionLevel: 3,
    fogColor: [0, 0, 0],
    fogDensity: 0,
    fov: 45,
    lightDir: [0, 0, 1],
    lightingStrength: 0,
    modelMatrix: new Float32Array(16),
    mvpMatrix: new Float32Array(16),
    pointSize: 1,
    projectionMatrix: new Float32Array(16),
    sizeAttenuation: 0,
    viewId: 'live',
    viewMatrix: new Float32Array(16),
    viewportHeight: 100,
  };

  renderer.draw(params);
  renderer.draw(params);

  assert.equal(drawCalls, 2);
  assert.deepEqual(
    vertexArrayBindings,
    [vertexArray, null, vertexArray, null]
  );
  assert.deepEqual(depthMasks, [false, true, false, true]);
});
