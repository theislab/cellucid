import assert from 'node:assert/strict';
import test from 'node:test';

import { OrbitAnchorRenderer } from '../assets/js/rendering/orbit-anchor.js';

function createRecordingGl() {
  const calls = [];
  let nextId = 1;
  let boundVao = null;
  const uniformNames = new Map();
  const gl = {
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    TRIANGLES: 0x0004,
    LINES: 0x0001,
    UNSIGNED_SHORT: 0x1403,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    NO_ERROR: 0,
    createShader: () => ({ id: nextId++ }),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => true,
    createProgram: () => ({ id: nextId++ }),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    detachShader() {},
    deleteShader() {},
    getError: () => 0,
    getAttribLocation: (_program, name) => ({ a_position: 0, a_normal: 1, a_color: 2 })[name],
    getUniformLocation(_program, name) {
      const location = { name };
      uniformNames.set(location, name);
      return location;
    },
    createBuffer: () => ({ id: nextId++ }),
    createVertexArray: () => ({ id: nextId++, vao: true }),
    bindVertexArray(vao) { boundVao = vao; calls.push(['bindVertexArray', vao]); },
    bindBuffer() {},
    bufferData(target, data) { calls.push(['bufferData', target, data.length]); },
    enableVertexAttribArray(location) { calls.push(['enable', boundVao, location]); },
    disableVertexAttribArray(location) { calls.push(['disable', boundVao, location]); },
    vertexAttribPointer() {},
    useProgram() {},
    uniformMatrix4fv(location, _transpose, value) {
      calls.push(['matrix', location.name, Array.from(value)]);
    },
    uniform1f() {},
    uniform3f() {},
    uniform3fv() {},
    enable() {},
    blendFuncSeparate() {},
    blendEquation() {},
    drawElements(mode, count, type, offset) {
      calls.push(['drawElements', boundVao, mode, count, type, offset]);
    },
    drawArrays(mode, first, count) {
      calls.push(['drawArrays', boundVao, mode, first, count]);
    },
  };
  return { calls, gl };
}

const identity = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function drawParams(overrides) {
  return {
    viewId: 'live',
    viewTheta: 0.25,
    viewPhi: 1.1,
    viewTarget: [1, 2, 3],
    viewRadius: 4,
    pointBoundsRadius: 2,
    bgColor: [0, 0, 0],
    use3D: true,
    mvpMatrix: identity,
    viewMatrix: identity,
    modelMatrix: identity,
    fogDensity: 0,
    lightingStrength: 0.6,
    lightDir: [0, 0, 1],
    navigationMode: 'orbit',
    ...overrides,
  };
}

function partMatrices(calls) {
  return calls
    .filter(call => call[0] === 'matrix' && call[1] === 'u_partMatrix')
    .map(call => call[2]);
}

test('orbit and target motion moves the anchor through uniforms without rebuilding geometry', () => {
  const { calls, gl } = createRecordingGl();
  const renderer = new OrbitAnchorRenderer(gl, {});

  renderer.draw(drawParams());
  const firstUploads = calls.filter(call => call[0] === 'bufferData');
  assert.equal(firstUploads.length, 7, 'the first draw uploads the mesh and the crosshair once');

  calls.length = 0;
  for (let frame = 1; frame <= 30; frame++) {
    renderer.draw(drawParams({
      viewTheta: 0.25 + frame * 0.05,
      viewPhi: 1.1 - frame * 0.02,
      viewTarget: [1 + frame, 2, 3 - frame],
      pointBoundsRadius: 2 + frame * 0.1,
    }));
  }
  assert.equal(
    calls.filter(call => call[0] === 'bufferData').length,
    0,
    'camera, target and bounds changes must not re-upload anchor geometry'
  );

  calls.length = 0;
  renderer.draw(drawParams({ viewTheta: 1.5, viewPhi: 0.4, viewTarget: [5, -1, 2] }));
  const [base, needle, baseAgain, marker] = partMatrices(calls);
  const r = renderer.computeAnchorRadius(2);
  const close = (actual, expected) => {
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      assert.ok(Math.abs(actual[i] - expected[i]) < 1e-6, `entry ${i}: ${actual[i]} vs ${expected[i]}`);
    }
  };
  close(base, [r, 0, 0, 0, 0, r, 0, 0, 0, 0, r, 0, 5, -1, 2, 1]);
  assert.deepEqual(baseAgain, base);
  const angle = 1.5 + Math.PI;
  close(needle, [
    Math.cos(angle) * r, 0, Math.sin(angle) * r, 0,
    0, r, 0, 0,
    -Math.sin(angle) * r, 0, Math.cos(angle) * r, 0,
    5, -1, 2, 1,
  ]);
  const elevation = 0.4 - Math.PI / 2;
  const arc = 0.82 * 0.78 * 0.68;
  close(marker, [
    r, 0, 0, 0, 0, r, 0, 0, 0, 0, r, 0,
    5 + arc * Math.cos(elevation) * r,
    -1 + arc * Math.sin(elevation) * r,
    2,
    1,
  ]);
});

test('the anchor rebuilds only for a shader-mode or palette change', () => {
  const { calls, gl } = createRecordingGl();
  const renderer = new OrbitAnchorRenderer(gl, {});
  renderer.draw(drawParams());
  calls.length = 0;
  // Luminance moves but stays dark: the palette and therefore the mesh are unchanged.
  renderer.draw(drawParams({ bgColor: [0.3, 0.3, 0.3] }));
  assert.equal(calls.filter(call => call[0] === 'bufferData').length, 0);
  renderer.draw(drawParams({ bgColor: [1, 1, 1] }));
  assert.equal(calls.filter(call => call[0] === 'bufferData').length, 7);
  calls.length = 0;
  renderer.draw(drawParams({ bgColor: [1, 1, 1], use3D: false }));
  assert.equal(
    calls.filter(call => call[0] === 'bufferData').length,
    4,
    'the flat compass has no crosshair line buffers'
  );
});

test('the anchor draws through its own vertex arrays and leaves none bound', () => {
  const { calls, gl } = createRecordingGl();
  const renderer = new OrbitAnchorRenderer(gl, {});
  renderer.draw(drawParams());
  renderer.draw(drawParams({ viewTheta: 2 }));
  const state = renderer.viewStates.get('live');
  for (const call of calls) {
    if (call[0] === 'enable' || call[0] === 'disable') {
      assert.ok(
        call[1] === state.meshVao || call[1] === state.lineVao,
        'attribute state must only change on the anchor’s own vertex arrays'
      );
    }
    if (call[0] === 'drawElements') assert.strictEqual(call[1], state.meshVao);
    if (call[0] === 'drawArrays') assert.strictEqual(call[1], state.lineVao);
  }
  assert.equal(calls.filter(call => call[0] === 'disable').length, 0);
  assert.deepEqual(calls.at(-1), ['bindVertexArray', null]);
  const draws = calls.filter(call => call[0] === 'drawElements');
  // Each frame draws the four build-order ranges back to back.
  const frame = draws.slice(-4);
  let expectedOffset = 0;
  for (const [, , , count, , offset] of frame) {
    assert.equal(offset, expectedOffset);
    expectedOffset += count * Uint16Array.BYTES_PER_ELEMENT;
  }
  assert.equal(expectedOffset, state.indexCount * Uint16Array.BYTES_PER_ELEMENT);
});
