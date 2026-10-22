import assert from 'node:assert/strict';
import test from 'node:test';

import { isContextLostError } from '../assets/js/rendering/gl-errors.js';
import {
  startCloudNoiseGenerationGPU,
} from '../assets/js/rendering/smoke-cloud/gpu-noise-generator.js';

function createManualScheduler() {
  const queue = [];
  let maximumPending = 0;
  const pendingCount = () => queue.filter(entry => entry.active).length;
  return {
    get maximumPending() {
      return maximumPending;
    },
    get pending() {
      return pendingCount();
    },
    runNext() {
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry.active) continue;
        entry.active = false;
        entry.callback();
        return true;
      }
      return false;
    },
    schedule(callback) {
      const entry = { active: true, callback };
      queue.push(entry);
      maximumPending = Math.max(maximumPending, pendingCount());
      return () => {
        entry.active = false;
      };
    },
  };
}

function createNoiseGl() {
  let nextId = 1;
  let activeTexture = 0x84C3;
  let arrayBuffer = { caller: 'array-buffer' };
  let colorMask = [false, true, false, true];
  let currentProgram = { caller: 'program' };
  let drawFramebuffer = { caller: 'draw-framebuffer' };
  let pixelUnpackBuffer = { caller: 'pixel-unpack-buffer' };
  let readFramebuffer = { caller: 'read-framebuffer' };
  let texture2D = { caller: 'texture-2d' };
  let texture3D = { caller: 'texture-3d' };
  let vertexArray = { caller: 'vertex-array' };
  let viewport = [7, 11, 13, 17];
  let contextLost = false;
  let failDeleteTexture = 0;
  let failDeleteProgram = 0;
  let injectDrawError = false;
  let failLinkOrdinal = null;
  let shaderFailureLog = '';
  let parallelCompilePolls = 0;
  let parallelCompilePollsPerProgram = 0;
  const parallelCompileChecks = new Map();
  let linkStatusChecks = 0;
  // How many status polls a fence stays unsignaled: the GPU's lag behind the
  // submitted batch, in scheduling turns.
  let gpuLagPolls = 0;
  const fences = new Map();

  const capabilities = new Map();
  const shaders = new Set();
  const programs = new Set();
  const buffers = new Set();
  const vertexArrays = new Set();
  const textures = new Set();
  const framebuffers = new Set();
  const framebufferAttachments = new Map();
  const errors = [];
  const draws = [];
  const mipmaps = [];
  const deletions = [];
  const allocations = [];

  const gl = {
    ACTIVE_TEXTURE: 0x84E0,
    ARRAY_BUFFER: 0x8892,
    ARRAY_BUFFER_BINDING: 0x8894,
    BLEND: 0x0BE2,
    COLOR_ATTACHMENT0: 0x8CE0,
    COLOR_WRITEMASK: 0x0C23,
    COMPILE_STATUS: 0x8B81,
    CONTEXT_LOST_WEBGL: 0x9242,
    CULL_FACE: 0x0B44,
    CURRENT_PROGRAM: 0x8B8D,
    DEPTH_TEST: 0x0B71,
    DITHER: 0x0BD0,
    DRAW_FRAMEBUFFER: 0x8CA9,
    DRAW_FRAMEBUFFER_BINDING: 0x8CA6,
    FLOAT: 0x1406,
    FRAGMENT_SHADER: 0x8B30,
    FRAMEBUFFER: 0x8D40,
    FRAMEBUFFER_COMPLETE: 0x8CD5,
    INVALID_OPERATION: 0x0502,
    LINEAR: 0x2601,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    LINK_STATUS: 0x8B82,
    NEAREST: 0x2600,
    NO_ERROR: 0,
    PIXEL_UNPACK_BUFFER: 0x88EC,
    PIXEL_UNPACK_BUFFER_BINDING: 0x88EF,
    RASTERIZER_DISCARD: 0x8C89,
    READ_FRAMEBUFFER: 0x8CA8,
    READ_FRAMEBUFFER_BINDING: 0x8CAA,
    REPEAT: 0x2901,
    RG: 0x8227,
    RG8: 0x822B,
    RGBA: 0x1908,
    RGBA8: 0x8058,
    SAMPLE_ALPHA_TO_COVERAGE: 0x809E,
    SAMPLE_COVERAGE: 0x80A0,
    SCISSOR_TEST: 0x0C11,
    SIGNALED: 0x9119,
    STATIC_DRAW: 0x88E4,
    STENCIL_TEST: 0x0B90,
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    SYNC_STATUS: 0x9114,
    TEXTURE_2D: 0x0DE1,
    TEXTURE_3D: 0x806F,
    TEXTURE_BINDING_2D: 0x8069,
    TEXTURE_BINDING_3D: 0x806A,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_R: 0x8072,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TRIANGLE_STRIP: 0x0005,
    UNSIGNED_BYTE: 0x1401,
    VERTEX_ARRAY_BINDING: 0x85B5,
    VERTEX_SHADER: 0x8B31,
    UNSIGNALED: 0x9118,
    VIEWPORT: 0x0BA2,

    activeTexture(value) {
      activeTexture = value;
    },
    attachShader() {},
    bindBuffer(target, value) {
      if (target === gl.ARRAY_BUFFER) arrayBuffer = value;
      else if (target === gl.PIXEL_UNPACK_BUFFER) {
        pixelUnpackBuffer = value;
      } else {
        throw new Error(`Unexpected buffer target ${target}`);
      }
    },
    bindFramebuffer(target, value) {
      if (target === gl.FRAMEBUFFER) {
        drawFramebuffer = value;
        readFramebuffer = value;
      } else if (target === gl.DRAW_FRAMEBUFFER) {
        drawFramebuffer = value;
      } else if (target === gl.READ_FRAMEBUFFER) {
        readFramebuffer = value;
      } else {
        throw new Error(`Unexpected framebuffer target ${target}`);
      }
    },
    bindTexture(target, value) {
      if (target === gl.TEXTURE_2D) texture2D = value;
      else if (target === gl.TEXTURE_3D) texture3D = value;
      else throw new Error(`Unexpected texture target ${target}`);
    },
    bindVertexArray(value) {
      vertexArray = value;
    },
    bufferData() {},
    checkFramebufferStatus() {
      return gl.FRAMEBUFFER_COMPLETE;
    },
    colorMask(...value) {
      colorMask = value;
    },
    compileShader() {},
    createBuffer() {
      const resource = { id: nextId++, type: 'buffer' };
      buffers.add(resource);
      allocations.push(resource);
      return resource;
    },
    createFramebuffer() {
      const resource = { id: nextId++, type: 'framebuffer' };
      framebuffers.add(resource);
      allocations.push(resource);
      return resource;
    },
    createProgram() {
      const resource = {
        id: nextId++,
        ordinal: programs.size + 1,
        type: 'program',
      };
      programs.add(resource);
      allocations.push(resource);
      return resource;
    },
    createShader(type) {
      const resource = { id: nextId++, type };
      shaders.add(resource);
      allocations.push(resource);
      return resource;
    },
    createTexture() {
      const resource = { id: nextId++, type: 'texture' };
      textures.add(resource);
      allocations.push(resource);
      return resource;
    },
    createVertexArray() {
      const resource = { id: nextId++, type: 'vertex-array' };
      vertexArrays.add(resource);
      allocations.push(resource);
      return resource;
    },
    deleteBuffer(resource) {
      buffers.delete(resource);
      deletions.push(['buffer', resource]);
    },
    deleteFramebuffer(resource) {
      framebuffers.delete(resource);
      deletions.push(['framebuffer', resource]);
    },
    deleteProgram(resource) {
      if (failDeleteProgram > 0) {
        failDeleteProgram--;
        throw new Error('synthetic program deletion failure');
      }
      programs.delete(resource);
      deletions.push(['program', resource]);
    },
    deleteShader(resource) {
      shaders.delete(resource);
      deletions.push(['shader', resource]);
    },
    deleteTexture(resource) {
      if (failDeleteTexture > 0) {
        failDeleteTexture--;
        throw new Error('synthetic texture deletion failure');
      }
      textures.delete(resource);
      deletions.push(['texture', resource]);
    },
    deleteVertexArray(resource) {
      vertexArrays.delete(resource);
      deletions.push(['vertex-array', resource]);
    },
    disable(capability) {
      capabilities.set(capability, false);
    },
    deleteSync(fence) {
      assert.ok(fences.has(fence), 'only a live fence is deleted');
      fences.delete(fence);
    },
    fenceSync(condition, flags) {
      assert.equal(condition, gl.SYNC_GPU_COMMANDS_COMPLETE);
      assert.equal(flags, 0);
      const fence = { fence: nextId++ };
      fences.set(fence, gpuLagPolls);
      return fence;
    },
    flush() {},
    getSyncParameter(fence, parameter) {
      assert.equal(parameter, gl.SYNC_STATUS);
      const remaining = fences.get(fence);
      assert.notEqual(remaining, undefined, 'only a live fence is polled');
      if (remaining > 0) {
        fences.set(fence, remaining - 1);
        return gl.UNSIGNALED;
      }
      return gl.SIGNALED;
    },
    drawArrays() {
      const attachment = framebufferAttachments.get(drawFramebuffer) ?? null;
      draws.push({
        layer: attachment?.layer ?? null,
        program: currentProgram?.ordinal ?? null,
        texture: attachment?.texture ?? null,
      });
      if (injectDrawError) {
        injectDrawError = false;
        errors.push(gl.INVALID_OPERATION);
      }
    },
    enable(capability) {
      capabilities.set(capability, true);
    },
    enableVertexAttribArray() {},
    framebufferTexture2D(_target, _attachment, _textureTarget, texture) {
      framebufferAttachments.set(drawFramebuffer, {
        layer: null,
        texture,
      });
    },
    framebufferTextureLayer(_target, _attachment, texture, _level, layer) {
      framebufferAttachments.set(drawFramebuffer, { layer, texture });
    },
    generateMipmap(target) {
      mipmaps.push(target === gl.TEXTURE_3D ? texture3D : texture2D);
    },
    getAttribLocation() {
      return 0;
    },
    getExtension(name) {
      if (
        name === 'KHR_parallel_shader_compile'
        && parallelCompilePollsPerProgram > 0
      ) {
        return { COMPLETION_STATUS_KHR: 0x91B1 };
      }
      return null;
    },
    getError() {
      return errors.shift() ?? gl.NO_ERROR;
    },
    getParameter(parameter) {
      const values = new Map([
        [gl.ACTIVE_TEXTURE, activeTexture],
        [gl.ARRAY_BUFFER_BINDING, arrayBuffer],
        [gl.COLOR_WRITEMASK, colorMask],
        [gl.CURRENT_PROGRAM, currentProgram],
        [gl.DRAW_FRAMEBUFFER_BINDING, drawFramebuffer],
        [gl.PIXEL_UNPACK_BUFFER_BINDING, pixelUnpackBuffer],
        [gl.READ_FRAMEBUFFER_BINDING, readFramebuffer],
        [gl.TEXTURE_BINDING_2D, texture2D],
        [gl.TEXTURE_BINDING_3D, texture3D],
        [gl.VERTEX_ARRAY_BINDING, vertexArray],
        [gl.VIEWPORT, viewport],
      ]);
      if (!values.has(parameter)) {
        throw new Error(`Unexpected state parameter ${parameter}`);
      }
      return values.get(parameter);
    },
    getProgramInfoLog(program) {
      return `synthetic program ${program.ordinal} link failure`;
    },
    getProgramParameter(program, parameter) {
      if (parameter === 0x91B1) {
        parallelCompilePolls++;
        const checks = (parallelCompileChecks.get(program) ?? 0) + 1;
        parallelCompileChecks.set(program, checks);
        return checks >= parallelCompilePollsPerProgram;
      }
      assert.equal(parameter, gl.LINK_STATUS);
      linkStatusChecks++;
      return program.ordinal !== failLinkOrdinal;
    },
    getShaderInfoLog() {
      return shaderFailureLog;
    },
    getShaderParameter(_shader, parameter) {
      assert.equal(parameter, gl.COMPILE_STATUS);
      return true;
    },
    getUniformLocation(_program, name) {
      return { name };
    },
    isContextLost() {
      return contextLost;
    },
    isEnabled(capability) {
      return capabilities.get(capability) ?? false;
    },
    isFramebuffer(resource) {
      return framebuffers.has(resource);
    },
    isTexture(resource) {
      return textures.has(resource);
    },
    linkProgram() {},
    shaderSource() {},
    texImage2D() {},
    texImage3D() {},
    texParameteri() {},
    uniform1f() {},
    useProgram(value) {
      currentProgram = value;
    },
    vertexAttribPointer() {},
    viewport(...value) {
      viewport = value;
    },

    _captureState() {
      return {
        activeTexture,
        arrayBuffer,
        capabilities: Array.from(capabilities.entries()),
        colorMask: [...colorMask],
        currentProgram,
        drawFramebuffer,
        pixelUnpackBuffer,
        readFramebuffer,
        texture2D,
        texture3D,
        vertexArray,
        viewport: [...viewport],
      };
    },
    _setContextLost(value) {
      contextLost = value;
    },
    _setFailDeleteProgram(count) {
      failDeleteProgram = count;
    },
    _setFailDeleteTexture(count) {
      failDeleteTexture = count;
    },
    _setFailLinkOrdinal(ordinal, shaderLog = '') {
      failLinkOrdinal = ordinal;
      shaderFailureLog = shaderLog;
    },
    _setInjectDrawError() {
      injectDrawError = true;
    },
    _setGpuLagPolls(count) {
      gpuLagPolls = count;
    },
    _setParallelCompilePollsPerProgram(count) {
      parallelCompilePollsPerProgram = count;
    },
    _state: {
      allocations,
      buffers,
      deletions,
      draws,
      fences,
      framebuffers,
      mipmaps,
      get linkStatusChecks() {
        return linkStatusChecks;
      },
      get parallelCompilePolls() {
        return parallelCompilePolls;
      },
      programs,
      shaders,
      textures,
      vertexArrays,
    },
  };

  for (const [index, capability] of [
    gl.BLEND,
    gl.CULL_FACE,
    gl.DEPTH_TEST,
    gl.DITHER,
    gl.RASTERIZER_DISCARD,
    gl.SAMPLE_ALPHA_TO_COVERAGE,
    gl.SAMPLE_COVERAGE,
    gl.SCISSOR_TEST,
    gl.STENCIL_TEST,
  ].entries()) {
    capabilities.set(capability, index % 2 === 0);
  }
  return gl;
}

