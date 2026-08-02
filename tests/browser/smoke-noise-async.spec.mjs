import { expect, test } from './helpers/test.mjs';

const WEBGL_HARNESS = '/tests/browser/fixtures/webgl-harness.html';

test('first smoke render allocates no noise and multiview renders share one scheduled batch', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);
  const proof = await page.evaluate(async () => {
    const [
      { createProgram },
      { SmokeRenderer },
    ] = await Promise.all([
      import('/assets/js/rendering/gl-utils.js'),
      import('/assets/js/rendering/smoke-cloud/smoke-renderer.js'),
    ]);
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
    });
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Smoke scheduling proof requires WebGL2');
    }
    const renderer = new SmokeRenderer(gl, createProgram);
    renderer.setNoiseTextureResolution(128);
    renderer.textureInfo = {};

    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const prototype = WebGL2RenderingContext.prototype;
    const originalCreateTexture = prototype.createTexture;
    let nextFrameId = 1;
    let textureAllocations = 0;
    let scheduleCalls = 0;
    let cancellationCalls = 0;
    const callbacks = new Map();
    globalThis.requestAnimationFrame = callback => {
      const id = nextFrameId++;
      scheduleCalls++;
      callbacks.set(id, callback);
      return id;
    };
    globalThis.cancelAnimationFrame = id => {
      cancellationCalls++;
      callbacks.delete(id);
    };
    prototype.createTexture = function (...args) {
      const texture = Reflect.apply(originalCreateTexture, this, args);
      if (this === gl && texture) textureAllocations++;
      return texture;
    };

    const runNextFrame = () => {
      const entry = callbacks.entries().next().value;
      if (!entry) throw new Error('Expected one scheduled noise batch');
      const [id, callback] = entry;
      callbacks.delete(id);
      callback(performance.now());
    };
    let result;
    try {
      for (let view = 0; view < 8; view++) {
        renderer.render({});
      }
      const transaction = renderer._noiseGenerationTransaction;
      const firstRender = {
        phase: transaction?._phase,
        scheduledCallbacks: callbacks.size,
        scheduleCalls,
        textureAllocations,
        transactionStarted: transaction !== null,
      };

      const phaseProgression = [];
      for (let batch = 0; batch < 3; batch++) {
        runNextFrame();
        for (let view = 0; view < 8; view++) {
          renderer.render({});
        }
        phaseProgression.push({
          phase: transaction._phase,
          scheduledCallbacks: callbacks.size,
          sameTransaction:
            renderer._noiseGenerationTransaction === transaction,
          scheduleCalls,
          textureAllocations,
        });
      }
      const disposeResult = renderer.dispose();
      await Promise.resolve();
      result = {
        cancellationCalls,
        disposeResult,
        firstRender,
        phaseProgression,
        scheduledAfterDispose: callbacks.size,
      };
    } finally {
      prototype.createTexture = originalCreateTexture;
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
      if (!renderer.disposed) renderer.dispose();
    }
    return result;
  });

  expect(proof.firstRender).toEqual({
    phase: 'pending-cleanup',
    scheduledCallbacks: 1,
    scheduleCalls: 1,
    textureAllocations: 0,
    transactionStarted: true,
  });
  expect(proof.phaseProgression).toEqual([
    {
      phase: 'initialize',
      sameTransaction: true,
      scheduleCalls: 2,
      scheduledCallbacks: 1,
      textureAllocations: 0,
    },
    {
      phase: 'shape-program-create',
      sameTransaction: true,
      scheduleCalls: 3,
      scheduledCallbacks: 1,
      textureAllocations: 0,
    },
    {
      phase: 'shape-program-await',
      sameTransaction: true,
      scheduleCalls: 4,
      scheduledCallbacks: 1,
      textureAllocations: 0,
    },
  ]);
  expect(proof.disposeResult).toBe(true);
  expect(proof.cancellationCalls).toBe(1);
  expect(proof.scheduledAfterDispose).toBe(0);
});

