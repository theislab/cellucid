import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';

function createInitializationGl(overrides = {}) {
  let nextId = 1;
  let shaderOrdinal = 0;
  let programOrdinal = 0;
  let uniformOrdinal = 0;
  const live = {
    shaders: new Set(),
    programs: new Set(),
    textures: new Set(),
    vertexArrays: new Set(),
  };
  const deleteAttempts = {
    shaders: new Map(),
    programs: new Map(),
    textures: new Map(),
    vertexArrays: new Map(),
  };
  const failProgramDeletionOnce = new Set();
  const failShaderDeletionOnce = new Set();
  let failNextProgramUnbind = false;
  let currentProgram = null;
  let nextError = 0;

  const recordDelete = (kind, handle) => {
    const attempts = deleteAttempts[kind];
    attempts.set(handle, (attempts.get(handle) ?? 0) + 1);
  };
  const createHandle = kind => ({
    id: `${kind}-${nextId++}`,
    kind,
  });

  const gl = {
    NO_ERROR: 0,
    INVALID_OPERATION: 0x0502,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    CURRENT_PROGRAM: 0x8b8d,
    TEXTURE_2D: 0x0de1,
    R32UI: 0x8236,
    RED_INTEGER: 0x8d94,
    UNSIGNED_INT: 0x1405,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    DEPTH_TEST: 0x0b71,
    LEQUAL: 0x0203,
    BLEND: 0x0be2,
    FUNC_ADD: 0x8006,
    ONE: 1,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,

    createShader(type) {
      shaderOrdinal++;
      if (overrides.nullShaderAt === shaderOrdinal) return null;
      const handle = createHandle(
        type === gl.VERTEX_SHADER ? 'vertex-shader' : 'fragment-shader'
      );
      handle.ordinal = shaderOrdinal;
      live.shaders.add(handle);
      return handle;
    },
    shaderSource(shader) {
      if (overrides.throwShaderSourceAt === shader.ordinal) {
        throw new Error('synthetic shaderSource failure');
      }
    },
    compileShader() {},
    getShaderParameter(shader, parameter) {
      assert.equal(parameter, gl.COMPILE_STATUS);
      return overrides.compileFailureAt !== shader.ordinal;
    },
    getShaderInfoLog() {
      return 'synthetic compiler diagnostic';
    },
    deleteShader(handle) {
      recordDelete('shaders', handle);
      if (
        overrides.failShaderDeleteOnceAt === handle.ordinal &&
        !failShaderDeletionOnce.has(handle)
      ) {
        failShaderDeletionOnce.add(handle);
        throw new Error('synthetic live shader deletion failure');
      }
      live.shaders.delete(handle);
      if (
        overrides.throwAfterShaderDeleteAt === handle.ordinal
      ) {
        throw new Error(
          'synthetic post-delete shader failure'
        );
      }
    },
    isShader(handle) {
      return live.shaders.has(handle);
    },

    createProgram() {
      programOrdinal++;
      if (overrides.nullProgramAt === programOrdinal) return null;
      const handle = createHandle('program');
      handle.ordinal = programOrdinal;
      live.programs.add(handle);
      return handle;
    },
    attachShader() {},
    linkProgram() {},
    getProgramParameter(program, parameter) {
      assert.equal(parameter, gl.LINK_STATUS);
      return overrides.linkFailureAt !== program.ordinal;
    },
    getProgramInfoLog() {
      return 'synthetic linker diagnostic';
    },
    getUniformLocation() {
      uniformOrdinal++;
      if (overrides.throwUniformAt === uniformOrdinal) {
        throw new Error('synthetic uniform lookup failure');
      }
      return { ordinal: uniformOrdinal };
    },
    useProgram(program) {
      if (program && overrides.throwUseProgram) {
        throw new Error('synthetic useProgram failure');
      }
      if (program === null && failNextProgramUnbind) {
        failNextProgramUnbind = false;
        throw new Error('synthetic program unbind failure');
      }
      currentProgram = program;
    },
    deleteProgram(handle) {
      recordDelete('programs', handle);
      if (failProgramDeletionOnce.has(handle)) {
        failProgramDeletionOnce.delete(handle);
        throw new Error('synthetic live program deletion failure');
      }
      live.programs.delete(handle);
    },
    isProgram(handle) {
      return live.programs.has(handle);
    },

    createTexture() {
      if (overrides.nullTexture) return null;
      const handle = createHandle('texture');
      live.textures.add(handle);
      return handle;
    },
    bindTexture() {},
    texImage2D() {
      if (overrides.textureUploadError) {
        nextError = gl.INVALID_OPERATION;
      }
    },
    texParameteri() {},
    deleteTexture(handle) {
      recordDelete('textures', handle);
      live.textures.delete(handle);
    },
    isTexture(handle) {
      return live.textures.has(handle);
    },

    createVertexArray() {
      if (overrides.nullVertexArray) return null;
      const handle = createHandle('vertex-array');
      live.vertexArrays.add(handle);
      return handle;
    },
    deleteVertexArray(handle) {
      recordDelete('vertexArrays', handle);
      live.vertexArrays.delete(handle);
    },
    isVertexArray(handle) {
      return live.vertexArrays.has(handle);
    },
    deleteBuffer() {},
    isBuffer() {
      return false;
    },

    enable() {},
    depthFunc() {},
    blendEquation(value) {
      assert.equal(value, gl.FUNC_ADD);
    },
    blendFuncSeparate(
      sourceRgb,
      destinationRgb,
      sourceAlpha,
      destinationAlpha,
    ) {
      if (overrides.throwBlendFunc) {
        throw new Error('synthetic blendFunc failure');
      }
      assert.equal(sourceRgb, gl.SRC_ALPHA);
      assert.equal(destinationRgb, gl.ONE_MINUS_SRC_ALPHA);
      assert.equal(sourceAlpha, gl.ONE);
      assert.equal(destinationAlpha, gl.ONE_MINUS_SRC_ALPHA);
    },
    getError() {
      const error = nextError;
      nextError = gl.NO_ERROR;
      return error;
    },
    getParameter(parameter) {
      assert.equal(parameter, gl.CURRENT_PROGRAM);
      return currentProgram;
    },

    _state: {
      deleteAttempts,
      failProgramDeletionOnce,
      set failNextProgramUnbind(value) {
        failNextProgramUnbind = value;
      },
      get currentProgram() {
        return currentProgram;
      },
      live,
    },
  };
  return gl;
}