function drainTransaction(transaction, scheduler, gl) {
  let callbacks = 0;
  while (transaction.running) {
    const callerState = gl._captureState();
    assert.equal(scheduler.pending, 1);
    assert.equal(scheduler.runNext(), true);
    assert.deepEqual(gl._captureState(), callerState);
    callbacks++;
    assert.ok(callbacks < 1000, 'noise transaction did not converge');
  }
  assert.equal(scheduler.pending, 0);
  return callbacks;
}

test('GPU noise transaction yields before allocation and restores exact state per bounded batch', async () => {
  const gl = createNoiseGl();
  const scheduler = createManualScheduler();
  const transaction = startCloudNoiseGenerationGPU(gl, 32, 32, {
    maxSlicesPerBatch: 2,
    now: () => 0,
    schedule: scheduler.schedule,
  });
  assert.equal(gl._state.allocations.length, 0);
  assert.equal(scheduler.pending, 1);

  const callbacks = drainTransaction(transaction, scheduler, gl);
  assert.equal(await transaction.completion, transaction);
  assert.equal(scheduler.maximumPending, 1);
  assert.equal(transaction.getTaskTimings().length, callbacks);
  assert.deepEqual(
    transaction.getTaskDurations(),
    transaction.getTaskTimings().map(timing => timing.duration),
  );
  assert.equal(
    transaction.getTaskTimings().every(timing => timing.failed === false),
    true,
  );

  const shapeDraws = gl._state.draws.filter(draw => draw.program === 1);
  const detailDraws = gl._state.draws.filter(draw => draw.program === 2);
  const blueDraws = gl._state.draws.filter(draw => draw.program === 3);
  assert.deepEqual(shapeDraws.map(draw => draw.layer), [...Array(32).keys()]);
  assert.deepEqual(detailDraws.map(draw => draw.layer), [...Array(32).keys()]);
  assert.equal(blueDraws.length, 1);
  for (const timing of transaction.getTaskTimings()) {
    if (timing.phase.endsWith('-slices')) {
      assert.ok(timing.sliceEnd - timing.sliceStart <= 2);
    }
  }
  assert.equal(gl._state.mipmaps.length, 2);
  assert.equal(gl._state.shaders.size, 0);
  assert.equal(gl._state.programs.size, 0);
  assert.equal(gl._state.buffers.size, 0);
  assert.equal(gl._state.vertexArrays.size, 0);
  assert.equal(gl._state.framebuffers.size, 0);

  const textures = transaction.takeTextures();
  assert.deepEqual(
    {
      blueNoiseSize: textures.blueNoiseSize,
      detailSize: textures.detailSize,
      shapeSize: textures.shapeSize,
    },
    {
      blueNoiseSize: 128,
      detailSize: 32,
      shapeSize: 32,
    },
  );
  assert.equal(transaction.cleanupComplete, true);
  gl.deleteTexture(textures.shape);
  gl.deleteTexture(textures.detail);
  gl.deleteTexture(textures.blueNoise);
  assert.equal(gl._state.textures.size, 0);
});