test('frame-batched GPU noise restores fresh hostile state and settles exactly once', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);
  const proof = await page.evaluate(async () => {
    const { startCloudNoiseGenerationGPU } = await import(
      '/assets/js/rendering/smoke-cloud/gpu-noise-generator.js'
    );
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: true,
    });
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Async noise state proof requires WebGL2');
    }

    const callerTexture2D = gl.createTexture();
    const callerTexture3D = gl.createTexture();
    const callerDrawFramebuffer = gl.createFramebuffer();
    const callerReadFramebuffer = gl.createFramebuffer();
    const callerArrayBuffer = gl.createBuffer();
    const callerPixelUnpackBuffer = gl.createBuffer();
    const callerVertexArray = gl.createVertexArray();
    if (
      !callerTexture2D
      || !callerTexture3D
      || !callerDrawFramebuffer
      || !callerReadFramebuffer
      || !callerArrayBuffer
      || !callerPixelUnpackBuffer
      || !callerVertexArray
    ) {
      throw new Error('Async noise caller-state allocation failed');
    }
    gl.activeTexture(gl.TEXTURE0 + 5);
    gl.bindTexture(gl.TEXTURE_2D, callerTexture2D);
    gl.bindTexture(gl.TEXTURE_3D, callerTexture3D);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, callerDrawFramebuffer);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, callerReadFramebuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, callerArrayBuffer);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, callerPixelUnpackBuffer);
    gl.bindVertexArray(callerVertexArray);

    const capabilities = [
      gl.BLEND,
      gl.CULL_FACE,
      gl.DEPTH_TEST,
      gl.DITHER,
      gl.RASTERIZER_DISCARD,
      gl.SAMPLE_ALPHA_TO_COVERAGE,
      gl.SAMPLE_COVERAGE,
      gl.SCISSOR_TEST,
      gl.STENCIL_TEST,
    ];
    const snapshot = () => ({
      activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
      arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
      capabilities: capabilities.map(capability =>
        gl.isEnabled(capability)
      ),
      colorMask: Array.from(gl.getParameter(gl.COLOR_WRITEMASK)),
      drawFramebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
      pixelUnpackBuffer: gl.getParameter(
        gl.PIXEL_UNPACK_BUFFER_BINDING
      ),
      program: gl.getParameter(gl.CURRENT_PROGRAM),
      readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      texture2D: gl.getParameter(gl.TEXTURE_BINDING_2D),
      texture3D: gl.getParameter(gl.TEXTURE_BINDING_3D),
      vertexArray: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
    });
    const sameState = (first, second) => (
      first.activeTexture === second.activeTexture
      && first.arrayBuffer === second.arrayBuffer
      && first.capabilities.every(
        (value, index) => value === second.capabilities[index]
      )
      && first.colorMask.every(
        (value, index) => value === second.colorMask[index]
      )
      && first.drawFramebuffer === second.drawFramebuffer
      && first.pixelUnpackBuffer === second.pixelUnpackBuffer
      && first.program === second.program
      && first.readFramebuffer === second.readFramebuffer
      && first.texture2D === second.texture2D
      && first.texture3D === second.texture3D
      && first.vertexArray === second.vertexArray
      && first.viewport.every(
        (value, index) => value === second.viewport[index]
      )
    );

    let transaction = null;
    let callbackCount = 0;
    let pendingCallbacks = 0;
    let maximumPendingCallbacks = 0;
    const restorationFailures = [];
    const callbackErrors = [];
    const schedule = callback => {
      let active = true;
      pendingCallbacks++;
      maximumPendingCallbacks = Math.max(
        maximumPendingCallbacks,
        pendingCallbacks
      );
      const frameId = requestAnimationFrame(() => {
        if (!active) return;
        active = false;
        pendingCallbacks--;
        const variant = callbackCount++;
        gl.viewport(
          3 + (variant % 5),
          7 + (variant % 3),
          19 + (variant % 7),
          23 + (variant % 11)
        );
        gl.colorMask(
          variant % 2 === 0,
          true,
          variant % 3 === 0,
          variant % 2 !== 0
        );
        for (const [index, capability] of capabilities.entries()) {
          if ((variant + index) % 2 === 0) gl.enable(capability);
          else gl.disable(capability);
        }
        const before = snapshot();
        callback();
        const after = snapshot();
        if (!sameState(before, after)) {
          restorationFailures.push(transaction?._phase ?? 'unknown');
        }
        const error = gl.getError();
        if (error !== gl.NO_ERROR) callbackErrors.push(error);
      });
      return () => {
        if (!active) return;
        active = false;
        pendingCallbacks--;
        cancelAnimationFrame(frameId);
      };
    };

    let fulfillmentCount = 0;
    let rejectionCount = 0;
    transaction = startCloudNoiseGenerationGPU(gl, 32, 32, {
      maxSlicesPerBatch: 2,
      schedule,
    });
    transaction.completion.then(
      () => {
        fulfillmentCount++;
      },
      () => {
        rejectionCount++;
      },
    );
    await transaction.completion;
    await Promise.resolve();

    const texturesAreLive = (
      gl.isTexture(transaction.shape)
      && gl.isTexture(transaction.detail)
      && gl.isTexture(transaction.blueNoise)
    );
    const shapeFramebuffer = gl.createFramebuffer();
    const detailFramebuffer = gl.createFramebuffer();
    if (!shapeFramebuffer || !detailFramebuffer) {
      throw new Error('Async noise verification framebuffer failed');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, shapeFramebuffer);
    gl.framebufferTextureLayer(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      transaction.shape,
      0,
      31
    );
    const shapeComplete =
      gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, detailFramebuffer);
    gl.framebufferTextureLayer(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      transaction.detail,
      0,
      31
    );
    const detailComplete =
      gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      === gl.FRAMEBUFFER_COMPLETE;

    const taskTimings = transaction.getTaskTimings();
    const timingPhases = taskTimings.map(timing => timing.phase);
    transaction.cancel();
    transaction.invalidate();
    await Promise.resolve();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0 + 5);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindTexture(gl.TEXTURE_3D, null);
    gl.deleteFramebuffer(shapeFramebuffer);
    gl.deleteFramebuffer(detailFramebuffer);
    gl.deleteFramebuffer(callerDrawFramebuffer);
    gl.deleteFramebuffer(callerReadFramebuffer);
    gl.deleteBuffer(callerArrayBuffer);
    gl.deleteBuffer(callerPixelUnpackBuffer);
    gl.deleteTexture(callerTexture2D);
    gl.deleteTexture(callerTexture3D);
    gl.deleteVertexArray(callerVertexArray);

    return {
      callbackCount,
      callbackErrors,
      cleanupComplete: transaction.cleanupComplete,
      detailComplete,
      fulfillmentCount,
      maximumPendingCallbacks,
      pendingCallbacks,
      rejectionCount,
      restorationFailures,
      shapeComplete,
      taskCount: taskTimings.length,
      timingPhases,
      texturesAreLive,
      webglError: gl.getError(),
    };
  });

  expect(proof.restorationFailures).toEqual([]);
  expect(proof.callbackErrors).toEqual([]);
  expect(proof.maximumPendingCallbacks).toBe(1);
  expect(proof.pendingCallbacks).toBe(0);
  expect(proof.callbackCount).toBe(proof.taskCount);
  expect(proof.timingPhases).toContain('pending-cleanup');
  expect(proof.timingPhases).toContain('initialize');
  expect(proof.timingPhases).toContain('shape-finalize');
  expect(proof.timingPhases).toContain('detail-finalize');
  expect(proof.timingPhases).toContain('generator-retire');
  expect(proof.texturesAreLive).toBe(true);
  expect(proof.shapeComplete).toBe(true);
  expect(proof.detailComplete).toBe(true);
  expect(proof.fulfillmentCount).toBe(1);
  expect(proof.rejectionCount).toBe(0);
  expect(proof.cleanupComplete).toBe(true);
  expect(proof.webglError).toBe(0);
});

