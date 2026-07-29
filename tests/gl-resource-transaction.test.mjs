import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProgram,
  createShader,
  createTransformFeedbackProgram,
} from '../assets/js/rendering/gl-utils.js';
import {
  GPUNoiseGenerator,
} from '../assets/js/rendering/smoke-cloud/gpu-noise-generator.js';
import {
  SmokeRenderer,
} from '../assets/js/rendering/smoke-cloud/smoke-renderer.js';

function createShaderGl({
  bufferDataError = 0,
  failBufferAllocation = false,
  failCompileType = null,
  failProgramAllocationAt = null,
  failProgramLinkAt = null,
  failShaderAllocationAt = null,
  initialWebGLError = 0,
  missingUniform = null,
} = {}) {
  let nextId = 1;
  let shaderAllocations = 0;
  let programAllocations = 0;
  const shaders = new Set();
  const programs = new Set();
  const buffers = new Set();
  const vertexArrays = new Set();
  const deletedShaders = [];
  const deletedPrograms = [];
  const deletedBuffers = [];
  const deletedVertexArrays = [];
  const webglErrors = initialWebGLError === 0
    ? []
    : [initialWebGLError];
  const gl = {
    ARRAY_BUFFER: 0x8892,
    ARRAY_BUFFER_BINDING: 0x8894,
    COMPILE_STATUS: 0x8B81,
    CONTEXT_LOST_WEBGL: 0x9242,
    FLOAT: 0x1406,
    FRAGMENT_SHADER: 0x8B30,
    INTERLEAVED_ATTRIBS: 0x8C8C,
    LINK_STATUS: 0x8B82,
    NO_ERROR: 0,
    OUT_OF_MEMORY: 0x0505,
    STATIC_DRAW: 0x88E4,
    VERTEX_ARRAY_BINDING: 0x85B5,
    VERTEX_SHADER: 0x8B31,
    createShader(type) {
      shaderAllocations++;
      if (shaderAllocations === failShaderAllocationAt) return null;
      const shader = { id: nextId++, type };
      shaders.add(shader);
      return shader;
    },
    shaderSource(shader) {
      if (!shader) throw new TypeError('shaderSource received null');
    },
    compileShader(shader) {
      if (!shader) throw new TypeError('compileShader received null');
    },
    getShaderParameter(shader, parameter) {
      assert.equal(parameter, gl.COMPILE_STATUS);
      return shader.type !== failCompileType;
    },
    getShaderInfoLog(shader) {
      return `synthetic ${shader.type} compile failure`;
    },
    deleteShader(shader) {
      if (!shader) return;
      shaders.delete(shader);
      deletedShaders.push(shader);
    },
    createProgram() {
      programAllocations++;
      if (programAllocations === failProgramAllocationAt) return null;
      const program = { id: nextId++, ordinal: programAllocations };
      programs.add(program);
      return program;
    },
    attachShader(program, shader) {
      if (!program || !shader) {
        throw new TypeError('attachShader received an unallocated resource');
      }
    },
    transformFeedbackVaryings() {},
    linkProgram() {},
    getProgramParameter(program, parameter) {
      assert.equal(parameter, gl.LINK_STATUS);
      return program.ordinal !== failProgramLinkAt;
    },
    getProgramInfoLog(program) {
      return `synthetic program ${program.ordinal} link failure`;
    },
    deleteProgram(program) {
      if (!program) return;
      programs.delete(program);
      deletedPrograms.push(program);
    },
    getAttribLocation() {
      return 0;
    },
    getUniformLocation(_program, name) {
      if (name === missingUniform) return null;
      return { name };
    },
    createBuffer() {
      if (failBufferAllocation) return null;
      const buffer = { id: nextId++ };
      buffers.add(buffer);
      return buffer;
    },
    deleteBuffer(buffer) {
      if (!buffer) return;
      buffers.delete(buffer);
      deletedBuffers.push(buffer);
    },
    createVertexArray() {
      const vertexArray = { id: nextId++ };
      vertexArrays.add(vertexArray);
      return vertexArray;
    },
    deleteVertexArray(vertexArray) {
      if (!vertexArray) return;
      vertexArrays.delete(vertexArray);
      deletedVertexArrays.push(vertexArray);
    },
    bindBuffer() {},
    bufferData() {
      if (bufferDataError !== gl.NO_ERROR) {
        webglErrors.push(bufferDataError);
      }
    },
    bindVertexArray() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    getParameter(parameter) {
      if (parameter === gl.ARRAY_BUFFER_BINDING) return null;
      if (parameter === gl.VERTEX_ARRAY_BINDING) return null;
      throw new TypeError(`unexpected parameter ${parameter}`);
    },
    getError() {
      return webglErrors.shift() ?? gl.NO_ERROR;
    },
    _state: {
      buffers,
      deletedBuffers,
      deletedPrograms,
      deletedShaders,
      deletedVertexArrays,
      programs,
      shaders,
      vertexArrays,
    },
  };
  return gl;
}

