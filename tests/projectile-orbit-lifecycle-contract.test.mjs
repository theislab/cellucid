import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OrbitAnchorRenderer,
} from '../assets/js/rendering/orbit-anchor.js';
import {
  createProjectileSystem,
} from '../assets/js/rendering/projectiles.js';

const vec3 = {
  create: () => new Float32Array(3),
  clone: value => Float32Array.from(value),
  add(out, a, b) {
    out[0] = a[0] + b[0];
    out[1] = a[1] + b[1];
    out[2] = a[2] + b[2];
    return out;
  },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  length: value => Math.hypot(value[0], value[1], value[2]),
  normalize(out, value) {
    const length = Math.hypot(value[0], value[1], value[2]) || 1;
    out[0] = value[0] / length;
    out[1] = value[1] / length;
    out[2] = value[2] / length;
    return out;
  },
  scale(out, value, scalar) {
    out[0] = value[0] * scalar;
    out[1] = value[1] * scalar;
    out[2] = value[2] * scalar;
    return out;
  },
  scaleAndAdd(out, a, b, scalar) {
    out[0] = a[0] + b[0] * scalar;
    out[1] = a[1] + b[1] * scalar;
    out[2] = a[2] + b[2] * scalar;
    return out;
  },
  set(out, x, y, z) {
    out[0] = x;
    out[1] = y;
    out[2] = z;
    return out;
  },
  sub(out, a, b) {
    out[0] = a[0] - b[0];
    out[1] = a[1] - b[1];
    out[2] = a[2] - b[2];
    return out;
  },
};

const vec4 = {
  create: () => new Float32Array(4),
  set(out, x, y, z, w) {
    out[0] = x;
    out[1] = y;
    out[2] = z;
    out[3] = w;
    return out;
  },
  transformMat4(out) {
    return out;
  },
};

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function createProjectileHarness({ failedBufferIds = [] } = {}) {
  let nextBufferId = 1;
  const deleteAttempts = new Map();
  const failuresRemaining = new Set(failedBufferIds);
  const calls = {
    bufferData: 0,
    drawArrays: 0,
  };
  const gl = {
    ARRAY_BUFFER: 0x8892,
    BLEND: 0x0be2,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    FUNC_ADD: 0x8006,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    POINTS: 0,
    SRC_ALPHA: 0x0302,
    UNSIGNED_BYTE: 0x1401,
    bindBuffer() {},
    blendEquation(value) {
      assert.equal(value, this.FUNC_ADD);
    },
    blendFuncSeparate(
      sourceRgb,
      destinationRgb,
      sourceAlpha,
      destinationAlpha,
    ) {
      assert.equal(sourceRgb, this.SRC_ALPHA);
      assert.ok(
        destinationRgb === this.ONE ||
        destinationRgb === this.ONE_MINUS_SRC_ALPHA,
      );
      assert.equal(sourceAlpha, this.ONE);
      assert.equal(destinationAlpha, this.ONE_MINUS_SRC_ALPHA);
    },
    bufferData() {
      calls.bufferData += 1;
    },
    createBuffer() {
      return { id: nextBufferId++ };
    },
    deleteBuffer(buffer) {
      increment(deleteAttempts, buffer.id);
      if (failuresRemaining.delete(buffer.id)) {
        throw new Error(`synthetic buffer ${buffer.id} deletion failure`);
      }
    },
    drawArrays() {
      calls.drawArrays += 1;
    },
    enable() {},
    enableVertexAttribArray() {},
    uniform1f() {},
    uniformMatrix4fv() {},
    useProgram() {},
    vertexAttribPointer() {},
  };
  const canvas = {
    getBoundingClientRect() {
      return {
        bottom: 100,
        height: 100,
        left: 0,
        right: 100,
        top: 0,
        width: 100,
      };
    },
  };
  const axes = {
    forward: Float32Array.from([0, 0, -1]),
    right: Float32Array.from([1, 0, 0]),
    upVec: Float32Array.from([0, 1, 0]),
  };
  const system = createProjectileSystem({
    gl,
    canvas,
    mat4: {},
    vec3,
    vec4,
    hpRenderer: {},
    physicsTickRate: 60,
    getPointCount: () => 0,
    getPositionsArray: () => new Float32Array(),
    getColorsArray: () => new Uint8Array(),
    getCursorPosition: () => ({ x: 50, y: 50 }),
    getFreeflyPosition: () => new Float32Array(3),
    getFreeflyAxes: () => axes,
    getCameraParams: () => ({
      far: 100,
      fov: Math.PI / 4,
      near: 0.1,
    }),
    centroidProgram: { id: 'centroid-program' },
    centroidAttribLocations: {
      color: 1,
      position: 0,
    },
    centroidUniformLocations: {
      fov: {},
      modelMatrix: {},
      mvpMatrix: {},
      pointSize: {},
      sizeAttenuation: {},
      viewMatrix: {},
      viewportHeight: {},
    },
    getLassoCtx: () => null,
    getPointerLockActive: () => true,
    getNavigationMode: () => 'free',
    getGridBounds: () => null,
    isGridVisible: () => false,
  });
  const drawParams = {
    basePointSize: 4,
    fov: Math.PI / 4,
    modelMatrix: new Float32Array(16),
    mvpMatrix: new Float32Array(16),
    sizeAttenuation: 1,
    viewMatrix: new Float32Array(16),
    viewportHeight: 480,
  };
  const viewportInfo = {
    cameraAxes: axes,
    cameraPosition: new Float32Array(3),
  };
  return {
    calls,
    deleteAttempts,
    drawParams,
    system,
    viewportInfo,
  };
}