function assertNoLiveInitializationResources(gl) {
  for (const [kind, handles] of Object.entries(gl._state.live)) {
    assert.equal(
      handles.size,
      0,
      `expected no live ${kind}, found ${handles.size}`
    );
  }
}

test('renderer initialization publishes one complete resource generation', () => {
  const gl = createInitializationGl();
  const renderer = new HighPerfRenderer(gl);

  assert.equal(gl._state.live.shaders.size, 0);
  assert.equal(gl._state.live.programs.size, 3);
  assert.equal(gl._state.live.textures.size, 1);
  assert.equal(gl._state.live.vertexArrays.size, 1);
  assert.equal(renderer.uniformLocations.size, 3);
  assert.equal(renderer.activeProgram, renderer.programs.full);
  assert.equal(gl._state.currentProgram, renderer.programs.full);

  renderer.dispose();
  assertNoLiveInitializationResources(gl);
  const attemptsAfterFirstDispose = [
    ...gl._state.deleteAttempts.programs.values(),
    ...gl._state.deleteAttempts.textures.values(),
    ...gl._state.deleteAttempts.vertexArrays.values(),
  ];
  assert.ok(attemptsAfterFirstDispose.every(count => count === 1));

  renderer.dispose();
  assert.deepEqual(
    [
      ...gl._state.deleteAttempts.programs.values(),
      ...gl._state.deleteAttempts.textures.values(),
      ...gl._state.deleteAttempts.vertexArrays.values(),
    ],
    attemptsAfterFirstDispose
  );
});

for (const scenario of [
  {
    name: 'partial shader allocation',
    overrides: { nullShaderAt: 3 },
    error: /light.*vertex shader/i,
  },
  {
    name: 'thrown shader setup',
    overrides: { throwShaderSourceAt: 3 },
    error: /synthetic shaderSource failure/i,
  },
  {
    name: 'partial program link',
    overrides: { linkFailureAt: 2 },
    error: /light.*link failed/i,
  },
  {
    name: 'partial uniform caching',
    overrides: { throwUniformAt: 7 },
    error: /synthetic uniform lookup failure/i,
  },
  {
    name: 'dummy texture allocation',
    overrides: { nullTexture: true },
    error: /LOD index texture/i,
  },
  {
    name: 'dummy texture WebGL publication',
    overrides: { textureUploadError: true },
    error: /candidate dummy LOD texture upload.*WebGL error/i,
  },
  {
    name: 'main VAO allocation',
    overrides: { nullVertexArray: true },
    error: /could not allocate its vertex array/i,
  },
  {
    name: 'post-acquisition GL state setup',
    overrides: { throwBlendFunc: true },
    error: /synthetic blendFunc failure/i,
  },
  {
    name: 'default-program activation',
    overrides: { throwUseProgram: true },
    error: /synthetic useProgram failure/i,
  },
]) {
  test(`renderer initialization retires all resources after ${scenario.name} failure`, () => {
    const gl = createInitializationGl(scenario.overrides);
    assert.throws(
      () => new HighPerfRenderer(gl),
      scenario.error
    );
    assertNoLiveInitializationResources(gl);
  });
}