test('GPU noise transaction submits no slice batch while the GPU is still behind, and shrinks its batches', async () => {
  const gl = createNoiseGl();
  // Every batch takes the GPU three scheduling turns to finish.
  gl._setGpuLagPolls(3);
  const scheduler = createManualScheduler();
  const transaction = startCloudNoiseGenerationGPU(gl, 32, 32, {
    maxSlicesPerBatch: 8,
    now: () => 0,
    schedule: scheduler.schedule,
  });
  let outstandingSubmissions = 0;
  while (transaction.running) {
    const fencesBefore = [...gl._state.fences.keys()];
    const drawsBefore = gl._state.draws.length;
    assert.equal(scheduler.runNext(), true);
    // A fence that was outstanding and still is: the turn must not draw.
    const stillBehind = fencesBefore.some(fence => gl._state.fences.has(fence));
    if (stillBehind && gl._state.draws.length !== drawsBefore) outstandingSubmissions++;
  }
  assert.equal(await transaction.completion, transaction);
  assert.equal(outstandingSubmissions, 0, 'no batch is drawn behind an unfinished one');
  assert.ok(
    transaction.getTaskTimings().some(timing => timing.waitedForGpu),
    'turns spent waiting on the GPU are recorded as such',
  );
  assert.equal(gl._state.fences.size, 0, 'every batch fence is deleted');

  const shapeBatches = transaction.getTaskTimings()
    .filter(timing => timing.phase === 'shape-slices' && !timing.waitedForGpu)
    .map(timing => timing.sliceEnd - timing.sliceStart);
  assert.equal(shapeBatches[0], 8, 'the first batch uses the full cap');
  assert.equal(
    shapeBatches.slice(-3).every(slices => slices === 1),
    true,
    `a GPU that never keeps up drives the batches down to one slice (${shapeBatches})`,
  );
  // Every slice is still drawn exactly once, in order.
  const shapeDraws = gl._state.draws.filter(draw => draw.program === 1);
  assert.deepEqual(shapeDraws.map(draw => draw.layer), [...Array(32).keys()]);
  transaction.dispose();
});