test('shared shader helpers reject null allocation and release every partial resource', () => {
  const nullShaderGl = createShaderGl({ failShaderAllocationAt: 1 });
  assert.throws(
    () => createShader(nullShaderGl, nullShaderGl.VERTEX_SHADER, 'void main(){}'),
    /shader allocation/i,
  );
  assert.equal(nullShaderGl._state.shaders.size, 0);

  const fragmentFailureGl = createShaderGl({
    failCompileType: 0x8B30,
  });
  assert.throws(
    () => createProgram(fragmentFailureGl, 'vertex', 'fragment'),
    /compile shader/i,
  );
  assert.equal(fragmentFailureGl._state.shaders.size, 0);
  assert.equal(fragmentFailureGl._state.programs.size, 0);
  assert.equal(fragmentFailureGl._state.deletedShaders.length, 2);

  const linkFailureGl = createShaderGl({ failProgramLinkAt: 1 });
  assert.throws(
    () => createProgram(linkFailureGl, 'vertex', 'fragment'),
    /link program/i,
  );
  assert.equal(linkFailureGl._state.shaders.size, 0);
  assert.equal(linkFailureGl._state.programs.size, 0);
  assert.equal(linkFailureGl._state.deletedShaders.length, 2);
  assert.equal(linkFailureGl._state.deletedPrograms.length, 1);
});

test('transform-feedback program failure releases both compiled shaders', () => {
  const gl = createShaderGl({ failProgramLinkAt: 1 });
  assert.throws(
    () => createTransformFeedbackProgram(
      gl,
      'vertex',
      'fragment',
      ['v_position'],
    ),
    /link transform feedback program/i,
  );
  assert.equal(gl._state.shaders.size, 0);
  assert.equal(gl._state.programs.size, 0);
  assert.equal(gl._state.deletedShaders.length, 2);
  assert.equal(gl._state.deletedPrograms.length, 1);
});

test('GPU noise construction rolls back programs when a later program fails', () => {
  const gl = createShaderGl({ failProgramLinkAt: 3 });
  assert.throws(
    () => new GPUNoiseGenerator(gl),
    /GPU noise program linking failed/,
  );
  assert.equal(gl._state.shaders.size, 0);
  assert.equal(gl._state.programs.size, 0);
  assert.equal(gl._state.buffers.size, 0);
  assert.equal(gl._state.vertexArrays.size, 0);
});