test('GPU noise context loss between batches invalidates without deletion', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);
  const proof = await page.evaluate(async () => {
    const { startCloudNoiseGenerationGPU } = await import(
      '/assets/js/rendering/smoke-cloud/gpu-noise-generator.js'
    );
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Noise context-loss proof requires WebGL2');
    }
    const extension = gl.getExtension('WEBGL_lose_context');
    if (!extension) {
      return { supported: false };
    }

    const queue = [];
    const schedule = callback => {
      const entry = { active: true, callback };
      queue.push(entry);
      return () => {
        entry.active = false;
      };
    };
    const runNext = () => {
      const entry = queue.find(candidate => candidate.active);
      if (!entry) throw new Error('Expected a scheduled noise batch');
      entry.active = false;
      entry.callback();
    };

    const prototype = WebGL2RenderingContext.prototype;
    const methods = [
      'deleteBuffer',
      'deleteFramebuffer',
      'deleteProgram',
      'deleteTexture',
      'deleteVertexArray',
    ];
    const originals = new Map();
    let deletionCalls = 0;
    for (const method of methods) {
      originals.set(method, prototype[method]);
      prototype[method] = function (...args) {
        if (this === gl) deletionCalls++;
        return Reflect.apply(originals.get(method), this, args);
      };
    }

    let result;
    try {
      const transaction = startCloudNoiseGenerationGPU(gl, 32, 32, {
        schedule,
      });
      const settlement = transaction.completion.catch(error => error);
      while (transaction._phase !== 'shape-slices') runNext();
      const deletionCallsBeforeLoss = deletionCalls;
      extension.loseContext();
      runNext();
      const error = await settlement;
      result = {
        cleanupComplete: transaction.cleanupComplete,
        deletionCallsAfterLoss: deletionCalls - deletionCallsBeforeLoss,
        errorMessage: error.message,
        pendingCallbacks: queue.filter(entry => entry.active).length,
        settled: transaction.settled,
        supported: true,
      };
    } finally {
      for (const [method, original] of originals) {
        prototype[method] = original;
      }
    }
    return result;
  });

  expect(proof.supported).toBe(true);
  expect(proof.cleanupComplete).toBe(true);
  expect(proof.deletionCallsAfterLoss).toBe(0);
  expect(proof.errorMessage).toMatch(/context loss/i);
  expect(proof.pendingCallbacks).toBe(0);
  expect(proof.settled).toBe(true);
});

test('GPU noise scheduling safely uses timer fallback without a paired frame canceller', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);
  const proof = await page.evaluate(async () => {
    const { startCloudNoiseGenerationGPU } = await import(
      '/assets/js/rendering/smoke-cloud/gpu-noise-generator.js'
    );
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Noise fallback proof requires WebGL2');
    }
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    let frameRequests = 0;
    globalThis.requestAnimationFrame = callback => {
      frameRequests++;
      return originalRequestAnimationFrame(callback);
    };
    globalThis.cancelAnimationFrame = undefined;
    let result;
    try {
      const transaction = startCloudNoiseGenerationGPU(gl, 32, 32);
      const settlement = transaction.completion.catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 10));
      const phaseAfterTimer = transaction._phase;
      transaction.cancel();
      await settlement;
      result = {
        cleanupComplete: transaction.cleanupComplete,
        frameRequests,
        phaseAfterTimer,
      };
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
    return result;
  });

  expect(proof.frameRequests).toBe(0);
  expect(proof.phaseAfterTimer).not.toBe('pending-cleanup');
  expect(proof.cleanupComplete).toBe(true);
});