test('program disposal detaches first and retries only the deletion that remains live', () => {
  const gl = createInitializationGl();
  const renderer = new HighPerfRenderer(gl);
  const programs = Object.values(renderer.programs);
  const failedProgram = programs[1];
  gl._state.failProgramDeletionOnce.add(failedProgram);

  assert.throws(
    () => renderer.dispose(),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 1 &&
      /live program deletion failure/i.test(error.errors[0].message)
    )
  );
  assert.equal(renderer.activeProgram, null);
  assert.deepEqual(renderer.programs, {
    full: null,
    light: null,
    ultralight: null,
  });
  assert.equal(gl._state.currentProgram, null);
  assert.equal(gl._state.live.programs.size, 1);
  assert.equal(
    gl._state.deleteAttempts.programs.get(failedProgram),
    1
  );
  for (const program of programs) {
    if (program === failedProgram) continue;
    assert.equal(
      gl._state.deleteAttempts.programs.get(program),
      1
    );
  }

  renderer.dispose();
  assertNoLiveInitializationResources(gl);
  assert.equal(
    gl._state.deleteAttempts.programs.get(failedProgram),
    2
  );
  for (const program of programs) {
    if (program === failedProgram) continue;
    assert.equal(
      gl._state.deleteAttempts.programs.get(program),
      1
    );
  }
});

test('shader cleanup is liveness-aware and constructor cleanup retries only a live shader', () => {
  const postDeleteGl = createInitializationGl({
    throwAfterShaderDeleteAt: 1,
  });
  const renderer = new HighPerfRenderer(postDeleteGl);
  assert.equal(postDeleteGl._state.live.shaders.size, 0);
  assert.equal(
    [...postDeleteGl._state.deleteAttempts.shaders.values()]
      .filter(count => count !== 1)
      .length,
    0
  );
  renderer.dispose();
  assertNoLiveInitializationResources(postDeleteGl);

  const liveFailureGl = createInitializationGl({
    failShaderDeleteOnceAt: 1,
  });
  assert.throws(
    () => new HighPerfRenderer(liveFailureGl),
    error => error instanceof AggregateError
  );
  assertNoLiveInitializationResources(liveFailureGl);
  const failedShaderAttempts = [
    ...liveFailureGl._state.deleteAttempts.shaders.values(),
  ].filter(count => count === 2);
  assert.equal(failedShaderAttempts.length, 1);
});

test('failed program unbinding remains retryable after program handles settle', () => {
  const gl = createInitializationGl();
  const renderer = new HighPerfRenderer(gl);
  const programs = Object.values(renderer.programs);
  const boundProgram = renderer.activeProgram;
  gl._state.failNextProgramUnbind = true;

  assert.throws(
    () => renderer.dispose(),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 1 &&
      /program unbind failure/i.test(error.errors[0].message)
    )
  );
  assert.equal(gl._state.currentProgram, boundProgram);
  assert.equal(gl._state.live.programs.size, 0);
  assert.ok(
    programs.every(
      program =>
        gl._state.deleteAttempts.programs.get(program) === 1
    )
  );

  renderer.dispose();
  assert.equal(gl._state.currentProgram, null);
  assertNoLiveInitializationResources(gl);
  assert.ok(
    programs.every(
      program =>
        gl._state.deleteAttempts.programs.get(program) === 1
    )
  );
});

test('disposal preserves a current program owned by another shared-context renderer', () => {
  const gl = createInitializationGl();
  const renderer = new HighPerfRenderer(gl);
  const externalProgram = { id: 'external-program' };
  gl.useProgram(externalProgram);

  renderer.dispose();
  assert.equal(gl._state.currentProgram, externalProgram);
  assertNoLiveInitializationResources(gl);
});