test('SmokeRenderer construction owns and rolls back every staged resource', () => {
  const preflightFailureGl = createShaderGl({
    initialWebGLError: 0x0501,
  });
  assert.throws(
    () => new SmokeRenderer(preflightFailureGl, createProgram),
    /construction preflight.*0x501/i,
  );
  assert.equal(preflightFailureGl._state.shaders.size, 0);
  assert.equal(preflightFailureGl._state.programs.size, 0);
  assert.equal(preflightFailureGl._state.buffers.size, 0);
  assert.equal(preflightFailureGl._state.vertexArrays.size, 0);
  assert.equal(preflightFailureGl.getError(), preflightFailureGl.NO_ERROR);

  const secondProgramFailureGl = createShaderGl();
  const stagedPrograms = [];
  assert.throws(
    () => new SmokeRenderer(secondProgramFailureGl, () => {
      if (stagedPrograms.length === 1) {
        throw new Error('synthetic composite program failure');
      }
      const program = { id: 'smoke-program' };
      stagedPrograms.push(program);
      return program;
    }),
    /synthetic composite program failure/,
  );
  assert.deepEqual(
    secondProgramFailureGl._state.deletedPrograms,
    stagedPrograms,
  );

  const bufferFailureGl = createShaderGl({ failBufferAllocation: true });
  const programsBeforeBuffer = [
    { id: 'smoke-program' },
    { id: 'composite-program' },
  ];
  let programIndex = 0;
  assert.throws(
    () => new SmokeRenderer(
      bufferFailureGl,
      () => programsBeforeBuffer[programIndex++],
    ),
    /fullscreen-buffer allocation failed/,
  );
  assert.deepEqual(
    bufferFailureGl._state.deletedPrograms,
    programsBeforeBuffer,
  );
  assert.equal(bufferFailureGl._state.buffers.size, 0);
  assert.equal(bufferFailureGl._state.vertexArrays.size, 0);

  const uniformFailureGl = createShaderGl({
    missingUniform: 'u_densityTex3D',
  });
  const programsBeforeUniform = [
    { id: 'smoke-program' },
    { id: 'composite-program' },
  ];
  programIndex = 0;
  assert.throws(
    () => new SmokeRenderer(
      uniformFailureGl,
      () => programsBeforeUniform[programIndex++],
    ),
    /smoke shader.*densityTex3D uniform/i,
  );
  assert.deepEqual(
    uniformFailureGl._state.deletedPrograms,
    programsBeforeUniform,
  );
  assert.equal(uniformFailureGl._state.buffers.size, 0);
  assert.equal(uniformFailureGl._state.vertexArrays.size, 0);

  const uploadFailureGl = createShaderGl({
    bufferDataError: 0x0505,
  });
  assert.throws(
    () => new SmokeRenderer(uploadFailureGl, createProgram),
    /candidate construction.*0x505/i,
  );
  assert.equal(uploadFailureGl._state.shaders.size, 0);
  assert.equal(uploadFailureGl._state.programs.size, 0);
  assert.equal(uploadFailureGl._state.buffers.size, 0);
  assert.equal(uploadFailureGl._state.vertexArrays.size, 0);
  assert.equal(uploadFailureGl.getError(), uploadFailureGl.NO_ERROR);
});