test('GPU noise transaction keeps its batches when the GPU is one turn behind', async () => {
  // A renderer whose frames are slow finishes a batch by the turn after the
  // one that polled it: the fence is a turn late whatever the batch size, so
  // a smaller batch would only add turns. On a software renderer at a frame
  // every few seconds, halving on that first miss drove every batch to one
  // slice and each slice to two turns: minutes for a 32-cubed volume.
  const gl = createNoiseGl();
  gl._setGpuLagPolls(1);
  const scheduler = createManualScheduler();
  const transaction = startCloudNoiseGenerationGPU(gl, 32, 32, {
    maxSlicesPerBatch: 16,
    now: () => 0,
    schedule: scheduler.schedule,
  });
  let turns = 0;
  while (transaction.running) {
    assert.equal(scheduler.runNext(), true);
    turns++;
  }
  assert.equal(await transaction.completion, transaction);
  for (const phase of ['shape-slices', 'detail-slices']) {
    const batches = transaction.getTaskTimings()
      .filter(timing => timing.phase === phase && !timing.waitedForGpu)
      .map(timing => timing.sliceEnd - timing.sliceStart);
    assert.deepEqual(batches, [16, 16], `${phase} batches (${batches}) in ${turns} turns`);
  }
  transaction.dispose();
});