const orbitBufferProperties = [
  'positionBuffer',
  'normalBuffer',
  'colorBuffer',
  'indexBuffer',
  'linePositionBuffer',
  'lineNormalBuffer',
  'lineColorBuffer',
];

function createOrbitState(prefix) {
  return Object.fromEntries(
    orbitBufferProperties.map(property => [
      property,
      { id: `${prefix}:${property}` },
    ])
  );
}

function createOrbitHarness({
  states = [],
  failedBufferIds = [],
  failedProgramIds = [],
} = {}) {
  const bufferDeleteAttempts = new Map();
  const programDeleteAttempts = new Map();
  const bufferFailuresRemaining = new Set(failedBufferIds);
  const programFailuresRemaining = new Set(failedProgramIds);
  let renderer = null;
  const gl = {
    createBuffer() {
      return { id: 'replacement-buffer' };
    },
    deleteBuffer(buffer) {
      assert.equal(
        renderer.viewStates.size,
        0,
        'every logical view must detach before disposal deletes any buffer'
      );
      increment(bufferDeleteAttempts, buffer.id);
      if (bufferFailuresRemaining.delete(buffer.id)) {
        throw new Error(`synthetic ${buffer.id} deletion failure`);
      }
    },
    deleteProgram(program) {
      increment(programDeleteAttempts, program.id);
      if (programFailuresRemaining.delete(program.id)) {
        throw new Error(`synthetic ${program.id} deletion failure`);
      }
    },
  };
  renderer = Object.assign(Object.create(OrbitAnchorRenderer.prototype), {
    gl,
    viewStates: new Map(states),
    _pendingViewRetirements: new Map(),
    _disposeRequested: false,
    _disposed: false,
    program3D: { id: 'program-3d' },
    program2D: { id: 'program-2d' },
  });
  return {
    bufferDeleteAttempts,
    programDeleteAttempts,
    renderer,
  };
}

test('projectile disable pauses simulation and hides every draw until exact re-enable', async () => {
  const {
    calls,
    drawParams,
    system,
    viewportInfo,
  } = createProjectileHarness();

  system.startCharging(viewportInfo);
  assert.equal(
    system.isCharging(),
    false,
    'disabled systems must reject charge work'
  );

  system.setEnabled(true);
  await new Promise(resolve => setTimeout(resolve, 60));
  system.spawn({
    navigationMode: 'free',
    pointerLockActive: true,
    viewportInfo,
  });
  system.update(0.01);
  system.draw(drawParams);
  assert.equal(calls.drawArrays, 1);
  assert.ok(calls.bufferData > 0);

  system.startCharging(viewportInfo);
  assert.equal(system.isCharging(), true);
  system.setEnabled(false);
  assert.equal(system.isCharging(), false);
  const disabledCalls = { ...calls };

  system.update(20);
  system.draw(drawParams);
  system.updateChargeUI();
  system.startCharging(viewportInfo);
  assert.deepEqual(calls, disabledCalls);
  assert.equal(system.isCharging(), false);

  // Disable is deliberately pause-and-hide, not destructive reset. A dt larger
  // than the projectile lifetime above must not age the retained projectile.
  system.setEnabled(true);
  system.update(0.001);
  system.draw(drawParams);
  assert.equal(calls.drawArrays, disabledCalls.drawArrays + 1);
  assert.ok(calls.bufferData > disabledCalls.bufferData);

  assert.equal(system.dispose(), true);
});

test('projectile disposal attempts every buffer and retries only failed handles', () => {
  const {
    calls,
    deleteAttempts,
    drawParams,
    system,
  } = createProjectileHarness({
    failedBufferIds: [1, 3],
  });

  assert.throws(
    () => system.dispose(),
    error => (
      error instanceof AggregateError
      && error.errors.length === 2
      && error.errors.every(item => /synthetic buffer [13]/.test(item.message))
    )
  );
  assert.deepEqual(
    Object.fromEntries(deleteAttempts),
    { 1: 1, 2: 1, 3: 1, 4: 1 }
  );

  const fencedCalls = { ...calls };
  assert.throws(
    () => system.setEnabled(true),
    /disposing projectile system cannot be re-enabled/i
  );
  system.update(1);
  system.draw(drawParams);
  assert.deepEqual(calls, fencedCalls);

  assert.equal(system.dispose(), true);
  assert.deepEqual(
    Object.fromEntries(deleteAttempts),
    { 1: 2, 2: 1, 3: 2, 4: 1 }
  );
  assert.equal(system.dispose(), false);
});