test('steady smoke rendering uses owned VAOs without synchronous state queries', () => {
  const source = SmokeRenderer.prototype.render.toString();
  assert.doesNotMatch(
    source,
    /\.getParameter\s*\(|\.getError\s*\(|\.isEnabled\s*\(/,
  );
  assert.doesNotMatch(
    source,
    /enableVertexAttribArray\s*\(|vertexAttribPointer\s*\(/,
  );
  assert.match(source, /bindVertexArray\s*\(this\.smokeVertexArray\)/);
  assert.match(source, /bindVertexArray\s*\(this\.compositeVertexArray\)/);
});

test('SmokeRenderer disposal retains and retries only exact failed owners', () => {
  const calls = [];
  let densityDeleteAttempts = 0;
  const gl = {
    deleteTexture(resource) {
      calls.push(['texture', resource.id]);
      if (resource.id === 'density') {
        densityDeleteAttempts++;
        if (densityDeleteAttempts === 1) {
          throw new Error('synthetic density deletion failure');
        }
      }
    },
    deleteFramebuffer(resource) {
      calls.push(['framebuffer', resource.id]);
    },
    deleteBuffer(resource) {
      calls.push(['buffer', resource.id]);
    },
    deleteVertexArray(resource) {
      calls.push(['vertexArray', resource.id]);
    },
    deleteProgram(resource) {
      calls.push(['program', resource.id]);
    },
  };
  const renderer = Object.assign(
    Object.create(SmokeRenderer.prototype),
    {
      colorTex: { id: 'target-texture' },
      compositeProgram: { id: 'composite-program' },
      compositeVertexArray: { id: 'composite-vao' },
      contextLost: false,
      disposed: false,
      framebuffer: { id: 'target-framebuffer' },
      gl,
      noiseGenerationError: null,
      noiseGenerationInProgress: true,
      noiseGenerationToken: 7,
      noiseTextures: {
        blueNoise: { id: 'blue-noise' },
        detail: { id: 'detail-noise' },
        shape: { id: 'shape-noise' },
      },
      quadBuffer: { id: 'quad-buffer' },
      smokeProgram: { id: 'smoke-program' },
      smokeVertexArray: { id: 'smoke-vao' },
      targetHeight: 16,
      targetWidth: 16,
      textureInfo: { texture: { id: 'density' } },
    },
  );

  assert.throws(
    () => renderer.dispose(),
    /synthetic density deletion failure/,
  );
  assert.deepEqual(calls, [
    ['texture', 'density'],
    ['texture', 'shape-noise'],
    ['texture', 'detail-noise'],
    ['texture', 'blue-noise'],
    ['texture', 'target-texture'],
    ['framebuffer', 'target-framebuffer'],
    ['buffer', 'quad-buffer'],
    ['vertexArray', 'smoke-vao'],
    ['vertexArray', 'composite-vao'],
    ['program', 'smoke-program'],
    ['program', 'composite-program'],
  ]);
  assert.equal(renderer.disposed, false);
  assert.equal(renderer.noiseGenerationToken, 8);
  assert.equal(renderer.textureInfo, null);
  assert.equal(renderer.noiseTextures, null);
  assert.equal(renderer.framebuffer, null);
  assert.equal(renderer.quadBuffer, null);
  assert.equal(renderer.smokeProgram, null);
  assert.deepEqual(
    Array.from(renderer._pendingTextureDeletes),
    [{ id: 'density' }],
  );
  assert.throws(
    () => renderer.setParams({ density: 1 }),
    /after disposal has started/,
  );
  assert.throws(
    () => renderer.clearVolume(),
    /after disposal has started/,
  );
  assert.throws(
    () => renderer.ensureRenderTarget(32, 32),
    /after disposal has started/,
  );

  assert.equal(renderer.dispose(), true);
  assert.equal(renderer.disposed, true);
  assert.deepEqual(calls.slice(11), [
    ['texture', 'density'],
  ]);
  assert.equal(renderer.dispose(), false);
  assert.equal(calls.length, 12);
});

test('SmokeRenderer runtime volume retirement stays owned until exact retry', () => {
  const texture = { id: 'runtime-volume' };
  let attempts = 0;
  const renderer = Object.assign(
    Object.create(SmokeRenderer.prototype),
    {
      contextLost: false,
      disposed: false,
      gl: {
        deleteTexture(resource) {
          assert.equal(resource, texture);
          attempts++;
          if (attempts === 1) {
            throw new Error(
              'synthetic runtime volume retirement failure'
            );
          }
        },
      },
      textureInfo: { texture },
      _disposeStarted: false,
    },
  );

  assert.throws(
    () => renderer.clearVolume(),
    /synthetic runtime volume retirement failure/,
  );
  assert.equal(renderer.textureInfo, null);
  assert.deepEqual(
    Array.from(renderer._pendingTextureDeletes),
    [texture],
  );

  renderer.clearVolume();
  assert.equal(attempts, 2);
  assert.equal(renderer._pendingTextureDeletes.size, 0);
});

test('SmokeRenderer accepts delete-then-throw retirement as already settled', () => {
  const texture = { id: 'post-delete-volume' };
  const liveTextures = new Set([texture]);
  const renderer = Object.assign(
    Object.create(SmokeRenderer.prototype),
    {
      contextLost: false,
      disposed: false,
      gl: {
        deleteTexture(resource) {
          liveTextures.delete(resource);
          throw new Error('synthetic post-delete wrapper failure');
        },
        isTexture(resource) {
          return liveTextures.has(resource);
        },
      },
      textureInfo: { texture },
      _disposeStarted: false,
    },
  );

  assert.doesNotThrow(() => renderer.clearVolume());
  assert.equal(renderer.textureInfo, null);
  assert.equal(renderer._pendingTextureDeletes.size, 0);
});

test('GPU noise disposal fences generation and retries only failed handles', () => {
  const failedProgram = { id: 'failed-program' };
  const successfulProgram = { id: 'successful-program' };
  const failedVertexArray = { id: 'failed-vao' };
  const successfulBuffer = { id: 'successful-buffer' };
  const calls = [];
  const attempts = new Map();
  const recordAttempt = (kind, resource) => {
    calls.push([kind, resource.id]);
    const count = (attempts.get(resource) ?? 0) + 1;
    attempts.set(resource, count);
    if (
      count === 1
      && (resource === failedProgram || resource === failedVertexArray)
    ) {
      throw new Error(`synthetic ${kind} deletion failure`);
    }
  };
  const generator = Object.assign(
    Object.create(GPUNoiseGenerator.prototype),
    {
      gl: {
        deleteProgram: resource => recordAttempt('program', resource),
        deleteVertexArray: resource => (
          recordAttempt('vertexArray', resource)
        ),
        deleteBuffer: resource => recordAttempt('buffer', resource),
      },
      programs: {
        shape: failedProgram,
        detail: successfulProgram,
      },
      uniforms: {
        shape: {},
        detail: {},
      },
      quadVAO: failedVertexArray,
      quadVBO: successfulBuffer,
      _pendingProgramDeletes: new Set(),
      _pendingVertexArrayDeletes: new Set(),
      _pendingBufferDeletes: new Set(),
      _disposeStarted: false,
      _disposed: false,
    },
  );

  assert.throws(
    () => generator.dispose(),
    error => (
      error instanceof AggregateError
      && error.errors.length === 2
    ),
  );
  assert.deepEqual(calls, [
    ['program', 'failed-program'],
    ['program', 'successful-program'],
    ['vertexArray', 'failed-vao'],
    ['buffer', 'successful-buffer'],
  ]);
  assert.equal(generator._disposed, false);
  assert.deepEqual(generator.programs, {});
  assert.equal(generator.quadVAO, null);
  assert.equal(generator.quadVBO, null);
  assert.deepEqual(
    Array.from(generator._pendingProgramDeletes),
    [failedProgram],
  );
  assert.deepEqual(
    Array.from(generator._pendingVertexArrayDeletes),
    [failedVertexArray],
  );
  assert.equal(generator._pendingBufferDeletes.size, 0);
  assert.throws(
    () => generator.generate(),
    /after disposal has started/,
  );

  assert.equal(generator.dispose(), true);
  assert.equal(generator._disposed, true);
  assert.deepEqual(calls.slice(4), [
    ['program', 'failed-program'],
    ['vertexArray', 'failed-vao'],
  ]);
  assert.equal(generator.dispose(), false);
});

test('SmokeRenderer context loss invalidates terminal owners without GL deletion', () => {
  const gl = {
    deleteTexture() {
      throw new Error('lost-context textures must not be deleted');
    },
    deleteFramebuffer() {
      throw new Error('lost-context framebuffers must not be deleted');
    },
    deleteBuffer() {
      throw new Error('lost-context buffers must not be deleted');
    },
    deleteVertexArray() {
      throw new Error('lost-context vertex arrays must not be deleted');
    },
    deleteProgram() {
      throw new Error('lost-context programs must not be deleted');
    },
  };
  const renderer = Object.assign(
    Object.create(SmokeRenderer.prototype),
    {
      colorTex: { id: 'target-texture' },
      compositeProgram: { id: 'composite-program' },
      compositeVertexArray: { id: 'composite-vao' },
      contextLost: false,
      disposed: false,
      framebuffer: { id: 'target-framebuffer' },
      gl,
      noiseGenerationError: null,
      noiseGenerationInProgress: false,
      noiseGenerationToken: 3,
      noiseTextures: {
        blueNoise: { id: 'blue-noise' },
        detail: { id: 'detail-noise' },
        shape: { id: 'shape-noise' },
      },
      quadBuffer: { id: 'quad-buffer' },
      smokeProgram: { id: 'smoke-program' },
      smokeVertexArray: { id: 'smoke-vao' },
      targetHeight: 16,
      targetWidth: 16,
      textureInfo: { texture: { id: 'density' } },
    },
  );

  assert.equal(renderer.handleContextLost(), false);
  assert.throws(
    () => renderer.setParams({ density: 1 }),
    /after WebGL context loss/,
  );
  assert.equal(renderer.dispose(), true);
  assert.equal(renderer.disposed, true);
  assert.equal(renderer.dispose(), false);
  assert.equal(renderer._pendingTextureDeletes.size, 0);
  assert.equal(renderer._pendingProgramDeletes.size, 0);
});