test('GPU noise transaction grows its batches back when the GPU keeps up', async () => {
  const gl = createNoiseGl();
  gl._setGpuLagPolls(2);
  const scheduler = createManualScheduler();
  const transaction = startCloudNoiseGenerationGPU(gl, 64, 32, {
    maxSlicesPerBatch: 8,
    now: () => 0,
    schedule: scheduler.schedule,
  });
  // Slow through the first shape batches, then the GPU catches up.
  let turns = 0;
  while (transaction.running) {
    assert.equal(scheduler.runNext(), true);
    turns++;
    if (turns === 12) gl._setGpuLagPolls(0);
  }
  assert.equal(await transaction.completion, transaction);
  const shapeBatches = transaction.getTaskTimings()
    .filter(timing => timing.phase === 'shape-slices' && !timing.waitedForGpu)
    .map(timing => timing.sliceEnd - timing.sliceStart);
  assert.ok(Math.min(...shapeBatches) < 8, `the batches shrank (${shapeBatches})`);
  assert.equal(shapeBatches.at(-2), 8, `and grew back to the cap (${shapeBatches})`);
  transaction.dispose();
});

test('cancelling GPU noise generation with a batch still on the GPU deletes its fence', async () => {
  const gl = createNoiseGl();
  gl._setGpuLagPolls(1000);
  const scheduler = createManualScheduler();
  const transaction = startCloudNoiseGenerationGPU(gl, 32, 32, {
    maxSlicesPerBatch: 4,
    now: () => 0,
    schedule: scheduler.schedule,
  });
  while (gl._state.fences.size === 0) {
    assert.equal(scheduler.runNext(), true);
  }
  const drawsAtFence = gl._state.draws.length;
  for (let turn = 0; turn < 5; turn++) assert.equal(scheduler.runNext(), true);
  assert.equal(gl._state.draws.length, drawsAtFence, 'waiting on the GPU draws nothing');
  transaction.cancel();
  await assert.rejects(transaction.completion);
  assert.equal(gl._state.fences.size, 0);
  assert.equal(transaction.cleanupComplete, true);
  assert.equal(scheduler.pending, 0);
});