test('projectile context loss drops invalid buffers without issuing GL deletion', () => {
  const {
    deleteAttempts,
    drawParams,
    system,
  } = createProjectileHarness();

  system.setEnabled(true);
  assert.equal(system.handleContextLost(), true);
  assert.equal(system.handleContextLost(), false);
  assert.equal(deleteAttempts.size, 0);
  assert.throws(
    () => system.setEnabled(true),
    /disposing projectile system cannot be re-enabled/i
  );
  system.update(1);
  system.draw(drawParams);
  assert.equal(system.dispose(), false);
  assert.equal(deleteAttempts.size, 0);
});

test('orbit view retirement detaches first and retries only failed buffers', () => {
  const state = createOrbitState('snap');
  const failedIds = [
    state.positionBuffer.id,
    state.lineNormalBuffer.id,
  ];
  const {
    bufferDeleteAttempts,
    renderer,
  } = createOrbitHarness({
    states: [['snap', state]],
    failedBufferIds: failedIds,
  });

  assert.throws(
    () => renderer.deleteViewState('snap'),
    error => (
      error instanceof AggregateError
      && error.errors.length === 2
    )
  );
  assert.equal(renderer.viewStates.has('snap'), false);
  assert.equal(renderer._pendingViewRetirements.has('snap'), true);
  assert.equal(bufferDeleteAttempts.size, orbitBufferProperties.length);
  assert.throws(
    () => renderer.getViewState('snap'),
    /pending resource retirement/i
  );

  assert.equal(renderer.deleteViewState('snap'), true);
  assert.equal(renderer._pendingViewRetirements.has('snap'), false);
  for (const id of failedIds) {
    assert.equal(bufferDeleteAttempts.get(id), 2);
  }
  for (const property of orbitBufferProperties) {
    const id = `snap:${property}`;
    if (!failedIds.includes(id)) {
      assert.equal(bufferDeleteAttempts.get(id), 1);
    }
  }
  assert.equal(renderer.deleteViewState('snap'), false);
});

test('orbit context loss drops every invalid handle without GL retirement', () => {
  const {
    bufferDeleteAttempts,
    programDeleteAttempts,
    renderer,
  } = createOrbitHarness({
    states: [['live', createOrbitState('live')]],
  });

  assert.equal(renderer.handleContextLost(), true);
  assert.equal(renderer.handleContextLost(), false);
  assert.equal(renderer.viewStates.size, 0);
  assert.equal(renderer._pendingViewRetirements.size, 0);
  assert.equal(renderer.program3D, null);
  assert.equal(renderer.program2D, null);
  assert.equal(bufferDeleteAttempts.size, 0);
  assert.equal(programDeleteAttempts.size, 0);
  assert.equal(renderer.dispose(), false);
  assert.equal(bufferDeleteAttempts.size, 0);
  assert.equal(programDeleteAttempts.size, 0);
});

test('orbit disposal detaches all views and attempts every program and buffer', () => {
  const first = createOrbitState('first');
  const second = createOrbitState('second');
  const failedBufferIds = [
    first.positionBuffer.id,
    second.lineColorBuffer.id,
  ];
  const {
    bufferDeleteAttempts,
    programDeleteAttempts,
    renderer,
  } = createOrbitHarness({
    states: [
      ['first', first],
      ['second', second],
    ],
    failedBufferIds,
    failedProgramIds: ['program-3d'],
  });

  assert.throws(
    () => renderer.dispose(),
    error => (
      error instanceof AggregateError
      && error.errors.length === 3
    )
  );
  assert.equal(renderer.viewStates.size, 0);
  assert.equal(
    bufferDeleteAttempts.size,
    orbitBufferProperties.length * 2
  );
  assert.deepEqual(
    Object.fromEntries(programDeleteAttempts),
    {
      'program-3d': 1,
      'program-2d': 1,
    }
  );
  assert.throws(
    () => renderer.getViewState('new-view'),
    /disposing orbit-anchor renderer/i
  );
  assert.doesNotThrow(() => renderer.draw());

  assert.equal(renderer.dispose(), true);
  for (const id of failedBufferIds) {
    assert.equal(bufferDeleteAttempts.get(id), 2);
  }
  for (const [id, attempts] of bufferDeleteAttempts) {
    if (!failedBufferIds.includes(id)) assert.equal(attempts, 1);
  }
  assert.deepEqual(
    Object.fromEntries(programDeleteAttempts),
    {
      'program-3d': 2,
      'program-2d': 1,
    }
  );
  assert.equal(renderer.dispose(), false);
});