test('GPU noise transaction scales the slice cap by submitted pixel work at 128 cubed', async () => {
  const gl = createNoiseGl();
  const scheduler = createManualScheduler();
  const transaction = startCloudNoiseGenerationGPU(gl, 128, 128, {
    maxSlicesPerBatch: 32,
    now: () => 0,
    schedule: scheduler.schedule,
  });
  drainTransaction(transaction, scheduler, gl);
  await transaction.completion;
  const sliceTimings = transaction.getTaskTimings().filter(
    timing => timing.phase.endsWith('-slices'),
  );
  assert.ok(sliceTimings.length > 0);
  assert.equal(
    Math.max(...sliceTimings.map(
      timing => timing.sliceEnd - timing.sliceStart
    )),
    16,
  );
  assert.equal(gl._state.draws.filter(draw => draw.program === 1).length, 128);
  assert.equal(gl._state.draws.filter(draw => draw.program === 2).length, 128);
  transaction.cancel();
  assert.equal(transaction.cleanupComplete, true);
});

test('GPU noise transaction polls parallel compilation without blocking on link status', async () => {
  const gl = createNoiseGl();
  gl._setParallelCompilePollsPerProgram(3);
  const scheduler = createManualScheduler();
  const transaction = startCloudNoiseGenerationGPU(gl, 32, 32, {
    now: () => 0,
    schedule: scheduler.schedule,
  });
  drainTransaction(transaction, scheduler, gl);
  await transaction.completion;
  assert.equal(gl._state.parallelCompilePolls, 9);
  assert.equal(gl._state.linkStatusChecks, 3);
  // A program still compiling ends the turn, so no turn polls one twice. The
  // first poll shares the turn that created the program (creating one is
  // cheap), and the other two each begin a turn of their own.
  assert.deepEqual(
    [
      'shape-program-await',
      'detail-program-await',
      'blueNoise-program-await',
    ].map(phase => transaction.getTaskTimings().filter(
      timing => timing.phase === phase
    ).length),
    [2, 2, 2],
  );
  transaction.cancel();
});

test('GPU noise cancellation is synchronous, retry-owned, and settles once', async () => {
  const gl = createNoiseGl();
  const scheduler = createManualScheduler();
  const transaction = startCloudNoiseGenerationGPU(gl, 32, 32, {
    maxSlicesPerBatch: 2,
    now: () => 0,
    schedule: scheduler.schedule,
  });
  let fulfillments = 0;
  let rejections = 0;
  const settlement = transaction.completion.then(
    () => {
      fulfillments++;
      return null;
    },
    error => {
      rejections++;
      return error;
    },
  );
  while (transaction._phase !== 'shape-slices') {
    assert.equal(scheduler.runNext(), true);
  }
  assert.equal(gl._state.textures.size, 1);
  gl._setFailDeleteTexture(1);
  assert.throws(
    () => transaction.cancel('synthetic cancellation'),
    /synthetic texture deletion failure/,
  );
  assert.equal(scheduler.pending, 0);
  assert.equal(transaction.cancelled, true);
  assert.equal(transaction.cleanupComplete, false);
  assert.equal((await settlement).name, 'AbortError');
  assert.equal(gl._state.textures.size, 1);
  assert.equal(transaction.dispose(), true);
  assert.equal(gl._state.textures.size, 0);
  assert.equal(transaction.cleanupComplete, true);
  transaction.invalidate();
  await Promise.resolve();
  assert.deepEqual({ fulfillments, rejections }, {
    fulfillments: 0,
    rejections: 1,
  });
});

test('GPU noise cancellation retains and retries a partially linked builder', async () => {
  const gl = createNoiseGl();
  // The shape program is still compiling, so the transaction stops there with
  // one program built; a turn otherwise runs straight past program creation.
  gl._setParallelCompilePollsPerProgram(2);
  const scheduler = createManualScheduler();
  const transaction = startCloudNoiseGenerationGPU(gl, 32, 32, {
    now: () => 0,
    schedule: scheduler.schedule,
  });
  const settlement = transaction.completion.catch(error => error);
  while (transaction._phase !== 'shape-program-await') {
    assert.equal(scheduler.runNext(), true);
  }
  assert.equal(gl._state.programs.size, 1);
  gl._setFailDeleteProgram(1);
  assert.throws(
    () => transaction.cancel(),
    /synthetic program deletion failure/,
  );
  assert.equal(transaction.cleanupComplete, false);
  assert.equal(gl._state.programs.size, 1);
  assert.equal((await settlement).name, 'AbortError');
  assert.equal(transaction.dispose(), true);
  assert.equal(transaction.cleanupComplete, true);
  assert.equal(gl._state.programs.size, 0);
});

test('GPU noise scheduled-callback cancellation failure is retry-owned and a stale callback is inert', async () => {
  const gl = createNoiseGl();
  let scheduledCallback = null;
  let cancellationAttempts = 0;
  const transaction = startCloudNoiseGenerationGPU(gl, 32, 32, {
    now: () => 0,
    schedule(callback) {
      scheduledCallback = callback;
      return () => {
        cancellationAttempts++;
        if (cancellationAttempts === 1) {
          throw new Error('synthetic scheduler cancellation failure');
        }
      };
    },
  });
  let rejectionCount = 0;
  const settlement = transaction.completion.catch(error => {
    rejectionCount++;
    return error;
  });
  assert.throws(
    () => transaction.cancel(),
    /synthetic scheduler cancellation failure/,
  );
  assert.equal(transaction.cleanupComplete, false);
  assert.equal((await settlement).name, 'AbortError');
  assert.equal(transaction.dispose(), true);
  assert.equal(transaction.cleanupComplete, true);
  assert.equal(cancellationAttempts, 2);
  scheduledCallback();
  await Promise.resolve();
  assert.equal(gl._state.allocations.length, 0);
  assert.equal(rejectionCount, 1);
});

test('GPU noise tolerates a no-op scheduler canceller without stale publication', async () => {
  const gl = createNoiseGl();
  let scheduledCallback = null;
  const transaction = startCloudNoiseGenerationGPU(gl, 32, 32, {
    now: () => 0,
    schedule(callback) {
      scheduledCallback = callback;
      return () => {};
    },
  });
  let fulfillments = 0;
  let rejections = 0;
  const settlement = transaction.completion.then(
    () => {
      fulfillments++;
    },
    error => {
      rejections++;
      return error;
    },
  );
  assert.equal(transaction.cancel(), true);
  scheduledCallback();
  await settlement;
  await Promise.resolve();
  assert.equal(gl._state.allocations.length, 0);
  assert.equal(transaction.cleanupComplete, true);
  assert.deepEqual({ fulfillments, rejections }, {
    fulfillments: 0,
    rejections: 1,
  });
});

test('GPU noise failure after context loss invalidates without issuing GL deletes', async () => {
  const gl = createNoiseGl();
  const scheduler = createManualScheduler();
  const transaction = startCloudNoiseGenerationGPU(gl, 32, 32, {
    now: () => 0,
    schedule: scheduler.schedule,
  });
  const settlement = transaction.completion.catch(error => error);
  while (transaction._phase !== 'shape-slices') {
    assert.equal(scheduler.runNext(), true);
  }
  const deletionCount = gl._state.deletions.length;
  gl._setContextLost(true);
  assert.equal(scheduler.runNext(), true);
  const error = await settlement;
  assert.equal(isContextLostError(error), true);
  assert.equal(transaction.cleanupComplete, true);
  assert.equal(transaction.settled, true);
  assert.equal(gl._state.deletions.length, deletionCount);
  assert.equal(scheduler.pending, 0);
});

test('GPU noise draw failure restores caller state and rolls back all live owners', async () => {
  const gl = createNoiseGl();
  const scheduler = createManualScheduler();
  const transaction = startCloudNoiseGenerationGPU(gl, 32, 32, {
    now: () => 0,
    schedule: scheduler.schedule,
  });
  const settlement = transaction.completion.catch(error => error);
  while (transaction._phase !== 'shape-slices') {
    assert.equal(scheduler.runNext(), true);
  }
  const callerState = gl._captureState();
  gl._setInjectDrawError();
  // Slice batches defer their error check to the texture's finalization, so
  // the failure is reported there, before anything is finalized or published.
  while (transaction.running) {
    assert.equal(scheduler.runNext(), true);
    assert.deepEqual(gl._captureState(), callerState);
  }
  const error = await settlement;
  assert.match(error.message, /shape slice batches.*0x502/i);
  assert.equal(gl._state.mipmaps.length, 0, 'a failed texture is never finalized');
  assert.deepEqual(gl._captureState(), callerState);
  assert.equal(transaction.cleanupComplete, true);
  assert.equal(gl._state.textures.size, 0);
  assert.equal(gl._state.framebuffers.size, 0);
  assert.equal(gl._state.programs.size, 0);
});

test('GPU noise absent-extension link failure reports shader diagnostics and leaks no owner', async () => {
  const gl = createNoiseGl();
  gl._setFailLinkOrdinal(1, 'synthetic shader compile failure');
  const scheduler = createManualScheduler();
  const transaction = startCloudNoiseGenerationGPU(gl, 32, 32, {
    now: () => 0,
    schedule: scheduler.schedule,
  });
  const settlement = transaction.completion.catch(error => error);
  while (transaction.running) {
    assert.equal(scheduler.runNext(), true);
  }
  const error = await settlement;
  assert.match(error.message, /program 1 link failure/i);
  assert.match(error.message, /shader compile failure/i);
  assert.equal(transaction.cleanupComplete, true);
  assert.equal(gl._state.shaders.size, 0);
  assert.equal(gl._state.programs.size, 0);
  assert.equal(gl._state.buffers.size, 0);
  assert.equal(gl._state.vertexArrays.size, 0);
  assert.equal(gl._state.framebuffers.size, 0);
  assert.equal(gl._state.textures.size, 0);
});

test('default GPU noise scheduling falls back when animation-frame cancellation is unavailable or the page is hidden', async () => {
  const requestFrameDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'requestAnimationFrame',
  );
  const cancelFrameDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'cancelAnimationFrame',
  );
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'document',
  );
  let frameRequests = 0;
  try {
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value() {
        frameRequests++;
        return 1;
      },
    });
    Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
    const first = startCloudNoiseGenerationGPU(
      createNoiseGl(),
      32,
      32,
    );
    const firstSettlement = first.completion.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(frameRequests, 0);
    assert.notEqual(first._phase, 'initialize');
    first.cancel();
    await firstSettlement;

    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      value() {},
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        addEventListener() {},
        hidden: true,
        removeEventListener() {},
      },
    });
    const second = startCloudNoiseGenerationGPU(
      createNoiseGl(),
      32,
      32,
    );
    const secondSettlement = second.completion.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(frameRequests, 0);
    assert.notEqual(second._phase, 'initialize');
    second.cancel();
    await secondSettlement;
  } finally {
    for (const [name, descriptor] of [
      ['requestAnimationFrame', requestFrameDescriptor],
      ['cancelAnimationFrame', cancelFrameDescriptor],
      ['document', documentDescriptor],
    ]) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  }
});

test('hidden fallback survives a throwing frame canceller and its stale frame stays inert', async () => {
  const requestFrameDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'requestAnimationFrame',
  );
  const cancelFrameDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'cancelAnimationFrame',
  );
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'document',
  );
  let frameCallback = null;
  let visibilityListener = null;
  let frameCancellationAttempts = 0;
  const documentStub = {
    hidden: false,
    addEventListener(name, listener) {
      assert.equal(name, 'visibilitychange');
      visibilityListener = listener;
    },
    removeEventListener(name, listener) {
      assert.equal(name, 'visibilitychange');
      if (visibilityListener === listener) visibilityListener = null;
    },
  };
  try {
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value(callback) {
        frameCallback = callback;
        return 41;
      },
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      value() {
        frameCancellationAttempts++;
        throw new Error('synthetic frame cancellation failure');
      },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: documentStub,
    });

    const transaction = startCloudNoiseGenerationGPU(
      createNoiseGl(),
      32,
      32,
    );
    const settlement = transaction.completion.catch(() => {});
    assert.equal(transaction._phase, 'initialize');
    assert.equal(typeof visibilityListener, 'function');
    documentStub.hidden = true;
    assert.doesNotThrow(() => visibilityListener());
    await new Promise(resolve => setTimeout(resolve, 5));
    const phaseAfterTimeout = transaction._phase;
    assert.notEqual(phaseAfterTimeout, 'initialize');
    frameCallback();
    assert.equal(transaction._phase, phaseAfterTimeout);
    assert.equal(frameCancellationAttempts, 1);
    transaction.cancel();
    await settlement;
    assert.equal(transaction.cleanupComplete, true);
  } finally {
    for (const [name, descriptor] of [
      ['requestAnimationFrame', requestFrameDescriptor],
      ['cancelAnimationFrame', cancelFrameDescriptor],
      ['document', documentDescriptor],
    ]) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  }
});

test('GPU noise slice batches issue no getError and a cancelled transaction consumes their error', async () => {
  const gl = createNoiseGl();
  const scheduler = createManualScheduler();
  const transaction = startCloudNoiseGenerationGPU(gl, 128, 32, {
    now: () => 0,
    schedule: scheduler.schedule,
  });
  const settlement = transaction.completion.catch(error => error);
  while (transaction._phase !== 'shape-slices') {
    assert.equal(scheduler.runNext(), true);
  }
  const originalGetError = gl.getError;
  let getErrorCalls = 0;
  gl.getError = function countedGetError() {
    getErrorCalls++;
    return originalGetError.call(this);
  };
  gl._setInjectDrawError();
  assert.equal(scheduler.runNext(), true);
  assert.equal(transaction._phase, 'shape-slices');
  assert.equal(getErrorCalls, 0, 'a slice batch must not drain the GPU command stream');

  transaction.cancel();
  await settlement;
  gl.getError = originalGetError;
  assert.equal(
    gl.getError(),
    gl.NO_ERROR,
    'an unchecked batch error must not surface to the next WebGL owner',
  );
});

test('GPU noise generation refuses volumes above the 128 cubed ceiling before touching WebGL', () => {
  const gl = new Proxy({}, {
    get(_target, property) {
      throw new Error(`WebGL must not be touched: ${String(property)}`);
    },
  });
  for (const [shape, detail] of [[256, 128], [128, 192], [16, 32]]) {
    assert.throws(
      () => startCloudNoiseGenerationGPU(gl, shape, detail),
      /must be an integer between 32 and 128/,
    );
  }
});
